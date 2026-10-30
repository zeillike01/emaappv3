import { describe, expect, test } from "vitest";
import {
  D1_DEAD_ZONE_HI_PCT,
  D1_DEAD_ZONE_LO_PCT,
  D1_MIN_BARS,
  D1_REJECTION_WICK_PCT,
  D1_STOCH_EXHAUST_K,
  SHADOW_TAG_D1_STOCH_EXHAUST,
  d1ReadingFromKlines,
  d1ShadowTags,
  type D1Bar,
} from "./d1-shadow";

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_700_000_000_000;

function bars(
  n: number,
  shape: (i: number, prevClose: number) => { close: number; high: number; low: number; volume: number },
): D1Bar[] {
  const out: D1Bar[] = [];
  let prevClose = 100;
  for (let i = 0; i < n; i++) {
    const s = shape(i, prevClose);
    out.push({
      openTime: T0 + i * DAY,
      closeTime: T0 + (i + 1) * DAY,
      high: s.high,
      low: s.low,
      close: s.close,
      volume: s.volume,
    });
    prevClose = s.close;
  }
  return out;
}

const flat = (n: number) =>
  bars(n, () => ({ close: 100, high: 100.5, low: 99.5, volume: 1000 }));

describe("d1ReadingFromKlines", () => {
  test("returns null below D1_MIN_BARS (fail-open)", () => {
    expect(d1ReadingFromKlines(flat(D1_MIN_BARS - 1), Date.now())).toBeNull();
  });

  test("ignores a forming bar (closeTime > now)", () => {
    const b = flat(D1_MIN_BARS + 2);
    const now = b[b.length - 1]!.closeTime - 1000;
    const r = d1ReadingFromKlines(b, now)!;
    expect(r.barOpenTime).toBe(b[b.length - 2]!.openTime);
  });

  test("rejection candle: upper wick dominates the range", () => {
    const b = flat(D1_MIN_BARS);
    b[b.length - 1] = { ...b[b.length - 1]!, high: 104, low: 99, close: 100.5 };
    const r = d1ReadingFromKlines(b, Date.now())!;
    expect(r.upWickPct).toBeGreaterThan(60);
    expect(r.r5Pct).toBeCloseTo(0.5, 5); // close 100.5 vs prior 100
  });

  test("dead-zone drift: five quiet lower closes of ~1% → r5 ≈ −5%", () => {
    const b = bars(D1_MIN_BARS + 5, (i, prev) => {
      const drift = i >= D1_MIN_BARS ? 0.99 : 1.0;
      const close = prev * drift;
      return { close, high: close * 1.005, low: close * 0.995, volume: 1000 };
    });
    const r = d1ReadingFromKlines(b, Date.now())!;
    expect(r.r5Pct).toBeLessThan(D1_DEAD_ZONE_HI_PCT);
    expect(r.r5Pct).toBeGreaterThan(D1_DEAD_ZONE_LO_PCT);
    expect(r.upWickPct).toBeLessThan(20);
  });

  test("highSweep: day pokes the prior 20d high and closes back below", () => {
    const b = flat(D1_MIN_BARS + 1);
    b[b.length - 1] = { ...b[b.length - 1]!, high: 101.2, low: 99.5, close: 100.4 };
    const r = d1ReadingFromKlines(b, Date.now())!;
    expect(r.highSweep).toBe(true);
    expect(r.lowReclaim).toBe(false);
  });

  test("lowReclaim (spring): day pierces the prior 20d low and closes back above", () => {
    const b = flat(D1_MIN_BARS + 1);
    b[b.length - 1] = { ...b[b.length - 1]!, high: 100.2, low: 98.8, close: 100.1 };
    const r = d1ReadingFromKlines(b, Date.now())!;
    expect(r.lowReclaim).toBe(true);
    expect(r.highSweep).toBe(false);
  });

  test("inside-range day: neither sweep fires", () => {
    const r = d1ReadingFromKlines(flat(D1_MIN_BARS + 1), Date.now())!;
    expect(r.highSweep).toBe(false);
    expect(r.lowReclaim).toBe(false);
  });
});

describe("d1ShadowTags", () => {
  const base = { barOpenTime: T0, upWickPct: 0, r5Pct: 0, highSweep: false, lowReclaim: false, dStochK: null as number | null };

  test("null reading: no tags, null numbers (fail-open)", () => {
    const t = d1ShadowTags(null, "LONG");
    expect(t.tags).toEqual([]);
    expect(t.d1UpWickPct).toBeNull();
    expect(t.d1R5Pct).toBeNull();
    expect(t.d1StochK).toBeNull();
  });

  test("d1-stoch-exhaust fires at/above %K 75 on LONG only, null never fires", () => {
    const at = d1ShadowTags({ ...base, dStochK: D1_STOCH_EXHAUST_K }, "LONG");
    expect(at.tags).toContain(SHADOW_TAG_D1_STOCH_EXHAUST);
    const below = d1ShadowTags({ ...base, dStochK: 74.9 }, "LONG");
    expect(below.tags).not.toContain(SHADOW_TAG_D1_STOCH_EXHAUST);
    const noReading = d1ShadowTags({ ...base, dStochK: null }, "LONG");
    expect(noReading.tags).not.toContain(SHADOW_TAG_D1_STOCH_EXHAUST);
    const short = d1ShadowTags({ ...base, dStochK: 95 }, "SHORT");
    expect(short.tags).toEqual([]);
  });

  test("rejection-wick fires at/above 45% on LONG only", () => {
    const at = d1ShadowTags({ ...base, upWickPct: D1_REJECTION_WICK_PCT }, "LONG");
    expect(at.tags).toContain("d1-rejection-wick");
    const below = d1ShadowTags({ ...base, upWickPct: 44.9 }, "LONG");
    expect(below.tags).not.toContain("d1-rejection-wick");
    const short = d1ShadowTags({ ...base, upWickPct: 80, r5Pct: -5 }, "SHORT");
    expect(short.tags).toEqual([]);
  });

  test("dead-zone fires inside [-8, -3] on LONG only", () => {
    const in1 = d1ShadowTags({ ...base, r5Pct: -3 }, "LONG");
    const in2 = d1ShadowTags({ ...base, r5Pct: D1_DEAD_ZONE_LO_PCT }, "LONG");
    expect(in1.tags).toContain("d1-dead-zone");
    expect(in2.tags).toContain("d1-dead-zone");
    const crash = d1ShadowTags({ ...base, r5Pct: -12 }, "LONG");
    const flatCase = d1ShadowTags({ ...base, r5Pct: -1 }, "LONG");
    expect(crash.tags).not.toContain("d1-dead-zone");
    expect(flatCase.tags).not.toContain("d1-dead-zone");
  });

  test("sweep-context tags fire LONG-only and alongside the wick tag", () => {
    const sweep = d1ShadowTags({ ...base, upWickPct: 50, highSweep: true }, "LONG");
    expect(sweep.tags).toContain("d1-sweep-high");
    expect(sweep.tags).toContain("d1-rejection-wick");
    const spring = d1ShadowTags({ ...base, lowReclaim: true }, "LONG");
    expect(spring.tags).toEqual(["d1-spring-low"]);
    const shortSweep = d1ShadowTags({ ...base, upWickPct: 50, highSweep: true, lowReclaim: true }, "SHORT");
    expect(shortSweep.tags).toEqual([]);
  });

  test("all tags together; numbers always returned", () => {
    const t = d1ShadowTags({ ...base, upWickPct: 60, r5Pct: -5, highSweep: true, dStochK: 80 }, "LONG");
    expect(t.tags).toContain("d1-rejection-wick");
    expect(t.tags).toContain("d1-dead-zone");
    expect(t.tags).toContain("d1-sweep-high");
    expect(t.tags).toContain(SHADOW_TAG_D1_STOCH_EXHAUST);
    expect(t.d1UpWickPct).toBe(60);
    expect(t.d1R5Pct).toBe(-5);
    expect(t.d1StochK).toBe(80);
  });
});
