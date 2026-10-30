/**
 * LTF 5M CONFLUENCE GATE (2026-09-26) — the session's one full-bar survivor.
 *
 * EVIDENCE (run-ltf5m-92d-lab.ts, 92-day audited full-stack window, n=762
 * longs): at the 15m entry signal, reading the last CLOSED 5m bar's position
 * vs its EMA20 splits the book — aligned entries +0.197 R/t (n=477, 45% WR),
 * against entries −0.161 R/t (n=285, 34% WR). Deleting the against cohort:
 * book +0.063 → +0.197 R/t, paired-day t=3.63 (bar 2.20), random-deletion
 * p95 +0.068, SPLIT-HALF t=2.42/2.69 — the only candidate of the 2026-09-26
 * sweeps to clear significance, the random control, and both halves on the
 * full window. Mechanism: a 15m break firing while the minute-scale
 * structure has already rolled over is a fade, not a continuation.
 *
 * CONTRACT: pure + unit-tested; LONG-only (the short
 * book was never tested against this signal — untouched);
 * fails OPEN when the 5m series is missing or too short (a data outage must
 * never become a silent full halt); disabled by a single config flag which
 * the engines resolve with the `!== false` default-ON convention.
 *
 * The engines fetch ~40 CLOSED 5m bars per candidate at gate time (5m is
 * finer than the 15m series in memory, so it cannot be derived; the fetch is
 * small and only candidates reaching the gate pay it). A blocked decision is
 * journaled with the ltf5m-against tag via shadowTags, so the forward record
 * keeps pricing the gate's removed cohort.
 */

/** EMA period of the 5m alignment gauge (the lab's setting). */
export const LTF5M_EMA_PERIOD = 20;
/** Minimum closed 5m closes for a verdict (EMA warm-up + margin); below → fail-open. */
export const LTF5M_MIN_BARS = 25;

export const SHADOW_TAG_LTF5M_AGAINST = "ltf5m-against";
export const SHADOW_TAG_LTF5M_WITH = "ltf5m-with";

export type Ltf5mGateCfg = { ltf5mGateEnabled: boolean };

/**
 * The 5m alignment state: true when the newest closed 5m close is at/above
 * its EMA20. Returns null when the series is too short (fail-open) or any
 * close is non-finite (corrupt data).
 */
export function ltf5mAligned(closes5m: readonly number[]): boolean | null {
  if (closes5m.length < LTF5M_MIN_BARS) return null;
  for (const c of closes5m) {
    if (!Number.isFinite(c) || c <= 0) return null;
  }
  let e = closes5m[0]!;
  const k = 2 / (LTF5M_EMA_PERIOD + 1);
  for (let i = 1; i < closes5m.length; i++) {
    e = closes5m[i]! * k + e * (1 - k);
  }
  return closes5m[closes5m.length - 1]! >= e;
}

/**
 * The gate. Returns the block reason for a LONG whose last closed 5m bar
 * closed BELOW its 5m EMA20, or null to allow. SHORT candidates are never
 * blocked (untested side). Missing/short series fails OPEN.
 */
export function ltf5mGateBlocks(input: {
  closes5m: readonly number[];
  side: "LONG" | "SHORT";
  cfg: Ltf5mGateCfg;
}): string | null {
  const { closes5m, side, cfg } = input;
  if (!cfg.ltf5mGateEnabled || side !== "LONG") return null;
  const aligned = ltf5mAligned(closes5m);
  if (aligned === null) return null; // fail-open
  if (!aligned) {
    return `5m confluence gate (last closed 5m bar closed below its EMA${LTF5M_EMA_PERIOD} — minute-scale structure already rolled over before the 15m break)`;
  }
  return null;
}

/**
 * The shadow tag for the decision record (rides shadowTags on every entry
 * and rejection row). Null series → no tag (fail-open).
 */
export function ltf5mShadowTag(closes5m: readonly number[]): string | null {
  const aligned = ltf5mAligned(closes5m);
  if (aligned === null) return null;
  return aligned ? SHADOW_TAG_LTF5M_WITH : SHADOW_TAG_LTF5M_AGAINST;
}
