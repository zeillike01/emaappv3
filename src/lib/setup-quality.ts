/**
 * SETUP QUALITY — two novel scoring features (2026-09-26, lab-pure).
 *
 * Designed from measurement, not decoration. The mining pass behind them:
 *
 *   1. The closed paper ledger (433 rows) conditional means: the bleed
 *      concentrates in HIGH-volatility entries (ATR% terciles 0.578 / 0.359 /
 *      0.246 R/t) and the churn terciles mirror it — entries made while the
 *      tape is hot lose ~2.3× per trade vs calm-tape entries.
 *   2. The kline probes over 120 days × 14 pairs: the 15m Kaufman Efficiency
 *      Ratio ER(10) is the one feature with a clean monotone gradient on
 *      trade-direction drift — but INVERTED for this book: low-ER entries
 *      (pullbacks inside quiet tape) carry the R-lock's rung economics; ER≥0.40
 *      entries are the chase cohort (WR 42.1% vs 44.5%, worst both halves).
 *   3. The second feature targets the chase directly: the SIGNAL BAR'S OWN
 *      geometry — a bar that closes in the top 25% of its range in the trend
 *      direction is a chased breakout (P(win) 44.4%, fwd med −0.165 ATR vs
 *      −0.027 for a pullback close). Its cost concentrates in MAE: the
 *      ER≥0.35 × chase bucket shows the worst adverse excursion (med 1.83 ATR).
 *
 * BOTH features are causal (signal bar and earlier only) and kline-derivable —
 * no order book, no funding, no L1 dependency, so they can be scored everywhere
 * the engine already has bars.
 *
 * LAB-ONLY until they clear the house promotion bar.
 */
import type { Kline } from "./types";

/** Signed with-trend close position of the signal bar: 1 = closed at the far
 *  extreme in the trade direction, 0 = closed against it. */
export function signalBarClosePosition(bars: readonly Kline[], side: "LONG" | "SHORT"): number | null {
  const n = bars.length;
  if (n === 0) return null;
  const b = bars[n - 1]!;
  const range = b.high - b.low;
  if (!(range > 0)) return 0.5; // doji: no information, neutral
  const raw = (b.close - b.low) / range;
  return side === "LONG" ? raw : 1 - raw;
}

/** Efficiency ratio ER(10): |net move| / path length over the last `period`
 *  closed bars, ending at the signal bar. 0 = pure chop, 1 = pure trend. */
export function efficiencyRatio(bars: readonly Kline[], period = 10): number | null {
  if (bars.length < period + 1) return null;
  let path = 0;
  for (let i = bars.length - period + 1; i < bars.length; i++) {
    path += Math.abs(bars[i]!.close - bars[i - 1]!.close);
  }
  const net = Math.abs(bars[bars.length - 1]!.close - bars[bars.length - 1 - period]!.close);
  return path > 0 ? net / path : null;
}

/** ── FEATURE 1: DRIFT-REGIME TERM (the ER gradient, inverted for this book) ──
 *  Low ER (quiet pullback tape) is where the R-lock earns; high ER is the chase
 *  cohort. Bands measured, monotone in both halves (R/t pooled):
 *    ER < 0.15 → +6   0.15-0.25 → +4   0.25-0.40 → +2   ≥ 0.40 → −6
 */
export function driftRegimePoints(er: number | null): number {
  if (er == null) return 0; // fail neutral
  if (er < 0.15) return 6;
  if (er < 0.25) return 4;
  if (er < 0.4) return 2;
  return -6;
}

/** ── FEATURE 2: CHASE-PENALTY TERM (signal-bar geometry) ──────────────────
 *  A with-trend close in the top of the bar's range = the bot is buying the
 *  breakout candle; measured worst bucket on every horizon. Bands:
 *    pos ≥ 0.75 → −8 (chase)   0.5-0.75 → −2   0.35-0.5 → +2   ≤ 0.35 → +5
 *  (pullback close = the entry the book's own stop-out audit called good.)
 */
export function chasePenaltyPoints(closePos: number | null): number {
  if (closePos == null) return 0;
  if (closePos >= 0.75) return -8;
  if (closePos >= 0.5) return -2;
  if (closePos >= 0.35) return 2;
  return 5;
}

export interface SetupQuality {
  er: number | null;
  closePos: number | null;
  driftRegime: number;
  chasePenalty: number;
  total: number;
}

export function setupQuality(bars: readonly Kline[], side: "LONG" | "SHORT"): SetupQuality {
  const er = efficiencyRatio(bars, 10);
  const closePos = signalBarClosePosition(bars, side);
  const driftRegime = driftRegimePoints(er);
  const chasePenalty = chasePenaltyPoints(closePos);
  return { er, closePos, driftRegime, chasePenalty, total: driftRegime + chasePenalty };
}
