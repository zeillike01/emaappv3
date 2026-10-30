/**
 * R-LOCK TRAILING EXIT — shared pure logic (2026-09-20).
 *
 * WHY THIS EXISTS
 * An audit of the paper book's 96 stop-outs against the 15m EMA30 found the
 * losing cohort is not "entries with no trend" (that degeneracy is already
 * priced — those cohorts net ~break-even because their wins average 1.69R).
 * It is trades that RAN and then gave it back: 74% of stop-outs saw price
 * trade back through the 15m EMA30 with the EMA30 slope rolling over, after
 * the position had already been in profit.
 *
 * A fixed 2R target cannot exploit that: it truncates the right tail, while
 * the 1.5% stop eats the base. Measured on the project's own backtest engine
 * (25 pairs, 2026-05-28 → 09-13, 1,878 out-of-sample signals, net of fees):
 *
 *   fixed 2R target            -0.062 R/trade   (-111.5R)
 *   best fixed TP (1.25R)      -0.047 R/trade    (-90.4R)
 *   R-lock from 1.5R, 0.25 step +0.038 R/trade   (+70.6R)
 *
 * The gain is the tail the fixed target cannot reach: 110 out-of-sample
 * trades exited above 2R under the lock, none could under a 2R cap. It held
 * in-sample (+0.139), in all five out-of-sample months, on both sides, and
 * across a PLATEAU of parameters (start 1.0-2.0R, either step size, any max
 * from 3R to 12R) rather than a single tuned value.
 *
 * 6-MONTH RE-RUN (2026-09-20, src/lib/run-6m-rlock-backtest.ts): the same
 * measurement over 2026-03-20 → 09-19 (25 era-frozen pairs, 3,071/3,212
 * trades) reproduces the window above almost exactly — sub-window parity
 * −0.064 R/t vs the documented −0.062, +0.032 vs +0.038 — and holds for the
 * full six months: fixed 2R −0.065 R/t (−199.8R) vs the shipped lock
 * 1.5R/0.25/6R +0.026 R/t (+82.9R). The lock beat FIXED in all 7 months, both
 * sides, 20 of 25 pairs, and every member of the fixed-TP family (1.0R −0.070
 * … 3.0R −0.090); paired-day test t = 5.62. The edge is somewhat smaller over
 * the longer window (lock +0.026 R/t vs the documented +0.038; Δ vs fixed
 * +0.091 vs +0.100) and the step-size arm of the plateau is not uniform
 * (step 0.25R is the good end at +0.026, step 0.5R +0.011, step 1R ~flat to
 * slightly negative) — so treat 0.25R as load-bearing, not arbitrary. Note the
 * lock does not make a losing month profitable (April 2026 stays −0.311 R/t):
 * it reduces the loss.
 *
 * SEMANTICS — deliberately identical to `src/lib/backtest.ts` (tpMode
 * "rlock"), which is where the numbers above were measured:
 *   0. if this sample already breached the ORIGINAL stop, stand down and let
 *      the book's own stop logic own the outcome (the backtest tests
 *      `bar.low <= slPrice` before it tests the lock, precisely so a bar that
 *      hit BOTH books −1R rather than the rung);
 *   1. breach of the STORED lock is checked against the current price, BEFORE
 *      this sample may ratchet the lock (the backtest checks within-bar low
 *      vs the previous bar's lock);
 *   2. then the max-target full exit, on the current price;
 *   3. only then does the sample update the peak and ratchet the lock.
 * The lock ratchets one-way only. `startR <= 0` disables the lock entirely,
 * in which case the caller keeps its fixed TP unchanged.
 *
 * Ordering note: the host engines poll on a 5-minute cadence, so one sample
 * is one price, not a bar's high/low. A caller wanting exact backtest parity
 * feeds low then high in that order — which is what `rLockBarStep` does, and why
 * `src/lib/backtest.ts` now calls `rLockBarStep` itself. The two cannot drift:
 * the equivalence is pinned by src/lib/__tests__/r-lock-engine-parity.test.ts.
 *
 * FROZEN RULER (2026-09-21) — `riskPx`
 * R is defined here as |entryPrice − slPrice|, which is correct but not STABLE.
 * The live book refines a trade's entryPrice to the exchange's average fill once
 * the position becomes visible (liveExitTick → refineLiveEntry), and every later
 * tick re-derived R from that new price — re-scaling the ruler underneath a
 * trailPeakR / trailLockPrice that had been stored on the old one. At a 1.5%
 * stop the refinement threshold (0.05%) is ~0.03R of silent lock drift.
 * Callers that PERSIST R state pass `riskPx` — 1R in price, captured at entry
 * and never changed — and the ruler becomes immutable: the divisor IS riskPx and
 * the anchor is reconstructed from (slPrice, riskPx, side), so refining the
 * reported entry price can no longer move a rung. Omitting riskPx keeps the
 * previous behaviour exactly (the backtest does: its entries never move).
 */

export type RLockParams = {
  /** R multiple at which locking starts. <= 0 = lock off. */
  startR: number;
  /** Ratchet step in R (lock jumps to each whole step once past startR). */
  stepR: number;
  /** Full-exit level in R — replaces the fixed TP while the lock is on. */
  maxR: number;
};

export type RLockState = {
  /** Best R multiple reached since entry. */
  peakR: number;
  /** Current locked exit price (0 = not locked yet). */
  lockPrice: number;
};

export type RLockOutcome = {
  peakR: number;
  lockPrice: number;
  /** Locked R multiple; 0 when not locked yet. */
  lockR: number;
  /** True when peakR/lockPrice moved and should be persisted. */
  changed: boolean;
  /**
   * Set when this sample should close the position.
   *
   * `rungPrice` is the LEVEL that was breached, for logging/attribution ONLY —
   * it is NOT the fill price. The host closes at market at the `price` it
   * sampled, so it must book the fill there (plus stop-style slippage). The
   * backtest books at the rung because it assumes a resting order; a 5-minute
   * poll does not get one, and booking at the rung would flatter both books and
   * make paper disagree with what live actually fills.
   */
  exit: { reason: "Trail Lock" | "R-Lock Max"; rungPrice: number; lockR: number } | null;
  /**
   * True when THIS SAMPLE breached the original stop (step 0). Additive: the
   * caller decides what to book. The backtest books −1R here, the live book's
   * exchange bracket fills it, and the paper book (which has no bracket) needs
   * this flag to stop a ticker sample from silently outliving its own stop.
   *
   * Deliberately reported on the DISABLED-lock early return too: whether the
   * stop was breached is a property of the sample, not of the lock params.
   */
  stopBreached: boolean;
};

/** True when a lock parameter set actually enables the trailing exit. */
export function rLockEnabled(params?: Partial<RLockParams> | null): boolean {
  const start = Number(params?.startR ?? 0);
  return Number.isFinite(start) && start > 0;
}

/**
 * Advance the R-lock on one price sample.
 *
 * Pure: no I/O, no clock. The caller persists `peakR`/`lockPrice` and acts on
 * `exit`. `state` may be partial/absent for a fresh position.
 */
export function rLockStep(args: {
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  price: number;
  /**
   * Frozen 1R distance in price, captured at entry (liveTrades.riskPx). When
   * present and positive it IS the ruler, and the entry the trade is measured
   * from is derived as slPrice ± riskPx — so a later entry refinement cannot
   * re-scale the lock. See the FROZEN RULER note above.
   */
  riskPx?: number | null;
  params?: Partial<RLockParams> | null;
  state?: Partial<RLockState> | null;
}): RLockOutcome {
  const sideSign = args.side === "LONG" ? 1 : -1;
  const frozen = Number(args.riskPx);
  const frozenOk = Number.isFinite(frozen) && frozen > 0;
  const risk = frozenOk ? frozen : Math.abs(args.entryPrice - args.slPrice);
  // Anchor: with a frozen ruler the entry is reconstructed from the stop it was
  // measured against, so the denominator and the origin are frozen together.
  const entry =
    frozenOk && args.slPrice > 0 ? args.slPrice + sideSign * frozen : args.entryPrice;
  const prevPeak = Number.isFinite(args.state?.peakR) ? Number(args.state!.peakR) : 0;
  const prevLock = Number.isFinite(args.state?.lockPrice) ? Number(args.state!.lockPrice) : 0;
  const startR = Number(args.params?.startR ?? 0);
  const maxR = Number(args.params?.maxR ?? 0);
  const rawStep = Number(args.params?.stepR ?? 0);

  // Computed BEFORE the guards below, so every return path (including the
  // lock-disabled one) reports the same breach fact for the same sample.
  const stopBreached =
    args.price > 0 &&
    args.slPrice > 0 &&
    (sideSign > 0 ? args.price <= args.slPrice : args.price >= args.slPrice);

  const idle: RLockOutcome = {
    peakR: prevPeak,
    lockPrice: prevLock,
    lockR: 0,
    changed: false,
    exit: null,
    stopBreached,
  };
  if (!(risk > 0) || !(args.price > 0) || !(startR > 0)) return idle;

  const step = rawStep > 0 ? rawStep : 1;
  const curR = (sideSign * (args.price - entry)) / risk;

  // 0. Stop already breached on this sample? Stand down — the book's own stop
  //    logic closes it (and the exchange bracket would have fired first on the
  //    live book). Without this the lock would book the rung on a sample that
  //    also gapped through the stop, which is exactly the optimism the backtest
  //    guards against by testing the stop before the lock.
  if (stopBreached) return idle;

  // 1. Stored lock breached? (checked before any ratchet from this sample)
  const lockHit =
    prevLock > 0 && (sideSign > 0 ? args.price <= prevLock : args.price >= prevLock);
  if (lockHit) {
    return {
      peakR: Math.max(prevPeak, curR),
      lockPrice: prevLock,
      lockR: (sideSign * (prevLock - entry)) / risk,
      changed: false,
      exit: {
        reason: "Trail Lock",
        rungPrice: prevLock,
        lockR: (sideSign * (prevLock - entry)) / risk,
      },
      stopBreached: false,
    };
  }

  // 2. Max-target full exit.
  if (maxR > 0 && curR >= maxR) {
    return {
      peakR: Math.max(prevPeak, curR),
      lockPrice: prevLock,
      lockR: maxR,
      changed: false,
      exit: {
        reason: "R-Lock Max",
        rungPrice: entry + sideSign * risk * maxR,
        lockR: maxR,
      },
      stopBreached: false,
    };
  }

  // 3. Ratchet the peak, then the lock.
  const peakR = Math.max(prevPeak, curR);
  let lockPrice = prevLock;
  let lockR = 0;
  if (peakR >= startR) {
    lockR = startR + Math.floor((peakR - startR) / step) * step;
    if (maxR > 0 && lockR > maxR) lockR = maxR;
    const candidate = entry + sideSign * risk * lockR;
    // One-way: the lock may only move in the trade's favour. `0` means unset,
    // and for a SHORT every locked price is BELOW entry — so an unset lock
    // must be replaced unconditionally rather than compared numerically.
    if (lockPrice === 0 || (sideSign > 0 ? candidate > lockPrice : candidate < lockPrice)) {
      lockPrice = candidate;
    }
  }
  return {
    peakR,
    lockPrice,
    lockR,
    changed: peakR !== prevPeak || lockPrice !== prevLock,
    exit: null,
    stopBreached: false,
  };
}

// ── PER-BAR STEP — THE SHARED UNIT OF PARITY (2026-09-22) ───────────────────
export interface RLockBarStepResult {
  peakR: number;
  lockPrice: number;
  exit: { reason: "Trail Lock" | "R-Lock Max"; rungPrice: number; lockR: number } | null;
  /**
   * True when this bar's ADVERSE extreme breached the original stop, and the
   * bar produced no lock exit. See the STOP-FIDELITY note below.
   */
  stopBreached: boolean;
}

/**
 * Advance the lock by ONE closed bar, adverse side first.
 *
 * This is the smallest shared unit: `src/lib/backtest.ts` (tpMode "rlock") and
 * `rLockReplayBars` BOTH call it, so the harness that MEASURED the lock and the
 * hosts that TRADE it cannot drift. That matters here more than in most places,
 * because they already had: the harness ranged over a bar's high and low, while
 * the books sampled one spot price per tick, and the live ledger shows the cost
 * in its own rows (stored peaks under-recording the true excursion on 14 of 23
 * measurable rows, 6 rows booking more R than their recorded peak allowed).
 *
 * It is also why a bar that ARMS the lock cannot breach it: the adverse price is
 * tested against the previous rung before that same bar's favourable price may
 * ratchet anything. The original stop stays the caller's (the harness closes at
 * its stop, live's exchange bracket fires) — `rLockStep` only stands down when a
 * sample has already breached it.
 *
 * STOP FIDELITY (2026-09-22) — why `stopBreached` is surfaced here.
 * "The original stop stays the caller's" is only true when the caller HAS one.
 * The backtest books −1R. The live book's exchange bracket fills the wick. But
 * paper has NO bracket: its stop is a single price sampled from the batched
 * ticker every 5 minutes, so a wick that touches the stop and recovers inside
 * that window is invisible and the trade lives on. The replay was already
 * computing `bar.low <= slPrice` on EVERY 5-minute bar and then throwing the
 * answer away, which made paper the one book whose stops were not bar-accurate.
 * This flag hands the caller that fact; who books it stays the caller's call.
 *
 * The breach is reported ONLY when the bar produced no lock exit, so a bar that
 * spans both the rung and the stop keeps the rung (the pre-existing behaviour,
 * and the one the lock's +0.026 R/t edge was measured under). That residual
 * rung-favouring case is counted by `run-paper-stop-fidelity-lab.ts` rather
 * than silently repriced.
 */
export function rLockBarStep(args: {
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  riskPx?: number | null;
  params?: Partial<RLockParams> | null;
  bar: { high: number; low: number };
  state?: Partial<RLockState> | null;
}): RLockBarStepResult {
  const isLong = args.side === "LONG";
  // Adverse first (the side that can breach the lock), then favourable (the side
  // that advances the peak) — the backtest's within-bar ordering.
  const prices = isLong ? [args.bar.low, args.bar.high] : [args.bar.high, args.bar.low];
  let state: RLockState = {
    peakR: Number(args.state?.peakR) || 0,
    lockPrice: Number(args.state?.lockPrice) || 0,
  };
  let stopBreached = false;

  for (const price of prices) {
    const s = rLockStep({
      side: args.side,
      entryPrice: args.entryPrice,
      slPrice: args.slPrice,
      price,
      riskPx: args.riskPx,
      params: args.params,
      state,
    });
    state = { peakR: s.peakR, lockPrice: s.lockPrice };
    if (s.stopBreached) stopBreached = true;
    if (s.exit) {
      return {
        peakR: state.peakR,
        lockPrice: state.lockPrice,
        exit: { reason: s.exit.reason, rungPrice: s.exit.rungPrice, lockR: s.exit.lockR },
        stopBreached: false, // a lock exit owns the bar; see STOP FIDELITY
      };
    }
  }

  return { peakR: state.peakR, lockPrice: state.lockPrice, exit: null, stopBreached };
}

// ── BAR REPLAY (2026-09-22 audit) ────────────────────────────────────────────
//
// WHY. The live/paper r-lock tick used to advance the lock from ONE spot price
// per run (the batched ticker's `last`). A 5-minute cron sampling a single
// price cannot see what the bar did between runs, so `trailPeakR` was a lower
// bound on the true excursion — and the lock therefore armed LATER (or never)
// than the mechanic that was actually measured. The live ledger proves it in
// its own data: on 6 of 61 r-lock-era rows, `realizedR > trailPeakR`, which is
// mechanically impossible if the peak tracker had seen every price the exit
// saw (e.g. SUI −: peak recorded 1.71R, booked +3.16R).
//
// WHAT. Replay each CLOSED bar's extremes through `rLockStep` in the
// **adverse-then-favourable** order the backtest engine (`tpMode: "rlock"`)
// uses — for a LONG the low is tested first, then the high — so one bar
// contributes its worst price to the lock check before its best price to the
// peak. That ordering is the whole reason a bar that arms the lock cannot also
// exit on the same bar: the low is checked while the previous lock is still 0.
//
// POLY: replaying the SAME bars from `sinceOpenTime` with a fresh state is
// DETERMINISTIC and idempotent, so a caller can re-replay the whole trade on
// every tick without a watermark or any other persisted cursor: the result is
// identical, and a tick that never ran simply self-heals on the next one.
// Replaying an OVERLAPPING window would NOT be safe (a bar whose low preceded
// the lock it later armed would fire a spurious exit) — which is exactly why
// this takes a `sinceOpenTime` lower bound and callers pass the trade's entry.

export interface RLockBar {
  openTime: number;
  closeTime: number;
  high: number;
  low: number;
}

export const RLOCK_REPLAY_BAR_MS = 5 * 60_000;

/**
 * Prove that a fetched window is safe to use as the next replay segment.
 * A partial/gapped window must not replace a previously accumulated peak with
 * a lower one. `cursor` is the close time of the last bar already incorporated;
 * when present, the first returned bar must be the next 5m bar. When absent,
 * the window must start at or before entry and reach the newest closed bar.
 */
export function validateReplayCoverage(args: {
  bars: readonly RLockBar[];
  entryTime: number;
  now: number;
  cursor?: number | null;
}): { ok: boolean; reason?: string; lastBarTime: number; barsRead: number } {
  const closed = args.bars
    .filter((b) => b.closeTime <= args.now && b.openTime > 0 && b.closeTime > b.openTime)
    .slice()
    .sort((a, b) => a.openTime - b.openTime);
  if (closed.length === 0) return { ok: false, reason: "no closed bars", lastBarTime: 0, barsRead: 0 };

  const latestExpected = Math.floor((args.now - 1) / RLOCK_REPLAY_BAR_MS) * RLOCK_REPLAY_BAR_MS;
  const newest = closed[closed.length - 1]!;
  if (newest.openTime !== latestExpected) {
    return { ok: false, reason: "window does not reach newest closed bar", lastBarTime: 0, barsRead: 0 };
  }

  const start = args.cursor == null ? args.entryTime : args.cursor;
  const first = args.cursor == null ? closed[0]! : closed.find((b) => b.openTime >= start);
  if (!first) return { ok: false, reason: "window does not reach replay cursor", lastBarTime: 0, barsRead: 0 };
  if (args.cursor == null && first.openTime > args.entryTime) {
    return { ok: false, reason: "window starts after entry", lastBarTime: 0, barsRead: 0 };
  }
  if (args.cursor != null && first.openTime !== start) {
    return { ok: false, reason: "window has a gap at replay cursor", lastBarTime: 0, barsRead: 0 };
  }

  const segment = closed.filter((b) => b.openTime >= start);
  if (segment.length === 0) return { ok: false, reason: "no bars after replay start", lastBarTime: 0, barsRead: 0 };
  for (let i = 1; i < segment.length; i++) {
    if (segment[i]!.openTime - segment[i - 1]!.openTime !== RLOCK_REPLAY_BAR_MS) {
      return { ok: false, reason: "window contains a 5m gap", lastBarTime: 0, barsRead: 0 };
    }
  }
  return { ok: true, lastBarTime: newest.closeTime, barsRead: segment.length };
}

export interface RLockReplayResult {
  /** Peak R after the last bar (0 when nothing was read). */
  peakR: number;
  /** Locked price after the last bar (0 = never armed). */
  lockPrice: number;
  /** True when the replayed bars moved the peak or the lock. */
  changed: boolean;
  /** First exit across the replayed bars, if any. */
  exit: {
    reason: "Trail Lock" | "R-Lock Max";
    rungPrice: number;
    lockR: number;
    /** closeTime of the bar the breach was found on. */
    atTime: number;
  } | null;
  /**
   * First bar whose ADVERSE extreme breached the original stop, when that bar
   * produced no lock exit — i.e. the bar that should have closed the trade at
   * −1R and, on the paper book, was being swallowed by the ticker sample.
   * Mutually exclusive with `exit`: whichever happened first is the one set.
   */
  stopBreach: {
    /** closeTime of the bar that breached the stop. */
    atTime: number;
    /** The breach price — the bar's adverse extreme, NOT the stop level. */
    price: number;
  } | null;
  /** closeTime of the newest bar consumed (0 when none qualified). */
  lastBarTime: number;
  /** Bars actually replayed. */
  barsRead: number;
}

/**
 * Replay closed bars through the lock, adverse-before-favourable.
 *
 * Bars whose `openTime` precedes `sinceOpenTime` are skipped: the bar open at
 * entry is deliberately excluded, because its low may well have printed before
 * the fill and the trade cannot be stopped by a price it never owned. That is
 * the only concession — every later bar is replayed in full.
 */
export function rLockReplayBars(args: {
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  riskPx?: number | null;
  params?: Partial<RLockParams> | null;
  bars: RLockBar[];
  /** Only bars OPENING at/after this are replayed (pass the trade's entryTime). */
  sinceOpenTime: number;
  /** Previously persisted state for an incremental, cursor-validated replay. */
  state?: Partial<RLockState> | null;
}): RLockReplayResult {
  const ordered = [...args.bars]
    .filter((b) => b.openTime >= args.sinceOpenTime)
    .sort((a, b) => a.openTime - b.openTime);

  let state: RLockState = {
    peakR: Number(args.state?.peakR) || 0,
    lockPrice: Number(args.state?.lockPrice) || 0,
  };
  let lastBarTime = 0;
  let barsRead = 0;

  for (const bar of ordered) {
    if (!(bar.high > 0) || !(bar.low > 0)) continue;
    barsRead++;
    lastBarTime = bar.closeTime;
    // ONE bar, ONE call — the same `rLockBarStep` the backtest engine runs, so
    // the replayed decision and the measured one are the same code path.
    const step = rLockBarStep({
      side: args.side,
      entryPrice: args.entryPrice,
      slPrice: args.slPrice,
      riskPx: args.riskPx,
      params: args.params,
      bar,
      state,
    });
    state = { peakR: step.peakR, lockPrice: step.lockPrice };
    if (step.exit) {
      return {
        peakR: state.peakR,
        lockPrice: state.lockPrice,
        changed: true,
        exit: { ...step.exit, atTime: bar.closeTime },
        stopBreach: null,
        lastBarTime,
        barsRead,
      };
    }
    if (step.stopBreached) {
      // The trade is over: a stop-out ends the replayed life, so later bars are
      // not consumed (they would only ratchet a peak the position never owned).
      return {
        peakR: state.peakR,
        lockPrice: state.lockPrice,
        changed: true,
        exit: null,
        stopBreach: {
          atTime: bar.closeTime,
          price: args.side === "LONG" ? bar.low : bar.high,
        },
        lastBarTime,
        barsRead,
      };
    }
  }

  return {
    peakR: state.peakR,
    lockPrice: state.lockPrice,
    changed: state.peakR > 0 || state.lockPrice > 0,
    exit: null,
    stopBreach: null,
    lastBarTime,
    barsRead,
  };
}

/** Locked R multiple implied by a lock price, for display/reporting. 0 when unlocked. */
export function lockRFromPrice(args: {
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  lockPrice: number;
}): number {
  const risk = Math.abs(args.entryPrice - args.slPrice);
  if (!(risk > 0) || !(args.lockPrice > 0)) return 0;
  const sideSign = args.side === "LONG" ? 1 : -1;
  return (sideSign * (args.lockPrice - args.entryPrice)) / risk;
}

// ── EXCHANGE-STOP AMEND (2026-09-26 live exit fix) ──────────────────────────
/**
 * Decide whether the exchange's protective SL should be MOVED to the current
 * locked rung, and in which direction.
 *
 * THE BUG THIS FIXES: the live ledger ratchets `trailLockPrice` every 5-minute
 * pass, but the exchange bracket stayed at the ORIGINAL −1R stop forever. A
 * trade that ran and retraced got stopped at the exchange's original level for
 * −1R while the ledger held a banked rung (+1.5R…): paper's Trail-Lock wins
 * became live Stop-Loss losses on identical signals (measured 2026-09-26: 3
 * win→loss flips, SL rate 62% live vs 50% paper on the same signals). With the
 * stop amended to the rung, the exchange — a sub-second resting trigger — owns
 * every banked rung instead of the 5-minute poll.
 *
 * PURE AND SIDE-AWARE. Movement is ONE-WAY only (tighten): a LONG stop may only
 * rise, a SHORT stop may only fall. A stale sample, an overlapping cron, or a
 * replayed close can therefore never walk a protective stop back toward the
 * entry and resurface a loss the lock had already banked. Price rounding is
 * the caller's job (the exchange has per-contract price units).
 */
export type StopAmendDecision = {
  /** True when the exchange SL must be replaced at `amendPrice`. */
  amend: boolean;
  /** The new stop level (the locked rung). NaN/0 when amend is false. */
  amendPrice: number;
  /** "tighten" when moving the stop closer to entry (favourable); "replace" when setting the first rung on a stop at the original level. */
  kind: "tighten" | "replace";
  /** Locked R multiple the new stop represents (for logging/audit). */
  lockR: number;
};

export function stopAmendDecision(args: {
  side: "LONG" | "SHORT";
  /** Current locked rung in price (trade.trailLockPrice). 0 = not locked. */
  lockPrice: number;
  /** The stop level the exchange is currently resting at (trade.exchangeSlPrice ?? trade.slPrice). */
  exchangeSlPrice: number | null | undefined;
  entryPrice: number;
  /** Frozen 1R in price (trade.riskPx) — for the audit-only lockR figure. */
  riskPx?: number | null;
  /** Relative movement below which the exchange is not disturbed (default 0.02%). */
  epsPct?: number;
}): StopAmendDecision {
  const idle: StopAmendDecision = { amend: false, amendPrice: NaN, kind: "tighten", lockR: 0 };
  const lock = Number(args.lockPrice);
  if (!(lock > 0)) return idle; // nothing banked — nothing to move
  const sideSign = args.side === "LONG" ? 1 : -1;
  const cur = Number(args.exchangeSlPrice);
  if (!(cur > 0)) return idle; // no known resting level — never blind-amend
  const entry = Number(args.entryPrice);
  if (!(entry > 0)) return idle;
  const eps = (Number(args.epsPct) > 0 ? Number(args.epsPct) : 0.0002) * entry;
  // The rung must sit on the FAVOURABLE side of the current exchange stop.
  // Anything else (a stale lock, a crossing pair) is refused, not clamped.
  const favourable = sideSign > 0 ? lock > cur + eps : lock < cur - eps;
  if (!favourable) return idle;
  const riskPx = Number(args.riskPx);
  const risk = Number.isFinite(riskPx) && riskPx > 0 ? riskPx : Math.abs(entry - cur);
  // "replace" = the exchange stop is still at/beyond the ORIGINAL adverse
  // level (never been in profit); "tighten" = it already sits in profit.
  const curAdverse = sideSign > 0 ? cur <= entry : cur >= entry;
  return {
    amend: true,
    amendPrice: lock,
    kind: curAdverse ? "replace" : "tighten",
    lockR: risk > 0 ? (sideSign * (lock - entry)) / risk : 0,
  };
}
