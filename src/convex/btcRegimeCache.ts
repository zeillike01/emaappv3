/**
 * BTC 4h REGIME VERDICT CACHE — bar-guarded. Cron/I-O optimisation, 2026-09-16.
 *
 * WHY THIS EXISTS
 * The layer2, proxy and live entry gates all apply the same pre-registered
 * rule (btc-regime.ts): block LONG while BTC's macro regime is chop, SHORT
 * while it is up, plus layer2's DOWN-BLOCK. All three computed that verdict
 * with `btcRegimeFromKlines(await relayKlines(ctx, "BTC", "4h", 240))` — ONCE PER
 * TICK, i.e. 3 books × 96 ticks/day = ~288 MEXC requests/day for a value that
 * only changes when a 4h bar closes (6×/day). ~186 requests/day were pure
 * waste, and it scaled with each universe add. This is the same pattern the
 * htfCache module already uses for the per-pair HTF gate.
 *
 * THE CONTRACT (semantics preserved exactly)
 *  1. Caller asks for the current verdict via `getBtcRegimeCached(ctx)`.
 *  2. Valid cached entry (its bar is the newest CLOSED 4h bar) → returned.
 *     The verdict is a pure function of the closed 4h series, and that series
 *     is identical for every tick inside a 4h bucket, so a hit equals what a
 *     fetch would have produced — byte for byte (same 240 bars, same
 *     `btcRegimeFromKlines`, same `emaSeeded`).
 *  3. Miss / stale / read error → fetch exactly the pre-cache way, compute
 *     with the SAME shared helper, then best-effort store. A write failure is
 *     swallowed: the cheapest outcome is to refetch next tick, never to
 *     change a verdict.
 * Worst case therefore equals the old behavior: at most one fetch per book
 * per 4h bar, never a changed gate verdict. Fail-open is preserved end to end
 * — a failed fetch returns undefined and the caller allows the trade, exactly
 * as before.
 */
import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
import { relayKlines } from "./marketFetch";
import {
  BTC_REGIME_TF_MS,
  btcRegimeCacheValid,
  btcRegimeContext,
  btcRegimeRuns,
  padFormingBar,
  type BtcRegime,
  type BtcRegimeContext,
  type BtcRegimeRun,
} from "../lib/btc-regime";

/** Bars fetched for the verdict — every caller used 240 (verified 2026-09-16),
 *  so the cached value is bit-comparable to any of them. */
const BTC_REGIME_BARS = 240;

/** Read the cached verdict for the newest CLOSED 4h bar. Null = miss. */
export const getBtcRegime = query({
  args: {},
  handler: async (ctx) => {
    const doc = await ctx.db.query("btcRegimeCache").first();
    if (!doc) return null;
    return {
      barOpenTime: doc.barOpenTime,
      ema: doc.ema,
      slopePct: doc.slopePct,
      regime: doc.regime,
      // Record-only fine-tune axes (2026-10-28); absent on pre-existing docs.
      runBars: doc.runBars,
      slopeDeltaPct: doc.slopeDeltaPct,
      // Run log for the card's strip; [] on docs written before 2026-10-28.
      recentRuns: doc.recentRuns ?? [],
    };
  },
});

/** Upsert the verdict a fetch just produced (singleton doc). */
export const putBtcRegime = mutation({
  args: {
    barOpenTime: v.number(),
    ema: v.number(),
    slopePct: v.number(),
    regime: v.string(),
    runBars: v.optional(v.number()),
    slopeDeltaPct: v.optional(v.number()),
    // Omitted by callers that did not compute a log — an absent value must
    // leave the stored runs untouched rather than blank the strip.
    recentRuns: v.optional(
      v.array(
        v.object({
          regime: v.string(),
          startedAt: v.number(),
          bars: v.number(),
          slopePct: v.number(),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const doc = await ctx.db.query("btcRegimeCache").first();
    const fields = { ...args, fetchedAt: Date.now() };
    if (doc) await ctx.db.patch(doc._id, fields);
    else await ctx.db.insert("btcRegimeCache", fields);
  },
});

/**
 * The one call the three entry engines make: cached verdict when the cache is
 * current for the newest CLOSED 4h bar, otherwise the exact pre-cache fetch
 * (240×4h bars → btcRegimeFromKlines) plus a best-effort store. Returns
 * undefined on any failure so callers keep their fail-open semantics.
 */
export async function getBtcRegimeCached(ctx: any): Promise<BtcRegimeContext | undefined> {
  const now = Date.now();
  const cached: any = await ctx
    .runQuery(api.btcRegimeCache.getBtcRegime, {})
    .catch(() => null);
  if (cached && btcRegimeCacheValid(cached.barOpenTime, now, BTC_REGIME_TF_MS)) {
    return {
      ema: cached.ema,
      slopePct: cached.slopePct,
      regime: cached.regime as BtcRegime["regime"],
      runBars: typeof cached.runBars === "number" ? cached.runBars : null,
      slopeDeltaPct: typeof cached.slopeDeltaPct === "number" ? cached.slopeDeltaPct : null,
    };
  }

  let regime: BtcRegimeContext | undefined;
  let runs: BtcRegimeRun[] = [];
  try {
    // padFormingBar is REQUIRED (2026-09-16): fetchKlines strips the forming
    // candle, so without it the verdict read the bar BEFORE the newest closed
    // one — 4h stale, and out of step with the labs that produced the wired
    // blocked-cohort stats (they pad via `slice(0, i + 2)`). With it, this
    // fetch classifies the newest closed bar, which is also what the cache key
    // below claims the stored verdict is for.
    const series = padFormingBar(await relayKlines(ctx, "BTC", "4h", BTC_REGIME_BARS));
    regime = btcRegimeContext(series);
    // Same series, same thresholds: the strip's newest segment is this verdict.
    if (regime) runs = btcRegimeRuns(series);
  } catch {
    regime = undefined;
  }
  if (regime) {
    // Store keyed on the newest CLOSED 4h bar at fetch time — the same value
    // the validity rule derives, so the next tick in this bucket hits.
    const newestClosedBar = Math.floor(now / BTC_REGIME_TF_MS) * BTC_REGIME_TF_MS - BTC_REGIME_TF_MS;
    await ctx
      .runMutation(api.btcRegimeCache.putBtcRegime, {
        barOpenTime: newestClosedBar,
        ema: regime.ema,
        slopePct: regime.slopePct,
        regime: regime.regime,
        ...(regime.runBars != null ? { runBars: regime.runBars } : {}),
        ...(regime.slopeDeltaPct != null ? { slopeDeltaPct: regime.slopeDeltaPct } : {}),
        ...(runs.length ? { recentRuns: runs } : {}),
      })
      .catch(() => {});
  }
  return regime;
}

/**
 * ONE-TIME / REPAIR BACKFILL for the run log (2026-10-28).
 *
 * `getBtcRegimeCached` only writes a log when the cache MISSES, so a fresh
 * cache would leave the strip empty for up to one 4h bar. This replays the same
 * 240-bar fetch and stores the log against the current verdict (byte-identical
 * values — the verdict is a pure function of the closed series). Safe to re-run:
 * it only rewrites the doc the cache already holds.
 */
export const backfillBtcRegimeRuns = action({
  args: {},
  handler: async (ctx): Promise<{ runs: number; label: string; barOpenTime: number }> => {
    const now = Date.now();
    const series = padFormingBar(await relayKlines(ctx, "BTC", "4h", BTC_REGIME_BARS));
    const regime = btcRegimeContext(series);
    if (!regime) throw new Error("insufficient BTC 4h bars for a regime verdict");
    const runs = btcRegimeRuns(series);
    const barOpenTime =
      Math.floor(now / BTC_REGIME_TF_MS) * BTC_REGIME_TF_MS - BTC_REGIME_TF_MS;
    await ctx.runMutation(api.btcRegimeCache.putBtcRegime, {
      barOpenTime,
      ema: regime.ema,
      slopePct: regime.slopePct,
      regime: regime.regime,
      ...(regime.runBars != null ? { runBars: regime.runBars } : {}),
      ...(regime.slopeDeltaPct != null ? { slopeDeltaPct: regime.slopeDeltaPct } : {}),
      recentRuns: runs,
    });
    return { runs: runs.length, label: regime.regime, barOpenTime };
  },
});
