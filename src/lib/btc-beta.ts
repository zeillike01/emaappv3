/**
 * BTC-BETA EXPOSURE (2026-09-23) — PURE module.
 *
 * The book's position cap counts POSITIONS; the risk it is trying to bound is
 * CORRELATED EXPOSURE TO A SINGLE FACTOR. A count cap cannot tell two facts
 * apart:
 *
 *   - 8 open alt longs that each move ~0.6 BTC-betas, versus
 *   - 8 open alt longs that each move ~1.8 BTC-betas.
 *
 * Measured on this project's own record, the count cap is not merely a weak
 * bound — it is a WORSE-THAN-RANDOM one: capping positions cut the paper
 * book's max drawdown 21.7% against a volume-matched random block's 27.9%
 * median, i.e. it removed less risk than deleting the same number of trades at
 * random. That is the signature of bounding the wrong quantity. The damage
 * event was not "too many positions" but one correlated cluster: 16 alts
 * stopped out together while 18 more entries opened into it.
 *
 * This module bounds the quantity that actually hurt: the SIGNED sum of
 * per-position BTC-beta. Longs add, shorts subtract, so a hedged book can
 * carry more positions than a one-sided one at the same exposure — exactly
 * the distinction a count cap cannot make.
 *
 * MEASURED 2026-09-23 — AND IT IS OFF. `run-beta-cap-lab.ts` replayed the
 * recorded stream at caps 3…29 on both books against a volume-matched random
 * block. The cap NEVER beat the control's p90 (paper: best DD cut 56.6% vs
 * control p90 71.0%; live: 29.4% vs 42.8%) and netR/DD worsened at every cap
 * on both. The reason is structural: median beta is 1.56 and the book is ~91%
 * one-sided, so |net| ≈ 1.56 × position count — the seed knob is close to a
 * monotone transform of the count cap, which had already failed the same
 * control. The hedge-aware mechanism this module exists for cannot fire on a
 * one-sided book (not one SHORT was blocked at any cap on live). Crowding also
 * carries the WRONG sign for a gate: ρ(|net|, R) = +0.123 paper / +0.124 live,
 * i.e. exposure proxies a broad trend, which is where the book's edge is. So
 * `maxNetBtcBeta` stays 0. Revisit only for a two-sided book — see
 * BETA_CAP_JOURNAL.md for the full record, including what would change the
 * answer.
 *
 * Beta is estimated by OLS regression of the pair's returns on BTC's returns
 * over the same closed 15m bars (cov(rp, rb) / var(rb)), aligned on bar
 * openTime. It is an estimate, not a promise: it is clamped to a sane band and
 * falls back to a neutral 1.0 whenever the window is too short to fit, which
 * makes a broken estimator FAIL SAFE (a missing beta counts as a full unit of
 * exposure) instead of failing open (counting as zero and disabling the cap).
 *
 * No I/O, no Convex — so both engines and the labs can use it.
 */

/** Lookback for the beta regression: 96 closed 15m bars = 24h. */
export const BTC_BETA_LOOKBACK_BARS = 96;

/**
 * Exposure charged to a position whose beta could not be estimated. 1.0 is the
 * conservative choice: an unknown pair is treated as a full unit of BTC-beta
 * rather than as zero (which would silently exempt it from the cap).
 */
export const BTC_BETA_FALLBACK = 1;

/** Fitted betas are clamped to this band so one degenerate window cannot
 *  produce a 12x exposure that would freeze the whole book. */
export const BTC_BETA_MIN = 0.2;
export const BTC_BETA_MAX = 3;

export interface BetaBar {
  openTime: number;
  close: number;
}

/**
 * OLS beta of the pair's 15m returns against BTC's 15m returns.
 *
 * Bars are aligned on `openTime` — only timestamps present in BOTH series are
 * used — so a gappy fetch degrades the sample size instead of silently
 * comparing different clocks. Returns BTC_BETA_FALLBACK when fewer than two
 * aligned returns exist or BTC's variance is zero.
 */
export function estimateBtcBeta(
  pairBars: readonly BetaBar[],
  btcBars: readonly BetaBar[],
  lookback: number = BTC_BETA_LOOKBACK_BARS,
): number {
  if (!pairBars?.length || !btcBars?.length) return BTC_BETA_FALLBACK;
  const btcByOpen = new Map<number, number>();
  for (const b of btcBars) {
    if (b && typeof b.openTime === "number" && b.close > 0) btcByOpen.set(b.openTime, b.close);
  }
  // Walk the pair series and keep only bars that have a BTC counterpart.
  const pairs: { p: number; b: number }[] = [];
  for (const bar of pairBars) {
    if (!bar || typeof bar.openTime !== "number" || !(bar.close > 0)) continue;
    const btcClose = btcByOpen.get(bar.openTime);
    if (btcClose == null || !(btcClose > 0)) continue;
    pairs.push({ p: bar.close, b: btcClose });
  }
  const n = Math.min(pairs.length, Math.max(2, Math.floor(lookback) + 1));
  if (n < 2) return BTC_BETA_FALLBACK;
  const window = pairs.slice(pairs.length - n);

  const rp: number[] = [];
  const rb: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prevP = window[i - 1].p;
    const prevB = window[i - 1].b;
    if (!(prevP > 0) || !(prevB > 0)) continue;
    rp.push((window[i].p - prevP) / prevP);
    rb.push((window[i].b - prevB) / prevB);
  }
  if (rp.length < 2) return BTC_BETA_FALLBACK;

  const mp = rp.reduce((a, b) => a + b, 0) / rp.length;
  const mb = rb.reduce((a, b) => a + b, 0) / rb.length;
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < rp.length; i++) {
    cov += (rp[i] - mp) * (rb[i] - mb);
    varB += (rb[i] - mb) * (rb[i] - mb);
  }
  if (!(varB > 0)) return BTC_BETA_FALLBACK;
  const beta = cov / varB;
  if (!Number.isFinite(beta)) return BTC_BETA_FALLBACK;
  return Math.min(BTC_BETA_MAX, Math.max(BTC_BETA_MIN, beta));
}

/** A position contributes +beta when long, −beta when short. */
export function signedBeta(side: string, beta: number | null | undefined): number {
  const b = typeof beta === "number" && Number.isFinite(beta) ? beta : BTC_BETA_FALLBACK;
  return side === "SHORT" ? -b : b;
}

/** Signed net BTC-beta carried by a set of open positions. */
export function netBtcBeta(
  positions: readonly { side: string; beta?: number | null }[],
): number {
  let net = 0;
  for (const p of positions) net += signedBeta(p.side, p.beta);
  return net;
}

/**
 * Would admitting `{ side, beta }` push the book's |net BTC-beta| past `cap`?
 * `cap <= 0` disables the check entirely (the shipped default) so the rule can
 * only ever act when a threshold is explicitly set.
 */
export function betaCapBlocks(opts: {
  net: number;
  side: string;
  beta: number;
  cap: number;
}): boolean {
  if (!(opts.cap > 0)) return false;
  const next = opts.net + signedBeta(opts.side, opts.beta);
  if (Math.abs(next) <= opts.cap + 1e-9) return false;
  // Past the cap — but a candidate that REDUCES existing |net| exposure is a
  // de-risking trade. Refusing it would forbid hedging the very cluster this
  // bounds, so a trade that never increases |net| is always admitted.
  return Math.abs(next) >= Math.abs(opts.net) - 1e-9;
}
