/**
 * HTF ADVISOR — 4H divergence + volume-exhaustion veto layer (PURE module).
 *
 * Built 2026-09-08 after the Sep 7-8 drawdown ($398.83 → $255.96): the paper
 * book kept buying strength / shorting weakness right at 4H exhaustion points.
 * The advisor is a second opinion IN FRONT OF the strategy engine's entry:
 * it re-reads the same pair on the higher timeframe (4H — the strategy's own
 * filter TF) and vetoes a side when 4H structure says the move is exhausted.
 *
 * Signal sources (each casts a WEIGHTED vote via advisorSignalWeights —
 * strong tells cast 2, weak cast 0.5, the rest 1; a side is vetoed when
 * votes >= its threshold — advisorLongThreshold / advisorShortThreshold,
 * each falling back to advisorVetoThreshold, default 2 — confluence
 * required on LONG, any single flag on SHORT — fail-open):
 *
 *   DIVERGENCE (price makes a higher high / lower low on 4H while the
 *   indicator disagrees — classic reversal tell; measured on the cached 193d
 *   MEXC 4H history in run-divergence-lab.ts):
 *     - MOMENTUM OSCILLATOR (2026-09-11: STOCHASTIC RSI replaced plain
 *                  RSI(14) at the user's request — see
 *                  run-stochrsi-advisor-lab.ts for the swap measurement).
 *                  Reads StochRSI %D by default (advisorStochRsiUseD); the
 *                  old RSI(14) behavior remains behind the kill switch
 *                  (advisorStochRsiEnabled=false) for A/B.
 *                  Legacy RSI(14) evidence, for reference: RSI 4H bearish div
 *                  at top → 58-88% hit on the pairs it fires on (PEPE 88%
 *                  n=8, SOL 58% n=12, ADA 56% n=9); bullish div at bottom →
 *                  NEAR 83%, ADA 60%, PEPE 60%.
 *     - OBV      : OBV 4H bearish div → PEPE 77% n=13, SOL 60%; bullish →
 *                  ONDO 71% n=14, ADA 64%. Volume-confirmed moves last.
 *     - A/D line : bearish → PEPE 73%, ADA 67%; bullish → GRASS/NEAR/ONDO 63%.
 *     - CMF(20)  : bearish → PEPE 67%, ADA 55%; weakest standalone but the
 *                  best "flattening pressure" confirm with RSI.
 *   EXHAUSTION (no divergence needed — price ran away from value):
 *     - VWAP stretch: close > +advisorVwapExtremePct above 4H VWAP(24) with
 *       the oscillator above advisorRsiExtreme (70) and CMF < 0 (buying into
 *       thin air) → veto LONG; mirrored below VWAP with it under 30 and
 *       CMF > 0 → veto SHORT. The "hot/cold" read uses the same line as the
 *       divergence detector (%D by default) — %K is too jumpy here: on the
 *       exhaustion fixture %K collapses to ~63 while %D holds ~84.
 *     - Thin volume zone: current price sits in a low-volume price bucket
 *       (volume profile over the last 96 bars) near the range's highs/lows —
 *       long/short entries into empty air tend to be unwound fast.
 *
 * Why confluence: the lab shows single-indicator divergence is ~50-60% on
 * most of the tracked universe (no edge), but 70%+ when RSI agrees with a
 * volume line. Threshold 2 = RSI + at least one volume line, or VWAP stretch
 * + thin zone, etc.
 *
 * Why weights (measured on the real Sep 2-8 book replay): bullish divergence
 * at 4H bottoms + thin zones near 4H lows — the SHORT-blocking family — are
 * a pure winner (0 wins on 10 vetoed shorts), worth 2 votes so they veto
 * even alone. RSI/OBV bearish divergence at 4H tops fired at continuation
 * points and blocked real winners, so they weigh 0.5. Thin zones near 4H
 * HIGHS stay at 1 (a tell only with confluence). Replay: weighted nets
 * +$68.44 vs uniform +$55.99 at threshold 2. Config knobs:
 * advisorStrongWeight / advisorWeakWeight.
 *
 * MACD family (2026-09-10): MACD-line divergence (same pivot machinery) plus
 * fresh 4H histogram sign flips, computed with configurable params (default
 * 6/14/10 per the user's proposal; the sweep's best 5/13/8 is within noise).
 * Weighted NORMAL (1) — the integration replay showed +$62.49 marginal
 * (+$34.21 LONG, +$28.28 SHORT) vs $0 at weak and less net at strong.
 *
 * Contracts:
 *   - PURE: no I/O, no Convex imports — shared by the paper engine
 *     (strategyEngine) and later the live engine (liveBroker).
 *   - Closed candles only: pivots use R=2 confirmation, so a divergence is
 *     only "seen" after the pivot bar + 2 right bars have closed.
 *   - Fail-open: insufficient history → neutral (callers allow the entry).
 *     A stale/missing advisor tick in the engine also fails open.
 */

import type { Kline } from "./types";

export interface AdvisorConfig {
  advisorEnabled: boolean;
  advisorVetoThreshold: number;      // SHARED votes needed to veto a side (default 2)
  // Per-side overrides (2026-09-08, replay-validated): the SHORT veto is a
  // pure winner (every flagged short lost, 0% WR) and needs NO confluence,
  // while LONG vetoes need the exhaustion pair (CMF+THIN). advisorShortThreshold
  // = 1 blocks shorts on any single flag; LONG stays at 2. When a side field
  // is unset, the shared advisorVetoThreshold applies to that side.
  advisorLongThreshold: number;
  advisorShortThreshold: number;
  advisorDivergenceAgeBars: number;  // 4H bars a confirmed divergence stays active (4 = 16h, wired 2026-09-12)
  advisorVwapExtremePct: number;     // close vs 4H VWAP stretch that flags exhaustion (default 3)
  advisorRsiExtreme: number;         // RSI level that counts as stretched (default 70)
  // Weighted-vote model (2026-09-08, measured on the Sep 2-8 book replay):
  // each signal casts a WEIGHTED vote, not just 1. STRONG tells cast
  // advisorStrongWeight (2): bullish divergence at 4H bottoms + thin zones
  // near 4H lows — the SHORT-blocking family, a pure winner in the replay
  // (0 wins on 10 vetoed shorts). WEAK tells cast advisorWeakWeight (0.5):
  // RSI/OBV bearish divergence at 4H tops, which fired at continuation
  // points and blocked real winners. Thin zones near 4H HIGHS stay NORMAL
  // (1): they are a tell only WITH confluence (20% WR at 2 votes) and noise
  // alone (38% WR as a single veto). Setting both weights to 1 restores the
  // old uniform model. Replay: weighted nets +$68.44 vs uniform +$55.99.
  advisorStrongWeight: number;       // strong signal vote weight (default 2)
  advisorWeakWeight: number;         // weak signal vote weight (default 0.5)
  // MACD vote family (2026-09-10): MACD-line divergence (pivot-based, same
  // R=2 confirm as the other divergence flags) + fresh histogram sign flips
  // on the 4H filter TF. Lab (run-macd-advisor-lab.ts, layer2 book replay):
  // MACD(6,14,10) at NORMAL weight adds +$62.49 marginal on vetoes the
  // shipped stack missed (10 new LONG vetoes net +$34.21, 16 new SHORT
  // vetoes net +$28.28). Flag buckets: SHORT macd bull-div 0% WR (6t),
  // SHORT hist flip-up 20% WR (20t, +$49.88 saved), LONG hist flip-down
  // 43% WR with +$63.70 PnL when vetoed. At weak (0.5) it never crosses a
  // threshold (SHORT veto needs 1) — dead weight; at strong (2) it adds
  // more collateral for less net (+$53.53). Default: enabled, weight 1.
  // PER-FAMILY KILL SWITCHES (2026-10-23, one panel button per vote family).
  // `undefined` = ON, so every config row written before these knobs existed
  // behaves EXACTLY as it did. A disabled family still computes its flags
  // (the panel and the stored metrics keep showing them) but casts 0 votes and
  // writes no reason string, so it can neither veto alone nor add collateral
  // toward a confluence threshold. These gate the DETECTOR, not the layer: a
  // family switched off here is off on both the 4H and the 1H tick (same
  // module, same row). See advisorFamilyToggles().
  advisorMomDivEnabled?: boolean;    // StochRSI/RSI divergence flags (rsiBear/rsiBull)
  advisorObvEnabled?: boolean;       // OBV divergence flags
  advisorAdEnabled?: boolean;        // A/D-line divergence flags
  advisorCmfEnabled?: boolean;       // CMF divergence flags
  advisorVwapEnabled?: boolean;      // VWAP-stretch exhaustion flags
  advisorThinZoneEnabled?: boolean;  // thin-volume-zone exhaustion flags
  advisorMacdEnabled: boolean;
  advisorMacdWeight: number;         // vote weight per MACD flag (default 1, normal)
  advisorMacdFast: number;           // default 6
  advisorMacdSlow: number;           // default 14
  advisorMacdSignal: number;         // default 10
  // Smart Volume MACD (2026-09-13, user's Pine v6 indicator as a vote
  // family): MACD of the smart net-flow series netFlow = vol·(2·pos−1),
  // pos = (close−low)/(high−low). Flags: MACD-line divergence on the flow
  // series + fresh histogram sign flips (flip-down vetoes LONG, flip-up
  // vetoes SHORT). Sweep lab (run-smartvolmacd-advisor-lab.ts, 96 cells,
  // parity-exact): veto and require modes are IDENTICAL (±0.001R/t) — the
  // layer acts as a slow flow-trend vote. No cell beat the shipped FIXED
  // anchor (+0.020): best FIX +0.018 (9/20/14). LOCK improves +0.017/t
  // (0.008→0.025) and maxDD 66R→55-57R — the vote trims losing legacy-veto
  // trades; it does not time better. DEFAULT OFF (weight 0): an honest,
  // measurable knob, not a promoted edge.
  advisorSmartVolEnabled: boolean;
  advisorSmartVolWeight: number;     // vote weight per smart-vol flag (default 0 = off)
  advisorSmartVolFast: number;       // default 12 (Pine default)
  advisorSmartVolSlow: number;       // default 26
  advisorSmartVolSignal: number;     // default 9
  // RSI Divergence family (2026-09-13, user's Pine "RSI Divergence"):
  // rsiFast − rsiSlow momentum differential on Close. Default 0 = off.
  advisorRsiDivEnabled: boolean;
  advisorRsiDivWeight: number;       // vote weight per rsi-div flag (default 0 = off)
  advisorRsiDivFast: number;         // default 5 (Pine "Length Fast RSI")
  advisorRsiDivSlow: number;         // default 14 (Pine "Length Slow RSI")
  // Source of the differential (2026-09-13): the Pine indicator's selectable
  // source list, ported. Default "close" (the only source measured so far).
  advisorRsiDivSource?: AdvisorRsiDivSource;
  // Stochastic RSI (2026-09-11): replaces the plain RSI(14) as the advisor's
  // momentum oscillator — divergence flags + the VWAP-exhaustion condition
  // now read StochRSI %K. false = legacy RSI(14) path (kill switch / A/B).
  // The divergence WEIGHT classes (rsiBear weak 0.5 / rsiBull strong 2) are
  // unchanged pending the integration replay in run-stochrsi-advisor-lab.ts.
  advisorStochRsiEnabled: boolean;
  advisorStochRsiRsiPeriod: number;  // RSI length feeding the stochastic (default 14)
  advisorStochRsiStochPeriod: number; // lookback for the RSI stochastic (default 14)
  advisorStochRsiKSmooth: number;    // %K SMA smoothing (default 3)
  advisorStochRsiDSmooth: number;    // %D SMA smoothing of %K (default 3)
  // Which line feeds the divergence detector + the VWAP-exhaustion "hot"
  // test. TRUE = %D (the doubly-smoothed line — the faithful analog of the
  // smoothed RSI it replaces: on the exhaustion fixture plain RSI(14) reads
  // 90.5 while %D holds 83.6, but %K has already collapsed to 63). FALSE =
  // %K (faster, jumpier). The sweep lab A/Bs both.
  advisorStochRsiUseD: boolean;
  // Timeframe label used in the veto REASON strings (2026-09-12). This detector
  // is shared by the 4H and the 1H advisor ticks, but every reason string had
  // "4H" hardcoded — so a 1H veto was reported as "4H OBV bearish divergence",
  // making the two layers indistinguishable in the panel and the block message.
  // Unset = "4H" (the original behaviour, so the 4H layer is unchanged).
  advisorTfLabel?: string;
}

/** Per-family on/off switches, resolved to booleans (unset = ON). */
export interface AdvisorFamilyToggles {
  advisorMomDivEnabled?: boolean;
  advisorObvEnabled?: boolean;
  advisorAdEnabled?: boolean;
  advisorCmfEnabled?: boolean;
  advisorVwapEnabled?: boolean;
  advisorThinZoneEnabled?: boolean;
}

/** Resolve the family switches once; unset means ON (pre-2026-10-23 rows). */
export function advisorFamilyToggles(cfg: AdvisorFamilyToggles): {
  mom: boolean; obv: boolean; ad: boolean; cmf: boolean; vwap: boolean; thin: boolean;
} {
  return {
    mom: cfg.advisorMomDivEnabled !== false,
    obv: cfg.advisorObvEnabled !== false,
    ad: cfg.advisorAdEnabled !== false,
    cmf: cfg.advisorCmfEnabled !== false,
    vwap: cfg.advisorVwapEnabled !== false,
    thin: cfg.advisorThinZoneEnabled !== false,
  };
}

/** Per-signal vote weights — the classification table for the weighted model. */
export interface AdvisorSignalWeights {
  rsiBear: number; obvBear: number; adBear: number; cmfBear: number;
  rsiBull: number; obvBull: number; adBull: number; cmfBull: number;
  vwapExhaustLong: number; vwapExhaustShort: number;
  thinZoneLong: number; thinZoneShort: number;
  // MACD family (2026-09-10) — normal weight by default (measured, see
  // AdvisorConfig.advisorMacdWeight for the lab evidence).
  macdBearDiv: number; macdBullDiv: number; histXDown: number; histXUp: number;
  // Smart Vol MACD family (2026-09-13) — off (0) by default; the sweep could
  // not beat the shipped anchor on the live-exit book.
  smartVolXDown: number; smartVolXUp: number;
  // RSI Divergence differential family (2026-09-13) — off (0) by default.
  rsiDivBearDiv: number; rsiDivBullDiv: number; rsiDivXDown: number; rsiDivXUp: number;
}

/**
 * Classify each signal as strong / normal / weak (see AdvisorConfig comment
 * for the replay evidence). STRONG = the SHORT-blocking family — bullish
 * divergences at 4H bottoms + thin zones near 4H lows (every short the
 * advisor flagged lost: 0 wins on 10 vetoed shorts). WEAK = RSI/OBV
 * bearish divergence at 4H tops, which fired at continuation points and
 * blocked real winners (WLD +6.3R, XRP +5.3R). Everything else — A/D & CMF
 * bearish, VWAP stretch, thin zones near 4H HIGHS — stays NORMAL (1): the
 * replay showed thin-zone-near-highs is only a tell WITH confluence (20% WR
 * at 2 votes) and noise alone (38% WR as a single veto).
 */
export function advisorSignalWeights(cfg: Pick<AdvisorConfig, "advisorStrongWeight" | "advisorWeakWeight" | "advisorMacdWeight"> & { advisorSmartVolWeight?: number; advisorRsiDivWeight?: number } & AdvisorFamilyToggles): AdvisorSignalWeights {
  const strong = cfg.advisorStrongWeight;
  const weak = cfg.advisorWeakWeight;
  const macdW = cfg.advisorMacdWeight;
  const svmW = cfg.advisorSmartVolWeight ?? 0;
  const rdW = cfg.advisorRsiDivWeight ?? 0;
  // Per-family kill switches (2026-10-23): a disabled family casts 0, which
  // is the SAME arithmetic as "its flags never fired" — so a switch-off can
  // never leave a stray half-vote or change another family's weight class.
  const fam = advisorFamilyToggles(cfg);
  return {
    // 2026-09-11: rsiBear/rsiBull are now STOCHRSI divergence flags (same
    // weight classes as the old RSI flags — both are momentum-oscillator
    // divergences; re-measured in run-stochrsi-advisor-lab.ts).
    rsiBear: fam.mom ? weak : 0, obvBear: fam.obv ? weak : 0,
    adBear: fam.ad ? 1 : 0, cmfBear: fam.cmf ? 1 : 0,
    rsiBull: fam.mom ? strong : 0, obvBull: fam.obv ? strong : 0,
    adBull: fam.ad ? strong : 0, cmfBull: fam.cmf ? strong : 0,
    vwapExhaustLong: fam.vwap ? 1 : 0, vwapExhaustShort: fam.vwap ? 1 : 0,
    thinZoneLong: fam.thin ? 1 : 0, thinZoneShort: fam.thin ? strong : 0,
    macdBearDiv: macdW, macdBullDiv: macdW, histXDown: macdW, histXUp: macdW,
    smartVolXDown: svmW, smartVolXUp: svmW,
    rsiDivBearDiv: rdW, rsiDivBullDiv: rdW, rsiDivXDown: rdW, rsiDivXUp: rdW,
  };
}

export interface AdvisorSideVerdict {
  status: "veto" | "ok";
  votes: number;
  reasons: string[];
}

export interface AdvisorPairState {
  price: number;            // last CLOSED 4H close
  barTime: number;          // closeTime of the last closed 4H bar
  // 2026-09-11: `rsi` now holds StochRSI %K (0-100) when the stoch path is
  // enabled; `stochD` holds %D. Legacy RSI(14) when the kill switch is off.
  rsi: number;
  stochD: number;
  stochK: number;
  cmf: number;
  vwapDistPct: number;      // (close - vwap) / vwap * 100
  // Divergence flags (confirmed, within age window):
  rsiBear: boolean; rsiBull: boolean;
  obvBear: boolean; obvBull: boolean;
  adBear: boolean; adBull: boolean;
  cmfBear: boolean; cmfBull: boolean;
  // Exhaustion flags:
  vwapExhaustLong: boolean;  // stretched above VWAP + RSI hot + CMF draining
  vwapExhaustShort: boolean; // stretched below VWAP + RSI cold + CMF loading
  thinZoneLong: boolean;     // price in thin volume bucket near recent highs
  thinZoneShort: boolean;    // price in thin volume bucket near recent lows
  // MACD flags (2026-09-10) — divergence (pivot R=2 confirmed) + fresh
  // histogram sign flips within MACD_HIST_FLIP_BARS closed 4H bars.
  macdBearDiv: boolean;
  macdBullDiv: boolean;
  histXDown: boolean;
  histXUp: boolean;
  // Smart Vol MACD flags (2026-09-13): fresh histogram sign flips of the
  // flow-weighted MACD (divergence flags fold into reasons only).
  smartVolXDown: boolean;
  smartVolXUp: boolean;
  rsiDivBearDiv: boolean; rsiDivBullDiv: boolean; rsiDivXDown: boolean; rsiDivXUp: boolean;
  long: AdvisorSideVerdict;
  short: AdvisorSideVerdict;
}

/**
 * Stored-doc shape of one pair's advisor metrics (as persisted in the
 * advisorTicks table — FLAT, see convex/advisor.ts toStored). The strategy
 * engine gates on this shape through advisorVetoFor(); keep the two in sync.
 */
export interface StoredAdvisorMetrics {
  longStatus?: string;
  longVotes?: number;
  longReasons?: string[];
  shortStatus?: string;
  shortVotes?: number;
  shortReasons?: string[];
  // 2026-09-11: `rsi` field carries StochRSI %K when the stoch path is on
  // (field name kept for storage compatibility); stochD/stochK are the two
  // StochRSI lines.
  stochD?: number;
  stochK?: number;
  // Thin-volume-zone flags (2026-09-09): price in a thin-volume bucket near
  // recent 4H highs (thinZoneLong) or lows (thinZoneShort). Stored for the
  // short-flow backtest and the panel readout. The gate itself does not
  // re-read these booleans — it reads longVotes/shortVotes, into which the
  // thin-zone weights are already folded by evaluateAdvisor() (see
  // advisorSignalWeights: long = normal, short = strong). So they DO veto.
  thinZoneLong?: boolean;
  thinZoneShort?: boolean;
  // MACD(6,14,10) flags (2026-09-10) — divergence (pivot R=2 confirmed) and
  // fresh histogram sign flips. Normal-weight votes; see AdvisorConfig.
  macdBearDiv?: boolean;
  macdBullDiv?: boolean;
  histXDown?: boolean;
  histXUp?: boolean;
  // Smart Vol MACD flags (2026-09-13): fresh histogram sign flips of the
  // flow-weighted MACD. Weight 0 by default = family off (no votes).
  smartVolXDown?: boolean;
  smartVolXUp?: boolean;
  rsiDivBearDiv?: boolean; rsiDivBullDiv?: boolean; rsiDivXDown?: boolean; rsiDivXUp?: boolean;
}

/**
 * Read a side's veto verdict from the STORED (flat) advisor metrics. Pure
 * and shape-safe: missing/malformed rows fail open ("ok") so a schema
 * drift can never silently veto entries in the wrong direction.
 *
 * The stored status was computed with the PAPER book's threshold (the
 * advisor tick reads paper's config — one shared doc). Each book's own
 * threshold is applied HERE at gate time: a side is vetoed only when the
 * stored status says "veto" AND the book's advisorVetoThreshold is met by
 * the stored vote count. So paper can enforce 2-vote confluence while live
 * uses 3 from its own config row, without duplicating the advisor doc.
 */
export function advisorVetoFor(
  metrics: StoredAdvisorMetrics | null | undefined,
  side: "LONG" | "SHORT",
  threshold = 2,
): { status: "veto" | "ok"; votes: number; reasons: string[] } {
  if (!metrics) return { status: "ok", votes: 0, reasons: [] };
  const stored = side === "LONG" ? metrics.longStatus : metrics.shortStatus;
  const votes = side === "LONG" ? metrics.longVotes ?? 0 : metrics.shortVotes ?? 0;
  const reasons = side === "LONG" ? metrics.longReasons ?? [] : metrics.shortReasons ?? [];
  const veto = stored === "veto" && votes >= threshold;
  return { status: veto ? "veto" : "ok", votes, reasons };
}

/** Which advisor inputs gate entries (2026-09-09). "pair" = the traded
 *  pair's own 4H verdict (original behavior). "btc" = BTC's 4H verdict
 *  alone (macro/regime layer). "both" = EITHER veto blocks — the
 *  replay-validated combo (backtest: 804t · WR 58.5% · +579.7R vs
 *  per-pair 890t · 52.6% · +484.1R, same 36.3R drawdown).
 */
export type AdvisorMode = "pair" | "btc" | "both";

export function advisorVetoForMode(
  metrics: StoredAdvisorMetrics | null | undefined,
  btcMetrics: StoredAdvisorMetrics | null | undefined,
  side: "LONG" | "SHORT",
  threshold = 2,
  mode: AdvisorMode = "both",
): { status: "veto" | "ok"; votes: number; reasons: string[]; source: "pair" | "btc" | "pair+btc" | null } {
  if (mode === "pair" || mode === "btc") {
    const v = advisorVetoFor(mode === "pair" ? metrics : btcMetrics, side, threshold);
    return { status: v.status, votes: v.votes, reasons: v.reasons, source: v.status === "veto" ? mode : null };
  }
  // "both": either veto blocks. Votes/reasons are merged so the block
  // message shows the full picture (e.g. "3.5v: pair: ...; BTC: ...").
  const pair = advisorVetoFor(metrics, side, threshold);
  const btc = advisorVetoFor(btcMetrics, side, threshold);
  const reasons: string[] = [
    ...(pair.status === "veto" ? pair.reasons.map((r) => `pair: ${r}`) : []),
    ...(btc.status === "veto" ? btc.reasons.map((r) => `BTC: ${r}`) : []),
  ];
  if (reasons.length === 0) {
    return { status: "ok", votes: Math.max(pair.votes, btc.votes), reasons: [], source: null };
  }
  const source: "pair" | "btc" | "pair+btc" =
    pair.status === "veto" && btc.status === "veto" ? "pair+btc" : pair.status === "veto" ? "pair" : "btc";
  return { status: "veto", votes: pair.votes + btc.votes, reasons, source };
}

/**
 * 4H ADVISOR SHADOW TAGS (2026-10-06, record-only — ADVISOR_REPRICE_JOURNAL
 * §3 verdict: DEMOTE TO SHADOW TAG).
 *
 * The 6-month reprice (A1 shipped both/L2/S1 on the 3212t engine book) deleted
 * 1126 trades at +104.0R, turned the kept book negative (R/t 0.026 → −0.010,
 * paired-day t=−0.62, halves −0.89/+0.07, inside random) for a 24% DD cut
 * (below the 30% policy leg). No refined arm cleared either. An enforced veto
 * cannot survive its own promotion test with that record — so the layer stops
 * deciding and starts recording.
 *
 * Returns the side-specific tag when the shipped-arm verdict WOULD have
 * vetoed this candidate, else []. NOTHING reads these to block or score —
 * they are data for `bun run lab:shadowcheck`, which prices every tag in
 * `shadowTags` generically (bar: day-paired kept-vs-deleted t ≥ 2.5, n ≥ 30).
 * Missing/malformed readings fail OPEN (no tag) — a tag with no data never
 * fires. Side-specific on purpose: the decision row carries the side, so one
 * tag per side keeps each deletion cohort thick enough to price.
 */
export const ADV4H_TAG_VETO_LONG = "adv4h-veto-long";
export const ADV4H_TAG_VETO_SHORT = "adv4h-veto-short";

export function advisorShadowTags(input: {
  metrics: StoredAdvisorMetrics | null | undefined;
  btcMetrics: StoredAdvisorMetrics | null | undefined;
  side: "LONG" | "SHORT";
  longThreshold: number;
  shortThreshold: number;
  mode: AdvisorMode;
}): string[] {
  const threshold = input.side === "LONG" ? input.longThreshold : input.shortThreshold;
  const v = advisorVetoForMode(input.metrics, input.btcMetrics, input.side, threshold, input.mode);
  if (v.status !== "veto") return [];
  return [input.side === "LONG" ? ADV4H_TAG_VETO_LONG : ADV4H_TAG_VETO_SHORT];
}

const PIVOT_L = 2;
const PIVOT_R = 2;
const MIN_PIVOT_SEP = 3;
const VWAP_BARS = 24;    // 4 days of 4H bars
const PROFILE_BARS = 96; // 16 days of 4H bars for the volume profile
const PROFILE_BINS = 20;
const MIN_BARS = 120;    // below this, fail open
const MACD_HIST_FLIP_BARS = 3; // histogram flip is "fresh" within N closed bars (lab parity)

/** Default MACD params (the user's proposal; the lab's 5/13/8 is within noise). */
export const ADVISOR_MACD_DEFAULTS = { fast: 6, slow: 14, signal: 10 } as const;

/** Default Smart Vol MACD params — the user's Pine v6 indicator defaults. */
export const ADVISOR_SMARTVOL_DEFAULTS = { fast: 12, slow: 26, signal: 9 } as const;

/** RSI Divergence differential periods (Pine defaults). */
export const ADVISOR_RSIDIV_DEFAULTS = { fast: 5, slow: 14 } as const;

/** RSI Divergence source list (2026-09-13) — the Pine indicator's 13
 * selectable sources. "ema30"/"sma30" use the Pine default MA length 30;
 * "macd" is MACD(12/26/9) line; "vwap" is the advisor's rolling VWAP.
 * Unbounded series (volume/atr/macd) are log- or window-bounded by their
 * builders so pivot math sees a stationary-ish input. */
export const ADVISOR_RSIDIV_SOURCES = [
  "close", "open", "high", "low", "hl2", "hlc3", "ohlc4",
  "ema30", "sma30", "vwap", "macd", "volume", "atr",
] as const;
export type AdvisorRsiDivSource = (typeof ADVISOR_RSIDIV_SOURCES)[number];

/** Default StochRSI params (classic 14/14/3/3) — the sweep's sweet spot is
 *  applied to the book config; these are the module fallbacks. */
export const ADVISOR_STOCHRSI_DEFAULTS = { rsiPeriod: 14, stochPeriod: 14, kSmooth: 3, dSmooth: 3, useD: true } as const;

// ── Indicator series ──

export function rsiSeries(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  out[period] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }
  return out;
}

function smaSeries(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period <= 0) return out;
  for (let i = period - 1; i < values.length; i++) {
    let s = 0, ok = true;
    for (let j = i - period + 1; j <= i; j++) {
      if (!Number.isFinite(values[j])) { ok = false; break; }
      s += values[j];
    }
    if (ok) out[i] = s / period;
  }
  return out;
}

/**
 * Stochastic RSI — momentum of the momentum. RSI first, then a raw
 * stochastic of the RSI over `stochPeriod`, smoothed into %K (SMA kSmooth)
 * and %D (SMA dSmooth of %K). Output 0-100. NaN until fully warmed up.
 */
export function stochRsiSeries(
  closes: number[],
  rsiPeriod: number,
  stochPeriod: number,
  kSmooth: number,
  dSmooth: number,
): { k: number[]; d: number[] } {
  const rsi = rsiSeries(closes, rsiPeriod);
  const raw = new Array(closes.length).fill(NaN);
  for (let i = 0; i < closes.length; i++) {
    if (!Number.isFinite(rsi[i]) || i < stochPeriod - 1) continue;
    let lo = Infinity, hi = -Infinity;
    for (let j = i - stochPeriod + 1; j <= i; j++) {
      if (!Number.isFinite(rsi[j])) { lo = NaN; break; }
      if (rsi[j] < lo) lo = rsi[j];
      if (rsi[j] > hi) hi = rsi[j];
    }
    if (!Number.isFinite(lo)) continue;
    raw[i] = hi > lo ? ((rsi[i] - lo) / (hi - lo)) * 100 : 50;
  }
  const k = smaSeries(raw, kSmooth);
  const d = smaSeries(k, dSmooth);
  return { k, d };
}

function obvSeries(k: Kline[]): number[] {
  const out: number[] = new Array(k.length).fill(0);
  for (let i = 1; i < k.length; i++) {
    const d = k[i].close - k[i - 1].close;
    out[i] = out[i - 1] + (d > 0 ? k[i].volume : d < 0 ? -k[i].volume : 0);
  }
  return out;
}

function adSeries(k: Kline[]): number[] {
  const out: number[] = new Array(k.length).fill(0);
  for (let i = 0; i < k.length; i++) {
    const hl = k[i].high - k[i].low;
    if (hl <= 0) { out[i] = i > 0 ? out[i - 1] : 0; continue; }
    const m = ((k[i].close - k[i].low) - (k[i].high - k[i].close)) / hl;
    out[i] = (i > 0 ? out[i - 1] : 0) + k[i].volume * m;
  }
  return out;
}

function cmfSeries(k: Kline[], period = 20): number[] {
  const out: number[] = new Array(k.length).fill(NaN);
  for (let i = period - 1; i < k.length; i++) {
    let mfv = 0, vol = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const hl = k[j].high - k[j].low;
      const m = hl > 0 ? ((k[j].close - k[j].low) - (k[j].high - k[j].close)) / hl : 0;
      mfv += m * k[j].volume;
      vol += k[j].volume;
    }
    out[i] = vol > 0 ? mfv / vol : 0;
  }
  return out;
}

/** Rolling VWAP over the last `period` bars using typical price. */
/** Wilder ATR (the RSI-Div "atr" source, Pine default length 14). NaN until
 * the first `period` bars seeded; TR[0] = high − low. */
function atrSeries(k: Kline[], period: number): number[] {
  const out: number[] = new Array(k.length).fill(NaN);
  let prevClose = NaN;
  let atr = NaN;
  let sum = 0;
  for (let i = 0; i < k.length; i++) {
    const tr = Number.isFinite(prevClose)
      ? Math.max(k[i].high - k[i].low, Math.abs(k[i].high - prevClose), Math.abs(k[i].low - prevClose))
      : k[i].high - k[i].low;
    if (i < period) {
      sum += tr;
      if (i === period - 1) atr = sum / period;
    } else {
      atr = (atr * (period - 1) + tr) / period;
    }
    out[i] = atr;
    prevClose = k[i].close;
  }
  return out;
}

function vwapSeries(k: Kline[], period: number): number[] {
  const out: number[] = new Array(k.length).fill(NaN);
  let pv = 0, vol = 0;
  for (let i = 0; i < k.length; i++) {
    const tp = (k[i].high + k[i].low + k[i].close) / 3;
    pv += tp * k[i].volume;
    vol += k[i].volume;
    if (i >= period) {
      const old = k[i - period];
      const otp = (old.high + old.low + old.close) / 3;
      pv -= otp * old.volume;
      vol -= old.volume;
    }
    if (i >= period - 1 && vol > 0) out[i] = pv / vol;
  }
  return out;
}

/** EMA series seeded with an SMA of the first `period` closes. */
function emaSeries(values: number[], period: number): number[] {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/**
 * MACD line + histogram (line − signal EMA of the line). The signal EMA is
 * computed over the line's valid (non-NaN) segment so the warm-up matches
 * the lab's macdSeries exactly.
 */
export function macdSeries(
  closes: number[],
  fast: number,
  slow: number,
  signal: number,
): { line: number[]; hist: number[] } {
  const f = emaSeries(closes, fast);
  const s = emaSeries(closes, slow);
  const line = closes.map((_, i) =>
    Number.isFinite(f[i]) && Number.isFinite(s[i]) ? f[i] - s[i] : NaN,
  );
  const firstValid = line.findIndex((v) => Number.isFinite(v));
  const compact = firstValid >= 0 ? line.slice(firstValid) : [];
  const sigCompact = emaSeries(compact, signal);
  const hist = new Array(closes.length).fill(NaN);
  for (let i = 0; i < sigCompact.length; i++) {
    const idx = firstValid + i;
    if (Number.isFinite(sigCompact[i])) hist[idx] = line[idx] - sigCompact[i];
  }
  return { line, hist };
}

// ── Pivots + divergence ──

interface Pivot { idx: number; price: number }

function findPivots(k: Kline[]): { highs: Pivot[]; lows: Pivot[] } {
  const highs: Pivot[] = [], lows: Pivot[] = [];
  for (let i = PIVOT_L; i < k.length - PIVOT_R; i++) {
    let isH = true, isL = true;
    for (let j = i - PIVOT_L; j <= i + PIVOT_R; j++) {
      if (j === i) continue;
      if (k[j].high >= k[i].high) isH = false;
      if (k[j].low <= k[i].low) isL = false;
    }
    if (isH) highs.push({ idx: i, price: k[i].high });
    if (isL) lows.push({ idx: i, price: k[i].low });
  }
  return { highs, lows };
}

/**
 * Return the index of the most recent CONFIRMED divergence (fire bar) of the
 * given kind, or null. Only closed candles: fire = pivot.idx + PIVOT_R.
 * Consecutive same-kind pivots with min separation; the newest one wins.
 */
function lastDivergence(
  pivots: Pivot[],
  series: number[],
  mode: "bearish" | "bullish",
): number | null {
  for (let i = pivots.length - 1; i >= 1; i--) {
    const prior = pivots[i - 1], cur = pivots[i];
    if (cur.idx - prior.idx < MIN_PIVOT_SEP) continue;
    const pv = series[prior.idx], cv = series[cur.idx];
    if (!Number.isFinite(pv) || !Number.isFinite(cv)) continue;
    const priceAgrees = mode === "bearish"
      ? cur.price > prior.price
      : cur.price < prior.price;
    const seriesAgrees = mode === "bearish"
      ? cv < pv
      : cv > pv;
    if (!priceAgrees || !seriesAgrees) continue;
    return cur.idx + PIVOT_R;
  }
  return null;
}

function withinAge(fireIdx: number | null, lastIdx: number, ageBars: number): boolean {
  return fireIdx != null && lastIdx - fireIdx >= 0 && lastIdx - fireIdx <= ageBars;
}

// ── Volume profile thin zone ──

function thinZone(k: Kline[], lastIdx: number): { long: boolean; short: boolean } {
  const win = k.slice(Math.max(0, lastIdx - PROFILE_BARS + 1), lastIdx + 1);
  if (win.length < 40) return { long: false, short: false };
  let lo = Infinity, hi = -Infinity;
  for (const b of win) {
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
  }
  if (!(hi > lo)) return { long: false, short: false };
  const bucket = (p: number) =>
    Math.min(PROFILE_BINS - 1, Math.max(0, Math.floor(((p - lo) / (hi - lo)) * PROFILE_BINS)));
  const volByBucket = new Array(PROFILE_BINS).fill(0);
  let total = 0;
  for (const b of win) {
    const tp = (b.high + b.low + b.close) / 3;
    volByBucket[bucket(tp)] += b.volume;
    total += b.volume;
  }
  if (total <= 0) return { long: false, short: false };
  const close = k[lastIdx].close;
  const cur = bucket(close);
  const share = volByBucket[cur] / total;
  const thin = share < (1 / PROFILE_BINS) * 0.5; // half of a uniform bucket
  const nearHigh = close > lo + 0.75 * (hi - lo);
  const nearLow = close < lo + 0.25 * (hi - lo);
  return { long: thin && nearHigh, short: thin && nearLow };
}

/** The RSI-Div differential's input series by source name (2026-09-13).
 * Shared by evaluateAdvisor and the sweep lab's flag helper so the lab can
 * never drift from the shipped source definitions. */
function rsiDivSourceSeries(k: Kline[], closes: number[], src: AdvisorRsiDivSource): number[] {
  switch (src) {
    case "open": return k.map((x) => x.open);
    case "high": return k.map((x) => x.high);
    case "low": return k.map((x) => x.low);
    case "hl2": return k.map((x) => (x.high + x.low) / 2);
    case "hlc3": return k.map((x) => (x.high + x.low + x.close) / 3);
    case "ohlc4": return k.map((x) => (x.open + x.high + x.low + x.close) / 4);
    case "ema30": return emaSeries(closes, 30);
    case "sma30": return smaSeries(closes, 30);
    case "vwap": return vwapSeries(k, VWAP_BARS);
    case "macd": return macdSeries(closes, 12, 26, 9).line;
    case "volume": return k.map((x) => (x.volume > 0 ? Math.log10(x.volume) : 0));
    case "atr": return atrSeries(k, 14);
    default: return closes;
  }
}

/** RSI-Div differential flags for the LAST bar of a window (2026-09-13),
 * replicating evaluateAdvisor's semantics exactly: the passed array IS the
 * window (same contract as evaluateAdvisor), PIVOT_L/R=2 confirmation,
 * MIN_PIVOT_SEP=3, the same age gate, the same fresh-flip window
 * (MACD_HIST_FLIP_BARS). Exported so the source sweep can compute flags
 * once per pair×4H-bar×source and rebuild every armed advisor arm from the
 * base state + weight×flags — the family enters the vote sums additively,
 * so base votes + weight×flags reproduce the armed advisor bit-for-bit. */
export function rsiDivFlagsAt(
  window: Kline[],
  src: AdvisorRsiDivSource,
  fast: number,
  slow: number,
  ageBars: number,
): { bearDiv: boolean; bullDiv: boolean; xDown: boolean; xUp: boolean } {
  const lastIdx = window.length - 1;
  const closes = window.map((x) => x.close);
  const s = rsiDivSourceSeries(window, closes, src);
  const rsiF = rsiSeries(s, fast);
  const rsiS = rsiSeries(s, slow);
  const diff = rsiF.map((v, i) => v - rsiS[i]);
  const { highs, lows } = findPivots(window);
  const bearFire = lastDivergence(highs, diff, "bearish");
  const bullFire = lastDivergence(lows, diff, "bullish");
  const bearDiv = withinAge(bearFire, lastIdx, ageBars);
  const bullDiv = withinAge(bullFire, lastIdx, ageBars);
  let xDown = false, xUp = false;
  for (let j = Math.max(1, lastIdx - (MACD_HIST_FLIP_BARS - 1)); j <= lastIdx; j++) {
    const a = diff[j - 1], b = diff[j];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    if (a > 0 && b <= 0) xDown = true;
    if (a < 0 && b >= 0) xUp = true;
  }
  return { bearDiv, bullDiv, xDown, xUp };
}

// ── Main evaluation ──

export function evaluateAdvisor(
  klines: Kline[],
  cfg: Pick<
    AdvisorConfig,
    "advisorVetoThreshold" | "advisorDivergenceAgeBars" | "advisorVwapExtremePct" | "advisorRsiExtreme"
  > & Partial<Pick<AdvisorConfig, "advisorStrongWeight" | "advisorWeakWeight" | "advisorLongThreshold" | "advisorShortThreshold" | "advisorMacdEnabled" | "advisorMacdWeight" | "advisorMacdFast" | "advisorMacdSlow" | "advisorMacdSignal" | "advisorSmartVolEnabled" | "advisorSmartVolWeight" | "advisorSmartVolFast" | "advisorSmartVolSlow" | "advisorSmartVolSignal" |    "advisorRsiDivEnabled" | "advisorRsiDivWeight" | "advisorRsiDivFast" | "advisorRsiDivSlow" | "advisorRsiDivSource" | "advisorMomDivEnabled" | "advisorObvEnabled" | "advisorAdEnabled" | "advisorCmfEnabled" | "advisorVwapEnabled" | "advisorThinZoneEnabled" | "advisorStochRsiEnabled" | "advisorStochRsiRsiPeriod" | "advisorStochRsiStochPeriod" | "advisorStochRsiKSmooth" | "advisorStochRsiDSmooth" | "advisorStochRsiUseD" | "advisorTfLabel">>,
): AdvisorPairState | undefined {
  if (!klines || klines.length < MIN_BARS) return undefined;

  const lastIdx = klines.length - 1;
  const closes = klines.map((k) => k.close);
  // Momentum oscillator (2026-09-11): StochRSI %K by default; legacy RSI(14)
  // when the kill switch is off. Both feed the SAME pivot-divergence
  // machinery and the VWAP-exhaustion condition.
  const stochEnabled = cfg.advisorStochRsiEnabled !== false;
  const srRsi = cfg.advisorStochRsiRsiPeriod ?? ADVISOR_STOCHRSI_DEFAULTS.rsiPeriod;
  const srStoch = cfg.advisorStochRsiStochPeriod ?? ADVISOR_STOCHRSI_DEFAULTS.stochPeriod;
  const srK = cfg.advisorStochRsiKSmooth ?? ADVISOR_STOCHRSI_DEFAULTS.kSmooth;
  const srD = cfg.advisorStochRsiDSmooth ?? ADVISOR_STOCHRSI_DEFAULTS.dSmooth;
  const srUseD = cfg.advisorStochRsiUseD !== false;
  const stoch = stochEnabled
    ? stochRsiSeries(closes, srRsi, srStoch, srK, srD)
    : null;
  // The series the divergence detector + exhaustion gate actually read.
  const rsi = stoch ? (srUseD ? stoch.d : stoch.k) : rsiSeries(closes, 14);
  const obv = obvSeries(klines);
  const ad = adSeries(klines);
  const cmf = cmfSeries(klines, 20);
  const vwap = vwapSeries(klines, VWAP_BARS);

  const { highs, lows } = findPivots(klines);
  const age = cfg.advisorDivergenceAgeBars;
  // Timeframe label for the reason strings (2026-09-12): the 1H tick passes
  // "1H" so its vetoes are not reported as 4H. Default keeps "4H".
  const tf = cfg.advisorTfLabel ?? "4H";

  const rsiBearFire = lastDivergence(highs, rsi, "bearish");
  const rsiBullFire = lastDivergence(lows, rsi, "bullish");
  const obvBearFire = lastDivergence(highs, obv, "bearish");
  const obvBullFire = lastDivergence(lows, obv, "bullish");
  const adBearFire = lastDivergence(highs, ad, "bearish");
  const adBullFire = lastDivergence(lows, ad, "bullish");
  const cmfBearFire = lastDivergence(highs, cmf, "bearish");
  const cmfBullFire = lastDivergence(lows, cmf, "bullish");

  const rsiBear = withinAge(rsiBearFire, lastIdx, age);
  const rsiBull = withinAge(rsiBullFire, lastIdx, age);
  const obvBear = withinAge(obvBearFire, lastIdx, age);
  const obvBull = withinAge(obvBullFire, lastIdx, age);
  const adBear = withinAge(adBearFire, lastIdx, age);
  const adBull = withinAge(adBullFire, lastIdx, age);
  const cmfBear = withinAge(cmfBearFire, lastIdx, age);
  const cmfBull = withinAge(cmfBullFire, lastIdx, age);

  // ── MACD family (2026-09-10) ──
  // Divergence on the MACD line with the same pivot rules (R=2, min sep 3),
  // plus a fresh histogram sign flip within the last 3 closed bars. Disabled
  // (or misconfigured) → all-false, zero votes: a config typo must never
  // silently veto entries.
  const macdEnabled =
    cfg.advisorMacdEnabled !== false &&
    (cfg.advisorMacdFast ?? ADVISOR_MACD_DEFAULTS.fast) > 0 &&
    (cfg.advisorMacdSlow ?? ADVISOR_MACD_DEFAULTS.slow) > (cfg.advisorMacdFast ?? ADVISOR_MACD_DEFAULTS.fast) &&
    (cfg.advisorMacdSignal ?? ADVISOR_MACD_DEFAULTS.signal) > 0;
  let macdBearDiv = false, macdBullDiv = false, histXDown = false, histXUp = false;
  const mFast = cfg.advisorMacdFast ?? ADVISOR_MACD_DEFAULTS.fast;
  const mSlow = cfg.advisorMacdSlow ?? ADVISOR_MACD_DEFAULTS.slow;
  const mSig = cfg.advisorMacdSignal ?? ADVISOR_MACD_DEFAULTS.signal;
  if (macdEnabled) {
    const { line: macdLine, hist: macdHist } = macdSeries(closes, mFast, mSlow, mSig);
    const macdBearFire = lastDivergence(highs, macdLine, "bearish");
    const macdBullFire = lastDivergence(lows, macdLine, "bullish");
    macdBearDiv = withinAge(macdBearFire, lastIdx, age);
    macdBullDiv = withinAge(macdBullFire, lastIdx, age);
    for (let i = Math.max(1, lastIdx - MACD_HIST_FLIP_BARS + 1); i <= lastIdx; i++) {
      const a = macdHist[i - 1], b = macdHist[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (a > 0 && b <= 0) histXDown = true;
      if (a < 0 && b >= 0) histXUp = true;
    }
  }

  // ── Smart Volume MACD family (2026-09-13) ──
  // Same pivot-divergence machinery + fresh-flip window as the price-MACD
  // family, but on the smart net-flow series (the user's Pine indicator,
  // ported 1:1). Disabled or misconfigured → all-false, zero votes:
  // fail-safe like the MACD family.
  const svmFastDef = cfg.advisorSmartVolFast ?? ADVISOR_SMARTVOL_DEFAULTS.fast;
  const svmEnabled =
    cfg.advisorSmartVolEnabled === true &&
    (cfg.advisorSmartVolWeight ?? 0) > 0 &&
    svmFastDef > 0 &&
    (cfg.advisorSmartVolSlow ?? ADVISOR_SMARTVOL_DEFAULTS.slow) > svmFastDef &&
    (cfg.advisorSmartVolSignal ?? ADVISOR_SMARTVOL_DEFAULTS.signal) > 0;
  let svmBearDiv = false, svmBullDiv = false, svmXDown = false, svmXUp = false;
  const svmFast = svmFastDef;
  const svmSlow = cfg.advisorSmartVolSlow ?? ADVISOR_SMARTVOL_DEFAULTS.slow;
  const svmSig = cfg.advisorSmartVolSignal ?? ADVISOR_SMARTVOL_DEFAULTS.signal;
  if (svmEnabled) {
    const pos = klines.map((k) => {
      const range = k.high - k.low;
      return range > 0 ? (k.close - k.low) / range : 0.5;
    });
    const netFlow = klines.map((k, i) => (k.volume > 0 ? k.volume : 0) * (2 * pos[i] - 1));
    const { line: svmLine, hist: svmHist } = macdSeries(netFlow, svmFast, svmSlow, svmSig);
    const svmBearFire = lastDivergence(highs, svmLine, "bearish");
    const svmBullFire = lastDivergence(lows, svmLine, "bullish");
    svmBearDiv = withinAge(svmBearFire, lastIdx, age);
    svmBullDiv = withinAge(svmBullFire, lastIdx, age);
    for (let i = Math.max(1, lastIdx - MACD_HIST_FLIP_BARS + 1); i <= lastIdx; i++) {
      const a = svmHist[i - 1], b = svmHist[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (a > 0 && b <= 0) svmXDown = true;
      if (a < 0 && b >= 0) svmXUp = true;
    }
  }

  // ── RSI Divergence differential family (2026-09-13) ──
  // The user's Pine "RSI Divergence": divergence = RSI(fast) − RSI(slow) on
  // Close. Same pivot machinery as the MACD families: line divergence + a
  // fresh zero-cross of the differential. Disabled/misconfigured → all-false.
  const rdFastDef = cfg.advisorRsiDivFast ?? ADVISOR_RSIDIV_DEFAULTS.fast;
  const rdEnabled =
    cfg.advisorRsiDivEnabled === true &&
    (cfg.advisorRsiDivWeight ?? 0) > 0 &&
    rdFastDef > 0 &&
    (cfg.advisorRsiDivSlow ?? ADVISOR_RSIDIV_DEFAULTS.slow) > rdFastDef;
  let rdBearDiv = false, rdBullDiv = false, rdXDown = false, rdXUp = false;
  const rdFast = rdFastDef;
  const rdSlow = cfg.advisorRsiDivSlow ?? ADVISOR_RSIDIV_DEFAULTS.slow;
  if (rdEnabled) {
    // Source selection (2026-09-13): the differential's input series. Built
    // lazily (only when the family is armed) — the dormant default must not
    // pay for 13-series construction. Default "open": the 13-source sweep
    // (run-rsi-div-lab.ts) measured open as the only coherent winner
    // (+0.012 to +0.022 net/t across arms; close WORSE than off). "volume"
    // is log10-bounded so 2021-era volume explosions cannot dominate pivot
    // geometry; "atr" uses Wilder ATR(14) (Pine default length).
    const rdSrcName = cfg.advisorRsiDivSource ?? "open";
    const rdSrc = rsiDivSourceSeries(klines, closes, rdSrcName);
    const rsiF = rsiSeries(rdSrc, rdFast);
    const rsiS = rsiSeries(rdSrc, rdSlow);
    const diff = rsiF.map((v, i) => v - rsiS[i]);
    const rdBearFire = lastDivergence(highs, diff, "bearish");
    const rdBullFire = lastDivergence(lows, diff, "bullish");
    rdBearDiv = withinAge(rdBearFire, lastIdx, age);
    rdBullDiv = withinAge(rdBullFire, lastIdx, age);
    for (let i = Math.max(1, lastIdx - MACD_HIST_FLIP_BARS + 1); i <= lastIdx; i++) {
      const a = diff[i - 1], b = diff[i];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      if (a > 0 && b <= 0) rdXDown = true;
      if (a < 0 && b >= 0) rdXUp = true;
    }
  }

  const rsiVal = rsi[lastIdx];
  const stochDVal = stoch ? stoch.d[lastIdx] : NaN;
  const stochKVal = stoch ? stoch.k[lastIdx] : NaN;
  const oscName = stoch
    ? `StochRSI(${srRsi}/${srStoch}/${srK}/${srD}) %${srUseD ? "D" : "K"}`
    : "RSI(14)";
  const cmfVal = cmf[lastIdx];
  const vwapVal = vwap[lastIdx];
  const price = closes[lastIdx];
  const vwapDistPct = vwapVal > 0 ? ((price - vwapVal) / vwapVal) * 100 : 0;

  // Optional weights default to the shipped weighted model (2 / 0.5) so
  // callers written before the weighted change compile and behave identically.
  const strongWeight = cfg.advisorStrongWeight ?? 2;
  const weakWeight = cfg.advisorWeakWeight ?? 0.5;
  // Per-side thresholds: each side defaults to the shared advisorVetoThreshold
  // unless its own override is set. SHORT = 1 is the replay-validated "any
  // flagged short loses" rule; LONG keeps confluence.
  const longThreshold = cfg.advisorLongThreshold ?? cfg.advisorVetoThreshold;
  const shortThreshold = cfg.advisorShortThreshold ?? cfg.advisorVetoThreshold;

  const ext = cfg.advisorVwapExtremePct;
  const hot = cfg.advisorRsiExtreme;
  const vwapExhaustLong =
    Number.isFinite(rsiVal) && Number.isFinite(cmfVal) && Number.isFinite(vwapVal)
      ? vwapDistPct > ext && rsiVal > hot && cmfVal < 0
      : false;
  const vwapExhaustShort =
    Number.isFinite(rsiVal) && Number.isFinite(cmfVal) && Number.isFinite(vwapVal)
      ? vwapDistPct < -ext && rsiVal < 100 - hot && cmfVal > 0
      : false;

  const thin = thinZone(klines, lastIdx);

  // ── Vote counting (WEIGHTED, 2026-09-08) ──
  // advisorSignalWeights() classifies each flag: strong (thin zones, bullish
  // divergence), normal (A/D/CMF bearish, VWAP stretch), weak (RSI/OBV
  // bearish). Uniform weights (1/1) reproduce the original model.
  const w = advisorSignalWeights({
    advisorStrongWeight: strongWeight,
    advisorWeakWeight: weakWeight,
    advisorMacdWeight: cfg.advisorMacdWeight ?? 1,
    advisorSmartVolWeight: cfg.advisorSmartVolWeight ?? 0,
    advisorRsiDivWeight: cfg.advisorRsiDivWeight ?? 0,
    // Per-family switches (2026-10-23): forwarded explicitly, same rule as the
    // MACD/SmartVol/RSI-Div knobs — an omitted knob here would silently fall
    // back to the module default and a panel toggle would do nothing.
    advisorMomDivEnabled: cfg.advisorMomDivEnabled,
    advisorObvEnabled: cfg.advisorObvEnabled,
    advisorAdEnabled: cfg.advisorAdEnabled,
    advisorCmfEnabled: cfg.advisorCmfEnabled,
    advisorVwapEnabled: cfg.advisorVwapEnabled,
    advisorThinZoneEnabled: cfg.advisorThinZoneEnabled,
  });
  // Reasons follow the SAME switches as the votes: a family that is switched
  // off must not appear in the veto text, otherwise the panel claims a veto
  // source that contributed zero votes.
  const fam = advisorFamilyToggles(cfg);
  const longVotes = (rsiBear ? w.rsiBear : 0) + (obvBear ? w.obvBear : 0) +
    (adBear ? w.adBear : 0) + (cmfBear ? w.cmfBear : 0) +
    (vwapExhaustLong ? w.vwapExhaustLong : 0) + (thin.long ? w.thinZoneLong : 0) +
    (macdBearDiv ? w.macdBearDiv : 0) + (histXDown ? w.histXDown : 0) +
    (svmXDown ? w.smartVolXDown : 0) +
    (rdBearDiv ? w.rsiDivBearDiv : 0) + (rdXDown ? w.rsiDivXDown : 0);
  const shortVotes = (rsiBull ? w.rsiBull : 0) + (obvBull ? w.obvBull : 0) +
    (adBull ? w.adBull : 0) + (cmfBull ? w.cmfBull : 0) +
    (vwapExhaustShort ? w.vwapExhaustShort : 0) + (thin.short ? w.thinZoneShort : 0) +
    (macdBullDiv ? w.macdBullDiv : 0) + (histXUp ? w.histXUp : 0) +
    (svmXUp ? w.smartVolXUp : 0) +
    (rdBullDiv ? w.rsiDivBullDiv : 0) + (rdXUp ? w.rsiDivXUp : 0);

  const longReasons: string[] = [];
  if (fam.mom && rsiBear) longReasons.push(`${tf} ${oscName} bearish divergence (price HH, oscillator LH)`);
  if (fam.obv && obvBear) longReasons.push(`${tf} OBV bearish divergence (price HH, OBV LH)`);
  if (fam.ad && adBear) longReasons.push(`${tf} A/D bearish divergence (price HH, A/D LH)`);
  if (fam.cmf && cmfBear) longReasons.push(`${tf} CMF bearish divergence (price HH, CMF LH)`);
  if (fam.vwap && vwapExhaustLong) longReasons.push(`Stretched ${vwapDistPct.toFixed(1)}% above ${tf} VWAP with ${oscName} ${rsiVal.toFixed(0)} & draining CMF`);
  if (fam.thin && thin.long) longReasons.push(`Price in thin-volume zone near ${tf} highs`);
  if (macdBearDiv) longReasons.push(`${tf} MACD(${mFast}/${mSlow}/${mSig}) bearish divergence (price HH, MACD line LH)`);
  if (histXDown) longReasons.push(`${tf} MACD histogram flipped down within ${MACD_HIST_FLIP_BARS} bars`);
  if (svmBearDiv) longReasons.push(`${tf} SmartVol MACD(${svmFast}/${svmSlow}/${svmSig}) bearish divergence (price HH, flow MACD LH)`);
  if (svmXDown) longReasons.push(`${tf} SmartVol MACD(${svmFast}/${svmSlow}/${svmSig}) histogram flipped down within ${MACD_HIST_FLIP_BARS} bars`);
  if (rdBearDiv) longReasons.push(`${tf} RSI-Div(${rdFast}/${rdSlow}) bearish divergence (price HH, differential LH)`);
  if (rdXDown) longReasons.push(`${tf} RSI-Div(${rdFast}/${rdSlow}) differential flipped down within ${MACD_HIST_FLIP_BARS} bars`);

  const shortReasons: string[] = [];
  if (fam.mom && rsiBull) shortReasons.push(`${tf} ${oscName} bullish divergence (price LL, oscillator HL)`);
  if (fam.obv && obvBull) shortReasons.push(`${tf} OBV bullish divergence (price LL, OBV HL)`);
  if (fam.ad && adBull) shortReasons.push(`${tf} A/D bullish divergence (price LL, A/D HL)`);
  if (fam.cmf && cmfBull) shortReasons.push(`${tf} CMF bullish divergence (price LL, CMF HL)`);
  if (fam.vwap && vwapExhaustShort) shortReasons.push(`Stretched ${Math.abs(vwapDistPct).toFixed(1)}% below ${tf} VWAP with ${oscName} ${rsiVal.toFixed(0)} & loading CMF`);
  if (fam.thin && thin.short) shortReasons.push(`Price in thin-volume zone near ${tf} lows`);
  if (macdBullDiv) shortReasons.push(`${tf} MACD(${mFast}/${mSlow}/${mSig}) bullish divergence (price LL, MACD line HL)`);
  if (histXUp) shortReasons.push(`${tf} MACD histogram flipped up within ${MACD_HIST_FLIP_BARS} bars`);
  if (svmBullDiv) shortReasons.push(`${tf} SmartVol MACD(${svmFast}/${svmSlow}/${svmSig}) bullish divergence (price LL, flow MACD HL)`);
  if (svmXUp) shortReasons.push(`${tf} SmartVol MACD(${svmFast}/${svmSlow}/${svmSig}) histogram flipped up within ${MACD_HIST_FLIP_BARS} bars`);
  if (rdBullDiv) shortReasons.push(`${tf} RSI-Div(${rdFast}/${rdSlow}) bullish divergence (price LL, differential HL)`);
  if (rdXUp) shortReasons.push(`${tf} RSI-Div(${rdFast}/${rdSlow}) differential flipped up within ${MACD_HIST_FLIP_BARS} bars`);

  return {
    price,
    barTime: klines[lastIdx].closeTime,
    rsi: Number.isFinite(rsiVal) ? rsiVal : 0,
    stochD: Number.isFinite(stochDVal) ? stochDVal : 0,
    stochK: Number.isFinite(stochKVal) ? stochKVal : 0,
    cmf: Number.isFinite(cmfVal) ? cmfVal : 0,
    vwapDistPct,
    rsiBear, rsiBull,
    obvBear, obvBull,
    adBear, adBull,
    cmfBear, cmfBull,
    vwapExhaustLong, vwapExhaustShort,
    thinZoneLong: thin.long,
    thinZoneShort: thin.short,
    macdBearDiv, macdBullDiv, histXDown, histXUp,
    smartVolXDown: svmXDown, smartVolXUp: svmXUp,
    rsiDivBearDiv: rdBearDiv, rsiDivBullDiv: rdBullDiv, rsiDivXDown: rdXDown, rsiDivXUp: rdXUp,
    long: {
      status: longVotes >= longThreshold ? "veto" : "ok",
      votes: longVotes,
      reasons: longReasons,
    },
    short: {
      status: shortVotes >= shortThreshold ? "veto" : "ok",
      votes: shortVotes,
      reasons: shortReasons,
    },
  };
}