/**
 * PORTFOLIO CIRCUIT BREAKER (R-based).
 *
 * WHY A NEW MODULE. circuit-breaker.ts and live-breaker.ts already exist, but
 * both are denominated in USD account balance and are enforced in
 * strategyEngine.strategyTick. Neither can be measured on the audited R-based
 * backtest engine, which is the only surface with enough history (353 days,
 * 6,141 trades) to tell a real breaker from a lucky one. This module is
 * denominated in R, is stateless to evaluate (it is a pure function of the
 * closed-trade sequence), and returns HALT INTERVALS rather than a live
 * boolean, so the lab can price a breaker on the same engine as every other
 * gate.
 *
 * WHY A BREAKER AT ALL, WHEN EVERY ENTRY GATE HAS FAILED. An entry gate has to
 * PREDICT which trades lose; a breaker does not. It accepts that the base signal
 * is a coin flip and simply stops paying after the coin flips against you. That
 * is a much weaker claim to validate, which is why this is the tool most likely
 * to survive a random-veto null on a book whose PF is 1.003.
 *
 * THE DEADLOCK HAZARD (this is the part that is easy to get wrong). A breaker
 * armed on a trade-derived metric — rolling win rate, rolling drawdown — can
 * never re-arm. A halted book takes no trades, so it produces no new closes, so
 * the metric that would release the halt never moves. The book halts forever on
 * a rule that was supposed to be self-clearing. Every trigger here therefore
 * re-arms on a TIME cooldown (or a natural calendar boundary), never on the
 * book needing to earn its way out. If you add a trigger, keep that property or
 * accept a permanent halt.
 *
 * CAUSALITY. Halts are derived from trades that had already CLOSED at the time
 * the halt begins, so nothing here can act on the outcome of a trade it is
 * deciding whether to take.
 */

export type BreakerTrigger =
  | "off"
  | "daily_loss_r"
  | "loss_streak"
  | "rolling_dd_r"
  | "rolling_wr"
  | "session_loss_r";

export type BreakerScope = "portfolio" | "pair";

export type PortfolioBreakerCfg = {
  trigger: BreakerTrigger;
  /**
   * Trigger-specific:
   *   daily_loss_r / session_loss_r — halt once realized R since the period
   *     start is <= -threshold
   *   loss_streak — halt after this many consecutive losing trades
   *   rolling_dd_r — halt once R from the rolling peak is <= -threshold
   *   rolling_wr — halt once rolling win rate < threshold (a fraction, not R)
   */
  threshold: number;
  /** Rolling window in trades (wr / dd) or bars (streak / dd cooldown). */
  window: number;
  /** Halt length in BARS after a trip. Daily/session triggers use the day/session boundary instead. */
  cooldownBars: number;
  scope: BreakerScope;
};

export const PORTFOLIO_BREAKER_DEFAULTS: PortfolioBreakerCfg = {
  trigger: "daily_loss_r",
  threshold: 3,
  window: 20,
  cooldownBars: 96,
  scope: "portfolio",
};

export type ClosedLike = {
  pair: string;
  exitTime: number;
  /** Realized R for the trade. */
  r: number;
};

export type HaltInterval = { from: number; until: number; reason: string; trigger: BreakerTrigger };

const DAY_MS = 86_400_000;
const BAR_MS = 900_000;
/** Session boundaries in UTC hours, matching trade-context's session split. */
const SESSIONS: Array<{ name: string; start: number; end: number }> = [
  { name: "asia", start: 0, end: 8 },
  { name: "europe", start: 7, end: 16 },
  { name: "us", start: 13, end: 21 },
];

function startOfUtcDay(t: number): number {
  const d = new Date(t);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

function sessionKey(t: number): number {
  // A session label keyed by its start boundary, so "which session is this
  // close in" survives the overlapping definitions used for entry sessions.
  const d = new Date(t);
  const h = d.getUTCHours();
  for (const s of SESSIONS) if (h >= s.start && h < s.end) return startOfUtcDay(t) + s.start * 3_600_000;
  return startOfUtcDay(t) + 8 * 3_600_000;
}

/**
 * The halt intervals a config produces from an ordered closed-trade sequence.
 *
 * `closes` must be sorted by exitTime ascending; the result is pure and
 * deterministic, which is what lets the lab iterate it to a fixed point against
 * a re-simulating engine.
 */
export function breakerHaltIntervals(closes: readonly ClosedLike[], cfg: PortfolioBreakerCfg): HaltInterval[] {
  if (cfg.trigger === "off") return [];
  const sorted = [...closes].sort((a, b) => a.exitTime - b.exitTime);
  const out: HaltInterval[] = [];
  // Per-scope running state. Portfolio scope keys everything under "".
  const state = new Map<string, { dayPnl: number; dayKey: number; streak: number; recent: number[]; peak: number }>();
  const get = (key: string) => {
    let s = state.get(key);
    if (!s) { s = { dayPnl: 0, dayKey: 0, streak: 0, recent: [], peak: 0 }; state.set(key, s); }
    return s;
  };
  // One pending halt PER SCOPE KEY. A single shared one would let a halt on one
  // pair suppress every other pair's closes under pair scope, which silently
  // converts a per-pair breaker into a portfolio-wide one.
  const pendingByKey = new Map<string, HaltInterval>();

  for (const c of sorted) {
    const keys = cfg.scope === "pair" ? [c.pair] : [""];
    for (const key of keys) {
      // A cooldown that has expired releases before this close is read.
      const p = pendingByKey.get(key);
      if (p && c.exitTime >= p.until) { out.push(p); pendingByKey.delete(key); }
      else if (p) continue; // still halted: no closes to read for this key

      const s = get(key);
      const day = startOfUtcDay(c.exitTime);
      let reason: string | null = null;
      let until = 0;

      if (cfg.trigger === "daily_loss_r") {
        if (s.dayKey !== day) { s.dayKey = day; s.dayPnl = 0; s.streak = 0; s.recent = []; s.peak = 0; }
        s.dayPnl += c.r;
        if (s.dayPnl <= -Math.abs(cfg.threshold)) {
          reason = `day R ${s.dayPnl.toFixed(2)} <= -${Math.abs(cfg.threshold)}`;
          until = day + DAY_MS;
        }
      } else if (cfg.trigger === "session_loss_r") {
        const sk = sessionKey(c.exitTime);
        if (s.dayKey !== day) { s.dayKey = day; s.dayPnl = 0; s.streak = 0; s.recent = []; s.peak = 0; }
        if (sk !== s.dayKey) { s.dayKey = sk; s.dayPnl = 0; }
        s.dayPnl += c.r;
        if (s.dayPnl <= -Math.abs(cfg.threshold)) {
          const starts = SESSIONS.map((x) => day + x.start * 3_600_000).filter((x) => x > c.exitTime).sort((a, b) => a - b);
          until = starts[0] ?? day + DAY_MS;
          reason = `session R ${s.dayPnl.toFixed(2)} <= -${Math.abs(cfg.threshold)}`;
        }
      } else if (cfg.trigger === "loss_streak") {
        // No calendar reset. "Three consecutive losses" means three consecutive
        // losing trades; clearing the counter at midnight means a streak that
        // straddles the boundary never trips, which is exactly the cluster a
        // streak breaker exists to catch.
        s.streak = c.r <= 0 ? s.streak + 1 : 0;
        if (s.streak >= cfg.threshold) {
          reason = `${s.streak} consecutive losses`;
          until = c.exitTime + cfg.cooldownBars * BAR_MS;
          s.streak = 0;
        }
      } else if (cfg.trigger === "rolling_dd_r") {
        // Likewise a rolling window spans days; resetting it daily would cap it
        // at "one day's worth of trades" no matter what `window` says.
        s.recent.push(c.r);
        if (s.recent.length > cfg.window) s.recent.shift();
        const sum = s.recent.reduce((a, b) => a + b, 0);
        s.peak = Math.max(s.peak, sum);
        const dd = sum - s.peak;
        if (dd <= -Math.abs(cfg.threshold)) {
          reason = `rolling R drawdown ${dd.toFixed(2)} <= -${Math.abs(cfg.threshold)}`;
          until = c.exitTime + cfg.cooldownBars * BAR_MS;
          s.peak = sum;
        }
      } else if (cfg.trigger === "rolling_wr") {
        s.recent.push(c.r > 0 ? 1 : 0);
        if (s.recent.length > cfg.window) s.recent.shift();
        const wr = s.recent.reduce((a, b) => a + b, 0) / s.recent.length;
        if (s.recent.length >= Math.min(cfg.window, 8) && wr < cfg.threshold) {
          reason = `rolling WR ${(wr * 100).toFixed(0)}% < ${(cfg.threshold * 100).toFixed(0)}%`;
          until = c.exitTime + cfg.cooldownBars * BAR_MS;
          s.recent = [];
        }
      }

      if (reason) { pendingByKey.set(key, { from: c.exitTime, until, reason, trigger: cfg.trigger }); break; }
    }
  }
  for (const [, p] of pendingByKey) out.push(p);
  return out.sort((a, b) => a.from - b.from);
}

/** Is `t` inside any halt? Sorted-interval scan with a binary search. */
export function isHalted(intervals: readonly HaltInterval[], t: number): HaltInterval | null {
  let lo = 0;
  let hi = intervals.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const iv = intervals[mid]!;
    if (t < iv.from) hi = mid - 1;
    else if (t >= iv.until) lo = mid + 1;
    else return iv;
  }
  return null;
}

/** Fraction of the timeline the breaker is halted for. Diagnostic only. */
export function haltCoverage(intervals: readonly HaltInterval[], from: number, until: number): number {
  if (until <= from) return 0;
  let covered = 0;
  for (const iv of intervals) covered += Math.max(0, Math.min(iv.until, until) - Math.max(iv.from, from));
  return covered / (until - from);
}
