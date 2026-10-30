/**
 * VCD / VCT — Volume Centroid Drift & Volume Conviction Trend.
 * Ported 2026-09-26 from the user's pasted indicator pair (house lab only,
 * NOT wired into any engine, book, or advisor).
 *
 * VERDICT (2026-09-26, lab:vcdvct + 360d redundancy probe):
 *  - VCD: RETIRED. The ±0.7 climax/vacuum cells of its reading guide are EMPTY
 *    after EMA smoothing (n=0 / n=6 in 168k entries); deciles flat both halves.
 *  - VCT: NOT CLEARED, one open lead. Pre-registered vetoes dead (wrong sign
 *    in half 1). But its band structure on the POST-STACK book is monotone
 *    (−0.501 → +1.636 R/t from <-0.5 to ≥+0.7) — the only monotone post-stack
 *    band structure found in five labs — with unusable tail samples (n=8, n=14).
 *    Exit-mod cells: 13 eligible trades, best t 1.61 vs FDR 2.10, halves split.
 *    Only honest path forward: shadow-tag vct on live decisions to accumulate
 *    the tail sample. Do not mistake this stamp for a validated gate.
 *
 * Causality contract: pass CLOSED bars only. raw[i] uses volumes[i] itself,
 * so the caller must ensure bar i is closed before its value is consumed.
 *
 * House fixes vs the paste (documented, behavior-preserving on filled data):
 *  - Warmup bars return NaN instead of null; NaN contracts match
 *    wilderRsiSeries / atrSeries used across this repo's labs.
 *  - VCT's EMA warmup bug (nulls propagating past slowLen) fixed.
 */

export interface VCDOptions {
  centroidWindow?: number; // N: rolling volume window
  vcdSmoothing?: number; // M: EMA period for VCD
  signalSmoothing?: number; // S: EMA period for signal
}

export interface VCDPoint {
  vcd: number; // smoothed centroid drift, NaN during warmup
  signal: number;
  histogram: number;
  raw: number; // in [-1, 1]; volume center-of-mass position in window
  centroid: number; // raw bar-position center of mass, 1..N
}

export interface VCTOptions {
  convictionWindow?: number; // N
  fastLen?: number;
  slowLen?: number;
  vctSmoothing?: number; // M
  signalSmoothing?: number; // S
}

export interface VCTPoint {
  vct: number;
  signal: number;
  histogram: number;
  raw: number; // trend * volume-weighted concordance, in [-1, 1]
  trend: 1 | -1;
}

export const VCD_DEFAULTS = {
  centroidWindow: 20,
  vcdSmoothing: 5,
  signalSmoothing: 3,
} as const;

export const VCT_DEFAULTS = {
  convictionWindow: 20,
  fastLen: 10,
  slowLen: 30,
  vctSmoothing: 5,
  signalSmoothing: 3,
} as const;

/** NaN-preserving EMA seeded with the SMA of the first `period` valid values. */
function emaSeries(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period < 1) return out;
  const alpha = 2 / (period + 1);
  let prev = NaN;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFinite(v)) continue;
    if (!isFinite(prev)) {
      seedSum += v;
      seedCount++;
      if (seedCount < period) continue;
      prev = seedSum / period;
      out[i] = prev;
    } else {
      prev = alpha * v + (1 - alpha) * prev;
      out[i] = prev;
    }
  }
  return out;
}

/** Standard EMA over a fully-defined numeric series. */
function plainEma(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period < 1) return out;
  const alpha = 2 / (period + 1);
  let prev = NaN;
  let seedSum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFinite(prev)) {
      seedSum += v;
      if (i + 1 < period) continue;
      prev = seedSum / period;
      out[i] = prev;
    } else {
      prev = alpha * v + (1 - alpha) * prev;
      out[i] = prev;
    }
  }
  return out;
}

export function computeVCD(volumes: number[], options: VCDOptions = {}): VCDPoint[] {
  const { centroidWindow: N, vcdSmoothing: M, signalSmoothing: S } = { ...VCD_DEFAULTS, ...options };
  if (N < 3) throw new Error("centroidWindow must be >= 3");
  if (M < 1 || S < 1) throw new Error("smoothing periods must be >= 1");

  const n = volumes.length;
  const raw: number[] = new Array(n).fill(NaN);
  const centroid: number[] = new Array(n).fill(NaN);

  for (let i = 0; i < n; i++) {
    if (i < N - 1) continue;
    let weightedSum = 0;
    let volSum = 0;
    for (let j = 0; j < N; j++) {
      const v = volumes[i - N + 1 + j];
      const weight = j + 1; // oldest = 1 ... newest = N
      weightedSum += weight * v;
      volSum += v;
    }
    if (!(volSum > 0)) {
      raw[i] = 0; // no volume in window -> neutral (paste convention)
      continue;
    }
    const c = weightedSum / volSum;
    const center = (N + 1) / 2;
    const maxDist = (N - 1) / 2;
    centroid[i] = c;
    raw[i] = (c - center) / maxDist;
  }

  const vcd = emaSeries(raw, M);
  const signal = emaSeries(vcd, S);

  return volumes.map((_, i) => ({
    vcd: vcd[i],
    signal: signal[i],
    histogram: isFinite(vcd[i]) && isFinite(signal[i]) ? vcd[i] - signal[i] : NaN,
    raw: raw[i],
    centroid: centroid[i],
  }));
}

export function computeVCT(
  closes: number[],
  volumes: number[],
  options: VCTOptions = {}
): VCTPoint[] {
  const { convictionWindow: N, fastLen, slowLen, vctSmoothing: M, signalSmoothing: S } = {
    ...VCT_DEFAULTS,
    ...options,
  };
  if (closes.length !== volumes.length) throw new Error("closes and volumes must have equal length");
  if (N < 2) throw new Error("convictionWindow must be >= 2");

  const n = closes.length;
  const emaFast = plainEma(closes, fastLen);
  const emaSlow = plainEma(closes, slowLen);

  // bar direction: sign of close-to-close move; bar 0 and flat bars are 0
  const barDir: number[] = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1];
    barDir[i] = diff > 0 ? 1 : diff < 0 ? -1 : 0;
  }

  const raw: number[] = new Array(n).fill(NaN);
  const trend: (1 | -1)[] = new Array(n).fill(-1) as (1 | -1)[];

  // House fix: raw requires a FULLY-defined trend window. The paste reads
  // trend as -1 for bars whose slow EMA is still NaN (NaN comparison), which
  // leaks bogus concordance into the first slowLen+N bars. Here raw is NaN
  // until every bar in the window has both EMAs defined.
  const warm = N + Math.max(fastLen, slowLen) - 1;
  for (let i = 0; i < n; i++) {
    if (i < warm) continue;
    const trendNow: 1 | -1 = emaFast[i] > emaSlow[i] ? 1 : -1;
    trend[i] = trendNow;

    let wSum = 0;
    let vSum = 0;
    for (let j = 0; j < N; j++) {
      const idx = i - j;
      const t = emaFast[idx] > emaSlow[idx] ? 1 : -1;
      const concord = barDir[idx] * t; // +1 bar agreed with its trend, -1 fought it, 0 flat
      wSum += concord * volumes[idx];
      vSum += volumes[idx];
    }
    raw[i] = vSum > 0 ? trendNow * (wSum / vSum) : 0;
  }

  const vct = emaSeries(raw, M);
  const signal = emaSeries(vct, S);

  return closes.map((_, i) => ({
    vct: vct[i],
    signal: signal[i],
    histogram: isFinite(vct[i]) && isFinite(signal[i]) ? vct[i] - signal[i] : NaN,
    raw: raw[i],
    trend: trend[i],
  }));
}
