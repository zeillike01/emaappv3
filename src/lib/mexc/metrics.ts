/**
 * LAYER 1 — Fast Market Metrics
 *
 * Pure functions that compute real-time market microstructure metrics
 * from raw MEXC data. These run frequently (every few seconds) and
 * feed into the Convex strategy engine (Layer 2).
 *
 * Metrics computed:
 *   - Order Book Imbalance (bid/ask depth ratio)
 *   - Trade Flow Bias (aggressive buying vs selling)
 *   - Spread quality
 *   - ATR / volatility
 *   - Price metrics
 */

import type { Kline } from "../types";

// ── Order Book Metrics ──

export interface BookMetrics {
  bestBid: number;
  bestAsk: number;
  midPrice: number;
  spreadPct: number;
  bidDepth: number;
  askDepth: number;
  imbalance: number; // -1 to +1
}

/**
 * Compute order book metrics from raw depth snapshot.
 * Uses notional depth (price × size × contractSize) for accurate imbalance.
 */
export function computeBookMetrics(
  bids: { price: number; size: number }[],
  asks: { price: number; size: number }[],
  contractSize: number = 1,
): BookMetrics {
  const bestBid = bids[0]?.price ?? 0;
  const bestAsk = asks[0]?.price ?? 0;
  const midPrice = (bestBid + bestAsk) / 2 || bestBid || bestAsk;
  const spreadPct = midPrice > 0 ? ((bestAsk - bestBid) / midPrice) * 100 : 0;

  const bidDepth = bids.reduce((s, l) => s + l.price * l.size * contractSize, 0);
  const askDepth = asks.reduce((s, l) => s + l.price * l.size * contractSize, 0);
  const total = bidDepth + askDepth;
  const imbalance = total > 0 ? (bidDepth - askDepth) / total : 0;

  return { bestBid, bestAsk, midPrice, spreadPct, bidDepth, askDepth, imbalance };
}

// ── Trade Flow Metrics ──

export interface FlowMetrics {
  buyVol: number;
  sellVol: number;
  bias: number; // -1 to +1
  /** Trades the window actually caught. 0 means the reading is UNKNOWN, not neutral. */
  samples: number;
  /** False when the window caught no trades — `bias` is then the 0 default, not a measurement. */
  valid: boolean;
}

/**
 * Compute trade flow bias from recent trades.
 * Separates aggressive buying vs selling over a time window.
 * isBuyerMaker: true = seller aggressive (market sell), false = buyer aggressive (market buy)
 */
export function computeFlowMetrics(
  recentTrades: { price: number; size: number; time: number; isBuyerMaker: boolean }[],
  windowMs: number = 5000,
  nowMs: number = Date.now(),
): FlowMetrics {
  const cutoff = nowMs - windowMs;
  const recent = recentTrades.filter((t) => t.time >= cutoff);

  let buyVol = 0;
  let sellVol = 0;
  for (const t of recent) {
    if (t.isBuyerMaker) {
      sellVol += t.size;
    } else {
      buyVol += t.size;
    }
  }

  const total = buyVol + sellVol;
  const bias = total > 0 ? (buyVol - sellVol) / total : 0;

  // SILENCE vs BALANCE (2026-09-22). `bias` is exactly 0 in two very different
  // situations: aggressive buying genuinely offsets selling, and the window
  // caught NO TRADES AT ALL. Callers could not tell them apart, and the second
  // case dominates — the window is 5 SECONDS while the Layer-1 tick is 5
  // MINUTES, so the archived ticks carried `flowBias === 0` on 68.5% of
  // readings (3,461 of 5,054 measured on the L1 replay). Layer 2 reads 0 as a
  // neutral score contribution (harmless) but the short-flow gate reads it as
  // "no sell-flow confirmation" (a veto), so a MISSING reading was silently
  // acting as evidence. `samples`/`valid` let a caller say which case it is.
  return { buyVol, sellVol, bias, samples: recent.length, valid: recent.length > 0 };
}

// ── Volatility Metrics ──

/**
 * ATR (Average True Range) using exponential moving average of true range.
 */
export function computeATR(candles: Kline[], period: number = 14): number[] {
  if (candles.length < 2) return candles.map(() => NaN);

  const tr: number[] = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr.push(Math.max(hl, hc, lc));
  }

  // EMA of TR
  const result: number[] = [];
  const k = 2 / (period + 1);
  let prev = tr[0];
  for (let i = 0; i < tr.length; i++) {
    if (i === 0) {
      result.push(tr[0]);
    } else {
      prev = tr[i] * k + prev * (1 - k);
      result.push(prev);
    }
  }
  return result;
}

/**
 * ATR as percentage of the latest close price.
 */
export function computeAtrPct(candles: Kline[], period: number = 14): number {
  const atrValues = computeATR(candles, period);
  const lastAtr = atrValues[atrValues.length - 1];
  if (!lastAtr || !isFinite(lastAtr)) return 0;
  const lastPrice = candles[candles.length - 1]?.close;
  if (!lastPrice || lastPrice <= 0) return 0;
  return (lastAtr / lastPrice) * 100;
}

/**
 * Current candle range as percentage of price (high-low / close).
 */
export function computeCandleRangePct(candle: Kline): number {
  if (!candle || candle.close <= 0) return 0;
  return ((candle.high - candle.low) / candle.close) * 100;
}

// ── EMA (reused from indicators.ts but kept local for Layer 1) ──

export function ema(data: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  let prev = data[0];
  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      result.push(data[0]);
    } else {
      prev = data[i] * k + prev * (1 - k);
      result.push(prev);
    }
  }
  return result;
}

// ── Composite Market Snapshot ──

/**
 * All metrics needed by Layer 2, computed from raw MEXC data.
 */
export interface MarketMetrics {
  pair: string;
  lastPrice: number;
  bestBid: number;
  bestAsk: number;
  spreadPct: number;
  bidDepth: number;
  askDepth: number;
  imbalance: number;
  buyVol5s: number;
  sellVol5s: number;
  flowBias: number;
  fundingRate: number;
  atrPct: number;
  candleRangePct: number;
  vol24h: number;
  fetchedAt: number;
  klineCount: number;
}
