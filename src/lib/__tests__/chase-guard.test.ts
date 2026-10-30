import { describe, it, expect } from "vitest";
import {
  evaluateChaseGuard,
  mergePendingSignal,
  resolveConfig,
  DEFAULT_CONFIG,
  type PendingSignal,
} from "../layer2-signal";

const cfg = resolveConfig({}); // defaults: drift 0.5%, age 120 min
const cfg30 = resolveConfig({ signalMaxAgeMin: 30 }); // legacy 30-min window for stale tests
const T0 = 1_000_000_000_000;

describe("evaluateChaseGuard", () => {
  it("allows when there is no pending anchor (normal same-candle entry)", () => {
    const r = evaluateChaseGuard(null, "LONG", 100, T0, cfg);
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("no-pending");
  });

  it("allows a LONG entry whose price pulled back below the anchor", () => {
    const r = evaluateChaseGuard(
      { side: "LONG", price: 100, time: T0 },
      "LONG",
      99.5, // −0.5% — favorable for a long
      T0 + 5 * 60_000,
      cfg,
    );
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("ok");
  });

  it("blocks a LONG entry whose price ran more than the drift limit above the anchor", () => {
    // WLD case: first signal 0.4688, delayed entry 0.4744 → +1.2% → blocked at 0.5%
    const r = evaluateChaseGuard(
      { side: "LONG", price: 0.4688, time: T0 },
      "LONG",
      0.4744,
      T0 + 20 * 60_000, // 20 min — well inside the 30-min age limit
      cfg,
    );
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("drift");
    expect(r.driftPct).toBeCloseTo(1.1945, 1);
  });

  it("allows a LONG entry still within the drift tolerance", () => {
    const r = evaluateChaseGuard(
      { side: "LONG", price: 0.4688, time: T0 },
      "LONG",
      0.4704, // +0.34% — within 0.5%
      T0 + 15 * 60_000,
      cfg,
    );
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("ok");
  });

  it("blocks a SHORT entry whose price fell more than the limit below the anchor", () => {
    // RENDER case: first short 1.541, delayed entry 1.533 → price fell 0.52% → blocked
    const r = evaluateChaseGuard(
      { side: "SHORT", price: 1.541, time: T0 },
      "SHORT",
      1.533,
      T0 + 30 * 60_000,
      cfg,
    );
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("drift");
    expect(r.driftPct).toBeCloseTo(0.519, 1);
  });

  it("allows a SHORT entry that bounces above the anchor (favorable)", () => {
    const r = evaluateChaseGuard(
      { side: "SHORT", price: 1.541, time: T0 },
      "SHORT",
      1.55, // +0.58% — shorting higher is better
      T0 + 20 * 60_000,
      cfg,
    );
    expect(r.allow).toBe(true);
  });

  it("blocks an anchor older than signalMaxAgeMin regardless of price", () => {
    const r = evaluateChaseGuard(
      { side: "LONG", price: 100, time: T0 },
      "LONG",
      100, // no price movement at all
      T0 + 45 * 60_000, // 45 min > 30 min (cfg30)
      cfg30,
    );
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("stale");
    expect(r.ageMin).toBe(45);
  });

  it("ignores an anchor whose side differs from the current signal (pair flipped — re-anchor)", () => {
    const r = evaluateChaseGuard(
      { side: "LONG", price: 1.547, time: T0 },
      "SHORT",
      1.533,
      T0 + 25 * 60_000,
      cfg,
    );
    expect(r.allow).toBe(true);
    expect(r.reason).toBe("no-pending");
  });

  it("honors custom drift / age settings from the config", () => {
    const tight = resolveConfig({ maxSignalDriftPct: 0.3, signalMaxAgeMin: 10 });
    expect(tight.maxSignalDriftPct).toBe(0.3);
    expect(tight.signalMaxAgeMin).toBe(10);
    const r = evaluateChaseGuard(
      { side: "LONG", price: 100, time: T0 },
      "LONG",
      100.35, // +0.35% — over the 0.3% custom limit
      T0 + 5 * 60_000,
      tight,
    );
    expect(r.allow).toBe(false);
    expect(r.reason).toBe("drift");
  });
});

describe("mergePendingSignal", () => {
  it("keeps the FIRST anchor of the same side even when a newer signal prices in", () => {
    const map = new Map<string, PendingSignal>();
    mergePendingSignal(map, "WLD", { side: "LONG", price: 0.4688, time: T0 }, cfg, T0);
    mergePendingSignal(map, "WLD", { side: "LONG", price: 0.4744, time: T0 + 30 * 60_000 }, cfg, T0 + 30 * 60_000);
    expect(map.get("WLD")).toEqual({ side: "LONG", price: 0.4688, time: T0 });
  });

  it("re-anchors when the side flips", () => {
    const map = new Map<string, PendingSignal>();
    mergePendingSignal(map, "RENDER", { side: "LONG", price: 1.547, time: T0 }, cfg, T0);
    mergePendingSignal(
      map,
      "RENDER",
      { side: "SHORT", price: 1.541, time: T0 + 30 * 60_000 },
      cfg,
      T0 + 30 * 60_000,
    );
    expect(map.get("RENDER")).toEqual({ side: "SHORT", price: 1.541, time: T0 + 30 * 60_000 });
  });

  it("re-anchors when the existing anchor is stale", () => {
    const map = new Map<string, PendingSignal>();
    mergePendingSignal(map, "X", { side: "LONG", price: 100, time: T0 }, cfg30, T0);
    mergePendingSignal(map, "X", { side: "LONG", price: 105, time: T0 + 45 * 60_000 }, cfg30, T0 + 45 * 60_000);
    expect(map.get("X")).toEqual({ side: "LONG", price: 105, time: T0 + 45 * 60_000 });
  });
});

describe("chase guard config defaults", () => {
  it("ships with 0.5% drift and 120 min age (backtested over 227 closed paper trades)", () => {
    expect(DEFAULT_CONFIG.maxSignalDriftPct).toBe(0.5);
    expect(DEFAULT_CONFIG.signalMaxAgeMin).toBe(120);
  });

  it("ships DISABLED (2026-09-20: the guard was making live fills worse)", () => {
    expect(DEFAULT_CONFIG.chaseGuardEnabled).toBe(false);
    // A row that predates the switch, or omits it, keeps it OFF — the numeric
    // knobs alone must never re-arm a parked guard.
    expect(resolveConfig({}).chaseGuardEnabled).toBe(false);
    expect(resolveConfig({ maxSignalDriftPct: 0.2, signalMaxAgeMin: 10 }).chaseGuardEnabled).toBe(
      false,
    );
    // An explicit true (panel switch / stored row) turns it back on.
    expect(resolveConfig({ chaseGuardEnabled: true }).chaseGuardEnabled).toBe(true);
  });
});