/**
 * Per-pair strategy configuration — reversal variant, EMA 41 trigger.
 *
 * Reversal variant: failed LL/HH → 15m EMA break entry
 * 4H MACD(8,17,9) filter · 3m EMA 31 confirm · ratchet TP (3R lock, 20R cap)
 * structure-anchored SL · full friction.
 */
export interface PairConfig {
  ema15m: number;      // EMA period for 15m entry (reversal: 41)
  ema4h: number;       // (reserved for future per-pair 4H EMA filter)
  slPct: number;       // Stop loss as decimal (0.003 = 0.3%)
  tpPct: number;       // Take profit as decimal (0.012 = 1.2%)
  maxLev: number;      // Max leverage (Hyperliquid cap)
  riskPct: number;     // Max risk per trade as decimal (0.01 = 1% of account)
  /** Confirmation timeframe: "3m" or "5m" */
  confirmTf: string;
  /** EMA period on the confirmation timeframe */
  confirmEma: number;
  /** Pivot lookback for HL/LH detection (LB5 best quality) */
  pivotLookback: number;
}

export const PAIR_CONFIGS: Record<string, PairConfig> = {
  // Reversal variant, EMA 41, 4H MACD, 3m EMA 31 confirm, ratchet 3R→20R
  // Book rebuilt from the MEXC screener (run-mexc-screener.ts, 30d, best config):
  // kept only pairs with PF >= 1.1 and positive PnL. Cut: BTC (-128%), ETH
  // (one-trade profit, -49% DD), ENA (-129%, flipped sign between windows),
  // DOGE (-146%), DOT (never screened), HYPE/AAVE (toxic, earlier audit).
  SOL:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  ADA:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  PEPE:     { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  OP:       { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  NEAR:     { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  INJ:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  FARTCOIN: { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  ARB:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  // Added 2026-09-11 (universe re-add: ARB/TAO/SUI) — ARB/SUI configs already
  // exist above; TAO matches book defaults.
  TAO:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  // PEPE-like coins (scored by ATR%, DX, body ratio, range)
  JTO:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  GRASS:    { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  JASMY:    { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  PYTH:     { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  WIF:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  PENDLE:   { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  // Newly added coins (volume-spike data gathering)
  AVAX:     { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  DOT:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  DOGE:     { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  LINK:     { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  SUI:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  HYPE:     { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  XRP:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  FET:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  FLOKI:    { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  RENDER:   { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  TIA:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  APT:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  SEI:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  WLD:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  // Added 2026-09-07 (book swap: JTO/SUI out): behavior matches to INJ/TIA
  // that cleared the 90d book-config engine check (+104.6R / +102.0R).
  ONDO:     { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
  ZEC:      { ema15m: 41, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 50, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 },
};

/** Get config for a coin, falling back to defaults */
export function getPairConfig(coin: string): PairConfig {
  return PAIR_CONFIGS[coin] ?? { ema15m: 50, ema4h: 75, slPct: 0.003, tpPct: 0.012, maxLev: 40, riskPct: 0.025, confirmTf: "3m", confirmEma: 31, pivotLookback: 10 };
}

/**
 * Size step (minimum increment) per coin on Hyperliquid.
 * BTC: 0.001, ETH: 0.01, HYPE: 1
 */
export const SIZE_STEP: Record<string, number> = {
  BTC: 0.001,
  ETH: 0.01,
  HYPE: 1,
};

/**
 * Risk-based position sizing.
 *
 * Formula:
 *   Risk Amount = Account Balance × Risk %
 *   Position Size (coin) = Risk Amount / (Entry Price × SL %)
 *
 * Example (BTC, $937 account, 1% risk, 0.3% SL, $72,000):
 *   Risk = $937 × 0.01 = $9.37
 *   Size = $9.37 / ($72,000 × 0.003) = 0.0434 BTC
 *   Notional = 0.0434 × $72,000 = $3,124
 *   Margin (40x) = $3,124 / 40 = $78
 *   If stopped: loss = $9.37 (1% of account)
 */
export function calculatePositionSize(
  accountBalance: number,
  entryPrice: number,
  coin: string,
  leverageCap?: number,
  /** Optional override for the pair's risk% — used by the concurrency ladder */
  effectiveRiskPct?: number,
  /** Optional override for the ACTUAL stop distance as a fraction of entry
   *  (e.g. structure-anchored SL). Must be passed whenever the real stop is
   *  not cfg.slPct, or the position is oversized by (actual/nominal). */
  slDistancePct?: number,
): number {
  const cfg = getPairConfig(coin);
  const maxLev = leverageCap ?? cfg.maxLev;

  // Risk amount in USDC
  const riskAmount = accountBalance * (effectiveRiskPct ?? cfg.riskPct);

  // Position size in coin units
  // Risk per 1x = entryPrice * stop distance (the distance to SL)
  // With leverage, the notional can be larger, but risk stays the same
  const sizeCoin = riskAmount / (entryPrice * (slDistancePct ?? cfg.slPct));

  // Round down to size step
  const step = SIZE_STEP[coin] ?? 0.001;
  const roundedSize = Math.floor(sizeCoin / step) * step;

  // Ensure margin doesn't exceed available balance
  const notional = roundedSize * entryPrice;
  const marginRequired = notional / maxLev;
  if (marginRequired > accountBalance * 0.8) {
    // Cap at 80% of account to leave buffer for fees
    const safeNotional = accountBalance * 0.8 * maxLev;
    const safeSize = Math.floor(safeNotional / entryPrice / step) * step;
    return Math.max(safeSize, step);
  }

  return Math.max(roundedSize, step);
}
