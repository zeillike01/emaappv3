/**
 * DEFERRED ENTRY — "not yet" as a third answer (2026-10-23).
 *
 * The stack can currently say yes (enter) or no (veto). The operator's rule is
 * a third answer: when a signal fires while price is OVER-EXTENDED, do not
 * enter and do not discard — park the setup and enter only once the turn is
 * visible on 15m closes.
 *
 * THE RULE (15m decisions, operator's words):
 *   · Stretch test at the signal bar: distance from the rolling VWAP plus an
 *     oscillator extreme. Not stretched → enter exactly as today.
 *   · Parked setup keeps the over-extended extreme and the FORMER HIGHER LOW
 *     (short) / former lower high (long). The guard level IS the expiry: there
 *     is no bar count and no session boundary, the wait lasts as long as price
 *     respects that level.
 *   · Cancel on a break of the guard (the move already happened — entering
 *     there is chasing the break) or on a new extreme beyond the parked one
 *     (the premise "this is the extended high" is gone).
 *   · Enter when BOTH: a lower high is confirmed (mirror: higher low) AND the
 *     MACD histogram weakens across the last `histBars` closes. One without the
 *     other keeps waiting.
 *
 * Pure: no I/O and no Convex imports. The engine tick and the lab call the
 * same functions, so the backtest measures the shipped rule rather than a
 * lookalike. Series are built once per pair by buildDeferralSeries().
 */
import type { Kline, Signal } from "./types";
import { calculateMACD } from "./strategy";
import { rsiSeries } from "./htf-advisor";

export interface DeferralConfig {
  /** % from rolling VWAP that counts as stretched. Measured on the cached
   *  90-day window: |dist| p97 is ~1.1% on BTC and ~1.8% on alts, so 3% fired
   *  on 0.08% of bars and the rule never engaged. 1.5% sits just inside p99. */
  overExtendVwapPct: number;
  /** Short-side oscillator extreme; the long side mirrors it (100 - this).
   *  65 = RSI(7)'s top decile, which is where exhaustion actually prints. */
  overExtendRsi: number;
  rsiPeriod: number;
  /** Bars in the rolling VWAP window. */
  vwapBars: number;
  /** Closed 15m candles the histogram must weaken across (2-3 per the rule). */
  histBars: number;
  /** Bars on each side of a pivot for confirmation (2 = classic swing). */
  pivotLookback: number;
  /** The PEAK after the lower high must sit 2-3 closed candles back (operator
   *  rule) and every candle since must fade. */
  peakLagMin: number;
  peakLagMax: number;
  /** How far back to search for that histogram peak. */
  peakLookbackBars: number;
  /** Require a GREEN peak for a SHORT / RED trough for a LONG ("peak green
   *  histogram"); false accepts a fade from either side of zero. */
  requirePeakSign: boolean;
  /** true (default) = only park signals that fire while STRETCHED. false =
   *  defer every signal (diagnostic: prices the timing rule alone, without the
   *  stretch gate, so the two effects can be told apart). */
  requireStretch?: boolean;
  /** How far back to look for the guard level's pivot. */
  guardLookbackBars: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
}

export const DEFERRAL_DEFAULTS: DeferralConfig = {
  overExtendVwapPct: 1.5,
  overExtendRsi: 65,
  rsiPeriod: 7,
  vwapBars: 24,
  histBars: 3,
  pivotLookback: 2,
  peakLagMin: 2,
  peakLagMax: 3,
  peakLookbackBars: 10,
  requirePeakSign: true,
  guardLookbackBars: 24,
  // 6/14/10 — the same MACD the 4H advisor uses, so "histogram" means one
  // thing across the stack instead of drifting per layer.
  macdFast: 6,
  macdSlow: 14,
  macdSignal: 10,
};

export interface DeferralSeries {
  /** MACD histogram per bar (NaN during warm-up). */
  hist: number[];
  /** RSI per bar (NaN during warm-up). */
  rsi: number[];
  /** Rolling VWAP per bar (NaN during warm-up). */
  vwap: number[];
}

/** Build the per-bar series once; every decision below reads these arrays. */
export function buildDeferralSeries(
  bars: Kline[],
  cfg: DeferralConfig = DEFERRAL_DEFAULTS,
): DeferralSeries {
  const closes = bars.map((b) => b.close);
  const { histogram } = calculateMACD(closes, cfg.macdFast, cfg.macdSlow, cfg.macdSignal);
  const rsi = rsiSeries(closes, cfg.rsiPeriod);
  const vwap = new Array<number>(bars.length).fill(NaN);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    const typical = (b.high + b.low + b.close) / 3;
    const v = b.volume ?? 0;
    pv += typical * v;
    vol += v;
    if (i >= cfg.vwapBars) {
      const old = bars[i - cfg.vwapBars];
      const oldTypical = (old.high + old.low + old.close) / 3;
      const oldVol = old.volume ?? 0;
      pv -= oldTypical * oldVol;
      vol -= oldVol;
    }
    if (i >= cfg.vwapBars - 1 && vol > 0) vwap[i] = pv / vol;
  }
  return { hist: histogram, rsi, vwap };
}

export interface StretchRead {
  extended: boolean;
  /** Signed % from VWAP (positive = above value). NaN during warm-up. */
  vwapDistPct: number;
  rsi: number;
}

/**
 * Is price stretched at this bar, on `side`?
 *
 * A SHORT is stretched when price sits ABOVE value by the threshold AND the
 * oscillator is hot; a LONG mirrors both (below value, oversold). Warm-up
 * returns `extended: false` — a gate that cannot measure must not park a
 * signal forever.
 */
export function stretchAt(
  bars: Kline[],
  series: DeferralSeries,
  idx: number,
  side: "LONG" | "SHORT",
  cfg: DeferralConfig = DEFERRAL_DEFAULTS,
): StretchRead {
  const v = series.vwap[idx];
  const r = series.rsi[idx];
  const price = bars[idx]?.close;
  if (!Number.isFinite(v) || !Number.isFinite(r) || !Number.isFinite(price) || v <= 0) {
    return { extended: false, vwapDistPct: NaN, rsi: r };
  }
  const dist = ((price - v) / v) * 100;
  const extended =
    side === "SHORT"
      ? dist >= cfg.overExtendVwapPct && r >= cfg.overExtendRsi
      : dist <= -cfg.overExtendVwapPct && r <= 100 - cfg.overExtendRsi;
  return { extended, vwapDistPct: dist, rsi: r };
}

export interface ParkedSetup {
  side: "LONG" | "SHORT";
  signalIndex: number;
  /** The over-extended high (short) / low (long) the setup is anchored to. */
  extreme: number;
  extremeIndex: number;
  /** Former higher low (short) / former lower high (long) — the expiry level. */
  guard: number;
  guardIndex: number;
}

/** A classical swing pivot: strictly beyond `lb` bars on both sides. */
export function isPivot(
  bars: Kline[],
  idx: number,
  kind: "high" | "low",
  lb: number,
): boolean {
  if (idx - lb < 0 || idx + lb >= bars.length) return false;
  const at = kind === "high" ? bars[idx].high : bars[idx].low;
  for (let k = 1; k <= lb; k++) {
    const before = kind === "high" ? bars[idx - k].high : bars[idx - k].low;
    const after = kind === "high" ? bars[idx + k].high : bars[idx + k].low;
    if (kind === "high" ? before >= at || after >= at : before <= at || after <= at) return false;
  }
  return true;
}

/**
 * Park a stretched signal: find the extreme it ran to and the guard level that
 * invalidates the wait. Returns null when no guard pivot exists in the lookback
 * (the setup has no measurable expiry, so the caller should not park it).
 */
export function parkSetup(
  bars: Kline[],
  side: "LONG" | "SHORT",
  signalIndex: number,
  cfg: DeferralConfig = DEFERRAL_DEFAULTS,
): ParkedSetup | null {
  const lb = cfg.pivotLookback;
  const from = Math.max(0, signalIndex - lb * 2);
  let extremeIndex = signalIndex;
  for (let i = from; i <= signalIndex; i++) {
    if (side === "SHORT" ? bars[i].high >= bars[extremeIndex].high : bars[i].low <= bars[extremeIndex].low) {
      extremeIndex = i;
    }
  }
  const guardKind = side === "SHORT" ? "low" : "high";
  const searchFrom = Math.max(lb, extremeIndex - cfg.guardLookbackBars);
  for (let i = extremeIndex - 1; i >= searchFrom; i--) {
    if (!isPivot(bars, i, guardKind, lb)) continue;
    return {
      side,
      signalIndex,
      extreme: side === "SHORT" ? bars[extremeIndex].high : bars[extremeIndex].low,
      extremeIndex,
      guard: side === "SHORT" ? bars[i].low : bars[i].high,
      guardIndex: i,
    };
  }
  return null;
}

/** Strictly weakening (short) / strengthening (long) histogram over `bars`. */
export function histogramTurning(
  hist: number[],
  idx: number,
  side: "LONG" | "SHORT",
  bars: number,
): boolean {
  if (idx - bars + 1 < 0) return false;
  for (let k = 1; k < bars; k++) {
    const prev = hist[idx - k];
    const cur = hist[idx - k + 1];
    if (!Number.isFinite(prev) || !Number.isFinite(cur)) return false;
    if (side === "SHORT" ? !(cur < prev) : !(cur > prev)) return false;
  }
  return true;
}

/**
 * The histogram PEAK then fade the operator described: after the lower high,
 * the histogram prints a local peak (green for a short / red for a long), and
 * 2-3 closed candles later it is weakening — every candle after the peak is
 * weaker than the one before.
 *
 * `fromIdx` is the lower-high pivot: the peak has to arrive AFTER the turn, so
 * an old peak from before the structure broke cannot qualify.
 */
export function histogramPeakThenFade(
  hist: number[],
  idx: number,
  side: "LONG" | "SHORT",
  cfg: DeferralConfig = DEFERRAL_DEFAULTS,
  fromIdx = 0,
): { ok: boolean; lag: number; peak: number } {
  const lo = Math.max(0, idx - cfg.peakLookbackBars, fromIdx);
  if (idx - lo < cfg.peakLagMin) return { ok: false, lag: 0, peak: NaN };
  let peakIdx = lo;
  for (let i = lo; i <= idx; i++) {
    if (!Number.isFinite(hist[i])) return { ok: false, lag: 0, peak: NaN };
    if (side === "SHORT" ? hist[i] > hist[peakIdx] : hist[i] < hist[peakIdx]) peakIdx = i;
  }
  const lag = idx - peakIdx;
  const peak = hist[peakIdx];
  if (lag < cfg.peakLagMin || lag > cfg.peakLagMax) return { ok: false, lag, peak };
  // "peak GREEN histogram" (mirror: red trough for a long) — a fade that never
  // crossed zero is momentum noise, not an exhaustion print.
  if (cfg.requirePeakSign && (side === "SHORT" ? !(peak > 0) : !(peak < 0))) {
    return { ok: false, lag, peak };
  }
  for (let i = peakIdx + 1; i <= idx; i++) {
    if (side === "SHORT" ? !(hist[i] < hist[i - 1]) : !(hist[i] > hist[i - 1])) {
      return { ok: false, lag, peak };
    }
  }
  return { ok: true, lag, peak };
}

export type AdvanceResult =
  | { action: "wait"; reason: string }
  | { action: "enter"; barIndex: number; reason: string }
  | { action: "cancel"; barIndex: number; reason: string };

/**
 * Evaluate a parked setup on the close of bar `idx` (idx > signalIndex).
 *
 * Order matters: invalidation is checked BEFORE confirmation, because a bar
 * that breaks the guard while the histogram fades is a failed setup, not an
 * entry — and a bar that prints a new extreme above the anchor means the
 * "extended high" premise is gone.
 */
export function advanceParked(
  bars: Kline[],
  series: DeferralSeries,
  setup: ParkedSetup,
  idx: number,
  cfg: DeferralConfig = DEFERRAL_DEFAULTS,
): AdvanceResult {
  const bar = bars[idx];
  if (!bar) return { action: "wait", reason: "no bar" };
  const lb = cfg.pivotLookback;

  if (setup.side === "SHORT") {
    if (bar.high > setup.extreme) {
      return { action: "cancel", barIndex: idx, reason: "new high above the extended extreme" };
    }
    if (bar.close < setup.guard) {
      return { action: "cancel", barIndex: idx, reason: "former higher low broken" };
    }
    const pivotIdx = idx - lb;
    const lowerHigh =
      pivotIdx > setup.signalIndex &&
      isPivot(bars, pivotIdx, "high", lb) &&
      bars[pivotIdx].high < setup.extreme;
    if (!lowerHigh) return { action: "wait", reason: "no confirmed lower high yet" };
    const fade = histogramPeakThenFade(series.hist, idx, "SHORT", cfg, pivotIdx);
    if (!fade.ok) {
      return {
        action: "wait",
        reason: `lower high formed, histogram has not printed a green peak ${cfg.peakLagMin}-${cfg.peakLagMax} bars back and faded since`,
      };
    }
    return {
      action: "enter",
      barIndex: idx,
      reason: `lower high at ${bars[pivotIdx].high.toFixed(6)} below ${setup.extreme.toFixed(6)} + histogram fading ${cfg.histBars} bars`,
    };
  }

  if (bar.low < setup.extreme) {
    return { action: "cancel", barIndex: idx, reason: "new low below the extended extreme" };
  }
  if (bar.close > setup.guard) {
    return { action: "cancel", barIndex: idx, reason: "former lower high broken" };
  }
  const pivotIdx = idx - lb;
  const higherLow =
    pivotIdx > setup.signalIndex &&
    isPivot(bars, pivotIdx, "low", lb) &&
    bars[pivotIdx].low > setup.extreme;
  if (!higherLow) return { action: "wait", reason: "no confirmed higher low yet" };
  const fade = histogramPeakThenFade(series.hist, idx, "LONG", cfg, pivotIdx);
  if (!fade.ok) {
    return {
      action: "wait",
      reason: `higher low formed, histogram has not printed a red trough ${cfg.peakLagMin}-${cfg.peakLagMax} bars back and risen since`,
    };
  }
  return {
    action: "enter",
    barIndex: idx,
    reason: `higher low at ${bars[pivotIdx].low.toFixed(6)} above ${setup.extreme.toFixed(6)} + histogram rising ${cfg.histBars} bars`,
  };
}

/** Result of re-timing one signal list. */
export interface DeferralReport {
  /** Signals that fired stretched and were parked. */
  deferred: number;
  /** Parked setups that never confirmed (guard break / new extreme / end of data). */
  cancelled: number;
  /** Bars each entered setup waited (for the lab's wait-time distribution). */
  waits: number[];
}

/**
 * Re-time a scanned signal list through the deferred-entry rule.
 *
 * Not stretched → the signal is passed through UNCHANGED (the shipped engine),
 * stretched → it is parked and either re-issued at the confirming bar (with the
 * parked extreme for stop anchoring) or dropped. `wait` is bounded only by the
 * data: the rule has no timer by design.
 */
export function deferSignals(
  signals: Signal[],
  bars: Kline[],
  cfg: DeferralConfig = DEFERRAL_DEFAULTS,
): { signals: Signal[]; report: DeferralReport } {
  const series = buildDeferralSeries(bars, cfg);
  const out: Signal[] = [];
  const report: DeferralReport = { deferred: 0, cancelled: 0, waits: [] };

  for (const sig of signals) {
    const side = sig.type;
    const read = stretchAt(bars, series, sig.index, side, cfg);
    if (cfg.requireStretch !== false && !read.extended) {
      out.push(sig);
      continue;
    }
    const setup = parkSetup(bars, side, sig.index, cfg);
    if (!setup) {
      out.push(sig); // no measurable guard → nothing to wait on; ship as-is
      continue;
    }
    report.deferred += 1;
    let resolved = false;
    for (let j = sig.index + 1; j < bars.length; j++) {
      const step = advanceParked(bars, series, setup, j, cfg);
      if (step.action === "wait") continue;
      resolved = true;
      if (step.action === "enter") {
        report.waits.push(j - sig.index);
        out.push({
          ...sig,
          index: j,
          time: bars[j].closeTime,
          price: bars[j].close,
          reason: `${sig.reason} · deferred ${j - sig.index} bars: ${step.reason}`,
          deferral: {
            extreme: setup.extreme,
            guard: setup.guard,
            waitedBars: j - sig.index,
          },
        });
      } else {
        report.cancelled += 1;
      }
      break;
    }
    if (!resolved) report.cancelled += 1; // never confirmed before the data ended
  }
  return { signals: out, report };
}
