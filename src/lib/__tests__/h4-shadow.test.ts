import { describe, expect, it } from "vitest";

import {
  evalShadowTags,
  extAtrApprox,
  H4_BIG_PCT,
  H4_DEAD_PCT,
  H4_VOL_CLIMAX_LOG2,
  h4GateBlocks,
  h4ShadowFromKlines,
  PULLBACK_EXT_ATR,
  RSI_HEAT,
  RSI_HEAT_SEVERE,
  rsi7FromCloses,
  SHADOW_TAG_BIG_PB,
  SHADOW_TAG_CLIMAX,
  SHADOW_TAG_DEAD_PB,
  SHADOW_TAG_RSI70,
  SHADOW_TAG_RSI80,
  type H4GateCfg,
} from "../h4-shadow";

/** n identical flat 4h bars with per-bar volume overrides. */
const mk4h = (
  n: number,
  vol: number,
  opts: { lastVol?: number; lastHigh?: number; lastLow?: number; close?: number } = {},
) => {
  const bars = [];
  const t0 = 1_700_000_000_000;
  const close = opts.close ?? 100;
  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    bars.push({
      openTime: t0 + i * 4 * 3600_000,
      closeTime: t0 + (i + 1) * 4 * 3600_000 - 1,
      open: close,
      high: isLast && opts.lastHigh != null ? opts.lastHigh : close * 1.001,
      low: isLast && opts.lastLow != null ? opts.lastLow : close * 0.999,
      close,
      volume: isLast && opts.lastVol != null ? opts.lastVol : vol,
    });
  }
  return bars;
};

describe("h4ShadowFromKlines", () => {
  it("computes range % and volume log2 from the newest closed bar", () => {
    // last bar: high 104, low 100, close 100 → range 4% of price
    const shadow = h4ShadowFromKlines(mk4h(30, 1000, { lastVol: 4000, lastHigh: 104, lastLow: 100 }), 9e14);
    expect(shadow).not.toBeNull();
    expect(shadow!.rangePct).toBeCloseTo(4, 6);
    // median of prior 20 = 1000 → log2(4000/1000) = 2
    expect(shadow!.volLog2).toBeCloseTo(2, 6);
  });

  it("ignores bars whose closeTime is after now (never reads a forming bar)", () => {
    const bars = mk4h(30, 1000, { lastVol: 9999 });
    const now = bars[24]!.closeTime; // pretend 'now' is mid-history: 25 bars closed
    const shadow = h4ShadowFromKlines(bars, now);
    expect(shadow).not.toBeNull();
    expect(shadow!.barOpenTime).toBe(bars[24]!.openTime);
    // the 9999-volume bar is in the future relative to now — must not be read
    expect(shadow!.volLog2).toBeCloseTo(0, 6);
  });

  it("returns null below 21 closed bars (no fabricated readings)", () => {
    expect(h4ShadowFromKlines(mk4h(20, 1000), 9e14)).toBeNull();
    expect(h4ShadowFromKlines([], 9e14)).toBeNull();
  });

  it("exposes the lab-matched thresholds as constants", () => {
    expect(H4_VOL_CLIMAX_LOG2).toBe(2); // ≥ 4× median
    expect(H4_BIG_PCT).toBe(4);
    expect(H4_DEAD_PCT).toBe(1);
    expect(PULLBACK_EXT_ATR).toBe(0.55);
    expect(RSI_HEAT).toBe(70);
    expect(RSI_HEAT_SEVERE).toBe(80);
  });
});

describe("rsi7FromCloses", () => {
  it("reads ~100 on a straight up-run and ~0 on a straight down-run", () => {
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    const down = Array.from({ length: 40 }, (_, i) => 140 - i);
    expect(rsi7FromCloses(up)!).toBeGreaterThan(95);
    expect(rsi7FromCloses(down)!).toBeLessThan(5);
  });

  it("returns null when the series is too short", () => {
    expect(rsi7FromCloses([1, 2, 3])).toBeNull();
  });

  it("sits mid-range on alternating closes", () => {
    const flat = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 100.5));
    const r = rsi7FromCloses(flat)!;
    expect(r).toBeGreaterThan(30);
    expect(r).toBeLessThan(70);
  });
});

describe("extAtrApprox", () => {
  it("is symmetric in side and positive in the side's direction", () => {
    const long = extAtrApprox("LONG", 110, 100, 1.0); // +10% / 1% ATR = 10
    const short = extAtrApprox("SHORT", 90, 100, 1.0); // 10% below → 10
    expect(long).toBeCloseTo(10, 6);
    expect(short).toBeCloseTo(10, 6);
  });

  it("floors tiny ATR readings at 0.04 instead of exploding", () => {
    expect(extAtrApprox("LONG", 100.4, 100, 0.0001)).toBeCloseTo(0.4 / 0.04, 6);
  });

  it("returns 0 on degenerate inputs (no fabricated extension)", () => {
    expect(extAtrApprox("LONG", 0, 100, 1)).toBe(0);
    expect(extAtrApprox("LONG", 100, 0, 1)).toBe(0);
  });
});

describe("evalShadowTags", () => {
  const H = (rangePct: number, volLog2: number) => ({
    barOpenTime: 1,
    rangePct,
    volLog2,
  });

  it("tags the 4h volume climax regardless of side or pullback", () => {
    const t = evalShadowTags({ h4: H(2, 2.0), rsi7: 50, pullback: false });
    expect(t.tags).toContain(SHADOW_TAG_CLIMAX);
    const notQuite = evalShadowTags({ h4: H(2, 1.99), rsi7: 50, pullback: false });
    expect(notQuite.tags).not.toContain(SHADOW_TAG_CLIMAX);
  });

  it("tags big/dead 4h candles only for pullback entries", () => {
    const pbBig = evalShadowTags({ h4: H(5, 0), rsi7: 50, pullback: true });
    expect(pbBig.tags).toContain(SHADOW_TAG_BIG_PB);
    const moBig = evalShadowTags({ h4: H(5, 0), rsi7: 50, pullback: false });
    expect(moBig.tags).not.toContain(SHADOW_TAG_BIG_PB);

    const pbDead = evalShadowTags({ h4: H(0.5, 0), rsi7: 50, pullback: true });
    expect(pbDead.tags).toContain(SHADOW_TAG_DEAD_PB);
    const pbNormal = evalShadowTags({ h4: H(1.5, 0), rsi7: 50, pullback: true });
    expect(pbNormal.tags).not.toContain(SHADOW_TAG_DEAD_PB);
    expect(pbNormal.tags).not.toContain(SHADOW_TAG_BIG_PB);
  });

  it("tags RSI heat at both severities, side-aligned upstream", () => {
    expect(evalShadowTags({ h4: null, rsi7: 85, pullback: false }).tags).toEqual(
      expect.arrayContaining([SHADOW_TAG_RSI70, SHADOW_TAG_RSI80]),
    );
    expect(evalShadowTags({ h4: null, rsi7: 75, pullback: false }).tags).toEqual([SHADOW_TAG_RSI70]);
    expect(evalShadowTags({ h4: null, rsi7: 69.9, pullback: false }).tags).toEqual([]);
  });

  it("returns no tags when the 4h reading is missing (fail-open) and carries null fields", () => {
    const t = evalShadowTags({ h4: null, rsi7: 50, pullback: true });
    expect(t.tags).toEqual([]);
    expect(t.h4RangePct).toBeNull();
    expect(t.h4VolLog2).toBeNull();
    expect(t.rsi7).toBe(50);
  });

  it("stacks multiple tags when several candidates fire at once", () => {
    const t = evalShadowTags({ h4: H(6, 3), rsi7: 90, pullback: true });
    expect(t.tags).toEqual(
      expect.arrayContaining([SHADOW_TAG_CLIMAX, SHADOW_TAG_BIG_PB, SHADOW_TAG_RSI70, SHADOW_TAG_RSI80]),
    );
    expect(t.tags).toHaveLength(4);
  });
});

describe("h4GateBlocks — paper quality gates (2026-09-23)", () => {
  const H = (rangePct: number, volLog2: number) => ({
    barOpenTime: 1,
    rangePct,
    volLog2,
  });
  const ON: H4GateCfg = {
    h4VolClimaxBlock: true,
    h4PullbackBigBlock: true,
    h4PullbackDeadBlock: true,
    rsiHeatMax: 80,
  };
  const OFF: H4GateCfg = {
    h4VolClimaxBlock: false,
    h4PullbackBigBlock: false,
    h4PullbackDeadBlock: false,
    rsiHeatMax: 0,
  };

  it("blocks any entry after a 4h volume climax (≥4× median), regardless of side or pullback state", () => {
    const h4 = H(6, 4); // log2 ≥ 2 → climax
    for (const side of ["LONG", "SHORT"] as const) {
      expect(h4GateBlocks({ h4, extAtr: 2.0, rsi7: 50, side, cfg: ON })).toMatch(/volume climax/);
      // Climax applies to momentum entries too — unlike the size gates.
      expect(h4GateBlocks({ h4, extAtr: 3.0, rsi7: 50, side, cfg: ON })).toMatch(/volume climax/);
    }
  });

  it("does not block a normal 4h bar (1–4% range, normal volume) for any entry", () => {
    const h4 = H(2, 1); // 2% range, 1× volume
    expect(h4GateBlocks({ h4, extAtr: 0.3, rsi7: 50, side: "LONG", cfg: ON })).toBeNull();
    expect(h4GateBlocks({ h4, extAtr: 3.0, rsi7: 50, side: "SHORT", cfg: OFF })).toBeNull();
  });

  it("blocks pullback entries after a big 4h candle and spares momentum entries", () => {
    const h4 = H(5, 1); // 5% ≥ H4_BIG_PCT, normal volume
    expect(h4GateBlocks({ h4, extAtr: 0.3, rsi7: 50, side: "LONG", cfg: ON })).toMatch(/candle-size gate/);
    expect(h4GateBlocks({ h4, extAtr: 0.5, rsi7: 50, side: "SHORT", cfg: ON })).toMatch(/candle-size gate/);
    // Same bar, momentum entry: allowed.
    expect(h4GateBlocks({ h4, extAtr: 1.5, rsi7: 50, side: "LONG", cfg: ON })).toBeNull();
  });

  it("blocks pullback entries after a dead 4h candle and spares momentum entries", () => {
    const h4 = H(0.6, 1); // 0.6% < H4_DEAD_PCT
    expect(h4GateBlocks({ h4, extAtr: 0.2, rsi7: 50, side: "SHORT", cfg: ON })).toMatch(/dead-candle gate/);
    expect(h4GateBlocks({ h4, extAtr: 1.0, rsi7: 50, side: "LONG", cfg: ON })).toBeNull();
  });

  it("enforces the RSI heat ceiling side-aligned, both sides", () => {
    expect(h4GateBlocks({ h4: H(2, 1), extAtr: 0.3, rsi7: 85, side: "LONG", cfg: ON })).toMatch(/RSI heat/);
    // Side-aligned: a SHORT at RSI 15 is the symmetric washout (100−15=85).
    expect(h4GateBlocks({ h4: H(2, 1), extAtr: 0.3, rsi7: 15, side: "SHORT", cfg: ON })).toMatch(/RSI heat/);
    // Just below the ceiling: allowed.
    expect(h4GateBlocks({ h4: H(2, 1), extAtr: 0.3, rsi7: 79.9, side: "LONG", cfg: ON })).toBeNull();
    expect(h4GateBlocks({ h4: H(2, 1), extAtr: 0.3, rsi7: 21, side: "SHORT", cfg: ON })).toBeNull();
  });

  it("fails OPEN on missing readings — null h4 / extAtr / rsi7 never blocks", () => {
    expect(h4GateBlocks({ h4: null, extAtr: 0.3, rsi7: 50, side: "LONG", cfg: ON })).toBeNull();
    // Size gates fail open without an extension reading (RSI still enforces).
    expect(h4GateBlocks({ h4: H(5, 0), extAtr: null, rsi7: 90, side: "LONG", cfg: ON })).toMatch(/RSI heat/);
    expect(h4GateBlocks({ h4: H(5, 0), extAtr: null, rsi7: 50, side: "LONG", cfg: ON })).toBeNull();
    expect(h4GateBlocks({ h4: null, extAtr: 0.3, rsi7: null, side: "SHORT", cfg: ON })).toBeNull();
  });

  it("respects the per-gate config toggles", () => {
    expect(h4GateBlocks({ h4: H(6, 4), extAtr: 0.3, rsi7: 50, side: "LONG", cfg: { ...ON, h4VolClimaxBlock: false } })).toMatch(/candle-size gate/);
    expect(h4GateBlocks({ h4: H(5, 1), extAtr: 0.3, rsi7: 50, side: "LONG", cfg: { ...ON, h4PullbackBigBlock: false } })).toBeNull();
    expect(h4GateBlocks({ h4: H(0.6, 1), extAtr: 0.2, rsi7: 50, side: "SHORT", cfg: { ...ON, h4PullbackDeadBlock: false } })).toBeNull();
    expect(h4GateBlocks({ h4: H(2, 1), extAtr: 0.3, rsi7: 85, side: "LONG", cfg: { ...ON, rsiHeatMax: 0 } })).toBeNull();
  });

  it("boundary: exactly 4% is big, exactly 1% is NOT dead, exactly 4× volume is climax", () => {
    // H(4,·): rangePct exactly 4 → big fires (>=), dead does not (strict <).
    expect(h4GateBlocks({ h4: H(4, 1), extAtr: 0.3, rsi7: 50, side: "LONG", cfg: ON })).toMatch(/candle-size gate/);
    expect(h4GateBlocks({ h4: H(4, 1), extAtr: 0.3, rsi7: 50, side: "LONG", cfg: { ...ON, h4PullbackBigBlock: false } })).toBeNull();
    // H(1,·): exactly 1% is not < 1.
    expect(h4GateBlocks({ h4: H(1, 1), extAtr: 0.3, rsi7: 50, side: "SHORT", cfg: ON })).toBeNull();
  });

  it("priority: climax fires before the size gates when several qualify", () => {
    const h4 = H(6, 4); // both climax AND big
    const block = h4GateBlocks({ h4, extAtr: 0.3, rsi7: 85, side: "LONG", cfg: ON });
    expect(block).toMatch(/volume climax/);
  });
});
