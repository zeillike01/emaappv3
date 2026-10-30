/**
 * S/R + IMBALANCE + RSI — 15m ENTRY SCORER (pure, no I/O).
 *
 * Implements Steps 1-8 of the specification: zone detection off 4H and 1H
 * swings, fair-value-gap fallback, 15m RSI confluence, a 0-100 composite with
 * two hard gates, and the output row. Nothing here reads the database, the
 * config, or the clock — every function is total in its arguments, which is
 * what makes Step 14's "unit test on hand-labelled candles" possible.
 *
 * WHY IT IS PURE AND UNWIRED (2026-09-26): the spec's own rollout says Phase 1
 * is pure functions + tests, Phase 2 is log every score over real history, and
 * Phase 3 is pick the threshold FROM the resulting distribution. That order
 * matters here specifically — this project has already shipped two fitted
 * composites that fell apart out of sample (`arm-score-lab.json`: in-sample PF
 * 1.49, out-of-sample 1.326 vs 1.326, a coin flip; and the composite A+ tier,
 * 82nd percentile against a size-matched null where 95th was required). Both
 * picked the weights FIRST and priced them SECOND. This module deliberately
 * carries no threshold authority: SR_PARAMS holds the spec's starting values
 * and nothing has been tuned.
 *
 * WHAT OUR OWN BOOK ALREADY SAYS about three of the seven score components —
 * not a reason to skip the build, but the prior to hold in mind:
 *   distToSwingSr  r=0.002  z=0.04   (closest proxy to "location")
 *   atrPctAtEntry  r=-0.069 z=-1.24  (volatility)
 *   htfVol4h       r=0.011  z=0.19   (volume confirmation)
 * All three measured at or near zero on 468 closed paper trades. Zone
 * detection here is richer than any of those fields, so this is not a repeat —
 * but the momentum and volatility halves of the score are the parts the
 * existing evidence argues against, and the lab must be able to attribute a
 * result to a COMPONENT, not just to the total.
 */
import type { Kline } from "./types";

// ── Step 11: parameters (the spec's starting values — NOT tuned) ───────────
export const SR_PARAMS = {
  swingLookback4H: 3,
  swingLookback1H: 2,
  zoneWidthATRMult: 0.5,
  zoneMergeATRMult: 0.25,
  zoneStrengthMin: 3,
  fvgStrengthMin: 0.5,
  rsiPeriod: 14,
  volumeHigh: 1.5,
  volumeLow: 0.8,
  fireThresholdAplus: 75,
  fireThresholdB: 60,
  counterTrendCap: 50,
  volumeSmaPeriod: 20,
  recencyBars: 50,
  atrPeriod: 14,
} as const;

/**
 * SCORE WEIGHTS — the 2026-09-26 rebalance. Separate from SR_PARAMS on purpose:
 * SR_PARAMS holds the spec's tunable numeric defaults (Step 11), while this is
 * the model's shape. Both are pinned by test and dumped into the lab artifact,
 * so neither can drift silently.
 *
 * Old → new: base 30→25, location max 25→35, strength max 10→15, HTF ±20→±10,
 * RSI ±20→±10. Location + strength now carry 50 of the 110 available points, so
 * a weak zone can no longer be carried by a strong RSI. Bands INSIDE each factor
 * are the old ones scaled by the new max, which preserves the spec's ordering: a
 * dual-TF zone still beats a strong FVG, and a strong FVG still beats a
 * single-TF zone.
 *
 * WHY THE MEASUREMENT MATTERS: the lab scored 40,654 candles with the previous
 * table and found A+ firing on 21.2% of them (678/week against a spec
 * expectation of 2-5). Rebalancing the terms changes where the mass sits but NOT
 * automatically the fire rate — the sum of maxima grew 100 → 110, so a fixed
 * threshold of 75 sits lower in the distribution than it used to. The lab
 * re-measures rather than assuming the tail moved where the intent pointed.
 */
export const SR_WEIGHTS = {
  base: 25,
  location: {
    /** AT_ZONE with a 1H zone also holding the price (the spec's +25). */
    dualTf: 35,
    /** AT_ZONE matched on one timeframe only (the spec's +15). */
    atZoneSingleTf: 21,
    /** NEAR_ZONE (the spec's +10). */
    nearZone: 14,
    /** AT_FVG at >= fvgStrengthMin (the spec's +20). */
    fvgStrong: 28,
    /** AT_FVG weaker than fvgStrengthMin (the spec's +8). */
    fvgWeak: 11,
  },
  zoneStrength: {
    /** strength >= 4 (the spec's +10, scaled 1.5x). */
    ge4: 15,
    /** strength == 3 (the spec's +5 → 7.5, rounded to 8). */
    eq3: 8,
  },
  htf: { withTrend: 10, neutral: 0, counterTrend: -10 },
  /**
   * Bands are the spec's, halved. The mild band (RSI 50-65 for a long) lands on
   * 0 rather than a rounded 2.5 — the table stays integral and symmetric, and a
   * reading that is merely not-extended should not add points at all.
   */
  rsi: { best: 10, good: 5, mild: 0, extended: -5, exhausted: -10, divergenceBonus: 5 },
  volume: { high: 10, low: -10 },
  candle: { with: 5, against: -10 },
} as const;

export type SrWeights = typeof SR_WEIGHTS;
/**
 * SR_PARAMS' shape with plain number fields. `typeof SR_PARAMS` would make every
 * field a LITERAL type (it is `as const`), so no caller could ever override one —
 * which is exactly what a coverage comparison needs to do. The defaults stay
 * pinned to the spec by SR_PARAMS itself and by test.
 */
export type SrParams = { [K in keyof typeof SR_PARAMS]: number };
export type Tf = "4H" | "1H";
export type Side = "long" | "short";
export type Location = "AT_ZONE" | "NEAR_ZONE" | "AT_FVG" | "NOWHERE";
export type Tier = "A+" | "B" | "skip";

export interface Swing {
  index: number;
  price: number;
  kind: "high" | "low";
}

export interface Zone {
  tf: Tf;
  high: number;
  low: number;
  strength: number;
  touchCount: number;
  /** Index of the most recent swing inside the merged band. */
  lastTouchIndex: number;
}

export interface Fvg {
  kind: "bullish" | "bearish";
  /** Gap band. */
  high: number;
  low: number;
  index: number;
  filled: boolean;
  /** gapSize / ATR(15m) */
  strength: number;
}

// ── Indicators ────────────────────────────────────────────────────────────

/**
 * Wilder-smoothed RSI as a SERIES, one value per bar (null until seeded).
 *
 * Same recursion as the repo's `wilderRsi` (src/lib/wilder-rsi.ts), which
 * returns the final bar only. This exists because a scan needs a reading at
 * every candle AND at the last five for divergence — calling the single-value
 * version per bar is O(n^2) and unusable over 35k candles. `sr-imbalance.test`
 * asserts the two agree at every index, so the two cannot silently diverge.
 */
export function wilderRsiSeries(closes: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (!(period > 1) || closes.length < period + 2) return out;
  let avgG = 0;
  let avgL = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    if (ch >= 0) avgG += ch;
    else avgL -= ch;
  }
  avgG /= period;
  avgL /= period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    avgG = (avgG * (period - 1) + Math.max(ch, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function trueRange(bars: readonly Kline[], i: number): number {
  const b = bars[i]!;
  if (i === 0) return b.high - b.low;
  const pc = bars[i - 1]!.close;
  return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
}

/** ATR as a series, one value per bar (null until seeded). Absolute price units. */
export function atrSeries(bars: readonly Kline[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(bars.length).fill(null);
  if (!(period > 0) || bars.length < period + 1) return out;
  let acc = 0;
  for (let i = 0; i < period; i++) acc += trueRange(bars, i);
  let atr = acc / period;
  out[period - 1] = atr;
  for (let i = period; i < bars.length; i++) {
    atr = (atr * (period - 1) + trueRange(bars, i)) / period;
    out[i] = atr;
  }
  return out;
}

export function sma(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (!(period > 0) || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

// ── Step 1: zone detection ────────────────────────────────────────────────

/**
 * Symmetric fractal swings. A high at i is confirmed when it is strictly above
 * every high in [i-K, i+K]; ties do NOT confirm (a flat top is not a pivot).
 */
export function detectSwings(bars: readonly Kline[], k: number): Swing[] {
  const out: Swing[] = [];
  for (let i = k; i < bars.length - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= k; j++) {
      if (!(bars[i]!.high > bars[i - j]!.high) || !(bars[i]!.high > bars[i + j]!.high)) isHigh = false;
      if (!(bars[i]!.low < bars[i - j]!.low) || !(bars[i]!.low < bars[i + j]!.low)) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ index: i, price: bars[i]!.high, kind: "high" });
    if (isLow) out.push({ index: i, price: bars[i]!.low, kind: "low" });
  }
  return out;
}

/**
 * Turn swings into merged price bands.
 *
 * Each swing becomes a band of `zoneWidthATRMult * ATR` centred on the swing
 * price. Bands that overlap, or sit within `zoneMergeATRMult * ATR` of each
 * other, merge into one. touchCount counts the DISTINCT swings in the merged
 * band; strength = min(touchCount, 5) + a recency bonus.
 */
export function buildZones(bars: readonly Kline[], tf: Tf, params: SrParams = SR_PARAMS): Zone[] {
  const k = tf === "4H" ? params.swingLookback4H : params.swingLookback1H;
  const atr = atrSeries(bars, params.atrPeriod);
  const last = bars.length - 1;
  const curAtr = last >= 0 ? atr[last] : null;
  if (curAtr == null) return [];

  const swings = detectSwings(bars, k);
  if (swings.length === 0) return [];

  const width = params.zoneWidthATRMult * curAtr;
  const mergeGap = params.zoneMergeATRMult * curAtr;

  type Band = { high: number; low: number; swings: Swing[] };
  const bands: Band[] = swings.map((s) => ({
    high: s.price + width / 2,
    low: s.price - width / 2,
    swings: [s],
  }));
  // Ordered by price so merges cascade deterministically instead of following
  // swing order.
  bands.sort((a, b) => b.low - a.low || b.high - a.high);

  const merged: Band[] = [];
  for (const b of bands) {
    const hit = merged.find((m) => !(b.low > m.high + mergeGap || b.high < m.low - mergeGap));
    if (hit) {
      hit.high = Math.max(hit.high, b.high);
      hit.low = Math.min(hit.low, b.low);
      hit.swings.push(...b.swings);
    } else {
      merged.push({ ...b, swings: [...b.swings] });
    }
  }

  return merged.map((m) => {
    // Distinct BARS, so a bar that is both a swing high and a swing low counts
    // once — the conservative reading of "distinct swing points".
    const touchCount = new Set(m.swings.map((s) => s.index)).size;
    const lastTouchIndex = Math.max(...m.swings.map((s) => s.index));
    const recencyBonus = last - lastTouchIndex <= params.recencyBars ? 1 : 0;
    return {
      tf,
      high: m.high,
      low: m.low,
      touchCount,
      lastTouchIndex,
      strength: Math.min(touchCount, 5) + recencyBonus,
    };
  });
}

// ── Step 3: fair value gaps ───────────────────────────────────────────────

/**
 * Three-candle imbalance. Bullish when candle[i-1].high < candle[i+1].low;
 * bearish when candle[i-1].low > candle[i+1].high. `filled` is decided by
 * scanning forward from formation — any later bar trading back into the band
 * fills it.
 */
export function detectFvgs(
  bars: readonly Kline[],
  atr: readonly (number | null)[],
  params: SrParams = SR_PARAMS,
): Fvg[] {
  const out: Fvg[] = [];
  for (let i = 1; i < bars.length - 1; i++) {
    const prev = bars[i - 1]!;
    const next = bars[i + 1]!;
    const a = atr[i];
    if (a == null || a <= 0) continue;

    let kind: "bullish" | "bearish" | null = null;
    let high = 0;
    let low = 0;
    if (prev.high < next.low) {
      kind = "bullish";
      high = next.low;
      low = prev.high;
    } else if (prev.low > next.high) {
      kind = "bearish";
      high = prev.low;
      low = next.high;
    }
    if (!kind) continue;

    let filled = false;
    const from = Math.min(i + 2, bars.length);
    for (let j = from; j < bars.length; j++) {
      if (bars[j]!.low <= high && bars[j]!.high >= low) {
        filled = true;
        break;
      }
    }
    out.push({ kind, high, low, index: i + 1, filled, strength: (high - low) / a });
  }
  return out;
}

// ── Step 4: 4H bias ───────────────────────────────────────────────────────

/** Last close vs the last CONFIRMED swing high / low. Ties resolve to "none". */
export function htfBias4h(bars: readonly Kline[], params: SrParams = SR_PARAMS): "up" | "down" | "none" {
  if (bars.length === 0) return "none";
  const k = params.swingLookback4H;
  const swings = detectSwings(bars, k);
  if (swings.length === 0) return "none";
  const lastHigh = [...swings].reverse().find((s) => s.kind === "high");
  const lastLow = [...swings].reverse().find((s) => s.kind === "low");
  const close = bars[bars.length - 1]!.close;
  if (lastHigh && close > lastHigh.price) return "up";
  if (lastLow && close < lastLow.price) return "down";
  return "none";
}

// ── Step 5: RSI confluence ────────────────────────────────────────────────

/** -10..+10 from the RSI band. Direction-aware: the SAME reading scores oppositely. */
export function rsiContribution(rsi: number, side: Side): number {
  const w = SR_WEIGHTS.rsi;
  if (side === "long") {
    if (rsi < 40) return w.best; // oversold, momentum turning
    if (rsi < 50) return w.good;
    if (rsi <= 65) return w.mild;
    if (rsi <= 75) return w.extended; // extended into the move
    return w.exhausted;
  }
  if (rsi > 60) return w.best;
  if (rsi > 50) return w.good;
  if (rsi >= 35) return w.mild;
  if (rsi >= 25) return w.extended;
  return w.exhausted;
}

/** Optional +10: price makes a new extreme while RSI refuses to confirm it. */
export function rsiDivergence(
  bars: readonly Kline[],
  rsi: readonly (number | null)[],
  side: Side,
): boolean {
  const n = bars.length;
  const lo = n - 5;
  if (lo < 0) return false;
  const last = rsi[n - 1];
  if (last == null) return false;
  // Reference bar: the most extreme of the four bars BEFORE the current one.
  // Comparing the two endpoints of the window alone would call a plain trend
  // a divergence, so one side of the pair must be an actual extreme.
  let ref = lo;
  for (let i = lo + 1; i < n - 1; i++) {
    if (side === "long" ? bars[i]!.low < bars[ref]!.low : bars[i]!.high > bars[ref]!.high) ref = i;
  }
  const refRsi = rsi[ref];
  if (refRsi == null) return false;
  return side === "long"
    ? bars[n - 1]!.low < bars[ref]!.low && last > refRsi
    : bars[n - 1]!.high > bars[ref]!.high && last < refRsi;
}

// ── Step 2: location ──────────────────────────────────────────────────────

export interface LocationResult {
  location: Location;
  zone: Zone | null;
  /** True when a 1H zone holds this price (informational). */
  confirmed1h: boolean;
  /**
   * True only when the matched zone is a 4H zone AND a 1H zone also holds the
   * price — the spec's "AT_ZONE (4H + 1H confirmed)". A 1H zone at price is NOT
   * its own 4H confirmation: the spec's own parenthetical scores "only 4H or
   * 1H" at +15, so a 1H-only match must not earn the +25.
   */
  dualTf: boolean;
}

function contains(z: Zone, price: number): boolean {
  return price >= z.low && price <= z.high;
}

function distanceTo(z: Zone, price: number): number {
  if (price > z.high) return price - z.high;
  if (price < z.low) return z.low - price;
  return 0;
}

/**
 * AT_ZONE -> NEAR_ZONE -> AT_FVG -> NOWHERE, in that order. 4H zones win ties
 * against 1H, and among equals the nearest wins.
 */
export function classifyLocation(
  close: number,
  zones4h: readonly Zone[],
  zones1h: readonly Zone[],
  atr15: number,
  fvgs: readonly Fvg[],
  params: SrParams = SR_PARAMS,
): LocationResult {
  const nearest = (zs: readonly Zone[]): Zone | null =>
    zs.length === 0
      ? null
      : zs.reduce((best, z) => (distanceTo(z, close) < distanceTo(best, close) ? z : best));

  // 4H wins outright — "prefer 4H zones over 1H if both are in range" — so a
  // near 1H band can never displace a 4H band that is actually at price.
  const inside =
    nearest(zones4h.filter((z) => contains(z, close))) ?? nearest(zones1h.filter((z) => contains(z, close)));
  let atZone = inside;

  if (!atZone) {
    const nearLimit = 0.5 * atr15;
    atZone =
      nearest(zones4h.filter((z) => distanceTo(z, close) <= nearLimit)) ??
      nearest(zones1h.filter((z) => distanceTo(z, close) <= nearLimit));
  }

  if (atZone) {
    const confirmed1h = atZone.tf === "1H" || zones1h.some((z) => contains(z, close));
    const dualTf = atZone.tf === "4H" && zones1h.some((z) => contains(z, close));
    return {
      location: inside ? "AT_ZONE" : "NEAR_ZONE",
      zone: atZone,
      confirmed1h,
      dualTf,
    };
  }

  // Mid-range: the only reason to trade is a strong, unfilled FVG.
  const strong = fvgs.filter((f) => !f.filled && f.strength >= params.fvgStrengthMin);
  const hit = strong.find((f) => close >= f.low && close <= f.high);
  if (hit) return { location: "AT_FVG", zone: null, confirmed1h: false, dualTf: false };

  return { location: "NOWHERE", zone: null, confirmed1h: false, dualTf: false };
}

// ── Steps 6-8: composite, gates, output ───────────────────────────────────

export interface ScoreRow {
  score: number;
  tier: Tier;
  direction: Side | "none";
  location: Location;
  zone: Zone | null;
  htfBias: "up" | "down" | "none";
  htfAlignment: "with_trend" | "counter_trend" | "neutral";
  rsi: number | null;
  rsiContribution: number;
  volumeRatio: number;
  entryPrice: number;
  stopPrice: number | null;
  targetPrice: number | null;
  rr: number | null;
  /** Per-component points, so a lab can attribute a result to a component. */
  components: Record<string, number>;
  reasons: string[];
}

function directionFor(loc: LocationResult, close: number, fvgs: readonly Fvg[]): Side | "none" {
  if (loc.zone) {
    const mid = (loc.zone.high + loc.zone.low) / 2;
    return close >= mid ? "long" : "short";
  }
  if (loc.location === "AT_FVG") {
    const f = fvgs.find(
      (x) => !x.filled && close >= x.low && close <= x.high,
    );
    if (!f) return "none";
    // Bullish gap below price -> long; bearish gap above -> short.
    return f.kind === "bullish" ? "long" : "short";
  }
  return "none";
}

/**
 * Next opposing zone beyond entry — the NEAR edge of it, which is the first
 * thing in the way. 4H is preferred: 1H is consulted only when no 4H zone sits
 * beyond the entry at all.
 */
function targetFor(side: Side, entry: number, zones4h: readonly Zone[], zones1h: readonly Zone[]): number | null {
  const beyond = (zs: readonly Zone[]) =>
    zs
      .map((z) => (side === "long" ? z.low : z.high))
      .filter((p) => (side === "long" ? p > entry : p < entry));
  const pool = beyond(zones4h);
  const use = pool.length > 0 ? pool : beyond(zones1h);
  if (use.length === 0) return null;
  return side === "long" ? Math.min(...use) : Math.max(...use);
}

export interface ScoreInput {
  bars4h: readonly Kline[];
  bars1h: readonly Kline[];
  bars15: readonly Kline[];
  params?: SrParams;
}

/**
 * Score the most recent CLOSED 15m candle. Returns null when there is not
 * enough history to form an opinion — the caller treats that as NO OPINION,
 * never as a silent pass (same fail-open contract as the rest of this repo).
 */
export function scoreLatestCandle(input: ScoreInput): ScoreRow | null {
  const params = input.params ?? SR_PARAMS;
  const { bars4h, bars1h, bars15 } = input;
  if (bars15.length < params.volumeSmaPeriod + 2) return null;

  const atr15s = atrSeries(bars15, params.atrPeriod);
  const i = bars15.length - 1;
  const atr15 = atr15s[i];
  if (atr15 == null || atr15 <= 0) return null;

  const bar = bars15[i]!;
  const close = bar.close;

  const zones4h = buildZones(bars4h, "4H", params);
  const zones1h = buildZones(bars1h, "1H", params);
  const fvgs = detectFvgs(bars15, atr15s, params);
  const loc = classifyLocation(close, zones4h, zones1h, atr15, fvgs, params);

  const reasons: string[] = [];
  const components: Record<string, number> = { base: SR_WEIGHTS.base };

  // Hard gate 1: nowhere to trade is a skip regardless of anything else.
  if (loc.location === "NOWHERE") {
    return {
      score: 0,
      tier: "skip",
      direction: "none",
      location: "NOWHERE",
      zone: null,
      htfBias: htfBias4h(bars4h, params),
      htfAlignment: "neutral",
      rsi: null,
      rsiContribution: 0,
      volumeRatio: NaN,
      entryPrice: close,
      stopPrice: null,
      targetPrice: null,
      rr: null,
      components: { base: SR_WEIGHTS.base },
      reasons: ["NOWHERE — no zone and no strong unfilled FVG in range (hard gate)"],
    };
  }

  const direction = directionFor(loc, close, fvgs);
  if (direction === "none") {
    return null;
  }
  const side: Side = direction;

  // Location points.
  let locationPts = 0;
  const w = SR_WEIGHTS;
  if (loc.location === "AT_ZONE") {
    locationPts = loc.dualTf ? w.location.dualTf : w.location.atZoneSingleTf;
    reasons.push(`AT_ZONE ${loc.zone?.tf}${loc.dualTf ? " + 1H confirmed" : " (single TF)"} +${locationPts}`);
  } else if (loc.location === "NEAR_ZONE") {
    locationPts = w.location.nearZone;
    reasons.push(`NEAR_ZONE ${loc.zone?.tf} +${locationPts}`);
  } else {
    const f = fvgs.find((x) => !x.filled && close >= x.low && close <= x.high);
    locationPts = f && f.strength >= params.fvgStrengthMin ? w.location.fvgStrong : w.location.fvgWeak;
    reasons.push(`AT_FVG strength ${f ? f.strength.toFixed(2) : "?"} +${locationPts}`);
  }
  components.location = locationPts;

  // Zone strength.
  let strengthPts = 0;
  if (loc.zone) {
    if (loc.zone.strength >= 4) strengthPts = w.zoneStrength.ge4;
    else if (loc.zone.strength === 3) strengthPts = w.zoneStrength.eq3;
    if (strengthPts) reasons.push(`zone strength ${loc.zone.strength} +${strengthPts}`);
  }
  components.zoneStrength = strengthPts;

  // HTF alignment.
  const bias = htfBias4h(bars4h, params);
  const alignment: ScoreRow["htfAlignment"] =
    bias === "none" ? "neutral" : (side === "long" && bias === "up") || (side === "short" && bias === "down") ? "with_trend" : "counter_trend";
  const htfPts = alignment === "with_trend" ? w.htf.withTrend : alignment === "counter_trend" ? w.htf.counterTrend : w.htf.neutral;
  components.htfAlignment = htfPts;
  if (htfPts !== 0) reasons.push(`HTF ${alignment} ${htfPts > 0 ? "+" : ""}${htfPts}`);

  // RSI + optional divergence.
  const rsiSeries = wilderRsiSeries(bars15.map((b) => b.close), params.rsiPeriod);
  const rsi = rsiSeries[i];
  let rsiPts = rsi == null ? 0 : rsiContribution(rsi, side);
  if (rsi != null && rsiDivergence(bars15, rsiSeries, side)) {
    rsiPts += w.rsi.divergenceBonus;
    reasons.push(`RSI divergence +${w.rsi.divergenceBonus}`);
  }
  components.rsi = rsiPts;
  if (rsi != null) reasons.push(`RSI ${rsi.toFixed(1)} ${rsiPts >= 0 ? "+" : ""}${rsiPts}`);

  // Volume confirmation.
  const volSma = sma(bars15.map((b) => b.volume), params.volumeSmaPeriod)[i];
  const volumeRatio = volSma && volSma > 0 ? bar.volume / volSma : NaN;
  let volPts = 0;
  if (Number.isFinite(volumeRatio)) {
    if (volumeRatio > params.volumeHigh) volPts = w.volume.high;
    else if (volumeRatio < params.volumeLow) volPts = w.volume.low;
    if (volPts) reasons.push(`volume ${volumeRatio.toFixed(2)}x ${volPts > 0 ? "+" : ""}${volPts}`);
  }
  components.volume = volPts;

  // Candle confirmation.
  const range = bar.high - bar.low;
  const posInRange = range > 0 ? (bar.close - bar.low) / range : 0.5;
  let candlePts = 0;
  const closingWith = side === "long" ? posInRange >= 0.75 : posInRange <= 0.25;
  const closingAgainst = side === "long" ? bar.close < bar.open : bar.close > bar.open;
  if (closingWith) candlePts = w.candle.with;
  if (closingAgainst) candlePts = w.candle.against;
  components.candle = candlePts;
  if (candlePts) reasons.push(`candle ${candlePts > 0 ? "+" : ""}${candlePts}`);

  let score = Object.values(components).reduce((a, b) => a + b, 0);

  // Hard gate 2: counter-trend caps the score.
  if (alignment === "counter_trend" && score > params.counterTrendCap) {
    reasons.push(`counter_trend — capped at ${params.counterTrendCap}`);
    score = params.counterTrendCap;
  }
  score = Math.max(0, Math.min(100, score));

  // Trade levels (Step 9 for the geometry; sizing is the caller's business).
  const entryPrice = close;
  let stopPrice: number | null = null;
  if (loc.zone) {
    // Beyond the FAR side of the zone, plus 0.3 ATR.
    stopPrice = side === "long" ? loc.zone.low - 0.3 * atr15 : loc.zone.high + 0.3 * atr15;
  } else {
    stopPrice = side === "long" ? close - 1.5 * atr15 : close + 1.5 * atr15;
  }
  const targetPrice = targetFor(side, entryPrice, zones4h, zones1h);
  const risk = Math.abs(entryPrice - stopPrice);
  const rr = targetPrice != null && risk > 0 ? Math.abs(targetPrice - entryPrice) / risk : null;

  const tier: Tier = score >= params.fireThresholdAplus ? "A+" : score >= params.fireThresholdB ? "B" : "skip";

  return {
    score,
    tier,
    direction: side,
    location: loc.location,
    zone: loc.zone,
    htfBias: bias,
    htfAlignment: alignment,
    rsi,
    rsiContribution: rsiPts,
    volumeRatio,
    entryPrice,
    stopPrice,
    targetPrice,
    rr,
    components,
    reasons,
  };
}
