/**
 * SHADOW BOOK — off-chain exit-policy evaluator (pure, no I/O).
 *
 * WHY: the live book runs one fixed bracket (SL 1.5% / TP 2.5% = 1:1.67R).
 * Testing an alternative exit policy — e.g. "scale out half at 1:2.5, run the
 * rest to 1:5 with the stop at breakeven" — normally means a second engine
 * writing a second set of trade rows every tick. That costs cron time and
 * Convex I/O for a question that is pure arithmetic over klines we already
 * hold on disk.
 *
 * So: NO cron, NO Convex writes. This module replays a policy over the book's
 * REAL entries using the local kline cache (see run-shadow-book.ts). It is a
 * deterministic backtest of the exit policy, holding entry selection constant
 * so the exit policy is the only variable.
 *
 * DESIGN NOTES
 *  - The risk unit is the trade's own real stop distance (|entry − sl|), so
 *    "1R" here means exactly what it means in the ledger. A policy that
 *    changes the stop distance is expressed in R (targets), never by moving
 *    the stop, which keeps shadow R comparable to realized R.
 *  - Intrabar ordering is CONSERVATIVE: when a bar's range spans both the stop
 *    and a target, the stop is assumed to hit first. This understates the
 *    policy rather than flattering it, matching the replay convention already
 *    used in this repo's post-mortems.
 *  - Partial scale-outs are weighted by fraction; the pre-first-target stop is
 *    a full-position stop, so a trade that dies before the first target always
 *    loses exactly 1R regardless of the scale-out split.
 *
 * Keep this file pure (no node:fs, no fetch) so it stays unit-testable.
 */

export type ShadowPolicy = {
  /** Human label, used in reports. */
  name: string;
  /** Fraction of the position scaled out at the first target (0..1). */
  firstFraction: number;
  /** First target, in multiples of the risk unit. */
  firstTargetR: number;
  /** Runner target, in multiples of the risk unit. */
  runnerTargetR: number;
  /** Move the stop to breakeven once the first target fills. */
  breakEvenAfterFirst: boolean;
  /** Give up after this many bars and mark to market. */
  horizonBars: number;
};

/** The variant under evaluation: 50% @1:2.5 + 50% runner to 1:5, BE after. */
export const SCALE_OUT_POLICY: ShadowPolicy = {
  name: "50% @1:2.5 + 50% runner to 1:5, BE after",
  firstFraction: 0.5,
  firstTargetR: 2.5,
  runnerTargetR: 5,
  breakEvenAfterFirst: true,
  horizonBars: 96, // 24h of 15m bars
};

/** The book's live bracket, as a reference policy (SL 1.5% / TP 2.5%). */
export const LIVE_BRACKET_POLICY: ShadowPolicy = {
  name: "live bracket (SL 1.5% / TP 2.5%)",
  firstFraction: 1,
  firstTargetR: 1.667,
  runnerTargetR: 1.667,
  breakEvenAfterFirst: false,
  horizonBars: 96,
};

export type ShadowTradeInput = {
  id: string;
  coin: string;
  side: "LONG" | "SHORT";
  entryTime: number;
  entryPrice: number;
  slPrice: number;
  /** The book's realized outcome, for side-by-side comparison. */
  realizedR: number;
  realizedPnlUsd?: number;
  /** "closed" | "open" | anything else the ledger uses. */
  status: string;
  session?: string;
  exitTime?: number;
};

export type ShadowBar = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type ShadowExitReason =
  | "tp1+tp2" // first target filled, runner reached its target
  | "tp1+breakeven" // first target filled, runner scratched at BE (only with breakEvenAfterFirst)
  | "tp1+stop" // first target filled, runner stopped out below BE
  | "tp1+timeout" // first target filled, runner still open at the horizon
  | "stop" // stopped before the first target — full-position loss
  | "timeout"; // never reached the first target, marked to market at the horizon

export type ShadowResult = {
  id: string;
  coin: string;
  side: "LONG" | "SHORT";
  entryTime: number;
  session?: string;
  /** The book's actual realized R. */
  realR: number;
  /** The policy's R for the same entry. */
  shadowR: number;
  reason: ShadowExitReason;
  /** Bars the policy held for (or the horizon, on a timeout). */
  barsHeld: number;
  /** Bars actually available from the cache from entry onward. */
  barsAvailable: number;
  /**
   * False when the cache ran out before the policy could resolve — the result
   * is a partial mark-to-market and must be excluded from headline numbers.
   */
  covered: boolean;
  /** Did each target fill at any point? */
  tp1Filled: boolean;
  tp2Filled: boolean;
};

const direction = (side: "LONG" | "SHORT") => (side === "LONG" ? 1 : -1);

/** Does a favourable extreme reach a target level? (LONG targets sit above, SHORT below.) */
const reaches = (side: "LONG" | "SHORT", favourable: number, level: number) =>
  side === "LONG" ? favourable >= level : favourable <= level;

/**
 * Does an adverse extreme reach the stop? The stop always sits on the losing
 * side of the entry, so this is the INVERSE comparison to `reaches` — using
 * `reaches` here would report a stop on any normal bar.
 */
const stoppedAt = (side: "LONG" | "SHORT", adverse: number, stop: number) =>
  side === "LONG" ? adverse <= stop : adverse >= stop;

/** R multiple of a price, given the entry and risk unit. */
export function rMultiple(entry: number, risk: number, side: "LONG" | "SHORT", price: number): number {
  return (direction(side) * (price - entry)) / risk;
}

/**
 * Replay one trade under a policy.
 *
 * `bars` must be closed 15m bars starting at (or just before) the entry bar and
 * running forward. `bars[0]` is treated as the entry bar: the policy can be
 * stopped out on it, but the entry price is the trade's actual entry, not the
 * bar open.
 */
export function simulateShadowTrade(
  trade: ShadowTradeInput,
  bars: ShadowBar[],
  policy: ShadowPolicy,
): ShadowResult {
  const { side, entryPrice, slPrice } = trade;
  const risk = Math.abs(entryPrice - slPrice);
  const dir = direction(side);
  const n = Math.min(policy.horizonBars, bars.length);
  const barsAvailable = bars.length;

  const tp1 = entryPrice + dir * risk * policy.firstTargetR;
  const tp2 = entryPrice + dir * risk * policy.runnerTargetR;

  let booked = 0;
  let tp1Filled = false;
  let tp2Filled = false;
  let stop = slPrice;
  let reason: ShadowExitReason = "timeout";
  let barsHeld = n;
  let resolved = false;

  // A zero/nonsensical risk makes every R infinite — report a flat scratch.
  if (!(risk > 0) || !(entryPrice > 0)) {
    return {
      id: trade.id,
      coin: trade.coin,
      side,
      entryTime: trade.entryTime,
      session: trade.session,
      realR: trade.realizedR,
      shadowR: 0,
      reason: "timeout",
      barsHeld: 0,
      barsAvailable,
      covered: false,
      tp1Filled: false,
      tp2Filled: false,
    };
  }

  for (let i = 0; i < n; i++) {
    const bar = bars[i];
    const favourable = side === "LONG" ? bar.high : bar.low;
    const adverse = side === "LONG" ? bar.low : bar.high;

    if (!tp1Filled) {
      const hitTp1 = reaches(side, favourable, tp1);
      const hitStop = stoppedAt(side, adverse, stop);

      if (hitTp1 && hitStop) {
        // Conservative: the stop is assumed to fill first.
        booked += -1;
        reason = "stop";
        barsHeld = i + 1;
        resolved = true;
        break;
      }
      if (hitStop) {
        booked += -1;
        reason = "stop";
        barsHeld = i + 1;
        resolved = true;
        break;
      }
      if (hitTp1) {
        booked += policy.firstFraction * policy.firstTargetR;
        tp1Filled = true;
        if (policy.breakEvenAfterFirst) stop = entryPrice;
      }
    }

    if (tp1Filled) {
      const hitTp2 = reaches(side, favourable, tp2);
      const hitRunnerStop = stoppedAt(side, adverse, stop);
      const runnerWeight = 1 - policy.firstFraction;

      if (hitTp2 && hitRunnerStop) {
        booked += runnerWeight * rMultiple(entryPrice, risk, side, stop);
        reason = stop === entryPrice ? "tp1+breakeven" : "tp1+stop";
        barsHeld = i + 1;
        resolved = true;
        break;
      }
      if (hitRunnerStop) {
        booked += runnerWeight * rMultiple(entryPrice, risk, side, stop);
        reason = stop === entryPrice ? "tp1+breakeven" : "tp1+stop";
        barsHeld = i + 1;
        resolved = true;
        break;
      }
      if (hitTp2) {
        booked += runnerWeight * policy.runnerTargetR;
        tp2Filled = true;
        reason = "tp1+tp2";
        barsHeld = i + 1;
        resolved = true;
        break;
      }
    }
  }

  if (!resolved) {
    const last = bars[Math.min(n, bars.length) - 1];
    const openWeight = tp1Filled ? 1 - policy.firstFraction : 1;
    if (last) booked += openWeight * rMultiple(entryPrice, risk, side, last.close);
    reason = tp1Filled ? "tp1+timeout" : "timeout";
    barsHeld = n;
  }

  return {
    id: trade.id,
    coin: trade.coin,
    side,
    entryTime: trade.entryTime,
    session: trade.session,
    realR: trade.realizedR,
    shadowR: booked,
    reason,
    barsHeld,
    barsAvailable,
    covered: barsAvailable >= policy.horizonBars,
    tp1Filled,
    tp2Filled,
  };
}

// ── Live (tick-driven) shadow ───────────────────────────────────────────────
//
// The offline replay above resolves a policy against closed 15m BARS. A live
// shadow instead sees whatever price the existing 5-minute exit cron happens to
// sample, so it needs a state machine that can advance one observation at a
// time and be resumed from persisted state. Same policy, same arithmetic —
// only the observation source differs.
//
// Trade-off worth knowing: the bar replay is conservative (a bar spanning the
// stop and a target is scored as a stop) while the live tick is *sampled* (it
// can miss an intrabar spike entirely). They answer the same question from
// opposite sides and will not agree to the cent.

export type ShadowLiveState = {
  /** Has the scaled-out portion already been banked? */
  tp1Filled: boolean;
  /** R already banked by the scaled-out portion (0 until the first target). */
  bankedR: number;
};

export const EMPTY_SHADOW_LIVE_STATE: ShadowLiveState = { tp1Filled: false, bankedR: 0 };

export type ShadowLiveOutcome = {
  /** The state to persist (unchanged when `changed` is false). */
  state: ShadowLiveState;
  /** Set when the shadow leg finishes on this observation. */
  resolved: null | { reason: ShadowExitReason; totalR: number };
  /** True when the caller must persist `state` because it moved. */
  changed: boolean;
};

/**
 * Advance one live shadow leg by a single price observation.
 *
 * Expressed in R rather than prices throughout, so the long and short cases
 * collapse to one set of comparisons. The stop is always exactly -1R by
 * construction (the risk unit IS the entry-to-stop distance).
 */
export function advanceShadowLive(
  trade: { side: "LONG" | "SHORT"; entryPrice: number; slPrice: number; entryTime: number },
  state: ShadowLiveState,
  price: number,
  now: number,
  policy: ShadowPolicy,
): ShadowLiveOutcome {
  const risk = Math.abs(trade.entryPrice - trade.slPrice);
  const flat: ShadowLiveOutcome = { state, resolved: null, changed: false };
  if (!(risk > 0) || !(price > 0)) return flat;

  const rNow = rMultiple(trade.entryPrice, risk, trade.side, price);
  const runnerWeight = 1 - policy.firstFraction;

  // Horizon first: a stale leg is closed at market regardless of price.
  if (now - trade.entryTime >= policy.horizonBars * 15 * 60 * 1000) {
    const openWeight = state.tp1Filled ? runnerWeight : 1;
    return {
      state,
      resolved: {
        reason: state.tp1Filled ? "tp1+timeout" : "timeout",
        totalR: state.bankedR + openWeight * rNow,
      },
      changed: false,
    };
  }

  const runnerStopR = policy.breakEvenAfterFirst ? 0 : -1;
  const runnerStopReason: ShadowExitReason = policy.breakEvenAfterFirst ? "tp1+breakeven" : "tp1+stop";

  if (!state.tp1Filled) {
    // Stop is checked BEFORE any target — the same conservative ordering the
    // bar replay uses.
    if (rNow <= -1) return { state, resolved: { reason: "stop", totalR: -1 }, changed: false };

    if (rNow >= policy.firstTargetR) {
      const bankedR = policy.firstFraction * policy.firstTargetR;
      const next: ShadowLiveState = { tp1Filled: true, bankedR };
      // A single observation can be far enough to fill the runner too.
      if (rNow >= policy.runnerTargetR) {
        return {
          state: next,
          resolved: { reason: "tp1+tp2", totalR: bankedR + runnerWeight * policy.runnerTargetR },
          changed: true,
        };
      }
      return { state: next, resolved: null, changed: true };
    }
    return flat;
  }

  // First target already banked — only the runner is live.
  if (rNow <= runnerStopR) {
    return {
      state,
      resolved: { reason: runnerStopReason, totalR: state.bankedR + runnerWeight * runnerStopR },
      changed: false,
    };
  }
  if (rNow >= policy.runnerTargetR) {
    return {
      state,
      resolved: { reason: "tp1+tp2", totalR: state.bankedR + runnerWeight * policy.runnerTargetR },
      changed: false,
    };
  }
  return flat;
}

export type ShadowSummary = {
  policy: string;
  trades: number;
  totalR: number;
  totalRealR: number;
  deltaR: number;
  winRate: number;
  realWinRate: number;
  /** Expected R per trade under the policy. */
  expectancyR: number;
  realExpectancyR: number;
  avgBarsHeld: number;
  /** Exit-reason histogram. */
  exits: Record<string, number>;
};

/** Aggregate a set of simulated trades into book-level stats. */
export function summarizeShadow(results: ShadowResult[], policy: ShadowPolicy): ShadowSummary {
  const trades = results.length;
  const totalR = results.reduce((s, r) => s + r.shadowR, 0);
  const totalRealR = results.reduce((s, r) => s + r.realR, 0);
  const exits: Record<string, number> = {};
  for (const r of results) exits[r.reason] = (exits[r.reason] ?? 0) + 1;
  return {
    policy: policy.name,
    trades,
    totalR,
    totalRealR,
    deltaR: totalR - totalRealR,
    winRate: trades ? results.filter((r) => r.shadowR > 0).length / trades : 0,
    realWinRate: trades ? results.filter((r) => r.realR > 0).length / trades : 0,
    expectancyR: trades ? totalR / trades : 0,
    realExpectancyR: trades ? totalRealR / trades : 0,
    avgBarsHeld: trades ? results.reduce((s, r) => s + r.barsHeld, 0) / trades : 0,
    exits,
  };
}
