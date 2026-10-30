/**
 * EMA Momentum Strategy — Scoring Engine
 *
 * Computes LONG and SHORT scores from:
 *   - EMA 8/21 momentum
 *   - Order book imbalance
 *   - Trade flow bias
 *   - Funding rate
 *   - Spread quality
 *   - ATR spike / anti-FOMO
 *   - Volume check
 *
 * Scoring starts at 50 each side, factors add/subtract.
 * Min score to qualify: 64, must beat opposite by 6+.
 */

import type { Kline, Side, SignalBreakdown, Snapshot, StrategySettings } from "./types";
import { atr, candleRangePct, ema } from "./indicators";

// ── Defaults ──

export const DEFAULT_SETTINGS: StrategySettings = {
  enabled: true,
  riskPct: 0.025,        // 2.5% risk per trade
  leverage: 50,
  minScore: 64,
  cooldownMs: 2 * 60_000, // 2 minutes between trades per symbol
  useImbalance: true,
  useFlow: true,
  skipSpike: true,
  trailing: true,
};

const START_SCORE = 50;
const MIN_SCORE = 64;
const MIN_GAP = 6; // long must beat short by this much (and vice versa)

// ── Order Book Metrics ──

export interface BookMetrics {
  bestBid: number;
  bestAsk: number;
  spreadPct: number;
  bidDepth: number;   // total notional on bid side
  askDepth: number;   // total notional on ask side
  imbalance: number;  // -1 to +1
}

export function bookMetrics(depth: { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] }, contractSize: number = 1): BookMetrics {
  const bestBid = depth.bids[0]?.price ?? 0;
  const bestAsk = depth.asks[0]?.price ?? 0;
  const mid = (bestBid + bestAsk) / 2 || bestBid || bestAsk;
  const spreadPct = mid > 0 ? ((bestAsk - bestBid) / mid) * 100 : 0;

  const bidDepth = depth.bids.reduce((s, l) => s + l.price * l.size * contractSize, 0);
  const askDepth = depth.asks.reduce((s, l) => s + l.price * l.size * contractSize, 0);
  const total = bidDepth + askDepth;
  const imbalance = total > 0 ? (bidDepth - askDepth) / total : 0;

  return { bestBid, bestAsk, spreadPct, bidDepth, askDepth, imbalance };
}

// ── Trade Flow Metrics ──

export interface FlowMetrics {
  buyVol: number;
  sellVol: number;
  bias: number; // -1 to +1
}

export function flowMetrics(
  recentTrades: { price: number; size: number; time: number; isBuyerMaker: boolean }[],
  windowMs: number = 5000,
  nowMs: number = Date.now(),
): FlowMetrics {
  const cutoff = nowMs - windowMs;
  const recent = recentTrades.filter((t) => t.time >= cutoff);

  let buyVol = 0;
  let sellVol = 0;
  for (const t of recent) {
    // isBuyerMaker=true means seller was aggressive (market sell)
    // isBuyerMaker=false means buyer was aggressive (market buy)
    if (t.isBuyerMaker) {
      sellVol += t.size;
    } else {
      buyVol += t.size;
    }
  }

  const total = buyVol + sellVol;
  const bias = total > 0 ? (buyVol - sellVol) / total : 0;

  return { buyVol, sellVol, bias };
}

// ── Scoring Engine ──

export function computeSignal(
  candles: Kline[],
  book: BookMetrics,
  flow: FlowMetrics,
  fundingRate: number,
  atrPct: number,
  currentCandleRangePct: number,
  vol24h: number,
  settings: StrategySettings = DEFAULT_SETTINGS,
): SignalBreakdown {
  let longScore = START_SCORE;
  let shortScore = START_SCORE;
  const reasons: string[] = [];
  const blockers: string[] = [];

  // ── 1. EMA Momentum (8/21) ──
  const closes = candles.map((c) => c.close);
  const ema8 = ema(closes, 8);
  const ema21 = ema(closes, 21);
  const emaFast = ema8[ema8.length - 1] ?? 0;
  const emaSlow = ema21[ema21.length - 1] ?? 0;

  if (emaFast > emaSlow) {
    longScore += 16;
    shortScore -= 10;
    reasons.push(`EMA8 > EMA21 (bullish momentum)`);
  } else if (emaFast < emaSlow) {
    shortScore += 16;
    longScore -= 10;
    reasons.push(`EMA8 < EMA21 (bearish momentum)`);
  }

  // Strong separation
  const emaGapPct = emaSlow > 0 ? ((emaFast - emaSlow) / emaSlow) * 100 : 0;
  if (emaGapPct > 0.04) {
    longScore += 6;
    reasons.push(`Strong bullish EMA gap (${emaGapPct.toFixed(3)}%)`);
  } else if (emaGapPct < -0.04) {
    shortScore += 6;
    reasons.push(`Strong bearish EMA gap (${emaGapPct.toFixed(3)}%)`);
  }

  // ── 2. Order Book Imbalance ──
  if (settings.useImbalance) {
    const imbScore = book.imbalance * 22;
    longScore += imbScore;
    shortScore -= imbScore;
    reasons.push(`Book imbalance: ${book.imbalance.toFixed(2)} (${book.imbalance > 0 ? "bid-heavy" : "ask-heavy"})`);
  }

  // ── 3. Trade Flow Bias ──
  if (settings.useFlow) {
    const flowScore = flow.bias * 22;
    longScore += flowScore;
    shortScore -= flowScore;
    reasons.push(`Flow bias: ${flow.bias.toFixed(2)} (${flow.bias > 0 ? "aggressive buying" : "aggressive selling"})`);
  }

  // ── 4. Funding Rate ──
  if (fundingRate < 0) {
    longScore += 6;
    reasons.push(`Negative funding (${fundingRate.toFixed(5)})`);
  } else if (fundingRate > 0.0002) {
    shortScore += 6;
    reasons.push(`High positive funding (${fundingRate.toFixed(5)})`);
  }

  // ── 5. Spread Quality ──
  if (book.spreadPct < 0.04) {
    longScore += 4;
    shortScore += 4;
    reasons.push(`Tight spread (${book.spreadPct.toFixed(3)}%)`);
  } else if (book.spreadPct > 0.12) {
    longScore -= 14;
    shortScore -= 14;
    blockers.push("Spread is wide");
    reasons.push(`Wide spread (${book.spreadPct.toFixed(3)}%)`);
  }

  // ── 6. ATR Spike / Anti-FOMO ──
  if (settings.skipSpike && atrPct > 0) {
    const spikeRatio = currentCandleRangePct / atrPct;
    if (spikeRatio > 2.4) {
      longScore -= 28;
      shortScore -= 28;
      blockers.push("Entry bar is an ATR spike — likely a chase");
      reasons.push(`ATR spike: candle range ${currentCandleRangePct.toFixed(2)}% vs ATR ${atrPct.toFixed(2)}% (ratio: ${spikeRatio.toFixed(1)}x)`);
    }
  }

  // ── 7. Volume Check ──
  if (!vol24h || vol24h <= 0) {
    longScore -= 20;
    shortScore -= 20;
    blockers.push("Missing 24h volume");
    reasons.push("No valid 24h volume data");
  }

  // ── Determine side ──
  let side: Side | null = null;
  if (longScore >= MIN_SCORE && longScore >= shortScore + MIN_GAP && blockers.length === 0) {
    side = "LONG";
  } else if (shortScore >= MIN_SCORE && shortScore >= longScore + MIN_GAP && blockers.length === 0) {
    side = "SHORT";
  }

  return {
    longScore,
    shortScore,
    side,
    reasons,
    blockers,
    emaFast,
    emaSlow,
    imbalance: book.imbalance,
    flow: flow.bias,
    atrPct,
    candleRangePct: currentCandleRangePct,
    spreadPct: book.spreadPct,
  };
}
