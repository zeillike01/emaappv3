import { describe, expect, it } from "vitest";

import {
  chasePenaltyPoints,
  driftRegimePoints,
  efficiencyRatio,
  setupQuality,
  signalBarClosePosition,
} from "./setup-quality";
import type { Kline } from "./types";

const bar = (openTime: number, open: number, high: number, low: number, close: number, volume = 10): Kline => ({
  openTime,
  open,
  high,
  low,
  close,
  volume,
  closeTime: openTime + 899_999,
  quoteVolume: 0,
  trades: 0,
  isClosed: true,
});

/** A flat tape: every bar the same 10-point range, closes tick `step` per bar. */
function tape(steps: number[], startOpen = 100, range = 10): Kline[] {
  let price = startOpen;
  return steps.map((step, i) => {
    const open = price;
    const close = open + step;
    const high = Math.max(open, close) + range / 2;
    const low = Math.min(open, close) - range / 2;
    price = close;
    return bar(i * 900_000, open, high, low, close);
  });
}

describe("efficiencyRatio", () => {
  it("reads 1 on a perfectly monotone tape (net = path)", () => {
    // tiny ranges so the round-trip of the bar body dominates nothing: use
    // range 0.02 on a +2 step, so wicks cannot bend the path materially
    const bars = tape(Array.from({ length: 20 }, () => 2), 100, 0.02);
    expect(efficiencyRatio(bars, 10)!).toBeGreaterThan(0.999);
  });
  it("reads ~0 on a chop tape that round-trips", () => {
    const steps = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 8 : -8));
    const er = efficiencyRatio(tape(steps), 10)!;
    expect(er).toBeLessThan(0.15);
  });
  it("returns null before the window fills", () => {
    expect(efficiencyRatio(tape([1, 1, 1]), 10)).toBeNull();
  });
  it("is causal: prepending history can only change it through the window", () => {
    const bars = tape(Array.from({ length: 20 }, () => 2));
    const full = efficiencyRatio(bars, 10);
    const sliced = efficiencyRatio(bars.slice(-11), 10);
    expect(full).toBeCloseTo(sliced!, 6);
  });
});

describe("signalBarClosePosition", () => {
  it("reads 1 for a LONG when the bar closes at its high", () => {
    const bars = [bar(0, 100, 110, 100, 110)];
    expect(signalBarClosePosition(bars, "LONG")).toBeCloseTo(1, 6);
  });
  it("mirrors for a SHORT: the same bar reads 0", () => {
    const bars = [bar(0, 100, 110, 100, 110)];
    expect(signalBarClosePosition(bars, "SHORT")).toBeCloseTo(0, 6);
  });
  it("reads 0.5 on a doji (zero range) rather than NaN", () => {
    const bars = [bar(0, 100, 100, 100, 100)];
    expect(signalBarClosePosition(bars, "LONG")).toBe(0.5);
  });
});

describe("driftRegimePoints", () => {
  it("pays the quiet-tape band and penalises the chase regime", () => {
    expect(driftRegimePoints(0.05)).toBe(6);
    expect(driftRegimePoints(0.2)).toBe(4);
    expect(driftRegimePoints(0.3)).toBe(2);
    expect(driftRegimePoints(0.9)).toBe(-6);
  });
  it("fails neutral without a reading", () => {
    expect(driftRegimePoints(null)).toBe(0);
  });
  it("is monotone non-increasing in ER", () => {
    let prev = Infinity;
    for (const er of [0, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 1]) {
      const p = driftRegimePoints(er);
      expect(p).toBeLessThanOrEqual(prev);
      prev = p;
    }
  });
});

describe("chasePenaltyPoints", () => {
  it("penalises the with-trend chase close hardest", () => {
    expect(chasePenaltyPoints(0.9)).toBe(-8);
    expect(chasePenaltyPoints(0.6)).toBe(-2);
    expect(chasePenaltyPoints(0.4)).toBe(2);
    expect(chasePenaltyPoints(0.2)).toBe(5);
  });
  it("fails neutral without a reading", () => {
    expect(chasePenaltyPoints(null)).toBe(0);
  });
});

describe("setupQuality", () => {
  it("scores a pullback close in quiet tape best", () => {
    // round-trip chop, last bar closes at its low (LONG) → quiet + pullback
    const steps = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 8 : -8));
    steps[19] = -8;
    const q = setupQuality(tape(steps), "LONG");
    expect(q.driftRegime).toBe(6);
    expect(q.chasePenalty).toBe(5);
    expect(q.total).toBe(11);
  });
  it("scores a chased breakout in trending tape worst", () => {
    // big positive steps with a SMALL bar range so each bar closes at its own high
    const q = setupQuality(tape(Array.from({ length: 20 }, () => 2), 100, 0.02), "LONG");
    expect(q.driftRegime).toBe(-6); // ER ≈ 1 → chase regime
    expect(q.chasePenalty).toBe(-8); // closes at the high
    expect(q.total).toBe(-14);
  });
  it("mirrors between LONG and SHORT on the same bars", () => {
    const steps = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 8 : -8));
    const bars = tape(steps);
    const l = setupQuality(bars, "LONG");
    const s = setupQuality(bars, "SHORT");
    expect(l.closePos).toBeCloseTo(1 - (s.closePos as number), 6);
  });
});
