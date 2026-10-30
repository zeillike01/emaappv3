import { describe, expect, it } from "vitest";
import {
  atrPct,
  captureRatio,
  closeFeesUsd,
  computeExcursion,
  fundingCostUsd,
  holdProfile,
  snapshotExcursion,
  MAKER_FEE,
  TAKER_FEE,
} from "../exit-telemetry";

const LONG = { type: "LONG", entryPrice: 100, slPrice: 90, entryTime: 1_000 };
const SHORT = { type: "SHORT", entryPrice: 100, slPrice: 110, entryTime: 1_000 };

describe("computeExcursion", () => {
  it("walks post-entry bars only, in R units (long)", () => {
    const bars = [
      { high: 200, low: 50, closeTime: 500 }, // pre-entry: ignored
      { high: 115, low: 95, closeTime: 1_500 }, // +1.5 fav, -0.5 adv
      { high: 108, low: 80, closeTime: 2_500 }, // -2.0 adv (new worst)
      { high: 130, low: 100, closeTime: 3_500 }, // +3.0 fav (new best)
    ];
    const r = computeExcursion(LONG, bars);
    expect(r.mfeR).toBeCloseTo(3.0, 10);
    expect(r.maeR).toBeCloseTo(2.0, 10);
    expect(r.timeToMfe).toBe(2);
    expect(r.timeToMae).toBe(1);
  });

  it("mirrors for shorts", () => {
    const bars = [
      { high: 105, low: 85, closeTime: 1_500 }, // +1.5 fav, -0.5 adv
      { high: 120, low: 90, closeTime: 2_500 }, // -2.0 adv
    ];
    const r = computeExcursion(SHORT, bars);
    expect(r.mfeR).toBeCloseTo(1.5, 10);
    expect(r.maeR).toBeCloseTo(2.0, 10);
    expect(r.timeToMfe).toBe(0);
    expect(r.timeToMae).toBe(1);
  });

  it("returns zeros with no post-entry bars", () => {
    const r = computeExcursion(LONG, [
      { high: 150, low: 50, closeTime: 1_000 }, // closeTime == entryTime: skipped
    ]);
    expect(r).toEqual({ mfeR: 0, maeR: 0, timeToMfe: undefined, timeToMae: undefined });
  });

  it("returns zeros on zero risk (entry == stop)", () => {
    const r = computeExcursion(
      { ...LONG, slPrice: 100 },
      [{ high: 150, low: 50, closeTime: 2_000 }],
    );
    expect(r.mfeR).toBe(0);
    expect(r.maeR).toBe(0);
  });

  it("skips non-finite bars without shifting the index", () => {
    const bars = [
      { high: NaN, low: NaN, closeTime: 1_500 },
      { high: 120, low: 100, closeTime: 2_500 },
    ];
    const r = computeExcursion(LONG, bars);
    expect(r.mfeR).toBeCloseTo(2.0, 10);
    expect(r.timeToMfe).toBe(1);
  });

  it("clamps adverse-only moves to mfe 0", () => {
    const r = computeExcursion(LONG, [{ high: 99, low: 80, closeTime: 2_000 }]);
    expect(r.mfeR).toBe(0);
    expect(r.maeR).toBeCloseTo(2.0, 10);
    expect(r.timeToMfe).toBeUndefined();
  });
});

describe("snapshotExcursion", () => {
  it("implies excursion from the exit price (long winner)", () => {
    const r = snapshotExcursion(LONG, 120);
    expect(r.mfeR).toBeCloseTo(2.0, 10);
    expect(r.maeR).toBe(0);
  });

  it("implies excursion from the exit price (short loser)", () => {
    const r = snapshotExcursion(SHORT, 120);
    expect(r.mfeR).toBe(0);
    expect(r.maeR).toBeCloseTo(2.0, 10);
  });

  it("returns zeros on bad inputs", () => {
    expect(snapshotExcursion(LONG, NaN)).toEqual({ mfeR: 0, maeR: 0 });
    expect(snapshotExcursion({ ...LONG, slPrice: 100 }, 120)).toEqual({
      mfeR: 0,
      maeR: 0,
    });
  });
});

describe("closeFeesUsd", () => {
  it("charges taker+taker on market exits, taker+maker on TP", () => {
    // notional = 100 * 2 = 200
    expect(closeFeesUsd(100, 2, false)).toBeCloseTo(200 * (TAKER_FEE + TAKER_FEE), 10);
    expect(closeFeesUsd(100, 2, true)).toBeCloseTo(200 * (TAKER_FEE + MAKER_FEE), 10);
  });

  it("returns 0 on non-positive notional", () => {
    expect(closeFeesUsd(0, 2, false)).toBe(0);
    expect(closeFeesUsd(100, 0, false)).toBe(0);
  });
});

describe("fundingCostUsd", () => {
  it("accrues full 8h windows only", () => {
    const H8 = 8 * 3_600_000;
    // notional 1000, held 2.5 windows -> 2 windows
    expect(fundingCostUsd(100, 10, 0, 2.5 * H8)).toBeCloseTo(2 * 0.0001 * 1000, 10);
    expect(fundingCostUsd(100, 10, 0, H8 - 1)).toBe(0);
  });
});

describe("holdProfile", () => {
  const H15 = 900_000;
  it("buckets 15m-bar holds fast/medium/slow", () => {
    expect(holdProfile(0, 4 * H15)).toEqual({ barsHeld: 4, durationBucket: "fast" });
    expect(holdProfile(0, 5 * H15)).toEqual({ barsHeld: 5, durationBucket: "medium" });
    expect(holdProfile(0, 16 * H15)).toEqual({ barsHeld: 16, durationBucket: "medium" });
    expect(holdProfile(0, 17 * H15)).toEqual({ barsHeld: 17, durationBucket: "slow" });
  });
});

describe("captureRatio", () => {
  it("divides realized by MFE, undefined when MFE is 0", () => {
    expect(captureRatio(1.5, 3)).toBe(0.5);
    expect(captureRatio(-1, 2)).toBe(-0.5);
    expect(captureRatio(1, 0)).toBeUndefined();
  });
});

describe("atrPct", () => {
  it("averages true ranges as % of price", () => {
    const n = 20;
    const highs = Array(n).fill(110);
    const lows = Array(n).fill(90);
    const closes = Array(n).fill(100);
    // TR = 20 every bar -> 20/100*100 = 20%
    expect(atrPct(highs, lows, closes)).toBe(20);
  });

  it("returns undefined without enough bars", () => {
    expect(atrPct([1], [1], [1])).toBeUndefined();
  });
});


