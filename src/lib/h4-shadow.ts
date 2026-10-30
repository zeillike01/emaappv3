/**
 * H4 SHADOW TAGS (2026-09-23) — record-only forward-test instrumentation.
 *
 * Three candidate entry filters measured by the exhaustion and volume labs
 * (EXHAUSTION_JOURNAL.md, VOLUME_SIZE_JOURNAL.md) failed their promotion bar
 * on the 17-day L1 replay but produced the cleanest deletion profiles of the
 * session. Per the agreed decision, they are wired as SHADOW TAGS: every
 * decision row (paper) and entry row (both books) records which tags fire.
 * NOTHING reads them to block or score — they are data, not rules. A tag
 * earns a config gate only when its forward record clears the pre-committed
 * promotion bar (day-paired t ≥ 2.5, or beats 95% of matched random
 * deletions) — checked at journal time via `bun run lab:shadowcheck`.
 *
 * The candidate families and their lab numbers:
 *   h4-vol-climax   — just-closed 4h bar's volume ≥ 4× its prior-20 median
 *                     (log2 ≥ 2). Entered-with-tag: 115 trades, −0.39 R/t,
 *                     22.6% WR (worst bucket measured). HELD over 3 months
 *                     (lab:gate3m: −0.135 R/t, 35.9% WR).
 *   h4-big-before-pullback — 4h range ≥ 4% of price AND the entry is a
 *                     pullback (extAtr < 0.55). Pullback entries after such a
 *                     candle: 331 trades, 0.07 R/t, 38.4% WR. REVERSED over
 *                     3 months (lab:gate3m: +0.074 R/t deleted) — kept ON by
 *                     user decision, monitored at every journal check; the
 *                     3-month window used EMA21-based extAtr while the scored
 *                     book uses the slower signal EMA, so populations differ.
 *   h4-dead-before-pullback — 4h range < 1% AND pullback. 218 trades,
 *                     0.12 R/t, 42.7% WR. Same 3-month caveat (small n).
 *   rsi-heat-70 / rsi-heat-80 — side-aligned 15m RSI(7) ≥ 70 / ≥ 80 on the
 *                     signal bar. ≥80: 129 trades, −0.19 R/t, 29.5% WR.
 *                     HELD over 3 months (−0.655 R/t, 16.7% WR, n=12).
 *
 * All thresholds are exported constants so the forward test measures exactly
 * what the labs measured. Pure functions only — no I/O, no Convex imports.
 */

import { rsiSeries } from "./htf-advisor";

/** A 4h bar is a volume climax when its volume is ≥ 2^CLIMAX the prior-20 median. */
export const H4_VOL_CLIMAX_LOG2 = 2; // ≥ 4× median
/** Plain-English 4h candle size thresholds (% of price) for pullback entries. */
export const H4_BIG_PCT = 4;
export const H4_DEAD_PCT = 1;
/** Pullback test: side-aligned extension beyond the slow EMA, in ATR units. */
export const PULLBACK_EXT_ATR = 0.55;
/** Side-aligned RSI(7) heat thresholds on the 15m signal bar. */
export const RSI_HEAT = 70;
export const RSI_HEAT_SEVERE = 80;

/** The 4h numbers the tags read, from the newest CLOSED 4h bar. */
export type H4Shadow = {
  barOpenTime: number;
  /** bar range as % of its close (the "size of the candle") */
  rangePct: number;
  /** log2(volume / median of the prior 20 bars' volume) */
  volLog2: number;
};

export type ShadowTags = {
  tags: string[];
  h4RangePct: number | null;
  h4VolLog2: number | null;
  rsi7: number | null;
};

export const SHADOW_TAG_CLIMAX = "h4-vol-climax";
export const SHADOW_TAG_BIG_PB = "h4-big-before-pullback";
export const SHADOW_TAG_DEAD_PB = "h4-dead-before-pullback";
export const SHADOW_TAG_RSI70 = "rsi-heat-70";
export const SHADOW_TAG_RSI80 = "rsi-heat-80";

/**
 * 4h shadow numbers from a CLOSED-bar 4h kline series (oldest→newest).
 * Uses only bars with closeTime ≤ nowMs — the caller's fetcher already
 * strips the forming bar, but the filter is re-applied defensively so a
 * partially-formed bar can never leak into a tag. Returns null when there
 * is not enough history (needs 21 bars: 20 for the median + the signal bar).
 */
export function h4ShadowFromKlines(
  klines: readonly { openTime: number; closeTime: number; high: number; low: number; close: number; volume: number }[],
  nowMs: number,
): H4Shadow | null {
  const closed = klines.filter((k) => k.closeTime <= nowMs);
  if (closed.length < 21) return null;
  const bar = closed[closed.length - 1]!;
  const prior = closed.slice(closed.length - 21, closed.length - 1);
  const meds = prior.map((k) => k.volume).sort((a, b) => a - b);
  const med = meds[Math.floor(meds.length / 2)]!;
  const range = bar.high - bar.low;
  return {
    barOpenTime: bar.openTime,
    rangePct: bar.close > 0 ? (range / bar.close) * 100 : 0,
    volLog2: med > 0 ? Math.log2(Math.max(bar.volume / med, 1e-9)) : 0,
  };
}

/**
 * Wilder RSI(7) of the 15m close series (the lab's exact estimator), or null
 * when the series is too short. The caller passes CLOSED 15m bars only.
 */
export function rsi7FromCloses(closes: readonly number[]): number | null {
  if (closes.length < 9) return null;
  const s = rsiSeries([...closes], 7);
  for (let i = s.length - 1; i >= 0; i--) {
    const v = s[i];
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Side-aligned extension beyond the slow EMA in ATR units — the lab's
 * `extAtr`. `atrPct` is the same Layer-1 ATR% gauge the engines already feed
 * `computeLayer2Signal` (the lab used computeAtrPct over the same bars; the
 * two agree to within the gauge's noise, which is acceptable for a tag and
 * recorded as data either way).
 */
export function extAtrApprox(
  side: "LONG" | "SHORT",
  lastClose: number,
  emaSlow: number,
  atrPct: number,
): number {
  if (!(emaSlow > 0) || !(lastClose > 0)) return 0;
  const extPct = side === "LONG"
    ? ((lastClose - emaSlow) / emaSlow) * 100
    : ((emaSlow - lastClose) / emaSlow) * 100;
  return extPct / Math.max(atrPct, 0.04);
}

/**
 * QUALITY GATES (2026-09-23, user decision — superseding the paper-only
 * posture of the same day): the four strongest findings from the exhaustion /
 * volume-size labs, ENFORCED on BOTH books (paper + live) and monitored at
 * every journal check via the shadow-tag record. Pure function: returns the
 * block reason for the first gate that fires, or null to allow. Missing
 * readings fail OPEN — a gate with no 4h row or no RSI never blocks.
 *
 * Inputs use the LAB estimators exactly: `extAtr` is candFeatures' extension
 * beyond EMA(21) in ATR units (the lab's pullback test), `rsi7` is Wilder
 * RSI(7) — so the paper book enforces precisely what the labs measured.
 */
export type H4GateCfg = {
  h4VolClimaxBlock: boolean;
  h4PullbackBigBlock: boolean;
  h4PullbackDeadBlock: boolean;
  /** side-aligned RSI(7) ceiling, both sides; 0 = off */
  rsiHeatMax: number;
};

export function h4GateBlocks(input: {
  h4: H4Shadow | null;
  extAtr: number | null;
  rsi7: number | null;
  side: "LONG" | "SHORT";
  cfg: H4GateCfg;
}): string | null {
  const { h4, extAtr, rsi7, side, cfg } = input;
  // 1. 4h volume climax (strongest finding): any entry after a ≥4×-median 4h bar.
  if (cfg.h4VolClimaxBlock && h4 && h4.volLog2 >= H4_VOL_CLIMAX_LOG2) {
    return `4h volume climax gate (bar volume 2^${h4.volLog2.toFixed(1)} of its 20-bar median, ≥ ${2 ** H4_VOL_CLIMAX_LOG2}× = climax)`;
  }
  // 2/3. 4h candle-size before a PULLBACK entry (the bell: 1–4% is healthy).
  const pullback = extAtr != null && extAtr < PULLBACK_EXT_ATR;
  if (h4 && pullback) {
    if (cfg.h4PullbackBigBlock && h4.rangePct >= H4_BIG_PCT) {
      return `4h candle-size gate (last 4h range ${h4.rangePct.toFixed(1)}% ≥ ${H4_BIG_PCT}% before a pullback entry)`;
    }
    if (cfg.h4PullbackDeadBlock && h4.rangePct < H4_DEAD_PCT) {
      return `4h dead-candle gate (last 4h range ${h4.rangePct.toFixed(1)}% < ${H4_DEAD_PCT}% before a pullback entry)`;
    }
  }
  // 4. RSI heat, both sides (the shipped 78 long guard already covers most of
  // the long half; on paper this gate's live margin is the short side).
  const aligned = rsi7 != null ? (side === "LONG" ? rsi7 : 100 - rsi7) : null;
  if (cfg.rsiHeatMax > 0 && aligned != null && aligned >= cfg.rsiHeatMax) {
    return `RSI heat gate (side-aligned RSI(7) ${aligned.toFixed(1)} ≥ ${cfg.rsiHeatMax})`;
  }
  return null;
}

/**
 * Evaluate the shadow tags. All inputs are decision-time-knowable; nothing
 * here blocks or scores. `pullback` should come from `extAtrApprox < PULLBACK_EXT_ATR`
 * for the side being considered.
 */
export function evalShadowTags(input: {
  h4: H4Shadow | null;
  rsi7: number | null;
  pullback: boolean;
}): ShadowTags {
  const tags: string[] = [];
  const { h4, rsi7, pullback } = input;
  if (h4 && h4.volLog2 >= H4_VOL_CLIMAX_LOG2) tags.push(SHADOW_TAG_CLIMAX);
  if (h4 && pullback) {
    if (h4.rangePct >= H4_BIG_PCT) tags.push(SHADOW_TAG_BIG_PB);
    if (h4.rangePct < H4_DEAD_PCT) tags.push(SHADOW_TAG_DEAD_PB);
  }
  if (rsi7 != null && rsi7 >= RSI_HEAT) tags.push(SHADOW_TAG_RSI70);
  if (rsi7 != null && rsi7 >= RSI_HEAT_SEVERE) tags.push(SHADOW_TAG_RSI80);
  return {
    tags,
    h4RangePct: h4 ? h4.rangePct : null,
    h4VolLog2: h4 ? h4.volLog2 : null,
    rsi7,
  };
}
