/**
 * EXIT TELEMETRY — one shared implementation for both paper-book exit legs.
 *
 * Leg A (stops/targets) resolves in strategyEngine.resolveLayer2Exits;
 * Leg B (signal exits) is booked by each book's own signal-close mutation.
 * Both legs used to compute excursion/fees/hold-time inline with DIFFERENT
 * conventions (leg B charged 0.1%/side vs leg A's 6bps/2bps, and recorded no
 * MFE/MAE at all), which made exit-mix P&L incomparable. Everything here is
 * pure math over caller-supplied
 * bars — no fetching — so it is importable from Convex actions AND
 * mutations (which cannot fetch) AND unit-testable with vitest.
 *
 * Conventions (all inherited from leg A, the older leg):
 * - R unit = |entryPrice - slPrice| (the trade's own stop distance).
 * - Excursion walks post-entry bars only (bar.closeTime > entryTime);
 *   timeToMfe/Mae count post-entry bars, matching leg A's barIdx.
 * - barsHeld is in 15-minute units regardless of the bar timeframe that
 *   produced the excursion, so hold times compare across legs/books.
 * - Fees follow leg A: 6bps taker on entry (market), 6bps taker on a
 *   market exit (stop OR signal), 2bps maker on a limit TP fill.
 */

export interface ExcursionBar {
  high: number;
  low: number;
  closeTime: number;
}

export interface ExcursionTrade {
  /** "LONG" or "SHORT" (anything else reads as long — callers pass row.type). */
  type: string;
  entryPrice: number;
  slPrice: number;
  entryTime: number;
}

export interface Excursion {
  mfeR: number;
  maeR: number;
  timeToMfe?: number;
  timeToMae?: number;
}

/** Leg-A fee convention (fractions of notional). */
export const TAKER_FEE = 0.0006; // 6bps — market entry, stop exit, signal exit
export const MAKER_FEE = 0.0002; // 2bps — limit TP fill
/** Funding accrual matching leg A: 0.01% of notional per 8h window held. */
export const FUNDING_PER_8H = 0.0001;

/**
 * True excursion profile over a trade's full life — the exact leg-A loop,
 * extracted verbatim: per post-entry bar, favorable/adverse move in R,
 * running maxima, first-bar-index of each maximum. Non-finite inputs yield
 * zeros (leg A clamped with Math.max(0, …)); zero/negative risk yields zeros.
 */
export function computeExcursion(
  trade: ExcursionTrade,
  bars: readonly ExcursionBar[],
): Excursion {
  const risk = Math.abs(trade.entryPrice - trade.slPrice);
  if (!(risk > 0)) return { mfeR: 0, maeR: 0 };
  const isLong = trade.type !== "SHORT";
  let mfeR = 0;
  let maeR = 0;
  let timeToMfe: number | undefined;
  let timeToMae: number | undefined;
  let barIdx = 0;
  for (const bar of bars) {
    if (!(bar.closeTime > trade.entryTime)) continue;
    if (!Number.isFinite(bar.high) || !Number.isFinite(bar.low)) {
      barIdx++;
      continue;
    }
    const fav = isLong
      ? (bar.high - trade.entryPrice) / risk
      : (trade.entryPrice - bar.low) / risk;
    const adv = isLong
      ? (trade.entryPrice - bar.low) / risk
      : (bar.high - trade.entryPrice) / risk;
    if (fav > mfeR) {
      mfeR = fav;
      timeToMfe = barIdx;
    }
    if (adv > maeR) {
      maeR = adv;
      timeToMae = barIdx;
    }
    barIdx++;
  }
  return {
    mfeR: Math.max(0, mfeR),
    maeR: Math.max(0, maeR),
    timeToMfe,
    timeToMae,
  };
}

/**
 * Fallback snapshot excursion when full-life bars are unavailable — the leg-A
 * fallback: excursion implied by the exit price alone. Non-finite → zeros.
 */
export function snapshotExcursion(
  trade: ExcursionTrade,
  exitPrice: number,
): Excursion {
  const risk = Math.abs(trade.entryPrice - trade.slPrice);
  if (!(risk > 0) || !Number.isFinite(exitPrice)) return { mfeR: 0, maeR: 0 };
  const isLong = trade.type !== "SHORT";
  const favMove = isLong
    ? (exitPrice - trade.entryPrice) / risk
    : (trade.entryPrice - exitPrice) / risk;
  const advMove = isLong
    ? (trade.entryPrice - exitPrice) / risk
    : (exitPrice - trade.entryPrice) / risk;
  return { mfeR: Math.max(0, favMove), maeR: Math.max(0, advMove) };
}

/** Round-trip fees in USD under the leg-A convention. */
export function closeFeesUsd(
  entryPrice: number,
  sizeCoin: number,
  exitIsTakeProfit: boolean,
): number {
  const notional = entryPrice * sizeCoin;
  if (!(notional > 0)) return 0;
  const entryFee = notional * TAKER_FEE;
  const exitFee = notional * (exitIsTakeProfit ? MAKER_FEE : TAKER_FEE);
  return entryFee + exitFee;
}

/** Funding accrual in USD: full 8h windows held × rate × notional. */
export function fundingCostUsd(
  entryPrice: number,
  sizeCoin: number,
  entryTime: number,
  exitTime: number,
): number {
  const notional = entryPrice * sizeCoin;
  if (!(notional > 0)) return 0;
  const windows = Math.floor(Math.max(0, exitTime - entryTime) / (8 * 3_600_000));
  return windows * FUNDING_PER_8H * notional;
}

export type DurationBucket = "fast" | "medium" | "slow";

/** Hold time in 15m-bar units + leg-A bucket thresholds (≤4 / ≤16 / rest). */
export function holdProfile(
  entryTime: number,
  exitTime: number,
): { barsHeld: number; durationBucket: DurationBucket } {
  const barsHeld = Math.max(0, Math.round((exitTime - entryTime) / 900_000));
  return {
    barsHeld,
    durationBucket: barsHeld <= 4 ? "fast" : barsHeld <= 16 ? "medium" : "slow",
  };
}

/** MFE capture ratio: share of the max favorable move actually banked. */
export function captureRatio(
  realizedR: number,
  mfeR: number,
): number | undefined {
  if (!(mfeR > 0) || !Number.isFinite(realizedR)) return undefined;
  return +((realizedR / mfeR).toFixed(4));
}

/**
 * ATR as % of price — simple mean of true ranges, matching leg A's volAtExit
 * computation (which averages TR over 14 on 15m bars). Callers choose the
 * timeframe; callers document which bar spec volAtExit/Entry/Delta use
 * (never mix 15m-ATR% rows with 1H-ATR% rows).
 */
export function atrPct(
  highs: readonly number[],
  lows: readonly number[],
  closes: readonly number[],
  period = 14,
): number | undefined {
  const n = Math.min(highs.length, lows.length, closes.length);
  if (n < period + 1) return undefined;
  let sum = 0;
  for (let i = n - period; i < n; i++) {
    const prev = closes[i - 1] ?? closes[i];
    sum += Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - prev),
      Math.abs(lows[i] - prev),
    );
  }
  const ref = closes[n - 1] || 1;
  const out = (sum / period / ref) * 100;
  return Number.isFinite(out) ? +out.toFixed(4) : undefined;
}
