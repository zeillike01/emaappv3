/**
 * D1 SHADOW TAGS v3 (2026-09-26) — the two survivors of the family sweep.
 *
 * Pedigree (labs, 2026-09-26, 92-day full-stack baseline, 754 longs):
 *   phase 1  run-d1-family-sweep.ts        — 7 daily families bucketed;
 *                                            rejection wicks and the 5d
 *                                            drift-down dead zone were the
 *                                            two coherent bleed bands.
 *   phase 2  run-d1-family-deletion-lab.ts — the four-family combo deleted
 *                                            335 trades of −56.3R (t=2.28)
 *                                            but FAILED robustness.
 *   phase 3  run-d1-family-robustness.ts   — leave-one-out: wick + dead-zone
 *                                            ALONE deletes 223 trades of
 *                                            −46.5R, book +0.027→+0.126 R/t,
 *                                            paired-day t=2.52. The other
 *                                            pairs did not reach
 *                                            significance, and every
 *                                            threshold wiggle dropped below
 *                                            the bar — which is exactly why
 *                                            these ship as SHADOW TAGS, not
 *                                            gates: the forward record is
 *                                            the tiebreaker between
 *                                            "fragile artifact" and
 *                                            "regime-dependent edge".
 *
 * THE TWO TAGS (LONG-only; the short book has ~27 rows — no thresholds
 * earned there):
 *   d1-rejection-wick — the last CLOSED daily candle's upper wick spans
 *                       ≥45% of its range: buyers pressed the high and were
 *                       rejected. Longs entered right after one lost
 *                       (−0.157 R/t, 35% WR, n=156).
 *   d1-dead-zone      — price drifted down 3–8% over the last 5 daily
 *                       closes: neither crashed (that cohort WON +0.474) nor
 *                       flat — the slow-bleed drift. Longs entered inside
 *                       it lost (−0.360 R/t, 28% WR, n=92).
 *
 * CONTRACT: pure functions, no I/O, nothing gates or scores on these tags.
 * Missing/daily-bar-short history → no tags (fail-open). Closed 1d bars
 * only — the caller filters `closeTime <= now` and this module re-filters
 * defensively. Thresholds are the lab's exact measured bands, exported as
 * constants.
 */

import { stochRsiSeries } from "./htf-advisor";

/** The last closed daily candle's upper wick as % of its range at/above this. */
export const D1_REJECTION_WICK_PCT = 45;
/** Dead-zone edges: 5-day return between −8% and −3%. */
export const D1_DEAD_ZONE_LO_PCT = -8;
export const D1_DEAD_ZONE_HI_PCT = -3;
/** Swing window for sweep detection (days before the signal day). */
export const D1_SWING_LOOKBACK = 20;
/** Minimum closed daily bars for any reading (warm-up margin). */
export const D1_MIN_BARS = 55;

export const SHADOW_TAG_D1_REJECTION_WICK = "d1-rejection-wick";
export const SHADOW_TAG_D1_DEAD_ZONE = "d1-dead-zone";
/**
 * Sweep-context tags (2026-09-26 sweep lab, run-d1-sweep-lab.ts): a wick
 * >=45% AT a prior 20d swing high (+0.119, n=32) is a DIFFERENT animal from
 * the same wick mid-range (-0.229, n=124) - the journal splits the wick
 * cohort by this tag. Spring (sweep of the 20d low then reclaim) is n=7:
 * recorded so the forward record accumulates, never read.
 */
export const SHADOW_TAG_D1_SWEEP_HIGH = "d1-sweep-high";
export const SHADOW_TAG_D1_SPRING_LOW = "d1-spring-low";

// ── d1-stoch-exhaust (2026-09-28, candidate — see DD note at §7 of
// DAILY_ADVISOR_JOURNAL.md and the Sep 27–28 drawdown audit) ──
// LONG taken while the daily StochRSI %K (14/14/3/3 — the SHIPPED
// stochRsiSeries behind the 4H advisor) is ≥ 75. Measured on the Sep 27–28
// drawdown: LONG & dK≥75 & price ≤4% above the 4H EMA20 = 19 trades, −0.99
// R/t, 0% wins (paper+live). The FULL combined condition (both clauses) is
// what the audit priced; the tag records the %K clause alone, and the audit's
// exact combo is recorded separately via d1StochK + the 4H distance so the
// forward record can price BOTH forms without re-deriving history.
export const D1_STOCH_EXHAUST_K = 75;
export const SHADOW_TAG_D1_STOCH_EXHAUST = "d1-stoch-exhaust";

/** Minimal daily bar shape the caller supplies (MEXC kline, oldest→newest). */
export type D1Bar = {
  openTime: number;
  closeTime: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/** The daily numbers the tags read, as of the newest CLOSED bar. */
export type D1Reading = {
  barOpenTime: number;
  /** Upper wick of the last closed daily bar as % of its range (0..100). */
  upWickPct: number;
  /** 5-day return of the daily closes, % (negative = drifting down). */
  r5Pct: number;
  /** True when the day exceeded the prior 20d high but closed back below it. */
  highSweep: boolean;
  /** True when the day pierced the prior 20d low but closed back above it. */
  lowReclaim: boolean;
  /** Daily StochRSI %K (14/14/3/3, shipped stochRsiSeries) on the last
   *  closed daily bar. null when the series cannot produce a reading. */
  dStochK: number | null;
};

/**
 * The reading from daily bars (oldest→newest). Re-filters `closeTime <= now`
 * defensively. Returns null below D1_MIN_BARS — fail-open, never a block.
 */
export function d1ReadingFromKlines(bars: readonly D1Bar[], nowMs: number): D1Reading | null {
  const closed = bars.filter((b) => b.closeTime <= nowMs);
  if (closed.length < D1_MIN_BARS) return null;
  const n = closed.length;
  const last = closed[n - 1]!;
  const prevClose = closed[n - 2]!.close;
  const range = last.high - last.low;
  const c = (k: number) => closed[n - 1 - k]!.close;
  const r5Ref = c(5);
  // Prior-window swing extremes (the signal day's own bar is excluded).
  const prior = closed.slice(n - 1 - D1_SWING_LOOKBACK, n - 1);
  const priorHigh = prior.length ? Math.max(...prior.map((b) => b.high)) : Infinity;
  const priorLow = prior.length ? Math.min(...prior.map((b) => b.low)) : -Infinity;
  // Daily StochRSI %K on the same closed-bar closes (shipped series function).
  // NaN-safe: a series too short for the warm-up leaves the field null.
  const closes = closed.map((b) => b.close);
  const { k } = stochRsiSeries(closes, 14, 14, 3, 3);
  const kLast = k[closes.length - 1];
  return {
    barOpenTime: last.openTime,
    upWickPct: range > 0 ? ((last.high - Math.max(last.close, prevClose)) / range) * 100 : 0,
    r5Pct: r5Ref > 0 ? ((last.close - r5Ref) / r5Ref) * 100 : 0,
    highSweep: last.high > priorHigh && last.close < priorHigh,
    lowReclaim: last.low < priorLow && last.close > priorLow,
    dStochK: Number.isFinite(kLast) ? kLast : null,
  };
}

/**
 * Decision-time tags for a candidate side. Pure, null-safe: a missing
 * reading produces no tags — never a block, never a score. LONG-only by
 * design (the short book never earned thresholds); SHORT records nothing.
 */
export function d1ShadowTags(
  reading: D1Reading | null,
  side: "LONG" | "SHORT",
): { tags: string[]; d1UpWickPct: number | null; d1R5Pct: number | null; d1StochK: number | null } {
  if (!reading) return { tags: [], d1UpWickPct: null, d1R5Pct: null, d1StochK: null };
  const tags: string[] = [];
  if (side === "LONG") {
    if (reading.upWickPct >= D1_REJECTION_WICK_PCT) tags.push(SHADOW_TAG_D1_REJECTION_WICK);
    if (reading.r5Pct >= D1_DEAD_ZONE_LO_PCT && reading.r5Pct <= D1_DEAD_ZONE_HI_PCT) {
      tags.push(SHADOW_TAG_D1_DEAD_ZONE);
    }
    // d1-stoch-exhaust (2026-09-28 candidate): LONG while the daily StochRSI
    // %K is pinned high. Record-only — nothing blocks on it.
    if (reading.dStochK != null && reading.dStochK >= D1_STOCH_EXHAUST_K) {
      tags.push(SHADOW_TAG_D1_STOCH_EXHAUST);
    }
    // Sweep-context tags are LONG-only like the rest (spring is n=7 in the
    // lab - record-only); a sweep fires alongside, never instead of, the wick
    // tag so the journal can split the wick cohort without re-deriving it.
    if (reading.highSweep) tags.push(SHADOW_TAG_D1_SWEEP_HIGH);
    if (reading.lowReclaim) tags.push(SHADOW_TAG_D1_SPRING_LOW);
  }
  return { tags, d1UpWickPct: reading.upWickPct, d1R5Pct: reading.r5Pct, d1StochK: reading.dStochK };
}
