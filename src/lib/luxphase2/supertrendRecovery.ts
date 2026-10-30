// SUPERTREND RECOVERY + STRUCTURE (CC BY-NC-SA 4.0, © LuxAlgo).
// Derived from LuxAlgo "SuperTrend Recovery" and "Structure & Trend
// Dashboard" (verified against the Library MCP sources 2026-10-10:
// indicator slugs `supertrend-recovery` and `structure-trend-dashboard`).
// The pasted strategy's trading logic is ported 1:1; visuals (plots,
// fills, labels, dashboard table) are chart concerns and not ported.
// Research/backtest use only — the NC license clause governs live capital.
//
// PURE: no I/O, no clock, no node imports — Convex-safe and unit-testable.
//
// PORT MAP (Pine -> here):
//   ta.atr(len)            -> I.atr (RMA Wilder; first-len-bars seeding
//                             differs microscopically from Pine's SMA seed —
//                             immaterial past the ready gate + 250 warmup)
//   ST state machine       -> stSeries() (exact: ratchet, alpha recovery
//                             blend, flip reassignment, isfirst seed)
//   f_get_trend(len)       -> pivotTrend() (identical latch logic; strict
//                             extremes, mirroring ta.pivot no-tie behaviour)
//   chart BOS/CHoCH        -> chartTrend() (consumable pivots, same breaks)
//   security(·,t[1],lookahead_on) -> htfAt(): previous CLOSED HTF block
//                             (absolute ms: bias 240m, struct 60m)
//                             (structTF == chart TF goes direct with 1-lag)
//   edge trigger           -> setupEdge() (setup && !setup[1])
//   strategy.exit loss/profit ticks -> engine stopAtrs/targetR (same
//                             economics in price units, no mintick step)
//   exitOnFlip             -> exitLong/exitShort on ST trend
// ENGINE-CONVENTION DEVIATIONS (apply to all 85 specs, not just this one):
//   sizing is 1% risk on stop distance (Pine: 10% equity), fills are
//   next-bar-open (Pine reverses intrabar), costs 5bps+5bps/side (Pine:
//   0.05% commission + 2-tick slippage), timeExit 0 (no Pine equivalent).
import { atr } from "./indicators";

export const STR_ATR_LEN = 10;
export const STR_BASE_MULT = 3.0;
export const STR_ALPHA = 0.05; // 5.0% / 100
export const STR_THR_ATR = 1.0;
export const STR_SWING_LEN = 5;
export const STR_READY_EXTRA = 5; // bar_index > atrLen + swingLen*2 + 5
// HTF mapping is chart-relative (Pine timeframes are absolute):
//   15m chart -> biasTF 240m = 16 bars, structTF 60m = 4 bars (authored habitat)
//   1H chart  -> biasTF 240m = 4 bars, structTF 60m = 1 bar (direct + 1-lag)
export const STR_BIAS_BLOCK_15M = 16;
export const STR_STRUCT_BLOCK_15M = 4;

export type BarsLike = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[] };
export type STOpts = { atrLen?: number; baseMult?: number; alpha?: number; thrAtr?: number };

const F = (v: number) => Number.isFinite(v);

/** SuperTrend Recovery state machine. Pine block verbatim in structure. */
export function stSeries(b: BarsLike, o?: STOpts): { trend: number[]; band: number[] } {
  const n = b.c.length;
  const atrLen = o?.atrLen ?? STR_ATR_LEN;
  const baseMult = o?.baseMult ?? STR_BASE_MULT;
  const alpha = o?.alpha ?? STR_ALPHA;
  const thrAtr = o?.thrAtr ?? STR_THR_ATR;
  const a = atr(b as never, atrLen);
  const trend = new Array(n).fill(1);
  const band = new Array(n).fill(NaN);
  let stBand = NaN;
  let switchPrice = NaN;
  let tr = 1;
  for (let i = 0; i < n; i++) {
    // barstate.isfirst runs even when ATR is na (Pine executes the whole
    // block); the seed must precede the na-guard or recovery never arms
    // on the first trend leg.
    if (i === 0) switchPrice = b.c[i];
    const at = a[i];
    if (!F(at)) continue; // band stays na until ATR valid (Pine: na propagation)
    const src = (b.h[i] + b.l[i]) / 2;
    const upperBase = src + baseMult * at;
    const lowerBase = src - baseMult * at;
    const deviation = thrAtr * at;
    const isAtLoss =
      (tr === 1 && switchPrice - b.c[i] > deviation) || (tr === -1 && b.c[i] - switchPrice > deviation);
    const prevBand = F(stBand) ? stBand : tr === 1 ? lowerBase : upperBase; // nz(stBand[1], …)
    if (tr === 1) {
      const targetBand = isAtLoss ? alpha * b.c[i] + (1 - alpha) * prevBand : lowerBase;
      stBand = Math.max(targetBand, prevBand);
      if (b.c[i] < stBand) {
        tr = -1;
        stBand = upperBase;
        switchPrice = b.c[i];
      }
    } else {
      const targetBand = isAtLoss ? alpha * b.c[i] + (1 - alpha) * prevBand : upperBase;
      stBand = Math.min(targetBand, prevBand);
      if (b.c[i] > stBand) {
        tr = 1;
        stBand = lowerBase;
        switchPrice = b.c[i];
      }
    }
    trend[i] = tr;
    band[i] = stBand;
  }
  return { trend, band };
}

/**
 * f_get_trend: confirmed-pivot latch. Strict extremes (ta.pivot no-tie
 * behaviour); close-through flips, otherwise the last state persists.
 */
export function pivotTrend(h: number[], l: number[], c: number[], len: number): number[] {
  const n = c.length;
  const out = new Array(n).fill(1);
  let lastPH = NaN;
  let lastPL = NaN;
  let t = 1;
  const isPH = (k: number) => {
    for (let j = k - len; j <= k + len; j++) {
      if (j === k || j < 0 || j >= n) continue;
      if (h[j] > h[k]) return false;
    }
    return true;
  };
  const isPL = (k: number) => {
    for (let j = k - len; j <= k + len; j++) {
      if (j === k || j < 0 || j >= n) continue;
      if (l[j] < l[k]) return false;
    }
    return true;
  };
  for (let i = 0; i < n; i++) {
    // pivots confirm `len` bars later; only confirmed pivots latch (same as
    // Pine, where ta.pivot* returns na until confirmation).
    const k = i - len;
    if (k >= len && k + len < n) {
      if (isPH(k)) lastPH = h[k];
      if (isPL(k)) lastPL = l[k];
    }
    if (F(lastPH) && c[i] > lastPH) t = 1;
    else if (F(lastPL) && c[i] < lastPL) t = -1;
    out[i] = t;
  }
  return out;
}

/** Chart BOS/CHoCH: consumable active pivots, break sets trend + consumes. */
export function chartTrend(h: number[], l: number[], c: number[], len: number): number[] {
  const n = c.length;
  const out = new Array(n).fill(1);
  let actPH = NaN;
  let actPL = NaN;
  let t = 1;
  const isPH = (k: number) => {
    for (let j = k - len; j <= k + len; j++) {
      if (j === k || j < 0 || j >= n) continue;
      if (h[j] > h[k]) return false;
    }
    return true;
  };
  const isPL = (k: number) => {
    for (let j = k - len; j <= k + len; j++) {
      if (j === k || j < 0 || j >= n) continue;
      if (l[j] < l[k]) return false;
    }
    return true;
  };
  for (let i = 0; i < n; i++) {
    const k = i - len;
    if (k >= len && k + len < n) {
      if (isPH(k)) actPH = h[k];
      if (isPL(k)) actPL = l[k];
    }
    if (F(actPH) && c[i] > actPH) {
      t = 1;
      actPH = NaN;
    }
    if (F(actPL) && c[i] < actPL) {
      t = -1;
      actPL = NaN;
    }
    out[i] = t;
  }
  return out;
}

type Cache = {
  st?: { trend: number[]; band: number[] };
  piv?: number[];
  chart?: number[];
  htf?: Map<string, number[]>;
};
const memo = new WeakMap<object, Cache>();
function mc(b: BarsLike): Cache {
  let m = memo.get(b as object);
  if (!m) {
    m = {};
    memo.set(b as object, m);
  }
  return m;
}

/**
 * HTF trend at bar i: f_get_trend over blocks of blockMs milliseconds
 * (UTC-epoch aligned; Pine timeframes are absolute: bias 240m, struct 60m),
 * read as of the previous CLOSED block — Pine's t[1] with lookahead_on.
 * blockMs <= 0 evaluates the chart series directly with the same 1-bar lag
 * (the structTF == chart-TF case: Pine still reads t[1] via security).
 */
export function htfAt(b: BarsLike, i: number, blockMs: number, len = STR_SWING_LEN): number {
  const m = mc(b);
  if (!m.htf) m.htf = new Map();
  const key = `${blockMs}:${len}`;
  let per = m.htf.get(key);
  if (!per) {
    const BLOCK = blockMs;
    const starts: number[] = [];
    const H: number[] = [];
    const L: number[] = [];
    const C: number[] = [];
    let cur = -1;
    for (let k = 0; k < b.c.length; k++) {
      const blk = Math.floor(b.t[k] / BLOCK);
      if (blk !== cur) {
        cur = blk;
        starts.push(k);
        H.push(b.h[k]);
        L.push(b.l[k]);
        C.push(b.c[k]);
      } else {
        H[H.length - 1] = Math.max(H[H.length - 1]!, b.h[k]);
        L[L.length - 1] = Math.min(L[L.length - 1]!, b.l[k]);
        C[C.length - 1] = b.c[k];
      }
    }
    const tr = pivotTrend(H, L, C, len);
    // Per-bar value: trend of the previous closed block. The block
    // containing bar k is incomplete there, so value = tr[blockIdx-1].
    // Block index per bar, tracked in one pass (starts[] is ascending).
    // blockMs <= 0: chart TF itself; Pine still reads t[1] through
    // request.security, so lag one bar behind the forming bar.
    per = new Array(b.c.length).fill(1);
    if (BLOCK <= 0) {
      const tr0 = pivotTrend(b.h, b.l, b.c, len);
      for (let k = 0; k < b.c.length; k++) per[k] = k > 0 ? tr0[k - 1]! : 1;
    } else {
      let bi = 0;
      for (let k = 0; k < b.c.length; k++) {
        while (bi + 1 < starts.length && starts[bi + 1]! <= k) bi++;
        per![k] = bi > 0 ? tr[bi - 1]! : 1;
      }
    }
    m.htf.set(key, per);
  }
  return per[Math.min(i, per.length - 1)]!;
}

/** HTF bias on an hourly chart (240m = 4 hourly bars). */
export function biasAt(b: BarsLike, i: number, blockBars = 4, len = STR_SWING_LEN): number {
  return htfAt(b, i, blockBars * 3_600_000, len);
}

export type SetupOpts = {
  useBias?: boolean;
  useStruct?: boolean;
  useChart?: boolean;
  atrLen?: number;
  swingLen?: number;
  /** Chart bar size in ms (default 15m = authored habitat). */
  chartMs?: number;
  /** Absolute HTF timeframes in ms (Pine inputs; defaults = pasted 240/60). */
  biasMs?: number;
  structMs?: number;
};
export const STR_CHART_MS = 900_000;
export const STR_BIAS_MS = 14_400_000;
export const STR_STRUCT_MS = 3_600_000;

/** Memoized ST + pivot + chart series for one bar array. */
export function series(b: BarsLike, o?: SetupOpts) {
  const m = mc(b);
  if (!m.st) m.st = stSeries(b, { atrLen: o?.atrLen });
  if (!m.piv) m.piv = pivotTrend(b.h, b.l, b.c, o?.swingLen ?? STR_SWING_LEN);
  if (!m.chart) m.chart = chartTrend(b.h, b.l, b.c, o?.swingLen ?? STR_SWING_LEN);
  return m as Required<Cache>;
}

/** Full setup state at bar i (Pine longSetup/shortSetup), no edge. */
export function setupAt(b: BarsLike, i: number, dir: 1 | -1, o?: SetupOpts): boolean {
  const atrLen = o?.atrLen ?? STR_ATR_LEN;
  const swingLen = o?.swingLen ?? STR_SWING_LEN;
  if (!(i > atrLen + swingLen * 2 + STR_READY_EXTRA)) return false; // ready
  const s = series(b, o);
  if ((s.st.trend[i] ?? 1) !== dir) return false;
  const chartMs = o?.chartMs ?? STR_CHART_MS;
  const biasMs = o?.biasMs ?? STR_BIAS_MS;
  const structMs = o?.structMs ?? STR_STRUCT_MS;
  const swingLen2 = o?.swingLen ?? STR_SWING_LEN;
  if (o?.useBias ?? true) {
    if (htfAt(b, i, biasMs, swingLen2) !== dir) return false;
  }
  if (o?.useStruct ?? true) {
    // structTF == chart TF collapses to the chart series with Pine's t[1]
    // lag; otherwise the struct TF is resampled like the bias TF.
    const ps = structMs <= chartMs && i > 0 ? s.piv[i - 1]! : htfAt(b, i, structMs, swingLen2);
    if (ps !== dir) return false;
  }
  if (o?.useChart ?? true) {
    if (s.chart[i] !== dir) return false;
  }
  return true;
}

/** Edge trigger: setup && !setup[1] (Pine longTrigger/shortTrigger). */
export function setupEdge(b: BarsLike, i: number, dir: 1 | -1, o?: SetupOpts): boolean {
  if (i < 1 || !setupAt(b, i, dir, o)) return false;
  return !setupAt(b, i - 1, dir, o);
}
