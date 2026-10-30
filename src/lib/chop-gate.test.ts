/**
 * Tests for the 4H choppiness (Efficiency Ratio) gate — see chop-gate.ts.
 *
 * The parity risk is the same one every measured gate in this repo guards:
 * the floor knobs (ER(10) < 0.25) come from the 6-month lab, so any drift
 * in the ER construction silently de-tunes the shipped gate from what was
 * measured. Besides hand-computed cases, the tests check `efficiencyRatio`
 * against an independent reduce-based reference on a deterministic walk,
 * and pin the fail-open contracts (gate off / short history / bad period
 * must never block).
 */

import { describe, expect, it } from "vitest";
import {
  CHOP_GATE_DEFAULTS,
  chopGateFloorFor,
  chopGateVerdict,
  efficiencyRatio,
  type ChopGateConfig,
} from "./chop-gate";

/** Deterministic PRNG so the random-walk test never flakes. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Independent reference: same math, written with reduce only. */
function erReference(closes: number[], period: number): number {
  const win = closes.slice(-(period + 1));
  const path = win.slice(1).reduce((acc, c, i) => acc + Math.abs(c - win[i]), 0);
  if (path <= 0) return 0;
  return Math.abs(win[win.length - 1] - win[0]) / path;
}

const cfg = (over: Partial<ChopGateConfig> = {}): ChopGateConfig => ({
  chopGateEnabled: true,
  chopGatePeriod: CHOP_GATE_DEFAULTS.period,
  chopGateFloor: CHOP_GATE_DEFAULTS.floor,
  chopGateFloorLong: null,
  chopGateFloorShort: null,
  ...over,
});

describe("efficiencyRatio", () => {
  it("is 1.0 for a straight-line move (every bar in one direction)", () => {
    const closes = [100, 101, 102, 103, 104, 105];
    expect(efficiencyRatio(closes, 5)).toBeCloseTo(1, 10);
    expect(efficiencyRatio(closes, 2)).toBeCloseTo(1, 10);
  });

  it("is 0 for a flat tape (no path length at all)", () => {
    expect(efficiencyRatio([100, 100, 100, 100], 3)).toBe(0);
  });

  it("is low for a zig-zag weave that ends where it started", () => {
    // 100 → 110 → 100 → 110 → 100: net 0 over a long path = pure chop
    const er = efficiencyRatio([100, 110, 100, 110, 100], 4);
    expect(er).toBeDefined();
    expect(er!).toBeCloseTo(0, 10);
  });

  it("matches the independent reference on a deterministic walk", () => {
    const rnd = mulberry32(42);
    let price = 100;
    const closes = Array.from({ length: 120 }, () => {
      price *= 1 + (rnd() - 0.5) * 0.02;
      return price;
    });
    for (const period of [5, 10, 14, 30]) {
      expect(efficiencyRatio(closes, period)).toBeCloseTo(
        erReference(closes, period),
        12,
      );
    }
  });

  it("only reads the LAST period changes (older bars cannot leak in)", () => {
    const tail = [100, 101, 102, 103, 104, 105];
    const withNoise = [5, 500, 3, 900, 7, ...tail];
    expect(efficiencyRatio(withNoise, 5)).toBeCloseTo(efficiencyRatio(tail, 5)!, 10);
  });

  it("fails open on insufficient history, bad period, or NaN", () => {
    expect(efficiencyRatio([1, 2], 10)).toBeUndefined();
    expect(efficiencyRatio([1, 2, 3], 0)).toBeUndefined();
    expect(efficiencyRatio([1, 2, 3], NaN)).toBeUndefined();
    expect(efficiencyRatio([1, NaN, 3], 2)).toBeUndefined();
  });
});

describe("chopGateFloorFor", () => {
  it("uses the shared floor when no per-side override is set", () => {
    expect(chopGateFloorFor(cfg({ chopGateFloor: 0.3 }), "LONG")).toBe(0.3);
    expect(chopGateFloorFor(cfg({ chopGateFloor: 0.3 }), "SHORT")).toBe(0.3);
  });

  it("lets a per-side override win, independently per side", () => {
    const c = cfg({ chopGateFloor: 0.25, chopGateFloorLong: 0.35 });
    expect(chopGateFloorFor(c, "LONG")).toBe(0.35);
    expect(chopGateFloorFor(c, "SHORT")).toBe(0.25);
  });

  it("ignores a 0 / NaN override (falls back to the shared floor)", () => {
    expect(chopGateFloorFor(cfg({ chopGateFloor: 0.25, chopGateFloorLong: 0 }), "LONG")).toBe(0.25);
    expect(chopGateFloorFor(cfg({ chopGateFloor: 0.25, chopGateFloorShort: NaN }), "SHORT")).toBe(0.25);
  });
});

describe("chopGateVerdict", () => {
  // A weave: net 0 over 10 bars → ER(10) = 0, clearly below any floor.
  const choppy = [100, 110, 100, 110, 100, 110, 100, 110, 100, 110, 100];
  // A trend: ER(10) = 1.
  const trending = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110];

  it("blocks both sides on a choppy tape at the default floor", () => {
    expect(chopGateVerdict(choppy, cfg(), "LONG")).toMatchObject({ blocked: true, floor: 0.25 });
    expect(chopGateVerdict(choppy, cfg(), "SHORT")).toMatchObject({ blocked: true });
  });

  it("allows both sides on a trending tape", () => {
    expect(chopGateVerdict(trending, cfg(), "LONG").blocked).toBe(false);
    expect(chopGateVerdict(trending, cfg(), "SHORT").blocked).toBe(false);
    expect(chopGateVerdict(trending, cfg(), "LONG").er).toBeCloseTo(1, 10);
  });

  it("is a no-op when the gate is OFF — even on pure chop", () => {
    const v = chopGateVerdict(choppy, cfg({ chopGateEnabled: false }), "LONG");
    expect(v.blocked).toBe(false);
    expect(v.er).toBeUndefined();
  });

  it("fails open on insufficient history (never blocks without a reading)", () => {
    const v = chopGateVerdict([100, 90, 100, 90], cfg(), "LONG");
    expect(v.blocked).toBe(false);
    expect(v.er).toBeUndefined();
  });

  it("applies per-side floors at verdict time", () => {
    // ER = 35/75 ≈ 0.47: blocked only by the stricter 0.99 long override.
    const mid = [100, 110, 105, 115, 110, 120, 115, 125, 120, 130, 135];
    const er = efficiencyRatio(mid, 10)!;
    expect(er).toBeGreaterThan(0.3);
    expect(er).toBeLessThan(0.99);
    const c = cfg({ chopGateFloor: 0.25, chopGateFloorLong: 0.99 });
    expect(chopGateVerdict(mid, c, "LONG").blocked).toBe(true);
    expect(chopGateVerdict(mid, c, "SHORT").blocked).toBe(false);
  });
});
