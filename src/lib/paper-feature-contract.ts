/**
 * PAPER-BOOK FEATURE CONTRACT.
 *
 * The paper bot already records everything needed to score its own entries
 * (data/shadow/trades.json, mirrored in the `paperTrades` Convex table): EMA
 * levels, the score, distance to swing S/R, MFE/MAE, capture ratio, BTC state
 * at entry and BTC move during the trade. This module is the contract for
 * WHICH of those may be used to predict an outcome, because the split is not
 * obvious and getting it wrong is the single most expensive mistake available
 * in this codebase.
 *
 * THE RULE, IN ONE LINE. A feature may be used to predict a trade's result
 * only if its value was knowable at the moment the entry was taken.
 *
 * WHY THIS IS NOT A PEDANTIC POINT. Measured on the 138 closed paper trades:
 *
 *   mfeR              r = +0.703 vs realizedR      <- "the maximum R it takes"
 *   maeR              r = -0.700
 *   mfeCaptureRatio   r = +0.640
 *   timeToMae         r = -0.325
 *   timeToMfe         r = +0.280
 *   btcMoveDuringTrade r = -0.084
 *
 * A model that includes MFE as a predictor correlates 0.70 with the answer. It
 * will produce a spectacular in-sample fit, an A+ tier that looks real, and a
 * live score that is worse than random — because at 09:14:00 nobody knows yet
 * where the trade's high will be. The repo's own arm-score-lab is the cautionary
 * tale on the other side: in-sample PF 1.490 vs 1.199, out-of-sample 1.321 vs
 * 1.326.
 *
 * The genuinely surprising part is the other direction: the CAUSAL features on
 * this dataset are weak. The best is the score itself at r = +0.193, then HTF
 * volume at -0.146, spread at -0.143, ATR at -0.129. Nothing is strong. That is
 * the real finding about these 4.6 days, and no amount of feature engineering
 * will change it at n = 138.
 *
 * MFE, MAE and capture ratio are not worthless — they are the correct inputs
 * for a LABEL (the repo's analytics/03 mistake taxonomy already uses them to
 * separate BAD_ENTRY from REVERSAL from NORMAL_LOSS). Diagnosis and prediction
 * want opposite things from the same columns.
 */

export type PaperTrade = {
  coin?: string; book?: string; variant?: string; type?: "LONG" | "SHORT";
  entryTime?: number; signalTime?: number; exitTime?: number;
  entryPrice?: number; slPrice?: number; tpPrice?: number;
  realizedR?: number; pnlPercent?: number; pnlUsd?: number;
  reason?: string; status?: string; barsHeld?: number;
  // causal
  atrPctAtEntry?: number; bidAskImbalance?: number; btcChange1h?: number;
  btcTrendAtEntry?: string; dayOfWeek?: number; session?: string;
  distToSwingSr?: number; entrySlippageBps?: number; spreadPct?: number;
  htfEma20_4h?: number; htfEma50_4h?: number; htfTrend1h?: string;
  htfVol4h?: number; htfVol4hAvg?: number; longScore?: number; shortScore?: number;
  oiAtEntry?: number; volAtEntry?: number; volPct?: number; fundingRate?: number;
  regime?: string;
  // post-hoc
  mfeR?: number; maeR?: number; mfeCaptureRatio?: number;
  timeToMfe?: number; timeToMae?: number; trailPeakR?: number;
  btcMoveDuringTrade?: number; ethMoveDuringTrade?: number;
  volAtExit?: number; volDelta?: number;
};

/** Knowable at the entry decision. Safe to predict from. */
export const CAUSAL_RAW_FIELDS = [
  "atrPctAtEntry", "bidAskImbalance", "btcChange1h", "dayOfWeek", "distToSwingSr",
  "entrySlippageBps", "spreadPct", "htfEma20_4h", "htfEma50_4h", "htfVol4h",
  "htfVol4hAvg", "longScore", "shortScore", "oiAtEntry", "volAtEntry", "volPct",
  "fundingRate", "type", "btcTrendAtEntry", "session", "htfTrend1h", "regime",
] as const;

/** Only knowable after the trade closed. Diagnostics and LABELS only. */
export const POST_HOC_FIELDS = [
  "mfeR", "maeR", "mfeCaptureRatio", "timeToMfe", "timeToMae", "trailPeakR",
  "barsHeld", "btcMoveDuringTrade", "ethMoveDuringTrade", "volAtExit", "volDelta",
  "exitTime", "exitPrice", "reason", "realizedR", "pnlPercent", "pnlUsd",
] as const;

export type PostHocField = (typeof POST_HOC_FIELDS)[number];

/**
 * The derived, entry-time feature vector. Every entry here is a function of
 * CAUSAL_RAW_FIELDS plus the entry price — nothing from POST_HOC_FIELDS can
 * reach it, which is the point of building it as an explicit function rather
 * than spreading the raw record.
 */
export type PaperCausalFeatures = Record<string, number>;

function n(x: number | undefined): number | null {
  return typeof x === "number" && Number.isFinite(x) ? x : null;
}

/** Causal features, or null if a required input is missing. */
export function paperCausalFeatures(t: PaperTrade): PaperCausalFeatures | null {
  const entry = n(t.entryPrice);
  if (entry == null || entry <= 0) return null;
  const isLong = t.type === "LONG";
  const out: PaperCausalFeatures = {};

  // The score, signed to the trade's side: a LONG and a SHORT with the same
  // raw score are opposite signals, and leaving them unsigned hands the model a
  // feature that means different things on the two sides of the book.
  const own = isLong ? n(t.longScore) : n(t.shortScore);
  if (own != null) out.sideScore = own;
  const opp = isLong ? n(t.shortScore) : n(t.longScore);
  if (own != null && opp != null) out.scoreEdge = own - opp;

  // Distance to the entry EMAs. The paper log stores the EMA LEVELS, not the
  // distance, so this is where "distance to the entry EMA" has to be computed.
  const e20 = n(t.htfEma20_4h);
  const e50 = n(t.htfEma50_4h);
  if (e20 != null) out.distToHtfEma20Pct = ((entry - e20) / e20) * 100;
  if (e50 != null) out.distToHtfEma50Pct = ((entry - e50) / e50) * 100;
  // HTF trend STRENGTH: a 20/50 spread of 0.1% and one of 5% are both "20 above
  // 50" but only one of them is a trend.
  if (e20 != null && e50 != null && e50 !== 0) out.htfEmaSpreadPct = ((e20 - e50) / e50) * 100;

  const hv = n(t.htfVol4h);
  const hva = n(t.htfVol4hAvg);
  if (hv != null && hva != null && hva > 0) out.htfVolRatio = hv / hva;

  // BTC behaviour AT ENTRY. This is the only BTC state a live score may use;
  // btcMoveDuringTrade is post-hoc and lives in POST_HOC_FIELDS.
  const btc1h = n(t.btcChange1h);
  if (btc1h != null) out.btcChange1h = btc1h;
  if (t.btcTrendAtEntry) {
    out.btcTrendBull = t.btcTrendAtEntry === "up" ? 1 : 0;
    out.btcTrendBear = t.btcTrendAtEntry === "down" ? 1 : 0;
  }
  if (t.htfTrend1h) {
    out.htfTrend1hUp = t.htfTrend1h === "up" ? 1 : 0;
    out.htfTrend1hDown = t.htfTrend1h === "down" ? 1 : 0;
  }

  for (const [field, key] of [
    ["atrPctAtEntry", "atrPctAtEntry"], ["bidAskImbalance", "bidAskImbalance"],
    ["distToSwingSr", "distToSwingSr"], ["entrySlippageBps", "entrySlippageBps"],
    ["spreadPct", "spreadPct"], ["oiAtEntry", "oiAtEntry"], ["volAtEntry", "volAtEntry"],
    ["volPct", "volPct"], ["fundingRate", "fundingRate"], ["dayOfWeek", "dayOfWeek"],
  ] as const) {
    const v = n(t[field] as number | undefined);
    if (v != null) out[key] = v;
  }
  if (t.session) {
    out.sessionAsia = t.session === "asia" ? 1 : 0;
    out.sessionEurope = t.session === "europe" ? 1 : 0;
    out.sessionUs = t.session === "us" ? 1 : 0;
  }
  if (n(t.slPrice) != null) out.stopDistancePct = ((entry - n(t.slPrice)!) / entry) * 100 * (isLong ? 1 : -1);
  return Object.keys(out).length > 0 ? out : null;
}

export const DERIVED_CAUSAL_FEATURES = [
  "sideScore", "scoreEdge", "distToHtfEma20Pct", "distToHtfEma50Pct",
  "htfEmaSpreadPct", "htfVolRatio", "btcChange1h", "btcTrendBull", "btcTrendBear",
  "htfTrend1hUp", "htfTrend1hDown", "atrPctAtEntry", "bidAskImbalance",
  "distToSwingSr", "entrySlippageBps", "spreadPct", "oiAtEntry", "volAtEntry",
  "volPct", "fundingRate", "dayOfWeek", "sessionAsia", "sessionEurope",
  "sessionUs", "stopDistancePct",
] as const;

const POST_HOC_SET: ReadonlySet<string> = new Set(POST_HOC_FIELDS);

/**
 * Throws if a post-hoc field is ever asked to serve as a predictor. This is the
 * enforcement, not a convention: the feature list is a plain array and nothing
 * stops a caller from adding "mfeR" to it otherwise.
 */
export function assertCausalFeatureList(names: readonly string[]): void {
  const bad = names.filter((x) => POST_HOC_SET.has(x));
  if (bad.length) {
    throw new Error(
      `post-hoc fields cannot be predictors: ${bad.join(", ")}. ` +
        `They are knowable only after the trade closes (mfeR alone correlates ~0.70 with realizedR). ` +
        `Use them as labels via the mistake taxonomy instead.`,
    );
  }
}
