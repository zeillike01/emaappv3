import { describe, expect, it } from "vitest";
import {
  captureRatioOf,
  durationBucketOf,
  excursionR,
  movePctOf,
  slippageBpsOf,
} from "../trade-analytics";

describe("excursionR", () => {
  // entry 100, stop 99 → 1R = 1.00 in price.
  const bars = [
    { high: 100.5, low: 99.4, close: 100.2 }, // fav +0.5R, adv 0.6R
    { high: 102.2, low: 100.0, close: 101.8 }, // fav +2.2R @ bar 1
    { high: 101.0, low: 98.7, close: 99.0 }, // adv 1.3R @ bar 2
  ];

  it("measures both extremes and when they occurred (LONG)", () => {
    const r = excursionR("LONG", 100, 99, bars);
    expect(r.mfeR).toBeCloseTo(2.2, 6);
    expect(r.timeToMfe).toBe(1);
    expect(r.maeR).toBeCloseTo(1.3, 6);
    expect(r.timeToMae).toBe(2);
  });

  it("mirrors for SHORT", () => {
    const r = excursionR("SHORT", 100, 101, bars);
    // fav = (100 - low)/1 → lowest low is 98.7 at bar 2 → 1.3R
    expect(r.mfeR).toBeCloseTo(1.3, 6);
    expect(r.timeToMfe).toBe(2);
    // adv = (high - 100)/1 → highest high is 102.2 at bar 1 → 2.2R
    expect(r.maeR).toBeCloseTo(2.2, 6);
    expect(r.timeToMae).toBe(1);
  });

  it("is a no-op without a positive risk distance", () => {
    expect(excursionR("LONG", 100, 100, bars)).toEqual({ mfeR: 0, maeR: 0 });
  });

  it("never returns a negative excursion", () => {
    // A trade that never traded above entry and never below it.
    const flat = [{ high: 100, low: 100, close: 100 }];
    const r = excursionR("LONG", 100, 99, flat);
    expect(r.mfeR).toBe(0);
    expect(r.maeR).toBe(0);
  });
});

describe("durationBucketOf", () => {
  it("uses the shipped cut points", () => {
    expect(durationBucketOf(1)).toBe("fast");
    expect(durationBucketOf(4)).toBe("fast");
    expect(durationBucketOf(5)).toBe("medium");
    expect(durationBucketOf(16)).toBe("medium");
    expect(durationBucketOf(17)).toBe("slow");
  });
});

describe("captureRatioOf", () => {
  it("divides realized R by the peak", () => {
    expect(captureRatioOf(1.0, 2.0)).toBe(0.5);
  });

  it("returns undefined when there is no peak to divide by", () => {
    expect(captureRatioOf(1, 0)).toBeUndefined();
    expect(captureRatioOf(1, undefined)).toBeUndefined();
  });

  it("can exceed 1 when the exit beat the sampled peak", () => {
    expect(captureRatioOf(1.5, 1.0)).toBe(1.5);
  });
});

describe("slippageBpsOf", () => {
  it("measures the gap in basis points", () => {
    // 0.1 on 100 = 0.1% = 10 bps
    expect(slippageBpsOf(100, 100.1)).toBeCloseTo(10, 6);
  });

  it("is sign-free (entry vs signal, either direction)", () => {
    expect(slippageBpsOf(100, 99.9)).toBeCloseTo(10, 6);
  });

  it("returns undefined without a usable signal price", () => {
    expect(slippageBpsOf(100, undefined)).toBeUndefined();
    expect(slippageBpsOf(100, 0)).toBeUndefined();
    expect(slippageBpsOf(0, 100)).toBeUndefined();
  });
});

describe("movePctOf", () => {
  it("measures last close vs first close", () => {
    expect(movePctOf([{ close: 100 }, { close: 101 }, { close: 103 }])).toBeCloseTo(3, 6);
  });

  it("returns undefined on a degenerate window", () => {
    expect(movePctOf([])).toBeUndefined();
    expect(movePctOf([{ close: 100 }])).toBeUndefined();
    expect(movePctOf([{ close: 0 }, { close: 5 }])).toBeUndefined();
  });
});
