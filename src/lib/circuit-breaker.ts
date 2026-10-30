/**
 * CIRCUIT BREAKER (paper book, 2026-09-08).
 *
 * Built after the Sep 7-8 drawdown ($398.83 realized peak → $255.96): the
 * EMA-momentum book bled -$142.87 across 63 closed trades in two days while
 * the regime flipped to chop (shorts 1-for-15, Asia session 18% WR). This
 * module gates NEW entries when the book's recent results degrade, instead of
 * letting the tick keep firing 40+ whipsaw trades/day at ~$13/R stops.
 *
 * Two independent triggers (stateless — recomputed every tick, no persisted
 * state to get stale):
 *   1. Rolling win rate over the last N closed trades falls below
 *      breakerMinWr (default 0.30 — the theoretical breakeven WR for the
 *      book's ~1R loss / ~2R win profile, before fees).
 *   2. Realized loss today (UTC) exceeds breakerMaxDailyLossPct of the
 *      account balance (default 5%) — halt the rest of the day.
 *
 * Re-arm is automatic: WR20 recovers as new closes enter the window, and the
 * daily-loss trigger resets at the UTC day boundary. Live trading does NOT
 * read this module; it is enforced only in strategyEngine.strategyTick.
 */

export interface BreakerConfig {
  breakerEnabled: boolean;
  breakerMinWr: number;           // 0-1 rolling win-rate floor
  breakerMaxDailyLossPct: number; // 0-1 of balance, max realized loss per UTC day
}

export interface RecentClosedLike {
  pnlUsd?: number;
  exitTime?: number;
}

export interface BreakerInput {
  recentClosed: RecentClosedLike[]; // WR window (last N closes)
  /**
   * EVERY close since the start of the UTC day — used for the daily-loss cap.
   * AUDIT FIX (2026-09-11): this used to be derived from `recentClosed`, which
   * the engine fetched as only the last 20 closes ordered by ENTRY time. On a
   * busy day (>20 closes) the cap could never see the day's full loss and
   * never fired. Callers must pass the complete day set here; when omitted
   * the old behaviour (recentClosed) is preserved for tests/back-compat.
   */
  dailyClosed?: RecentClosedLike[];
  balance: number;
  now: number;
  cfg: BreakerConfig;
}

export interface BreakerState {
  paused: boolean;
  reasons: string[];
  wr20: number | null;      // win rate over the window (null if no closed trades)
  dailyPnl: number;         // realized P&L since start of UTC day
  maxDailyLossUsd: number;  // breakerMaxDailyLossPct * balance (0 when disabled)
}

const BREAKER_WINDOW = 20;

function startOfUtcDay(now: number): number {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

export function computeBreakerState(input: BreakerInput): BreakerState {
  const { recentClosed, balance, now, cfg } = input;
  const dailyClosed = input.dailyClosed ?? recentClosed;
  const reasons: string[] = [];

  // Rolling win rate over the most recent BREAKER_WINDOW closes.
  const window = recentClosed
    .filter((t) => t.exitTime !== undefined)
    .sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0))
    .slice(0, BREAKER_WINDOW);
  const wins = window.filter((t) => (t.pnlUsd ?? 0) > 0).length;
  const wr20 = window.length > 0 ? wins / window.length : null;

  // Realized P&L since the start of the UTC day — over the FULL day set, not
  // the truncated WR window (audit fix).
  const dayStart = startOfUtcDay(now);
  const dailyPnl = dailyClosed
    .filter((t) => t.exitTime !== undefined && (t.exitTime ?? 0) >= dayStart)
    .reduce((s, t) => s + (t.pnlUsd ?? 0), 0);

  const maxDailyLossUsd = cfg.breakerEnabled ? balance * cfg.breakerMaxDailyLossPct : 0;

  let paused = false;
  if (!cfg.breakerEnabled) {
    reasons.push("Circuit breaker disabled");
    return { paused, reasons, wr20, dailyPnl, maxDailyLossUsd };
  }

  if (wr20 !== null && wr20 < cfg.breakerMinWr) {
    paused = true;
    reasons.push(
      `Rolling WR ${(wr20 * 100).toFixed(0)}% < ${(cfg.breakerMinWr * 100).toFixed(0)}% over last ${window.length} closes`,
    );
  }
  if (maxDailyLossUsd > 0 && dailyPnl <= -maxDailyLossUsd) {
    paused = true;
    reasons.push(
      `Daily loss -$${Math.abs(dailyPnl).toFixed(2)} exceeds ${(cfg.breakerMaxDailyLossPct * 100).toFixed(0)}% of balance ($${maxDailyLossUsd.toFixed(2)})`,
    );
  }
  if (!paused) reasons.push(`WR20 ${wr20 === null ? "n/a" : (wr20 * 100).toFixed(0) + "%"}, daily ${dailyPnl >= 0 ? "+" : ""}$${dailyPnl.toFixed(2)}`);

  return { paused, reasons, wr20, dailyPnl, maxDailyLossUsd };
}