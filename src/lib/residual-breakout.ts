/** Lab-only signal primitives. No exposure-estimator fallback, clamp, I/O or live imports. */
import type { CachedKline } from "./kline-cache";

export const RESIDUAL_SPEC = { betaBars: 96, breakoutBars: 20, persistenceBars: 3, requiredSigns: 2, barMs: 900_000 } as const;
export type Side = "LONG" | "SHORT";
export type PriceBar = Pick<CachedKline, "openTime" | "closeTime" | "close">;
export type BetaFit = { available: true; beta: number; observations: number } | {
  available: false; reason: "insufficient" | "unaligned-or-invalid" | "degenerate";
};

/** Fit exactly 96 prior one-bar returns. Current trigger return is EXCLUDED.
 * Timestamp intersection is not enough: both endpoints must exist and be 15m apart.
 * Missing bars do not become multi-bar returns; negative/extreme finite betas are not clamped.
 */
export function strictBetaAt(pair: readonly PriceBar[], btc: ReadonlyMap<number, PriceBar>, index: number, lookback = RESIDUAL_SPEC.betaBars): BetaFit {
  if (!Number.isInteger(lookback) || lookback < 2 || index < lookback + 1) return { available: false, reason: "insufficient" };
  const rp: number[] = [], rb: number[] = [];
  for (let j = index - lookback; j < index; j++) {
    const a = pair[j - 1], b = pair[j];
    const x = a && btc.get(a.openTime), y = b && btc.get(b.openTime);
    if (!a || !b || !x || !y || b.openTime - a.openTime !== RESIDUAL_SPEC.barMs ||
      [a, b, x, y].some((v) => !Number.isFinite(v.close) || v.close <= 0 || v.closeTime !== v.openTime + RESIDUAL_SPEC.barMs) ||
      y.openTime - x.openTime !== RESIDUAL_SPEC.barMs) return { available: false, reason: "unaligned-or-invalid" };
    rp.push(b.close / a.close - 1); rb.push(y.close / x.close - 1);
  }
  const meanP = mean(rp), meanB = mean(rb);
  let cov = 0, variance = 0;
  for (let j = 0; j < rp.length; j++) { cov += (rp[j] - meanP) * (rb[j] - meanB); variance += (rb[j] - meanB) ** 2; }
  if (!(variance / lookback > 1e-16)) return { available: false, reason: "degenerate" };
  const beta = cov / variance;
  return Number.isFinite(beta) ? { available: true, beta, observations: lookback } : { available: false, reason: "degenerate" };
}
export const mean = (xs: readonly number[]): number => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/** Strict extrema against PRECEDING 20 path values; persistence includes the trigger bar.
 * A null/gap resets the path segment: never bridge unavailable residual history.
 */
export function breakoutSide(path: readonly (number | null)[], returns: readonly (number | null)[], index: number): Side | null {
  const n = RESIDUAL_SPEC.breakoutBars;
  if (index < n) return null;
  const window = path.slice(index - n, index + 1);
  const signs = returns.slice(index - 2, index + 1);
  if (window.length !== n + 1 || signs.length !== 3 || [...window, ...signs].some((v) => v == null || !Number.isFinite(v))) return null;
  const current = path[index]!;
  const prior = window.slice(0, -1) as number[];
  if (current > Math.max(...prior) && signs.filter((v) => v! > 0).length >= 2) return "LONG";
  if (current < Math.min(...prior) && signs.filter((v) => v! < 0).length >= 2) return "SHORT";
  return null;
}

export function buildBreakoutPaths(pair: readonly PriceBar[], btcBars: readonly PriceBar[]) {
  const btc = new Map(btcBars.map((b) => [b.openTime, b]));
  const rawReturns: (number | null)[] = [], residualReturns: (number | null)[] = [];
  const rawPath: (number | null)[] = [], residualPath: (number | null)[] = [];
  const fits: BetaFit[] = [];
  const unavailable: Record<string, number> = {};
  for (let i = 0; i < pair.length; i++) {
    const fit = strictBetaAt(pair, btc, i); fits.push(fit);
    const prev = pair[i - 1], bar = pair[i];
    const valid = prev && bar.openTime - prev.openTime === RESIDUAL_SPEC.barMs &&
      [prev, bar].every((b) => Number.isFinite(b.close) && b.close > 0 && b.closeTime === b.openTime + RESIDUAL_SPEC.barMs);
    const raw = valid ? bar.close / prev.close - 1 : null;
    rawReturns.push(raw);
    rawPath.push(raw == null ? null : (rawPath[i - 1] ?? 0) + raw);
    const x = prev && btc.get(prev.openTime), y = btc.get(bar.openTime);
    const currentAligned = x && y && [x, y].every((b) => Number.isFinite(b.close) && b.close > 0 && b.closeTime === b.openTime + RESIDUAL_SPEC.barMs);
    const residual = fit.available && raw != null && currentAligned ? raw - fit.beta * (y.close / x.close - 1) : null;
    residualReturns.push(residual);
    residualPath.push(residual == null ? null : (residualPath[i - 1] ?? 0) + residual);
    if (residual == null) { const reason = fit.available ? "trigger-unaligned" : fit.reason; unavailable[reason] = (unavailable[reason] ?? 0) + 1; }
  }
  return { fits, rawReturns, rawPath, residualReturns, residualPath, unavailable };
}
