/**
 * LIVE SETUP FEATURES — what was knowable when the bot pressed the button.
 *
 * The live ledger (mining:exportTrades) records 114 fields per trade. That is
 * more than enough to overfit 581 trades, so this module does two things:
 *
 *   1. CLASSIFIES. Everything the bot already measured AT the decision is
 *      causal: atrPctAtEntry, bidAskImbalance, oiAtEntry, pairVsBtc1h,
 *      btcChange1h, btcTrendAtEntry,
 *      htfTrend1h, regime, session, distToSwingSr, the scores, and the
 *      `*AtDecision` shadow-gate reads (shadowH4VolLog2, shadowH4RangePct,
 *      shadowRsi7).
 *      Those ARE the gate and advisor behaviour at entry, which is the only
 *      version of it a live score is allowed to see.
 *
 *   2. MINES THE KLINES for what the ledger does not store: distance to nine
 *      EMAs across three timeframes, their slopes, and whether those slopes
 *      agree. "Distance to the entry EMA" and "slope behaviour" are not columns
 *      in the trade record — they have to be computed from the bars that were
 *      closed at entry, which is what makes them honest.
 *
 * Everything measured DURING or AFTER the trade (mfeR, maeR,
 * mfeCaptureRatio, timeToMfe, timeToMae, trailPeakR, btcMoveDuringTrade,
 * volDelta, shadowR, realizedR, reason) is excluded and the
 * guard is the same one the paper contract uses, so a leaked field throws
 * rather than quietly inflating a result.
 */

import { atrPctSeries } from "./backtest";
import { assertCausalFeatureList } from "./paper-feature-contract";
import type { Kline } from "./types";

export type LiveTrade = {
  _id?: string; coin?: string; book?: string; variant?: string;
  type?: "LONG" | "SHORT"; status?: string;
  entryTime?: number; signalTime?: number; exitTime?: number;
  entryPrice?: number; signalPrice?: number; slPrice?: number; tpPrice?: number;
  realizedR?: number; pnlUsd?: number; pnlPercent?: number; reason?: string;
  leverage?: number; notionalUsd?: number; marginUsd?: number; volContracts?: number;
  atrPctAtEntry?: number; volPct?: number; volAtEntry?: number; volRatioAtEntry?: number;
  bidAskImbalance?: number; spreadPct?: number; entrySlippageBps?: number;
  oiAtEntry?: number; fundingRate?: number; distToSwingSr?: number;
  // 4H EMA LEVELS as the bot measured them at the decision (580/588 coverage).
  // These are the same quantity the mining computes, from the bot's own read --
  // kept separately so the two can be cross-checked against each other.
  htfEma20_4h?: number; htfEma50_4h?: number;
  htfVol4h?: number; htfVol4hAvg?: number;
  btcChange1h?: number; btcTrendAtEntry?: string; htfTrend1h?: string;
  regime?: string; session?: string; dayOfWeek?: number; durationBucket?: string;
  longScore?: number; shortScore?: number;
  pairVsBtc1h?: number;
  shadowH4VolLog2?: number; shadowH4RangePct?: number; shadowRsi7?: number;
  shadowTags?: string[];
  // post-hoc -- present on the record, never used as a predictor
  mfeR?: number; maeR?: number; mfeCaptureRatio?: number;
  timeToMfe?: number; timeToMae?: number; trailPeakR?: number;
  btcMoveDuringTrade?: number; ethMoveDuringTrade?: number;
  volDelta?: number; shadowR?: number;
};

/** Decision-time fields carried on the trade record itself. */
export const LOGGED_CAUSAL: Record<string, string[]> = {
  volatility: ["atrPctAtEntry", "volPct", "volAtEntry", "volRatioAtEntry"],
  micro: ["bidAskImbalance", "spreadPct", "entrySlippageBps", "oiAtEntry", "fundingRate"],
  btc: ["btcChange1h", "pairVsBtc1h"],
  levels: ["distToSwingSr"],
  /** Distance to the 4H EMAs using the bot's OWN recorded levels, not mined. */
  htfLogged: ["dLog4hEma20", "dLog4hEma50", "dLog4hEmaSpread", "htfVolRatio4h"],
};

export const LABELLED_CAUSAL: Record<string, string[]> = {
  btc: ["btcTrendAtEntry"],
  htf: ["htfTrend1h", "regime"],
  session: ["session"],
  shadowGate: ["shadowH4VolLog2", "shadowH4RangePct", "shadowRsi7"],
};

/** Mined from klines, not stored on the record. */
export const MINED_CAUSAL: Record<string, string[]> = {
  emaDistance: [
    "d15Ema7", "d15Ema20", "d15Ema50", "d15Ema200",
    "d1hEma20", "d1hEma50", "d4hEma20", "d4hEma50",
  ],
  slope: ["s15Ema20", "s15Ema50", "s15Ema200", "s4hEma20"],
  agreement: ["slopeAlign15_1h", "slopeAlign15_4h", "slopeAlignCount"],
  structure: ["rsi14", "barRangePct", "closeInBar", "volRatio20", "atrRank", "consecSameDir"],
  /** Mined-minus-logged gap: a data-integrity check, not a signal. */
  integrity: ["emaCrossCheckMaxAbsDiff"],
};

export const ALL_CAUSAL_FEATURES: string[] = [
  ...Object.values(LOGGED_CAUSAL).flat(),
  ...Object.values(MINED_CAUSAL).flat(),
  // derived below
  "sideScore", "scoreEdge", "isLong", "hourUtc",
  "btcTrendBull", "btcTrendBear", "htfTrendUp", "htfTrendDown",
  "sessionAsia", "sessionLondon", "sessionNy", "regimeTrendUp", "regimeTrendDown",
];

// The guard, run at module load: if anyone adds a post-hoc field to one of the
// lists above, this throws at import time rather than in a result three days
// later.
assertCausalFeatureList(ALL_CAUSAL_FEATURES);

type Series = {
  ema: Record<number, number[]>; rsi: number[]; atr: number[];
  closes: number[]; volAvg20: number[]; ranges: number[];
};

function emaSeries(v: number[], p: number): number[] {
  const k = 2 / (p + 1);
  const out = new Array<number>(v.length).fill(NaN);
  if (!v.length) return out;
  let x = v[0]!;
  out[0] = x;
  for (let i = 1; i < v.length; i++) { x = v[i]! * k + x * (1 - k); out[i] = x; }
  return out;
}

function rsiSeries(c: number[], p = 14): number[] {
  const out = new Array<number>(c.length).fill(NaN);
  if (c.length <= p) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = c[i]! - c[i - 1]!; if (d >= 0) g += d; else l -= d; }
  g /= p; l /= p;
  out[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < c.length; i++) {
    const d = c[i]! - c[i - 1]!;
    g = (g * (p - 1) + Math.max(0, d)) / p;
    l = (l * (p - 1) + Math.max(0, -d)) / p;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

export function buildSeries(bars: readonly Kline[]): Series {
  const closes = bars.map((b) => b.close);
  const ranges = bars.map((b) => ((b.high - b.low) / (b.low || 1)) * 100);
  const volAvg20 = new Array<number>(bars.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < bars.length; i++) {
    s += bars[i]!.volume;
    if (i >= 20) s -= bars[i - 20]!.volume;
    if (i >= 19) volAvg20[i] = s / 20;
  }
  return {
    ema: { 7: emaSeries(closes, 7), 20: emaSeries(closes, 20), 50: emaSeries(closes, 50), 200: emaSeries(closes, 200) },
    rsi: rsiSeries(closes, 14),
    atr: atrPctSeries(bars as Kline[]),
    closes, volAvg20, ranges,
  };
}

function indexAt(bars: readonly Kline[], at: number): number {
  let lo = 0, hi = bars.length - 1, idx = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m]!.closeTime <= at) { idx = m; lo = m + 1; } else hi = m - 1; }
  return idx;
}


/** Percent slope of an EMA over `back` bars, as a percentage of its own value. */
function slopePct(series: readonly number[], i: number, back: number): number {
  const now = series[i];
  const then = series[i - back];
  if (!Number.isFinite(now) || !Number.isFinite(then) || then === 0) return NaN;
  return ((now - then) / then) * 100;
}

export type MinedSources = { k15: Series; h1: Series; h4: Series };

/**
 * The mined + logged causal vector. Requires enough closed history on all three
 * timeframes; returns null rather than a half-filled vector, because a record
 * missing the 4H slope is not comparable to one that has it.
 */
export function liveCausalFeatures(
  t: LiveTrade,
  bars: { k15: readonly Kline[]; h1: readonly Kline[]; h4: readonly Kline[] },
  src: MinedSources,
  at: number,
): Record<string, number> | null {
  const i = indexAt(bars.k15, at);
  const j1 = indexAt(bars.h1, at);
  const j4 = indexAt(bars.h4, at);
  if (i < 210 || j1 < 60 || j4 < 60) return null;
  const c15 = src.k15.closes[i]!;
  const isLong = t.type === "LONG";
  const out: Record<string, number> = {};

  const dist = (v: number) => Number.isFinite(v) && v > 0 ? ((c15 - v) / v) * 100 : NaN;
  out.d15Ema7 = dist(src.k15.ema[7]![i]!);
  out.d15Ema20 = dist(src.k15.ema[20]![i]!);
  out.d15Ema50 = dist(src.k15.ema[50]![i]!);
  out.d15Ema200 = dist(src.k15.ema[200]![i]!);
  if (Number.isFinite(c15)) {
    out.d1hEma20 = ((c15 - src.h1.ema[20]![j1]!) / src.h1.ema[20]![j1]!) * 100;
    out.d1hEma50 = ((c15 - src.h1.ema[50]![j1]!) / src.h1.ema[50]![j1]!) * 100;
    out.d4hEma20 = ((c15 - src.h4.ema[20]![j4]!) / src.h4.ema[20]![j4]!) * 100;
    out.d4hEma50 = ((c15 - src.h4.ema[50]![j4]!) / src.h4.ema[50]![j4]!) * 100;
  }
  out.s15Ema20 = slopePct(src.k15.ema[20]!, i, 20);
  out.s15Ema50 = slopePct(src.k15.ema[50]!, i, 50);
  out.s15Ema200 = slopePct(src.k15.ema[200]!, i, 100);
  out.s4hEma20 = slopePct(src.h4.ema[20]!, j4, 6);

  // Do the three timeframes lean the same way? A LONG whose 15m slope is up
  // while the 4h slope is down is a different setup from one where all three
  // agree, and a distance-to-EMA number alone cannot express that.
  const s15 = out.s15Ema20, s1h = slopePct(src.h1.ema[20]!, j1, 8), s4h = out.s4hEma20;
  out.slopeAlign15_1h = Number.isFinite(s15) && Number.isFinite(s1h) ? (Math.sign(s15) === Math.sign(s1h) ? 1 : -1) : NaN;
  out.slopeAlign15_4h = Number.isFinite(s15) && Number.isFinite(s4h) ? (Math.sign(s15) === Math.sign(s4h) ? 1 : -1) : NaN;
  const aligns = [out.slopeAlign15_1h, out.slopeAlign15_4h].filter((x) => Number.isFinite(x));
  out.slopeAlignCount = aligns.reduce((s, x) => s + (x > 0 ? 1 : 0), 0);

  out.rsi14 = src.k15.rsi[i]!;
  out.barRangePct = src.k15.ranges[i]!;
  const bar = bars.k15[i]!;
  const range = bar.high - bar.low;
  out.closeInBar = range > 0 ? (bar.close - bar.low) / range : 0.5;
  out.volRatio20 = src.k15.volAvg20[i]! > 0 ? bar.volume / src.k15.volAvg20[i]! : NaN;

  // ATR percentile against its OWN trailing history — the relative form, so a
  // 0.4% bar is "extreme" for a large pair and ordinary for a small one.
  const cur = src.k15.atr[i]!;
  if (Number.isFinite(cur)) {
    let below = 0, used = 0;
    for (let j = Math.max(0, i - 479); j <= i; j++) { const v = src.k15.atr[j]; if (Number.isFinite(v)) { used++; if (v <= cur) below++; } }
    out.atrRank = used > 50 ? below / used : NaN;
  }
  const dir = Math.sign(c15 - src.k15.closes[i - 1]!);
  let consec = 0;
  for (let j = i; j > 0 && dir !== 0 && Math.sign(src.k15.closes[j]! - src.k15.closes[j - 1]!) === dir; j--) consec++;
  out.consecSameDir = isLong ? consec : -consec;

  // ── logged decision-time fields ──
  for (const keys of Object.values(LOGGED_CAUSAL)) {
    for (const k of keys) {
      const v = (t as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
  }
  const own = isLong ? t.longScore : t.shortScore;
  const opp = isLong ? t.shortScore : t.longScore;
  if (Number.isFinite(own)) out.sideScore = own!;
  if (Number.isFinite(own) && Number.isFinite(opp)) out.scoreEdge = own! - opp!;
  out.isLong = isLong ? 1 : 0;
  out.hourUtc = new Date(at).getUTCHours();

  // The bot's own 4H EMA levels, converted to the same percent-distance form as
  // the mined ones. Two independent measurements of the same thing: if these
  // disagree with d4hEma20/d4hEma50 the disagreement itself is recorded, because
  // a silent data-integrity fault would be read as a trading signal.
  const px = Number.isFinite(t.signalPrice) ? t.signalPrice! : c15;
  if (t.htfEma20_4h! > 0) out.dLog4hEma20 = ((px - t.htfEma20_4h!) / t.htfEma20_4h!) * 100;
  if (t.htfEma50_4h! > 0) out.dLog4hEma50 = ((px - t.htfEma50_4h!) / t.htfEma50_4h!) * 100;
  if (t.htfEma50_4h! > 0 && t.htfEma20_4h! > 0) out.dLog4hEmaSpread = ((t.htfEma20_4h! - t.htfEma50_4h!) / t.htfEma50_4h!) * 100;
  if (t.htfVol4hAvg! > 0) out.htfVolRatio4h = t.htfVol4h! / t.htfVol4hAvg!;
  const gaps = [Math.abs(out.dLog4hEma20 - out.d4hEma20), Math.abs(out.dLog4hEma50 - out.d4hEma50)]
    .filter((x) => Number.isFinite(x));
  if (gaps.length) out.emaCrossCheckMaxAbsDiff = Math.max(...gaps);
  if (t.btcTrendAtEntry) { out.btcTrendBull = t.btcTrendAtEntry === "up" ? 1 : 0; out.btcTrendBear = t.btcTrendAtEntry === "down" ? 1 : 0; }
  if (t.htfTrend1h) { out.htfTrendUp = t.htfTrend1h === "up" ? 1 : 0; out.htfTrendDown = t.htfTrend1h === "down" ? 1 : 0; }
  if (t.session) {
    out.sessionAsia = t.session === "asia" ? 1 : 0;
    out.sessionLondon = t.session === "london" ? 1 : 0;
    out.sessionNy = t.session === "ny" ? 1 : 0;
  }
  if (t.regime) { out.regimeTrendUp = t.regime === "trend-up" ? 1 : 0; out.regimeTrendDown = t.regime === "trend-down" ? 1 : 0; }
  for (const keys of Object.values(LABELLED_CAUSAL)) {
    for (const k of keys) {
      if (k in { btcTrendAtEntry: 1, htfTrend1h: 1, regime: 1, session: 1 }) continue;
      const v = (t as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}
