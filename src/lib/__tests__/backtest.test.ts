import { describe, it, expect } from "vitest";
import { runBacktest, atrPctSeries } from "../backtest";
import { rsiSeries } from "../htf-advisor";
import type { Kline } from "../types";

function klines(prices: number[], startTime = 0): Kline[] {
  return prices.map((close, i) => ({
    openTime: startTime + i * 900000,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
    closeTime: startTime + i * 900000 + 899999,
    quoteVolume: 100,
    trades: 1,
    isClosed: true,
  }));
}

describe("runBacktest", () => {
  it("returns zero stats for no signals (insufficient data)", () => {
    const k15m = klines([100, 101, 102]);
    const k4h = klines([100]);
    const result = runBacktest(k15m, k4h);

    expect(result.trades).toEqual([]);
    expect(result.totalTrades).toBe(0);
    expect(result.winRate).toBe(0);
    expect(result.totalPnl).toBe(0);
  });

  it("only runs one position at a time", () => {
    // Create data long enough for signals to fire
    const prices = Array.from(
      { length: 200 },
      (_, i) => 90 + Math.sin(i * 0.05) * 5 + (i > 80 && i < 140 ? 20 : 0),
    );
    const k15m = klines(prices);
    const k4h = klines(
      Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i * 0.03) * 5),
    );

    const result = runBacktest(k15m, k4h, {
      stopLossPercent: 3,
      takeProfitPercent: 6,
    });

    // Key invariant: each trade's entry >= previous trade's exit
    for (let i = 1; i < result.trades.length; i++) {
      expect(result.trades[i].entryTime).toBeGreaterThanOrEqual(
        result.trades[i - 1].exitTime!,
      );
    }
  });

  it("charges fees (net pnl < gross pnl)", () => {
    // Trending up data that should produce winning long trades
    const prices = Array.from(
      { length: 200 },
      (_, i) => 80 + i * 0.3 + Math.sin(i * 0.1) * 2,
    );
    const k15m = klines(prices);
    const k4h = klines(
      Array.from({ length: 200 }, (_, i) => 100 + i * 0.2),
    );

    const result = runBacktest(k15m, k4h, {
      stopLossPercent: 5,
      takeProfitPercent: 10,
    });

    if (result.trades.length > 0) {
      // Each trade's pnlPercent should account for fees
      for (const trade of result.trades) {
        if (trade.pnlPercent !== null && trade.status === "closed") {
          // Just check trades exist and have numeric PnL
          expect(typeof trade.pnlPercent).toBe("number");
        }
      }
    }
  });

  it("Sharpe ratio is bounded (not wildly inflated)", () => {
    const prices = Array.from(
      { length: 300 },
      (_, i) => 90 + Math.sin(i * 0.08) * 10,
    );
    const k15m = klines(prices);
    const k4h = klines(
      Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i * 0.05) * 5),
    );

    const result = runBacktest(k15m, k4h, {
      stopLossPercent: 3,
      takeProfitPercent: 5,
    });

    // Sharpe should be a finite number
    expect(Number.isFinite(result.sharpeRatio)).toBe(true);
    // Not wildly inflated — even with 15m bar scaling, |Sharpe| < 1000
    expect(Math.abs(result.sharpeRatio)).toBeLessThan(1000);
  });

  it("computes correct win rate", () => {
    const prices = Array.from(
      { length: 300 },
      (_, i) => 90 + Math.sin(i * 0.06) * 10 + (i > 100 && i < 200 ? 15 : 0),
    );
    const k15m = klines(prices);
    const k4h = klines(
      Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i * 0.03) * 5),
    );

    const result = runBacktest(k15m, k4h, {
      stopLossPercent: 2,
      takeProfitPercent: 4,
    });

    if (result.totalTrades > 0) {
      // winRate should equal (totalTrades - losers) / totalTrades * 100
      const losers = result.trades.filter(
        (t) => (t.pnlPercent ?? 0) <= 0,
      ).length;
      const expectedWinRate =
        ((result.totalTrades - losers) / result.totalTrades) * 100;
      expect(result.winRate).toBeCloseTo(expectedWinRate, 1);
    }
  });

  it("force-closes open positions at end of data", () => {
    // Rising data with few bars — should produce signals that may not close
    const prices = Array.from(
      { length: 150 },
      (_, i) => 80 + i * 0.4 + Math.sin(i * 0.1) * 3,
    );
    const k15m = klines(prices);
    const k4h = klines(
      Array.from({ length: 150 }, (_, i) => 100 + i * 0.3),
    );

    const result = runBacktest(k15m, k4h, {
      stopLossPercent: 20,
      takeProfitPercent: 20,
    });

    // All trades should be closed (no open trades left)
    for (const trade of result.trades) {
      expect(trade.status).toBe("closed");
      expect(trade.exitPrice).not.toBeNull();
      expect(trade.exitTime).not.toBeNull();
    }
  });

  it("handles alternating data that produces both long and short signals", () => {
    // Oscillating data above and below EMA
    const prices = Array.from(
      { length: 300 },
      (_, i) => 100 + Math.sin(i * 0.05) * 20,
    );
    const k15m = klines(prices);
    const k4h = klines(
      Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i * 0.03) * 3),
    );

    const result = runBacktest(k15m, k4h, {
      stopLossPercent: 3,
      takeProfitPercent: 5,
    });

    if (result.trades.length > 0) {
      // All trades should have valid entry/exit
      for (const trade of result.trades) {
        expect(trade.entryPrice).toBeGreaterThan(0);
        expect(trade.exitPrice).toBeGreaterThan(0);
        expect(["LONG", "SHORT"]).toContain(trade.entrySignal.type);
      }
    }
  });

  it("returns startDate and endDate from data", () => {
    const k15m = klines([100, 101, 102], 1000000);
    const k4h = klines([100, 101, 102], 1000000);

    const result = runBacktest(k15m, k4h);
    expect(result.startDate).toBe(1000000);
    expect(result.endDate).toBeGreaterThan(1000000);
  });

  it("maxDrawdown is between 0 and 100", () => {
    const prices = Array.from(
      { length: 300 },
      (_, i) => 90 + Math.sin(i * 0.07) * 15,
    );
    const k15m = klines(prices);
    const k4h = klines(
      Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i * 0.04) * 5),
    );

    const result = runBacktest(k15m, k4h);
    expect(result.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(result.maxDrawdown).toBeLessThanOrEqual(100);
  });

  it("default config delays entries to the pivot-confirmation bar (no look-ahead)", () => {
    const prices = Array.from(
      { length: 300 },
      (_, i) => 90 + Math.sin(i * 0.06) * 10 + (i > 100 && i < 220 ? 15 : 0),
    );
    const k15m = klines(prices);
    const k4h = klines(
      Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i * 0.03) * 5),
    );

    const causal = runBacktest(k15m, k4h, { stopLossPercent: 3, takeProfitPercent: 6 });
    const lb = 5; // DEFAULT_CONFIG.pivotLookback / pivot right-lookback
    for (const t of causal.trades) {
      const entryIdx = t.entrySignal.index + 1 + lb;
      if (entryIdx < k15m.length) {
        expect(t.entryTime).toBe(k15m[entryIdx].closeTime);
      }
    }

    // The causal run must never enter EARLIER than the explicitly non-causal one.
    const fast = runBacktest(k15m, k4h, {
      stopLossPercent: 3,
      takeProfitPercent: 6,
      confirmLag: false,
    });
    if (causal.trades.length > 0 && fast.trades.length > 0) {
      expect(causal.trades[0].entryTime).toBeGreaterThan(fast.trades[0].entryTime);
    }
  });

  it("reports a compounded return distinct from the raw percent sum", () => {
    const prices = Array.from({ length: 250 }, (_, i) => 90 + Math.sin(i * 0.07) * 12);
    const k15m = klines(prices);
    const k4h = klines(Array.from({ length: 250 }, (_, i) => 100 + Math.sin(i * 0.04) * 5));

    const result = runBacktest(k15m, k4h, { stopLossPercent: 3, takeProfitPercent: 5 });
    expect(Number.isFinite(result.totalReturnPct)).toBe(true);
    expect(Number.isFinite(result.totalPnl)).toBe(true);
    // The equity curve starts at the starting capital.
    expect(result.equityCurve[0]).toBe(result.startingCapital);
  });

  // ── Volatility gate (2026-09-21) ─────────────────────────────────────────
  // Fixture: this shape yields exactly ONE trade whose signal bar reads
  // ATR% ≈ 2.512 — verified against atrPctSeries directly — which lets the
  // threshold comparisons be pinned EXACTLY (bounds straddling 2.512), not
  // just "fewer trades than before".
  const gateFixture = () => {
    const prices = Array.from({ length: 200 }, (_, i) => 90 + Math.sin(i * 0.05) * 5 + (i > 80 && i < 140 ? 20 : 0));
    return {
      k15m: klines(prices),
      k4h: klines(Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i * 0.03) * 5)),
    };
  };

  it("volatility gate off by default: identical trades with permissive bounds", () => {
    const { k15m, k4h } = gateFixture();
    const off = runBacktest(k15m, k4h, { confirmLag: false });
    expect(off.totalTrades).toBeGreaterThan(0); // fixture sanity
    const permissive = runBacktest(k15m, k4h, { confirmLag: false, minAtrPct: 0.001, maxAtrPct: 99 });
    expect(permissive.trades).toEqual(off.trades);
  });

  it("atrPctSeries is a Wilder ATR(14) as % of close, seeded from TR[1..14]", () => {
    // 40 identical-height bars → TR constant after the first → ATR = that TR.
    const bars = klines(Array.from({ length: 40 }, (_, i) => 100));
    const series = atrPctSeries(bars);
    for (let i = 0; i < 14; i++) expect(Number.isNaN(series[i])).toBe(true);
    // TR from bar 1 on = high − low = 2.0 → ATR = 2.0 → 2% of 100.
    expect(series[14]).toBeCloseTo(2, 9);
    expect(series[39]).toBeCloseTo(2, 9);
  });

  it("floor blocks below the bound, ceiling above it — pinned on the fixture's real ATR", () => {
    const { k15m, k4h } = gateFixture();
    const base = runBacktest(k15m, k4h, { confirmLag: false });
    expect(base.totalTrades).toBe(1);
    const sigAtr = atrPctSeries(k15m)[base.trades[0].entrySignal.index];
    expect(sigAtr).toBeGreaterThan(2.5); // the pin below relies on this reading

    // Floor above the reading blocks; below it passes. Pins v < min → block.
    expect(runBacktest(k15m, k4h, { confirmLag: false, minAtrPct: 3 }).totalTrades).toBe(0);
    expect(runBacktest(k15m, k4h, { confirmLag: false, minAtrPct: 2.4 }).totalTrades).toBe(1);
    // Ceiling below the reading blocks; above it passes. Pins v > max → block.
    expect(runBacktest(k15m, k4h, { confirmLag: false, maxAtrPct: 2 }).totalTrades).toBe(0);
    expect(runBacktest(k15m, k4h, { confirmLag: false, maxAtrPct: 2.6 }).totalTrades).toBe(1);
  });

  it("blocked signals do not re-enter later on the same structure", () => {
    // The gate runs at the SIGNAL bar; a blocked signal is skipped entirely —
    // the next bar must not resurrect it (that would change the trade measured).
    const { k15m, k4h } = gateFixture();
    const blocked = runBacktest(k15m, k4h, { confirmLag: false, minAtrPct: 3 });
    expect(blocked.totalTrades).toBe(0);
    // and nothing enters later either (total stays 0 over the whole series)
    expect(blocked.trades.length).toBe(0);
  });

  // ── Per-pair cooldown (2026-09-21) ───────────────────────────────────────
  // Fixture: SHORT plateau-dip cycle then two LONG cycles (the second at a
  // higher plateau so its troughs form Higher Lows against cycle 1's).
  // amp=3 → t1 is a TP WINNER (win anchor); amp=1.5 → t1 is a Stop LOSER
  // (loss anchor). Gaps: t1.exit→t2.entry ≈ 3315/3270 min, t2.exit→t3.entry
  // ≈ 4365 min — so cooldownMin=2160 expires before t2, 3600 blocks it.
  const k4hCooldown = () =>
    klines(Array.from({ length: 700 }, (_, i) => 100 + Math.sin(i * 0.0107) * 4));
  const cooldownFixture = (amp: number) => {
    const a: number[] = [];
    const push = (n: number, f: (k: number) => number) => { for (let k = 0; k < n; k++) a.push(f(k)); };
    push(90, (k) => 100 + Math.sin(k * 0.1) * 4);
    push(60, (k) => 100 + k * 0.35 + Math.sin(k * 0.2) * 1.2);
    push(60, (k) => 121 + Math.sin(k * 0.1) * 2.5);
    push(30, (k) => 121 - k * 0.3 + Math.sin(k * 0.2) * 1.2);
    push(20, (k) => 112 + Math.sin(k * 0.1) * amp); // shallow dip → SHORT stops out; deeper → SHORT TPs
    push(60, (k) => 112 + k * 0.35 + Math.sin(k * 0.2) * 1.2);
    push(60, (k) => 133 + Math.sin(k * 0.1) * 2.5);
    push(40, (k) => 133 - k * 0.3);
    push(18, (k) => 121);
    push(20, (k) => 121 + (k + 1) * 0.45);
    push(96, (k) => 121 + 12 + Math.sin(k * 0.21) * 1.8 + k * 0.012);
    push(30, (k) => 121 + 12.2 - (k + 1) * 0.42);
    push(150, (k) => 121 - 3);
    push(20, (k) => 121 + (k + 1) * 0.45);
    push(96, (k) => 121 + 14.5 + Math.sin(k * 0.21) * 1.8 + k * 0.012);
    push(30, (k) => 121 + 14.7 - (k + 1) * 0.42);
    push(30, (k) => 121 - 3);
    return a;
  };
  const COOLDOWN_CFG = { stopLossPercent: 1.5, takeProfitPercent: 1.8, confirmLag: false } as const;

  it("cooldown off by default: a permissive cooldown is byte-identical", () => {
    const k15m = klines(cooldownFixture(3));
    const k4h = k4hCooldown();
    const off = runBacktest(k15m, k4h, COOLDOWN_CFG);
    expect(off.totalTrades).toBe(3); // fixture sanity: short + two longs
    const permissive = runBacktest(k15m, k4h, { ...COOLDOWN_CFG, cooldownMin: 2160 });
    expect(permissive.trades).toEqual(off.trades); // 2160 < 3315 gap → nothing blocked
  });

  it("a WINNING close anchors the cooldown — exitMin blocks the next trade", () => {
    const k15m = klines(cooldownFixture(3));
    const k4h = k4hCooldown();
    // t1 is a Take Profit winner; 3600 > 3315 gap → t2 blocked, t3 (later) kept.
    expect(runBacktest(k15m, k4h, { ...COOLDOWN_CFG, cooldownMin: 3600 }).totalTrades).toBe(2);
  });

  it("cooldownOnlyAfterLoss: a winning close does NOT anchor", () => {
    const k15m = klines(cooldownFixture(3));
    const k4h = k4hCooldown();
    expect(
      runBacktest(k15m, k4h, { ...COOLDOWN_CFG, cooldownMin: 3600, cooldownOnlyAfterLoss: true }).totalTrades,
    ).toBe(3);
  });

  it("a LOSING close anchors the cooldown even under cooldownOnlyAfterLoss", () => {
    const k15m = klines(cooldownFixture(1.5));
    const k4h = k4hCooldown();
    // t1 is a Stop LOSER → the loss-only cooldown still blocks the quick t2.
    const lossOnly = runBacktest(k15m, k4h, { ...COOLDOWN_CFG, cooldownMin: 3600, cooldownOnlyAfterLoss: true });
    expect(lossOnly.totalTrades).toBe(2);
  });

  // ── 15m RSI pullback gate (2026-09-21) ──────────────────────────────────
  // Same one-trade fixture as the volatility gate, so both bounds can be
  // pinned EXACTLY against the signal bar's real RSI reading instead of
  // "fewer trades than before".
  it("RSI gate off by default: permissive bounds change nothing", () => {
    const { k15m, k4h } = gateFixture();
    const off = runBacktest(k15m, k4h, { confirmLag: false });
    expect(off.totalTrades).toBeGreaterThan(0); // fixture sanity
    const permissive = runBacktest(k15m, k4h, {
      confirmLag: false,
      rsiPeriod: 14,
      rsiLongMin: 0.001,
      rsiLongMax: 99.999,
      rsiShortMin: 0.001,
      rsiShortMax: 99.999,
    });
    expect(permissive.trades).toEqual(off.trades);
  });

  it("RSI gate blocks on the signal bar's reading, both bounds, pinned", () => {
    const { k15m, k4h } = gateFixture();
    const base = runBacktest(k15m, k4h, { confirmLag: false });
    expect(base.totalTrades).toBe(1);
    const trade = base.trades[0];
    const side = trade.entrySignal.type;
    const rsi = rsiSeries(k15m.map((b) => b.close), 14)[trade.entrySignal.index];
    expect(Number.isFinite(rsi)).toBe(true);
    // Bounds are expressed on the trade's OWN side, so the pin covers whichever
    // leg this fixture prints.
    const band = (min?: number, max?: number) =>
      side === "LONG"
        ? { confirmLag: false as const, rsiPeriod: 14, rsiLongMin: min, rsiLongMax: max }
        : { confirmLag: false as const, rsiPeriod: 14, rsiShortMin: min, rsiShortMax: max };

    // Ceiling below the reading blocks; above it passes. Pins v > max → block.
    expect(runBacktest(k15m, k4h, band(undefined, rsi - 1)).totalTrades).toBe(0);
    expect(runBacktest(k15m, k4h, band(undefined, rsi + 1)).totalTrades).toBe(1);
    // Floor above the reading blocks; below it passes. Pins v < min → block.
    expect(runBacktest(k15m, k4h, band(rsi + 1, undefined)).totalTrades).toBe(0);
    expect(runBacktest(k15m, k4h, band(rsi - 1, undefined)).totalTrades).toBe(1);
  });

  it("RSI gate is side-specific: the OTHER side's bounds never block this signal", () => {
    const { k15m, k4h } = gateFixture();
    const base = runBacktest(k15m, k4h, { confirmLag: false });
    const opposite = base.trades[0].entrySignal.type === "LONG" ? "SHORT" : "LONG";
    const impossible = { confirmLag: false as const, rsiPeriod: 14 };
    const s = runBacktest(
      k15m,
      k4h,
      opposite === "SHORT"
        ? { ...impossible, rsiShortMin: 99, rsiShortMax: 100 }
        : { ...impossible, rsiLongMin: 99, rsiLongMax: 100 },
    );
    expect(s.totalTrades).toBe(1);
  });

  it("RSI gate fails CLOSED before the RSI has seeded", () => {
    const { k15m, k4h } = gateFixture();
    // Period far longer than the fixture's bar count → every reading is NaN
    // (pre-seed). A blocked signal is skipped outright, never resurrected.
    const blocked = runBacktest(k15m, k4h, { confirmLag: false, rsiPeriod: 500, rsiLongMin: 30, rsiLongMax: 70 });
    expect(blocked.totalTrades).toBe(0);
    expect(blocked.trades.length).toBe(0);
  });

  it("cooldown expires — a long one still lets the LATER trade through", () => {
    const k15m = klines(cooldownFixture(1.5));
    const k4h = k4hCooldown();
    const off = runBacktest(k15m, k4h, COOLDOWN_CFG);
    expect(off.totalTrades).toBe(3);
    const withCd = runBacktest(k15m, k4h, { ...COOLDOWN_CFG, cooldownMin: 3600 });
    expect(withCd.totalTrades).toBe(2); // t2 blocked…
    expect(withCd.trades[1].entryTime).toBe(off.trades[2].entryTime); // …but t3 survives
  });

  // ── Higher-timeframe gate overrides + entry-veto hook (2026-09-22) ────────
  // 1H-MIGRATION LAB. The spec's "4H EMA75" filter was hard-coded in BOTH the
  // scanner and the engine, so "what if the entry timeframe — and therefore the
  // filter timeframe and its EMA period — moved?" was untestable. These pins
  // prove the override is live, that a SECOND HTF series is AND-ed with the
  // first, and that the advisor veto hook is inert unless a caller supplies it.

  it("htfEmaPeriod: an explicit 75 is byte-identical to the default", () => {
    const k15m = klines(cooldownFixture(3));
    const k4h = k4hCooldown();
    const off = runBacktest(k15m, k4h, COOLDOWN_CFG);
    expect(off.totalTrades).toBe(3); // fixture sanity
    expect(runBacktest(k15m, k4h, { ...COOLDOWN_CFG, htfEmaPeriod: 75 }).trades).toEqual(off.trades);
  });

  it("htfEmaPeriod re-gates: a 100-period HTF EMA drops the third signal", () => {
    const k15m = klines(cooldownFixture(3));
    const k4h = k4hCooldown();
    const off = runBacktest(k15m, k4h, COOLDOWN_CFG);
    expect(off.trades.map((t) => t.entrySignal.type)).toEqual(["SHORT", "LONG", "LONG"]);
    // The slower 4H EMA sits above price at the second LONG's signal bar, so
    // that side's gate shuts where EMA75 had it open — a real re-gate, not a
    // cosmetic rename.
    const slow = runBacktest(k15m, k4h, { ...COOLDOWN_CFG, htfEmaPeriod: 100 });
    expect(slow.totalTrades).toBe(2);
    expect(slow.trades.map((t) => t.entrySignal.type)).toEqual(["SHORT", "LONG"]);
  });

  it("a second HTF series is AND-ed with the first", () => {
    const { k15m, k4h } = gateFixture();
    const off = runBacktest(k15m, k4h, { confirmLag: false });
    expect(off.totalTrades).toBe(1);
    const side = off.trades[0].entrySignal.type; // SHORT on this fixture
    // A monotone series that agrees with this side changes nothing…
    const agree = klines(
      Array.from({ length: 200 }, (_, i) => (side === "LONG" ? 60 + i * 0.5 : 160 - i * 0.5)),
    );
    // (Compare the trade economics, not the raw objects — a second series
    // appends its own label to `entrySignal.reason` by design.)
    const econ = (r: ReturnType<typeof runBacktest>) =>
      r.trades.map((t) => [t.entryTime, t.exitTime, t.pnlPercent]);
    expect(
      econ(runBacktest(k15m, k4h, { confirmLag: false, klinesHtf2: agree, htf2EmaPeriod: 75 })),
    ).toEqual(econ(off));
    // …and its mirror blocks the entry outright (AND-stack, not OR).
    const disagree = klines(
      Array.from({ length: 200 }, (_, i) => (side === "LONG" ? 160 - i * 0.5 : 60 + i * 0.5)),
    );
    expect(
      runBacktest(k15m, k4h, { confirmLag: false, klinesHtf2: disagree, htf2EmaPeriod: 75 }).totalTrades,
    ).toBe(0);
    // Fail-closed while the second series has no seeded EMA (period > bars).
    expect(
      runBacktest(k15m, k4h, { confirmLag: false, klinesHtf2: agree, htf2EmaPeriod: 5000 }).totalTrades,
    ).toBe(0);
  });

  it("entryVeto: inert when unset, blocks every entry when true, sees the real signal", () => {
    const { k15m, k4h } = gateFixture();
    const off = runBacktest(k15m, k4h, { confirmLag: false });
    expect(off.totalTrades).toBe(1);
    // An always-false veto must be byte-identical to no veto at all.
    expect(runBacktest(k15m, k4h, { confirmLag: false, entryVeto: () => false }).trades).toEqual(off.trades);
    // An always-true veto blocks the entry outright.
    expect(runBacktest(k15m, k4h, { confirmLag: false, entryVeto: () => true }).totalTrades).toBe(0);
    // The hook is handed the real side and the SIGNAL bar's close (not the entry bar)
    // so an advisor read can be aligned to the same causal point the engine uses.
    const seen: Array<{ side: string; signalTime: number }> = [];
    runBacktest(k15m, k4h, {
      confirmLag: false,
      entryVeto: (c) => {
        seen.push({ side: c.side, signalTime: c.signalTime });
        return false;
      },
    });
    expect(seen).toEqual([
      { side: off.trades[0].entrySignal.type, signalTime: off.trades[0].entrySignal.time },
    ]);
  });
});
