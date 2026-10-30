/**
 * DEAD-CHANNEL 1H ADVISOR — pure veto logic (2026-09-26, lab-pure).
 *
 * Designed from measurement, frozen before validation. The mining pass:
 *
 *   Single 1H bar anatomy (range expansion, close-position, run length, body
 *   ratio, outside bars, EMA20 extension) separated cohorts by ≤0.13 ATR of
 *   MAE — nothing veto-grade. What DID separate, on 157k trend-context
 *   entries over 120d × 14 pairs with the book's own exit (1.5% SL, R-lock
 *   1.5/0.25/6, 32-bar horizon, base +0.059 R/t):
 *
 *     channel position (dir-aware, 20-bar 1H Donchian) × trend age
 *     (bars since the 1H close last crossed its own EMA20):
 *
 *       chanMid|old   +0.186 R/t   (the reload: old trend, pullback to mid)
 *       chanLow|old   +0.113
 *       chanBot|young +0.079
 *       chanBot|old   −0.097  WR 38.9%   ← the dead channel bottom
 *       chanBot|mid   −0.038
 *
 *   THE RULE (frozen before the half-split was run): veto LONG-in-uptrend /
 *   SHORT-in-downtrend entries when the HTF close sits in the bottom 35% of
 *   its own direction-aware 20-bar channel AND the 1H trend is ≥18 bars old.
 *   Interpretation: a stale trend whose price is pressing the channel
 *   extreme against the trend — the deepest, tirest part of a move that no
 *   longer has structure behind it. Measured cohort: −0.097 R/t on 12,760
 *   entries.
 *
 * HONEST CAVEAT STAMPED AT DESIGN TIME: the half-split came out SPLIT —
 * half 1 vetoed cohort +0.135 (rule wrong in H1), half 2 −0.233 (rule right
 * in H2). That is NOT a validated advisor; it is a hypothesis with one good
 * half. The full-stack lab (run-setup-quality-advisor-lab.ts pattern) and a
 * longer window must both clear before this ships anywhere.
 *
 * Causality: reads only the 1H bars that closed at or before the decision
 * time (the advisor family's sampling convention). Pure — no I/O, no clock.
 */

/** Trend age in 1H bars: distance since the close last crossed its own EMA20. */
export function trendAge(closes: readonly number[], emaPeriod = 20): number | null {
  if (closes.length < emaPeriod + 2) return null;
  const k = 2 / (emaPeriod + 1);
  let ema = closes[0]!;
  let lastCross = 0;
  let prevSide = 0;
  for (let i = 0; i < closes.length; i++) {
    ema = closes[i]! * k + ema * (1 - k);
    const side = Math.sign(closes[i]! - ema);
    if (i > 0 && side !== 0 && side !== prevSide) lastCross = i;
    if (side !== 0) prevSide = side;
  }
  return closes.length - 1 - lastCross;
}

/** Donchian position of the last close within the last `period` bars:
 *  1 = at the channel top, 0 = at the channel bottom. */
export function channelPosition(
  bars: readonly { high: number; low: number; close: number }[],
  period = 20,
): number | null {
  if (bars.length < period) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = bars.length - period; i < bars.length; i++) {
    hi = Math.max(hi, bars[i]!.high);
    lo = Math.min(lo, bars[i]!.low);
  }
  const width = hi - lo;
  if (!(width > 0)) return 0.5;
  return (bars[bars.length - 1]!.close - lo) / width;
}

export const DEAD_CHANNEL = {
  /** Direction-aware channel position below which the setup is "pressing the
   *  extreme against the trend". */
  channelFloor: 0.35,
  /** 1H bars since the last EMA20 cross beyond which the trend is stale. */
  staleAgeBars: 18,
  /** Donchian lookback on 1H bars. */
  channelPeriod: 20,
} as const;

/** Overridable param shape (the coverage-sweep contract: `typeof` literals
 *  would make every field a literal type no caller could widen). */
export type DeadChannelParams = { [K in keyof typeof DEAD_CHANNEL]: number };

export interface DeadChannelInput {
  /** 1H bars that had CLOSED at or before the decision time, oldest first. */
  bars1h: readonly { high: number; low: number; close: number }[];
  side: "LONG" | "SHORT";
  params?: Partial<DeadChannelParams>;
}

export interface DeadChannelVerdict {
  veto: boolean;
  channelPos: number | null;
  dirChannelPos: number | null;
  age: number | null;
  reason: string | null;
}

/**
 * The verdict: veto when the direction-aware channel position is below the
 * floor AND the trend is at least `staleAgeBars` 1H bars old. Missing data
 * fails OPEN (no veto) — the advisor family's contract.
 */
export function deadChannelVerdict(input: DeadChannelInput): DeadChannelVerdict {
  const p = { ...DEAD_CHANNEL, ...input.params };
  const { bars1h, side } = input;
  const age = trendAge(bars1h.map((b) => b.close), 20);
  const pos = channelPosition(bars1h, p.channelPeriod);
  if (age == null || pos == null) {
    return { veto: false, channelPos: pos, dirChannelPos: null, age, reason: null };
  }
  const dirPos = side === "LONG" ? pos : 1 - pos;
  const veto = dirPos < p.channelFloor && age >= p.staleAgeBars;
  return {
    veto,
    channelPos: pos,
    dirChannelPos: dirPos,
    age,
    reason: veto
      ? `dead-channel: dir-channel-pos ${dirPos.toFixed(2)} < ${p.channelFloor} with 1H trend ${age} bars old (stale extreme-press)`
      : null,
  };
}
