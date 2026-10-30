/**
 * CANDLE INTEGRITY GATE tests (2026-09-11 red-team audit fix, F-2).
 *
 * The engine must fail CLOSED on junk feed data: a partial candle, a gap, an
 * out-of-order timestamp, or an impossible OHLC bar must never reach signal
 * detection as if it were a real closed candle.
 */
import { describe, expect, it } from "vitest";
import { validateKlines } from "../strategy-utils";

const STEP = 900_000; // 15m
const NOW = 10_000 * STEP;

function bar(i: number, over: Partial<{ open: number; high: number; low: number; close: number; isClosed: boolean; openTime: number; closeTime: number }> = {}) {
  const close = 100 + i;
  return {
    openTime: i * STEP,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    closeTime: i * STEP + STEP - 1,
    isClosed: true,
    ...over,
  };
}

function series(n: number) {
  return Array.from({ length: n }, (_, i) => bar(i));
}

describe("validateKlines", () => {
  it("accepts a clean, contiguous, closed series", () => {
    expect(validateKlines(series(50), { intervalMs: STEP, now: NOW }).ok).toBe(true);
  });

  it("rejects an unclosed (still-forming) final candle", () => {
    const k = series(50);
    k[49] = bar(49, { isClosed: false });
    const r = validateKlines(k, { intervalMs: STEP, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not closed");
  });

  it("rejects a missing candle (gap)", () => {
    const k = series(50).filter((_, i) => i !== 25);
    // Re-number the tail so timestamps genuinely skip a slot.
    const r = validateKlines(k, { intervalMs: STEP, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("missing candle");
  });

  it("rejects out-of-order timestamps", () => {
    const k = series(50);
    k[30] = bar(29); // duplicate/backwards openTime
    const r = validateKlines(k, { intervalMs: STEP, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("not increasing");
  });

  it("rejects impossible OHLC (high does not contain close)", () => {
    const k = series(50);
    k[10] = bar(10, { high: 105, low: 100 }); // close=110 sits above the high
    const r = validateKlines(k, { intervalMs: STEP, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("out of range");
  });

  it("rejects a bar whose high is below its low", () => {
    const k = series(50);
    k[10] = bar(10, { high: 50, low: 100 });
    const r = validateKlines(k, { intervalMs: STEP, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("high < low");
  });

  it("rejects non-positive / non-finite prices", () => {
    const k = series(50);
    k[5] = bar(5, { close: 0 });
    expect(validateKlines(k, { intervalMs: STEP, now: NOW }).ok).toBe(false);
    k[5] = bar(5, { close: NaN });
    expect(validateKlines(k, { intervalMs: STEP, now: NOW }).ok).toBe(false);
  });

  it("rejects too few candles", () => {
    expect(validateKlines([bar(0)], { intervalMs: STEP, now: NOW }).ok).toBe(false);
    expect(validateKlines(undefined, { intervalMs: STEP, now: NOW }).ok).toBe(false);
  });

  it("rejects a newest bar that closes in the future", () => {
    const k = series(50);
    k[49] = bar(49, { closeTime: NOW + 10 * STEP });
    const r = validateKlines(k, { intervalMs: STEP, now: NOW });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("future");
  });

  it("honours an explicit gap tolerance", () => {
    const k = series(50).filter((_, i) => i !== 25);
    // A 2-bar tolerance lets a single missing candle through.
    expect(validateKlines(k, { intervalMs: STEP, gapToleranceMs: 2 * STEP, now: NOW }).ok).toBe(true);
  });
});
