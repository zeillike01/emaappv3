/**
 * LIVE CIRCUIT BREAKER (2026-09-10, manual re-arm 2026-10-22).
 *
 * Trigger the user asked for: N consecutive LOSSES disarm the live bot —
 * every entry signal is vetoed. Two release rules:
 *
 *   MANUAL (default, `liveBreakerManualReArm: true`): the trip is a HARD
 *   disarm — it survives restarts, ticks and config saves. Two things release
 *   it, both of which clear the stamp and set triggeredAt = now:
 *     (a) the operator clicking Re-arm, and
 *     (b) NEXT-SESSION evidence (2026-10-23, `liveBreakerRearmOnSession`,
 *         default ON). The session the trip happened in is written off. The
 *         FIRST session whose window starts after the trip has to CLOSE
 *         before anything is judged; if that session's paper record is
 *         profitable (net R > 0 over at least `sessionBreakerMinTrades`
 *         closes) the book re-arms. A session that closed red leaves the book
 *         disarmed and the next completed session is judged instead, so the
 *         check advances one session at a time and never releases on a timer.
 *   The evidence is read from the PAPER ledger, not the live one: a disarmed
 *   book takes no entries, so it produces no sessions to judge — gating on
 *   live P&L deadlocks the moment the positions opened before the trip close.
 *   Paper keeps trading, which is the same paper-measures / live-acts split as
 *   the session breaker (src/lib/session-breaker.ts), and the reason this rule
 *   cannot deadlock.
 *
 *   COOLDOWN (opt-out): the legacy timed pause. Entries resume after
 *   liveBreakerCooldownMin, unless the streak still holds AND includes a loss
 *   that closed AFTER the trigger (fresh evidence of a still-broken tape
 *   re-trips immediately; a streak made only of pre-pause losses does not
 *   chain pauses).
 *
 * Unlike the paper breaker (stateless WR20 + daily loss), this one NEEDS
 * persisted state in BOTH modes: the streak that tripped it is still >= N
 * while the book takes no trades, so a stateless check would either re-trip
 * forever (cooldown mode) or re-arm on the very next tick (manual mode). The
 * engine therefore persists { liveBreakerPausedUntil, liveBreakerTriggeredAt,
 * liveBreakerManualDisarmedAt } on the liveAccount doc when a trip begins.
 * Manual re-arm clears the disarm and stamps triggeredAt = now, which marks
 * the existing streak as pre-trigger history so it cannot immediately re-trip
 * (see the fresh-evidence rule in the cooldown branch).
 *
 * Pure logic — unit-tested in src/lib/__tests__/live-breaker.test.ts.
 */

export interface LiveBreakerConfig {
  liveBreakerEnabled: boolean;
  liveBreakerMaxLossStreak: number; // consecutive losses that trip the breaker (6)
  liveBreakerCooldownMin: number;   // pause length in minutes (720 = 12h) — cooldown mode only
  /** true (default) = a trip disarms until a manual re-arm; false = timed cooldown. */
  liveBreakerManualReArm?: boolean;
  /**
   * true (default) = a manual-mode disarm also releases on next-session
   * evidence (see the header). false restores the pure latch: only the
   * operator re-arms it.
   */
  liveBreakerRearmOnSession?: boolean;
}

export interface LiveBreakerTrade {
  /** null/undefined = unreconciled close. Counted as a LOSS for the streak
   *  (2026-09-11 audit fix): an exchange outage / manual close / liquidation
   *  leaves pnl unknown, and ignoring those hid real losses from the breaker
   *  exactly when infrastructure was degraded. Conservative by design. */
  pnlUsd?: number;
  exitTime?: number;
}

export interface LiveBreakerPersisted {
  pausedUntil?: number | null;
  triggeredAt?: number | null;
  /** Stamped when the breaker disarms in manual mode; cleared ONLY by re-arm. */
  disarmedAt?: number | null;
}

export interface LiveBreakerState {
  paused: boolean;
  shouldTrip: boolean;        // true ONLY when a NEW pause must be persisted now
  pausedUntil: number | null; // active/pending pause expiry (ms); null in manual mode
  triggeredAt: number | null;
  disarmedAt: number | null;  // set (and persisted) in manual mode, null otherwise
  lossStreak: number;         // current consecutive-loss count (0 if none)
  reason: string;
}

const MINUTE_MS = 60_000;

/**
 * Consecutive losses scanning newest-first. UNRECONCILED closes (pnlUsd
 * null/undefined) count as losses — see LiveBreakerTrade. Only a confirmed
 * WIN ends the streak.
 */
export function computeLiveLossStreak(recentClosed: LiveBreakerTrade[]): number {
  const closed = recentClosed
    .filter((t) => t.exitTime !== undefined)
    .sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0));
  let streak = 0;
  for (const t of closed) {
    if (t.pnlUsd != null && t.pnlUsd > 0) break; // a confirmed win ends the streak
    streak++;
  }
  return streak;
}

export function computeLiveBreakerState(
  cfg: LiveBreakerConfig,
  recentClosed: LiveBreakerTrade[],
  persisted: LiveBreakerPersisted,
  now: number,
): LiveBreakerState {
  const streak = computeLiveLossStreak(recentClosed);
  const persistedUntil = persisted.pausedUntil ?? null;
  const persistedTrigger = persisted.triggeredAt ?? null;
  const persistedDisarm = persisted.disarmedAt ?? null;
  const manual = cfg.liveBreakerManualReArm !== false;

  const base = { lossStreak: streak, triggeredAt: persistedTrigger, disarmedAt: null as number | null };

  if (!cfg.liveBreakerEnabled) {
    return { ...base, paused: false, shouldTrip: false, pausedUntil: null, reason: "breaker disabled" };
  }

  // 0) MANUAL DISARM → veto entries until the operator clears it. Checked
  //    before the streak so a disarmed book can never trade on the strength of
  //    a win that closed after the trip: the disarm is the operator's call.
  if (manual && persistedDisarm != null) {
    return {
      ...base,
      disarmedAt: persistedDisarm,
      paused: true,
      shouldTrip: false,
      pausedUntil: null,
      // No streak count here: a win can close after the trip and reset the
      // streak to 0 while the book is still disarmed. "0 consecutive losses —
      // DISARMED" would read like a contradiction on the Live page.
      reason: "loss-streak breaker DISARMED — manual re-arm required",
    };
  }

  // 1) Inside a persisted cooldown → veto entries (no new persistence).
  if (!manual && persistedUntil != null && now < persistedUntil) {
    const mins = Math.ceil((persistedUntil - now) / MINUTE_MS);
    return {
      ...base,
      paused: true,
      shouldTrip: false,
      pausedUntil: persistedUntil,
      reason: `cooldown active — entries resume in ~${mins} min (tripped on ${streak} consecutive losses)`,
    };
  }

  // 2) Streak below the trigger → armed.
  if (streak < cfg.liveBreakerMaxLossStreak) {
    return {
      ...base,
      paused: false,
      shouldTrip: false,
      pausedUntil: null,
      reason: `armed — loss streak ${streak}/${cfg.liveBreakerMaxLossStreak}`,
    };
  }

  // 3) Streak holds after a previous cooldown. Only re-trip on FRESH
  //    evidence: at least one of those losses closed after the last trigger.
  //    Otherwise the same old streak would re-pause forever with no trades.
  if (persistedTrigger != null) {
    const closed = recentClosed
      .filter((t) => t.exitTime !== undefined && (t.pnlUsd == null || t.pnlUsd <= 0))
      .sort((a, b) => (b.exitTime ?? 0) - (a.exitTime ?? 0));
    const hasFresh = closed.slice(0, streak).some((t) => (t.exitTime ?? 0) > persistedTrigger);
    if (!hasFresh) {
      return {
        ...base,
        paused: false,
        shouldTrip: false,
        pausedUntil: null,
        reason: `armed — streak ${streak} is pre-trigger history; ${manual ? "operator re-armed" : "cooldown already served"}`,
      };
    }
  }

  // 4) New trip → the caller must persist the returned state.
  if (manual) {
    // HARD DISARM: no expiry. Released by the operator's Re-arm, or by
    // shouldRearmOnSession() once a session after the trip closes profitable.
    return {
      lossStreak: streak,
      paused: true,
      shouldTrip: true,
      pausedUntil: null,
      triggeredAt: now,
      disarmedAt: now,
      reason: `${streak} consecutive losses — live book DISARMED; re-arm manual or next session`,
    };
  }
  const pausedUntil = now + cfg.liveBreakerCooldownMin * MINUTE_MS;
  return {
    lossStreak: streak,
    paused: true,
    shouldTrip: true,
    pausedUntil,
    triggeredAt: now,
    disarmedAt: null,
    reason: `${streak} consecutive losses — entries paused ${cfg.liveBreakerCooldownMin} min`,
  };
}

// ── NEXT-SESSION RELEASE (2026-10-23) ───────────────────────────────────────
//
// The release rule for a manual-mode disarm, in the operator's words: "the
// current session the breaker is armed, then a next session — check whether it
// is profitable, and if so arm it again."
//
// The unit is a CLOSED session, not a win count. A session is a block of a few
// hours in which the book takes many entries, so "was that session profitable"
// asks a question with a sample behind it; "did the last two closes win" fires
// every couple of hours in a book that wins ~50% of the time, which is a
// cooldown wearing an evidence label.
//
// Paper is the sensor. The disarmed book takes no entries, so its own P&L stops
// producing sessions the moment the pre-trip positions close out: a live-fed
// release would deadlock. Paper keeps trading through the same config, so its
// closes are the shadow record of what live would have been doing.

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
/**
 * How far back the session-verdict walk may start. Bounds the walked sessions
 * to ~150, so the 400-session guard can never stop the walk short of `now`
 * (see measureCompletedSessionSince). 30 days is also the longest a disarmed
 * book can plausibly sit before the release is judged on stale evidence.
 */
const SESSION_VERDICT_WINDOW_MS = 30 * DAY_MS;
/** Session start hours in UTC — identical to trade-context.sessionOf(). */
const SESSION_START_HOUR = [0, 7, 13, 17, 22];
const SESSION_LABEL = ["asia", "london", "ldn-ny", "ny", "late"];

export interface SessionWindow {
  label: string;
  start: number;
  end: number;
}

/** The session window containing `ms` (UTC buckets, exclusive end). */
export function sessionWindowAt(ms: number): SessionWindow {
  const d = new Date(ms);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const hour = d.getUTCHours();
  let i = 0;
  for (let k = 0; k < SESSION_START_HOUR.length; k++) if (hour >= SESSION_START_HOUR[k]) i = k;
  const start = dayStart + SESSION_START_HOUR[i] * HOUR_MS;
  const end =
    i + 1 < SESSION_START_HOUR.length
      ? dayStart + SESSION_START_HOUR[i + 1] * HOUR_MS
      : dayStart + DAY_MS;
  return { label: SESSION_LABEL[i], start, end };
}

/** The subset of a closed PAPER trade the session verdict reads. */
export interface LiveBreakerSessionClose {
  exitTime?: number | null;
  /** Paper closes store `realizedR`; accept `r` for older/derived rows. */
  realizedR?: number | null;
  r?: number | null;
}

export interface LiveBreakerSessionEvidence {
  label: string;
  start: number;
  end: number;
  closes: number;
  netR: number;
  minCloses: number;
  profitable: boolean;
}

/**
 * The MOST RECENT session that both started after the trip and has fully
 * closed, measured on the paper ledger. Returns null while the first such
 * session is still running — an open session is not evidence.
 */
export function measureCompletedSessionSince(
  tripAt: number,
  now: number,
  closes: LiveBreakerSessionClose[],
  minCloses: number,
): LiveBreakerSessionEvidence | null {
  const floor = Math.max(1, Math.round(minCloses) || 1);
  // Every session that has CLOSED since the trip, oldest -> newest. The
  // trip's own session is written off: the book was trading into the very
  // losses that disarmed it, so its P&L is the evidence that FAILED.
  //
  // The walk starts at the LATER of (a) the end of the trip's session and
  // (b) 30 days ago. The verdict is always the NEWEST completed session, so
  // nothing older than that window can be the verdict — and skipping it keeps
  // the 400-session guard from truncating BEFORE `now` on a trip older than
  // ~80 days. Without the floor that truncation made the function judge a
  // months-old session (and could arm the book on it).
  const tripEnd = sessionWindowAt(tripAt).end;
  const walkFrom = Math.max(tripEnd, now - SESSION_VERDICT_WINDOW_MS);
  const completed: SessionWindow[] = [];
  let cursor = sessionWindowAt(walkFrom).start;
  for (let i = 0; i < 400; i++) {
    const win = sessionWindowAt(cursor);
    if (win.end > now) break; // still open — not evidence yet
    completed.push(win);
    cursor = win.end;
  }
  if (completed.length === 0) return null;

  const measure = (win: SessionWindow): { n: number; netR: number } => {
    let n = 0;
    let netR = 0;
    for (const t of closes) {
      const at = t.exitTime;
      if (typeof at !== "number" || at < win.start || at >= win.end) continue;
      const r = typeof t.realizedR === "number" ? t.realizedR : t.r;
      if (typeof r !== "number" || !Number.isFinite(r)) continue;
      n++;
      netR += r;
    }
    return { n, netR };
  };

  // The newest completed session is the verdict — unless the paper book closed
  // NOTHING in it. Zero closes means no measurement happened, not a losing
  // session (exits cluster: a book can carry positions through a whole quiet
  // session), so step back to the newest session that actually closed one. A
  // session with SOME closes below the floor is still a verdict: unproven.
  let judged = completed[completed.length - 1];
  let { n, netR } = measure(judged);
  if (n === 0) {
    for (let i = completed.length - 2; i >= 0; i--) {
      const stats = measure(completed[i]);
      if (stats.n > 0) {
        judged = completed[i];
        n = stats.n;
        netR = stats.netR;
        break;
      }
    }
  }

  return {
    label: judged.label,
    start: judged.start,
    end: judged.end,
    closes: n,
    netR,
    minCloses: floor,
    // Strictly profitable, and only on a sample that can carry a verdict: a
    // thin session is UNPROVEN, and an unproven session is not a safe session
    // for the book that pays for its mistakes (same rule as the session
    // breaker's 2026-10-22 operator decision).
    profitable: n >= floor && netR > 0,
  };
}

/**
 * Does next-session evidence release a manual-mode disarm?
 *
 * Never in cooldown mode (the timer owns that release) and never when the
 * flag is off. `reason` is written verbatim to the live scan result, so it
 * says which session was judged and why it did or did not release.
 */
export function shouldRearmOnSession(
  cfg: LiveBreakerConfig,
  persisted: LiveBreakerPersisted,
  evidence: LiveBreakerSessionEvidence | null,
): { shouldRearm: boolean; reason: string } {
  if (!cfg.liveBreakerEnabled) return { shouldRearm: false, reason: "breaker disabled" };
  if (cfg.liveBreakerManualReArm === false) {
    return { shouldRearm: false, reason: "cooldown mode releases on its timer" };
  }
  if (cfg.liveBreakerRearmOnSession === false) {
    return { shouldRearm: false, reason: "next-session release off — manual re-arm only" };
  }
  if (persisted.disarmedAt == null) return { shouldRearm: false, reason: "not disarmed" };
  if (!evidence) {
    return { shouldRearm: false, reason: "no session has closed since the trip yet — still disarmed" };
  }
  if (evidence.closes < evidence.minCloses) {
    return {
      shouldRearm: false,
      reason: `${evidence.label} closed with ${evidence.closes} paper close(s) (<${evidence.minCloses}) — unproven, still disarmed`,
    };
  }
  if (!evidence.profitable) {
    return {
      shouldRearm: false,
      reason: `${evidence.label} closed at ${evidence.netR.toFixed(2)}R over ${evidence.closes} paper closes — not profitable, next session judged`,
    };
  }
  return {
    shouldRearm: true,
    reason: `${evidence.label} closed at +${evidence.netR.toFixed(2)}R over ${evidence.closes} paper closes — re-armed`,
  };
}

/**
 * Prefix a terminal scan status with the breaker release that happened on the
 * same tick.
 *
 * The auto re-arm runs BEFORE the scan, so every path that writes
 * lastScanResult afterwards (session prison, stale metrics, balance failure,
 * cap reached, tick failed, normal summary) has to carry it. When it did not,
 * the 2026-10-24 00:03Z tick released a disarmed book and the Live page showed
 * only "SESSION BLOCKED" — indistinguishable from a book that was never
 * disarmed. Pure so that property is unit-tested instead of retyped per branch.
 */
export function withRearmNote(text: string, rearmNote: string | null | undefined): string {
  return rearmNote ? `${rearmNote} · ${text}` : text;
}
