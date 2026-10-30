/**
 * BTC regime side gate — pure classification + blocking rule. (2026-09-13)
 *
 * BTC's own 4h EMA75 slope classifies the macro tape as up/down/chop from
 * CLOSED bars only (no lookahead): slope = (EMA75[t] − EMA75[t−lookback]) /
 * EMA75[t−lookback]; up > +th, down < −th, else chop.
 *
 * The pre-registered blocking rule (run-btc-regime-gate-lab.ts): block LONG
 * in chop, block SHORT in up. The gauntlet: blocked cohort 251t at −72.1R
 * (WR 27.9%) on the armed stack, all four books lifted (+0.065…+0.083
 * net/t), OOS ≈ 2× IS on every arm, every threshold/lookback neighborhood
 * held. Wired at ±0.5% over 18 bars (the primary parameters).
 *
 * Fail-open contract: insufficient/invalid data -> undefined ->
 * the caller allows the trade (a blackout must not freeze the book).
 */

import type { Kline } from "./types";

/**
 * SMA-seeded EMA. The first `period` values are averaged to seed, then the
 * recursion runs. This used to live in proxy-signal.ts; when that book was
 * removed this became the only construction the BTC regime read needs, and it
 * is kept here rather than duplicated a third time (mexcFetchers keeps its own
 * local copy on purpose, to avoid an import edge).
 */
export function emaSeeded(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let acc = 0;
  for (let i = 0; i < period; i++) acc += values[i];
  out[period - 1] = acc / period;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i]! * k + out[i - 1]! * (1 - k);
  }
  return out;
}

export const BTC_REGIME_EMA = 75;
export const BTC_REGIME_LOOKBACK = 18;
export const BTC_REGIME_TH_PCT = 0.5;

/** Minimum bars for a valid classification: EMA seed + lookback + the
 * trailing forming slot the series must carry (read at length−2). */
export const BTC_REGIME_MIN_BARS = BTC_REGIME_EMA + BTC_REGIME_LOOKBACK + 2;

export interface BtcRegime {
  ema: number;
  slopePct: number;
  regime: "up" | "down" | "chop";
}

/** Classify BTC's macro regime from a 4h kline series.
 *
 * CONTRACT (2026-09-16, now enforced): the series must END WITH THE FORMING
 * BAR — the read is at `length − 2`, so the last CLOSED bar is at `length − 2`
 * only when a trailing forming slot is present. Every historical caller obeyed
 * this: the tests append a crashing bar to prove it is ignored, and all three
 * labs pass `slice(0, i + 2)` so their verdict for bar `i` is computed from
 * bars ≤ `i` (no lookahead).
 *
 * The LIVE path is the exception worth knowing about: `fetchKlines` already
 * strips the forming candle (it ends one full candle back and marks every bar
 * `isClosed: true`), so feeding its output straight in read the bar BEFORE the
 * newest closed one — a silent, permanent 4h lag that the labs did not share.
 * Live callers must therefore route through `padFormingBar`.
 *
 * Undefined = insufficient/invalid data → caller fails open. */
export function btcRegimeFromKlines(kl: Kline[]): BtcRegime | undefined {
  if (!kl || kl.length < BTC_REGIME_MIN_BARS) return undefined;
  const closes = kl.map((k) => k.close);
  const e = emaSeeded(closes, BTC_REGIME_EMA);
  const i = kl.length - 2;
  const now = e[i], before = e[i - BTC_REGIME_LOOKBACK];
  if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0) return undefined;
  const slopePct = (100 * (now - before)) / before;
  const regime = slopePct > BTC_REGIME_TH_PCT ? "up" : slopePct < -BTC_REGIME_TH_PCT ? "down" : "chop";
  return { ema: now, slopePct, regime };
}

/**
 * The verdict PLUS the two readings the down-block forward record is cut by
 * (2026-10-28). Same closed-bar contract as `btcRegimeFromKlines`; both extra
 * readings describe the SAME newest closed bar, so a label, its depth and its
 * direction can never describe different bars.
 *
 * `runBars` is the depth: how many consecutive closed 4h bars the current label
 * has held (1 = the bar it flipped on). `slopeDeltaPct` is the direction: the
 * slope change against the previous closed bar, in percentage points. The
 * 2026-10-28 replay found the block's refused expectancy moves with DEPTH far
 * more than with the slope's level, and that direction flips sign between
 * windows — neither is a gate, both are record fields.
 *
 * Null (not 0) when a reading cannot be computed: a missing previous bar must
 * never be rendered as "flat".
 */
export interface BtcRegimeContext extends BtcRegime {
  runBars: number | null;
  slopeDeltaPct: number | null;
}

export function btcRegimeContext(kl: Kline[]): BtcRegimeContext | undefined {
  if (!kl || kl.length < BTC_REGIME_MIN_BARS) return undefined;
  const closes = kl.map((k) => k.close);
  const e = emaSeeded(closes, BTC_REGIME_EMA);

  const slopeAt = (i: number): number => {
    if (i - BTC_REGIME_LOOKBACK < 0) return NaN;
    const now = e[i];
    const before = e[i - BTC_REGIME_LOOKBACK];
    if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0) return NaN;
    return (100 * (now - before)) / before;
  };
  const labelOf = (s: number): "up" | "down" | "chop" =>
    s > BTC_REGIME_TH_PCT ? "up" : s < -BTC_REGIME_TH_PCT ? "down" : "chop";

  const i = kl.length - 2; // newest CLOSED bar (see the contract above)
  const slopePct = slopeAt(i);
  if (!Number.isFinite(slopePct)) return undefined;
  const regime = labelOf(slopePct);

  // Depth: walk back while the label holds. Bounded at the last bar that can
  // produce a slope, so a long run cannot read past the EMA's first reading.
  let runBars = 1;
  for (let j = i - 1; j >= BTC_REGIME_EMA + BTC_REGIME_LOOKBACK; j--) {
    const s = slopeAt(j);
    if (!Number.isFinite(s) || labelOf(s) !== regime) break;
    runBars++;
  }

  const prev = slopeAt(i - 1);
  return {
    ema: e[i]!,
    slopePct,
    regime,
    runBars,
    slopeDeltaPct: Number.isFinite(prev) ? slopePct - prev : null,
  };
}

/**
 * THE RUN LOG (2026-10-28) — the last few labels as runs, for the card's strip.
 *
 * Pure, and derived from the SAME series, thresholds and indices as
 * `btcRegimeContext`, so a strip segment can never disagree with the label it
 * sits beside. The walk stops at `BTC_REGIME_EMA + BTC_REGIME_LOOKBACK`, the
 * first index the depth counter in `btcRegimeContext` also accepts — that is
 * what makes the newest run's `bars` equal that call's `runBars` exactly,
 * truncation at the window edge included.
 *
 * `startedAt` is the first bar's openTime INSIDE the analysed window. A run
 * older than the window is truncated, never invented: `bars` counts only what
 * this series can prove. Chronological, oldest first.
 */
export interface BtcRegimeRun {
  regime: "up" | "down" | "chop";
  /** openTime of the run's first bar in the window. */
  startedAt: number;
  /** Closed bars in the run, truncated at the window's edge. */
  bars: number;
  /** Slope at the run's newest bar, % — the reading that decided its label. */
  slopePct: number;
}

export function btcRegimeRuns(kl: Kline[], limit = 8): BtcRegimeRun[] {
  if (!kl || kl.length < BTC_REGIME_MIN_BARS) return [];
  const newest = kl.length - 2; // newest CLOSED bar (same contract as above)
  const first = BTC_REGIME_EMA + BTC_REGIME_LOOKBACK;
  if (newest < first) return [];

  const e = emaSeeded(
    kl.map((k) => k.close),
    BTC_REGIME_EMA,
  );
  const slopeAt = (i: number): number => {
    const now = e[i],
      before = e[i - BTC_REGIME_LOOKBACK];
    if (!Number.isFinite(now) || !Number.isFinite(before) || before <= 0) return NaN;
    return (100 * (now - before)) / before;
  };
  const labelOf = (s: number): BtcRegimeRun["regime"] =>
    s > BTC_REGIME_TH_PCT ? "up" : s < -BTC_REGIME_TH_PCT ? "down" : "chop";

  const runs: BtcRegimeRun[] = [];
  let end = newest;
  let start = newest;
  let label = labelOf(slopeAt(newest));
  for (let i = newest - 1; i >= first; i--) {
    const l = labelOf(slopeAt(i));
    if (l === label) {
      start = i;
      continue;
    }
    runs.push({ regime: label, startedAt: kl[start]!.openTime, bars: end - start + 1, slopePct: slopeAt(end) });
    end = i;
    start = i;
    label = l;
  }
  runs.push({ regime: label, startedAt: kl[start]!.openTime, bars: end - start + 1, slopePct: slopeAt(end) });
  runs.reverse();
  const max = Math.max(1, Math.floor(limit));
  return runs.length > max ? runs.slice(runs.length - max) : runs;
}

export const BTC_REGIME_TF_MS = 4 * 60 * 60 * 1000;

/**
 * Cache-validity rule for the bar-guarded regime cache (2026-09-16).
 *
 * The verdict is a PURE function of the closed 4h series, and that series only
 * advances when a 4h bar closes — so a cached verdict is reusable exactly
 * while `now` sits in the same 4h bucket (i.e. while the newest CLOSED bar is
 * still the one the fetch saw). `cachedBarOpenTime` is the newest CLOSED bar
 * openTime at the time of the fetch (the same quantity `newestClosedBarOpen`
 * derives), so `>=` is the whole rule: a cache entry from the current or a
 * newer bucket is valid, anything older is a miss → fetch (old behavior).
 *
 * Kept pure and separate from Convex so the invariant is unit-testable.
 */
export function btcRegimeCacheValid(
  cachedBarOpenTime: number,
  now: number,
  tfMs: number = BTC_REGIME_TF_MS,
): boolean {
  const newestClosed = Math.floor(now / tfMs) * tfMs - tfMs;
  return cachedBarOpenTime >= newestClosed;
}

/**
 * LIVE-PATH ADAPTER for the `length − 2` contract above (2026-09-16).
 *
 * `fetchKlines` returns CLOSED bars only, so its last element IS the newest
 * closed bar and passing it straight to `btcRegimeFromKlines` classified one
 * 4h bar stale. This appends a single placeholder so the newest closed bar
 * lands at `length − 2`, exactly as the labs' `slice(0, i + 2)` padding does.
 *
 * The placeholder's own OHLC is never read (the verdict indexes `length − 2`
 * and the EMA is causal), so only its PRESENCE matters — which is why its
 * values are derived, not meaningful.
 */
export function padFormingBar(kl: Kline[]): Kline[] {
  const last = kl[kl.length - 1];
  if (!last) return kl;
  const step = last.closeTime - last.openTime;
  return [
    ...kl,
    {
      ...last,
      openTime: last.closeTime,
      closeTime: last.closeTime + step,
      isClosed: false,
      volume: 0,
      quoteVolume: 0,
      trades: 0,
    },
  ];
}

/** The pre-registered blocking rule: LONG dies in chop, SHORT dies in up. */
export function btcRegimeBlocks(regime: "up" | "down" | "chop", side: "LONG" | "SHORT"): boolean {
  if (side === "LONG") return regime === "chop";
  return regime === "up";
}

/** The DOWN-BLOCK extension (2026-09-14, layer2-only): in regime "down",
 * block BOTH sides. Grind-fix lab (run-layer2-grind-fix-lab.ts): the Jun–Jul
 * autopsy found LONG-in-up −149.8R and SHORT-in-down −84.3R as the bleeders;
 * vetoing all down-regime entries lifts the layer2 full-stack surrogate era
 * +17.9 → +156.3R with both profitable windows intact (Mar–May +73.5 →
 * +91.8R, Aug–Sep +153.4 → +157.4R), cohort poison (2,303t at −137.2R,
 * −0.060/t), and every threshold/lookback neighborhood era-positive.
 * Layer2-only by measurement. */
export function btcRegimeDownBlocks(regime: "up" | "down" | "chop"): boolean {
  return regime === "down";
}

/**
 * Whether the DOWN-BLOCK makes a WHOLE entry scan pointless (2026-10-28).
 *
 * `btcRegimeDownBlocks` is regime-only: in "down" it refuses BOTH sides for
 * EVERY pair. So when the block is enabled and the verdict is "down", no
 * candidate in that scan can enter — a per-pair scan would fetch its series and
 * run its full gate chain only to be refused at the same gate. Callers that pay
 * per pair can test this FIRST.
 *
 * Fail-open, exactly like the gate it mirrors: no verdict (missing or stale
 * cache, failed fetch) is NOT a down verdict, so the scan runs normally.
 */
export function btcDownBlockSkipsScan(
  regime: BtcRegime | undefined,
  downBlockEnabled: boolean | undefined,
): boolean {
  if (downBlockEnabled !== true) return false;
  if (!regime) return false;
  return btcRegimeDownBlocks(regime.regime);
}
