import { describe, expect, test } from "vitest";
import { atrPctSeries } from "./backtest";
import {
  VOLATILITY_REGIME_DEFAULTS,
  volatilityRegimeAt,
  volatilityRegimeBlocks,
  type VolatilityRegimeCfg,
} from "./volatility-regime";
import type { Kline } from "./types";

/** Build n bars whose true range is a fixed fraction of price, so ATR% is controlled. */
const bar = (index: number, rangePct: number, base = 100): Kline => ({
  openTime: index * 900_000,
  closeTime: (index + 1) * 900_000 - 1,
  open: base,
  high: base * (1 + rangePct),
  low: base * (1 - rangePct),
  close: base,
  volume: 100,
  quoteVolume: 100,
  trades: 1,
  isClosed: true,
});

const flat = (n: number, rangePct: number) => Array.from({ length: n }, (_, i) => bar(i, rangePct));

/** Regime: mostly quiet, with a loud patch in the middle of the tail. */
const withBurst = (n: number) =>
  Array.from({ length: n }, (_, i) => bar(i, i >= n - 30 && i < n - 10 ? 0.05 : 0.005));

const cfg = (over: Partial<VolatilityRegimeCfg> = {}): Partial<VolatilityRegimeCfg> => ({
  lookbackBars: 100,
  blockAboveRank: 0.8,
  minBars: 20,
  ...over,
});

describe("volatility regime", () => {
  test("ranks a quiet bar near the bottom of its own trailing window", () => {
    const bars = withBurst(200);
    const at = bars[199]!.closeTime;
    const read = volatilityRegimeAt(bars, at, cfg());
    expect(read.verdict).toBe("allowed");
    expect(read.rank).not.toBeNull();
    // The last bar is back to quiet, so it should not read as the hottest one.
    expect(read.rank!).toBeLessThan(0.8);
  });

  test("blocks a bar that is the most volatile in its own window", () => {
    const bars = withBurst(200);
    // Index 189 sits inside the 30-bar loud patch, at its loudest edge.
    const burst = bars[189]!;
    const read = volatilityRegimeAt(bars, burst.closeTime, cfg({ lookbackBars: 40 }));
    expect(read.atrPct).toBeGreaterThan(0);
    expect(read.rank!).toBeGreaterThan(0.5);
  });

  test("the read cannot see bars after the one being judged", () => {
    const bars = withBurst(200);
    const at = bars[150]!.closeTime;
    const before = volatilityRegimeAt(bars, at, cfg());
    // Append a catastrophic volatility spike AFTER the read time.
    const future = Array.from({ length: 40 }, (_, i) => bar(200 + i, 0.5));
    const after = volatilityRegimeAt([...bars, ...future], at, cfg());
    expect(after.rank).toBe(before.rank);
    expect(after.verdict).toBe(before.verdict);
    expect(after.atrPct).toBe(before.atrPct);
  });

  test("warm-up ALLOWS rather than blocking, so a cold pair is not silently muted", () => {
    // Enough bars for ATR(14) to exist, but too few trailing values to rank.
    const bars = flat(40, 0.05);
    const read = volatilityRegimeAt(bars, bars[39]!.closeTime, cfg({ minBars: 50 }));
    expect(read.verdict).toBe("warmup");
    expect(read.rank).toBeNull();
    expect(read.reason).toMatch(/usable trailing/);
  });

  test("a read before ATR(14) exists is warm-up too", () => {
    const bars = flat(10, 0.05);
    const read = volatilityRegimeAt(bars, bars[9]!.closeTime, cfg());
    expect(read.verdict).toBe("warmup");
    expect(read.reason).toMatch(/ATR warm-up/);
  });

  test("a lower rank cut blocks at least as much as a higher one", () => {
    // `blockAboveRank` is a ceiling on the rank, so 0.5 is the LOOSER cut and
    // must therefore block no fewer bars than 0.95.
    const bars = withBurst(200);
    let loose = 0;
    let strict = 0;
    for (let i = 0; i < bars.length; i++) {
      const t = bars[i]!.closeTime;
      if (volatilityRegimeBlocks(bars, t, cfg({ blockAboveRank: 0.5 }))) loose++;
      if (volatilityRegimeBlocks(bars, t, cfg({ blockAboveRank: 0.95 }))) strict++;
    }
    expect(loose).toBeGreaterThanOrEqual(strict);
    expect(strict).toBeGreaterThan(0);
  });

  test("a disabled gate allows everything and reads nothing", () => {
    const bars = withBurst(200);
    const read = volatilityRegimeAt(bars, bars[199]!.closeTime, cfg({ blockAboveRank: 0 }));
    expect(read.verdict).toBe("allowed");
    expect(read.rank).toBeNull();
    expect(read.reason).toMatch(/disabled/);
  });

  test("defaults are a sane non-degenerate configuration", () => {
    expect(VOLATILITY_REGIME_DEFAULTS.blockAboveRank).toBeGreaterThan(0.5);
    expect(VOLATILITY_REGIME_DEFAULTS.blockAboveRank).toBeLessThan(1);
    expect(VOLATILITY_REGIME_DEFAULTS.minBars).toBeGreaterThan(0);
  });

  test("a read at a time before any bar is a warm-up, not a crash", () => {
    const bars = flat(50, 0.01);
    const read = volatilityRegimeAt(bars, -1, cfg());
    expect(read.verdict).toBe("warmup");
  });

  test("reusing a precomputed ATR series matches recomputing it", () => {
    const bars = withBurst(200);
    const atr = atrPctSeries(bars);
    const read = volatilityRegimeAt(bars, bars[199]!.closeTime, cfg(), atr);
    expect(read.rank).toBe(volatilityRegimeAt(bars, bars[199]!.closeTime, cfg()).rank);
  });
});
