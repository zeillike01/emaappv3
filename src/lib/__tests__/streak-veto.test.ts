import { describe, expect, it } from "vitest";
import {
  CHASE_STREAK_VETO_N,
  computeLayer2Signal,
  resolveConfig,
  streakVetoBlocks,
} from "../layer2-signal";

// Other vetoes isolated off so ONLY the streak veto can decide.
const BASE_CFG = resolveConfig({
  minScore: 8,
  minGap: 2,
  maxEmaStretchPct: 0,
  rsiLongGuard: false,
});

/** 60 straight rises — a chase by construction. */
function riseCloses(n = 60, base = 100, step = 0.5): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(base + i * step);
  return out;
}

/** 60 straight falls. */
function fallCloses(n = 60, base = 100, step = 0.5): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(base - i * step);
  return out;
}

describe("streakVetoBlocks (pure)", () => {
  it("ships the validated constant N=4 (plateau holds at 3/4/5 — not a knob)", () => {
    expect(CHASE_STREAK_VETO_N).toBe(4);
  });

  it("blocks LONG after 4 straight higher closes, allows 3", () => {
    expect(streakVetoBlocks([100, 101, 102, 103, 104], "LONG")).toBe(true);
    expect(streakVetoBlocks([100, 101, 102, 103], "LONG")).toBe(false);
  });

  it("blocks SHORT after 4 straight lower closes, allows 3", () => {
    expect(streakVetoBlocks([104, 103, 102, 101, 100], "SHORT")).toBe(true);
    expect(streakVetoBlocks([103, 102, 101, 100], "SHORT")).toBe(false);
  });

  it("is side-specific: a rise is not a SHORT chase and a fall is not a LONG chase", () => {
    expect(streakVetoBlocks([100, 101, 102, 103, 104], "SHORT")).toBe(false);
    expect(streakVetoBlocks([104, 103, 102, 101, 100], "LONG")).toBe(false);
  });

  it("a flat bar breaks the run (a pause is not a chase)", () => {
    expect(streakVetoBlocks([100, 101, 102, 103, 103], "LONG")).toBe(false);
    expect(streakVetoBlocks([100, 101, 102, 103, 102.9], "LONG")).toBe(false);
  });

  it("never fires without a side", () => {
    expect(streakVetoBlocks([100, 101, 102, 103, 104], null)).toBe(false);
  });
});

describe("chase-streak veto wiring (2026-10-03, Mech-4 PASS)", () => {
  it("blocks a LONG chase and reports its own cause", () => {
    const s = computeLayer2Signal(riseCloses(), 0.5, 0.5, null, 0.5, 0.5, 0.4, 0.02, 1e8, BASE_CFG);
    expect(s.longScore).toBeGreaterThanOrEqual(8);
    expect(s.side).toBeNull();
    expect(s.streakBlocked).toBe(true);
    expect(s.trendBlocked).toBe(false);
    expect(s.reasons.join(" ")).toMatch(/chase-streak/i);
  });

  it("blocks a SHORT chase (mirror)", () => {
    const s = computeLayer2Signal(fallCloses(), -0.5, -0.5, null, 0.5, 0.5, 0.4, 0.02, 1e8, BASE_CFG);
    expect(s.shortScore).toBeGreaterThanOrEqual(8);
    expect(s.side).toBeNull();
    expect(s.streakBlocked).toBe(true);
    expect(s.trendBlocked).toBe(false);
    expect(s.reasons.join(" ")).toMatch(/chase-streak/i);
  });

  it("lets a non-chase LONG through (run broken by a pullback bar)", () => {
    const closes = riseCloses();
    closes[closes.length - 1] = closes[closes.length - 2]! - 0.3;
    const s = computeLayer2Signal(closes, 0.5, 0.5, null, 0.5, 0.5, 0.4, 0.02, 1e8, BASE_CFG);
    expect(s.side).toBe("LONG");
    expect(s.streakBlocked).toBe(false);
  });

  it("runs AFTER the trend gate: a counter-trend chase reports trend, not streak", () => {
    // Rising tape + seller flow selects SHORT pre-gate; the trend gate kills it
    // first, so the streak veto never fires on it.
    const s = computeLayer2Signal(riseCloses(), -0.9, -0.9, null, 0.5, 0.5, 0.4, 0.02, 1e8, BASE_CFG);
    expect(s.side).toBeNull();
    expect(s.trendBlocked).toBe(true);
    expect(s.streakBlocked).toBe(false);
  });
});
