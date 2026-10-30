import { describe, expect, it } from "vitest";
import {
  zigzag,
  validBull,
  validBear,
  entryAt,
  epaTouchAt,
  epaValue,
  stopDist,
  completedPatterns,
  type LuxPiv,
} from "../luxphase2/wolfeLux";

type B = { o: number[]; h: number[]; l: number[]; c: number[] };

// Textbook bullish Wolfe skeleton (L=3 zigzag):
// A=low95@10 B=high121@20 C=low89@30 D=high116@40, decline, 1-3 break,
// reclaim; zone x1=43 x2=57; completion bars 58,59.
function bullBars(): B {
  const N = 70;
  const o = new Array(N).fill(0), h = new Array(N).fill(0), l = new Array(N).fill(0), c = new Array(N).fill(0);
  const set = (k: number, oo: number, hh: number, ll: number, cc: number) => { o[k] = oo; h[k] = hh; l[k] = ll; c[k] = cc; };
  for (let k = 0; k <= 9; k++) set(k, 98, 98.3, 97.7, 98); // flat seed
  set(10, 97, 97.5, 95, 97); // A
  for (let k = 11; k <= 19; k++) { const px = 97 + (119 - 97) * ((k - 10) / 10); set(k, px - 0.2, px + 0.5, px - 2, px); } // rise
  set(20, 119, 121, 117, 119); // B
  for (let k = 21; k <= 29; k++) { const px = 119 - (119 - 91) * ((k - 20) / 10); set(k, px + 0.2, px + 2, px - 0.5, px); } // fall
  set(30, 91, 91.5, 89, 91); // C
  for (let k = 31; k <= 39; k++) { const px = 91 + (114 - 91) * ((k - 30) / 10); set(k, px - 0.2, px + 0.5, px - 2, px); } // rise
  set(40, 114, 116, 112, 114); // D
  for (let k = 41; k <= 51; k++) { const px = 112 - (112 - 79) * ((k - 41) / 10); set(k, px + 0.2, px + 1.5, px - 1.5, px); } // decline
  for (let k = 52; k <= 59; k++) { const px = 79 + (90 - 79) * ((k - 52) / 7); set(k, px - 0.2, px + 0.8, px - 1.2, px); } // reclaim
  for (let k = 60; k < N; k++) { const px = 90 + (k - 60) * 0.3; set(k, px - 0.1, px + 0.4, px - 0.4, px); } // drift
  return { o, h, l, c };
}

const P = (i: number, px: number, dir: 1 | -1): LuxPiv => ({ i, px, dir });

describe("wolfeLux validation math (Pine 1:1)", () => {
  it("accepts a symmetric textbook bull quad", () => {
    expect(validBull(P(10, 95, -1), P(20, 121, 1), P(30, 89, -1), P(40, 116, 1))).toBe(true);
  });
  it("rejects asymmetric leg durations (margin 0.70)", () => {
    // legs 10 vs 25 bars -> 2.5-1 = 1.5 > 0.7
    expect(validBull(P(10, 95, -1), P(20, 121, 1), P(30, 89, -1), P(55, 116, 1))).toBe(false);
  });
  it("rejects a bad angle (D off the A-C-projected channel)", () => {
    expect(validBull(P(10, 95, -1), P(20, 121, 1), P(30, 89, -1), P(40, 150, 1))).toBe(false);
  });
  it("rejects wrong alternation", () => {
    expect(validBull(P(10, 95, -1), P(20, 121, -1), P(30, 89, -1), P(40, 116, 1))).toBe(false);
  });
  it("accepts the mirrored bear quad and rejects its violations", () => {
    expect(validBear(P(10, 105, 1), P(20, 79, -1), P(30, 111, 1), P(40, 84, -1))).toBe(true);
    expect(validBear(P(10, 105, 1), P(20, 79, -1), P(30, 111, 1), P(55, 84, -1))).toBe(false);
  });
});

describe("wolfeLux zigzag (Pine left=L, right=1)", () => {
  it("finds the textbook A,B,C,D pivots in order", () => {
    const b = bullBars();
    const piv = zigzag(b, 3);
    const idx = piv.map((p) => p.i);
    expect(idx).toContain(10);
    expect(idx).toContain(20);
    expect(idx).toContain(30);
    expect(idx).toContain(40);
    const at = (k: number) => piv.find((p) => p.i === k)!;
    expect(at(10).dir).toBe(-1);
    expect(at(20).dir).toBe(1);
    expect(at(30).dir).toBe(-1);
    expect(at(40).dir).toBe(1);
  });
});

describe("wolfeLux entry (break + zone-end close-back)", () => {
  it("fires long exactly on the completion bars 58 and 59", () => {
    const b = bullBars();
    expect(entryAt(b, 57, "bull")).toBeNull();
    const p58 = entryAt(b, 58, "bull");
    expect(p58).not.toBeNull();
    expect(p58!.A.i).toBe(10);
    expect(p58!.D.i).toBe(40);
    expect(p58!.breakIdx).toBeGreaterThanOrEqual(43);
    expect(p58!.breakPrc).toBeLessThan(89); // undercut below C
    expect(entryAt(b, 59, "bull")).not.toBeNull();
    expect(entryAt(b, 60, "bull")).toBeNull(); // grace window closed
  });
  it("fires the mirrored bear on inverted bars", () => {
    const bull = bullBars();
    const N = bull.c.length;
    const b: B = {
      o: bull.o.map((v) => 200 - v), h: bull.l.map((v) => 200 - v),
      l: bull.h.map((v) => 200 - v), c: bull.c.map((v) => 200 - v),
    };
    expect(entryAt(b, 58, "bear")).not.toBeNull();
    expect(entryAt(b, 58, "bull")).toBeNull();
    void N;
  });
  it("never fires on a trend with no converging structure", () => {
    const N = 80;
    const c = Array.from({ length: N }, (_, k) => 100 + k * 0.5);
    const b: B = { o: [...c], h: c.map((v) => v + 0.2), l: c.map((v) => v - 0.2), c: [...c] };
    expect(completedPatterns(b, { num: 20 })).toEqual([]);
    expect(entryAt(b, 79, "bull", { num: 20 })).toBeNull();
  });
  it("rejects the OLD approximation shape (higher-low p5, no flush)", () => {
    // Five alternating pivots where p5 sits ABOVE p3 and price never breaks
    // the 1-3 line: exactly what the old code traded. The Lux port must not.
    const N = 60;
    const o = new Array(N).fill(0), h = new Array(N).fill(0), l = new Array(N).fill(0), c = new Array(N).fill(0);
    const set = (k: number, cc: number) => { o[k] = cc - 0.1; h[k] = cc + 0.5; l[k] = cc - 1.5; c[k] = cc; };
    for (let k = 0; k <= 8; k++) set(k, 98);
    set(9, 97); l[9] = 95; // A
    for (let k = 10; k <= 18; k++) set(k, 97 + (k - 10) * 1.5);
    set(19, 112); h[19] = 113; // B
    for (let k = 20; k <= 28; k++) set(k, 112 - (k - 20) * 1.2);
    set(29, 100); l[29] = 99; // C (above A)
    for (let k = 30; k <= 38; k++) set(k, 100 + (k - 30) * 0.8);
    set(39, 107); h[39] = 108; // D (below B)
    for (let k = 40; k <= 49; k++) set(k, 107 - (k - 40) * 0.4); // shallow dip, never breaks 1-3
    set(50, 102); l[50] = 101.5; // p5 ABOVE C
    for (let k = 51; k < N; k++) set(k, 102 + (k - 51) * 0.5); // reclaim above the line
    const b: B = { o, h, l, c };
    expect(entryAt(b, 55, "bull", { num: 20 })).toBeNull();
    expect(entryAt(b, 58, "bull", { num: 20 })).toBeNull();
  });
});

describe("wolfeLux target and stop", () => {
  it("EPA runs from A through D and the touch rule matches Pine", () => {
    const b = bullBars();
    const p = entryAt(b, 58, "bull")!;
    expect(epaValue(p, p.A.i)).toBeCloseTo(p.A.px, 6);
    expect(epaValue(p, p.D.i)).toBeCloseTo(p.D.px, 6);
    expect(epaValue(p, 58)).toBeGreaterThan(b.c[58]); // sloping target above entry
    // stop sits beyond the point-5 extreme
    expect(stopDist(p, "bull", b.c[58])).toBeCloseTo(b.c[58] - p.breakPrc, 6);
    expect(stopDist(p, "bull", p.breakPrc - 1)).toBeUndefined(); // extreme on wrong side
  });
  it("exit fires when price rallies into the EPA line", () => {
    const b = bullBars();
    const p = entryAt(b, 58, "bull")!;
    // extend the series with a rally through the (rising) EPA line: each
    // appended bar's EPA value is evaluated at its own index, like Pine.
    const push = (cc: number, hh: number, ll: number) => { b.o.push(cc - 0.1); b.h.push(hh); b.l.push(ll); b.c.push(cc); };
    let j = b.c.length;
    let e = epaValue(p, j);
    push(e - 3, e - 1, e - 4); // approaching from below
    j = b.c.length;
    e = epaValue(p, j);
    push(e - 0.5, e + 2, e - 1); // extreme crosses the line
    j = b.c.length - 1;
    expect(epaTouchAt(b, j, p)).toBe(true);
  });
});
