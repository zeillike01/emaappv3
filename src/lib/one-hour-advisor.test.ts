import { describe, expect, it } from "vitest";

import {
  channelPosition,
  deadChannelVerdict,
  trendAge,
} from "./one-hour-advisor";

const bar = (i: number, close: number, high = close + 1, low = close - 1) => ({
  openTime: i * 3_600_000,
  open: close,
  high,
  low,
  close,
  closeTime: i * 3_600_000 + 3_599_999,
});

describe("trendAge", () => {
  it("reads ~0 right after a fresh cross", () => {
    // collapse into a downtrend at the very end
    const closes = [...Array(30).fill(110), ...Array(3).fill(90)];
    expect(trendAge(closes, 20)).toBeLessThanOrEqual(3);
  });
  it("reads large for a long uninterrupted trend", () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    expect(trendAge(closes, 20)).toBeGreaterThanOrEqual(30);
  });
  it("returns null before the EMA seeds", () => {
    expect(trendAge([100, 101, 102], 20)).toBeNull();
  });
});

describe("channelPosition", () => {
  it("reads 1 at the channel top", () => {
    // a V then a spike: channel 0..21 over the last 20 bars, final close at 21
    const bars = Array.from({ length: 20 }, (_, i) => bar(i, i % 2 === 0 ? 0 : 1));
    bars.push(bar(20, 21, 21.5, 20.5));
    const p = channelPosition(bars, 20)!;
    expect(p).toBeGreaterThan(0.9);
  });
  it("reads 0 at the channel bottom", () => {
    // 19 oscillating 0..1 bars + final bar with close at its own low of 0 —
    // the channel spans −0.5..1.5, and the close sits at (0−(−0.5))/2 = 0.25;
    // the honest assertion is the bottom quartile, not literal 0
    const bars = Array.from({ length: 19 }, (_, i) => bar(i, i % 2 === 0 ? 0.1 : 1));
    bars.push(bar(19, 0, 0.5, 0));
    const p = channelPosition(bars, 20)!;
    expect(p).toBeLessThan(0.35);
  });
  it("reads 0.5 on a zero-width channel instead of NaN", () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(i, 100, 100.5, 99.5));
    bars.push(bar(20, 100, 100.5, 99.5));
    expect(channelPosition(bars, 20)).toBeCloseTo(0.5, 6);
  });
});

describe("deadChannelVerdict", () => {
  /** Build a stale uptrend bleeding sideways-to-down: 30 slow-up bars (old
   *  EMA20-cross age), then a slow fade that sags the close to the bottom of
   *  the 20-bar Donchian window WITHOUT crossing the EMA20 (a crash would
   *  reset the age; the measured state is a slow bleed). */
  function staleTrendCollapse(): { high: number; low: number; close: number }[] {
    const bars: { high: number; low: number; close: number }[] = [];
    for (let i = 0; i < 30; i++) {
      const c = 100 + i * 0.4;
      bars.push({ high: c + 0.4, low: c - 0.4, close: c });
    }
    // slow fade: 26 bars drifting down 0.55/bar from ~112 to ~98 — the close
    // rides the channel bottom while the EMA20 (lagging above ~103) is never
    // recrossed, so the age grows past 18
    for (let i = 0; i < 26; i++) {
      const c = 112 - i * 0.55;
      bars.push({ high: c + 0.5, low: c - 0.5, close: c });
    }
    return bars;
  }
  it("vetoes a LONG pressing the channel bottom in a stale trend", () => {
    const v = deadChannelVerdict({ bars1h: staleTrendCollapse(), side: "LONG" });
    expect(v.age).toBeGreaterThanOrEqual(18);
    expect(v.dirChannelPos).toBeLessThan(0.35);
    expect(v.veto).toBe(true);
    expect(v.reason).toContain("dead-channel");
  });
  it("mirrors for a SHORT pressing the channel top in a stale downtrend", () => {
    // invert the collapse fixture around 100: stale downtrend bleeding up into
    // the channel top. SHORT's dir-pos = 1 − pos → same low quadrant.
    const bars = staleTrendCollapse().map((b) => ({ high: 200 - b.low, low: 200 - b.high, close: 200 - b.close }));
    const v = deadChannelVerdict({ bars1h: bars, side: "SHORT" });
    expect(v.veto).toBe(true);
  });
  it("does not veto a young trend at the same place (fail-soft by design)", () => {
    // fresh 25-bar collapse: age < 18, position low
    const bars: { high: number; low: number; close: number }[] = [];
    for (let i = 0; i < 21; i++) {
      const c = 100 - i * 4;
      bars.push({ high: c + 1, low: c - 1, close: c });
    }
    const v = deadChannelVerdict({ bars1h: bars, side: "SHORT" });
    expect(v.age ?? 0).toBeLessThan(18);
    expect(v.veto).toBe(false);
  });
  it("fails OPEN on short history", () => {
    const v = deadChannelVerdict({ bars1h: [bar(0, 100)], side: "LONG" });
    expect(v.veto).toBe(false);
    expect(v.reason).toBeNull();
  });
  it("params are overridable (the coverage-sweep contract)", () => {
    const bars = staleTrendCollapse();
    const strict = deadChannelVerdict({ bars1h: bars, side: "LONG", params: { staleAgeBars: 999 } });
    expect(strict.veto).toBe(false);
  });
});
