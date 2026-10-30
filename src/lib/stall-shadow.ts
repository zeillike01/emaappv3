/**
 * STALL SHADOW TAGS (2026-10-06) — record-only forward-test instrumentation.
 *
 * The ledger pricing on the recorded 543-trade book isolated the poison
 * cohort for "continuation that stopped continuing": 15m-momentum LONGs taken
 * while the pair's 1h trends down AND BTC trends up (Rule B), plus the
 * stall-tape leg (signal-bar ATR% < 0.6, both sides — Rule F = the union).
 * Kept-book r/t 0.255 → 0.352, maxDD halved, last-window +16.4R vs −14.15R.
 *
 * That is IN-SAMPLE on one 22-day regime, and the 6-month harness
 * (backtest:stallrule, src/lib/run-stall-rule-backtest.ts) REFUTED both
 * rules as gates (Rule F paired-day t = −0.27 with an OOS sign flip, Rule B
 * t = +0.07) — the 10th refuted entry lever. Per project discipline the
 * conjunction must not arm; per the shadow-tag contract it earns a forward
 * record instead. These tags ARE that record.
 *
 * NOTHING reads them to block or score — they are data, not rules. A tag
 * earns a config gate only when its forward record clears the shadowcheck
 * bar (day-paired kept-vs-deleted t ≥ 2.5 with n ≥ 30 deleted, or beats 95%
 * of matched random deletions — `bun run lab:shadowcheck`, which prices
 * every tag in `shadowTags` generically, so these are picked up with no
 * lab change).
 *
 * SEMANTICS (ledger-identical — the pricing read the STORED enrichment
 * strings, and these tags read the same strings at entry time):
 *   stall-conj    — side is LONG, htfTrend1h == "down", btcTrendAtEntry == "up"
 *   stall-low-atr — atrPctAtEntry < STALL_ATR_FLOOR (both sides, like the ledger)
 * Rule B deletion = rows carrying stall-conj; Rule F deletion = rows
 * carrying either tag. Missing readings fail OPEN (no tag) — a tag with no
 * data never fires.
 *
 * All thresholds are exported constants so the forward test measures exactly
 * what the ledger priced. Pure functions only — no I/O, no Convex imports.
 */

/** Signal-bar ATR% below this = stall tape (the ledger-priced floor). */
export const STALL_ATR_FLOOR = 0.6;

/** Rule B: LONG into a down-1h pair while BTC trends up. */
export const STALL_TAG_CONJ = "stall-conj";
/** Rule F's ATR leg: stall-tape entry, either side. */
export const STALL_TAG_LOW_ATR = "stall-low-atr";

export type StallReadings = {
  side: "LONG" | "SHORT";
  /** buildTradeEnrichment's htfTrend1h ("up" | "down" | "flat" | undefined). */
  htfTrend1h: string | null | undefined;
  /** buildTradeEnrichment's btcTrendAtEntry ("up" | "down" | "chop" | ...). */
  btcTrendAtEntry: string | null | undefined;
  /** buildTradeEnrichment's atrPctAtEntry (15m ATR% at the signal bar). */
  atrPctAtEntry: number | null | undefined;
};

/**
 * The stall shadow tags for one entry. Pure: given the entry's side and its
 * stored enrichment strings, returns the tag(s). Missing/non-finite readings
 * fail OPEN (no tag) — never infer a stall from absent data.
 */
export function stallShadowTags(input: StallReadings): string[] {
  const tags: string[] = [];
  if (
    input.side === "LONG" &&
    input.htfTrend1h === "down" &&
    input.btcTrendAtEntry === "up"
  ) {
    tags.push(STALL_TAG_CONJ);
  }
  if (
    typeof input.atrPctAtEntry === "number" &&
    Number.isFinite(input.atrPctAtEntry) &&
    input.atrPctAtEntry < STALL_ATR_FLOOR
  ) {
    tags.push(STALL_TAG_LOW_ATR);
  }
  return tags;
}
