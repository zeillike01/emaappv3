import type { Kline, Pivot, Signal, StrategyState } from "./types";

export type FilterType = "ema" | "macd";

/**
 * Calculate Exponential Moving Average for an array of close prices.
 * Returns an array the same length as `closes`, with NaN for indices
 * where not enough data exists.
 */
export function calculateEMA(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];
  const ema: number[] = new Array(closes.length).fill(NaN);
  if (closes.length < period) return ema;

  // Seed: SMA of first `period` values
  let sum = 0;
  for (let i = 0; i < period; i++) sum += closes[i];
  ema[period - 1] = sum / period;

  const multiplier = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    ema[i] = (closes[i] - ema[i - 1]) * multiplier + ema[i - 1];
  }
  return ema;
}

/**
 * Detect pivot highs and pivot lows using a window of `lookback` bars
 * on each side. Only considers closed candles.
 *
 * Returns arrays of Pivot objects sorted by index.
 */
export function detectPivots(
  klines: Kline[],
  lookback: number = 5,
  /** Bars required on the RIGHT side to confirm. 0 = left-only pivot,
   *  known the moment the pivot bar itself closes (front-running mode). */
  rightLookback: number = lookback,
): Pivot[] {
  const pivots: Pivot[] = [];

  for (let i = lookback; i < klines.length - rightLookback; i++) {
    const bar = klines[i];

    // Check pivot high
    let isPivotHigh = true;
    for (let j = 1; j <= lookback; j++) {
      if (klines[i - j].high >= bar.high) {
        isPivotHigh = false;
        break;
      }
    }
    if (isPivotHigh) {
      for (let j = 1; j <= rightLookback; j++) {
        if (klines[i + j].high >= bar.high) {
          isPivotHigh = false;
          break;
        }
      }
    }
    if (isPivotHigh) {
      pivots.push({ index: i, price: bar.high, time: bar.closeTime, type: "high" });
    }

    // Check pivot low
    let isPivotLow = true;
    for (let j = 1; j <= lookback; j++) {
      if (klines[i - j].low <= bar.low) {
        isPivotLow = false;
        break;
      }
    }
    if (isPivotLow) {
      for (let j = 1; j <= rightLookback; j++) {
        if (klines[i + j].low <= bar.low) {
          isPivotLow = false;
          break;
        }
      }
    }
    if (isPivotLow) {
      pivots.push({ index: i, price: bar.low, time: bar.closeTime, type: "low" });
    }
  }

  // Sort by index
  pivots.sort((a, b) => a.index - b.index);
  return pivots;
}

/**
 * From pivot points, detect Higher Lows and Lower Highs.
 * A Higher Low: a pivot low whose price is higher than the previous pivot low.
 * A Lower High: a pivot high whose price is lower than the previous pivot high.
 */
export function detectSwings(pivots: Pivot[]): {
  higherLows: Pivot[];
  lowerHighs: Pivot[];
} {
  const higherLows: Pivot[] = [];
  const lowerHighs: Pivot[] = [];

  let prevLow: Pivot | null = null;
  let prevHigh: Pivot | null = null;

  for (const p of pivots) {
    if (p.type === "low") {
      if (prevLow && p.price > prevLow.price) {
        higherLows.push(p);
      }
      prevLow = p;
    } else {
      if (prevHigh && p.price < prevHigh.price) {
        lowerHighs.push(p);
      }
      prevHigh = p;
    }
  }

  return { higherLows, lowerHighs };
}

/**
 * Determine whether a close at `index` represents a break above EMA.
 * The break happens when the close crosses from strictly below to strictly above.
 * Uses strict inequality to avoid ambiguity when close equals the EMA.
 */
export function hasBrokenAboveEma(
  closes: number[],
  ema: number[],
  index: number,
): boolean {
  if (index < 1) return false;
  if (isNaN(ema[index]) || isNaN(ema[index - 1])) return false;
  return closes[index - 1] < ema[index - 1] && closes[index] > ema[index];
}

/**
 * Determine whether a close at `index` represents a break below EMA.
 * Uses strict inequality to avoid ambiguity when close equals the EMA.
 */
export function hasBrokenBelowEma(
  closes: number[],
  ema: number[],
  index: number,
): boolean {
  if (index < 1) return false;
  if (isNaN(ema[index]) || isNaN(ema[index - 1])) return false;
  return closes[index - 1] > ema[index - 1] && closes[index] < ema[index];
}

// 4-hour interval in milliseconds (4 * 60 * 60 * 1000)
const FOUR_HOUR_MS = 14_400_000;

/**
 * Scan for all entry signals across a 15m kline series, using a 4h kline
 * series for the higher-timeframe filter.
 *
 * Returns an array of signals in chronological order.
 */
/**
 * Calculate MACD (Moving Average Convergence Divergence).
 * Returns the MACD line, signal line, and histogram arrays.
 */
export function calculateMACD(
  closes: number[],
  fastPeriod: number = 12,
  slowPeriod: number = 26,
  signalPeriod: number = 9,
): { macdLine: number[]; signalLine: number[]; histogram: number[] } {
  const emaFast = calculateEMA(closes, fastPeriod);
  const emaSlow = calculateEMA(closes, slowPeriod);

  const macdLine = closes.map((_, i) => {
    if (isNaN(emaFast[i]) || isNaN(emaSlow[i])) return NaN;
    return emaFast[i] - emaSlow[i];
  });

  const validMacd = macdLine.filter((v) => !isNaN(v));
  const signalOfValid = calculateEMA(validMacd, signalPeriod);

  const signalLine = new Array(closes.length).fill(NaN);
  let validIdx = 0;
  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(macdLine[i])) {
      if (validIdx < signalOfValid.length) {
        signalLine[i] = signalOfValid[validIdx];
      }
      validIdx++;
    }
  }

  const histogram = closes.map((_, i) => {
    if (isNaN(macdLine[i]) || isNaN(signalLine[i])) return NaN;
    return macdLine[i] - signalLine[i];
  });

  return { macdLine, signalLine, histogram };
}

/**
 * Find the most recent completed 4H bar for a given 15m bar.
 */
function findCompleted4hBar(
  h4Bars: Array<{ closeTime: number; openTime: number }>,
  openTime15m: number,
): number {
  // Find the last 4H bar whose closeTime is strictly before the 15m bar's openTime.
  // This ensures the 4H bar is fully completed before we act on its data.
  let best = -1;
  for (let idx = 0; idx < h4Bars.length; idx++) {
    if (h4Bars[idx].closeTime < openTime15m) {
      best = idx;
    } else {
      break;
    }
  }
  return best;
}

/** One row of the higher-timeframe gate table — a closed HTF bar and which
 *  sides its filter allowed. Built oldest→newest; `openTime` is what the
 *  causality lookup keys on. */
export type HtfFilterRow = {
  closeTime: number;
  openTime: number;
  allowedLong: boolean;
  allowedShort: boolean;
  label: string;
};

/**
 * Higher-timeframe gate overrides (2026-09-22, 1H-migration lab).
 *
 * The spec's 4H EMA75 filter was hard-coded in both `scanForSignals` and the
 * backtest engine, which made "what if the entry timeframe — and therefore the
 * filter timeframe and its EMA period — moved?" untestable. These options
 * parameterize it without changing any default:
 *   · `emaPeriod`      — EMA period on the PRIMARY filter series (default 75);
 *   · `klines2`        — an optional SECOND filter series (e.g. 12h). When
 *                        present BOTH series must allow the side (AND), which
 *                        is how the live stack stacks its 1H + 4H vetoes;
 *   · `emaPeriod2`     — EMA period on the second series (default 75).
 */
export interface HtfFilterOptions {
  emaPeriod?: number;
  klines2?: Kline[];
  emaPeriod2?: number;
}

/**
 * Build the per-HTF-bar gate table for one filter series.
 * EMA mode: allowedLong = close > EMA(period), allowedShort = mirror.
 * MACD mode: the legacy histogram-sign rule (only ever used as the primary).
 * Bars whose indicator is NaN (warm-up) are dropped, exactly as before.
 */
export function buildHtfFilterRows(
  klines: Kline[],
  filterType: FilterType,
  emaPeriod: number,
): HtfFilterRow[] {
  const closes = klines.map((k) => k.close);
  const rows: HtfFilterRow[] = [];

  if (filterType === "macd") {
    const macd = calculateMACD(closes, 8, 17, 9);
    for (let i = 0; i < klines.length; i++) {
      if (isNaN(macd.histogram[i])) continue;
      rows.push({
        closeTime: klines[i].closeTime,
        openTime: klines[i].openTime,
        allowedLong: macd.histogram[i] > 0,
        allowedShort: macd.histogram[i] < 0,
        label: `histogram=${macd.histogram[i].toFixed(2)}`,
      });
    }
  } else {
    const ema = calculateEMA(closes, emaPeriod);
    for (let i = 0; i < klines.length; i++) {
      if (isNaN(ema[i])) continue;
      rows.push({
        closeTime: klines[i].closeTime,
        openTime: klines[i].openTime,
        allowedLong: closes[i] > ema[i],
        allowedShort: closes[i] < ema[i],
        label: `price=$${closes[i].toFixed(0)} vs EMA${emaPeriod}=$${ema[i].toFixed(0)}`,
      });
    }
  }
  return rows;
}

/**
 * Causal gate read: the last filter row whose bar had CLOSED before this entry
 * bar opened. No row yet (or the series never warmed up) → blocked, the same
 * fail-closed posture the inline version had.
 */
export function htfDecision(
  rows: HtfFilterRow[],
  barOpenTime: number,
  type: "LONG" | "SHORT",
): { allowed: boolean; label: string } {
  const idx = findCompleted4hBar(rows, barOpenTime);
  if (idx < 0) return { allowed: false, label: "n/a" };
  return {
    allowed: type === "LONG" ? rows[idx].allowedLong : rows[idx].allowedShort,
    label: rows[idx].label,
  };
}

export function scanForSignals(
  klines15m: Kline[],
  klines4h: Kline[],
  pivotLookback: number = 4,
  filterType: FilterType = "ema",
  emaPeriod15m: number = 50,
  /** Right-side pivot bars (default = pivotLookback, i.e. full confirmation). */
  pivotRightLookback?: number,
  /** Higher-timeframe gate overrides — see HtfFilterOptions. Omit for the
   *  shipped 4H EMA75 behaviour (byte-identical to before this param existed). */
  htf?: HtfFilterOptions,
): Signal[] {
  // ⚠️ CAUSALITY CONTRACT (2026-09-11 red-team audit) ⚠️
  // A returned signal's `index`/`time` point at the PIVOT BAR, but a pivot is
  // only knowable `pivotRightLookback ?? pivotLookback` bars LATER (detectPivots
  // requires that many right-side bars). A simulated entry at pivot+1 is
  // therefore ~4-5 bars (60-75 min) of LOOK-AHEAD and will not be reproducible
  // live. Any consumer that ACTS on a signal must delay execution to the bar
  // after confirmation — `runBacktest` now does this by default via
  // `confirmLag` (lag = pivotLookback). Do not add a new consumer that enters
  // on `signal.index` directly.
  const closes15m = klines15m.map((k) => k.close);
  const ema50_15m = calculateEMA(closes15m, emaPeriod15m);

  // ── 4H filter data ──────────────────────────────────────────
  // Primary series (the spec's 4H EMA75 unless overridden) + an OPTIONAL
  // second series (e.g. 12H). When a second series is supplied both must
  // allow the side — the AND-stack the live advisor layers use.
  const h4FilterData = buildHtfFilterRows(klines4h, filterType, htf?.emaPeriod ?? 75);
  const h4Filter2Data = htf?.klines2
    ? buildHtfFilterRows(htf.klines2, "ema", htf.emaPeriod2 ?? 75)
    : null;


  // Detect pivots on 15m
  const pivots = detectPivots(klines15m, pivotLookback, pivotRightLookback ?? pivotLookback);
  const { higherLows, lowerHighs } = detectSwings(pivots);

  const signals: Signal[] = [];

  // Track break state per bar
  let longBreakActive = false;
  let longBreakIndex = -1;
  let shortBreakActive = false;
  let shortBreakIndex = -1;

  // Track most recent higher lows and lower highs
  let recentHigherLow: Pivot | null = null;
  let recentLowerHigh: Pivot | null = null;
  let hlIndex = 0;
  let lhIndex = 0;

  for (let i = 1; i < klines15m.length; i++) {
    const bar = klines15m[i];

    // Detect break above EMA 50
    if (!longBreakActive && hasBrokenAboveEma(closes15m, ema50_15m, i)) {
      longBreakActive = true;
      longBreakIndex = i;
    }
    // Detect break below EMA 50
    if (!shortBreakActive && hasBrokenBelowEma(closes15m, ema50_15m, i)) {
      shortBreakActive = true;
      shortBreakIndex = i;
    }

    // Reset break states if price crosses back through the EMA
    // (only reset once we have a confirmed opposing close, not on a single wick)
    if (longBreakActive && closes15m[i] < ema50_15m[i]) {
      longBreakActive = false;
    }
    if (shortBreakActive && closes15m[i] > ema50_15m[i]) {
      shortBreakActive = false;
    }

    // Check for new higher lows that formed after the long break
    while (hlIndex < higherLows.length && higherLows[hlIndex].index <= i) {
      if (higherLows[hlIndex].index > longBreakIndex && longBreakActive) {
        recentHigherLow = higherLows[hlIndex];
      }
      hlIndex++;
    }

    // Check for new lower highs that formed after the short break
    while (lhIndex < lowerHighs.length && lowerHighs[lhIndex].index <= i) {
      if (lowerHighs[lhIndex].index > shortBreakIndex && shortBreakActive) {
        recentLowerHigh = lowerHighs[lhIndex];
      }
      lhIndex++;
    }

    // LONG SIGNAL: Higher Low confirmed + HTF filter (1 or 2 series)
    if (longBreakActive && recentHigherLow && recentHigherLow.index === i) {
      const f1 = htfDecision(h4FilterData, bar.openTime, "LONG");
      const f2 = h4Filter2Data ? htfDecision(h4Filter2Data, bar.openTime, "LONG") : null;
      if (f1.allowed && (!f2 || f2.allowed)) {
        const fLabel = f2 ? `${f1.label} + ${f2.label}` : f1.label;
        signals.push({
          type: "LONG",
          time: bar.closeTime,
          price: bar.close,
          index: i,
          ema50: ema50_15m[i],
          ema75_4h: 0,
          structurePrice: recentHigherLow.price,
          reason: `15m break above EMA${emaPeriod15m} @ bar ${longBreakIndex}, Higher Low @ $${recentHigherLow.price.toFixed(2)}, 4H filter (${filterType}): ${fLabel}`,
        });
        longBreakActive = false;
      }
    }

    // SHORT SIGNAL: Lower High confirmed + HTF filter (1 or 2 series)
    if (shortBreakActive && recentLowerHigh && recentLowerHigh.index === i) {
      const f1 = htfDecision(h4FilterData, bar.openTime, "SHORT");
      const f2 = h4Filter2Data ? htfDecision(h4Filter2Data, bar.openTime, "SHORT") : null;
      if (f1.allowed && (!f2 || f2.allowed)) {
        const fLabel = f2 ? `${f1.label} + ${f2.label}` : f1.label;
        signals.push({
          type: "SHORT",
          time: bar.closeTime,
          price: bar.close,
          index: i,
          ema50: ema50_15m[i],
          ema75_4h: 0,
          structurePrice: recentLowerHigh.price,
          reason: `15m break below EMA${emaPeriod15m} @ bar ${shortBreakIndex}, Lower High @ $${recentLowerHigh.price.toFixed(2)}, 4H filter (${filterType}): ${fLabel}`,
        });
        shortBreakActive = false;
      }
    }
  }

  return signals;
}

// ── Reversal variant: failed low/high + EMA-break entry ───────────────

/**
 * Reversal-variant signal scan (the "failed lower low → trendline break" pattern
 * and its short mirror):
 *
 *   LONG:  downtrend context (series of lower lows), a left-only pivot low
 *          prints HIGHER than the previous pivot low (price failed to make a
 *          new lower low → Higher-Low raw material), then a 15m close breaks
 *          above the EMA (trendline-break proxy) while the HL is fresh and
 *          structure is intact (no close back below the HL).
 *
 *   SHORT: uptrend context (series of higher highs), a pivot high prints
 *          LOWER than the previous pivot high (failed higher high → LH),
 *          then a 15m close breaks below the EMA while the LH is fresh and
 *          structure is intact (no close back above the LH).
 *
 * Uses LEFT-ONLY pivots: the EMA break itself is the confirmation — no
 * right-side pivot wait. 4H filter (MACD histogram or EMA75) applied at
 * signal time using only completed 4H bars.
 */
export function scanReversalSignals(
  klines15m: Kline[],
  klines4h: Kline[],
  pivotLookback: number = 5,
  filterType: FilterType = "macd",
  emaPeriod15m: number = 50,
  /** Max bars between the failed pivot and the EMA break (default 12 = 3h) */
  pivotMaxAge: number = 12,
  /** Higher-timeframe gate overrides — see HtfFilterOptions. */
  htf?: HtfFilterOptions,
): Signal[] {
  const closes15m = klines15m.map((k) => k.close);
  const ema15 = calculateEMA(closes15m, emaPeriod15m);

  // 4H filter data (same construction as scanForSignals)
  const h4FilterData = buildHtfFilterRows(klines4h, filterType, htf?.emaPeriod ?? 75);
  const h4Filter2Data = htf?.klines2
    ? buildHtfFilterRows(htf.klines2, "ema", htf.emaPeriod2 ?? 75)
    : null;
  const htfOk = (openTime: number, type: "LONG" | "SHORT"): { ok: boolean; label: string } => {
    const f1 = htfDecision(h4FilterData, openTime, type);
    const f2 = h4Filter2Data ? htfDecision(h4Filter2Data, openTime, type) : null;
    return { ok: f1.allowed && (!f2 || f2.allowed), label: f2 ? `${f1.label} + ${f2.label}` : f1.label };
  };

  // Left-only pivots: each pivot is known the moment its own bar closes
  const pivots = detectPivots(klines15m, pivotLookback, 0);

  const signals: Signal[] = [];

  // Rolling pivot history (most recent last, max 3 kept for trend context)
  const lowHistory: Pivot[] = [];
  const highHistory: Pivot[] = [];
  let pivotIdx = 0;

  // Structure-intact flags: no close beyond the failed pivot since it formed
  let longStructureBroken = false;
  let shortStructureBroken = false;
  // Indices of pivots already consumed by a fired signal (no refire)
  let lastFiredLowIndex = -1;
  let lastFiredHighIndex = -1;

  for (let i = 1; i < klines15m.length; i++) {
    // Consume pivots known as of bar i's close
    while (pivotIdx < pivots.length && pivots[pivotIdx].index <= i) {
      const p = pivots[pivotIdx];
      if (p.type === "low") {
        lowHistory.push(p);
        if (lowHistory.length > 3) lowHistory.shift();
        longStructureBroken = false; // fresh pivot resets the long structure check
      } else {
        highHistory.push(p);
        if (highHistory.length > 3) highHistory.shift();
        shortStructureBroken = false;
      }
      pivotIdx++;
    }

    const close = closes15m[i];
    const lastLow = lowHistory[lowHistory.length - 1] ?? null;
    const lastHigh = highHistory[highHistory.length - 1] ?? null;

    // Track structure against the most recent failed pivot
    if (lastLow && close < lastLow.price) longStructureBroken = true;
    if (lastHigh && close > lastHigh.price) shortStructureBroken = true;

    // ── LONG: failed lower low + close above EMA ──
    if (
      lastLow &&
      lastLow.index > lastFiredLowIndex &&
      !longStructureBroken &&
      i - lastLow.index <= pivotMaxAge &&
      lowHistory.length >= 2 &&
      lastLow.price > lowHistory[lowHistory.length - 2].price && // failed to make a new lower low
      (lowHistory.length < 3 ||
        lowHistory[lowHistory.length - 2].price < lowHistory[lowHistory.length - 3].price) && // downtrend context
      hasBrokenAboveEma(closes15m, ema15, i)
    ) {
      const f = htfOk(klines15m[i].openTime, "LONG");
      if (f.ok) {
        signals.push({
          type: "LONG",
          time: klines15m[i].closeTime,
          price: close,
          index: i,
          ema50: ema15[i],
          ema75_4h: 0,
          structurePrice: lastLow.price,
          reason: `REVERSAL LONG: failed lower low (HL @ $${lastLow.price.toFixed(2)}, ${i - lastLow.index} bars prior) + 15m close above EMA${emaPeriod15m}, 4H filter (${filterType}): ${f.label}`,
        });
        lastFiredLowIndex = lastLow.index;
      }
    }

    // ── SHORT: failed higher high + close below EMA ──
    if (
      lastHigh &&
      lastHigh.index > lastFiredHighIndex &&
      !shortStructureBroken &&
      i - lastHigh.index <= pivotMaxAge &&
      highHistory.length >= 2 &&
      lastHigh.price < highHistory[highHistory.length - 2].price && // failed to make a new higher high
      hasBrokenBelowEma(closes15m, ema15, i)
    ) {
      const f = htfOk(klines15m[i].openTime, "SHORT");
      if (f.ok) {
        signals.push({
          type: "SHORT",
          time: klines15m[i].closeTime,
          price: close,
          index: i,
          ema50: ema15[i],
          ema75_4h: 0,
          structurePrice: lastHigh.price,
          reason: `REVERSAL SHORT: failed higher high (LH @ $${lastHigh.price.toFixed(2)}, ${i - lastHigh.index} bars prior) + 15m close below EMA${emaPeriod15m}, 4H filter (${filterType}): ${f.label}`,
        });
        lastFiredHighIndex = lastHigh.index;
      }
    }
  }

  return signals;
}

// ── 5m MACD entry-confirmation filter ─────────────────────────

export interface MacdConfirmationResult {
  /** true when the histogram has the right color for the direction */
  confirmed: boolean;
  /** latest closed 5m histogram value */
  histogram: number;
  /** previous closed 5m histogram value */
  prevHistogram: number;
  /** human-readable status for logs/UI */
  label: string;
}

/**
 * Check whether the 5m MACD(8,17,9) histogram confirms a direction on the
 * last CLOSED 5m candle.
 *
 *   LONG:  histogram > 0 (green)
 *   SHORT: histogram < 0 (red)
 *
 * If the histogram is the wrong color, `confirmed` is false and the caller
 * should keep waiting (as long as market structure is intact).
 */
export function checkMacdConfirmation(
  klines5m: Kline[],
  direction: "LONG" | "SHORT",
): MacdConfirmationResult {
  const closes = klines5m.map((k) => k.close);
  const { histogram } = calculateMACD(closes, 8, 17, 9);

  // Last two CLOSED candles (the final element may be forming — drop it if
  // its closeTime is in the future).
  const now = Date.now();
  let end = klines5m.length;
  while (end > 0 && klines5m[end - 1].closeTime > now) end--;

  const hist = end >= 1 ? histogram[end - 1] : NaN;
  const prevHist = end >= 2 ? histogram[end - 2] : NaN;

  const confirmed = direction === "LONG" ? hist > 0 : hist < 0;
  const color = isNaN(hist) ? "unknown" : hist > 0 ? "green" : hist < 0 ? "red" : "flat";

  return {
    confirmed,
    histogram: hist,
    prevHistogram: prevHist,
    label: `5m MACD hist ${isNaN(hist) ? "n/a" : hist.toFixed(3)} (${color}) — ${confirmed ? "confirmed" : "waiting"} for ${direction}`,
  };
}

/**
 * Check that market structure is still intact on the 5m series.
 *
 *   LONG:  structure breaks when price CLOSES below the Higher Low.
 *   SHORT: structure breaks when price CLOSES above the Lower High.
 *
 * Uses only closed candles.
 */
export function isStructureIntact(
  klines5m: Kline[],
  direction: "LONG" | "SHORT",
  structurePrice: number,
): { intact: boolean; lastClose: number } {
  const now = Date.now();
  let end = klines5m.length;
  while (end > 0 && klines5m[end - 1].closeTime > now) end--;

  const lastClose = end >= 1 ? klines5m[end - 1].close : NaN;
  if (isNaN(lastClose)) return { intact: false, lastClose };

  const intact =
    direction === "LONG" ? lastClose > structurePrice : lastClose < structurePrice;
  return { intact, lastClose };
}

// ── 3m EMA 31 confirmation filter ──────────────────────────

export interface EmaConfirmationResult {
  /** Whether price has broken above (LONG) or below (SHORT) the EMA */
  confirmed: boolean;
  /** Current EMA value */
  emaValue: number;
  /** Last closed price */
  lastClose: number;
  /** Human-readable label */
  label: string;
}

/**\ * 3m EMA 31 filter — final entry gate.
 *
 * LONG:  price must be ABOVE 3m EMA 31 → confirmed.
 * SHORT: price must be BELOW 3m EMA 31 → confirmed.
 *
 * If the price hasn't broken the 3m EMA 31 yet, wait.
 */
export function checkEma3mFilter(
  klines: Kline[],
  direction: "LONG" | "SHORT",
  emaPeriod = 31,
): EmaConfirmationResult {
  const closes = klines.map((k) => k.close);
  const ema = calculateEMA(closes, emaPeriod);

  // Use only closed candles
  const now = Date.now();
  let end = klines.length;
  while (end > 0 && klines[end - 1].closeTime > now) end--;

  const lastClose = end >= 1 ? klines[end - 1].close : NaN;
  const emaVal = end >= 1 ? ema[end - 1] : NaN;

  if (isNaN(lastClose) || isNaN(emaVal)) {
    return {
      confirmed: false,
      emaValue: NaN,
      lastClose,
      label: `EMA ${emaPeriod}: no data — waiting for ${direction}`,
    };
  }

  const confirmed = direction === "LONG" ? lastClose > emaVal : lastClose < emaVal;
  const dist = ((lastClose - emaVal) / emaVal * 100).toFixed(3);

  // Adaptive decimals: micro-cap prices (<$0.01) need 6–8 places,
  // otherwise toFixed(2) truncates to $0.00.
  const dp = emaVal < 0.001 ? 8 : emaVal < 0.01 ? 6 : emaVal < 1 ? 4 : 2;
  const fmt = (v: number) => `$${v.toFixed(dp)}`;

  return {
    confirmed,
    emaValue: emaVal,
    lastClose,
    label: `EMA${emaPeriod} ${fmt(emaVal)} | price ${fmt(lastClose)} (${dist}%) — ${confirmed ? "confirmed" : "waiting"} for ${direction}`,
  };
}

/**
 * Get the current live strategy state from 15m and 4h kline data.
 *
 * Pass `filterType: "macd"` and the pair's EMA period to match the live bot
 * (bot.ts uses `scanForSignals(k15, k4h, 4, "macd", cfg.ema15m)`).
 */
export function getCurrentState(
  klines15m: Kline[],
  klines4h: Kline[],
  pivotLookback: number = 4,
  emaPeriod15m: number = 50,
  filterType: FilterType = "ema",
): StrategyState | null {
  if (klines15m.length < 50 || klines4h.length < 75) return null;

  const closes15m = klines15m.map((k) => k.close);
  const ema50_15m = calculateEMA(closes15m, emaPeriod15m);
  const closes4h = klines4h.map((k) => k.close);
  const ema75_4h = calculateEMA(closes4h, 75);

  // 4H filter — same logic as scanForSignals (MACD histogram or EMA75)
  let macdHistogram4h: number = NaN;
  let filterLong: boolean;
  let filterShort: boolean;
  if (filterType === "macd") {
    const macd4h = calculateMACD(closes4h, 8, 17, 9);
    macdHistogram4h = macd4h.histogram[macd4h.histogram.length - 1];
    filterLong = macdHistogram4h > 0;
    filterShort = macdHistogram4h < 0;
  } else {
    const lastEma75 = ema75_4h[ema75_4h.length - 1];
    filterLong = closes4h[closes4h.length - 1] > lastEma75;
    filterShort = closes4h[closes4h.length - 1] < lastEma75;
  }

  const last15m = klines15m[klines15m.length - 1];
  const last4h = klines4h[klines4h.length - 1];

  const pivots = detectPivots(klines15m, pivotLookback);
  const { higherLows, lowerHighs } = detectSwings(pivots);

  // Find last two swing lows and swing highs
  const swingLows = pivots.filter((p) => p.type === "low");
  const swingHighs = pivots.filter((p) => p.type === "high");

  const lastSwingLow = swingLows.length > 0 ? swingLows[swingLows.length - 1] : null;
  const prevSwingLow = swingLows.length > 1 ? swingLows[swingLows.length - 2] : null;
  const lastSwingHigh = swingHighs.length > 0 ? swingHighs[swingHighs.length - 1] : null;
  const prevSwingHigh = swingHighs.length > 1 ? swingHighs[swingHighs.length - 2] : null;

  // Check most recent break state
  let brokeAboveEma = false;
  let brokeBelowEma = false;
  for (let i = klines15m.length - 1; i >= 1; i--) {
    if (isNaN(ema50_15m[i]) || isNaN(ema50_15m[i - 1])) continue;
    if (closes15m[i] > ema50_15m[i] && closes15m[i - 1] < ema50_15m[i - 1]) {
      brokeAboveEma = true;
      brokeBelowEma = false;
      break;
    }
    if (closes15m[i] < ema50_15m[i] && closes15m[i - 1] > ema50_15m[i - 1]) {
      brokeBelowEma = true;
      brokeAboveEma = false;
      break;
    }
  }

  // Check if higher low or lower high formed recently
  const recentHLs = higherLows.filter(
    (h) => h.index > klines15m.length - 50,
  );
  const recentLHs = lowerHighs.filter(
    (l) => l.index > klines15m.length - 50,
  );

  return {
    ema50_15m: ema50_15m[ema50_15m.length - 1],
    ema75_4h: ema75_4h[ema75_4h.length - 1],
    price4h: last4h.close,
    brokeAboveEma,
    brokeBelowEma,
    lastSwingHigh,
    lastSwingLow,
    prevSwingHigh,
    prevSwingLow,
    higherLowFormed: recentHLs.length > 0,
    lowerHighFormed: recentLHs.length > 0,
    fourHourFilterLong: filterLong,
    fourHourFilterShort: filterShort,
    macdHistogram4h,
  };
}

/**
 * Re-check the 4H filter against the CURRENT market data at entry time.
 * This prevents stale signals from entering when the 4H MACD has flipped
 * since the signal was originally generated.
 */
export function isCurrentFilterAllowed(
  klines4h: Kline[],
  direction: "LONG" | "SHORT",
  filterType: FilterType = "macd",
): boolean {
  if (klines4h.length < 30) return true; // not enough data — allow (fail-open)

  const closes4h = klines4h.map((k) => k.close);

  if (filterType === "macd") {
    const macd4h = calculateMACD(closes4h, 8, 17, 9);
    // Use the last CLOSED 4H bar (second-to-last element; last may be forming)
    const lastIdx = macd4h.histogram.length - 2;
    if (lastIdx < 0 || isNaN(macd4h.histogram[lastIdx])) return true;
    const hist = macd4h.histogram[lastIdx];
    return direction === "LONG" ? hist > 0 : hist < 0;
  } else {
    // EMA75 filter
    const ema75 = calculateEMA(closes4h, 75);
    const lastPrice = closes4h[closes4h.length - 2]; // last closed bar
    const lastEma = ema75[ema75.length - 2];
    if (isNaN(lastEma)) return true;
    return direction === "LONG" ? lastPrice > lastEma : lastPrice < lastEma;
  }
}
