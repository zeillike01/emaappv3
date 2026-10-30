import { atrPctSeries } from "./backtest";
import type { Kline } from "./types";

/**
 * VOLR — VOLATILITY REGIME.
 *
 * WHY THIS EXISTS. The Layer 2 loss diagnosis (run-layer2-loss-diagnosis.ts)
 * found that the single strongest causal, entry-time separator in the real
 * 2-sided population is the pair's volatility at entry. Mean R per trade runs
 * +0.361R in the 0.077–0.106% ATR band and decays to +0.142R above 0.135%,
 * while the stop-out rate climbs from 48% to 59%. The relationship is monotone
 * and held on both walk-forward halves.
 *
 * THE RULE. Rank the pair's current ATR% against its OWN trailing
 * distribution, and refuse entries taken while the pair is unusually volatile
 * FOR ITSELF. This is deliberately relative rather than an absolute ATR cap:
 * 0.2% is unremarkable for a large-cap pair and an emergency for a small one,
 * so a fixed number silently encodes a pair-size bet that the operator never
 * asked for. `rank` is the fraction of the trailing window at or below the
 * current reading, in [0,1]; 1.0 means "the most volatile bar in the window".
 *
 * It is kline-derivable on purpose. The live book has a real-time ATR% from
 * its L1 feed, but a gate that can only be measured live can never be
 * validated, and a gate that cannot be validated is a guess. Computing the
 * same quantity from cached 15m bars is what makes the 92-day backtest
 * possible.
 *
 * CAUSALITY. The window is bounded by `at` (a closed bar's closeTime), so the
 * read cannot see the bar it is being used to judge. A warm-up read (fewer
 * than `minBars` usable trailing values) ALLOWS rather than blocking: refusing
 * every entry until an indicator is warm is a silent outage, not a gate.
 */

export type VolatilityRegimeCfg = {
  /** Trailing bars the rank is measured against. 480 ≈ 5d, 960 ≈ 10d on 15m. */
  lookbackBars: number;
  /** Block when rank > threshold. 0 disables the gate. */
  blockAboveRank: number;
  /** Minimum usable trailing values before a read is trusted. */
  minBars: number;
};

export const VOLATILITY_REGIME_DEFAULTS: VolatilityRegimeCfg = {
  lookbackBars: 480,
  blockAboveRank: 0.8,
  minBars: 100,
};

export type VolatilityRegimeSide = "LONG" | "SHORT";

export type VolatilityRegimeVerdict = "allowed" | "blocked" | "warmup";

export type VolatilityRegimeRead = {
  verdict: VolatilityRegimeVerdict;
  /** ATR% of the bar at `at`, as a fraction of price. */
  atrPct: number | null;
  /** Percentile rank of atrPct within the trailing window, in [0,1]. */
  rank: number | null;
  /** Trailing values the rank was measured over. */
  windowUsed: number;
  reason: string;
};

function cfgOrDefault(cfg: Partial<VolatilityRegimeCfg> | undefined): VolatilityRegimeCfg {
  return {
    lookbackBars: Number.isInteger(cfg?.lookbackBars) && cfg!.lookbackBars! > 0 ? cfg!.lookbackBars! : VOLATILITY_REGIME_DEFAULTS.lookbackBars,
    blockAboveRank: Number.isFinite(cfg?.blockAboveRank) ? cfg!.blockAboveRank! : VOLATILITY_REGIME_DEFAULTS.blockAboveRank,
    minBars: Number.isInteger(cfg?.minBars) && cfg!.minBars! > 0 ? cfg!.minBars! : VOLATILITY_REGIME_DEFAULTS.minBars,
  };
}

/** Index of the last bar whose closeTime <= at, or -1. Binary search. */
function indexAt(bars: readonly Kline[], at: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.closeTime <= at) {
      idx = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return idx;
}

/**
 * Rank the bar at `at` against its own trailing ATR distribution.
 *
 * `at` is the signal candle's closeTime — the first moment the decision is
 * knowable. O(lookback) per call, which is fine because the lab only reads at
 * signal times; computing this for every bar in a 12k-bar series would not be.
 */
export function volatilityRegimeAt(
  bars: readonly Kline[],
  at: number,
  cfg?: Partial<VolatilityRegimeCfg>,
  atr?: readonly number[],
): VolatilityRegimeRead {
  const c = cfgOrDefault(cfg);
  if (c.blockAboveRank <= 0) {
    return { verdict: "allowed", atrPct: null, rank: null, windowUsed: 0, reason: "gate disabled" };
  }
  const i = indexAt(bars, at);
  if (i < 0) {
    return { verdict: "warmup", atrPct: null, rank: null, windowUsed: 0, reason: "no closed bar at or before the read time" };
  }
  const series = atr ?? atrPctSeries(bars as Kline[]);
  const current = series[i];
  if (!Number.isFinite(current)) {
    return { verdict: "warmup", atrPct: null, rank: null, windowUsed: 0, reason: "ATR warm-up incomplete" };
  }
  const from = Math.max(0, i - c.lookbackBars + 1);
  let below = 0;
  let used = 0;
  for (let j = from; j <= i; j++) {
    const v = series[j];
    if (!Number.isFinite(v)) continue;
    used++;
    if (v <= current) below++;
  }
  if (used < c.minBars) {
    return { verdict: "warmup", atrPct: current, rank: null, windowUsed: used, reason: `only ${used} usable trailing ATR values, need ${c.minBars}` };
  }
  const rank = below / used;
  const blocked = rank > c.blockAboveRank;
  return {
    verdict: blocked ? "blocked" : "allowed",
    atrPct: current,
    rank,
    windowUsed: used,
    reason: blocked
      ? `ATR ${(current * 100).toFixed(3)}% sits in the top ${((1 - rank) * 100).toFixed(0)}% of its own last ${used} bars`
      : `ATR rank ${rank.toFixed(2)} inside the ${(c.blockAboveRank * 100).toFixed(0)}% cut`,
  };
}

/** Convenience for callers that only need the boolean. */
export function volatilityRegimeBlocks(
  bars: readonly Kline[],
  at: number,
  cfg?: Partial<VolatilityRegimeCfg>,
  atr?: readonly number[],
): boolean {
  return volatilityRegimeAt(bars, at, cfg, atr).verdict === "blocked";
}
