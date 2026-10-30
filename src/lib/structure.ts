/**
 * MARKET STRUCTURE — causal, pure, closed-bar-only (2026-09-28).
 *
 * Why this exists: every feature the strategy scores on is LOCAL and MARKOVIAN
 * (this bar + a short lookback): EMA5/20, book imbalance, flow bias, ATR, RSI.
 * None of them describes WHERE price is. A human reading a chart is not doing
 * more arithmetic per bar — they are holding a small set of PERSISTENT OBJECTS
 * (levels that were rejected before, the last confirmed swing, whether the
 * universe just broke or just failed) and comparing the current bar against
 * them. That is the representational gap this module fills.
 *
 * THREE PRIMITIVES, TWO PARAMETERS (deliberately minimal):
 *   · confirmed swings   — fractal pivots, `lookback` bars each side
 *   · levels with memory — swings clustered within `zoneTolAtr` × ATR
 *   · two events         — BOS/CHoCH (a close beyond the last swing) and a
 *                          sweep (a wick beyond it that closes back inside)
 * Parameters: `lookback` and `zoneTolAtr`. That is the whole surface. The full
 * SMC toolkit (order blocks, FVGs, premium/discount, equal-highs) runs to ~15
 * parameters; this repo has already buried nine tuned gates, so the smaller
 * surface is the point, not a shortcut.
 *
 * ══ THE CAUSAL CONTRACT (read this before changing anything) ══
 * A pivot is DEFINITIONALLY hindsight: a swing high is a swing high only
 * because nothing after it exceeded it. So any function here MUST read only
 * bars[0..index] and must never see bar index+1. `structureAt(bars, index)`
 * satisfies this by construction: `findSwings` only emits pivots with
 * `lookback` confirming bars available INSIDE the slice, and nothing else in
 * this file indexes past `index`.
 *
 * The property is pinned by a unit test (structure.test.ts): computing at time
 * t from a TRUNCATED series must equal computing at t from the full series.
 * That test is what makes this repaint-proof — it is the exact failure mode
 * every ported TradingView market-structure indicator has.
 *
 * RECORD-ONLY. Nothing here gates, sizes, or vetoes anything.
 */

export type StructBar = {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type Swing = { index: number; price: number; time: number; kind: "high" | "low" };
export type LevelSide = "resistance" | "support";
export type Level = { price: number; touches: number; lastTouchIndex: number; side: LevelSide };
export type Trend = "up" | "down" | "range";

export type StructureState = {
  index: number;
  trend: Trend;
  lastSwingHigh: Swing | null;
  lastSwingLow: Swing | null;
  levels: Level[];
  /** A close beyond the last swing IN the prevailing trend — continuation. */
  bos: "up" | "down" | null;
  /** The SAME event against the prevailing trend — a reversal warning. */
  choch: "up" | "down" | null;
  /** A wick through the last swing that closed back inside, on this bar. */
  sweep: "high" | "low" | null;
  atr: number;
};

/** Bars required on EACH side to confirm a swing. */
export const STRUCT_LOOKBACK = 3;
/** Two swings within this × ATR are treated as the same level. */
export const STRUCT_ZONE_TOL_ATR = 0.5;
/** Keep only the N most recently touched levels. */
export const STRUCT_MAX_LEVELS = 3;
export const STRUCT_ATR_PERIOD = 14;

/** True range of a single bar (in price units). Pure, no history needed. */
export function trueRange(bars: readonly StructBar[], index: number): number {
  const b = bars[index];
  if (!b) return 0;
  const prev = bars[index - 1] ?? b;
  return Math.max(
    b.high - b.low,
    Math.abs(b.high - prev.close),
    Math.abs(b.low - prev.close),
  );
}

/** Mean true range over the `period` bars ending at `index` (never looks past it). */
export function atrAt(
  bars: readonly StructBar[],
  index: number,
  period: number = STRUCT_ATR_PERIOD,
): number {
  const from = Math.max(0, index - period + 1);
  let sum = 0;
  let n = 0;
  for (let i = from; i <= index; i++) {
    sum += trueRange(bars, i);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/**
 * Confirmed fractal swings inside bars[0..endIndex].
 *
 * A pivot at `i` requires `lookback` bars on EACH side, so the loop stops at
 * `endIndex - lookback`: the newest pivot this can return is already
 * `lookback` bars old, which IS the confirmation lag a human pays too. No bar
 * after `endIndex` is ever read — that is what keeps this causal.
 */
export function findSwings(
  bars: readonly StructBar[],
  endIndex: number,
  lookback: number = STRUCT_LOOKBACK,
): Swing[] {
  const out: Swing[] = [];
  if (lookback < 1) return out;
  const last = Math.min(endIndex, bars.length - 1);
  for (let i = lookback; i <= last - lookback; i++) {
    const b = bars[i];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= lookback; j++) {
      const l = bars[i - j];
      const r = bars[i + j];
      if (l.high >= b.high || r.high >= b.high) isHigh = false;
      if (l.low <= b.low || r.low <= b.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ index: i, price: b.high, time: b.closeTime, kind: "high" });
    if (isLow) out.push({ index: i, price: b.low, time: b.closeTime, kind: "low" });
  }
  return out;
}

/** HH+HL → up, LH+LL → down, anything else → range. Needs two of each kind. */
export function trendFrom(swings: readonly Swing[]): Trend {
  const highs = swings.filter((s) => s.kind === "high");
  const lows = swings.filter((s) => s.kind === "low");
  if (highs.length < 2 || lows.length < 2) return "range";
  const hN = highs[highs.length - 1].price;
  const hP = highs[highs.length - 2].price;
  const lN = lows[lows.length - 1].price;
  const lP = lows[lows.length - 2].price;
  if (hN > hP && lN > lP) return "up";
  if (hN < hP && lN < lP) return "down";
  return "range";
}

/**
 * Cluster swings into levels ("the same price was rejected twice"). A level
 * carries its own MEMORY — how many times it was touched and when it was last
 * touched — which is the thing a rolling max/min window cannot express.
 */
export function clusterLevels(
  swings: readonly Swing[],
  atr: number,
  refPrice: number,
  tolAtr: number = STRUCT_ZONE_TOL_ATR,
  maxLevels: number = STRUCT_MAX_LEVELS,
): Level[] {
  const tol = atr > 0 ? atr * tolAtr : Math.abs(refPrice) * 0.001;
  const groups: { price: number; touches: number; lastIndex: number }[] = [];
  for (const s of swings) {
    const g = groups.find((x) => Math.abs(x.price - s.price) <= tol);
    if (g) {
      g.price = s.price; // most recent price defines the level
      g.touches += 1;
      g.lastIndex = Math.max(g.lastIndex, s.index);
    } else {
      groups.push({ price: s.price, touches: 1, lastIndex: s.index });
    }
  }
  return groups
    .sort((a, b) => b.lastIndex - a.lastIndex)
    .slice(0, maxLevels)
    .map((g) => ({
      price: g.price,
      touches: g.touches,
      lastTouchIndex: g.lastIndex,
      side: (g.price >= refPrice ? "resistance" : "support") as LevelSide,
    }));
}

/** BOS/CHoCH are the SAME event — a close beyond the last swing — labelled by
 *  the prevailing trend. A sweep is a wick beyond it that closes back inside. */
export function eventsAt(
  bars: readonly StructBar[],
  index: number,
  swings: readonly Swing[],
  trend: Trend,
): { bos: "up" | "down" | null; choch: "up" | "down" | null; sweep: "high" | "low" | null } {
  const b = bars[index];
  let bos: "up" | "down" | null = null;
  let choch: "up" | "down" | null = null;
  let sweep: "high" | "low" | null = null;
  if (!b) return { bos, choch, sweep };

  let lastHigh: Swing | null = null;
  let lastLow: Swing | null = null;
  for (let i = swings.length - 1; i >= 0; i--) {
    if (!lastHigh && swings[i].kind === "high") lastHigh = swings[i];
    if (!lastLow && swings[i].kind === "low") lastLow = swings[i];
    if (lastHigh && lastLow) break;
  }

  if (lastHigh && b.close > lastHigh.price) {
    if (trend === "up") bos = "up";
    else choch = "up";
  } else if (lastLow && b.close < lastLow.price) {
    if (trend === "down") bos = "down";
    else choch = "down";
  }

  // Sweep: pierce the reference wick-first, then close back on the other side.
  if (lastHigh && b.high > lastHigh.price && b.close < lastHigh.price) sweep = "high";
  else if (lastLow && b.low < lastLow.price && b.close > lastLow.price) sweep = "low";

  return { bos, choch, sweep };
}

/**
 * Full structural read at `index`, using ONLY bars[0..index].
 *
 * This is the causal entry point. It is safe to call on a full series at any
 * historical index — the no-lookahead test asserts that calling it on a
 * truncated series gives an identical result.
 */
export function structureAt(
  bars: readonly StructBar[],
  index: number,
  opts: { lookback?: number; tolAtr?: number; maxLevels?: number; atrPeriod?: number } = {},
): StructureState {
  const lookback = opts.lookback ?? STRUCT_LOOKBACK;
  const atr = atrAt(bars, index, opts.atrPeriod ?? STRUCT_ATR_PERIOD);
  const swings = findSwings(bars, index, lookback);
  const trend = trendFrom(swings);
  let lastSwingHigh: Swing | null = null;
  let lastSwingLow: Swing | null = null;
  for (let i = swings.length - 1; i >= 0; i--) {
    if (!lastSwingHigh && swings[i].kind === "high") lastSwingHigh = swings[i];
    if (!lastSwingLow && swings[i].kind === "low") lastSwingLow = swings[i];
    if (lastSwingHigh && lastSwingLow) break;
  }
  const ref = bars[index]?.close ?? 0;
  const levels = clusterLevels(swings, atr, ref, opts.tolAtr ?? STRUCT_ZONE_TOL_ATR, opts.maxLevels);
  const { bos, choch, sweep } = eventsAt(bars, index, swings, trend);
  return { index, trend, lastSwingHigh, lastSwingLow, levels, bos, choch, sweep, atr };
}

/** The nearest active level, and its distance from `price`. */
export function nearestLevel(
  s: StructureState,
  price: number,
): { level: Level; dist: number } | null {
  let best: { level: Level; dist: number } | null = null;
  for (const l of s.levels) {
    const d = Math.abs(l.price - price);
    if (!best || d < best.dist) best = { level: l, dist: d };
  }
  return best;
}

/** The level price is SITTING ON (within tolAtr × ATR), or null. */
export function atLevel(
  s: StructureState,
  price: number,
  tolAtr: number = STRUCT_ZONE_TOL_ATR,
): Level | null {
  const tol = s.atr > 0 ? s.atr * tolAtr : 0;
  if (!(tol > 0)) return null;
  const near = nearestLevel(s, price);
  return near && near.dist <= tol ? near.level : null;
}

/**
 * How many R of ROOM the trade has before it runs into the nearest opposing
 * level — the one quantity here with a NATURAL UNIT, which is why it is the
 * only structure term worth scoring later.
 *
 *   LONG  → nearest level ABOVE entry (a resistance caps the move)
 *   SHORT → nearest level BELOW entry (a support caps the move)
 *
 * Returns null when nothing is in the way (clear runway — its own bucket).
 */
export function rToNextOpposingLevel(
  s: StructureState,
  side: "LONG" | "SHORT",
  entry: number,
  stop: number,
): number | null {
  const risk = side === "LONG" ? entry - stop : stop - entry;
  if (!(risk > 0) || !(entry > 0)) return null;
  let best: number | null = null;
  for (const l of s.levels) {
    const adverse = side === "LONG" ? l.price > entry : l.price < entry;
    if (!adverse) continue;
    const dist = side === "LONG" ? l.price - entry : entry - l.price;
    if (best == null || dist < best) best = dist;
  }
  return best == null ? null : best / risk;
}

/** Tags in the house `shadowTags` idiom. One tag per structural fact. */
export function structTags(s: StructureState, side: "LONG" | "SHORT"): string[] {
  const tags: string[] = [`struct-${s.trend}`];
  if (s.bos) tags.push(`struct-bos-${s.bos}`);
  if (s.choch) tags.push(`struct-choch-${s.choch}`);
  if (s.sweep) tags.push(`struct-sweep-${s.sweep}`);
  return tags;
}

/** Structural agreement between the read and the side being considered. */
export function structAgrees(s: StructureState, side: "LONG" | "SHORT"): boolean {
  return side === "LONG" ? s.trend === "up" : s.trend === "down";
}
