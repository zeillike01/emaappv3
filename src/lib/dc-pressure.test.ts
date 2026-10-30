import { describe, expect, test } from "vitest";
import { DCP_DEFAULTS, computeDCP, detectDCLegs } from "./dc-pressure";

/** Steady rise: one direction, no confirmations yet. */
const ramp = (n: number) => Array.from({ length: n }, (_, i) => 100 * Math.pow(1.001, i));

/** Zig-zag with independent up/down step sizes (in %): cycles of `up` rises then `down` falls. */
function zig(
  up: number,
  down: number,
  aUp: number,
  aDown: number,
  cycles: number,
  start = 100,
): number[] {
  const out: number[] = [];
  let p = start;
  out.push(p);
  for (let c = 0; c < cycles; c++) {
    for (let i = 0; i < up; i++) { p *= 1 + aUp / 100; out.push(p); }
    for (let i = 0; i < down; i++) { p *= 1 - aDown / 100; out.push(p); }
  }
  return out;
}

describe("detectDCLegs", () => {
  test("θ must be positive; short input returns no legs", () => {
    expect(() => detectDCLegs([1, 2], 0)).toThrow();
    expect(detectDCLegs([1], 1)).toEqual([]);
    expect(detectDCLegs([], 1)).toEqual([]);
  });

  test("monotone ramp produces zero confirmed legs", () => {
    expect(detectDCLegs(ramp(50), 1)).toEqual([]);
  });

  test("a θ% reversal confirms a leg at the CONFIRMATION bar, not the extreme", () => {
    // 5 up bars @1% (extreme at index 5), then 3 down bars @0.5%:
    // cumulative fall 0.995³ = 0.98507 ≤ 0.99 only on the 3rd down bar.
    const prices = zig(5, 3, 1, 0.5, 1);
    const legs = detectDCLegs(prices, 1);
    expect(legs.length).toBe(1);
    const leg = legs[0]!;
    expect(leg.direction).toBe(1);
    expect(leg.endIndex).toBe(5); // extreme bar — what the buggy paste used
    expect(leg.confirmIndex).toBe(8); // θ printed here — the causality fix
    expect(leg.magnitude).toBeCloseTo(105.101 / 100 - 1, 6);
    expect(leg.duration).toBe(6);
  });

  test("no phantom zero-magnitude legs when reversal is immediate from bar 0", () => {
    // drop 2% immediately: the paste would emit a 0-magnitude up-leg at bar 0
    const prices = [100, 99, 98, 97];
    expect(detectDCLegs(prices, 1)).toEqual([]);
  });

  test("legs chain: each leg starts at the previous extreme; confirmations strictly increase", () => {
    const prices = zig(5, 5, 1, 1, 3);
    const legs = detectDCLegs(prices, 1);
    expect(legs.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < legs.length; i++) {
      expect(legs[i]!.startIndex).toBe(legs[i - 1]!.endIndex);
      expect(legs[i]!.confirmIndex).toBeGreaterThan(legs[i - 1]!.confirmIndex);
    }
  });

  test("directions strictly alternate (DC construction)", () => {
    const legs = detectDCLegs(zig(5, 5, 1, 1, 6), 1);
    for (let i = 1; i < legs.length; i++) {
      expect(legs[i]!.direction).toBe(-legs[i - 1]!.direction);
    }
  });
});

describe("computeDCP", () => {
  test("defaults pin", () => {
    expect(DCP_DEFAULTS).toEqual({
      thetaPct: 1.0, rollingLegs: 8, dcpSmoothing: 5, signalSmoothing: 3,
      magnitudeWeight: 0.6, speedWeight: 0.4,
    });
  });

  test("validation throws", () => {
    const p = ramp(100);
    expect(() => computeDCP(p, { rollingLegs: 1 })).toThrow();
    expect(() => computeDCP(p, { minLegs: 9 })).toThrow(); // > K
    expect(() => computeDCP(p, { minLegs: 0 })).toThrow();
    expect(() => computeDCP(p, { dcpSmoothing: 0 })).toThrow();
    expect(() => computeDCP(p, { magnitudeWeight: 0, speedWeight: 0 })).toThrow();
  });

  test("CAUSALITY: raw[t] only sees legs confirmed by bar t", () => {
    // one big up-leg confirmed 1 bar into the reversal
    const prices = zig(10, 5, 1.5, 1.5, 1);
    const legs = detectDCLegs(prices, 1.5);
    expect(legs.length).toBe(1);
    const c = legs[0]!.confirmIndex;
    const r = computeDCP(prices, { thetaPct: 1.5, rollingLegs: 4, minLegs: 1 });
    expect(r[c - 1]!.legsCount).toBe(0);
    expect(Number.isNaN(r[c - 1]!.raw)).toBe(true); // nothing confirmed yet
    expect(r[c]!.legsCount).toBe(1);
    expect(r[c]!.raw).toBe(1); // single confirmed up-leg: full positive pressure
  });

  test("WARMUP: raw is NaN until minLegs confirmed legs exist (default = K)", () => {
    const prices = zig(5, 5, 1, 1, 12);
    const legs = detectDCLegs(prices, 1);
    const eighthConfirm = legs[7]!.confirmIndex;
    const r = computeDCP(prices, { thetaPct: 1, rollingLegs: 8 });
    for (let i = 0; i < eighthConfirm; i++) expect(Number.isNaN(r[i]!.raw)).toBe(true);
    expect(isFinite(r[eighthConfirm]!.raw)).toBe(true);
  });

  test("dominance: big fast up-swings vs small slow down-swings → raw strongly positive, never ±1", () => {
    // DC legs alternate by construction, so both directions are always in the
    // window once ≥2 legs exist — raw CANNOT saturate; ±1 needs a one-legged
    // window (minLegs=1). The honest property: strong sign, strict bound.
    const up = zig(8, 3, 2, 0.75, 2); // up legs ~0.17 mag/9 bars, down ~0.023/4 bars
    const down = zig(3, 8, 0.75, 2, 2);
    const rUp = computeDCP(up, { thetaPct: 1, rollingLegs: 4, minLegs: 2 });
    const rDown = computeDCP(down, { thetaPct: 1, rollingLegs: 4, minLegs: 2 });
    const lastUp = rUp[rUp.length - 1]!.raw;
    const lastDown = rDown[rDown.length - 1]!.raw;
    expect(lastUp).toBeGreaterThan(0.5);
    expect(lastUp).toBeLessThan(1);
    expect(lastDown).toBeLessThan(-0.5);
    expect(lastDown).toBeGreaterThan(-1);
  });

  test("equal alternating swings cancel to ~0 (magBias and spdBias both 0)", () => {
    const prices = zig(5, 5, 1, 1, 8);
    const r = computeDCP(prices, { thetaPct: 1, rollingLegs: 8 });
    const last = r[r.length - 1]!;
    expect(Math.abs(last.raw)).toBeLessThan(0.05);
  });

  test("histogram identity and bounded raw on finite values", () => {
    const prices = zig(4, 3, 1.2, 0.9, 15);
    const r = computeDCP(prices, { thetaPct: 1.2 });
    for (const pt of r) {
      if (isFinite(pt.raw)) {
        expect(pt.raw).toBeGreaterThanOrEqual(-1);
        expect(pt.raw).toBeLessThanOrEqual(1);
      }
      if (isFinite(pt.dcp) && isFinite(pt.signal)) {
        expect(pt.histogram).toBeCloseTo(pt.dcp - pt.signal, 10);
      }
    }
  });

  test("smoothing converges toward the dominant raw once legs stabilize", () => {
    const prices = zig(8, 3, 2, 0.75, 2);
    const r = computeDCP(prices, { thetaPct: 1, rollingLegs: 4, minLegs: 2 });
    const tail = r.slice(-5);
    for (const pt of tail) {
      expect(pt.dcp).toBeGreaterThan(0.4); // near the dominant raw, still bounded
      expect(pt.dcp).toBeLessThan(1);
      expect(pt.signal).toBeGreaterThan(0);
    }
  });
});
