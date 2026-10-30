import { describe, expect, it } from "vitest";
import type { Kline } from "./types";
import {
  BTC_REGIME_MIN_BARS,
  BTC_REGIME_TF_MS,
  btcDownBlockSkipsScan,
  btcRegimeBlocks,
  btcRegimeCacheValid,
  btcRegimeContext,
  btcRegimeDownBlocks,
  btcRegimeFromKlines,
  btcRegimeRuns,
  emaSeeded,
  padFormingBar,
} from "./btc-regime";

const bar = (close: number): Kline =>
  ({
    openTime: 0,
    closeTime: 0,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    quoteVolume: 1,
    trades: 1,
    isClosed: true,
  }) as unknown as Kline;

const series = (n: number, f: (i: number) => number): Kline[] =>
  Array.from({ length: n }, (_, i) => bar(f(i)));

/** Same, but with a real bar clock so run starts are checkable. */
const seriesAt = (n: number, f: (i: number) => number): Kline[] =>
  Array.from({ length: n }, (_, i) => ({ ...bar(f(i)), openTime: i * BTC_REGIME_TF_MS }));

describe("btcDownBlockSkipsScan (the live scan's read-the-sign-first guard)", () => {
  const down = { regime: "down" as const, ema: 1, slopePct: -0.74 };
  const up = { regime: "up" as const, ema: 1, slopePct: 0.6 };
  const chop = { regime: "chop" as const, ema: 1, slopePct: 0.1 };

  it("skips only when the block is enabled AND the verdict is down", () => {
    expect(btcDownBlockSkipsScan(down, true)).toBe(true);
    expect(btcDownBlockSkipsScan(up, true)).toBe(false);
    expect(btcDownBlockSkipsScan(chop, true)).toBe(false);
  });

  it("never skips with the block off — one side is still allowed", () => {
    expect(btcDownBlockSkipsScan(down, false)).toBe(false);
    expect(btcDownBlockSkipsScan(down, undefined)).toBe(false);
  });

  it("fails open on a missing verdict, exactly like the gate it mirrors", () => {
    expect(btcDownBlockSkipsScan(undefined, true)).toBe(false);
  });

  it("agrees with the gate: whenever it skips, BOTH sides are refused", () => {
    for (const r of [down, up, chop]) {
      if (!btcDownBlockSkipsScan(r, true)) continue;
      for (const side of ["LONG", "SHORT"] as const) {
        expect(btcRegimeBlocks(r.regime, side) || btcRegimeDownBlocks(r.regime)).toBe(true);
      }
    }
  });
});

describe("btcRegimeRuns (the card's regime strip)", () => {
  it("agrees with the classifier it is drawn beside", () => {
    const kl = seriesAt(240, (i) => 100 * Math.pow(0.997, i));
    const ctx = btcRegimeContext(kl)!;
    const runs = btcRegimeRuns(kl);
    expect(runs.length).toBeGreaterThan(0);
    const last = runs[runs.length - 1]!;
    // The strip's newest segment IS the live verdict — same label, same depth.
    expect(last.regime).toBe(ctx.regime);
    expect(last.bars).toBe(ctx.runBars);
  });

  it("is chronological, alternates labels, and counts real bars", () => {
    const kl = seriesAt(240, (i) =>
      100 * Math.pow(0.996, Math.min(i, 120)) * Math.pow(1.004, Math.max(0, i - 120)),
    );
    const runs = btcRegimeRuns(kl);
    expect(runs.length).toBeGreaterThan(1);
    for (let i = 1; i < runs.length; i++) {
      expect(runs[i]!.startedAt).toBeGreaterThan(runs[i - 1]!.startedAt);
      expect(runs[i]!.regime).not.toBe(runs[i - 1]!.regime);
    }
    for (const r of runs) {
      expect(r.bars).toBeGreaterThan(0);
      expect(Number.isFinite(r.slopePct)).toBe(true);
    }
  });

  it("keeps only the newest `limit` runs", () => {
    const kl = seriesAt(240, (i) =>
      100 * Math.pow(0.996, Math.min(i, 120)) * Math.pow(1.004, Math.max(0, i - 120)),
    );
    expect(btcRegimeRuns(kl, 2).length).toBeLessThanOrEqual(2);
    expect(btcRegimeRuns(kl, 1).length).toBe(1);
  });

  it("returns nothing for a series it cannot classify", () => {
    expect(btcRegimeRuns([])).toEqual([]);
    expect(btcRegimeRuns(series(50, (i) => 100 + i))).toEqual([]);
  });
});

describe("btcRegimeFromKlines", () => {
  it("rising series → up (slope > +0.5%)", () => {
    const r = btcRegimeFromKlines(series(200, (i) => 100 * Math.pow(1.005, i)));
    expect(r).toBeDefined();
    expect(r!.regime).toBe("up");
    expect(r!.slopePct).toBeGreaterThan(0.5);
  });

  it("falling series → down (slope < −0.5%)", () => {
    const r = btcRegimeFromKlines(series(200, (i) => 100 * Math.pow(0.995, i)));
    expect(r).toBeDefined();
    expect(r!.regime).toBe("down");
  });

  it("flat series → chop (|slope| ≤ 0.5%)", () => {
    const r = btcRegimeFromKlines(series(200, (i) => 100 + Math.sin(i / 7) * 0.5));
    expect(r).toBeDefined();
    expect(r!.regime).toBe("chop");
    expect(Math.abs(r!.slopePct)).toBeLessThanOrEqual(0.5);
  });

  it("insufficient bars → undefined (fail-open contract)", () => {
    expect(btcRegimeFromKlines([])).toBeUndefined();
    expect(btcRegimeFromKlines(series(50, (i) => 100 + i))).toBeUndefined();
    expect(btcRegimeFromKlines(series(BTC_REGIME_MIN_BARS - 1, (i) => 100 + i))).toBeUndefined();
  });

  it("reads the last CLOSED bar, not the forming one", () => {
    const kl = series(200, (i) => 100 * Math.pow(1.005, i));
    kl.push(bar(10)); // forming bar: crash — must not influence the regime
    const r = btcRegimeFromKlines(kl);
    expect(r).toBeDefined();
    expect(r!.regime).toBe("up");
  });
});

/**
 * The live path's half of the `length − 2` contract. `fetchKlines` returns
 * CLOSED bars only, so its last element is the newest closed bar; feeding that
 * straight in made the live gate classify the PREVIOUS bar — a permanent 4h
 * lag — while the labs (which pad via `slice(0, i + 2)`) evaluated the newest
 * closed bar. These pin the adapter that closes that gap.
 */
describe("padFormingBar (live-path adapter for the length−2 contract)", () => {
  it("appends exactly one placeholder and leaves the caller's array untouched", () => {
    const kl = series(120, () => 100);
    const padded = padFormingBar(kl);
    expect(padded.length).toBe(121);
    expect(kl.length).toBe(120); // no mutation of the fetched series
    expect(padded[120].isClosed).toBe(false);
  });

  it("empty series is returned as-is (fail-open stays reachable)", () => {
    expect(padFormingBar([]).length).toBe(0);
  });

  it("without the adapter the verdict is one bar STALE — the bug it fixes", () => {
    // A long rise, then a violent reversal on the newest closed bar.
    const rise = series(BTC_REGIME_MIN_BARS + 25, (i) => 100 * Math.pow(1.005, i));
    const kl = [...rise, bar(1)];
    // Unpadded, `bar(1)` sits at length−1 and is NEVER read: the verdict is
    // therefore identical to classifying without that bar at all (stale).
    const stale = btcRegimeFromKlines(kl)!;
    const withoutNewest = btcRegimeFromKlines(padFormingBar(rise))!;
    expect(stale.slopePct).toBeCloseTo(withoutNewest.slopePct, 12);
    expect(stale.ema).toBeCloseTo(withoutNewest.ema, 12);
    // Padded, `bar(1)` lands at length−2 and genuinely moves the verdict.
    const live = btcRegimeFromKlines(padFormingBar(kl))!;
    expect(live.slopePct).toBeLessThan(stale.slopePct);
    expect(Math.abs(live.slopePct - stale.slopePct)).toBeGreaterThan(0.5);
  });

  it("the placeholder's own values never influence the verdict", () => {
    const kl = series(200, (i) => 100 * Math.pow(1.005, i));
    const viaAdapter = btcRegimeFromKlines(padFormingBar(kl))!;
    const viaCrashPlaceholder = btcRegimeFromKlines([...kl, bar(0.0001)])!;
    expect(viaAdapter.slopePct).toBeCloseTo(viaCrashPlaceholder.slopePct, 12);
    expect(viaAdapter.regime).toBe(viaCrashPlaceholder.regime);
  });

  it("agrees with the labs' slice(0, i + 2) indexing convention", () => {
    // Labs: verdict attributed to btcKl[i], computed as slice(0, i + 2).
    // Live: the same bar is the newest closed one, so fetched-bars-so-far are
    // slice(0, i + 1) and the adapter supplies the trailing slot.
    const kl = series(140, (i) => 100 * Math.pow(1.004, i + Math.sin(i / 5) * 3));
    const i = 120;
    const labVerdict = btcRegimeFromKlines(kl.slice(0, i + 2))!;
    const liveVerdict = btcRegimeFromKlines(padFormingBar(kl.slice(0, i + 1)))!;
    expect(liveVerdict.slopePct).toBeCloseTo(labVerdict.slopePct, 12);
    expect(liveVerdict.regime).toBe(labVerdict.regime);
    expect(liveVerdict.ema).toBeCloseTo(labVerdict.ema, 12);
  });
});

/**
 * The bar-guard contract behind convex/btcRegimeCache.ts: the cached verdict is
 * reusable exactly while the newest CLOSED 4h bar has not advanced. A wrong
 * rule here means the shared cache could serve a verdict computed BEFORE the
 * newest 4h bar existed — i.e. a changed gate decision — which is the one
 * thing the optimisation must never do.
 */
describe("btcRegimeCacheValid (bar-guard for the shared verdict cache)", () => {
  const TF = BTC_REGIME_TF_MS; // 4h
  // A bucket boundary, and the newest closed bar at that instant.
  const boundary = TF * 1000;
  const newestClosed = boundary - TF;

  it("is valid for the whole bucket the value was computed in", () => {
    expect(btcRegimeCacheValid(newestClosed, boundary)).toBe(true);
    expect(btcRegimeCacheValid(newestClosed, boundary + 1)).toBe(true);
    expect(btcRegimeCacheValid(newestClosed, boundary + TF - 1)).toBe(true);
  });

  it("expires the instant the next bar closes", () => {
    // One more 4h bar closes at the next boundary → the stored verdict (which
    // never saw it) must be a miss so the engine refetches.
    expect(btcRegimeCacheValid(newestClosed, boundary + TF)).toBe(false);
  });

  it("rejects an entry from an older bucket (multi-bar staleness)", () => {
    expect(btcRegimeCacheValid(newestClosed - TF, boundary)).toBe(false);
    expect(btcRegimeCacheValid(0, boundary)).toBe(false);
  });

  it("accepts an entry from a NEWER bucket (clock skew / another engine wrote first)", () => {
    expect(btcRegimeCacheValid(newestClosed + TF, boundary)).toBe(true);
  });

  it("agrees with a naive re-derivation of the newest closed bar", () => {
    const naiveNewestClosed = (now: number) => Math.floor(now / TF) * TF - TF;
    for (const now of [boundary - 1, boundary, boundary + 12345, boundary + TF - 1, boundary + TF]) {
      // Valid ⇔ the cached bar is the newest closed bar (or newer).
      expect(btcRegimeCacheValid(naiveNewestClosed(now), now)).toBe(true);
      expect(btcRegimeCacheValid(naiveNewestClosed(now) - TF, now)).toBe(false);
    }
  });
});

describe("btcRegimeBlocks (the pre-registered rule)", () => {
  it("LONG dies in chop, only there", () => {
    expect(btcRegimeBlocks("chop", "LONG")).toBe(true);
    expect(btcRegimeBlocks("up", "LONG")).toBe(false);
    expect(btcRegimeBlocks("down", "LONG")).toBe(false);
  });

  it("SHORT dies in up, only there", () => {
    expect(btcRegimeBlocks("up", "SHORT")).toBe(true);
    expect(btcRegimeBlocks("chop", "SHORT")).toBe(false);
    expect(btcRegimeBlocks("down", "SHORT")).toBe(false);
  });
});

describe("btcRegimeDownBlocks (layer2-only DOWN-BLOCK)", () => {
  it("blocks both sides in down, nothing else", () => {
    expect(btcRegimeDownBlocks("down")).toBe(true);
    expect(btcRegimeDownBlocks("up")).toBe(false);
    expect(btcRegimeDownBlocks("chop")).toBe(false);
  });
});

// Ported from the deleted proxy-signal.test.ts when emaSeeded moved into this
// module. The BTC regime slope read is only as correct as this constructor, so
// its seeding convention gets pinned directly rather than inferred through
// btcRegimeFromKlines.
describe("emaSeeded (SMA-seeded EMA)", () => {
  it("leaves the first period-1 slots NaN and seeds at index period-1 with the SMA", () => {
    const out = emaSeeded([1, 2, 3, 4, 5], 3);
    expect(out).toHaveLength(5);
    expect(Number.isNaN(out[0]!)).toBe(true);
    expect(Number.isNaN(out[1]!)).toBe(true);
    expect(out[2]).toBeCloseTo(2, 12); // (1 + 2 + 3) / 3
  });

  it("recurses with k = 2 / (period + 1)", () => {
    const out = emaSeeded([1, 2, 3, 4], 3);
    expect(out[2]).toBeCloseTo(2, 12);
    expect(out[3]).toBeCloseTo(3, 12); // 4*0.5 + 2*0.5
  });

  it("returns all-NaN when the series is shorter than the period", () => {
    const out = emaSeeded([1, 2], 3);
    expect(out).toHaveLength(2);
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
  });

  it("returns all-NaN for a non-positive period", () => {
    expect(emaSeeded([1, 2, 3], 0).every((v) => Number.isNaN(v))).toBe(true);
    expect(emaSeeded([1, 2, 3], -1).every((v) => Number.isNaN(v))).toBe(true);
  });

  it("a constant series stays constant from the seed onward", () => {
    const out = emaSeeded([7, 7, 7, 7, 7], 2);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeCloseTo(7, 12);
  });

  it("returns an empty array for empty input without throwing", () => {
    expect(emaSeeded([], 3)).toEqual([]);
  });

  it("output length always equals input length", () => {
    for (const n of [5, 20, 75, 200]) {
      expect(emaSeeded(new Array<number>(n).fill(1), 5)).toHaveLength(n);
    }
  });
});
