import { describe, expect, test } from "vitest";
import {
  CAUSAL_RAW_FIELDS,
  DERIVED_CAUSAL_FEATURES,
  POST_HOC_FIELDS,
  assertCausalFeatureList,
  paperCausalFeatures,
  type PaperTrade,
} from "./paper-feature-contract";

const trade = (over: Partial<PaperTrade> = {}): PaperTrade => ({
  type: "LONG",
  entryPrice: 100,
  slPrice: 98.5,
  htfEma20_4h: 102,
  htfEma50_4h: 99,
  htfVol4h: 120,
  htfVol4hAvg: 100,
  btcChange1h: 0.25,
  btcTrendAtEntry: "up",
  htfTrend1h: "up",
  session: "us",
  longScore: 12,
  shortScore: -4,
  atrPctAtEntry: 0.3,
  ...over,
});

describe("paper feature contract: leakage guard", () => {
  test("refuses MFE and friends as predictors, by name", () => {
    for (const field of ["mfeR", "maeR", "mfeCaptureRatio", "btcMoveDuringTrade", "realizedR"]) {
      expect(() => assertCausalFeatureList(["atrPctAtEntry", field])).toThrow(/post-hoc/);
    }
  });

  test("the message names the offenders and points at the label use", () => {
    expect(() => assertCausalFeatureList(["mfeR", "maeR"])).toThrow(/mfeR, maeR/);
    expect(() => assertCausalFeatureList(["mfeR"])).toThrow(/mistake taxonomy/);
  });

  test("accepts the causal list and every derived feature", () => {
    expect(() => assertCausalFeatureList([...DERIVED_CAUSAL_FEATURES])).not.toThrow();
    expect(() => assertCausalFeatureList([...CAUSAL_RAW_FIELDS])).not.toThrow();
  });

  test("no post-hoc field appears in the derived causal set", () => {
    for (const f of DERIVED_CAUSAL_FEATURES) {
      expect(POST_HOC_FIELDS as readonly string[]).not.toContain(f);
    }
  });

  test("a post-hoc value on the record cannot reach the feature vector", () => {
    // The record carries a perfect MFE that would score the trade as a winner.
    // The feature vector must be byte-identical to the same trade without it.
    const withMfe = paperCausalFeatures(trade({ mfeR: 9.9, realizedR: 2 }));
    const without = paperCausalFeatures(trade());
    expect(withMfe).toEqual(without);
    expect(JSON.stringify(withMfe)).not.toMatch(/mfe/i);
  });
});

describe("paper feature contract: derived features", () => {
  test("signs the score to the trade's side", () => {
    const long = paperCausalFeatures(trade({ type: "LONG", longScore: 12, shortScore: -4 }))!;
    const short = paperCausalFeatures(trade({ type: "SHORT", longScore: 12, shortScore: -4 }))!;
    expect(long.sideScore).toBe(12);
    expect(short.sideScore).toBe(-4);
    // Same book, opposite direction: the edge must flip sign too.
    expect(long.scoreEdge).toBe(16);
    expect(short.scoreEdge).toBe(-16);
  });

  test("computes distance to both HTF EMAs from the stored levels", () => {
    const f = paperCausalFeatures(trade({ entryPrice: 100, htfEma20_4h: 102, htfEma50_4h: 99 }))!;
    expect(f.distToHtfEma20Pct).toBeCloseTo(((100 - 102) / 102) * 100, 6);
    expect(f.distToHtfEma50Pct).toBeCloseTo(((100 - 99) / 99) * 100, 6);
    // Strength of the HTF trend, independent of where price sits.
    expect(f.htfEmaSpreadPct).toBeCloseTo(((102 - 99) / 99) * 100, 6);
  });

  test("turns BTC state at entry into numbers and ignores BTC state during the trade", () => {
    const f = paperCausalFeatures(trade({ btcChange1h: 0.25, btcTrendAtEntry: "up", btcMoveDuringTrade: -5 }))!;
    expect(f.btcChange1h).toBe(0.25);
    expect(f.btcTrendBull).toBe(1);
    expect(f.btcTrendBear).toBe(0);
    expect(Object.keys(f)).not.toContain("btcMoveDuringTrade");
  });

  test("volume ratio and stop distance are derived, not raw", () => {
    const f = paperCausalFeatures(trade({ htfVol4h: 120, htfVol4hAvg: 100, entryPrice: 100, slPrice: 98.5 }))!;
    expect(f.htfVolRatio).toBeCloseTo(1.2, 6);
    expect(f.stopDistancePct).toBeCloseTo(1.5, 6);
  });

  test("returns null when the entry price is unusable", () => {
    expect(paperCausalFeatures(trade({ entryPrice: undefined }))).toBeNull();
    expect(paperCausalFeatures(trade({ entryPrice: 0 }))).toBeNull();
    expect(paperCausalFeatures(trade({ entryPrice: NaN }))).toBeNull();
  });

  test("one-hots session and trend labels, emitting explicit zeros", () => {
    const f = paperCausalFeatures(trade({ session: "asia", btcTrendAtEntry: "down", htfTrend1h: "down" }))!;
    // Explicit 0s, not absent keys: the model needs the same feature vector
    // shape on every record regardless of which label it happens to carry.
    expect(f.sessionAsia).toBe(1);
    expect(f.sessionUs).toBe(0);
    expect(f.sessionEurope).toBe(0);
    expect(f.btcTrendBear).toBe(1);
    expect(f.btcTrendBull).toBe(0);
    expect(f.htfTrend1hDown).toBe(1);
    expect(f.htfTrend1hUp).toBe(0);
  });
});
