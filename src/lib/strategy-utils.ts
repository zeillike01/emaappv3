/**
 * Pure decision helpers for the Layer 2 engine (strategyEngine) and the
 * shared trade lifecycle (paperTrading). Extracted from the Convex handlers
 * so the concurrency / dedupe rules are unit-testable without a Convex
 * runtime. No I/O, no side effects — keep it that way.
 */

/**
 * Deterministic identity of one strategy signal: the close-time of the newest
 * CLOSED 15m bar. There is deliberately NO wall-clock fallback — two ticks
 * that see the same closed bars must derive the identical signalTime, or the
 * idempotency-key dedupe in paperTrading.insertTrade is silently bypassed
 * and duplicate entries come back. Returns null when no valid closed bar
 * exists; callers must SKIP the signal (never substitute Date.now()).
 */
export function resolveSignalBarTime(
  klines: Array<{ closeTime?: number }>,
): number | null {
  const closeTime = klines[klines.length - 1]?.closeTime;
  if (typeof closeTime !== "number" || !(closeTime > 0)) return null;
  return closeTime;
}

/**
 * Run-guard lease for strategyTick (see strategyEngine.acquireStrategyTickLock).
 * Returns the new lease expiry (ms epoch) when the lease can be acquired, or
 * null while another tick is in flight. A lease held past `now` blocks;
 * expired leases are stealable, so a crashed tick can never deadlock the book
 * (the lease auto-expires after leaseMs).
 */
export function tryAcquireLease(
  scanLockUntil: number | undefined,
  now: number,
  leaseMs: number,
): number | null {
  if ((scanLockUntil ?? 0) > now) return null;
  return now + leaseMs;
}

/**
 * Entry dedupe decision for paperTrading.insertTrade, in precedence order:
 *   1. "duplicate-signal" — the same (book, coin, signalTime) already exists
 *      in ANY status (open or already closed): a re-fired identical signal
 *      can never open a second trade.
 *   2. "open-position" — an open trade already exists on (book, coin), even
 *      for a different signal.
 * Returns null when both checks pass and the insert should proceed.
 */
export function duplicateRejection(
  signalTime: number | undefined,
  sameSignalExists: boolean,
  openPositionExists: boolean,
): "duplicate-signal" | "open-position" | null {
  if (signalTime != null && sameSignalExists) return "duplicate-signal";
  if (openPositionExists) return "open-position";
  return null;
}

/**
 * CANDLE INTEGRITY GATE (2026-09-11 red-team audit fix).
 *
 * Before this, NOTHING validated the kline series: a partial (still-forming)
 * final candle was consumed as a closed bar, and a feed gap silently removed
 * intermediate candles — which can turn a failed structure into a valid one
 * or fabricate a "close above the EMA". The engine now fails CLOSED on bad
 * data (skip the pair) instead of trading a phantom bar.
 *
 * Checks (all must pass):
 *   - non-empty
 *   - every bar has finite, positive OHLC with high >= low, and high/low
 *     actually containing open/close
 *   - `isClosed !== false` (a missing isClosed is tolerated for legacy data)
 *   - openTime strictly increasing
 *   - no gap larger than `gapToleranceMs` between consecutive openTimes
 *     (default: 10% of the interval — absorbs exchange jitter but treats a
 *     genuinely missing candle as a failure)
 *   - the newest bar's closeTime is not in the future relative to `now`
 */
export interface KlineIntegrityInput {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  closeTime?: number;
  isClosed?: boolean;
}

export interface KlineIntegrityResult {
  ok: boolean;
  reason?: string;
}

export function validateKlines(
  klines: KlineIntegrityInput[] | undefined | null,
  opts: { intervalMs: number; gapToleranceMs?: number; now?: number; minBars?: number },
): KlineIntegrityResult {
  const { intervalMs } = opts;
  const minBars = opts.minBars ?? 2;
  const tol = opts.gapToleranceMs ?? Math.floor(intervalMs * 0.1);
  if (!klines || klines.length < minBars) {
    return { ok: false, reason: `insufficient candles (${klines?.length ?? 0} < ${minBars})` };
  }
  for (let i = 0; i < klines.length; i++) {
    const k = klines[i];
    if (k.isClosed === false) return { ok: false, reason: `bar ${i} is not closed` };
    for (const [name, v] of [
      ["open", k.open],
      ["high", k.high],
      ["low", k.low],
      ["close", k.close],
    ] as const) {
      if (!Number.isFinite(v) || v <= 0) return { ok: false, reason: `bar ${i} ${name} is not a positive finite number` };
    }
    if (k.high < k.low) return { ok: false, reason: `bar ${i} high < low` };
    if (k.high < Math.max(k.open, k.close) || k.low > Math.min(k.open, k.close)) {
      return { ok: false, reason: `bar ${i} OHLC out of range (high/low do not contain open/close)` };
    }
    if (i > 0) {
      const step = k.openTime - klines[i - 1].openTime;
      if (step <= 0) return { ok: false, reason: `bar ${i} openTime not increasing` };
      if (step > intervalMs + tol) {
        return { ok: false, reason: `missing candle(s) before bar ${i} (gap ${step}ms > ${intervalMs + tol}ms)` };
      }
    }
  }
  const now = opts.now ?? Date.now();
  const last = klines[klines.length - 1];
  if (typeof last.closeTime === "number" && last.closeTime > now + intervalMs) {
    return { ok: false, reason: "newest bar closes in the future (clock/feed skew)" };
  }
  return { ok: true };
}