/**
 * HTF ADVISOR — 4H divergence / volume-exhaustion layer (2026-09-08).
 *
 * Feasibility: yes — this is the same data contract the strategy engine
 * already trusts (MEXC 4H klines, one fetch per pair) but evaluated on the
 * HIGHER timeframe so it sees the macro structure the 15m entry cannot.
 * The advisor runs on its own cadence and writes ONE batched advisorTicks
 * doc (mirrors layer1Ticks), so the 15-min strategy tick pays ZERO extra
 * MEXC calls to consult it.
 *
 * Flow:
 *   crons "advisor-htf-tick" (4H bar-aligned, 1 min after each 4H close) →
 *     advisorTick (this action)
 *     → skip guard: a run within the last 30 min is a no-op (4H inputs only
 *       change at bar closes — 3 of 4 hourly runs would recompute identical
 *       results, so the cron is aligned to the 4H close instead: 6 runs/day
 *       instead of 24, i.e. 4x fewer MEXC kline fetches and doc writes)
 *   → relayKlines(ctx, pair, interval, 400) per tracked pair (ADVISOR_PAIRS = the
 *     LAYER1 pairs + BTC). COST RE-MEASURED 2026-09-16 at 32 pairs: the 1H run
 *     is 32 klines × 24/day = 768/day (~23.0k/month) and the 4H run is
 *     (32 + 1 BTC-1H) × 6/day = 198/day (~5.9k/month) → ~29k MEXC calls/month
 *     while the 1H layer is enabled. BTC is the regime leader, scored so the next bleed
 *     gets a divergence/exhaustion read on the leader too) + ONE extra BTC
 *     1H fetch per run for the live regime label (btcRegime on the BTC row)
 *     → evaluateAdvisor()  (pure logic, src/lib/htf-advisor.ts)
 *     → recordAdvisorTick (one batched doc) + prune old rows; skipped when
 *       no pair produced data (a bad tick must not clobber a good doc)
 *   strategyEngine.strategyTick reads the newest doc once per run and vetoes
 *   a side when advisorVotes >= advisorVetoThreshold (fail-open when missing
 *   OR when the doc is older than ADVISOR_MAX_AGE_MS in the engine).
 *
 * Veto policy lives in htf-advisor.ts (threshold 2 = confluence: RSI + a
 * volume line, or two exhaustion tells). Paper defaults the advisor ON via
 * strategyEngine.getConfig; live stays OFF until enabled from the panel.
 */

import { v } from "convex/values";
import { action, mutation, query } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { LAYER1_PAIRS } from "../lib/tracked-pairs";
import { relayKlines } from "./marketFetch";
import {
  evaluateAdvisor,
  ADVISOR_MACD_DEFAULTS,
  ADVISOR_SMARTVOL_DEFAULTS,
  ADVISOR_RSIDIV_DEFAULTS,
  type AdvisorRsiDivSource,
  ADVISOR_STOCHRSI_DEFAULTS,
  type AdvisorPairState,
} from "../lib/htf-advisor";

const ADVISOR_4H_BARS = 400; // ~66 days — enough for pivots, RSI, VWAP, profile
const TICK_MAX_AGE_MS = 48 * 60 * 60 * 1000; // keep advisor ticks < 48h (pruned on insert)

// BTC advisor history (chart data): backfilled ONCE over ~90 days of 4H bars,
// then kept current by the tick (one row per 4H close). The chart reads this
// table — it is never touched by the frontend's on-demand 1H kline fetch.
const HISTORY_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // keep ~90 days of readings
const BACKFILL_4H_BARS = 600; // ~100 days — enough for the 90-day window + warm-up

// Advisor-scored universe: the LAYER1 entry pairs PLUS BTC — 32 at the
// 2026-09-16 universe (31 LAYER1 + BTC), not the 20 this comment used to say.
// BTC is NOT in
// the entry universe (LAYER1_PAIRS) on purpose — it is the regime LEADER, and
// 2026-09-07/08 showed it rolling over ~8h before the alt book bled. The
// advisor now runs its full divergence/exhaustion detector on BTC's 4H klines
// so the next bleed gets a read on the leader, not just the followers. The
// engine can then veto alt entries off BTC's verdict (regime layer) without
// BTC itself ever taking trades.
export const ADVISOR_PAIRS: string[] = [...LAYER1_PAIRS, "BTC"];

/**
 * BTC 1H regime classification — IDENTICAL math to paperTrading's
 * btcTrendAtEntry enrichment (percentile of the 1H EMA20 slope: >p67 = up,
 * <p33 = down, else chop) so the label the frontend shows matches the label
 * mining already stores per trade. One 1H kline fetch per advisor tick (6/day)
 * — batched into the same advisorTicks doc, so clients pay zero extra I/O.
 */
function btcRegimeOf(k1h: { close: number }[]): {
  btcRegime: "up" | "down" | "chop";
  btcChange1h: number;
} {
  const closes = k1h.map((k) => k.close);
  const kFactor = 2 / 21;
  let ema = closes[0];
  const slopes: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prevEma = ema;
    ema = closes[i] * kFactor + ema * (1 - kFactor);
    if (prevEma > 0) slopes.push((ema - prevEma) / prevEma);
  }
  let btcRegime: "up" | "down" | "chop" = "chop";
  if (slopes.length >= 5) {
    const sorted = [...slopes].sort((a, b) => a - b);
    const p33 = sorted[Math.floor(sorted.length * 0.33)];
    const p67 = sorted[Math.floor(sorted.length * 0.67)];
    const currentSlope = slopes[slopes.length - 1];
    btcRegime = currentSlope > p67 ? "up" : currentSlope < p33 ? "down" : "chop";
  }
  const btcChange1h =
    closes.length >= 2
      ? ((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100
      : 0;
  return { btcRegime, btcChange1h };
}

/**
 * Per-bar 1H regime series for the chart — the SAME math as btcRegimeOf /
 * paperTrading's btcTrendAtEntry, applied to every closed 1H bar instead of
 * just the newest one. Each bar's slope is classified against the percentiles
 * of the slopes that preceded it (no look-ahead), so the chart's regime
 * coloring is exactly what the engine would have labeled at that time.
 */
function btcRegimeSeries(k1h: { close: number }[]): ("up" | "down" | "chop")[] {
  const closes = k1h.map((k) => k.close);
  const kFactor = 2 / 21;
  let ema = closes[0];
  const regimes: ("up" | "down" | "chop")[] = new Array(closes.length).fill("chop");
  const sorted: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const prevEma = ema;
    ema = closes[i] * kFactor + ema * (1 - kFactor);
    if (prevEma <= 0) continue;
    const slope = (ema - prevEma) / prevEma;
    // Insertion-sort the slope so the rolling percentile scan is O(n log n)
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < slope) lo = mid + 1;
      else hi = mid;
    }
    sorted.splice(lo, 0, slope);
    // Same 5-slope warmup as btcRegimeOf / the mining enrichment, so the
    // chart's labels can never disagree with the engine's live label.
    if (sorted.length >= 5) {
      const p33 = sorted[Math.floor(sorted.length * 0.33)];
      const p67 = sorted[Math.floor(sorted.length * 0.67)];
      regimes[i] = slope > p67 ? "up" : slope < p33 ? "down" : "chop";
    }
  }
  return regimes;
}

/**
 * Map a stored strategyConfig row (or null) to the advisor knobs, with the
 * same defaults advisorTick ships. Shared by the live tick, the one-time
 * BTC history backfill, AND the offline labs (run-advisor-latch-lab.ts) so
 * every caller replays the IDENTICAL detector config — a lab that built its
 * own knob map could silently measure a different detector than the one the
 * book trades.
 */
export function advisorConfigFrom(config: any) {
  const vetoThreshold =
    typeof config?.advisorVetoThreshold === "number" ? config.advisorVetoThreshold : 2;
  return {
    advisorVetoThreshold: vetoThreshold,
    advisorLongThreshold:
      typeof config?.advisorLongThreshold === "number"
        ? config.advisorLongThreshold
        : vetoThreshold,
    advisorShortThreshold:
      typeof config?.advisorShortThreshold === "number"
        ? config.advisorShortThreshold
        : vetoThreshold,
    // 4H age default 6 → 4 (2026-09-12, wired): see DEFAULT_CONFIG in
    // layer2-signal.ts for the three-window evidence.
    advisorDivergenceAgeBars:
      typeof config?.advisorDivergenceAgeBars === "number"
        ? config.advisorDivergenceAgeBars
        : 4,
    advisorVwapExtremePct:
      typeof config?.advisorVwapExtremePct === "number"
        ? config.advisorVwapExtremePct
        : 3,
    advisorRsiExtreme:
      typeof config?.advisorRsiExtreme === "number"
        ? config.advisorRsiExtreme
        : 70,
    // StochRSI (2026-09-11): enabled by default with classic 14/14/3/3 —
    // the book's sweet spot is applied via its config row.
    advisorStochRsiEnabled:
      typeof config?.advisorStochRsiEnabled === "boolean"
        ? config.advisorStochRsiEnabled
        : true,
    advisorStochRsiRsiPeriod:
      typeof config?.advisorStochRsiRsiPeriod === "number"
        ? config.advisorStochRsiRsiPeriod
        : ADVISOR_STOCHRSI_DEFAULTS.rsiPeriod,
    advisorStochRsiStochPeriod:
      typeof config?.advisorStochRsiStochPeriod === "number"
        ? config.advisorStochRsiStochPeriod
        : ADVISOR_STOCHRSI_DEFAULTS.stochPeriod,
    advisorStochRsiKSmooth:
      typeof config?.advisorStochRsiKSmooth === "number"
        ? config.advisorStochRsiKSmooth
        : ADVISOR_STOCHRSI_DEFAULTS.kSmooth,
    advisorStochRsiDSmooth:
      typeof config?.advisorStochRsiDSmooth === "number"
        ? config.advisorStochRsiDSmooth
        : ADVISOR_STOCHRSI_DEFAULTS.dSmooth,
    advisorStochRsiUseD:
      typeof config?.advisorStochRsiUseD === "boolean"
        ? config.advisorStochRsiUseD
        : ADVISOR_STOCHRSI_DEFAULTS.useD,
    advisorStrongWeight:
      typeof config?.advisorStrongWeight === "number"
        ? config.advisorStrongWeight
        : 2,
    advisorWeakWeight:
      typeof config?.advisorWeakWeight === "number"
        ? config.advisorWeakWeight
        : 0.5,
    // Per-family switches (2026-10-23): one panel button per vote family.
    // Unset = ON, so a row written before these knobs existed resolves to the
    // shipped detector unchanged. Forwarded to BOTH ticks (4H and 1H).
    advisorMomDivEnabled:
      typeof config?.advisorMomDivEnabled === "boolean"
        ? config.advisorMomDivEnabled
        : true,
    advisorObvEnabled:
      typeof config?.advisorObvEnabled === "boolean"
        ? config.advisorObvEnabled
        : true,
    advisorAdEnabled:
      typeof config?.advisorAdEnabled === "boolean"
        ? config.advisorAdEnabled
        : true,
    advisorCmfEnabled:
      typeof config?.advisorCmfEnabled === "boolean"
        ? config.advisorCmfEnabled
        : true,
    advisorVwapEnabled:
      typeof config?.advisorVwapEnabled === "boolean"
        ? config.advisorVwapEnabled
        : true,
    advisorThinZoneEnabled:
      typeof config?.advisorThinZoneEnabled === "boolean"
        ? config.advisorThinZoneEnabled
        : true,
    // MACD family (2026-09-10): enabled + normal weight (1) by default —
    // the lab's measured best integration for the 6/14/10 proposal.
    advisorMacdEnabled:
      typeof config?.advisorMacdEnabled === "boolean"
        ? config.advisorMacdEnabled
        : true,
    advisorMacdWeight:
      typeof config?.advisorMacdWeight === "number"
        ? config.advisorMacdWeight
        : 1,
    // 1H-only MACD weight (2026-09-12): unset = share advisorMacdWeight.
    // Only the hourly advisorTick consumes this — the weight is baked into
    // the stored vote counts at tick time, so the engine needs no re-read.
    advisor1hMacdWeight:
      typeof config?.advisor1hMacdWeight === "number"
        ? config.advisor1hMacdWeight
        : config?.advisorMacdWeight,
    // Smart Vol MACD family (2026-09-13, user's Pine indicator): OFF by
    // default — the sweep could not beat the shipped FIXED anchor, so the
    // shipped stack must be unchanged until the user flips the weight up.
    advisorSmartVolEnabled:
      typeof config?.advisorSmartVolEnabled === "boolean"
        ? config.advisorSmartVolEnabled
        : false,
    advisorSmartVolWeight:
      typeof config?.advisorSmartVolWeight === "number"
        ? config.advisorSmartVolWeight
        : 0,
    advisorSmartVolFast:
      typeof config?.advisorSmartVolFast === "number"
        ? config.advisorSmartVolFast
        : ADVISOR_SMARTVOL_DEFAULTS.fast,
    advisorSmartVolSlow:
      typeof config?.advisorSmartVolSlow === "number"
        ? config.advisorSmartVolSlow
        : ADVISOR_SMARTVOL_DEFAULTS.slow,
    advisorSmartVolSignal:
      typeof config?.advisorSmartVolSignal === "number"
        ? config.advisorSmartVolSignal
        : ADVISOR_SMARTVOL_DEFAULTS.signal,
    // 1H isolation for the SmartVol family (2026-09-13): unset = OFF on the
    // hourly layer. The lab tested the family on the 4H advisor ONLY — the
    // 1H branch must read its own weight, never inherit the shared one.
    advisor1hSmartVolWeight:
      typeof config?.advisor1hSmartVolWeight === "number"
        ? config.advisor1hSmartVolWeight
        : 0,
    // RSI-Div differential family (2026-09-13): defaults per the lab — 5/14
    // (Pine), weight 0 = OFF, 1H isolation unset = 0 (never inherit the 4H
    // weight; the lab tested 4H only). Enabled defaults TRUE when unset:
    // the WEIGHT is the master switch (arm condition needs weight > 0), so
    // the panel knob "0 = off, 1 = arm" is the whole UX. The boolean stays
    // as an explicit kill-switch (set false to force-off regardless of
    // weight) and matches the SmartVol knob's contract.
    advisorRsiDivEnabled:
      typeof config?.advisorRsiDivEnabled === "boolean"
        ? config.advisorRsiDivEnabled
        : true,
    advisorRsiDivWeight:
      typeof config?.advisorRsiDivWeight === "number"
        ? config.advisorRsiDivWeight
        : 0,
    advisorRsiDivFast:
      typeof config?.advisorRsiDivFast === "number"
        ? config.advisorRsiDivFast
        : ADVISOR_RSIDIV_DEFAULTS.fast,
    advisorRsiDivSlow:
      typeof config?.advisorRsiDivSlow === "number"
        ? config.advisorRsiDivSlow
        : ADVISOR_RSIDIV_DEFAULTS.slow,
    advisor1hRsiDivWeight:
      typeof config?.advisor1hRsiDivWeight === "number"
        ? config.advisor1hRsiDivWeight
        : 0,
    // Source of the RSI-Div differential (2026-09-13): the Pine indicator's
    // selectable source list, ported (ADVISOR_RSIDIV_SOURCES). Unset = "open"
    // — the 13-source sweep's only coherent winner (close measured WORSE
    // than the family being off).
    advisorRsiDivSource:
      typeof config?.advisorRsiDivSource === "string"
        ? (config.advisorRsiDivSource as AdvisorRsiDivSource)
        : "open",
    // 1H-only StochRSI periods (2026-09-12): unset = share the advisor-
    // StochRsi* fields. Same tick-time baking as the MACD weight — the
    // hourly tick reads these, the 4H tick and BTC backfill never do.
    advisor1hStochRsiRsiPeriod:
      typeof config?.advisor1hStochRsiRsiPeriod === "number"
        ? config.advisor1hStochRsiRsiPeriod
        : config?.advisorStochRsiRsiPeriod,
    advisor1hStochRsiStochPeriod:
      typeof config?.advisor1hStochRsiStochPeriod === "number"
        ? config.advisor1hStochRsiStochPeriod
        : config?.advisorStochRsiStochPeriod,
    // 1H-only divergence age (2026-09-12): unset = share the resolved shared
    // value (an undefined age would silently kill ALL divergence votes, so this
    // fallback hardcodes the shared default). The SHIPPED 1H value is 12 and is
    // written into both config rows — 12 beat the earlier 8 in the sweep and
    // in the out-of-sample window (+81.4R vs +74.3R in-sample, +47.8R vs
    // +39.7R on Aug 20-Sep 1, both with 4H pinned to the pair arm).
    advisor1hDivergenceAgeBars:
      typeof config?.advisor1hDivergenceAgeBars === "number"
        ? config.advisor1hDivergenceAgeBars
        : typeof config?.advisorDivergenceAgeBars === "number"
          ? config.advisorDivergenceAgeBars
          : 4,
    advisorMacdFast:
      typeof config?.advisorMacdFast === "number"
        ? config.advisorMacdFast
        : ADVISOR_MACD_DEFAULTS.fast,
    advisorMacdSlow:
      typeof config?.advisorMacdSlow === "number"
        ? config.advisorMacdSlow
        : ADVISOR_MACD_DEFAULTS.slow,
    advisorMacdSignal:
      typeof config?.advisorMacdSignal === "number"
        ? config.advisorMacdSignal
        : ADVISOR_MACD_DEFAULTS.signal,
  };
}

/** Serialize the pure advisor state into the stored (flat) doc shape. */
function toStored(s: AdvisorPairState) {
  return {
    price: s.price,
    barTime: s.barTime,
    rsi: s.rsi,
    stochD: s.stochD,
    stochK: s.stochK,
    cmf: s.cmf,
    vwapDistPct: s.vwapDistPct,
    rsiBear: s.rsiBear, rsiBull: s.rsiBull,
    obvBear: s.obvBear, obvBull: s.obvBull,
    adBear: s.adBear, adBull: s.adBull,
    cmfBear: s.cmfBear, cmfBull: s.cmfBull,
    vwapExhaustLong: s.vwapExhaustLong, vwapExhaustShort: s.vwapExhaustShort,
    thinZoneLong: s.thinZoneLong, thinZoneShort: s.thinZoneShort,
    macdBearDiv: s.macdBearDiv, macdBullDiv: s.macdBullDiv,
    histXDown: s.histXDown, histXUp: s.histXUp,
    smartVolXDown: s.smartVolXDown, smartVolXUp: s.smartVolXUp,
    longStatus: s.long.status,
    longVotes: s.long.votes,
    shortStatus: s.short.status,
    shortVotes: s.short.votes,
    longReasons: s.long.reasons,
    shortReasons: s.short.reasons,
  };
}

export const recordAdvisorTick = mutation({
  args: { timestamp: v.number(), metrics: v.any(), interval: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await ctx.db.insert("advisorTicks", {
      timestamp: args.timestamp,
      metrics: args.metrics,
      interval: args.interval ?? "4h",
    });
    // Prune rows older than 48h. Bounded drain loop, not a single delete:
    // one-per-insert never catches up after a multi-day tick outage (audit
    // 2026-10-01) — each stale row beyond the backlog then lives until the
    // next outage-free 48h, and the table grows without bound while stalled.
    // Cap 20/insert keeps a pathological backlog draining over a few ticks
    // instead of one giant write.
    for (let i = 0; i < 20; i++) {
      const oldest = await ctx.db
        .query("advisorTicks")
        .withIndex("by_timestamp")
        .order("asc")
        .first();
      if (!oldest || oldest.timestamp >= args.timestamp - TICK_MAX_AGE_MS) break;
      await ctx.db.delete(oldest._id);
    }
    return { ok: true };
  },
});

export const advisorTick = action({
  // 2026-09-12: the SAME detector now runs on two timeframes from this one
  // action — pass { interval: "1h" } for the hourly layer (cron hours outside
  // the 4H grid) or call with no args for the original 4H tick. Everything
  // downstream (detector, weights, thresholds, stored doc shape) is shared;
  // only the kline interval and the cron hour differ.
  args: {
    interval: v.optional(v.union(v.literal("4h"), v.literal("1h"))),
    // Scheduler-only flag: this action also backs the panel's "Run now", and a
    // manual run must not pass for proof that the cron is alive.
    cron: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<{
    status: string;
    pairs: number;
    withData: number;
    vetoLong: number;
    vetoShort: number;
    results: string[];
  }> => {
    const results: string[] = [];
    let withData = 0;
    let vetoLong = 0;
    let vetoShort = 0;

    const interval = args.interval ?? "4h";
    const is1h = interval === "1h";
    const tfLabel = is1h ? "1H" : "4H";

    // Heartbeat, scheduler-only (src/lib/heartbeat.ts), BEFORE the dedupe
    // guard: the switch is about the clock, and a correctly-skipped tick is
    // still alive. The 4H job's 300-min stale ceiling is exactly
    // ADVISOR_MAX_AGE_MS, the moment this layer stops vetoing and silently goes
    // permissive.
    if (args.cron) {
      await ctx
        .runMutation(internal.heartbeat.record, {
          job: is1h ? "advisor-1h-tick" : "advisor-htf-tick",
        })
        .catch(() => {});
    }

    // ── Dedupe guard ──
    // 4H inputs only change when a 4H bar closes. If a tick already ran in
    // the last 30 min, recomputing produces the identical doc — skip with
    // zero MEXC calls. This also makes the panel's manual "Run now" a cheap
    // no-op right after the cron fires (both serve the same closed bars).
    const newestTick: any = await ctx
      .runQuery(api.advisor.getAdvisorState, { interval })
      .catch(() => null);
    if (newestTick && Date.now() - newestTick.timestamp < 30 * 60 * 1000) {
      return {
        status: "skip-recent",
        pairs: newestTick.pairs,
        withData: newestTick.pairs,
        vetoLong: newestTick.vetoLong,
        vetoShort: newestTick.vetoShort,
        results: [
          `skip: ${tfLabel} advisor ran within the last 30 min — bars unchanged`,
        ],
      };
    }

    // I/O gate (2026-09-12): the 1H layer is optional (default OFF). When
    // NEITHER book enables it, the hourly tick would burn 32 kline fetches
    // (~23.0k MEXC calls/month at the 2026-09-16 universe) producing a doc
    // nobody reads — skip early. (Old figure here was ~26 fetches / 18.7k at
    // 25 pairs; the universe grew to 31 LAYER1 + BTC.)
    // Cheap: two config-row reads, zero market I/O. Re-enabling from the
    // panel takes effect at the next hourly fire (≤60 min); until that doc
    // exists the engine's freshness gate fails OPEN (no 1H veto, never blocks).
    if (is1h) {
      const paperCfg: any = await ctx
        .runQuery(api.strategyEngine.getConfig, { book: "paper" })
        .catch(() => null);
      const liveCfg: any = await ctx
        .runQuery(api.strategyEngine.getConfig, { book: "live" })
        .catch(() => null);
      if (!paperCfg?.advisor1hEnabled && !liveCfg?.advisor1hEnabled) {
        return {
          status: "skip-1h-disabled",
          pairs: 0,
          withData: 0,
          vetoLong: 0,
          vetoShort: 0,
          results: [
            "skip: 1H advisor disabled on both books — hourly scan not needed (enable it in the Advisor panel; next fire picks it up)",
          ],
        };
      }
    }

    // Config read: read the PAPER book's numbers so the advisor tick computes
    // votes the same way strategyTick reads them (paper is the validation
    // book). DEMOTED 2026-10-06: votes still compute (they feed the adv4h-*
    // shadow tags) but no book enforces them unless its row opts back in.
    const config: any = await ctx
      .runQuery(api.strategyEngine.getConfig, { book: "paper" })
      .catch(() => null);
    // Per-side veto thresholds (2026-09-08): SHORT=1 blocks shorts on any
    // single flag (every flagged short lost in the replay); LONG stays 2.
    // Each falls back to the shared advisorVetoThreshold when unset.
    const cfg = advisorConfigFrom(config);
    const vetoThreshold = cfg.advisorVetoThreshold;
    const longThreshold = cfg.advisorLongThreshold;
    const shortThreshold = cfg.advisorShortThreshold;
    const divergenceAgeBars = cfg.advisorDivergenceAgeBars;
    const divergenceAgeBars1h = cfg.advisor1hDivergenceAgeBars;
    const vwapExtremePct = cfg.advisorVwapExtremePct;
    const rsiExtreme = cfg.advisorRsiExtreme;
    const strongWeight = cfg.advisorStrongWeight;
    const weakWeight = cfg.advisorWeakWeight;

    // Stored per-pair shape + the BTC-only optional regime fields (filled
    // below with one extra 1H fetch — other pairs leave them unset).
    type StoredMetrics = ReturnType<typeof toStored> & {
      btcRegime?: string;
      btcChange1h?: number;
    };
    const metrics: Record<string, StoredMetrics> = {};

    await Promise.all(
      ADVISOR_PAIRS.map(async (pair) => {
        try {
          const klines = await relayKlines(ctx, pair, interval, ADVISOR_4H_BARS);
          const state = evaluateAdvisor(klines, {
            // 1H layer (2026-09-12): label the reason strings with the ACTUAL
            // timeframe — the detector is shared, so without this every 1H veto
            // was reported as "4H ..." and the two layers were impossible to
            // tell apart in the panel / block message.
            advisorTfLabel: tfLabel,
            advisorVetoThreshold: vetoThreshold,
            advisorLongThreshold: longThreshold,
            advisorShortThreshold: shortThreshold,
            // 1H layer (2026-09-12): hourly tick reads the 1H-only age
            // (advisorConfigFrom falls back to the shared value when unset).
            advisorDivergenceAgeBars: is1h ? divergenceAgeBars1h : divergenceAgeBars,
            advisorVwapExtremePct: vwapExtremePct,
            advisorRsiExtreme: rsiExtreme,
            advisorStrongWeight: strongWeight,
            advisorWeakWeight: weakWeight,
            // Per-family switches (2026-10-23): MUST be forwarded explicitly —
            // this call passes a hand-built subset, so an omitted knob silently
            // falls back to the module default and the panel button does nothing.
            advisorMomDivEnabled: cfg.advisorMomDivEnabled,
            advisorObvEnabled: cfg.advisorObvEnabled,
            advisorAdEnabled: cfg.advisorAdEnabled,
            advisorCmfEnabled: cfg.advisorCmfEnabled,
            advisorVwapEnabled: cfg.advisorVwapEnabled,
            advisorThinZoneEnabled: cfg.advisorThinZoneEnabled,
            advisorMacdEnabled: cfg.advisorMacdEnabled,
            // 1H layer (2026-09-12): the weight is baked into the stored vote
            // counts at tick time, so the hourly tick must read the 1H-only
            // weight (falls back to the shared one in advisorConfigFrom).
            advisorMacdWeight: is1h ? cfg.advisor1hMacdWeight : cfg.advisorMacdWeight,
            advisorMacdFast: cfg.advisorMacdFast,
            advisorMacdSlow: cfg.advisorMacdSlow,
            advisorMacdSignal: cfg.advisorMacdSignal,
            // Smart Vol MACD (2026-09-13): MUST be forwarded explicitly —
            // same rule as the MACD/StochRSI families (this call passes a
            // hand-built subset; an omitted knob silently falls back to the
            // module default and panel edits would do nothing).
            advisorSmartVolEnabled: cfg.advisorSmartVolEnabled,
            // 1H isolation (2026-09-13): the hourly layer reads its own weight
            // (advisor1hSmartVolWeight, default 0 = OFF) — never the shared
            // 4H weight. run-smartvol-advisor-lab.ts measured the 4H scope.
            advisorSmartVolWeight: is1h ? cfg.advisor1hSmartVolWeight : cfg.advisorSmartVolWeight,
            advisorSmartVolFast: cfg.advisorSmartVolFast,
            advisorSmartVolSlow: cfg.advisorSmartVolSlow,
            advisorSmartVolSignal: cfg.advisorSmartVolSignal,
            // RSI-Div (2026-09-13): explicit forward + 1H isolation, same
            // rule as the MACD/SmartVol families (omitted knobs silently
            // fall back to module defaults and panel edits would do nothing).
            advisorRsiDivEnabled: cfg.advisorRsiDivEnabled,
            advisorRsiDivWeight: is1h ? cfg.advisor1hRsiDivWeight : cfg.advisorRsiDivWeight,
            advisorRsiDivFast: cfg.advisorRsiDivFast,
            advisorRsiDivSlow: cfg.advisorRsiDivSlow,
            advisorRsiDivSource: cfg.advisorRsiDivSource,
            // StochRSI (2026-09-11): MUST be forwarded explicitly — this call
            // passes a hand-built subset, so any knob omitted here silently
            // falls back to the module default and panel edits do nothing.
            advisorStochRsiEnabled: cfg.advisorStochRsiEnabled,
            // 1H layer (2026-09-12): hourly tick reads the 1H-only periods
            // (advisorConfigFrom falls back to the shared values when unset).
            advisorStochRsiRsiPeriod: is1h ? cfg.advisor1hStochRsiRsiPeriod : cfg.advisorStochRsiRsiPeriod,
            advisorStochRsiStochPeriod: is1h ? cfg.advisor1hStochRsiStochPeriod : cfg.advisorStochRsiStochPeriod,
            advisorStochRsiKSmooth: cfg.advisorStochRsiKSmooth,
            advisorStochRsiDSmooth: cfg.advisorStochRsiDSmooth,
            advisorStochRsiUseD: cfg.advisorStochRsiUseD,
          });
          if (!state) {
            results.push(`${pair}: skip (insufficient ${tfLabel} history)`);
            return;
          }
          metrics[pair] = toStored(state);
          withData++;
          if (state.long.status === "veto") vetoLong++;
          if (state.short.status === "veto") vetoShort++;
          const vetoes = [
            ...(state.long.status === "veto" ? [`LONG(${state.long.votes}v)`] : []),
            ...(state.short.status === "veto" ? [`SHORT(${state.short.votes}v)`] : []),
          ];
          results.push(
            vetoes.length
              ? `${pair}: ${vetoes.join(" ")} veto — ${[
                  ...state.long.reasons,
                  ...state.short.reasons,
                ].join("; ")}`
              : `${pair}: ok (StochRSI %K ${state.stochK.toFixed(0)} · %D ${state.stochD.toFixed(0)} · VWAP ${state.vwapDistPct >= 0 ? "+" : ""}${state.vwapDistPct.toFixed(1)}%)`,
          );
        } catch (e: any) {
          results.push(`${pair}: error (${e?.message ?? "fetch failed"})`);
        }
      }),
    );

    // BTC regime read — ONE extra 1H fetch per advisor run (not per pair):
    // attach the same up/down/chop percentile classification the mining data
    // records per trade, so the frontend's BTC behavior card shows the LIVE
    // regime without any per-render I/O. Only fills when BTC's 4H metrics
    // made it into the doc (skip silently otherwise — the doc stays valid).
    // BTC 1H regime + the 4H history accumulator are 4H-layer concerns only
    // — the hourly tick writes verdicts only, so the chart overlay keeps its
    // one-row-per-4H-bar contract and the doc's BTC row stays regime-free.
    if (metrics.BTC && !is1h) {
      try {
        const k1h = await relayKlines(ctx, "BTC", "1h", 720);
        if (k1h.length >= 20) {
          const { btcRegime, btcChange1h } = btcRegimeOf(k1h);
          metrics.BTC = { ...metrics.BTC, btcRegime, btcChange1h };
        }
      } catch (e: any) {
        results.push(`BTC regime: error (${e?.message ?? "fetch failed"}) — skipping`);
      }
      // ACCUMULATE the current 4H bar into the BTC advisor history (the
      // chart's overlay data) — one upsert + one prune per tick, keeping the
      // one-time backfill current going forward. Strips the BTC-only regime
      // fields (they are not part of the history row shape).
      try {
        const { btcRegime: _r, btcChange1h: _c, ...row } = metrics.BTC;
        await ctx.runMutation(api.advisor.recordBtcHistory, {
          row,
          now: Date.now(),
        });
      } catch (e: any) {
        results.push(`BTC history: error (${e?.message ?? "write failed"})`);
      }
    }

    // Zero pairs with data (MEXC down / rate-limited): do NOT write — an
    // empty doc would mask the previous good one and silently disable the
    // veto layer at the next strategy tick. Keep the old doc until it ages
    // out via the engine's ADVISOR_MAX_AGE_MS fail-open.
    if (withData === 0) {
      return {
        status: "no-data",
        pairs: ADVISOR_PAIRS.length,
        withData,
        vetoLong,
        vetoShort,
        results: [`no ${tfLabel} data fetched — keeping previous advisor doc (fail-open)`, ...results],
      };
    }

    const now = Date.now();
    await ctx.runMutation(api.advisor.recordAdvisorTick, { timestamp: now, metrics, interval });

    return {
      status: "ok",
      pairs: ADVISOR_PAIRS.length,
      withData,
      vetoLong,
      vetoShort,
      results,
    };
  },
});

/**
 * Newest advisor tick of ONE interval + a compact veto summary for the panel.
 * 2026-09-12: pass { interval: "1h" } for the hourly layer.
 *
 * 2026-09-16 (Database I/O audit) — this query was the project's #1 Database
 * I/O consumer (~400 MB/day measured). It runs ~24×/hour (two intervals × four
 * entry ticks across paper/proxy/live) and re-runs once per UI subscription
 * whenever a tick lands, so ~600 calls/day. The old shape scanned
 * `by_timestamp` newest-first and filtered `interval` in JS, reading EVERY
 * pruned row (up to ~30 large multi-pair docs) on each of those calls to find
 * one. The `by_interval_timestamp` index makes "newest row of my interval" a
 * SINGLE-document read.
 *
 * `interval` is optional in the schema (legacy 4H rows predate the field), but
 * `recordAdvisorTick` ALWAYS writes it (defaulting to "4h"), so every live row
 * is inside the compound index. The scan fallback below is 4H-only and covers
 * only rows written before 2026-09-12; it is unreachable in steady state.
 *
 * RESOLVED 2026-09-16 (deployment verified): the query above now reads
 * EXACTLY ONE document per call — convex logs show 17–20 KB / 1 doc per
 * completion, both intervals, across engine (Action), UI (SyncWorker) and
 * manual (HttpApi) callers. Before the push, every call scanned the whole
 * 48h `by_timestamp` partition (21–48 docs, up to 914 KB) because the
 * compound index existed on disk but had never been pushed — the interrupted
 * deploy left the OLD code running, which is what put this query at ~281
 * MB/day (79% of the deployment's total measured 357 MB/day). With the index
 * live and ~770 calls/day, this line is now ~14 MB/day and no longer the
 * meter leader (saveLayer1Cache/getLayer1Cache are).
 *
 * The COMPACT veto-only doc split sketched earlier (trim `metrics` to the six
 * veto fields the engines read) was re-evaluated against the post-fix
 * measurements and dropped: Convex meters the DOCUMENT read, and the whole
 * stored doc is only ~17 KB, so per-call cost is already at the floor. The
 * remaining lever would be call VOLUME (three books × 96 ticks × 2 intervals
 * + UI subscriptions), not per-call bytes — not worth a second table and a
 * dual-write path for ~7 MB/day.
 */
export const getAdvisorState = query({
  args: { interval: v.optional(v.union(v.literal("4h"), v.literal("1h"))) },
  handler: async (ctx, args) => {
    const want = args.interval ?? "4h";

    let tick:
      | { timestamp: number; interval?: string; metrics: Record<string, any> }
      | null = (await ctx.db
      .query("advisorTicks")
      .withIndex("by_interval_timestamp", (q) => q.eq("interval", want))
      .order("desc")
      .first()) as any;

    if (!tick && want === "4h") {
      // Legacy-only path — 4H INTERVAL ONLY (fixed 2026-09-16).
      //
      // Pre-2026-09-12 rows have `interval` UNSET and are read as "4h", so for
      // want === "1h" this scan could never match anything: a miss on the
      // compound index PROVES no 1H row exists, because every row written
      // since 2026-09-12 carries the tag. The old unconditional version was
      // therefore a guaranteed-miss scan of up to 8 large (~25 KB) docs on
      // EVERY 1H read — and the 1H layer defaults OFF, so once its rows aged
      // out of the 48h prune this fired on every panel 1H subscription
      // re-evaluation for ~200 KB of pure DB I/O per call. 4H keeps the
      // fallback because legacy rows genuinely are 4H. Still bounded at 8 so
      // it can never reintroduce the full-table scan the compound index
      // replaced.
      const legacy = await ctx.db
        .query("advisorTicks")
        .withIndex("by_timestamp")
        .order("desc")
        .take(8);
      tick = (legacy.find((d: any) => (d.interval ?? "4h") === want) as any) ?? null;
    }
    if (!tick) return null;

    const entries = Object.entries(tick.metrics);
    const vetoLong = entries.filter(([, m]) => m.longStatus === "veto").length;
    const vetoShort = entries.filter(([, m]) => m.shortStatus === "veto").length;
    const vetoed = entries
      .filter(([, m]) => m.longStatus === "veto" || m.shortStatus === "veto")
      .sort(
        (a, b) =>
          b[1].longVotes + b[1].shortVotes - (a[1].longVotes + a[1].shortVotes),
      )
      .slice(0, 30)
      .map(([pair, m]) => ({ pair, ...m }));

    return {
      timestamp: tick.timestamp,
      ageMs: Date.now() - tick.timestamp,
      pairs: entries.length,
      vetoLong,
      vetoShort,
      vetoed,
      // Full per-pair map — consumed by strategyTick for entry gating (and
      // cheap: 20 pairs). Rows carry the stored doc shape (longStatus etc.).
      metrics: tick.metrics,
    };
  },
});

// ── BTC ADVISOR HISTORY (chart overlay data, 2026-09-08) ──────────────────
// One row per CLOSED 4H bar of BTC with the exact advisor reading that bar
// would have produced. Backfilled once over ~90 days by
// backfillBtcAdvisorHistory, then kept current by the advisor tick (one
// upsert + one prune per run). Read-only on the chart path: the frontend's
// on-demand getBtcChartData action reads this table — zero recurring I/O.

/** Upsert one 4H bar's BTC reading + prune rows past HISTORY_MAX_AGE_MS. */
export const recordBtcHistory = mutation({
  args: { row: v.any(), now: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("btcAdvisorHistory")
      .withIndex("by_barTime", (q) => q.eq("barTime", args.row.barTime))
      .first();
    if (existing) await ctx.db.replace(existing._id, args.row);
    else await ctx.db.insert("btcAdvisorHistory", args.row);
    const oldest = await ctx.db
      .query("btcAdvisorHistory")
      .withIndex("by_barTime")
      .order("asc")
      .first();
    if (oldest && oldest.barTime < args.now - HISTORY_MAX_AGE_MS) {
      await ctx.db.delete(oldest._id);
    }
    return { ok: true };
  },
});

/** Replace the whole history (used by the one-time backfill). */
export const replaceBtcHistory = mutation({
  args: { rows: v.array(v.any()) },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("btcAdvisorHistory").collect();
    for (const row of existing) await ctx.db.delete(row._id);
    for (const row of args.rows) await ctx.db.insert("btcAdvisorHistory", row);
    return { inserted: args.rows.length, removed: existing.length };
  },
});

/** Full advisor history, oldest → newest (optionally trimmed to a time). */
export const getBtcHistory = query({
  args: { since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    // Push the since-window into the index so a 7d view reads ~48 rows, not
    // the whole ~480-row table, then filtering in memory.
    if (args.since) {
      const since = args.since;
      return ctx.db
        .query("btcAdvisorHistory")
        .withIndex("by_barTime", (range) => range.gte("barTime", since))
        .order("asc")
        .collect();
    }
    return ctx.db
      .query("btcAdvisorHistory")
      .withIndex("by_barTime")
      .order("asc")
      .collect();
  },
});

/**
 * One-time backfill: fetch ~100 days of BTC 4H klines (1 MEXC call) and
 * replay the EXACT evaluateAdvisor detector over every closed bar, so the
 * chart's advisor overlay (veto markers, divergence flags, RSI, votes)
 * spans the whole window instead of just the last 48h. Stored in the
 * btcAdvisorHistory table; the advisor tick keeps it current from here on.
 * All bars share the CURRENT advisor config (a consistent lens) — if the
 * thresholds are tuned later, only bars written after that change reflect
 * the new config.
 */
export const backfillBtcAdvisorHistory = action({
  args: {},
  handler: async (ctx): Promise<{ inserted: number; from: number; to: number }> => {
    const config: any = await ctx
      .runQuery(api.strategyEngine.getConfig, { book: "paper" })
      .catch(() => null);
    const cfg = advisorConfigFrom(config);

    const klines = await relayKlines(ctx, "BTC", "4h", BACKFILL_4H_BARS);
    if (klines.length < 120) {
      throw new Error(`insufficient 4H history for backfill: ${klines.length} bars`);
    }

    // Replay bar-by-bar (closed candles only): evaluateAdvisor(klines[0..i])
    // is exactly what the advisor tick computes for bar i, so each stored row
    // is the reading that WOULD have been live at that 4H close.
    const rows: ReturnType<typeof toStored>[] = [];
    for (let i = 119; i < klines.length; i++) {
      const state = evaluateAdvisor(klines.slice(0, i + 1), cfg);
      if (state) rows.push(toStored(state));
    }
    if (rows.length === 0) throw new Error("backfill produced no advisor readings");

    const res = await ctx.runMutation(api.advisor.replaceBtcHistory, { rows });
    return {
      inserted: res.inserted,
      from: rows[0].barTime,
      to: rows[rows.length - 1].barTime,
    };
  },
});

/**
 * On-demand chart payload — the ONLY market call the BTC chart makes:
 * ONE BTC 1H kline fetch per view (168 or 720 bars, capped at 30 days so a
 * single request covers the window). The advisor overlay comes from the
 * btcAdvisorHistory table (backfilled once + kept current by the tick) —
 * zero recurring market I/O. First-ever view on a fresh deployment seeds
 * the table via backfillBtcAdvisorHistory (one extra call, then read-only).
 */
export const getBtcChartData = action({
  args: { days: v.optional(v.number()) },
  handler: async (ctx, args): Promise<{
    bars: { time: number; close: number; regime: "up" | "down" | "chop" }[];
    advisor: ReturnType<typeof toStored>[];
    coverage: { count: number; firstBar: number; lastBar: number } | null;
  }> => {
    const days = Math.min(Math.max(args.days ?? 30, 7), 30);
    const k1h = await relayKlines(ctx, "BTC", "1h", days * 24);
    if (k1h.length < 50) {
      throw new Error(`insufficient 1H history: ${k1h.length} bars`);
    }
    const since = k1h[0].openTime;
    // DB rows carry _id/_creationTime and widen longStatus to string; map
    // them back to the stored doc shape so the action's return type stays
    // the same shape the tick stores.
    const toRow = (r: any): ReturnType<typeof toStored> => ({
      price: r.price, barTime: r.barTime, rsi: r.rsi, stochD: r.stochD, stochK: r.stochK, cmf: r.cmf, vwapDistPct: r.vwapDistPct,
      rsiBear: r.rsiBear, rsiBull: r.rsiBull, obvBear: r.obvBear, obvBull: r.obvBull,
      adBear: r.adBear, adBull: r.adBull, cmfBear: r.cmfBear, cmfBull: r.cmfBull,
      smartVolXDown: r.smartVolXDown, smartVolXUp: r.smartVolXUp,
      vwapExhaustLong: r.vwapExhaustLong, vwapExhaustShort: r.vwapExhaustShort,
      thinZoneLong: r.thinZoneLong, thinZoneShort: r.thinZoneShort,
      macdBearDiv: r.macdBearDiv ?? false, macdBullDiv: r.macdBullDiv ?? false,
      histXDown: r.histXDown ?? false, histXUp: r.histXUp ?? false,
      longStatus: r.longStatus, longVotes: r.longVotes,
      shortStatus: r.shortStatus, shortVotes: r.shortVotes,
      longReasons: r.longReasons ?? [], shortReasons: r.shortReasons ?? [],
    });
    let advisor: ReturnType<typeof toStored>[] = [];
    advisor = (await ctx
      .runQuery(api.advisor.getBtcHistory, { since })
      .catch(() => null))?.map(toRow) ?? [];
    if (!advisor.length) {
      await ctx.runAction(api.advisor.backfillBtcAdvisorHistory).catch(() => null);
      advisor = (await ctx
        .runQuery(api.advisor.getBtcHistory, { since })
        .catch(() => null))?.map(toRow) ?? [];
    }
    const regimes = btcRegimeSeries(k1h);
    const bars = k1h.map((k, i) => ({
      time: Math.floor(k.openTime / 1000),
      close: k.close,
      regime: regimes[i],
    }));
    const coverage = advisor.length
      ? {
          count: advisor.length,
          firstBar: advisor[0].barTime,
          lastBar: advisor[advisor.length - 1].barTime,
        }
      : null;
    return { bars, advisor, coverage };
  },
});