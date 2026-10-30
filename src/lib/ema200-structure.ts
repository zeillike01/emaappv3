/**
 * 15m EMA200 SUPPORT/RESISTANCE GATE (EMA200-SR) — lab-only structure filter.
 *
 * THE RULE (one trader, 2026-09-25):
 *   "Don't take a LONG when price is below the 200EMA and it is acting as
 *    resistance. Long only if it is acting as support and below the price.
 *    Mirror in SHORT."
 *
 * That sentence packs two DIFFERENT claims, and they are kept apart here
 * because they are not the same filter:
 *
 *   POSITION — price sits on the trade's side of the EMA (close > EMA for a
 *              LONG). "The EMA is below the price" / "above the price".
 *   ROLE     — the EMA actually *acted* as support/resistance rather than
 *              merely being on one side: inside the last `touchLookbackBars`
 *              closed candles price traded into the EMA zone and was turned
 *              back on the same candle (a LONG needs low <= EMA*(1+tol) AND
 *              close > EMA on that candle). A close through the EMA is a
 *              break, not a hold, so it never counts as a touch.
 *
 * Two optional arms tighten it:
 *   SLOPE     — the EMA is rising for a LONG (falling for a SHORT).
 *   EXTENSION — refuse when price is already `maxExtensionPct` away from the
 *               EMA (buying a stretched tape is not a support entry).
 *
 * CAUSALITY. Only bars whose `closeTime <= at` are read. The series is built by
 * the engine's own `calculateEMA` (SMA-seeded, NaN before `period-1`), and an
 * EMA is a purely backward recursion, so a series precomputed over the FULL
 * bars array and read at index `end` is identical to one built on bars[0..end].
 * Never feed this a precomputed series from a non-causal indicator.
 *
 * A `null` read means "no warm-up / no opinion" and the gate ALLOWS. That is
 * the same fail-open convention as `one-hour-rejection.ts`: failing closed
 * would silently delete the first `period` bars of every late-listed pair and
 * make the gate look like a universe filter.
 */

import { calculateEMA } from "./strategy";

export type Ema200Side = "LONG" | "SHORT";

export type Ema200GateCfg = {
  /** EMA period on the entry timeframe (200 = the rule). */
  period: number;
  /** Bars back used to measure the EMA's slope. 0 = slope arm OFF. */
  slopeLookbackBars: number;
  /**
   * How many closed candles back a touch-and-hold may be found. 0 = arm OFF.
   * Read this WITH `maxTouchAgeBars`: only a candle the age test can still
   * accept changes the verdict, so any window wider than `maxTouchAgeBars + 1`
   * is INERT. Two sweeps that differ only in window size (e.g. 10 vs 20 with
   * maxAge 3) are the same filter and will produce identical numbers.
   */
  touchLookbackBars: number;
  /** How close (in % of the EMA) counts as "traded into the EMA zone". */
  touchTolerancePct: number;
  /** The most recent touch-and-hold must be at most this old. */
  maxTouchAgeBars: number;
  /** Refuse entries further than this % from the EMA. 0 = extension arm OFF. */
  maxExtensionPct: number;
};

/** The rule as stated: position + role, no slope / extension arms. */
export const EMA200_GATE_DEFAULT: Ema200GateCfg = {
  period: 200,
  slopeLookbackBars: 0,
  touchLookbackBars: 20,
  touchTolerancePct: 0.35,
  maxTouchAgeBars: 3,
  maxExtensionPct: 0,
};

export type Ema200Verdict =
  | "allowed"
  | "wrong-side" // price is on the wrong side of the EMA (the core rule)
  | "slope-against" // the EMA is not sloping the trade's way
  | "no-touch" // no recent touch-and-hold — the EMA never acted as S/R
  | "extended"; // price too far from the EMA to be a support/resistance entry

export type Ema200Read = {
  side: Ema200Side;
  allow: boolean;
  verdict: Ema200Verdict;
  /** EMA value on the last closed candle. */
  ema: number;
  /** That candle's close. */
  close: number;
  /** (close − ema) / ema, in %, signed. Positive = price above the EMA. */
  distPct: number;
  /** EMA change over `slopeLookbackBars`, in %. NaN when the arm is off. */
  slopePct: number;
  /** Closed candles since the last touch-and-hold. null = none found. */
  touchAgoBars: number | null;
  /** Index into `bars` of the last closed candle the read used. */
  barIndex: number;
};

type Ohlc = { closeTime: number; high: number; low: number; close: number };

/** EMA series aligned 1:1 with `bars` (NaN before the seed). */
export function ema200Series(bars: readonly Ohlc[], period: number): number[] {
  return calculateEMA(
    bars.map((b) => b.close),
    period,
  );
}

/** Index of the newest bar already closed at `at`, or −1. */
function lastClosedIndex(bars: readonly Ohlc[], at: number): number {
  let end = bars.length - 1;
  while (end >= 0 && bars[end]!.closeTime > at) end--;
  return end;
}

/**
 * Read the gate at `at` for one side.
 *
 * `precomputedEma` must be an EMA series aligned with `bars` (see the causality
 * note above); omitted, the series is built from bars[0..end]. Returns null when
 * there is not enough history for `period` bars — the caller should ALLOW.
 */
export function ema200GateReadAt(
  bars: readonly Ohlc[],
  at: number,
  side: Ema200Side,
  cfg: Ema200GateCfg = EMA200_GATE_DEFAULT,
  precomputedEma?: readonly number[],
): Ema200Read | null {
  if (cfg.period < 2 || bars.length === 0) return null;
  const end = lastClosedIndex(bars, at);
  if (end < 0 || end + 1 < cfg.period) return null;

  const series =
    precomputedEma && precomputedEma.length === bars.length
      ? precomputedEma
      : calculateEMA(
          bars.slice(0, end + 1).map((b) => b.close),
          cfg.period,
        );

  const ema = series[end]!;
  if (!Number.isFinite(ema) || ema <= 0) return null;
  const close = bars[end]!.close;
  const distPct = ((close - ema) / ema) * 100;

  let slopePct = NaN;
  if (cfg.slopeLookbackBars > 0) {
    const prev = series[end - cfg.slopeLookbackBars]!;
    if (prev !== undefined && Number.isFinite(prev) && prev > 0) {
      slopePct = ((ema - prev) / prev) * 100;
    }
  }

  // Most recent candle that touched the EMA zone and held on the same candle.
  let touchAgoBars: number | null = null;
  if (cfg.touchLookbackBars > 0) {
    const from = Math.max(cfg.period - 1, end - cfg.touchLookbackBars + 1);
    for (let i = end; i >= from; i--) {
      const e = series[i]!;
      if (!Number.isFinite(e) || e <= 0) continue;
      const b = bars[i]!;
      const touched =
        side === "LONG"
          ? b.low <= e * (1 + cfg.touchTolerancePct / 100)
          : b.high >= e * (1 - cfg.touchTolerancePct / 100);
      const held = side === "LONG" ? b.close > e : b.close < e;
      if (touched && held) {
        touchAgoBars = end - i;
        break;
      }
    }
  }

  const base = { side, ema, close, distPct, slopePct, touchAgoBars, barIndex: end };
  const blocked = (verdict: Ema200Verdict): Ema200Read => ({ ...base, allow: false, verdict });

  // 1. POSITION — the core of the rule.
  if (side === "LONG" ? close <= ema : close >= ema) return blocked("wrong-side");
  // 2. SLOPE (optional). An unmeasurable slope at the warm edge does not arm.
  if (cfg.slopeLookbackBars > 0 && Number.isFinite(slopePct)) {
    if (side === "LONG" ? slopePct <= 0 : slopePct >= 0) return blocked("slope-against");
  }
  // 3. ROLE (optional) — the EMA must have acted as support/resistance.
  if (cfg.touchLookbackBars > 0) {
    if (touchAgoBars == null || touchAgoBars > cfg.maxTouchAgeBars) return blocked("no-touch");
  }
  // 4. EXTENSION (optional) — no stretched support entries.
  if (cfg.maxExtensionPct > 0 && Math.abs(distPct) > cfg.maxExtensionPct) return blocked("extended");

  return { ...base, allow: true, verdict: "allowed" };
}

/** Boolean form: a null read (no warm-up) ALLOWS. */
export function ema200GateAllows(
  bars: readonly Ohlc[],
  at: number,
  side: Ema200Side,
  cfg: Ema200GateCfg = EMA200_GATE_DEFAULT,
  precomputedEma?: readonly number[],
): boolean {
  return ema200GateReadAt(bars, at, side, cfg, precomputedEma)?.allow ?? true;
}

/** Compact label for sweeps, e.g. `P+T+S+X`. */
export function ema200GateLabel(cfg: Ema200GateCfg): string {
  const parts = ["P"];
  if (cfg.slopeLookbackBars > 0) parts.push("S");
  if (cfg.touchLookbackBars > 0) parts.push("T");
  if (cfg.maxExtensionPct > 0) parts.push("X");
  return parts.join("+");
}
