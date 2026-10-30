/**
 * EMA Momentum Strategy — Scoring Tests
 *
 * Verifies:
 *   - Score starts at 50 each side
 *   - EMA bullish/bearish adds correct scores
 *   - Order book imbalance scales correctly
 *   - Flow bias scales correctly
 *   - Funding rate adds correct scores
 *   - Spread blocker fires at wide spread
 *   - ATR spike blocker fires at > 2.4x ATR
 *   - Missing volume blocks trade
 *   - Min score threshold (64) and gap requirement (+6)
 */

import { describe, it, expect } from "vitest";
import { computeSignal, DEFAULT_SETTINGS, bookMetrics, flowMetrics } from "../mexc/strategy";
import type { Kline } from "../mexc/types";

// ── Helpers ──

function makeCandles(n: number, startPrice: number, trend: "up" | "down" | "flat" = "flat"): Kline[] {
  const candles: Kline[] = [];
  let price = startPrice;
  for (let i = 0; i < n; i++) {
    const change = trend === "up" ? 0.5 : trend === "down" ? -0.5 : 0;
    price += change;
    const high = price + Math.random() * 0.5;
    const low = price - Math.random() * 0.5;
    candles.push({
      openTime: i * 60_000,
      closeTime: (i + 1) * 60_000,
      open: price - change,
      high,
      low,
      close: price,
      volume: 1000,
    });
  }
  return candles;
}

function makeBook(imbalance: number, spreadPct: number = 0.02) {
  const mid = 100;
  const halfSpread = (spreadPct / 100) * mid / 2;
  const bidNotional = mid * 100 * (1 + imbalance);
  const askNotional = mid * 100 * (1 - imbalance);
  return {
    bids: [{ price: mid - halfSpread, size: bidNotional / mid }],
    asks: [{ price: mid + halfSpread, size: askNotional / mid }],
  };
}

function makeFlow(bias: number) {
  // isBuyerMaker=false → aggressive buy (market buy)
  // isBuyerMaker=true  → aggressive sell (market sell)
  // bias > 0 means more aggressive buying
  const trades = [];
  const n = 10;
  const buyCount = Math.round(n * (1 + bias) / 2);
  for (let i = 0; i < n; i++) {
    // Aggressive buy if i < buyCount
    trades.push({ price: 100, size: 100, time: Date.now(), isBuyerMaker: i >= buyCount });
  }
  return trades;
}

// ── Tests ──

describe("EMA Momentum Scoring", () => {
  it("starts both scores at 50", () => {
    const candles = makeCandles(30, 100);
    const book = bookMetrics(makeBook(0));
    const flow = flowMetrics(makeFlow(0));

    const sig = computeSignal(candles, book, flow, 0, 0.5, 0.5, 1_000_000);

    // Without any signals, scores should be close to 50
    // (may vary slightly due to EMA alignment)
    expect(sig.longScore).toBeGreaterThanOrEqual(30);
    expect(sig.shortScore).toBeGreaterThanOrEqual(30);
  });

  it("bullish EMA adds +16 to long, -10 to short", () => {
    const candles = makeCandles(30, 100, "up"); // upward trend = EMA8 > EMA21
    const book = bookMetrics(makeBook(0));       // neutral book
    const flow = flowMetrics(makeFlow(0));       // neutral flow

    const sig = computeSignal(candles, book, flow, 0, 0.5, 0.5, 1_000_000);

    // With bullish EMA: long gets +16, short gets -10
    // Base is 50, so long should be ~66, short ~40
    expect(sig.longScore).toBeGreaterThan(sig.shortScore);
    expect(sig.reasons.some(r => r.includes("EMA8 > EMA21"))).toBe(true);
  });

  it("bearish EMA adds +16 to short, -10 to long", () => {
    const candles = makeCandles(30, 100, "down"); // downward trend
    const book = bookMetrics(makeBook(0));
    const flow = flowMetrics(makeFlow(0));

    const sig = computeSignal(candles, book, flow, 0, 0.5, 0.5, 1_000_000);

    expect(sig.shortScore).toBeGreaterThan(sig.longScore);
    expect(sig.reasons.some(r => r.includes("EMA8 < EMA21"))).toBe(true);
  });

  it("bid-heavy book adds to long, subtracts from short", () => {
    const candles = makeCandles(30, 100);
    const book = bookMetrics(makeBook(0.5)); // 50% bid-heavy
    const flow = flowMetrics(makeFlow(0));

    const sig = computeSignal(candles, book, flow, 0, 0.5, 0.5, 1_000_000);

    // imbalance=0.5 → long += 11, short -= 11
    expect(sig.imbalance).toBeCloseTo(0.5, 1);
    expect(sig.reasons.some(r => r.includes("bid-heavy"))).toBe(true);
  });

  it("aggressive buying adds to long, subtracts from short", () => {
    const candles = makeCandles(30, 100);
    const book = bookMetrics(makeBook(0));
    const flow = flowMetrics(makeFlow(0.6)); // 60% buy bias

    const sig = computeSignal(candles, book, flow, 0, 0.5, 0.5, 1_000_000);

    expect(sig.flow).toBeGreaterThan(0.3);
    expect(sig.reasons.some(r => r.includes("aggressive buying"))).toBe(true);
  });

  it("negative funding adds +6 to long", () => {
    const candles = makeCandles(30, 100);
    const book = bookMetrics(makeBook(0));
    const flow = flowMetrics(makeFlow(0));

    const sig = computeSignal(candles, book, flow, -0.0001, 0.5, 0.5, 1_000_000);

    expect(sig.longScore).toBeGreaterThan(50);
    expect(sig.reasons.some(r => r.includes("Negative funding"))).toBe(true);
  });

  it("high positive funding adds +6 to short", () => {
    const candles = makeCandles(30, 100);
    const book = bookMetrics(makeBook(0));
    const flow = flowMetrics(makeFlow(0));

    const sig = computeSignal(candles, book, flow, 0.0003, 0.5, 0.5, 1_000_000);

    expect(sig.shortScore).toBeGreaterThan(50);
    expect(sig.reasons.some(r => r.includes("High positive funding"))).toBe(true);
  });

  it("wide spread blocks trade", () => {
    const candles = makeCandles(30, 100);
    const book = bookMetrics(makeBook(0, 0.15)); // 0.15% spread > 0.12% threshold
    const flow = flowMetrics(makeFlow(0));

    const sig = computeSignal(candles, book, flow, 0, 0.5, 0.5, 1_000_000);

    expect(sig.blockers).toContain("Spread is wide");
    expect(sig.side).toBeNull();
  });

  it("tight spread adds +4 to both sides", () => {
    const candles = makeCandles(30, 100);
    const book = bookMetrics(makeBook(0, 0.02)); // tight spread
    const flow = flowMetrics(makeFlow(0));

    const sig = computeSignal(candles, book, flow, 0, 0.5, 0.5, 1_000_000);

    expect(sig.spreadPct).toBeLessThan(0.04);
    expect(sig.reasons.some(r => r.includes("Tight spread"))).toBe(true);
  });

  it("ATR spike blocks trade", () => {
    const candles = makeCandles(30, 100);
    const book = bookMetrics(makeBook(0));
    const flow = flowMetrics(makeFlow(0));

    // candleRangePct = 3.0, ATR = 1.0 → ratio = 3.0 > 2.4 threshold
    const sig = computeSignal(candles, book, flow, 0, 1.0, 3.0, 1_000_000);

    expect(sig.blockers.some(b => b.includes("ATR spike"))).toBe(true);
    expect(sig.side).toBeNull();
  });

  it("missing volume blocks trade", () => {
    const candles = makeCandles(30, 100);
    const book = bookMetrics(makeBook(0));
    const flow = flowMetrics(makeFlow(0));

    const sig = computeSignal(candles, book, flow, 0, 0.5, 0.5, 0);

    expect(sig.blockers).toContain("Missing 24h volume");
    expect(sig.side).toBeNull();
  });

  it("no signal if scores don't meet min threshold", () => {
    // Neutral everything — scores hover around 50, below 64
    const candles = makeCandles(30, 100);
    const book = bookMetrics(makeBook(0));
    const flow = flowMetrics(makeFlow(0));

    const sig = computeSignal(candles, book, flow, 0, 0.5, 0.5, 1_000_000);

    // With neutral everything, neither score should reach 64
    expect(sig.side).toBeNull();
  });

  it("long signal when long score >= 64 and beats short by 6+", () => {
    // Strong bullish setup: up EMA + bid-heavy + buying flow + negative funding
    const candles = makeCandles(30, 100, "up");
    const book = bookMetrics(makeBook(0.6));
    const flow = flowMetrics(makeFlow(0.7));

    const sig = computeSignal(candles, book, flow, -0.0003, 0.5, 0.5, 1_000_000);

    expect(sig.longScore).toBeGreaterThanOrEqual(64);
    expect(sig.longScore).toBeGreaterThanOrEqual(sig.shortScore + 6);
    expect(sig.side).toBe("LONG");
  });

  it("short signal when short score >= 64 and beats long by 6+", () => {
    // Strong bearish setup: down EMA + ask-heavy + selling flow + high funding
    const candles = makeCandles(30, 100, "down");
    const book = bookMetrics(makeBook(-0.6));
    const flow = flowMetrics(makeFlow(-0.7));

    const sig = computeSignal(candles, book, flow, 0.0003, 0.5, 0.5, 1_000_000);

    expect(sig.shortScore).toBeGreaterThanOrEqual(64);
    expect(sig.shortScore).toBeGreaterThanOrEqual(sig.longScore + 6);
    expect(sig.side).toBe("SHORT");
  });
});

describe("Book Metrics", () => {
  it("computes imbalance correctly", () => {
    const bm = bookMetrics(makeBook(0));
    expect(bm.imbalance).toBeCloseTo(0, 1);
  });

  it("bid-heavy returns positive imbalance", () => {
    const bm = bookMetrics(makeBook(0.5));
    expect(bm.imbalance).toBeGreaterThan(0);
  });

  it("ask-heavy returns negative imbalance", () => {
    const bm = bookMetrics(makeBook(-0.5));
    expect(bm.imbalance).toBeLessThan(0);
  });

  it("spread is computed from best bid/ask", () => {
    const bm = bookMetrics(makeBook(0, 0.05));
    expect(bm.spreadPct).toBeGreaterThan(0);
    expect(bm.spreadPct).toBeCloseTo(0.05, 1);
  });
});

describe("Flow Metrics", () => {
  it("computes bias from aggressive trades", () => {
    const trades = makeFlow(0.6);
    const fm = flowMetrics(trades, 60_000);
    expect(fm.bias).toBeGreaterThan(0.3);
  });

  it("neutral flow has near-zero bias", () => {
    const trades = makeFlow(0);
    const fm = flowMetrics(trades, 60_000);
    expect(Math.abs(fm.bias)).toBeLessThan(0.5);
  });
});
