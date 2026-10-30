/**
 * PHASE 7 — 2% RISK PROOF (2026-10-02).
 *
 * The rule: no trade may risk more than 2% of book equity at its stop
 * (nominal — the stop-touch price loss; fees/slippage land on top and are
 * bounded separately by costs.ts via worstCaseLossPct).
 *
 * Enforcement is defense-in-depth, all funnelled through
 * MAX_RISK_PCT_PER_TRADE in costs.ts:
 *   - resolveConfig (layer2-signal) clamps paper+live scoring configs
 *   - strategyEngine sizing + updateConfig clamp the paper book
 *   - liveBrokerRuntime clamps riskUsd before live sizing
 *   - liveEngine updateLiveSettings/setLiveDefaults/readLiveDefaults clamp
 *     what is stored and what seeds a fresh account
 *   - backtest harness clamps fraction-space riskPct (labs can't bless a
 *     size the live book refuses to place)
 *   - StrategyConfigPanel + Live.tsx cap the UI at 2
 *
 * These tests pin the ceiling itself: the clamp helpers, the worst-case
 * bound, and the sizing identity (notional = risk ÷ SL ⇒ stop-touch loss
 * is exactly riskPct). If any layer regresses, the suite that matters is
 * this one.
 */

import { describe, expect, it } from "vitest";
import {
  clampRiskFrac,
  clampRiskPct,
  MAX_RISK_PCT_PER_TRADE,
  worstCaseLossPct,
} from "./costs";
import { computeOrderSize } from "./live-math";

describe("Phase 7 — 2% hard ceiling constant", () => {
  it("is exactly 2 (percent space)", () => {
    expect(MAX_RISK_PCT_PER_TRADE).toBe(2);
  });
});

describe("clampRiskPct — percent space (1 = 1%)", () => {
  it("passes normal values through", () => {
    expect(clampRiskPct(1)).toBe(1);
    expect(clampRiskPct(2)).toBe(2);
    expect(clampRiskPct(0.5)).toBe(0.5);
  });

  it("caps the old 10% UI ceiling down to 2", () => {
    expect(clampRiskPct(10)).toBe(2);
    expect(clampRiskPct(5)).toBe(2);
    expect(clampRiskPct(2.5)).toBe(2);
    expect(clampRiskPct(100)).toBe(2);
  });

  it("floors panel typos at 0.1", () => {
    expect(clampRiskPct(0.05)).toBe(0.1);
    expect(clampRiskPct(0)).toBe(0.1);
    expect(clampRiskPct(-3)).toBe(0.1);
  });

  it("falls back on non-finite input", () => {
    expect(clampRiskPct(NaN)).toBe(1);
    expect(clampRiskPct(Infinity)).toBe(1);
    expect(clampRiskPct(undefined)).toBe(1);
    expect(clampRiskPct("abc")).toBe(1);
    expect(clampRiskPct(NaN, 2)).toBe(2);
  });
});

describe("clampRiskFrac — fraction space (0.02 = 2%, the backtest convention)", () => {
  it("caps the legacy 2.5% backtest default down to 2%", () => {
    expect(clampRiskFrac(0.025)).toBe(0.02);
    expect(clampRiskFrac(0.1)).toBe(0.02);
  });

  it("passes normal values through", () => {
    expect(clampRiskFrac(0.01)).toBe(0.01);
    expect(clampRiskFrac(0.02)).toBe(0.02);
  });

  it("falls back on non-finite input", () => {
    expect(clampRiskFrac(NaN)).toBe(0.02);
    expect(clampRiskFrac(undefined)).toBe(0.02);
  });
});

describe("sizing identity — stop-touch loss IS riskPct by construction", () => {
  it("notional = risk ÷ SL distance ⇒ a stopped trade loses exactly riskPct", () => {
    const equity = 1000;
    for (const riskPct of [0.5, 1, 2]) {
      const stopLossPct = 1.5;
      const riskUsd = (equity * clampRiskPct(riskPct)) / 100;
      const notional = riskUsd / (stopLossPct / 100);
      const stopLossUsd = notional * (stopLossPct / 100);
      expect(stopLossUsd).toBeCloseTo(riskUsd, 10);
      expect(stopLossUsd / equity).toBeCloseTo(riskPct / 100, 10);
    }
  });

  it("a 10% attempt clamped to 2% sizes 1/5th — the ceiling binds", () => {
    const equity = 1000;
    const stopLossPct = 1.5;
    const attempted = 10;
    const clamped = clampRiskPct(attempted);
    expect(clamped).toBe(2);
    const riskUsdAttempted = (equity * attempted) / 100; // 100
    const riskUsdClamped = (equity * clamped) / 100; // 20
    expect(riskUsdClamped).toBe(20);
    expect(riskUsdClamped).toBe(riskUsdAttempted / 5);
  });

  it("computeOrderSize honors a clamped 2% riskUsd end-to-end (live sizing math)", () => {
    const equity = 1000;
    const riskUsd = (equity * clampRiskPct(10)) / 100; // operator typed 10 → clamped to 20
    const r = computeOrderSize({
      side: "LONG",
      entryPrice: 100,
      riskUsd,
      stopLossPct: 1.5,
      takeProfitPct: 3,
      leverage: 10,
      balanceUsd: equity,
      contractSize: 1,
      volScale: 0,
      minVol: 1,
      maxVol: 100_000,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // notional = 20 / 0.015 = 1333.33 → vol 13.33 → floored 13
    expect(r.vol).toBe(13);
    expect(r.notionalUsd).toBeCloseTo(1333.333, 2);
    // stop-touch loss = notional × 1.5% = exactly the clamped 2% of equity
    expect(r.notionalUsd * 0.015).toBeCloseTo(20, 6);
    expect(r.notionalUsd * 0.015).toBeLessThanOrEqual(equity * 0.02 + 1e-9);
  });
});

describe("worstCaseLossPct — all-in bound at the ceiling", () => {
  it("is nominal risk plus round-trip costs, ~2.19% at the 2% ceiling / 1.5% stop", () => {
    const w = worstCaseLossPct(2, 1.5);
    // fee 0.08% + 2×0.03% slip = 0.14% ÷ 1.5% stop ≈ 0.0933R of drag
    expect(w).toBeGreaterThan(2);
    expect(w).toBeLessThan(2.5);
    expect(w).toBeCloseTo(2 * (1 + 0.14 / 1.5), 6);
  });

  it("a clamped input can never report a worse bound than the ceiling", () => {
    const ceiling = worstCaseLossPct(MAX_RISK_PCT_PER_TRADE, 1.5);
    for (const attempted of [2, 5, 10, 100]) {
      expect(worstCaseLossPct(clampRiskPct(attempted), 1.5)).toBeLessThanOrEqual(ceiling);
    }
  });

  it("rejects degenerate inputs", () => {
    expect(worstCaseLossPct(0, 1.5)).toBe(Infinity);
    expect(worstCaseLossPct(2, 0)).toBe(Infinity);
  });
});
