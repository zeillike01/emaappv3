/** Single candlestick from Binance klines API */
export interface Kline {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
  quoteVolume: number;
  trades: number;
  isClosed: boolean;
}

/** Pivot point (swing high or swing low) */
export interface Pivot {
  index: number;
  price: number;
  time: number;
  type: "high" | "low";
}

/** Detected market structure swing */
export interface Swing {
  index: number;
  price: number;
  time: number;
  type: "higher_low" | "lower_high" | "swing_low" | "swing_high";
  prevSwingIndex: number;
  prevSwingPrice: number;
}

/** Strategy state at a point in time */
export interface StrategyState {
  ema50_15m: number;
  ema75_4h: number;
  price4h: number;
  brokeAboveEma: boolean;
  brokeBelowEma: boolean;
  lastSwingHigh: Pivot | null;
  lastSwingLow: Pivot | null;
  prevSwingHigh: Pivot | null;
  prevSwingLow: Pivot | null;
  higherLowFormed: boolean;
  lowerHighFormed: boolean;
  fourHourFilterLong: boolean;
  fourHourFilterShort: boolean;
  /** Latest 4H MACD histogram (NaN when the EMA filter is used) */
  macdHistogram4h?: number;
}

/** A generated signal */
export interface Signal {
  type: "LONG" | "SHORT";
  time: number;
  price: number;
  index: number;
  ema50: number;
  ema75_4h: number;
  reason: string;
  /** Price of the confirming Higher Low (LONG) or Lower High (SHORT) swing */
  structurePrice?: number;
  /** DEFERRED ENTRY (opt-in labs, 2026-10-23): set when this entry was re-timed
   *  by the deferred-entry rule instead of taken on the signal bar. `extreme`
   *  is the over-extended high (SHORT) / low (LONG) the stop anchors to, and
   *  `waitedBars` is how long it stayed parked. Absent on ordinary signals. */
  deferral?: { extreme: number; guard: number; waitedBars: number };
}

/** Backtest trade result */
export interface Trade {
  entrySignal: Signal;
  entryPrice: number;
  entryTime: number;
  exitPrice: number | null;
  exitTime: number | null;
  pnlPercent: number | null;
  status: "open" | "closed";
  reason?: string;
}

/** Backtest summary */
export interface BacktestResult {
  trades: Trade[];
  totalTrades: number;
  winRate: number;
  avgPnl: number;
  maxDrawdown: number;
  /** NON-COMPOUNDED sum of per-trade leveraged P&L percents (a raw sum, not a
   *  return — do not read it as "account gained X%"). Use totalReturnPct. */
  totalPnl: number;
  /** Compounded return of the fixed-fractional equity curve, percent. */
  totalReturnPct: number;
  /** Per-trade Sharpe annualized by trades/year (NOT by 15m bars). */
  sharpeRatio: number;
  profitFactor: number;
  startDate: number;
  endDate: number;
  startingCapital: number;
  finalEquity: number;
  /** Compounded fixed-fractional equity curve (starts at startingCapital, one point per trade) */
  equityCurve: number[];
}

/** Symbol info */
export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  price: number;
}

/** Strategy configuration */
export interface StrategyConfig {
  symbol: string;
  lookbackBars: number;
  pivotLookback: number;
  stopLossPercent: number;
  takeProfitPercent: number;
}
