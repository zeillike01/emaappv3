import { describe, it, expect } from "vitest";
import {
  calculateEMA,
  detectPivots,
  detectSwings,
  hasBrokenAboveEma,
  hasBrokenBelowEma,
  scanForSignals,
  isCurrentFilterAllowed,
} from "../strategy";
import type { Kline } from "../types";

// Helper to create a kline with explicit high/low
function kline(
  close: number,
  opts: { high?: number; low?: number; openTime?: number } = {},
): Kline {
  const high = opts.high ?? close + 10;
  const low = opts.low ?? close - 10;
  const openTime = opts.openTime ?? 0;
  return {
    openTime,
    open: close - 0.5,
    high,
    low,
    close,
    volume: 100,
    closeTime: openTime + 899999,
    quoteVolume: 100,
    trades: 1,
    isClosed: true,
  };
}

// Generate klines from close prices, with high=close+1, low=close-1
function klines(prices: number[], startTime = 0): Kline[] {
  return prices.map((close, i) =>
    kline(close, {
      high: close + 1,
      low: close - 1,
      openTime: startTime + i * 900000,
    })
  );
}

describe("calculateEMA", () => {
  it("returns an array of same length as input", () => {
    const data = [10, 11, 12, 13, 14];
    const ema = calculateEMA(data, 5);
    expect(ema.length).toBe(5);
  });

  it("first (period-1) entries are NaN", () => {
    const data = [10, 11, 12, 13, 14];
    const ema = calculateEMA(data, 5);
    for (let i = 0; i < 4; i++) {
      expect(Number.isNaN(ema[i])).toBe(true);
    }
  });

  it("SMA seed at index period-1", () => {
    const data = [10, 11, 12, 13, 14];
    const ema = calculateEMA(data, 5);
    // SMA of [10,11,12,13,14] = 12
    expect(ema[4]).toBe(12);
  });

  it("computes EMA correctly after warmup", () => {
    const data = [10, 10, 10, 10, 10];
    const ema = calculateEMA(data, 3);
    expect(ema[2]).toBe(10);
    expect(ema[4]).toBe(10);
  });

  it("tracks a rising series", () => {
    const data = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const ema = calculateEMA(data, 3);
    // Should be less than 10 since EMA lags
    const last = ema[ema.length - 1];
    expect(last).toBeGreaterThan(8);
    expect(last).toBeLessThan(10);
  });

  it("returns empty array for empty data", () => {
    expect(calculateEMA([], 5)).toEqual([]);
  });

  it("returns all NaN if data shorter than period", () => {
    const ema = calculateEMA([10, 20], 3);
    expect(ema.length).toBe(2);
    expect(ema.every((v) => Number.isNaN(v))).toBe(true);
  });

  it("returns SMA if data length equals period", () => {
    const ema = calculateEMA([10, 20, 30], 3);
    expect(ema[2]).toBe(20);
  });
});

describe("detectPivots", () => {
  it("detects a pivot high using bar.high", () => {
    // [high: 11, high: 11, high: 30, high: 11, high: 11] with lookback=2
    const k: Kline[] = [
      kline(10, { high: 11, openTime: 0 }),
      kline(10, { high: 11, openTime: 900000 }),
      kline(20, { high: 30, openTime: 1800000 }),
      kline(10, { high: 11, openTime: 2700000 }),
      kline(10, { high: 11, openTime: 3600000 }),
    ];
    const pivots = detectPivots(k, 2);
    const highs = pivots.filter((p) => p.type === "high");
    expect(highs.length).toBe(1);
    expect(highs[0].index).toBe(2);
    expect(highs[0].price).toBe(30);
  });

  it("detects a pivot low using bar.low", () => {
    const k: Kline[] = [
      kline(30, { low: 29, openTime: 0 }),
      kline(30, { low: 29, openTime: 900000 }),
      kline(10, { low: 9, openTime: 1800000 }),
      kline(30, { low: 29, openTime: 2700000 }),
      kline(30, { low: 29, openTime: 3600000 }),
    ];
    const pivots = detectPivots(k, 2);
    const lows = pivots.filter((p) => p.type === "low");
    expect(lows.length).toBe(1);
    expect(lows[0].index).toBe(2);
    expect(lows[0].price).toBe(9);
  });

  it("does not treat equal values as pivots (strict inequality)", () => {
    // All highs equal = 20, so no pivot high
    const k: Kline[] = [
      kline(10, { high: 20, openTime: 0 }),
      kline(10, { high: 20, openTime: 900000 }),
      kline(20, { high: 20, openTime: 1800000 }),
      kline(10, { high: 20, openTime: 2700000 }),
      kline(10, { high: 20, openTime: 3600000 }),
    ];
    const pivots = detectPivots(k, 2);
    expect(pivots.length).toBe(0);
  });

  it("detects multiple pivots in a zigzag pattern", () => {
    // high values: 20, 30, 40 — only 30 at index 2 is a pivot if lookback=1
    // low values: 5, 3 — both can be pivots
    const k: Kline[] = [
      kline(10, { high: 20, low: 9, openTime: 0 }),
      kline(5, { high: 10, low: 5, openTime: 900000 }),
      kline(20, { high: 30, low: 19, openTime: 1800000 }),
      kline(3, { high: 8, low: 3, openTime: 2700000 }),
      kline(15, { high: 25, low: 14, openTime: 3600000 }),
    ];
    const pivots = detectPivots(k, 1);
    const highs = pivots.filter((p) => p.type === "high");
    const lows = pivots.filter((p) => p.type === "low");
    // Index 2 has high=30 which is > high[1]=10 and > high[3]=8 → pivot high
    // Index 1 has low=5 which is < low[0]=9 and < low[2]=19 → pivot low
    // Index 3 has low=3 which is < low[2]=19 and < low[4]=14 → pivot low
    expect(highs.length).toBeGreaterThanOrEqual(1);
    expect(lows.length).toBeGreaterThanOrEqual(1);
  });

  it("returns empty for insufficient data", () => {
    const k = klines([10, 20]);
    expect(detectPivots(k, 2)).toEqual([]);
  });
});

describe("detectSwings", () => {
  it("detects Higher Low formation", () => {
    // Two consecutive lows where second > first
    const pivots = [
      { index: 2, price: 10, time: 0, type: "low" as const },
      { index: 6, price: 15, time: 0, type: "low" as const },
    ];
    const { higherLows, lowerHighs } = detectSwings(pivots);
    expect(higherLows.length).toBe(1);
    expect(higherLows[0].price).toBe(15);
    expect(lowerHighs.length).toBe(0);
  });

  it("detects Lower High formation", () => {
    const pivots = [
      { index: 2, price: 30, time: 0, type: "high" as const },
      { index: 6, price: 25, time: 0, type: "high" as const },
    ];
    const { higherLows, lowerHighs } = detectSwings(pivots);
    expect(lowerHighs.length).toBe(1);
    expect(lowerHighs[0].price).toBe(25);
    expect(higherLows.length).toBe(0);
  });

  it("detects no swings for monotonically rising pivots", () => {
    const pivots = [
      { index: 0, price: 10, time: 0, type: "low" as const },
      { index: 2, price: 12, time: 0, type: "low" as const },
      { index: 4, price: 14, time: 0, type: "low" as const },
    ];
    const { higherLows, lowerHighs } = detectSwings(pivots);
    // Each successive low is higher than the previous → all are Higher Lows
    expect(higherLows.length).toBe(2);
    expect(lowerHighs.length).toBe(0);
  });

  it("detects both HL and LH in a complex pattern", () => {
    const pivots = [
      { index: 0, price: 10, time: 0, type: "low" as const },
      { index: 2, price: 30, time: 0, type: "high" as const },
      { index: 4, price: 15, time: 0, type: "low" as const },
      { index: 6, price: 25, time: 0, type: "high" as const },
      { index: 8, price: 8, time: 0, type: "low" as const },
    ];
    const { higherLows, lowerHighs } = detectSwings(pivots);
    // Low 15 > Low 10 → HL; High 25 < High 30 → LH; Low 8 < Low 15 → not HL
    expect(higherLows.length).toBe(1);
    expect(lowerHighs.length).toBe(1);
  });

  it("returns empty for single pivot", () => {
    const { higherLows, lowerHighs } = detectSwings([
      { index: 0, price: 10, time: 0, type: "low" as const },
    ]);
    expect(higherLows.length).toBe(0);
    expect(lowerHighs.length).toBe(0);
  });
});

describe("hasBrokenAboveEma / hasBrokenBelowEma", () => {
  it("detects break above", () => {
    const closes = [9, 9, 11, 11];
    const ema = [9.5, 9.5, 9.5, 9.5];
    expect(hasBrokenAboveEma(closes, ema, 2)).toBe(true);
  });

  it("no break when already above", () => {
    const closes = [11, 12, 13];
    const ema = [9, 9, 9];
    expect(hasBrokenAboveEma(closes, ema, 2)).toBe(false);
  });

  it("detects break below", () => {
    const closes = [11, 11, 9, 9];
    const ema = [10.5, 10.5, 10.5, 10.5];
    expect(hasBrokenBelowEma(closes, ema, 2)).toBe(true);
  });

  it("no break when close equals EMA (strict inequality)", () => {
    const closes = [9, 10, 11];
    const ema = [9.5, 10, 10.5];
    // close[1]=10, ema[1]=10 → not strictly greater
    expect(hasBrokenAboveEma(closes, ema, 1)).toBe(false);
  });
});

describe("scanForSignals", () => {
  it("returns empty for insufficient data", () => {
    const k15m = klines([100, 101, 102]);
    const k4h = klines([100]);
    expect(scanForSignals(k15m, k4h)).toEqual([]);
  });

  it("each signal has required fields", () => {
    // Create data that trends up to produce signals
    const prices = Array.from(
      { length: 120 },
      (_, i) => 90 + Math.sin(i * 0.08) * 10 + i * 0.15,
    );
    const k15m = klines(prices);
    const k4h = klines(
      Array.from({ length: 100 }, (_, i) => 100 + Math.sin(i * 0.05) * 5 + i * 0.1),
    );

    const signals = scanForSignals(k15m, k4h);
    signals.forEach((s) => {
      expect(s).toHaveProperty("index");
      expect(s).toHaveProperty("type");
      expect(s).toHaveProperty("price");
      expect(s).toHaveProperty("ema50");
      expect(s).toHaveProperty("reason");
      expect(s).toHaveProperty("time");
      expect(s).toHaveProperty("ema75_4h");
      expect(["LONG", "SHORT"]).toContain(s.type);
    });
  });

  it("blocks long signals when 4H price is below EMA75", () => {
    // 4H prices very low — below EMA75
    const prices4h = Array.from(
      { length: 100 },
      (_, i) => 10 + Math.sin(i * 0.1),
    );
    const k4h = klines(prices4h);

    // 15m prices trend up through EMA50
    const prices = Array.from(
      { length: 120 },
      (_, i) => 80 + Math.sin(i * 0.08) * 5 + i * 0.2,
    );
    const k15m = klines(prices);

    const signals = scanForSignals(k15m, k4h);
    const longs = signals.filter((s) => s.type === "LONG");
    expect(longs.length).toBe(0);
  });

  it("blocks short signals when 4H price is above EMA75", () => {
    const prices4h = Array.from(
      { length: 100 },
      (_, i) => 200 + Math.sin(i * 0.1) * 5,
    );
    const k4h = klines(prices4h);

    // 15m prices trend down through EMA50
    const prices = Array.from(
      { length: 120 },
      (_, i) => 110 - Math.sin(i * 0.08) * 5 - i * 0.2,
    );
    const k15m = klines(prices);

    const signals = scanForSignals(k15m, k4h);
    const shorts = signals.filter((s) => s.type === "SHORT");
    expect(shorts.length).toBe(0);
  });
});

describe("isCurrentFilterAllowed", () => {
  it("allows LONG when last closed 4H histogram is positive (exponential rise)", () => {
    // Exponential rise → accelerating momentum → MACD histogram positive (~3.6)
    const prices = Array.from({ length: 100 }, (_, i) => 100 * Math.pow(1.02, i));
    expect(isCurrentFilterAllowed(klines(prices), "LONG", "macd")).toBe(true);
  });

  it("blocks SHORT when histogram is positive", () => {
    const prices = Array.from({ length: 100 }, (_, i) => 100 * Math.pow(1.02, i));
    expect(isCurrentFilterAllowed(klines(prices), "SHORT", "macd")).toBe(false);
  });

  it("blocks both when histogram is zero (linear data)", () => {
    // Linear rise → MACD histogram converges to exactly 0 (both EMAs track linearly)
    const prices = Array.from({ length: 100 }, (_, i) => 100 + i * 0.5);
    expect(isCurrentFilterAllowed(klines(prices), "LONG", "macd")).toBe(false);
    expect(isCurrentFilterAllowed(klines(prices), "SHORT", "macd")).toBe(false);
  });

  it("returns true (fail-open) when data is too short", () => {
    const short = klines([100, 101, 102]);
    expect(isCurrentFilterAllowed(short, "LONG", "macd")).toBe(true);
  });

  it("works with EMA75 filter type", () => {
    // Rising prices → price above EMA75
    const rising = Array.from({ length: 100 }, (_, i) => 100 + i * 0.3);
    expect(isCurrentFilterAllowed(klines(rising), "LONG", "ema")).toBe(true);
    expect(isCurrentFilterAllowed(klines(rising), "SHORT", "ema")).toBe(false);

    // Falling prices → price below EMA75
    const falling = Array.from({ length: 100 }, (_, i) => 150 - i * 0.3);
    expect(isCurrentFilterAllowed(klines(falling), "SHORT", "ema")).toBe(true);
    expect(isCurrentFilterAllowed(klines(falling), "LONG", "ema")).toBe(false);
  });
});
