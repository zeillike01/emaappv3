import { describe, expect, it } from "vitest";
import {
  BTC_BETA_FALLBACK,
  BTC_BETA_MAX,
  BTC_BETA_MIN,
  betaCapBlocks,
  estimateBtcBeta,
  netBtcBeta,
  signedBeta,
} from "../btc-beta";

/** Build a 15m close series on a fixed clock so two series can be aligned. */
const series = (closes: number[], startOpen = 1_000_000) =>
  closes.map((close, i) => ({ openTime: startOpen + i * 900_000, close }));

/** A pair that moves exactly twice BTC's return, bar for bar. */
function scaledSeries(btc: number[], multiple: number, startOpen = 1_000_000) {
  const out: { openTime: number; close: number }[] = [{ openTime: startOpen, close: 100 }];
  for (let i = 1; i < btc.length; i++) {
    const r = (btc[i] - btc[i - 1]) / btc[i - 1];
    const prev = out[out.length - 1].close;
    out.push({ openTime: startOpen + i * 900_000, close: prev * (1 + r * multiple) });
  }
  return out;
}

const BTC = [100, 101, 100.5, 102, 101, 103, 102.5, 104, 103, 105, 104.5, 106, 105, 107, 106.5];

describe("estimateBtcBeta", () => {
  it("recovers a known multiple of BTC's returns", () => {
    const beta = estimateBtcBeta(scaledSeries(BTC, 1.5), series(BTC));
    expect(beta).toBeCloseTo(1.5, 2);
  });

  it("returns ~1.0 for a pair that is an exact copy of BTC", () => {
    expect(estimateBtcBeta(series(BTC), series(BTC))).toBeCloseTo(BTC_BETA_FALLBACK, 2);
  });

  it("returns ~0 (clamped to the floor) for a pair uncorrelated with BTC", () => {
    // BTC wanders up; the pair alternates with no co-movement at all.
    const flat = [100, 100.1, 100.02, 100.11, 100.03, 100.12, 100.04, 100.13, 100.05, 100.14, 100.06];
    expect(estimateBtcBeta(series(flat), series(BTC))).toBe(BTC_BETA_MIN);
  });

  it("falls back instead of failing open on unusable input", () => {
    // Empty, one-sided, and constant-BTC inputs all charge the conservative
    // fallback — a missing beta must never count as ZERO exposure.
    expect(estimateBtcBeta([], series(BTC))).toBe(BTC_BETA_FALLBACK);
    expect(estimateBtcBeta(series(BTC), [])).toBe(BTC_BETA_FALLBACK);
    expect(estimateBtcBeta(series([100, 100]), series([100, 100]))).toBe(BTC_BETA_FALLBACK);
    const constantBtc = series([100, 100, 100, 100, 100]);
    expect(estimateBtcBeta(series([100, 101, 102, 103, 104]), constantBtc)).toBe(BTC_BETA_FALLBACK);
  });

  it("aligns on openTime, so mismatched clocks degrade the sample instead of lying", () => {
    const beta = estimateBtcBeta(series(BTC, 0), series(BTC, 5_000_000));
    // No overlapping bar times at all → no fit → fallback.
    expect(beta).toBe(BTC_BETA_FALLBACK);
  });

  it("clamps a degenerate fit into the sane band", () => {
    const violent = scaledSeries(BTC, 12);
    const beta = estimateBtcBeta(violent, series(BTC));
    expect(beta).toBeLessThanOrEqual(BTC_BETA_MAX);
    expect(beta).toBeGreaterThan(BTC_BETA_MIN);
  });

  it("honours the lookback window", () => {
    // With only the newest 3 paired bars the estimate still fits from them.
    const beta = estimateBtcBeta(scaledSeries(BTC, 2), series(BTC), 3);
    expect(Number.isFinite(beta)).toBe(true);
    expect(beta).toBeGreaterThanOrEqual(BTC_BETA_MIN);
  });
});

describe("signedBeta / netBtcBeta", () => {
  it("adds longs and subtracts shorts", () => {
    expect(signedBeta("LONG", 1.4)).toBe(1.4);
    expect(signedBeta("SHORT", 1.4)).toBe(-1.4);
  });

  it("charges the fallback for a missing beta", () => {
    expect(signedBeta("LONG", undefined)).toBe(BTC_BETA_FALLBACK);
    expect(signedBeta("LONG", null)).toBe(BTC_BETA_FALLBACK);
  });

  it("sums a one-sided book to full gross exposure", () => {
    const net = netBtcBeta([
      { side: "LONG", beta: 1.2 },
      { side: "LONG", beta: 0.8 },
      { side: "LONG", beta: 1.0 },
    ]);
    expect(net).toBeCloseTo(3.0, 6);
  });

  it("nets a hedged book toward zero", () => {
    const net = netBtcBeta([
      { side: "LONG", beta: 1.2 },
      { side: "SHORT", beta: 1.2 },
    ]);
    expect(net).toBeCloseTo(0, 6);
  });

  it("is the distinction a position count cannot make", () => {
    // Same NUMBER of positions, very different factor exposure.
    const lowBeta = netBtcBeta([
      { side: "LONG", beta: 0.2 },
      { side: "LONG", beta: 0.2 },
      { side: "LONG", beta: 0.2 },
    ]);
    const highBeta = netBtcBeta([
      { side: "LONG", beta: 2.5 },
      { side: "LONG", beta: 2.5 },
      { side: "LONG", beta: 2.5 },
    ]);
    expect(lowBeta).toBeCloseTo(0.6, 6);
    expect(highBeta).toBeCloseTo(7.5, 6);
  });
});

describe("betaCapBlocks", () => {
  it("never blocks while the cap is off", () => {
    expect(betaCapBlocks({ net: 100, side: "LONG", beta: 3, cap: 0 })).toBe(false);
    expect(betaCapBlocks({ net: 100, side: "LONG", beta: 3, cap: -1 })).toBe(false);
  });

  it("blocks only when the candidate would push exposure PAST the cap", () => {
    // Landing exactly ON the cap is admitted — the cap is an upper bound, not
    // a strict one — so a 3.0 book taking a 1.0 long against a 4.0 cap passes.
    expect(betaCapBlocks({ net: 3, side: "LONG", beta: 1, cap: 4 })).toBe(false);
    expect(betaCapBlocks({ net: 3, side: "LONG", beta: 1.1, cap: 4 })).toBe(true);
    expect(betaCapBlocks({ net: 2.5, side: "LONG", beta: 1.2, cap: 4 })).toBe(false);
  });

  it("lets a short REDUCE a crowded long book even at the cap", () => {
    // 5.0 net against a 4.0 cap is already over, and a short moves toward
    // zero — the whole point of bounding a signed sum rather than a count.
    expect(betaCapBlocks({ net: 5, side: "SHORT", beta: 1, cap: 4 })).toBe(false);
    expect(betaCapBlocks({ net: 4.5, side: "SHORT", beta: 0.5, cap: 4 })).toBe(false);
    expect(betaCapBlocks({ net: 4, side: "SHORT", beta: 1, cap: 4 })).toBe(false);
  });

  it("never blocks a de-risking trade, even one that stays over the cap", () => {
    // 6.0 → 5.0 is still above a 4.0 cap, but it reduces exposure. Refusing it
    // would forbid hedging the exact cluster the cap exists to bound.
    expect(betaCapBlocks({ net: 6, side: "SHORT", beta: 1, cap: 4 })).toBe(false);
    // The mirror: a long that REDUCES a crowded short book is admitted too.
    expect(betaCapBlocks({ net: -6, side: "LONG", beta: 1, cap: 4 })).toBe(false);
    // But pushing FURTHER out from the same state is blocked.
    expect(betaCapBlocks({ net: 6, side: "LONG", beta: 1, cap: 4 })).toBe(true);
  });

  it("symmetric for a short book", () => {
    expect(betaCapBlocks({ net: -3, side: "SHORT", beta: 1.5, cap: 4 })).toBe(true);
    expect(betaCapBlocks({ net: -3, side: "SHORT", beta: 0.5, cap: 4 })).toBe(false);
  });

  it("charges the fallback for an unknown beta", () => {
    expect(betaCapBlocks({ net: 3.5, side: "LONG", beta: BTC_BETA_FALLBACK, cap: 4 })).toBe(true);
  });
});
