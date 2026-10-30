import { describe, expect, test } from "vitest";
import { VCD_DEFAULTS, VCT_DEFAULTS, computeVCD, computeVCT } from "./volume-centroid";

/** Flat volume -> raw = 0 at every index (center of mass = window center). */
const flat = (n: number) => new Array(n).fill(1000);

describe("computeVCD", () => {
  test("defaults pin", () => {
    expect(VCD_DEFAULTS).toEqual({ centroidWindow: 20, vcdSmoothing: 5, signalSmoothing: 3 });
  });

  test("warmup NaN until N-1, raw=0 on flat volume", () => {
    const r = computeVCD(flat(40));
    for (let i = 0; i < 19; i++) expect(Number.isNaN(r[i].raw)).toBe(true);
    for (let i = 19; i < 40; i++) {
      expect(r[i].raw).toBe(0);
      expect(r[i].centroid).toBe(10.5);
    }
  });

  test("all volume on the newest bar -> raw -> +1 (bounded by old bars' tiny weight); on the oldest -> -1", () => {
    const n = 20;
    const front = flat(n).map((v, i) => (i === n - 1 ? v * 1000 : v));
    const back = flat(n).map((v, i) => (i === 0 ? v * 1000 : v));
    expect(computeVCD(front)[n - 1].raw).toBeGreaterThan(0.95);
    expect(computeVCD(back)[n - 1].raw).toBeLessThan(-0.95);
  });

  test("centroid is the volume-weighted mean bar position (1..N)", () => {
    // N=3: weights 1,2,3 on equal volume -> centroid 2
    const r = computeVCD([5, 5, 5], { centroidWindow: 3 });
    expect(r[2].centroid).toBeCloseTo(2, 6);
    expect(r[2].raw).toBeCloseTo(0, 6);
  });

  test("zero-volume window -> raw 0, centroid NaN", () => {
    const r = computeVCD([0, 0, 0, 0, 0], { centroidWindow: 3 });
    expect(r[4].raw).toBe(0);
    expect(Number.isNaN(r[4].centroid)).toBe(true);
  });

  test("smoothing: vcd equals raw once stable, signal tracks vcd, histogram = vcd - signal", () => {
    const vols = flat(60).map((v, i) => 1000 + (i > 40 ? 5000 : 0));
    const r = computeVCD(vols);
    let sawPos = false;
    for (let i = 45; i < 60; i++) {
      expect(isFinite(r[i].vcd)).toBe(true);
      expect(isFinite(r[i].signal)).toBe(true);
      expect(r[i].histogram).toBeCloseTo(r[i].vcd - r[i].signal, 10);
      if (r[i].vcd > 0) sawPos = true;
    }
    expect(sawPos).toBe(true); // volume spike near the end -> vcd > 0
  });

  test("monotone decreasing volume -> raw negative (old volume dominates)", () => {
    const vols = Array.from({ length: 30 }, (_, i) => 1000 - i * 10);
    const r = computeVCD(vols);
    expect(r[29].raw).toBeLessThan(0);
  });
});

describe("computeVCT", () => {
  test("defaults pin", () => {
    expect(VCT_DEFAULTS).toEqual({ convictionWindow: 20, fastLen: 10, slowLen: 30, vctSmoothing: 5, signalSmoothing: 3 });
  });

  test("length mismatch throws", () => {
    expect(() => computeVCT([1, 2, 3], [1, 2])).toThrow();
  });

  test("steady uptrend with rising closes -> trend +1, raw +1 (full conviction)", () => {
    const closes = Array.from({ length: 70 }, (_, i) => 100 + i);
    const r = computeVCT(closes, flat(70));
    expect(r[69].trend).toBe(1);
    expect(r[69].raw).toBeCloseTo(1, 6);
  });

  test("steady downtrend -> trend -1, raw -1 (trend-signed: strong downtrend is VCT NEGATIVE)", () => {
    const closes = Array.from({ length: 70 }, (_, i) => 100 - i);
    const r = computeVCT(closes, flat(70));
    expect(r[69].trend).toBe(-1);
    expect(r[69].raw).toBeCloseTo(-1, 6);
  });

  test("uptrend carried by dissident volume -> conviction flips fully negative across the pullback", () => {
    const closes: number[] = [];
    for (let i = 0; i < 80; i++) closes.push(100 + i * 0.5); // long uptrend
    for (let i = 0; i < 30; i++) closes.push(closes[closes.length - 1] - 1.5); // volume-heavy pullback
    const vols = flat(110).map((v, i) => (i >= 80 ? v * 20 : v));
    const r = computeVCT(closes, vols);
    const rawBefore = r[79].raw; // last fully-up window (past warmup 49)
    const rawAfter = r[109].raw; // after 30 volume-heavy down bars
    expect(Number.isFinite(rawBefore)).toBe(true);
    expect(Number.isFinite(rawAfter)).toBe(true);
    expect(rawBefore).toBeGreaterThan(0.5);
    expect(rawAfter).toBeLessThan(-0.5);
  });

  test("warmup NaN until N + max(fast,slow) - 1, then defined", () => {
    const r = computeVCT(Array.from({ length: 70 }, (_, i) => 100 + (i % 5)), flat(70));
    for (let i = 0; i < 49; i++) expect(Number.isNaN(r[i].raw)).toBe(true);
    expect(Number.isNaN(r[49].raw)).toBe(false);
  });

  test("flat prices -> barDir 0 -> raw 0 despite trend defined", () => {
    const r = computeVCT(new Array(70).fill(100), flat(70));
    expect(r[69].raw).toBeCloseTo(0, 10);
  });

  test("histogram identity holds after warmup", () => {
    const closes = Array.from({ length: 90 }, (_, i) => 100 + Math.sin(i / 3) * 5);
    const r = computeVCT(closes, flat(90));
    for (let i = 55; i < 90; i++) {
      expect(r[i].histogram).toBeCloseTo(r[i].vct - r[i].signal, 10);
    }
  });
});
