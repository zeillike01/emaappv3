/**
 * H4 SHADOW CACHE (2026-09-23) — bar-guarded per-pair 4h shadow numbers.
 *
 * The shadow tags need the newest CLOSED 4h bar's range % and volume vs its
 * prior-20 median. That value only changes when a 4h bar closes (6×/day), so
 * fetching it per pair per tick would be ~1,900 wasted MEXC requests/day.
 * This is the btcRegimeCache pattern generalized per pair:
 *
 *   1. Caller asks via `getH4ShadowCached(ctx, pair)`.
 *   2. Cached row whose `barOpenTime` is the newest CLOSED 4h bar → hit.
 *      The reading is a pure function of the closed 4h series, identical for
 *      every tick inside a 4h bucket → hit equals fetch, byte for byte.
 *   3. Miss/stale → one 4h fetch (21 bars), compute, best-effort store.
 *      A write failure is swallowed: worst case refetch next tick, never a
 *      changed tag.
 *
 * Cost ceiling: one 4h fetch per pair per 4h bar ≈ 32 pairs × 6/day = ~192
 * fetches/day TOTAL (≈ 0.13 req/min), shared across BOTH books. Tags are
 * record-only; a failed fetch leaves tags off for that bar (fail-open), the
 * journal treats missing as "no reading", never as zero.
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
import { relayKlines } from "./marketFetch";
import { h4ShadowFromKlines, type H4Shadow } from "../lib/h4-shadow";

const H4_BARS = 24; // 20-bar median + signal bar + margin
const H4_TF_MS = 4 * 60 * 60 * 1000;
const H4_BUCKETS = 48; // 4h buckets × 48 = 8 days of history

/** Valid while `barOpenTime` is the newest CLOSED 4h bar relative to `now`. */
export function h4CacheValid(barOpenTime: number, now: number): boolean {
  const newestClosed = Math.floor(now / H4_TF_MS) * H4_TF_MS - H4_TF_MS;
  return barOpenTime >= newestClosed;
}

export const getH4Shadow = query({
  args: { pair: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("h4ShadowCache")
      .withIndex("by_pair", (q) => q.eq("pair", args.pair))
      .order("desc")
      .take(1)
      .then((rows: any[]) => rows[0] ?? null);
  },
});

export const putH4Shadow = mutation({
  args: {
    pair: v.string(),
    barOpenTime: v.number(),
    rangePct: v.number(),
    volLog2: v.number(),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("h4ShadowCache", { ...args, fetchedAt: Date.now() });
  },
});

/** One call per entry engine: cached reading or one fetch + best-effort store. */
export async function getH4ShadowCached(ctx: any, pair: string): Promise<H4Shadow | null> {
  const now = Date.now();
  const cached: any = await ctx
    .runQuery(api.h4ShadowCache.getH4Shadow, { pair })
    .catch(() => null);
  if (cached && h4CacheValid(cached.barOpenTime, now)) {
    return { barOpenTime: cached.barOpenTime, rangePct: cached.rangePct, volLog2: cached.volLog2 };
  }
  try {
    const klines = await relayKlines(ctx, pair, "4h", H4_BARS);
    const shadow = h4ShadowFromKlines(klines, Date.now());
    if (!shadow) return null;
    // Fire-and-forget store; retention handled by a cleanup prune (8 days).
    void ctx
      .runMutation(api.h4ShadowCache.putH4Shadow, {
        pair,
        barOpenTime: shadow.barOpenTime,
        rangePct: shadow.rangePct,
        volLog2: shadow.volLog2,
      })
      .catch(() => {});
    return shadow;
  } catch {
    return null;
  }
}
