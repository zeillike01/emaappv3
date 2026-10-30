/**
 * LIVE TRADING — liveEngine (queries + mutations, NO node APIs).
 *
 * Owns the liveAccount doc + the liveTrades ledger. The engine that actually
 * talks to MEXC lives in liveBroker.ts ("use node" — private signed API), which
 * drives everything through the mutations below, mirroring how strategyEngine
 * (paper Layer 2) drives paperTrading. Separating them keeps the signing code
 * out of every query/mutation the UI subscribes to.
 *
 * Scope (2026-09, per the user): a SEPARATE page/route, SAME Layer 2 auto-bot,
 * fresh ledger (nothing migrated), started/stopped from a button, running in
 * parallel with the paper books. Live orders are ONLY placed when the bot is
 * armed AND MEXC_API_KEY / MEXC_API_SECRET exist on the deployment — the entry
 * tick refuses to fire without them and surfaces the reason in
 * liveAccount.lastScanResult.
 */
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
const action = internalAction;
import type { MutationCtx } from "./_generated/server";
import { api as convexApi, internal } from "./_generated/api";
import { requireOperator } from "./users";

// Preserve the module's existing `api.liveEngine.*` call syntax while routing
// the backfill worker's ledger writes through internal functions.
const api = convexApi as typeof convexApi & {
  liveEngine: typeof convexApi.liveEngine & typeof internal.liveEngine;
};
Object.assign(api.liveEngine, {
  setLiveMeta: internal.liveEngine.setLiveMeta,
  markLiveClosed: internal.liveEngine.markLiveClosed,
  setLiveBracketBreach: internal.liveEngine.setLiveBracketBreach,
  patchLiveCloseAnalytics: internal.liveEngine.patchLiveCloseAnalytics,
});
import { tryAcquireLease } from "../lib/strategy-utils";
import { clampRiskPct, MAX_RISK_PCT_PER_TRADE } from "../lib/costs";
import { detectAttributionAnomaly, planLiveExitRelabel } from "../lib/live-math";
import { scheduleExecRecord } from "./executionRecord";
// Shared pure analytics — the SAME helpers paperTrading uses, so live and
// paper produce identical close-side numbers from identical bars.
import {
  excursionR,
  durationBucketOf,
  captureRatioOf,
  slippageBpsOf,
  movePctOf,
} from "../lib/trade-analytics";
// MEXC reads go through the Node relay: this file is default-runtime and the
// WAF 403s direct fetches here (see marketRelay.ts).
import { relayKlines } from "./marketFetch";

// Built-in seeds for a brand-new live account. These are a SAFETY-NET
// fallback: whenever a liveAccount row is created the engine prefers the
// user-saved `liveDefaults` doc (editable from the /live Risk settings card —
// "Also save as defaults"), so a reset account keeps the values the user last
// chose. Risk seeds at 1% (user requirement) rather than mirroring paper's
// 2.5% engine risk.
// 20x (audit fix 2026-09-11). The old 60x default put liquidation ~1.67%
// (minus maintenance) from entry against a 1.5% stop — barely past it, so
// fees/slippage could liquidate the position BEFORE the stop filled, losing
// the whole margin instead of 1R. 20x gives liquidation ~5% away, comfortably
// clearing the stop plus costs. The entry path additionally clamps any
// configured leverage to maxSafeLeverage(stopLossPct) (see live-math.ts), so
// a stale 60x account row is capped automatically on the next entry.
// No live-owner import: the ownership lock is disabled on this single-user
// app (see requireLiveOwner below). The legacy helper module is gone.

export const LIVE_DEFAULT_LEVERAGE = 20;
export const LIVE_DEFAULT_RISK_PCT = 1;
// Concurrent live-position cap. User: "3 for now — we will add more when we
// get more funds" — stored on the account doc + editable in the /live Risk
// settings (raise it from the UI later, no code change needed).
/**
 * Concurrent live-position cap for a FRESH account row (2026-10-21).
 *
 * The operator's number is 10 ("Live only has the limit and it's 10"), and the
 * live row on the deployment already carries 10, so this only decides what a
 * rebuilt/reseeded account starts at. It was 3 from 2026-09-10 (when the
 * balance was ~$150 and three ~30x positions were the most the margin could
 * carry); a reseed silently dropping an armed book back to 3 would be a
 * business change nobody asked for. Raising it further stays allowed up to
 * LIVE_MAX_OPEN_POSITIONS_UPPER.
 *
 * PAPER HAS NO EQUIVALENT AND MUST NEVER GET ONE — see the note in
 * strategyEngine.processPair's caller: paper is the sensor every gate is
 * validated on, so it enters every qualified signal it can and lets the gates
 * (not a slot count) decide. Changing this constant cannot affect paper.
 */
export const LIVE_DEFAULT_MAX_OPEN_POSITIONS = 10;
export const LIVE_MAX_OPEN_POSITIONS_UPPER = 20; // UI/engine clamp
export const LIVE_TICK_LEASE_MS = 25 * 60_000; // same run-guard lease as strategyTick

/**
 * The settings a FRESH liveAccount row should start with: the user-saved
 * `liveDefaults` doc when one exists, otherwise the built-in LIVE_DEFAULT_*.
 * Every account-creation path (ensureLiveAccount / setLiveEnabled /
 * updateLiveSettings) seeds from this so a reset can never silently fall back
 * to stale constants.
 */
async function readLiveDefaults(ctx: MutationCtx) {
  const doc = await ctx.db
    .query("liveDefaults")
    .withIndex("by_name", (q) => q.eq("name", "live"))
    .first();
  if (doc) {
    // Phase 7: clamp a legacy stored row — a pre-ceiling defaults doc carrying
    // riskPct > 2 must never seed a fresh account above the ceiling.
    return {
      leverage: doc.leverage,
      riskPct: clampRiskPct(doc.riskPct, LIVE_DEFAULT_RISK_PCT),
      maxOpenPositions: doc.maxOpenPositions,
    };
  }
  return {
    leverage: LIVE_DEFAULT_LEVERAGE,
    riskPct: LIVE_DEFAULT_RISK_PCT,
    maxOpenPositions: LIVE_DEFAULT_MAX_OPEN_POSITIONS,
  };
}

// ── Account ──

/**
 * Single-user live account (2026-09-25): the OWNERSHIP LOCK IS DISABLED.
 *
 * The guard that used to live here pinned the live book to one auth identity
 * (`ownerSubject` / `ownerKey`, src/lib/live-owner.ts). It was added because
 * a shared deployment must not let a visitor arm someone else's real-money
 * bot, but on this deployment it only ever locked the OWNER out: every
 * sign-in is an anonymous Convex Auth identity whose first subject segment is
 * re-minted when browser storage is cleared, so the arm/stop/settings
 * mutations threw "belongs to a different authenticated user" for a session
 * that was in fact the same human.
 *
 * This app is private and single-user, so the identity pin is gone. What
 * remains is the check that actually matters: the caller must be signed in
 * (the /live route is behind RequireAuth, and the crons are internal). Any
 * signed-in session can now arm, stop, and configure the book.
 *
 * `ownerSubject` / `ownerKey` stay in the schema as inert legacy fields —
 * existing rows keep their values and nothing reads them.
 */
async function requireLiveOwner(ctx: MutationCtx) {
  // OPERATOR GATE (2026-10-30): identity alone is not authorization. See
  // users.requireOperator — a guest session is signed in but is not an
  // operator, and this check is what stops one arming a real-money book.
  const identity = await requireOperator(ctx);
  const account = await ctx.db
    .query("liveAccount")
    .withIndex("by_name", (q) => q.eq("name", "live"))
    .first();
  if (!account) {
    const seed = await readLiveDefaults(ctx);
    const id = await ctx.db.insert("liveAccount", {
      name: "live",
      enabled: false,
      leverage: seed.leverage,
      riskPct: seed.riskPct,
      maxOpenPositions: seed.maxOpenPositions,
    });
    return { id, subject: identity.subject };
  }
  return { id: account._id, subject: identity.subject };
}

export const assertLiveOwner = mutation({
  args: {},
  handler: async (ctx) => {
    const owner = await requireLiveOwner(ctx);
    return { ok: true, subject: owner.subject };
  },
});

async function ensureLiveAccountRow(ctx: MutationCtx) {
  const existing = await ctx.db
    .query("liveAccount")
    .withIndex("by_name", (q) => q.eq("name", "live"))
    .first();
  if (existing) return existing;
  const seed = await readLiveDefaults(ctx);
  const id = await ctx.db.insert("liveAccount", {
    name: "live",
    enabled: false,
    leverage: seed.leverage,
    riskPct: seed.riskPct,
    maxOpenPositions: seed.maxOpenPositions,
  });
  const doc = await ctx.db.get(id);
  return doc;
}

export const ensureLiveAccount = mutation({
  args: {},
  handler: async (ctx) => {
    // Operator gate (2026-10-30): which risk / slot defaults a freshly-armed
    // book inherits is a decision, not a read.
    await requireOperator(ctx);
    return await ensureLiveAccountRow(ctx);
  },
});

/** Server-side twin: the live tick has no user session to authorize. */
export const ensureLiveAccountInternal = internalMutation({
  args: {},
  handler: async (ctx) => await ensureLiveAccountRow(ctx),
});

export const getLiveAccount = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("liveAccount")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
  },
});

/** Backfill-only: patch PnL fields on an already-closed live ledger row
 *  (2026-09-09). Used by the deal-history reconciler for rows closed outside
 *  the engine (manual closes on MEXC). Refuses to touch open rows and
 *  refuses to overwrite a non-null pnlUsd (idempotent backfills). */
export const patchLiveTradePnl = internalMutation({
  args: {
    id: v.id("liveTrades"),
    exitPrice: v.optional(v.number()),
    pnlUsd: v.number(),
    realizedR: v.optional(v.number()),
    feesUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const trade = await ctx.db.get(args.id);
    if (!trade) return { ok: false, reason: "not-found" };
    if (trade.status !== "closed") return { ok: false, reason: "not-closed" };
    if (trade.pnlUsd != null) return { ok: false, reason: "already-has-pnl" };
    await ctx.db.patch(args.id, {
      exitPrice: args.exitPrice ?? trade.exitPrice,
      pnlUsd: args.pnlUsd,
      realizedR: args.realizedR,
      feesUsd: args.feesUsd,
    });
    // AUDIT FIX: this reconcile path writes pnlUsd on rows the engine closed
    // WITHOUT PnL (manual / liquidation closes), but it used to leave the
    // aggregated liveStats doc untouched — so the /live header silently
    // drifted from the ledger. Measured on the live book: the doc reported
    // 4 wins / -$2.18 while the raw rows held 8 wins / -$2.39. Rebuild the
    // aggregate from the closed book so the numbers you audit by always match
    // the rows you actually have.
    await recomputeLiveStats(ctx);
    return { ok: true };
  },
});

/**
 * MANUAL RE-ARM (2026-10-22): clear a loss-streak disarm.
 *
 * The breaker's default behaviour is a HARD disarm after N consecutive losses
 * (liveBreakerMaxLossStreak, default 6) — entries stay vetoed until this runs.
 * It is deliberately a separate, operator-driven action: no timer, no win and
 * no calendar reset releases it.
 *
 * `triggeredAt = now` is what stops the very same streak re-tripping on the
 * next tick: the losses that caused the disarm are now pre-trigger history, so
 * the fresh-evidence rule only re-disarms on a loss that closes AFTER the
 * re-arm. Exits / SL / TP are untouched by the breaker either way.
 */
export const rearmLiveBreaker = mutation({
  args: {},
  handler: async (ctx) => {
    await requireLiveOwner(ctx);
    const acc = await ctx.db
      .query("liveAccount")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
    if (!acc) return { ok: false, reason: "no-account" };
    const now = Date.now();
    await ctx.db.patch(acc._id, {
      liveBreakerManualDisarmedAt: undefined,
      liveBreakerPausedUntil: undefined,
      liveBreakerTriggeredAt: now,
      // Re-arming the breaker is the operator saying "count from here", so it
      // also moves the streak reset line (2026-10-24). Without it the button
      // stopped a re-trip but left the page reading 5/6 — see resetLiveLossStreak.
      liveBreakerStreakResetAt: now,
    });
    return { ok: true, rearmedAt: now, streakResetAt: now };
  },
});

/**
 * RESET THE LOSS STREAK (2026-10-24).
 *
 * The streak is DERIVED from the closed ledger (computeLiveLossStreak), so
 * there is no stored counter to zero: rearmLiveBreaker() only stamps
 * triggeredAt, which stops a re-trip but leaves the count reading N/limit.
 * This stamps the reset line the entry tick filters on
 * (liveBreakerStreakResetAt) — every close that exited before it is excluded
 * from the count, so the next tick reports 0/limit and the breaker needs a
 * full fresh streak before it can fire again.
 *
 * History is NOT edited. The written-off closes keep their rows, their P&L and
 * their place in every total; only this one counter stops seeing them, which is
 * why the reset can be audited after the fact.
 */
export const resetLiveLossStreak = internalMutation({
  // `at` makes the reset schedulable without becoming a recurring hazard: a
  // cron-driven call more than 20 min from its intended instant is refused, so
  // a registration that fires in a later year no-ops instead of silently
  // wiping a live loss streak on a day nobody chose.
  args: { at: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (args.at != null && Math.abs(Date.now() - args.at) > 20 * 60_000) {
      return { ok: false, reason: "outside the ±20 min window" };
    }
    const acc = await ctx.db
      .query("liveAccount")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
    if (!acc) return { ok: false, reason: "no-account" };
    const now = Date.now();
    await ctx.db.patch(acc._id, { liveBreakerStreakResetAt: now });
    return {
      ok: true,
      resetAt: now,
      previousResetAt: acc.liveBreakerStreakResetAt ?? null,
    };
  },
});

/** Start / stop the live bot (the big button on the Live page). */
export const setLiveEnabled = mutation({
  args: { enabled: v.boolean() },
  handler: async (ctx, args) => {
    await requireLiveOwner(ctx);
    const acc = await ctx.db
      .query("liveAccount")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
    const now = Date.now();
    if (acc) {
      const patch: Record<string, any> = { enabled: args.enabled };
      if (args.enabled) {
        patch.enabledSince = now;
        patch.firstEnabledAt = acc.firstEnabledAt ?? now;
        // ARMING IS A RE-ARM (2026-10-22): the Start button is the operator
        // putting the book back on, so it also clears a breaker disarm. The
        // triggeredAt stamp marks the streak that tripped it as pre-trigger
        // history — the same rule as rearmLiveBreaker — so a plain Start
        // cannot immediately re-disarm on the old losses.
        patch.liveBreakerManualDisarmedAt = undefined;
        patch.liveBreakerPausedUntil = undefined;
        patch.liveBreakerTriggeredAt = now;
      } else if (acc.enabled && acc.enabledSince) {
        patch.totalEnabledMs = (acc.totalEnabledMs ?? 0) + (now - acc.enabledSince);
        patch.enabledSince = undefined;
      }
      await ctx.db.patch(acc._id, patch);
      return { ok: true, enabled: args.enabled };
    }
    const seed = await readLiveDefaults(ctx);
    const id = await ctx.db.insert("liveAccount", {
      name: "live",
      enabled: args.enabled,
      leverage: seed.leverage,
      riskPct: seed.riskPct,
      maxOpenPositions: seed.maxOpenPositions,
      enabledSince: args.enabled ? now : undefined,
      firstEnabledAt: args.enabled ? now : undefined,
    });
    return { ok: true, enabled: args.enabled, id };
  },
});

/**
 * ONE-SHOT SCHEDULED ARM (2026-10-24).
 *
 * The operator cannot press Start on a weekday evening, so a cron owns the
 * arming. This is deliberately NOT setLiveEnabled in disguise: it can only
 * ever turn the book ON (never off), and it refuses to fire outside a ±20 min
 * window around its scheduled instant. Cron expressions have no year field, so
 * that window is the one-shot guarantee — the same registration firing in any
 * later year is ~365 days off and no-ops instead of arming the live book on a
 * day nobody chose.
 *
 * The arm itself is a RE-ARM, identical to the Start button: a breaker disarm
 * is cleared and liveBreakerTriggeredAt is stamped, so the streak that would
 * have disarmed the book becomes pre-trigger history.
 */
export const armLiveScheduled = internalMutation({
  args: { at: v.number(), note: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const skew = now - args.at;
    if (Math.abs(skew) > 20 * 60_000) {
      return {
        ok: false,
        reason: `outside the ±20 min window (skew ${Math.round(skew / 60_000)} min)`,
      };
    }
    const acc = await ctx.db
      .query("liveAccount")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
    if (!acc) return { ok: false, reason: "no-account" };
    if (acc.enabled) return { ok: false, reason: "already-enabled" };
    await ctx.db.patch(acc._id, {
      enabled: true,
      enabledSince: now,
      firstEnabledAt: acc.firstEnabledAt ?? now,
      liveBreakerManualDisarmedAt: undefined,
      liveBreakerPausedUntil: undefined,
      liveBreakerTriggeredAt: now,
      lastScanResult:
        `SCHEDULED ARM — ${args.note ?? "scheduled"} · fired ${new Date(now).toISOString()} · ` +
        `risk ${acc.riskPct}% · max ${acc.maxOpenPositions} open · last balance $${acc.balanceUsd ?? "unknown"}`,
    });
    return { ok: true, enabled: true, at: now };
  },
});

/**
 * RETIRED (2026-09-25): the ownership lock is disabled on this single-user
 * app, so there is nothing left to take over. The endpoint is kept only so
 * any stale client call fails loudly instead of "function not found"; it
 * now just confirms auth and touches nothing.
 */
export const claimLiveOwnership = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required");
    return {
      ok: true,
      claimed: false,
      reason: "ownership disabled — any signed-in session can arm the book",
    };
  },
});

/** RETIRED with the ownership lock: always reports "allowed" once signed in. */
export const getLiveOwnership = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return { authenticated: false, isOwner: true, reason: "Authentication required" };
    return { authenticated: true, isOwner: true, reason: null };
  },
});

export const updateLiveSettings = mutation({
  args: {
    leverage: v.optional(v.number()),
    riskPct: v.optional(v.number()),
    maxOpenPositions: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireLiveOwner(ctx);
    const acc = await ctx.db
      .query("liveAccount")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
    const patch: Record<string, any> = {};
    if (args.leverage != null) patch.leverage = Math.max(1, Math.min(125, Math.round(args.leverage)));
    // 2% HARD CEILING (Phase 7): the live book is real money — a riskPct
    // above MAX_RISK_PCT_PER_TRADE is clamped, never stored.
    if (args.riskPct != null) patch.riskPct = clampRiskPct(args.riskPct, MAX_RISK_PCT_PER_TRADE);
    if (args.maxOpenPositions != null) {
      patch.maxOpenPositions = Math.max(1, Math.min(LIVE_MAX_OPEN_POSITIONS_UPPER, Math.round(args.maxOpenPositions)));
    }
    if (!acc) {
      const seed = await readLiveDefaults(ctx);
      const id = await ctx.db.insert("liveAccount", {
        name: "live",
        enabled: false,
        leverage: patch.leverage ?? seed.leverage,
        riskPct: patch.riskPct ?? seed.riskPct,
        maxOpenPositions: patch.maxOpenPositions ?? seed.maxOpenPositions,
      });
      return { ok: true, id };
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(acc._id, patch);
    return { ok: true };
  },
});

// ── New-account defaults (what a FRESH liveAccount row starts with) ──
// Edited from the /live Risk settings card ("Also save as defaults for new
// accounts"). No doc = built-in LIVE_DEFAULT_* constants apply (risk 1%).

export const getLiveDefaults = query({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query("liveDefaults")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first(),
});

export const setLiveDefaults = mutation({
  args: {
    leverage: v.optional(v.number()),
    riskPct: v.optional(v.number()),
    maxOpenPositions: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireLiveOwner(ctx);
    const doc = await ctx.db
      .query("liveDefaults")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
    const fallback = await readLiveDefaults(ctx);
    // Same clamps as updateLiveSettings — nothing stored out of range.
    const leverage = args.leverage != null
      ? Math.max(1, Math.min(125, Math.round(args.leverage)))
      : (doc?.leverage ?? fallback.leverage);
    const riskPct = args.riskPct != null
      ? clampRiskPct(args.riskPct, MAX_RISK_PCT_PER_TRADE)
      : clampRiskPct(doc?.riskPct ?? fallback.riskPct, MAX_RISK_PCT_PER_TRADE);
    const maxOpenPositions = args.maxOpenPositions != null
      ? Math.max(1, Math.min(LIVE_MAX_OPEN_POSITIONS_UPPER, Math.round(args.maxOpenPositions)))
      : (doc?.maxOpenPositions ?? fallback.maxOpenPositions);
    const now = Date.now();
    if (doc) {
      await ctx.db.patch(doc._id, { leverage, riskPct, maxOpenPositions, updatedAt: now });
    } else {
      await ctx.db.insert("liveDefaults", {
        name: "live",
        leverage,
        riskPct,
        maxOpenPositions,
        updatedAt: now,
      });
    }
    return { ok: true, leverage, riskPct, maxOpenPositions };
  },
});

/** Generic account-meta patch used by the liveBroker actions after each run. */
export const setLiveMeta = internalMutation({
  args: {
    balanceUsd: v.optional(v.number()),
    walletBalanceUsd: v.optional(v.number()),
    lastProbeAt: v.optional(v.number()),
    lastProbeOk: v.optional(v.boolean()),
    lastProbeDetail: v.optional(v.string()),
    lastScanAt: v.optional(v.number()),
    lastScanResult: v.optional(v.string()),
    lastExitAt: v.optional(v.number()),
    lastExitResult: v.optional(v.string()),
    lastRLockAt: v.optional(v.number()),
    lastRLockResult: v.optional(v.string()),
    lastRLockPending: v.optional(v.number()),
    lastRLockUnmanaged: v.optional(v.number()),
    lastRLockError: v.optional(v.union(v.null(), v.string())),
    lastIntentAt: v.optional(v.number()),
    lastIntentResult: v.optional(v.string()),
    lastIntentPending: v.optional(v.number()),
    lastIntentFailed: v.optional(v.number()),
    // LIVE circuit breaker persisted state (2026-09-10) — written by the
    // entry tick when the loss-streak breaker trips. Nulls clear a pause.
    liveBreakerPausedUntil: v.optional(v.union(v.null(), v.number())),
    liveBreakerTriggeredAt: v.optional(v.union(v.null(), v.number())),
    // Manual disarm stamp (2026-10-22): written when the loss-streak breaker
    // trips in manual mode. Null clears it — only rearmLiveBreaker does.
    liveBreakerManualDisarmedAt: v.optional(v.union(v.null(), v.number())),
    lastSignalTimes: v.optional(v.record(v.string(), v.number())),
    pendingSignals: v.optional(
      v.record(
        v.string(),
        v.object({
          side: v.string(),
          price: v.number(),
          time: v.number(),
        }),
      ),
    ),
    totalEntryErrors: v.optional(v.number()),
    // This tick's NEW entry errors — merged (not replaced) into the rolling
    // log so the last 10 survive across ticks.
    entryErrors: v.optional(
      v.array(
        v.object({
          time: v.number(),
          pair: v.string(),
          message: v.string(),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const acc = await ctx.db
      .query("liveAccount")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
    if (!acc) return { ok: false, reason: "no-account" };
    const patch: Record<string, any> = {};
    // NULLABLE fields must honour an explicit `null`: it is the documented way
    // to CLEAR a breaker pause. The generic loop below skips nulls, so a pause
    // could never be cleared (2026-09-11 audit). Handle them separately.
    const NULLABLE_CLEAR = [
      "liveBreakerPausedUntil",
      "liveBreakerTriggeredAt",
      "liveBreakerManualDisarmedAt",
      "lastRLockError",
    ] as const;
    for (const [k, val] of Object.entries(args)) {
      if ((NULLABLE_CLEAR as readonly string[]).includes(k)) continue;
      if (val != null) patch[k] = val;
    }
    for (const k of NULLABLE_CLEAR) {
      const val = (args as Record<string, unknown>)[k];
      if (val !== undefined) patch[k] = val ?? undefined; // null → remove the field
    }
    // Rolling entry-error log: append this tick's failures to the stored
    // history and keep the last 10. Newest last, like a console tail.
    if (args.entryErrors?.length) {
      patch.entryErrors = [...(acc.entryErrors ?? []), ...args.entryErrors].slice(-10);
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(acc._id, patch);
    return { ok: true };
  },
});

// ── Run-guard lease (mirrors acquireStrategyTickLock, tested in strategy-utils) ──

export const acquireLiveTickLock = internalMutation({
  args: { leaseMs: v.number() },
  handler: async (ctx, args): Promise<{ locked: boolean; reason?: string }> => {
    const acc = await ctx.db
      .query("liveAccount")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
    if (!acc) return { locked: false, reason: "no-account" };
    const expiry = tryAcquireLease(acc.scanLockUntil, Date.now(), args.leaseMs);
    if (expiry == null) return { locked: false, reason: "in-flight" };
    await ctx.db.patch(acc._id, { scanLockUntil: expiry });
    return { locked: true };
  },
});

export const releaseLiveTickLock = internalMutation({
  args: {},
  handler: async (ctx) => {
    const acc = await ctx.db
      .query("liveAccount")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
    if (acc) await ctx.db.patch(acc._id, { scanLockUntil: 0 });
  },
});

// ── Trade ledger ──

export const getLiveOpenTrades = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("liveTrades")
      .withIndex("by_status_entryTime", (q) => q.eq("status", "open"))
      .order("desc")
      .take(60);
  },
});

export const getLiveClosedTrades = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(200, args.limit ?? 100);
    return await ctx.db
      .query("liveTrades")
      .withIndex("by_status_entryTime", (q) => q.eq("status", "closed"))
      .order("desc")
      .take(limit);
  },
});

/**
 * Newest CLOSES by EXIT time — the loss-streak breaker's input (2026-10-22).
 *
 * `getLiveClosedTrades` is ordered by ENTRY time because that is the ledger
 * list's order. The breaker must count the closes that actually happened last:
 * a position entered 20 entries ago but closed today falls outside an
 * entry-ordered window, and that missing close can be the 6th loss — the
 * disarm would arrive a loss late. This query reads the same rows the streak
 * logic sorts by, and the `limit` (default 20) is well above the 6-loss
 * trigger even with unreconciled rows counted as losses.
 */
export const getLiveRecentClosedByExit = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(60, Math.max(1, args.limit ?? 20));
    return await ctx.db
      .query("liveTrades")
      .withIndex("by_status_exitTime", (q) => q.eq("status", "closed"))
      .order("desc")
      .take(limit);
  },
});

/**
 * Durable breaker transition log (2026-10-23).
 *
 * The breaker's own state is three fields on the liveAccount doc, and its
 * reason string is a single `lastScanResult` value replaced every tick — so a
 * trip or a release used to leave no reviewable record after 15 minutes.
 * These rows are the audit trail: one per transition, written by the entry
 * tick, read by the panel/diagnostics. Never called on an ordinary tick.
 */
export const recordLiveBreakerEvent = internalMutation({
  args: {
    at: v.number(),
    kind: v.string(), // "trip" | "release"
    trigger: v.string(), // "loss-streak" | "next-session"
    reason: v.string(),
    lossStreak: v.number(),
    session: v.optional(v.string()),
    sessionStart: v.optional(v.number()),
    sessionEnd: v.optional(v.number()),
    closes: v.optional(v.number()),
    netR: v.optional(v.number()),
    minCloses: v.optional(v.number()),
    disarmedForMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("liveBreakerEvents", args);
  },
});

/** Newest breaker transitions first — the audit trail for trips and releases. */
export const getLiveBreakerEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(100, Math.max(1, args.limit ?? 20));
    return await ctx.db.query("liveBreakerEvents").withIndex("by_at").order("desc").take(limit);
  },
});

/** Raw dump of the whole live ledger — used by mining exportTrades so the
 *  Claude backtest dump covers REAL trades alongside paper books. */
export const getLiveTradesRaw = query({
  args: {},
  handler: async (ctx) => await ctx.db.query("liveTrades").collect(),
});

/**
 * Wipe the live ledger: all liveTrades rows, the liveStats aggregate, and
 * the account's trade counters (entries / closes / errors + per-pair signal
 * state + entry-error log). Keeps the liveAccount row itself — bot settings
 * (leverage, risk%, maxOpenPositions, balance snapshots) survive, so
 * re-arming starts with a fresh ledger, not a fresh account. Safe only with
 * no open exchange positions; the caller stops live first.
 */
export const purgeLiveLedger = internalMutation({
  args: { reason: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const trades = await ctx.db.query("liveTrades").collect();
    const stats = await ctx.db.query("liveStats").first();

    // ARCHIVE BEFORE DELETE (audit fix 2026-09-11): the purge used to destroy
    // the only record of what the bot did with real money, with no copy and no
    // audit trail. Write the whole ledger (+ stats) into liveLedgerArchive
    // first so a mis-click is recoverable.
    if (trades.length > 0 || stats) {
      await ctx.db.insert("liveLedgerArchive", {
        purgedAt: Date.now(),
        reason: args.reason,
        tradeCount: trades.length,
        trades: trades as any[],
        stats: stats ?? undefined,
      });
    }

    for (const t of trades) await ctx.db.delete(t._id);
    if (stats) await ctx.db.delete(stats._id);

    const acc = await ctx.db
      .query("liveAccount")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
    if (acc) {
      await ctx.db.patch(acc._id, {
        totalEntries: 0,
        totalCloses: 0,
        totalEntryErrors: 0,
        lastSignalTimes: undefined,
        pendingSignals: undefined,
        entryErrors: undefined,
        // The purged ledger is the EVIDENCE for the loss-streak breaker, so a
        // manual disarm cannot survive it (2026-10-22): with zero remaining
        // closes the "6 consecutive losses" verdict is no longer derivable, and
        // leaving the stamp would block a clean book forever.
        liveBreakerManualDisarmedAt: undefined,
        liveBreakerPausedUntil: undefined,
        liveBreakerTriggeredAt: undefined,
        lastScanResult: "Ledger purged — awaiting re-arm",
      });
    }
    return {
      deleted: trades.length,
      statsReset: !!stats,
      accountReset: !!acc,
    };
  },
});

export const getLiveClosedStats = query({
  args: {},
  handler: async (ctx) => {
    // I/O optimization (mirrors paper's bookStats): the /live header stats
    // read ONE aggregated liveStats doc instead of collecting up to 500
    // closed liveTrades rows on every subscription invalidation. Fallback to
    // the raw scan only if the doc doesn't exist yet (e.g. rows closed before
    // this aggregation shipped) — once markLiveClosed writes the doc, the
    // fallback is never hit again.
    const doc = await ctx.db.query("liveStats").first();
    if (doc) {
      const { closedCount, wins, totalPnl, totalFeesUsd, realizedRSum } = doc;
      let grossWin = doc.grossWinUsd;
      let grossLoss = doc.grossLossUsd;
      if (grossWin == null || grossLoss == null) {
        // Display-only fallback for a doc written before the gross legs
        // shipped: one bounded scan fills them until the next close rebuilds
        // the doc (markLiveClosed calls recomputeLiveStats in that case).
        const rows = await ctx.db
          .query("liveTrades")
          .withIndex("by_status_entryTime", (q) => q.eq("status", "closed"))
          .take(500);
        grossWin = rows.reduce((s, t) => s + Math.max(0, t.pnlUsd ?? 0), 0);
        grossLoss = rows.reduce((s, t) => s + Math.max(0, -(t.pnlUsd ?? 0)), 0);
      }
      return {
        closedCount,
        wins,
        losses: closedCount - wins,
        totalPnl,
        totalFees: totalFeesUsd,
        avgR: closedCount > 0 ? realizedRSum / closedCount : 0,
        winRate: closedCount > 0 ? (wins / closedCount) * 100 : 0,
        grossWin,
        grossLoss,
      };
    }
    const closed = await ctx.db
      .query("liveTrades")
      .withIndex("by_status_entryTime", (q) => q.eq("status", "closed"))
      .order("desc")
      .take(500);
    const closedCount = closed.length;
    const wins = closed.filter((t) => (t.pnlUsd ?? 0) > 0).length;
    const totalPnl = closed.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
    const totalFees = closed.reduce((s, t) => s + (t.feesUsd ?? 0), 0);
    const rSum = closed.reduce((s, t) => s + (t.realizedR ?? 0), 0);
    return {
      closedCount,
      wins,
      losses: closedCount - wins,
      totalPnl,
      totalFees,
      avgR: closedCount > 0 ? rSum / closedCount : 0,
      winRate: closedCount > 0 ? (wins / closedCount) * 100 : 0,
      grossWin: closed.reduce((s, t) => s + Math.max(0, t.pnlUsd ?? 0), 0),
      grossLoss: closed.reduce((s, t) => s + Math.max(0, -(t.pnlUsd ?? 0)), 0),
    };
  },
});

/**
 * Record a REAL exchange entry (called by liveBroker after the order filled).
 * Dedupe rules mirror paperTrading.insertTrade: same (coin, signalTime) can
 * never open twice, and a coin with an open live position can't re-enter.
 */
export const recordLiveEntry = internalMutation({
  args: {
    intentId: v.optional(v.id("liveTrades")),
    coin: v.string(),
    type: v.string(),
    entryTime: v.number(),
    signalTime: v.optional(v.number()),
    signalPrice: v.optional(v.number()),
    entryPrice: v.optional(v.number()),
    slPrice: v.number(),
    tpPrice: v.number(),
    // R-lock trailing exit policy (2026-09-20). Omitted = fixed TP.
    trailStartR: v.optional(v.number()),
    trailStepR: v.optional(v.number()),
    trailMaxR: v.optional(v.number()),
    // Frozen 1R distance in price (2026-09-21) — the lock's ruler, so a later
    // exchange-fill refinement of entryPrice cannot re-scale stored R state.
    riskPx: v.optional(v.number()),
    volContracts: v.number(),
    notionalUsd: v.number(),
    marginUsd: v.number(),
    leverage: v.number(),
    orderId: v.optional(v.string()),
    externalOid: v.optional(v.string()),
    positionId: v.optional(v.union(v.string(), v.number())),
    rLockAnchorPrice: v.optional(v.number()),
    session: v.optional(v.string()),
    exchangeStop: v.optional(v.boolean()),
    // Entry enrichment (paper parity, see schema) — best-effort context
    // attached post-fill by liveBroker; never required for an entry.
    regime: v.optional(v.string()),
    volPct: v.optional(v.number()),
    spreadPct: v.optional(v.number()),
    btcTrendAtEntry: v.optional(v.string()),
    btcChange1h: v.optional(v.number()),
    htfEma20_4h: v.optional(v.number()),
    htfEma50_4h: v.optional(v.number()),
    htfTrend1h: v.optional(v.string()),
    htfVol4h: v.optional(v.number()),
    htfVol4hAvg: v.optional(v.number()),
    distToSwingSr: v.optional(v.number()),
    fundingRate: v.optional(v.number()),
    openInterestDelta: v.optional(v.number()),
    bidAskImbalance: v.optional(v.number()),
    pairVsBtc1h: v.optional(v.number()),
    // ── Paper parity, entry side (2026-09-23) ──
    // The score vector is in hand at entry, but the live book used to send it
    // only to strategySignals, leaving the trade row unable to answer any
    // question about what the decision looked like.
    longScore: v.optional(v.number()),
    shortScore: v.optional(v.number()),
    dayOfWeek: v.optional(v.number()),
    // Factor-exposure cap (2026-09-23): estimated BTC beta at entry and the
    // book's signed net beta after admitting it.
    btcBetaAtEntry: v.optional(v.number()),
    netBtcBetaAtEntry: v.optional(v.number()),
    // H4 shadow tags (2026-09-23, record-only forward test — src/lib/h4-shadow.ts).
    shadowTags: v.optional(v.array(v.string())),
    shadowH4RangePct: v.optional(v.number()),
    shadowH4VolLog2: v.optional(v.number()),
    shadowRsi7: v.optional(v.number()),
    // D1 shadow tags v3 (2026-09-26, record-only): daily wick % + 5d return.
    d1UpWickPct: v.optional(v.number()),
    d1R5Pct: v.optional(v.number()),
    // Daily StochRSI %K (2026-10-02): the live builder has recorded it since
    // the d1-stoch candidate shipped; without this declaration the ENTIRE
    // recordLiveEntry call is rejected the moment a reading carries one.
    d1StochK: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    let intent: any = args.intentId ? await ctx.db.get(args.intentId) : null;
    // Older callers predate the explicit intent id. Resolve their durable row
    // by the stable exchange id before inserting anything; never fall back to
    // a fresh row here.
    if (!intent) {
      const candidates = await ctx.db
        .query("liveTrades")
        .withIndex("by_status", (q) => q.eq("status", "pending"))
        .collect();
      intent = candidates.find((row: any) =>
        (args.externalOid != null && row.externalOid === args.externalOid) ||
        (args.orderId != null && row.orderId === args.orderId) ||
        (row.coin === args.coin && row.type === args.type && row.entryTime === args.entryTime),
      );
    }
    if (!intent) return { inserted: false, reason: "intent-not-found" };
    const intentId = intent._id;
    if (intent.status === "open") {
      return { inserted: false, reason: "already-open", id: intentId };
    }
    if (
      intent.status !== "pending" ||
      !ACTIVE_ENTRY_INTENTS.has(String(intent.entryIntentStatus ?? "pending"))
    ) {
      return { inserted: false, reason: "intent-not-active" };
    }
    if (intent.coin !== args.coin || intent.type !== args.type) {
      return { inserted: false, reason: "intent-mismatch" };
    }

    await ctx.db.patch(intentId, {
      status: "open",
      entryIntentStatus: "filled",
      entryLastError: undefined,
      entryTime: args.entryTime,
      signalTime: args.signalTime,
      signalPrice: args.signalPrice,
      entryPrice: args.entryPrice,
      slPrice: args.slPrice,
      tpPrice: args.tpPrice,
      trailStartR: args.trailStartR,
      trailStepR: args.trailStepR,
      trailMaxR: args.trailMaxR,
      // The first open transition is the only point at which the actual fill
      // may stamp the ruler. Once this row is open, bracket retries and
      // entry-price refinement must never replace these values.
      ...(typeof args.riskPx === "number" && args.riskPx > 0 ? { riskPx: args.riskPx } : {}),
      ...(typeof args.rLockAnchorPrice === "number" && args.rLockAnchorPrice > 0
        ? { rLockAnchorPrice: args.rLockAnchorPrice }
        : {}),
      trailPeakR: 0,
      trailLockPrice: 0,
      trailReplayCursor: undefined,
      volContracts: args.volContracts,
      notionalUsd: args.notionalUsd,
      marginUsd: args.marginUsd,
      leverage: args.leverage,
      orderId: args.orderId ?? intent.orderId,
      externalOid: args.externalOid ?? intent.externalOid,
      positionId: args.positionId ?? intent.positionId,
      session: args.session,
      exchangeStop: args.exchangeStop ?? intent.exchangeStop,
      ...(args.exchangeStop === true || intent.exchangeStop === true
        ? { bracketIntentStatus: "attached" }
        : {}),
      regime: args.regime,
      volPct: args.volPct,
      spreadPct: args.spreadPct,
      btcTrendAtEntry: args.btcTrendAtEntry,
      btcChange1h: args.btcChange1h,
      htfEma20_4h: args.htfEma20_4h,
      htfEma50_4h: args.htfEma50_4h,
      htfTrend1h: args.htfTrend1h,
      htfVol4h: args.htfVol4h,
      htfVol4hAvg: args.htfVol4hAvg,
      distToSwingSr: args.distToSwingSr,
      fundingRate: args.fundingRate,
      openInterestDelta: args.openInterestDelta,
      bidAskImbalance: args.bidAskImbalance,
      pairVsBtc1h: args.pairVsBtc1h,
      longScore: args.longScore,
      shortScore: args.shortScore,
      dayOfWeek: args.dayOfWeek ?? new Date(args.entryTime).getUTCDay(),
      btcBetaAtEntry: args.btcBetaAtEntry,
      netBtcBetaAtEntry: args.netBtcBetaAtEntry,
      shadowTags: args.shadowTags,
      shadowH4RangePct: args.shadowH4RangePct,
      shadowH4VolLog2: args.shadowH4VolLog2,
      shadowRsi7: args.shadowRsi7,
      d1UpWickPct: args.d1UpWickPct,
      d1R5Pct: args.d1R5Pct,
      d1StochK: args.d1StochK,
    });

    const acc = await ctx.db
      .query("liveAccount")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
    if (acc) {
      await ctx.db.patch(acc._id, { totalEntries: (acc.totalEntries ?? 0) + 1 });
    }
    return { inserted: true, id: intentId };
  },
});

/** Pending entry rows are durable exchange intents, not managed positions yet. */
export const getLivePendingEntries = query({
  args: {},
  handler: async (ctx) =>
    (await ctx.db
      .query("liveTrades")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .order("desc")
      .take(50))
      .filter((t: any) => !["failed", "cancelled"].includes(String(t.entryIntentStatus ?? "pending"))),
});

const ACTIVE_ENTRY_INTENTS = new Set(["pending", "submitting", "submitted", "unknown"]);
const ACTIVE_CLOSE_INTENTS = new Set(["pending", "submitted", "unknown", "settling"]);
const ACTIVE_BRACKET_INTENTS = new Set(["pending", "submitted", "unknown"]);

/**
 * Create the ledger intent BEFORE submitting a real entry. The old path placed
 * the exchange order first and inserted the row afterwards, so a successful
 * fill plus a failed insert became an unmanaged real position.
 */
export const beginLiveEntry = internalMutation({
  args: {
    coin: v.string(),
    type: v.string(),
    entryTime: v.number(),
    signalTime: v.optional(v.number()),
    signalPrice: v.optional(v.number()),
    entryPrice: v.optional(v.number()),
    slPrice: v.number(),
    tpPrice: v.number(),
    trailStartR: v.optional(v.number()),
    trailStepR: v.optional(v.number()),
    trailMaxR: v.optional(v.number()),
    riskPx: v.optional(v.number()),
    rLockAnchorPrice: v.optional(v.number()),
    volContracts: v.number(),
    notionalUsd: v.number(),
    marginUsd: v.number(),
    leverage: v.number(),
    externalOid: v.string(),
    session: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.signalTime != null) {
      const dup = await ctx.db
        .query("liveTrades")
        .withIndex("by_coin_signalTime", (q) =>
          q.eq("coin", args.coin).eq("signalTime", args.signalTime as any),
        )
        .first();
      if (dup) return { inserted: false, reason: "duplicate-signal" };
    }
    const open = await ctx.db
      .query("liveTrades")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .filter((q) => q.eq(q.field("coin"), args.coin))
      .first();
    if (open) return { inserted: false, reason: "open-position" };
    const pending = await ctx.db
      .query("liveTrades")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .filter((q) => q.eq(q.field("coin"), args.coin))
      .first();
    if (pending && ACTIVE_ENTRY_INTENTS.has(String(pending.entryIntentStatus ?? "pending"))) {
      return { inserted: false, reason: "entry-intent-pending", id: pending._id };
    }

    const id = await ctx.db.insert("liveTrades", {
      coin: args.coin,
      type: args.type,
      status: "pending",
      entryTime: args.entryTime,
      signalTime: args.signalTime,
      signalPrice: args.signalPrice,
      entryPrice: args.entryPrice,
      slPrice: args.slPrice,
      tpPrice: args.tpPrice,
      trailStartR: args.trailStartR,
      trailStepR: args.trailStepR,
      trailMaxR: args.trailMaxR,
      riskPx: args.riskPx,
      rLockAnchorPrice: args.rLockAnchorPrice,
      volContracts: args.volContracts,
      notionalUsd: args.notionalUsd,
      marginUsd: args.marginUsd,
      leverage: args.leverage,
      externalOid: args.externalOid,
      entryIntentId: args.externalOid,
      entryIntentStatus: "pending",
      session: args.session,
    });
    return { inserted: true, id };
  },
});

export const markLiveEntrySubmitting = internalMutation({
  args: { id: v.id("liveTrades") },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade) return { ok: false, reason: "not-found" };
    if (trade.status === "open") return { ok: true, alreadyOpen: true };
    if (trade.status !== "pending" || !ACTIVE_ENTRY_INTENTS.has(String(trade.entryIntentStatus))) {
      return { ok: false, reason: "intent-not-active" };
    }
    await ctx.db.patch(args.id, { entryIntentStatus: "submitting" });
    return { ok: true };
  },
});

export const markLiveEntrySubmitted = internalMutation({
  args: { id: v.id("liveTrades"), orderId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade) return { ok: false, reason: "not-found" };
    if (trade.status === "open") return { ok: true, alreadyOpen: true };
    if (trade.status !== "pending" || !ACTIVE_ENTRY_INTENTS.has(String(trade.entryIntentStatus))) {
      return { ok: false, reason: "intent-not-active" };
    }
    await ctx.db.patch(args.id, {
      entryIntentStatus: "submitted",
      entrySubmittedAt: Date.now(),
      ...(args.orderId ? { orderId: args.orderId } : {}),
    });
    return { ok: true };
  },
});

export const markLiveEntryIntentError = internalMutation({
  args: {
    id: v.id("liveTrades"),
    error: v.string(),
    definitive: v.boolean(),
  },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade || trade.status !== "pending") return { ok: false, reason: "not-pending" };
    await ctx.db.patch(args.id, {
      entryIntentStatus: args.definitive ? "failed" : "unknown",
      entryLastError: args.error,
      ...(args.definitive ? { status: "cancelled" } : {}),
    });
    return { ok: true };
  },
});

/** Claim one bracket attachment attempt. A pending/unknown claim fences retries. */
export const claimLiveBracket = internalMutation({
  args: { id: v.id("liveTrades") },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade || !["pending", "open"].includes(trade.status)) {
      return { claimed: false, reason: "not-manageable" };
    }
    if (trade.exchangeStop === true || trade.bracketIntentStatus === "attached") {
      return { claimed: false, reason: "already-attached" };
    }
    if (ACTIVE_BRACKET_INTENTS.has(String(trade.bracketIntentStatus))) {
      return { claimed: false, reason: "intent-pending", intentId: trade.bracketIntentId };
    }
    const intentId = `br-${trade._id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await ctx.db.patch(args.id, {
      bracketIntentStatus: "pending",
      bracketIntentId: intentId,
      // The fence is TIME-BOUNDED (2026-09-24 mock-exchange audit): this stamp
      // is what expireLiveBracketIntent measures, so a cut reply or a process
      // death after this claim cannot block bracket recovery forever.
      bracketIntentAt: Date.now(),
    });
    return { claimed: true, intentId };
  },
});

/**
 * End a bracket attempt whose outcome can no longer be in flight.
 *
 * A bracket claim exists to stop two passes placing two stops for one position.
 * It is only meaningful while the request it fences could still be resolved, so
 * this mutation refuses to touch a fresh claim (`not-stale`) and refuses unless
 * the caller still holds the current intent id. The broker calls it AFTER it has
 * read the exchange's stop-order book and found no resting bracket for this
 * position, so expiring here cannot orphan a stop that actually landed — and any
 * bracket that did land is adopted before this is ever reached.
 */
export const expireLiveBracketIntent = internalMutation({
  args: { id: v.id("liveTrades"), intentId: v.string(), staleMs: v.number() },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade || !["pending", "open"].includes(trade.status)) {
      return { ok: false, reason: "not-manageable" };
    }
    if (trade.exchangeStop === true || trade.bracketIntentStatus === "attached") {
      return { ok: false, reason: "already-attached" };
    }
    if (String(trade.bracketIntentId ?? "") !== args.intentId) {
      return { ok: false, reason: "intent-changed" };
    }
    if (!ACTIVE_BRACKET_INTENTS.has(String(trade.bracketIntentStatus))) {
      return { ok: false, reason: "not-active" };
    }
    // Rows claimed before this field existed carry no stamp. Fall back to the
    // row's own creation time so a legacy fence — taken by a process that is
    // long dead — can still expire instead of wedging the position forever.
    // Current code stamps on every claim and on every ambiguous outcome, so
    // this only ever applies to rows written before the stamp shipped.
    const claimedAt = Number(trade.bracketIntentAt ?? 0) || Number(trade.entryTime ?? 0);
    const ageMs = Date.now() - claimedAt;
    if (!(claimedAt > 0) || !(ageMs >= args.staleMs)) {
      return { ok: false, reason: "not-stale", ageMs };
    }
    await ctx.db.patch(args.id, {
      bracketIntentStatus: "stale",
      bracketStaleAt: Date.now(),
      bracketLastError: `bracket intent expired after ${Math.round(ageMs / 60_000)}m with no resting exchange stop; retrying under a fresh claim`,
    });
    return { ok: true, ageMs };
  },
});

export const markLiveBracketAttached = internalMutation({
  args: {
    id: v.id("liveTrades"),
    intentId: v.string(),
    slPrice: v.number(),
    tpPrice: v.number(),
    positionId: v.optional(v.union(v.string(), v.number())),
    riskPx: v.optional(v.number()),
    rLockAnchorPrice: v.optional(v.number()),
    // STOP-AMEND (2026-09-26): the level the exchange stop actually rests at.
    // With a frozen ruler (riskPx > 0) the ledger's slPrice must NEVER be
    // rewritten by an adopt — slPrice + riskPx define the R units every rung
    // is measured in — so the resting level is recorded beside it instead.
    exchangeSlPrice: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade || !["pending", "open"].includes(trade.status)) {
      return { ok: false, reason: "not-manageable" };
    }
    if (trade.exchangeStop === true) return { ok: true, alreadyAttached: true };
    if (trade.bracketIntentId !== args.intentId) return { ok: false, reason: "intent-mismatch" };
    const sideSign = trade.type === "LONG" ? 1 : -1;
    const rulerFrozen = typeof trade.riskPx === "number" && trade.riskPx > 0;
    const anchor =
      args.rLockAnchorPrice ??
      trade.rLockAnchorPrice ??
      (rulerFrozen ? trade.slPrice + sideSign * trade.riskPx : args.slPrice);
    await ctx.db.patch(args.id, {
      exchangeStop: true,
      // FROZEN RULER: with riskPx present, slPrice stays as stamped at entry
      // (the exchange-confirmed level goes to exchangeSlPrice). Without it,
      // keep the pre-amend behaviour of adopting the exchange's level.
      slPrice: rulerFrozen ? trade.slPrice : args.slPrice,
      exchangeSlPrice: args.exchangeSlPrice ?? args.slPrice,
      tpPrice: args.tpPrice,
      ...(trade.positionId == null && args.positionId != null ? { positionId: args.positionId } : {}),
      bracketIntentStatus: "attached",
      bracketAttachedAt: Date.now(),
      // Never re-stamp a frozen ruler during a bracket retry.
      ...(typeof trade.riskPx !== "number" && args.riskPx != null ? { riskPx: args.riskPx } : {}),
      ...(trade.rLockAnchorPrice == null && anchor != null ? { rLockAnchorPrice: anchor } : {}),
    });
    return { ok: true };
  },
});

export const markLiveBracketFailed = internalMutation({
  args: { id: v.id("liveTrades"), intentId: v.string(), error: v.string(), definitive: v.boolean() },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade || trade.bracketIntentId !== args.intentId) return { ok: false, reason: "intent-mismatch" };
    await ctx.db.patch(args.id, {
      bracketIntentStatus: args.definitive ? "failed" : "unknown",
      bracketLastError: args.error,
      // An ambiguous attachment remains fenced until the next reconciliation
      // observes the exchange order. A definitive rejection is retryable.
      //
      // The staleness clock restarts HERE, not at the claim: an ambiguous
      // outcome observed late must still get a full unresolved window before
      // expireLiveBracketIntent may retry it.
      bracketIntentAt: Date.now(),
    });
    return { ok: true };
  },
});

/** Atomically claim the one close intent allowed to reach the exchange. */
export const claimLiveClose = internalMutation({
  args: {
    id: v.id("liveTrades"),
    reason: v.string(),
    requestedVol: v.number(),
    expectedPrice: v.optional(v.number()),
    exitTime: v.number(),
    pnlUsd: v.optional(v.number()),
    realizedR: v.optional(v.number()),
    feesUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade || trade.status !== "open") return { claimed: false, reason: "not-open" };
    if (ACTIVE_CLOSE_INTENTS.has(String(trade.closeIntentStatus))) {
      return {
        claimed: false,
        reason: "intent-pending",
        intentId: trade.closeIntentId,
        status: trade.closeIntentStatus,
      };
    }
    // MEXC caps externalOid at 32 chars (error 2030) — the previous 59-char
    // id (close- + 32-char trade id + ms + rand) made EVERY close order fail
    // request validation (live audit 2026-09-27: PUMP stuck open, 13 failed
    // close attempts while the R-lock wanted to bank +1.95R).
    // "close-" + 12-char trade tail + base36 ms + 3 rand = 31 chars.
    const intentId = `close-${trade._id.slice(-12)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`;
    await ctx.db.patch(args.id, {
      closeIntentStatus: "pending",
      closeIntentId: intentId,
      closeRequestedAt: Date.now(),
      closeRequestedVol: args.requestedVol,
      closeReason: args.reason,
      closeExpectedPrice: args.expectedPrice,
      closeExpectedExitTime: args.exitTime,
      closePnlUsd: args.pnlUsd,
      closeRealizedR: args.realizedR,
      closeFeesUsd: args.feesUsd,
      closeAttempts: (trade.closeAttempts ?? 0) + 1,
      closeLastError: undefined,
    });
    return { claimed: true, intentId };
  },
});

export const markLiveCloseSubmitted = internalMutation({
  args: { id: v.id("liveTrades"), intentId: v.string(), orderId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade) return { ok: false, reason: "not-found" };
    if (trade.status === "closed") return { ok: true, alreadyClosed: true };
    if (trade.closeIntentId !== args.intentId) return { ok: false, reason: "intent-mismatch" };
    await ctx.db.patch(args.id, {
      closeIntentStatus: "submitted",
      ...(args.orderId ? { exitOrderId: args.orderId } : {}),
    });
    return { ok: true };
  },
});

/** Fence a malformed active close record without pretending an order exists. */
export const markLiveCloseUnresolved = internalMutation({
  args: { id: v.id("liveTrades"), error: v.string() },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade || trade.status !== "open") return { ok: false, reason: "not-open" };
    if (!ACTIVE_CLOSE_INTENTS.has(String(trade.closeIntentStatus))) {
      return { ok: false, reason: "intent-not-active" };
    }
    await ctx.db.patch(args.id, {
      closeIntentStatus: "unknown",
      closeLastError: args.error,
    });
    return { ok: true };
  },
});

export const markLiveCloseFailed = internalMutation({
  args: { id: v.id("liveTrades"), intentId: v.string(), error: v.string(), definitive: v.boolean() },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade || trade.closeIntentId !== args.intentId) return { ok: false, reason: "intent-mismatch" };
    await ctx.db.patch(args.id, {
      closeIntentStatus: args.definitive ? "failed" : "unknown",
      closeLastError: args.error,
    });
    return { ok: true };
  },
});

/**
 * Attach paper-parity enrichment context to a live trade (regime, vol,
 * spread, funding, OI, BTC trend, HTF EMAs, imbalance…). Called by liveBroker
 * AFTER the order fills — best-effort metadata, never blocks or retries the
 * entry. Missing doc = nothing to patch (e.g. row already closed by a fast
 * exit tick).
 */
export const updateLiveEnrichment = internalMutation({
  args: {
    id: v.id("liveTrades"),
    enrichment: v.object({
      // Must mirror buildTradeEnrichment's EXACT return keys — Convex
      // v.object() rejects extra fields (ArgumentValidationError), and the
      // broker's catch swallows that, silently killing ALL enrichment.
      // session + atrPctAtEntry were missing pre-2026-09-07: every live
      // entry's patch threw and no regime/vol/funding/imbalance context was
      // ever persisted (only the flat session on recordLiveEntry).
      session: v.optional(v.string()),
      regime: v.optional(v.string()),
      volPct: v.optional(v.number()),
      spreadPct: v.optional(v.number()),
      btcTrendAtEntry: v.optional(v.string()),
      btcChange1h: v.optional(v.number()),
      atrPctAtEntry: v.optional(v.number()),
      htfEma20_4h: v.optional(v.number()),
      htfEma50_4h: v.optional(v.number()),
      htfTrend1h: v.optional(v.string()),
      htfVol4h: v.optional(v.number()),
      htfVol4hAvg: v.optional(v.number()),
      distToSwingSr: v.optional(v.number()),
      fundingRate: v.optional(v.number()),
      openInterestDelta: v.optional(v.number()),
      oiAtEntry: v.optional(v.number()),
      bidAskImbalance: v.optional(v.number()),
      pairVsBtc1h: v.optional(v.number()),
    }),
  },
  handler: async (ctx, args) => {
    const trade = await ctx.db.get(args.id);
    if (!trade) return { ok: false, reason: "not-found" };
    const patch: Record<string, any> = {};
    for (const [k, val] of Object.entries(args.enrichment)) {
      if (val != null) patch[k] = val;
    }
    if (Object.keys(patch).length > 0) await ctx.db.patch(args.id, patch);
    return { ok: true };
  },
});

/** Refine a live entry with the exchange's actual average fill price. */
export const refineLiveEntry = internalMutation({
  args: { id: v.id("liveTrades"), entryPrice: v.number(), notionalUsd: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const trade = await ctx.db.get(args.id);
    if (!trade || trade.status !== "open") return { ok: false };
    const patch: Record<string, any> = { entryPrice: args.entryPrice };
    if (args.notionalUsd != null) patch.notionalUsd = args.notionalUsd;
    await ctx.db.patch(args.id, patch);
    return { ok: true };
  },
});

/** Persist a bracket that was attached on a later retry, using the exact
 * tick-rounded levels accepted by MEXC. */
export const setLiveExchangeStop = internalMutation({
  args: {
    id: v.id("liveTrades"),
    slPrice: v.number(),
    tpPrice: v.number(),
    riskPx: v.optional(v.number()),
    rLockAnchorPrice: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const trade = await ctx.db.get(args.id);
    if (!trade || trade.status !== "open") return { ok: false, reason: "not-open" };
    if (!(args.slPrice > 0) || !(args.tpPrice > 0)) {
      return { ok: false, reason: "invalid-bracket" };
    }
    const anchor =
      args.rLockAnchorPrice ??
      (trade.rLockAnchorPrice != null
        ? trade.rLockAnchorPrice
        : typeof trade.riskPx === "number" && trade.riskPx > 0
          ? args.slPrice + (trade.type === "LONG" ? 1 : -1) * trade.riskPx
          : trade.entryPrice);
    await ctx.db.patch(args.id, {
      exchangeStop: true,
      slPrice: args.slPrice,
      tpPrice: args.tpPrice,
      bracketIntentStatus: "attached",
      bracketAttachedAt: Date.now(),
      ...(typeof trade.riskPx !== "number" && args.riskPx != null ? { riskPx: args.riskPx } : {}),
      ...(trade.rLockAnchorPrice == null && anchor != null ? { rLockAnchorPrice: anchor } : {}),
    });
    return { ok: true };
  },
});

/**
 * Record / clear the first-observed breach time on an exchange-bracketed
 * trade (dead-bracket backstop — see liveReconcile.liveExitTickSafe and the
 * R-lock pass in rLockExit). Call with a
 * `since` timestamp when a bracketed row's SL/TP level is first seen breached
 * and the position is still open; call with no `since` to clear it when price
 * recovers between the levels.
 */
export const setLiveBracketBreach = internalMutation({
  args: { id: v.id("liveTrades"), since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const trade = await ctx.db.get(args.id);
    if (!trade || trade.status !== "open") return { ok: false, reason: "not-open" };
    if (args.since == null) {
      await ctx.db.patch(args.id, { bracketBreachSince: undefined });
    } else {
      await ctx.db.patch(args.id, { bracketBreachSince: args.since });
    }
    return { ok: true };
  },
});

/**
 * Rebuild the liveStats doc from the whole closed live book (O(n) — used
 * ONLY to (re)seed a missing doc, mirroring paper's recomputeLayer2Stats).
 * markLiveClosed maintains the doc INCREMENTALLY (O(1) per close), and if the
 * doc is ever deleted or a close lands before the aggregation ever shipped,
 * this heals it so the /live header can never drift from a counter that
 * silently restarted at zero.
 */
async function recomputeLiveStats(ctx: MutationCtx) {
  const closed = await ctx.db
    .query("liveTrades")
    .withIndex("by_status_entryTime", (q) => q.eq("status", "closed"))
    .collect();
  let wins = 0;
  let totalPnl = 0;
  let totalFeesUsd = 0;
  let realizedRSum = 0;
  let grossWinUsd = 0;
  let grossLossUsd = 0;
  for (const t of closed) {
    const pnl = t.pnlUsd ?? 0;
    if (pnl > 0) wins++;
    // Profit factor's two legs. Split here (not from totalPnl) so the ratio
    // survives any mix of wins and losses.
    if (pnl > 0) grossWinUsd += pnl;
    else if (pnl < 0) grossLossUsd -= pnl;
    totalPnl += pnl;
    totalFeesUsd += t.feesUsd ?? 0;
    realizedRSum += t.realizedR ?? 0;
  }
  const payload = {
    closedCount: closed.length,
    wins,
    totalPnl,
    totalFeesUsd,
    realizedRSum,
    grossWinUsd,
    grossLossUsd,
    updatedAt: Date.now(),
  };
  const stats = await ctx.db.query("liveStats").first();
  if (stats) await ctx.db.patch(stats._id, payload);
  else await ctx.db.insert("liveStats", payload);
}

/** Mark a live trade closed after the exchange close order was accepted. */
/**
 * Persist R-lock trailing state (2026-09-20) — the live twin of
 * paperTrading.setTrailState. The 5-min r-lock tick sees ONE price per run, so
 * the running peak has to live on the row or the lock could never ratchet.
 * One-way on both fields: a stale or overlapping tick must never walk the
 * lock back down (that would silently resurface a full-R loss the lock had
 * already banked).
 */
export const setLiveTrailState = internalMutation({
  args: {
    id: v.id("liveTrades"),
    peakR: v.number(),
    lockPrice: v.number(),
    replayCursor: v.optional(v.number()),
    exchangeSlPrice: v.optional(v.number()),
    stopAmendedAt: v.optional(v.number()),
    amendAttempted: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade || trade.status !== "open") return false;
    const isLong = trade.type === "LONG";
    const curLock = trade.trailLockPrice ?? 0;
    const nextLock =
      curLock > 0 && args.lockPrice > 0
        ? isLong
          ? Math.max(curLock, args.lockPrice)
          : Math.min(curLock, args.lockPrice)
        : args.lockPrice > 0
          ? args.lockPrice
          : curLock;
    const nextPeak = Math.max(trade.trailPeakR ?? 0, args.peakR);
    const nextCursor =
      args.replayCursor != null
        ? Math.max(trade.trailReplayCursor ?? 0, args.replayCursor)
        : trade.trailReplayCursor;
    await ctx.db.patch(args.id, {
      trailPeakR: nextPeak,
      trailLockPrice: nextLock,
      ...(nextCursor != null ? { trailReplayCursor: nextCursor } : {}),
      // STOP-AMEND AUDIT (2026-09-26): when the caller has (tried to) move the
      // exchange SL to the new rung, record the resting level it aimed for and
      // when. Amend is one-way, so exchangeSlPrice only ever moves favourable.
      ...(args.exchangeSlPrice != null && args.exchangeSlPrice > 0
        ? { exchangeSlPrice: args.exchangeSlPrice, stopAmendedAt: args.stopAmendedAt }
        : {}),
      ...(args.amendAttempted ? { stopAmendAttempts: (trade.stopAmendAttempts ?? 0) + 1 } : {}),
    });
    return true;
  },
});

export const markLiveClosed = internalMutation({
  args: {
    id: v.id("liveTrades"),
    exitPrice: v.optional(v.number()),
    exitTime: v.number(),
    reason: v.string(),
    pnlUsd: v.optional(v.number()),
    realizedR: v.optional(v.number()),
    feesUsd: v.optional(v.number()),
    exitOrderId: v.optional(v.string()),
    closeIntentId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade) return { ok: false, reason: "not-found" };
    if (trade.status === "closed") return { ok: true, alreadyClosed: true };
    if (trade.status !== "open") return { ok: false, reason: "not-open" };
    if (
      args.closeIntentId != null &&
      ACTIVE_CLOSE_INTENTS.has(String(trade.closeIntentStatus)) &&
      trade.closeIntentId !== args.closeIntentId
    ) {
      return { ok: false, reason: "close-intent-mismatch" };
    }
    // ATTRIBUTION INVARIANT (2026-09-22). realizedR can never exceed the peak
    // the position actually reached: trailPeakR/trailLockPrice are written in
    // one atomic running-max patch, so a fill ABOVE the recorded peak means the
    // exit's provenance is unexplained. Six live winners carried that signature
    // — fills 0.35R to 1.66R above their own lock, no exitOrderId — and they
    // were +15.40R, 74% of the book's net profit. The ledger looked normal.
    //
    // Recorded, never corrected: clamping realizedR would hide the cause and
    // falsify the PnL record. This only makes the impossibility loud the moment
    // it happens, instead of three audits later.
    const attributionAnomaly = detectAttributionAnomaly({
      realizedR: args.realizedR,
      trailPeakR: trade.trailPeakR,
      reason: args.reason,
    });
    if (attributionAnomaly) {
      console.warn(`[markLiveClosed] ${trade.coin} ${trade.type}: ${attributionAnomaly}`);
    }
    await ctx.db.patch(args.id, {
      status: "closed",
      closeIntentStatus: "settled",
      exitPrice: args.exitPrice,
      exitTime: args.exitTime,
      reason: args.reason,
      pnlUsd: args.pnlUsd,
      realizedR: args.realizedR,
      feesUsd: args.feesUsd,
      exitOrderId: args.exitOrderId,
      attributionAnomaly,
    });
    // EXECUTION RECORD (Stage 3, record-only, fail-open): stop trigger vs the
    // exchange fill, liq level and realized R from the ACTUAL fill. Scheduled
    // as its own mutation, so it can never affect the close above.
    await scheduleExecRecord(ctx, { kind: "exit", ref: { table: "liveTrades", id: String(args.id) } });
    const acc = await ctx.db
      .query("liveAccount")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
    if (acc) {
      // Cooldown parity with paper (2026-09-07): paper's cooldown tracker is
      // stamped on BOTH entry and exit (noteCooldown in insertTrade +
      // closeTrade), so a pair can't re-enter for 1h after a stop-loss even
      // if the trade was short. Live only persisted the entry signal time
      // (liveEntryTick's recentTimes map), so after a quick stop the same
      // pair could re-fire up to an hour sooner than the paper engine would
      // allow. Stamp the exit time here — the per-pair cooldown check in
      // liveEntryTick reads this map, so this blocks re-entry for 1h from the
      // close, mirroring paper exactly. The open-trade seed in the tick keeps
      // its entry-signal stamp too; both expire naturally.
      const map = { ...(acc.lastSignalTimes ?? {}) };
      map[trade.coin] = args.exitTime;
      await ctx.db.patch(acc._id, {
        totalCloses: (acc.totalCloses ?? 0) + 1,
        lastSignalTimes: map,
      });
    }

    // Maintain the aggregated liveStats doc (single read-modify-write on one
    // doc — closes are rare and Convex retries write conflicts). Without it
    // the /live header stats fall back to scanning closed history.
    const pnl = args.pnlUsd ?? 0;
    const fees = args.feesUsd ?? 0;
    const r = args.realizedR ?? 0;
    const stats = await ctx.db.query("liveStats").first();
    if (stats && (stats.grossWinUsd == null || stats.grossLossUsd == null)) {
      // Pre-2026-10-28 doc: the gross legs did not exist yet. Folding from 0
      // would understate them for the whole book, so rebuild once instead —
      // recompute reads the row patched above, so this close is included and
      // every later close takes the O(1) path below.
      await recomputeLiveStats(ctx);
    } else if (stats) {
      // Normal path — O(1) fold: add this close to the running counters.
      await ctx.db.patch(stats._id, {
        closedCount: stats.closedCount + 1,
        wins: stats.wins + (pnl > 0 ? 1 : 0),
        totalPnl: stats.totalPnl + pnl,
        totalFeesUsd: stats.totalFeesUsd + fees,
        realizedRSum: stats.realizedRSum + r,
        grossWinUsd: (stats.grossWinUsd ?? 0) + (pnl > 0 ? pnl : 0),
        grossLossUsd: (stats.grossLossUsd ?? 0) + (pnl < 0 ? -pnl : 0),
        updatedAt: Date.now(),
      });
    } else {
      // Self-heal (mirrors paper foldLayer2Stats): the doc was deleted or
      // this close landed before the aggregation ever shipped. Rebuild from
      // the whole closed book so the counters can never silently drift.
      await recomputeLiveStats(ctx);
    }
    return { ok: true };
  },
});

/**
 * PAPER PARITY — close-side analytics (2026-09-23).
 *
 * The live book has always recorded the ENTRY half of paper's context but
 * none of the close-side fields (excursion, capture, duration, vol delta,
 * cross-asset move). Everything this project has actually
 * measured about exits — the give-back cohort (53.5% of losers were ≥ +0.5R in
 * profit before dying), MFE capture, time-to-peak — was therefore paper-only
 * and could never be confirmed on the independent real-money book.
 *
 * The 7 close call sites in liveBroker/rLockExit cannot compute these inline
 * (some close on a reconstructed exchange fill, some on a bracket breach) so
 * they are filled by a bounded, idempotent backfill instead: `mfeR == null` is
 * the work queue, `patchLiveCloseAnalytics` is the writer. Missing readings
 * stay missing — never zero.
 */
export const patchLiveCloseAnalytics = internalMutation({
  args: {
    id: v.id("liveTrades"),
    mfeR: v.optional(v.number()),
    maeR: v.optional(v.number()),
    timeToMfe: v.optional(v.number()),
    timeToMae: v.optional(v.number()),
    mfeCaptureRatio: v.optional(v.number()),
    barsHeld: v.optional(v.number()),
    durationBucket: v.optional(v.string()),
    entrySlippageBps: v.optional(v.number()),
    volAtExit: v.optional(v.number()),
    volDelta: v.optional(v.number()),
    volRatioAtEntry: v.optional(v.number()),
    fundingCostUsd: v.optional(v.number()),
    btcMoveDuringTrade: v.optional(v.number()),
    ethMoveDuringTrade: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.id);
    if (!trade) return { ok: false, reason: "not-found" };
    const patch: Record<string, any> = {};
    for (const [k, val] of Object.entries(args)) {
      if (k !== "id" && val != null) patch[k] = val;
    }
    // volAtEntry mirrors the row's stored entry volatility — paper stores
    // volPct at entry and derives volAtEntry from it, so live parity means the
    // same derivation rather than a second measurement.
    if (trade.volPct != null) patch.volAtEntry = trade.volPct;
    if (Object.keys(patch).length > 0) await ctx.db.patch(args.id, patch);
    return { ok: true };
  },
});

/**
 * REPAIR (2026-09-23 audit) — un-measure the rows a bug previously wrote
 * zeros to, so the corrected backfill can redo them.
 *
 * The first version of backfillLiveCloseAnalytics called the kline fetch WITHOUT
 * `endMs`, which defaults to Date.now(). For a trade closed days earlier the
 * returned window did not contain the trade, so `held` was empty and
 * excursionR — which returns `{mfeR: 0, maeR: 0}` for empty input, not
 * undefined — wrote a literal zero. Because the work queue is `mfeR == null`,
 * a written zero marks the row DONE: six live rows were frozen with
 * `mfeR 0 / maeR 0`, including trades that closed at −1.01R and therefore had
 * maeR ≥ 1 by construction.
 *
 * The marker is the PROVABLY-IMPOSSIBLE state `mfeR === 0 && maeR === 0` on a
 * trade held for at least one completed bar: price is not exactly at entry on
 * every bar of a real hold, so a completed bar always shows SOME excursion.
 * (The `barsHeld > 0` condition keeps a genuinely sub-bar hold — no complete
 * 15m candle inside the trade, where 0/0 IS the honest reading — out of the
 * repair.) Clearing those fields to undefined puts the rows back in the queue;
 * the anchored backfill refills them from the right window. fundingCostUsd is
 * deliberately NOT cleared — it derives from the row's own duration and
 * notional, so it was never affected.
 *
 * A second candidate test was TRIED AND REJECTED in the same audit:
 * `maeR < |realizedR|` on a loser looks impossible — you cannot exit at your
 * stop without having reached it — but it is not, because the excursion counts
 * COMPLETED candles only (`closeTime <= exitTime`, paper's convention), so the
 * partial bar in which a stop-out happens is excluded by construction. A trade
 * that dies in its final bar legitimately reports maeR below |realizedR|. That
 * test was in an earlier version of this mutation and it produced three false
 * positives that re-flagged themselves after every refill, which is how the
 * mistake was caught; it must not be reinstated.
 */
export const repairLiveCloseAnalytics = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 200);
    const rows = await ctx.db
      .query("liveTrades")
      .withIndex("by_status_entryTime", (q) => q.eq("status", "closed"))
      .take(200);
    // "Held for at least one COMPLETED bar" — the same condition that makes 0/0
    // impossible. Derived from the timestamps rather than `barsHeld`, whose
    // rounding turns an 8-minute hold into "1 bar" while `held` (completed
    // candles only) is still empty; using it would mis-classify sub-bar holds.
    const spansCompletedBar = (t: any) => (t.exitTime ?? 0) - (t.entryTime ?? 0) >= 900_000;
    const impossible = (t: any) => t.mfeR === 0 && t.maeR === 0 && spansCompletedBar(t);
    const bad = rows.filter(impossible).slice(0, limit);
    for (const t of bad) {
      await ctx.db.patch(t._id, {
        mfeR: undefined,
        maeR: undefined,
        timeToMfe: undefined,
        timeToMae: undefined,
        mfeCaptureRatio: undefined,
        volAtEntry: undefined,
        volAtExit: undefined,
        volDelta: undefined,
        volRatioAtEntry: undefined,
        btcMoveDuringTrade: undefined,
        ethMoveDuringTrade: undefined,
        barsHeld: undefined,
        durationBucket: undefined,
        entrySlippageBps: undefined,
      });
    }
    return { status: "ok", scanned: rows.length, repaired: bad.length };
  },
});

/**
 * RELABEL LIVE EXIT PROVENANCE (2026-09-23) — one-shot repair, idempotent.
 *
 * THE GAP. Exit attribution shipped 2026-09-22: `nameExitFromFill` names a
 * close from the exchange's own fill against the row's stored bracket, and
 * `detectAttributionAnomaly` stores a verdict when a close realizes more R than
 * the position's own recorded peak (arithmetically impossible for a rung exit).
 * Neither could help the rows that closed BEFORE it: 36 of the live book's 86
 * exits still read "Closed on exchange (manual / TP-SL / liquidation)" — a
 * label naming four causes and identifying none — and none of the 86 carries an
 * attribution verdict at all.
 *
 * That shrug is not cosmetic. It is why the two books' exits could not be
 * compared at reason level (paper labels 389/389), and it is what hid six
 * winners worth +15.40R — 74% of the live book's net profit — whose fills sat
 * 0.35R to 1.66R ABOVE their own recorded trail lock. Every one of those rows
 * has a recovered fill, so the evidence was always on the row.
 *
 * WHAT IT WRITES: `reason` and `attributionAnomaly` only, via the pure planner
 * in live-math.ts (policy + tests there). Prices, realizedR, PnL and fees are
 * never touched — this changes what the ledger SAYS about an exit, never what
 * it earned. A row whose reason the engine set from an order it placed is left
 * alone, so re-running converges rather than churning, and the forward path in
 * liveBroker remains the only writer for new closes.
 */
export const relabelLiveExitProvenance = mutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    const rows = await ctx.db
      .query("liveTrades")
      .withIndex("by_status_entryTime", (q) => q.eq("status", "closed"))
      .order("desc")
      .take(200);
    const results: string[] = [];
    let relabelled = 0;
    let flagged = 0;
    for (const t of rows) {
      if (relabelled + flagged >= limit) break;
      const patch = planLiveExitRelabel(t as any);
      if (patch.reason === undefined && patch.attributionAnomaly === undefined) continue;
      await ctx.db.patch(t._id, patch as any);
      if (patch.reason !== undefined) {
        relabelled++;
        results.push(`${t.coin}: "${t.reason}" -> "${patch.reason}"`);
      }
      if (patch.attributionAnomaly !== undefined) {
        flagged++;
        results.push(`${t.coin}: FLAGGED ${patch.attributionAnomaly}`);
      }
    }
    return { status: "ok", scanned: rows.length, relabelled, flagged, results: results.slice(0, 60) };
  },
});

/**
 * Bounded, idempotent backfill of the live close-side analytics above.
 * Processes a few of the newest rows lacking mfeR per run so it can never
 * become a burst of MEXC calls, and self-heals: a run that never happened is
 * simply picked up by the next one (no cursor, like the R-lock bar replay).
 *
 * WRITES BOUND THE RUN, SCANS ARE BOUNDED SEPARATELY (2026-09-23, found by
 * audit). The first version sliced the queue to `limit` and counted every
 * processed row as filled — which combined into a permanent stall:
 *   - the queue is sorted NEWEST first, and the newest rows all needed
 *     `volRatioAtEntry`, whose computation silently returned nothing because
 *     the kline window (ageBars + 20) landed exactly 20 bars before the fill
 *     and the guard needs 21. See the window note below.
 *   - so the same 6 rows sat at the head of the queue, were re-scanned, wrote
 *     nothing, and reported `filled: 6` — leaving the 29 rows behind them
 *     never reached.
 * Two consecutive manual runs proved it: `filled: 6, remaining: 0` with the
 * pending count and the populated-field count BOTH unchanged. At the cron's
 * then-cadence that was ~290 MEXC kline fetches/day for zero progress, forever.
 *
 * Now: `filled` counts WRITES, `skipped` counts scans that produced nothing to
 * write, and the scan head is allowed to run MAX_SCANS_PER_WRITE× the write
 * budget deep, so an unsatisfiable row cannot starve the rows behind it.
 */
const MAX_SCANS_PER_WRITE = 4;

export const backfillLiveCloseAnalytics = action({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 6, 1), 30);
    const closed: any[] = await ctx.runQuery(api.liveEngine.getLiveClosedTrades, { limit: 120 });
    // The queue is "missing ANY close-side reading", not just mfeR. The live
    // ledger's 86 already-closed rows predate volRatioAtEntry/fundingCostUsd,
    // and the live book is disarmed — so a forward-only queue would leave live
    // with parity fields on nothing at all. Widening it here backfills them
    // from the klines this job already fetches, at no extra MEXC cost.
    const queue = closed
      .filter(
        (t) =>
          (t.mfeR == null || t.volRatioAtEntry == null || t.fundingCostUsd == null) &&
          t.entryPrice > 0 &&
          t.exitTime &&
          t.entryTime,
      )
      .sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0));
    // See the header note: the scan head must be wider than the write budget,
    // or a row that can never be satisfied holds the head of the queue forever.
    const pending = queue.slice(0, limit * MAX_SCANS_PER_WRITE);
    if (pending.length === 0) return { status: "ok", filled: 0, skipped: 0, remaining: 0 };

    let filled = 0;
    let skipped = 0;
    const results: string[] = [];
    for (const t of pending) {
      if (filled >= limit) break;
      try {
        // ANCHOR THE WINDOW AT THE EXIT — `endMs` is not optional here.
        // fetchKlines defaults `endMs` to Date.now(), and this job runs for
        // trades closed days earlier, so an unanchored fetch returns a window
        // that does not contain the trade at all: `held` is empty, excursionR
        // returns a literal `{mfeR: 0, maeR: 0}` (it does NOT return undefined
        // for empty input), the row is written `mfeR: 0`, and because the work
        // queue is `mfeR == null` it is never revisited — a permanently wrong
        // zero, which is exactly what "missing readings stay missing, never
        // zero" forbids. It also made volAtExit read TODAY's ATR and the
        // cross-asset move read the last N hours rather than the trade's life.
        // Same off-by-one class as the signal-fill lab's; found by audit.
        // WINDOW: ageBars + 45, not + 20 (2026-09-23). `volRatioAtEntry` below
        // needs 21 CLOSED bars at or before the fill (20 for the SMA + the entry
        // bar itself), and this window ends at the exit — so the pre-entry
        // budget is 20 bars, exactly one short. Six rows sat unfillable in the
        // queue because of it and stalled the whole job. Paper's equivalent
        // (backfillKlineFields) fetches a flat 500 bars for the same reason: the
        // window is not what bounds the cost, the row count is.
        const ageBars = Math.max(1, Math.ceil((t.exitTime - t.entryTime) / 900_000));
        const k15: any[] = await relayKlines(ctx, t.coin, "15m", ageBars + 45, t.exitTime);
        // Structural guard against re-introducing the above: if the fetched
        // window does not even reach the trade (a very new listing, a gappy
        // page), record nothing rather than a zero.
        if (!k15.length || k15[0].openTime > t.exitTime) {
          results.push(`${t.coin}: no bars covering ${new Date(t.exitTime).toISOString()} — skipped`);
          continue;
        }
        // A row only missing volRatioAtEntry/fundingCostUsd needs k15 and
        // nothing else — so the excursion profile and its cross-asset I/O is
        // skipped rather than paid for and discarded.
        const needExcursion = t.mfeR == null;
        const held = k15.filter((k) => k.closeTime > t.entryTime && k.closeTime <= t.exitTime);
        // RULER: measure in the SAME R as realizedR. The live book stamps
        // `riskPx` (|entryPx − stop| at entry) precisely because
        // `refineLiveEntry` later rewrites entryPrice to the exchange's average
        // fill — which re-scales |entryPrice − slPrice| under the stored levels.
        // Paper never refines its entries, so its excursionRFull/slPrice pair is
        // self-consistent; live must anchor on riskPx or its excursions are
        // quoted in a slightly different R than the R it reports.
        const riskPx = typeof t.riskPx === "number" && t.riskPx > 0 ? t.riskPx : undefined;
        const slForExcursion = riskPx
          ? t.type === "LONG"
            ? t.entryPrice - riskPx
            : t.entryPrice + riskPx
          : t.slPrice;
        const exc = excursionR(t.type, t.entryPrice, slForExcursion, held);
        const barsHeld = Math.round((t.exitTime - t.entryTime) / 900_000);

        // volRatioAtEntry — the entry bar's volume against the 20-bar SMA
        // BEFORE it, the same definition the paper backfill uses. `held` cannot
        // serve here (it starts after entry), so read the entry bar off k15
        // directly: the newest bar CLOSED at or before the fill.
        let volRatioAtEntry: number | undefined;
        {
          const closed = k15.filter((k: any) => k.closeTime <= t.entryTime);
          if (closed.length >= 21) {
            let volSum = 0;
            for (let i = closed.length - 21; i < closed.length - 1; i++) volSum += closed[i].volume;
            const volSma = volSum / 20;
            if (volSma > 0) volRatioAtEntry = +(closed[closed.length - 1].volume / volSma).toFixed(3);
          }
        }

        // fundingCostUsd — the paper book's own model (FUNDING_COST_PER_8H in
        // paperTrading), so the two books' cost accounting is comparable rather
        // than merely both non-zero. Needs the notional the live row carries.
        const held8hWindows = Math.floor((t.exitTime - t.entryTime) / (8 * 3_600_000));
        const fundingCostUsd =
          t.notionalUsd > 0 ? held8hWindows * 0.0001 * t.notionalUsd : undefined;

        // volAtExit: ATR(14) as % of the newest close (same formula paper uses).
        let volAtExit: number | undefined;
        if (needExcursion && k15.length >= 15) {
          let sum = 0;
          for (let i = k15.length - 14; i < k15.length; i++) {
            sum += Math.max(
              k15[i].high - k15[i].low,
              Math.abs(k15[i].high - k15[i - 1].close),
              Math.abs(k15[i].low - k15[i - 1].close),
            );
          }
          const lastClose = k15[k15.length - 1].close;
          if (lastClose > 0) volAtExit = +((sum / 14 / lastClose) * 100).toFixed(4);
        }

        // Cross-asset move across the trade's life (1h bars, like paper).
        const tradeHours = Math.max(2, Math.ceil((t.exitTime - t.entryTime) / 3_600_000));
        const bars = Math.min(tradeHours + 2, 100);
        // Anchored at the exit like k15 — otherwise "move during trade" reports
        // whatever the market did in the hours before the BACKFILL ran.
        const btcMoveDuringTrade = needExcursion
          ? await relayKlines(ctx, "BTC", "1h", bars, t.exitTime).then(movePctOf).catch(() => undefined)
          : undefined;
        const ethMoveDuringTrade = needExcursion
          ? await relayKlines(ctx, "ETH", "1h", bars, t.exitTime).then(movePctOf).catch(() => undefined)
          : undefined;

        const volAtEntry = t.volPct ?? undefined;

        // NEVER overwrite a reading that exists. Two writers touch these rows
        // (this backfill and rLockExit's monitor path, which stamps its own
        // peak-derived mfeR) and the two are not the same measurement, so a
        // row that already carries one keeps it — which is also what lets the
        // queue include rows that were closed before the volRatio/funding
        // fields existed without disturbing their excursion record.
        // Nothing to write? Then it was not progress — do not claim a fill, and
        // let the scan move on so this row cannot starve the queue behind it.
        const patch: Record<string, any> = {
          ...(t.mfeR == null
            ? {
                mfeR: exc.mfeR,
                maeR: exc.maeR,
                timeToMfe: exc.timeToMfe,
                timeToMae: exc.timeToMae,
                mfeCaptureRatio: captureRatioOf(t.realizedR ?? 0, exc.mfeR),
                barsHeld,
                durationBucket: durationBucketOf(barsHeld),
                entrySlippageBps: slippageBpsOf(t.entryPrice, t.signalPrice),
                volAtExit,
                volDelta:
                  volAtEntry != null && volAtExit != null
                    ? +(volAtExit - volAtEntry).toFixed(4)
                    : undefined,
                btcMoveDuringTrade,
                ethMoveDuringTrade,
              }
            : {}),
          ...(t.volRatioAtEntry == null && volRatioAtEntry != null ? { volRatioAtEntry } : {}),
          ...(t.fundingCostUsd == null && fundingCostUsd != null ? { fundingCostUsd } : {}),
        };
        if (Object.keys(patch).length === 0) {
          skipped++;
          continue;
        }
        await ctx.runMutation(api.liveEngine.patchLiveCloseAnalytics, { id: t._id, ...patch });
        filled++;
      } catch (e: any) {
        results.push(`${t.coin}: ${e?.message ?? e}`);
      }
    }
    return {
      status: "ok",
      filled,
      skipped,
      remaining: Math.max(0, queue.length - filled),
      results,
    };
  },
});
