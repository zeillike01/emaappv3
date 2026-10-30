/**
 * HTF (1h/4h) EMA CACHE — bar-guarded. Cron/I-O optimisation, 2026-09-16.
 *
 * WHY THIS EXISTS
 * Both books' HTF trend gate depends ONLY on the newest CLOSED bar of its
 * timeframe — yet each engine re-fetched the full series per pair on every
 * 15m tick. At 31 pairs × 96 ticks that is 2,976 requests/day PER BOOK (240
 * bars each, so ~714k bars/day) for values that only change 6×/day on 4h and
 * 24×/day on 1h. That was the largest avoidable MEXC load in the cron grid
 * (~170k requests/month across both books) and it grew with every universe
 * add (25 → 31 pairs on 2026-09-15/16).
 *
 * THE CONTRACT (semantics preserved exactly)
 *  1. Caller computes `barOpenTime` of the newest CLOSED bar at decision time
 *     (`newestClosedBarOpen`) and reads the cache.
 *  2. Hit (cached bar >= expected) → use it. The value is deterministic from
 *     that bar, so this is identical to having fetched it.
 *  3. Miss / stale / read error → fetch exactly the pre-cache way, then
 *     `putHtf` the result. The verdict comes from the SAME shared helper
 *     (htfVerdictOf / proxy's own comparison), so a hit and a fetch can never
 *     disagree.
 * Worst case therefore equals the old behavior: at most one fetch per pair
 * per HTF bar, never a changed gate verdict.
 *
 * `period` is part of the match: a book configured with a different EMA period
 * simply misses and refetches (last writer wins) — again, old behavior, not a
 * wrong verdict.
 */
import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

/** Newest CLOSED bar's openTime for a timeframe, clock-derived and
 *  bar-aligned: a bar opening at t closes at t + tfMs, so the newest closed
 *  bar is the one that opened one full timeframe before the current bucket. */
export function newestClosedBarOpen(tfMs: number, now: number): number {
  return Math.floor(now / tfMs) * tfMs - tfMs;
}

/** Read the cached HTF values for (coin, tf, period). Null = miss. */
export const getHtf = query({
  args: { coin: v.string(), tf: v.string(), period: v.number() },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("htfCache")
      .withIndex("by_coin", (q) => q.eq("coin", args.coin))
      .first();
    if (!doc || doc.tf !== args.tf || doc.period !== args.period) return null;
    return { barOpenTime: doc.barOpenTime, ema: doc.ema, close: doc.close };
  },
});

/** Upsert the HTF values a fetch just produced (one doc per coin). */
export const putHtf = mutation({
  args: {
    coin: v.string(),
    tf: v.string(),
    period: v.number(),
    barOpenTime: v.number(),
    ema: v.number(),
    close: v.number(),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("htfCache")
      .withIndex("by_coin", (q) => q.eq("coin", args.coin))
      .first();
    const fields = {
      tf: args.tf,
      period: args.period,
      barOpenTime: args.barOpenTime,
      ema: args.ema,
      close: args.close,
      fetchedAt: Date.now(),
    };
    if (doc) await ctx.db.patch(doc._id, fields);
    else await ctx.db.insert("htfCache", { coin: args.coin, ...fields });
  },
});
