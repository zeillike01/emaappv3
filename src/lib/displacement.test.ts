import { describe, it, expect } from "vitest";
import type { Kline } from "./types";
import {
  DISPLACEMENT_DEFAULTS,
  readDisplacementState,
  scanDisplacementSignals,
  wilderAtrSeries,
  type DisplacementOptions,
} from "./displacement";

// ── Fixtures ───────────────────────────────────────────────────────────────
//
// The bullish pattern below is built by hand so every pivot, every pivot's
// confirmation bar and the ATR read are known quantities, then mirrored for the
// short test. Mirroring is an EXACT symmetry here: EMA is affine, so
// EMA(2C − x) = 2C − EMA(x), and true range is invariant under reflection — the
// same series flipped must produce the mirrored signal, and nothing else.

const BASE = Date.parse("2026-06-01T00:00:00Z");
const FLAT: [number, number, number] = [100.0, 100.2, 99.8];

function k15(close: number, high: number, low: number, i: number): Kline {
  const openTime = BASE + i * 900_000;
  return {
    openTime,
    open: close,
    high,
    low,
    close,
    volume: 1000,
    closeTime: openTime + 899_000,
    quoteVolume: 1000 * close,
    trades: 10,
    isClosed: true,
  };
}

function series15(spec: Array<[number, number, number]>): Kline[] {
  return spec.map(([c, h, l], i) => k15(c, h, l, i));
}

/** Reflection about 100: up ⇄ down, pivot low ⇄ pivot high. */
function mirror15(spec: Array<[number, number, number]>): Array<[number, number, number]> {
  return spec.map(([c, h, l]) => [200 - c, 200 - l, 200 - h]);
}

function series4h(closes: number[]): Kline[] {
  const base = BASE - 200 * 14_400_000;
  return closes.map((c, i) => {
    const openTime = base + i * 14_400_000;
    return {
      openTime,
      open: c,
      high: c * 1.001,
      low: c * 0.999,
      close: c,
      volume: 1000,
      closeTime: openTime + 14_399_000,
      quoteVolume: 1000 * c,
      trades: 10,
      isClosed: true,
    };
  });
}

/** 4H series that allows LONG: steady uptrend, close above its EMA75. */
const HTF_UP = () => series4h(Array.from({ length: 300 }, (_, i) => 100 + i * 0.5));
/** 4H series that allows SHORT only. */
const HTF_DOWN = () => series4h(Array.from({ length: 300 }, (_, i) => 300 - i * 0.5));

/**
 * Bullish displacement pattern (LB = 2, ATR period 3, EMA 20):
 *
 *   bars 0..23   flat at 100          → EMA20 = 100, ATR small
 *   bar 25       pivot LOW 97.5
 *   bar 27       close 100 crosses back above EMA20   ← breakIndex
 *   bar 29       pivot HIGH 103.0                     ← the level to displace
 *   bar 32       pivot LOW 99.9 (higher than 97.5)    ← the Higher Low
 *   bar 35       close 103.8 closes through 103.0     ← structure break
 *
 * The HL at 32 is only knowable at bar 34 (32 + pivotLookback), so the earliest
 * honest entry is the bar AFTER 35.
 */
function bullishSpec(): Array<[number, number, number]> {
  return [
    ...Array.from({ length: 24 }, () => FLAT),
    [99.0, 99.2, 98.5],
    [98.0, 98.2, 97.5],
    [99.0, 99.2, 98.0],
    [100.0, 100.2, 98.8],
    [101.5, 101.8, 99.9],
    [102.5, 103.0, 101.5],
    [101.8, 102.2, 101.0],
    [100.8, 101.2, 100.2],
    [101.0, 101.4, 99.9],
    [102.0, 102.3, 100.5],
    [103.0, 103.3, 101.8],
    [103.8, 104.0, 102.6],
    [103.5, 104.2, 103.0],
    [104.0, 104.5, 103.5],
  ];
}

const OPTS: DisplacementOptions = {
  kAtr: 1,
  atrPeriod: 3,
  pivotLookback: 2,
  emaPeriod: 20,
};

// ── Wilder ATR ─────────────────────────────────────────────────────────────

describe("wilderAtrSeries", () => {
  it("is NaN before the seed and equals the SMA of TR[1..period] at the seed", () => {
    const bars = series15(Array.from({ length: 10 }, () => [100, 101, 99] as [number, number, number]));
    const atr = wilderAtrSeries(bars, 3);
    expect(Number.isNaN(atr[0])).toBe(true);
    expect(Number.isNaN(atr[2])).toBe(true);
    // TR is 2 on every bar after the first, so the seed is exactly 2.
    expect(atr[3]).toBeCloseTo(2, 10);
    expect(atr[9]).toBeCloseTo(2, 10);
  });

  it("returns all-NaN when there is not enough history for the period", () => {
    const bars = series15(Array.from({ length: 5 }, () => FLAT));
    expect(wilderAtrSeries(bars, 14).every((v) => Number.isNaN(v))).toBe(true);
  });
});

// ── The displacement gate ──────────────────────────────────────────────────

describe("scanDisplacementSignals", () => {
  it("fires LONG on the structure-break bar when the leg clears k x ATR", () => {
    const sigs = scanDisplacementSignals(series15(bullishSpec()), HTF_UP(), OPTS);
    expect(sigs).toHaveLength(1);
    const s = sigs[0];
    expect(s.type).toBe("LONG");
    expect(s.index).toBe(35); // the bar that closed through the prior swing high
    expect(s.structureIndex).toBe(32); // the Higher Low pivot
    expect(s.structurePrice).toBeCloseTo(99.9, 10);
    expect(s.breakLevel).toBeCloseTo(103.0, 10);
    expect(s.breakIndex).toBe(35);
    expect(s.displacementAtr).toBeGreaterThanOrEqual(1);
    expect(s.legAmplitude).toBeCloseTo(104.0 - 99.9, 10);
    expect(s.reason).toContain("DISPLACEMENT LONG");
  });

  it("does NOT fire when the leg is too small for k — the chop case", () => {
    // Same series, k raised past the leg's actual amplitude in ATR: the
    // structure break still happens, it just is not a displacement.
    const sigs = scanDisplacementSignals(series15(bullishSpec()), HTF_UP(), { ...OPTS, kAtr: 60 });
    expect(sigs).toHaveLength(0);
  });

  it("does NOT fire when the 4H filter blocks the side", () => {
    const sigs = scanDisplacementSignals(series15(bullishSpec()), HTF_DOWN(), OPTS);
    expect(sigs).toHaveLength(0);
  });

  it("abandons the setup when price closes back through the Higher Low", () => {
    const spec = bullishSpec();
    // Bar 33 (the first bar after the HL pivot) closes below the HL → structure broken.
    spec[33] = [99.0, 99.5, 98.6];
    const sigs = scanDisplacementSignals(series15(spec), HTF_UP(), OPTS);
    expect(sigs).toHaveLength(0);
  });

  it("does NOT fire before the pivot's confirmation window closes (causality)", () => {
    // Truncate the series to bar 34: the break has NOT happened yet, so nothing fires,
    // and every signal that does fire is at least pivotLookback bars after its pivot.
    const sigs = scanDisplacementSignals(series15(bullishSpec().slice(0, 35)), HTF_UP(), OPTS);
    expect(sigs).toHaveLength(0);

    const full = scanDisplacementSignals(series15(bullishSpec()), HTF_UP(), OPTS);
    for (const s of full) {
      expect(s.structureIndex + OPTS.pivotLookback!).toBeLessThanOrEqual(s.index);
      expect(s.breakIndex).toBeGreaterThan(s.structureIndex);
      expect(s.index).toBeGreaterThanOrEqual(s.breakIndex);
    }
  });

  it("mirrors exactly for SHORT", () => {
    const longs = scanDisplacementSignals(series15(bullishSpec()), HTF_UP(), OPTS);
    const sigs = scanDisplacementSignals(series15(mirror15(bullishSpec())), HTF_DOWN(), OPTS);
    expect(sigs).toHaveLength(1);
    const s = sigs[0];
    expect(s.type).toBe("SHORT");
    expect(s.index).toBe(35);
    expect(s.structureIndex).toBe(32);
    expect(s.structurePrice).toBeCloseTo(100.1, 10); // mirror of 99.9
    expect(s.breakLevel).toBeCloseTo(97.0, 10); // mirror of 103.0
    // True range and EMA are both invariant under a reflection about a constant,
    // so the mirrored trade must carry the identical amplitude/ATR profile.
    expect(s.legAmplitude).toBeCloseTo(longs[0].legAmplitude, 10);
    expect(s.atrAtBreak).toBeCloseTo(longs[0].atrAtBreak, 10);
    expect(s.displacementAtr).toBeCloseTo(longs[0].displacementAtr, 10);
  });

  it("returns nothing on a too-short series instead of throwing", () => {
    expect(scanDisplacementSignals(series15([FLAT, FLAT]), HTF_UP(), OPTS)).toEqual([]);
  });

  it("uses the spec defaults when options are omitted", () => {
    expect(DISPLACEMENT_DEFAULTS.pivotLookback).toBe(5);
    expect(DISPLACEMENT_DEFAULTS.emaPeriod).toBe(50);
    expect(DISPLACEMENT_DEFAULTS.atrPeriod).toBe(14);
  });
});

// ── Live readout ───────────────────────────────────────────────────────────

describe("readDisplacementState", () => {
  it("reports an armed LONG on the break bar", () => {
    const bars = series15(bullishSpec());
    const st = readDisplacementState(bars, HTF_UP(), OPTS);
    expect(st).not.toBeNull();
    expect(st!.long.armed).toBe(true);
    expect(st!.long.breakActive).toBe(true);
    expect(st!.long.breakIndex).toBe(27);
    expect(st!.long.structureFormed).toBe(true);
    expect(st!.long.structureIndex).toBe(32);
    expect(st!.long.breakLevel).toBeCloseTo(103.0, 10);
    expect(st!.long.broken).toBe(true);
    expect(st!.long.displaced).toBe(true);
    expect(st!.long.htfAllowed).toBe(true);
    expect(st!.short.armed).toBe(false);
  });

  it("reports not-armed while the leg has not closed through the level", () => {
    // Through bar 34: the HL at 32 is confirmed (32 + LB) but nothing has closed
    // through the 103.0 level yet.
    const bars = series15(bullishSpec().slice(0, 35));
    const st = readDisplacementState(bars, HTF_UP(), OPTS);
    expect(st!.long.structureFormed).toBe(true);
    expect(st!.long.broken).toBe(false);
    expect(st!.long.armed).toBe(false);
  });

  it("returns the 15m EMA and 4H EMA on the last closed bars", () => {
    const st = readDisplacementState(series15(bullishSpec()), HTF_UP(), OPTS);
    expect(st!.ema15m).toBeGreaterThan(0);
    expect(st!.ema4h).toBeGreaterThan(0);
    expect(st!.kAtr).toBe(1);
    expect(st!.last4hBarTime).toBeGreaterThan(0);
  });

  it("returns null when the series is too short to evaluate", () => {
    expect(readDisplacementState(series15([FLAT, FLAT]), HTF_UP(), OPTS)).toBeNull();
  });
});
