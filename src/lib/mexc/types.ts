/**
 * EMA Momentum + Order Flow Strategy — Types
 *
 * Market data snapshot, trade record, position, and strategy types
 * for the real-time scoring engine.
 */

// ── Market Data ──

export type Session = "ASIA" | "LONDON" | "NEW_YORK" | "OFF_HOURS";
export type Side = "LONG" | "SHORT";
export type OrderType = "MARKET" | "LIMIT";

export interface Kline {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DepthLevel {
  price: number;
  size: number;
}

export interface DepthSnapshot {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface RecentTrade {
  price: number;
  size: number;
  time: number;
  isBuyerMaker: boolean; // true = sell aggressive, false = buy aggressive
}

export interface Ticker {
  symbol: string;
  last: number;
  bid: number;
  ask: number;
  volume24: number;
  holdVol: number; // open interest
}

export interface Snapshot {
  symbol: string;
  candles: Kline[];
  depth: DepthSnapshot;
  recentTrades: RecentTrade[];
  ticker: Ticker;
  fundingRate: number;
  btcCandles: Kline[]; // BTC 1m candles for correlation
  btcLast: number;
  meta: {
    contractSize: number;
    fetchedAt: number;
  };
}

// ── Trade Record ──

export interface TradeRecord {
  id: string;
  symbol: string;
  side: Side;
  signalTime: number;
  entryTime: number;
  signalPrice: number;
  entryPrice: number;
  exitTime?: number;
  exitPrice?: number;
  size: number;
  margin: number;
  leverage: number;
  notional: number;
  qtyCoin: number;
  orderType: OrderType;
  filledFully?: boolean;
  feeRate?: number;
  feePaid?: number;
  source: "BOT" | "MANUAL";
  status: "OPEN" | "CLOSED" | "LIQUIDATED";

  slippagePct: number;
  bestBid: number;
  bestAsk: number;
  spreadPct: number;
  latencyMs: number;

  bidDepth: number;
  askDepth: number;
  bookImbalance: number;
  aggressiveBuyVol5s: number;
  aggressiveSellVol5s: number;
  tradeFlowBias: number;
  openInterest?: number;

  volAtEntry: number;
  candleRangePct: number;
  atrPct: number;
  fundingRate?: number;
  btcPriceAtEntry?: number;
  btcChangePctSameWindow?: number;
  session: Session;

  mfePct?: number;
  maePct?: number;
  timeInTradeMs?: number;
  pnlPct?: number;
  pnlUsd?: number;
  stopPrice?: number;
  takePrice?: number;
  trailFromMfePct?: number;
}

export interface Position extends TradeRecord {
  status: "OPEN";
}

// ── Strategy ──

export interface SignalBreakdown {
  longScore: number;
  shortScore: number;
  side: Side | null;
  reasons: string[];
  blockers: string[];
  emaFast: number;
  emaSlow: number;
  imbalance: number;
  flow: number;
  atrPct: number;
  candleRangePct: number;
  spreadPct: number;
}

export interface StrategySettings {
  enabled: boolean;
  riskPct: number;
  leverage: number;
  minScore: number;
  cooldownMs: number;
  useImbalance: boolean;
  useFlow: boolean;
  skipSpike: boolean;
  trailing: boolean;
}

export interface PaperOrder {
  id: string;
  symbol: string;
  side: Side;
  orderType: OrderType;
  limitPrice?: number;
  margin: number;
  leverage: number;
  createdAt: number;
  signalPrice: number;
  signalTime: number;
  source: "BOT" | "MANUAL";
  stopPct?: number;
  takePct?: number;
}

export interface BotEvent {
  id: string;
  time: number;
  kind: "signal" | "entry" | "exit" | "skip" | "info";
  message: string;
}

export interface QualityIssue {
  tradeId: string;
  symbol: string;
  problem: string;
  fix: string;
}
