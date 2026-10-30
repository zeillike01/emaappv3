/**
 * EXECUTION RECORD (2026-10-10) — the per-trade execution facts the ledger
 * never kept: intended vs filled price, the liquidation level at entry, the
 * stop TRIGGER vs the stop FILL, decision→order latency, rejects and partial
 * fills, and the exit facts in R.
 *
 * WHY IT EXISTS. Every one of these is a place where a paper assumption stops
 * being true on the live book, and none of them was recorded, so the live-vs-
 * paper gap could only be guessed at from P&L. `stopTrigger` vs `stopFill`
 * separates "the exchange was slow" from "the market gapped"; `liqPrice` is
 * the level the 60x/20x sizing was actually risking against.
 *
 * THE ANOMALY THIS FLAGS: a stop fill BEYOND the liquidation price. A stop can
 * slip, but it cannot fill past the level at which the position would already
 * have been liquidated — so that combination means one of the two numbers is
 * wrong (stale liq model, wrong contract size, unread partial), and it is
 * flagged rather than silently averaged into the book's R.
 *
 * PURE AND TOTAL. Nothing here reads I/O or the clock; every function returns
 * null / a flag instead of throwing, because this is a logging path: a
 * malformed input must leave the trade record untouched, never fail it.
 */

/** Default isolated-margin maintenance rate used when the exchange's is unknown. */
export const DEFAULT_MAINTENANCE_MARGIN_RATE = 0.005; // 0.5%

export type Side = "LONG" | "SHORT";

/** Flags carried on the record so a report never has to re-derive them. */
export const EXEC_FLAGS = {
  STOP_BEYOND_LIQ: "stop-beyond-liq",
  MISSING_INTENDED: "missing-intended",
  LATE_ORDER: "late-order",
  PARTIAL_FILL: "partial-fill",
  REJECTED: "rejected",
} as const;

/** Decision→order latency above which the order counts as late (1 tick = 5m). */
export const LATE_ORDER_MS = 5 * 60_000;

export interface EntryExecInput {
  side: Side;
  /** Price the decision intended to trade (signal price). Null when unknown. */
  intendedPrice?: number | null;
  /** Price the order actually filled at (exchange average fill). */
  fillPrice: number;
  /** Original stop level. */
  stopPrice?: number | null;
  /** Target level (fixed TP or the lock's max). */
  targetPrice?: number | null;
  /** Decision timestamp (closed signal bar). */
  decisionTs?: number | null;
  /** Wall-clock when the order was submitted. */
  submittedAt?: number | null;
  /** Wall-clock of the fill / position open. */
  fillTime?: number | null;
  leverage?: number | null;
  /** Exchange maintenance-margin rate when known. */
  maintenanceMarginRate?: number | null;
  /** Order quantity submitted (contracts or coin) and quantity filled. */
  requestedQty?: number | null;
  filledQty?: number | null;
  rejects?: number | null;
  partialFills?: number | null;
  /** Fees paid on entry, in USD (recorded, not re-derived here). */
  feeUsd?: number | null;
  /** Funding charged while the position was open, in USD. */
  fundingPaidUsd?: number | null;
}

export interface ExecRecord {
  side: Side;
  intendedPrice: number | null;
  fillPrice: number;
  slippageBps: number | null;
  stopTrigger: number | null;
  stopFill: number | null;
  targetPrice: number | null;
  liqPrice: number | null;
  liqDistancePct: number | null;
  decisionToOrderMs: number | null;
  entryLatencyMs: number | null;
  requestedQty: number | null;
  filledQty: number | null;
  rejects: number;
  partialFills: number;
  feeUsd: number | null;
  fundingPaidUsd: number | null;
  exitReason: string | null;
  exitPrice: number | null;
  exitTime: number | null;
  realizedR: number | null;
  mfeR: number | null;
  maeR: number | null;
  barsHeld: number | null;
  flags: string[];
}

/**
 * Isolated-margin liquidation price. Distance is `1/leverage − maintenance
 * rate`, which is the standard isolated approximation and exactly what the
 * ledger's stop placement is implicitly betting against.
 */
export function liqPriceFor(args: {
  side: Side;
  entryPrice: number;
  leverage?: number | null;
  maintenanceMarginRate?: number | null;
}): number | null {
  const lev = Number(args.leverage);
  const entry = Number(args.entryPrice);
  if (!(lev > 1) || !(entry > 0)) return null;
  const mmr = Number.isFinite(Number(args.maintenanceMarginRate))
    ? Math.max(0, Math.min(0.5, Number(args.maintenanceMarginRate)))
    : DEFAULT_MAINTENANCE_MARGIN_RATE;
  const dist = 1 / lev - mmr;
  if (!(dist > 0)) return null;
  return args.side === "LONG" ? entry * (1 - dist) : entry * (1 + dist);
}

/** How far the stop sits from liquidation, as a percent of entry. */
export function liqDistancePct(args: {
  entryPrice: number;
  liqPrice?: number | null;
}): number | null {
  const entry = Number(args.entryPrice);
  const liq = Number(args.liqPrice);
  if (!(entry > 0) || !(liq > 0)) return null;
  return +(((Math.abs(entry - liq)) / entry) * 100).toFixed(4);
}

/** Signed R from a real entry/exit pair, against the frozen 1R distance. */
export function realizedRFromFill(args: {
  side: Side;
  entryPrice: number;
  exitPrice: number;
  riskPx?: number | null;
  stopPrice?: number | null;
}): number | null {
  const frozen = Number(args.riskPx);
  const risk = Number.isFinite(frozen) && frozen > 0
    ? frozen
    : Math.abs(Number(args.entryPrice) - Number(args.stopPrice));
  if (!(risk > 0) || !(args.entryPrice > 0) || !(args.exitPrice > 0)) return null;
  const sign = args.side === "LONG" ? 1 : -1;
  return +((sign * (args.exitPrice - args.entryPrice)) / risk).toFixed(4);
}

/** Build the entry half. Returns null when the input cannot describe a fill. */
export function buildEntryExec(input: EntryExecInput): ExecRecord | null {
  const fill = Number(input.fillPrice);
  if (!(fill > 0)) return null;
  const intended = Number(input.intendedPrice);
  const hasIntended = Number.isFinite(intended) && intended > 0;
  const liq = liqPriceFor({
    side: input.side,
    entryPrice: fill,
    leverage: input.leverage,
    maintenanceMarginRate: input.maintenanceMarginRate,
  });
  const decisionTs = Number(input.decisionTs);
  const submittedAt = Number(input.submittedAt);
  const fillTime = Number(input.fillTime);
  const decisionToOrderMs =
    Number.isFinite(decisionTs) && Number.isFinite(submittedAt) && submittedAt >= decisionTs
      ? submittedAt - decisionTs
      : null;
  const entryLatencyMs =
    Number.isFinite(submittedAt) && Number.isFinite(fillTime) && fillTime >= submittedAt
      ? fillTime - submittedAt
      : null;
  const rejects = Math.max(0, Math.floor(Number(input.rejects) || 0));
  const partialFills = Math.max(0, Math.floor(Number(input.partialFills) || 0));

  const flags: string[] = [];
  if (!hasIntended) flags.push(EXEC_FLAGS.MISSING_INTENDED);
  if (decisionToOrderMs != null && decisionToOrderMs > LATE_ORDER_MS) flags.push(EXEC_FLAGS.LATE_ORDER);
  if (rejects > 0) flags.push(EXEC_FLAGS.REJECTED);
  if (partialFills > 0) flags.push(EXEC_FLAGS.PARTIAL_FILL);

  return {
    side: input.side,
    intendedPrice: hasIntended ? intended : null,
    fillPrice: fill,
    slippageBps: hasIntended ? +(((Math.abs(fill - intended)) / intended) * 10_000).toFixed(4) : null,
    stopTrigger: numberOrNull(input.stopPrice),
    stopFill: null,
    targetPrice: numberOrNull(input.targetPrice),
    liqPrice: liq != null ? +liq.toFixed(8) : null,
    liqDistancePct: liqDistancePct({ entryPrice: fill, liqPrice: liq }),
    decisionToOrderMs,
    entryLatencyMs,
    requestedQty: numberOrNull(input.requestedQty),
    filledQty: numberOrNull(input.filledQty),
    rejects,
    partialFills,
    feeUsd: numberOrNull(input.feeUsd),
    fundingPaidUsd: numberOrNull(input.fundingPaidUsd),
    exitReason: null,
    exitPrice: null,
    exitTime: null,
    realizedR: null,
    mfeR: null,
    maeR: null,
    barsHeld: null,
    flags,
  };
}

export interface ExitExecInput {
  /** The entry half already on the row (may be null on legacy rows). */
  entry?: Partial<ExecRecord> | null;
  side: Side;
  entryPrice: number;
  stopPrice?: number | null;
  /** The level the stop was TRIGGERED at (the bracket / stop level). */
  stopTrigger?: number | null;
  /** The price the stop actually FILLED at. */
  stopFill?: number | null;
  exitPrice: number;
  exitTime: number;
  entryTime?: number | null;
  riskPx?: number | null;
  reason: string;
  feeUsd?: number | null;
  fundingPaidUsd?: number | null;
  mfeR?: number | null;
  maeR?: number | null;
}

/**
 * Build the exit half, merging over whatever the entry half already recorded.
 * `realizedR` here is measured from the ACTUAL fill — never an assumed -1 — so
 * a report comparing books compares what both books really got.
 */
export function buildExitExec(input: ExitExecInput): ExecRecord | null {
  const exitPrice = Number(input.exitPrice);
  if (!(exitPrice > 0)) return null;
  const base = normalizeExec(input.entry, input.side, input.entryPrice, input.stopPrice);
  const stopTrigger = numberOrNull(input.stopTrigger ?? base.stopTrigger);
  const isStop = /stop/i.test(input.reason);
  const stopFill = isStop ? numberOrNull(input.stopFill ?? exitPrice) : numberOrNull(input.stopFill);
  // The entry half has no entryTime of its own — the caller passes the row's.
  const entryTime = Number(input.entryTime ?? 0);
  const exitTime = Number(input.exitTime);
  const barsHeld =
    entryTime > 0 && Number.isFinite(exitTime) && exitTime >= entryTime
      ? Math.max(1, Math.round((exitTime - entryTime) / 60_000))
      : base.barsHeld ?? null;
  const realizedR =
    realizedRFromFill({
      side: input.side,
      entryPrice: input.entryPrice,
      exitPrice,
      riskPx: input.riskPx,
      stopPrice: input.stopPrice ?? stopTrigger,
    }) ?? base.realizedR;

  const flags = [...(base.flags ?? [])];
  const liq = base.liqPrice ?? null;
  const beyond =
    liq != null && stopFill != null
      ? input.side === "LONG"
        ? stopFill < liq
        : stopFill > liq
      : false;
  if (beyond && !flags.includes(EXEC_FLAGS.STOP_BEYOND_LIQ)) flags.push(EXEC_FLAGS.STOP_BEYOND_LIQ);

  return {
    ...base,
    side: input.side,
    fillPrice: base.fillPrice ?? +Number(input.entryPrice).toFixed(8),
    stopTrigger,
    stopFill,
    exitReason: input.reason,
    exitPrice: +exitPrice.toFixed(8),
    exitTime,
    realizedR,
    mfeR: numberOrNull(input.mfeR) ?? base.mfeR,
    maeR: numberOrNull(input.maeR) ?? base.maeR,
    barsHeld,
    feeUsd: numberOrNull(input.feeUsd) ?? base.feeUsd,
    fundingPaidUsd: numberOrNull(input.fundingPaidUsd) ?? base.fundingPaidUsd,
    flags,
  };
}

/** True when the record carries the impossible stop-vs-liquidation pairing. */
export function stopBeyondLiquidation(exec?: Partial<ExecRecord> | null): boolean {
  return !!exec && Array.isArray(exec.flags) && exec.flags.includes(EXEC_FLAGS.STOP_BEYOND_LIQ);
}

/**
 * Merge a patch into an existing record without ever producing an invalid one.
 *
 * The logging path's fail-open contract lives here: a null/undefined patch,
 * a non-object record, or a NaN in a numeric field makes the whole merge a
 * no-op (returns null), so the WRITER can skip the database write entirely and
 * the trade row keeps exactly what it had.
 */
export function mergeExec(prev: unknown, patch: unknown): ExecRecord | null {
  const p = isPlainRecord(patch) ? (patch as Partial<ExecRecord>) : null;
  if (!p) return null;
  const base = normalizeExec(prev, p.side ?? "LONG", p.fillPrice ?? 0, p.stopTrigger ?? null);
  const merged: ExecRecord = { ...base };
  for (const [k, v] of Object.entries(p)) {
    // `undefined` AND `null` both mean "this write did not measure the field".
    // `buildEntryExec` returns every exit-side field as an explicit null, so
    // applying nulls let an entry write — a delayed scheduler retry, a re-run —
    // ERASE the exit half of an already-closed row's record: realizedR, maeR,
    // mfeR, barsHeld and the exit reason all wiped by a log write. The whole
    // contract of this function is that a log write can never destroy data.
    if (v === undefined || v === null) continue;
    if (k === "flags") {
      merged.flags = [...new Set([...(base.flags ?? []), ...((v as string[]) ?? [])])];
      continue;
    }
    if (typeof v === "number" && !Number.isFinite(v)) return null;
    (merged as any)[k] = v;
  }
  if (!(merged.fillPrice > 0)) return null;
  return merged;
}

// ── internals ───────────────────────────────────────────────────────────────

function normalizeExec(
  prev: unknown,
  side: Side,
  entryPrice: number,
  stopPrice?: number | null,
): ExecRecord {
  const base: ExecRecord = {
    side,
    intendedPrice: null,
    fillPrice: Number(entryPrice) > 0 ? Number(entryPrice) : 0,
    slippageBps: null,
    stopTrigger: numberOrNull(stopPrice),
    stopFill: null,
    targetPrice: null,
    liqPrice: null,
    liqDistancePct: null,
    decisionToOrderMs: null,
    entryLatencyMs: null,
    requestedQty: null,
    filledQty: null,
    rejects: 0,
    partialFills: 0,
    feeUsd: null,
    fundingPaidUsd: null,
    exitReason: null,
    exitPrice: null,
    exitTime: null,
    realizedR: null,
    mfeR: null,
    maeR: null,
    barsHeld: null,
    flags: [],
  };
  if (!isPlainRecord(prev)) return base;
  return { ...base, ...(prev as Partial<ExecRecord>), flags: [...((prev as Partial<ExecRecord>).flags ?? [])] };
}

function isPlainRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === "object" && !Array.isArray(x);
}

function numberOrNull(x: unknown): number | null {
  const n = Number(x);
  if (x === null || x === undefined || x === "") return null;
  return Number.isFinite(n) ? n : null;
}
