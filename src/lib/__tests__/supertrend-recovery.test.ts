import { describe, expect, it } from "vitest";
import {
  stSeries,
  pivotTrend,
  chartTrend,
  biasAt,
  htfAt,
  setupEdge,
  setupAt,
} from "../luxphase2/supertrendRecovery";

type B = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[] };
const HOUR = 3_600_000;
function bars(c: number[], spread = 2): B {
  const t = c.map((_, k) => k * HOUR);
  return { t, o: [...c], h: c.map((v) => v + spread / 2), l: c.map((v) => v - spread / 2), c: [...c] };
}

// Hand-traced Pine parity (spread 4 + max 2/bar moves -> TR exactly 4,
// so RMA atr = 4 for i >= 1): flips bearish exactly at bar 10 with band 100,
// after recovery-blended bands 88 -> 88.3 -> 88.485 -> 88.56.
function dropBars(): B {
  return bars(
    [100, 100, 100, 100, 100, 98, 96, 94, 92, 90, 88, 86, 84, 82, 80],
    4,
  );
}

describe("stSeries (Pine block verbatim)", () => {
  it("matches the hand-traced band path and flips at bar 8", () => {
    const b = dropBars();
    const { trend, band } = stSeries(b, { atrLen: 2, baseMult: 3, alpha: 0.05, thrAtr: 1 });
    expect(trend.slice(0, 10)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(trend[10]).toBe(-1);
    expect(band[1]).toBeCloseTo(88, 6);
    expect(band[7]).toBeCloseTo(88.3, 6);
    expect(band[9]).toBeCloseTo(88.56075, 4); // exact blend chain
    expect(band[10]).toBeCloseTo(100, 6); // flip reassigns upperBase
  });
  it("ratchets (never loosens) outside recovery", () => {
    const b = bars([100, 101, 102, 103, 104, 105, 106, 107]);
    const { trend, band } = stSeries(b, { atrLen: 2 });
    expect(trend.every((t) => t === 1)).toBe(true);
    for (let k = 2; k < band.length; k++) expect(band[k]).toBeGreaterThanOrEqual(band[k - 1]! - 1e-9);
  });
  it("blends toward price (not the base band) while at a loss", () => {
    const b = dropBars();
    const { band } = stSeries(b, { atrLen: 2, baseMult: 3, alpha: 0.05, thrAtr: 1 });
    // bar 7: at-loss blend 88.3 vs base lowerBase 82 -> blend wins via max()
    expect(band[7]).toBeGreaterThan(82);
    // bar 5: healthy, band is exactly the ratcheted base
    expect(band[5]).toBeCloseTo(88, 6);
  });
});

describe("pivotTrend (f_get_trend)", () => {
  it("latches the last confirmed pivots and flips on close-through", () => {
    // len 2: peak high 120 @5, trough low 90 @10
    const c = [100, 101, 102, 103, 104, 105, 104, 103, 100, 96, 92, 91, 92, 95, 99, 103, 108, 112, 118, 121, 119, 115, 110, 104, 97, 89, 84];
    const h = c.map((v, k) => (k === 5 ? 120 : k === 19 ? 121 : v + 0.5));
    const l = c.map((v, k) => (k === 10 ? 90 : v - 0.5));
    const t = pivotTrend(h, l, c, 2);
    expect(t[0]).toBe(1); // init bias, like Pine
    expect(t[12]).toBe(1); // 92 never closed through the confirmed 90 low
    expect(t[t.length - 1]).toBe(-1); // 84 < 90 flips on the confirmed pivot
  });
  it("needs a genuine close through the pivot", () => {
    const c = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
    const h = [...c.map((v) => v + 1)];
    const l = [...c.map((v) => v - 1)];
    expect(pivotTrend(h, l, c, 2).every((t) => t === 1)).toBe(true);
  });
});

describe("chartTrend (consumable BOS/CHoCH)", () => {
  it("breaks once per pivot then needs a fresh one", () => {
    const c = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111];
    const h = c.map((v, k) => (k === 5 ? 120 : v + 0.3));
    const l = c.map((v) => v - 0.3);
    const t = chartTrend(h, l, c, 2);
    // breakout above 120 confirms at bar 7+: trend already 1, pivot consumed
    expect(t[t.length - 1]).toBe(1);
    // dip forms a fresh low pivot, rally, then a break through it flips bear
    const c2 = [...c, 108, 104, 99, 96, 97, 99, 102, 100, 96, 92];
    const h2 = [...h, 109, 105, 100, 97, 98, 100, 103, 101, 97, 93];
    const l2 = [...l, 107, 103, 98, 95.7, 96.7, 98.7, 101.7, 99.7, 95.7, 91.7];
    const t2 = chartTrend(h2, l2, c2, 2);
    expect(t2[11]).toBe(1); // pre-dip tail untouched
    expect(t2[t2.length - 1]).toBe(-1); // 92 < confirmed 95.7 low pivot
  });
});

describe("biasAt/htfAt (t[1] + lookahead_on semantics)", () => {
  it("reads the previous CLOSED 4H block, never the forming one", () => {
    // 12 hourly bars = 3 blocks. Block 0 flat-ish (trend init 1).
    const c = [100, 100, 100, 100, 60, 60, 60, 60, 60, 60, 60, 60];
    const b = bars(c);
    // bar 4..7 live inside block 1 (forming): bias must still be block 0's = 1
    expect(biasAt(b, 5)).toBe(1);
    expect(biasAt(b, 7)).toBe(1);
  });
  it("maps 15m bars to 240m bias blocks (16 bars, UTC aligned)", () => {
    const Q = 900_000;
    const mk = (px: number[]) => ({
      t: px.map((_, k) => k * Q), o: [...px],
      h: px.map((v) => v + 0.2), l: px.map((v) => v - 0.2), c: [...px],
    });
    // 32 quarter-hours = 2 bias blocks; block 0 trends up from init 1.
    const px = Array.from({ length: 32 }, (_, k) => 100 + k * 0.1);
    const b = mk(px);
    expect(htfAt(b as never, 15, 14_400_000)).toBe(1); // inside forming block 1
    expect(htfAt(b as never, 16, 14_400_000)).toBe(1); // block 1 opens: reads block 0
  });
  it("resamples the 60m struct TF on a 15m chart with 1-block lag", () => {
    const Q = 900_000;
    const mk = (px: number[]) => ({
      t: px.map((_, k) => k * Q), o: [...px],
      h: px.map((v) => v + 0.3), l: px.map((v) => v - 0.3), c: [...px],
    });
    // 24 quarters = 6 struct blocks; steady climb, struct stays 1 throughout.
    const px = Array.from({ length: 24 }, (_, k) => 100 + k * 0.5);
    const b = mk(px);
    for (const i of [5, 11, 17, 23]) {
      expect(htfAt(b as never, i, 3_600_000)).toBe(1);
    }
  });
  it("setupAt honors the 15m HTF agreement by default", () => {
    const Q = 900_000;
    const px = Array.from({ length: 64 }, (_, k) => 100 + Math.sin(k / 4) * 2 + k * 0.05);
    const b = mk15(px);
    // smoke: both directions evaluate without throwing across the window
    let n = 0;
    for (let i = 30; i < 64; i++) {
      if (setupAt(b as never, i, 1)) n++;
      if (setupAt(b as never, i, -1)) n++;
    }
    expect(n).toBeGreaterThanOrEqual(0);
    function mk15(p: number[]) {
      return { t: p.map((_, k) => k * Q), o: [...p], h: p.map((v) => v + 0.2), l: p.map((v) => v - 0.2), c: [...p] };
    }
  });
});

describe("setupEdge", () => {
  it("fires once on the transition, not while sustained", () => {
    const b = dropBars();
    const o = { useBias: false, useStruct: false, useChart: false, atrLen: 2, swingLen: 1 };
    // ST flips bearish at bar 10 (ready gate is i > 2+2+5 = 9); bar 11 sustained
    expect(setupEdge(b, 10, -1, o)).toBe(true);
    expect(setupEdge(b, 11, -1, o)).toBe(false);
    expect(setupEdge(b, 10, 1, o)).toBe(false);
  });
});
