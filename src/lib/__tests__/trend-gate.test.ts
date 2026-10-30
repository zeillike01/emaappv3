import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, computeLayer2Signal, resolveConfig } from "../layer2-signal";

// Realistic thresholds so the "score compensation" leak is proven, not assumed:
// minScore 8 + minGap 2 with EMA7/EMA30. Stretch + RSI isolated off in the
// uptrend tests so ONLY the trend gate decides (mirrors rsi-guard.test.ts).
const BASE_CFG = resolveConfig({
  minScore: 8,
  minGap: 2,
  maxEmaStretchPct: 0,
  rsiLongGuard: false,
});

/** Downtrend closes: EMA7 < EMA30. */
function downCloses(n = 60, base = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(base - i * 0.5);
  return out;
}

/** Uptrend closes with small pullbacks so RSI stays under 78 (isolated anyway). */
function upCloses(n = 60, base = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(base + i * 0.5 + (i % 2) * 0.3);
  return out;
}

/**
 * Run-BROKEN variants (2026-10-03, chase-streak veto): identical trend, but the
 * last bar counter-moves so the streak veto (blocks LONG after 4 straight
 * higher closes, SHORT after 4 straight lower) does not fire. Tests of OLDER
 * gates use these to keep isolating their own gate — the veto has its own
 * suite in streak-veto.test.ts.
 */
function upClosesCool(n = 60, base = 100): number[] {
  const out = upCloses(n, base);
  out[out.length - 1] = out[out.length - 2]! - 0.3;
  return out;
}
function downClosesCool(n = 60, base = 100): number[] {
  const out = downCloses(n, base);
  out[out.length - 1] = out[out.length - 2]! + 0.3;
  return out;
}

describe("LONG hard trend gate (longTrendGate, 2026-09-10)", () => {
  it("default config ships the gate ON", () => {
    expect(DEFAULT_CONFIG.longTrendGate).toBe(true);
    expect(DEFAULT_CONFIG.shortTrendGate).toBe(true);
    expect(resolveConfig({}).longTrendGate).toBe(true);
    expect(resolveConfig({ longTrendGate: false }).longTrendGate).toBe(false);
    expect(resolveConfig({ shortTrendGate: false }).shortTrendGate).toBe(false);
  });

  it("blocks LONG when EMA fast <= EMA slow despite score compensation (the 09-02..10 leak)", () => {
    // Downtrend EMAs + heavy positive book/flow: longScore = -10 (EMA down)
    // + 0.9*22 (book) + 0.9*22 (flow) + 4 (tight spread) = 33.6 >= 8 and >=
    // shortScore + 2 — the OLD compensating model would enter this LONG.
    const s = computeLayer2Signal(downCloses(), 0.9, 0.9, null, 0.5, 0.5, 0.4, 0.02, 1e8, BASE_CFG);
    expect(s.longScore).toBeGreaterThanOrEqual(8);
    expect(s.side).toBeNull();
    expect(s.trendBlocked).toBe(true);
    expect(s.reasons.join(" ")).toMatch(/trend gate/i);
  });

  it("blocks LONG on an exact EMA tie (gate is emaFast > emaSlow, strict)", () => {
    // Flat ZERO closes → EMA fast === EMA slow === 0 exactly (zeros are
    // floating-point exact for any period; flat 100s drift by ~1e-14 on
    // EMA30 and read as a trend). Book/flow alone carries the score to LONG;
    // the tie must veto. The trend gate runs FIRST (before stretch/RSI), so
    // trendBlocked reports even though RSI would also be extreme.
    const flat = Array.from({ length: 60 }, () => 0);
    const s = computeLayer2Signal(flat, 0.9, 0.9, null, 0.5, 0.5, 0.4, 0.02, 1e8, BASE_CFG);
    expect(s.side).toBeNull();
    expect(s.trendBlocked).toBe(true);
  });

  it("does not block LONG when EMA fast > EMA slow", () => {
    const s = computeLayer2Signal(upClosesCool(), 0.5, 0.5, null, 0.5, 0.5, 0.4, 0.02, 1e8, BASE_CFG);
    expect(s.side).toBe("LONG");
    expect(s.trendBlocked).toBe(false);
  });

  it("does not touch SHORT when the mirror is off (LONG gate is side-specific)", () => {
    // Uptrend EMAs + heavy seller flow → SHORT; with shortTrendGate disabled
    // the LONG gate alone must never block it.
    const cfg = resolveConfig({ ...BASE_CFG, shortTrendGate: false });
    const s = computeLayer2Signal(upCloses(), -0.9, -0.9, null, 0.5, 0.5, 0.4, 0.02, 1e8, cfg);
    expect(s.side).toBe("SHORT");
    expect(s.trendBlocked).toBe(false);
  });

  it("gate disabled (longTrendGate=false) restores the old compensating behavior", () => {
    const cfg = resolveConfig({ ...BASE_CFG, longTrendGate: false });
    const s = computeLayer2Signal(downCloses(), 0.9, 0.9, null, 0.5, 0.5, 0.4, 0.02, 1e8, cfg);
    expect(s.side).toBe("LONG");
    expect(s.trendBlocked).toBe(false);
  });
});

describe("SHORT hard trend gate mirror (shortTrendGate, 2026-09-10)", () => {
  it("blocks SHORT when EMA fast >= EMA slow despite score compensation", () => {
    // Uptrend EMAs + heavy seller book/flow: shortScore = -10 (EMA up)
    // + 0.9*22 (book) + 0.9*22 (flow) + 4 (tight spread) = 33.6 >= 8 and
    // >= longScore + 2 — the old compensating model would short into a
    // rising EMA structure.
    const s = computeLayer2Signal(upCloses(), -0.9, -0.9, null, 0.5, 0.5, 0.4, 0.02, 1e8, BASE_CFG);
    expect(s.shortScore).toBeGreaterThanOrEqual(8);
    expect(s.side).toBeNull();
    expect(s.trendBlocked).toBe(true);
    expect(s.reasons.join(" ")).toMatch(/trend gate/i);
  });

  it("blocks SHORT on an exact EMA tie (gate is emaFast < emaSlow, strict)", () => {
    // Flat ZEROs for a floating-point-exact tie (see LONG tie test above).
    const flat = Array.from({ length: 60 }, () => 0);
    const s = computeLayer2Signal(flat, -0.9, -0.9, null, 0.5, 0.5, 0.4, 0.02, 1e8, BASE_CFG);
    expect(s.side).toBeNull();
    expect(s.trendBlocked).toBe(true);
  });

  it("does not block SHORT when EMA fast < EMA slow", () => {
    const s = computeLayer2Signal(downClosesCool(), -0.5, -0.5, null, 0.5, 0.5, 0.4, 0.02, 1e8, BASE_CFG);
    expect(s.side).toBe("SHORT");
    expect(s.trendBlocked).toBe(false);
  });

  it("does not touch LONG (mirror is side-specific)", () => {
    const s = computeLayer2Signal(upClosesCool(), 0.9, 0.9, null, 0.5, 0.5, 0.4, 0.02, 1e8, BASE_CFG);
    expect(s.side).toBe("LONG");
    expect(s.trendBlocked).toBe(false);
  });

  it("gate disabled (shortTrendGate=false) restores the old compensating behavior", () => {
    const cfg = resolveConfig({ ...BASE_CFG, shortTrendGate: false });
    const s = computeLayer2Signal(upCloses(), -0.9, -0.9, null, 0.5, 0.5, 0.4, 0.02, 1e8, cfg);
    expect(s.side).toBe("SHORT");
    expect(s.trendBlocked).toBe(false);
  });
});