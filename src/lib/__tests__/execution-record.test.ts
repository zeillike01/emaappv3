/**
 * EXECUTION RECORD (Stage 3). The properties that matter: R is measured from
 * the ACTUAL fill, the liq level is where the sizing thinks it is, a stop fill
 * beyond liquidation is FLAGGED rather than averaged in, and — the fail-open
 * contract — a bad logging input returns null so the writer never touches the
 * trade row.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  EXEC_FLAGS,
  buildEntryExec,
  buildExitExec,
  liqDistancePct,
  liqPriceFor,
  mergeExec,
  realizedRFromFill,
  stopBeyondLiquidation,
} from "../execution-record";

describe("liqPriceFor / liqDistancePct", () => {
  it("places a 20x long ~4.5% below entry and a short the same above", () => {
    const long = liqPriceFor({ side: "LONG", entryPrice: 100, leverage: 20 })!;
    expect(long).toBeCloseTo(100 * (1 - (1 / 20 - 0.005)), 8);
    const short = liqPriceFor({ side: "SHORT", entryPrice: 100, leverage: 20 })!;
    expect(short).toBeCloseTo(100 * (1 + (1 / 20 - 0.005)), 8);
    expect(liqDistancePct({ entryPrice: 100, liqPrice: long })).toBeCloseTo(4.5, 3);
  });

  it("tells you whether a 1.5% stop is reachable at all: yes at 30x, no at 60x", () => {
    const stop = 100 * (1 - 0.015);
    const liq30 = liqPriceFor({ side: "LONG", entryPrice: 100, leverage: 30 })!;
    // 30x: liquidation is ~2.83% away, so the 1.5% stop fires first.
    expect(liq30).toBeLessThan(stop);
    expect(liqDistancePct({ entryPrice: 100, liqPrice: liq30 })).toBeCloseTo(2.8333, 3);
    // 60x: liquidation is only ~1.17% away — the stop can never be reached.
    const liq60 = liqPriceFor({ side: "LONG", entryPrice: 100, leverage: 60 })!;
    expect(liq60).toBeGreaterThan(stop);
    expect(liqDistancePct({ entryPrice: 100, liqPrice: liq60 })).toBeCloseTo(1.1667, 3);
  });

  it("returns null for nonsense leverage instead of a fake level", () => {
    expect(liqPriceFor({ side: "LONG", entryPrice: 100, leverage: 0 })).toBeNull();
    expect(liqPriceFor({ side: "LONG", entryPrice: 0, leverage: 20 })).toBeNull();
    expect(liqPriceFor({ side: "LONG", entryPrice: 100, leverage: 2, maintenanceMarginRate: 0.6 })).toBeNull();
  });
});

describe("buildEntryExec", () => {
  const base = {
    side: "LONG" as const,
    intendedPrice: 100,
    fillPrice: 100.05,
    stopPrice: 98.5,
    targetPrice: 103,
    decisionTs: 1_000_000,
    submittedAt: 1_060_000,
    fillTime: 1_061_000,
    leverage: 20,
  };

  it("records intended vs fill and the slippage in bps", () => {
    const exec = buildEntryExec(base)!;
    expect(exec.intendedPrice).toBe(100);
    expect(exec.fillPrice).toBe(100.05);
    expect(exec.slippageBps).toBeCloseTo(5, 4); // 0.05/100 = 5bps
    expect(exec.stopTrigger).toBe(98.5);
    expect(exec.liqPrice).toBeGreaterThan(0);
    expect(exec.liqDistancePct).toBeCloseTo(4.5, 2);
    expect(exec.flags).not.toContain(EXEC_FLAGS.LATE_ORDER);
  });

  it("flags a late order, a missing intended price, rejects and partials", () => {
    const exec = buildEntryExec({
      ...base,
      intendedPrice: null,
      submittedAt: base.decisionTs + 9 * 60_000,
      rejects: 2,
      partialFills: 1,
    })!;
    expect(exec.decisionToOrderMs).toBe(9 * 60_000);
    expect(exec.flags).toEqual(
      expect.arrayContaining([
        EXEC_FLAGS.MISSING_INTENDED,
        EXEC_FLAGS.LATE_ORDER,
        EXEC_FLAGS.REJECTED,
        EXEC_FLAGS.PARTIAL_FILL,
      ]),
    );
  });

  it("returns null when there is no usable fill (writer must skip)", () => {
    expect(buildEntryExec({ side: "LONG", fillPrice: 0 })).toBeNull();
    expect(buildEntryExec({ side: "LONG", fillPrice: Number.NaN })).toBeNull();
  });
});

describe("buildExitExec", () => {
  const entry = buildEntryExec({
    side: "LONG",
    intendedPrice: 100,
    fillPrice: 100,
    stopPrice: 98.5,
    leverage: 20,
  })!;

  it("measures realizedR from the ACTUAL stop fill, not an assumed -1R", () => {
    const exit = buildExitExec({
      entry,
      side: "LONG",
      entryPrice: 100,
      stopPrice: 98.5,
      stopTrigger: 98.5,
      stopFill: 98.42, // 0.8bps of extra slip through the stop
      exitPrice: 98.42,
      exitTime: 1_000_000 + 60 * 60_000,
      entryTime: 1_000_000,
      reason: "Stop Loss",
    })!;
    expect(exit.stopTrigger).toBe(98.5);
    expect(exit.stopFill).toBe(98.42);
    expect(exit.realizedR).toBeLessThan(-1);
    expect(exit.realizedR).not.toBe(-1);
    expect(exit.barsHeld).toBe(60);
    expect(stopBeyondLiquidation(exit)).toBe(false);
  });

  it("flags a stop fill beyond liquidation", () => {
    const exec = buildExitExec({
      entry,
      side: "LONG",
      entryPrice: 100,
      stopPrice: 98.5,
      stopTrigger: 98.5,
      stopFill: 94, // 20x long liquidates at ~95.5
      exitPrice: 94,
      exitTime: 1_000_000 + 60_000,
      entryTime: 1_000_000,
      reason: "Stop Loss",
    })!;
    expect(exec.liqPrice).toBeCloseTo(95.5, 6);
    expect(stopBeyondLiquidation(exec)).toBe(true);
    expect(exec.flags).toContain(EXEC_FLAGS.STOP_BEYOND_LIQ);
  });

  it("does not treat a take-profit fill as a stop fill", () => {
    const exec = buildExitExec({
      entry,
      side: "SHORT",
      entryPrice: 100,
      stopPrice: 101.5,
      exitPrice: 97,
      exitTime: 1_000_000 + 120_000,
      entryTime: 1_000_000,
      riskPx: 1.5,
      reason: "Take Profit",
    })!;
    expect(exec.stopFill).toBeNull();
    expect(exec.realizedR).toBeCloseTo(2, 6);
    expect(stopBeyondLiquidation(exec)).toBe(false);
  });

  it("returns null when the exit has no usable price", () => {
    expect(
      buildExitExec({ entry, side: "LONG", entryPrice: 100, exitPrice: 0, exitTime: 1, reason: "Stop Loss" }),
    ).toBeNull();
  });
});

describe("mergeExec — a log write must never DESTROY a measured field", () => {
  it("an entry write cannot erase the exit half of a closed row", () => {
    // `buildEntryExec` returns every exit-side field as an explicit null, and
    // mergeExec used to apply nulls. So an entry record landing after the exit —
    // a delayed scheduler retry, a re-run — wiped realizedR, mfeR, maeR,
    // barsHeld and the exit reason off a closed trade.
    const exitRec = buildExitExec({
      entry: null,
      side: "LONG",
      entryPrice: 100,
      stopPrice: 98.5,
      stopTrigger: 98.5,
      stopFill: 98.45,
      exitPrice: 98.45,
      exitTime: 100 + 3 * 3_600_000,
      entryTime: 100,
      riskPx: 1.5,
      reason: "Stop Loss",
      feeUsd: 0.4,
      fundingPaidUsd: 0.02,
      mfeR: 0.8,
      maeR: 1.02,
    })!;
    const entryWrite = buildEntryExec({
      side: "LONG",
      intendedPrice: 100,
      fillPrice: 100.2,
      stopPrice: 98.5,
      leverage: 20,
    })!;
    expect(entryWrite.exitReason).toBeNull(); // the shape that caused the damage

    const after = mergeExec(exitRec, entryWrite)!;
    expect(after.exitReason).toBe(exitRec.exitReason);
    expect(after.exitPrice).toBe(exitRec.exitPrice);
    expect(after.exitTime).toBe(exitRec.exitTime);
    expect(after.realizedR).toBe(exitRec.realizedR);
    expect(after.mfeR).toBe(exitRec.mfeR);
    expect(after.maeR).toBe(exitRec.maeR);
    expect(after.barsHeld).toBe(exitRec.barsHeld);
    expect(after.stopFill).toBe(exitRec.stopFill);
    // ...while the entry half still updates.
    expect(after.fillPrice).toBe(100.2);
  });

  it("still unions flags instead of replacing them", () => {
    const base = mergeExec(null, { side: "LONG", fillPrice: 100, flags: ["a"] })!;
    const merged = mergeExec(base, { flags: ["b"] })!;
    expect(merged.flags.sort()).toEqual(["a", "b"]);
  });
});

describe("mergeExec — the fail-open contract", () => {
  it("merges a valid patch and keeps earlier facts", () => {
    const entry = buildEntryExec({ side: "LONG", intendedPrice: 100, fillPrice: 100.2, stopPrice: 98.5, leverage: 20 })!;
    const merged = mergeExec(entry, { stopFill: 98.4, exitReason: "Stop Loss", realizedR: -1.2, exitPrice: 98.4 })!;
    expect(merged.intendedPrice).toBe(100);
    expect(merged.stopFill).toBe(98.4);
    expect(merged.exitReason).toBe("Stop Loss");
  });

  it("de-duplicates flags across merges", () => {
    const merged = mergeExec(
      { fillPrice: 100, flags: [EXEC_FLAGS.LATE_ORDER] },
      { flags: [EXEC_FLAGS.LATE_ORDER, EXEC_FLAGS.REJECTED] },
    )!;
    expect(merged.flags).toEqual([EXEC_FLAGS.LATE_ORDER, EXEC_FLAGS.REJECTED]);
  });

  it("returns null (no write) for a non-object patch, a NaN, or no fill", () => {
    expect(mergeExec({ fillPrice: 100 }, null)).toBeNull();
    expect(mergeExec({ fillPrice: 100 }, "not a record")).toBeNull();
    expect(mergeExec({ fillPrice: 100 }, { realizedR: Number.NaN })).toBeNull();
    expect(mergeExec(null, { exitReason: "Stop Loss" })).toBeNull(); // no fill price anywhere
  });

  it("ignores undefined members of a patch instead of nulling them", () => {
    const merged = mergeExec({ fillPrice: 100, mfeR: 2.5 }, { mfeR: undefined, maeR: 0.4 })!;
    expect(merged.mfeR).toBe(2.5);
    expect(merged.maeR).toBe(0.4);
  });
});

describe("realizedRFromFill", () => {
  it("uses the frozen ruler when one is given", () => {
    expect(realizedRFromFill({ side: "LONG", entryPrice: 100, exitPrice: 103, riskPx: 1.5 })).toBeCloseTo(2, 6);
  });
  it("falls back to the stop distance and refuses a zero ruler", () => {
    expect(realizedRFromFill({ side: "SHORT", entryPrice: 100, exitPrice: 97, stopPrice: 101.5 })).toBeCloseTo(2, 6);
    expect(realizedRFromFill({ side: "LONG", entryPrice: 100, exitPrice: 103, riskPx: 0, stopPrice: 100 })).toBeNull();
  });
});

describe("writer guards — the logging path cannot touch a trade (Stage 3)", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "convex", "executionRecord.ts"), "utf8");

  it("writes exactly one field, and only that field", () => {
    const chunks = src.split("ctx.db.patch(").slice(1);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const call = chunk.slice(0, chunk.indexOf(");"));
      expect(call).toContain("exec: next"); // the ONLY field any patch sets
    }
    // No row can be created or wholesale-replaced by this module either.
    expect(src).not.toContain("ctx.db.replace(");
    expect(src).not.toContain('ctx.db.insert("paperTrades"');
    expect(src).not.toContain('ctx.db.insert("liveTrades"');
    expect(src).not.toContain('ctx.db.delete(');
  });

  it("returns WITHOUT writing when the pure builder rejects the input", () => {
    expect(src).toMatch(/if \(!next\) return \{ ok: false, reason: "invalid-input" \};[^\n]*\n\s*await ctx\.db\.patch/);
    expect((src.match(/if \(!next\)/g) ?? []).length).toBe(3); // entry, exit, backfill
  });

  it("schedules every record write as its own mutation and swallows failures", () => {
    expect(src).toContain("runAfter(0,");
    expect(src).toMatch(/catch \{\s*return false;/);
  });

  it("is wired from both books, on entry and on exit", () => {
    const call = (f: string) =>
      fs.readFileSync(path.join(__dirname, "..", "..", "convex", f), "utf8");
    expect(call("strategyEngine.ts")).toContain("scheduleEntryRecordByKey");
    expect(call("strategyEngine.ts")).toContain("scheduleExecRecord");
    expect(call("liveBrokerRuntime.ts")).toContain("scheduleExecRecord");
    expect(call("liveEngine.ts")).toContain("scheduleExecRecord");
  });

  it("keeps the exec field declared on both trade tables", () => {
    const schema = call_schema();
    expect((schema.match(/exec: v\.optional\(v\.any\(\)\)/g) ?? []).length).toBe(2);
  });

  function call_schema() {
    return fs.readFileSync(path.join(__dirname, "..", "..", "convex", "schema.ts"), "utf8");
  }
});
