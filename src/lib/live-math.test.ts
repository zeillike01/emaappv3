/**
 * LIVE STOP-LOSS AUDIT (2026-09-24) — focused tests for the pure math the
 * real-money paths run. Three defect classes are pinned here so they cannot
 * regress silently:
 *
 *   1. CONFIG VALIDATION — a non-positive stop or target used to limp through
 *      sizing (Infinity contracts / an instant "Take Profit" at or through
 *      entry) instead of being refused with the reason named.
 *   2. POSITION MATCHING — consumers acting on one trade must resolve THAT
 *      trade's exchange row (exact `${sym}_${side}` key, ambiguous-side `_0`
 *      fallback only), never the opposite side's hedge-mode row or a row whose
 *      symbol merely shares a string prefix.
 *   3. STOP FILL PRICING — the ledger books a stop OUT past the level
 *      (adverse slippage, both sides) and a TP exactly at the target.
 */

import { describe, expect, it } from "vitest";
import { rLockReplayBars, rLockStep } from "./r-lock";
import {
  computeOrderSize,
  expectedExitPrice,
  expectedMarketExitPrice,
  LIVE_EXIT_SLIP_BPS,
  matchLiveDealVolume,
  manualCloseAck,
  matchPositionEntry,
  maxSafeLeverage,
  recordLiveCloseWrite,
  roundVol,
} from "./live-math";

const BASE_SIZE = {
  side: "LONG" as const,
  entryPrice: 100,
  riskUsd: 10,
  stopLossPct: 1.5,
  takeProfitPct: 3,
  leverage: 10,
  balanceUsd: 1000,
  contractSize: 1,
  volScale: 0,
  minVol: 1,
  maxVol: 100_000,
};

describe("computeOrderSize — stop/TP config validation (2026-09-24)", () => {
  it("sizes a valid entry: risk ÷ SL distance, SL/TP on the correct sides", () => {
    const r = computeOrderSize(BASE_SIZE);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // notional = 10 / 0.015 = 666.67 → vol = 666.67 / 100 / 1 = 6.66 → floored
    expect(r.vol).toBe(6);
    expect(r.slPrice).toBeCloseTo(100 * 0.985, 10);
    expect(r.tpPrice).toBeCloseTo(100 * 1.03, 10);
  });

  it("refuses a zero stop distance with the reason named", () => {
    const r = computeOrderSize({ ...BASE_SIZE, stopLossPct: 0 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("stopLossPct");
  });

  it("refuses a negative stop distance", () => {
    const r = computeOrderSize({ ...BASE_SIZE, stopLossPct: -1.5 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("stopLossPct");
  });

  it("refuses a non-positive target (it would sit at/through entry and trigger instantly)", () => {
    for (const takeProfitPct of [0, -2]) {
      const r = computeOrderSize({ ...BASE_SIZE, takeProfitPct });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.reason).toContain("take-profit");
    }
  });

  it("refuses a non-positive per-side SHORT target override", () => {
    const r = computeOrderSize({
      ...BASE_SIZE,
      side: "SHORT",
      takeProfitPct: 3,
      shortTakeProfitPct: 0,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("take-profit");
  });

  it("still honors the SHORT override when it is valid", () => {
    const r = computeOrderSize({
      ...BASE_SIZE,
      side: "SHORT",
      shortTakeProfitPct: 2.25,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // SHORT: stop ABOVE entry (101.5), target BELOW (97.75)
    expect(r.slPrice).toBeCloseTo(100 * 1.015, 10);
    expect(r.tpPrice).toBeCloseTo(100 * 0.9775, 10);
  });

  it("refuses an invalid entry price", () => {
    for (const entryPrice of [0, -1, NaN]) {
      const r = computeOrderSize({ ...BASE_SIZE, entryPrice });
      expect(r.ok).toBe(false);
    }
  });

  it("keeps the liquidation-distance leverage guard (stop must clear liquidation)", () => {
    const safe = maxSafeLeverage(1.5);
    const r = computeOrderSize({ ...BASE_SIZE, leverage: safe + 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toContain("liquidation");
  });
});

describe("matchPositionEntry — side-aware exact-key matching (2026-09-24)", () => {
  const row = (tag: string) => ({ vol: 1, avgPrice: 2, positionId: tag });

  it("prefers the exact side key", () => {
    const map = new Map([
      ["BTC_USDT_1", row("long")],
      ["BTC_USDT_2", row("short")],
      ["BTC_USDT_0", row("shadow")],
    ]);
    expect(matchPositionEntry(map, "BTC_USDT", 1)?.positionId).toBe("long");
    expect(matchPositionEntry(map, "BTC_USDT", 2)?.positionId).toBe("short");
  });

  it("falls back to the ambiguous-side key only when the side key is absent", () => {
    const map = new Map([["BTC_USDT_0", row("shadow")]]);
    expect(matchPositionEntry(map, "BTC_USDT", 1)?.positionId).toBe("shadow");
  });

  it("never returns the opposite side's row when the wanted side is absent", () => {
    // Hedge-mode account holding ONLY the short: a long consumer must see
    // nothing, not the short row (the pre-fix `${sym}_0` fallback did).
    const map = new Map([
      ["BTC_USDT_2", row("short")],
      ["BTC_USDT_0", row("shadow")],
    ]);
    expect(matchPositionEntry(map, "BTC_USDT", 1)).toBeNull();
  });

  it("never matches a different symbol by string prefix", () => {
    const map = new Map([
      ["BTC_USDT_1", row("btc")],
      ["BTCDOM_USDT_1", row("btcdom")],
    ]);
    expect(matchPositionEntry(map, "BTCDOM_USDT", 1)?.positionId).toBe("btcdom");
    expect(matchPositionEntry(map, "ETH_USDT", 1)).toBeNull();
  });
});

describe("expectedExitPrice — stop-fill pricing (2026-09-24)", () => {
  const slip = LIVE_EXIT_SLIP_BPS / 10_000;

  it("books a LONG stop out PAST the level (adverse slippage)", () => {
    const px = expectedExitPrice({
      trigger: "Stop Loss",
      side: "LONG",
      slPrice: 98.5,
      tpPrice: 103,
    });
    expect(px).toBeCloseTo(98.5 * (1 - slip), 10);
  });

  it("books a SHORT stop out PAST the level (adverse slippage)", () => {
    const px = expectedExitPrice({
      trigger: "Stop Loss",
      side: "SHORT",
      slPrice: 101.5,
      tpPrice: 97,
    });
    expect(px).toBeCloseTo(101.5 * (1 + slip), 10);
  });

  it("books a TP exactly at the target on both sides", () => {
    expect(
      expectedExitPrice({ trigger: "Take Profit", side: "LONG", slPrice: 98.5, tpPrice: 103 }),
    ).toBe(103);
    expect(
      expectedExitPrice({ trigger: "Take Profit", side: "SHORT", slPrice: 101.5, tpPrice: 97 }),
    ).toBe(97);
  });
});

describe("expectedMarketExitPrice — market closes are never booked favourably", () => {
  const slip = LIVE_EXIT_SLIP_BPS / 10_000;

  it("books a LONG market close BELOW the sampled price", () => {
    expect(expectedMarketExitPrice({ side: "LONG", price: 100 })).toBeCloseTo(100 * (1 - slip), 10);
  });

  it("books a SHORT market close ABOVE the sampled price", () => {
    expect(expectedMarketExitPrice({ side: "SHORT", price: 100 })).toBeCloseTo(100 * (1 + slip), 10);
  });

  it("never returns the raw sample, on either side", () => {
    // The r-lock / manual closes are MARKET orders: booking the sampled ticker
    // would claim a zero-slippage fill that the exchange cannot guarantee.
    for (const side of ["LONG", "SHORT"] as const) {
      expect(expectedMarketExitPrice({ side, price: 42 })).not.toBe(42);
    }
  });

  it("honours an explicit slippage assumption and defaults to LIVE_EXIT_SLIP_BPS", () => {
    expect(expectedMarketExitPrice({ side: "LONG", price: 100, slipBps: 10 })).toBeCloseTo(99.9, 10);
    expect(expectedMarketExitPrice({ side: "SHORT", price: 100, slipBps: 10 })).toBeCloseTo(100.1, 10);
    expect(expectedMarketExitPrice({ side: "LONG", price: 100, slipBps: 0 })).toBe(100);
  });
});

describe("stop fidelity with the trailing lock disabled", () => {
  it("still reports a spot sample through the original stop", () => {
    const out = rLockStep({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      price: 98.4,
      params: { startR: 0, stepR: 0.25, maxR: 6 },
    });
    expect(out.exit).toBeNull();
    expect(out.stopBreached).toBe(true);
  });

  it("still surfaces the first adverse bar breach while lock exits are disabled", () => {
    const out = rLockReplayBars({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      params: { startR: 0, stepR: 0.25, maxR: 6 },
      sinceOpenTime: 1_000,
      bars: [
        { openTime: 1_000, closeTime: 1_299_999, high: 100.2, low: 99.4 },
        { openTime: 1_300_000, closeTime: 1_599_999, high: 99.1, low: 98.2 },
        { openTime: 1_600_000, closeTime: 1_899_999, high: 103, low: 99 },
      ],
    });
    expect(out.exit).toBeNull();
    expect(out.stopBreach).toEqual({ atTime: 1_599_999, price: 98.2 });
  });
});

describe("matchLiveDealVolume — one trade's exchange fills only", () => {
  const deal = (side: number, vol: number, ts: number) => ({ side, vol, ts });

  it("ignores the prior same-pair trade's close before this entry", () => {
    const matched = matchLiveDealVolume(
      [
        deal(4, 10, 999), // previous trade closed just before the new entry
        deal(4, 3, 1_100),
        deal(4, 2, 1_200),
      ],
      { side: 4, entryTime: 1_000, volContracts: 5 },
    );
    expect(matched.map((m) => m.vol)).toEqual([3, 2]);
    expect(matched.every((m) => m.deal.ts >= 1_000)).toBe(true);
  });

  it("takes partial fills oldest-first and never exceeds recorded volume", () => {
    const matched = matchLiveDealVolume(
      [deal(4, 8, 1_200), deal(4, 3, 1_100), deal(4, 9, 1_300)],
      { side: 4, entryTime: 1_000, volContracts: 5 },
    );
    expect(matched.map((m) => m.deal.ts)).toEqual([1_100, 1_200]);
    expect(matched.map((m) => m.vol)).toEqual([3, 2]);
    expect(matched.reduce((n, m) => n + m.vol, 0)).toBe(5);
  });

  it("rejects malformed time/volume instead of guessing a trade", () => {
    expect(
      matchLiveDealVolume([deal(4, 5, 0)], { side: 4, entryTime: 1_000, volContracts: 5 }),
    ).toEqual([]);
    expect(
      matchLiveDealVolume([deal(4, Number.NaN, 1_100)], {
        side: 4,
        entryTime: 1_000,
        volContracts: 5,
      }),
    ).toEqual([]);
  });
});

describe("recordLiveCloseWrite — only an explicit ok:true counts", () => {
  it("records an acknowledged close", async () => {
    await expect(recordLiveCloseWrite(async () => ({ ok: true }))).resolves.toBe("recorded");
  });

  it("does not double-count a row another pass already closed", async () => {
    await expect(recordLiveCloseWrite(async () => ({ ok: false, reason: "not-open" }))).resolves.toBe(
      "already-closed",
    );
  });

  it("never counts a failed or unrecognised ledger write", async () => {
    await expect(
      recordLiveCloseWrite(async () => {
        throw new Error("write conflict");
      }),
    ).resolves.toBe("write-failed");
    await expect(recordLiveCloseWrite(async () => undefined)).resolves.toBe("write-failed");
    await expect(recordLiveCloseWrite(async () => ({ ok: false, reason: "invalid-bracket" }))).resolves.toBe(
      "write-failed",
    );
  });
});

describe("manualCloseAck — trust the final ledger state over a stale action reply", () => {
  it("reports success when the order action errored but the row is already closed", () => {
    expect(manualCloseAck({ reportedOk: false, stillOpen: false, reason: "write failed" })).toEqual({
      ok: true,
      reason: "Close completed; the ledger row is already closed.",
    });
  });

  it("reports acceptance without claiming the ledger fill is settled", () => {
    expect(manualCloseAck({ reportedOk: false, stillOpen: true, accepted: true })).toEqual({
      ok: true,
      reason: "Close order accepted; awaiting the exchange fill and ledger reconciliation.",
    });
  });

  it("does not claim success while an unaccepted order leaves the row open", () => {
    expect(manualCloseAck({ reportedOk: true, stillOpen: true })).toEqual({
      ok: false,
      reason:
        "The exchange close completed, but the ledger row is still open; the next exit pass will reconcile it.",
    });
  });

  it("preserves a genuine order failure", () => {
    expect(manualCloseAck({ reportedOk: false, stillOpen: true, reason: "MEXC rejected order" })).toEqual({
      ok: false,
      reason: "MEXC rejected order",
    });
  });
});

describe("roundVol — never oversizes", () => {
  it("floors to the contract's volume precision", () => {
    expect(roundVol(6.9999, 0)).toBe(6);
    expect(roundVol(6.9999, 2)).toBeCloseTo(6.99, 10);
  });
});
