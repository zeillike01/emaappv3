import { describe, it, expect } from "vitest";
import {
  computeBookMetrics,
  computeFlowMetrics,
  computeAtrPct,
  computeCandleRangePct,
  ema,
} from "../mexc/metrics";
import type { Kline } from "../types";

// ── Shared Metrics Tests ──

describe("computeBookMetrics", () => {
  it("returns correct imbalance for bid-heavy book", () => {
    const bids = [
      { price: 100, size: 50 },
      { price: 99, size: 30 },
    ];
    const asks = [
      { price: 101, size: 10 },
      { price: 102, size: 10 },
    ];
    const result = computeBookMetrics(bids, asks, 1);
    expect(result.imbalance).toBeGreaterThan(0); // bid-heavy
    expect(result.spreadPct).toBeGreaterThan(0);
    expect(result.bestBid).toBe(100);
    expect(result.bestAsk).toBe(101);
  });

  it("returns correct imbalance for ask-heavy book", () => {
    const bids = [
      { price: 100, size: 10 },
    ];
    const asks = [
      { price: 101, size: 50 },
      { price: 102, size: 30 },
    ];
    const result = computeBookMetrics(bids, asks, 1);
    expect(result.imbalance).toBeLessThan(0); // ask-heavy
  });

  it("returns 0 imbalance for balanced book", () => {
    const bids = [{ price: 100, size: 50 }];
    const asks = [{ price: 101, size: 50 }];
    const result = computeBookMetrics(bids, asks, 1);
    expect(result.imbalance).toBeCloseTo(0, 2);
  });

  it("handles empty book gracefully", () => {
    const result = computeBookMetrics([], [], 1);
    expect(result.imbalance).toBe(0);
    expect(result.bestBid).toBe(0);
    expect(result.bestAsk).toBe(0);
  });

  it("applies contractSize multiplier to depth", () => {
    const bids = [{ price: 100, size: 10 }];
    const asks = [{ price: 101, size: 10 }];
    const r1 = computeBookMetrics(bids, asks, 1);
    const r2 = computeBookMetrics(bids, asks, 10);
    // Imbalance should be the same (ratio), but depths should differ
    expect(r2.bidDepth).toBeCloseTo(r1.bidDepth * 10, 0);
    expect(r2.imbalance).toBeCloseTo(r1.imbalance, 6);
  });
});

describe("computeFlowMetrics", () => {
  it("returns positive bias for aggressive buying", () => {
    const now = Date.now();
    const trades = [
      { price: 100, size: 100, time: now - 1000, isBuyerMaker: false }, // buyer aggressive
      { price: 101, size: 50, time: now - 2000, isBuyerMaker: false },
    ];
    const result = computeFlowMetrics(trades, 10_000, now);
    expect(result.bias).toBeGreaterThan(0);
    expect(result.buyVol).toBe(150);
    expect(result.sellVol).toBe(0);
  });

  it("returns negative bias for aggressive selling", () => {
    const now = Date.now();
    const trades = [
      { price: 100, size: 100, time: now - 1000, isBuyerMaker: true }, // seller aggressive
      { price: 99, size: 80, time: now - 2000, isBuyerMaker: true },
    ];
    const result = computeFlowMetrics(trades, 10_000, now);
    expect(result.bias).toBeLessThan(0);
    expect(result.sellVol).toBe(180);
  });

  it("returns 0 bias when no trades in window", () => {
    const now = Date.now();
    const trades = [
      { price: 100, size: 100, time: now - 20_000, isBuyerMaker: false }, // outside 10s window
    ];
    const result = computeFlowMetrics(trades, 10_000, now);
    expect(result.bias).toBe(0);
  });

  it("handles empty trades array", () => {
    const result = computeFlowMetrics([], 5000);
    expect(result.bias).toBe(0);
    expect(result.buyVol).toBe(0);
    expect(result.sellVol).toBe(0);
  });
});

describe("computeAtrPct", () => {
  it("returns positive ATR% for volatile candles", () => {
    const klines: Kline[] = Array.from({ length: 30 }, (_, i) => ({
      openTime: i * 60_000,
      open: 100,
      high: 102 + Math.sin(i) * 0.5,
      low: 98 - Math.sin(i) * 0.5,
      close: 100,
      volume: 1000,
      closeTime: i * 60_000 + 59_000,
      quoteVolume: 100_000,
      trades: 100,
      isClosed: true,
    }));
    const result = computeAtrPct(klines, 14);
    expect(result).toBeGreaterThan(0);
  });

  it("returns 0 for flat candles", () => {
    const klines: Kline[] = Array.from({ length: 30 }, (_, i) => ({
      openTime: i * 60_000,
      open: 100,
      high: 100,
      low: 100,
      close: 100,
      volume: 1000,
      closeTime: i * 60_000 + 59_000,
      quoteVolume: 100_000,
      trades: 100,
      isClosed: true,
    }));
    const result = computeAtrPct(klines, 14);
    expect(result).toBe(0);
  });
});

describe("computeCandleRangePct", () => {
  it("returns correct range %", () => {
    const candle: Kline = {
      openTime: 0, open: 100, high: 102, low: 98, close: 101,
      volume: 1000, closeTime: 60_000, quoteVolume: 100_000,
      trades: 100, isClosed: true,
    };
    // range = 4, close = 101 → 4/101 * 100 ≈ 3.96%
    const result = computeCandleRangePct(candle);
    expect(result).toBeCloseTo(3.96, 1);
  });

  it("returns 0 for zero close", () => {
    const candle: Kline = {
      openTime: 0, open: 0, high: 0, low: 0, close: 0,
      volume: 0, closeTime: 0, quoteVolume: 0,
      trades: 0, isClosed: true,
    };
    expect(computeCandleRangePct(candle)).toBe(0);
  });
});

describe("ema", () => {
  it("returns array of same length as input", () => {
    const data = Array.from({ length: 50 }, (_, i) => 100 + i * 0.5);
    const result = ema(data, 21);
    expect(result.length).toBe(data.length);
  });

  it("EMA7 converges to price faster than EMA30", () => {
    // Sudden jump from 100 to 120 at index 20
    const data = Array.from({ length: 50 }, (_, i) => (i < 20 ? 100 : 120));
    const fast = ema(data, 7);
    const slow = ema(data, 30);
    // After the jump, EMA7 should be closer to 120 than EMA30
    expect(fast[30]).toBeGreaterThan(slow[30]);
  });

  it("handles single-element array", () => {
    const result = ema([100], 10);
    expect(result).toEqual([100]);
  });

  it("handles very short array", () => {
    const result = ema([100, 101, 102], 30);
    expect(result.length).toBe(3);
    // First element should be the seed value
    expect(result[0]).toBe(100);
  });
});
