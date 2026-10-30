import { describe, expect, it } from "vitest";
import {
  EMPTY_SHADOW_LIVE_STATE,
  LIVE_BRACKET_POLICY,
  SCALE_OUT_POLICY,
  advanceShadowLive,
  simulateShadowTrade,
  summarizeShadow,
  type ShadowBar,
  type ShadowPolicy,
  type ShadowTradeInput,
} from "../shadow-book";

const bar = (high: number, low: number, close: number, open = close): ShadowBar => ({
  openTime: 0,
  open,
  high,
  low,
  close,
});

const trade = (over: Partial<ShadowTradeInput> = {}): ShadowTradeInput => ({
  id: "t1",
  coin: "ADA",
  side: "LONG",
  entryTime: 0,
  entryPrice: 100,
  slPrice: 98, // risk unit = 2
  realizedR: -1,
  status: "closed",
  ...over,
});

const policy = (over: Partial<ShadowPolicy> = {}): ShadowPolicy => ({ ...SCALE_OUT_POLICY, ...over });

describe("simulateShadowTrade — scale-out arithmetic", () => {
  it("long: half at 1:2.5 (105) + half at 1:5 (110) = 1.25 + 2.5 = 3.75R", () => {
    const r = simulateShadowTrade(
      trade(),
      [bar(106, 100.5, 105), bar(111, 104, 110)],
      policy(),
    );
    expect(r.reason).toBe("tp1+tp2");
    expect(r.tp1Filled).toBe(true);
    expect(r.tp2Filled).toBe(true);
    expect(r.shadowR).toBeCloseTo(3.75, 6);
  });

  it("long: first target then a return to breakeven = 1.25R (not a loss, not the full win)", () => {
    const r = simulateShadowTrade(trade(), [bar(106, 100.5, 105), bar(106, 99, 100)], policy());
    expect(r.reason).toBe("tp1+breakeven");
    expect(r.shadowR).toBeCloseTo(1.25, 6);
  });

  it("long: stopped before the first target loses the FULL 1R regardless of the scale-out split", () => {
    const r = simulateShadowTrade(trade(), [bar(100.5, 97, 98)], policy());
    expect(r.reason).toBe("stop");
    expect(r.tp1Filled).toBe(false);
    expect(r.shadowR).toBeCloseTo(-1, 6);
  });

  it("short: symmetric — half at 95 then half at 90 = 3.75R", () => {
    const r = simulateShadowTrade(
      trade({ side: "SHORT", slPrice: 102, realizedR: 1 }),
      [bar(99.5, 94, 95), bar(96, 89, 90)],
      policy(),
    );
    expect(r.reason).toBe("tp1+tp2");
    expect(r.shadowR).toBeCloseTo(3.75, 6);
  });

  it("same bar spans the stop and the first target → conservative stop, -1R", () => {
    const r = simulateShadowTrade(trade(), [bar(106, 97, 98)], policy());
    expect(r.reason).toBe("stop");
    expect(r.shadowR).toBeCloseTo(-1, 6);
  });

  it("with breakeven disabled the runner keeps the original stop: 1.25 - 0.5 = 0.75R", () => {
    const r = simulateShadowTrade(
      trade(),
      [bar(106, 100.5, 105), bar(105.5, 97, 98)],
      policy({ breakEvenAfterFirst: false }),
    );
    expect(r.reason).toBe("tp1+stop");
    expect(r.shadowR).toBeCloseTo(0.75, 6);
  });

  it("never reaching the first target marks to market at the horizon", () => {
    const r = simulateShadowTrade(trade(), [bar(101, 99, 100), bar(101.5, 99, 101)], policy({ horizonBars: 2 }));
    expect(r.reason).toBe("timeout");
    expect(r.tp1Filled).toBe(false);
    expect(r.shadowR).toBeCloseTo(0.5, 6);
    expect(r.barsHeld).toBe(2);
  });

  it("first target filled but runner unresolved marks the runner to market", () => {
    const r = simulateShadowTrade(trade(), [bar(106, 100.5, 105), bar(107, 104, 106)], policy({ horizonBars: 2 }));
    expect(r.reason).toBe("tp1+timeout");
    expect(r.shadowR).toBeCloseTo(1.25 + 0.5 * 3, 6); // runner marked at 106 → +3R
  });
});

describe("simulateShadowTrade — guards", () => {
  it("zero risk cannot produce infinite R", () => {
    const r = simulateShadowTrade(trade({ slPrice: 100 }), [bar(110, 90, 100)], policy());
    expect(r.shadowR).toBe(0);
    expect(r.covered).toBe(false);
  });

  it("covered is false when the cache cannot supply the full horizon", () => {
    const short = simulateShadowTrade(trade(), [bar(101, 99, 100)], policy());
    expect(short.covered).toBe(false);
    expect(short.barsAvailable).toBe(1);

    const long = Array.from({ length: 120 }, () => bar(101, 99, 100));
    expect(simulateShadowTrade(trade(), long, policy()).covered).toBe(true);
  });

  it("an empty bar window is reported uncovered rather than as a stop", () => {
    const r = simulateShadowTrade(trade(), [], policy());
    expect(r.covered).toBe(false);
    expect(r.reason).toBe("timeout");
  });
});

describe("LIVE_BRACKET_POLICY reproduces the live bracket", () => {
  it("take-profit exits at 1.667R", () => {
    const r = simulateShadowTrade(trade(), [bar(104, 99, 103)], LIVE_BRACKET_POLICY);
    expect(r.shadowR).toBeCloseTo(1.667, 3);
  });

  it("stop exits at -1R", () => {
    const r = simulateShadowTrade(trade(), [bar(100.5, 97, 98)], LIVE_BRACKET_POLICY);
    expect(r.shadowR).toBeCloseTo(-1, 6);
  });
});

describe("advanceShadowLive — the tick-driven shadow", () => {
  // entry 100, stop 98 → risk 2. First target 2.5R = 105, runner 5R = 110.
  const leg = { side: "LONG" as const, entryPrice: 100, slPrice: 98, entryTime: 0 };
  const at = (price: number, now = 0) => advanceShadowLive(leg, EMPTY_SHADOW_LIVE_STATE, price, now, policy());

  it("does nothing while price sits between the stop and the first target", () => {
    const r = at(102);
    expect(r.resolved).toBeNull();
    expect(r.changed).toBe(false);
    expect(r.state.tp1Filled).toBe(false);
  });

  it("stops out for a full -1R before the first target", () => {
    const r = at(98);
    expect(r.resolved).toEqual({ reason: "stop", totalR: -1 });
  });

  it("banks the first target and asks to be persisted, without resolving", () => {
    const r = at(105);
    expect(r.changed).toBe(true);
    expect(r.state).toEqual({ tp1Filled: true, bankedR: 1.25 });
    expect(r.resolved).toBeNull();
  });

  it("resolves the runner at the second target for 3.75R total", () => {
    const first = at(105);
    const r = advanceShadowLive(leg, first.state, 110, 0, policy());
    expect(r.resolved).toEqual({ reason: "tp1+tp2", totalR: 3.75 });
  });

  it("scratches the runner at breakeven for 1.25R", () => {
    const first = at(105);
    const r = advanceShadowLive(leg, first.state, 100, 0, policy());
    expect(r.resolved).toEqual({ reason: "tp1+breakeven", totalR: 1.25 });
  });

  it("a single observation far enough fills both targets", () => {
    const r = at(112);
    expect(r.resolved).toEqual({ reason: "tp1+tp2", totalR: 3.75 });
    expect(r.state.tp1Filled).toBe(true);
  });

  it("without breakeven the runner keeps the original stop: 1.25 - 0.5 = 0.75R", () => {
    const p = policy({ breakEvenAfterFirst: false });
    const first = advanceShadowLive(leg, EMPTY_SHADOW_LIVE_STATE, 105, 0, p);
    const r = advanceShadowLive(leg, first.state, 98, 0, p);
    expect(r.resolved).toEqual({ reason: "tp1+stop", totalR: 0.75 });
  });

  it("the horizon closes a leg that never reached the first target", () => {
    const r = at(102, SCALE_OUT_POLICY.horizonBars * 15 * 60 * 1000);
    expect(r.resolved).toEqual({ reason: "timeout", totalR: 1 }); // full weight at +1R
  });

  it("the horizon closes a post-first-target leg at reduced weight", () => {
    const first = at(105);
    const r = advanceShadowLive(leg, first.state, 104, SCALE_OUT_POLICY.horizonBars * 15 * 60 * 1000, policy());
    expect(r.resolved).toEqual({ reason: "tp1+timeout", totalR: 1.25 + 0.5 * 2 });
  });

  it("is symmetric for a short", () => {
    const shortLeg = { side: "SHORT" as const, entryPrice: 100, slPrice: 102, entryTime: 0 };
    const first = advanceShadowLive(shortLeg, EMPTY_SHADOW_LIVE_STATE, 95, 0, policy());
    expect(first.state).toEqual({ tp1Filled: true, bankedR: 1.25 });
    const r = advanceShadowLive(shortLeg, first.state, 90, 0, policy());
    expect(r.resolved).toEqual({ reason: "tp1+tp2", totalR: 3.75 });
  });

  it("ignores a zero price rather than resolving on it", () => {
    const r = at(0);
    expect(r.resolved).toBeNull();
    expect(r.changed).toBe(false);
  });
});

describe("summarizeShadow", () => {
  it("aggregates totals, expectancy and the exit histogram", () => {
    const a = simulateShadowTrade(trade({ id: "a" }), [bar(106, 100.5, 105), bar(111, 104, 110)], policy());
    const b = simulateShadowTrade(trade({ id: "b" }), [bar(100.5, 97, 98)], policy());
    const s = summarizeShadow([a, b], policy());
    expect(s.trades).toBe(2);
    expect(s.totalR).toBeCloseTo(3.75 - 1, 6);
    expect(s.totalRealR).toBeCloseTo(-2, 6);
    expect(s.deltaR).toBeCloseTo(2.75 - -2, 6);
    expect(s.winRate).toBeCloseTo(0.5, 6);
    expect(s.expectancyR).toBeCloseTo(1.375, 6);
    expect(s.exits).toEqual({ "tp1+tp2": 1, stop: 1 });
  });

  it("is safe on an empty set", () => {
    const s = summarizeShadow([], policy());
    expect(s.trades).toBe(0);
    expect(s.expectancyR).toBe(0);
    expect(s.winRate).toBe(0);
  });
});
