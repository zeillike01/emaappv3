// Strategy definitions batch 3: Harmonics (8), Patterns (14), Levels (6),
// Time&Seasonality (1), Risk&Exits (4). Chart/harmonic detectors are
// pivot-based approximations — documented in METHOD_NOTES.md.
import type { Bars } from "./indicators";
import { pivots } from "./indicators";
import type { Cache, StratDef } from "./engine";
import { bosUp, bosDn } from "./strategies2";
import * as WL from "./wolfeLux";
type B = Bars; type C = Cache;
const F = (v: number) => Number.isFinite(v) && !Number.isNaN(v);
const D = (slug: string, family: string, direction: "Long" | "Short" | "Both", p: Partial<StratDef>): StratDef => ({
  slug, family, direction,
  long: () => false, short: () => false, exitLong: () => false, exitShort: () => false,
  stopAtrs: 1.5, targetR: 2, timeExit: 0, alwaysIn: false, ...p,
});
const crossUp = (a: number[], b: number[], i: number) => F(a[i]) && F(a[i - 1]) && F(b[i]) && F(b[i - 1]) && a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossDn = (a: number[], b: number[], i: number) => F(a[i]) && F(a[i - 1]) && F(b[i]) && F(b[i - 1]) && a[i - 1] >= b[i - 1] && a[i] < b[i];
// last 5 alternating fractal pivots (most recent last): [{i, px, dir}]
type Piv = { i: number; px: number; dir: 1 | -1 };
export function lastPivots(b: B, c: C, i: number, n = 5): Piv[] {
  const out: Piv[] = [];
  for (let k = i; k > Math.max(0, i - 120) && out.length < n; k--) {
    if (c.swHi[k] === 1) out.unshift({ i: k, px: b.h[k], dir: 1 });
    else if (c.swLo[k] === 1) out.unshift({ i: k, px: b.l[k], dir: -1 });
  }
  return out;
}
const near = (v: number, t: number, tol: number) => Math.abs(v - t) <= tol;
// Generic harmonic matcher on last 5 pivots [X,A,B,C,D]; tol in ratio units.
function harmonic(b: B, c: C, i: number, want: "bull" | "bear",
  bR: [number, number], dR: [number, number], cR?: [number, number]): boolean {
  const p = lastPivots(b, c, i, 5);
  if (p.length < 5) return false;
  const [X, A, Bc, Cc, Dc] = p;
  if (want === "bull") {
    if (!(X.dir === -1 && A.dir === 1 && Bc.dir === -1 && Cc.dir === 1 && Dc.dir === -1)) return false;
  } else {
    if (!(X.dir === 1 && A.dir === -1 && Bc.dir === 1 && Cc.dir === -1 && Dc.dir === 1)) return false;
  }
  const xa = Math.abs(A.px - X.px); if (xa <= 0) return false;
  const br = Math.abs(Bc.px - A.px) / xa;
  const dr = Math.abs(Dc.px - A.px) / xa;
  if (br < bR[0] || br > bR[1] || dr < dR[0] || dr > dR[1]) return false;
  if (cR) {
    const xc = Math.abs(Cc.px - Bc.px); if (xc <= 0) return false;
    const cr = Math.abs(Dc.px - Cc.px) / xc;
    if (cr < cR[0] || cr > cR[1]) return false;
  }
  // confirmation: close back in reversal direction
  if (want === "bull") return b.c[i] > b.o[i] && b.c[i] > Dc.px;
  return b.c[i] < b.o[i] && b.c[i] < Dc.px;
}
// candle helpers
const bull = (b: B, i: number) => b.c[i] > b.o[i];
const bear = (b: B, i: number) => b.c[i] < b.o[i];
const body = (b: B, i: number) => Math.abs(b.c[i] - b.o[i]);
const rng = (b: B, i: number) => b.h[i] - b.l[i];

export const S3: StratDef[] = [
  D("gartley", "elliott-harmonics", "Both", {
    long: (b, i, c) => harmonic(b, c, i, "bull", [0.55, 0.68], [0.72, 0.86]),
    short: (b, i, c) => harmonic(b, c, i, "bear", [0.55, 0.68], [0.72, 0.86]),
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("bat", "elliott-harmonics", "Both", {
    long: (b, i, c) => harmonic(b, c, i, "bull", [0.32, 0.56], [0.82, 0.95]),
    short: (b, i, c) => harmonic(b, c, i, "bear", [0.32, 0.56], [0.82, 0.95]),
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("butterfly", "elliott-harmonics", "Both", {
    long: (b, i, c) => harmonic(b, c, i, "bull", [0.72, 0.86], [1.21, 1.68]),
    short: (b, i, c) => harmonic(b, c, i, "bear", [0.72, 0.86], [1.21, 1.68]),
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("crab", "elliott-harmonics", "Both", {
    long: (b, i, c) => harmonic(b, c, i, "bull", [0.32, 0.68], [1.55, 1.7]),
    short: (b, i, c) => harmonic(b, c, i, "bear", [0.32, 0.68], [1.55, 1.7]),
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("cypher", "elliott-harmonics", "Both", {
    long: (b, i, c) => harmonic(b, c, i, "bull", [0.32, 0.68], [0.72, 0.86], [1.21, 1.47]),
    short: (b, i, c) => harmonic(b, c, i, "bear", [0.32, 0.68], [0.72, 0.86], [1.21, 1.47]),
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("shark", "elliott-harmonics", "Both", {
    long: (b, i, c) => harmonic(b, c, i, "bull", [0.3, 1.1], [0.82, 1.2]),
    short: (b, i, c) => harmonic(b, c, i, "bear", [0.3, 1.1], [0.82, 1.2]),
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("abcd", "elliott-harmonics", "Both", {
    long: (b, i, c) => {
      const p = lastPivots(b, c, i, 4);
      if (p.length < 4) return false;
      const [A, Bc, Cc, Dc] = p;
      if (!(A.dir === 1 && Bc.dir === -1 && Cc.dir === 1 && Dc.dir === -1)) return false;
      const ab = A.px - Bc.px, cd = Cc.px - Dc.px;
      if (ab <= 0 || cd <= 0) return false;
      const bc = Cc.px - Bc.px;
      const retr = bc / ab;
      return retr > 0.35 && retr < 0.95 && near(cd / ab, 1, 0.25) && bull(b, i);
    },
    short: (b, i, c) => {
      const p = lastPivots(b, c, i, 4);
      if (p.length < 4) return false;
      const [A, Bc, Cc, Dc] = p;
      if (!(A.dir === -1 && Bc.dir === 1 && Cc.dir === -1 && Dc.dir === 1)) return false;
      const ab = Bc.px - A.px, cd = Dc.px - Cc.px;
      if (ab <= 0 || cd <= 0) return false;
      const bc = Bc.px - Cc.px;
      const retr = bc / ab;
      return retr > 0.35 && retr < 0.95 && near(cd / ab, 1, 0.25) && bear(b, i);
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("potential-reversal-zone", "elliott-harmonics", "Both", {
    long: (b, i, c) => {
      // 62-79% retrace of last 40-bar swing + rejection candle
      let hi = -Infinity, hx = 0, lo = Infinity, lx = 0;
      for (let k = i - 40; k < i; k++) { if (b.h[k] > hi) { hi = b.h[k]; hx = k; } if (b.l[k] < lo) { lo = b.l[k]; lx = k; } }
      if (!(lx > hx) || hi - lo <= 0) return false;
      const r62 = hi - 0.62 * (hi - lo), r79 = hi - 0.79 * (hi - lo);
      return b.l[i] <= r62 && b.l[i] >= r79 && bull(b, i) && rng(b, i) > body(b, i) * 2;
    },
    short: (b, i, c) => {
      let hi = -Infinity, hx = 0, lo = Infinity, lx = 0;
      for (let k = i - 40; k < i; k++) { if (b.h[k] > hi) { hi = b.h[k]; hx = k; } if (b.l[k] < lo) { lo = b.l[k]; lx = k; } }
      if (!(hx > lx) || hi - lo <= 0) return false;
      const r62 = lo + 0.62 * (hi - lo), r79 = lo + 0.79 * (hi - lo);
      return b.h[i] >= r62 && b.h[i] <= r79 && bear(b, i) && rng(b, i) > body(b, i) * 2;
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  // ---- Patterns ----
  D("bull-bear-flag", "patterns", "Both", {
    long: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      const pole = b.c[i - 6] - b.c[i - 11];
      if (pole < 2 * c.atr14[i]) return false;
      let mx = -Infinity, mn = Infinity;
      for (let k = i - 5; k <= i; k++) { mx = Math.max(mx, b.h[k]); mn = Math.min(mn, b.l[k]); }
      if (mx - mn > c.atr14[i]) return false;
      return F(c.dc20u[i - 1]) && b.c[i] > c.dc20u[i - 1];
    },
    short: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      const pole = b.c[i - 11] - b.c[i - 6];
      if (pole < 2 * c.atr14[i]) return false;
      let mx = -Infinity, mn = Infinity;
      for (let k = i - 5; k <= i; k++) { mx = Math.max(mx, b.h[k]); mn = Math.min(mn, b.l[k]); }
      if (mx - mn > c.atr14[i]) return false;
      return F(c.dc20l[i - 1]) && b.c[i] < c.dc20l[i - 1];
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("head-and-shoulders", "patterns", "Short", {
    long: () => false,
    short: (b, i, c) => {
      const p = lastPivots(b, c, i, 5);
      if (p.length < 5) return false;
      const [L, H1, Hd, H2, R] = p;
      if (!(L.dir === -1 && H1.dir === 1 && Hd.dir === -1 && H2.dir === 1 && R.dir === -1)) {
        // allow neckline pivot polarity variants: need 3 highs with middle tallest
        const q = lastPivots(b, c, i, 3).filter((x) => x.dir === 1);
        if (q.length < 3) return false;
        const [s1, h, s2] = q.slice(-3);
        if (!(h.px > s1.px && h.px > s2.px && near(s1.px, s2.px, (h.px - Math.min(s1.px, s2.px)) * 0.15))) return false;
        const neck = Math.min(s1.px, s2.px) - (h.px - Math.min(s1.px, s2.px)) * 0.0;
        void L; void H1; void Hd; void H2; void R;
        return b.c[i] < neck && bear(b, i);
      }
      if (!(H1.px < Hd.px && H2.px < Hd.px && near(H1.px, H2.px, (Hd.px - Math.min(H1.px, H2.px)) * 0.2))) return false;
      const neck = Math.min(L.px, R.px);
      return b.c[i] < neck && bear(b, i);
    },
    exitLong: () => false,
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("inverse-head-and-shoulders", "patterns", "Long", {
    long: (b, i, c) => {
      const q = lastPivots(b, c, i, 5).filter((x) => x.dir === -1);
      if (q.length < 3) return false;
      const [s1, h, s2] = q.slice(-3);
      if (!(h.px < s1.px && h.px < s2.px && near(s1.px, s2.px, (Math.max(s1.px, s2.px) - h.px) * 0.2))) return false;
      const neck = Math.max(s1.px, s2.px);
      return b.c[i] > neck && bull(b, i);
    },
    short: () => false,
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: () => false,
    stopAtrs: 1, targetR: 2,
  }),
  D("double-top-bottom", "patterns", "Both", {
    long: (b, i, c) => {
      const q = lastPivots(b, c, i, 4).filter((x) => x.dir === -1);
      if (q.length < 2) return false;
      const [t1, t2] = q.slice(-2);
      if (!near(t1.px, t2.px, t1.px * 0.01)) return false;
      let neck = Infinity;
      for (let k = t1.i; k <= t2.i; k++) neck = Math.min(neck, b.h[k]);
      void neck;
      // neckline = highest high between troughs; enter on break above it
      let nl = -Infinity;
      for (let k = t1.i; k <= t2.i; k++) nl = Math.max(nl, b.h[k]);
      return b.c[i] > nl && bull(b, i);
    },
    short: (b, i, c) => {
      const q = lastPivots(b, c, i, 4).filter((x) => x.dir === 1);
      if (q.length < 2) return false;
      const [t1, t2] = q.slice(-2);
      if (!near(t1.px, t2.px, t1.px * 0.01)) return false;
      let nl = Infinity;
      for (let k = t1.i; k <= t2.i; k++) nl = Math.min(nl, b.l[k]);
      return b.c[i] < nl && bear(b, i);
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("cup-and-handle", "patterns", "Long", {
    long: (b, i, c) => {
      if (!F(c.dc20u[i - 1])) return false;
      let hi = -Infinity, hx = 0;
      for (let k = i - 60; k < i - 5; k++) if (b.h[k] > hi) { hi = b.h[k]; hx = k; }
      if (hx <= i - 60) return false;
      let lo = Infinity;
      for (let k = hx; k < i - 3; k++) lo = Math.min(lo, b.l[k]);
      const depth = (hi - lo) / hi;
      if (depth < 0.05 || depth > 0.5) return false;
      return b.c[i] > hi && bull(b, i);
    },
    short: () => false,
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: () => false,
    stopAtrs: 1.5, targetR: 2,
  }),
  D("rising-falling-wedge", "patterns", "Both", {
    long: (b, i, c) => {
      // falling wedge: lower highs + lower lows converging, break up
      const hs = lastPivots(b, c, i, 6).filter((x) => x.dir === 1).slice(-2);
      const ls = lastPivots(b, c, i, 6).filter((x) => x.dir === -1).slice(-2);
      if (hs.length < 2 || ls.length < 2) return false;
      if (!(hs[1].px < hs[0].px && ls[1].px < ls[0].px)) return false;
      const w0 = hs[0].px - ls[0].px, w1 = hs[1].px - ls[1].px;
      if (!(w1 < w0 * 0.9)) return false;
      return b.c[i] > hs[1].px && bull(b, i);
    },
    short: (b, i, c) => {
      const hs = lastPivots(b, c, i, 6).filter((x) => x.dir === 1).slice(-2);
      const ls = lastPivots(b, c, i, 6).filter((x) => x.dir === -1).slice(-2);
      if (hs.length < 2 || ls.length < 2) return false;
      if (!(hs[1].px > hs[0].px && ls[1].px > ls[0].px)) return false;
      const w0 = hs[0].px - ls[0].px, w1 = hs[1].px - ls[1].px;
      if (!(w1 < w0 * 0.9)) return false;
      return b.c[i] < ls[1].px && bear(b, i);
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("evening-star", "patterns", "Short", {
    long: () => false,
    short: (b, i, c) => {
      if (i < 3 || !F(c.atr14[i])) return false;
      const b1 = i - 2, b2 = i - 1, b3 = i;
      return bull(b, b1) && body(b, b1) > c.atr14[i] * 0.5 &&
        body(b, b2) < body(b, b1) * 0.4 && b.o[b2] > b.c[b1] &&
        bear(b, b3) && b.c[b3] < (b.o[b1] + b.c[b1]) / 2;
    },
    exitLong: () => false,
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("morning-star", "patterns", "Long", {
    long: (b, i, c) => {
      if (i < 3 || !F(c.atr14[i])) return false;
      const b1 = i - 2, b2 = i - 1, b3 = i;
      return bear(b, b1) && body(b, b1) > c.atr14[i] * 0.5 &&
        body(b, b2) < body(b, b1) * 0.4 && b.o[b2] < b.c[b1] &&
        bull(b, b3) && b.c[b3] > (b.o[b1] + b.c[b1]) / 2;
    },
    short: () => false,
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: () => false,
    stopAtrs: 1, targetR: 2,
  }),
  D("bullish-bearish-engulfing", "patterns", "Both", {
    long: (b, i, c) => bear(b, i - 1) && bull(b, i) && b.o[i] <= b.c[i - 1] && b.c[i] >= b.o[i - 1] && body(b, i) > body(b, i - 1),
    short: (b, i, c) => bull(b, i - 1) && bear(b, i) && b.o[i] >= b.c[i - 1] && b.c[i] <= b.o[i - 1] && body(b, i) > body(b, i - 1),
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("pin-bar", "patterns", "Both", {
    long: (b, i, c) => {
      if (!F(c.atr14[i]) || rng(b, i) < 0.5 * c.atr14[i]) return false;
      const wick = Math.min(b.o[i], b.c[i]) - b.l[i];
      const upw = b.h[i] - Math.max(b.o[i], b.c[i]);
      return wick > 2 * body(b, i) && wick > 2 * upw && bull(b, i);
    },
    short: (b, i, c) => {
      if (!F(c.atr14[i]) || rng(b, i) < 0.5 * c.atr14[i]) return false;
      const upw = b.h[i] - Math.max(b.o[i], b.c[i]);
      const wick = Math.min(b.o[i], b.c[i]) - b.l[i];
      return upw > 2 * body(b, i) && upw > 2 * wick && bear(b, i);
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("inside-bar", "patterns", "Both", {
    long: (b, i, c) => b.h[i - 1] < b.h[i - 2] && b.l[i - 1] > b.l[i - 2] && b.c[i] > b.h[i - 1],
    short: (b, i, c) => b.h[i - 1] < b.h[i - 2] && b.l[i - 1] > b.l[i - 2] && b.c[i] < b.l[i - 1],
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("hikkake", "patterns", "Both", {
    long: (b, i, c) => {
      // inside bar, failed downside break, break back up
      if (!(b.h[i - 2] < b.h[i - 3] && b.l[i - 2] > b.l[i - 3])) return false;
      const faked = b.l[i - 1] < b.l[i - 2] && b.c[i - 1] > b.l[i - 2];
      return faked && b.c[i] > b.h[i - 2] && bull(b, i);
    },
    short: (b, i, c) => {
      if (!(b.h[i - 2] < b.h[i - 3] && b.l[i - 2] > b.l[i - 3])) return false;
      const faked = b.h[i - 1] > b.h[i - 2] && b.c[i - 1] < b.h[i - 2];
      return faked && b.c[i] < b.l[i - 2] && bear(b, i);
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("gap-and-go", "patterns", "Both", {
    long: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      const gap = b.o[i] - b.h[i - 1];
      return gap > 0.5 * c.atr14[i] && bull(b, i);
    },
    short: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      const gap = b.l[i - 1] - b.o[i];
      return gap > 0.5 * c.atr14[i] && bear(b, i);
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("wolfe-waves", "patterns", "Both", {
    // Faithful LuxAlgo Wolfe Wave Detector port (see wolfeLux.ts): multi-
    // length zigzag, margin/angle symmetry, 1-3 break + close-back entry,
    // 1-4 EPA touch exits, sweet-zone-extreme stop via stopFn.
    // targetR 99 = runner (EPA is the objective); timeExit 400 = Pine's
    // sf>400 pattern-kill horizon as a market-close proxy (documented
    // assumption — the Detector itself holds to the EPA touch).
    long: (b, i) => WL.entryAt(b, i, "bull") != null,
    short: (b, i) => WL.entryAt(b, i, "bear") != null,
    exitLong: (b, i) => {
      const p = WL.latestCompleted(b, i, "bull");
      return p != null && i > p.endBar + 2 && WL.epaTouchAt(b, i, p);
    },
    exitShort: (b, i) => {
      const p = WL.latestCompleted(b, i, "bear");
      return p != null && i > p.endBar + 2 && WL.epaTouchAt(b, i, p);
    },
    stopAtrs: 1, targetR: 99, timeExit: 400,
    stopFn: (b, i, _c, dir, px) => {
      const p = WL.latestCompleted(b, i, dir === 1 ? "bull" : "bear");
      if (!p || i - p.endBar > 3) return undefined; // entry must follow completion
      return WL.stopDist(p, dir === 1 ? "bull" : "bear", px);
    },
  }),
  // ---- Levels ----
  D("pivot-points", "levels", "Both", {
    long: (b, i, c) => {
      const d0 = new Date(b.t[i - 1]);
      const y = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), d0.getUTCDate() - 1));
      void y;
      // prior UTC day HLC
      let h = -Infinity, l = Infinity, cl = NaN;
      const day = new Date(b.t[i]).toISOString().slice(0, 10);
      for (let k = i - 1; k > 0 && new Date(b.t[k]).toISOString().slice(0, 10) !== day; k--) {
        h = Math.max(h, b.h[k]); l = Math.min(l, b.l[k]); if (Number.isNaN(cl)) cl = b.c[k];
      }
      if (!Number.isFinite(h)) return false;
      const p = pivots(h, l, cl);
      return b.l[i] <= p.s1 * 1.001 && b.c[i] > p.s1 && bull(b, i);
    },
    short: (b, i, c) => {
      let h = -Infinity, l = Infinity, cl = NaN;
      const day = new Date(b.t[i]).toISOString().slice(0, 10);
      for (let k = i - 1; k > 0 && new Date(b.t[k]).toISOString().slice(0, 10) !== day; k--) {
        h = Math.max(h, b.h[k]); l = Math.min(l, b.l[k]); if (Number.isNaN(cl)) cl = b.c[k];
      }
      if (!Number.isFinite(h)) return false;
      const p = pivots(h, l, cl);
      return b.h[i] >= p.r1 * 0.999 && b.c[i] < p.r1 && bear(b, i);
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 99,
  }),
  D("central-pivot-range", "levels", "Both", {
    long: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      let h = -Infinity, l = Infinity, cl = NaN;
      const day = new Date(b.t[i]).toISOString().slice(0, 10);
      for (let k = i - 1; k > 0 && new Date(b.t[k]).toISOString().slice(0, 10) !== day; k--) {
        h = Math.max(h, b.h[k]); l = Math.min(l, b.l[k]); if (Number.isNaN(cl)) cl = b.c[k];
      }
      if (!Number.isFinite(h)) return false;
      const pp = (h + l + cl) / 3, tc = pp + (h - l), bc = pp - (h - l);
      const narrow = tc - bc < 0.5 * c.atr14[i];
      if (narrow) return b.c[i - 1] <= tc && b.c[i] > tc;
      return b.l[i] <= bc * 1.001 && b.c[i] > bc && bull(b, i);
    },
    short: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      let h = -Infinity, l = Infinity, cl = NaN;
      const day = new Date(b.t[i]).toISOString().slice(0, 10);
      for (let k = i - 1; k > 0 && new Date(b.t[k]).toISOString().slice(0, 10) !== day; k--) {
        h = Math.max(h, b.h[k]); l = Math.min(l, b.l[k]); if (Number.isNaN(cl)) cl = b.c[k];
      }
      if (!Number.isFinite(h)) return false;
      const pp = (h + l + cl) / 3, tc = pp + (h - l), bc = pp - (h - l);
      const narrow = tc - bc < 0.5 * c.atr14[i];
      if (narrow) return b.c[i - 1] >= bc && b.c[i] < bc;
      return b.h[i] >= tc * 0.999 && b.c[i] < tc && bear(b, i);
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("fib-retracement", "levels", "Both", {
    long: (b, i, c) => {
      if (!F(c.ema50[i]) || b.c[i] < c.ema50[i]) return false;
      let hi = -Infinity, hx = 0, lo = Infinity;
      for (let k = i - 50; k < i; k++) { if (b.h[k] > hi) { hi = b.h[k]; hx = k; } }
      for (let k = hx; k < i; k++) lo = Math.min(lo, b.l[k]);
      if (!Number.isFinite(lo) || hi - lo <= 0) return false;
      const r618 = hi - 0.618 * (hi - lo);
      return b.l[i] <= r618 && b.c[i] > r618 && bull(b, i);
    },
    short: (b, i, c) => {
      if (!F(c.ema50[i]) || b.c[i] > c.ema50[i]) return false;
      let lo = Infinity, lx = 0, hi = -Infinity;
      for (let k = i - 50; k < i; k++) { if (b.l[k] < lo) { lo = b.l[k]; lx = k; } }
      for (let k = lx; k < i; k++) hi = Math.max(hi, b.h[k]);
      if (!Number.isFinite(hi) || hi - lo <= 0) return false;
      const r618 = lo + 0.618 * (hi - lo);
      return b.h[i] >= r618 && b.c[i] < r618 && bear(b, i);
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("golden-pocket", "levels", "Both", {
    long: (b, i, c) => {
      let hi = -Infinity, hx = 0, lo = Infinity;
      for (let k = i - 50; k < i; k++) { if (b.h[k] > hi) { hi = b.h[k]; hx = k; } }
      for (let k = hx; k < i; k++) lo = Math.min(lo, b.l[k]);
      if (!Number.isFinite(lo) || hi - lo <= 0) return false;
      const g65 = hi - 0.65 * (hi - lo), g79 = hi - 0.79 * (hi - lo);
      return b.l[i] <= g65 && b.l[i] >= g79 && bull(b, i);
    },
    short: (b, i, c) => {
      let lo = Infinity, lx = 0, hi = -Infinity;
      for (let k = i - 50; k < i; k++) { if (b.l[k] < lo) { lo = b.l[k]; lx = k; } }
      for (let k = lx; k < i; k++) hi = Math.max(hi, b.h[k]);
      if (!Number.isFinite(hi) || hi - lo <= 0) return false;
      const g65 = lo + 0.65 * (hi - lo), g79 = lo + 0.79 * (hi - lo);
      return b.h[i] >= g65 && b.h[i] <= g79 && bear(b, i);
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("supply-and-demand-zones", "levels", "Both", {
    long: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      for (let k = i - 1; k > i - 20 && k > 2; k--) {
        // drop-base-rally: down, tight base, up departure
        if (bear(b, k - 2) && Math.abs(b.c[k - 1] - b.o[k - 1]) < 0.5 * c.atr14[i] &&
          bull(b, k) && b.c[k] - b.o[k] > 1.0 * c.atr14[i]) {
          const zT = Math.max(b.h[k - 1], b.o[k - 1]), zB = Math.min(b.l[k - 1], b.o[k - 1]);
          if (b.l[i] <= zT && b.l[i] >= zB - 0.1 * c.atr14[i] && bull(b, i)) return true;
          break;
        }
      }
      return false;
    },
    short: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      for (let k = i - 1; k > i - 20 && k > 2; k--) {
        if (bull(b, k - 2) && Math.abs(b.c[k - 1] - b.o[k - 1]) < 0.5 * c.atr14[i] &&
          bear(b, k) && b.o[k] - b.c[k] > 1.0 * c.atr14[i]) {
          const zT = Math.max(b.h[k - 1], b.o[k - 1]), zB = Math.min(b.l[k - 1], b.o[k - 1]);
          if (b.h[i] >= zB && b.h[i] <= zT + 0.1 * c.atr14[i] && bear(b, i)) return true;
          break;
        }
      }
      return false;
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("role-reversal", "levels", "Both", {
    long: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      for (let k = i - 1; k > i - 20 && k > 0; k--) {
        let rh = -Infinity;
        for (let m = k - 20; m < k; m++) if (m >= 0) rh = Math.max(rh, b.h[m]);
        if (b.c[k] > rh) {
          if (b.l[i] <= rh + 0.25 * c.atr14[i] && b.l[i] >= rh - 0.5 * c.atr14[i] && b.c[i] > rh && bull(b, i)) return true;
          break;
        }
      }
      return false;
    },
    short: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      for (let k = i - 1; k > i - 20 && k > 0; k--) {
        let rl = Infinity;
        for (let m = k - 20; m < k; m++) if (m >= 0) rl = Math.min(rl, b.l[m]);
        if (b.c[k] < rl) {
          if (b.h[i] >= rl - 0.25 * c.atr14[i] && b.h[i] <= rl + 0.5 * c.atr14[i] && b.c[i] < rl && bear(b, i)) return true;
          break;
        }
      }
      return false;
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  // ---- Time ----
  D("opening-range-and-orb", "time-seasonality", "Both", {
    long: (b, i, c) => {
      // 13:30-14:30 UTC opening range; trade the break during 14:30-18:00 UTC
      const hr = new Date(b.t[i]).getUTCHours() + new Date(b.t[i]).getUTCMinutes() / 60;
      if (hr < 14.5 || hr >= 18) return false;
      let rh = -Infinity, rl = Infinity, ok = false;
      for (let k = i - 1; k > 0; k--) {
        const h = new Date(b.t[k]).getUTCHours() + new Date(b.t[k]).getUTCMinutes() / 60;
        if (h < 13.5 || h >= 14.5) { if (ok) break; else continue; }
        ok = true; rh = Math.max(rh, b.h[k]); rl = Math.min(rl, b.l[k]);
      }
      if (!ok) return false;
      return b.c[i - 1] <= rh && b.c[i] > rh;
    },
    short: (b, i, c) => {
      const hr = new Date(b.t[i]).getUTCHours() + new Date(b.t[i]).getUTCMinutes() / 60;
      if (hr < 14.5 || hr >= 18) return false;
      let rh = -Infinity, rl = Infinity, ok = false;
      for (let k = i - 1; k > 0; k--) {
        const h = new Date(b.t[k]).getUTCHours() + new Date(b.t[k]).getUTCMinutes() / 60;
        if (h < 13.5 || h >= 14.5) { if (ok) break; else continue; }
        ok = true; rh = Math.max(rh, b.h[k]); rl = Math.min(rl, b.l[k]);
      }
      if (!ok) return false;
      void rh;
      return b.c[i - 1] >= rl && b.c[i] < rl;
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2, timeExit: 10,
  }),
  // ---- Risk & Exits (as overlay systems: breakout entries + the named exit) ----
  D("volatility-stop", "risk-exits", "Both", {
    long: (b, i, c) => F(c.stLine[i]) && c.stDir[i] === 1 && c.stDir[i - 1] === -1,
    short: (b, i, c) => F(c.stLine[i]) && c.stDir[i] === -1 && c.stDir[i - 1] === 1,
    exitLong: (b, i, c) => F(c.stLine[i]) && b.c[i] < c.stLine[i],
    exitShort: (b, i, c) => F(c.stLine[i]) && b.c[i] > c.stLine[i],
    stopAtrs: 3, targetR: 99, alwaysIn: true,
  }),
  D("elder-safezone-stop", "risk-exits", "Both", {
    long: (b, i, c) => F(c.dc20u[i - 1]) && b.c[i] > c.dc20u[i - 1],
    short: (b, i, c) => F(c.dc20l[i - 1]) && b.c[i] < c.dc20l[i - 1],
    exitLong: (b, i, c) => {
      let l = Infinity;
      for (let k = i - 10; k < i; k++) l = Math.min(l, b.l[k]);
      return b.c[i] < l;
    },
    exitShort: (b, i, c) => {
      let h = -Infinity;
      for (let k = i - 10; k < i; k++) h = Math.max(h, b.h[k]);
      return b.c[i] > h;
    },
    stopAtrs: 2, targetR: 99,
  }),
  D("pattern-invalidation-stop", "risk-exits", "Both", {
    long: (b, i, c) => {
      if (!F(c.dc20u[i - 1])) return false;
      return b.c[i - 1] <= c.dc20u[i - 2] && b.c[i] > c.dc20u[i - 1];
    },
    short: (b, i, c) => {
      if (!F(c.dc20l[i - 1])) return false;
      return b.c[i - 1] >= c.dc20l[i - 2] && b.c[i] < c.dc20l[i - 1];
    },
    exitLong: (b, i, c) => {
      // structural invalidation: close below last 5-bar swing low
      for (let k = i - 1; k > i - 6 && k > 0; k--) if (c.swLo[k] === 1) return b.c[i] < b.l[k];
      return false;
    },
    exitShort: (b, i, c) => {
      for (let k = i - 1; k > i - 6 && k > 0; k--) if (c.swHi[k] === 1) return b.c[i] > b.h[k];
      return false;
    },
    stopAtrs: 1, targetR: 2,
  }),
  D("stop-and-reverse", "risk-exits", "Both", {
    long: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    short: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 2, targetR: 99, alwaysIn: true,
  }),
];
