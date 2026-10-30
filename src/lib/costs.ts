/**
 * TRADING COSTS — SINGLE SOURCE OF TRUTH (2026-09-11 red-team audit fix).
 *
 * Before this module every lab carried its own cost constants: backtest.ts
 * charged 0.06% taker / 0.02% maker but defaulted slippage and funding to
 * ZERO, backtest-regime-adaptive-v3.ts charged 0.04% (under the real 0.06%),
 * and run-regime-short-backtest.ts used 3 bps of slippage. Three different
 * cost worlds, so "it's profitable in backtest" meant three different things
 * and none of them matched live.
 *
 * All values are PERCENT of notional unless the name says otherwise, matching
 * backtest.ts's existing convention (0.06 = 0.06%).
 *
 * MEXC USDT-perp taker is 0.06% and maker 0.02% (see strategyEngine.ts
 * TAKER_FEE/MAKER_FEE and paperTrading.ts MEXC_*_FEE_PCT). Slippage defaults
 * are deliberately adverse: market entries pay 3 bps, stop/trail exits pay
 * 5 bps (stops trade INTO a moving market, so they slip more than entries).
 * Funding is a per-8h-window cost, always charged against the position.
 *
 * Changing a number here changes every lab AND the engines — that is the
 * point. Add a test before changing values.
 */

export interface CostModel {
  /** Taker fee per side, % of notional (market entry + stop/trail exit). */
  takerFeePct: number;
  /** Maker fee per side, % of notional (resting limit TP exit). */
  makerFeePct: number;
  /** Adverse slippage on a market ENTRY, % of price. */
  entrySlipPct: number;
  /** Adverse slippage on a market STOP/TRAIL exit, % of price (TP is maker, no slip). */
  exitSlipPct: number;
  /** Funding paid per full 8h window held, % of notional, always adverse. */
  fundingPctPer8h: number;
}

/**
 * HARD RISK CEILING (Phase 7, 2026-10-02): maximum NOMINAL initial risk per
 * trade, as a percent of book equity (1 = 1%). Sizing in every engine is
 * notional = (equity × riskPct/100) ÷ stopDistance, so the stop-touch loss is
 * exactly riskPct% of equity — this constant caps that knob. Shipped books run
 * at 1% (DEFAULT_CONFIG.riskPct / LIVE_DEFAULT_RISK_PCT); 2% is the ceiling
 * the operator may dial up to, never a target. Enforced at every layer:
 * resolveConfig (defense in depth), both engine sizing sites, both live
 * settings mutations, updateConfig, and the backtest harness (fraction space).
 */
export const MAX_RISK_PCT_PER_TRADE = 2;
/** Minimum riskPct the sizing math accepts (below this is a panel typo). */
export const MIN_RISK_PCT_PER_TRADE = 0.1;

/**
 * Clamp a percent-space riskPct (1 = 1%) into [0.1, MAX_RISK_PCT_PER_TRADE].
 * Non-finite input resolves to the supplied fallback (default 1%).
 */
export function clampRiskPct(raw: unknown, fallback = 1): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_RISK_PCT_PER_TRADE, Math.max(MIN_RISK_PCT_PER_TRADE, n));
}

/**
 * Clamp a fraction-space risk value (0.02 = 2%, the backtest convention)
 * into [0.001, MAX_RISK_PCT_PER_TRADE/100].
 */
export function clampRiskFrac(raw: unknown, fallback = 0.02): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_RISK_PCT_PER_TRADE / 100, Math.max(0.001, n));
}

/**
 * Worst-case all-in loss of a stopped-out trade as % of equity, given the
 * nominal riskPct and stop distance. The stop-touch price loss IS riskPct by
 * construction (notional = risk ÷ stopDistance); entry/exit slippage plus
 * round-trip fees land on top. At the 2% ceiling with a 1.5% stop that is
 * ≈2% × (1 + 0.093) ≈ 2.19% before funding — the ceiling bounds the
 * controllable part; costs.ts bounds and documents the remainder.
 */
export function worstCaseLossPct(riskPct: number, stopLossPct: number): number {
  if (!(riskPct > 0) || !(stopLossPct > 0)) return Infinity;
  return riskPct * (1 + roundTripCostR(stopLossPct));
}

/** The one cost model every strategy uses. */
export const COSTS: CostModel = {
  takerFeePct: 0.06,
  makerFeePct: 0.02,
  entrySlipPct: 0.03,
  exitSlipPct: 0.05,
  fundingPctPer8h: 0.01,
};

/** 15m bars in one 8h funding window (used by the labs' funding accrual). */
export const BARS_PER_8H = 32;

/** Fraction-space helpers for labs that keep everything in decimal form. */
export const COST_FRACTIONS = {
  takerFee: COSTS.takerFeePct / 100,
  makerFee: COSTS.makerFeePct / 100,
  entrySlip: COSTS.entrySlipPct / 100,
  exitSlip: COSTS.exitSlipPct / 100,
  fundingPer8h: COSTS.fundingPctPer8h / 100,
} as const;

/**
 * ROUND-TRIP cost of one trade in R, given the stop distance as a percent of
 * price. A trade cannot show a profit below this many R, so any claimed edge
 * must clear it. Used by labs' verdict lines to make fee drag explicit.
 */
export function roundTripCostR(stopLossPct: number, slippageRounds = 2): number {
  if (stopLossPct <= 0) return Infinity;
  const feePct = COSTS.takerFeePct + COSTS.makerFeePct;
  const slipPct = slippageRounds * COSTS.entrySlipPct;
  return (feePct + slipPct) / stopLossPct;
}

/** Break-even win rate for a symmetric-ish profile with `avgWinR` per win. */
export function breakEvenWinRate(avgWinR: number, costR: number): number {
  // p*avgWinR - (1-p)*(1+costR) = 0  →  p = (1+costR) / (avgWinR + 1 + costR)
  const denom = avgWinR + 1 + costR;
  return denom > 0 ? (1 + costR) / denom : 1;
}
