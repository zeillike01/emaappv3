/**
 * LAYER 1 — Market Data Engine
 *
 * Fetches live MEXC data and computes fast-moving metrics:
 *   - Order Book Imbalance (20-level depth)
 *   - Trade Flow Bias (5s aggressive buy/sell)
 *   - Spread quality
 *   - ATR(14) volatility
 *   - Candle range
 *   - Funding rate
 *   - 24h volume
 *
 * THE TICK MOVED to ./marketDataNode.ts (2026-10-28): it needs the Node
 * runtime, both because MEXC's WAF 403s the default runtime's fetch (see
 * marketRelay.ts) and because routing ~110 reads per tick through ~110
 * separate relay actions billed both sides of every hop. A Node module may
 * only define actions, so everything DB-facing — the queries, the batched
 * write, the slow-variable cache and the run-guard lease — stays HERE, and
 * the tick calls it exactly as before. Results are still ONE `layer1Ticks`
 * doc per tick; Layer 2 (strategyEngine.ts) reads the newest one.
 *
 * Runs every 15 min via cron (crons.ts -> api.marketDataNode.marketDataTick).
 */

import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
import { tryAcquireLease } from "../lib/strategy-utils";

// ── Queries ──
// Layer 1 single source of truth is the NEWEST layer1Ticks doc (one write per
// tick, all pairs). The old per-pair marketMetrics table is legacy — the cron
// no longer writes there; rows are drained by cleanup:pruneMarketMetrics.

export const getLatestLayer1Tick = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db
      .query("layer1Ticks")
      .withIndex("by_timestamp")
      .order("desc")
      .first();
  },
});

export const getMarketMetrics = query({
  args: { pair: v.string() },
  handler: async (ctx, args) => {
    const tick = await ctx.db
      .query("layer1Ticks")
      .withIndex("by_timestamp")
      .order("desc")
      .first();
    const m = tick?.metrics?.[args.pair];
    if (m) return { pair: args.pair, ...m, fetchedAt: tick.timestamp };
    return null;
  },
});

export const getAllMarketMetrics = query({
  args: {},
  handler: async (ctx) => {
    const tick = await ctx.db
      .query("layer1Ticks")
      .withIndex("by_timestamp")
      .order("desc")
      .first();
    if (!tick) return [];
    return Object.entries(tick.metrics).map(([pair, m]) => ({
      pair,
      ...m,
      fetchedAt: tick.timestamp,
    }));
  },
});

export const getStaleMetrics = query({
  args: { maxAgeMs: v.number() },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - args.maxAgeMs;
    const all = await ctx.db.query("marketMetrics").collect();
    return all.filter((m) => m.fetchedAt < cutoff);
  },
});

/**
 * EXPORT THE L1 SNAPSHOT ARCHIVE for the entry audit (2026-09-11).
 *
 * The entry score is dominated by the ±22-point order-book-imbalance and
 * taker-flow terms. Those inputs only ever exist as live 5-min snapshots, so
 * the entry has always been described as "untestable" — but cleanup.ts keeps
 * layer1Ticks for 60 days (L1_MAX_AGE_MS), so 60 days of the full entry
 * function IS reconstructable. This query is the bridge: it pages the raw
 * ticks out in a COMPACT payload so a lab script can join them to 15m candles
 * and score with the real computeLayer2Signal.
 *
 * Compact shape (keeps the payload ~10x smaller than the raw docs):
 *   rows: [ timestamp, [ [pair, imbalance, flowBias, spreadPct, atrPct,
 *                         candleRangePct, vol24h, fundingRate, fundingValid], ... ] ]
 * fundingValid is 0/1 (Convex numbers) so the caller can apply
 * resolveFundingRate()'s fail-closed rule without a second field.
 *
 * Page with `nextStart` until it returns null. Ascending order so a single
 * pass produces a sorted tick series. Bounded take() keeps every call under
 * the read limit; the lab walks days, not the whole window at once.
 */
export const exportLayer1Ticks = query({
  args: {
    startMs: v.number(),
    endMs: v.number(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 288, 1), 576);
    const docs = await ctx.db
      .query("layer1Ticks")
      .withIndex("by_timestamp", (q) =>
        q.gte("timestamp", args.startMs).lt("timestamp", args.endMs),
      )
      .order("asc")
      .take(limit);
    const rows = docs.map((r) => [
      r.timestamp,
      Object.entries(r.metrics).map(([pair, m]) => {
        const x = m as any;
        return [
          pair,
          x.imbalance,
          x.flowBias,
          x.spreadPct,
          x.atrPct,
          x.candleRangePct,
          x.vol24h,
          x.fundingRate,
          x.fundingValid === true ? 1 : 0,
        ];
      }),
    ]);
    const last = docs.length > 0 ? docs[docs.length - 1].timestamp : null;
    return {
      rows,
      count: docs.length,
      nextStart:
        docs.length === limit && last != null && last + 1 < args.endMs
          ? last + 1
          : null,
    };
  },
});

// ── Mutations ──

/**
 * Legacy (2026-09): one row per pair, called 20× per tick — the big
 * function-call line. Kept for manual/backfill tooling; the cron no longer
 * calls it. The batched path is recordLayer1Tick below.
 */
export const upsertMarketMetrics = mutation({
  args: {
    pair: v.string(),
    spreadPct: v.number(),
    imbalance: v.number(),
    flowBias: v.number(),
    fundingRate: v.number(),
    atrPct: v.number(),
    candleRangePct: v.number(),
    vol24h: v.number(),
    fetchedAt: v.number(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("marketMetrics")
      .withIndex("by_pair", (q) => q.eq("pair", args.pair))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, args);
    } else {
      await ctx.db.insert("marketMetrics", args);
    }
  },
});

/**
 * OI context for an entry (2026-09-09): the pair's newest OI snapshot from
 * the layer1Ticks series and the oldest snapshot within the trailing ~4h
 * window, plus the % change between them. The engine calls this once per
 * actual entry (not per scan) — one indexed read. Null fields when the
 * series doesn't cover the pair yet (first 4h after deploy).
 */
export const getOiContext = query({
  args: { pair: v.string() },
  handler: async (ctx, args) => {
    const now = Date.now();
    const windowStart = now - 4 * 3600 * 1000 - 15 * 60 * 1000; // 4h + slack
    const ticks = await ctx.db
      .query("layer1Ticks")
      .withIndex("by_timestamp", (q) => q.gte("timestamp", windowStart))
      .order("asc")
      .collect();
    let oiNow: number | undefined;
    let oi4hAgo: number | undefined;
    let oi4hAgoAt = 0;
    for (const t of ticks) {
      const oi = t.metrics?.[args.pair]?.oi;
      if (typeof oi !== "number" || oi <= 0) continue;
      if (oi4hAgo === undefined) {
        oi4hAgo = oi;
        oi4hAgoAt = t.timestamp;
      }
      oiNow = oi;
    }
    if (oiNow == null || oi4hAgo == null || oi4hAgo <= 0) {
      return { oiNow: oiNow ?? null, oi4hAgo: null, deltaPct: null };
    }
    const deltaPct = +(((oiNow - oi4hAgo) / oi4hAgo) * 100).toFixed(3);
    // Sanity guards (2026-09-10 audit):
    // 1. Universe OI never moves ±25% in 4h — a bigger delta means a poisoned
    //    row (pre-fix symbol-mangling bug, a fetch hiccup, or a delisting);
    //    log the snapshot but not a nonsense delta.
    // 2. The oldest sample must be ≥3h old, else "4hAgo" is really "a few
    //    minutes ago" and the near-zero delta washes out the series until
    //    real history accumulates.
    const saneDelta = Math.abs(deltaPct) <= 25 && now - oi4hAgoAt >= 3 * 3600 * 1000;
    return {
      oiNow,
      oi4hAgo,
      deltaPct: saneDelta ? deltaPct : null,
    };
  },
});

/**
 * Layer 1 batched write (2026-09): all pairs' metrics in ONE doc per tick.
 * The strategy engine reads the newest doc, so this single insert replaces
 * the old 20-upsert loop (~5.7k writes/day → 288 writes/day).
 */
// Single source of truth for one pair's Layer-1 metrics object — used by the
// recordLayer1Tick args validator below and pinned against the layer1Ticks
// schema by src/lib/__tests__/layer1tick-validator.test.ts. Convex validators
// THROW on undeclared fields, so a field added to the tick writer but not to
// this object would reject EVERY tick write, all pairs at once (P0 caught
// 2026-09-16 — the fix and the regression test landed together).
export const layer1MetricsValidator = v.object({
  spreadPct: v.number(),
  imbalance: v.number(),
  flowBias: v.number(),
  flowValid: v.optional(v.boolean()), // false = empty 5s flow window (see metrics.ts)
  fundingRate: v.number(),
  fundingValid: v.optional(v.boolean()),
  atrPct: v.number(),
  candleRangePct: v.number(),
  vol24h: v.number(),
  oi: v.optional(v.number()), // MEXC holdVol snapshot (contracts)
});

export const recordLayer1Tick = mutation({
  args: {
    timestamp: v.number(),
    metrics: v.record(v.string(), layer1MetricsValidator),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("layer1Ticks", args);
  },
});

// ── Layer 1 slow-variable cache + run-guard lease (2026-09) ──
// Singleton layer1Cache doc (see schema). The tick reads it once and re-fetches
// only stale funding/contract entries, then patches the maps in one write.
// (The run-guard lease used to live here too — see layer1Lock below.)

export const getLayer1Cache = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("layer1Cache").first();
  },
});

/**
 * ONE-SHOT: drop the legacy `depthLadder` blob (2026-10-25).
 *
 * The depth-churn gauge was deleted, and this field was its only writer and
 * its only reader. Nothing writes it any more, but the doc it lives on is
 * still fetched WHOLE by every Layer-1 tick (`getLayer1Cache`), so the stale
 * ladders — ~22 KB of the ~26 KB document, per the lease note below — keep
 * being paid for on every tick. Safe to re-run: no-ops once the field is gone.
 */
export const dropLegacyDepthLadder = internalMutation({
  args: {},
  handler: async (ctx): Promise<string> => {
    const doc: any = await ctx.db.query("layer1Cache").first();
    if (!doc || doc.depthLadder === undefined) return "already clean";
    // `as any`: the field is no longer in the schema, so the generated Patch
    // type rejects it — patching it to undefined is exactly how Convex DELETES
    // an existing field, and the resulting document validates.
    await ctx.db.patch(doc._id, { depthLadder: undefined } as any);
    return "dropped legacy depthLadder";
  },
});

/**
 * Run-guard lease for marketDataTick (the pure rule is in strategy-utils).
 *
 * 2026-09-16 (Database I/O audit): this lease used to be a field ON the
 * layer1Cache singleton, so every acquire/release loaded that entire document
 * — ~26 KB, of which ~22 KB is the 31-pair depth ladder — purely to read or
 * clear ONE number. Both mutations were in the deployment's top-6 Database I/O
 * consumers despite doing nothing but a `first()` read (~450 MB/month
 * combined, the two biggest purely-recurring lines after the tick's own work).
 * The lease now has its own single-field document; `tryAcquireLease` semantics
 * are unchanged, so the lease still guarantees exactly one tick at a time and
 * still auto-expires if a tick crashes mid-run.
 */
export const acquireLayer1TickLock = mutation({
  args: { leaseMs: v.number() },
  handler: async (ctx, args): Promise<{ locked: boolean; reason?: string }> => {
    const doc = await ctx.db.query("layer1Lock").first();
    if (!doc) {
      // First tick ever — create the singleton already holding the lease.
      await ctx.db.insert("layer1Lock", { lockedUntil: Date.now() + args.leaseMs });
      return { locked: true };
    }
    const expiry = tryAcquireLease(doc.lockedUntil, Date.now(), args.leaseMs);
    if (expiry == null) return { locked: false, reason: "in-flight" };
    await ctx.db.patch(doc._id, { lockedUntil: expiry });
    return { locked: true };
  },
});

/** Release the Layer 1 run-guard lease (see acquireLayer1TickLock). */
export const releaseLayer1TickLock = mutation({
  args: {},
  handler: async (ctx) => {
    const doc = await ctx.db.query("layer1Lock").first();
    if (doc) await ctx.db.patch(doc._id, { lockedUntil: 0 });
  },
});

/**
 * Merge freshly fetched slow variables into the singleton cache doc — one
 * write for the whole tick. Only called when a tick actually re-fetched
 * something; maps are merged (spread), never replaced, so concurrent ticks
 * can't drop each other's entries (not that the lease allows concurrency).
 *
 * 2026-09-16 (Database I/O audit): the tick passes BOTH the doc `_id` and the
 * already-merged maps, because it read this singleton earlier in the same run.
 * Passing the id skips this mutation's own `first()` read — the saving is
 * caller-side. The id path requires BOTH sections (see the guard) so a partial
 * call can never drop state; the read-then-merge path is retained for partial
 * callers and the first tick.
 */
export const saveLayer1Cache = mutation({
  args: {
    id: v.optional(v.id("layer1Cache")),
    funding: v.optional(
      v.record(
        v.string(),
        v.object({
          rate: v.number(),
          fetchedAt: v.number(),
          version: v.optional(v.number()),
        }),
      ),
    ),
    contractSize: v.optional(
      v.record(v.string(), v.object({ size: v.number(), fetchedAt: v.number() })),
    ),
  },
  handler: async (ctx, args) => {
    const patch: {
      funding?: Record<string, { rate: number; fetchedAt: number; version?: number }>;
      contractSize?: Record<string, { size: number; fetchedAt: number }>;
    } = {};
    if (args.funding) patch.funding = args.funding;
    if (args.contractSize) patch.contractSize = args.contractSize;

    // Fast path: caller already read the singleton earlier in the same run and
    // passes the FULL merged maps. Measured 2026-09-17: the saving is entirely
    // caller-side — passing `id` skips the mutation's own `first()` read, so
    // this mutation meters ONE 29 KB read instead of two (58.5 KB → 29.3 KB
    // per tick). replace() vs patch() meter IDENTICALLY here (both load the
    // stored doc to version the write — verified on live logs), so this uses
    // patch(): same bytes, and it can never delete a section a caller failed
    // to pass. GUARD: the id path only runs when BOTH sections arrived;
    // a partial call falls through to the read-merge path below, so a future
    // caller can never wipe funding/contract state by omission.

    if (args.id && args.funding !== undefined && args.contractSize !== undefined) {
      // Both sections arrived → the maps ARE the full document state;
      // patch verbatim (same metered bytes as replace, cannot delete a field).
      if (patch.funding || patch.contractSize) {
        await ctx.db.patch(args.id, patch);
      }
      return;
    }

    const doc = await ctx.db.query("layer1Cache").first();
    if (doc) {
      const merged: typeof patch = {};
      if (patch.funding) merged.funding = { ...doc.funding, ...patch.funding };
      if (patch.contractSize) merged.contractSize = { ...doc.contractSize, ...patch.contractSize };
      if (merged.funding || merged.contractSize) {
        await ctx.db.patch(doc._id, merged);
      }
    } else {
      await ctx.db.insert("layer1Cache", patch);
    }
  },
});
