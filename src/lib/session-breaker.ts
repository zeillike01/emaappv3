/**
 * SESSION PROFITABILITY BREAKER (paper-fed, live-enforced; 2026-10-20).
 *
 * WHY. The book-wide breaker in `circuit-breaker.ts` answers "is the book
 * bleeding?" with ONE number (WR20 + today's realized loss), and the loss
 * record says the damage is not uniform: over the last 14 days of paper closes
 * the same book earned +12.65R on asia SHORTs and lost −3.48R on late SHORTs.
 * That cohort is invisible to a book-wide win rate — 13 losing late shorts are
 * diluted by 42 winning ldn-ny shorts into a "fine" 49%.
 *
 * WHO MEASURES, WHO ACTS. Paper is the sensor and is NEVER blocked; it keeps
 * trading every session so the buckets keep receiving fresh evidence. Live is
 * the actuator: it refuses to open a position in a (session, side) bucket the
 * paper book has not shown to be profitable. That split is the whole point —
 * if the measured book blocked itself, it would stop producing the data needed
 * to decide when the bucket is healthy again.
 *
 * THE RULE. Bucket the paper ledger by (session, side) over the lookback
 * window. A bucket with at least `minTrades` closes is BLOCKED for live entries
 * while its realized R is at or below `minProfitR` (default 0 = "must be
 * profitable"). A bucket with FEWER closes than that is BLOCKED too: an
 * unproven session is not a safe session, and live spends real money on the
 * answer. `insufficient` records which of the two reasons applies, so the veto
 * line says "too little evidence" instead of pretending the bucket lost money.
 *
 * WHY UNPROVEN CLOSES LIVE (2026-10-22, operator rule). "Fail open on a thin
 * sample" was the wrong default for the book that pays for its mistakes: a
 * 1-close bucket can look profitable by luck, and the live row is where that
 * luck is paid for. Paper is unaffected (it is never blocked), so the missing
 * evidence accrues anyway and the bucket re-opens as soon as the sample exists
 * AND the record is profitable. The full session × side grid is emitted for
 * the same reason — a (session, side) the paper book has never closed is a
 * zero-evidence bucket, not an absent row nobody can refuse.
 *
 * RE-ARMING. Re-evaluated on the refresh cadence (12h) from a book that is
 * still trading, so a bucket re-opens as soon as its paper record turns
 * profitable. There is no permanent-halt path and no reliance on the gated book
 * producing new trades.
 *
 * PURE: no I/O, no clock, one import (the shared session labels). Unit-tested
 * in `src/lib/__tests__/session-breaker.test.ts`. The Convex seam (snapshot
 * table, refresh cron, live veto) lives in `convex/strategyEngine.ts` and
 * `convex/liveBrokerRuntime.ts`.
 */

import { SESSION_LABELS, sessionOf } from "./trade-context";

export type SessionSide = "LONG" | "SHORT";

/** Coarse, documented defaults — they mirror the stored config rows. */
export const SESSION_BREAKER_DEFAULTS = {
  sessionBreakerLookbackDays: 14,
  sessionBreakerMinTrades: 10,
  sessionBreakerMinProfitR: 0,
} as const;

export interface SessionBreakerConfig {
  sessionBreakerLookbackDays: number;
  sessionBreakerMinTrades: number;
  /**
   * Minimum realized R a bucket must show to stay OPEN for live entries.
   * 0 = "must be profitable" (sumR <= 0 blocks). Set it above 0 to demand a
   * margin, or below 0 to tolerate a small loss.
   */
  sessionBreakerMinProfitR: number;
}

/** The subset of a closed PAPER trade this module reads. */
export interface SessionBreakerClosedLike {
  /** Stored engine session label; falls back to signalTime/exitTime bucketing. */
  session?: string | null;
  /** Paper trades carry the side in `type`; accept `side` too. */
  type?: string | null;
  side?: string | null;
  exitTime?: number | null;
  signalTime?: number | null;
  /** Realized R — the unit the verdict is denominated in. */
  realizedR?: number | null;
}

export interface SessionBreakerBucket {
  session: string;
  side: SessionSide;
  trades: number;
  wins: number;
  sumR: number;
  winRate: number | null;
  /**
   * True when the bucket has fewer than `minTrades` closes. `blocked` is true
   * as well (unproven ⇒ refused for live), but the reason is different — no
   * amount of R makes a 2-close bucket proven.
   */
  insufficient?: boolean;
  /** The sample floor this bucket was judged against (diagnostics only). */
  minTrades?: number;
  /** True when LIVE must not enter this bucket: unproven OR not profitable. */
  blocked: boolean;
}

export interface SessionBreakerState {
  lookbackDays: number;
  minTrades: number;
  minProfitR: number;
  from: number;
  to: number;
  buckets: SessionBreakerBucket[];
  blocked: SessionBreakerBucket[];
}

const DAY_MS = 86_400_000;

/** UTC day key, `YYYY-MM-DD` — the identity of a persisted daily snapshot. */
export function sessionBreakerDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// ── THE MEASUREMENT WINDOW ───────────────────────────────────────────────────
//
// The gate measures "is this (session, side) profitable over the last N days".
// A window is only meaningful if the DATA behind it is the same window, so the
// ledger is pruned to exactly N days and the P&L that leaves the window is
// CARRIED (not lost) on the book account.
//
// WHY THE CARRY EXISTS. The paper balance is PATCHED incrementally on every
// close (`balance += pnlUsd`), so deleting a row does not move the balance —
// but every path that RE-DERIVES the balance from the ledger
// (`restoreLayer2Balance`, `mining:reconcileBalances`) would subtract the
// pruned P&L and make the book look like it lost everything. The carry is
// added back on those paths, so pruning shrinks the ledger without moving the
// book. Same idea for the lifetime counters: `bookStats` is folded by hand, so
// a prune folds the pruned rows OUT of it — the totals stay all-time.

/** The start of the measurement window (ms epoch). */
export function sessionWindowCutoff(now: number, lookbackDays: number): number {
  const days = Math.min(Math.max(Math.round(lookbackDays) || 0, 1), 90);
  return now - days * DAY_MS;
}

/**
 * The retention window for the measured paper ledger (days).
 *
 * TWO rankings read that ledger — the session breaker (its own lookback) and
 * the per-coin priority (its own lookback) — and the prune is the ONLY thing
 * deleting rows. Retaining the narrower window would silently starve the wider
 * reader: a 30-day coin ranking over a ledger pruned at 14 days would compute
 * a 14-day record and label it 30. So the ledger keeps the WIDER window, and
 * each reader filters to its own on top (2026-10-21 second-pass audit).
 */
export function measuredWindowDays(cfg: {
  sessionBreakerLookbackDays: number;
  coinPriorityLookbackDays?: number;
}): number {
  const session = Math.min(Math.max(Math.round(cfg.sessionBreakerLookbackDays) || 0, 1), 90);
  const coin = Math.min(Math.max(Math.round(cfg.coinPriorityLookbackDays ?? 0) || 0, 1), 90);
  return Math.max(session, coin);
}

/** The subset of a closed row the window/carry math reads. */
export interface SessionWindowRowLike {
  exitTime?: number | null;
  entryTime?: number | null;
  pnlUsd?: number | null;
  totalFeesUsd?: number | null;
  realizedR?: number | null;
}

/**
 * The realized result of the rows that aged out of the window.
 *
 * This is the number that must survive the prune: it is folded into the
 * book's lifetime counters and added back to every ledger-derived balance.
 */
export interface SessionWindowCarry {
  /** Rows that left the window. */
  trades: number;
  /** Of those, the ones that closed positive. */
  wins: number;
  /** Realized P&L in USD (the balance unit). */
  realizedPnlUsd: number;
  /** Total fees paid on those rows. */
  totalFeesUsd: number;
  /** Realized R on those rows (the bucket unit). */
  realizedR: number;
  /** Oldest / newest close time in the carry — the window's own edges. */
  oldestExitTime: number | null;
  newestExitTime: number | null;
}

/** A carry with nothing in it. */
export function emptySessionWindowCarry(): SessionWindowCarry {
  return {
    trades: 0,
    wins: 0,
    realizedPnlUsd: 0,
    totalFeesUsd: 0,
    realizedR: 0,
    oldestExitTime: null,
    newestExitTime: null,
  };
}

/**
 * Summarize the rows that are about to leave the window.
 *
 * Rows without a close time carry no P&L (a close always has one) and are
 * counted as trades with 0 P&L rather than dropped — the count is what the
 * lifetime "Closed" counter reports.
 */
export function sessionWindowCarryOf(
  rows: readonly SessionWindowRowLike[],
): SessionWindowCarry {
  const carry = emptySessionWindowCarry();
  for (const row of rows) {
    carry.trades += 1;
    const pnl = finiteNumber(row.pnlUsd) ?? 0;
    if (pnl > 0) carry.wins += 1;
    carry.realizedPnlUsd += pnl;
    carry.totalFeesUsd += finiteNumber(row.totalFeesUsd) ?? 0;
    carry.realizedR += finiteNumber(row.realizedR) ?? 0;
    const exit = finiteNumber(row.exitTime) ?? finiteNumber(row.entryTime);
    if (exit != null) {
      carry.oldestExitTime =
        carry.oldestExitTime == null ? exit : Math.min(carry.oldestExitTime, exit);
      carry.newestExitTime =
        carry.newestExitTime == null ? exit : Math.max(carry.newestExitTime, exit);
    }
  }
  return carry;
}

/**
 * The book's balance from the ledger PLUS the carry.
 *
 * `startBalance + carry + ledger` is the whole balance. A prune moves P&L
 * from the ledger term into the carry term, so the sum — and therefore the
 * balance — does not move.
 */
export function bookBalanceWithCarry(
  startBalance: number,
  ledgerPnlUsd: number,
  carryPnlUsd = 0,
): number {
  return startBalance + carryPnlUsd + ledgerPnlUsd;
}

/** The lifetime counters of a book: what the ledger holds plus the carry. */
export function statsWithCarry(
  ledger: { closedCount: number; wins: number; realizedPnl: number; totalFeesUsd: number },
  carry: SessionWindowCarry,
): { closedCount: number; wins: number; realizedPnl: number; totalFeesUsd: number } {
  return {
    closedCount: ledger.closedCount + carry.trades,
    wins: ledger.wins + carry.wins,
    realizedPnl: ledger.realizedPnl + carry.realizedPnlUsd,
    totalFeesUsd: ledger.totalFeesUsd + carry.totalFeesUsd,
  };
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sideOf(t: SessionBreakerClosedLike): SessionSide | null {
  const raw = t.type ?? t.side;
  if (raw === "LONG" || raw === "SHORT") return raw;
  return null;
}

/**
 * The session a close is bucketed under.
 *
 * The ENGINE tags the trade with the session of its SIGNAL bar
 * (`paperTrades.session`, written from `sessionOf(signalTime)`), and the live
 * entry gate evaluates the same label. Prefer the stored field so the breaker
 * and the entry path can never disagree; fall back to the formula for legacy
 * rows that predate the field.
 */
function sessionOfClose(t: SessionBreakerClosedLike): string {
  const stored = typeof t.session === "string" ? t.session.trim() : "";
  if (stored) return stored;
  const anchor = finiteNumber(t.signalTime) ?? finiteNumber(t.exitTime);
  return anchor == null ? "unknown" : sessionOf(anchor);
}

/** Clamp a config value into the range the math is defined on. */
function sanitize(cfg: SessionBreakerConfig): SessionBreakerConfig {
  return {
    sessionBreakerLookbackDays: Math.min(
      Math.max(Math.round(cfg.sessionBreakerLookbackDays) || 0, 1),
      90,
    ),
    sessionBreakerMinTrades: Math.max(Math.round(cfg.sessionBreakerMinTrades) || 0, 1),
    sessionBreakerMinProfitR: Number.isFinite(cfg.sessionBreakerMinProfitR)
      ? cfg.sessionBreakerMinProfitR
      : SESSION_BREAKER_DEFAULTS.sessionBreakerMinProfitR,
  };
}

/**
 * Bucket the closed PAPER book by (session, side) over the lookback window.
 *
 * Closes without a finite `exitTime` or `realizedR` are ignored: an
 * unreconciled row is not evidence about a session, and counting it as a loss
 * would block live trading on bookkeeping noise.
 */
export function computeSessionBreaker(
  closes: readonly SessionBreakerClosedLike[],
  cfg: SessionBreakerConfig,
  now: number,
): SessionBreakerState {
  const c = sanitize(cfg);
  const to = now;
  const from = now - c.sessionBreakerLookbackDays * DAY_MS;

  const byKey = new Map<string, SessionBreakerBucket>();
  for (const t of closes) {
    const exitTime = finiteNumber(t.exitTime);
    const r = finiteNumber(t.realizedR);
    if (exitTime == null || r == null || exitTime < from || exitTime > to) continue;
    const side = sideOf(t);
    if (!side) continue;
    const session = sessionOfClose(t);
    const key = `${session}|${side}`;
    const b =
      byKey.get(key) ??
      ({ session, side, trades: 0, wins: 0, sumR: 0, winRate: null, blocked: false } as const);
    const next: SessionBreakerBucket = {
      ...b,
      trades: b.trades + 1,
      wins: b.wins + (r > 0 ? 1 : 0),
      sumR: b.sumR + r,
    };
    byKey.set(key, next);
  }

  // FULL GRID (2026-10-22): every session label × both sides gets a bucket,
  // even when the paper book has never closed one. A missing bucket used to
  // mean "no rule applies" — i.e. live was free to trade the one cohort with
  // no evidence at all. Zero closes is the least evidence there is, so it is
  // seeded here as unproven; the grid is what makes that impossible to skip.
  // Labels outside SESSION_LABELS (legacy/unknown rows) keep their buckets.
  for (const session of SESSION_LABELS) {
    for (const side of ["LONG", "SHORT"] as const) {
      const key = `${session}|${side}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          session,
          side,
          trades: 0,
          wins: 0,
          sumR: 0,
          winRate: null,
          blocked: false,
        });
      }
    }
  }

  const buckets = [...byKey.values()]
    .map((b) => {
      const sumR = +b.sumR.toFixed(4);
      // TWO ways to be refused, and the order matters only for the label:
      //   · insufficient — fewer closes than the floor; the sample cannot
      //     support a verdict either way, so live does not bet on it.
      //   · unprofitable — enough closes and sumR <= minProfitR. `<=` on
      //     purpose: a flat bucket (0R) has not proven profitable.
      const insufficient = b.trades < c.sessionBreakerMinTrades;
      return {
        ...b,
        sumR,
        winRate: b.trades > 0 ? b.wins / b.trades : null,
        insufficient,
        minTrades: c.sessionBreakerMinTrades,
        blocked: insufficient || sumR <= c.sessionBreakerMinProfitR,
      };
    })
    .sort((a, b) => a.session.localeCompare(b.session) || a.side.localeCompare(b.side));

  return {
    lookbackDays: c.sessionBreakerLookbackDays,
    minTrades: c.sessionBreakerMinTrades,
    minProfitR: c.sessionBreakerMinProfitR,
    from,
    to,
    buckets,
    blocked: buckets.filter((b) => b.blocked),
  };
}

/**
 * The bucket that forbids a LIVE entry on `session` + `side`, if any.
 *
 * Accepts either the full state or a precomputed blocked list so the entry
 * path can pass the per-tick snapshot straight through. Fails open ONLY on a
 * missing/empty snapshot (no gate data at all) or an unknown side — an
 * unproven bucket lives in `blocked` like any other refusal.
 */
export function sessionBreakerBlock(
  state: SessionBreakerState | null | undefined | { blocked: SessionBreakerBucket[] },
  session: string,
  side: string,
): SessionBreakerBucket | undefined {
  if (!state || !Array.isArray(state.blocked) || state.blocked.length === 0) return undefined;
  if (side !== "LONG" && side !== "SHORT") return undefined;
  return state.blocked.find((b) => b.session === session && b.side === side);
}

/** Human-readable veto line, in the engine's canonical `blocked — …` shape. */
export function sessionBreakerReason(bucket: SessionBreakerBucket): string {
  if (bucket.insufficient) {
    const floor = bucket.minTrades != null ? ` < ${bucket.minTrades}` : "";
    return `session has too little evidence: ${bucket.session} ${bucket.side} ${bucket.trades} paper close(s)${floor}`;
  }
  return `session not profitable: ${bucket.session} ${bucket.side} ${bucket.sumR.toFixed(2)}R over ${bucket.trades} trades`;
}

// ── WHOLE-TICK SESSION PRISON (2026-10-22, cron I/O) ─────────────────────────
//
// The LIVE entry tick reads a 400-bar 15m series per pair before it can score
// anything, and the session tests (manual allowlist + profitability breaker)
// are applied to the SIGNAL — i.e. AFTER that fetch. When both sides are
// impossible for the session of the bar the tick is about to evaluate, that
// fetch can only end in a refusal: every one of the ~36 candidates is read
// and then dropped by the same two lines.
//
// Measured on 2026-10-22: `london` was blocked on BOTH sides (paper LONG
// −1.84R/12, SHORT −2.34R/33), so 24 ticks/day — 6 hours × 4 slots — spent
// ~36 kline fetches each (plus the tick's own balance/position reads) to
// produce zero entries. The cut below is the same shape as the existing
// disabled-book and coin-priority pre-fetch vetoes: prove no candidate can
// pass, then don't pay for the scan.
//
// NOT applied to the paper book: paper is the measuring instrument, and a
// session it stops sampling is a session no gate can ever be re-validated on
// (that is why the breaker is live-only in the first place).

/** The live config fields that decide whether a side can enter a session. */
export interface SessionScanConfig {
  allowLong: boolean;
  allowShort: boolean;
  longSessions: readonly string[];
  shortSessions: readonly string[];
}

export interface SessionScanVerdict {
  /** True when NEITHER side can enter `session` — the tick has no work. */
  skip: boolean;
  /** Why LONG is impossible in this session (null = LONG may enter). */
  longBlockedBy: string | null;
  /** Why SHORT is impossible in this session (null = SHORT may enter). */
  shortBlockedBy: string | null;
  /** One line for the tick summary / lastScanResult; "" when not skipping. */
  reason: string;
}

/** Why one side cannot enter `session`, or null when it may. */
function sessionSideBlockedBy(
  cfg: SessionScanConfig,
  session: string,
  side: SessionSide,
  breaker: { blocked: SessionBreakerBucket[] } | null | undefined,
): string | null {
  if (side === "LONG" ? !cfg.allowLong : !cfg.allowShort) return `${side.toLowerCase()} disabled`;
  const allow = side === "LONG" ? cfg.longSessions : cfg.shortSessions;
  if (allow.length > 0 && !allow.includes(session)) {
    return `${session} not in the ${side.toLowerCase()} allowlist`;
  }
  const bucket = sessionBreakerBlock(breaker, session, side);
  return bucket ? sessionBreakerReason(bucket) : null;
}

/**
 * Can any side enter `session`? Pure, and deliberately conservative in ONE
 * direction: it only reports `skip` when BOTH sides are impossible, so the
 * worst case of a stale/odd config is a tick that runs as it does today.
 *
 * Every input it reads is also read per candidate by the entry path itself
 * (`allowLong`/`allowShort`, the session allowlists, `sessionBreakerBlock` on
 * `entrySession`) — so a `skip` verdict means every candidate in that session
 * would have been refused. Nothing here predicts a score, a price or a gate.
 */
export function sessionScanVerdict(
  cfg: SessionScanConfig,
  session: string,
  breaker: { blocked: SessionBreakerBucket[] } | null | undefined,
): SessionScanVerdict {
  const longBlockedBy = sessionSideBlockedBy(cfg, session, "LONG", breaker);
  const shortBlockedBy = sessionSideBlockedBy(cfg, session, "SHORT", breaker);
  const skip = longBlockedBy != null && shortBlockedBy != null;
  return {
    skip,
    longBlockedBy,
    shortBlockedBy,
    reason: skip ? `session ${session}: LONG blocked (${longBlockedBy}); SHORT blocked (${shortBlockedBy})` : "",
  };
}
