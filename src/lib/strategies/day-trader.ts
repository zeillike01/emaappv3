// Top-down strategy: 4H bias -> 1H zone -> 15M sweep+BOS -> 5M FVG/engulfing entry.
// Logic is written for LONGS only; shorts run the same code on mirrored (price-negated) candles.
// This is a hypothesis, not a proven edge: backtest and forward-test before risking money.

export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };
export type Side = "long" | "short";

export interface Config {
  emaPeriod: number;      // 4H trend filter EMA
  atrPeriod: number;
  atrBuffer: number;      // stop buffer in ATR(15M) multiples
  swingN: number;         // candles each side to confirm a pivot
  minRR: number;
  riskPct: number;        // fraction of equity risked per trade, e.g. 0.01
  maxTradesPerDay: number;
  dailyLossCapPct: number; // e.g. 0.03
  sessions: Array<[number, number]>; // UTC hour windows [start, end)
  sweepLookback: number;  // 15M candles to search for a sweep
}

export const defaultConfig: Config = {
  emaPeriod: 50,
  atrPeriod: 14,
  atrBuffer: 1.0,
  swingN: 2,
  minRR: 2,
  riskPct: 0.01,
  maxTradesPerDay: 3,
  dailyLossCapPct: 0.03,
  sessions: [[7, 11], [13, 17]], // London open, New York open
  sweepLookback: 48,
};

export interface RiskState {
  equity: number;
  tradesToday: number;
  realizedPnlToday: number;
}

export interface Signal {
  side: Side;
  entry: number;
  stop: number;
  target: number;
  rr: number;
  size: number; // units of the asset
  time: number;
}

export type Result = { signal: Signal } | { signal: null; reason: string };

type Pivot = { index: number; price: number };
type Zone = { low: number; high: number; formedAt: number };
type Setup = { sweepLow: number; bosLevel: number; bosTime: number };

// ---------- indicators & helpers ----------

function emaLast(values: number[], period: number): number {
  const k = 2 / (period + 1);
  let e = values[0];
  for (let i = 1; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

function atrLast(c: Candle[], period: number): number {
  const n = Math.min(period, c.length - 1);
  let sum = 0;
  for (let i = c.length - n; i < c.length; i++) {
    const prevClose = c[i - 1].close;
    sum += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - prevClose), Math.abs(c[i].low - prevClose));
  }
  return sum / n;
}

function pivots(c: Candle[], n: number): { highs: Pivot[]; lows: Pivot[] } {
  const highs: Pivot[] = [];
  const lows: Pivot[] = [];
  for (let i = n; i < c.length - n; i++) {
    let isH = true;
    let isL = true;
    for (let k = 1; k <= n; k++) {
      if (c[i].high <= c[i - k].high || c[i].high <= c[i + k].high) isH = false;
      if (c[i].low >= c[i - k].low || c[i].low >= c[i + k].low) isL = false;
    }
    if (isH) highs.push({ index: i, price: c[i].high });
    if (isL) lows.push({ index: i, price: c[i].low });
  }
  return { highs, lows };
}

const mirror = (c: Candle[]): Candle[] =>
  c.map((x) => ({ ...x, open: -x.open, close: -x.close, high: -x.low, low: -x.high }));

const last = <T>(a: T[]): T => a[a.length - 1];

// ---------- step 1: 4H bias ----------

export function bias4H(c4h: Candle[], cfg: Config): Side | null {
  const { highs, lows } = pivots(c4h, cfg.swingN);
  if (highs.length < 2 || lows.length < 2) return null;
  const [h1, h2] = highs.slice(-2);
  const [l1, l2] = lows.slice(-2);
  const ema = emaLast(c4h.map((x) => x.close), cfg.emaPeriod);
  const close = last(c4h).close;
  if (h2.price > h1.price && l2.price > l1.price && close > ema) return "long";
  if (h2.price < h1.price && l2.price < l1.price && close < ema) return "short";
  return null; // conflicting signals -> no trade
}

// ---------- step 2: 1H demand zone (long perspective) ----------

function activeDemandZone(c1h: Candle[], cfg: Config): Zone | null {
  const { highs } = pivots(c1h, cfg.swingN);
  for (let hi = highs.length - 1; hi >= 0; hi--) {
    const h = highs[hi];
    const j = c1h.findIndex((x, i) => i > h.index && x.close > h.price); // break of structure
    if (j < 0) continue;

    // Base of the impulse: lowest-low candle shortly before the break.
    let origin = c1h[Math.max(0, h.index - 10)];
    for (let i = Math.max(0, h.index - 10); i <= j; i++) if (c1h[i].low < origin.low) origin = c1h[i];
    const zone: Zone = { low: origin.low, high: origin.high, formedAt: j };

    // Invalidated if any 1H candle closed below the zone after the break.
    if (c1h.slice(j + 1).some((x) => x.close < zone.low)) return null;
    // Active only when price has retraced into the zone.
    return last(c1h).low <= zone.high ? zone : null;
  }
  return null;
}

// ---------- step 3: 15M sweep + break of structure ----------

function sweepSetup(c15: Candle[], zone: Zone, cfg: Config): Setup | null {
  const { highs, lows } = pivots(c15, cfg.swingN);
  const start = Math.max(0, c15.length - cfg.sweepLookback);
  for (let k = c15.length - 1; k >= start; k--) {
    const cand = c15[k];
    const sl = [...lows].reverse().find((p) => p.index < k);
    const sh = [...highs].reverse().find((p) => p.index < k);
    if (!sl || !sh) continue;
    const sweptAndReclaimed = cand.low < sl.price && cand.close > sl.price;
    const insideZone = cand.low <= zone.high && cand.close > zone.low;
    if (!sweptAndReclaimed || !insideZone) continue;
    const m = c15.findIndex((x, i) => i > k && x.close > sh.price);
    if (m < 0) continue;
    return { sweepLow: cand.low, bosLevel: sh.price, bosTime: c15[m].time };
  }
  return null;
}

// ---------- step 4: 5M entry (FVG pullback + bullish engulfing) ----------

const bullEngulf = (p: Candle, c: Candle) => p.close < p.open && c.close > c.open && c.close > p.open && c.open <= p.close;

function entry5M(c5: Candle[], setup: Setup): number | null {
  const from = c5.findIndex((x) => x.time >= setup.bosTime);
  if (from < 0) return null;
  let fvg: { bottom: number; top: number; index: number } | null = null;
  for (let i = from + 2; i < c5.length; i++) {
    if (!fvg && c5[i].low > c5[i - 2].high) fvg = { bottom: c5[i - 2].high, top: c5[i].low, index: i };
  }
  if (!fvg) return null;
  const k = c5.length - 1; // only fire on the newest candle (live signal)
  if (k <= fvg.index) return null;
  const c = c5[k];
  if (c5.slice(fvg.index + 1).some((x) => x.close < fvg!.bottom)) return null; // FVG failed
  return c.low <= fvg.top && c.close > fvg.bottom && bullEngulf(c5[k - 1], c) ? c.close : null;
}

// ---------- filters ----------

export function inSession(t: number, cfg: Config): boolean {
  const d = new Date(t);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false; // skip weekends
  const h = d.getUTCHours();
  return cfg.sessions.some(([s, e]) => h >= s && h < e);
}

export function riskAllows(r: RiskState, cfg: Config): string | null {
  if (r.tradesToday >= cfg.maxTradesPerDay) return "max trades per day reached";
  if (r.realizedPnlToday <= -cfg.dailyLossCapPct * r.equity) return "daily loss cap hit";
  return null;
}

// ---------- main evaluation ----------

export function evaluate(
  data: { c4h: Candle[]; c1h: Candle[]; c15: Candle[]; c5: Candle[] },
  risk: RiskState,
  cfg: Config = defaultConfig
): Result {
  const now = last(data.c5).time;
  if (!inSession(now, cfg)) return { signal: null, reason: "outside session" };
  const blocked = riskAllows(risk, cfg);
  if (blocked) return { signal: null, reason: blocked };

  const side = bias4H(data.c4h, cfg);
  if (!side) return { signal: null, reason: "no 4H bias" };

  const flip = side === "short";
  const c1h = flip ? mirror(data.c1h) : data.c1h;
  const c15 = flip ? mirror(data.c15) : data.c15;
  const c5 = flip ? mirror(data.c5) : data.c5;

  const zone = activeDemandZone(c1h, cfg);
  if (!zone) return { signal: null, reason: "no active 1H zone" };

  const setup = sweepSetup(c15, zone, cfg);
  if (!setup) return { signal: null, reason: "no 15M sweep + BOS" };

  const entry = entry5M(c5, setup);
  if (entry === null) return { signal: null, reason: "no 5M entry trigger" };

  const stop = setup.sweepLow - cfg.atrBuffer * atrLast(c15, cfg.atrPeriod);
  const riskPerUnit = entry - stop;
  if (riskPerUnit <= 0) return { signal: null, reason: "invalid stop" };

  const target = pivots(c1h, cfg.swingN).highs
    .map((p) => p.price)
    .filter((p) => p > entry)
    .sort((a, b) => a - b)[0];
  if (target === undefined) return { signal: null, reason: "no 1H target above entry" };

  const rr = (target - entry) / riskPerUnit;
  if (rr < cfg.minRR) return { signal: null, reason: `RR ${rr.toFixed(2)} below minimum` };

  const sign = flip ? -1 : 1; // un-mirror prices
  return {
    signal: {
      side,
      entry: sign * entry,
      stop: sign * stop,
      target: sign * target,
      rr,
      size: (risk.equity * cfg.riskPct) / riskPerUnit,
      time: now,
    },
  };
}

// ---------- trade management ----------

export interface Trade {
  side: Side;
  entry: number;
  initialStop: number;
  stop: number;
  target: number;
  size: number;
  movedToBE: boolean;
  partialTaken: boolean;
}

export type Action = "none" | "move_to_breakeven" | "take_partial" | "stopped_out" | "target_hit";

// Call on every new price. Breakeven at +1R, 50% partial at +2R.
export function manage(t: Trade, price: number): { action: Action; trade: Trade } {
  const dir = t.side === "long" ? 1 : -1;
  const oneR = Math.abs(t.entry - t.initialStop);
  const r = ((price - t.entry) * dir) / oneR;

  if ((price - t.stop) * dir <= 0) return { action: "stopped_out", trade: t };
  if ((price - t.target) * dir >= 0) return { action: "target_hit", trade: t };
  if (r >= 2 && !t.partialTaken) return { action: "take_partial", trade: { ...t, partialTaken: true, size: t.size / 2 } };
  if (r >= 1 && !t.movedToBE) return { action: "move_to_breakeven", trade: { ...t, movedToBE: true, stop: t.entry } };
  return { action: "none", trade: t };
}
