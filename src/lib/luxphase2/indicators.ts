// Indicator library for LuxAlgo Phase-2 1H backtests. All functions take
// plain number arrays (oldest->newest) and return arrays of the same length
// (leading NaN where warmup is insufficient). Wilder smoothing where the
// source specs use it (RSI, ATR, ADX).
export type Bars = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] };
export const N = (n: number, v = NaN) => new Array(n).fill(v);
export function sma(x: number[], p: number): number[] {
  const o = N(x.length); let s = 0;
  for (let i = 0; i < x.length; i++) { s += x[i]; if (i >= p) s -= x[i - p]; if (i >= p - 1) o[i] = s / p; }
  return o;
}
export function ema(x: number[], p: number): number[] {
  const o = N(x.length); const k = 2 / (p + 1); let e = NaN;
  for (let i = 0; i < x.length; i++) { e = Number.isNaN(e) ? x[i] : x[i] * k + e * (1 - k); if (i >= p - 1) o[i] = e; }
  return o;
}
export function rma(x: number[], p: number): number[] {
  const o = N(x.length); let e = NaN;
  for (let i = 0; i < x.length; i++) { e = Number.isNaN(e) ? x[i] : (e * (p - 1) + x[i]) / p; if (i >= p - 1) o[i] = e; }
  return o;
}
export function rsi(c: number[], p = 14): number[] {
  const o = N(c.length); let g = 0, l = 0;
  for (let i = 1; i < c.length; i++) {
    const ch = c[i] - c[i - 1];
    const u = Math.max(ch, 0), d = Math.max(-ch, 0);
    if (i <= p) { g += u; l += d; if (i === p) { g /= p; l /= p; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
    else { g = (g * (p - 1) + u) / p; l = (l * (p - 1) + d) / p; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  }
  return o;
}
export function atr(b: Bars, p = 14): number[] {
  const tr = b.c.map((c, i) => i === 0 ? b.h[0] - b.l[0] : Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - c), Math.abs(b.l[i] - c)));
  return rma(tr, p);
}
export function adx(b: Bars, p = 14): { adx: number[]; plus: number[]; minus: number[] } {
  const n = b.c.length, A = N(n), P = N(n), M = N(n);
  let sp = 0, sm = 0, sa = 0;
  for (let i = 1; i < n; i++) {
    const up = b.h[i] - b.h[i - 1], dn = b.l[i - 1] - b.l[i];
    const p1 = up > dn && up > 0 ? up : 0, m1 = dn > up && dn > 0 ? dn : 0;
    const tr = Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1]));
    if (i <= p) { sp += p1; sm += m1; sa += tr; if (i === p) { sp /= p; sm /= p; sa /= p; } }
    else { sp = (sp * (p - 1) + p1) / p; sm = (sm * (p - 1) + m1) / p; sa = (sa * (p - 1) + tr) / p; }
    if (i >= p && sa > 0) {
      const pp = (100 * sp) / sa, mm = (100 * sm) / sa;
      P[i] = pp; M[i] = mm;
      const dx = pp + mm > 0 ? (100 * Math.abs(pp - mm)) / (pp + mm) : 0;
      A[i] = i === p ? dx : (A[i - 1] * (p - 1) + dx) / p;
    }
  }
  return { adx: A, plus: P, minus: M };
}
export function stdev(x: number[], p: number): number[] {
  const o = N(x.length);
  for (let i = p - 1; i < x.length; i++) {
    const s = x.slice(i - p + 1, i + 1); const m = s.reduce((a, v) => a + v, 0) / p;
    o[i] = Math.sqrt(s.reduce((a, v) => a + (v - m) ** 2, 0) / p);
  }
  return o;
}
export function bollinger(c: number[], p = 20, m = 2) {
  const mid = sma(c, p), sd = stdev(c, p);
  return { mid, up: mid.map((v, i) => v + m * sd[i]), lo: mid.map((v, i) => v - m * sd[i]) };
}
export function keltner(b: Bars, p = 20, m = 2) {
  const mid = ema(b.c, p), a = atr(b, 10).map((v) => v * m);
  return { mid, up: mid.map((v, i) => v + a[i]), lo: mid.map((v, i) => v - a[i]) };
}
export function donchian(b: Bars, p: number) {
  const up = N(b.c.length), lo = N(b.c.length);
  for (let i = p - 1; i < b.c.length; i++) {
    let h = -Infinity, l = Infinity;
    for (let k = i - p + 1; k <= i; k++) { if (b.h[k] > h) h = b.h[k]; if (b.l[k] < l) l = b.l[k]; }
    up[i] = h; lo[i] = l;
  }
  return { up, lo };
}
export function supertrend(b: Bars, p = 10, m = 3) {
  const n = b.c.length, line = N(n), dir = N(n);
  const a = atr(b, p); let d = 1;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(a[i])) continue;
    const bu = (b.h[i] + b.l[i]) / 2 + m * a[i], bl = (b.h[i] + b.l[i]) / 2 - m * a[i];
    if (i > 0 && !Number.isNaN(line[i - 1])) {
      const pb = line[i - 1];
      const ub = b.c[i - 1] > pb ? Math.min(bu, pb) : bu;
      const lb = b.c[i - 1] < pb ? Math.max(bl, pb) : bl;
      if (d === 1) { if (b.c[i] < lb) d = -1; } else if (b.c[i] > ub) d = 1;
      line[i] = d === 1 ? lb : ub;
    } else line[i] = d === 1 ? bl : bu;
    dir[i] = d;
  }
  return { line, dir };
}
export function psar(b: Bars, step = 0.02, max = 0.2) {
  const n = b.c.length, o = N(n); let bull = true, af = step, ep = b.h[0], sar = b.l[0];
  for (let i = 1; i < n; i++) {
    sar = sar + af * (ep - sar);
    if (bull) {
      if (b.l[i] < sar) { bull = false; sar = ep; ep = b.l[i]; af = step; }
      else { if (b.h[i] > ep) { ep = b.h[i]; af = Math.min(af + step, max); } sar = Math.min(sar, b.l[i - 1], b.l[i]); }
    } else {
      if (b.h[i] > sar) { bull = true; sar = ep; ep = b.h[i]; af = step; }
      else { if (b.l[i] < ep) { ep = b.l[i]; af = Math.min(af + step, max); } sar = Math.max(sar, b.h[i - 1], b.h[i]); }
    }
    o[i] = sar;
  }
  return o;
}
export function macd(c: number[], f = 12, s = 26, sig = 9) {
  const ef = ema(c, f), es = ema(c, s);
  const line = c.map((_, i) => ef[i] - es[i]);
  const valid = line.map((v) => (Number.isNaN(v) ? 0 : v));
  const signal = ema(valid, sig);
  return { line, signal, hist: line.map((v, i) => v - signal[i]) };
}
export function stoch(b: Bars, k = 14, d = 3) {
  const kk = N(b.c.length);
  for (let i = k - 1; i < b.c.length; i++) {
    let h = -Infinity, l = Infinity;
    for (let x = i - k + 1; x <= i; x++) { if (b.h[x] > h) h = b.h[x]; if (b.l[x] < l) l = b.l[x]; }
    kk[i] = h === l ? 50 : (100 * (b.c[i] - l)) / (h - l);
  }
  const dd = sma(kk.map((v) => (Number.isNaN(v) ? 50 : v)), d);
  return { k: kk, d: dd };
}
export function stochRsi(c: number[], r = 14, k = 14, d = 3) {
  const rsiV = rsi(c, r);
  const kk = N(c.length);
  for (let i = r + k - 1; i < c.length; i++) {
    const s = rsiV.slice(i - k + 1, i + 1);
    const h = Math.max(...s), l = Math.min(...s);
    kk[i] = h === l ? 0 : (rsiV[i] - l) / (h - l);
  }
  const dd = sma(kk.map((v) => (Number.isNaN(v) ? 0 : v)), d);
  return { k: kk, d: dd };
}
export function cci(b: Bars, p = 20) {
  const o = N(b.c.length);
  for (let i = p - 1; i < b.c.length; i++) {
    const tp = []; for (let k = i - p + 1; k <= i; k++) tp.push((b.h[k] + b.l[k] + b.c[k]) / 3);
    const m = tp.reduce((a, v) => a + v, 0) / p;
    const md = tp.reduce((a, v) => a + Math.abs(v - m), 0) / p;
    o[i] = md === 0 ? 0 : (tp[p - 1] - m) / (0.015 * md);
  }
  return o;
}
export function roc(c: number[], p = 12) { return c.map((v, i) => (i < p ? NaN : (100 * (v - c[i - p])) / c[i - p])); }
export function obv(b: Bars) {
  const o = N(b.c.length); let v = 0;
  for (let i = 0; i < b.c.length; i++) { if (i > 0) v += b.c[i] > b.c[i - 1] ? b.v[i] : b.c[i] < b.c[i - 1] ? -b.v[i] : 0; o[i] = v; }
  return o;
}
export function cmf(b: Bars, p = 20) {
  const o = N(b.c.length);
  for (let i = p - 1; i < b.c.length; i++) {
    let num = 0, den = 0;
    for (let k = i - p + 1; k <= i; k++) {
      const m = b.h[k] === b.l[k] ? 0 : ((b.c[k] - b.l[k]) - (b.h[k] - b.c[k])) / (b.h[k] - b.l[k]);
      num += m * b.v[k]; den += b.v[k];
    }
    o[i] = den === 0 ? 0 : num / den;
  }
  return o;
}
export function mfi(b: Bars, p = 14) {
  const o = N(b.c.length);
  for (let i = p; i < b.c.length; i++) {
    let pf = 0, nf = 0;
    for (let k = i - p + 1; k <= i; k++) {
      const tp = (b.h[k] + b.l[k] + b.c[k]) / 3, pp = (b.h[k - 1] + b.l[k - 1] + b.c[k - 1]) / 3;
      if (tp > pp) pf += tp * b.v[k]; else if (tp < pp) nf += tp * b.v[k];
    }
    o[i] = nf === 0 ? 100 : 100 - 100 / (1 + pf / nf);
  }
  return o;
}
/** Session (UTC-day) VWAP reset each day. */
export function sessionVwap(b: Bars) {
  const o = N(b.c.length); let pv = 0, vv = 0, day = -1;
  for (let i = 0; i < b.c.length; i++) {
    const d = new Date(b.t[i]).getUTCDate();
    if (d !== day) { day = d; pv = 0; vv = 0; }
    const tp = (b.h[i] + b.l[i] + b.c[i]) / 3;
    pv += tp * b.v[i]; vv += b.v[i];
    o[i] = vv > 0 ? pv / vv : tp;
  }
  return o;
}
/** Anchored VWAP from bar `anchor`. */
export function anchoredVwap(b: Bars, anchor: number) {
  const o = N(b.c.length); let pv = 0, vv = 0;
  for (let i = anchor; i < b.c.length; i++) {
    const tp = (b.h[i] + b.l[i] + b.c[i]) / 3;
    pv += tp * b.v[i]; vv += b.v[i];
    o[i] = vv > 0 ? pv / vv : tp;
  }
  return o;
}
export function pivots(h: number, l: number, c: number) {
  const pp = (h + l + c) / 3;
  return { pp, r1: 2 * pp - l, s1: 2 * pp - h, r2: pp + (h - l), s2: pp - (h - l) };
}
export function aroon(b: Bars, p = 14) {
  const up = N(b.c.length), dn = N(b.c.length);
  for (let i = p; i < b.c.length; i++) {
    let hi = -Infinity, hx = 0, li = Infinity, lx = 0;
    for (let k = i - p; k <= i; k++) { if (b.h[k] >= hi) { hi = b.h[k]; hx = k; } if (b.l[k] <= li) { li = b.l[k]; lx = k; } }
    up[i] = (100 * (p - (i - hx))) / p; dn[i] = (100 * (p - (i - lx))) / p;
  }
  return { up, dn };
}
export function vortex(b: Bars, p = 14) {
  const vp = N(b.c.length), vn = N(b.c.length);
  for (let i = p; i < b.c.length; i++) {
    let sp = 0, sn = 0, tr = 0;
    for (let k = i - p + 1; k <= i; k++) {
      sp += Math.abs(b.h[k] - b.l[k - 1]); sn += Math.abs(b.l[k] - b.h[k - 1]);
      tr += Math.max(b.h[k] - b.l[k], Math.abs(b.h[k] - b.c[k - 1]), Math.abs(b.l[k] - b.c[k - 1]));
    }
    vp[i] = tr ? sp / tr : 1; vn[i] = tr ? sn / tr : 1;
  }
  return { plus: vp, minus: vn };
}
export function elderImpulse(b: Bars) {
  const e = ema(b.c, 13), m = macd(b.c);
  return b.c.map((_, i) => {
    if (Number.isNaN(e[i]) || Number.isNaN(m.hist[i])) return 0;
    const eb = i > 0 && !Number.isNaN(e[i - 1]) ? e[i] - e[i - 1] : 0;
    const mb = i > 0 && !Number.isNaN(m.hist[i - 1]) ? m.hist[i] - m.hist[i - 1] : 0;
    if (eb > 0 && mb > 0) return 1;
    if (eb < 0 && mb < 0) return -1;
    return 0;
  });
}
export function waveTrend(b: Bars, n1 = 10, n2 = 21) {
  const ap = b.c.map((_, i) => (b.h[i] + b.l[i] + b.c[i]) / 3);
  const esa = ema(ap, n1);
  const dd = ema(ap.map((v, i) => Math.abs(v - esa[i])), n1);
  const ci = ap.map((v, i) => (dd[i] === 0 || Number.isNaN(dd[i]) ? 0 : (v - esa[i]) / (0.015 * dd[i])));
  const wt1 = ema(ci.map((v) => (Number.isNaN(v) ? 0 : v)), n2);
  const wt2 = sma(wt1.map((v) => (Number.isNaN(v) ? 0 : v)), 4);
  return { wt1, wt2 };
}
export function connorsRsi(b: Bars, r = 3, u = 2, rk = 100) {
  const r1 = rsi(b.c, r);
  const ch = b.c.map((v, i) => (i === 0 ? 0 : v - b.c[i - 1]));
  const up = ch.map((v, i) => {
    if (i < u) return NaN;
    let c = 0; for (let k = i - u + 1; k <= i; k++) if (ch[k] > 0) c++;
    return (100 * c) / u;
  });
  const rsiUp = rsi(up.map((v) => (Number.isNaN(v) ? 50 : v)), u);
  const pct = b.c.map((v, i) => {
    if (i < rk) return NaN;
    let c = 0; for (let k = i - rk + 1; k <= i; k++) if (b.c[k] < v) c++;
    return (100 * c) / rk;
  });
  return b.c.map((_, i) => (r1[i] + rsiUp[i] + pct[i]) / 3);
}
export function trix(c: number[], p = 15) {
  const e1 = ema(c, p), e2 = ema(e1.map((v) => (Number.isNaN(v) ? c[0] : v)), p), e3 = ema(e2.map((v) => (Number.isNaN(v) ? c[0] : v)), p);
  return e3.map((v, i) => (i === 0 || Number.isNaN(v) || Number.isNaN(e3[i - 1]) || e3[i - 1] === 0 ? NaN : (100 * (v - e3[i - 1])) / e3[i - 1]));
}
export function rvi(b: Bars, p = 10) {
  const num = b.c.map((_, i) => (i < 4 ? NaN : ((b.c[i] - b.o[i]) + 2 * (b.c[i - 1] - b.o[i - 1]) + 2 * (b.c[i - 2] - b.o[i - 2]) + (b.c[i - 3] - b.o[i - 3])) / 6));
  const den = b.c.map((_, i) => (i < 4 ? NaN : ((b.h[i] - b.l[i]) + 2 * (b.h[i - 1] - b.l[i - 1]) + 2 * (b.h[i - 2] - b.l[i - 2]) + (b.h[i - 3] - b.l[i - 3])) / 6));
  const n = sma(num.map((v) => (Number.isNaN(v) ? 0 : v)), p), d = sma(den.map((v) => (Number.isNaN(v) ? 1 : v)), p);
  return n.map((v, i) => (d[i] === 0 ? 0 : (100 * v) / d[i]));
}
/** Fractal pivots: high[i] is highest of [i-L, i+R]. */
export function swings(b: Bars, L = 3, R = 3) {
  const hi: number[] = [], lo: number[] = [];
  for (let i = L; i < b.c.length - R; i++) {
    let h = true, l = true;
    for (let k = i - L; k <= i + R; k++) {
      if (k === i) continue;
      if (b.h[k] > b.h[i]) h = false;
      if (b.l[k] < b.l[i]) l = false;
    }
    if (h) hi.push(i); if (l) lo.push(i);
  }
  return { hi, lo };
}
/** Heikin-Ashi closes. */
export function haClose(b: Bars) {
  const o = N(b.c.length); let ho = b.o[0], hc = b.c[0];
  for (let i = 0; i < b.c.length; i++) {
    const c = (b.o[i] + b.h[i] + b.l[i] + b.c[i]) / 4;
    const oo = i === 0 ? b.o[0] : (ho + hc) / 2;
    ho = oo; hc = c; o[i] = c;
  }
  return o;
}
