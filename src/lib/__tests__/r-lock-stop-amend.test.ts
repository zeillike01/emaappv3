import { describe, expect, test } from "vitest";
import { stopAmendDecision } from "../r-lock";

// LONG entry 100, riskPx 1.5 (1.5% stop) → original slPrice 98.5.
// Rungs: 1.5R → 102.25, 1.75R → 102.625, 2R → 103.0 …
// SHORT entry 100 → original slPrice 101.5; rung 1.5R → 97.75.

describe("stopAmendDecision", () => {
  const base = {
    side: "LONG" as const,
    entryPrice: 100,
    riskPx: 1.5,
  };

  test("no lock → never amend", () => {
    const d = stopAmendDecision({ ...base, lockPrice: 0, exchangeSlPrice: 98.5 });
    expect(d.amend).toBe(false);
  });

  test("amend that would LOOSEN the stop is refused", () => {
    // corrupt/legacy resting level above the rung (LONG): moving the stop to
    // the rung would widen protection — refused, not clamped.
    const d = stopAmendDecision({ ...base, lockPrice: 102.25, exchangeSlPrice: 102.5 });
    expect(d.amend).toBe(false);
  });

  test("first rung on the original adverse stop → amend, kind=replace", () => {
    const d = stopAmendDecision({ ...base, lockPrice: 102.25, exchangeSlPrice: 98.5 });
    expect(d.amend).toBe(true);
    expect(d.amendPrice).toBe(102.25);
    expect(d.kind).toBe("replace");
    expect(d.lockR).toBeCloseTo(1.5, 6);
  });

  test("second ratchet on an already-amended stop → amend, kind=tighten", () => {
    const d = stopAmendDecision({ ...base, lockPrice: 103.0, exchangeSlPrice: 102.25 });
    expect(d.amend).toBe(true);
    expect(d.amendPrice).toBe(103.0);
    expect(d.kind).toBe("tighten");
    expect(d.lockR).toBeCloseTo(2.0, 6);
  });

  test("tiny favourable gap inside epsilon → no amend (exchange not disturbed)", () => {
    // eps default 0.02% of 100 = 0.02; gap 0.01 → below eps
    const d = stopAmendDecision({ ...base, lockPrice: 102.26, exchangeSlPrice: 102.25 });
    expect(d.amend).toBe(false);
  });

  test("equal level → no amend (nothing to do)", () => {
    const d = stopAmendDecision({ ...base, lockPrice: 102.25, exchangeSlPrice: 102.25 });
    expect(d.amend).toBe(false);
  });

  test("unknown resting level → never blind-amend", () => {
    const d = stopAmendDecision({ ...base, lockPrice: 102.25, exchangeSlPrice: null });
    expect(d.amend).toBe(false);
    const d2 = stopAmendDecision({ ...base, lockPrice: 102.25, exchangeSlPrice: 0 });
    expect(d2.amend).toBe(false);
  });

  test("SHORT: rung below entry tightens the stop downward; loosening refused", () => {
    const s = { side: "SHORT" as const, entryPrice: 100, riskPx: 1.5 };
    // resting original stop 101.5, first rung 97.75 → amend down
    const d = stopAmendDecision({ ...s, lockPrice: 97.75, exchangeSlPrice: 101.5 });
    expect(d.amend).toBe(true);
    expect(d.amendPrice).toBe(97.75);
    expect(d.kind).toBe("replace");
    expect(d.lockR).toBeCloseTo(1.5, 6);
    // resting at 97.75, "rung" at 99.0 would LOOSEN → refused
    const d2 = stopAmendDecision({ ...s, lockPrice: 99.0, exchangeSlPrice: 97.75 });
    expect(d2.amend).toBe(false);
    // tighten further: 97.75 → 97.5
    const d3 = stopAmendDecision({ ...s, lockPrice: 97.5, exchangeSlPrice: 97.75 });
    expect(d3.amend).toBe(true);
    expect(d3.kind).toBe("tighten");
  });

  test("riskPx missing → lockR falls back to |entry − resting SL| as the ruler", () => {
    const d = stopAmendDecision({
      side: "LONG",
      entryPrice: 100,
      lockPrice: 102.25,
      exchangeSlPrice: 98.5,
    });
    expect(d.amend).toBe(true);
    expect(d.lockR).toBeCloseTo(1.5, 6); // (102.25−100)/1.5
  });
});
