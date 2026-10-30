// Strategy definitions batch 1: Trend (10), Momentum (11), Volatility (9).
// Each maps its LuxAlgo spec's documented rules to 1H-executable logic.
// Approximations vs the prose spec are noted in METHOD_NOTES.md.
import type { Bars } from "./indicators";
import type { Cache, StratDef } from "./engine";
import * as SR from "./supertrendRecovery";
type B = Bars; type C = Cache;
const F = (v: number) => Number.isFinite(v) && !Number.isNaN(v);
const D = (slug: string, family: string, direction: "Long" | "Short" | "Both", p: Partial<StratDef>): StratDef => ({
  slug, family, direction,
  long: () => false, short: () => false, exitLong: () => false, exitShort: () => false,
  stopAtrs: 1.5, targetR: 2, timeExit: 0, alwaysIn: false, ...p,
});
const crossUp = (a: number[], b: number[], i: number) => F(a[i]) && F(a[i - 1]) && F(b[i]) && F(b[i - 1]) && a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossDn = (a: number[], b: number[], i: number) => F(a[i]) && F(a[i - 1]) && F(b[i]) && F(b[i - 1]) && a[i - 1] >= b[i - 1] && a[i] < b[i];

export const S1: StratDef[] = [
  D("supertrend", "trend", "Both", {
    long: (b, i, c) => c.stDir[i - 1] === -1 && c.stDir[i] === 1,
    short: (b, i, c) => c.stDir[i - 1] === 1 && c.stDir[i] === -1,
    exitLong: (b, i, c) => c.stDir[i] === -1, exitShort: (b, i, c) => c.stDir[i] === 1,
    stopAtrs: 3, targetR: 99, alwaysIn: true,
  }),
  D("supertrend-recovery", "trend", "Both", {
    // Faithful port of the "ST Recovery + Structure" strategy (CC BY-NC-SA
    // 4.0, (c) LuxAlgo): SuperTrend Recovery core (atrLen 10, mult 3.0,
    // alpha 5%, threshold 1xATR) + bias/structure/chart trend agreement
    // (swingLen 5; 4H bias on a 1H chart). See supertrendRecovery.ts.
    // Exits on the ST flip; 1.5xATR stop, 2R target (the pasted defaults).
    long: (b, i) => SR.setupEdge(b, i, 1),
    short: (b, i) => SR.setupEdge(b, i, -1),
    exitLong: (b, i) => (SR.series(b).st.trend[i] ?? 1) === -1,
    exitShort: (b, i) => (SR.series(b).st.trend[i] ?? 1) === 1,
    stopAtrs: 1.5, targetR: 2,
  }),
  D("halftrend", "trend", "Both", {
    // HalfTrend approx: 2-bar high/low average +/- 2xATR(100); flip traded.
    long: (b, i, c) => {
      const h = (x: number) => Math.max(b.h[x], b.h[x - 1]);
      const need = F(c.atr14[i]);
      if (!need) return false;
      const ch = 2 * c.atr14[i];
      const abovePrev = b.c[i - 1] > (h(i - 1) + Math.min(b.l[i - 1], b.l[i - 2])) / 2 - ch;
      const aboveNow = b.c[i] > (h(i) + Math.min(b.l[i], b.l[i - 1])) / 2 - ch;
      const belowPrev = b.c[i - 1] < (h(i - 1) + Math.min(b.l[i - 1], b.l[i - 2])) / 2 + ch;
      void abovePrev;
      return belowPrev && aboveNow && b.c[i] > b.c[i - 1];
    },
    short: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      const ch = 2 * c.atr14[i];
      const l = (x: number) => Math.min(b.l[x], b.l[x - 1]);
      const abovePrev = b.c[i - 1] > (Math.max(b.h[i - 1], b.h[i - 2]) + l(i - 1)) / 2 - ch;
      const belowNow = b.c[i] < (Math.max(b.h[i], b.h[i - 1]) + l(i)) / 2 + ch;
      return abovePrev && belowNow && b.c[i] < b.c[i - 1];
    },
    exitLong: (b, i, c) => F(c.sar[i]) && b.c[i] < c.sar[i],
    exitShort: (b, i, c) => F(c.sar[i]) && b.c[i] > c.sar[i],
    stopAtrs: 2, targetR: 99,
  }),
  D("parabolic-sar", "trend", "Both", {
    long: (b, i, c) => F(c.sar[i]) && F(c.sar[i - 1]) && b.c[i - 1] < c.sar[i - 1] && b.c[i] > c.sar[i],
    short: (b, i, c) => F(c.sar[i]) && F(c.sar[i - 1]) && b.c[i - 1] > c.sar[i - 1] && b.c[i] < c.sar[i],
    exitLong: (b, i, c) => F(c.sar[i]) && b.c[i] < c.sar[i],
    exitShort: (b, i, c) => F(c.sar[i]) && b.c[i] > c.sar[i],
    stopAtrs: 1.5, targetR: 99, alwaysIn: true,
  }),
  D("donchian-trend-rules", "trend", "Both", {
    long: (b, i, c) => F(c.dc20u[i - 1]) && b.c[i] > c.dc20u[i - 1],
    short: (b, i, c) => F(c.dc20l[i - 1]) && b.c[i] < c.dc20l[i - 1],
    exitLong: (b, i, c) => F(c.dc10l[i]) && b.c[i] < c.dc10l[i],
    exitShort: (b, i, c) => F(c.dc10u[i]) && b.c[i] > c.dc10u[i],
    stopAtrs: 2, targetR: 99,
  }),
  D("moving-average-crossovers", "trend", "Both", {
    long: (b, i, c) => crossUp(c.ema20, c.ema50, i),
    short: (b, i, c) => crossDn(c.ema20, c.ema50, i),
    exitLong: (b, i, c) => crossDn(c.ema20, c.ema50, i),
    exitShort: (b, i, c) => crossUp(c.ema20, c.ema50, i),
    stopAtrs: 2, targetR: 99, alwaysIn: true,
  }),
  D("gann-hilo-activator", "trend", "Both", {
    long: (b, i, c) => F(c.gannHilo[i]) && b.c[i - 1] <= c.gannHilo[i - 1] && b.c[i] > c.gannHilo[i],
    short: (b, i, c) => F(c.gannHilo[i]) && b.c[i - 1] >= c.gannHilo[i - 1] && b.c[i] < c.gannHilo[i],
    exitLong: (b, i, c) => F(c.gannHilo[i]) && b.c[i] < c.gannHilo[i],
    exitShort: (b, i, c) => F(c.gannHilo[i]) && b.c[i] > c.gannHilo[i],
    stopAtrs: 1.5, targetR: 99, alwaysIn: true,
  }),
  D("chandelier-stop", "trend", "Both", {
    long: (b, i, c) => F(c.ema50[i]) && F(c.chandL[i]) && b.c[i] > c.ema50[i] && b.c[i - 1] <= c.chandL[i - 1] === false && b.c[i] > c.chandL[i] && b.c[i - 1] < c.ema50[i - 1] * 1.0 && crossUp(b.c, c.ema50, i),
    short: (b, i, c) => F(c.ema50[i]) && F(c.chandS[i]) && crossDn(b.c, c.ema50, i),
    exitLong: (b, i, c) => F(c.chandL[i]) && b.c[i] < c.chandL[i],
    exitShort: (b, i, c) => F(c.chandS[i]) && b.c[i] > c.chandS[i],
    stopAtrs: 3, targetR: 99,
  }),
  D("breakout", "trend", "Both", {
    long: (b, i, c) => F(c.dc20u[i - 1]) && b.c[i] > c.dc20u[i - 1],
    short: (b, i, c) => F(c.dc20l[i - 1]) && b.c[i] < c.dc20l[i - 1],
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1.5, targetR: 2,
  }),
  D("retest", "trend", "Both", {
    long: (b, i, c) => {
      if (!F(c.dc20u[i - 5]) || !F(c.atr14[i])) return false;
      for (let k = i - 5; k < i; k++) {
        if (b.c[k] > c.dc20u[k - 1]) {
          const lvl = c.dc20u[k - 1];
          if (b.l[i] <= lvl + 0.25 * c.atr14[i] && b.c[i] > lvl && b.c[i] > b.o[i]) return true;
        }
      }
      return false;
    },
    short: (b, i, c) => {
      if (!F(c.dc20l[i - 5]) || !F(c.atr14[i])) return false;
      for (let k = i - 5; k < i; k++) {
        if (b.c[k] < c.dc20l[k - 1]) {
          const lvl = c.dc20l[k - 1];
          if (b.h[i] >= lvl - 0.25 * c.atr14[i] && b.c[i] < lvl && b.c[i] < b.o[i]) return true;
        }
      }
      return false;
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("pullback", "trend", "Both", {
    long: (b, i, c) => F(c.ema50[i]) && b.c[i] > c.ema50[i] && c.ema20[i] > c.ema20[i - 3] &&
      b.c[i - 1] < b.c[i - 2] && b.c[i - 2] < b.c[i - 3] && b.c[i] > b.o[i] && b.l[i] >= c.ema50[i] - c.atr14[i],
    short: (b, i, c) => F(c.ema50[i]) && b.c[i] < c.ema50[i] && c.ema20[i] < c.ema20[i - 3] &&
      b.c[i - 1] > b.c[i - 2] && b.c[i - 2] > b.c[i - 3] && b.c[i] < b.o[i] && b.h[i] <= c.ema50[i] + c.atr14[i],
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1.5, targetR: 2,
  }),
  // ---- Momentum ----
  D("rsi-2", "momentum", "Both", {
    long: (b, i, c) => F(c.sma200[i]) && F(c.rsi2[i]) && b.c[i] > c.sma200[i] && c.rsi2[i] < 10,
    short: (b, i, c) => F(c.sma200[i]) && F(c.rsi2[i]) && b.c[i] < c.sma200[i] && c.rsi2[i] > 90,
    exitLong: (b, i, c) => F(c.sma5[i]) && b.c[i] > c.sma5[i],
    exitShort: (b, i, c) => F(c.sma5[i]) && b.c[i] < c.sma5[i],
    stopAtrs: 1.5, targetR: 99,
  }),
  D("stochastic-rsi", "momentum", "Both", {
    long: (b, i, c) => F(c.ema50[i]) && b.c[i] > c.ema50[i] && F(c.srsiK[i]) && c.srsiK[i - 1] <= c.srsiD[i - 1] && c.srsiK[i] > c.srsiD[i] && c.srsiK[i] < 0.3,
    short: (b, i, c) => F(c.ema50[i]) && b.c[i] < c.ema50[i] && F(c.srsiK[i]) && c.srsiK[i - 1] >= c.srsiD[i - 1] && c.srsiK[i] < c.srsiD[i] && c.srsiK[i] > 0.7,
    exitLong: (b, i, c) => F(c.srsiK[i]) && c.srsiK[i] > 0.8,
    exitShort: (b, i, c) => F(c.srsiK[i]) && c.srsiK[i] < 0.2,
    stopAtrs: 1.5, targetR: 2,
  }),
  D("stochastic-pop", "momentum", "Both", {
    long: (b, i, c) => F(c.stK[i]) && F(c.adx[i]) && c.adx[i] > 20 && c.stK[i - 1] <= 80 && c.stK[i] > 80 && b.c[i] > c.ema50[i],
    short: (b, i, c) => F(c.stK[i]) && F(c.adx[i]) && c.adx[i] > 20 && c.stK[i - 1] >= 20 && c.stK[i] < 20 && b.c[i] < c.ema50[i],
    exitLong: (b, i, c) => F(c.stK[i]) && c.stK[i] < 80,
    exitShort: (b, i, c) => F(c.stK[i]) && c.stK[i] > 20,
    stopAtrs: 1.5, targetR: 2,
  }),
  D("macd", "momentum", "Both", {
    long: (b, i, c) => F(c.macdL[i]) && crossUp(c.macdL, c.macdS, i) && c.macdL[i] < 0,
    short: (b, i, c) => F(c.macdL[i]) && crossDn(c.macdL, c.macdS, i) && c.macdL[i] > 0,
    exitLong: (b, i, c) => crossDn(c.macdL, c.macdS, i),
    exitShort: (b, i, c) => crossUp(c.macdL, c.macdS, i),
    stopAtrs: 2, targetR: 99,
  }),
  D("rsi-failure-swing", "momentum", "Both", {
    long: (b, i, c) => {
      if (!F(c.rsi14[i]) || c.rsi14[i] > 35) return false;
      // bearish failure swing mirror: RSI trough then break above prior peak
      let pk = -1;
      for (let k = i - 1; k > i - 15 && k > 0; k--) {
        if (c.rsi14[k] > c.rsi14[k - 1] && c.rsi14[k] > c.rsi14[k + 1]) { pk = k; break; }
      }
      return pk > 0 && c.rsi14[i] > c.rsi14[pk];
    },
    short: (b, i, c) => {
      if (!F(c.rsi14[i]) || c.rsi14[i] < 65) return false;
      let tr = -1;
      for (let k = i - 1; k > i - 15 && k > 0; k--) {
        if (c.rsi14[k] < c.rsi14[k - 1] && c.rsi14[k] < c.rsi14[k + 1]) { tr = k; break; }
      }
      return tr > 0 && c.rsi14[i] < c.rsi14[tr];
    },
    exitLong: (b, i, c) => F(c.rsi14[i]) && c.rsi14[i] > 65,
    exitShort: (b, i, c) => F(c.rsi14[i]) && c.rsi14[i] < 35,
    stopAtrs: 1.5, targetR: 2,
  }),
  D("rsi-range-rules", "momentum", "Both", {
    long: (b, i, c) => F(c.sma200[i]) && b.c[i] > c.sma200[i] && F(c.rsi14[i]) && c.rsi14[i - 1] <= 40 && c.rsi14[i] > 40,
    short: (b, i, c) => F(c.sma200[i]) && b.c[i] < c.sma200[i] && F(c.rsi14[i]) && c.rsi14[i - 1] >= 60 && c.rsi14[i] < 60,
    exitLong: (b, i, c) => F(c.rsi14[i]) && c.rsi14[i] > 75,
    exitShort: (b, i, c) => F(c.rsi14[i]) && c.rsi14[i] < 25,
    stopAtrs: 1.5, targetR: 2,
  }),
  D("regular-bullish-bearish-divergence", "momentum", "Both", {
    long: (b, i, c) => {
      if (!F(c.rsi14[i])) return false;
      for (let k = i - 5; k > i - 30 && k > 1; k--) {
        if (c.swLo[k] === 1 && b.l[i] < b.l[k] && c.rsi14[i] > c.rsi14[k]) return true;
      }
      return false;
    },
    short: (b, i, c) => {
      if (!F(c.rsi14[i])) return false;
      for (let k = i - 5; k > i - 30 && k > 1; k--) {
        if (c.swHi[k] === 1 && b.h[i] > b.h[k] && c.rsi14[i] < c.rsi14[k]) return true;
      }
      return false;
    },
    exitLong: (b, i, c) => F(c.rsi14[i]) && c.rsi14[i] > 70,
    exitShort: (b, i, c) => F(c.rsi14[i]) && c.rsi14[i] < 30,
    stopAtrs: 1.5, targetR: 2,
  }),
  D("connors-rsi", "momentum", "Both", {
    long: (b, i, c) => F(c.sma200[i]) && F(c.crsi[i]) && b.c[i] > c.sma200[i] && c.crsi[i] < 10,
    short: (b, i, c) => F(c.sma200[i]) && F(c.crsi[i]) && b.c[i] < c.sma200[i] && c.crsi[i] > 90,
    exitLong: (b, i, c) => F(c.crsi[i]) && c.crsi[i] > 70,
    exitShort: (b, i, c) => F(c.crsi[i]) && c.crsi[i] < 30,
    stopAtrs: 1.5, targetR: 99,
  }),
  D("elder-impulse-system", "momentum", "Both", {
    long: (b, i, c) => c.elder[i] === 1 && c.elder[i - 1] !== 1,
    short: (b, i, c) => c.elder[i] === -1 && c.elder[i - 1] !== -1,
    exitLong: (b, i, c) => c.elder[i] !== 1,
    exitShort: (b, i, c) => c.elder[i] !== -1,
    stopAtrs: 1.5, targetR: 99,
  }),
  D("wave-trend-oscillator", "momentum", "Both", {
    long: (b, i, c) => F(c.wt1[i]) && c.wt1[i - 1] <= c.wt2[i - 1] && c.wt1[i] > c.wt2[i] && c.wt1[i] < -53,
    short: (b, i, c) => F(c.wt1[i]) && c.wt1[i - 1] >= c.wt2[i - 1] && c.wt1[i] < c.wt2[i] && c.wt1[i] > 53,
    exitLong: (b, i, c) => F(c.wt1[i]) && c.wt1[i] > 0,
    exitShort: (b, i, c) => F(c.wt1[i]) && c.wt1[i] < 0,
    stopAtrs: 1.5, targetR: 2,
  }),
  D("overbought-oversold", "momentum", "Both", {
    long: (b, i, c) => F(c.rsi14[i]) && F(c.adx[i]) && c.adx[i] < 20 && c.rsi14[i] < 30,
    short: (b, i, c) => F(c.rsi14[i]) && F(c.adx[i]) && c.adx[i] < 20 && c.rsi14[i] > 70,
    exitLong: (b, i, c) => F(c.rsi14[i]) && c.rsi14[i] > 50,
    exitShort: (b, i, c) => F(c.rsi14[i]) && c.rsi14[i] < 50,
    stopAtrs: 1.5, targetR: 99,
  }),
  // ---- Volatility ----
  D("bollinger-band-tag-reversion", "volatility", "Both", {
    long: (b, i, c) => F(c.bbLo[i - 1]) && b.l[i - 1] <= c.bbLo[i - 1] && b.c[i] > c.bbLo[i] && b.c[i] > b.o[i],
    short: (b, i, c) => F(c.bbUp[i - 1]) && b.h[i - 1] >= c.bbUp[i - 1] && b.c[i] < c.bbUp[i] && b.c[i] < b.o[i],
    exitLong: (b, i, c) => F(c.bbMid[i]) && b.c[i] > c.bbMid[i],
    exitShort: (b, i, c) => F(c.bbMid[i]) && b.c[i] < c.bbMid[i],
    stopAtrs: 1, targetR: 99,
  }),
  D("bollinger-squeeze", "volatility", "Both", {
    long: (b, i, c) => {
      if (!F(c.bbUp[i]) || !F(c.atr14[i])) return false;
      const w = (c.bbUp[i] - c.bbLo[i]) / b.c[i];
      let min = Infinity;
      for (let k = i - 120; k < i; k++) { if (F(c.bbUp[k])) min = Math.min(min, (c.bbUp[k] - c.bbLo[k]) / b.c[k]); }
      return w <= min * 1.05 && F(c.dc20u[i - 1]) && b.c[i] > c.dc20u[i - 1];
    },
    short: (b, i, c) => {
      if (!F(c.bbUp[i]) || !F(c.atr14[i])) return false;
      const w = (c.bbUp[i] - c.bbLo[i]) / b.c[i];
      let min = Infinity;
      for (let k = i - 120; k < i; k++) { if (F(c.bbUp[k])) min = Math.min(min, (c.bbUp[k] - c.bbLo[k]) / b.c[k]); }
      return w <= min * 1.05 && F(c.dc20l[i - 1]) && b.c[i] < c.dc20l[i - 1];
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1.5, targetR: 2,
  }),
  D("ttm-squeeze", "volatility", "Both", {
    long: (b, i, c) => {
      if (!F(c.bbUp[i]) || !F(c.kcUp[i]) || !F(c.roc[i])) return false;
      const sqPrev = c.bbUp[i - 1] < c.kcUp[i - 1] && c.bbLo[i - 1] > c.kcLo[i - 1];
      const fired = c.bbUp[i] >= c.kcUp[i] || c.bbLo[i] <= c.kcLo[i];
      return sqPrev && fired && c.roc[i] > 0 && b.c[i] > c.sma20[i];
    },
    short: (b, i, c) => {
      if (!F(c.bbUp[i]) || !F(c.kcUp[i]) || !F(c.roc[i])) return false;
      const sqPrev = c.bbUp[i - 1] < c.kcUp[i - 1] && c.bbLo[i - 1] > c.kcLo[i - 1];
      const fired = c.bbUp[i] >= c.kcUp[i] || c.bbLo[i] <= c.kcLo[i];
      return sqPrev && fired && c.roc[i] < 0 && b.c[i] < c.sma20[i];
    },
    exitLong: (b, i, c) => F(c.roc[i]) && c.roc[i] < 0,
    exitShort: (b, i, c) => F(c.roc[i]) && c.roc[i] > 0,
    stopAtrs: 1.5, targetR: 2,
  }),
  D("keltner-channels", "volatility", "Both", {
    long: (b, i, c) => F(c.kcUp[i - 1]) && F(c.adx[i]) && c.adx[i] > 20 && b.c[i - 1] <= c.kcUp[i - 1] && b.c[i] > c.kcUp[i],
    short: (b, i, c) => F(c.kcLo[i - 1]) && F(c.adx[i]) && c.adx[i] > 20 && b.c[i - 1] >= c.kcLo[i - 1] && b.c[i] < c.kcLo[i],
    exitLong: (b, i, c) => F(c.kcMid[i]) && b.c[i] < c.kcMid[i],
    exitShort: (b, i, c) => F(c.kcMid[i]) && b.c[i] > c.kcMid[i],
    stopAtrs: 1.5, targetR: 99,
  }),
  D("donchian-channels", "volatility", "Both", {
    long: (b, i, c) => F(c.dc20l[i - 1]) && b.l[i - 1] <= c.dc20l[i - 1] && b.c[i] > b.o[i] && b.c[i] < c.dc20u[i] - (c.dc20u[i] - c.dc20l[i]) * 0.25,
    short: (b, i, c) => F(c.dc20u[i - 1]) && b.h[i - 1] >= c.dc20u[i - 1] && b.c[i] < b.o[i] && b.c[i] > c.dc20l[i] + (c.dc20u[i] - c.dc20l[i]) * 0.25,
    exitLong: (b, i, c) => F(c.dc20u[i]) && b.c[i] > c.dc20u[i] - (c.dc20u[i] - c.dc20l[i]) * 0.1,
    exitShort: (b, i, c) => F(c.dc20l[i]) && b.c[i] < c.dc20l[i] + (c.dc20u[i] - c.dc20l[i]) * 0.1,
    stopAtrs: 1, targetR: 99,
  }),
  D("waddah-attar-explosion", "volatility", "Both", {
    long: (b, i, c) => {
      if (!F(c.macdH[i]) || !F(c.atr14[i]) || !F(c.ema50[i])) return false;
      const t = 0.15 * c.atr14[i] / b.c[i] * 1000;
      return b.c[i] > c.ema50[i] && c.macdH[i - 1] <= t && c.macdH[i] > t;
    },
    short: (b, i, c) => {
      if (!F(c.macdH[i]) || !F(c.atr14[i]) || !F(c.ema50[i])) return false;
      const t = 0.15 * c.atr14[i] / b.c[i] * 1000;
      return b.c[i] < c.ema50[i] && c.macdH[i - 1] >= -t && c.macdH[i] < -t;
    },
    exitLong: (b, i, c) => F(c.macdH[i]) && c.macdH[i] < 0,
    exitShort: (b, i, c) => F(c.macdH[i]) && c.macdH[i] > 0,
    stopAtrs: 1.5, targetR: 2,
  }),
  D("squeeze-release-direction", "volatility", "Both", {
    long: (b, i, c) => {
      if (!F(c.bbUp[i]) || !F(c.kcUp[i])) return false;
      let sq = 0;
      for (let k = i - 1; k > i - 12 && k > 0; k--) {
        if (c.bbUp[k] < c.kcUp[k] && c.bbLo[k] > c.kcLo[k]) sq++; else break;
      }
      const fired = c.bbUp[i] >= c.kcUp[i] || c.bbLo[i] <= c.kcLo[i];
      return sq >= 5 && fired && b.c[i] > b.c[i - sq] && b.c[i] > c.sma20[i];
    },
    short: (b, i, c) => {
      if (!F(c.bbUp[i]) || !F(c.kcUp[i])) return false;
      let sq = 0;
      for (let k = i - 1; k > i - 12 && k > 0; k--) {
        if (c.bbUp[k] < c.kcUp[k] && c.bbLo[k] > c.kcLo[k]) sq++; else break;
      }
      const fired = c.bbUp[i] >= c.kcUp[i] || c.bbLo[i] <= c.kcLo[i];
      return sq >= 5 && fired && b.c[i] < b.c[i - sq] && b.c[i] < c.sma20[i];
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1.5, targetR: 2,
  }),
  D("nr4-nr7-narrow-range-bars", "volatility", "Both", {
    long: (b, i, c) => {
      const r = b.h[i - 1] - b.l[i - 1];
      for (let k = i - 7; k < i - 1; k++) if (b.h[k] - b.l[k] < r) return false;
      return b.c[i] > b.h[i - 1];
    },
    short: (b, i, c) => {
      const r = b.h[i - 1] - b.l[i - 1];
      for (let k = i - 7; k < i - 1; k++) if (b.h[k] - b.l[k] < r) return false;
      return b.c[i] < b.l[i - 1];
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("band-walk", "volatility", "Both", {
    long: (b, i, c) => F(c.bbUp[i]) && F(c.adx[i]) && c.adx[i] > 20 &&
      b.c[i] > c.bbUp[i] && b.c[i - 1] > c.bbUp[i - 1] && b.c[i - 2] > c.bbUp[i - 2],
    short: (b, i, c) => F(c.bbLo[i]) && F(c.adx[i]) && c.adx[i] > 20 &&
      b.c[i] < c.bbLo[i] && b.c[i - 1] < c.bbLo[i - 1] && b.c[i - 2] < c.bbLo[i - 2],
    exitLong: (b, i, c) => F(c.bbMid[i]) && b.c[i] < c.bbMid[i],
    exitShort: (b, i, c) => F(c.bbMid[i]) && b.c[i] > c.bbMid[i],
    stopAtrs: 1.5, targetR: 99,
  }),
];
