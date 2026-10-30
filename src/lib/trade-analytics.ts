/**
 * TRADE ANALYTICS (2026-09-23) — PURE, shared by both books.
 *
 * These are the per-trade derivations that both the paper and live books
 * record at close (excursion profile, duration bucket, MFE capture, entry
 * slippage). They previously lived only as module-private helpers inside
 * convex/paperTrading.ts, so the live book — which had no equivalent — could
 * not record them, and every finding built on `mfeR`/`maeR` was paper-only.
 *
 * Keeping ONE implementation means the two books are guaranteed to compute the
 * same number from the same bars. That is the same rule the R-lock refactor
 * imposed (src/lib/r-lock.ts): two implementations of one decision rule is how
 * a live book drifts from the measurement that justified it.
 */

export interface OhlcBar {
  high: number;
  low: number;
  close: number;
}

/**
 * Max favourable / adverse excursion in R across a trade's life, plus the
 * 0-based bar index at which each extreme occurred (timeToMfe / timeToMae) —
 * the retrace-profile data used for ratchet tuning: "at which R did price pull
 * back before continuing?"
 *
 * Mirrors paperTrading's original `excursionRFull` exactly.
 */
export function excursionR(
  type: string,
  entryPrice: number,
  slPrice: number,
  bars: readonly OhlcBar[],
): { mfeR: number; maeR: number; timeToMfe?: number; timeToMae?: number } {
  const riskDist = Math.abs(entryPrice - slPrice);
  if (!(riskDist > 0)) return { mfeR: 0, maeR: 0 };
  let mfe = 0;
  let mae = 0;
  let timeToMfe: number | undefined;
  let timeToMae: number | undefined;
  let barIdx = 0;
  for (const bar of bars) {
    if (type === "LONG") {
      const fav = (bar.high - entryPrice) / riskDist;
      const adv = (entryPrice - bar.low) / riskDist;
      if (fav > mfe) { mfe = fav; timeToMfe = barIdx; }
      if (adv > mae) { mae = adv; timeToMae = barIdx; }
    } else {
      const fav = (entryPrice - bar.low) / riskDist;
      const adv = (bar.high - entryPrice) / riskDist;
      if (fav > mfe) { mfe = fav; timeToMfe = barIdx; }
      if (adv > mae) { mae = adv; timeToMae = barIdx; }
    }
    barIdx++;
  }
  return { mfeR: Math.max(0, mfe), maeR: Math.max(0, mae), timeToMfe, timeToMae };
}

/** 15m-bar duration bucket — same cut points as both books have always used. */
export function durationBucketOf(barsHeld: number): string {
  return barsHeld <= 4 ? "fast" : barsHeld <= 16 ? "medium" : "slow";
}

/** How much of the available move the exit kept: realizedR / mfeR. */
export function captureRatioOf(realizedR: number, mfeR?: number): number | undefined {
  if (mfeR == null || mfeR === 0) return undefined;
  const r = +(realizedR / mfeR).toFixed(4);
  return Number.isFinite(r) ? r : undefined;
}

/** Entry price vs the signal bar's price, in basis points. */
export function slippageBpsOf(
  entryPrice: number,
  signalPrice?: number,
): number | undefined {
  if (signalPrice == null || !(signalPrice > 0) || !(entryPrice > 0)) return undefined;
  return Math.abs(entryPrice - signalPrice) / entryPrice * 10_000;
}

/**
 * % change across a 1h kline window (used for btcMoveDuringTrade /
 * ethMoveDuringTrade): last close vs first close. Needs ≥ 2 bars.
 */
export function movePctOf(bars: readonly { close: number }[]): number | undefined {
  if (!bars || bars.length < 2) return undefined;
  const first = bars[0].close;
  const last = bars[bars.length - 1].close;
  if (!(first > 0)) return undefined;
  const pct = +(((last - first) / first) * 100).toFixed(4);
  return Number.isFinite(pct) ? pct : undefined;
}
