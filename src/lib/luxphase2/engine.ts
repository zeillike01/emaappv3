// Phase-2 1H backtest engine: execution model, regime classifier, metrics.
// Execution: next-bar-open fills; intrabar stop-before-target (pessimistic);
// 0.05% fee + 0.05% slippage per side; 1% risk sizing w/ ATR fallback.
import type { Bars } from "./indicators";
import * as I from "./indicators";

export const FEE = 0.0005, SLIP = 0.0005, RISK = 0.01;
export const WARMUP = 250;

export type Regime = "trend_up" | "trend_down" | "ranging" | "high_vol" | "low_vol" | "neutral";
export type StratDef = {
  slug: string; family: string; direction: "Long" | "Short" | "Both";
  long: (b: Bars, i: number, c: Cache) => boolean;
  short: (b: Bars, i: number, c: Cache) => boolean;
  exitLong: (b: Bars, i: number, c: Cache) => boolean;
  exitShort: (b: Bars, i: number, c: Cache) => boolean;
  stopAtrs: number; targetR: number; timeExit: number; // timeExit 0 = none
  alwaysIn: boolean;
  // Optional structure-based stop distance (price units) at entry. When it
  // returns a finite positive number it replaces stopAtrs*ATR for sizing and
  // the stop level (e.g. Wolfe sweet-zone extreme); otherwise ATR fallback.
  stopFn?: (b: Bars, i: number, c: Cache, dir: 1 | -1, entryPx: number) => number | undefined;
};
export type Cache = {
  ema20: number[]; ema50: number[]; ema200: number[]; sma5: number[]; sma20: number[]; sma50: number[]; sma200: number[];
  rsi14: number[]; rsi2: number[]; atr14: number[]; adx: number[]; dmp: number[]; dmn: number[];
  bbUp: number[]; bbLo: number[]; bbMid: number[]; kcUp: number[]; kcLo: number[]; kcMid: number[];
  dc20u: number[]; dc20l: number[]; dc55u: number[]; dc55l: number[]; dc10u: number[]; dc10l: number[];
  stDir: number[]; stLine: number[]; sar: number[];
  macdL: number[]; macdS: number[]; macdH: number[];
  stK: number[]; stD: number[]; srsiK: number[]; srsiD: number[];
  cci: number[]; roc: number[]; obv: number[]; cmf: number[]; mfi: number[];
  vwap: number[]; aroonU: number[]; aroonD: number[]; vortP: number[]; vortM: number[];
  elder: number[]; wt1: number[]; wt2: number[]; crsi: number[]; trix: number[]; rvi: number[];
  gannHilo: number[]; chandL: number[]; chandS: number[]; ema13: number[]; haC: number[];
  swHi: number[]; swLo: number[];
};
export function buildCache(b: Bars): Cache {
  const ema20 = I.ema(b.c, 20), ema50 = I.ema(b.c, 50), ema200 = I.ema(b.c, 200);
  const sma5 = I.sma(b.c, 5), sma20 = I.sma(b.c, 20), sma50 = I.sma(b.c, 50), sma200 = I.sma(b.c, 200);
  const rsi14 = I.rsi(b.c, 14), rsi2 = I.rsi(b.c, 2);
  const atr14 = I.atr(b, 14);
  const { adx, plus: dmp, minus: dmn } = I.adx(b, 14);
  const bb = I.bollinger(b.c, 20, 2), kc = I.keltner(b, 20, 2);
  const dc20 = I.donchian(b, 20), dc55 = I.donchian(b, 55), dc10 = I.donchian(b, 10);
  const st = I.supertrend(b, 10, 3);
  const sar = I.psar(b);
  const macd = I.macd(b.c);
  const stoch = I.stoch(b, 14, 3), srsi = I.stochRsi(b.c, 14, 14, 3);
  const cci = I.cci(b, 20), roc = I.roc(b.c, 12), obv = I.obv(b), cmf = I.cmf(b, 20), mfi = I.mfi(b, 14);
  const vwap = I.sessionVwap(b);
  const ar = I.aroon(b, 14), vx = I.vortex(b, 14);
  const elder = I.elderImpulse(b), wt = I.waveTrend(b), crsi = I.connorsRsi(b);
  const trix = I.trix(b.c), rvi = I.rvi(b, 10);
  const ema13 = I.ema(b.c, 13), haC = I.haClose(b);
  // Gann HiLo(13): state line of smoothed highs/lows
  const hma = I.sma(b.h, 13), lma = I.sma(b.l, 13), cma = I.sma(b.c, 13);
  const gannHilo = b.c.map((_, i) => (Number.isNaN(cma[i]) ? NaN : b.c[i] > cma[i] ? lma[i] : hma[i]));
  // Chandelier(22,3)
  const chandL = b.c.map((_, i) => {
    if (i < 21 || Number.isNaN(atr14[i])) return NaN;
    let h = -Infinity; for (let k = i - 21; k <= i; k++) if (b.h[k] > h) h = b.h[k];
    return h - 3 * atr14[i];
  });
  const chandS = b.c.map((_, i) => {
    if (i < 21 || Number.isNaN(atr14[i])) return NaN;
    let l = Infinity; for (let k = i - 21; k <= i; k++) if (b.l[k] < l) l = b.l[k];
    return l + 3 * atr14[i];
  });
  // fractal swing marker series (1 = swing high, -1 = swing low)
  const swHi = I.N(b.c.length, 0), swLo = I.N(b.c.length, 0);
  const { hi, lo } = I.swings(b, 3, 3);
  for (const x of hi) swHi[x] = 1;
  for (const x of lo) swLo[x] = 1;
  return {
    ema20, ema50, ema200, sma5, sma20, sma50, sma200, rsi14, rsi2, atr14, adx, dmp, dmn,
    bbUp: bb.up, bbLo: bb.lo, bbMid: bb.mid, kcUp: kc.up, kcLo: kc.lo, kcMid: kc.mid,
    dc20u: dc20.up, dc20l: dc20.lo, dc55u: dc55.up, dc55l: dc55.lo, dc10u: dc10.up, dc10l: dc10.lo,
    stDir: st.dir, stLine: st.line, sar, macdL: macd.line, macdS: macd.signal, macdH: macd.hist,
    stK: stoch.k, stD: stoch.d, srsiK: srsi.k, srsiD: srsi.d,
    cci, roc, obv, cmf, mfi, vwap, aroonU: ar.up, aroonD: ar.dn, vortP: vx.plus, vortM: vx.minus,
    elder, wt1: wt.wt1, wt2: wt.wt2, crsi, trix, rvi, gannHilo, chandL, chandS, ema13, haC, swHi, swLo,
  };
}
/** Exclusive-priority regime label per bar. */
export function classify(b: Bars, c: Cache, i: number): Regime {
  const atr = c.atr14[i];
  if (Number.isNaN(atr) || Number.isNaN(c.adx[i]) || Number.isNaN(c.ema200[i])) return "neutral";
  let sum = 0, n = 0;
  for (let k = Math.max(0, i - 29); k <= i; k++) { if (!Number.isNaN(c.atr14[k])) { sum += c.atr14[k]; n++; } }
  const avg = n ? sum / n : atr;
  if (atr > 1.5 * avg) return "high_vol";
  const up = b.c[i] > c.ema200[i] && c.adx[i] > 25 && c.ema20[i] > c.ema20[Math.max(0, i - 5)];
  const dn = b.c[i] < c.ema200[i] && c.adx[i] > 25 && c.ema20[i] < c.ema20[Math.max(0, i - 5)];
  if (up) return "trend_up";
  if (dn) return "trend_down";
  if (c.adx[i] < 20) return "ranging";
  if (atr < 0.5 * avg) return "low_vol";
  return "neutral";
}
export type Trade = {
  entryTime: number; exitTime: number; direction: string; entryPrice: number; exitPrice: number;
  notional: number; pnl: number; pnlPct: number; exitReason: string; regimeIn: Regime; regimeOut: Regime;
  holdBars: number;
};
export function backtest(b: Bars, s: StratDef, regimes: Regime[], startIdx: number): { trades: Trade[]; equity: number[]; exposure: number } {
  const n = b.c.length;
  const c = buildCache(b);
  let equity = 10000;
  const eq = new Array(n).fill(NaN);
  const trades: Trade[] = [];
  type Pos = { dir: 1 | -1; entry: number; qty: number; stop: number; target: number; since: number; r: number };
  const S: { pos: Pos | null } = { pos: null };
  let inMkt = 0;
  const fire = (i: number, dir: 1 | -1, why: string) => {
    const px = b.o[i];
    const atr = c.atr14[i - 1] || px * 0.01;
    let stopD = s.stopAtrs * atr;
    try {
      const custom = s.stopFn?.(b, i, c, dir, px);
      if (custom != null && Number.isFinite(custom) && custom > 0) stopD = custom;
    } catch { /* fall back to the ATR stop */ }
    const risk = equity * RISK;
    let notional = risk / (stopD / px);
    notional = Math.min(notional, equity * 2);
    const qty = notional / px;
    const stop = dir === 1 ? px - stopD : px + stopD;
    const target = dir === 1 ? px + s.targetR * stopD : px - s.targetR * stopD;
    S.pos = { dir, entry: px, qty, stop, target, since: i, r: stopD };
    void why;
  };
  const close = (i: number, px: number, why: string) => {
    const q = S.pos;
    if (!q) return;
    const gross = ((px - q.entry) * q.dir * q.qty) / 10000;
    const pnlPct = ((px - q.entry) * q.dir) / q.entry;
    const cost = (q.entry * q.qty + px * q.qty) * (FEE + SLIP);
    const net = gross * 10000 - cost;
    equity += net;
    trades.push({
      entryTime: b.t[q.since], exitTime: b.t[i], direction: q.dir === 1 ? "LONG" : "SHORT",
      entryPrice: q.entry, exitPrice: px, notional: q.entry * q.qty,
      pnl: net, pnlPct: pnlPct * 100, exitReason: why,
      regimeIn: regimes[q.since], regimeOut: regimes[i], holdBars: i - q.since,
    });
    S.pos = null;
  };
  for (let i = Math.max(1, startIdx); i < n; i++) {
    const p = S.pos;
    if (p) {
      inMkt++;
      // intrabar pessimistic: stop before target
      if (p.dir === 1) {
        if (b.l[i] <= p.stop) { close(i, Math.min(p.stop, b.o[i]), "stop"); }
        else if (b.h[i] >= p.target) { close(i, Math.max(p.target, b.o[i]), "target"); }
        else if (s.timeExit > 0 && i - p.since >= s.timeExit) close(i, b.c[i], "time");
        else if (s.exitLong(b, i, c)) close(i, b.c[i], "signal");
      } else {
        if (b.h[i] >= p.stop) { close(i, Math.max(p.stop, b.o[i]), "stop"); }
        else if (b.l[i] <= p.target) { close(i, Math.min(p.target, b.o[i]), "target"); }
        else if (s.timeExit > 0 && i - p.since >= s.timeExit) close(i, b.c[i], "time");
        else if (s.exitShort(b, i, c)) close(i, b.c[i], "signal");
      }
    }
    if (i >= n - 1) { if (S.pos) close(i, b.c[i], "eod"); eq[i] = equity; break; }
    if (!S.pos) {
      const L = s.direction !== "Short" && s.long(b, i, c);
      const S = s.direction !== "Long" && s.short(b, i, c);
      if (s.alwaysIn) {
        if (L) fire(i + 1, 1, "entry");
        else if (S) fire(i + 1, -1, "entry");
      } else {
        if (L && !S) fire(i + 1, 1, "entry");
        else if (S && !L) fire(i + 1, -1, "entry");
        else if (L && S) { /* conflicting: stay flat */ }
      }
    } else if (s.alwaysIn) {
      const cur = S.pos;
      const rev = cur && (cur.dir === 1 ? (s.direction !== "Long" && s.short(b, i, c)) : (s.direction !== "Short" && s.long(b, i, c)));
      if (rev && cur) { close(i, b.c[i], "reverse"); fire(i + 1, cur.dir === 1 ? -1 : 1, "entry"); }
    }
    eq[i] = equity;
  }
  eq[n - 1] = equity;
  return { trades, equity: eq, exposure: inMkt / Math.max(1, n - startIdx) };
}
export function metrics(eq: number[], trades: Trade[], startIdx: number, bhRet: number) {
  const rets: number[] = [];
  for (let i = startIdx + 1; i < eq.length; i++) if (eq[i - 1] > 0) rets.push(eq[i] / eq[i - 1] - 1);
  const mean = rets.length ? rets.reduce((a, v) => a + v, 0) / rets.length : 0;
  const sd = rets.length > 1 ? Math.sqrt(rets.reduce((a, v) => a + (v - mean) ** 2, 0) / (rets.length - 1)) : 0;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(8760) : 0;
  const dn = rets.filter((r) => r < 0);
  const dsd = dn.length > 1 ? Math.sqrt(dn.reduce((a, v) => a + v * v, 0) / dn.length) : 0;
  const sortino = dsd > 0 ? (mean / dsd) * Math.sqrt(8760) : 0;
  let peak = eq[startIdx] || 10000, mdd = 0;
  for (let i = startIdx; i < eq.length; i++) { if (eq[i] > peak) peak = eq[i]; mdd = Math.max(mdd, (peak - eq[i]) / peak); }
  const tot = (eq[eq.length - 1] / (eq[startIdx] || 10000) - 1) * 100;
  const hours = Math.max(1, eq.length - startIdx);
  const cagr = (Math.pow(eq[eq.length - 1] / (eq[startIdx] || 10000), 8760 / hours) - 1) * 100;
  const wins = trades.filter((t) => t.pnl > 0);
  const gw = wins.reduce((a, t) => a + t.pnl, 0), gl = -trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  let mcw = 0, mcl = 0, cw = 0, cl = 0;
  for (const t of trades) { if (t.pnl > 0) { cw++; cl = 0; mcw = Math.max(mcw, cw); } else { cl++; cw = 0; mcl = Math.max(mcl, cl); } }
  return {
    total_return_pct: r(tot), cagr_pct: r(cagr), max_drawdown_pct: r(mdd * 100),
    sharpe: r(sharpe), sortino: r(sortino), calmar: r(mdd > 0 ? cagr / (mdd * 100) : 0),
    win_rate_pct: r(trades.length ? (100 * wins.length) / trades.length : 0),
    profit_factor: r(gl > 0 ? gw / gl : gw > 0 ? 99 : 0),
    num_trades: trades.length,
    avg_trade_duration_hours: r(trades.length ? trades.reduce((a, t) => a + t.holdBars, 0) / trades.length : 0),
    expectancy: r(trades.length ? trades.reduce((a, t) => a + t.pnlPct, 0) / trades.length : 0),
    avg_win: r(wins.length ? wins.reduce((a, t) => a + t.pnlPct, 0) / wins.length : 0),
    avg_loss: r(trades.filter((t) => t.pnl <= 0).length ? trades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnlPct, 0) / Math.max(1, trades.length - wins.length) : 0),
    largest_win: r(trades.length ? Math.max(...trades.map((t) => t.pnlPct)) : 0),
    largest_loss: r(trades.length ? Math.min(...trades.map((t) => t.pnlPct)) : 0),
    max_consecutive_wins: mcw, max_consecutive_losses: mcl,
    buy_and_hold_return_pct: r(bhRet), alpha_vs_bh: r(tot - bhRet),
  };
}
const r = (v: number) => Math.round(v * 1000) / 1000;
