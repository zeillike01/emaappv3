import { describe, expect, it } from "vitest";

import {
  atrSeries,
  buildZones,
  classifyLocation,
  detectFvgs,
  detectSwings,
  htfBias4h,
  rsiContribution,
  rsiDivergence,
  scoreLatestCandle,
  sma,
  SR_PARAMS,
  SR_WEIGHTS,
  wilderRsiSeries,
  type Zone,
} from "./sr-imbalance";
import type { Kline } from "./types";
import { wilderRsi } from "./wilder-rsi";

/**
 * PHASE 1 OF THE SPEC'S ROLLOUT: pure functions, hand-built candles.
 *
 * Every fixture here is arithmetic, not history. `pathBars` builds a price path
 * whose every step is ≤ 0.5 with high/low a fixed 0.5 either side of the path
 * price, which makes true range exactly 1 on every bar — so ATR(14) is exactly
 * 1 and every zone edge below is 0.25 either side of a swing the test chose.
 * No cached klines, and no threshold fitted to anything.
 *
 * NOTE the offset that the first draft of this file got wrong: a swing's PRICE
 * is the bar's high or low, not its close. On these fixtures a swing at path
 * price p is a zone centred on p ± 0.5.
 */

function bar(open: number, high: number, low: number, close: number, volume = 100): Kline {
  return { openTime: 0, open, high, low, close, volume, closeTime: 0, quoteVolume: 0, trades: 0, isClosed: true };
}

/** Bars from a price path: high = p+0.5, low = p-0.5, open = close = p. ATR = 1. */
function pathBars(prices: readonly number[]): Kline[] {
  return prices.map((p) => bar(p, p + 0.5, p - 0.5, p));
}

/** Red 15m bars marching down by `step`, then whatever the caller appends. */
function declineBars(count: number, from: number, step: number): Kline[] {
  return Array.from({ length: count }, (_, i) => {
    const c = from - step * i;
    return bar(c + 0.02, c + 0.04, c - 0.02, c);
  });
}

// ── 4H: double bottom at 100.0 / 100.2 (bars 5 and 15) whose bands overlap into
// one [99.25, 99.95] — two touches, strength 3 — then a rally closing at 102.0,
// clear of the 101.5 swing high. Bias up.
const H4_MERGE = [
  101, 100.8, 100.6, 100.4, 100.2, 100, 100.2, 100.4, 100.6, 100.8, 101, 100.8, 100.6, 100.5, 100.3, 100.2, 100.4, 100.6,
  100.8, 101, 101.2, 101.4, 101.6, 101.8, 102,
];

// ── 4H: down to 100.5 (bar 8), rally to 102.0 (bar 14), a LOWER swing low at
// 101.5 (bar 17), then a drift back to 100.1. Bias DOWN while price sits in the
// OLD low's band [99.75, 100.25] — the setup the counter-trend cap exists for.
const H4_DOWN = [
  101.5, 101.3, 101.1, 100.9, 100.7, 100.6, 100.55, 100.52, 100.5, 100.7, 100.9, 101.1, 101.3, 101.5, 102, 101.9, 101.7,
  101.5, 101.7, 101.6, 101.55, 101.2, 100.8, 100.4, 100.1,
];

// ── 1H: V at 100.2 (bar 4) whose low is 99.7, then a rise. One band: [99.45, 99.95].
const H1_V = [
  100.9, 100.6, 100.4, 100.3, 100.2, 100.4, 100.6, 100.8, 101, 101.2, 101.4, 101.6, 101.8, 102, 102.2, 102.4, 102.6, 102.8,
  103, 103.2,
];

function zone(tf: "4H" | "1H", low: number, high: number, touchCount = 1, strength = 1): Zone {
  return { tf, low, high, touchCount, strength, lastTouchIndex: 0 };
}

describe("SR_PARAMS", () => {
  it("ships the spec's starting parameters — a fitted value here is a regression", () => {
    expect(SR_PARAMS.swingLookback4H).toBe(3);
    expect(SR_PARAMS.swingLookback1H).toBe(2);
    expect(SR_PARAMS.zoneWidthATRMult).toBe(0.5);
    expect(SR_PARAMS.zoneMergeATRMult).toBe(0.25);
    expect(SR_PARAMS.fvgStrengthMin).toBe(0.5);
    expect(SR_PARAMS.rsiPeriod).toBe(14);
    expect(SR_PARAMS.volumeHigh).toBe(1.5);
    expect(SR_PARAMS.volumeLow).toBe(0.8);
    expect(SR_PARAMS.fireThresholdAplus).toBe(75);
    expect(SR_PARAMS.fireThresholdB).toBe(60);
    expect(SR_PARAMS.counterTrendCap).toBe(50);
  });
});

describe("SR_WEIGHTS (the 2026-09-26 rebalance)", () => {
  it("pins the table — the model's shape must not drift without the lab noticing", () => {
    expect(SR_WEIGHTS).toEqual({
      base: 25,
      location: { dualTf: 35, atZoneSingleTf: 21, nearZone: 14, fvgStrong: 28, fvgWeak: 11 },
      zoneStrength: { ge4: 15, eq3: 8 },
      htf: { withTrend: 10, neutral: 0, counterTrend: -10 },
      rsi: { best: 10, good: 5, mild: 0, extended: -5, exhausted: -10, divergenceBonus: 5 },
      volume: { high: 10, low: -10 },
      candle: { with: 5, against: -10 },
    });
  });

  it("makes location + zone strength a bigger block than both momentum factors together", () => {
    const locationBlock = SR_WEIGHTS.location.dualTf + SR_WEIGHTS.zoneStrength.ge4;
    const htfSwing = SR_WEIGHTS.htf.withTrend - SR_WEIGHTS.htf.counterTrend;
    const rsiSwing = SR_WEIGHTS.rsi.best - SR_WEIGHTS.rsi.exhausted;
    expect(locationBlock).toBe(50);
    expect(htfSwing + rsiSwing).toBe(40);
    expect(locationBlock).toBeGreaterThan(htfSwing + rsiSwing);
  });
});

describe("wilderRsiSeries", () => {
  it("returns no reading before the seed bar", () => {
    const series = wilderRsiSeries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 14);
    expect(series.every((v) => v === null)).toBe(true);
  });

  it("agrees with the repo's single-value wilderRsi at every index it can speak at", () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + Math.sin(i / 4) * 6 + i * 0.15);
    const series = wilderRsiSeries(closes, 14);
    expect(series.slice(0, 14).every((v) => v === null)).toBe(true);
    expect(series[14]).not.toBeNull();
    // The single-value node refuses to speak until period+2 bars exist, so it
    // trails by one index. Past that the two recursions must be identical.
    for (let i = 15; i < closes.length; i++) {
      const single = wilderRsi(closes.slice(0, i + 1), 14);
      expect(single).not.toBeNull();
      expect(series[i]).toBeCloseTo(single as number, 10);
    }
  });

  it("reads 50 on an alternating series, 100 on a pure uptrend, 0 on a pure downtrend", () => {
    const alt = Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    expect(wilderRsiSeries(alt, 14)[14]).toBeCloseTo(50, 10);
    const up = Array.from({ length: 40 }, (_, i) => 100 + i);
    expect(wilderRsiSeries(up, 14)[39]).toBe(100);
    const down = Array.from({ length: 40 }, (_, i) => 100 - i);
    expect(wilderRsiSeries(down, 14)[39]).toBe(0);
  });
});

describe("atrSeries", () => {
  it("is exactly 1 on a path whose every step is within 0.5", () => {
    const bars = pathBars(H4_MERGE);
    const atr = atrSeries(bars, 14);
    expect(atr.slice(0, 13).every((v) => v === null)).toBe(true);
    expect(atr[13]).toBeCloseTo(1, 12);
    expect(atr[bars.length - 1]).toBeCloseTo(1, 12);
  });

  it("falls back to the bar range when there is no previous close", () => {
    const bars = [bar(100, 103, 99, 101), bar(101, 102, 100, 101.5), bar(101.5, 102, 101, 101.5), bar(101.5, 102, 101, 101.5)];
    const atr = atrSeries(bars, 3);
    expect(atr[2]).toBeCloseTo((4 + 2 + 1) / 3, 10);
  });

  it("returns nothing at all when the series is shorter than the window", () => {
    expect(atrSeries(pathBars([100, 101, 100.5]), 14).every((v) => v === null)).toBe(true);
  });
});

describe("sma", () => {
  it("is null until the window fills, then the trailing mean", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
});

describe("detectSwings", () => {
  it("finds exactly the two swings the fixture was built around", () => {
    expect(detectSwings(pathBars(H4_MERGE), 3).map((s) => [s.index, s.price, s.kind])).toEqual([
      [5, 99.5, "low"],
      [10, 101.5, "high"],
      [15, 99.7, "low"],
    ]);
  });

  it("does not confirm a flat top — the fractal test is strict", () => {
    expect(detectSwings(pathBars([1, 2, 5, 5, 2, 1]), 1)).toEqual([]);
  });
});

describe("buildZones", () => {
  it("merges bands that overlap and counts the touches, in ATR units", () => {
    const zones = buildZones(pathBars(H4_MERGE), "4H");
    expect(zones).toHaveLength(2);
    const [merged, overhead] = [...zones].sort((a, b) => a.low - b.low);
    // 99.5 and 99.7 are within the 0.25 merge gap, so one band runs from
    // 99.5 - 0.25 to 99.7 + 0.25 and carries both touches.
    expect(merged.low).toBeCloseTo(99.25, 10);
    expect(merged.high).toBeCloseTo(99.95, 10);
    expect(merged.touchCount).toBe(2);
    expect(merged.strength).toBe(3); // two touches + recency (touched 9 bars ago)
    expect(overhead.low).toBeCloseTo(101.25, 10);
    expect(overhead.high).toBeCloseTo(101.75, 10);
    expect(overhead.touchCount).toBe(1);
  });

  it("keeps bands apart when the gap is wider than a quarter ATR", () => {
    const zones = buildZones(pathBars(H4_DOWN), "4H");
    expect(zones).toHaveLength(3);
    expect(zones.map((z) => z.touchCount)).toEqual([1, 1, 1]);
    expect(zones.map((z) => z.low).sort((a, b) => a - b)).toEqual([
      expect.closeTo(99.75, 10),
      expect.closeTo(100.75, 10),
      expect.closeTo(102.25, 10),
    ]);
  });

  it("drops the recency bonus once the band has not been touched for 50 bars", () => {
    const tail = Array.from({ length: 60 }, (_, i) => 102 - 0.02 * (i + 1));
    const zones = buildZones(pathBars([...H4_MERGE, ...tail]), "4H");
    expect(zones.find((z) => z.touchCount === 2)!.strength).toBe(2);
    expect(zones.find((z) => z.touchCount === 1)!.strength).toBe(1);
  });

  it("returns nothing when there is not enough history for an ATR", () => {
    expect(buildZones(pathBars([100, 101, 100.5]), "4H")).toEqual([]);
  });
});

describe("detectFvgs", () => {
  const mk = (h: number, l: number) => bar((h + l) / 2, h, l, (h + l) / 2);

  it("finds bullish gaps, sizes them in ATR, and marks the one price came back into", () => {
    const bars = [mk(100, 99), mk(101, 100), mk(105, 104), mk(105, 103.5)];
    const fvgs = detectFvgs(bars, [null, 1, 1, 1]);
    expect(fvgs).toHaveLength(2);
    expect(fvgs[0]).toMatchObject({ kind: "bullish", low: 100, high: 104, filled: true });
    expect(fvgs[0].strength).toBeCloseTo(4, 10);
    // The last gap has no bars after it yet, so it cannot have filled.
    expect(fvgs[1]).toMatchObject({ kind: "bullish", low: 101, high: 103.5, filled: false });
    expect(fvgs[1].strength).toBeCloseTo(2.5, 10);
  });

  it("finds bearish gaps the same way", () => {
    const bars = [mk(100, 99), mk(100, 99), mk(94, 93), mk(95, 92)];
    const fvgs = detectFvgs(bars, [null, 1, 1, 1]);
    expect(fvgs).toHaveLength(2);
    expect(fvgs[0]).toMatchObject({ kind: "bearish", low: 94, high: 99, filled: true });
    expect(fvgs[1]).toMatchObject({ kind: "bearish", low: 95, high: 99, filled: false });
  });

  it("declines to size a gap it has no ATR for", () => {
    const bars = [mk(100, 99), mk(101, 100), mk(105, 104), mk(105, 103.5)];
    expect(detectFvgs(bars, bars.map(() => null))).toEqual([]);
  });
});

describe("htfBias4h", () => {
  it("goes up when the close clears the last confirmed swing high", () => {
    expect(htfBias4h(pathBars(H4_MERGE))).toBe("up");
  });

  it("goes down when the close loses the last confirmed swing low", () => {
    expect(htfBias4h(pathBars(H4_DOWN))).toBe("down");
  });

  it("says nothing when structure says nothing", () => {
    expect(htfBias4h([])).toBe("none");
    expect(htfBias4h(pathBars([100, 100.2, 100.1, 100.3]))).toBe("none");
  });
});

describe("rsiContribution", () => {
  it("pays a LONG for weakness and docks it for strength", () => {
    expect([39.9, 40, 49.9, 50, 65, 65.1, 75, 75.1].map((r) => rsiContribution(r, "long"))).toEqual([
      10, 5, 5, 0, 0, -5, -5, -10,
    ]);
  });

  it("mirrors every band for a SHORT", () => {
    expect([60.1, 60, 50.1, 50, 35, 34.9, 25, 24.9].map((r) => rsiContribution(r, "short"))).toEqual([
      10, 5, 5, 0, 0, -5, -5, -10,
    ]);
  });

  it("never lets a merely un-extended reading add points", () => {
    expect(rsiContribution(55, "long")).toBe(0);
    expect(rsiContribution(45, "short")).toBe(0);
  });
});

describe("rsiDivergence", () => {
  const lows = [95, 90, 92, 93, 94, 89];
  const highs = [96, 95, 95, 96, 97, 91];
  const divBars = lows.map((l, i) => bar(l, highs[i], l, l + 0.5));

  it("calls a lower low that RSI refuses to confirm", () => {
    expect(rsiDivergence(divBars, [null, 30, 32, 34, 36, 45], "long")).toBe(true);
  });

  it("does not call it when RSI confirms the new low", () => {
    expect(rsiDivergence(divBars, [null, 30, 32, 34, 36, 20], "long")).toBe(false);
  });

  it("mirrors it for a higher high", () => {
    const bHighs = [96, 99, 98, 97, 96, 100];
    const bLows = [95, 95.5, 96.5, 95.5, 94.5, 95.5];
    const bBars = bHighs.map((h, i) => bar(h - 0.5, h, bLows[i], h - 0.5));
    expect(rsiDivergence(bBars, [null, 70, 68, 66, 64, 55], "short")).toBe(true);
    expect(rsiDivergence(bBars, [null, 70, 68, 66, 64, 80], "short")).toBe(false);
  });

  it("stays out of the way when there is no window", () => {
    expect(rsiDivergence(divBars.slice(0, 4), [null, 30, 32, 34], "long")).toBe(false);
  });
});

describe("classifyLocation", () => {
  it("prefers a 4H zone over a 1H zone at the same price, and confirms via 1H", () => {
    const r = classifyLocation(100.5, [zone("4H", 100, 101)], [zone("1H", 100.4, 100.6)], 0.2, []);
    expect(r.location).toBe("AT_ZONE");
    expect(r.zone?.tf).toBe("4H");
    expect(r.confirmed1h).toBe(true);
  });

  it("pays the dual-timeframe bonus only when BOTH timeframes hold the price", () => {
    expect(classifyLocation(100.5, [zone("4H", 100, 101)], [zone("1H", 100.4, 100.6)], 0.2, []).dualTf).toBe(true);
    // A 1H zone at price is not its own 4H confirmation — the spec's parenthetical
    // scores "only 4H or 1H" at +15, so this must not earn the +25.
    const oneHourOnly = classifyLocation(100.5, [], [zone("1H", 100, 101)], 0.2, []);
    expect(oneHourOnly.confirmed1h).toBe(true);
    expect(oneHourOnly.dualTf).toBe(false);
    expect(classifyLocation(100.5, [zone("4H", 100, 101)], [], 0.2, []).dualTf).toBe(false);
  });

  it("keeps a 4H zone that is merely in range ahead of a nearer 1H band", () => {
    const r = classifyLocation(102, [zone("4H", 100, 101)], [zone("1H", 102.2, 102.5)], 4, []);
    expect(r.location).toBe("NEAR_ZONE");
    expect(r.zone?.tf).toBe("4H");
  });

  it("falls back to a strong unfilled gap when price is not at any zone", () => {
    const fvg = { kind: "bullish" as const, low: 100, high: 101, index: 2, filled: false, strength: 0.8 };
    expect(classifyLocation(100.5, [], [], 0.2, [fvg]).location).toBe("AT_FVG");
    expect(classifyLocation(100.5, [], [], 0.2, [{ ...fvg, strength: 0.3 }]).location).toBe("NOWHERE");
    expect(classifyLocation(100.5, [], [], 0.2, [{ ...fvg, filled: true }]).location).toBe("NOWHERE");
  });
});

describe("scoreLatestCandle — the two hard gates", () => {
  const flat15 = Array.from({ length: 30 }, (_, i) => {
    const c = 100 - 0.01 * i;
    return bar(c + 0.02, c + 0.04, c - 0.02, c);
  });

  it("forces a NOWHERE candle to zero rather than letting the parts add up", () => {
    const row = scoreLatestCandle({
      bars4h: pathBars([100, 100.2, 100.1, 100.3]),
      bars1h: pathBars([100, 100.2, 100.1]),
      bars15: flat15,
    });
    expect(row).not.toBeNull();
    expect(row!.location).toBe("NOWHERE");
    expect(row!.score).toBe(0);
    expect(row!.tier).toBe("skip");
    expect(row!.direction).toBe("none");
    expect(row!.stopPrice).toBeNull();
    expect(row!.rsi).toBeNull();
    expect(row!.reasons.join(" ")).toContain("NOWHERE");
  });

  it("caps a counter-trend setup at 50 even though its parts sum higher", () => {
    // Price pulls back into the [99.75, 100.25] band of an OLD 4H swing low
    // while the newest 4H swing low is 101.0 — bias down, so the bounce is a
    // LONG against the higher-timeframe trend.
    const bars15 = [...declineBars(29, 101.4, 0.045), bar(100.06, 100.16, 100.02, 100.14, 300)];
    const row = scoreLatestCandle({ bars4h: pathBars(H4_DOWN), bars1h: pathBars(H1_V), bars15 });
    expect(row).not.toBeNull();
    expect(row!.location).toBe("AT_ZONE");
    expect(row!.direction).toBe("long");
    expect(row!.htfBias).toBe("down");
    expect(row!.htfAlignment).toBe("counter_trend");
    expect(row!.components).toEqual({
      base: 25,
      location: 21, // AT_ZONE, but no 1H zone holds this price
      zoneStrength: 0, // touched once — nothing is paid below strength 3
      htfAlignment: -10,
      rsi: 10, // RSI ~0, the best band
      volume: 10,
      candle: 5,
    });
    expect(Object.values(row!.components).reduce((a, b) => a + b, 0)).toBe(61);
    expect(row!.score).toBe(50);
    expect(row!.tier).toBe("skip"); // at the cap a counter-trend signal can never fire
  });

  it("returns no opinion rather than a pass when 15m history is too short", () => {
    const short15 = declineBars(10, 101.4, 0.045);
    expect(scoreLatestCandle({ bars4h: pathBars(H4_MERGE), bars1h: pathBars(H1_V), bars15: short15 })).toBeNull();
  });
});

describe("scoreLatestCandle — a full A+ setup", () => {
  it("scores a pullback into a 4H+1H confirmed double bottom with trend, RSI and volume behind it", () => {
    // 4H: bias up (close 102.0 clears the 101.5 swing high) and the double bottom
    // leaves a two-touch band of [99.25, 99.95] — strength 3. 1H: the V at 100.2
    // leaves [99.45, 99.95], so 99.74 is confirmed on both timeframes.
    const bars15 = [...declineBars(29, 101, 0.045), bar(99.66, 99.76, 99.62, 99.74, 300)];
    const row = scoreLatestCandle({ bars4h: pathBars(H4_MERGE), bars1h: pathBars(H1_V), bars15 });
    expect(row).not.toBeNull();

    expect(row!.location).toBe("AT_ZONE");
    expect(row!.zone?.tf).toBe("4H");
    expect(row!.direction).toBe("long");
    expect(row!.htfBias).toBe("up");
    expect(row!.htfAlignment).toBe("with_trend");
    expect(row!.components).toEqual({
      base: 25,
      location: 35, // AT_ZONE on 4H, held by 1H too
      zoneStrength: 8, // strength 3
      htfAlignment: 10,
      rsi: 10, // RSI ~0, the best band; no divergence on a flat final close
      volume: 10,
      candle: 5,
    });
    expect(row!.rsiContribution).toBe(10);
    expect(row!.volumeRatio).toBeGreaterThan(SR_PARAMS.volumeHigh);
    expect(row!.score).toBe(100); // parts sum to 103, then clamp
    expect(row!.tier).toBe("A+");
    expect(row!.reasons.some((r) => r.startsWith("AT_ZONE"))).toBe(true);

    // Step 9 geometry: stop beyond the FAR side of the zone plus 0.3 ATR, and
    // the target is the next opposing zone — 2R minimum.
    const atr15 = atrSeries(bars15, SR_PARAMS.atrPeriod)[bars15.length - 1] as number;
    expect(row!.stopPrice).toBeCloseTo(99.25 - 0.3 * atr15, 10);
    expect(row!.targetPrice).toBeCloseTo(101.25, 10);
    expect(row!.rr).toBeGreaterThan(2);
  });
});
