// WOLFE-LUX — faithful port of LuxAlgo's Wolfe Wave Detector (Pine v6)
// decision logic: multi-length zigzag, margin/angle symmetry validation,
// 1-3 break + close-back confirmation, 1-4 EPA target, sweet-zone stop.
//
// Lineage: indicator `wolfe-wave-detector` + concept `wolfe-waves` from the
// LuxAlgo Library MCP server (https://mcp.luxalgo.com/mcp). Pine's drawing,
// dashboard, progression-display and input plumbing are NOT ported (chart
// concerns); every trading decision is ported 1:1 and cited below.
//
// PURE: no I/O, no clock, no node imports — safe to bundle into Convex
// actions and the backtest engine alike.
//
// Pine variable map (their UDT `piv`: d=direction, x=bar index, y=price):
//   A,B,C,D = points 1..4 (newest pivot is D). Point 5 is NOT a pivot — it
//   is the break of the A-C (1-3) line, tracked as breakIdx/breakPrc.
//   EPA line = A->D extended (their dashed ln8). Entry = zone-end close
//   back inside the A-C line after a recorded break.

export const WOLFE_LUX_MARGIN = 0.7; // Pine `margin` default 70/100
export const WOLFE_LUX_ANGLE = 0.7; // Pine `angle` default 70/100
export const WOLFE_LUX_STT = 2; // Pine `Minimum` swing length
export const WOLFE_LUX_NUM = 100; // Pine `Maximum` swing length
export const WOLFE_LUX_KILL_BARS = 400; // Pine `sf_a > 400 or sf_b > 400` kill
export const WOLFE_LUX_RIGHT = 1; // Pine zigzag call passes right = 1

export type LuxPiv = { i: number; px: number; dir: 1 | -1 };

export type LuxPattern = {
  dir: "bull" | "bear";
  A: LuxPiv;
  B: LuxPiv;
  C: LuxPiv;
  D: LuxPiv;
  length: number;
  x1: number; // wave-5 zone start (bar index, Pine math.round)
  x2: number; // wave-5 zone end (bar index)
  breakIdx: number; // point 5: bar of the deepest 1-3 break extreme
  breakPrc: number; // point 5: extreme price (low for bull, high for bear)
  endBar: number; // completion bar == x2
};

export type BarsLike = {
  o: number[];
  h: number[];
  l: number[];
  c: number[];
};

/** A-C (1-3) line value at bar k. Pine ln0 extended by slope0. */
export function lineAC(A: LuxPiv, C: LuxPiv, k: number): number {
  const slope0 = (C.px - A.px) / (C.i - A.i);
  return A.px + slope0 * (k - A.i);
}

/** B-D line value at bar k. Pine ln1 extended by slope1. */
export function lineBD(B: LuxPiv, D: LuxPiv, k: number): number {
  const slope1 = (D.px - B.px) / (D.i - B.i);
  return B.px + slope1 * (k - B.i);
}

/** EPA (1-4) line value at bar k. Pine dashed ln8 from A through D. */
export function epaValue(p: LuxPattern, k: number): number {
  return p.A.px + ((p.D.px - p.A.px) / (p.D.i - p.A.i)) * (k - p.A.i);
}

/**
 * Per-length zigzag. Pine `zigzag(index, left, right)` with right = 1:
 * pivot high at k confirmed at k+1, strict extremes (matches ta.pivothigh
 * no-tie behaviour and our own swings() convention), alternating with
 * same-direction extreme updates (their in_out / dr_ branches).
 */
export function zigzag(b: BarsLike, L: number): LuxPiv[] {
  const n = b.c.length;
  const out: LuxPiv[] = [];
  if (L < 1 || n < L + 2) return out;
  const push = (dir: 1 | -1, k: number, px: number) => {
    const last = out[out.length - 1];
    if (!last) {
      out.push({ i: k, px, dir });
      return;
    }
    if (dir === 1) {
      if (last.dir < 1) out.push({ i: k, px, dir });
      else if (px > last.px) {
        last.i = k;
        last.px = px;
      }
    } else {
      if (last.dir > -1) out.push({ i: k, px, dir });
      else if (px < last.px) {
        last.i = k;
        last.px = px;
      }
    }
  };
  for (let k = L; k <= n - 2; k++) {
    let ph = true;
    for (let j = k - L; j <= k + 1; j++) {
      if (j === k) continue;
      if (b.h[j] > b.h[k]) {
        ph = false;
        break;
      }
    }
    let pl = true;
    for (let j = k - L; j <= k + 1; j++) {
      if (j === k) continue;
      if (b.l[j] < b.l[k]) {
        pl = false;
        break;
      }
    }
    // Pine evaluates ph first, then pl — same order here.
    if (ph) push(1, k, b.h[k]);
    if (pl) push(-1, k, b.l[k]);
  }
  return out;
}

/** Pine bull validation: time symmetry, price structure, angle symmetry. */
export function validBull(A: LuxPiv, B: LuxPiv, C: LuxPiv, D: LuxPiv, margin = WOLFE_LUX_MARGIN, angle = WOLFE_LUX_ANGLE): boolean {
  const Ax = A.i, Ay = A.px, Bx = B.i, By = B.px, Cx = C.i, Cy = C.px, Dx = D.i, Dy = D.px;
  if (D.dir !== 1 || C.dir !== -1 || B.dir !== 1 || A.dir !== -1) return false;
  const leg1 = Bx - Ax, leg2 = Dx - Cx;
  if (!(leg1 > 0 && leg2 > 0)) return false;
  if (Math.max(leg1, leg2) / Math.min(leg1, leg2) - 1 > margin) return false;
  if (!(Dy > Cy && Cy < Ay)) return false;
  if (Cx === Dx || Cx === Ax) return false;
  const slope0 = (Cy - Ay) / (Cx - Ax);
  // Exact Pine form (sign-preserving): By + slope0*(1±angle)*(Dx-Bx).
  const hi = By + slope0 * (1 + angle) * (Dx - Bx);
  const lo = By + slope0 * (1 - angle) * (Dx - Bx);
  if (!(Dy >= Math.min(lo, hi) && Dy <= Math.max(lo, hi))) return false;
  return true;
}

/** Pine bear validation (mirror). */
export function validBear(A: LuxPiv, B: LuxPiv, C: LuxPiv, D: LuxPiv, margin = WOLFE_LUX_MARGIN, angle = WOLFE_LUX_ANGLE): boolean {
  const Ax = A.i, Ay = A.px, Bx = B.i, By = B.px, Cx = C.i, Cy = C.px, Dx = D.i, Dy = D.px;
  if (D.dir !== -1 || C.dir !== 1 || B.dir !== -1 || A.dir !== 1) return false;
  const leg1 = Bx - Ax, leg2 = Dx - Cx;
  if (!(leg1 > 0 && leg2 > 0)) return false;
  if (Math.max(leg1, leg2) / Math.min(leg1, leg2) - 1 > margin) return false;
  if (!(Dy < Cy && Cy > Ay)) return false;
  if (Cx === Dx || Cx === Ax) return false;
  const slope0 = (Cy - Ay) / (Cx - Ax);
  const hi = By + slope0 * (1 + angle) * (Dx - Bx);
  const lo = By + slope0 * (1 - angle) * (Dx - Bx);
  if (!(Dy >= Math.min(lo, hi) && Dy <= Math.max(lo, hi))) return false;
  return true;
}

/** Wave-5 zone. Pine: x1 = Dx + (Cx-Bx)*(1-margin), x2 = Dx + (Cx-Bx)*(1+margin). */
export function waveZone(D: LuxPiv, B: LuxPiv, C: LuxPiv, margin = WOLFE_LUX_MARGIN): { x1: number; x2: number } {
  const span = C.i - B.i;
  return { x1: Math.round(D.i + span * (1 - margin)), x2: Math.round(D.i + span * (1 + margin)) };
}

type Quad = { A: LuxPiv; B: LuxPiv; C: LuxPiv; D: LuxPiv; length: number };

/**
 * Full lifecycle for one validated quad, recomputed purely from bars
 * (Pine tracks it as a stateful `drawing`; same transitions):
 *  - before the zone: any close outside [A-C, B-D] kills it (their clean())
 *  - inside the zone: wrong-side close kills it; 1-3 break records point 5
 *  - completion at zone end (bars x2+1, x2+2): needs a recorded break AND
 *    close back inside the A-C line, else dead.
 * Returns the completed pattern or null.
 */
export function completeQuad(b: BarsLike, q: Quad, margin = WOLFE_LUX_MARGIN): LuxPattern | null {
  const { A, B, C, D, length } = q;
  const dir: "bull" | "bear" = D.dir === 1 ? "bull" : "bear";
  if (C.i - B.i <= 0) return null;
  const { x1, x2 } = waveZone(D, B, C, margin);
  const n = b.c.length;
  if (x2 - x1 <= 0 || x1 > n + 500 || x2 > n + 500) return null; // Pine x-far guard
  let breakIdx = -1;
  let breakPrc = dir === "bull" ? Infinity : -Infinity;
  const end = Math.min(x2, n - 1);
  for (let k = D.i + 1; k <= end; k++) {
    const v0 = lineAC(A, C, k);
    const v1 = lineBD(B, D, k);
    if (k < x1) {
      if (dir === "bull" ? b.c[k] < v0 || b.c[k] > v1 : b.c[k] > v0 || b.c[k] < v1) return null;
    } else {
      if (dir === "bull" ? b.c[k] > v1 : b.c[k] < v1) return null;
      if (dir === "bull" ? b.c[k] < v0 : b.c[k] > v0) {
        if (dir === "bull" ? b.l[k] < breakPrc : b.h[k] > breakPrc) {
          breakPrc = dir === "bull" ? b.l[k] : b.h[k];
          breakIdx = k;
        }
      }
    }
  }
  if (breakIdx < 0) return null;
  return { dir, A, B, C, D, length, x1, x2, breakIdx, breakPrc, endBar: x2 };
}

// Registry of completed patterns per bar series (built once, memoized).
const registry = new WeakMap<object, LuxPattern[]>();

export function completedPatterns(
  b: BarsLike,
  opts?: { stt?: number; num?: number; margin?: number; angle?: number },
): LuxPattern[] {
  const key = b as object;
  const hit = registry.get(key);
  if (hit) return hit;
  const stt = opts?.stt ?? WOLFE_LUX_STT;
  const num = opts?.num ?? WOLFE_LUX_NUM;
  const margin = opts?.margin ?? WOLFE_LUX_MARGIN;
  const angle = opts?.angle ?? WOLFE_LUX_ANGLE;
  const out: LuxPattern[] = [];
  const seen = new Set<string>();
  const n = b.c.length;
  for (let L = stt; L <= Math.min(num, n - 2); L++) {
    const piv = zigzag(b, L);
    for (let e = 3; e < piv.length; e++) {
      const A = piv[e - 3]!, B = piv[e - 2]!, C = piv[e - 1]!, D = piv[e]!;
      const key2 = `${A.i},${B.i},${C.i},${D.i}`;
      if (seen.has(key2)) continue;
      seen.add(key2);
      const bull = D.dir === 1 && validBull(A, B, C, D, margin, angle);
      const bear = D.dir === -1 && validBear(A, B, C, D, margin, angle);
      if (!bull && !bear) continue;
      const done = completeQuad(b, { A, B, C, D, length: L }, margin);
      if (done) out.push(done);
    }
  }
  out.sort((a, b2) => a.endBar - b2.endBar);
  registry.set(key, out);
  return out;
}

/**
 * Entry signal at bar i: a pattern completed at x2 with i == x2+1 or
 * x2+2 (Pine `n-1 == last or n-2 == last`) and close back inside the A-C
 * line on bar i itself.
 */
export function entryAt(b: BarsLike, i: number, dir: "bull" | "bear", opts?: { stt?: number; num?: number }): LuxPattern | null {
  for (const p of completedPatterns(b, opts)) {
    if (p.dir !== dir || i < p.endBar + 1 || i > p.endBar + 2) continue;
    const v0 = lineAC(p.A, p.C, i);
    if (dir === "bull" ? b.c[i] >= v0 : b.c[i] <= v0) return p;
  }
  return null;
}

/**
 * EPA touch at bar i (exit). Pine hit test: prior close on one side,
 * extreme crosses the dashed EPA line.
 */
export function epaTouchAt(b: BarsLike, i: number, p: LuxPattern): boolean {
  if (p.D.i === p.A.i || i < 1) return false;
  const e = epaValue(p, i);
  if (!Number.isFinite(e)) return false;
  if (p.dir === "bull") return b.c[i - 1] < e && b.h[i] > e;
  return b.c[i - 1] > e && b.l[i] < e;
}

/** Latest completed pattern of `dir` with endBar <= i (for exits/stops). */
export function latestCompleted(b: BarsLike, i: number, dir: "bull" | "bear", opts?: { stt?: number; num?: number }): LuxPattern | null {
  const all = completedPatterns(b, opts);
  for (let k = all.length - 1; k >= 0; k--) {
    const p = all[k]!;
    if (p.dir === dir && p.endBar <= i) return p;
  }
  return null;
}

/**
 * Sweet-zone stop distance from entry. Stop sits beyond the point-5
 * extreme (Pine premise: wave 5 is a terminal overshoot). Returns
 * undefined when the extreme is on the wrong side of entry (engine and
 * live book fall back to the ATR stop).
 */
export function stopDist(p: LuxPattern, dir: "bull" | "bear", entryPx: number): number | undefined {
  const d = dir === "bull" ? entryPx - p.breakPrc : p.breakPrc - entryPx;
  return d > 0 && Number.isFinite(d) ? d : undefined;
}
