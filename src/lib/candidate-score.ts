/**
 * CANDIDATE SCORE — a faithful, parameterized port of the externally proposed
 * two-sided microstructure scorer (EMA 8/21 stack + book imbalance + taker
 * flow + funding + exhaustion overlay), built so `run-candidate-score-lab.ts`
 * can sweep its knobs without re-deriving candle features per cell.
 *
 * FIDELITY RULES (the port tracks the proposed code line-for-line):
 *  - base 50/50, EMA trend tilt +16/−10, book/flow weight 22 (literal),
 *    funding ±6, spread +4 (tight) / −14 (wide), ATR spike −28, volume −20,
 *    clamp 0..100, side needs own ≥ minScore AND ≥ opposite + edge.
 *  - All shared penalties (spread, spike, volume) are applied to BOTH scores,
 *    so they cancel in the margin exactly and act only through `minScore`.
 *    This is a property of the design, not a bug in the port — pinned by test.
 *  - `blockers` are labels, NOT vetoes: the side rule never consults them.
 *    A "blocked" bar can still trade if it clears minScore+edge. Pinned by
 *    test so the behaviour cannot silently change.
 *
 * Known defects carried over DELIBERATELY (they are what the lab measures):
 *  - missing order book ⇒ spreadPct falls back to 0 ⇒ the *tight-spread*
 *    +4/+4 bonus fires on absent data (absence is rewarded);
 *  - the gap bonus runs only when useExhaustion is OFF, so the toggle swaps
 *    between two different scorers rather than adding an overlay;
 *  - no warmup guard inside the scorer (the lab enforces MIN_BARS instead).
 *
 * Candle-derived inputs (EMA, ATR over the last 21 candles, range, RSI(7),
 * runs, wicks) come from the 15m bars; snapshot-derived inputs (imbalance,
 * flowBias, spread, funding, volume24) come from the archived L1 ticks that
 * marketData recorded at the same bar close — i.e. exactly what a live
 * `snap` object would have carried. `computeAtrPct`/`candleRangePct` are the
 * same functions the snapshotter uses.
 */

import { rsiSeries } from "./htf-advisor";
import { candleRangePct, computeAtrPct, ema } from "./mexc/indicators";
import type { Kline } from "./mexc/types";

export type CandCandle = {
  open: number;
  high: number;
  low: number;
  close: number;
};

export type CandSettings = {
  emaFast: number;
  emaSlow: number;
  minScore: number;
  /** dominance: winning side must beat the losing side by this much */
  edge: number;
  useExhaustion: boolean;
  useImbalance: boolean;
  useFlow: boolean;
  skipSpike: boolean;
};

export const CAND_EMA_FAST = 8;
export const CAND_EMA_SLOW = 21;

/** All feature overlays ON — the reading that matches the proposal's intent. */
export const CAND_DEFAULT_SETTINGS: CandSettings = {
  emaFast: CAND_EMA_FAST,
  emaSlow: CAND_EMA_SLOW,
  minScore: 64,
  edge: 6,
  useExhaustion: true,
  useImbalance: true,
  useFlow: true,
  skipSpike: true,
};

/** The proposal exactly as written against an empty settings object. */
export const CAND_AS_WRITTEN_SETTINGS: CandSettings = {
  emaFast: CAND_EMA_FAST,
  emaSlow: CAND_EMA_SLOW,
  minScore: 64,
  edge: 6,
  useExhaustion: false,
  useImbalance: false,
  useFlow: false,
  skipSpike: false,
};

export type CandSnap = {
  /** closed 15m bars through the signal bar (warmup enforced by caller) */
  candles: CandCandle[];
  lastPrice: number;
  imbalance: number;
  flowBias: number;
  spreadPct: number;
  /** resolved funding; 0/undefined-neutral when the snapshot flagged stale */
  fundingRate: number;
  volume24: number;
};

/**
 * Everything in the score that does NOT depend on the swept settings.
 * Precomputed once per (bar, EMA pair) — the sweep is then pure arithmetic.
 */
export type CandFeatures = {
  emaFast: number;
  emaSlow: number;
  emaGap: number; // % of slow EMA
  atrPct: number; // computeAtrPct over the last 21 candles (proposal: slice(-21))
  rangePct: number; // candleRangePct of the signal candle
  extAtr: number; // extension of price beyond slow EMA, in ATR units
  run: number; // signed consecutive-close streak, capped at ±6
  rsi7: number; // RSI(7); 50 when undefined (no term fires either way)
  wickUpper: number;
  wickLower: number;
  imbalance: number;
  flowBias: number;
  spreadPct: number;
  fundingRate: number;
  volume24: number;
  /** exhaustion overlay totals (θ-independent: fixed thresholds) */
  exhLong: number;
  exhShort: number;
  exhBlockers: string[];
  exhReasons: string[];
};

export type CandDecision = {
  longScore: number;
  shortScore: number;
  side: "LONG" | "SHORT" | null;
  reasons: string[];
  blockers: string[];
};

const clamp = (n: number, a: number, b: number): number => Math.max(a, Math.min(b, n));

/** Signed streak of consecutive directional closes ending at the last bar. */
export function closeRun(candles: CandCandle[], cap: number): number {
  let run = 0;
  let sign = 0;
  for (let i = candles.length - 1; i > 0; i--) {
    if (Math.abs(run) >= cap) break;
    const d = candles[i]!.close - candles[i - 1]!.close;
    if (d === 0) break;
    const s = d > 0 ? 1 : -1;
    if (sign === 0) {
      sign = s;
      run = s;
    } else if (s !== sign) {
      break;
    } else {
      run += s;
    }
  }
  return run;
}

/** Upper/lower wick share of the candle's full range (0 when range is 0). */
export function wickShare(c: CandCandle): { upper: number; lower: number } {
  const range = c.high - c.low;
  if (!(range > 0)) return { upper: 0, lower: 0 };
  const bodyTop = Math.max(c.open, c.close);
  const bodyBottom = Math.min(c.open, c.close);
  return {
    upper: (c.high - bodyTop) / range,
    lower: (bodyBottom - c.low) / range,
  };
}

const exhausted = (
  n: number,
  why: string,
  block: boolean,
  long: boolean,
  acc: { l: number; s: number; blockers: string[]; reasons: string[] },
): void => {
  if (long) acc.l += n;
  else acc.s += n;
  if (block) acc.blockers.push(why);
  else if (n > 0 || n < -8) acc.reasons.push(why);
};

/** θ-independent feature extraction. Returns null on insufficient history. */
export function candFeatures(snap: CandSnap, fastLen = CAND_EMA_FAST, slowLen = CAND_EMA_SLOW): CandFeatures | null {
  const candles = snap.candles;
  if (candles.length < 22) return null; // ATR(14) over slice(-21) needs 14+ bars with TR
  const closes = candles.map((c) => c.close);
  const fastSeries = ema(closes, Math.max(2, fastLen));
  const slowSeries = ema(closes, Math.max(Math.max(2, fastLen) + 1, slowLen));
  const emaFast = fastSeries[fastSeries.length - 1]!;
  const emaSlow = slowSeries[slowSeries.length - 1]!;
  if (!Number.isFinite(emaFast) || !Number.isFinite(emaSlow)) return null;

  // computeAtrPct/candleRangePct type their input as a full Kline but read
  // only OHLC — the proposal's own candles carry exactly that shape.
  const atrPct = computeAtrPct(candles.slice(-21) as unknown as Kline[]);
  const lastCandle = candles[candles.length - 1]!;
  const rangePct = candleRangePct(lastCandle as unknown as Kline);
  const emaGap = emaSlow !== 0 ? ((emaFast - emaSlow) / emaSlow) * 100 : 0;

  // exhaustion coordinates (proposal: applyExhaustion preamble)
  const atrEff = Math.max(atrPct, 0.04);
  const extPct = emaSlow !== 0 ? ((snap.lastPrice - emaSlow) / emaSlow) * 100 : 0;
  const extAtr = extPct / atrEff;
  const run = closeRun(candles, 6);
  const rsiRaw = rsiSeries(closes, 7)[closes.length - 1];
  const rsi7 = rsiRaw !== undefined && Number.isFinite(rsiRaw) ? rsiRaw : 50;
  const wicks = wickShare(lastCandle);

  const longTrend = emaFast > emaSlow;
  const shortTrend = emaFast < emaSlow;
  const acc = { l: 0, s: 0, blockers: [] as string[], reasons: [] as string[] };

  if (longTrend && extAtr > -0.2 && extAtr < 0.55) exhausted(8, "dip into rising EMA", false, true, acc);
  if (shortTrend && extAtr < 0.2 && extAtr > -0.55) exhausted(8, "bounce into falling EMA", false, false, acc);

  if (extAtr >= 2.0) exhausted(-22, "stretched above EMA", true, true, acc);
  else if (extAtr >= 1.25) exhausted(-16, "extended above EMA", false, true, acc);
  if (extAtr <= -2.0) exhausted(-22, "stretched below EMA", true, false, acc);
  else if (extAtr <= -1.25) exhausted(-16, "extended below EMA", false, false, acc);

  if (run >= 5) exhausted(-20, `${run}-bar up run`, true, true, acc);
  else if (run >= 3) exhausted(-12, `${run}-bar up run`, false, true, acc);
  if (run <= -5) exhausted(-20, `${-run}-bar down run`, true, false, acc);
  else if (run <= -3) exhausted(-12, `${-run}-bar down run`, false, false, acc);

  if (rsi7 >= 80) exhausted(-18, `RSI ${rsi7.toFixed(0)} exhaustion`, true, true, acc);
  else if (rsi7 >= 70) exhausted(-10, `RSI ${rsi7.toFixed(0)} hot`, false, true, acc);
  if (rsi7 <= 20) exhausted(-18, `RSI ${rsi7.toFixed(0)} exhaustion`, true, false, acc);
  else if (rsi7 <= 30) exhausted(-10, `RSI ${rsi7.toFixed(0)} washed out`, false, false, acc);

  if (rangePct > atrEff * 0.5) {
    if (wicks.upper >= 0.58) {
      exhausted(-14, "upper wick", false, true, acc);
      if (wicks.upper >= 0.7) exhausted(-8, "shooting star", true, true, acc);
    }
    if (wicks.lower >= 0.58) {
      exhausted(-14, "lower wick", false, false, acc);
      if (wicks.lower >= 0.7) exhausted(-8, "hammer", true, false, acc);
    }
  }

  return {
    emaFast,
    emaSlow,
    emaGap,
    atrPct,
    rangePct,
    extAtr,
    run,
    rsi7,
    wickUpper: wicks.upper,
    wickLower: wicks.lower,
    imbalance: snap.imbalance,
    flowBias: snap.flowBias,
    spreadPct: snap.spreadPct,
    fundingRate: snap.fundingRate,
    volume24: snap.volume24,
    exhLong: acc.l,
    exhShort: acc.s,
    exhBlockers: acc.blockers,
    exhReasons: acc.reasons,
  };
}

/** The proposal's side rule + score assembly, on precomputed features. */
export function scoreCandidate(f: CandFeatures, s: CandSettings): CandDecision {
  let longScore = 50;
  let shortScore = 50;
  const reasons: string[] = [];
  const blockers: string[] = [];

  if (f.emaFast > f.emaSlow) {
    longScore += 16;
    shortScore -= 10;
    reasons.push(`EMA ${s.emaFast} above ${s.emaSlow}`);
  } else if (f.emaFast < f.emaSlow) {
    shortScore += 16;
    longScore -= 10;
    reasons.push(`EMA ${s.emaFast} below ${s.emaSlow}`);
  }

  // NOTE the inversion (carried from the proposal): the gap bonus exists only
  // when the exhaustion overlay is OFF.
  if (!s.useExhaustion) {
    if (f.emaGap > 0.04) longScore += 6;
    if (f.emaGap < -0.04) shortScore += 6;
  }

  if (s.useImbalance) {
    longScore += f.imbalance * 22;
    shortScore -= f.imbalance * 22;
  }
  if (s.useFlow) {
    longScore += f.flowBias * 22;
    shortScore -= f.flowBias * 22;
  }

  if (f.fundingRate < 0) longScore += 6;
  else if (f.fundingRate > 0.0002) shortScore += 6;

  if (f.spreadPct < 0.04) {
    longScore += 4;
    shortScore += 4;
  } else if (f.spreadPct > 0.12) {
    longScore -= 14;
    shortScore -= 14;
    blockers.push("wide spread");
  }

  if (s.skipSpike && f.rangePct > 2.4 * Math.max(f.atrPct, 0.05)) {
    longScore -= 28;
    shortScore -= 28;
    blockers.push("ATR spike");
  }

  if (s.useExhaustion) {
    longScore += f.exhLong;
    shortScore += f.exhShort;
    blockers.push(...f.exhBlockers);
    reasons.push(...f.exhReasons);
  }

  if (!(f.volume24 > 0)) {
    longScore -= 20;
    shortScore -= 20;
    blockers.push("no 24h volume");
  }

  longScore = clamp(longScore, 0, 100);
  shortScore = clamp(shortScore, 0, 100);

  // Blockers are labels only — the proposal's side rule never reads them.
  let side: "LONG" | "SHORT" | null = null;
  if (longScore >= s.minScore && longScore >= shortScore + s.edge) side = "LONG";
  else if (shortScore >= s.minScore && shortScore >= longScore + s.edge) side = "SHORT";

  return { longScore, shortScore, side, reasons, blockers };
}
