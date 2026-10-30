/**
 * LAYER 2 — Strategy Engine
 *
 * Reads pre-computed metrics from `marketMetrics` table (Layer 1)
 * and combines with EMA momentum logic to generate trade signals.
 *
 * Fixes applied:
 *   - Uses 15m candles (400 bars) for proper EMA warming
 *   - Processes pairs in parallel batches (max 6 concurrent)
 *   - Reads balance dynamically from paper account
 *   - Enforces 1-hour cooldown between trades per pair
 *   - Logs all signals to strategySignals table for audit
 *   - Removes dead volCheckBars config
 *   - Excludes incomplete candles from EMA computation
 */

import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { scheduleEntryRecordByKey, scheduleExecRecord } from "./executionRecord";
import { requireOperator } from "./users";
import type { Kline } from "../lib/types";
import { htfVerdictOf } from "../lib/mexc/mexcFetchers";
import {
  relayAllTickers,
  relayHtfRaw,
  relayKlines,
  relayKlinesBatch,
  relayTickerPrice,
} from "./marketFetch";
import { timedTick } from "./tickTiming";
import { computeAtrPct } from "../lib/mexc/indicators";
import { newestClosedBarOpen } from "./htfCache";
import { CHOP_GATE_DEFAULTS, chopGateVerdict } from "../lib/chop-gate";
import { btcRegimeBlocks, btcRegimeDownBlocks, type BtcRegime } from "../lib/btc-regime";
import { getBtcRegimeCached } from "./btcRegimeCache";
import { resolveSignalBarTime, tryAcquireLease, validateKlines } from "../lib/strategy-utils";
import { computeBreakerState } from "../lib/circuit-breaker";
import {
  computeSessionBreaker,
  emptySessionWindowCarry,
  sessionBreakerDayKey,
  measuredWindowDays,
  sessionWindowCarryOf,
  sessionWindowCutoff,
  type SessionBreakerBucket,
  type SessionBreakerState,
} from "../lib/session-breaker";
import {
  measureCompletedSessionSince,
  sessionWindowAt,
  type LiveBreakerSessionEvidence,
} from "../lib/live-breaker";
import {
  computeCoinPriority,
  type CoinPriorityBucket,
  type CoinPriorityState,
} from "../lib/coin-priority";
import { SCALE_OUT_POLICY, advanceShadowLive } from "../lib/shadow-book";
import { advisorShadowTags, advisorVetoForMode } from "../lib/htf-advisor";
import { clampRiskPct } from "../lib/costs";
import { contractMetaFull } from "../lib/contract-meta";
import { entryGuardBlock, riskPctUnset, roundPriceToTick } from "../lib/entry-guards";
import { roundVol } from "../lib/live-math";
import {
  computeExcursion,
  snapshotExcursion,
  closeFeesUsd,
  fundingCostUsd as fundingCostFor,
  holdProfile,
  captureRatio,
} from "../lib/exit-telemetry";
import {
  DEFAULT_CONFIG,
  type SignalResult,
  type StrategyConfig,
  computeLayer2Signal,
  resolveConfig,
  resolvePaperConfig,
  resolveFundingRate,
  rLockConfigError,
  blocklistUnion,
} from "../lib/layer2-signal";
// R-lock trailing exit (2026-09-20) — see src/lib/r-lock.ts.
import { rLockEnabled, rLockStep, lockRFromPrice } from "../lib/r-lock";
import { buildTradeEnrichment, foldBookStatsBatch } from "./paperTrading";
// Factor-exposure cap (2026-09-23) — pure beta estimator + signed net exposure.
import {
  estimateBtcBeta,
  netBtcBeta,
  signedBeta,
  betaCapBlocks,
} from "../lib/btc-beta";
// H4 shadow tags (2026-09-23) — record-only forward-test instrumentation.
import { evalShadowTags, extAtrApprox, h4GateBlocks, PULLBACK_EXT_ATR, rsi7FromCloses } from "../lib/h4-shadow";
import { d1ShadowTags } from "../lib/d1-shadow";
import { getH4ShadowCached } from "./h4ShadowCache";
import { getD1ShadowCached } from "./d1ShadowCache";
import { ltf5mGateBlocks, ltf5mShadowTag } from "../lib/ltf5m";
import { stallShadowTags } from "../lib/stall-shadow";
// Resilient journal writes (2026-10-02) — see src/lib/resilient-batch-write.ts.
import { bisectBatchWrite, writeErrorMessage } from "../lib/resilient-batch-write";
// ── Constants ──

// HTF GATE ERA MIGRATION (2026-09-13): one-time stamp that flips both layer2
// rows to the measured 4h EMA75 gate (run-layer2-4h-ema-sweep.ts: EMA75 tied-
// best on the era-long surrogate, mid-plateau of the 60–90 band, best OOS
// half; same plateau the proxy sweep found). Bump the variant to re-stamp.
const LAYER2_VARIANT = "layer2-v4-downblock";

const LEVERAGE = 60; // 60x (2026-09-09): user config — liq ≈1.67% vs 1.5% stop
// Risk per trade (2026-09-10): now a per-book config knob (cfg.riskPct,
// StrategyConfigPanel → Risk group). This fallback only applies if a stored
// row somehow predates the field AND the default merge fails — normally dead.
const RISK_PCT = 0.01; // 1% risk per trade (user config 2026-09-09)
// Metrics freshness gate. Was 5 min — equal to the Layer 1 cadence, so a
// single jittered tick silently excluded the whole universe (scanned: 0,
// status still "ok"). 8 min = 1.6× the cadence, so one missed/slow L1 tick
// can never blank the strategy scan.
const STALE_METRICS_MAX_AGE_MS = 8 * 60_000;
const COOLDOWN_MS = 60 * 60_000; // 1 hour cooldown between trades per pair
// strategyTick run-guard lease: max time a tick may hold the lock before a
// crashed tick's lease auto-expires (see acquireStrategyTickLock). Set above
// the 15-min cron cadence so a slow tick blocks the next fire, but a dead
// tick can never deadlock the book.
const TICK_LEASE_MS = 25 * 60_000;
// Tick-summary "signals" classifier (audit fix): a pair PRODUCED a signal when
// the entry logic qualified a side — either it entered, or it was blocked by a
// gate that runs AFTER computeLayer2Signal (trend / stretch / RSI / advisor /
// flow / HTF / session / side switch / dedupe). Pre-scoring outcomes are
// excluded by name. The previous counter matched "no signal" and incremented
// on it, i.e. it reported the pairs that produced NOTHING as "signals".
const NO_SIGNAL_RE =
  /(no signal|cooldown|skip|blocklist|open position already exists|error)/;
const PARALLEL_BATCH_SIZE = 6; // max concurrent MEXC fetch pairs
const EMA_KLINE_BARS = 400; // 400 × 15m = ~4.2 days of data for EMA warming
const EMA_MIN_BARS = 60; // need at least 60 candles for EMA 30 to stabilize
// Circuit breaker (paper only, 2026-09-08): rolling WR window over the most
// recent N closed layer2 trades (matches the rollingWr20 tag logged at entry).
const BREAKER_WINDOW = 20;
// HTF advisor freshness gate (2026-09-08): the advisor cron runs 1 min after
// each 4H close (6 runs/day). A doc older than ~5h means the cron missed or
// the deployment is stalled — the gate FAILS OPEN (no vetoes) rather than
// enforcing divergence flags computed against 3-day-old bars.
const ADVISOR_MAX_AGE_MS = 5 * 60 * 60 * 1000;

// StrategyConfig / DEFAULT_CONFIG / computeLayer2Signal now live in
// src/lib/layer2-signal.ts — the pure shared scoring module ALSO used by the
// live MEXC engine (convex/liveBroker.ts) so paper Layer 2 and live run
// identical signal logic. DEFAULT_CONFIG + computeLayer2Signal are imported
// above; StrategyConfig stays imported for local type annotations.

// ── Queries ──

// Layer 1 metrics now live in the NEWEST layer1Ticks doc (one write per tick,
// all pairs — see marketData.recordLayer1Tick). These queries flatten it back
// to the old per-pair shape so the strategy tick and any panel consume
// identical data; the legacy marketMetrics table is only a fallback for the
// window before the first batched tick exists.
export const getStrategyState = query({
  args: { pair: v.string() },
  handler: async (ctx, args) => {
    const tick = await ctx.db
      .query("layer1Ticks")
      .withIndex("by_timestamp")
      .order("desc")
      .first();
    const m = tick?.metrics?.[args.pair];
    if (m) return { pair: args.pair, ...m, fetchedAt: tick.timestamp };
    // Legacy fallback (pre-migration rows)
    return await ctx.db
      .query("marketMetrics")
      .withIndex("by_pair", (q) => q.eq("pair", args.pair))
      .first();
  },
});

export const getAllStrategyStates = query({
  args: {},
  handler: async (ctx) => {
    const tick = await ctx.db
      .query("layer1Ticks")
      .withIndex("by_timestamp")
      .order("desc")
      .first();
    if (tick) {
      return Object.entries(tick.metrics).map(([pair, m]) => ({
        pair,
        ...m,
        fetchedAt: tick.timestamp,
      }));
    }
    // Legacy fallback (pre-migration rows)
    return await ctx.db.query("marketMetrics").collect();
  },
});

// ── Config Endpoints ──

// Per-book config rows (2026-09-08): paper gathers data under the original
// "ema-momentum" row; live trades under its own "live" row. The strategy
// console panel controls ONE book at a time (defaults to Live) so a session/
// switch edit can never leak across books. New rows seed from the other
// book's current values.
const CONFIG_BOOK_NAME = (book: string | undefined) => (book === "live" ? "live" : "ema-momentum");

async function readConfigRow(ctx: any, name: string) {
  return ctx.db
    .query("strategyConfig")
    .withIndex("by_name", (q: any) => q.eq("name", name))
    .first();
}

/**
 * One-time HTF-gate era stamp for BOTH layer2 rows (paper "ema-momentum" +
 * "live"), idempotent — no-ops once layer2Variant matches LAYER2_VARIANT.
 * Writes the measured gate (4h EMA75, run-layer2-4h-ema-sweep.ts) explicitly
 * over the stored panel values and re-arms both per-side switches. Bump
 * LAYER2_VARIANT to re-stamp after a future era change.
 */
export const ensureLayer2GateMigration = mutation({
  args: {},
  handler: async (ctx): Promise<string[]> => {
    const notes: string[] = [];
    for (const name of ["ema-momentum", "live"] as const) {
      const row = await readConfigRow(ctx, name);
      if (!row || (row as any).layer2Variant === LAYER2_VARIANT) continue;
      await ctx.db.patch(row._id, {
        htfShortEma: 75,
        htfLongEma: 75,
        htfTf: "4h",
        htfGateShort: true,
        htfGateLong: true,
        btcRegimeEnabled: true,
        btcRegimeDownBlock: true,
        layer2Variant: LAYER2_VARIANT,
        updatedAt: Date.now(),
        updatedBy: "layer2-v4-downblock-migration",
      } as any);
      notes.push(`config[${name}]: HTF gate 4h EMA75 kept · BTC-regime side gate ON · DOWN-BLOCK ON · long-slope min ON (paper exp) [${LAYER2_VARIANT}]`);
    }
    return notes;
  },
});

// ── SHARED GATE CONFIG (2026-10-21) ─────────────────────────────────────────
// ONE tuning surface. Every GATE field now resolves from the PAPER row for BOTH
// books, and a save writes the gate fields to both rows — so a threshold can
// never mean one thing on paper and another on live again.
//
// WHY. Paper is the book every gate in this system is validated on; live is the
// actuator that reads the same evidence. Per-book gate rows let the two drift
// (the blocklist divergence of 2026-09-19 is the documented case: live blocked
// 21 pairs while paper blocked 2, so the validation book traded what the live
// book refused). Divergent thresholds make every paper→live comparison a
// comparison of two different strategies.
//
// WHAT STAYS PER BOOK (the only exceptions):
//   · session breaker — paper measures it, live enforces it. The arm switch and
//     the thresholds are legitimately per-book.
//   · coin priority — same split: paper-measured ranking, live ordering/veto.
// Everything else (EMA, scoring, risk, filters, advisor, direction switches,
// session allowlists, blocklist) is shared.
const PER_BOOK_CONFIG_KEYS = [
  "sessionBreakerEnabled",
  "sessionBreakerLookbackDays",
  "sessionBreakerMinTrades",
  "sessionBreakerMinProfitR",
  "coinPriorityEnabled",
  "coinPriorityLookbackDays",
  "coinPriorityMinTrades",
  "coinPriorityBlockAvoid",
  "name",
  "updatedAt",
  "_id",
  "_creationTime",
] as const;
const PER_BOOK_KEY_SET = new Set<string>(PER_BOOK_CONFIG_KEYS);

/** The per-book half of a config row (session breaker + coin priority). */
function perBookConfigValues(row: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const key of PER_BOOK_CONFIG_KEYS) {
    if (row && row[key] !== undefined) out[key] = row[key];
  }
  return out;
}

/** The shared half of a config row — every gate. */
function sharedGateConfigValues(row: any): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [key, value] of Object.entries(row ?? {})) {
    if (PER_BOOK_KEY_SET.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export const getConfig = query({
  args: { book: v.optional(v.union(v.literal("paper"), v.literal("live"))) },
  handler: async (ctx, args) => {
    const name = CONFIG_BOOK_NAME(args.book);
    const existing = await readConfigRow(ctx, name);
    // SHARED GATES (2026-10-21): the LIVE view is the paper row's gates with
    // its own session-breaker / coin-priority fields on top. The paper view is
    // simply the paper row. Read-time overlay, not a migration: no writes, no
    // cron, and a stale live row can never resurrect an old threshold.
    const paperRow = name === "live" ? await readConfigRow(ctx, "ema-momentum") : existing;
    const base =
      name === "live"
        ? {
            // Fallback to the live row's own gates when the paper row is
            // missing (fresh deployment) — never to bare defaults, which would
            // silently re-arm every gate at its shipped value.
            ...(paperRow
              ? sharedGateConfigValues(paperRow)
              : sharedGateConfigValues(existing)),
            ...perBookConfigValues(existing),
          }
        : existing;
    if (base) {
      const merged = { ...DEFAULT_CONFIG, ...base }; // default-merge so docs predating a new field never surface undefined/0
      // ── BLOCKLIST PARITY (2026-09-22) ──
      // Per-book config rows are right for strategy knobs (sessions, side
      // switches, EMA periods) — that is why the console edits one book at a
      // time. They are WRONG for a SAFETY list, and this is where that broke:
      // by 2026-09-19 the live row blocked 21 pairs while the paper row blocked
      // 2 (ENA, JASMY), so the paper book — the bed every gate in this system is
      // validated on — took 115 of its next 201 entries (57%) on pairs the live
      // book refuses to trade at all.
      //
      // Measured out-of-sample on paper's own record (src/lib/run-portfolio-gate-lab.ts,
      // --since=2026-09-19T04:27Z, the stamp on the live list):
      //   blocked cohort  115 trades  WR 45.3%  +0.223 R/trade
      //   kept cohort      86 trades  WR 55.8%  +0.556 R/trade
      //   as booked       201 trades  maxDD 14.09R  R/DD  5.22
      //   blocked          86 trades  maxDD  6.16R  R/DD  7.77
      // The full 8.9-day book agrees (R/DD 10.82 → 16.83; WR 53.7% → 64.9%), and
      // the universe cut carries a structural side effect the lab measured too:
      // with 10 tradeable crypto pairs a book CANNOT hold more than 10 at once,
      // against a measured peak of 25 on the 30-pair universe — the exposure
      // that produced the 2026-09-21 giveback. A concurrency cap on top of it
      // changes nothing (the lab's "blocklist + ranked cap 10" is identical to
      // "blocklist" alone), while the cap on its own makes risk-adjusted return
      // WORSE, FIFO or ranked.
      //
      // Resolved at READ time rather than migrated into the row: no writes, no
      // cron, no race with the tick, and the panel shows the list the gate
      // actually enforces. Union, and PAPER ONLY — the live row is never
      // written, so this can never widen what the trading book may do. The
      // union is monotone: adding a pair to either list blocks it on both, and
      // REMOVING one takes an edit to both rows. A safety list that can shrink
      // from one side alone is how this divergence happened.
      if (name !== "live") {
        const liveRow = await readConfigRow(ctx, "live");
        merged.blocklist = blocklistUnion(
          ((base as any).blocklist ?? []) as string[],
          ((liveRow as any)?.blocklist ?? []) as string[],
        );
      }
      // HTF advisor default — DEMOTED 2026-10-06 (ADVISOR_REPRICE_JOURNAL
      // §3): the 6-month reprice deleted +104R of winners, so both books
      // start TAG-ONLY; the stored row wins once the panel explicitly flips
      // the toggle back on. The resolved vote counts are unchanged — they
      // still feed the adv4h-* shadow tags.
      if ((base as any).advisorEnabled == null) {
        merged.advisorEnabled = false;
      }
      // EMA speed migration RETIRED (2026-09-09): the 7/30 → 5/20
      // read-time override blocked the panel from ever displaying 7/30 on
      // the paper book (every save was masked back to 5/20 on the next
      // read). The stored row is the source of truth again — paper runs
      // 7/30 alongside live per the trader's call.
      return merged;
    }
    return { ...DEFAULT_CONFIG, name, updatedAt: 0 };
  },
});

/** Circuit breaker state for the paper book (what the next tick would do). */
export const getBreakerState = query({
  args: {},
  handler: async (ctx) => {
    const cfg = resolvePaperConfig(
      (await readConfigRow(ctx, CONFIG_BOOK_NAME("paper"))) as any,
    );
    const account = await ctx.db
      .query("paperAccount")
      .withIndex("by_name", (q: any) => q.eq("name", "layer2"))
      .first();
    const recentClosed = await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status_entryTime", (q: any) =>
        q.eq("book", "layer2").eq("status", "closed"),
      )
      .order("desc")
      .take(BREAKER_WINDOW);
    return computeBreakerState({
      recentClosed,
      balance: (account as any)?.balance ?? 150,
      now: Date.now(),
      cfg,
    });
  },
});

// ── SESSION PROFITABILITY BREAKER SEAM (2026-10-20) ─────────────────────────
// PAPER measures, LIVE acts.
//   · The paper ledger is bucketed by (session, side) over the lookback window.
//     Paper is NEVER blocked — it is the sensor, and it has to keep trading so
//     a blocked bucket can produce the evidence that re-opens it.
//   · The LIVE entry path (liveBrokerRuntime.processPairLive) reads this
//     snapshot and refuses a (session, side) whose paper record is not
//     profitable (sumR <= minProfitR with at least minTrades closes) AND one
//     that is merely UNPROVEN (fewer than minTrades closes, including zero).
//     Live spends real money, so "not enough evidence" is a refusal, not a
//     pass; paper is never blocked, so the missing closes keep arriving.
//   · Refresh: 00:20 + 12:20 UTC. The day's row is upserted on each fire; the
//     reader uses the newest row and recomputes on the fly when it is older
//     than 26h, so a missed cron never blinds the gate.
//   · Thresholds come from the PAPER row (the book being measured); the LIVE
//     row's `sessionBreakerEnabled` is the arm switch (read by the live tick).
// Pure math: src/lib/session-breaker.ts.
const SESSION_BREAKER_SOURCE = "paper";
const SESSION_BREAKER_MAX_ROWS = 2000;
/**
 * Rows one prune pass may remove (2026-10-21). A backlog drains over a few
 * 12h passes instead of deleting the whole history in one transaction, and a
 * single pass can never exceed Convex's per-transaction write budget.
 */
const SESSION_WINDOW_MAX_PRUNE = 500;
/** Two 12h fires plus slack — older than this and the snapshot is "missing". */
const SESSION_BREAKER_MAX_AGE_MS = 26 * 60 * 60_000;

async function resolveSessionBreakerConfig(ctx: any): Promise<StrategyConfig> {
  const configRecord: any = await readConfigRow(ctx, CONFIG_BOOK_NAME("paper"));
  return resolvePaperConfig(configRecord);
}

/** Bucket the closed paper book over the configured lookback window. */
async function readSessionBreakerState(
  ctx: any,
  cfg: StrategyConfig,
  now: number,
): Promise<SessionBreakerState> {
  const cutoff = now - cfg.sessionBreakerLookbackDays * 86_400_000;
  // Index-ranged on exitTime so the read is bounded by the window rather than
  // by the lifetime of the book (same index the daily-loss breaker uses).
  const closes = await ctx.db
    .query("paperTrades")
    .withIndex("by_book_status_exitTime", (q: any) =>
      q.eq("book", "layer2").eq("status", "closed").gte("exitTime", cutoff),
    )
    // Newest first: if a busy window ever exceeds the row cap, the buckets keep
    // the recent closes rather than the stale head of the range.
    .order("desc")
    .take(SESSION_BREAKER_MAX_ROWS);
  return computeSessionBreaker(closes as any, cfg, now);
}

/** Write (or refresh) the day's snapshot. Idempotent. */
export const recomputeSessionBreaker = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cfg = await resolveSessionBreakerConfig(ctx);
    const state = await readSessionBreakerState(ctx, cfg, now);
    const day = sessionBreakerDayKey(now);
    const payload = {
      day,
      computedAt: now,
      lookbackDays: state.lookbackDays,
      minTrades: state.minTrades,
      minProfitR: state.minProfitR,
      source: SESSION_BREAKER_SOURCE,
      buckets: state.buckets,
    };
    const existing = await ctx.db
      .query("sessionBreakerState")
      .withIndex("by_day", (q) => q.eq("day", day))
      .first();
    if (existing) await ctx.db.patch(existing._id, payload);
    else await ctx.db.insert("sessionBreakerState", payload);
    return { day, buckets: state.buckets.length, blocked: state.blocked.length };
  },
});

/**
 * SESSION WINDOW PRUNE (2026-10-21) — keep the measured ledger at exactly the
 * lookback window.
 *
 * WHY. The gate answers one question: "is this (session, side) profitable over
 * the last 14 days". A window is only meaningful if the DATA behind it is the
 * same window — so the ledger is pruned to the lookback and the P&L that
 * leaves the window is CARRIED, not lost. The bucket sums then always come
 * from the same evidence, and the table cannot grow without bound.
 *
 * WHAT IT TOUCHES.
 *   · paperTrades rows of the MEASURED book (layer2) whose close is older
 *     than the cutoff. Index-ranged on (book, status, exitTime), so the read
 *     costs the expired band and not the whole book.
 *   · the bookStats counters: the pruned rows are folded OUT, so the lifetime
 *     totals (Closed / Win Rate / Realized PnL) do not move.
 *   · the paperAccount carry: the pruned rows' realized P&L is carried
 *     forward, so every path that re-derives the balance from the ledger
 *     still produces the SAME balance (see paperTrading.readSessionWindowCarry).
 *   · the daily sessionBreakerState snapshots older than the window — the
 *     reader only ever uses the newest row.
 *
 * WHAT IT NEVER TOUCHES: open trades, the live book's ledger, the strategy
 * signal log, and the balance itself (the P&L was applied when the trade
 * closed, not when it was pruned).
 */
export const pruneSessionWindow = internalMutation({
  args: { maxRows: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const cfg = await resolveSessionBreakerConfig(ctx);
    // RETENTION = THE WIDER OF THE TWO READERS (2026-10-21 second pass):
    // the coin-priority ranking is a second, separately-tunable window over
    // this same ledger. Pruning at the session window alone would let a
    // wider coin lookback silently measure fewer days than it claims, with
    // no error anywhere. Each reader still filters to its own window.
    const cutoff = sessionWindowCutoff(now, measuredWindowDays(cfg));
    const maxRows = Math.min(
      Math.max(args.maxRows ?? SESSION_WINDOW_MAX_PRUNE, 1),
      2_000,
    );

    // 1. Closes older than the window — index-ranged, so this is bounded by
    //    the expired band rather than by the size of the book.
    const expired = await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status_exitTime", (q: any) =>
        q
          .eq("book", "layer2")
          .eq("status", "closed")
          .lt("exitTime", cutoff),
      )
      .take(maxRows);

    // 2. Closes with NO exit time at all: Convex omits those docs from the
    //    exitTime index, so they need the entryTime band plus a filter. They
    //    are not evidence for the gate (the breaker buckets on exitTime) but
    //    they would sit in the ledger forever.
    const band = await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status_entryTime", (q: any) =>
        q
          .eq("book", "layer2")
          .eq("status", "closed")
          .lt("entryTime", cutoff),
      )
      .take(maxRows);
    const orphans = band.filter((t: any) => t.exitTime == null);

    // Daily snapshots older than the window: the reader only ever uses the
    // newest row, so the older ones are dead weight. This runs FIRST and
    // unconditionally — it does not depend on there being expired trades,
    // and an early return that skipped it would leave the snapshot table
    // growing forever on a quiet book.
    const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
    const stale = await ctx.db
      .query("sessionBreakerState")
      .withIndex("by_day")
      .order("asc")
      .take(64);
    let snapshotsDeleted = 0;
    for (const s of stale) {
      if (s.day < cutoffDay) {
        await ctx.db.delete(s._id);
        snapshotsDeleted++;
      }
    }

    const rows = [...expired, ...orphans];
    if (rows.length === 0) {
      return {
        pruned: 0,
        cutoff,
        carry: emptySessionWindowCarry(),
        snapshotsDeleted,
      };
    }

    const carry = sessionWindowCarryOf(rows);

    // ORDER MATTERS. The counters are folded while the rows are still IN the
    // ledger (a missing bookStats doc is rebuilt from the full ledger and
    // then corrected by the fold), the rows are deleted next, and the carry
    // is patched last. Any other order double-counts or loses the P&L.
    await foldBookStatsBatch(ctx, "layer2", rows, -1);
    for (const row of rows) await ctx.db.delete(row._id);

    const acc: any = await ctx.db
      .query("paperAccount")
      .withIndex("by_name", (q: any) => q.eq("name", "layer2"))
      .first();
    if (acc) {
      await ctx.db.patch(acc._id, {
        archivedRealizedPnlUsd:
          (acc.archivedRealizedPnlUsd ?? 0) + carry.realizedPnlUsd,
        archivedTrades: (acc.archivedTrades ?? 0) + carry.trades,
        archivedWins: (acc.archivedWins ?? 0) + carry.wins,
        archivedFeesUsd: (acc.archivedFeesUsd ?? 0) + carry.totalFeesUsd,
        archivedR: (acc.archivedR ?? 0) + carry.realizedR,
        archivedUntil:
          Math.max(acc.archivedUntil ?? 0, carry.newestExitTime ?? 0) || undefined,
      });
    }

    return { pruned: rows.length, cutoff, carry, snapshotsDeleted };
  },
});

/**
 * Refresh entry point (00:20 / 12:20 UTC) — EVERY 12 HOURS.
 *
 * Two things happen here, in this order:
 *   1. PRUNE the measured ledger down to the lookback window, so the ledger
 *      holds exactly the window the gate measures (and only that window).
 *   2. RECOMPUTE the day's bucket snapshot from that window.
 *
 * Registered with `cron: true` so the heartbeat means "the scheduler fired"
 * (see src/lib/heartbeat.ts) — a manual recompute must never stand in for
 * the clock.
 */
export const sessionBreakerRefreshTick = internalAction({
  args: { cron: v.optional(v.boolean()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: string;
    day: string;
    buckets: number;
    blocked: number;
    pruned: number;
    cutoff: number;
  }> => {
    if (args.cron) {
      await ctx.runMutation(internal.heartbeat.record, { job: "session-breaker-refresh" }).catch(
        () => {},
      );
    }
    // Prune FIRST: the evidence and the data must be the same window.
    const prune = await ctx.runMutation(internal.strategyEngine.pruneSessionWindow, {});
    const res = await ctx.runMutation(internal.strategyEngine.recomputeSessionBreaker, {});
    return { status: "ok", ...res, pruned: prune.pruned, cutoff: prune.cutoff };
  },
});

export interface SessionBreakerBlockedSnapshot {
  day: string;
  computedAt: number;
  /** True when no fresh snapshot existed and the buckets were recomputed now. */
  stale: boolean;
  lookbackDays: number;
  minTrades: number;
  minProfitR: number;
  blocked: SessionBreakerBucket[];
}

/**
 * The blocked list the LIVE entry path reads. Newest snapshot row when it is
 * fresh; otherwise the buckets are computed from the ledger right now
 * (read-only — the refresh cron stays the only writer).
 */
export const readSessionBreakerBlocked = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, args): Promise<SessionBreakerBlockedSnapshot> => {
    const row: any = await ctx.db
      .query("sessionBreakerState")
      // Day keys are YYYY-MM-DD, so lexicographic desc = newest first.
      .withIndex("by_day")
      .order("desc")
      .first();
    const fresh =
      row &&
      args.now >= row.computedAt &&
      args.now - row.computedAt <= SESSION_BREAKER_MAX_AGE_MS;
    if (fresh) {
      return {
        day: row.day,
        computedAt: row.computedAt,
        stale: false,
        lookbackDays: row.lookbackDays,
        minTrades: row.minTrades,
        minProfitR: row.minProfitR,
        blocked: (row.buckets as SessionBreakerBucket[]).filter((b) => b.blocked),
      };
    }
    const cfg = await resolveSessionBreakerConfig(ctx);
    const state = await readSessionBreakerState(ctx, cfg, args.now);
    return {
      day: sessionBreakerDayKey(args.now),
      computedAt: args.now,
      stale: true,
      lookbackDays: state.lookbackDays,
      minTrades: state.minTrades,
      minProfitR: state.minProfitR,
      blocked: state.blocked,
    };
  },
});

/**
 * NEXT-SESSION EVIDENCE for the live breaker (2026-10-23).
 *
 * The release rule reads the closed PAPER book — the sensor — from the start
 * of the first session after the trip, and answers "was the most recent fully
 * closed session profitable?" via measureCompletedSessionSince() (pure, tested
 * in src/lib/__tests__/live-breaker.test.ts). Live cannot be the source: a
 * disarmed book takes no entries, so its own P&L stops producing sessions.
 *
 * Bounded by the exitTime index and capped: no single session holds anywhere
 * near 600 closes, so the newest rows always contain the session being judged.
 */
export const readLiveBreakerSessionEvidence = internalQuery({
  args: { tripAt: v.number(), now: v.number(), minCloses: v.number() },
  handler: async (ctx, args): Promise<LiveBreakerSessionEvidence | null> => {
    const tripWindow = sessionWindowAt(args.tripAt);
    const closes = await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status_exitTime", (q: any) =>
        q.eq("book", "layer2").eq("status", "closed").gte("exitTime", tripWindow.end),
      )
      .order("desc")
      .take(600);
    return measureCompletedSessionSince(args.tripAt, args.now, closes as any, args.minCloses);
  },
});

/** Newest snapshot (panel/diagnostics). Never writes. */
export const getSessionBreakerState = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const row: any = await ctx.db
      .query("sessionBreakerState")
      .withIndex("by_day")
      .order("desc")
      .first();
    if (row && now >= row.computedAt && now - row.computedAt <= SESSION_BREAKER_MAX_AGE_MS) {
      return { ...row, stale: false };
    }
    const cfg = await resolveSessionBreakerConfig(ctx);
    const state = await readSessionBreakerState(ctx, cfg, now);
    return {
      day: sessionBreakerDayKey(now),
      computedAt: now,
      lookbackDays: state.lookbackDays,
      minTrades: state.minTrades,
      minProfitR: state.minProfitR,
      source: SESSION_BREAKER_SOURCE,
      buckets: state.buckets,
      stale: true,
    };
  },
});

// ── COIN-PRIORITY MONITOR SEAM (2026-10-21) ─────────────────────────────────
// PAPER measures, LIVE orders.
//   · The paper ledger is bucketed by COIN over the lookback window. The result
//     is a ranking, not a gate: profitable coins (>= minTrades closes and
//     sumR > 0) are scanned FIRST by the live entry tick, unproven coins ride
//     with them, and coins whose record is negative are scanned last.
//   · Refreshed ONCE A DAY (00:40 UTC) into `coinProfitState`; the live tick
//     reads the newest row and recomputes on the fly when it is older than
//     26h, so a missed cron degrades to a per-tick recompute, never to a
//     blind/arbitrary scan order.
//   · RETENTION: every fire deletes snapshot rows older than the lookback
//     (14 daily rows max), and the refresh also runs the session-window prune
//     so the paper ledger those buckets are measured from is itself trimmed to
//     the same 14 days (P&L carried, lifetime counters preserved — see
//     pruneSessionWindow).
//   · Thresholds are read from the PAPER row (the measured book); the LIVE
//     row's `coinPriorityEnabled` is the arm switch.
// Pure math: src/lib/coin-priority.ts.
const COIN_PRIORITY_SOURCE = "paper";
const COIN_PRIORITY_MAX_ROWS = 2000;
/** One daily fire plus slack — older than this and the snapshot is "missing". */
const COIN_PRIORITY_MAX_AGE_MS = 26 * 60 * 60_000;

async function resolveCoinPriorityConfig(ctx: any): Promise<StrategyConfig> {
  const configRecord: any = await readConfigRow(ctx, CONFIG_BOOK_NAME("paper"));
  return resolvePaperConfig(configRecord);
}

/** Bucket the closed paper book by coin over the configured window. */
async function readCoinPriorityState(
  ctx: any,
  cfg: StrategyConfig,
  now: number,
): Promise<CoinPriorityState> {
  const cutoff = now - cfg.coinPriorityLookbackDays * 86_400_000;
  const closes = await ctx.db
    .query("paperTrades")
    .withIndex("by_book_status_exitTime", (q: any) =>
      q.eq("book", "layer2").eq("status", "closed").gte("exitTime", cutoff),
    )
    .order("desc")
    .take(COIN_PRIORITY_MAX_ROWS);
  return computeCoinPriority(closes as any, cfg as any, now);
}

/**
 * Write (or refresh) the day's coin-priority row and drop expired history.
 * Idempotent: the daily cron re-runs it safely, and a manual run is a no-op
 * on the same day's row apart from the recompute.
 */
export const recomputeCoinPriority = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cfg = await resolveCoinPriorityConfig(ctx);
    const state = await readCoinPriorityState(ctx, cfg, now);
    const day = sessionBreakerDayKey(now);
    const payload = {
      day,
      computedAt: now,
      lookbackDays: state.lookbackDays,
      minTrades: state.minTrades,
      source: COIN_PRIORITY_SOURCE,
      buckets: state.buckets,
    };
    const existing = await ctx.db
      .query("coinProfitState")
      .withIndex("by_day", (q) => q.eq("day", day))
      .first();
    if (existing) await ctx.db.patch(existing._id, payload);
    else await ctx.db.insert("coinProfitState", payload);

    // RETENTION: keep the monitor's own history to the lookback window. The
    // reader only ever uses the newest row, so older days are dead weight —
    // but they are also the monitor's series, which is why the cutoff is the
    // same 14 days rather than "delete everything except today".
    const cutoffDay = sessionBreakerDayKey(now - state.lookbackDays * 86_400_000);
    const history = await ctx.db
      .query("coinProfitState")
      .withIndex("by_day")
      .order("asc")
      .take(64);
    let snapshotsDeleted = 0;
    for (const row of history) {
      if (row.day < cutoffDay) {
        await ctx.db.delete(row._id);
        snapshotsDeleted++;
      }
    }
    return {
      day,
      coins: state.buckets.length,
      prioritized: state.buckets.filter((b) => b.tier === "priority").length,
      avoid: state.buckets.filter((b) => b.tier === "avoid").length,
      snapshotsDeleted,
    };
  },
});

/**
 * Daily refresh entry point (00:40 UTC).
 *
 * Two jobs, in this order:
 *   1. PRUNE the measured ledger to the lookback window (idempotent — the
 *      12h session refresh already does this; running it here makes the
 *      retention guarantee daily even if the session breaker is later
 *      disabled/removed).
 *   2. RECOMPUTE + persist the per-coin ranking and drop expired snapshots.
 *
 * Registered with `cron: true` so the heartbeat means "the scheduler fired".
 */
export const coinPriorityRefreshTick = internalAction({
  args: { cron: v.optional(v.boolean()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: string;
    day: string;
    coins: number;
    prioritized: number;
    avoid: number;
    /** Always 0 — the ledger prune lives on the 12h session refresh. */
    pruned: number;
    snapshotsDeleted: number;
  }> => {
    if (args.cron) {
      await ctx
        .runMutation(internal.heartbeat.record, { job: "coin-priority-refresh" })
        .catch(() => {});
    }
    // NO LEDGER PRUNE HERE (2026-10-21 cron audit): the session refresh already
    // prunes the measured ledger twice a day (00:20 / 12:20), which is inside
    // the "delete anything older than the window, every day" guarantee. Running
    // it again at 00:40 re-scanned both expiry bands and the snapshot table for
    // zero rows — duplicate I/O on the one tick whose job is the coin snapshot.
    // The snapshot history retention stays inside recomputeCoinPriority.
    const res = await ctx.runMutation(internal.strategyEngine.recomputeCoinPriority, {});
    return { status: "ok", ...res, pruned: 0 };
  },
});

export interface CoinPrioritySnapshot {
  day: string;
  computedAt: number;
  /** True when no fresh snapshot existed and the buckets were recomputed now. */
  stale: boolean;
  lookbackDays: number;
  minTrades: number;
  source: string;
  buckets: CoinPriorityBucket[];
}

/**
 * The ranking the LIVE entry tick reads. Newest snapshot row when it is
 * fresh; otherwise computed from the ledger right now (read-only — the cron
 * stays the only writer).
 */
export const readCoinPriority = internalQuery({
  args: { now: v.number() },
  handler: async (ctx, args): Promise<CoinPrioritySnapshot> => {
    const row: any = await ctx.db
      .query("coinProfitState")
      .withIndex("by_day")
      .order("desc")
      .first();
    const fresh =
      row &&
      args.now >= row.computedAt &&
      args.now - row.computedAt <= COIN_PRIORITY_MAX_AGE_MS;
    if (fresh) {
      return {
        day: row.day,
        computedAt: row.computedAt,
        stale: false,
        lookbackDays: row.lookbackDays,
        minTrades: row.minTrades,
        source: row.source ?? COIN_PRIORITY_SOURCE,
        buckets: row.buckets as CoinPriorityBucket[],
      };
    }
    const cfg = await resolveCoinPriorityConfig(ctx);
    const state = await readCoinPriorityState(ctx, cfg, args.now);
    return {
      day: sessionBreakerDayKey(args.now),
      computedAt: args.now,
      stale: true,
      lookbackDays: state.lookbackDays,
      minTrades: state.minTrades,
      source: COIN_PRIORITY_SOURCE,
      buckets: state.buckets,
    };
  },
});

/** Newest ranking (monitor panel / diagnostics). Never writes. */
export const getCoinProfitState = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const row: any = await ctx.db
      .query("coinProfitState")
      .withIndex("by_day")
      .order("desc")
      .first();
    if (row && now >= row.computedAt && now - row.computedAt <= COIN_PRIORITY_MAX_AGE_MS) {
      return { ...row, stale: false };
    }
    const cfg = await resolveCoinPriorityConfig(ctx);
    const state = await readCoinPriorityState(ctx, cfg, now);
    return {
      day: sessionBreakerDayKey(now),
      computedAt: now,
      lookbackDays: state.lookbackDays,
      minTrades: state.minTrades,
      source: COIN_PRIORITY_SOURCE,
      buckets: state.buckets,
      stale: true,
    };
  },
});

/**
 * PAPER SCAN STATUS (2026-10-21) — the tick's own summary, written back to
 * the layer2 `paperAccount` doc.
 *
 * WHY THIS EXISTS. The panel's paper tile reads `paperAccount.lastScanResult`
 * and `lastScanTime`, and NOTHING in this engine wrote them: `strategyTick`
 * returned its summary to the cron and dropped it. The deployment that used
 * to be live had a writer for it, but that writer is not in this repository,
 * so the tile froze on its last write (2026-10-21 01:18) and the panel has
 * since shown a stale scan as if it were current.
 *
 * The line is the paper book's only liveness signal in the UI: it is where a
 * gate drought ("0 entered") and a tripped breaker are visible at a glance.
 * One patch per tick on a doc that already exists — the cost is noise.
 */
export const recordPaperScanStatus = internalMutation({
  args: {
    scanned: v.number(),
    signals: v.number(),
    entries: v.number(),
    blocked: v.number(),
    /** Set for the early-return paths (breaker, lease, stale metrics). */
    note: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const account: any = await ctx.db
      .query("paperAccount")
      .withIndex("by_name", (q: any) => q.eq("name", "layer2"))
      .first();
    if (!account) return { ok: false };
    const now = Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    await ctx.db.patch(account._id, {
      lastScanTime: now,
      lastScanResult:
        args.note ??
        `${args.scanned} scanned · ${args.signals} signal(s) · ${args.entries} entered · ${args.blocked} blocked`,
      totalScans: (account.totalScans ?? 0) + 1,
      scansToday: account.scansDate === day ? (account.scansToday ?? 0) + 1 : 1,
      scansDate: day,
    });
    return { ok: true };
  },
});

export const updateConfig = mutation({
  args: {
    book: v.optional(v.union(v.literal("paper"), v.literal("live"))),
    emaFast: v.optional(v.number()),
    emaSlow: v.optional(v.number()),
    gapThreshold: v.optional(v.number()),
    minScore: v.optional(v.number()),
    minGap: v.optional(v.number()),
    stopLossPct: v.optional(v.number()),
    takeProfitPct: v.optional(v.number()),
    spreadTight: v.optional(v.number()),
    spreadWide: v.optional(v.number()),
    atrSpikeMult: v.optional(v.number()),
    feePct: v.optional(v.number()),
    allowLong: v.optional(v.boolean()),
    allowShort: v.optional(v.boolean()),
    longSessions: v.optional(v.array(v.string())),
    shortSessions: v.optional(v.array(v.string())),
    bookWeight: v.optional(v.number()),
    flowWeight: v.optional(v.number()),
    fundingWeight: v.optional(v.number()),
    fundingMode: v.optional(v.union(v.literal("bonus"), v.literal("strict"))),
    fundingBonusThreshold: v.optional(v.number()),
    blocklist: v.optional(v.array(v.string())),
    // 1H HTF trend gates (2026-09-06): per-side EMA period + on/off switch.
    htfShortEma: v.optional(v.number()),
    htfLongEma: v.optional(v.number()),
    htfGateShort: v.optional(v.boolean()),
    htfGateLong: v.optional(v.boolean()),
    // HTF gate timeframe (2026-09-13): "1h" or "4h". Undefined/absent keeps
    // the swapped default ("4h") at the read site — the fail-safe ternary
    // there means legacy rows get the swap without a migration.
    htfTf: v.optional(v.union(v.literal("1h"), v.literal("4h"))),
    // 4H choppiness gate (2026-09-22, ships OFF): ER floor gate, both sides.
    // Explicit null clears a per-side override so the side falls back to the
    // shared chopGateFloor (same nullable pattern as shortTakeProfitPct).
    chopGateEnabled: v.optional(v.boolean()),
    chopGatePeriod: v.optional(v.number()),
    chopGateFloor: v.optional(v.number()),
    chopGateFloorLong: v.optional(v.union(v.null(), v.number())),
    chopGateFloorShort: v.optional(v.union(v.null(), v.number())),
    // Volatility floor (2026-09-27, armed paper + live): block a side when the
    // decision bar's ATR% is below the floor. Shared + per-side overrides
    // (nullable = inherit the shared value, NOT "off"). See src/lib/vol-floor.ts.
    atrFloorPct: v.optional(v.number()),
    atrFloorPctLong: v.optional(v.union(v.null(), v.number())),
    atrFloorPctShort: v.optional(v.union(v.null(), v.number())),
    // Short flow gate (2026-09-09, paper + live): SHORT needs flowBias < 0.
    shortFlowGate: v.optional(v.boolean()),
    // Hard EMA trend gates (2026-09-10, paper + live): LONG requires
    // emaFast > emaSlow, SHORT requires emaFast < emaSlow on the signal bar
    // (hard gates, no score compensation).
    longTrendGate: v.optional(v.boolean()),
    shortTrendGate: v.optional(v.boolean()),
    // Per-side SHORT TP (2026-09-09): percent target for shorts (2.25 = 1.5R).
    // Explicit null (blank in the panel) clears the override so shorts fall
    // back to the shared takeProfitPct.
    shortTakeProfitPct: v.optional(v.union(v.null(), v.number())),
    // R-lock trailing exit (2026-09-20, both books): replaces the fixed TP
    // with a stepped trailing lock. startR <= 0 disables it. See r-lock.ts.
    trailLockStartR: v.optional(v.number()),
    trailLockStepR: v.optional(v.number()),
    trailLockMaxR: v.optional(v.number()),
    // Risk per trade (2026-09-10): percent of book balance risked per entry.
    // Paper engine sizes as balance × riskPct/100 (compounding); live keeps
    // its own UI knob on the liveAccount doc.
    riskPct: v.optional(v.number()),
    // ENTRY LIMITS (2026-10): null = gate off. Units: % and bps.
    maxSpreadPct: v.optional(v.union(v.number(), v.null())),
    maxEntrySlippageBps: v.optional(v.union(v.number(), v.null())),
    // FACTOR-EXPOSURE CAP (2026-09-23, both books, SHIPS OFF): cap on the
    // SIGNED sum of open positions' estimated BTC beta. 0/blank = off (the
    // default) — the engines then measure no beta and fetch no BTC bars.
    // Longs add, shorts subtract, so a hedged book may hold more positions
    // than a one-sided one at the same correlated exposure. See
    // src/lib/btc-beta.ts and the note on StrategyConfig.maxNetBtcBeta.
    maxNetBtcBeta: v.optional(v.number()),
    // Chase guard (2026-09-07, live only): skip cap-delayed entries that
    // drifted past maxSignalDriftPct from the first signal, or whose first
    // signal is older than signalMaxAgeMin. `chaseGuardEnabled` (2026-09-20)
    // is the master switch — ships false (guard parked; it was making fills
    // worse), so setting the numeric knobs alone no longer arms it.
    chaseGuardEnabled: v.optional(v.boolean()),
    maxSignalDriftPct: v.optional(v.number()),
    signalMaxAgeMin: v.optional(v.number()),
    // EMA-stretch veto (2026-09-09): max % price may run from the fast EMA
    // on the closed signal candle before a side is blocked. 0 = off.
    maxEmaStretchPct: v.optional(v.number()),
    // RSI wick guard (2026-09-09, LONG side): block longs when 15m RSI(7)
    // on the signal bar exceeds maxRsiLong.
    rsiLongGuard: v.optional(v.boolean()),
    maxRsiLong: v.optional(v.number()),
    // RSI pullback term (2026-09-21): 15m Wilder RSI as a per-side pullback
    // band — "off" (default) | "bonus" | "veto". See layer2-signal.ts.
    rsiPullbackMode: v.optional(v.union(v.literal("off"), v.literal("bonus"), v.literal("veto"))),
    rsiPullbackPeriod: v.optional(v.number()),
    rsiPullbackWeight: v.optional(v.number()),
    rsiPullbackLongMin: v.optional(v.number()),
    rsiPullbackLongMax: v.optional(v.number()),
    rsiPullbackShortMin: v.optional(v.number()),
    rsiPullbackShortMax: v.optional(v.number()),
    // SuperTrend score term (lab-only 2026-10-11, ships OFF): "off" (default)
    // | "bonus" | "penalty" | "symmetric", magnitude stWeight.
    stMode: v.optional(v.union(v.literal("off"), v.literal("bonus"), v.literal("penalty"), v.literal("symmetric"))),
    stWeight: v.optional(v.number()),
    // SuperTrend veto (2026-10-11, ships OFF): "off" | "shadow" | "on".
    stVeto: v.optional(v.union(v.literal("off"), v.literal("shadow"), v.literal("on"))),
    // EMA cross-term kill switch (lab-only 2026-10-11, default false).
    noEmaTerm: v.optional(v.boolean()),
    // Circuit breaker (paper only, 2026-09-08)
    breakerEnabled: v.optional(v.boolean()),
    breakerMinWr: v.optional(v.number()),
    breakerMaxDailyLossPct: v.optional(v.number()),
    // LIVE circuit breaker (2026-09-10, manual re-arm 2026-10-22):
    // loss-streak disarm for live entries. manualReArm (default true) makes a
    // trip a hard disarm until rearmLiveBreaker; explicit false restores the
    // legacy liveBreakerCooldownMin timed pause.
    liveBreakerEnabled: v.optional(v.boolean()),
    liveBreakerMaxLossStreak: v.optional(v.number()),
    liveBreakerCooldownMin: v.optional(v.number()),
    liveBreakerManualReArm: v.optional(v.boolean()),
    liveBreakerRearmOnSession: v.optional(v.boolean()),
    // SESSION circuit breaker (2026-10-20, paper book): per (session, side)
    // buckets over the paper ledger. See src/lib/session-breaker.ts.
    sessionBreakerEnabled: v.optional(v.boolean()),
    sessionBreakerLookbackDays: v.optional(v.number()),
    sessionBreakerMinTrades: v.optional(v.number()),
    sessionBreakerMinProfitR: v.optional(v.number()),
    // COIN PRIORITY (2026-10-21): paper-measured per-coin ranking that orders
    // the LIVE scan (profitable coins first). Ordering only — never a veto.
    coinPriorityEnabled: v.optional(v.boolean()),
    coinPriorityLookbackDays: v.optional(v.number()),
    coinPriorityMinTrades: v.optional(v.number()),
    coinPriorityBlockAvoid: v.optional(v.boolean()),
    // HTF advisor (2026-09-08): 4H divergence/exhaustion veto layer.
    advisorEnabled: v.optional(v.boolean()),
    // 1H advisor layer (2026-09-12): the optional hourly second layer. This
    // arg was MISSING from the mutation, so the panel's Enforce toggle threw
    // "Unexpected field `advisor1hEnabled`" on save and the layer could never
    // be turned on from the UI (the hourly cron also stays in its
    // skip-1h-disabled guard forever). The numeric 1H knobs below were wired;
    // only the enable flag was dropped.
    advisor1hEnabled: v.optional(v.boolean()),
    // Advisor input mode (2026-09-09): "pair" | "btc" | "both" — which 4H
    // verdicts gate entries. Default "both" (BTC macro veto + per-pair).
    advisorMode: v.optional(v.union(v.literal("pair"), v.literal("btc"), v.literal("both"))),
    advisorVetoThreshold: v.optional(v.number()),
    // Per-side veto thresholds (SHORT=1 = any flagged short loses; LONG=2).
    advisorLongThreshold: v.optional(v.number()),
    advisorShortThreshold: v.optional(v.number()),
    advisorDivergenceAgeBars: v.optional(v.number()),
    advisorVwapExtremePct: v.optional(v.number()),
    advisorRsiExtreme: v.optional(v.number()),
    // Weighted-vote model (2026-09-08): strong/weak signal weights.
    advisorStrongWeight: v.optional(v.number()),
    advisorWeakWeight: v.optional(v.number()),
    // Per-family advisor switches (2026-10-23): unset = ON. Each panel button
    // writes one of these; a disabled family casts 0 votes and no reason text.
    advisorMomDivEnabled: v.optional(v.boolean()),
    advisorObvEnabled: v.optional(v.boolean()),
    advisorAdEnabled: v.optional(v.boolean()),
    advisorCmfEnabled: v.optional(v.boolean()),
    advisorVwapEnabled: v.optional(v.boolean()),
    advisorThinZoneEnabled: v.optional(v.boolean()),
    // MACD vote family (2026-09-10): divergence + hist-flip flags on the 4H
    // filter TF, normal weight by default (lab-validated, see htf-advisor.ts).
    advisorMacdEnabled: v.optional(v.boolean()),
    advisorMacdWeight: v.optional(v.number()),
    advisorMacdFast: v.optional(v.number()),
    advisorMacdSlow: v.optional(v.number()),
    advisorMacdSignal: v.optional(v.number()),
    // StochRSI (2026-09-11): the advisor's momentum oscillator + kill switch.
    advisorStochRsiEnabled: v.optional(v.boolean()),
    advisorStochRsiRsiPeriod: v.optional(v.number()),
    advisorStochRsiStochPeriod: v.optional(v.number()),
    advisorStochRsiKSmooth: v.optional(v.number()),
    advisorStochRsiDSmooth: v.optional(v.number()),
    advisorStochRsiUseD: v.optional(v.boolean()),
    // 1H advisor per-side thresholds (2026-09-12): unset = fall back to the
    // shared advisor thresholds. Backtest sweet spot: L3.5/S2.5 (vote
    // quantization — L3.25-3.5 / S2.25-2.75 all land on the same book).
    // WIRED 2026-09-12 into BOTH rows. Re-derived the same day at the SHIPPED
    // divergence ages (the sweep defaults pin age 6 for both layers; pass
    // SWEEP_AGE_4H=4 SWEEP_AGE_1H=12 to re-run at the wired config):
    // run-1h-macd-sweep then reproduces the wired 4H-only baseline EXACTLY
    // (724t · +125.3R) and still puts the sweet spot at L3.5/S2.5, with every
    // per-param-set best sitting on L3.5 or L3.75 (same quantization plateau).
    //
    // NULL-ACCEPTING (2026-09-12 fix): the panel renders these as "blank =
    // shared" and its save handler maps EVERY blank emptyIsNull field to null
    // before calling updateConfig (see StrategyConfigPanel.handleSave). With
    // a plain v.optional(v.number()) the validator rejected that null and the
    // whole payload failed — so the main Save button threw "Unable to save
    // strategy settings" on any save while these overrides were unset, which
    // is the default state. Same shape as shortTakeProfitPct (the only other
    // null-cleared override); the handler turns null into `undefined` before
    // patching, so nothing null is ever stored.
    advisor1hLongThreshold: v.optional(v.union(v.null(), v.number())),
    advisor1hShortThreshold: v.optional(v.union(v.null(), v.number())),
    // 1H-only MACD flag weight (2026-09-12): consumed by the hourly
    // advisorTick when baking stored vote counts; unset = share
    // advisorMacdWeight. Sweep sweet spot: 0.5 (hourly flags fire ~3x more).
    // WIRED 2026-09-12 into BOTH rows. Weight 0.5 is the most robust knob in
    // the whole 1H layer: run-1h-macd-sweep picks it at age 6 (Sep), at the
    // shipped ages 4/12 (Sep) AND out of sample (Aug 20-Sep 1, +59.0R
    // marginal). The MACD PARAMS do not survive that test — the winning set
    // moves 6/14/10 → 9/25/11 → 8/21/9 across those three windows — so they
    // deliberately stay shared at the 6/14/10 default.
    advisor1hMacdWeight: v.optional(v.union(v.null(), v.number())),
    // 1H-only StochRSI periods (2026-09-12): same tick-time baking; unset =
    // share the advisorStochRsi* fields. Sweep sweet spot: 8/8 (+37.5R
    // marginal vs +26.0R at the shared 14/14).
    // WIRED 2026-09-12 into BOTH rows. 8/8 is the ONLY setting that beats the
    // shipped 14/14 anchor in all three regimes probed — Sep at age 6 (+11.5R),
    // Sep at the shipped ages 4/12 (+6.4R), Aug 20-Sep 1 at 4/12 (+8.9R). 7/7
    // ties that record but its worst window is a tie (+0.4R), so 8/8 is the
    // max-min pick. Every in-sample-only winner failed out of sample (28/28
    // +14.8R → −7.0R; 21/14/5/5 +4.9R → −6.6R), which is why the age-6 sweep's
    // top row is not what shipped. NOTE the sweep's VERDICT line names
    // 14/14/5/5 — it reports the FIRST variant clearing the anchor, not the
    // best; the ranked table governs.
    //
    // Knobs deliberately NOT given 1H-specific values (both re-swept same day):
    //   · VWAP stretch / RSI extreme — all 35 cells of run-1h-vwap-sweep tie at
    //     +44.0R, i.e. inert on hourly bars; the shared 3 / 70 stay.
    //   · strong / weak vote weights — 1.5/0.5 ties the shipped 2/0.5 exactly
    //     (+0.0R in run-1h-weights-sweep), so the shared weights stay.
    advisor1hStochRsiRsiPeriod: v.optional(v.union(v.null(), v.number())),
    advisor1hStochRsiStochPeriod: v.optional(v.union(v.null(), v.number())),
    // 1H-only divergence age (2026-09-12): same tick-time baking; unset =
    // share advisorDivergenceAgeBars. WIRED value 12 — the sweep's earlier 8
    // was beaten by 12 in-sample (+81.4R vs +74.3R marginal) AND out of sample
    // on Aug 20-Sep 1 (+47.8R vs +39.7R), so 12 is written into both config
    // rows rather than left to the shared fallback.
    advisor1hDivergenceAgeBars: v.optional(v.union(v.null(), v.number())),
    // 1H-only advisor INPUT MODE (2026-09-12): which verdicts gate the hourly
    // layer — "pair" (the pair's own 1H read), "btc" (BTC's 1H read alone) or
    // "both". Unset/null = share advisorMode (the pre-fix behaviour). Until
    // now BOTH layers read the single shared advisorMode, so the mode A/B's
    // best cell (4H=pair + 1H=btc → 641t · WR 46.8% · +203.5R, i.e. +74.3R
    // over the pair-only 4H book) was NOT reachable from the panel. Null is
    // accepted for the same blank-clears-the-override reason as the knobs
    // above.
    advisor1hMode: v.optional(v.union(v.null(), v.literal("pair"), v.literal("btc"), v.literal("both"))),
    // Smart Volume MACD vote family (2026-09-13, run-smartvol-advisor-lab.ts):
    // 4H-advisor-only family, ships OFF (no stored keys → weight 0). The lab
    // showed the strongest veto-family lift measured (+0.036–0.052 net/t at
    // weight 1) but it failed the pre-registered null bar — promote from the
    // panel only with that caveat in mind. advisorSmartVolWeight > 0 arms the
    // family (enabled implied); 0/blank = off.
    advisorSmartVolEnabled: v.optional(v.boolean()),
    advisorSmartVolWeight: v.optional(v.number()),
    advisorSmartVolFast: v.optional(v.number()),
    advisorSmartVolSlow: v.optional(v.number()),
    advisorSmartVolSignal: v.optional(v.number()),
    advisor1hSmartVolWeight: v.optional(v.number()),
    // RSI-Div differential family (2026-09-13): 4H-advisor-only, ships OFF.
    // Weight > 0 arms it; the 1H layer reads advisor1hRsiDivWeight (default 0).
    advisorRsiDivEnabled: v.optional(v.boolean()),
    advisorRsiDivWeight: v.optional(v.number()),
    advisorRsiDivFast: v.optional(v.number()),
    advisorRsiDivSlow: v.optional(v.number()),
    // Source of the differential (2026-09-13): one of ADVISOR_RSIDIV_SOURCES
    // ("close" | "open" | ... | "atr"). Unset = "close".
    advisorRsiDivSource: v.optional(v.string()),
    advisor1hRsiDivWeight: v.optional(v.number()),
    // BTC regime side gate (2026-09-13, layer2-v3): block LONG while BTC's
    // 4h EMA75 slope is chop, SHORT while up (±0.5% / 18 closed bars).
    btcRegimeEnabled: v.optional(v.boolean()),
    // DOWN-BLOCK (2026-09-14, layer2-v4): additionally block BOTH sides in
    // regime "down" (layer2-only — the proxy's best cohort lives in down).
    btcRegimeDownBlock: v.optional(v.boolean()),
    // LONG-SLOPE MIN (2026-09-16, PAPER-ONLY quality experiment): LONG also
    // requires BTC's 4h EMA75 slope ≥ this % (0/undefined = off, fail-open).
    // Quality lab (run-layer2-quality-lab.ts, 11.8 months, parity exact):
    // poison longs live where BTC rises but feeble (slope 0→+1%) — removing
    // them (≥ +1.0%) flips the book −69.1 → +172.6R, cohort negative in all
    // four quarters. SHORT deliberately untouched (fading feeble BTC is the
    // good short cohort — every short-side arm removed WINNERS). Live engine
    // does not read this knob until the paper forward record confirms.
    btcRegimeLongSlopeMin: v.optional(v.number()),
    // H4 QUALITY GATES (2026-09-23, PAPER ONLY — exhaustion + volume-size
    // labs, src/lib/h4-shadow.ts h4GateBlocks). Defaults live in processPair:
    // blank/undefined = the lab-measured defaults (all blocks ON, RSI heat 80).
    // h4VolClimaxBlock: block any entry after a ≥4×-median-volume 4h bar
    //   (−0.39 R/t, 22.6% WR in the lab).
    // h4PullbackBigBlock / h4PullbackDeadBlock: block PULLBACK entries after a
    //   ≥4% / <1% 4h candle (0.07 / 0.12 R/t; the healthy band is 1–4%).
    // rsiHeatMax: block both sides when side-aligned RSI(7) ≥ this (80;
    //   0 = off). Measured bucket: −0.19 R/t, 29.5% WR.
    h4VolClimaxBlock: v.optional(v.boolean()),
    h4PullbackBigBlock: v.optional(v.boolean()),
    h4PullbackDeadBlock: v.optional(v.boolean()),
    rsiHeatMax: v.optional(v.number()),
    // LTF 5M CONFLUENCE GATE (2026-09-26, both books): ltf5mGateEnabled
    // blocks LONG entries when the last CLOSED 5m bar closed below its 5m
    // EMA20 (src/lib/ltf5m.ts). Default resolves ON in resolveConfig; the
    // gate fails OPEN on missing/short 5m series.
    ltf5mGateEnabled: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    // Operator gate (2026-10-30): this mutation rewrites risk, slot caps, the
    // breakers and every entry gate. It used to be callable with no identity
    // at all — knowing the deployment URL was enough.
    await requireOperator(ctx);
    const { book, ...rest } = args;
    const name = CONFIG_BOOK_NAME(book);
    const existing = await readConfigRow(ctx, name);
    const updates: Record<string, any> = { updatedAt: Date.now() };
    for (const [key, val] of Object.entries(rest)) {
      if (val === null) {
        // Explicit null clears a nullable override (e.g. shortTakeProfitPct:
        // blank in the panel = shorts fall back to the shared takeProfitPct).
        // patch-with-undefined removes the field; getConfig's default merge
        // then restores the null default instead of the stale number.
        updates[key] = undefined;
      } else if (val != null) {
        // 2% HARD CEILING (Phase 7): a save carrying riskPct > 2 is clamped
        // to the ceiling instead of rejected, so the panel can never persist
        // a book that risks more than MAX_RISK_PCT_PER_TRADE per trade.
        updates[key] = key === "riskPct" ? clampRiskPct(val, DEFAULT_CONFIG.riskPct) : val;
      }
    }

    const candidate = { ...(existing ?? {}), ...updates };
    const lockError = rLockConfigError(
      candidate.trailLockStartR,
      candidate.trailLockMaxR,
      candidate.trailLockStepR,
    );
    if (lockError) return { ok: false, error: lockError };

    if (existing) {
      await ctx.db.patch(existing._id, updates);
    } else {
      // New book row: seed from the other book's current values so the live
      // row starts exactly where the shared config was (never defaults).
      // Strip the seed doc's _id/_creationTime/name — spreading a raw row
      // into insert would fail the document-id check.
      const seedName = book === "live" ? "ema-momentum" : "live";
      const seed = await readConfigRow(ctx, seedName);
      const { _id: _s, _creationTime: _c, name: _n, ...seedValues } = (seed ?? {}) as Record<string, any>;
      await ctx.db.insert("strategyConfig", {
        name,
        ...DEFAULT_CONFIG,
        ...seedValues,
        updatedAt: Date.now(),
        ...updates,
      });
    }
    // SHARED GATES (2026-10-21): mirror every GATE field onto the other book's
    // row. Reads already resolve gates from the paper row, so this is the
    // belt-and-braces half — the panel, `resetConfig` and any direct row reader
    // then see one number, not two. The per-book fields (session breaker, coin
    // priority) are deliberately NOT mirrored: paper measures them, live acts
    // on them, and they must be free to differ.
    const otherName = book === "live" ? "ema-momentum" : "live";
    const sharedUpdates: Record<string, any> = {};
    for (const [key, value] of Object.entries(updates)) {
      if (!PER_BOOK_KEY_SET.has(key)) sharedUpdates[key] = value;
    }
    if (Object.keys(sharedUpdates).length > 0) {
      const other = await readConfigRow(ctx, otherName);
      // updatedAt is a PER-BOOK field (PER_BOOK_CONFIG_KEYS), so the loop above
      // drops it — yet the mirrored row's gates DID change, leaving the panel
      // reporting a save older than the values it shows (2026-10-26: paper
      // saved 04:43, the Live tab still said 04:31). Stamp it in the same write
      // so both books agree on when the shared half last moved.
      if (other) {
        await ctx.db.patch(other._id, { ...sharedUpdates, updatedAt: updates.updatedAt });
      }
    }

    // WHERE EACH PER-BOOK FIELD IS ACTUALLY READ (2026-10-21 second pass): the
    // per-book half is asymmetric, and the panel cannot see it. The MEASURED
    // thresholds are read from the PAPER row always (resolveSessionBreakerConfig
    // / resolveCoinPriorityConfig), while the ARM switches are read from the
    // LIVE row by the entry path. Saving a lookback on the Live tab used to
    // patch only the live row, so the panel showed a value the gate never
    // used — a silent no-op. Mirror each field to the row that reads it.
    const MEASURED_ON_PAPER = [
      "sessionBreakerLookbackDays",
      "sessionBreakerMinTrades",
      "sessionBreakerMinProfitR",
      "coinPriorityLookbackDays",
      "coinPriorityMinTrades",
    ];
    const ARMED_ON_LIVE = [
      "sessionBreakerEnabled",
      "coinPriorityEnabled",
      "coinPriorityBlockAvoid",
    ];
    const paperMirror: Record<string, any> = {};
    for (const key of MEASURED_ON_PAPER) if (key in updates) paperMirror[key] = updates[key];
    if (book === "live" && Object.keys(paperMirror).length > 0) {
      const paperRow = await readConfigRow(ctx, CONFIG_BOOK_NAME("paper"));
      if (paperRow) await ctx.db.patch(paperRow._id, paperMirror);
    }
    const liveMirror: Record<string, any> = {};
    for (const key of ARMED_ON_LIVE) if (key in updates) liveMirror[key] = updates[key];
    if (book !== "live" && Object.keys(liveMirror).length > 0) {
      // Saving the paper row (or the legacy no-book form) must still arm the
      // live reader, which is where the switches are consumed.
      const liveRow = await readConfigRow(ctx, CONFIG_BOOK_NAME("live"));
      if (liveRow) await ctx.db.patch(liveRow._id, liveMirror);
    }

    // CONFIG HISTORY (Stage 4, record-only, fail-open): every save is a new
    // configVersion with the full hash, the actor and the keys that moved —
    // rule 3 needs that list to catch a version that changed two things.

    return { ok: true };
  },
});

export const resetConfig = mutation({
  args: { book: v.optional(v.union(v.literal("paper"), v.literal("live"))) },
  handler: async (ctx, args) => {
    await requireOperator(ctx);
    const name = CONFIG_BOOK_NAME(args.book);
    const existing = await readConfigRow(ctx, name);
    // SHARED GATES (2026-10-21): a reset is a save of every default, so it has
    // to honour the same invariant as updateConfig — gates go to BOTH rows.
    // Before this, resetting one book left the other on its old thresholds and
    // the paper→live gate parity silently broke.
    const resetShared = sharedGateConfigValues({ ...DEFAULT_CONFIG, updatedAt: Date.now() });
    const otherName = args.book === "live" ? "ema-momentum" : "live";
    const other = await readConfigRow(ctx, otherName);
    if (other) await ctx.db.patch(other._id, { ...resetShared, updatedAt: Date.now() });
    if (existing) {
      await ctx.db.patch(existing._id, { ...DEFAULT_CONFIG, updatedAt: Date.now() });
    } else {
      const seedName = args.book === "live" ? "ema-momentum" : "live";
      const seed = await readConfigRow(ctx, seedName);
      const { _id: _s, _creationTime: _c, name: _n, ...seedValues } = (seed ?? {}) as Record<string, any>;
      await ctx.db.insert("strategyConfig", {
        name,
        ...DEFAULT_CONFIG,
        ...seedValues,
        updatedAt: Date.now(),
      });
    }
    return { ok: true, config: DEFAULT_CONFIG };
  },
});

// ── Signal Logging Query ──

/**
 * Veto journal (2026-09-17): log every candidate a gate BLOCKED so quiet
 * stretches are auditable - strategySignals previously recorded entries only
 * (see cleanup.ts note). ONE batched doc per tick (side="VETO", entered=false
 * per the schema's boolean) carries all blocked candidates in `blockers`;
 * cost is ~1 small doc per 15m tick, pruned by pruneStrategySignals like
 * every other row. Empty tick -> no write.
 */
export const logVeto = mutation({
  args: {
    vetoes: v.array(v.object({ pair: v.string(), side: v.string(), reason: v.string() })),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.vetoes.length === 0) return;
    await ctx.db.insert("strategySignals", {
      // Batched doc: pair/side/price/scores are per-entry fields, so the veto
      // row carries the tick's veto list in `blockers` and neutral values for
      // the rest. `entered: false` keeps every existing consumer correct.
      pair: `VETO x${args.vetoes.length}`,
      side: "VETO",
      entryPrice: 0,
      longScore: 0,
      shortScore: 0,
      reasons: [],
      blockers: args.vetoes.map((v) => `${v.pair} ${v.side}: ${v.reason}`),
      emaFast: 0,
      emaSlow: 0,
      imbalance: 0,
      flowBias: 0,
      fundingRate: 0,
      spreadPct: 0,
      atrPct: 0,
      entered: false,
      timestamp: args.timestamp,
    });
  },
});

/**
 * DECISION RECORD (2026-09-23): one row per candidate the scan did NOT take,
 * with the SAME numeric vector an entry row carries.
 *
 * This is the numeric companion to logVeto. logVeto batches the tick's veto
 * reasons into one prose row with every number zeroed (the scan had already
 * collapsed each pair to a string by then), which makes the journal readable
 * but not screenable. Here each rejected candidate keeps its scores, EMA
 * values and Layer-1 snapshot, so a feature can finally be measured on the
 * setups a gate REFUSED — the missing half of every A/B in this repo.
 *
 * Bounded: one batched call per tick, capped at MAX_REJECTION_ROWS_PER_TICK
 * rows, and admission-filtered by NEAR_MISS_BAND in processPair. No separate
 * prune: these rows ride pruneStrategySignals' 60-day pass like every other
 * row (a 21-day cap was written first and removed — it could not fire; see the
 * header note in cleanup.ts).
 *
 * MEASURED VOLUME (2026-09-23, 2.2h live): ~5 rows/tick ≈ 500/day at 789B
 * each ≈ 390 KB/day, against ~68 entries/day. So the gates refuse roughly
 * SEVEN candidates for every one they accept — ~87% of the decision surface
 * was unrecorded before this. (The first estimate here — "~29 pairs × 96
 * ticks ≈ 2,800/day" — assumed every evaluated pair produced a row; the
 * near-miss band and the blocker test cut it to the observed 5.)
 */
export const logRejections = mutation({
  args: {
    rows: v.array(
      v.object({
        pair: v.string(),
        side: v.string(),
        longScore: v.number(),
        shortScore: v.number(),
        reasons: v.array(v.string()),
        blockers: v.array(v.string()),
        emaFast: v.number(),
        emaSlow: v.number(),
        imbalance: v.number(),
        flowBias: v.number(),
        fundingRate: v.number(),
        spreadPct: v.number(),
        atrPct: v.number(),
        signalBarClose: v.number(),
        veto: v.string(),
        shadowTags: v.optional(v.array(v.string())),
        shadowH4RangePct: v.optional(v.number()),
        shadowH4VolLog2: v.optional(v.number()),
        shadowRsi7: v.optional(v.number()),
        // D1 shadow tags v3 (2026-09-26): daily wick % + 5d return at decision.
        d1UpWickPct: v.optional(v.number()),
        d1R5Pct: v.optional(v.number()),
        // Daily StochRSI %K (2026-09-28 candidate, recorded from 2026-10-02).
        // MUST be declared here: Convex rejects the ENTIRE rows array on one
        // undeclared field, and this call site swallowed that error — the
        // decision record was dead 2026-09-29 02:03 → 2026-10-02 because the
        // builder emitted d1StochK while every validator/table predated it.
        d1StochK: v.optional(v.number()),
      }),
    ),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    if (args.rows.length === 0) return;
    for (const row of args.rows) {
      // entryPrice 0 mirrors the veto journal: a rejection has no fill.
      await ctx.db.insert("strategySignals", {
        ...row,
        entryPrice: 0,
        entered: false,
        timestamp: args.timestamp,
      });
    }
  },
});

// LIVE ENTRY-ERROR JOURNAL (2026-09-27): processPairLive's catch counts
// transient failures (MEXC price/enrichment/order hiccups) in the tick
// summary — but that summary is overwritten every 15 minutes, so a candidate
// whose live entry died left NO durable trace and book-divergence audits
// ("why did paper take DOGE and live not?") had nothing to read. These rows
// use side="ERROR" so every LONG/SHORT filter (labs, dashboards, veto stats)
// ignores them, while the failure stays countable by query. The numeric
// vector is zeros by construction: an error row records THAT an attempt
// died and WHY, never an EV measurement.
export const logEntryError = mutation({
  args: {
    pair: v.string(),
    message: v.string(),
    // Row side (2026-10-02, flaw-4c plumbing-skip logging): writers other
    // than the error path log non-error rows through this journal (pre-signal
    // plumbing skips whose side was never evaluated). Default keeps the live
    // wording; LONG/SHORT filters keep ignoring every non-LONG/SHORT side.
    side: v.optional(v.string()),
    // Journal kind (2026-10-02): writers other than the live entry path
    // (decision-record batch, veto journal) label their failure rows so the
    // ERROR trace names WHICH writer died. Default keeps the live wording.
    kind: v.optional(v.string()),
    timestamp: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("strategySignals", {
      pair: args.pair,
      side: args.side ?? "ERROR",
      entryPrice: 0,
      longScore: 0,
      shortScore: 0,
      reasons: [],
      blockers: [],
      emaFast: 0,
      emaSlow: 0,
      imbalance: 0,
      flowBias: 0,
      fundingRate: 0,
      spreadPct: 0,
      atrPct: 0,
      entered: false,
      timestamp: args.timestamp,
      veto: `${args.kind ?? "entry-error"}: ${args.message.slice(0, 180)}`,
    });
  },
});

// Signal Logging Query

export const getRecentSignals = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = args.limit ?? 50;
    const signals = await ctx.db
      .query("strategySignals")
      .order("desc")
      .take(limit);
    return signals;
  },
});

/**
 * PAGED DECISION LOG (2026-10-24) — the replay feed.
 *
 * getRecentSignals() reads the newest N rows, which at ~4k rows/day is only a
 * day and a half. A counterfactual replay needs weeks, so this pages backwards
 * on the by_timestamp index. Read-only, same rows, bounded page size.
 */
export const getSignalsPage = query({
  args: { before: v.optional(v.number()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(2000, Math.max(1, args.limit ?? 1000));
    if (args.before == null) {
      return await ctx.db.query("strategySignals").withIndex("by_timestamp").order("desc").take(limit);
    }
    return await ctx.db
      .query("strategySignals")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", args.before!))
      .order("desc")
      .take(limit);
  },
});

// ── Helpers ──

function sessionOf(ms: number): string {
  const h = new Date(ms).getUTCHours();
  if (h < 7) return "asia";
  if (h < 13) return "london";
  if (h < 17) return "ldn-ny";
  if (h < 22) return "ny";
  return "late";
}

/**
 * A candidate the scan evaluated but did NOT enter, carrying its numbers.
 *
 * THE GAP THIS CLOSES (2026-09-23). `processPair` used to reduce every pair to
 * a `result` STRING before any gate ran, and the tick then recovered the veto
 * list by regex-parsing that string. So `logVeto` could only write zeros into
 * every numeric column, and the ONLY complete decision record in the database
 * was the trades we actually took (344 rows over 10 days). That is the root
 * cause of a pattern that has cost this project repeatedly: every candidate
 * feature has to be judged on a RECONSTRUCTED proxy, so nothing a filter
 * blocks can ever be screened, and every conclusion lands in-sample.
 *
 * This is a RECORD, not a rule. It changes no gate, no threshold and no entry.
 */
export interface RejectionRow {
  pair: string;
  side: string;
  longScore: number;
  shortScore: number;
  reasons: string[];
  blockers: string[];
  emaFast: number;
  emaSlow: number;
  imbalance: number;
  flowBias: number;
  fundingRate: number;
  spreadPct: number;
  atrPct: number;
  signalBarClose: number;
  veto: string;
  // H4 shadow tags (2026-09-23, record-only forward test — src/lib/h4-shadow.ts):
  // which candidate filters WOULD have fired on this candidate. Data, not rules.
  shadowTags?: string[];
  shadowH4RangePct?: number;
  shadowH4VolLog2?: number;
  shadowRsi7?: number;
  // D1 shadow tags v3 (2026-09-26): daily wick % + 5d return at decision.
  d1UpWickPct?: number;
  d1R5Pct?: number;
  // Daily StochRSI %K (2026-09-28 candidate; declared 2026-10-02 after its
  // absence killed every rejection batch — see the logRejections note).
  d1StochK?: number;
}

/**
 * How far below `minScore` the better side may sit and still be recorded as a
 * near-miss. Every evaluated pair is NOT logged: at ~29 pairs × 96 ticks/day
 * that would be ~2,800 rows/day. The band keeps the informative misses (a
 * side that nearly qualified, or one a guard blocked after it did qualify) and
 * drops the obviously dead pairs, which carry no screening information.
 */
const NEAR_MISS_BAND = 3;

/** Per-tick ceiling on decision-record rows, so one wide scan cannot flood the table. */
const MAX_REJECTION_ROWS_PER_TICK = 60;

/**
 * BOOK CONTEXT AT ENTRY (2026-10-06, record-only).
 *
 * The two entry-time tags the journals have never been able to read:
 *   - `rollingWr20`: win rate over the last BREAKER_WINDOW closed layer2
 *     trades. Taken straight from the BREAKER (already computed this tick), so
 *     the tag and the rule can never disagree about the same window; scaled to
 *     a PERCENTAGE (0-100) to match analytics.toFeatures' `?? 50` default.
 *   - `consecutiveStreak`: signed run of the most recent closes, +N wins /
 *     -N losses, 0 while flat. Truncated at the window, so a run longer than
 *     BREAKER_WINDOW reports ±BREAKER_WINDOW.
 *
 * Both come from data strategyTick already loaded (recentClosed + the breaker
 * state), so this adds no read, no network call and no gate. They exist so
 * "was this entry taken into a losing streak?" is answerable from the trade
 * row instead of reconstructed after the fact from exit times — which is
 * exactly what the stack/stop-out journal had to do.
 */
function consecutiveStreakOf(recentClosed: any[], windowSize: number): number {
  const window = recentClosed
    .filter((t) => t.exitTime !== undefined)
    .sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0))
    .slice(0, windowSize);
  let streak = 0;
  for (const t of window) {
    const pnl = t.pnlUsd ?? 0;
    if (pnl === 0) break; // a flat close ends the run
    const sign = pnl > 0 ? 1 : -1;
    if (streak === 0) streak = sign;
    else if (Math.sign(streak) === sign) streak += sign;
    else break;
  }
  return streak;
}

/**
 * Zero-vector plumbing-skip row (2026-10-02 flaw-4c; extended 2026-10-06).
 *
 * A skip that fires BEFORE any score exists (cooldown, open-position lock,
 * short/bad kline history, no closed signal bar) has no numbers to record, so
 * the row carries the Layer-1 snapshot, the reason and a `plumbing: …` veto
 * label. These are decision records, never entries: nothing reads them to make
 * a decision, and the LONG/SHORT filters ignore the SKIP side.
 *
 * The 2026-10-06 extension added the three data/kline paths, which previously
 * returned a tick-summary string and left NOTHING durable — the same silence
 * that hid the decision-record outage documented in logRejections.
 */
function plumbingSkipRow(
  pair: string,
  metrics: any,
  reason: string,
  veto: string,
  signalBarClose: number,
): RejectionRow {
  return {
    pair,
    side: "SKIP",
    longScore: 0,
    shortScore: 0,
    reasons: [reason],
    blockers: [],
    emaFast: 0,
    emaSlow: 0,
    imbalance: metrics.imbalance ?? 0,
    flowBias: metrics.flowBias ?? 0,
    fundingRate: resolveFundingRate(metrics.fundingRate, metrics.fundingValid) ?? 0,
    spreadPct: metrics.spreadPct ?? 0,
    atrPct: metrics.atrPct ?? 0,
    signalBarClose,
    veto,
  };
}

/** Process a single pair: fetch klines, compute signal, optionally enter trade. */
async function processPair(
  pair: string,
  metrics: any,
  cfg: StrategyConfig,
  balance: number,
  now: number,
  recentTrades: Map<string, number>,
  advisor: Record<string, any> | null,
  openCoinSet: Set<string>,
  ctx: any,
  advisor1h?: Record<string, any> | null, // 1H advisor verdicts (2026-09-12, optional layer)
  btcRegime?: BtcRegime, // BTC 4h regime verdict (layer2-v3, computed once per tick; undefined = fail-open)
  /**
   * Shared per-tick factor-exposure state (2026-09-23). `undefined` =
   * disabled: no beta is measured and the gate is a no-op. `net` is
   * mutated in place as candidates are admitted, so the tick bounds the
   * whole book rather than each pair in isolation.
   */
  exposure?: {
    cap: number;
    net: number;
    btcCloses: readonly { openTime: number; close: number }[];
  },
  /** Out-param: filled with the candidate's numbers when the scan did not enter it. */
  sink: { rejection?: RejectionRow } = {},
  /**
   * Book state at entry (2026-10-06, record-only): rollingWr20 (percent, from
   * the breaker's window) + consecutiveStreak, stamped on every entry row.
   * Never read by a gate; undefined only while the book has no closed trades.
   */
  bookContext?: { rollingWr20?: number; consecutiveStreak?: number },
  /**
   * Prefetched 15m series for this pair (2026-10-28, action-compute opt — see
   * the prefetch in strategyTickRun). Missing = read it exactly as before.
   * Same bars the per-pair read would return; only the action boundary moved.
   */
  prefetchedBars?: Map<string, Kline[]>,
): Promise<{ pair: string; result: string }> {
  try {
    // Check cooldown — was there a recent trade on this pair?
    const lastTradeTime = recentTrades.get(pair);
    if (lastTradeTime && now - lastTradeTime < COOLDOWN_MS) {
      const cooldownLeft = Math.round((COOLDOWN_MS - (now - lastTradeTime)) / 60_000);
      // PLUMBING-SKIP RECORD (2026-10-02, flaw 4c): the cooldown fires before
      // any signal is computed, so no score vector exists — record the
      // zero-vector SKIP row (never a decision input; the tick only batches
      // it into the decision log like every other rejection).
      sink.rejection = plumbingSkipRow(
        pair,
        metrics,
        `signal not evaluated — cooldown (${cooldownLeft}m left)`,
        "plumbing: cooldown",
        now,
      );
      return { pair, result: `${pair}: cooldown (${cooldownLeft}m left)` };
    }

    // Open-position lock (2026-09-09, I/O fix): a coin with an OPEN position
    // can't enter regardless of signal — insertTrade's openDup would reject
    // it anyway, but only after the klines + price fetch + enrichment. The
    // skip here saves ~3 MEXC calls per open coin per tick. Trade-off: the
    // entered:false signal-log row for locked coins is no longer written
    // (those rows were the only place the lock's rejected signals showed).
    if (openCoinSet.has(pair)) {
      // PLUMBING-SKIP RECORD (2026-10-02, flaw 4c): same zero-vector SKIP
      // row as the cooldown above — the lock previously left no trace, so no
      // lab could price what holding a position costs in forgone entries.
      sink.rejection = plumbingSkipRow(
        pair,
        metrics,
        "signal not evaluated — open position already exists (locked)",
        "plumbing: open position",
        now,
      );
      return { pair, result: `${pair}: skip — open position already exists (locked)` };
    }

    // PAPER SAMPLES EVERY COIN (2026-10-21). The blocklist is a LIVE safety
    // veto — paper is the measuring instrument, and a pair it never trades is a
    // pair no gate can ever be validated on. Dropping the check here is the
    // whole point of "paper trades all coins": live still refuses the pair, so
    // the ban's real-money effect is unchanged, while the ledger keeps
    // collecting the evidence that would justify lifting it.

    // Fetch 15m candles for EMA computation (400 bars ≈ 4.2 days).
    // PREFETCHED (2026-10-28): the tick reads every eligible pair's series in
    // batched actions before this loop, so the common path is a Map lookup. A
    // pair with no prefetched entry (batch failure, or excluded because it was
    // skipped above) reads its own series exactly as before.
    const klines =
      prefetchedBars?.get(pair) ?? (await relayKlines(ctx, pair, "15m", EMA_KLINE_BARS));
    if (klines.length < EMA_MIN_BARS) {
      // PLUMBING-SKIP RECORD (2026-10-06): a short feed used to leave no trace
      // at all — the decision record only starts once a score vector exists,
      // so a data outage looked identical to a quiet market.
      sink.rejection = plumbingSkipRow(
        pair,
        metrics,
        `signal not evaluated — only ${klines.length}/${EMA_MIN_BARS} candles`,
        "plumbing: klines",
        now,
      );
      return { pair, result: `${pair}: skip (only ${klines.length}/${EMA_MIN_BARS} candles)` };
    }

    // CANDLE INTEGRITY (audit fix 2026-09-11): fail CLOSED on a partial
    // (still-forming) candle, a missing candle in the feed, out-of-order
    // timestamps, or an impossible OHLC bar. Previously any of these could
    // fabricate a "close above the EMA" and enter a phantom setup.
    const integrity = validateKlines(klines, { intervalMs: 15 * 60_000, minBars: EMA_MIN_BARS });
    if (!integrity.ok) {
      // PLUMBING-SKIP RECORD (2026-10-06): a partial/missing/impossible candle
      // now leaves a row instead of only a tick-summary string — this is the
      // fail-CLOSED guard, so its firings are exactly what a journal needs.
      sink.rejection = plumbingSkipRow(
        pair,
        metrics,
        `signal not evaluated — bad candle data (${integrity.reason})`,
        "plumbing: candle integrity",
        now,
      );
      return { pair, result: `${pair}: skip — bad candle data (${integrity.reason})` };
    }

    // Use only completed candles (already handled by shared fetcher, but double-check)
    const closes = klines.map((k) => k.close);

    // Deterministic signal identity = the newest CLOSED 15m bar. fetchKlines
    // excludes the live candle and the EMA_MIN_BARS guard above guarantees a
    // last element, so this cannot be empty in practice — but resolveSignalBarTime
    // deliberately has NO wall-clock fallback: two ticks that see the same
    // closed bars must derive the identical signalTime, or insertTrade's keyed
    // dedupe is silently bypassed and duplicate entries come back. Fail the
    // pair loudly instead of degrading silently. Rule is unit-tested in
    // src/lib/__tests__/strategy-utils.test.ts. Computed early so the manual
    // session filter (below) can gate on the exact session the trade would be
    // tagged with.
    const signalBarTime = resolveSignalBarTime(klines);
    if (signalBarTime == null) {
      // PLUMBING-SKIP RECORD (2026-10-06): the idempotency-key failure. Rare,
      // but when it fires the pair silently drops out of the scan, and nothing
      // recorded that it happened.
      sink.rejection = plumbingSkipRow(
        pair,
        metrics,
        "signal not evaluated — no valid closed signal bar for the idempotency key",
        "plumbing: no signal bar",
        now,
      );
      return { pair, result: `${pair}: skip (no valid closed signal bar for idempotency key)` };
    }
    const entrySession = sessionOf(signalBarTime);

    // Run scoring engine (shared with the LIVE engine — layer2-signal.ts)
    const signal = computeLayer2Signal(
      closes,
      metrics.imbalance,
      metrics.flowBias,
      resolveFundingRate(metrics.fundingRate, metrics.fundingValid),
      metrics.atrPct,
      // 15m ATR% for the volatility floor — NOT metrics.atrPct, which is the
      // Layer-1 tick's 1m read (see the parameter's note in layer2-signal.ts).
      computeAtrPct(klines, 14),
      metrics.candleRangePct,
      metrics.spreadPct,
      metrics.vol24h,
      cfg,
      // Chart-TF highs/lows for the lab-only ST term / stVeto read (both
      // default-off; without this the "st" component records v=null).
      { high: klines.map((k) => k.high), low: klines.map((k) => k.low) },
    );

    // ── H4 SHADOW CONTEXT (2026-09-23, record-only — src/lib/h4-shadow.ts) ──
    // One bar-guarded 4h cache read (≤1 fetch per pair per 4h bar, shared with
    // live) + the RSI(7) of the closes already in memory. NOTHING here blocks
    // or scores: the tags ride on the decision record and the entry row so the
    // forward test can price each candidate filter at journal time.
    const h4Shadow = await getH4ShadowCached(ctx, pair);
    const shadowRsi7 = rsi7FromCloses(closes);
    const shadowSide: "LONG" | "SHORT" | null =
      signal.side ?? (signal.longScore >= signal.shortScore ? "LONG" : "SHORT");
    const shadowPullback =
      shadowSide != null &&
      extAtrApprox(shadowSide, closes[closes.length - 1] ?? 0, signal.emaSlow, metrics.atrPct) <
        PULLBACK_EXT_ATR;
    const shadow = evalShadowTags({ h4: h4Shadow, rsi7: shadowRsi7, pullback: shadowPullback });
    // D1 SHADOW TAGS v3 (2026-09-26, record-only — src/lib/d1-shadow.ts):
    // the two family-sweep survivors (rejection-wick, dead-zone), bar-guarded
    // cached (~1 fetch per pair per UTC day, shared with live). Tags only —
    // nothing here blocks or scores; the forward record is the tiebreaker
    // between artifact and regime-dependent edge (phase-3 lab verdict).
    const d1 = await getD1ShadowCached(ctx, pair);
    const d1Tags = d1ShadowTags(d1, shadowSide ?? "LONG");
    // LTF 5M CONFLUENCE GATE (2026-09-26, both books — src/lib/ltf5m.ts):
    // fetch ~40 closed 5m bars for candidates that reach this point, tag the
    // decision either way, and block LONGs whose minute-scale structure has
    // already rolled over (lab: 92d, t=3.63, split-half 2.42/2.69). Fails
    // open on fetch failure or short history.
    let closes5m: number[] = [];
    try {
      const k5 = await relayKlines(ctx, pair, "5m", 40);
      closes5m = k5.map((b: any) => b.close);
    } catch { closes5m = []; }
    const ltf5mTag = ltf5mShadowTag(closes5m);
    // 4H ADVISOR SHADOW TAGS (2026-10-06, record-only — ADVISOR_REPRICE_JOURNAL
    // §3 verdict: DEMOTE TO SHADOW TAG). The shipped arm (both/L2/S1) deleted
    // +104R of winners on the 6m book, so the layer records what it WOULD have
    // vetoed under this book's own thresholds instead of deciding. Rides the
    // decision record (spread below) and the entry row (entryShadowTags merge)
    // so `lab:shadowcheck` prices the forward record; nothing reads it to block.
    const advSide: "LONG" | "SHORT" | null = signal.side ?? shadowSide;
    const advTags =
      advSide != null
        ? advisorShadowTags({
            metrics: advisor?.[pair],
            btcMetrics: advisor?.BTC,
            side: advSide,
            longThreshold: cfg.advisorLongThreshold,
            shortThreshold: cfg.advisorShortThreshold,
            mode: cfg.advisorMode ?? "both",
          })
        : [];
    const shadowFields = {
      shadowTags: [...shadow.tags, ...d1Tags.tags, ...(ltf5mTag ? [ltf5mTag] : []), ...advTags],
      ...(d1 ? { d1UpWickPct: d1.upWickPct, d1R5Pct: d1.r5Pct, ...(d1.dStochK != null ? { d1StochK: d1.dStochK } : {}) } : {}),
      // null readings stay null — a missing reading is never rendered as zero.
      ...(shadow.h4RangePct != null ? { shadowH4RangePct: shadow.h4RangePct } : {}),
      ...(shadow.h4VolLog2 != null ? { shadowH4VolLog2: shadow.h4VolLog2 } : {}),
      ...(shadow.rsi7 != null ? { shadowRsi7: shadow.rsi7 } : {}),
    };

    // ── DECISION RECORD (2026-09-23) ──────────────────────────────────────
    // Capture the numeric vector HERE, the one place where the full score
    // vector is still alive. The tick fills in `veto` from the gate that ends
    // up firing; the no-signal path sets its own reason below. Purely a write:
    // the collected rejection is used only by the legacy strategy-signal journal.
    const bestScore = Math.max(signal.longScore, signal.shortScore);
    // A pair is worth recording when it produced a side, when a BLOCKER fired
    // (an explicit rejection — a shared penalty like wide spread or an ATR
    // spike suppresses both scores, so a score-band test alone would silently
    // drop precisely the candidates the veto journal lists), or when it came
    // within NEAR_MISS_BAND of qualifying.
    if (signal.side != null || signal.blockers.length > 0 || bestScore >= cfg.minScore - NEAR_MISS_BAND) {
      sink.rejection = {
        pair,
        side: signal.side ?? (signal.longScore >= signal.shortScore ? "LONG" : "SHORT"),
        longScore: signal.longScore,
        shortScore: signal.shortScore,
        reasons: signal.reasons,
        blockers: signal.blockers,
        emaFast: signal.emaFast,
        emaSlow: signal.emaSlow,
        imbalance: metrics.imbalance,
        flowBias: metrics.flowBias,
        fundingRate: resolveFundingRate(metrics.fundingRate, metrics.fundingValid) ?? 0,
        spreadPct: metrics.spreadPct,
        atrPct: metrics.atrPct,
        signalBarClose: signalBarTime,
        veto: signal.side != null
          ? ""
          : signal.stretchBlocked
            ? "ema-stretch veto"
            : signal.rsiLongBlocked
              ? "RSI wick veto"
              : signal.rsiPullbackBlocked
                ? "RSI band veto"
                : signal.trendBlocked
                  ? "trend-gate veto"
                  : signal.blockers.length > 0
                    ? "blocker"
                    : bestScore < cfg.minScore
                      ? "below minScore"
                      // Both sides cleared minScore but the winner could not
                      // clear minGap. The first live decision row (2026-09-23,
                      // SOL L9.8/S10.2, margin 0.4) shows this is NOT the dead                      // knob the minGap doc comment claims it is: the comparison
                      // CAN decide a trade when the EMA term is not the only
                      // contributor. Recorded rather than assumed.
                      : "score margin",
      ...shadowFields,
    };
    }

    // ── H4 QUALITY GATES (2026-09-23, PAPER + LIVE — user decision: "keep
    // all the gates run for now, wire it in the live also; monitor at every
    // journaling") ─────────────────────────────────────────────────────────
    // The four gates from the exhaustion + volume-size labs, enforced for
    // real on BOTH books via h4GateBlocks (src/lib/h4-shadow.ts, unit-tested).
    // Config knobs resolve in layer2-signal.resolveConfig (default-ON; an
    // explicit stored false turns a block off; rsiHeatMax 0 = off). Missing
    // readings fail OPEN — a gate with no 4h row or no RSI never blocks.
    // Runs BEFORE the price fetch so a blocked candidate also skips that
    // MEXC call, and AFTER the decision record above so the gated candidate
    // is journaled with its full score vector (the "blocked — " result shape
    // is picked up by the tick's veto-journal regex).
    if (signal.side) {
      const h4GateCfg = {
        h4VolClimaxBlock: cfg.h4VolClimaxBlock,
        h4PullbackBigBlock: cfg.h4PullbackBigBlock,
        h4PullbackDeadBlock: cfg.h4PullbackDeadBlock,
        rsiHeatMax: cfg.rsiHeatMax,
      };
      const gateExtAtr = extAtrApprox(signal.side, closes[closes.length - 1] ?? 0, signal.emaSlow, metrics.atrPct);
      const gateBlock = h4GateBlocks({
        h4: h4Shadow,
        extAtr: gateExtAtr,
        rsi7: shadowRsi7,
        side: signal.side,
        cfg: h4GateCfg,
      });
      if (gateBlock) {

        return {
          pair,
          result: `${pair}: ${signal.side} blocked — ${gateBlock}`,
        };
      }
    }

    if (!signal.side) {
      return {
        pair,
        result: `${pair}: no signal (L:${signal.longScore.toFixed(1)} S:${signal.shortScore.toFixed(1)})${signal.stretchBlocked ? " · EMA-stretch veto" : ""}${signal.rsiLongBlocked ? " · RSI wick veto" : ""}${signal.trendBlocked ? " · trend-gate veto" : ""}`,
      };
    }

    // LTF 5M CONFLUENCE GATE (2026-09-26, both books — src/lib/ltf5m.ts):
    // block LONGs whose last closed 5m bar closed below its EMA20. Uses the
    // closes5m fetched above for the tag; fails open when missing/short.
    const ltf5mBlock = ltf5mGateBlocks({
      closes5m,
      side: signal.side,
      cfg: { ltf5mGateEnabled: cfg.ltf5mGateEnabled },
    });
    if (ltf5mBlock) {
      return { pair, result: `${pair}: ${signal.side} blocked — ${ltf5mBlock}` };
    }

    // Side kill switch (manual, from the front-end panel). Checked BEFORE any
    // extra MEXC call — disabling a side skips the price fetch + enrichment
    // for it, so the switch doubles as an I/O saver while it is off.
    if (signal.side === "LONG" && !cfg.allowLong) {
      // Label the decision row explicitly (2026-10-06): the tick's veto regex
      // only matches the "<pair>: <SIDE> blocked — …" shape, so a manual
      // switch was recorded with an EMPTY veto and could not be counted.
      if (sink.rejection) sink.rejection.veto = "manual switch: long side disabled";
      return { pair, result: `${pair}: no LONG entry — long side disabled (manual switch)` };
    }
    if (signal.side === "SHORT" && !cfg.allowShort) {
      if (sink.rejection) sink.rejection.veto = "manual switch: short side disabled";
      return { pair, result: `${pair}: no SHORT entry — short side disabled (manual switch)` };
    }

    // PAPER SAMPLES EVERY SESSION (2026-10-21). The per-side allowlist is a
    // LIVE gate: paper must keep trading every session so the session breaker
    // has evidence for the buckets live refuses — a blocked bucket can only
    // re-open if the sensor keeps producing closes in it. Live still enforces
    // the allowlist (liveBrokerRuntime.processPairLive), so the operator's
    // choice binds the book that risks money and nothing else.

    // HTF ADVISOR (2026-09-08, paper default ON): veto the side when the 4H
    // divergence / volume-exhaustion layer has enough agreeing signals.
    // advisorVetoFor reads the STORED (flat) doc shape, applies THIS book's
    // advisorVetoThreshold to the stored vote count, and fails open on
    // missing/malformed rows. Pure logic: src/lib/htf-advisor.ts.
    if (cfg.advisorEnabled) {
      // Per-side veto thresholds (2026-09-08): SHORT blocks on any single
      // flag (replay: every flagged short lost), LONG needs confluence.
      const sideThreshold =
        signal.side === "LONG" ? cfg.advisorLongThreshold : cfg.advisorShortThreshold;
      // Advisor mode (2026-09-09): "pair" = the pair's own 4H verdict,
      // "btc" = BTC's verdict alone, "both" = either blocks (replay-
      // validated: 804t · WR 58.5% · +579.7R at the same 36.3R drawdown
      // as the old per-pair gate). BTC's row is keyed "BTC" in the
      // shared advisorTicks doc — zero extra fetches.
      const sideState = advisorVetoForMode(
        advisor?.[pair],
        advisor?.BTC,
        signal.side,
        sideThreshold,
        cfg.advisorMode ?? "both",
      );
      if (sideState.status === "veto") {
        return {
          pair,
          result: `${pair}: ${signal.side} blocked — HTF advisor veto (${sideState.source === "btc" ? "BTC " : sideState.source === "pair+btc" ? "pair+BTC " : ""}${sideState.votes}/${sideThreshold} signals: ${sideState.reasons.join("; ")})`,
        };
      }
    }

    // 1H ADVISOR (2026-09-12): the SAME detector on 1H bars, vetoing
    // alongside the 4H layer when the book enables it. Own per-side
    // thresholds (advisor1hLongThreshold / advisor1hShortThreshold) falling
    // back to the shared advisor thresholds — the backtest (Sep 1-12 disk
    // cache) showed hourly flags fire ~3x more often, so shipped L2/S1
    // over-vetoes on 1H (-11.6R marginal) while L4/S2.5 is +5.3R. Fails
    // open (missing/stale map = no veto) exactly like the 4H layer.
    //
    // INPUT MODE (2026-09-12): the hourly layer has its OWN mode override
    // (advisor1hMode) so it can drop the per-pair arm while the 4H layer keeps
    // it — unset shares the 4H mode. The mode A/B measured the split at its
    // best when the arms differ: 4H=pair + 1H=btc = 641t · WR 46.8% · +203.5R
    // (+74.3R over the pair-only 4H book) vs 1H=both +29.0R and 1H=pair
    // +2.8R. BTC's 1H verdict alone blocks 61 shorts at 21.3% WR (-26.2R).
    if ((cfg as any).advisor1hEnabled) {
      const sideThreshold1h =
        signal.side === "LONG"
          ? ((cfg as any).advisor1hLongThreshold ?? cfg.advisorLongThreshold)
          : ((cfg as any).advisor1hShortThreshold ?? cfg.advisorShortThreshold);
      const sideState1h = advisorVetoForMode(
        advisor1h?.[pair],
        advisor1h?.BTC,
        signal.side,
        sideThreshold1h,
        (cfg as any).advisor1hMode ?? cfg.advisorMode ?? "both",
      );
      if (sideState1h.status === "veto") {
        return {
          pair,
          result: `${pair}: ${signal.side} blocked — 1H advisor veto (${sideState1h.source === "btc" ? "BTC " : sideState1h.source === "pair+btc" ? "pair+BTC " : ""}${sideState1h.votes}/${sideThreshold1h} signals: ${sideState1h.reasons.join("; ")})`,
        };
      }
    }

    // BTC regime side gate (2026-09-13, layer2-v3): block LONG while BTC's
    // 4h EMA75 slope is chop, SHORT while it is up (±0.5% over 18 closed
    // bars). Layer2 surrogate gauntlet (run-layer2-btc-regime-gate-lab.ts):
    // blocked cohort 3,386t at −422.9R (avg −0.125/t); every threshold/
    // lookback arm lifted, OOS ≥ IS. BTC's verdict is computed ONCE per tick
    // and passed in (btcRegime param) — fail-open on undefined (feed outage
    // must not freeze the book).
    if (btcRegime && btcRegimeBlocks(btcRegime.regime, signal.side)) {
      return {
        pair,
        result: `${pair}: ${signal.side} blocked — BTC 4h regime ${btcRegime.regime} (slope ${btcRegime.slopePct.toFixed(2)}%)`,
      };
    }

    // DOWN-BLOCK (2026-09-14, layer2-v4): in regime "down", block BOTH
    // sides. Grind-fix lab (run-layer2-grind-fix-lab.ts): the Jun–Jul grind
    // bleed is LONG-in-up (−149.8R) + SHORT-in-down (−84.3R); vetoing all
    // down-regime entries lifts the era +17.9 → +156.3R with the profitable
    // windows intact. LAYER2-ONLY: the proxy's SHORT-in-down cohort is its
    // best (+28.5R era), so the proxy engine never reads this knob. Fails
    // open with the same undefined-verdict contract as above.
    if ((cfg as any).btcRegimeDownBlock && btcRegime && btcRegimeDownBlocks(btcRegime.regime)) {
      return {
        pair,
        result: `${pair}: ${signal.side} blocked — BTC 4h regime DOWN-BLOCK (slope ${btcRegime.slopePct.toFixed(2)}%)`,
      };
    }

    // LONG-SLOPE MIN (2026-09-16 — quality lab, 11.8 months, parity exact):
    // residual poison = LONGs while BTC's 4h EMA75 slope is up but feeble
    // (0→+1% over 18 bars). Cohort −0.199/t across 1,217 trades, negative in
    // ALL FOUR quarters; removing it flips the 11.8-month book −69.1 →
    // +172.6R. SHORT stays untouched by measurement.
    // BOTH BOOKS since 2026-10-25 (user: "live should copy paper settings"):
    // liveBrokerRuntime reads the same knob at the same place, so the books no
    // longer differ on which one pays for a down tape's long-side refusals.
    // 0/undefined = off; fail-open when the regime verdict is missing.
    const longSlopeMin = (cfg as any).btcRegimeLongSlopeMin as number | undefined;
    if (longSlopeMin && longSlopeMin > 0 && btcRegime && signal.side === "LONG" && btcRegime.slopePct < longSlopeMin) {
      return {
        pair,
        result: `${pair}: LONG blocked — BTC 4h slope ${btcRegime.slopePct.toFixed(2)}% < +${longSlopeMin}% (long-slope minimum)`,
      };
    }

    // SHORT FLOW GATE (2026-09-09, paper + live share this rule): SHORT
    // entries require aggressive-seller confirmation on the L1 flow snapshot
    // (flowBias < 0). Backtested on real Sep 2-8 signals with the combo
    // advisor: shorts with no sell flow read 23% WR (the bleeders),
    // flow-confirmed shorts 45-46% WR (+6.1R) — total +588.8R at the
    // lowest drawdown of any config (31.1R). flowBias exactly 0 (silent 5s
    // snapshot) blocks — that bucket is the losing one. Runs BEFORE the
    // price fetch so a blocked candidate also skips that MEXC call. LONG
    // untouched.
    if (signal.side === "SHORT" && cfg.shortFlowGate && (metrics.flowBias ?? 0) >= 0) {
      const f = typeof metrics.flowBias === "number" ? metrics.flowBias.toFixed(2) : String(metrics.flowBias ?? "?");
      // SILENT vs BALANCED (2026-09-22) — mirror of the live guard. flowBias is
      // exactly 0 both when selling genuinely offsets buying and when the 5s
      // window caught no trades at all; the second case dominates (68.5% of
      // archived readings). The gate's measured behaviour is UNCHANGED (the
      // silent bucket is the one the Sep 2-8 test found losing, so it still
      // blocks); the reason now names the real cause instead of implying that
      // sellers were absent when the truth is that they were never observed.
      const flowSilent = metrics.flowValid === false;

      return {
        pair,
        result: flowSilent
          ? `${pair}: SHORT blocked — NO FLOW READING (empty 5s window; the flow gate needs visible aggressive sellers)`
          : `${pair}: SHORT blocked — no sell-flow confirmation (flowBias ${f} ≥ 0; flow gate requires aggressive sellers)`,
      };
    }

    // HTF trend gates (2026-09-06, paper + live share these exact rules;
    // price-vs-EMA semantics since 2026-09-11): the verdict compares the
    // last CLOSED HTF-bar close against the HTF EMA(htfEma). SHORT is vetoed
    // while that close is ABOVE the EMA ("up"), LONG while it is BELOW
    // ("down"). Per-side switches + periods are panel-adjustable.
    // TIMEFRAME SWAP (2026-09-13, both books): default htfTf = "4h" — the
    // swap analyzer (run-layer2-htf-swap.ts) over the closed layer2 sample
    // showed the 4h deep-EMA read would have blocked the −9R cluster bucket
    // (kept book +8.1R vs −0.75R as-run) while the 1h reads added little.
    // "4h" uses fetchHtfTrend4h: deep SMA-seeded EMA (>= period+65 bars) on
    // the last CLOSED 4h bar — matches the analyzer bit-for-bit. "1h" keeps
    // the original fetchHtfTrend1h path. Fail-open: missing/flat data stays
    // allowed. Runs BEFORE the price fetch so a blocked candidate also skips
    // the ticker + enrichment MEXC calls.
    const htfGateOn = signal.side === "SHORT" ? cfg.htfGateShort : cfg.htfGateLong;
    const htfEma = signal.side === "SHORT" ? cfg.htfShortEma : cfg.htfLongEma;
    const htfTf = cfg.htfTf === "1h" ? "1h" : "4h";
    // Price-vs-EMA semantics: verdict = last CLOSED HTF-bar close vs the
    // EMA(htfEma). up = close above (longs ok, shorts vetoed), down = close
    // below (shorts ok, longs vetoed), flat/missing = allow.
    if (htfGateOn) {
      // Bar-guarded cache (2026-09-16, cron I/O opt): the verdict depends only
      // on the newest CLOSED bar of the gate's timeframe, so refetching the
      // series per pair on every 15m tick was pure waste. Hit = deterministic
      // value from that bar (same shared verdict helper as the fetch path);
      // miss / stale / read error = the exact pre-cache fetch. Worst case
      // therefore equals the old behavior, never a changed verdict.
      const tfMs = htfTf === "1h" ? 60 * 60_000 : 4 * 60 * 60_000;
      const expectedBar = newestClosedBarOpen(tfMs, Date.now());
      const cached = await ctx
        .runQuery(api.htfCache.getHtf, { coin: pair, tf: htfTf, period: htfEma })
        .catch(() => null);
      let htf: "up" | "down" | "flat" | undefined;
      if (cached && cached.barOpenTime >= expectedBar) {
        htf = htfVerdictOf({ ema: cached.ema, close: cached.close, barOpenTime: cached.barOpenTime });
      } else {
        const raw =
          htfTf === "1h"
            ? await relayHtfRaw(ctx, pair, "1h", htfEma)
            : await relayHtfRaw(ctx, pair, "4h", htfEma);
        htf = raw ? htfVerdictOf(raw) : undefined;
        if (raw) {
          await ctx
            .runMutation(api.htfCache.putHtf, {
              coin: pair,
              tf: htfTf,
              period: htfEma,
              barOpenTime: raw.barOpenTime,
              ema: raw.ema,
              close: raw.close,
            })
            .catch(() => {});
        }
      }
      const tfLabel = htfTf === "1h" ? "1H" : "4H";

      if (signal.side === "SHORT" && htf === "up") {
        return {
          pair,
          result: `${pair}: SHORT blocked — last ${tfLabel} close ABOVE ${tfLabel} EMA ${htfEma} (HTF gate, price-vs-EMA)`,
        };
      }
      if (signal.side === "LONG" && htf === "down") {
        return {
          pair,
          result: `${pair}: LONG blocked — last ${tfLabel} close BELOW ${tfLabel} EMA ${htfEma} (HTF gate, price-vs-EMA)`,
        };
      }
    }

    // 4H CHOPPINESS GATE (2026-09-22, default OFF): block a side while the
    // pair's own 4H Kaufman Efficiency Ratio — net move ÷ path length over
    // the last `chopGatePeriod` CLOSED 4h bars — sits below its floor
    // (shared chopGateFloor, optional per-side override). The choppy-4H fix
    // the operator asked for: when the 4H tape weaves around its filter EMA
    // (INJ: ER 0.14 vs a 0.25 floor) the HTF verdict flips while 15m HL/LH
    // setups inside the range get stop-farmed. Pure math in
    // src/lib/chop-gate.ts; the same `efficiencyRatio` is imported by
    // run-4h-chop-gate-lab.ts so the lab measures exactly this gate.
    // Contracts: CLOSED candles only (fetchKlines excludes the live bar),
    // fail-open (gate off / short history / fetch error = allow), default
    // OFF so shipped behavior is byte-identical until the panel arms it.
    // Runs BEFORE the price fetch so a blocked candidate also skips the
    // ticker call — same ordering as the HTF gate above. Config-driven, so
    // it arms whichever book has it on, and it defaults OFF EVERYWHERE: the
    // 6-month A/B ran 2026-09-22 (backtest:chopgate) and did NOT clear the
    // promotion bar (Δnet/t +0.009, paired-day t 0.34, IS +0.030 → OOS
    // −0.012). Left wired so the measurement stays re-runnable; see the
    // header of src/lib/chop-gate.ts for the full verdict.
    if (cfg.chopGateEnabled) {
      try {
        const period =
          cfg.chopGatePeriod > 0 ? Math.floor(cfg.chopGatePeriod) : CHOP_GATE_DEFAULTS.period;
        const k4h = await relayKlines(ctx, pair, "4h", period + 1);
        const verdict = chopGateVerdict(
          k4h.map((k) => k.close),
          cfg,
          signal.side,
        );

        if (verdict.blocked) {
          return {
            pair,
            result: `${pair}: ${signal.side} blocked — 4H chop gate (ER(${period}) ${verdict.er!.toFixed(2)} < floor ${verdict.floor})`,
          };
        }
      } catch {
        // fail-open: a kline fetch error must never silently freeze the book.
      }
    }

    // Get current price for entry.
    //
    // FALLBACK (2026-10-28): a failed per-pair read used to skip the candidate
    // ("plumbing: no price") even though the batched universe snapshot carries
    // the same last price for every symbol in ONE request. The per-pair read
    // stays primary on purpose — that is the price a market order would see a
    // moment later, and substituting a tick-start snapshot would change every
    // paper fill. This only rescues a transient read error.
    let entryPrice = await relayTickerPrice(ctx, pair).catch(() => 0);
    if (!entryPrice || entryPrice <= 0) {
      const snapshot = await relayAllTickers(ctx).catch(() => null);
      entryPrice = snapshot?.get(pair)?.last ?? 0;
    }
    if (!entryPrice || entryPrice <= 0) {
      // Same labelling rule as the manual switch above: this return shape does
      // not match the veto regex, so the row would otherwise be blank.
      if (sink.rejection) sink.rejection.veto = "plumbing: no entry price";
      return { pair, result: `${pair}: skip (no price)` };
    }

    // FACTOR-EXPOSURE CAP (2026-09-23) — the paper twin of liveBroker's
    // gate. Runs BEFORE sizing/enrichment so a blocked candidate costs
    // nothing further. Beta comes from the same closed 15m bars the signal
    // was computed on, regressed on BTC's over the same timestamps. The
    // check and the increment are synchronous (no await between them), so
    // sibling pairs in the same parallel batch cannot both pass.
    let entryBeta: number | undefined;
    if (exposure && exposure.cap > 0) {
      entryBeta = estimateBtcBeta(klines, exposure.btcCloses);
      const next = exposure.net + signedBeta(signal.side, entryBeta);

      if (
        betaCapBlocks({
          net: exposure.net,
          side: signal.side,
          beta: entryBeta,
          cap: exposure.cap,
        })
      ) {
        return {
          pair,
          result:
            `${pair}: ${signal.side} blocked — factor-exposure cap (net BTC-beta ` +
            `${exposure.net.toFixed(2)} → ${next.toFixed(2)} > ${exposure.cap} · this pair β ${entryBeta.toFixed(2)})`,
        };
      }
      exposure.net = next;
    }

    // ENTRY GUARDS (2026-10): same rules as live. Exchange contract data must
    // be complete, risk must be set, and the spread/slippage limits (off unless
    // set) must pass. Nothing is defaulted on the entry path.
    let contract: Awaited<ReturnType<typeof contractMetaFull>>;
    try {
      contract = await contractMetaFull(pair);
    } catch {
      return { pair, result: `${pair}: ${signal.side} skipped — contract detail unavailable` };
    }
    if (contract.missing.length) {
      return {
        pair,
        result: `${pair}: ${signal.side} skipped — exchange contract data missing (${contract.missing.join(", ")})`,
      };
    }
    const paperMeta = contract.meta;
    if (riskPctUnset(cfg.riskPct)) {
      return { pair, result: `${pair}: ${signal.side} skipped — risk per trade not set` };
    }
    const entryGuard = entryGuardBlock({
      spreadPct: metrics.spreadPct,
      maxSpreadPct: cfg.maxSpreadPct,
      signalPrice: closes[closes.length - 1],
      entryPrice,
      maxSlippageBps: cfg.maxEntrySlippageBps,
    });
    if (entryGuard) {
      return { pair, result: `${pair}: ${signal.side} blocked — ${entryGuard}` };
    }

    // Calculate SL/TP from config. Per-side SHORT TP (2026-09-09): shorts
    // use shortTakeProfitPct when set (live: 2.25 = 1.5R), else the shared
    // takeProfitPct. LONG always uses the shared TP.
    const slPct = cfg.stopLossPct / 100;
    const tpPct =
      signal.side === "SHORT" && cfg.shortTakeProfitPct != null
        ? cfg.shortTakeProfitPct / 100
        : cfg.takeProfitPct / 100;
    const slPrice = roundPriceToTick(
      signal.side === "LONG" ? entryPrice * (1 - slPct) : entryPrice * (1 + slPct),
      paperMeta.priceUnit,
    );
    const stopDistPrice = entryPrice * slPct;

    // R-LOCK TRAILING EXIT (2026-09-20). When the lock is armed the stored
    // `tpPrice` becomes the lock's MAX-TARGET price (trailLockMaxR × the stop
    // distance) rather than the fixed takeProfitPct: a fixed 2R target is
    // exactly what the lock exists to remove, and leaving it in place would
    // close every winner before the ratchet could ever matter. The lock
    // parameters are stamped onto the trade so the exit tick closes it under
    // the policy it was opened with (config changes stay entry-scoped, same
    // rule as takeProfitPct). See src/lib/r-lock.ts for the measurement.
    const lockOn = rLockEnabled({ startR: cfg.trailLockStartR });
    const lockMaxR = cfg.trailLockMaxR > 0 ? cfg.trailLockMaxR : 8;
    const tpPrice = roundPriceToTick(lockOn
      ? signal.side === "LONG"
        ? entryPrice + stopDistPrice * lockMaxR
        : entryPrice - stopDistPrice * lockMaxR
      : signal.side === "LONG"
        ? entryPrice * (1 + tpPct)
        : entryPrice * (1 - tpPct), paperMeta.priceUnit);

    // Position sizing — read actual balance, risk cfg.riskPct % of it
    // (config knob 2026-09-10; compounding unchanged: paper balance already
    // rolls with closed PnL). HARD 2% CEILING (Phase 7): clampRiskPct caps a
    // panel typo or stale row at MAX_RISK_PCT_PER_TRADE — a typo can never
    // 100× the size, and no book can exceed 2% nominal initial risk/trade.
    const riskPct = clampRiskPct(cfg.riskPct, NaN);
    const riskAmount = (balance * riskPct) / 100;
    // Round to the exchange step like live does (floor, never oversize).
    const paperContracts = roundVol(riskAmount / stopDistPrice / paperMeta.contractSize, paperMeta.volScale);
    if (paperContracts < paperMeta.minVol || paperContracts > paperMeta.maxVol) {
      return {
        pair,
        result: `${pair}: ${signal.side} skipped — ${paperContracts} contracts outside [${paperMeta.minVol}, ${paperMeta.maxVol}]`,
      };
    }
    const sizeCoin = paperContracts * paperMeta.contractSize;

    // ANALYTICS FINDING (2026-09-03): blocklisted pairs (ENA) are negative in
    // both config eras and BAD_ENTRY-concentrated. Tunable via updateConfig.
    // (2026-09-10 audit: the check now runs BEFORE the klines fetch, at the
    // top of processPair with the other free gates.)

    // buildTradeEnrichment still records htfTrend1h (EMA-20 read) on every
    // stored trade for analytics continuity — the GATE itself no longer reads
    // it; it evaluates the per-side period above, before the price fetch.
    // OI context (2026-09-09) comes from the Layer-1 tick series so entries log
    // a true 4h OI % delta (openInterestDelta) + raw snapshot (oiAtEntry). READ
    // IT FIRST (2026-10-06): this was gathered in parallel and then DROPPED —
    // only `...enrich` was spread into insertTrade, so `openInterestDelta` was
    // undefined on every paper row while the live book recorded it. The read is
    // a local indexed query; the enrichment below is the MEXC-bound half.
    const oiCtx = await ctx.runQuery(api.marketData.getOiContext, { pair }).catch(() => null);
    const enrich = await buildTradeEnrichment(ctx, pair, klines, signalBarTime, oiCtx);
    // STALL shadow tags (2026-10-06, record-only — src/lib/stall-shadow.ts):
    // the Rule B/F forward record, read off the enrichment strings the ledger
    // pricing used (htfTrend1h / btcTrendAtEntry / atrPctAtEntry — zero extra
    // I/O, fail-open on missing). Merged over the decision-time tags on the
    // entry row and its signal row; nothing reads them to block or score.
    const entryShadowTags = [
      ...(shadowFields.shadowTags ?? []),
      ...stallShadowTags({
        side: signal.side,
        htfTrend1h: enrich.htfTrend1h,
        btcTrendAtEntry: enrich.btcTrendAtEntry,
        atrPctAtEntry: enrich.atrPctAtEntry,
      }),
    ];

    // Insert trade
    const inserted = await ctx.runMutation(api.paperTrading.insertTrade, {
      coin: pair,
      type: signal.side,
      entryPrice,
      slPrice,
      tpPrice,
      // R-lock policy this position closes under (2026-09-20). Left undefined
      // when the lock is off so the row keeps meaning "fixed TP".
      trailStartR: lockOn ? cfg.trailLockStartR : undefined,
      trailStepR: lockOn ? cfg.trailLockStepR : undefined,
      trailMaxR: lockOn ? lockMaxR : undefined,
      sizeCoin,
      leverage: LEVERAGE,
      entryTime: now,
      signalTime: signalBarTime, // deterministic signal key → idempotent entry
      signalPrice: entryPrice,
      variant: "layer2-v1",
      book: "layer2",
      ...enrich,
      // Book state at entry (2026-10-06, record-only). Both columns existed
      // and were never written; a journal trying to price
      // "entries taken during a losing streak" had to rebuild this from exits.
      rollingWr20: bookContext?.rollingWr20,
      consecutiveStreak: bookContext?.consecutiveStreak,
      dayOfWeek: new Date(now).getUTCDay(),
      longScore: signal.longScore,
      shortScore: signal.shortScore,
      // Factor-exposure cap (2026-09-23): the beta this entry was admitted
      // on and the book's signed net beta after it. Both undefined while the
      // cap is off, since no beta is measured then.
      btcBetaAtEntry: entryBeta,
      netBtcBetaAtEntry:
        entryBeta != null && exposure ? +exposure.net.toFixed(4) : undefined,
      // H4 shadow tags (2026-09-23): record-only, see src/lib/h4-shadow.ts.
      ...shadowFields,
      // STALL tags (2026-10-06): decision-time tags plus the entry-time
      // stall read — the forward record for Rules B/F.
      shadowTags: entryShadowTags,
    });

    // EXECUTION RECORD (2026-10-10, Stage 3 — record-only, fail-open). Separate
    // scheduled mutation, keyed on the trade's natural key; a logging failure
    // can never block, alter or roll back the entry above.
    if (inserted) {
      await scheduleEntryRecordByKey(ctx, {
        table: "paperTrades",
        book: "layer2",
        coin: pair,
        signalTime: signalBarTime,
      });
    }

    // Log the signal
    await ctx.runMutation(api.strategyEngine.logSignal, {
      pair,
      side: signal.side,
      entryPrice,
      longScore: signal.longScore,
      shortScore: signal.shortScore,
      reasons: signal.reasons,
      blockers: signal.blockers,
      emaFast: signal.emaFast,
      emaSlow: signal.emaSlow,
      imbalance: metrics.imbalance,
      flowBias: metrics.flowBias,
      fundingRate: metrics.fundingRate,
      spreadPct: metrics.spreadPct,
      atrPct: metrics.atrPct,
      entered: inserted,
      timestamp: now,
      ...shadowFields,
      shadowTags: entryShadowTags,
    });

    if (inserted) {

      return { pair, result: `${pair}: ENTERED ${signal.side} @ ${entryPrice.toFixed(4)} (L:${signal.longScore.toFixed(1)} S:${signal.shortScore.toFixed(1)})` };
    } else {
      if (sink.rejection) sink.rejection.veto = "plumbing: duplicate open trade";
      return { pair, result: `${pair}: blocked (duplicate open trade)` };
    }
  } catch (e: any) {
    // DURABLE FAILURE TRACE (2026-10-06): a throw in processPair (klines
    // fetch, insertTrade rejecting a row, a malformed candidate) previously
    // left ONLY the tick-summary string, which the next tick overwrote — the
    // exact silence that let an undeclared insertTrade field kill entries with
    // no trace. Journal it through the entry-error path instead.
    await ctx
      .runMutation(api.strategyEngine.logEntryError, {
        pair,
        kind: "pair-scan-error",
        message: e?.message ?? String(e),
        timestamp: Date.now(),
      })
      .catch(() => {});
    return { pair, result: `${pair}: error (${e.message})` };
  }
}

// ── Tick run-guard lease ──
// Overlapping strategyTick executions (a cron fire while the previous tick is
// still running, or the panel's manual "Run Layer 2" while the cron tick is
// in flight) are what make two insertTrade calls race for the same pair: both
// dup-checks read "no open trade", both insert, and Convex retries the write
// conflicts on paperTrades. Exactly one tick at a time is allowed via the
// layer2 account's scanLockUntil field; the loser aborts before any entry.

export const acquireStrategyTickLock = mutation({
  args: { leaseMs: v.number() },
  handler: async (ctx, args): Promise<{ locked: boolean; reason?: string }> => {
    const acc = await ctx.db
      .query("paperAccount")
      .withIndex("by_name", (q) => q.eq("name", "layer2"))
      .first();
    if (!acc) return { locked: false, reason: "no-account" };
    // Pure lease rule (tested in src/lib/__tests__/strategy-utils.test.ts):
    // null = in-flight (another tick holds the lease), number = new expiry.
    const expiry = tryAcquireLease(acc.scanLockUntil, Date.now(), args.leaseMs);
    if (expiry == null) return { locked: false, reason: "in-flight" };
    await ctx.db.patch(acc._id, { scanLockUntil: expiry });
    return { locked: true };
  },
});

/** Release the strategyTick run-guard lease (see acquireStrategyTickLock). */
export const releaseStrategyTickLock = mutation({
  args: {},
  handler: async (ctx) => {
    const acc = await ctx.db
      .query("paperAccount")
      .withIndex("by_name", (q) => q.eq("name", "layer2"))
      .first();
    if (acc) await ctx.db.patch(acc._id, { scanLockUntil: 0 });
  },
});

// ── Main Action: Layer 2 Tick ──

export const strategyTickRun = internalAction({
  // `cron` is passed ONLY by the cron registration in crons.ts — this action is
  // also wired to the panel's "Run now". See src/lib/heartbeat.ts.
  // NOT the public entry: `strategyTick` below wraps it so a crash is visible.
  args: { cron: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{
    status: string;
    scanned: number;
    signals: number;
    entries: number;
    results: string[];
  }> => {
    // Heartbeat, scheduler-only (src/lib/heartbeat.ts) — recorded before any
    // gate can early-return, so a disabled book still shows a live clock.
    if (args.cron) {
      await ctx.runMutation(internal.heartbeat.record, { job: "layer2-strategy" }).catch(() => {});
    }

    const results: string[] = [];
    let signalCount = 0;
    let entryCount = 0;
    // PAPER SCAN STATUS (2026-10-21): one patch per tick so the panel's
    // "last scan" line is the engine's OWN summary. Nothing in this file
    // used to write it — the tick returned its summary to the cron and
    // dropped it — so `paperAccount.lastScanResult` froze on the last write
    // the PREVIOUS deployment made and the panel kept showing a stale scan
    // as if it were current. A paper book you cannot see is a paper book you
    // cannot trust: this line is where a gate drought shows up.
    const recordStatus = (status: {
      scanned: number;
      signals: number;
      entries: number;
      blocked: number;
      note?: string;
    }) =>
      ctx
        .runMutation(internal.strategyEngine.recordPaperScanStatus, status)
        .catch(() => {});
    // Veto journal accumulator: qualified candidates blocked by a gate.
    const vetoes: { pair: string; side: string; reason: string }[] = [];
    // Numeric decision record for candidates this tick does NOT take.
    const rejections: RejectionRow[] = [];
    // One-time variant migration for the HTF gate era (idempotent; runs once
    // per variant bump). The user request wired the 4H timeframe on 09-13;
    // the era sweep then fixed the PERIOD at 75. The paper row's explicit
    // 15/30 and the live row's explicit 25/25 would otherwise win the
    // default-merge forever, so the stamp writes 75/75 explicitly — and
    // re-arms the gate switches (paper's had drifted OFF pre-request).
    // Mutations can't run inside an action, so the stamp lives in its own
    // idempotent mutation below and is invoked here + by liveTick.
    for (const note of await ctx.runMutation(api.strategyEngine.ensureLayer2GateMigration, {})) {
      results.push(note);
    }

    // Load the PAPER config row (name "ema-momentum") through
    // resolvePaperConfig. Funding is currently forced OFF there (2026-09-08:
    // the sign-strict agreement test was parked — prevailing positive funding
    // vetoed LONGs on most of the universe) — live keeps its own
    // configurable row/policy in liveBroker.
    const configRecord: any = await ctx.runQuery(api.strategyEngine.getConfig, {});
    const cfg: StrategyConfig = resolvePaperConfig(configRecord);

    // Layer 2 book has its OWN paperAccount (created on first use, seeded with
    // the book's accumulated closed P&L) — size off that, never the main book.
    // (Previously this read the main account, and layer2 closes had no
    // "layer2" account to credit, so layer2 P&L was silently dropped.)
    const account: any = await ctx.runMutation(api.paperTrading.ensureLayer2Account, {});
    const balance = account?.balance ?? 150; // fallback to $150 if no account exists

    // CIRCUIT BREAKER (paper only, 2026-09-08): recomputed every tick from the
    // last BREAKER_WINDOW closes + today's realized P&L. While tripped, skip
    // the whole scan so the book stops bleeding ~1R stops into a degraded
    // regime (Sep 7-8: -$142.87 in 63 closes, WR 27%). Checked BEFORE the
    // run-guard lease so a paused tick never holds it. Re-arms automatically:
    // WR20 recovers as new closes enter the window; daily loss resets at UTC
    // midnight.
    const nowMs = Date.now();
    const recentClosed: any[] = await ctx.runQuery(api.paperTrading.getLayer2RecentClosed, {
      n: BREAKER_WINDOW,
    });
    // Daily-loss window = EVERY close since the start of the UTC day, not the
    // last 20 (audit fix 2026-09-11: a >20-close day could never trip the cap).
    let dailyClosed: any[] = [];
    if (cfg.breakerEnabled) {
      const dayStart = new Date(nowMs);
      dayStart.setUTCHours(0, 0, 0, 0);
      dailyClosed = await ctx.runQuery(api.paperTrading.getLayer2ClosedSince, {
        since: dayStart.getTime(),
      });
    }
    const breaker = computeBreakerState({ recentClosed, dailyClosed, balance, now: nowMs, cfg });
    // ENTRY TAGS (2026-10-06, record-only): the rolling win rate comes from the
    // breaker state computed one line above (same window, same "win" rule), and
    // the streak from the same recentClosed read. No extra I/O, nothing gates.
    const bookContext = {
      rollingWr20: breaker.wr20 != null ? +(breaker.wr20 * 100).toFixed(1) : undefined,
      consecutiveStreak: consecutiveStreakOf(recentClosed, BREAKER_WINDOW),
    };
    if (breaker.paused) {
      const note = `CIRCUIT BREAKER — entries paused: ${breaker.reasons.join(" | ")}`;

      // SYSTEM EVENT (Stage 4, record-only, fail-open): a trip is a fact about
      // the system, not about a trade, and it only lands if the write succeeds.

      await recordStatus({ scanned: 0, signals: 0, entries: 0, blocked: 0, note });
      return {
        status: "circuit-breaker",
        scanned: 0,
        signals: 0,
        entries: 0,
        results: [note],
      };
    }

    // Run-guard lease (2026-09): strategyTick (15-min cron) and the panel's
    // manual "Run Layer 2" can overlap when a tick runs past the next cron
    // fire. Two overlapping ticks both pass processPair's checks and race
    // identical insertTrade calls for the same pair — each dup-check reads
    // "no open trade", then both insert → Convex write conflicts on
    // paperTrades. Convex auto-retries them (surfacing as the "Retried due to
    // write conflicts in table paperTrades" insight, each retry re-running
    // the whole mutation and inflating entry-path I/O). The lease below
    // serializes ticks: the second entrant aborts here before any entry work.
    // Released on success; if a tick crashes mid-run the lease auto-expires
    // after TICK_LEASE_MS (25 min), so at most one cron fire is skipped.
    const lease: any = await ctx.runMutation(api.strategyEngine.acquireStrategyTickLock, {
      leaseMs: TICK_LEASE_MS,
    });
    if (!lease.locked) {
      const note =
        "skip: another strategy tick is in flight — lease held (duplicate-entry race prevented)";


      await recordStatus({ scanned: 0, signals: 0, entries: 0, blocked: 0, note });
      return {
        status: "skip",
        scanned: 0,
        signals: 0,
        entries: 0,
        results: [note],
      };
    }

    // Get all pairs with fresh Layer 1 metrics
    const allMetrics: any[] = await ctx.runQuery(api.strategyEngine.getAllStrategyStates);
    const now = Date.now();
    const freshMetrics = allMetrics.filter(
      (m: any) => now - m.fetchedAt < STALE_METRICS_MAX_AGE_MS,
    );

    // VISIBLE DEGRADATION (audit fix 2026-09-11): with every metric stale the
    // scan used to process zero pairs and report success — a silent no-op while
    // the marketData cron was down. Say so loudly instead.
    if (freshMetrics.length === 0) {
      const note = `LAYER 1 METRICS STALE — no pair metrics newer than ${STALE_METRICS_MAX_AGE_MS / 60_000} min; scan skipped (check the marketData cron)`;


      await recordStatus({ scanned: 0, signals: 0, entries: 0, blocked: 0, note });
      return {
        status: "stale-metrics",
        scanned: 0,
        signals: 0,
        entries: 0,
        results: [note],
      };
    }

    // Get recent trade times per pair for cooldown check — scoped to the
    // LAYER 2 book. getTrades reads the MAIN book only, so using it here made
    // the 1h per-pair cooldown a permanent no-op for layer2 pairs.
    const cooldownRows = await ctx.runQuery(api.paperTrading.getLayer2Cooldowns, {});
    const recentTrades = new Map<string, number>();
    for (const row of cooldownRows) recentTrades.set(row.coin, row.time);

    // Open-position lock (2026-09-09, I/O fix): skip coins already holding an
    // OPEN layer2 position — insertTrade's openDup would reject them anyway,
    // but only AFTER the klines fetch + price fetch + enrichment (~3 MEXC
    // calls per open coin per tick). One DB read per tick, mirrors live's
    // openCoinSet skip.
    //
    // PAPER HAS NO POSITION CAP, AND MUST NOT GET ONE (2026-10-21, operator
    // rule). `maxOpenPositions` exists only on liveAccount — the live book caps
    // itself at 10 — because live spends a finite margin. Paper is the sensor
    // every gate in this system is validated on: a slot count here would make
    // its record conditional on how many other pairs happened to be open, and
    // the session breaker / coin-priority rankings read exactly that record. So
    // paper enters EVERY qualified signal and lets the gates decide.
    //
    // The only concurrency rules on this book are (a) this one-per-coin lock —
    // a duplicate guard, not a count cap, since two positions on one coin would
    // double that pair's exposure and corrupt its per-pair record — and (b) the
    // 1h per-pair cooldown above. Nothing limits how many PAIRS are open at
    // once, and both exit paths (rLockExit.layer2ExitTick,
    // strategyEngine.resolveLayer2Exits) read the open book with collect(), so
    // every extra position is still managed to its stop.
    const openCoins = await ctx.runQuery(api.paperTrading.getLayer2OpenCoins, {});
    const openCoinSet = new Set<string>(openCoins);
    // Factor-exposure cap (2026-09-23): the open book's per-position side +
    // entry beta. One extra small read per tick; unused (and unpaid for
    // beyond the read) while the cap is off.
    const openRisk: { coin: string; side: string; beta?: number }[] = await ctx
      .runQuery(api.paperTrading.getLayer2OpenRisk, {})
      .catch(() => []);

    // BATCHED 15m PREFETCH (2026-10-28, action-compute opt). Every pair that
    // reaches processPair reads the same 400x15m series, and each read used to
    // be its OWN relay action — ~34 per tick, each billed separately (the
    // caller waits, the callee runs). Read them once, in a handful of batched
    // actions, and hand processPair the series in memory.
    //
    // PURE TRANSPORT: same fetcher, same interval, same bar count, same pacer.
    // The list is exactly the pairs that would reach the fetch — cooldown and
    // the open-position lock return BEFORE it (see processPair), so those pairs
    // are excluded here and still skip with zero reads.
    //
    // Failure is per series: a null entry means "no prefetched series" and
    // processPair falls back to its own read, so a batch failure costs hops,
    // never a signal. Chunked so one action's return value stays small.
    const prefetchPairs = freshMetrics
      .map((m: any) => String(m.pair))
      .filter((p: string) => {
        if (openCoinSet.has(p)) return false;
        const last = recentTrades.get(p);
        return !(last && now - last < COOLDOWN_MS);
      });
    const prefetchedBars = new Map<string, Kline[]>();
    const PREFETCH_CHUNK = 10;
    for (let i = 0; i < prefetchPairs.length; i += PREFETCH_CHUNK) {
      const chunk = prefetchPairs.slice(i, i + PREFETCH_CHUNK);
      try {
        const series = await relayKlinesBatch(
          ctx,
          chunk.map((coin: string) => ({ coin, interval: "15m", bars: EMA_KLINE_BARS })),
        );
        series.forEach((bars, k) => {
          if (bars && bars.length > 0) prefetchedBars.set(chunk[k], bars);
        });
      } catch (e: any) {
        // fall through: processPair reads its own series
        console.warn(`[layer2] 15m prefetch chunk failed: ${e?.message ?? e}`);
      }
    }

    // HTF advisor state: newest advisorTicks doc read ONCE per run, then
    // indexed per pair inside processPair — zero extra MEXC calls per pair.
    // FRESHNESS GATE: only enforce when the doc is newer than
    // ADVISOR_MAX_AGE_MS; an old doc (missed cron, stalled deployment) fails
    // open so stale divergence flags can never veto trades.
    const advisorState: any = await ctx
      .runQuery(api.advisor.getAdvisorState, { interval: "4h" })
      .catch(() => null);
    const advisorMap: Record<string, any> | null =
      advisorState && Date.now() - advisorState.timestamp < ADVISOR_MAX_AGE_MS
        ? advisorState.metrics
        : null;
    // 1H advisor layer (2026-09-12): the same detector on 1H bars, ticking
    // hourly. Optional (default OFF until the cache backtest validates it);
    // read only when the paper/live config turns it on — zero extra reads
    // while disabled. Same freshness gate as the 4H layer.
    const advisor1hState: any = (cfg as any).advisor1hEnabled
      ? await ctx.runQuery(api.advisor.getAdvisorState, { interval: "1h" }).catch(() => null)
      : null;
    const advisor1hMap: Record<string, any> | null =
      advisor1hState && Date.now() - advisor1hState.timestamp < ADVISOR_MAX_AGE_MS
        ? advisor1hState.metrics
        : null;

    // FAIL OPEN (reverted 2026-09-11): a missing/stale advisor doc must NOT
    // halt the whole book. The previous "fail closed" version turned ANY
    // advisor-cron hiccup — one missed/delayed 4H run, a fresh deployment
    // with no doc yet, a manual reset — into a total entry blackout on paper
    // AND live (scanned: 0, status "advisor-stale"), which is exactly the
    // "paper and live show no signals" symptom. Degradation is now LOUD but
    // non-blocking: the scan proceeds with the veto layer absent (processPair
    // treats a null map as "no veto"), and the reason is surfaced in the tick
    // results so the stalled cron is visible instead of silent.
    if (cfg.advisorEnabled && !advisorMap) {
      results.push(
        "WARNING: HTF ADVISOR DATA MISSING/STALE — scanning WITHOUT the 4H veto layer (fix the advisor cron; entries are NOT blocked)",
      );
    }
    if ((cfg as any).advisor1hEnabled && !advisor1hMap) {
      results.push(
        "WARNING: 1H ADVISOR DATA MISSING/STALE — scanning WITHOUT the 1H veto layer (fix the hourly advisor cron; entries are NOT blocked)",
      );
    }

    // BTC regime verdict (layer2-v3): the bar-guarded shared cache, read
    // ONCE per tick and shared by every pair — one 4h fetch per bar across
    // ALL THREE books instead of one per book per tick, and zero extra
    // per-entry MEXC calls. Fail-open: undefined verdict leaves the gate
    // inactive (see convex/btcRegimeCache.ts).
    let btcRegime: BtcRegime | undefined;
    if ((cfg as any).btcRegimeEnabled !== false) {
      // Bar-guarded cache (2026-09-16, cron I/O opt): the verdict is a pure
      // function of the newest CLOSED 4h bar and is SHARED with the proxy and
      // live engines, so re-fetching 240x4h bars every 15m tick was ~186
      // wasted MEXC requests/day. Hit = the value a fetch would have produced
      // (same helper, same 240 bars); miss/error = the exact pre-cache fetch.
      // See convex/btcRegimeCache.ts for the contract.
      btcRegime = await getBtcRegimeCached(ctx);
    }


    // FACTOR-EXPOSURE CAP (2026-09-23) — mirrors liveBroker. Disabled by
    // default (maxNetBtcBeta = 0): the tick then measures nothing and
    // fetches no BTC bars. Armed, it seeds the book's signed net beta from
    // the open positions and shares BTC's 15m closes across the scan, so
    // each candidate's beta is one regression against bars in memory.
    const betaCap =
      typeof cfg.maxNetBtcBeta === "number" && cfg.maxNetBtcBeta > 0
        ? cfg.maxNetBtcBeta
        : 0;
    let btcCloses: { openTime: number; close: number }[] = [];
    if (betaCap > 0) {
      btcCloses = await relayKlines(ctx, "BTC", "15m", EMA_KLINE_BARS)
        .then((ks) => ks.map((k) => ({ openTime: k.openTime, close: k.close })))
        .catch(() => []);
    }
    const exposure = {
      cap: betaCap,
      net: netBtcBeta(openRisk.map((r) => ({ side: r.side, beta: r.beta }))),
      btcCloses,
    };

    // Process pairs in parallel batches (max PARALLEL_BATCH_SIZE concurrent)
    for (let b = 0; b < freshMetrics.length; b += PARALLEL_BATCH_SIZE) {
      const batch = freshMetrics.slice(b, b + PARALLEL_BATCH_SIZE);
      // One sink per pair collects legacy strategy-signal rejection rows.
      const batchSinks: { rejection?: RejectionRow }[] = batch.map(() => ({}));
      const batchResults = await Promise.all(
        batch.map((metrics: any, i: number) =>
          processPair(metrics.pair, metrics, cfg, balance, now, recentTrades, advisorMap, openCoinSet, ctx, advisor1hMap, btcRegime, exposure, batchSinks[i], bookContext, prefetchedBars)
        ),
      );
      for (let i = 0; i < batchResults.length; i++) {
        const r = batchResults[i];
        results.push(r.result);
        if (r.result.includes("ENTERED")) entryCount++;
        // Count QUALIFIED signals, not silent pairs (see NO_SIGNAL_RE).
        if (!NO_SIGNAL_RE.test(r.result)) signalCount++;
        // Veto journal: qualified candidate blocked by a gate.
        const vm = r.result.match(/^(\S+): (LONG|SHORT) blocked — (.+)$/);
        if (vm) vetoes.push({ pair: vm[1], side: vm[2], reason: vm[3] });
            const rej = batchSinks[i].rejection;
        if (rej && !r.result.includes("ENTERED")) {
          if (rejections.length < MAX_REJECTION_ROWS_PER_TICK) {
            rejections.push(vm ? { ...rej, veto: vm[3] } : rej);
          }
        }

      }
    }

    // One batched veto-journal write per tick (no-op when nothing blocked).
    // Fails SOFT but never SILENT (2026-10-02): a journal error must not fail
    // the tick, but it must leave a durable trace (see the decision-record
    // note below — the same silence hid a 3-day outage of this discipline).
    if (vetoes.length > 0) {
      await ctx
        .runMutation(api.strategyEngine.logVeto, { vetoes, timestamp: now })
        .catch(async (e: unknown) => {
          await ctx
            .runMutation(api.strategyEngine.logEntryError, {
              pair: "SYSTEM",
              kind: "veto-journal-write",
              message: writeErrorMessage(e),
              timestamp: now,
            })
            .catch(() => {});
        });
    }

    // One batched rejected-signal write per tick (no-op when nothing blocked).
    // Fails SOFT but never SILENT (2026-10-02): the batch is bisected on a
    // rejection, so one malformed row cannot take the tick's whole record with
    // it, and every dropped row is journaled as a side="ERROR" signal row.
    // The old `.catch(() => {})` hid exactly that: an undeclared shadow field
    // (d1StochK) made Convex reject the ENTIRE array, and the decision record
    // vanished without a trace from 2026-09-29 02:03 until this fix.
    if (rejections.length > 0) {
      const outcome = await bisectBatchWrite(rejections, (batch) =>
        ctx.runMutation(api.strategyEngine.logRejections, { rows: batch, timestamp: now }),
      );
      if (outcome.dropped.length > 0) {
        const first = outcome.dropped[0]!;
        await ctx
          .runMutation(api.strategyEngine.logEntryError, {
            pair: "SYSTEM",
            kind: "decision-record-write",
            message: `${outcome.dropped.length}/${rejections.length} rows dropped (first ${first.row.pair}/${first.row.side}): ${first.error}`,
            timestamp: now,
          })
          .catch(() => {});
      }
    }

    // PAPER SCAN STATUS: the tick's own summary, on the panel's paper tile.
    await recordStatus({
      scanned: freshMetrics.length,
      signals: signalCount,
      entries: entryCount,
      blocked: vetoes.length,
    });

    // Release the run-guard lease so the next cron fire can proceed. (On a
    // hard crash mid-tick this is skipped; the lease auto-expires after
    // TICK_LEASE_MS and the following fire steals it.)
    await ctx.runMutation(api.strategyEngine.releaseStrategyTickLock, {}).catch(() => {});
    return {
      status: "ok",
      scanned: freshMetrics.length,
      signals: signalCount,
      entries: entryCount,
      results,
    };
  },
});

/**
 * PUBLIC entry point for the paper tick — the cron and the panel's "Run now"
 * both call this, and it delegates to `strategyTickRun` above.
 *
 * WHY THE WRAPPER (2026-10-21 second pass). The scan summary is written at the
 * END of the body, so a throw before that line left `paperAccount.lastScanResult`
 * showing the PREVIOUS tick as if it were current — the same silent-stale-signal
 * failure the live tick's `TICK FAILED` trace removed. The lease was skipped
 * too, so the next 15-minute fire was lost waiting out the 25-minute expiry.
 * This catches the crash, records the reason where the paper tile reads, frees
 * the lease, and rethrows so the cron/deployment log still shows the failure.
 */
export const strategyTick = action({
  args: { cron: v.optional(v.boolean()) },
  handler: async (
    ctx,
    args,
  ): Promise<{
    status: string;
    scanned: number;
    signals: number;
    entries: number;
    results: string[];
  }> =>
    timedTick(ctx, "layer2-strategy", async () => {
      try {
        return await ctx.runAction(internal.strategyEngine.strategyTickRun, args);
      } catch (e: any) {
        const msg = String(e?.message ?? e).slice(0, 300);
        await ctx
          .runMutation(internal.strategyEngine.recordPaperScanStatus, {
            scanned: 0,
            signals: 0,
            entries: 0,
            blocked: 0,
            note: `TICK FAILED — ${msg}`,
          })
          .catch(() => {});
        await ctx.runMutation(api.strategyEngine.releaseStrategyTickLock, {}).catch(() => {});
        throw e;
      }
    }),
});

// ── Signal Logging Mutation ──

export const logSignal = mutation({
  args: {
    // Optional audit metadata; legacy/manual signal logs remain valid.
    shadowTags: v.optional(v.array(v.string())),
    shadowH4RangePct: v.optional(v.number()),
    shadowH4VolLog2: v.optional(v.number()),
    shadowRsi7: v.optional(v.number()),
    // D1 shadow tags v3 (2026-09-26): declared so the shadowFields spread
    // is not silently stripped (same bug class the insertTrade fix documents).
    d1UpWickPct: v.optional(v.number()),
    d1R5Pct: v.optional(v.number()),
    // Daily StochRSI %K (2026-10-02): same declaration fix as logRejections.
    d1StochK: v.optional(v.number()),
    pair: v.string(),
    side: v.string(),
    entryPrice: v.number(),
    longScore: v.number(),
    shortScore: v.number(),
    reasons: v.array(v.string()),
    blockers: v.array(v.string()),
    emaFast: v.number(),
    emaSlow: v.number(),
    imbalance: v.number(),
    flowBias: v.number(),
    fundingRate: v.number(),
    spreadPct: v.number(),
    atrPct: v.number(),
    entered: v.boolean(),
    timestamp: v.number(),
    // Plumbing-skip label (2026-10-02, flaw 4c): post-signal skips that never
    // reach an entry (session / cap / sizing) are logged with the full vector
    // plus this veto, so gate-pricing labs can finally see them. Optional so
    // every existing entry row stays valid; the column already exists.
    veto: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("strategySignals", args);
  },
});

// ── Exit Resolution: Check SL/TP for all open Layer 2 trades ──
// This runs on a separate 5-min cron so exits are resolved quickly.
// strategyTick (15 min) handles entries; this handles exits.
//
// I/O profile (2026-09): each tick fetches ONLY the live ticker per open pair
// (SL/TP breach check) — no kline history for holding trades. Full-life 15m
// history is fetched once, lazily, only for a pair whose trade actually
// closes, sized to the trade's age (+20 bars slack), so the recorded
// MFE/MAE/timeToMfe/timeToMae cover the trade's ENTIRE life instead of a
// fixed ~30h window (which silently clipped the early-life peaks of long
// holds — measured 24/159 closed trades ran >30h carrying 22.7% of win PnL).

export const resolveLayer2Exits = action({
  args: {},
  handler: async (ctx): Promise<{
    status: string;
    checked: number;
    closed: number;
    results: string[];
  }> => {
    const results: string[] = [];
    let closedCount = 0;

    // Get all open Layer 2 trades (index-scoped read: book=layer2, status=open).
    // The old full-table getLayer2Trades collect() re-read all 400+ paperTrades
    // every 2 minutes — the single biggest driver of the Database I/O meter.
    const openTrades: any[] = await ctx.runQuery(api.paperTrading.getOpenLayer2Trades);

    // Shadow legs (see lib/shadow-book.ts + the schema note on `shadowOpen`).
    // Advanced by THIS tick, which is the whole point: the existing 5-minute
    // cron and the batched universe fetch below are reused, so the shadow book
    // adds no cron job and no extra price request.
    //
    // I/O: the leg set is assembled from data ALREADY IN HAND. A leg on an
    // open trade is the open trade; only a leg that outlived its position
    // needs a fetch, and that set is usually empty. Asking the database for
    // all pending legs instead re-read the open rows the tick had just
    // loaded — ~19 KB of enrichment, 288 times a day (~5.4 MB/day, measured)
    // for nothing.
    const orphanedShadow: any[] = await ctx
      .runQuery(api.paperTrading.getShadowPendingClosedTrades, { book: "layer2" })
      .catch(() => []);
    const shadowTrades: any[] = [
      ...openTrades.filter((t: any) => t.shadowOpen === 1),
      ...orphanedShadow,
    ];

    // A pending leg can outlive every real position, so an empty open book
    // does not mean there is no shadow work to do.
    if (openTrades.length === 0 && shadowTrades.length === 0) {
      return { status: "ok", checked: 0, closed: 0, results: ["No open Layer 2 trades"] };
    }

    // Ensure the Layer 2 account exists before any close can hit closeTrade.
    // strategyTick (entries) does this too, but this exit cron is independent
    // and may be the first to fire on a fresh deployment — without it a close
    // would find no "layer2" account and its P&L would be dropped.
    await ctx.runMutation(api.paperTrading.ensureLayer2Account, {});

    // Fetch current prices for all open pairs. Breach detection (SL/TP) needs
    // only the live ticker — the old code ALSO fetched 120×15m bars for every
    // open pair on every 5-min tick, even when nothing closed (that was the
    // steady-state kline load this restructure removes). Full-life 15m
    // history is fetched lazily, once per pair, only when a trade on that
    // pair actually closes — holding ticks pay for zero kline calls.
    const pairs = [
      ...new Set([...openTrades.map((t: any) => t.coin), ...shadowTrades.map((t: any) => t.coin)]),
    ];
    const priceMap = new Map<string, number>();
    // I/O (2026-09-16): one batched universe request (fetchAllTickers — the
    // same unauthenticated /contract/ticker call marketDataTick uses)
    // replaces the per-pair ticker fetch: N open pairs ≈ N → 1 request per
    // tick (~2,800 MEXC calls/day saved at a steady ~10 open pairs). Pairs
    // missing from the universe response (e.g. non-crypto tokens) fall back
    // to the per-pair fetch, so a batched-fetch failure can never strand an
    // open trade with "no price".
    // Node-runtime relay: MEXC's WAF 403s default-runtime fetches (2026-10-16).
    // The batched read + per-pair fallback live in convex/priceRelay.ts.
    const relayed: Record<string, number> = await ctx.runAction(
      internal.priceRelay.layer2Prices,
      { pairs },
    );
    for (const pair of pairs) {
      const px = relayed[pair];
      if (px && px > 0) priceMap.set(pair, px);
    }

    const now = Date.now();

    // ── Shadow book advance ──
    // Pure state machine, priced off the SAME ticker map the real exits use.
    // A write happens only when a leg banks its first target or resolves, so a
    // trade costs ~2 small patches across its whole life rather than one per
    // tick. Failures are swallowed: a shadow leg must never break a real exit.
    let shadowUpdated = 0;
    for (const trade of shadowTrades) {
      const price = priceMap.get(trade.coin);
      if (!price || price <= 0) continue;
      const prior = { tp1Filled: trade.shadowTp1At != null, bankedR: trade.shadowBankedR ?? 0 };
      const outcome = advanceShadowLive(
        { side: trade.type, entryPrice: trade.entryPrice, slPrice: trade.slPrice, entryTime: trade.entryTime },
        prior,
        price,
        now,
        SCALE_OUT_POLICY,
      );
      if (!outcome.resolved && !outcome.changed) continue;
      try {
        await ctx.runMutation(api.paperTrading.patchShadowState, {
          tradeId: trade._id,
          tp1Filled: outcome.state.tp1Filled,
          bankedR: outcome.state.bankedR,
          resolved: outcome.resolved
            ? {
                at: now,
                reason: outcome.resolved.reason,
                totalR: outcome.resolved.totalR,
                // Preserve the original first-target stamp; only set it when
                // this very tick is what filled it.
                tp1At: outcome.state.tp1Filled && !prior.tp1Filled ? now : trade.shadowTp1At,
              }
            : undefined,
        });
        shadowUpdated++;
      } catch { /* shadow must never break a real exit */ }
    }
    if (shadowUpdated) results.push(`shadow: ${shadowUpdated} leg(s) advanced`);
    const EXIT_SLIP_BPS = 3; // 3 bps exit slippage on SL

    // Full-life 15m history cache, filled lazily ONLY when a trade closes.
    // Deep fetch is sized to the oldest OPEN trade on the pair (+20 bars
    // slack ≈ 5h), so all of that pair's closing trades share one request and
    // the excursion scan always sees back to each trade's entry.
    const deepKlineMap = new Map<string, Kline[]>();
    const deepFetching = new Map<string, Promise<Kline[]>>();

    for (const trade of openTrades) {
      const price = priceMap.get(trade.coin);
      if (!price) {
        results.push(`${trade.coin}: skip (no price)`);
        continue;
      }

      const isLong = trade.type === "LONG";
      const slPrice = trade.slPrice;
      const tpPrice = trade.tpPrice;
      let exitReason: string | null = null;
      let exitPrice = price;

      // Check SL and TP using current price
      if (isLong) {
        if (price <= slPrice) {
          exitReason = "Stop Loss";
          // SL exits get slippage: price moves against you past the SL level
          exitPrice = slPrice * (1 - EXIT_SLIP_BPS / 10_000);
        } else if (tpPrice && price >= tpPrice) {
          exitReason = "Take Profit";
          exitPrice = tpPrice; // TP limit fill — no slippage
        }
      } else {
        if (price >= slPrice) {
          exitReason = "Stop Loss";
          exitPrice = slPrice * (1 + EXIT_SLIP_BPS / 10_000);
        } else if (tpPrice && price <= tpPrice) {
          exitReason = "Take Profit";
          exitPrice = tpPrice;
        }
      }

      if (exitReason) {
        // True excursion profile over the trade's FULL life — bar-based, not
        // a ticker snapshot, and not a fixed ~30h window (long holds ran past
        // it, clipping their early-life peaks). Shared helper
        // (src/lib/exit-telemetry.ts) — the same function leg B uses, so
        // MFE/MAE compare across exit legs. Deep klines are fetched ONCE
        // per pair, only now that a close is actually happening.
        const risk = Math.abs(trade.entryPrice - trade.slPrice);
        let k15 = deepKlineMap.get(trade.coin);
        if (risk > 0 && !k15) {
          let pending = deepFetching.get(trade.coin);
          if (!pending) {
            // Size the fetch to the OLDEST open trade on this pair (+20 bars
            // slack) so every closing trade's full history is present.
            const oldestEntry = Math.min(
              ...openTrades
                .filter((t: any) => t.coin === trade.coin)
                .map((t: any) => t.entryTime),
            );
            const ageBars = Math.max(1, Math.ceil((now - oldestEntry) / 900_000));
            pending = relayKlines(ctx, trade.coin, "15m", ageBars + 20).catch(() => []);
            deepFetching.set(trade.coin, pending);
          }
          k15 = await pending;
          if (k15.length > 0) deepKlineMap.set(trade.coin, k15);
        }
        const excursion =
          risk > 0 && k15 && k15.length > 0
            ? computeExcursion(
                {
                  type: trade.type,
                  entryPrice: trade.entryPrice,
                  slPrice: trade.slPrice,
                  entryTime: trade.entryTime,
                },
                k15,
              )
            : risk > 0
              ? snapshotExcursion(
                  {
                    type: trade.type,
                    entryPrice: trade.entryPrice,
                    slPrice: trade.slPrice,
                    entryTime: trade.entryTime,
                  },
                  price,
                )
              : { mfeR: 0, maeR: 0 };
        const { mfeR, maeR, timeToMfe, timeToMae } = excursion;

        // Calculate PnL with fees (shared leg-A convention — see exit-telemetry).
        const side = isLong ? 1 : -1;
        const notional = trade.entryPrice * trade.sizeCoin;
        const totalFees = closeFeesUsd(
          trade.entryPrice,
          trade.sizeCoin,
          exitReason === "Take Profit",
        );
        const grossPnl = (exitPrice - trade.entryPrice) * trade.sizeCoin * side;
        const pnlUsd = grossPnl - totalFees;
        const marginUsd = notional / (trade.leverage || 50);
        const pnlPercent = (pnlUsd / marginUsd) * 100;

        // Compute realized R
        const move = isLong ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
        const realizedR = risk > 0 ? move / risk : 0;
        const { barsHeld, durationBucket } = holdProfile(trade.entryTime, now);

        // MFE capture ratio: how much of the max favorable move did we capture?
        const mfeCaptureRatio = captureRatio(realizedR, mfeR);

        // Entry slippage: difference between signal price and fill price
        const entrySlippageBps = trade.signalPrice && trade.signalPrice > 0
          ? Math.abs(trade.entryPrice - trade.signalPrice) / trade.entryPrice * 10_000
          : undefined;

        // Tier 5: vol at exit (ATR% at close time)
        let volAtExit: number | undefined;
        try {
          const kExit = await relayKlines(ctx, trade.coin, "15m", 20);
          if (kExit.length >= 14) {
            let atrSum = 0;
            for (let i = kExit.length - 14; i < kExit.length; i++) {
              const prev = kExit[i - 1]?.close ?? kExit[i].open;
              atrSum += Math.max(
                kExit[i].high - kExit[i].low,
                Math.abs(kExit[i].high - prev),
                Math.abs(kExit[i].low - prev),
              );
            }
            volAtExit = +(atrSum / 14 / (kExit[kExit.length - 1]?.close || 1) * 100).toFixed(4);
          }
        } catch { /* optional */ }
        const volAtEntry = trade.volPct ?? undefined;
        const volDelta = volAtEntry != null && volAtExit != null ? +(volAtExit - volAtEntry).toFixed(4) : undefined;

        // Tier 6: BTC/ETH move during trade
        let btcMoveDuringTrade: number | undefined;
        let ethMoveDuringTrade: number | undefined;
        try {
          const tradeHours = Math.max(2, Math.ceil((now - trade.entryTime) / 3_600_000));
          const btcBars = Math.min(tradeHours + 2, 100);
          const btcK = await relayKlines(ctx, "BTC", "1h", btcBars);
          if (btcK.length >= 2) btcMoveDuringTrade = +((btcK[btcK.length - 1].close - btcK[0].close) / btcK[0].close * 100).toFixed(4);
        } catch { /* optional */ }
        try {
          const tradeHours = Math.max(2, Math.ceil((now - trade.entryTime) / 3_600_000));
          const ethBars = Math.min(tradeHours + 2, 100);
          const ethK = await relayKlines(ctx, "ETH", "1h", ethBars);
          if (ethK.length >= 2) ethMoveDuringTrade = +((ethK[ethK.length - 1].close - ethK[0].close) / ethK[0].close * 100).toFixed(4);
        } catch { /* optional */ }

        // Funding cost (8h windows) — shared helper, same convention.
        const fundingCostUsd = fundingCostFor(
          trade.entryPrice,
          trade.sizeCoin,
          trade.entryTime,
          now,
        );

        await ctx.runMutation(api.paperTrading.closeTrade, {
          id: trade._id,
          exitPrice,
          exitTime: now,
          reason: exitReason,
          pnlUsd,
          pnlPercent,
          realizedR,
          barsHeld,
          durationBucket,
          mfeR,
          maeR,
          timeToMfe,
          timeToMae,
          mfeCaptureRatio,
          entrySlippageBps,
          totalFeesUsd: +totalFees.toFixed(6),
          fundingCostUsd: +fundingCostUsd.toFixed(6),
          volAtEntry,
          volAtExit,
          volDelta,
          btcMoveDuringTrade,
          ethMoveDuringTrade,
        });

        // EXECUTION RECORD (Stage 3): stop trigger vs stop fill, liq level and
        // the realized R from the ACTUAL fill. Scheduled, fail-open.
        await scheduleExecRecord(ctx, { kind: "exit", ref: { table: "paperTrades", id: String(trade._id) } });

        closedCount++;
        results.push(`${trade.coin}: CLOSED ${exitReason} @ ${exitPrice.toFixed(4)} (PnL: $${pnlUsd.toFixed(2)}, R: ${realizedR.toFixed(2)}, MFE: ${mfeR.toFixed(1)}R, MAE: ${maeR.toFixed(1)}R)`);
      } else {
        results.push(`${trade.coin}: holding (price: ${price.toFixed(4)}, SL: ${slPrice.toFixed(4)}, TP: ${tpPrice?.toFixed(4) ?? "N/A"})`);
      }
    }

    return {
      status: "ok",
      checked: openTrades.length,
      closed: closedCount,
      results,
    };
  },
});
