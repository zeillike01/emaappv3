/**
 * LIVE MATH — pure order-sizing + exit-estimate helpers (NO imports, NO I/O).
 *
 * These are the exact arithmetic the real-money engine in convex/liveBroker.ts
 * runs, extracted into a dependency-free module so it can be unit-tested
 * without a node runtime or a MEXC connection. Sizing rules mirror the paper
 * Layer 2 engine: fixed-fractional risking — risk RISK_PCT of live USDT
 * equity at the SL distance — sized in MEXC contracts.
 *
 * Values in this module are deliberately PARITY-PINNED by unit tests: a
 * change here changes what the live bot sends to the exchange, so each rule
 * has a test in src/lib/live-math.test.ts.
 */

// Estimated taker fee per side (0.06% from the MEXC contract detail). Only
// used for ledger estimates — the exchange is the source of truth for money.
export const LIVE_TAKER_FEE = 0.0006;
// SL market closes get adverse slippage in the recorded estimate, matching
// the paper engine's EXIT_SLIP_BPS convention (3 bps).
export const LIVE_EXIT_SLIP_BPS = 3;
// Sizing guard: never let one entry's isolated margin exceed 90% of equity.
const MAX_MARGIN_FRACTION_OF_BALANCE = 0.9;

// ── LIQUIDATION-DISTANCE GUARD (2026-09-11 red-team audit fix) ──────────────
// The dangerous failure mode on a leveraged perp is not the stop — it is
// LIQUIDATION firing BEFORE the stop. For isolated margin the liquidation
// distance is approximately (100 / leverage) − maintenanceMarginPct, so a
// 1.5% stop at 60x leaves roughly 1.67% − maintenance ≈ 1.0-1.2% — i.e. the
// position is liquidated before the stop can ever fill, and you lose the
// whole margin instead of 1R. Fees and slippage make it worse.
//
// We therefore cap the leverage of any single order so the liquidation
// distance clears the stop PLUS round-trip costs PLUS a slippage buffer.
// Assumed maintenance margin is deliberately conservative (alts, small
// positions): the real tier varies by symbol and notional.
export const LIVE_ASSUMED_MAINTENANCE_PCT = 1.0;
// Extra room beyond the stop for fees + entry/exit slippage on the liquidation side.
export const LIVE_LIQ_SAFETY_BUFFER_PCT =
  2 * LIVE_TAKER_FEE * 100 + LIVE_EXIT_SLIP_BPS / 100 + 0.3;

/**
 * Highest leverage whose isolated liquidation distance still clears the stop
 * plus costs and a safety buffer. `stopLossPct` is in PERCENT (1.5 = 1.5%).
 * Returns at least 1.
 */
export function maxSafeLeverage(stopLossPct: number): number {
  const stop = Math.max(stopLossPct, 0.05);
  const denom = stop + LIVE_LIQ_SAFETY_BUFFER_PCT + LIVE_ASSUMED_MAINTENANCE_PCT;
  return Math.max(1, Math.floor(100 / denom));
}

/**
 * Isolated liquidation distance as a percent of price for a given leverage,
 * net of maintenance margin. Used by the tests and the entry guard.
 */
export function liquidationDistancePct(leverage: number): number {
  if (leverage <= 0) return 0;
  return 100 / leverage - LIVE_ASSUMED_MAINTENANCE_PCT;
}

/** Floor a volume to `scale` decimal places (never rounds up → never oversizes). */
export function roundVol(vol: number, scale: number): number {
  const f = Math.pow(10, Math.max(0, Math.floor(scale)));
  return Math.floor(vol * f) / f;
}

export interface OrderSizeInput {
  side: "LONG" | "SHORT";
  entryPrice: number; // ticker price at signal
  riskUsd: number; // equity × (riskPct / 100)
  stopLossPct: number; // PERCENT, e.g. 1.5 = 1.5% stop distance
  takeProfitPct: number; // PERCENT, e.g. 2.0 = 2.0% target distance
  // Per-side SHORT TP override (2026-09-09): when set, SHORT uses this
  // target instead of takeProfitPct (e.g. 2.25 = 1.5R). null/undefined =
  // shorts keep the shared takeProfitPct. LONG always uses takeProfitPct.
  shortTakeProfitPct?: number | null;
  leverage: number;
  balanceUsd: number; // live equity (for the margin guard)
  contractSize: number; // USDT value per contract (contract/detail)
  volScale: number; // decimal places allowed on order volume
  minVol: number;
  maxVol: number;
}

export type OrderSizeResult =
  | {
      ok: true;
      slPrice: number;
      tpPrice: number;
      vol: number; // contracts to submit
      notionalUsd: number;
      marginUsd: number;
    }
  | { ok: false; reason: string };

/**
 * Compute SL/TP prices + the isolated-margin contract size for one entry.
 * Pure mirror of the old inline math in liveBroker.processPairLive — a change
 * here must keep the paper engine's sizing semantics identical.
 */
export function computeOrderSize(input: OrderSizeInput): OrderSizeResult {
  // ── CONFIG VALIDATION (2026-09-24 live stop audit) ─────────────────────────
  // A zero/negative stop or target distance used to reach the sizing math and
  // fail only BY ACCIDENT — a 0% stop divides notional by zero and limps out
  // through the volume range check with a confusing "Infinity contracts"
  // message, and a non-positive target lands the TP at or THROUGH entry, where
  // every exit check reads it as an instant "Take Profit". Garbage stop/TP
  // config is refused with the reason named instead of limping through.
  const tpPctRaw =
    input.side === "SHORT" && input.shortTakeProfitPct != null
      ? input.shortTakeProfitPct
      : input.takeProfitPct;
  if (!(Number.isFinite(input.stopLossPct) && input.stopLossPct > 0)) {
    return {
      ok: false,
      reason: `invalid stopLossPct ${input.stopLossPct} — must be a positive percent (a non-positive stop has no loss side)`,
    };
  }
  if (!(Number.isFinite(tpPctRaw) && tpPctRaw > 0)) {
    return {
      ok: false,
      reason: `invalid take-profit ${tpPctRaw}% — must be a positive percent (a non-positive target sits at/through entry and would trigger instantly)`,
    };
  }
  if (!(Number.isFinite(input.entryPrice) && input.entryPrice > 0)) {
    return { ok: false, reason: `invalid entryPrice ${input.entryPrice}` };
  }
  const slPct = input.stopLossPct / 100;
  const tpPct = tpPctRaw / 100;
  const slPrice =
    input.side === "LONG" ? input.entryPrice * (1 - slPct) : input.entryPrice * (1 + slPct);
  const tpPrice =
    input.side === "LONG" ? input.entryPrice * (1 + tpPct) : input.entryPrice * (1 - tpPct);

  // Liquidation guard: refuse any order whose liquidation would trigger
  // before its own stop (defense in depth — the caller also clamps leverage).
  const safeLev = maxSafeLeverage(input.stopLossPct);
  if (input.leverage > safeLev) {
    return {
      ok: false,
      reason: `leverage ${input.leverage}x > safe max ${safeLev}x for a ${input.stopLossPct}% stop (liquidation would precede the stop)`,
    };
  }

  const notionalUsd = input.riskUsd / slPct; // risk ÷ SL distance → full notional
  const volRaw = notionalUsd / input.entryPrice / input.contractSize;
  const vol = roundVol(volRaw, input.volScale);
  if (vol < input.minVol || vol > input.maxVol) {
    return {
      ok: false,
      reason: `computed ${vol} contracts outside [${input.minVol}, ${input.maxVol}]`,
    };
  }
  const marginUsd = notionalUsd / input.leverage;
  if (marginUsd > input.balanceUsd * MAX_MARGIN_FRACTION_OF_BALANCE) {
    return {
      ok: false,
      reason: `margin ${marginUsd.toFixed(2)} USDT > ${MAX_MARGIN_FRACTION_OF_BALANCE * 100}% of balance`,
    };
  }
  return { ok: true, slPrice, tpPrice, vol, notionalUsd, marginUsd };
}

// ── POSITION MATCHING (2026-09-24 live stop audit) ───────────────────────────
// fetchOpenPositions keys every exchange position row as `${symbol}_${side}`
// plus a `${symbol}_0` ambiguous-side fallback. A consumer acting on ONE trade
// must pick the row for THAT trade's side: findNewPosition used to take the
// first map key whose string merely STARTED WITH the symbol, so (a) the `_0`
// shadow or the OPPOSITE side's row of a hedge-mode account could win the
// match and receive another trade's TP/SL bracket, and (b) any symbol sharing
// a string prefix matched too. Exact keys, own side first, ambiguous-side
// fallback only — pure so the rule is unit-testable without an exchange.
/**
 * Resolve the exchange position row for ONE trade's side. Exact `${sym}_${side}`
 * key first; the `${sym}_0` ambiguous-side fallback is taken only when the
 * symbol has no side-keyed row at all, so a hedge-mode opposite side can never
 * be mistaken for the wanted one.
 */
export function matchPositionEntry<T>(
  entries: Iterable<readonly [string, T]>,
  sym: string,
  sideNum: 1 | 2,
): T | null {
  let ambiguous: T | null = null;
  let sideKeyedSeen = false;
  for (const [key, val] of entries) {
    if (key === `${sym}_${sideNum}`) return val;
    if (key === `${sym}_1` || key === `${sym}_2`) sideKeyedSeen = true;
    if (key === `${sym}_0` && ambiguous == null) ambiguous = val;
  }
  // The `_0` fallback is trusted ONLY when the symbol has no side-keyed row at
  // all — i.e. the exchange genuinely reported an ambiguous side. When a
  // side-keyed row exists (hedge mode), a leftover `_0` shadow belongs to
  // whichever row wrote it last and must never stand in for the wanted side.
  return sideKeyedSeen ? null : ambiguous;
}

export type ExitTrigger = "Stop Loss" | "Take Profit";

/**
 * The price the ledger assumes for a close. TP fills at the target (limit,
 * no slippage); SL fills adversarially past the level by LIVE_EXIT_SLIP_BPS.
 */
export function expectedExitPrice(opts: {
  trigger: ExitTrigger;
  side: "LONG" | "SHORT";
  slPrice: number;
  tpPrice: number;
}): number {
  if (opts.trigger === "Take Profit") return opts.tpPrice;
  const slip = LIVE_EXIT_SLIP_BPS / 10_000;
  return opts.side === "LONG" ? opts.slPrice * (1 - slip) : opts.slPrice * (1 + slip);
}

/**
 * Conservative estimate for a market close at a sampled ticker price. R-lock
 * and manual closes are market orders, so booking the raw sample overstates
 * realized PnL. The exchange fill remains authoritative; this only prevents the
 * live ledger from claiming an impossible zero-slippage fill.
 */
export function expectedMarketExitPrice(opts: {
  side: "LONG" | "SHORT";
  price: number;
  slipBps?: number;
}): number {
  const slip = (opts.slipBps ?? LIVE_EXIT_SLIP_BPS) / 10_000;
  return opts.side === "LONG" ? opts.price * (1 - slip) : opts.price * (1 + slip);
}

export interface ExitEstimateInput {
  notionalUsd: number; // effective notional actually closed (scaled for partial closes)
  entryPrice: number;
  exitPrice: number;
  side: "LONG" | "SHORT";
  slPrice: number;
  takerFee?: number; // per side, default LIVE_TAKER_FEE (estimate charges it on both sides)
}

export interface ExitEstimate {
  gross: number; // signed, before fees
  fees: number;
  pnlUsd: number;
  realizedR: number; // signed R multiple — negative on losses on BOTH sides
}

/**
 * Ledger-only estimate of a close's PnL/fees/R. The exchange remains the
 * source of truth for money; this only drives the UI + analytics.
 *
 * realizedR is SIGNED (move ÷ risk, matching the paper engine): a losing long
 * and a losing short both report negative R. The pre-extraction inline math
 * used Math.abs(|move|) × dir, which flipped the sign on long losses and
 * short wins — pinned by tests below so it can't regress.
 */
export function estimateExit(input: ExitEstimateInput): ExitEstimate {
  const dir = input.side === "LONG" ? 1 : -1;
  const gross = input.notionalUsd * ((input.exitPrice - input.entryPrice) / input.entryPrice) * dir;
  const fees = input.notionalUsd * (input.takerFee ?? LIVE_TAKER_FEE) * 2;
  const pnlUsd = gross - fees;
  const risk = Math.abs(input.entryPrice - input.slPrice);
  const move = (input.exitPrice - input.entryPrice) * dir; // signed price move
  const realizedR = risk > 0 ? move / risk : 0;
  return { gross, fees, pnlUsd, realizedR };
}

// ── DEAL-SIDE CODES (MEXC contract_v1) ──────────────────────────────────────
// order_deals returns `side`: 1 open long / 2 close short / 3 open short /
// 4 close long. A round trip therefore has BOTH legs in the deal history, and
// the fee reconciliation has to read both — it used to filter to the close leg
// only and so recorded roughly half the fees actually paid (measured on the
// live ledger: reconciled rows carried a close-leg-only ratio of 0.433 while
// estimate-priced rows were exact at 1.000, a ~26% under-count of the total
// fee bill).
export const LIVE_DEAL_SIDE = {
  openLong: 1,
  closeShort: 2,
  openShort: 3,
  closeLong: 4,
} as const;

/** The {open, close} deal-side codes for a position side. */
export function dealSidesFor(side: "LONG" | "SHORT"): { open: number; close: number } {
  return side === "LONG"
    ? { open: LIVE_DEAL_SIDE.openLong, close: LIVE_DEAL_SIDE.closeLong }
    : { open: LIVE_DEAL_SIDE.openShort, close: LIVE_DEAL_SIDE.closeShort };
}

/**
 * Select the exchange fills that belong to ONE ledger trade, oldest first.
 *
 * The private deal endpoint is scoped by symbol + time, not by order id. A
 * same-pair trade that closed moments before this one can therefore appear in
 * the response. The reconciler used to accept every close-side fill in the
 * window and stop after the requested volume, so a quick re-entry could book
 * the PREVIOUS trade's stop as this trade's exit. `entryTime` is the boundary;
 * the order is submitted after that timestamp, while the earlier trade's fill
 * is before it. Volume is capped so a partial fill is represented honestly and
 * unrelated later volume can never leak in.
 */
export function matchLiveDealVolume<T extends { side: number; vol: number; ts: number }>(
  deals: readonly T[],
  opts: { side: number; entryTime: number; volContracts: number },
): Array<{ deal: T; vol: number }> {
  let need = Number.isFinite(opts.volContracts) ? Math.max(0, opts.volContracts) : 0;
  if (!(need > 0) || !Number.isFinite(opts.entryTime)) return [];
  const eligible = deals
    .filter(
      (deal) =>
        deal.side === opts.side &&
        Number.isFinite(deal.ts) &&
        deal.ts >= opts.entryTime &&
        Number.isFinite(deal.vol) &&
        deal.vol > 0,
    )
    .sort((a, b) => a.ts - b.ts);

  const matched: Array<{ deal: T; vol: number }> = [];
  for (const deal of eligible) {
    if (need <= 0) break;
    const vol = Math.min(need, deal.vol);
    if (!(vol > 0)) continue;
    matched.push({ deal, vol });
    need -= vol;
  }
  return matched;
}

// ── LEDGER CLOSE ACK (2026-09-24 live stop audit) ──────────────────────────
export type LiveCloseWriteResult = "recorded" | "already-closed" | "write-failed";

/**
 * Run a close-ledger write without allowing bookkeeping failure to fall into
 * an order-error catch. `{ ok: true }` is the only acknowledgement that counts
 * as a newly recorded close; `{ ok: false }` means a concurrent pass already
 * closed the row. A thrown error or unrecognised return is unconfirmed, never
 * counted, and is left for the next reconciliation pass.
 */
export async function recordLiveCloseWrite(
  write: () => Promise<unknown>,
): Promise<LiveCloseWriteResult> {
  try {
    const result = await write();
    if (result != null && typeof result === "object" && "ok" in result) {
      const ok = (result as { ok?: unknown }).ok;
      if (ok === true) return "recorded";
      if (ok === false) {
        const reason = (result as { reason?: unknown }).reason;
        return reason === "not-open" ? "already-closed" : "write-failed";
      }
    }
    return "write-failed";
  } catch {
    return "write-failed";
  }
}

/** Reconcile a UI/manual action's answer with the ledger's final row state. */
export function manualCloseAck(args: {
  reportedOk: boolean;
  stillOpen: boolean;
  /** MEXC accepted the fenced order; the ledger may still await its fill. */
  accepted?: boolean;
  reason?: string;
}): { ok: boolean; reason?: string } {
  if (!args.stillOpen) {
    return args.reportedOk
      ? { ok: true }
      : { ok: true, reason: "Close completed; the ledger row is already closed." };
  }
  if (args.accepted) {
    return {
      ok: true,
      reason: args.reason ?? "Close order accepted; awaiting the exchange fill and ledger reconciliation.",
    };
  }
  if (args.reportedOk) {
    return {
      ok: false,
      reason:
        args.reason ??
        "The exchange close completed, but the ledger row is still open; the next exit pass will reconcile it.",
    };
  }
  return { ok: false, reason: args.reason };
}

// ── EXIT ATTRIBUTION (2026-09-22) ───────────────────────────────────────────
// When a position vanished and the engine had NOT placed the close, the row
// was labelled with a shrug — "Closed on exchange (manual / TP-SL / liquidation)"
// — which names four possibilities and identifies none. It covered 47% of the
// live book (34 of 72 exits), and it hid a real defect: six winners whose
// realizedR exceeded their own recorded trailPeakR (arithmetically impossible,
// since peak and lock are written in one atomic patch) sat inside that bucket.
//
// Every row already keeps its own bracket (slPrice / tpPrice / trailLockPrice)
// and the reconciler recovers the true fill from the exchange's deal history,
// so the fill itself is the evidence. This names the exit from the fill by
// picking the CLOSEST bracket and asserting it only within tolerance — so a
// fill that matches nothing is reported as exactly that, never laundered into
// a plausible-sounding cause.
//
// Tolerance is 0.5%: wide enough for market-close slippage and partial-fill
// VWAP drift, far narrower than the gap between two brackets in normal use.
export type LiveExitName =
  | "Stop Loss"
  | "Take Profit"
  | "Trail Lock"
  | "Closed off-engine (fill matches no bracket)";

export const LIVE_EXIT_MATCH_TOL_PCT = 0.5;

/**
 * RELABEL PLANNER (2026-09-23) — what the historical rows should say.
 *
 * `nameExitFromFill` names NEW closes (wired 2026-09-22 in liveBroker's two
 * reconciliation paths). It cannot help the rows that closed BEFORE it existed:
 * 36 of the live book's 86 exits still read "Closed on exchange (manual /
 * TP-SL / liquidation)" — the shrug that names four causes and identifies
 * none. Every one of them has a recovered fill (`exitPrice` + `realizedR`), so
 * the evidence to name them is already on the row; what was missing is a pass
 * that applies the rule backwards.
 *
 * Pure and single-purpose, so the repair mutation is a thin applier and this
 * policy is unit-testable without a database:
 *   1. Name the exit from its own fill, ONLY for rows still wearing the legacy
 *      shrug. A reason the engine set from an order it PLACED is itself
 *      evidence and is never overwritten — the pass cannot rewrite history it
 *      did not produce, and re-running it converges instead of churning.
 *   2. Store the attribution verdict once, for every row that never got one
 *      (the invariant shipped 2026-09-22, so all 86 predate it). Passing the
 *      NEW reason through matters: six winners only become checkable after (1)
 *      renames them off the shrug, which is precisely the case the invariant
 *      was written for and could not see.
 *
 * Labels and verdicts only. Prices, R, PnL and fees are never touched — the
 * repair changes what the ledger SAYS about an exit, never what it earned.
 */
export const LEGACY_EXIT_REASON = "Closed on exchange (manual / TP-SL / liquidation)";

export type LiveExitRelabelRow = {
  reason?: string | null;
  exitPrice?: number | null;
  slPrice?: number | null;
  tpPrice?: number | null;
  trailLockPrice?: number | null;
  realizedR?: number | null;
  trailPeakR?: number | null;
  attributionAnomaly?: string | null;
};

export function planLiveExitRelabel(t: LiveExitRelabelRow): {
  reason?: LiveExitName;
  attributionAnomaly?: string;
} {
  const patch: { reason?: LiveExitName; attributionAnomaly?: string } = {};

  let reason = t.reason ?? undefined;
  if (t.reason === LEGACY_EXIT_REASON && typeof t.exitPrice === "number" && t.exitPrice > 0) {
    const named = nameExitFromFill({
      fillPrice: t.exitPrice,
      slPrice: t.slPrice,
      tpPrice: t.tpPrice,
      trailLockPrice: t.trailLockPrice,
    });
    if (named.name !== reason) {
      patch.reason = named.name;
      reason = named.name;
    }
  }

  if (t.attributionAnomaly == null) {
    const anomaly = detectAttributionAnomaly({
      realizedR: t.realizedR,
      trailPeakR: t.trailPeakR,
      reason,
    });
    if (anomaly) patch.attributionAnomaly = anomaly;
  }

  return patch;
}

export function nameExitFromFill(opts: {
  fillPrice: number;
  slPrice?: number | null;
  tpPrice?: number | null;
  trailLockPrice?: number | null;
  tolPct?: number;
}): {
  name: LiveExitName;
  matched: "stop" | "target" | "trail" | "none";
  /** Relative distance to the closest bracket, in percent. NaN when no bracket exists. */
  distancePct: number;
} {
  const tol = opts.tolPct ?? LIVE_EXIT_MATCH_TOL_PCT;
  const fill = opts.fillPrice;
  const unmatched: LiveExitName = "Closed off-engine (fill matches no bracket)";

  const candidates: { key: "stop" | "target" | "trail"; name: LiveExitName; price: number }[] = [];
  const push = (
    key: "stop" | "target" | "trail",
    name: LiveExitName,
    price: number | null | undefined,
  ): void => {
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      candidates.push({ key, name, price });
    }
  };
  push("stop", "Stop Loss", opts.slPrice);
  push("target", "Take Profit", opts.tpPrice);
  push("trail", "Trail Lock", opts.trailLockPrice);

  if (!(fill > 0) || candidates.length === 0) {
    return { name: unmatched, matched: "none", distancePct: NaN };
  }

  let best = candidates[0]!;
  let bestDist = Math.abs(fill - best.price) / best.price;
  for (const c of candidates.slice(1)) {
    const d = Math.abs(fill - c.price) / c.price;
    if (d < bestDist) {
      best = c;
      bestDist = d;
    }
  }

  const distancePct = bestDist * 100;
  if (distancePct > tol) return { name: unmatched, matched: "none", distancePct };
  return { name: best.name, matched: best.key, distancePct };
}

// ── ATTRIBUTION INVARIANT (2026-09-22) ──────────────────────────────────────
// A close can never realize MORE R than the position actually reached. The
// trail monitor writes trailPeakR and trailLockPrice in ONE atomic patch as a
// running max, so `realizedR > trailPeakR` is arithmetically impossible when
// the close is the trail's own doing: a rung exit fills at or below the rung
// (<= peak), and an R-Lock Max exit ratchets the peak to the target in the
// same tick it closes (rLockExit.ts writes setLiveTrailState BEFORE
// markLiveClosed).
//
// Six live winners carried exactly that signature — fills 0.35R to 1.66R ABOVE
// their own recorded lock, with no exitOrderId — and they were +15.40R, i.e.
// 74% of the live book's net profit. They survived three audits because the
// row read as a normal win. This turns that silent impossibility into a stored
// string the moment it happens, WITHOUT touching the money: the numbers are
// left exactly as the exchange reported them, because clamping would hide the
// cause and corrupt the PnL record.
//
// WHEN NOT TO FIRE — the check only judges exits whose provenance is NOT
// already explained by their own reason (first audit revision):
//   - "Take Profit": the fill IS the bracket target by construction
//     (expectedExitPrice), and the exchange bracket can fill a TP the 5-minute
//     monitor never sampled — the recorded peak legitimately LAGS the fill by
//     up to one tick. Firing here false-positives on every healthy TP close
//     that ran to target between samples. (Found by self-audit: with a 0.01R
//     tolerance every TP win above the last sampled peak would be flagged.)
//   - "Stop Loss": the fill sits at −1R minus slippage — can never exceed any
//     non-negative peak.
//   - "Manual close": a human closed at market; the action itself explains the
//     exit, and exitOrderId is recorded.
// It DOES fire on trail-family exits and on unexplained closes — the exact
// bucket the six real anomalies fell into ("Closed off-engine (fill matches no
// bracket)", formerly the shrug label).
export const ATTRIBUTION_CHECK_REASONS: ReadonlySet<string> = new Set([
  "Trail Lock",
  "R-Lock Max",
  "Closed off-engine (fill matches no bracket)",
]);

export function detectAttributionAnomaly(opts: {
  realizedR?: number | null;
  trailPeakR?: number | null;
  /**
   * The recorded close reason. The invariant only evaluates exits whose cause
   * is trail-managed or unexplained — see ATTRIBUTION_CHECK_REASONS above.
   * Undefined reasons ARE checked (absence of a reason is not an explanation).
   */
  reason?: string | null;
  /** Rounding/slippage slack on the R comparison. Default 0.05R — wider than
   * any observed favourable fill slippage on a rung exit (live rung fills
   * measured −0.04R to −0.90R, i.e. all adverse), tight enough that every real
   * anomaly (all >= 0.35R above peak) still fires. */
  tolR?: number;
}): string | undefined {
  const peak = opts.trailPeakR;
  const realized = opts.realizedR;
  if (typeof peak !== "number" || !Number.isFinite(peak)) return undefined;
  if (typeof realized !== "number" || !Number.isFinite(realized)) return undefined;
  if (opts.reason != null && !ATTRIBUTION_CHECK_REASONS.has(opts.reason)) return undefined;
  const tol = opts.tolR ?? 0.05;
  if (realized <= peak + tol) return undefined;
  return `realizedR ${realized.toFixed(2)} exceeds trailPeakR ${peak.toFixed(2)} — exit provenance unexplained`;
}
