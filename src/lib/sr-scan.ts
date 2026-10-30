/**
 * SR SCAN — the shared harness behind `run-sr-score-lab.ts` and
 * `run-sr-score-backtest.ts`: load cached klines, then score every 15m candle
 * causally with the pure scorer in `sr-imbalance.ts`.
 *
 * CAUSALITY is the whole point of this file being separate. At each 15m candle
 * the scorer sees ONLY bars that had already closed: the 4H/1H windows advance
 * on closeTime, and the 15m window is truncated at the candle being scored. If
 * two scripts scored their own way, one of them would eventually see the future
 * and the other's numbers would be the wrong side of the comparison. There is
 * one implementation, here.
 *
 * Windows are bounded for speed only (see the constants); the longest component
 * lookback is 50 bars of HTF recency and 20 for volume.
 *
 * Node-only: reads the kline cache off disk, so never import from src/convex.
 */
import { getCachedKlines, type CachedKline } from "./kline-cache";
import { scoreLatestCandle, type ScoreRow, type SrParams } from "./sr-imbalance";
import type { Kline } from "./types";

/** 15m bars handed to the scorer: 30 hours, far longer than the 20-bar volume SMA. */
export const WINDOW_15M = 120;
/** HTF bars handed to the scorer: ~33 days of 4H, ~8 days of 1H. */
export const WINDOW_HTF = 200;

export type Row = {
  pair: string;
  openTime: number;
  /** Index of the scored candle inside the symbol's 15m array — the backtest
   *  needs it to walk forward; the lab ignores it. */
  barIndex: number;
  row: ScoreRow;
};

export type PairStat = {
  pair: string;
  candles: number;
  aplus: number;
  b: number;
  skip: number;
  clampedHigh: number;
  cappedCounterTrend: number;
  nowhere: number;
  first: number;
  last: number;
};

export type Loaded = { pair: string; m15: Kline[]; h1: Kline[]; h4: Kline[] };
export type ScanResult = { rows: Row[]; stats: PairStat[]; nullRows: number };

export const asKlines = (bars: readonly CachedKline[]): Kline[] =>
  bars.map((b) => ({ ...b, quoteVolume: 0, trades: 0, isClosed: true }));

export function rawSum(row: ScoreRow): number {
  return Object.values(row.components).reduce((a, b) => a + b, 0);
}

/** Read every series once — callers that sweep parameters re-score the same bars. */
export async function loadAll(pairs: string[]): Promise<Loaded[]> {
  const out: Loaded[] = [];
  for (const pair of pairs) {
    const [m15raw, h1raw, h4raw] = await Promise.all([
      getCachedKlines(pair, "15m", { localOnly: true, readOnly: true }),
      getCachedKlines(pair, "1h", { localOnly: true, readOnly: true }),
      getCachedKlines(pair, "4h", { localOnly: true, readOnly: true }),
    ]);
    if (m15raw.length === 0 || h1raw.length === 0 || h4raw.length === 0) {
      console.log(`  ${pair.padEnd(9)} no local cache for all three intervals — skipped`);
      continue;
    }
    out.push({ pair, m15: asKlines(m15raw), h1: asKlines(h1raw), h4: asKlines(h4raw) });
  }
  return out;
}

/** Score every 15m candle in the loaded set under ONE parameter set. */
export function scanLoaded(loaded: Loaded[], since: number, params: SrParams): ScanResult {
  const rows: Row[] = [];
  const stats: PairStat[] = [];
  let nullRows = 0;

  for (const { pair, m15, h1, h4 } of loaded) {
    const firstScored = m15.findIndex((b) => b.closeTime > since);
    if (firstScored < 0) continue;
    const start = Math.max(firstScored, WINDOW_15M - 1);

    let p1 = 0;
    let p4 = 0;
    const stat: PairStat = {
      pair,
      candles: 0,
      aplus: 0,
      b: 0,
      skip: 0,
      clampedHigh: 0,
      cappedCounterTrend: 0,
      nowhere: 0,
      first: m15[start]!.openTime,
      last: m15[m15.length - 1]!.openTime,
    };

    for (let i = start; i < m15.length; i++) {
      const cut = m15[i]!.closeTime;
      while (p1 < h1.length && h1[p1]!.closeTime <= cut) p1++;
      while (p4 < h4.length && h4[p4]!.closeTime <= cut) p4++;
      const row = scoreLatestCandle({
        bars4h: h4.slice(Math.max(0, p4 - WINDOW_HTF), p4),
        bars1h: h1.slice(Math.max(0, p1 - WINDOW_HTF), p1),
        bars15: m15.slice(Math.max(0, i - WINDOW_15M + 1), i + 1),
        params,
      });
      if (!row) {
        nullRows++;
        continue;
      }
      stat.candles++;
      if (row.tier === "A+") stat.aplus++;
      else if (row.tier === "B") stat.b++;
      else stat.skip++;
      if (row.location === "NOWHERE") stat.nowhere++;
      if (rawSum(row) > 100 && row.score === 100) stat.clampedHigh++;
      if (row.htfAlignment === "counter_trend" && row.score === params.counterTrendCap && rawSum(row) > params.counterTrendCap) {
        stat.cappedCounterTrend++;
      }
      rows.push({ pair, openTime: m15[i]!.openTime, barIndex: i, row });
    }
    stats.push(stat);
  }
  return { rows, stats, nullRows };
}
