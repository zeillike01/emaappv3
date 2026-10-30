import { describe, it, expect } from "vitest";
import {
  calculateMACD,
  checkMacdConfirmation,
  isStructureIntact,
} from "./strategy";
import type { Kline } from "./types";

// ── Helpers ────────────────────────────────────────────────────

function makeKline(
  close: number,
  openTimeOffset: number,
  opts?: { closeTimeOffset?: number },
): Kline {
  const base = Date.now() - 300_000 * 200; // far enough in the past
  const openTime = base + openTimeOffset * 300_000; // 5min per offset
  return {
    openTime,
    open: close,
    high: close * 1.001,
    low: close * 0.999,
    close,
    volume: 100,
    closeTime: opts?.closeTimeOffset !== undefined
      ? base + opts.closeTimeOffset * 300_000
      : openTime + 299_000,
    quoteVolume: 100,
    trades: 10,
    isClosed: true,
  };
}

// Generate a series of klines with an accelerating uptrend
// (MACD histogram is most positive when momentum is increasing)
function makeUptrend(count: number, startPrice: number): Kline[] {
  return Array.from({ length: count }, (_, i) =>
    makeKline(startPrice + i * i * 0.01, i),
  );
}

// Generate a series of klines with an accelerating downtrend
function makeDowntrend(count: number, startPrice: number): Kline[] {
  return Array.from({ length: count }, (_, i) =>
    makeKline(startPrice - i * i * 0.01, i),
  );
}

// ── Tests ──────────────────────────────────────────────────────

describe("calculateMACD", () => {
  it("returns arrays of correct length", () => {
    const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109];
    const { macdLine, signalLine, histogram } = calculateMACD(closes);
    expect(macdLine.length).toBe(closes.length);
    expect(signalLine.length).toBe(closes.length);
    expect(histogram.length).toBe(closes.length);
  });

  it("histogram equals macdLine minus signalLine", () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const { macdLine, signalLine, histogram } = calculateMACD(closes);
    for (let i = 0; i < closes.length; i++) {
      if (!isNaN(macdLine[i]) && !isNaN(signalLine[i])) {
        expect(histogram[i]).toBeCloseTo(macdLine[i] - signalLine[i], 10);
      }
    }
  });
});

describe("checkMacdConfirmation", () => {
  it("confirms LONG when histogram is positive on uptrend data", () => {
    // Strong uptrend should produce positive histogram
    const klines = makeUptrend(100, 100);
    const result = checkMacdConfirmation(klines, "LONG");
    // On a clear uptrend the histogram should be positive → confirmed
    expect(result.confirmed).toBe(true);
    expect(result.histogram).toBeGreaterThan(0);
  });

  it("does NOT confirm LONG on downtrend data", () => {
    const klines = makeDowntrend(100, 200);
    const result = checkMacdConfirmation(klines, "LONG");
    // Strong downtrend → negative histogram → not confirmed for LONG
    expect(result.confirmed).toBe(false);
  });

  it("confirms SHORT when histogram is negative on downtrend data", () => {
    const klines = makeDowntrend(100, 200);
    const result = checkMacdConfirmation(klines, "SHORT");
    expect(result.confirmed).toBe(true);
    expect(result.histogram).toBeLessThan(0);
  });

  it("does NOT confirm SHORT on uptrend data", () => {
    const klines = makeUptrend(100, 100);
    const result = checkMacdConfirmation(klines, "SHORT");
    expect(result.confirmed).toBe(false);
  });

  it("returns a descriptive label", () => {
    const klines = makeUptrend(100, 100);
    const result = checkMacdConfirmation(klines, "LONG");
    expect(result.label).toContain("5m MACD");
    expect(result.label).toContain("LONG");
  });

  it("handles too few klines gracefully (no crash)", () => {
    const klines = [makeKline(100, 0), makeKline(101, 1)];
    const result = checkMacdConfirmation(klines, "LONG");
    // With only 2 bars, MACD cannot compute → confirmed should be false
    expect(result.confirmed).toBe(false);
  });
});

describe("isStructureIntact", () => {
  it("returns intact=true when price is above structurePrice for LONG", () => {
    const klines = makeUptrend(20, 100);
    // structurePrice is below all closes
    const result = isStructureIntact(klines, "LONG", 50);
    expect(result.intact).toBe(true);
  });

  it("returns intact=false when price closes below structurePrice for LONG", () => {
    // All closes around 95, structurePrice = 100 (above)
    const klines = Array.from({ length: 20 }, (_, i) => makeKline(95, i));
    const result = isStructureIntact(klines, "LONG", 100);
    expect(result.intact).toBe(false);
  });

  it("returns intact=true when price is below structurePrice for SHORT", () => {
    const klines = makeDowntrend(20, 50);
    // structurePrice is above all closes
    const result = isStructureIntact(klines, "SHORT", 100);
    expect(result.intact).toBe(true);
  });

  it("returns intact=false when price closes above structurePrice for SHORT", () => {
    // All closes around 105, structurePrice = 100 (below)
    const klines = Array.from({ length: 20 }, (_, i) => makeKline(105, i));
    const result = isStructureIntact(klines, "SHORT", 100);
    expect(result.intact).toBe(false);
  });

  it("returns the lastClose value", () => {
    const klines = makeUptrend(20, 100);
    const result = isStructureIntact(klines, "LONG", 50);
    // Last close should be startPrice + 19^2 * 0.01 = 103.61
    expect(result.lastClose).toBeCloseTo(103.61, 1);
  });

  it("handles empty klines gracefully", () => {
    const result = isStructureIntact([], "LONG", 100);
    expect(result.intact).toBe(false);
  });
});
