/**
 * DISPLACEMENT TEST — market structure shift confirmation (PURE module).
 *
 * The problem this solves (2026-09-22, operator watching INJ chop around its
 * 4H filter EMA): the shipped entry core calls any pivot low that prints above
 * the previous pivot low a "Higher Low". Inside a range that is a wiggle
 * detector — the pivot is two ticks higher, the 4H gate happens to be flipped
 * the right way, and a trade is born into a tape going nowhere. The strategy's
 * own name claims it trades a Market Structure Shift; a relative pivot is not
 * one.
 *
 * THE ADDED CONDITION (one condition, at the point the HL/LH is confirmed):
 *
 *   LONG  — the leg off the Higher Low must close ABOVE the most recent swing
 *           HIGH (the structure the HL was built beneath), and that leg must
 *           span >= k x ATR(period) on the closed 15m bars.
 *   SHORT — mirror: close BELOW the most recent swing LOW, leg >= k x ATR.
 *
 * Everything else is unchanged from the spec: the 15m break-and-close through
 * EMA 50, the HL/LH requirement, the "no retest of the EMA needed" rule, and
 * the 4H filter (this module reads the SAME gate table the shipped scanner
 * uses — buildHtfFilterRows/htfDecision in strategy.ts — so the two cores
 * cannot drift on the filter).
 *
 * Why the amplitude term is the right shape: a range does not produce an
 * ATR-sized break through the pivot on the other side of the structure, so the
 * chop setup never becomes an entry at all. No gate, no threshold on the tape,
 * nothing to overfit beyond the single knob `k`.
 *
 * ── MEASURED OUTCOME (2026-09-22) — BUILT, TESTED, NOT ARMED ────────────────
 * `bun run backtest:displacement` (2026-03-20 → 2026-09-19, SEP11_25_SNAPSHOT,
 * 437,557 x 15m bars, shipped brackets + R-LOCK exit) reproduced the documented
 * anchor exactly (3,212t / +0.026 R/t; fixed-2R 3,071t / −0.065) and then
 * REFUTED the fix:
 *
 *   · the metric IS pointed at the right cohort — the anchor's setups that never
 *     displaced the prior pivot run −0.951 R/trade over 622 trades at 6.1% WR
 *     (19.4% of the book), while the ≥ 2 ATR band runs +0.307;
 *   · "break" timing (wait for the close through the level) pays −0.316 R/trade
 *     of ENTRY PRICE on the very setups both cores keep — it enters after the
 *     move has already cleared structure, systematically later and higher than
 *     the shipped core. Net: Δ −0.073 R/t, paired-day t = −1.45.
 *   · "confirm" timing strips that cost to exactly 0.000 (identical entry bar)
 *     and then the selection is simply worse: it drops setups averaging
 *     +0.060 R/t and keeps ones averaging −0.056. Δ −0.097 R/t, t = −1.27.
 *   · the amplitude knob is nearly inert under "confirm" (k = 0 → 1.25 moves 60
 *     trades), so there is no second dial to tune.
 *
 * Neither reading clears the promotion bar (Δ > 0 AND paired-day |t| ≥ 2).
 * The scanner stays in the tree, UNARMED — nothing in the engine imports it and
 * no cron calls it — so the result is re-runnable instead of becoming folklore.
 * The live board (convex/displacementScan.ts + DisplacementBoard) reads the same
 * pure functions for diagnostics only.
 *
 * The open question this leaves: the never-displaced cohort is a real −0.95
 * R/trade bleed that no causal, price-only structure rule tested here can
 * separate from the rest. The next candidate must be ex-ante at the HL bar.
 *
 * ── CAUSALITY (the reason this is a new scanner, not a flag on the old one) ──
 * scanForSignals stamps a signal at the PIVOT BAR, which is only knowable
 * `pivotLookback` bars later; the backtest compensates with `confirmLag`. This
 * scanner is causal BY CONSTRUCTION — a signal's `index` is a bar at which
 * every input it uses had already closed:
 *
 *   · a pivot at index p is consumed only once bar p + pivotLookback exists;
 *   · the structure level (the prior swing high/low) is a pivot whose index is
 *     BELOW p, so it is strictly older and already confirmed;
 *   · the leg's close through that level and the ATR read are taken on the
 *     break bar itself.
 *
 * A consumer therefore enters at the open of `index + 1` with NO confirmation
 * lag and no look-ahead.
 *
 * ── FAIL-CLOSED ─────────────────────────────────────────────────────────────
 * A NaN ATR (warm-up) or a missing prior swing means NO signal, never a
 * default-open one — the same posture as the volatility gate in backtest.ts.
 */

import type { Kline, Pivot, Signal } from "./types";
import {
  buildHtfFilterRows,
  calculateEMA,
  detectPivots,
  detectSwings,
  hasBrokenAboveEma,
  hasBrokenBelowEma,
  htfDecision,
  type FilterType,
  type HtfFilterOptions,
} from "./strategy";

/** Defaults. `kAtr` is the single knob — everything else mirrors the spec. */
export const DISPLACEMENT_DEFAULTS = {
  /** Minimum leg amplitude, in ATR(period) units. */
  kAtr: 1.0,
  /** ATR period (Wilder), closed 15m bars. */
  atrPeriod: 14,
  /** Pivot lookback on BOTH sides — same as the shipped core. */
  pivotLookback: 5,
  /** 15m entry EMA, from the spec. */
  emaPeriod: 50,
} as const;

export interface DisplacementOptions {
  /** Required leg amplitude in ATR units (see DISPLACEMENT_DEFAULTS.kAtr). */
  kAtr: number;
  atrPeriod?: number;
  pivotLookback?: number;
  emaPeriod?: number;
  /** HTF filter mode — "ema" is the spec's 4H EMA75. */
  filterType?: FilterType;
  /** HTF gate overrides (period / optional second series), as in strategy.ts. */
  htf?: HtfFilterOptions;
  /**
   * WHEN the displacement is required (2026-09-22).
   *
   *  "break"   — wait for the leg to close through the level, then enter at the
   *              next open. The strongest reading, and the most expensive: the
   *              break is by definition LATER than the HL and above it, so the
   *              entry is a chase relative to the shipped core.
   *  "confirm" — the spec's literal wording: the condition is evaluated AT the
   *              bar the HL/LH becomes confirmable (pivot + pivotLookback), so
   *              the leg must have closed through the level inside that window.
   *              A setup whose break has not happened yet is dropped, which
   *              enters on the SAME bar the shipped core does — same timing,
   *              different confirmation. This is the only form of the rule that
   *              isolates the selection change from the entry-price change.
   */
  entryTiming?: "break" | "confirm";
}

/**
 * Wilder ATR over CLOSED bars, in absolute price units (not % — the leg span it
 * is compared against is also in price).
 *
 * Seeding matches every other ATR read in the project (proxy-signal's
 * `wilderAtr14`, backtest's `atrPctSeries`): TR[i] needs the previous close, the
 * seed at index `period` is the mean of TR[1..period], then the
 * (prev·(p−1) + TR)/p recursion. NaN = not ready.
 */
export function wilderAtrSeries(bars: Kline[], period: number = 14): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  if (bars.length <= period) return out;
  const tr = new Array<number>(bars.length).fill(NaN);
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    tr[i] = Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - pc),
      Math.abs(bars[i].low - pc),
    );
  }
  let s = 0;
  for (let i = 1; i <= period; i++) s += tr[i];
  out[period] = s / period;
  for (let i = period + 1; i < bars.length; i++) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

/** A displacement signal carries the full structure audit trail. */
export interface DisplacementSignal extends Signal {
  /** Price of the Higher Low (LONG) / Lower High (SHORT) the leg is measured from. */
  structurePrice: number;
  /** Bar index of that pivot. */
  structureIndex: number;
  /** The prior swing high (LONG) / low (SHORT) the leg had to close through. */
  breakLevel: number;
  /** Bar index of the first close through `breakLevel`. */
  breakIndex: number;
  /** Leg amplitude in price: the leg extreme minus/plus the structure price. */
  legAmplitude: number;
  /** Wilder ATR(period) on the break bar. */
  atrAtBreak: number;
  /** legAmplitude / atrAtBreak — the number the gate compares against kAtr. */
  displacementAtr: number;
  /** Bars from the structure pivot to the break bar. */
  barsToBreak: number;
}

export type DisplacementSide = "LONG" | "SHORT";

/** One live setup waiting for its leg to displace through structure. */
interface PendingLeg {
  structureIndex: number;
  structurePrice: number;
  level: number;
  /** Running extreme of the leg (max high for LONG, min low for SHORT). */
  legExtreme: number;
  /** The leg extreme frozen the moment the level was first closed through. */
  extremeAtBreak: number | null;
  brokenIndex: number | null;
}

type LegStep = "wait" | "fire" | "abandon";

/**
 * Advance one pending leg over bar `i` and decide. Mutates `pd` in place (hot
 * loop: once per bar per side).
 *
 * The order mirrors how a chart reads:
 *   1. a close back through the structure price kills the setup — the structure
 *      staying intact is the precondition for the whole pattern;
 *   2. the running leg extreme is updated;
 *   3. the FIRST close through `level` freezes the extreme at that bar: the
 *      amplitude is a property of the break, not of bars that come after it;
 *   4. the frozen amplitude is compared against k x ATR at the break bar. Too
 *      small => "abandon". A weak break is the chop case and is NOT re-armed
 *      later on the same structure — that is the deliberate difference from a
 *      pure post-hoc filter, and the reason there is nothing to overfit
 *      downstream of the one knob.
 */
function stepLeg(
  side: DisplacementSide,
  pd: PendingLeg,
  i: number,
  bars: Kline[],
  atr: number[],
  kAtr: number,
): LegStep {
  const bar = bars[i];
  const isLong = side === "LONG";

  if (isLong ? bar.close < pd.structurePrice : bar.close > pd.structurePrice) {
    return "abandon";
  }
  const ext = isLong ? bar.high : bar.low;
  if (pd.legExtreme === 0 || (isLong ? ext > pd.legExtreme : ext < pd.legExtreme)) {
    pd.legExtreme = ext;
  }
  if (pd.brokenIndex === null && (isLong ? bar.close > pd.level : bar.close < pd.level)) {
    pd.brokenIndex = i;
    pd.extremeAtBreak = pd.legExtreme;
  }
  if (pd.brokenIndex === null) return "wait";

  const a = atr[pd.brokenIndex];
  if (!Number.isFinite(a) || a <= 0) return "abandon"; // warm-up: fail closed
  const extreme = pd.extremeAtBreak ?? pd.legExtreme;
  const amplitude = isLong ? extreme - pd.structurePrice : pd.structurePrice - extreme;
  return amplitude >= kAtr * a ? "fire" : "abandon";
}

/**
 * Monotonic "last pivot below idx" reader.
 *
 * Structure pivots are consumed in increasing index order, so a single forward
 * cursor answers every query in O(total pivots) rather than O(pivots) per
 * setup — which matters when a lab re-scans 25 pairs once per arm.
 */
function makePriorReader(arr: Pivot[]): (idx: number) => Pivot | null {
  let ptr = 0;
  return (idx: number) => {
    while (ptr < arr.length && arr[ptr].index < idx) ptr++;
    return ptr > 0 ? arr[ptr - 1] : null;
  };
}

/**
 * Scan a 15m series for displacement-gated entries, using the 4h series for the
 * spec's higher-timeframe filter.
 *
 * Returned signals are ordered by index and are CAUSAL at that index (see the
 * module header): enter at the open of `index + 1`.
 */
export function scanDisplacementSignals(
  klines15m: Kline[],
  klines4h: Kline[],
  opts: DisplacementOptions,
): DisplacementSignal[] {
  const LB = opts.pivotLookback ?? DISPLACEMENT_DEFAULTS.pivotLookback;
  const atrPeriod = opts.atrPeriod ?? DISPLACEMENT_DEFAULTS.atrPeriod;
  const emaPeriod = opts.emaPeriod ?? DISPLACEMENT_DEFAULTS.emaPeriod;
  const filterType: FilterType = opts.filterType ?? "ema";
  const kAtr = opts.kAtr;
  const confirmTiming = opts.entryTiming === "confirm";

  const out: DisplacementSignal[] = [];
  if (klines15m.length < LB * 2 + atrPeriod + 2) return out;

  const closes = klines15m.map((k) => k.close);
  const ema = calculateEMA(closes, emaPeriod);
  const atr = wilderAtrSeries(klines15m, atrPeriod);

  // HTF gate — the SAME table + causal read the shipped scanner uses.
  const rows1 = buildHtfFilterRows(klines4h, filterType, opts.htf?.emaPeriod ?? 75);
  const rows2 = opts.htf?.klines2
    ? buildHtfFilterRows(opts.htf.klines2, "ema", opts.htf.emaPeriod2 ?? 75)
    : null;
  const htfOf = (openTime: number, side: DisplacementSide): { ok: boolean; label: string } => {
    const f1 = htfDecision(rows1, openTime, side);
    const f2 = rows2 ? htfDecision(rows2, openTime, side) : null;
    return {
      ok: f1.allowed && (!f2 || f2.allowed),
      label: f2 ? `${f1.label} + ${f2.label}` : f1.label,
    };
  };

  const pivots = detectPivots(klines15m, LB, LB);
  const { higherLows, lowerHighs } = detectSwings(pivots);
  const pivotHighs = pivots.filter((p) => p.type === "high");
  const pivotLows = pivots.filter((p) => p.type === "low");

  // EMA break state — identical rules to scanForSignals.
  let longBreakActive = false;
  let longBreakIndex = -1;
  let shortBreakActive = false;
  let shortBreakIndex = -1;

  const priorHighBefore = makePriorReader(pivotHighs);
  const priorLowBefore = makePriorReader(pivotLows);

  let hlCursor = 0;
  let lhCursor = 0;
  let pendingLong: PendingLeg | null = null;
  let pendingShort: PendingLeg | null = null;

  /**
   * Build the pending leg for a structure pivot, back-filling the bars that
   * already elapsed inside the pivot's own confirmation window (bars
   * p+1..i-1 — all closed by bar i, so the back-fill is causal). Returns null
   * when the back-fill already invalidated the setup. Bar `i` itself is left to
   * the main loop so it is stepped exactly once.
   */
  const openPending = (
    side: DisplacementSide,
    p: Pivot,
    level: number,
    i: number,
  ): { pd: PendingLeg; last: LegStep } | null => {
    const pd: PendingLeg = {
      structureIndex: p.index,
      structurePrice: p.price,
      level,
      legExtreme: 0,
      extremeAtBreak: null,
      brokenIndex: null,
    };
    // Confirm timing also evaluates bar `i`, and the setup lives or dies there;
    // break timing stops short of `i` and keeps tracking forward instead.
    const upTo = confirmTiming ? i : i - 1;
    let last: LegStep = "wait";
    for (let j = p.index + 1; j <= upTo; j++) {
      last = stepLeg(side, pd, j, klines15m, atr, kAtr);
      if (last === "abandon") return null;
    }
    return { pd, last };
  };

  /** Emit a signal for a leg that already passed both gates. */
  const fire = (
    side: DisplacementSide,
    pd: PendingLeg,
    i: number,
    breakAtBar: number,
  ): void => {
    const htf = htfOf(klines15m[i].openTime, side);
    if (!htf.ok) return; // fail closed: the filter is part of the entry rule
    out.push(buildSignal(side, pd, i, klines15m, closes, ema, atr, {
      breakAtBar, emaPeriod, filterType, kAtr, atrPeriod, htf,
    }));
  };

  for (let i = 0; i < klines15m.length; i++) {
    // ── EMA break state (bar 0 cannot hold a cross) ──
    if (i >= 1 && Number.isFinite(ema[i]) && Number.isFinite(ema[i - 1])) {
      if (!longBreakActive && hasBrokenAboveEma(closes, ema, i)) {
        longBreakActive = true;
        longBreakIndex = i;
      }
      if (!shortBreakActive && hasBrokenBelowEma(closes, ema, i)) {
        shortBreakActive = true;
        shortBreakIndex = i;
      }
      if (longBreakActive && closes[i] < ema[i]) longBreakActive = false;
      if (shortBreakActive && closes[i] > ema[i]) shortBreakActive = false;
    }

    // ── Consume HL/LH pivots whose confirmation window has now closed ──
    while (hlCursor < higherLows.length && higherLows[hlCursor].index + LB <= i) {
      const p = higherLows[hlCursor];
      hlCursor++;
      if (!longBreakActive || p.index <= longBreakIndex) continue;
      const prior = priorHighBefore(p.index);
      if (!prior) continue; // no swing high to displace through
      const res = openPending("LONG", p, prior.price, i);
      if (!res) continue;
      if (confirmTiming) {
        if (res.last === "fire") {
          fire("LONG", res.pd, i, longBreakIndex);
          longBreakActive = false;
        }
      } else {
        pendingLong = res.pd;
      }
    }
    while (lhCursor < lowerHighs.length && lowerHighs[lhCursor].index + LB <= i) {
      const p = lowerHighs[lhCursor];
      lhCursor++;
      if (!shortBreakActive || p.index <= shortBreakIndex) continue;
      const prior = priorLowBefore(p.index);
      if (!prior) continue; // no swing low to displace through
      const res = openPending("SHORT", p, prior.price, i);
      if (!res) continue;
      if (confirmTiming) {
        if (res.last === "fire") {
          fire("SHORT", res.pd, i, shortBreakIndex);
          shortBreakActive = false;
        }
      } else {
        pendingShort = res.pd;
      }
    }

    // ── Advance the live legs on this bar and act (break timing only) ──
    if (pendingLong) {
      const step = stepLeg("LONG", pendingLong, i, klines15m, atr, kAtr);
      if (step === "fire") {
        fire("LONG", pendingLong, i, longBreakIndex);
        longBreakActive = false; // mirror the shipped core: one entry per break
        pendingLong = null;
      } else if (step === "abandon") {
        pendingLong = null;
      }
    }
    if (pendingShort) {
      const step = stepLeg("SHORT", pendingShort, i, klines15m, atr, kAtr);
      if (step === "fire") {
        fire("SHORT", pendingShort, i, shortBreakIndex);
        shortBreakActive = false;
        pendingShort = null;
      } else if (step === "abandon") {
        pendingShort = null;
      }
    }
  }

  return out;
}

/** Assemble a Signal from a leg that passed both the amplitude test and the
 *  HTF gate (both are checked at the same bar — the structure-break bar). */
function buildSignal(
  side: DisplacementSide,
  pd: PendingLeg,
  i: number,
  bars: Kline[],
  closes: number[],
  ema: number[],
  atr: number[],
  ctx: {
    breakAtBar: number;
    emaPeriod: number;
    filterType: FilterType;
    kAtr: number;
    atrPeriod: number;
    htf: { ok: boolean; label: string };
  },
): DisplacementSignal {
  const b = pd.brokenIndex!;
  const a = atr[b];
  const extreme = pd.extremeAtBreak ?? pd.legExtreme;
  const amplitude = side === "LONG" ? extreme - pd.structurePrice : pd.structurePrice - extreme;
  const dp = pd.structurePrice < 0.001 ? 8 : pd.structurePrice < 0.01 ? 6 : pd.structurePrice < 1 ? 4 : 2;
  const fmt = (v: number) => `$${v.toFixed(dp)}`;
  const struct = side === "LONG" ? "Higher Low" : "Lower High";
  const levelName = side === "LONG" ? "swing high" : "swing low";

  return {
    type: side,
    time: bars[i].closeTime,
    price: closes[i],
    index: i,
    ema50: ema[i],
    ema75_4h: 0,
    structurePrice: pd.structurePrice,
    structureIndex: pd.structureIndex,
    breakLevel: pd.level,
    breakIndex: b,
    legAmplitude: amplitude,
    atrAtBreak: a,
    displacementAtr: amplitude / a,
    barsToBreak: b - pd.structureIndex,
    reason:
      `DISPLACEMENT ${side}: 15m close through EMA${ctx.emaPeriod} @ bar ${ctx.breakAtBar}, ` +
      `${struct} ${fmt(pd.structurePrice)} @ bar ${pd.structureIndex}; leg closed through ${levelName} ` +
      `${fmt(pd.level)} at bar ${b}, spanning ${(amplitude / a).toFixed(2)}×ATR(${ctx.atrPeriod}) ` +
      `(requires ≥ ${ctx.kAtr}) in ${b - pd.structureIndex} bars; ` +
      `${ctx.filterType === "ema" ? "4H" : "HTF"} filter: ${ctx.htf.label}`,
  };
}

// ── Live state readout (UI board) ──────────────────────────────────────────

export interface DisplacementSideState {
  side: DisplacementSide;
  /** Price broke and closed through the entry EMA and has not crossed back. */
  breakActive: boolean;
  breakIndex: number;
  breakTime: number;
  /** A structure pivot (HL for LONG / LH for SHORT) is confirmed. */
  structureFormed: boolean;
  structurePrice: number;
  structureIndex: number;
  /** The prior swing high/low the leg must close through. */
  breakLevel: number;
  /** The leg has already closed through `breakLevel`. */
  broken: boolean;
  /** Current leg amplitude in ATR units, and what k requires. */
  currentAtr: number;
  requiredAtr: number;
  /** `currentAtr >= requiredAtr` right now. */
  displaced: boolean;
  /** The 4H gate currently allows this side. */
  htfAllowed: boolean;
  htfLabel: string;
  /** Every rule satisfied on the last closed bar — an entry is due next open. */
  armed: boolean;
}

export interface DisplacementState {
  /** 15m EMA(50) on the last closed bar. */
  ema15m: number;
  /** 4H filter EMA(75) on the last closed 4H bar. */
  ema4h: number;
  price15m: number;
  price4h: number;
  /** Wilder ATR(period) on the last closed 15m bar. */
  atr: number;
  kAtr: number;
  atrPeriod: number;
  lastBarTime: number;
  last4hBarTime: number;
  long: DisplacementSideState;
  short: DisplacementSideState;
}

/**
 * Read the CURRENT displacement state for a pair — the live equivalent of the
 * scanner, for the dashboard board. Uses only closed candles (callers pass
 * klines whose last element is closed, which is what fetchKlines returns).
 *
 * `armed` is deliberately strict: every rule the app would act on is satisfied
 * on the LAST CLOSED bar, so an entry would be taken at the next bar's open.
 */
export function readDisplacementState(
  klines15m: Kline[],
  klines4h: Kline[],
  opts: DisplacementOptions,
): DisplacementState | null {
  const LB = opts.pivotLookback ?? DISPLACEMENT_DEFAULTS.pivotLookback;
  const atrPeriod = opts.atrPeriod ?? DISPLACEMENT_DEFAULTS.atrPeriod;
  const emaPeriod = opts.emaPeriod ?? DISPLACEMENT_DEFAULTS.emaPeriod;
  const filterType: FilterType = opts.filterType ?? "ema";
  const kAtr = opts.kAtr;
  if (klines15m.length < LB * 2 + atrPeriod + 2 || klines4h.length === 0) return null;

  const closes = klines15m.map((k) => k.close);
  const ema = calculateEMA(closes, emaPeriod);
  const atr = wilderAtrSeries(klines15m, atrPeriod);
  const closes4h = klines4h.map((k) => k.close);
  const ema4h = calculateEMA(closes4h, opts.htf?.emaPeriod ?? 75);

  const rows1 = buildHtfFilterRows(klines4h, filterType, opts.htf?.emaPeriod ?? 75);
  const rows2 = opts.htf?.klines2
    ? buildHtfFilterRows(opts.htf.klines2, "ema", opts.htf.emaPeriod2 ?? 75)
    : null;

  const lastIdx = klines15m.length - 1;
  const lastBar = klines15m[lastIdx];

  const pivots = detectPivots(klines15m, LB, LB);
  const { higherLows, lowerHighs } = detectSwings(pivots);

  const build = (side: DisplacementSide): DisplacementSideState => {
    const isLong = side === "LONG";
    const f1 = htfDecision(rows1, lastBar.openTime, side);
    const f2 = rows2 ? htfDecision(rows2, lastBar.openTime, side) : null;
    const htfAllowed = f1.allowed && (!f2 || f2.allowed);
    const htfLabel = f2 ? `${f1.label} + ${f2.label}` : f1.label;

    // Break state: walk back to the most recent EMA cross, stopping if the
    // search crosses a bar that closed back through the line.
    let breakActive = false;
    let breakIndex = -1;
    for (let i = lastIdx; i >= 1; i--) {
      if (!Number.isFinite(ema[i]) || !Number.isFinite(ema[i - 1])) break;
      if (isLong ? hasBrokenAboveEma(closes, ema, i) : hasBrokenBelowEma(closes, ema, i)) {
        breakActive = true;
        breakIndex = i;
        break;
      }
      if (isLong ? closes[i] < ema[i] : closes[i] > ema[i]) break;
    }

    const structPivots = isLong ? higherLows : lowerHighs;
    const swings = pivots.filter((p) => p.type === (isLong ? "high" : "low"));
    let structureFormed = false;
    let structurePrice = NaN;
    let structureIndex = -1;
    let breakLevel = NaN;
    let broken = false;
    let currentAtr = NaN;

    for (let k = structPivots.length - 1; k >= 0; k--) {
      const p = structPivots[k];
      if (p.index + LB > lastIdx) continue; // not confirmed at the last closed bar
      if (!breakActive || p.index <= breakIndex) continue;
      const prior = [...swings].reverse().find((s) => s.index < p.index);
      if (!prior) continue;
      structureFormed = true;
      structurePrice = p.price;
      structureIndex = p.index;
      breakLevel = prior.price;
      let extreme = isLong ? -Infinity : Infinity;
      for (let j = p.index + 1; j <= lastIdx; j++) {
        const v = isLong ? klines15m[j].high : klines15m[j].low;
        extreme = isLong ? Math.max(extreme, v) : Math.min(extreme, v);
      }
      const a = atr[lastIdx];
      currentAtr =
        Number.isFinite(a) && a > 0
          ? (isLong ? extreme - p.price : p.price - extreme) / a
          : NaN;
      for (let j = p.index + 1; j <= lastIdx; j++) {
        if (isLong ? closes[j] > prior.price : closes[j] < prior.price) {
          broken = true;
          break;
        }
      }
      break;
    }

    const displaced = Number.isFinite(currentAtr) && currentAtr >= kAtr;
    return {
      side,
      breakActive,
      breakIndex,
      breakTime: breakIndex >= 0 ? klines15m[breakIndex].closeTime : 0,
      structureFormed,
      structurePrice,
      structureIndex,
      breakLevel,
      broken,
      currentAtr,
      requiredAtr: kAtr,
      displaced,
      htfAllowed,
      htfLabel,
      armed: breakActive && structureFormed && broken && displaced && htfAllowed,
    };
  };

  const last4h = klines4h[klines4h.length - 1];
  return {
    ema15m: ema[lastIdx],
    ema4h: ema4h[ema4h.length - 1],
    price15m: lastBar.close,
    price4h: last4h.close,
    atr: atr[lastIdx],
    kAtr,
    atrPeriod,
    lastBarTime: lastBar.closeTime,
    last4hBarTime: last4h.closeTime,
    long: build("LONG"),
    short: build("SHORT"),
  };
}
