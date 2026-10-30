import { describe, expect, it } from "vitest";
import {
  advanceParked,
  buildDeferralSeries,
  DEFERRAL_DEFAULTS,
  histogramTurning,
  isPivot,
  parkSetup,
  stretchAt,
  type DeferralSeries,
} from "../deferred-entry";
import type { Kline } from "../types";

const bar = (high: number, low: number, close: number, volume = 10, openTime = 0): Kline => ({
  openTime,
  open: (high + low) / 2,
  high,
  low,
  close,
  volume,
  quoteVolume: close * volume,
  trades: 1,
  isClosed: true,
  closeTime: openTime + 900_000,
});

/** A flat 15m tape — the "not stretched" control. */
const flat = Array.from({ length: 40 }, (_, i) => bar(100.5, 99.5, 100, 10, i * 900_000));

describe("stretchAt — the over-extension test", () => {
  it("flags a vertical run as stretched for a SHORT", () => {
    // 40 bars climbing 100 → 130: price finishes well above the 24-bar VWAP
    // with RSI pinned high.
    const bars = Array.from({ length: 40 }, (_, i) => {
      const c = 100 + i;
      return bar(c + 0.5, c - 1, c, 10, i * 900_000);
    });
    const series = buildDeferralSeries(bars);
    const read = stretchAt(bars, series, bars.length - 1, "SHORT");
    expect(read.extended).toBe(true);
    expect(read.vwapDistPct).toBeGreaterThan(3);
    expect(read.rsi).toBeGreaterThan(70);
  });

  it("mirrors the test for a LONG on a collapse", () => {
    const bars = Array.from({ length: 40 }, (_, i) => {
      const c = 140 - i;
      return bar(c + 1, c - 0.5, c, 10, i * 900_000);
    });
    const series = buildDeferralSeries(bars);
    const read = stretchAt(bars, series, bars.length - 1, "LONG");
    expect(read.extended).toBe(true);
    expect(read.vwapDistPct).toBeLessThan(-3);
    expect(read.rsi).toBeLessThan(30);
  });

  it("does not flag a flat tape, in either direction", () => {
    const series = buildDeferralSeries(flat);
    expect(stretchAt(flat, series, flat.length - 1, "SHORT").extended).toBe(false);
    expect(stretchAt(flat, series, flat.length - 1, "LONG").extended).toBe(false);
  });

  it("fails OPEN during warm-up (cannot measure ⇒ never parks)", () => {
    const series = buildDeferralSeries(flat);
    expect(stretchAt(flat, series, 2, "SHORT").extended).toBe(false);
    expect(Number.isNaN(stretchAt(flat, series, 2, "SHORT").vwapDistPct)).toBe(true);
  });
});

// ── A short setup: over-extended high at 5, former higher low at 2 (96).
const shortBars: Kline[] = [
  bar(100, 99, 99.5),
  bar(101, 98, 100),
  bar(99, 96, 97), //       ← guard pivot low (96)
  bar(101, 98, 100),
  bar(103, 100, 102),
  bar(110, 102, 109), //     ← the extended high (110)
  bar(107, 103, 104),
  bar(104, 101, 102),
  bar(105, 102, 103),
  bar(106, 103, 104), //     ← lower high pivot (106), confirmed 2 bars later
  bar(105, 101, 102),
  bar(104, 100, 101), //     ← confirmation bar (idx 11)
];

const flatHist = new Array<number>(shortBars.length).fill(0);
const seriesWith = (hist: number[]): DeferralSeries => ({
  hist,
  rsi: new Array(shortBars.length).fill(60),
  vwap: new Array(shortBars.length).fill(100),
});

const histFading = flatHist.map((_, i) => (i <= 8 ? 1.4 : i === 9 ? 1.0 : i === 10 ? 0.5 : 0.2));
const histRising = flatHist.map((_, i) => (i <= 8 ? 0.2 : i === 9 ? 0.5 : i === 10 ? 1.0 : 1.4));

describe("parkSetup — the parked state", () => {
  it("anchors the extended high and the former higher low", () => {
    const setup = parkSetup(shortBars, "SHORT", 5)!;
    expect(setup.extreme).toBe(110);
    expect(setup.extremeIndex).toBe(5);
    expect(setup.guard).toBe(96);
    expect(setup.guardIndex).toBe(2);
  });

  it("returns null when no guard pivot exists (no measurable expiry)", () => {
    const bars = Array.from({ length: 6 }, (_, i) => bar(101 + i, 100 + i, 100.5 + i));
    expect(parkSetup(bars, "SHORT", 5)).toBe(null);
  });
});

describe("isPivot — swing confirmation", () => {
  it("needs strictly lower neighbours on both sides for a high", () => {
    expect(isPivot(shortBars, 9, "high", 2)).toBe(true);
    // The extreme itself IS a valid pivot (it has lower neighbours on both
    // sides) — that is what makes it the anchor, not a rejection reason.
    expect(isPivot(shortBars, 5, "high", 2)).toBe(true);
    expect(isPivot(shortBars, 4, "high", 2)).toBe(false); // 103 < the 110 two bars later
  });
});

describe("advanceParked — wait / enter / cancel", () => {
  const setup = parkSetup(shortBars, "SHORT", 5)!;

  it("waits while no confirmed lower high exists", () => {
    const r = advanceParked(shortBars, seriesWith(histFading), setup, 7);
    expect(r.action).toBe("wait");
    expect(r.action === "wait" && r.reason).toMatch(/no confirmed lower high/);
  });

  it("waits when the lower high formed but the histogram has not turned", () => {
    const r = advanceParked(shortBars, seriesWith(histRising), setup, 11);
    expect(r.action).toBe("wait");
    expect(r.action === "wait" && r.reason).toMatch(/has not printed a green peak/);
  });

  it("enters on a confirmed lower high plus 2-3 fading histogram bars", () => {
    const r = advanceParked(shortBars, seriesWith(histFading), setup, 11);
    expect(r.action).toBe("enter");
    expect(r.action === "enter" && r.barIndex).toBe(11);
  });

  it("cancels when the former higher low breaks — entering there is chasing", () => {
    const bars = shortBars.map((b, i) => (i === 11 ? { ...b, close: 95 } : b));
    const r = advanceParked(bars, seriesWith(histFading), setup, 11);
    expect(r.action).toBe("cancel");
    expect(r.action === "cancel" && r.reason).toMatch(/former higher low broken/);
  });

  it("cancels on a new high above the parked extreme (premise gone)", () => {
    const bars = shortBars.map((b, i) => (i === 11 ? { ...b, high: 111 } : b));
    const r = advanceParked(bars, seriesWith(histFading), setup, 11);
    expect(r.action).toBe("cancel");
    expect(r.action === "cancel" && r.reason).toMatch(/new high/);
  });

  it("checks invalidation before confirmation on the same bar", () => {
    // Bar breaks the guard AND has a fading histogram: that is a failed setup.
    const bars = shortBars.map((b, i) => (i === 11 ? { ...b, close: 95 } : b));
    expect(advanceParked(bars, seriesWith(histFading), setup, 11).action).toBe("cancel");
  });
});

describe("mirror — a LONG is the same rule upside down", () => {
  // Collapse to 90 at index 5, former lower high at 2 (104), bounce into a
  // higher low pivot at 9 (94), confirmation at 11.
  const longBars: Kline[] = [
    bar(101, 100, 100.5),
    bar(102, 99, 101),
    bar(104, 101, 103), //    ← guard pivot high (104)
    bar(102, 99, 100),
    bar(100, 97, 98),
    bar(92, 90, 91), //       ← the extended low (90), close 91
    bar(97, 92, 95),
    bar(99, 95, 96),
    bar(97, 95, 96),
    bar(96, 94, 95), //       ← higher low pivot (94)
    bar(98, 95, 97),
    bar(99, 96, 98), //       ← confirmation bar (idx 11)
  ];
  const histRisingLong = new Array<number>(longBars.length)
    .fill(1.4)
    .map((v, i) => (i <= 8 ? -1.4 : i === 9 ? -1.0 : i === 10 ? -0.5 : -0.2));

  it("parks the extended low and the former lower high", () => {
    const setup = parkSetup(longBars, "LONG", 5)!;
    expect(setup.extreme).toBe(90);
    expect(setup.guard).toBe(104);
  });

  it("enters on a higher low plus a strengthening histogram", () => {
    const setup = parkSetup(longBars, "LONG", 5)!;
    const series = seriesWith(histRisingLong);
    const r = advanceParked(longBars, series, setup, 11);
    expect(r.action).toBe("enter");
  });

  it("cancels on a break of the former lower high", () => {
    const setup = parkSetup(longBars, "LONG", 5)!;
    const bars = longBars.map((b, i) => (i === 11 ? { ...b, close: 105 } : b));
    expect(advanceParked(bars, seriesWith(histRisingLong), setup, 11).action).toBe("cancel");
  });
});

describe("histogramTurning — the 2-3 candle rule", () => {
  const hist = [0, 0, 3, 2, 1];

  it("needs a strict decline on every bar in the window", () => {
    expect(histogramTurning(hist, 4, "SHORT", 3)).toBe(true);
    expect(histogramTurning(hist, 4, "SHORT", 2)).toBe(true);
    expect(histogramTurning([0, 0, 1, 2, 3], 4, "SHORT", 2)).toBe(false);
  });

  it("mirrors for a LONG", () => {
    expect(histogramTurning([0, 0, 1, 2, 3], 4, "LONG", 3)).toBe(true);
    expect(histogramTurning(hist, 4, "LONG", 3)).toBe(false);
  });

  it("refuses to confirm on warm-up NaNs", () => {
    expect(histogramTurning([NaN, NaN, 0.2, 0.1], 3, "SHORT", 3)).toBe(false);
  });
});

describe("config keys stay aligned with the documented defaults", () => {
  it("uses 15m-scale defaults (1.5% stretch, RSI 65, 24-bar VWAP, 2-bar pivots)", () => {
    expect(DEFERRAL_DEFAULTS.overExtendVwapPct).toBe(1.5);
    expect(DEFERRAL_DEFAULTS.overExtendRsi).toBe(65);
    expect(DEFERRAL_DEFAULTS.vwapBars).toBe(24);
    expect(DEFERRAL_DEFAULTS.pivotLookback).toBe(2);
  });
});
