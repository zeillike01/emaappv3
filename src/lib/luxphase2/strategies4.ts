// Original strategies batch 4 (5): designed from 4Y findings (see MEGA_4Y_REPORT.md §Bonus).
// - 4Y winners to lean into: harmonics (only robust family), ADX-gated trend breaks,
//   range structure; failure modes to avoid: high-churn counter-trend fading, fixed-2R
//   targets that truncate trends, entries without a regime gate.
// All signals use confirmed closes only (i / i-1); fills are next-bar-open via engine.
import type { Bars } from "./indicators";
import type { Cache, StratDef } from "./engine";
type B = Bars; type C = Cache;
const F = (v: number) => Number.isFinite(v) && !Number.isNaN(v);
const D = (slug: string, family: string, direction: "Long" | "Short" | "Both", p: Partial<StratDef>): StratDef => ({
  slug, family, direction,
  long: () => false, short: () => false, exitLong: () => false, exitShort: () => false,
  stopAtrs: 1.5, targetR: 2, timeExit: 0, alwaysIn: false, ...p,
});

export const S4: StratDef[] = [
  D("orig-harmonic-pullback", "original", "Both", {
    // Harmonic swing point + RSI-2 stretch inside an EMA200 trend filter.
    long: (b, i, c) => {
      if (!F(c.rsi2[i]) || !F(c.ema200[i])) return false;
      // swings(b,3,3) confirms pivot k only at k+3: use k <= i-3 (confirmed).
      let swing = false;
      for (let k = i - 3; k > i - 9 && k > 0; k--) if (c.swLo[k] === 1) { swing = true; break; }
      return swing && c.rsi2[i] < 30 && b.c[i] > c.ema200[i];
    },
    short: (b, i, c) => {
      if (!F(c.rsi2[i]) || !F(c.ema200[i])) return false;
      let swing = false;
      for (let k = i - 3; k > i - 9 && k > 0; k--) if (c.swHi[k] === 1) { swing = true; break; }
      return swing && c.rsi2[i] > 70 && b.c[i] < c.ema200[i];
    },
    exitLong: (b, i, c) => F(c.rsi2[i]) && c.rsi2[i] > 60,
    exitShort: (b, i, c) => F(c.rsi2[i]) && c.rsi2[i] < 40,
    stopAtrs: 1.5, targetR: 2,
  }),
  D("orig-adx-donchian", "original", "Both", {
    // Donchian-20 breakout gated to its winning regime: ADX > 25 + EMA200 side.
    long: (b, i, c) =>
      F(c.dc20u[i - 1]) && F(c.adx[i]) && F(c.ema200[i]) &&
      b.c[i] > c.dc20u[i - 1] && c.adx[i] > 25 && b.c[i] > c.ema200[i],
    short: (b, i, c) =>
      F(c.dc20l[i - 1]) && F(c.adx[i]) && F(c.ema200[i]) &&
      b.c[i] < c.dc20l[i - 1] && c.adx[i] > 25 && b.c[i] < c.ema200[i],
    exitLong: (b, i, c) => F(c.dc10l[i]) && b.c[i] < c.dc10l[i],
    exitShort: (b, i, c) => F(c.dc10u[i]) && b.c[i] > c.dc10u[i],
    stopAtrs: 2, targetR: 99,
  }),
  D("orig-range-fade", "original", "Both", {
    // Dedicated ranging specialist: Bollinger tag fade only while ADX < 20.
    long: (b, i, c) =>
      F(c.bbLo[i]) && F(c.adx[i]) && c.adx[i] < 20 && b.c[i] < c.bbLo[i],
    short: (b, i, c) =>
      F(c.bbUp[i]) && F(c.adx[i]) && c.adx[i] < 20 && b.c[i] > c.bbUp[i],
    exitLong: (b, i, c) => F(c.bbMid[i]) && b.c[i] > c.bbMid[i],
    exitShort: (b, i, c) => F(c.bbMid[i]) && b.c[i] < c.bbMid[i],
    stopAtrs: 1.5, targetR: 2,
  }),
  D("orig-squeeze-expansion", "original", "Both", {
    // BB-in-KC squeeze at i-1 releasing at i + ROC(12) direction + ATR expansion.
    long: (b, i, c) => {
      if (!F(c.bbUp[i - 1]) || !F(c.kcUp[i - 1]) || !F(c.roc[i]) || !F(c.atr14[i]) || !F(c.atr14[i - 1])) return false;
      const wasSq = (c.bbUp[i - 1] - c.bbLo[i - 1]) < (c.kcUp[i - 1] - c.kcLo[i - 1]);
      return wasSq && c.roc[i] > 0 && c.atr14[i] > c.atr14[i - 1];
    },
    short: (b, i, c) => {
      if (!F(c.bbUp[i - 1]) || !F(c.kcUp[i - 1]) || !F(c.roc[i]) || !F(c.atr14[i]) || !F(c.atr14[i - 1])) return false;
      const wasSq = (c.bbUp[i - 1] - c.bbLo[i - 1]) < (c.kcUp[i - 1] - c.kcLo[i - 1]);
      return wasSq && c.roc[i] < 0 && c.atr14[i] > c.atr14[i - 1];
    },
    exitLong: (b, i, c) => F(c.roc[i]) && c.roc[i] < 0,
    exitShort: (b, i, c) => F(c.roc[i]) && c.roc[i] > 0,
    stopAtrs: 1.5, targetR: 3,
  }),
  D("orig-psar-chandelier", "original", "Both", {
    // PSAR flip entry with a structural Chandelier(22,3) trailing exit (runner).
    long: (b, i, c) =>
      F(c.sar[i]) && F(c.sar[i - 1]) && b.c[i - 1] < c.sar[i - 1] && b.c[i] > c.sar[i],
    short: (b, i, c) =>
      F(c.sar[i]) && F(c.sar[i - 1]) && b.c[i - 1] > c.sar[i - 1] && b.c[i] < c.sar[i],
    exitLong: (b, i, c) => F(c.chandL[i]) && b.c[i] < c.chandL[i],
    exitShort: (b, i, c) => F(c.chandS[i]) && b.c[i] > c.chandS[i],
    stopAtrs: 2, targetR: 99,
  }),
];
