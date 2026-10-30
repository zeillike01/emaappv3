import { describe, expect, it } from "vitest";
import {
  STRUCT_LOOKBACK,
  atLevel,
  atrAt,
  clusterLevels,
  eventsAt,
  findSwings,
  rToNextOpposingLevel,
  structureAt,
  structAgrees,
  structTags,
  trendFrom,
  type StructBar,
  type Swing,
} from "../structure";

/** Deterministic pseudo-random OHLC series (seeded LCG — no Math.random). */
function makeBars(n: number, seed = 1): StructBar[] {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const bars: StructBar[] = [];
  let price = 100;
  let t = Date.parse("2026-01-01T00:00:00Z");
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = Math.max(1, open + (rnd() - 0.5) * 2);
    const high = Math.max(open, close) + rnd();
    const low = Math.min(open, close) - rnd();
    bars.push({ openTime: t, closeTime: t + 900_000, open, high, low, close });
    price = close;
    t += 900_000;
  }
  return bars;
}

const swing = (index: number, price: number, kind: "high" | "low"): Swing => ({
  index,
  price,
  time: index * 900_000,
  kind,
});

describe("structure — CAUSALITY (the contract that makes this repaint-proof)", () => {
  it("truncated series gives an identical read at t as the full series", () => {
    const bars = makeBars(400, 7);
    for (let i = 60; i < bars.length; i++) {
      expect(structureAt(bars.slice(0, i + 1), i)).toEqual(structureAt(bars, i));
    }
  });

  it("ignores bars after the decision index entirely", () => {
    const bars = makeBars(220, 3);
    // Violently perturb only the FUTURE bars — the read at 100 must not move.
    const perturbed = bars.map((b, i) =>
      i > 100 ? { ...b, high: b.high + 50, low: b.low - 50, close: b.close + 50 } : b,
    );
    expect(structureAt(perturbed, 100)).toEqual(structureAt(bars, 100));
  });

  it("never confirms a pivot within `lookback` bars of the read index", () => {
    const bars = makeBars(120, 5);
    for (const s of findSwings(bars, 80, STRUCT_LOOKBACK)) {
      expect(s.index).toBeLessThanOrEqual(80 - STRUCT_LOOKBACK);
    }
  });
});

describe("structure — primitives", () => {
  it("findSwings emits a strict fractal high and low", () => {
    const bars: StructBar[] = [10, 11, 12, 15, 12, 11, 10, 9, 8, 5, 8, 9, 10, 11, 12].map(
      (p, i) => ({
        openTime: i * 900_000,
        closeTime: (i + 1) * 900_000,
        open: p,
        high: p,
        low: p,
        close: p,
      }),
    );
    const s = findSwings(bars, bars.length - 1, 3);
    expect(s.some((x) => x.kind === "high" && x.index === 3 && x.price === 15)).toBe(true);
    expect(s.some((x) => x.kind === "low" && x.index === 9 && x.price === 5)).toBe(true);
  });

  it("trendFrom: HH+HL up, LH+LL down, mixed range", () => {
    expect(
      trendFrom([
        swing(5, 100, "low"),
        swing(10, 110, "high"),
        swing(15, 105, "low"),
        swing(20, 120, "high"),
      ]),
    ).toBe("up");
    expect(
      trendFrom([
        swing(5, 100, "low"),
        swing(10, 120, "high"),
        swing(15, 95, "low"),
        swing(20, 110, "high"),
      ]),
    ).toBe("down");
    expect(
      trendFrom([
        swing(5, 100, "low"),
        swing(10, 110, "high"),
        swing(15, 105, "low"),
        swing(20, 108, "high"),
      ]),
    ).toBe("range");
    expect(trendFrom([swing(5, 100, "low")])).toBe("range");
  });

  it("clusterLevels merges nearby swings into ONE level with a touch count", () => {
    const swings = [
      swing(5, 100.0, "high"),
      swing(20, 100.4, "high"), // same zone (tol 0.5 × ATR 2 = 1.0)
      swing(30, 120.0, "high"), // different zone
    ];
    const lv = clusterLevels(swings, 2, 105);
    expect(lv.length).toBe(2);
    const merged = lv.find((l) => Math.abs(l.price - 100.4) < 0.01)!;
    expect(merged.touches).toBe(2);
    expect(merged.lastTouchIndex).toBe(20);
  });

  it("BOS vs CHoCH are the same event labelled by the prevailing trend", () => {
    const bars: StructBar[] = [
      { openTime: 0, closeTime: 1, open: 100, high: 100, low: 100, close: 100 },
      { openTime: 1, closeTime: 2, open: 100, high: 113, low: 100, close: 113 }, // closes above 112
    ];
    const highs = [swing(5, 110, "high"), swing(7, 112, "high")];
    expect(eventsAt(bars, 1, highs, "up").bos).toBe("up");
    expect(eventsAt(bars, 1, highs, "range").choch).toBe("up");
    expect(eventsAt(bars, 1, highs, "range").bos).toBeNull();
  });

  it("detects a sweep: wick through the swing high, close back inside", () => {
    const bars: StructBar[] = [
      { openTime: 0, closeTime: 1, open: 100, high: 100, low: 100, close: 100 },
      { openTime: 1, closeTime: 2, open: 108, high: 115, low: 107, close: 108 }, // wick 115 > 112, close 108 < 112
    ];
    const highs = [swing(5, 112, "high")];
    const ev = eventsAt(bars, 1, highs, "up");
    expect(ev.sweep).toBe("high");
    expect(ev.bos).toBeNull(); // a sweep closes back INSIDE — not a break
  });

  it("atrAt reads only the trailing window", () => {
    const flat: StructBar[] = Array.from({ length: 40 }, (_, i) => ({
      openTime: i,
      closeTime: i + 1,
      open: 10,
      high: 11,
      low: 9,
      close: 10,
    }));
    expect(atrAt(flat, 39, 14)).toBeCloseTo(2, 6);
  });
});

describe("structure — the one term with a natural unit", () => {
  const base = structureAt(makeBars(120, 11), 119);

  it("LONG: R to the nearest level ABOVE entry, divided by risk", () => {
    const s = { ...base, atr: 1, levels: [{ price: 120, touches: 2, lastTouchIndex: 1, side: "resistance" as const }] };
    // entry 100, stop 90 → risk 10; nearest level above at 120 → 20 / 10 = 2R
    expect(rToNextOpposingLevel(s, "LONG", 100, 90)).toBeCloseTo(2, 6);
  });

  it("LONG: null when nothing is in the way (clear runway)", () => {
    const s = { ...base, atr: 1, levels: [{ price: 80, touches: 1, lastTouchIndex: 1, side: "support" as const }] };
    expect(rToNextOpposingLevel(s, "LONG", 100, 90)).toBeNull();
  });

  it("SHORT mirrors: nearest level BELOW entry", () => {
    const s = { ...base, atr: 1, levels: [{ price: 90, touches: 1, lastTouchIndex: 1, side: "support" as const }] };
    // entry 120, stop 130 → risk 10; level below at 90 → 30 / 10 = 3R
    expect(rToNextOpposingLevel(s, "SHORT", 120, 130)).toBeCloseTo(3, 6);
  });

  it("returns null on a degenerate stop (risk <= 0)", () => {
    expect(rToNextOpposingLevel(base, "LONG", 100, 100)).toBeNull();
  });
});

describe("structure — tags and agreement", () => {
  it("emits one tag per structural fact", () => {
    const s = structureAt(makeBars(200, 13), 199);
    const tags = structTags(s, "LONG");
    expect(tags[0]).toMatch(/^struct-(up|down|range)$/);
    for (const t of tags) expect(t).toMatch(/^struct-/);
  });

  it("agreement is directional", () => {
    const s = { ...structureAt(makeBars(120, 2), 119), trend: "up" as const };
    expect(structAgrees(s, "LONG")).toBe(true);
    expect(structAgrees(s, "SHORT")).toBe(false);
    expect(structAgrees({ ...s, trend: "range" as const }, "LONG")).toBe(false);
  });

  it("atLevel finds a level only inside the tolerance band", () => {
    const s = { ...structureAt(makeBars(120, 4), 119), atr: 10, levels: [{ price: 100, touches: 3, lastTouchIndex: 1, side: "resistance" as const }] };
    expect(atLevel(s, 104, 0.5)).not.toBeNull(); // 4 <= 5
    expect(atLevel(s, 110, 0.5)).toBeNull(); // 10 > 5
  });
});
