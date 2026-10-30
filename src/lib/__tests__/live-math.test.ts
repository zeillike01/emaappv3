/**
 * LIVE MATH — order sizing + exit-estimate parity tests.
 *
 * This module is the arithmetic the REAL-money MEXC engine (liveBroker.ts)
 * runs, so each rule is pinned here: a change that alters what the live bot
 * would send to the exchange (contract volume, SL/TP anchors, margin guard)
 * or how it books an exit (PnL/fees/R signs) fails loudly instead of trading
 * differently than intended.
 *
 * In particular, estimateExit's realizedR must stay SIGNED on both sides:
 * losing longs and losing shorts both report negative R, winning trades of
 * both sides report positive R. The pre-extraction inline math
 * (|exit − entry| × dir) flipped the sign on long losses and short wins.
 */
import { describe, it, expect } from "vitest";
import {
  LIVE_TAKER_FEE,
  LIVE_EXIT_SLIP_BPS,
  roundVol,
  computeOrderSize,
  expectedExitPrice,
  estimateExit,
  maxSafeLeverage,
  liquidationDistancePct,
  LIVE_ASSUMED_MAINTENANCE_PCT,
  type OrderSizeInput,
} from "../live-math";

const META = { contractSize: 1, volScale: 0, minVol: 1, maxVol: 10_000_000 };

function orderInput(overrides: Partial<OrderSizeInput> = {}): OrderSizeInput {
  return {
    side: "LONG",
    entryPrice: 100,
    riskUsd: 25, // 2.5% of a $1,000 balance
    stopLossPct: 1.5,
    takeProfitPct: 2.0,
    // 20x (post-audit default), NOT the old 50x: the liquidation guard now
    // rejects any leverage whose liquidation would precede the stop.
    leverage: 20,
    balanceUsd: 1_000,
    contractSize: META.contractSize,
    volScale: META.volScale,
    minVol: META.minVol,
    maxVol: META.maxVol,
    ...overrides,
  };
}

// ── roundVol ──

describe("roundVol", () => {
  it("floors to whole contracts at scale 0", () => {
    expect(roundVol(16.6667, 0)).toBe(16);
    expect(roundVol(2.999, 0)).toBe(2); // never rounds up → never oversizes
  });

  it("floors to the requested decimals at scale > 0", () => {
    expect(roundVol(33.3333, 2)).toBe(33.33);
    expect(roundVol(1.9999, 2)).toBe(1.99);
  });

  it("never accepts a negative scale", () => {
    expect(roundVol(12.5, -3)).toBe(12);
  });
});

// ── computeOrderSize ──

describe("computeOrderSize", () => {
  it("sizes risk % of equity at the SL distance (long)", () => {
    const r = computeOrderSize(orderInput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // risk 25 / SL 1.5% → notional 1666.67, vol 16 contracts @ $100, margin at 20x
    expect(r.slPrice).toBeCloseTo(98.5, 6);
    expect(r.tpPrice).toBeCloseTo(102, 6);
    expect(r.notionalUsd).toBeCloseTo(1666.6667, 4);
    expect(r.vol).toBe(16);
    expect(r.marginUsd).toBeCloseTo(83.3333, 4);
  });

  it("anchors a short's SL above entry and TP below entry", () => {
    const r = computeOrderSize(orderInput({ side: "SHORT" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.slPrice).toBeCloseTo(101.5, 6);
    expect(r.tpPrice).toBeCloseTo(98, 6);
  });

  it("respects volScale rounding of the contract volume", () => {
    const r = computeOrderSize(orderInput({ entryPrice: 50, volScale: 1 }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // notional 1666.67 / 50 = 33.333 contracts → floored to 33.3
    expect(r.vol).toBe(33.3);
  });

  it("rejects a computed volume below the exchange minimum", () => {
    const r = computeOrderSize(orderInput({ entryPrice: 100_000 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("outside");
    expect(r.reason).toContain("0"); // floored to 0 contracts
  });

  it("rejects a volume above the exchange maximum", () => {
    const r = computeOrderSize(
      orderInput({ riskUsd: 1_000_000, balanceUsd: 50_000_000, maxVol: 1_000 }),
    );
    expect(r.ok).toBe(false);
  });

  it("rejects leverage whose liquidation would fire before the stop", () => {
    const r = computeOrderSize(orderInput({ leverage: 60 }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("safe max");
  });

  it("rejects when one entry's isolated margin would exceed 90% of balance", () => {
    // $100 balance, $10 risked at a 0.1% stop → notional $10,000 → margin
    // $10,000 at 1x — far past the 90% guard.
    const r = computeOrderSize(
      orderInput({ balanceUsd: 100, riskUsd: 10, stopLossPct: 0.1, leverage: 1 }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("90%");
  });
});

// ── liquidation guard ──

describe("maxSafeLeverage", () => {
  it("caps leverage so liquidation clears the stop plus costs", () => {
    const lev = maxSafeLeverage(1.5);
    expect(lev).toBeLessThan(60);
    // Liquidation distance at the cap must exceed the stop by the safety buffer.
    expect(liquidationDistancePct(lev)).toBeGreaterThan(1.5 + 2 * LIVE_TAKER_FEE * 100);
  });

  it("allows more leverage for tighter stops but never zero/negative", () => {
    expect(maxSafeLeverage(0.3)).toBeGreaterThan(maxSafeLeverage(3));
    expect(maxSafeLeverage(0)).toBeGreaterThanOrEqual(1);
  });

  it("liquidation distance shrinks with leverage", () => {
    expect(liquidationDistancePct(10)).toBeCloseTo(10 - LIVE_ASSUMED_MAINTENANCE_PCT, 6);
    expect(liquidationDistancePct(50)).toBeLessThan(liquidationDistancePct(20));
  });
});

// ── expectedExitPrice ──

describe("expectedExitPrice", () => {
  it("hits TP at the target with no slippage", () => {
    expect(expectedExitPrice({ trigger: "Take Profit", side: "LONG", slPrice: 98, tpPrice: 102 })).toBe(102);
    expect(expectedExitPrice({ trigger: "Take Profit", side: "SHORT", slPrice: 102, tpPrice: 98 })).toBe(98);
  });

  it("fills a long SL adversarially below the level by EXIT_SLIP_BPS", () => {
    const slip = (LIVE_EXIT_SLIP_BPS / 10_000) * 100;
    expect(expectedExitPrice({ trigger: "Stop Loss", side: "LONG", slPrice: 100, tpPrice: 110 })).toBeCloseTo(100 * (1 - slip / 100), 6);
  });

  it("fills a short SL adversarially above the level by EXIT_SLIP_BPS", () => {
    const slip = (LIVE_EXIT_SLIP_BPS / 10_000) * 100;
    expect(expectedExitPrice({ trigger: "Stop Loss", side: "SHORT", slPrice: 100, tpPrice: 90 })).toBeCloseTo(100 * (1 + slip / 100), 6);
  });
});

// ── estimateExit ──

describe("estimateExit", () => {
  // Shared geometry: entry 100, risk distance 1 (SL 99 long / 101 short),
  // notional 1000 → fee both sides = 1000 × LIVE_TAKER_FEE × 2 = 1.20.
  const longBase = { notionalUsd: 1000, entryPrice: 100, side: "LONG" as const, slPrice: 99 };
  const shortBase = { notionalUsd: 1000, entryPrice: 100, side: "SHORT" as const, slPrice: 101 };

  it("books a winning long TP as positive PnL and positive R", () => {
    const est = estimateExit({ ...longBase, exitPrice: 102 });
    expect(est.gross).toBeCloseTo(20, 6);
    expect(est.fees).toBeCloseTo(1000 * LIVE_TAKER_FEE * 2, 6);
    expect(est.pnlUsd).toBeCloseTo(20 - est.fees, 6);
    expect(est.realizedR).toBeCloseTo(2, 6);
  });

  it("books a losing long SL as negative PnL and NEGATIVE R", () => {
    // Long SL fills at slPrice × (1 − 3bps) = 98.9703
    const exit = expectedExitPrice({ trigger: "Stop Loss", side: "LONG", slPrice: 99, tpPrice: 110 });
    const est = estimateExit({ ...longBase, exitPrice: exit });
    expect(est.gross).toBeLessThan(0);
    expect(est.realizedR).toBeCloseTo((exit - 100) / 1, 6);
    expect(est.realizedR).toBeLessThan(0); // regression: old inline math reported +R here
  });

  it("books a winning short TP as positive PnL and POSITIVE R", () => {
    const est = estimateExit({ ...shortBase, exitPrice: 98 });
    expect(est.gross).toBeCloseTo(20, 6);
    expect(est.realizedR).toBeCloseTo(2, 6);
    expect(est.realizedR).toBeGreaterThan(0); // regression: old inline math reported −R here
  });

  it("books a losing short SL as negative PnL and negative R", () => {
    // Short SL fills at slPrice × (1 + 3bps) = 101.03
    const exit = expectedExitPrice({ trigger: "Stop Loss", side: "SHORT", slPrice: 101, tpPrice: 90 });
    const est = estimateExit({ ...shortBase, exitPrice: exit });
    expect(est.gross).toBeLessThan(0);
    expect(est.realizedR).toBeCloseTo((exit - 100) * -1 / 1, 6);
    expect(est.realizedR).toBeLessThan(0);
  });

  it("returns 0 R when there is no risk distance (entry == SL)", () => {
    const est = estimateExit({ ...longBase, slPrice: 100, exitPrice: 105 });
    expect(est.realizedR).toBe(0);
    expect(est.pnlUsd).toBeGreaterThan(0); // price move still books
  });
});
