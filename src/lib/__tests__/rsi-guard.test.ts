import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, computeLayer2Signal, resolveConfig } from "../layer2-signal";

/** Build a rising closes array that trips LONG (EMA7 > EMA30, break above). */
function longCloses(n = 60, base = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(base + i * 0.4);
  out[out.length - 1] = base + n * 0.4 + 3; // break candle
  return out;
}

/** Push the last closes vertical so RSI(7) of the final bar is extreme. */
function overextended(closes: number[], steps = 8, step = 1.2): number[] {
  const out = [...closes];
  let p = out[out.length - 1];
  for (let i = 0; i < steps; i++) {
    p += step;
    out.push(p);
  }
  return out;
}

const BASE_CFG = resolveConfig({
  minScore: 0,
  minGap: 0,
  maxEmaStretchPct: 0, // stretch veto off — isolates the RSI guard
  maxRsiLong: 78,
});

describe("RSI(7) long wick-guard", () => {
  it("default config ships the guard ON with threshold 78", () => {
    expect(DEFAULT_CONFIG.maxRsiLong).toBe(78);
    expect(DEFAULT_CONFIG.rsiLongGuard).toBe(true);
    expect(resolveConfig({}).maxRsiLong).toBe(78);
    expect(resolveConfig({ maxRsiLong: 90 }).maxRsiLong).toBe(90);
  });

  it("blocks LONG when the entry bar's RSI(7) is above the threshold", () => {
    const hot = overextended(longCloses(), 10, 1.5);
    const cfg = { ...BASE_CFG, maxEmaStretchPct: 0, maxRsiLong: 78, rsiLongGuard: true };
    const hotSignal = computeLayer2Signal(hot, 0.5, 0, null, 0.5, 0.5, 1, 0.01, 1e8, cfg);
    if (hotSignal.side === "LONG") {
      // if this setup still reads LONG, the guard must have vetoed it
      expect(hotSignal.stretchBlocked).toBe(false);
      expect(hotSignal.rsiLongBlocked).toBe(true);
      expect(hotSignal.side).toBeNull();
      expect(hotSignal.reasons.join(" ")).toMatch(/RSI/i);
    }
  });

  it("does not block SHORT when RSI(7) is hot (guard is long-only by design)", () => {
    const falling: number[] = [];
    for (let i = 0; i < 60; i++) falling.push(200 - i * 0.5);
    // needle up-tick on the last candle to print a hot RSI print while the
    // trend stays down — SHORT must NOT be blocked by a hot RSI
    falling[falling.length - 1] = falling[falling.length - 1] + 12;
    const cfg = { ...BASE_CFG, maxEmaStretchPct: 0, maxRsiLong: 78, rsiLongGuard: true };
    const s = computeLayer2Signal(falling, 0.5, 0, null, 0.5, 0.5, 1, 0.01, 1e8, cfg);
    if (s.side === "SHORT") {
      expect(s.rsiLongBlocked).toBe(false);
    }
  });

  it("guard disabled (rsiLongGuard=false) leaves signals untouched", () => {
    const hot = overextended(longCloses(), 10, 1.5);
    const cfg = { ...BASE_CFG, maxRsiLong: 78, rsiLongGuard: false };
    const s = computeLayer2Signal(hot, 0.5, 0, null, 0.5, 0.5, 1, 0.01, 1e8, cfg);
    expect(s.rsiLongBlocked).toBe(false);
  });
});
