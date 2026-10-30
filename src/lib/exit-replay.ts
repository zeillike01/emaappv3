/**
 * EXIT REPLAY — the counterfactual pricer for candidate outcomes (2026-10-10).
 *
 * WHAT THIS IS FOR. The candidate log records what the engine decided; this
 * module prices what would have HAPPENED to those candidates (taken or blocked)
 * under a bracket, so a report can finally measure a gate by the R it removed
 * instead of by the trades that survived it.
 *
 * ONE IMPLEMENTATION OF THE EXIT RULE. The R-lock replay calls
 * `rLockBarStep` — the same pure function both live books use to advance the
 * lock and `src/lib/backtest.ts` uses to measure it — so the counterfactual
 * and the shipped mechanic cannot drift. The fixed bracket books at the same
 * prices the books themselves book: a stop fills ADVERSE by
 * `EXIT_SLIP_BPS` (paper `resolveLayer2Exits` books `slPrice × (1 − 3bps)`;
 * live-math's `expectedExitPrice` books exactly the same), and a take-profit
 * fills AT the target (a resting limit in both books).
 *
 * STOP-BEFORE-LOCK (the spec's ambiguity rule). A single 1m bar can span both
 * the stop and a lock rung. The replay books the STOP first and counts the bar
 * in `ambiguousBars` — never the more favourable rung. Same rule for a fixed
 * bracket whose bar spans stop and target.
 *
 * COSTS. Fees/funding come from `src/lib/exit-telemetry` (TAKER_FEE,
 * MAKER_FEE, FUNDING_PER_8H) — the exact model both paper ledgers book at
 * close — so a replay's R is comparable to a recorded `realizedR`.
 *
 * HORIZON. The replay stops at `horizonMs` (default 48h) and books the close
 * of the last bar inside the window as `Horizon` with `horizonCapped: true`.
 * `complete: false` means the bar series did not reach the exit — the caller
 * must NOT store that as an outcome.
 */
import { rLockBarStep, rLockEnabled, type RLockParams } from "./r-lock";
import { TAKER_FEE, MAKER_FEE, FUNDING_PER_8H } from "./exit-telemetry";

/** Market-exit slippage in bps — the same 3bps both books use (EXIT_SLIP_BPS). */
export const REPLAY_EXIT_SLIP_BPS = 3;
/** Default horizon cap (48h, spec §Stage 2; configurable at the call site). */
export const DEFAULT_HORIZON_MS = 48 * 60 * 60_000;

export interface ReplayBar {
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ReplayExitReason =
  | "Stop Loss"
  | "Take Profit"
  | "Trail Lock"
  | "R-Lock Max"
  | "Horizon";

export interface ReplayInput {
  side: "LONG" | "SHORT";
  /** Fill price of the entry bar's open. */
  entryPrice: number;
  /** Original stop level. */
  slPrice: number;
  /**
   * Target level. With a lock armed this is the lock's MAX target; with the
   * lock off it is the fixed TP. Set to Infinity for "no target" (lock rides
   * to the rung only).
   */
  tpPrice: number;
  /** R-lock policy; startR <= 0 or null = fixed bracket. */
  lock?: RLockParams | null;
  /** Frozen 1R in price; defaults to |entry − sl|. */
  riskPx?: number | null;
  /** Closed bars from the entry bar onward (oldest first). */
  bars: readonly ReplayBar[];
  horizonMs?: number;
  /** Entry bar open time (defaults to bars[0].openTime). */
  entryTime?: number;
}

export interface ReplayOutcome {
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  exitReason: ReplayExitReason;
  /** Net R after fees and funding, signed. */
  r: number;
  /** Gross R before costs, signed. */
  grossR: number;
  /** Cost drag in R (fees + funding, always >= 0). */
  costR: number;
  mfeR: number;
  maeR: number;
  barsHeld: number;
  /** Bars where the stop and a target were both touched (stop was booked). */
  ambiguousBars: number;
  horizonCapped: boolean;
  /** True when the bars reached the exit (or the full horizon). */
  complete: boolean;
}

function sideSign(side: "LONG" | "SHORT"): number {
  return side === "LONG" ? 1 : -1;
}

/** Cost drag in R for one exit: entry taker + exit taker/maker + funding windows. */
export function replayCostR(args: {
  entryPrice: number;
  riskPx: number;
  exitIsMaker: boolean;
  holdMs: number;
}): number {
  const { entryPrice, riskPx } = args;
  if (!(entryPrice > 0) || !(riskPx > 0)) return 0;
  const entryFeeR = (entryPrice * TAKER_FEE) / riskPx;
  const exitFeeR = (entryPrice * (args.exitIsMaker ? MAKER_FEE : TAKER_FEE)) / riskPx;
  const windows = Math.floor(Math.max(0, args.holdMs) / (8 * 3_600_000));
  const fundingR = (windows * FUNDING_PER_8H * entryPrice) / riskPx;
  return entryFeeR + exitFeeR + fundingR;
}

/**
 * Replay one candidate entry through a bracket (fixed or R-lock) on closed
 * bars. Pure; no I/O. Returns `complete: false` when the series runs out
 * before the exit or the full horizon.
 */
export function replayExit(input: ReplayInput): ReplayOutcome {
  const side = input.side;
  const sign = sideSign(side);
  const bars = [...input.bars]
    .filter((b) => Number.isFinite(b.openTime) && Number.isFinite(b.high) && Number.isFinite(b.low))
    .sort((a, b) => a.openTime - b.openTime);
  const entryTime = input.entryTime ?? bars[0]?.openTime ?? 0;
  const entryPrice = input.entryPrice;
  const riskPx = (() => {
    const r = input.riskPx != null && input.riskPx > 0 ? input.riskPx : Math.abs(entryPrice - input.slPrice);
    return r > 0 ? r : NaN;
  })();
  const horizonMs = input.horizonMs ?? DEFAULT_HORIZON_MS;
  const slip = REPLAY_EXIT_SLIP_BPS / 10_000;
  const lockOn = rLockEnabled(input.lock ?? undefined);

  const base: ReplayOutcome = {
    entryTime,
    entryPrice,
    exitTime: entryTime,
    exitPrice: entryPrice,
    exitReason: "Horizon",
    r: 0,
    grossR: 0,
    costR: 0,
    mfeR: 0,
    maeR: 0,
    barsHeld: 0,
    ambiguousBars: 0,
    horizonCapped: false,
    complete: false,
  };
  if (!(riskPx > 0) || !(entryPrice > 0) || bars.length === 0) return base;

  let peakR = 0;
  let lockPrice = 0;
  let mfeR = 0;
  let maeR = 0;
  let ambiguousBars = 0;
  let lastBar: ReplayBar | null = null;

  const finish = (
    bar: ReplayBar,
    exitPrice: number,
    exitReason: ReplayExitReason,
    horizonCapped: boolean,
    complete: boolean,
  ): ReplayOutcome => {
    const grossR = (sign * (exitPrice - entryPrice)) / riskPx;
    const exitIsMaker = exitReason === "Take Profit";
    const costR = replayCostR({
      entryPrice,
      riskPx,
      exitIsMaker,
      holdMs: bar.closeTime - entryTime,
    });
    return {
      entryTime,
      entryPrice,
      exitTime: bar.closeTime,
      exitPrice,
      exitReason,
      r: grossR - costR,
      grossR,
      costR,
      mfeR,
      maeR,
      barsHeld: Math.max(0, Math.round((bar.closeTime - entryTime) / 60_000)),
      ambiguousBars,
      horizonCapped,
      complete,
    };
  };

  for (const bar of bars) {
    if (bar.closeTime <= entryTime) continue;
    // Horizon: the bar opens beyond the cap — book the previous close.
    if (bar.openTime >= entryTime + horizonMs) {
      const bookBar = lastBar ?? bar;
      return finish(bookBar, bookBar.close, "Horizon", true, true);
    }

    // Excursion up to and including this bar.
    const favMove = sign * (side === "LONG" ? bar.high - entryPrice : bar.low - entryPrice);
    const advMove = sign * (entryPrice - (side === "LONG" ? bar.low : bar.high));
    const favR = favMove / riskPx;
    const advR = advMove / riskPx;
    if (favR > mfeR) mfeR = favR;
    if (advR > maeR) maeR = advR;

    // Stop-first: adverse extreme against the ORIGINAL stop.
    const stopTouched = side === "LONG" ? bar.low <= input.slPrice : bar.high >= input.slPrice;

    // Which favourable level could this bar reach? (lock rung once armed, else
    // the max/fixed target).
    const lockLevel = lockOn && lockPrice > 0 ? lockPrice : null;
    const targetLevel = Number.isFinite(input.tpPrice) && input.tpPrice > 0 ? input.tpPrice : null;
    const reachable = lockLevel != null ? lockLevel : targetLevel;
    const targetTouched =
      reachable != null && (side === "LONG" ? bar.high >= reachable : bar.low <= reachable);

    if (stopTouched) {
      if (targetTouched) ambiguousBars++;
      const fill = side === "LONG" ? input.slPrice * (1 - slip) : input.slPrice * (1 + slip);
      return finish(bar, fill, "Stop Loss", false, true);
    }

    if (lockOn) {
      const step = rLockBarStep({
        side,
        entryPrice,
        slPrice: input.slPrice,
        riskPx,
        params: input.lock ?? undefined,
        bar: { high: bar.high, low: bar.low },
        state: { peakR, lockPrice },
      });
      if (step.exit) {
        // Rung breach: book at the rung with market slippage (the books book
        // at the sampled market price; the rung is the conservative stand-in
        // for a 1m replay).
        const fill =
          side === "LONG" ? step.exit.rungPrice * (1 - slip) : step.exit.rungPrice * (1 + slip);
        peakR = step.peakR;
        lockPrice = step.lockPrice;
        return finish(bar, fill, step.exit.reason, false, true);
      }
      peakR = step.peakR;
      lockPrice = step.lockPrice;
      if (step.stopBreached) {
        const fill = side === "LONG" ? input.slPrice * (1 - slip) : input.slPrice * (1 + slip);
        return finish(bar, fill, "Stop Loss", false, true);
      }
      // Record the bar BEFORE continuing. The horizon branch books
      // `lastBar.close`; leaving it null on the lock path made a horizon exit
      // price the first bar PAST the cap instead of the last one inside it.
      lastBar = bar;
      continue;
    }

    // Fixed bracket.
    if (targetLevel != null && targetTouched) {
      return finish(bar, targetLevel, "Take Profit", false, true);
    }
    lastBar = bar;
  }

  return base;
}

/** First closed bar after a decision time (the replay's entry bar). */
export function entryBarAfter(
  bars: readonly ReplayBar[],
  decisionTs: number,
): ReplayBar | null {
  for (const b of bars) {
    if (b.openTime >= decisionTs) return b;
  }
  return null;
}

/**
 * PARITY — replay a RECORDED closed trade and compare. The spec asks for two
 * runs: at the book's own check interval (5m for paper) and at 1m; the gap
 * between the two is the exit-sampling error. Reason must match at 5m;
 * `dR` reports the R difference for the report.
 */
export interface ParityInput {
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  tpPrice: number;
  lock?: RLockParams | null;
  riskPx?: number | null;
  recordedExitTime: number;
  recordedExitPrice: number;
  recordedReason: string;
  recordedR: number;
  bars5m: readonly ReplayBar[];
  bars1m: readonly ReplayBar[];
  horizonMs?: number;
  /**
   * Recorded entry time. Without it `replayExit` falls back to bars[0].openTime
   * — the START of the fetched window — and prices pre-entry bars against the
   * bracket and measures the 48h horizon from the wrong instant.
   */
  entryTime?: number;
}

export interface ParityResult {
  replay5Reason: string;
  replay5R: number;
  replay1Reason: string;
  replay1R: number;
  reasonMatch5: boolean;
  reasonMatch1: boolean;
  /**
   * The R landed within REASON_TOLERANCE_R of the recorded R even though the
   * REASON differed. Reported, never merged into `reasonMatch5`: rule 11
   * excludes a gate from tuning on ANY parity failure, so a tolerance that
   * silently satisfied the match could launder a genuinely different exit.
   */
  reasonClose5: boolean;
  /** |replay1R − replay5R| — the exit-sampling error the spec asks to report. */
  samplingErrorR: number;
  /**
   * The 5m replay's bars actually reached the exit (or the full horizon).
   * `false` means the series ran out first: the replay knows nothing about this
   * trade, and `replay5Reason`/`replay5R` are the inert defaults ("Horizon", 0),
   * NOT findings.
   */
  complete5: boolean;
  /** Same, for the 1m replay. */
  complete1: boolean;
  /** Both replays reached a real exit — only then is `samplingErrorR` meaningful. */
  evaluated: boolean;
  /**
   * Rule 11's verdict for this trade.
   *
   * TRUE ONLY WHEN THE 5m REPLAY HAD THE DATA TO JUDGE AND DISAGREED. A series
   * that stops before the recorded exit says nothing about the trade — but its
   * inert defaults ("Horizon", r=0) never equal the recorded reason, so it used
   * to read as a mismatch, and ONE mismatch excludes EVERY gate from tuning.
   * A single short kline fetch could therefore disable the whole tuning pipeline
   * and blame the book for it. `complete5` is disclosed instead
   * (see paritySummary.notEvaluated).
   */
  mismatch: boolean;
}

/** R proximity that used to stand in for a reason match. Now informational. */
export const REASON_TOLERANCE_R = 0.35;

const normalizeReason = (r: string): string =>
  r === "Take Profit" || r === "Stop Loss" || r === "Trail Lock" || r === "R-Lock Max" || r === "Horizon"
    ? r
    : /trail|r-lock/i.test(r)
      ? "Trail Lock"
      : /profit|target/i.test(r)
        ? "Take Profit"
        : /stop|loss/i.test(r)
          ? "Stop Loss"
          : r;

export function checkParity(input: ParityInput): ParityResult {
  const common = {
    side: input.side,
    entryPrice: input.entryPrice,
    slPrice: input.slPrice,
    tpPrice: input.tpPrice,
    lock: input.lock ?? null,
    riskPx: input.riskPx ?? null,
    horizonMs: input.horizonMs,
    entryTime: input.entryTime,
  };
  const five = replayExit({ ...common, bars: input.bars5m });
  const one = replayExit({ ...common, bars: input.bars1m });
  const rec = normalizeReason(input.recordedReason);
  // `judged5` = the 5m replay either reached an exit, or held bars that span the
  // moment the trade actually exited. Only then can its reason be held against
  // the recorded one; anything earlier is silence, not disagreement.
  const lastClose = (bs: readonly ReplayBar[]): number =>
    bs.reduce((m, b) => (Number.isFinite(b.closeTime) && b.closeTime > m ? b.closeTime : m), 0);
  const judged5 = five.complete || lastClose(input.bars5m) >= input.recordedExitTime;
  const reasonMatch5 = five.exitReason === rec;
  const reasonMatch1 = one.exitReason === rec;
  const reasonClose5 = !reasonMatch5 && Math.abs(five.r - input.recordedR) <= REASON_TOLERANCE_R;
  return {
    replay5Reason: five.exitReason,
    replay5R: +five.r.toFixed(4),
    replay1Reason: one.exitReason,
    replay1R: +one.r.toFixed(4),
    reasonMatch5,
    reasonMatch1,
    reasonClose5,
    samplingErrorR: +Math.abs(one.r - five.r).toFixed(4),
    complete5: five.complete,
    complete1: one.complete,
    evaluated: five.complete && one.complete,
    mismatch: judged5 && !reasonMatch5,
  };
}

/**
 * The shipped exit variants, applied to identical entries (spec §Stage 2).
 *
 * REMOVED `variantSpecs` (2026-10-10 audit): it was production-dead, ignored its
 * own `configTpR` argument (`void opts.configTpR`), and duplicated
 * `exit-replay-plan.defaultVariants`, which is the one the backfill actually
 * uses. Two sources of truth for the variant list is how a counterfactual and
 * its report drift apart.
 */
export interface VariantSpec {
  name: string;
  lock: RLockParams | null;
  /** Target in R; null = use the lock's max (entry ± maxR × risk). */
  tpR: number | null;
}

/** Build the concrete bracket for a variant against one entry. */
export function bracketForVariant(args: {
  variant: VariantSpec;
  side: "LONG" | "SHORT";
  entryPrice: number;
  riskPx: number;
  fallbackTpR: number;
}): { lock: RLockParams | null; tpPrice: number } {
  const sign = sideSign(args.side);
  const lock = args.variant.lock && rLockEnabled(args.variant.lock) ? args.variant.lock : null;
  const rTarget = lock ? (lock.maxR > 0 ? lock.maxR : 8) : (args.variant.tpR ?? args.fallbackTpR);
  const tpPrice = args.entryPrice + sign * args.riskPx * rTarget;
  return { lock, tpPrice };
}

/**
 * Aggregate 1m bars up to a coarser interval (5m by default).
 *
 * PARITY NEEDS BOTH CADENCES, and the spec allows only ONE kline fetch a day.
 * MEXC futures trade 24/7 and a 5m boundary is also a 1m boundary, so the 5m
 * series the paper book's r-lock replay consumes is exactly reproducible from
 * the 1m fetch: open = first bar's open, high/low = the window's extremes,
 * close = last bar's close, volume summed. Aggregating instead of fetching is
 * what keeps the request budget to the single daily batch.
 *
 * Partial trailing windows are dropped: a 3-bar stub is not a 5m bar and would
 * let the lock advance on a horizon the fetcher never had.
 */
export function aggregateBars(bars: readonly ReplayBar[], factor: number): ReplayBar[] {
  const f = Math.floor(factor);
  if (!(f > 1)) return [...bars];
  const ordered = [...bars].sort((a, b) => a.openTime - b.openTime);
  if (ordered.length === 0) return [];
  // The source interval is the MODAL gap, not the first one. Reading it off
  // `bars[1] - bars[0]` made a single missing candle at the head of the window
  // redefine the step (60s -> 120s), which changed bucketMs, which made every
  // bucket fail the "exactly f contiguous bars" test below — an EMPTY 5m series
  // out of a perfectly good 1m one. Parity then read "no bars" and reported a
  // mismatch for a trade it never evaluated (see checkParity).
  const gaps = new Map<number, number>();
  for (let i = 1; i < ordered.length; i++) {
    const gap = Math.round(ordered[i]!.openTime - ordered[i - 1]!.openTime);
    if (gap > 0) gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
  }
  const commonest = [...gaps.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
  const stepMs = Math.max(60_000, commonest?.[0] ?? 60_000);
  const bucketMs = stepMs * f;
  const byBucket = new Map<number, ReplayBar[]>();
  for (const b of ordered) {
    // Align to the WALL CLOCK. A 5m bar is 12:00:00–12:04:59 wherever the
    // fetched window happens to start: anchoring on bars[0] would shift every
    // bucket by (start mod bucketMs) and price the lock on a window the book
    // never used, turning real cadence into fake parity error.
    const key = Math.floor(b.openTime / bucketMs) * bucketMs;
    const list = byBucket.get(key);
    if (list) list.push(b);
    else byBucket.set(key, [b]);
  }
  const out: ReplayBar[] = [];
  for (const [openTime, win] of [...byBucket.entries()].sort((a, b) => a[0] - b[0])) {
    // A bucket is a real bar only when every source step inside it is present
    // AND contiguous. Checking only the first gap (as before) let a hole in the
    // middle produce a "5m" bar spanning 10+ minutes, advancing the lock on a
    // horizon that never existed.
    if (win.length !== f) continue;
    let contiguous = true;
    for (let i = 1; i < win.length; i++) {
      if (Math.round(win[i]!.openTime - win[i - 1]!.openTime) !== stepMs) {
        contiguous = false;
        break;
      }
    }
    if (!contiguous) continue;
    const first = win[0]!;
    const last = win[win.length - 1]!;
    out.push({
      openTime: first.openTime,
      closeTime: last.closeTime,
      open: first.open,
      high: Math.max(...win.map((b) => b.high)),
      low: Math.min(...win.map((b) => b.low)),
      close: last.close,
    });
  }
  return out;
}
