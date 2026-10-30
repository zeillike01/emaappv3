/**
 * D1 SHADOW CACHE v3 (2026-09-26) — bar-guarded per-pair daily readings for
 * the two surviving family-sweep tags (src/lib/d1-shadow.ts).
 *
 * Same pattern as h4ShadowCache at daily granularity: the reading only
 * changes when a daily bar closes (1×/day), so it is computed lazily at
 * most once per pair per UTC day and shared by BOTH books. Cost ceiling:
 * ~30 fetches/day total. A failed fetch leaves the tags off (fail-open).
 */

import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
import { relayKlines } from "./marketFetch";
import { d1ReadingFromKlines, type D1Reading } from "../lib/d1-shadow";

const D1_BARS = 55;
const D1_TF_MS = 24 * 60 * 60 * 1000;

/** Valid while `barOpenTime` is the newest CLOSED 1d bar relative to `now`. */
export function d1CacheValid(barOpenTime: number, now: number): boolean {
  const newestClosed = Math.floor(now / D1_TF_MS) * D1_TF_MS - D1_TF_MS;
  return barOpenTime >= newestClosed;
}

export const getD1Shadow = query({
  args: { pair: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("d1ShadowCache")
      .withIndex("by_pair", (q) => q.eq("pair", args.pair))
      .order("desc")
      .take(1)
      .then((rows: any[]) => rows[0] ?? null);
  },
});

export const putD1Shadow = mutation({
  args: {
    pair: v.string(),
    barOpenTime: v.number(),
    upWickPct: v.number(),
    r5Pct: v.number(),
    highSweep: v.boolean(),
    lowReclaim: v.boolean(),
    dStochK: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("d1ShadowCache", { ...args, fetchedAt: Date.now() });
  },
});

/** One call per entry engine: cached reading or one fetch + best-effort store. */
export async function getD1ShadowCached(ctx: any, pair: string): Promise<D1Reading | null> {
  const now = Date.now();
  const cached: any = await ctx
    .runQuery(api.d1ShadowCache.getD1Shadow, { pair })
    .catch(() => null);
  if (cached && d1CacheValid(cached.barOpenTime, now) && cached.upWickPct != null) {
    return {
      barOpenTime: cached.barOpenTime,
      upWickPct: cached.upWickPct,
      r5Pct: cached.r5Pct,
      highSweep: !!cached.highSweep,
      lowReclaim: !!cached.lowReclaim,
      // Rows written before 2026-09-28 have no dStochK — null (fail-open).
      dStochK: typeof cached.dStochK === "number" ? cached.dStochK : null,
    };
  }
  try {
    const klines = await relayKlines(ctx, pair, "1d", D1_BARS);
    const reading = d1ReadingFromKlines(klines, Date.now());
    if (!reading) return null;
    // Fire-and-forget store; retention handled by the daily prune (8 days).
    void ctx
      .runMutation(api.d1ShadowCache.putD1Shadow, {
        pair,
        barOpenTime: reading.barOpenTime,
        upWickPct: reading.upWickPct,
        r5Pct: reading.r5Pct,
        highSweep: reading.highSweep,
        lowReclaim: reading.lowReclaim,
        ...(reading.dStochK != null ? { dStochK: reading.dStochK } : {}),
      })
      .catch(() => {});
    return reading;
  } catch {
    return null;
  }
}
