/**
 * EXIT REPLAY (2026-10-10). Pins the four rules the counterfactual pricer must
 * never get wrong: the same R-lock rule the books run (`rLockBarStep`), the
 * stop-before-lock ambiguity rule, the horizon cap, and a cost model that
 * matches the ledger (entry taker + exit taker/maker + funding windows).
 */
import { describe, expect, it } from "vitest";
import { rLockBarStep } from "../r-lock";
import { TAKER_FEE, MAKER_FEE, FUNDING_PER_8H } from "../exit-telemetry";
import {
  DEFAULT_HORIZON_MS,
  aggregateBars,
  bracketForVariant,
  checkParity,
  entryBarAfter,
  replayCostR,
  replayExit,
  REASON_TOLERANCE_R,
  type ReplayBar,
  type VariantSpec,
} from "../exit-replay";
import { horizonEnded, planEntry, variantLabel } from "../exit-replay-plan";

const MIN = 60_000;
let t0 = 1_750_000_000_000;

function bars(specs: Array<[number, number, number, number]>, start = t0): ReplayBar[] {
  // [open, high, low, close]
  return specs.map(([open, high, low, close], i) => ({
    openTime: start + i * MIN,
    closeTime: start + (i + 1) * MIN,
    open,
    high,
    low,
    close,
  }));
}

describe("entry + helpers", () => {
  it("picks the first bar at/after the decision time", () => {
    const b = bars([[100, 101, 99, 100], [101, 102, 100, 101]], t0 + 5 * MIN);
    expect(entryBarAfter(b, t0 + 5 * MIN - 1)?.openTime).toBe(t0 + 5 * MIN);
    expect(entryBarAfter(b, t0 + 5 * MIN)?.open).toBe(100);
    expect(entryBarAfter(b, t0 + 99 * MIN)).toBeNull();
  });

  it("builds a fixed 2R bracket and an rlock max-target bracket", () => {
    // The variant list itself is exit-replay-plan.defaultVariants (the one the
    // backfill uses); this pins the BRACKET maths for both shapes.
    const specs: VariantSpec[] = [
      { name: "rlock", lock: { startR: 1.5, stepR: 0.25, maxR: 8 }, tpR: null },
      { name: "fixed2R", lock: null, tpR: 2 },
    ];
    const rlockV = specs[0];
    const fixedV = specs[1];
    const fixed = bracketForVariant({ variant: fixedV!, side: "LONG", entryPrice: 100, riskPx: 1.5, fallbackTpR: 2 });
    expect(fixed.tpPrice).toBeCloseTo(103, 10);
    expect(fixed.lock).toBeNull();
    const lock = bracketForVariant({ variant: rlockV!, side: "LONG", entryPrice: 100, riskPx: 1.5, fallbackTpR: 2 });
    expect(lock.tpPrice).toBeCloseTo(112, 10); // 8R
    expect(lock.lock?.startR).toBe(1.5);
  });
});

describe("replayExit — fixed bracket", () => {
  it("stops a long at the stop with 3bps adverse slippage", () => {
    const out = replayExit({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      tpPrice: 103,
      bars: bars([[100, 100.2, 98.4, 99]]),
    });
    expect(out.exitReason).toBe("Stop Loss");
    expect(out.exitPrice).toBeCloseTo(98.5 * (1 - 0.0003), 10);
    expect(out.complete).toBe(true);
    expect(out.barsHeld).toBe(1);
    expect(out.r).toBeLessThan(-1); // -1R gross minus costs
  });

  it("fills a take profit at the target (a resting limit, no slippage)", () => {
    const out = replayExit({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      tpPrice: 103,
      bars: bars([[100, 103.2, 99.8, 103]]),
    });
    expect(out.exitReason).toBe("Take Profit");
    expect(out.exitPrice).toBe(103);
    expect(out.r).toBeCloseTo(2 - replayCostR({ entryPrice: 100, riskPx: 1.5, exitIsMaker: true, holdMs: MIN }), 6);
  });

  it("counts the stop first when one bar spans stop AND target", () => {
    const out = replayExit({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      tpPrice: 103,
      bars: bars([[100, 103.5, 98.4, 102]]),
    });
    expect(out.exitReason).toBe("Stop Loss");
    expect(out.ambiguousBars).toBe(1);
    expect(out.mfeR).toBeCloseTo(3.5 / 1.5, 4);
  });

  it("mirrors the short side", () => {
    const out = replayExit({
      side: "SHORT",
      entryPrice: 100,
      slPrice: 101.5,
      tpPrice: 97,
      bars: bars([[100, 101.6, 96.9, 97.2]]),
    });
    expect(out.exitReason).toBe("Stop Loss");
    expect(out.exitPrice).toBeCloseTo(101.5 * (1 + 0.0003), 10);
    expect(out.ambiguousBars).toBe(1);
  });
});

describe("replayExit — R-lock variant", () => {
  const lock = { startR: 1.5, stepR: 0.25, maxR: 8 };

  it("rides past 2R and exits on the rung with market slippage", () => {
    // Arm: bar 1 peaks at +2.07R (lock -> 2.0R, whole 0.25 steps from 1.5).
    // Bar 2 retraces through the 2.0R rung -> Trail Lock.
    const out = replayExit({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      tpPrice: 112,
      lock,
      bars: bars([
        [100, 103.1, 99.9, 103], // +2.07R peak
        [103, 103.2, 102.5, 102.6],
      ]),
    });
    expect(out.exitReason).toBe("Trail Lock");
    const expectedRung = 100 + 2 * 1.5; // peak 2.07R -> ratchet floor(0.57/0.25)=2 -> 2.0R
    expect(out.exitPrice).toBeCloseTo(expectedRung * (1 - 0.0003), 10);
    expect(out.r).toBeGreaterThan(1.85); // rung 2R minus 3bps slip + fees
  });

  it("uses the SAME rLockBarStep the books use (state agreement)", () => {
    const bar = { high: 103.4, low: 99.8 };
    const direct = rLockBarStep({
      side: "LONG", entryPrice: 100, slPrice: 98.5, riskPx: 1.5, params: lock, bar, state: { peakR: 0, lockPrice: 0 },
    });
    const out = replayExit({
      side: "LONG", entryPrice: 100, slPrice: 98.5, tpPrice: 112, lock,
      bars: bars([[100, bar.high, bar.low, 103]]),
    });
    expect(out.complete).toBe(false); // nothing exited in one bar
    expect(direct.peakR).toBeGreaterThan(1.5);
    expect(direct.lockPrice).toBeGreaterThan(0);
  });

  it("honours R-Lock Max at the top", () => {
    const out = replayExit({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      tpPrice: 112,
      lock,
      bars: bars([[100, 112.5, 111.8, 112.2]]),
    });
    expect(out.exitReason).toBe("R-Lock Max");
    expect(out.r).toBeGreaterThan(7);
  });

  it("books the STOP when a bar spans the armed rung and the stop", () => {
    const out = replayExit({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      tpPrice: 112,
      lock,
      bars: bars([
        [100, 102.9, 99.9, 102.5], // peak 1.93R -> rung 1.75R = 102.625
        [102.6, 102.8, 98.4, 99],  // spans the rung AND the stop
      ]),
    });
    expect(out.exitReason).toBe("Stop Loss");
    expect(out.ambiguousBars).toBe(1);
  });
});

describe("replayExit — horizon + completeness", () => {
  it("caps at the 48h horizon and records its own reason", () => {
    // 49 hourly bars drifting flat, never touching stop or target.
    const huge: ReplayBar[] = Array.from({ length: 49 }, (_, i) => ({
      openTime: t0 + i * 60 * MIN,
      closeTime: t0 + (i + 1) * 60 * MIN,
      open: 100, high: 100.2, low: 99.8, close: 100.05,
    }));
    const out = replayExit({ side: "LONG", entryPrice: 100, slPrice: 98.5, tpPrice: 103, bars: huge });
    expect(out.exitReason).toBe("Horizon");
    expect(out.horizonCapped).toBe(true);
    expect(out.exitTime - out.entryTime).toBeLessThanOrEqual(DEFAULT_HORIZON_MS);
    expect(out.complete).toBe(true);
  });

  it("with the lock armed, books the LAST bar inside the cap, not the first past it", () => {
    const lock = { startR: 5, stepR: 1, maxR: 10 }; // never arms on this drift
    const drifting = bars([
      [100, 100.1, 99.95, 100.0],
      [100, 100.2, 99.95, 100.1],
      [100, 100.25, 99.95, 100.3], // last bar inside the horizon
      [100, 100.4, 99.9, 99.97], // opens AT the cap — must not be priced
    ]);
    const out = replayExit({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      tpPrice: 112,
      lock,
      bars: drifting,
      horizonMs: 3 * MIN,
    });
    expect(out.exitReason).toBe("Horizon");
    expect(out.horizonCapped).toBe(true);
    expect(out.exitPrice).toBe(100.3);
    expect(out.exitTime).toBe(t0 + 3 * MIN);
  });

  it("reports incomplete when the bars run out before any exit", () => {
    const out = replayExit({
      side: "LONG", entryPrice: 100, slPrice: 98.5, tpPrice: 103,
      bars: bars([[100, 100.2, 99.9, 100.1]]),
    });
    expect(out.complete).toBe(false);
  });
});

describe("checkParity", () => {
  it("matches a recorded stop at 5m and reports the 1m sampling error", () => {
    const five = bars([
      [100, 100.2, 99.9, 100],
      [100, 100.1, 98.4, 98.5],
    ]);
    const one = bars([
      [100, 100.2, 99.9, 100],
      [100, 100.1, 99.95, 100],
      [100, 100.05, 98.4, 98.5],
    ]);
    const res = checkParity({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      tpPrice: 103,
      lock: null,
      recordedExitTime: t0 + 3 * MIN,
      recordedExitPrice: 98.5 * (1 - 0.0003),
      recordedReason: "Stop Loss",
      recordedR: -1.002,
      bars5m: five,
      bars1m: one,
    });
    expect(res.replay5Reason).toBe("Stop Loss");
    expect(res.reasonMatch5).toBe(true);
    expect(res.samplingErrorR).toBeGreaterThanOrEqual(0);
  });

  it("flags a mismatch when the replay cannot reproduce the recorded exit", () => {
    const res = checkParity({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      tpPrice: 103,
      lock: null,
      recordedExitTime: t0 + MIN,
      recordedExitPrice: 103,
      recordedReason: "Take Profit",
      recordedR: 2,
      bars5m: bars([[100, 100.2, 99.9, 100]]),
      bars1m: bars([[100, 100.2, 99.9, 100]]),
    });
    expect(res.mismatch).toBe(true);
  });
});

describe("cost model", () => {
  it("charges the ledger's fees + full funding windows", () => {
    const r = replayCostR({ entryPrice: 100, riskPx: 1.5, exitIsMaker: false, holdMs: 16 * 3_600_000 });
    const feeR = (100 * TAKER_FEE + 100 * TAKER_FEE) / 1.5;
    const fundingR = (2 * FUNDING_PER_8H * 100) / 1.5;
    expect(r).toBeCloseTo(feeR + fundingR, 10);
    const maker = replayCostR({ entryPrice: 100, riskPx: 1.5, exitIsMaker: true, holdMs: 0 });
    expect(maker).toBeCloseTo((100 * TAKER_FEE + 100 * MAKER_FEE) / 1.5, 10);
  });
});

describe("planEntry — decision record -> concrete brackets", () => {
  const cfg = {
    trailLockStartR: 1.5,
    trailLockStepR: 0.25,
    trailLockMaxR: 8,
    stopLossPct: 1.5,
    takeProfitPct: 3,
  } as any;

  it("enters on the first 1m bar at/after the decision, at its open", () => {
    const plan = planEntry({
      cfg,
      side: "LONG",
      decisionTs: t0 + 2 * MIN,
      bars: bars([[102, 103, 101, 102], [104, 105, 103, 104]], t0 + 3 * MIN),
    });
    expect(plan?.entryTime).toBe(t0 + 3 * MIN);
    expect(plan?.entryPrice).toBe(102);
    // 1.5% stop off 102, frozen 1R = 102 - 100.47
    expect(plan?.variants[0]!.slPrice).toBeCloseTo(102 * (1 - 0.015), 10);
    expect(plan?.variants[0]!.riskPx).toBeCloseTo(102 * 0.015, 10);
  });

  it("plans the book's lock plus the spec's fixed 2R on the SAME entry", () => {
    const plan = planEntry({ cfg, side: "LONG", decisionTs: t0, bars: bars([[100, 101, 99, 100]]) })!;
    const names = plan.variants.map((v) => v.variant);
    expect(names).toEqual(["rlock", "fixed2R"]);
    const [rlock, fixed] = plan.variants;
    expect(rlock!.tpPrice).toBeCloseTo(100 + 8 * 1.5, 10); // lock max 8R
    expect(fixed!.tpPrice).toBeCloseTo(100 + 2 * 1.5, 10);
    expect(rlock!.slPrice).toBe(fixed!.slPrice);
  });

  it("falls back to the fixed target when the book ships the lock off", () => {
    const noLock = { ...cfg, trailLockStartR: 0 };
    const plan = planEntry({ cfg: noLock, side: "SHORT", decisionTs: t0, bars: bars([[100, 101, 99, 100]]) })!;
    expect(plan.variants.map((v) => v.variant)).toEqual(["fixedTp", "fixed2R"]);
    expect(plan.variants[0]!.lock).toBeNull();
    expect(plan.variants[0]!.tpPrice).toBeCloseTo(100 - 3, 10);
  });

  it("returns null when no bar follows the decision", () => {
    expect(planEntry({ cfg, side: "LONG", decisionTs: t0 + 5 * MIN, bars: bars([[100, 101, 99, 100]]) })).toBeNull();
  });
});

describe("horizonEnded / variantLabel", () => {
  it("refuses to settle a decision whose 48h horizon is still open", () => {
    expect(horizonEnded({ decisionTs: t0, now: t0 + DEFAULT_HORIZON_MS - 1 })).toBe(false);
    expect(horizonEnded({ decisionTs: t0, now: t0 + DEFAULT_HORIZON_MS })).toBe(true);
  });

  it("labels a locked variant with its own parameters", () => {
    expect(variantLabel({ variant: "rlock", lock: { startR: 1.5, stepR: 0.25, maxR: 8 }, slPrice: 0, tpPrice: 0, riskPx: 1 })).toBe(
      "rlock@1.5/0.25/8",
    );
    expect(variantLabel({ variant: "fixed2R", lock: null, slPrice: 0, tpPrice: 0, riskPx: 1 })).toBe("fixed2R");
  });
});

describe("aggregateBars — 5m series without a second fetch", () => {
  // A 5m bar is a WALL-CLOCK window (12:00:00–12:04:59). The buckets must be
  // aligned to it, not anchored on whatever bar the fetch happened to start at.
  const ALIGNED = Math.floor(t0 / (5 * MIN)) * (5 * MIN);
  const SPEC: Array<[number, number, number, number]> = [
    [100, 101, 99, 100.5],
    [100.5, 102, 100, 101],
    [101, 103.5, 100.8, 102],
    [102, 102.2, 98.9, 99],
    [99, 99.5, 98.8, 99.2],
    [99.2, 100, 99, 99.9],
  ];

  it("reproduces OHLC exactly from five 1m bars", () => {
    const five = aggregateBars(bars(SPEC, ALIGNED), 5);
    expect(five.length).toBe(1); // the 6th bar is a partial window -> dropped
    expect(five[0]).toEqual({
      openTime: ALIGNED,
      closeTime: ALIGNED + 5 * MIN,
      open: 100,
      high: 103.5,
      low: 98.8,
      close: 99.2,
    });
  });

  it("drops a leading partial window instead of shifting every later bucket", () => {
    // Start two minutes past a 5m boundary: the first bucket holds 3 bars.
    const five = aggregateBars(bars(SPEC, ALIGNED + 2 * MIN), 5);
    expect(five).toHaveLength(0); // 3-bar head, 3-bar tail: neither is a real 5m bar
    const longer = bars([...SPEC, [99.9, 100.2, 99.5, 100], [100, 100.1, 99.8, 99.9]], ALIGNED + 2 * MIN);
    const five2 = aggregateBars(longer, 5);
    expect(five2).toHaveLength(1);
    expect(five2[0]!.openTime).toBe(ALIGNED + 5 * MIN); // the aligned interior bucket
  });

  it("drops a bucket that has an interior hole", () => {
    const holed = bars(SPEC, ALIGNED).filter((b) => b.openTime !== ALIGNED + 2 * MIN);
    expect(aggregateBars(holed, 5)).toHaveLength(0);
  });

  it("is a no-op for factor <= 1", () => {
    const one = bars([[100, 101, 99, 100]]);
    expect(aggregateBars(one, 1)).toHaveLength(1);
  });
});

describe("checkParity — starts where the trade started", () => {
  it("ignores pre-entry bars that would trip the stop", () => {
    const entry = t0 + 10 * MIN;
    const series: ReplayBar[] = [
      // Ten pre-entry bars dipping far below the stop.
      ...Array.from({ length: 10 }, (_, i) => ({
        openTime: t0 + i * MIN,
        closeTime: t0 + (i + 1) * MIN,
        open: 100, high: 100.2, low: 95, close: 96,
      })),
      // Twenty post-entry bars doing nothing.
      ...Array.from({ length: 20 }, (_, i) => ({
        openTime: entry + i * MIN,
        closeTime: entry + (i + 1) * MIN,
        open: 100, high: 100.2, low: 99.9, close: 100.05,
      })),
    ];
    const common = {
      side: "LONG" as const,
      entryPrice: 100,
      slPrice: 98.5,
      tpPrice: 103,
      recordedExitTime: entry + 20 * MIN,
      recordedExitPrice: 100.05,
      recordedReason: "Horizon",
      recordedR: 0,
      bars5m: series,
      bars1m: series,
    };
    // Without entryTime the replay prices the fetch start — the bug.
    expect(checkParity({ ...common }).replay1Reason).toBe("Stop Loss");
    expect(checkParity({ ...common, entryTime: entry }).replay1Reason).not.toBe("Stop Loss");
  });

  it("matches the REASON strictly and reports R proximity separately", () => {
    const series = bars([
      [100, 100.3, 99.9, 100.1],
      [100.1, 100.2, 99.9, 100.0],
      [100, 100.15, 99.95, 100.05],
    ]);
    // The replay can only reach the horizon here; the RECORDED reason is a
    // take-profit that never happened. R is close (both ~0R), so the old
    // `|| Math.abs(r - recordedR) <= 0.35` clause called this a match.
    const res = checkParity({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      tpPrice: 103,
      recordedExitTime: t0 + 2 * MIN,
      recordedExitPrice: 100.05,
      recordedReason: "Take Profit",
      recordedR: 0.02,
      bars5m: series,
      bars1m: series,
      entryTime: t0,
    });
    expect(res.replay1Reason).toBe("Horizon");
    expect(res.reasonMatch5).toBe(false); // strict: reasons differ
    expect(res.mismatch).toBe(true);
    expect(res.reasonClose5).toBe(true); // the R tolerance is still reported
    expect(Math.abs(res.replay1R - 0.02)).toBeLessThanOrEqual(REASON_TOLERANCE_R);
  });
});

describe("third-pass audit fixes", () => {
  it("a series that stops BEFORE the recorded exit is silence, not a mismatch", () => {
    // One bar, and the recorded exit is well past it. The replay may not have
    // happened at all — its inert Horizon/0 defaults must not be held against
    // the book, because ONE mismatch excludes every gate from tuning.
    const res = checkParity({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      tpPrice: 103,
      lock: null,
      recordedExitTime: t0 + 300 * MIN, // far beyond the single fetched bar
      recordedExitPrice: 102,
      recordedReason: "Take Profit",
      recordedR: 1.3,
      bars5m: bars([[100, 100.2, 99.9, 100]]),
      bars1m: bars([[100, 100.2, 99.9, 100]]),
      entryTime: t0,
    });
    expect(res.complete5).toBe(false);
    expect(res.evaluated).toBe(false);
    expect(res.mismatch).toBe(false); // nothing was established
  });

  it("a series that COVERS the recorded exit and disagrees is still a mismatch", () => {
    // The same wrong-reason case, but the bars span the exit moment — so the
    // replay really did judge the trade.
    const res = checkParity({
      side: "LONG",
      entryPrice: 100,
      slPrice: 98.5,
      tpPrice: 103,
      lock: null,
      recordedExitTime: t0 + 1 * MIN,
      recordedExitPrice: 103,
      recordedReason: "Take Profit",
      recordedR: 2,
      bars5m: bars([[100, 100.2, 99.9, 100]]),
      bars1m: bars([[100, 100.2, 99.9, 100]]),
      entryTime: t0,
    });
    expect(res.complete5).toBe(false); // the series still ran out early...
    expect(res.mismatch).toBe(true); // ...but it covered the exit and disagreed
  });

  it("aggregateBars reads the source interval from the MODAL gap, not the first", () => {
    // 1m bars with the candle at 12:01 missing: the first gap is 2 minutes.
    // Inferring stepMs from bars[1]-bars[0] made every 5m bucket fail its
    // "exactly f contiguous bars" test -> an EMPTY 5m series out of a good 1m
    // one -> parity read "no bars" and reported a mismatch for every trade.
    const start = Date.UTC(2026, 0, 1, 12, 0, 0);
    const series = Array.from({ length: 15 }, (_, i) => ({
      openTime: start + i * 60_000,
      closeTime: start + (i + 1) * 60_000,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
    })).filter((b) => b.openTime !== start + 60_000); // drop 12:01
    const five = aggregateBars(series, 5);
    expect(five.length).toBeGreaterThan(0);
    // Buckets are wall-clock aligned, so the first complete 5m window is 12:05.
    expect(five[0]!.openTime).toBe(start + 5 * 60_000);
    expect(five[0]!.open).toBe(105); // 12:05's open
  });
});
