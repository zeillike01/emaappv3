/**
 * EMA Momentum Strategy — Indicators
 *
 * Pure functions for EMA, ATR, and candle metrics.
 * No side effects, no API calls.
 */

import type { Kline, Side } from "./types";

/** Exponential Moving Average */
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

/** Simple Moving Average */
export function sma(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      let sum = 0;
      for (let j = i - period + 1; j <= i; j++) sum += data[j];
      result.push(sum / period);
    }
  }
  return result;
}

/** Average True Range (ATR) from klines, using close-to-close fallback */
export function atr(candles: Kline[], period: number = 14): number[] {
  if (candles.length < 2) return candles.map(() => NaN);

  const tr: number[] = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const hl = candles[i].high - candles[i].low;
    const hc = Math.abs(candles[i].high - candles[i - 1].close);
    const lc = Math.abs(candles[i].low - candles[i - 1].close);
    tr.push(Math.max(hl, hc, lc));
  }
  return ema(tr, period);
}

/** ATR as percentage of price */
export function computeAtrPct(candles: Kline[], period: number = 14): number {
  const atrValues = atr(candles, period);
  const lastAtr = atrValues[atrValues.length - 1];
  if (!lastAtr || !isFinite(lastAtr)) return 0;
  const lastPrice = candles[candles.length - 1]?.close;
  if (!lastPrice || lastPrice <= 0) return 0;
  return (lastAtr / lastPrice) * 100;
}

/** Current candle range as percentage of price */
export function candleRangePct(candle: Kline): number {
  if (!candle || candle.close <= 0) return 0;
  return ((candle.high - candle.low) / candle.close) * 100;
}

/** Get last element of array */
export function last<T>(arr: T[]): T | undefined {
  return arr.length > 0 ? arr[arr.length - 1] : undefined;
}

/** Direction sign: +1 for LONG, -1 for SHORT */
export function dirSign(side: Side): number {
  return side === "LONG" ? 1 : -1;
}

/** Percentage move from entry to price, direction-adjusted */
export function movePct(side: Side, entry: number, price: number): number {
  if (!entry) return 0;
  return ((price - entry) / entry) * 100 * dirSign(side);
}
