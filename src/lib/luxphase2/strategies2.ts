// Strategy definitions batch 2: Volume&Flow (3), Structure (7), SMC/ICT (9), Wyckoff (3).
import type { Bars } from "./indicators";
import type { Cache, StratDef } from "./engine";
type B = Bars; type C = Cache;
const F = (v: number) => Number.isFinite(v) && !Number.isNaN(v);
const D = (slug: string, family: string, direction: "Long" | "Short" | "Both", p: Partial<StratDef>): StratDef => ({
  slug, family, direction,
  long: () => false, short: () => false, exitLong: () => false, exitShort: () => false,
  stopAtrs: 1.5, targetR: 2, timeExit: 0, alwaysIn: false, ...p,
});
const crossUp = (a: number[], b: number[], i: number) => F(a[i]) && F(a[i - 1]) && F(b[i]) && F(b[i - 1]) && a[i - 1] <= b[i - 1] && a[i] > b[i];
const crossDn = (a: number[], b: number[], i: number) => F(a[i]) && F(a[i - 1]) && F(b[i]) && F(b[i - 1]) && a[i - 1] >= b[i - 1] && a[i] < b[i];
// displacement: single-bar range > mult x ATR
const disp = (b: B, c: C, i: number, m = 1.5) => F(c.atr14[i]) && b.h[i] - b.l[i] > m * c.atr14[i];
// FVG: low[i] > high[i-2] (bullish gap)
const fvgUp = (b: B, i: number) => b.l[i] > b.h[i - 2];
const fvgDn = (b: B, i: number) => b.h[i] < b.l[i - 2];
// sweep of N-bar extreme with close back inside
const sweepHi = (b: B, c: C, i: number, p = 20) => {
  if (!F(c.dc20u[i - 1])) return false;
  return b.h[i] > c.dc20u[i - 1] && b.c[i] < c.dc20u[i - 1];
};
const sweepLo = (b: B, c: C, i: number, p = 20) => {
  if (!F(c.dc20l[i - 1])) return false;
  return b.l[i] < c.dc20l[i - 1] && b.c[i] > c.dc20l[i - 1];
};
// BOS via fractal swings
const bosUp = (b: B, c: C, i: number) => {
  for (let k = i - 1; k > i - 25 && k > 0; k--) if (c.swHi[k] === 1 && b.c[i] > b.h[k]) return true;
  return false;
};
const bosDn = (b: B, c: C, i: number) => {
  for (let k = i - 1; k > i - 25 && k > 0; k--) if (c.swLo[k] === 1 && b.c[i] < b.l[k]) return true;
  return false;
};

export const S2: StratDef[] = [
  D("session-vwap", "volume-orderflow", "Both", {
    long: (b, i, c) => F(c.vwap[i]) && b.c[i - 1] <= c.vwap[i - 1] && b.c[i] > c.vwap[i],
    short: (b, i, c) => F(c.vwap[i]) && b.c[i - 1] >= c.vwap[i - 1] && b.c[i] < c.vwap[i],
    exitLong: (b, i, c) => F(c.vwap[i]) && b.c[i] < c.vwap[i],
    exitShort: (b, i, c) => F(c.vwap[i]) && b.c[i] > c.vwap[i],
    stopAtrs: 1, targetR: 2,
  }),
  D("anchored-vwap", "volume-orderflow", "Both", {
    // anchor: 120-bar high/low; trade pullback touches holding the AVWAP
    long: (b, i, c) => {
      let hi = -Infinity, hx = 0;
      for (let k = i - 120; k < i; k++) if (b.h[k] > hi) { hi = b.h[k]; hx = k; }
      if (hx <= i - 120) return false;
      let pv = 0, vv = 0;
      for (let k = hx; k <= i; k++) { const tp = (b.h[k] + b.l[k] + b.c[k]) / 3; pv += tp * b.v[k]; vv += b.v[k]; }
      const av = vv > 0 ? pv / vv : NaN;
      if (!F(av) || !F(c.atr14[i])) return false;
      return b.l[i] <= av + 0.1 * c.atr14[i] && b.c[i] > av && b.c[i] > b.o[i];
    },
    short: (b, i, c) => {
      let lo = Infinity, lx = 0;
      for (let k = i - 120; k < i; k++) if (b.l[k] < lo) { lo = b.l[k]; lx = k; }
      if (lx <= i - 120) return false;
      let pv = 0, vv = 0;
      for (let k = lx; k <= i; k++) { const tp = (b.h[k] + b.l[k] + b.c[k]) / 3; pv += tp * b.v[k]; vv += b.v[k]; }
      const av = vv > 0 ? pv / vv : NaN;
      if (!F(av) || !F(c.atr14[i])) return false;
      return b.h[i] >= av - 0.1 * c.atr14[i] && b.c[i] < av && b.c[i] < b.o[i];
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("vwap-mean-reversion-vs-trend-regimes", "volume-orderflow", "Both", {
    long: (b, i, c) => {
      if (!F(c.vwap[i]) || !F(c.adx[i]) || !F(c.atr14[i])) return false;
      if (c.adx[i] > 25) return b.c[i - 1] <= c.vwap[i - 1] && b.c[i] > c.vwap[i] && b.c[i] > c.ema50[i];
      return c.vwap[i] - b.c[i] > c.atr14[i] && b.c[i] > b.o[i];
    },
    short: (b, i, c) => {
      if (!F(c.vwap[i]) || !F(c.adx[i]) || !F(c.atr14[i])) return false;
      if (c.adx[i] > 25) return b.c[i - 1] >= c.vwap[i - 1] && b.c[i] < c.vwap[i] && b.c[i] < c.ema50[i];
      return b.c[i] - c.vwap[i] > c.atr14[i] && b.c[i] < b.o[i];
    },
    exitLong: (b, i, c) => F(c.vwap[i]) && b.c[i] > c.vwap[i] && F(c.adx[i]) && c.adx[i] <= 25,
    exitShort: (b, i, c) => F(c.vwap[i]) && b.c[i] < c.vwap[i] && F(c.adx[i]) && c.adx[i] <= 25,
    stopAtrs: 1, targetR: 2,
  }),
  // ---- Structure ----
  D("break-of-structure", "market-structure", "Both", {
    long: (b, i, c) => bosUp(b, c, i) && disp(b, c, i, 1.0),
    short: (b, i, c) => bosDn(b, c, i) && disp(b, c, i, 1.0),
    exitLong: (b, i, c) => bosDn(b, c, i),
    exitShort: (b, i, c) => bosUp(b, c, i),
    stopAtrs: 1.5, targetR: 2,
  }),
  D("change-of-character", "market-structure", "Both", {
    long: (b, i, c) => {
      // prior bearish BOS within 30 bars, now bullish BOS with displacement
      for (let k = i - 1; k > i - 30 && k > 0; k--) {
        for (let m = k - 1; m > k - 25 && m > 0; m--) {
          if (c.swLo[m] === 1 && b.c[k] < b.l[m]) {
            if (bosUp(b, c, i) && disp(b, c, i, 1.5)) return true;
            break;
          }
        }
      }
      return false;
    },
    short: (b, i, c) => {
      for (let k = i - 1; k > i - 30 && k > 0; k--) {
        for (let m = k - 1; m > k - 25 && m > 0; m--) {
          if (c.swHi[m] === 1 && b.c[k] > b.h[m]) {
            if (bosDn(b, c, i) && disp(b, c, i, 1.5)) return true;
            break;
          }
        }
      }
      return false;
    },
    exitLong: (b, i, c) => bosDn(b, c, i),
    exitShort: (b, i, c) => bosUp(b, c, i),
    stopAtrs: 1.5, targetR: 2,
  }),
  D("swing-failure-pattern", "market-structure", "Both", {
    long: (b, i, c) => {
      for (let k = i - 1; k > i - 10 && k > 0; k--) {
        if (c.swLo[k] === 1 && b.l[i - 1] < b.l[k] && b.c[i - 1] > b.l[k] && b.c[i] > b.o[i] && b.c[i] > c.sma20[i]) return true;
      }
      return false;
    },
    short: (b, i, c) => {
      for (let k = i - 1; k > i - 10 && k > 0; k--) {
        if (c.swHi[k] === 1 && b.h[i - 1] > b.h[k] && b.c[i - 1] < b.h[k] && b.c[i] < b.o[i] && b.c[i] < c.sma20[i]) return true;
      }
      return false;
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("turtle-soup", "market-structure", "Both", {
    long: (b, i, c) => {
      if (!F(c.dc20l[i - 3])) return false;
      for (let k = i - 3; k < i; k++) {
        if (b.l[k] < c.dc20l[k - 1] && b.c[i] > c.dc20l[k - 1] && b.c[i] > b.o[i]) return true;
      }
      return false;
    },
    short: (b, i, c) => {
      if (!F(c.dc20u[i - 3])) return false;
      for (let k = i - 3; k < i; k++) {
        if (b.h[k] > c.dc20u[k - 1] && b.c[i] < c.dc20u[k - 1] && b.c[i] < b.o[i]) return true;
      }
      return false;
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && b.c[i] > c.dc20u[i] - (c.dc20u[i] - c.dc20l[i]) * 0.25,
    exitShort: (b, i, c) => F(c.sma20[i]) && b.c[i] < c.dc20l[i] + (c.dc20u[i] - c.dc20l[i]) * 0.25,
    stopAtrs: 1, targetR: 99,
  }),
  D("1-2-3-reversal", "market-structure", "Both", {
    long: (b, i, c) => {
      // (1) swing low, (2) rally BOS up, (3) higher-low hold then break of micro high
      for (let k = i - 2; k > i - 30 && k > 0; k--) {
        if (c.swLo[k] === 1 && bosUp(b, c, i - 1)) {
          let hl = false;
          for (let m = k + 1; m < i; m++) if (b.l[m] > b.l[k] && c.swLo[m] === 1) hl = true;
          if (hl && b.c[i] > b.h[i - 1] && b.c[i] > c.sma20[i]) return true;
          break;
        }
      }
      return false;
    },
    short: (b, i, c) => {
      for (let k = i - 2; k > i - 30 && k > 0; k--) {
        if (c.swHi[k] === 1 && bosDn(b, c, i - 1)) {
          let lh = false;
          for (let m = k + 1; m < i; m++) if (b.h[m] < b.h[k] && c.swHi[m] === 1) lh = true;
          if (lh && b.c[i] < b.l[i - 1] && b.c[i] < c.sma20[i]) return true;
          break;
        }
      }
      return false;
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1.5, targetR: 2,
  }),
  D("breakout-pullback-continuation", "market-structure", "Both", {
    long: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      for (let k = i - 1; k > i - 10 && k > 0; k--) {
        if (F(c.dc20u[k - 1]) && b.c[k] > c.dc20u[k - 1]) {
          const lvl = c.dc20u[k - 1];
          if (b.l[i] <= lvl + 0.5 * c.atr14[i] && b.l[i] >= lvl - 0.5 * c.atr14[i] && b.c[i] > b.o[i] && b.c[i] > lvl) return true;
          break;
        }
      }
      return false;
    },
    short: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      for (let k = i - 1; k > i - 10 && k > 0; k--) {
        if (F(c.dc20l[k - 1]) && b.c[k] < c.dc20l[k - 1]) {
          const lvl = c.dc20l[k - 1];
          if (b.h[i] >= lvl - 0.5 * c.atr14[i] && b.h[i] <= lvl + 0.5 * c.atr14[i] && b.c[i] < b.o[i] && b.c[i] < lvl) return true;
          break;
        }
      }
      return false;
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("false-breakout", "market-structure", "Both", {
    long: (b, i, c) => {
      if (!F(c.dc20l[i - 2])) return false;
      for (let k = i - 2; k < i; k++) {
        if (b.l[k] < c.dc20l[k - 1] && b.c[k] > c.dc20l[k - 1] && b.c[i] > c.sma20[i]) return true;
      }
      return false;
    },
    short: (b, i, c) => {
      if (!F(c.dc20u[i - 2])) return false;
      for (let k = i - 2; k < i; k++) {
        if (b.h[k] > c.dc20u[k - 1] && b.c[k] < c.dc20u[k - 1] && b.c[i] < c.sma20[i]) return true;
      }
      return false;
    },
    exitLong: (b, i, c) => F(c.dc20u[i]) && b.c[i] > c.dc20u[i] - (c.dc20u[i] - c.dc20l[i]) * 0.15,
    exitShort: (b, i, c) => F(c.dc20l[i]) && b.c[i] < c.dc20l[i] + (c.dc20u[i] - c.dc20l[i]) * 0.15,
    stopAtrs: 1, targetR: 99,
  }),
  // ---- SMC/ICT ----
  D("bullish-bearish-order-block", "smc-ict", "Both", {
    long: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      for (let k = i - 1; k > i - 10 && k > 0; k--) {
        // last down candle before up-displacement BOS
        if (b.c[k] < b.o[k] && disp(b, c, k + 1, 1.5) && bosUp(b, c, k + 1)) {
          if (b.l[i] <= b.h[k] && b.l[i] >= b.l[k] - 0.25 * c.atr14[i] && b.c[i] > b.o[i]) return true;
          break;
        }
      }
      return false;
    },
    short: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      for (let k = i - 1; k > i - 10 && k > 0; k--) {
        if (b.c[k] > b.o[k] && disp(b, c, k + 1, 1.5) && bosDn(b, c, k + 1)) {
          if (b.h[i] >= b.l[k] && b.h[i] <= b.h[k] + 0.25 * c.atr14[i] && b.c[i] < b.o[i]) return true;
          break;
        }
      }
      return false;
    },
    exitLong: (b, i, c) => bosDn(b, c, i),
    exitShort: (b, i, c) => bosUp(b, c, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("breaker-block", "smc-ict", "Both", {
    long: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      for (let k = i - 1; k > i - 15 && k > 0; k--) {
        // bearish OB that got closed through, now retested from above
        if (b.c[k] > b.o[k] && b.c[k + 1] !== undefined) {
          const broke = b.c.slice(k + 1, i).some((v) => v > b.h[k]);
          if (broke && b.l[i] <= b.h[k] + 0.25 * c.atr14[i] && b.l[i] >= b.l[k] - 0.25 * c.atr14[i] && b.c[i] > b.o[i]) return true;
        }
      }
      return false;
    },
    short: (b, i, c) => {
      if (!F(c.atr14[i])) return false;
      for (let k = i - 1; k > i - 15 && k > 0; k--) {
        if (b.c[k] < b.o[k] && b.c[k + 1] !== undefined) {
          const broke = b.c.slice(k + 1, i).some((v) => v < b.l[k]);
          if (broke && b.h[i] >= b.l[k] - 0.25 * c.atr14[i] && b.h[i] <= b.h[k] + 0.25 * c.atr14[i] && b.c[i] < b.o[i]) return true;
          break;
        }
      }
      return false;
    },
    exitLong: (b, i, c) => bosDn(b, c, i),
    exitShort: (b, i, c) => bosUp(b, c, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("fair-value-gap", "smc-ict", "Both", {
    long: (b, i, c) => {
      if (!F(c.atr14[i]) || !F(c.ema200[i])) return false;
      for (let k = i - 1; k > i - 8 && k > 2; k--) {
        if (fvgUp(b, k) && b.c[i] > c.ema200[i]) {
          if (b.l[i] <= b.l[k] && b.l[i] >= b.h[k - 2] - 0.1 * c.atr14[i] && b.c[i] > b.o[i]) return true;
        }
      }
      return false;
    },
    short: (b, i, c) => {
      if (!F(c.atr14[i]) || !F(c.ema200[i])) return false;
      for (let k = i - 1; k > i - 8 && k > 2; k--) {
        if (fvgDn(b, k) && b.c[i] < c.ema200[i]) {
          if (b.h[i] >= b.h[k] && b.h[i] <= b.l[k - 2] + 0.1 * c.atr14[i] && b.c[i] < b.o[i]) return true;
        }
      }
      return false;
    },
    exitLong: (b, i, c) => bosDn(b, c, i),
    exitShort: (b, i, c) => bosUp(b, c, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("fvg-behavior-rules", "smc-ict", "Both", {
    long: (b, i, c) => {
      if (!F(c.atr14[i]) || !F(c.ema200[i]) || b.c[i] < c.ema200[i]) return false;
      for (let k = i - 1; k > i - 8 && k > 2; k--) {
        if (fvgUp(b, k) && bosUp(b, c, k + 1 > i - 1 ? i - 1 : k + 1)) {
          if (b.l[i] <= b.l[k] && b.l[i] >= b.h[k - 2] && b.c[i] > b.o[i]) return true;
        }
      }
      return false;
    },
    short: (b, i, c) => {
      if (!F(c.atr14[i]) || !F(c.ema200[i]) || b.c[i] > c.ema200[i]) return false;
      for (let k = i - 1; k > i - 8 && k > 2; k--) {
        if (fvgDn(b, k) && bosDn(b, c, k + 1 > i - 1 ? i - 1 : k + 1)) {
          if (b.h[i] >= b.h[k] && b.h[i] <= b.l[k - 2] && b.c[i] < b.o[i]) return true;
          break;
        }
      }
      return false;
    },
    exitLong: (b, i, c) => bosDn(b, c, i),
    exitShort: (b, i, c) => bosUp(b, c, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("liquidity-sweep", "smc-ict", "Both", {
    long: (b, i, c) => {
      if (!sweepLo(b, c, i - 1)) return false;
      return bosUp(b, c, i) && b.c[i] > b.o[i];
    },
    short: (b, i, c) => {
      if (!sweepHi(b, c, i - 1)) return false;
      return bosDn(b, c, i) && b.c[i] < b.o[i];
    },
    exitLong: (b, i, c) => bosDn(b, c, i),
    exitShort: (b, i, c) => bosUp(b, c, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("silver-bullet", "smc-ict", "Both", {
    long: (b, i, c) => {
      const hr = new Date(b.t[i]).getUTCHours();
      if (hr < 13 || hr >= 16) return false;
      if (!sweepLo(b, c, i - 1) && !sweepLo(b, c, i - 2)) return false;
      return disp(b, c, i, 1.2) && b.c[i] > b.o[i];
    },
    short: (b, i, c) => {
      const hr = new Date(b.t[i]).getUTCHours();
      if (hr < 13 || hr >= 16) return false;
      if (!sweepHi(b, c, i - 1) && !sweepHi(b, c, i - 2)) return false;
      return disp(b, c, i, 1.2) && b.c[i] < b.o[i];
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("optimal-trade-entry", "smc-ict", "Both", {
    long: (b, i, c) => {
      // impulse leg low->high with BOS, price retraced into 62-79% zone
      for (let a = i - 30; a < i - 3; a++) {
        if (a < 0) continue;
        let hi = -Infinity, hx = a;
        for (let k = a; k < Math.min(a + 15, i); k++) if (b.h[k] > hi) { hi = b.h[k]; hx = k; }
        const lo = b.l[a];
        if (hi - lo <= 0 || !bosUp(b, c, hx)) continue;
        const r62 = hi - 0.62 * (hi - lo), r79 = hi - 0.79 * (hi - lo);
        if (b.l[i] <= r62 && b.l[i] >= r79 - (hi - lo) * 0.05 && b.c[i] > b.o[i]) return true;
        break;
      }
      return false;
    },
    short: (b, i, c) => {
      for (let a = i - 30; a < i - 3; a++) {
        if (a < 0) continue;
        let lo = Infinity, lx = a;
        for (let k = a; k < Math.min(a + 15, i); k++) if (b.l[k] < lo) { lo = b.l[k]; lx = k; }
        const hi = b.h[a];
        if (hi - lo <= 0 || !bosDn(b, c, lx)) continue;
        const r62 = lo + 0.62 * (hi - lo), r79 = lo + 0.79 * (hi - lo);
        if (b.h[i] >= r62 && b.h[i] <= r79 + (hi - lo) * 0.05 && b.c[i] < b.o[i]) return true;
        break;
      }
      return false;
    },
    exitLong: (b, i, c) => bosDn(b, c, i),
    exitShort: (b, i, c) => bosUp(b, c, i),
    stopAtrs: 1, targetR: 2,
  }),
  D("mitigation-block", "smc-ict", "Both", {
    long: (b, i, c) => {
      // origin leg low, 50% (consequent encroachment) touched and holding
      for (let a = i - 30; a < i - 3; a++) {
        if (a < 0) continue;
        let hi = -Infinity, hx = a;
        for (let k = a; k < Math.min(a + 15, i); k++) if (b.h[k] > hi) { hi = b.h[k]; hx = k; }
        const lo = b.l[a];
        if (hi - lo <= 0 || !bosUp(b, c, hx)) continue;
        const mid = (hi + lo) / 2;
        if (Math.abs(b.l[i] - mid) < (hi - lo) * 0.05 && b.c[i] > b.o[i] && b.c[i] > mid) return true;
        break;
      }
      return false;
    },
    short: (b, i, c) => {
      for (let a = i - 30; a < i - 3; a++) {
        if (a < 0) continue;
        let lo = Infinity, lx = a;
        for (let k = a; k < Math.min(a + 15, i); k++) if (b.l[k] < lo) { lo = b.l[k]; lx = k; }
        const hi = b.h[a];
        if (hi - lo <= 0 || !bosDn(b, c, lx)) continue;
        const mid = (hi + lo) / 2;
        if (Math.abs(b.h[i] - mid) < (hi - lo) * 0.05 && b.c[i] < b.o[i] && b.c[i] < mid) return true;
        break;
      }
      return false;
    },
    exitLong: (b, i, c) => bosDn(b, c, i),
    exitShort: (b, i, c) => bosUp(b, c, i),
    stopAtrs: 1.5, targetR: 2,
  }),
  D("killzones", "smc-ict", "Both", {
    long: (b, i, c) => {
      const hr = new Date(b.t[i]).getUTCHours();
      if (!((hr >= 7 && hr < 10) || (hr >= 12 && hr < 15))) return false;
      // Asian range 00-07 UTC high broken
      let ah = -Infinity;
      const day = new Date(b.t[i]).toISOString().slice(0, 10);
      for (let k = i - 1; k > 0 && new Date(b.t[k]).toISOString().slice(0, 10) === day; k--) {
        if (new Date(b.t[k]).getUTCHours() < 7) ah = Math.max(ah, b.h[k]);
      }
      if (!Number.isFinite(ah)) return false;
      return b.c[i - 1] <= ah && b.c[i] > ah;
    },
    short: (b, i, c) => {
      const hr = new Date(b.t[i]).getUTCHours();
      if (!((hr >= 7 && hr < 10) || (hr >= 12 && hr < 15))) return false;
      let al = Infinity;
      const day = new Date(b.t[i]).toISOString().slice(0, 10);
      for (let k = i - 1; k > 0 && new Date(b.t[k]).toISOString().slice(0, 10) === day; k--) {
        if (new Date(b.t[k]).getUTCHours() < 7) al = Math.min(al, b.l[k]);
      }
      if (!Number.isFinite(al)) return false;
      return b.c[i - 1] >= al && b.c[i] < al;
    },
    exitLong: (b, i, c) => F(c.sma20[i]) && crossDn(b.c, c.sma20, i),
    exitShort: (b, i, c) => F(c.sma20[i]) && crossUp(b.c, c.sma20, i),
    stopAtrs: 1.5, targetR: 2,
  }),
  // ---- Wyckoff ----
  D("spring", "wyckoff", "Long", {
    long: (b, i, c) => {
      if (!F(c.dc20l[i - 1]) || !F(c.adx[i]) || c.adx[i] > 25) return false;
      return b.l[i - 1] < c.dc20l[i - 2] && b.c[i - 1] > c.dc20l[i - 2] && b.c[i] > b.o[i] && b.c[i] > c.sma20[i];
    },
    short: () => false,
    exitLong: (b, i, c) => F(c.dc20u[i]) && b.c[i] > c.dc20u[i] - (c.dc20u[i] - c.dc20l[i]) * 0.15,
    exitShort: () => false,
    stopAtrs: 1, targetR: 99,
  }),
  D("upthrust", "wyckoff", "Short", {
    long: () => false,
    short: (b, i, c) => {
      if (!F(c.dc20u[i - 1]) || !F(c.adx[i]) || c.adx[i] > 25) return false;
      return b.h[i - 1] > c.dc20u[i - 2] && b.c[i - 1] < c.dc20u[i - 2] && b.c[i] < b.o[i] && b.c[i] < c.sma20[i];
    },
    exitLong: () => false,
    exitShort: (b, i, c) => F(c.dc20l[i]) && b.c[i] < c.dc20l[i] + (c.dc20u[i] - c.dc20l[i]) * 0.15,
    stopAtrs: 1, targetR: 99,
  }),
  D("wyckoff-accumulation-schematic", "wyckoff", "Both", {
    long: (b, i, c) => {
      if (!F(c.dc20l[i - 1]) || !F(c.adx[i]) || c.adx[i] > 22) return false;
      const sprung = b.l[i - 2] < c.dc20l[i - 3] && b.c[i - 2] > c.dc20l[i - 3];
      return sprung && bosUp(b, c, i) && b.c[i] > b.o[i];
    },
    short: (b, i, c) => {
      if (!F(c.dc20u[i - 1]) || !F(c.adx[i]) || c.adx[i] > 22) return false;
      const ut = b.h[i - 2] > c.dc20u[i - 3] && b.c[i - 2] < c.dc20u[i - 3];
      return ut && bosDn(b, c, i) && b.c[i] < b.o[i];
    },
    exitLong: (b, i, c) => F(c.dc20u[i]) && b.c[i] > c.dc20u[i] - (c.dc20u[i] - c.dc20l[i]) * 0.15,
    exitShort: (b, i, c) => F(c.dc20l[i]) && b.c[i] < c.dc20l[i] + (c.dc20u[i] - c.dc20l[i]) * 0.15,
    stopAtrs: 1, targetR: 99,
  }),
];
export { disp, bosUp, bosDn, sweepHi, sweepLo, fvgUp, fvgDn, crossUp, crossDn };
