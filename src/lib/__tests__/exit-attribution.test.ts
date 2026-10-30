/**
 * LEDGER HONESTY — exit attribution, fee accounting, and the R invariant.
 *
 * Three defects in how the books RECORD trades (not how they choose them) made
 * three consecutive audits infer most of the ledger:
 *
 *   1. 47% of live exits carried a shrug — "Closed on exchange (manual / TP-SL
 *      / liquidation)" — which names four possibilities and identifies none.
 *   2. Reconciled rows recorded only the CLOSING-side fee (ratio 0.433 of the
 *      true bill vs an exact 1.000 on engine-priced rows), under-counting fees
 *      by ~26%, so the live book looked cheaper than it is.
 *   3. Six winners were +15.40R — 74% of the book's net — on exits whose
 *      realizedR EXCEEDED their own recorded trailPeakR, which is arithmetically
 *      impossible (peak and lock are written in one atomic running-max patch).
 *
 * Each rule below is pinned so the ledger cannot quietly go back to inferring.
 */

import { describe, it, expect } from "vitest";
import {
  LEGACY_EXIT_REASON,
  dealSidesFor,
  detectAttributionAnomaly,
  nameExitFromFill,
  planLiveExitRelabel,
} from "../live-math";
import { computeFlowMetrics } from "../mexc/metrics";
import { gateReachabilityWarnings, resolveConfig } from "../layer2-signal";

describe("dealSidesFor — both legs of a round trip are recoverable", () => {
  it("maps LONG to open 1 / close 4 and SHORT to open 3 / close 2", () => {
    expect(dealSidesFor("LONG")).toEqual({ open: 1, close: 4 });
    expect(dealSidesFor("SHORT")).toEqual({ open: 3, close: 2 });
  });

  it("never returns the same code for both legs (an entry fee can't hide in the close leg)", () => {
    for (const side of ["LONG", "SHORT"] as const) {
      const s = dealSidesFor(side);
      expect(s.open).not.toBe(s.close);
    }
  });
});

describe("nameExitFromFill — name the exit from its own fill", () => {
  // entry 100, 1.5% stop -> sl 98.5 ; 1.5R lock -> 102.25 ; 6R max -> 109
  const LONG = { slPrice: 98.5, tpPrice: 109, trailLockPrice: 102.25 };

  it("names a stop loss when the fill sits on the stop", () => {
    const r = nameExitFromFill({ fillPrice: 98.4, ...LONG });
    expect(r.name).toBe("Stop Loss");
    expect(r.matched).toBe("stop");
  });

  it("names a take profit when the fill sits on the target", () => {
    const r = nameExitFromFill({ fillPrice: 109, ...LONG });
    expect(r.name).toBe("Take Profit");
    expect(r.matched).toBe("target");
  });

  it("names a trail lock when the fill sits on the recorded rung", () => {
    const r = nameExitFromFill({ fillPrice: 102.25, ...LONG });
    expect(r.name).toBe("Trail Lock");
    expect(r.matched).toBe("trail");
  });

  it("tolerates 0.5% of market-close slippage", () => {
    // 98.5 * 1.004 = 98.894 -> 0.4% off the stop
    expect(nameExitFromFill({ fillPrice: 98.89, ...LONG }).name).toBe("Stop Loss");
    expect(nameExitFromFill({ fillPrice: 102.25 * 0.996, ...LONG }).name).toBe("Trail Lock");
  });

  it("does NOT launder a fill that matches no bracket", () => {
    // 2% away from the stop and nowhere near anything else.
    const r = nameExitFromFill({ fillPrice: 100.5, ...LONG });
    expect(r.name).toBe("Closed off-engine (fill matches no bracket)");
    expect(r.matched).toBe("none");
  });

  it("refuses to name the six impossible winners a 'Trail Lock'", () => {
    // The real row: lock at 1.50R (102.25) but the fill landed at 3.16R
    // (104.74) with peakR 1.71. Nearest bracket is the lock, 2.4% away — well
    // outside tolerance, so it must be reported as unexplained rather than
    // attributed to a rung the position never reached.
    const r = nameExitFromFill({ fillPrice: 104.74, ...LONG });
    expect(r.name).toBe("Closed off-engine (fill matches no bracket)");
    expect(r.matched).toBe("none");
    expect(r.distancePct).toBeGreaterThan(0.5);
  });

  it("falls back safely when there is nothing to compare against", () => {
    expect(nameExitFromFill({ fillPrice: 100 }).name).toBe(
      "Closed off-engine (fill matches no bracket)",
    );
    expect(Number.isNaN(nameExitFromFill({ fillPrice: 100 }).distancePct)).toBe(true);
    expect(nameExitFromFill({ fillPrice: 0, ...LONG }).matched).toBe("none");
    expect(nameExitFromFill({ fillPrice: NaN, ...LONG }).matched).toBe("none");
  });

  it("honours an explicit tolerance override", () => {
    const loose = nameExitFromFill({ fillPrice: 104.74, ...LONG, tolPct: 5 });
    expect(loose.name).toBe("Trail Lock");
  });
});

describe("detectAttributionAnomaly — realizedR can never exceed the peak", () => {
  // The six real rows, as a trail-family close.
  for (const [realizedR, trailPeakR] of [
    [3.16, 1.71],
    [2.77, 1.97],
    [2.7, 2.34],
    [2.1, 1.85],
    [2.25, 1.56],
    [2.41, 2.02],
  ] as const) {
    it(`fires on the real row ${realizedR}R above peak ${trailPeakR}R (trail exit)`, () => {
      const msg = detectAttributionAnomaly({ realizedR, trailPeakR, reason: "Trail Lock" });
      expect(msg).toBeTruthy();
      expect(msg).toContain(realizedR.toFixed(2));
      expect(msg).toContain(trailPeakR.toFixed(2));
    });
  }

  it("fires on the same rows when the close reason is unexplained", () => {
    // The original six carried no named trigger — the closes the fix exists for.
    expect(
      detectAttributionAnomaly({ realizedR: 3.16, trailPeakR: 1.71, reason: "Closed off-engine (fill matches no bracket)" }),
    ).toBeTruthy();
    // No reason at all is NOT an explanation — checked.
    expect(detectAttributionAnomaly({ realizedR: 3.16, trailPeakR: 1.71 })).toBeTruthy();
    expect(detectAttributionAnomaly({ realizedR: 3.16, trailPeakR: 1.71, reason: "R-Lock Max" })).toBeTruthy();
  });

  it("stays silent when the reason already explains the exit (audit finding 1)", () => {
    // TP backstop: the exchange bracket can fill a target the 5-minute monitor
    // never sampled, so the recorded peak can legitimately lag the fill.
    expect(detectAttributionAnomaly({ realizedR: 6.0, trailPeakR: 5.4, reason: "Take Profit" })).toBeUndefined();
    // A stop fills at −1R minus slippage — never above any peak.
    expect(detectAttributionAnomaly({ realizedR: -1.02, trailPeakR: 0.9, reason: "Stop Loss" })).toBeUndefined();
    // Manual close: the action explains the exit, exitOrderId is recorded.
    expect(detectAttributionAnomaly({ realizedR: 4.0, trailPeakR: 1.0, reason: "Manual close" })).toBeUndefined();
  });

  it("stays silent on every legitimate trail path", () => {
    // rung exit: fill at or below the rung, i.e. realizedR <= peak
    expect(detectAttributionAnomaly({ realizedR: 1.5, trailPeakR: 1.75, reason: "Trail Lock" })).toBeUndefined();
    // max-target exit: realizedR == maxR, peak reached it
    expect(detectAttributionAnomaly({ realizedR: 6, trailPeakR: 6, reason: "R-Lock Max" })).toBeUndefined();
    // exactly equal is fine
    expect(detectAttributionAnomaly({ realizedR: 2.0, trailPeakR: 2.0, reason: "Trail Lock" })).toBeUndefined();
    // a stop never exceeds the peak
    expect(detectAttributionAnomaly({ realizedR: -1.02, trailPeakR: 0.9, reason: "Trail Lock" })).toBeUndefined();
  });

  it("tolerates slippage slack but not a real overshoot", () => {
    expect(detectAttributionAnomaly({ realizedR: 1.505, trailPeakR: 1.5, reason: "Trail Lock" })).toBeUndefined();
    // 0.04R above peak — inside the 0.05R slack (observed rung slippage is adverse-only)
    expect(detectAttributionAnomaly({ realizedR: 1.54, trailPeakR: 1.5, reason: "Trail Lock" })).toBeUndefined();
    // 0.06R above peak — outside slack, fires. Every real anomaly was >= 0.35R.
    expect(detectAttributionAnomaly({ realizedR: 1.56, trailPeakR: 1.5, reason: "Trail Lock" })).toBeTruthy();
  });

  it("skips trades with no peak to compare against (pre-lock era)", () => {
    expect(detectAttributionAnomaly({ realizedR: 3.0, reason: "Trail Lock" })).toBeUndefined();
    expect(detectAttributionAnomaly({ trailPeakR: 1.0, reason: "Trail Lock" })).toBeUndefined();
    expect(detectAttributionAnomaly({ realizedR: null, trailPeakR: 1.0 })).toBeUndefined();
    expect(detectAttributionAnomaly({ realizedR: 3.0, trailPeakR: NaN, reason: "Trail Lock" })).toBeUndefined();
  });
});

describe("computeFlowMetrics — silence is not balance", () => {
  const t = (size: number, isBuyerMaker: boolean, time: number) => ({
    price: 100,
    size,
    time,
    isBuyerMaker,
  });

  it("marks an empty window INVALID rather than neutral", () => {
    // This is the whole defect: 68.5% of archived ticks carried flowBias === 0
    // because the 5s window caught nothing, and the short-flow gate read that
    // missing reading as "no sell-flow confirmation".
    const f = computeFlowMetrics([], 5000, 1_000_000);
    expect(f.bias).toBe(0);
    expect(f.samples).toBe(0);
    expect(f.valid).toBe(false);
  });

  it("distinguishes a genuinely balanced window from an empty one", () => {
    const balanced = computeFlowMetrics(
      [t(10, false, 999_000), t(10, true, 999_500)], // equal buy and sell volume
      5000,
      1_000_000,
    );
    expect(balanced.bias).toBe(0); // same number as the silent case...
    expect(balanced.samples).toBe(2);
    expect(balanced.valid).toBe(true); // ...but a real measurement
  });

  it("still reports directional flow", () => {
    const buys = computeFlowMetrics(
      [t(30, false, 999_000), t(10, true, 999_100)],
      5000,
      1_000_000,
    );
    expect(buys.bias).toBeCloseTo(0.5, 10);
    expect(buys.valid).toBe(true);
  });

  it("only counts trades inside the window", () => {
    const f = computeFlowMetrics(
      [t(10, true, 900_000), t(10, false, 999_000)], // first is 100s old
      5000,
      1_000_000,
    );
    expect(f.samples).toBe(1);
    expect(f.valid).toBe(true);
    expect(f.bias).toBe(1); // only the aggressive buy is in the window
  });
});

describe("gateReachabilityWarnings — no threshold that cannot bind", () => {
  it("flags the shipped minGap, which the trend gate makes unreachable", () => {
    const warnings = gateReachabilityWarnings(resolveConfig(null));
    expect(resolveConfig(null).minGap).toBe(2);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("minGap 2");
    expect(warnings[0]).toContain("no-op");
  });

  it("stays quiet for a value that can actually bind", () => {
    const cfg = { ...resolveConfig(null), minGap: 10 };
    expect(gateReachabilityWarnings(cfg)).toEqual([]);
  });

  it("stays quiet when the requirement is disabled", () => {
    const cfg = { ...resolveConfig(null), minGap: 0 };
    expect(gateReachabilityWarnings(cfg)).toEqual([]);
  });

  it("reports but never mutates the config", () => {
    const cfg = resolveConfig(null);
    const before = cfg.minGap;
    gateReachabilityWarnings(cfg);
    expect(cfg.minGap).toBe(before);
  });
});

describe("planLiveExitRelabel — naming the exits that closed before attribution existed", () => {
  // entry 100, 1.5% stop -> sl 98.5 (1R = 1.50) ; 2R target -> tp 103 ; 1.5R lock -> 102.25
  const shrug = (over: Record<string, unknown>) => ({
    reason: LEGACY_EXIT_REASON,
    entryPrice: 100,
    slPrice: 98.5,
    tpPrice: 103,
    ...over,
  });

  it("names a stop from the fill that landed on it", () => {
    expect(planLiveExitRelabel(shrug({ exitPrice: 98.3, realizedR: -1.13 })).reason).toBe("Stop Loss");
  });

  it("names a target from the fill that landed on it", () => {
    expect(planLiveExitRelabel(shrug({ exitPrice: 103.1, realizedR: 2.07 })).reason).toBe("Take Profit");
  });

  it("names a lock from the fill that landed on it", () => {
    const p = planLiveExitRelabel(shrug({ trailLockPrice: 102.25, exitPrice: 102.1, realizedR: 1.4 }));
    expect(p.reason).toBe("Trail Lock");
  });

  it("refuses to launder an unmatched fill into a plausible cause", () => {
    const p = planLiveExitRelabel(
      shrug({ trailLockPrice: 102.25, exitPrice: 104.74, realizedR: 3.16, trailPeakR: 1.71 }),
    );
    expect(p.reason).toBe("Closed off-engine (fill matches no bracket)");
  });

  it("flags the six-row case: a fill above the trade's OWN recorded peak", () => {
    // This is the shape that hid +15.40R — and it is only reachable by
    // relabelling first, because the shrug is not in the invariant's check set.
    const withoutRelabel = planLiveExitRelabel(
      shrug({ trailLockPrice: 102.25, exitPrice: 104.74, realizedR: 3.16, trailPeakR: 1.71 }),
    );
    expect(withoutRelabel.attributionAnomaly).toContain("exceeds trailPeakR");

    const alreadyOnShrug = detectAttributionAnomaly({
      realizedR: 3.16,
      trailPeakR: 1.71,
      reason: LEGACY_EXIT_REASON,
    });
    expect(alreadyOnShrug).toBeUndefined();
  });

  it("leaves a reason the engine set from an order it placed", () => {
    for (const reason of ["Stop Loss", "Take Profit", "Trail Lock", "R-Lock Max", "Manual close"]) {
      expect(planLiveExitRelabel(shrug({ reason, exitPrice: 98.3, realizedR: -1.13 })).reason).toBeUndefined();
    }
  });

  it("cannot name a row with no recovered fill, and writes nothing", () => {
    expect(planLiveExitRelabel(shrug({ exitPrice: undefined }))).toEqual({});
    expect(planLiveExitRelabel(shrug({ exitPrice: 0 }))).toEqual({});
  });

  it("never overwrites a verdict already stored", () => {
    const p = planLiveExitRelabel(
      shrug({
        reason: "Trail Lock",
        exitPrice: 104.74,
        realizedR: 3.16,
        trailPeakR: 1.71,
        attributionAnomaly: "realizedR 3.16 exceeds trailPeakR 1.71 — exit provenance unexplained",
      }),
    );
    expect(p).toEqual({});
  });

  it("stays quiet on a healthy rung exit", () => {
    const p = planLiveExitRelabel(
      shrug({ reason: "Trail Lock", exitPrice: 102.1, realizedR: 1.4, trailPeakR: 1.6 }),
    );
    expect(p).toEqual({});
  });

  it("is idempotent: applying the plan twice changes nothing the second time", () => {
    const row = shrug({ trailLockPrice: 102.25, exitPrice: 104.74, realizedR: 3.16, trailPeakR: 1.71 });
    const first = planLiveExitRelabel(row);
    const applied = { ...row, ...first };
    expect(planLiveExitRelabel(applied)).toEqual({});
  });
});
