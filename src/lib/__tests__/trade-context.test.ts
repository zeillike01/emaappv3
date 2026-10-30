import { describe, expect, it } from "vitest";

import {
  atrPctOf,
  compactContextPatch,
  regimeFrom4hBars,
  sessionOf,
} from "../trade-context";

const UTC = (h: number, m = 0) => Date.UTC(2026, 0, 15, h, m);

describe("sessionOf — UTC-hour buckets (engine parity)", () => {
  it("buckets every boundary exactly like the engine sessionOf", () => {
    expect(sessionOf(UTC(0))).toBe("asia");
    expect(sessionOf(UTC(6, 59))).toBe("asia");
    expect(sessionOf(UTC(7))).toBe("london");
    expect(sessionOf(UTC(12, 59))).toBe("london");
    expect(sessionOf(UTC(13))).toBe("ldn-ny");
    expect(sessionOf(UTC(16, 59))).toBe("ldn-ny");
    expect(sessionOf(UTC(17))).toBe("ny");
    expect(sessionOf(UTC(21, 59))).toBe("ny");
    expect(sessionOf(UTC(22))).toBe("late");
    expect(sessionOf(UTC(23, 59))).toBe("late");
  });
});

describe("atrPctOf — 15m ATR(14) as % of close (engine parity)", () => {
  const flatBar = (close: number) => ({
    high: close + 0.5,
    low: close - 0.5,
    close,
  });

  it("returns undefined with fewer than 15 bars", () => {
    expect(atrPctOf([flatBar(100), flatBar(101)])).toBeUndefined();
    expect(atrPctOf(Array.from({ length: 14 }, (_, i) => flatBar(100 + i)))).toBeUndefined();
  });

  it("computes ATR(14) over the LAST 14 bars, normalized by final close", () => {
    // 15 bars each with range exactly 1.0 and no gap vs previous close
    // (prev close == 100 always), so every TR = 1 → ATR = 1, close = 100.
    const bars = Array.from({ length: 15 }, () => flatBar(100));
    expect(atrPctOf(bars)).toBeCloseTo((1 / 100) * 100, 10); // 1%
  });

  it("uses bars[i-1].close for TR gaps (gap-up makes TR larger)", () => {
    const bars = Array.from({ length: 15 }, (_, i) => {
      const close = 100 + i * 2; // rising series; |high - prevClose| dominates
      return { high: close, low: close - 1, close };
    });
    // TR for each bar = |high_i - close_{i-1}| = (close_i) - (close_{i-1}) = 2
    const pct = atrPctOf(bars);
    expect(pct).not.toBeUndefined();
    expect(pct!).toBeCloseTo((2 / (100 + 28)) * 100, 6); // ATR=2, last close=128
  });
});

describe("regimeFrom4hBars — EMA50 slope (engine classifyRegime4h parity)", () => {
  const series = (start: number, stepPct: number, n = 80) =>
    Array.from({ length: n }, (_, i) => ({
      high: 0,
      low: 0,
      close: start * Math.pow(1 + stepPct, i),
    }));

  it("returns null with fewer than 60 bars (backfill leaves field missing)", () => {
    expect(regimeFrom4hBars(series(100, 0.001, 59))).toBeNull();
  });

  it("classifies a strong uptrend as trend-up", () => {
    expect(regimeFrom4hBars(series(100, 0.01))).toBe("trend-up");
  });

  it("classifies a strong downtrend as trend-down", () => {
    expect(regimeFrom4hBars(series(100, -0.01))).toBe("trend-down");
  });

  it("classifies a flat series as chop", () => {
    expect(regimeFrom4hBars(series(100, 0))).toBe("chop");
  });
});

describe("compactContextPatch — undefined must never reach ctx.db.patch", () => {
  it("strips undefined keys but preserves present ones", () => {
    expect(compactContextPatch({ session: "london" })).toEqual({ session: "london" });
    expect(compactContextPatch({ regime: "trend-up", volPct: undefined })).toEqual({
      regime: "trend-up",
    });
    expect(compactContextPatch({})).toEqual({});
    expect(compactContextPatch({ volPct: 0.447 })).toEqual({ volPct: 0.447 });
  });

  it("keeps 0 as a real value (volPct is never falsy-stripped)", () => {
    expect(compactContextPatch({ volPct: 0 })).toEqual({ volPct: 0 });
  });
});
