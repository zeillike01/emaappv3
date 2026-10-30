import { describe, expect, it } from "vitest";
import {
  EMA200_GATE_DEFAULT,
  ema200GateAllows,
  ema200GateLabel,
  ema200GateReadAt,
  ema200Series,
  type Ema200GateCfg,
} from "../ema200-structure";

/**
 * The 15m EMA200 support/resistance gate decides whether an entry may happen at
 * all, so every branch below is pinned against a hand-computed EMA rather than a
 * snapshot: a snapshot would happily bless a regression that keeps the same
 * numbers on this window and flips on the live tape.
 */

const BAR = 900_000;
/** Reading "at" bar i means bar i has closed (so bar i IS visible). */
const at = (i: number) => (i + 1) * BAR;
const flat = (n: number) => Array.from({ length: n }, () => ({ o: 100, h: 101, l: 99, c: 100 }));

type Row = { o: number; h: number; l: number; c: number };
function mk(rows: Row[]) {
  return rows.map((r, i) => ({
    openTime: i * BAR,
    closeTime: (i + 1) * BAR,
    open: r.o,
    high: r.h,
    low: r.l,
    close: r.c,
  }));
}
/** A bar whose body sits at `c` with an explicit wick. */
const row = (c: number, low: number = c, high: number = c): Row => ({ o: c, h: high, l: low, c });

const POS_CFG: Ema200GateCfg = {
  ...EMA200_GATE_DEFAULT,
  period: 5,
  touchLookbackBars: 0,
  slopeLookbackBars: 0,
  maxExtensionPct: 0,
};
const TOUCH_CFG: Ema200GateCfg = { ...POS_CFG, touchLookbackBars: 20, maxTouchAgeBars: 3 };
const SLOPE_CFG: Ema200GateCfg = { ...POS_CFG, slopeLookbackBars: 3 };
const EXT_CFG: Ema200GateCfg = { ...POS_CFG, maxExtensionPct: 1 };

describe("ema200-structure: warm-up and fail-open", () => {
  it("returns null (no opinion) until `period` bars have closed", () => {
    const four = mk(flat(4));
    expect(ema200GateReadAt(four, at(3), "LONG", POS_CFG)).toBeNull();
    // A null read ALLOWS — fail-open, like one-hour-rejection.
    expect(ema200GateAllows(four, at(3), "LONG", POS_CFG)).toBe(true);

    const five = mk([...flat(4), row(101)]);
    const r = ema200GateReadAt(five, at(4), "LONG", POS_CFG);
    expect(r).not.toBeNull();
    // SMA seed of the engine's own calculateEMA.
    expect(r!.ema).toBeCloseTo((100 * 4 + 101) / 5, 10);
    expect(r!.barIndex).toBe(4);
  });

  it("ignores bars that have not closed yet", () => {
    const bars = mk([...flat(4), row(101), row(103)]);
    const early = ema200GateReadAt(bars, at(4), "LONG", POS_CFG);
    expect(early!.barIndex).toBe(4);
    expect(early!.close).toBe(101);
    // Mid-way through bar 6 (its openTime) the newest CLOSED candle is still 5:
    // the bar in progress is never an input.
    const mid = ema200GateReadAt(bars, 6 * BAR, "LONG", POS_CFG)!;
    expect(mid.barIndex).toBe(5);
    expect(mid.close).toBe(103);
  });

  it("is unchanged by bars appended after the read time (no look-ahead)", () => {
    const base = mk([...flat(4), row(101), row(101)]);
    const before = ema200GateReadAt(base, at(5), "LONG", TOUCH_CFG);
    const extended = mk([...flat(4), row(101), row(101), row(80, 70), row(80, 70)]);
    const after = ema200GateReadAt(extended, at(5), "LONG", TOUCH_CFG);
    expect(after).toEqual(before);
  });

  it("a precomputed series gives the identical read (EMA is causal)", () => {
    const bars = mk([100, 102, 101, 105, 104, 108, 107, 111, 110, 115].map((c) => row(c, c - 1)));
    const series = ema200Series(bars, 5);
    expect(series.length).toBe(bars.length);
    for (let i = 4; i < bars.length; i++) {
      expect(ema200GateReadAt(bars, at(i), "LONG", SLOPE_CFG, series)).toEqual(
        ema200GateReadAt(bars, at(i), "LONG", SLOPE_CFG),
      );
    }
  });
});

describe("ema200-structure: position arm (the core rule)", () => {
  it("blocks a LONG below the EMA and allows one above it", () => {
    const below = mk([...flat(4), row(99)]);
    const rBelow = ema200GateReadAt(below, at(4), "LONG", POS_CFG)!;
    expect(rBelow.allow).toBe(false);
    expect(rBelow.verdict).toBe("wrong-side");
    expect(rBelow.distPct).toBeLessThan(0);

    const above = mk([...flat(4), row(101)]);
    const rAbove = ema200GateReadAt(above, at(4), "LONG", POS_CFG)!;
    expect(rAbove.allow).toBe(true);
    expect(rAbove.verdict).toBe("allowed");
  });

  it("mirrors exactly for a SHORT", () => {
    const above = mk([...flat(4), row(101)]);
    const r = ema200GateReadAt(above, at(4), "SHORT", POS_CFG)!;
    expect(r.allow).toBe(false);
    expect(r.verdict).toBe("wrong-side");
    const below = mk([...flat(4), row(99)]);
    expect(ema200GateReadAt(below, at(4), "SHORT", POS_CFG)!.allow).toBe(true);
  });

  it("treats a close exactly ON the EMA as the wrong side", () => {
    // Flat tape: close == ema == 100. Neither a support nor a resistance entry.
    expect(ema200GateReadAt(mk(flat(5)), at(4), "LONG", POS_CFG)!.verdict).toBe("wrong-side");
    expect(ema200GateReadAt(mk(flat(5)), at(4), "SHORT", POS_CFG)!.verdict).toBe("wrong-side");
  });
});

describe("ema200-structure: role arm (did the EMA act as support/resistance)", () => {
  it("allows when the candle wicks into the EMA and closes back above it", () => {
    // ema[5] = 100 + (100.5−100)/3 = 100.1667; low 100 is inside the 0.35% zone,
    // and the candle closes above → support held.
    const bars = mk([...flat(5), row(100.5, 100)]);
    const r = ema200GateReadAt(bars, at(5), "LONG", TOUCH_CFG)!;
    expect(r.allow).toBe(true);
    expect(r.touchAgoBars).toBe(0);
  });

  it("blocks when price never traded back into the EMA zone", () => {
    // Same shape but the low stays 103 — a gapped-up entry with no EMA touch.
    const bars = mk([...flat(4), row(101), row(103, 103)]);
    const r = ema200GateReadAt(bars, at(5), "LONG", TOUCH_CFG)!;
    expect(r.allow).toBe(false);
    expect(r.verdict).toBe("no-touch");
    expect(r.touchAgoBars).toBeNull();
    // …and the position-only arm would have taken it — that is the whole point.
    expect(ema200GateReadAt(bars, at(5), "LONG", POS_CFG)!.allow).toBe(true);
  });

  it("does not count a candle that closed THROUGH the EMA as a touch-and-hold", () => {
    // bar 4 pierces the EMA (low 99) and closes below it (99.8): a break, not a
    // hold. bar 5 closes back above (ema 100.2) but never returned to the zone.
    const bars = mk([...flat(4), row(99, 99), row(101, 100.8)]);
    const r = ema200GateReadAt(bars, at(5), "LONG", TOUCH_CFG)!;
    expect(r.verdict).toBe("no-touch");
    expect(r.touchAgoBars).toBeNull();
    expect(ema200GateReadAt(bars, at(5), "LONG", POS_CFG)!.allow).toBe(true);
  });

  it("expires a touch older than maxTouchAgeBars", () => {
    // Touch at bar 5 (low 100); bars 6-9 climb away from the EMA.
    const bars = mk([...flat(5), row(100.5, 100), row(103, 103), row(103, 103), row(103, 103), row(103, 103)]);
    const fresh = ema200GateReadAt(bars, at(9), "LONG", { ...TOUCH_CFG, maxTouchAgeBars: 4 })!;
    expect(fresh.allow).toBe(true);
    expect(fresh.touchAgoBars).toBe(4);
    const stale = ema200GateReadAt(bars, at(9), "LONG", { ...TOUCH_CFG, maxTouchAgeBars: 3 })!;
    expect(stale.verdict).toBe("no-touch");
  });

  it("is symmetric: a wick to the EMA from below is resistance for a SHORT", () => {
    // Mirror of the allowed LONG: price breaks down, wicks UP into the EMA and
    // closes back below it → resistance held.
    const bars = mk([...flat(4), row(99), row(99, 99, 99.5)]);
    const r = ema200GateReadAt(bars, at(5), "SHORT", TOUCH_CFG)!;
    expect(r.allow).toBe(true);
    expect(r.touchAgoBars).toBe(0);
  });
});

describe("ema200-structure: slope and extension arms", () => {
  it("blocks a LONG on a falling EMA even though price is above it", () => {
    // 120 → 100 collapse, then a bounce to 110: price is above a FALLING EMA.
    const bars = mk([...flat(5).map(() => row(120)), row(100), row(100), row(100), row(100), row(110)]);
    const r = ema200GateReadAt(bars, at(9), "LONG", SLOPE_CFG)!;
    expect(r.close).toBeGreaterThan(r.ema);
    expect(r.slopePct).toBeLessThan(0);
    expect(r.verdict).toBe("slope-against");
    expect(ema200GateReadAt(bars, at(9), "LONG", POS_CFG)!.allow).toBe(true);
  });

  it("blocks a SHORT on a rising EMA even though price is below it", () => {
    const bars = mk([...flat(5).map(() => row(80)), row(100), row(100), row(100), row(100), row(90)]);
    const r = ema200GateReadAt(bars, at(9), "SHORT", SLOPE_CFG)!;
    expect(r.close).toBeLessThan(r.ema);
    expect(r.slopePct).toBeGreaterThan(0);
    expect(r.verdict).toBe("slope-against");
  });

  it("allows a LONG riding a rising EMA", () => {
    const bars = mk([...flat(5), row(110), row(110), row(110), row(110)]);
    expect(ema200GateReadAt(bars, at(8), "LONG", SLOPE_CFG)!.allow).toBe(true);
  });

  it("refuses an entry stretched too far from the EMA", () => {
    const bars = mk([...flat(4), row(130)]);
    const r = ema200GateReadAt(bars, at(4), "LONG", EXT_CFG)!;
    expect(r.verdict).toBe("extended");
    expect(r.distPct).toBeGreaterThan(1);
    expect(ema200GateReadAt(bars, at(4), "LONG", POS_CFG)!.allow).toBe(true);
  });
});

describe("ema200-structure: long/short mirror is exact", () => {
  // Reflecting prices about M makes EMA(2M−c) == 2M−EMA(c) (the seed is an SMA
  // and the recursion is affine), so the mirrored tape must produce the mirrored
  // verdict for EVERY branch, not just the happy path.
  const M = 100;
  const mirror = (rows: Row[]): Row[] => rows.map((r) => ({ o: 2 * M - r.o, h: 2 * M - r.l, l: 2 * M - r.h, c: 2 * M - r.c }));
  const tapes: Row[][] = [
    [...flat(5), row(100.5, 100)],
    [...flat(4), row(101), row(103, 103)],
    [...flat(4), row(99, 99), row(101, 100.5)],
    [...flat(5).map(() => row(120)), row(100), row(100), row(100), row(100), row(110)],
    [...flat(4), row(130)],
    flat(5),
  ];
  const cfgs: Ema200GateCfg[] = [POS_CFG, TOUCH_CFG, SLOPE_CFG, EXT_CFG, { ...TOUCH_CFG, slopeLookbackBars: 3, maxExtensionPct: 2 }];

  it("produces mirrored verdicts on every tape × cfg pair", () => {
    for (const rows of tapes) {
      for (const cfg of cfgs) {
        const bars = mk(rows);
        const barsMirror = mk(mirror(rows));
        for (let i = 4; i < rows.length; i++) {
          const l = ema200GateReadAt(bars, at(i), "LONG", cfg);
          const s = ema200GateReadAt(barsMirror, at(i), "SHORT", cfg);
          expect(s!.verdict).toBe(l!.verdict);
          expect(s!.allow).toBe(l!.allow);
          expect(s!.ema).toBeCloseTo(2 * M - l!.ema, 8);
        }
      }
    }
  });
});

describe("ema200-structure: cfg labels", () => {
  it("labels the swept arms", () => {
    expect(ema200GateLabel(POS_CFG)).toBe("P");
    expect(ema200GateLabel(TOUCH_CFG)).toBe("P+T");
    expect(ema200GateLabel(SLOPE_CFG)).toBe("P+S");
    expect(ema200GateLabel({ ...TOUCH_CFG, slopeLookbackBars: 20, maxExtensionPct: 3 })).toBe("P+S+T+X");
  });
});
