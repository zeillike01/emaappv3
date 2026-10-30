import { describe, expect, it } from "vitest";
import {
  computeLiveLossStreak,
  computeLiveBreakerState,
  measureCompletedSessionSince,
  sessionWindowAt,
  shouldRearmOnSession,
  withRearmNote,
  type LiveBreakerTrade,
} from "../live-breaker";

const H = 3_600_000;
const NOW = 100 * H;

/** Shipped behaviour (2026-10-22): 6 losses → hard disarm, manual re-arm. */
const manualCfg = {
  liveBreakerEnabled: true,
  liveBreakerMaxLossStreak: 6,
  liveBreakerCooldownMin: 720,
  liveBreakerManualReArm: true,
};

/** Legacy timed pause, still reachable via an explicit opt-out. */
const cooldownCfg = { ...manualCfg, liveBreakerManualReArm: false };

const trade = (pnl: number, hoursAgo: number): LiveBreakerTrade => ({
  pnlUsd: pnl,
  exitTime: NOW - hoursAgo * H,
});

/** N consecutive losses, newest first, starting `fromHoursAgo` back. */
const losses = (n: number, fromHoursAgo = 1): LiveBreakerTrade[] =>
  Array.from({ length: n }, (_, i) => trade(-1, fromHoursAgo + i));

describe("computeLiveLossStreak", () => {
  it("counts consecutive losses newest-first", () => {
    expect(computeLiveLossStreak([trade(-1, 1), trade(-1, 2), trade(-1, 3)])).toBe(3);
  });

  it("stops at a win", () => {
    expect(computeLiveLossStreak([trade(-1, 1), trade(2, 2), trade(-1, 3)])).toBe(1);
  });

  it("counts unreconciled (null pnl) rows as losses (conservative)", () => {
    // Audit fix 2026-09-11: an unknown-PnL close must never hide a real loss.
    expect(computeLiveLossStreak([trade(-1, 1), { exitTime: NOW - 2 * H }, trade(-1, 3)])).toBe(3);
  });

  it("a confirmed win still ends the streak even after a null row", () => {
    expect(computeLiveLossStreak([trade(2, 1), { exitTime: NOW - 2 * H }, trade(-1, 3)])).toBe(0);
  });

  it("returns 0 for an empty book", () => {
    expect(computeLiveLossStreak([])).toBe(0);
  });
});

describe("computeLiveBreakerState — manual disarm (default)", () => {
  it("arms below the 6-loss threshold", () => {
    const s = computeLiveBreakerState(manualCfg, losses(5), {}, NOW);
    expect(s.paused).toBe(false);
    expect(s.shouldTrip).toBe(false);
    expect(s.disarmedAt).toBe(null);
    expect(s.lossStreak).toBe(5);
  });

  it("disarms on the 6th consecutive loss and persists the stamp", () => {
    const s = computeLiveBreakerState(manualCfg, losses(6), {}, NOW);
    expect(s.paused).toBe(true);
    expect(s.shouldTrip).toBe(true);
    expect(s.pausedUntil).toBe(null);
    expect(s.disarmedAt).toBe(NOW);
    expect(s.reason).toContain("DISARMED");
  });

  it("stays disarmed indefinitely — no timer releases it", () => {
    const persisted = { disarmedAt: NOW - 100 * H, triggeredAt: NOW - 100 * H };
    const s = computeLiveBreakerState(manualCfg, losses(6), persisted, NOW);
    expect(s.paused).toBe(true);
    expect(s.shouldTrip).toBe(false);
    expect(s.disarmedAt).toBe(NOW - 100 * H);
  });

  it("stays disarmed even after a winning close", () => {
    const persisted = { disarmedAt: NOW - 20 * H, triggeredAt: NOW - 20 * H };
    // One win after the trip resets the streak to 0, but the operator has not
    // re-armed: the disarm is theirs to clear, not the book's.
    const recent = [trade(2, 1), ...losses(6, 2)];
    const s = computeLiveBreakerState(manualCfg, recent, persisted, NOW);
    expect(s.paused).toBe(true);
    expect(s.shouldTrip).toBe(false);
  });

  it("a manual re-arm (cleared stamp, triggeredAt = re-arm time) lets the same streak trade again", () => {
    // rearmLiveBreaker clears disarmedAt and stamps triggeredAt = NOW.
    const s = computeLiveBreakerState(manualCfg, losses(6), { triggeredAt: NOW }, NOW);
    expect(s.paused).toBe(false);
    expect(s.shouldTrip).toBe(false);
    expect(s.reason).toContain("re-armed");
  });

  it("re-disarms on the first loss that closes after a re-arm", () => {
    // 5 losses predate the re-arm, 1 closed after it → fresh evidence.
    const recent = [...losses(5, 3), trade(-1, 1)];
    const s = computeLiveBreakerState(manualCfg, recent, { triggeredAt: NOW - 2 * H }, NOW);
    expect(s.lossStreak).toBe(6);
    expect(s.paused).toBe(true);
    expect(s.shouldTrip).toBe(true);
    expect(s.disarmedAt).toBe(NOW);
  });

  it("counts null-PnL closes toward the 6-loss trip", () => {
    const recent: LiveBreakerTrade[] = [
      { exitTime: NOW - 1 * H },
      { exitTime: NOW - 2 * H },
      ...losses(4, 3),
    ];
    const s = computeLiveBreakerState(manualCfg, recent, {}, NOW);
    expect(s.lossStreak).toBe(6);
    expect(s.paused).toBe(true);
    expect(s.shouldTrip).toBe(true);
  });

  it("defaults to manual mode when the flag is omitted (legacy config rows)", () => {
    const noFlag = {
      liveBreakerEnabled: true,
      liveBreakerMaxLossStreak: 6,
      liveBreakerCooldownMin: 720,
    };
    const s = computeLiveBreakerState(noFlag, losses(6), {}, NOW);
    expect(s.paused).toBe(true);
    expect(s.shouldTrip).toBe(true);
    expect(s.pausedUntil).toBe(null);
    expect(s.disarmedAt).toBe(NOW);
  });

  it("does nothing when disabled", () => {
    const s = computeLiveBreakerState(
      { ...manualCfg, liveBreakerEnabled: false },
      losses(6),
      {},
      NOW,
    );
    expect(s.paused).toBe(false);
    expect(s.shouldTrip).toBe(false);
    expect(s.disarmedAt).toBe(null);
  });
});

describe("computeLiveBreakerState — legacy cooldown (manualReArm: false)", () => {
  it("trips on 6 losses and sets a 12h pause", () => {
    const s = computeLiveBreakerState(cooldownCfg, losses(6), {}, NOW);
    expect(s.paused).toBe(true);
    expect(s.shouldTrip).toBe(true);
    expect(s.pausedUntil).toBe(NOW + 720 * 60_000);
    expect(s.disarmedAt).toBe(null);
  });

  it("stays paused inside the cooldown without re-tripping", () => {
    const persisted = { pausedUntil: NOW + 5 * H, triggeredAt: NOW - 7 * H };
    const s = computeLiveBreakerState(cooldownCfg, losses(6), persisted, NOW);
    expect(s.paused).toBe(true);
    expect(s.shouldTrip).toBe(false);
  });

  it("re-arms after the cooldown when the streak is all pre-trigger history", () => {
    const persisted = { pausedUntil: NOW - 1 * H, triggeredAt: NOW - 13 * H };
    const s = computeLiveBreakerState(cooldownCfg, losses(6, 13.5), persisted, NOW);
    expect(s.paused).toBe(false);
    expect(s.shouldTrip).toBe(false);
  });

  it("immediately re-trips when a fresh post-trigger loss keeps the streak alive", () => {
    const persisted = { pausedUntil: NOW - 1 * H, triggeredAt: NOW - 13 * H };
    // Five pre-trigger losses + one that closed AFTER the trigger.
    const recent = [...losses(5, 13.5), trade(-1, 2)];
    const s = computeLiveBreakerState(cooldownCfg, recent, persisted, NOW);
    expect(s.paused).toBe(true);
    expect(s.shouldTrip).toBe(true);
  });

  it("re-arms when a win ends the streak after the cooldown", () => {
    const persisted = { pausedUntil: NOW - 1 * H, triggeredAt: NOW - 13 * H };
    const recent = [trade(2, 1), ...losses(6, 2)];
    const s = computeLiveBreakerState(cooldownCfg, recent, persisted, NOW);
    expect(s.paused).toBe(false);
    expect(s.shouldTrip).toBe(false);
  });

  it("ignores a stale manual disarm stamp when the cooldown mode is selected", () => {
    const persisted = { disarmedAt: NOW - 50 * H, triggeredAt: NOW - 50 * H };
    const s = computeLiveBreakerState(cooldownCfg, losses(6, 60), persisted, NOW);
    expect(s.paused).toBe(false);
    expect(s.shouldTrip).toBe(false);
  });
});

// ── NEXT-SESSION RELEASE (2026-10-23) ───────────────────────────────────────
// Sessions are the engine's UTC buckets: asia 00-07, london 07-13,
// ldn-ny 13-17, ny 17-22, late 22-24.

const DAY = Date.UTC(2026, 9, 23);
const at = (h: number, m = 0) => DAY + h * H + m * 60_000;
/** A closed PAPER close: only exitTime + realizedR matter to the verdict. */
const close = (hour: number, minute: number, r: number) => ({
  exitTime: at(hour, minute),
  realizedR: r,
});

describe("sessionWindowAt — engine session buckets", () => {
  it("maps each UTC hour to the label sessionOf() produces", () => {
    expect(sessionWindowAt(at(0)).label).toBe("asia");
    expect(sessionWindowAt(at(6, 59)).label).toBe("asia");
    expect(sessionWindowAt(at(7)).label).toBe("london");
    expect(sessionWindowAt(at(12, 59)).label).toBe("london");
    expect(sessionWindowAt(at(13)).label).toBe("ldn-ny");
    expect(sessionWindowAt(at(17)).label).toBe("ny");
    expect(sessionWindowAt(at(22)).label).toBe("late");
  });

  it("gives each window its true end (late closes at the next UTC midnight)", () => {
    expect(sessionWindowAt(at(13)).start).toBe(at(13));
    expect(sessionWindowAt(at(13)).end).toBe(at(17));
    expect(sessionWindowAt(at(23)).end).toBe(DAY + 24 * H);
  });
});

describe("measureCompletedSessionSince", () => {
  const trip = at(9, 18); // london — the session the book was disarmed in

  it("returns null while the first post-trip session is still running", () => {
    // ldn-ny (13:00-17:00) has not closed yet at 16:00.
    const ev = measureCompletedSessionSince(trip, at(16), [close(14, 0, 1.2)], 3);
    expect(ev).toBe(null);
  });

  it("judges the most recent session that closed after the trip", () => {
    // At 17:30 the only completed post-trip session is ldn-ny.
    const ev = measureCompletedSessionSince(
      trip,
      at(17, 30),
      [close(13, 30, 1.0), close(14, 30, -0.4), close(15, 30, 0.9)],
      3,
    );
    expect(ev).toMatchObject({ label: "ldn-ny", start: at(13), end: at(17), closes: 3 });
    expect(ev!.netR).toBeCloseTo(1.5, 6);
    expect(ev!.profitable).toBe(true);
  });

  it("writes off the trip's own session — its P&L is the evidence that failed", () => {
    // A huge london profit must not release the book; only ldn-ny is judged.
    const ev = measureCompletedSessionSince(
      trip,
      at(17, 30),
      [close(9, 30, -1), close(11, 0, 5), close(14, 0, -2)],
      1,
    );
    expect(ev!.label).toBe("ldn-ny");
    expect(ev!.closes).toBe(1);
    expect(ev!.netR).toBeCloseTo(-2, 6);
    expect(ev!.profitable).toBe(false);
  });

  it("ignores closes from the session that is still open", () => {
    const ev = measureCompletedSessionSince(
      trip,
      at(18, 30), // ny (17:00-22:00) is open
      [close(14, 0, 1.0), close(17, 30, -9)],
      1,
    );
    expect(ev!.label).toBe("ldn-ny");
    expect(ev!.closes).toBe(1);
    expect(ev!.netR).toBeCloseTo(1.0, 6);
  });

  it("advances to the next session when the last one closed red", () => {
    // 22:30 — ldn-ny and ny have both closed; ny is judged.
    const ev = measureCompletedSessionSince(
      trip,
      at(22, 30),
      [close(14, 0, -3), close(18, 0, 0.5), close(19, 0, 0.7)],
      2,
    );
    expect(ev!.label).toBe("ny");
    expect(ev!.netR).toBeCloseTo(1.2, 6);
    expect(ev!.profitable).toBe(true);
  });

  it("falls back to the last session that closed a trade when the newest one is empty", () => {
    // ny (17-22) closed nothing at all; ldn-ny's verdict still stands. A
    // session with no exits is no measurement, not a loss.
    const ev = measureCompletedSessionSince(trip, at(22, 30), [close(14, 0, 1.4), close(15, 0, 0.6)], 2);
    expect(ev!.label).toBe("ldn-ny");
    expect(ev!.closes).toBe(2);
    expect(ev!.netR).toBeCloseTo(2.0, 6);
    expect(ev!.profitable).toBe(true);
  });

  it("still refuses when the newest session DID close trades and lost", () => {
    // ny has 2 closes and is red: no fallback to the green ldn-ny behind it.
    const ev = measureCompletedSessionSince(
      trip,
      at(22, 30),
      [close(14, 0, 5), close(18, 0, -1), close(19, 0, -1)],
      2,
    );
    expect(ev!.label).toBe("ny");
    expect(ev!.netR).toBeCloseTo(-2, 6);
    expect(ev!.profitable).toBe(false);
  });

  it("never calls a thin session profitable, however green it is", () => {
    const ev = measureCompletedSessionSince(trip, at(17, 30), [close(14, 0, 8)], 3);
    expect(ev!.closes).toBe(1);
    expect(ev!.netR).toBeCloseTo(8, 6);
    expect(ev!.profitable).toBe(false); // unproven is not safe
  });

  it("judges the NEWEST session even when the trip is far older than the walk guard", () => {
    // A book disarmed for 200 days used to stop walking at the 400-session
    // safety cap (~80 days) and report that months-old session as the verdict.
    // The walk now starts no earlier than 30 days back, so `now` is always
    // reachable and the freshest completed session is the one judged.
    const oldTrip = at(9, 18) - 200 * 24 * H;
    const now = at(23, 59);
    const closes = [
      close(2, 0, 1.1), // asia, same day
      close(14, 0, 0.7), // ldn-ny, same day
    ];
    const ev = measureCompletedSessionSince(oldTrip, now, closes, 1)!;
    // 23:59 sits in `late` (22:00-24:00), which is still open; the newest
    // CLOSED session is ny (17:00-22:00), with no closes → step back to the
    // newest one that closed a trade: ldn-ny, TODAY.
    expect(ev.label).toBe("ldn-ny");
    expect(ev.end).toBe(at(17));
    expect(now - ev.end).toBeLessThan(24 * H);
    expect(ev.closes).toBe(1);
  });

  it("skips closes with no usable R", () => {
    const ev = measureCompletedSessionSince(
      trip,
      at(17, 30),
      [close(14, 0, 1.0), { exitTime: at(14, 30) }, { exitTime: at(15, 0), realizedR: NaN }],
      1,
    );
    expect(ev!.closes).toBe(1);
    expect(ev!.netR).toBeCloseTo(1.0, 6);
  });
});

describe("shouldRearmOnSession", () => {
  const disarmed = { disarmedAt: NOW - 8 * H, triggeredAt: NOW - 8 * H };
  const evidence = (netR: number, closes = 12) => ({
    label: "ldn-ny",
    start: NOW - 4 * H,
    end: NOW,
    closes,
    netR,
    minCloses: 10,
    profitable: closes >= 10 && netR > 0,
  });

  it("releases a manual-mode disarm on a profitable session", () => {
    const rel = shouldRearmOnSession(manualCfg, disarmed, evidence(4.2));
    expect(rel.shouldRearm).toBe(true);
    expect(rel.reason).toContain("+4.20R");
  });

  it("keeps the veto when the session closed red, naming the session", () => {
    const rel = shouldRearmOnSession(manualCfg, disarmed, evidence(-2.5));
    expect(rel.shouldRearm).toBe(false);
    expect(rel.reason).toContain("ldn-ny");
    expect(rel.reason).toContain("not profitable");
  });

  it("keeps the veto on a thin sample even when it is green", () => {
    const rel = shouldRearmOnSession(manualCfg, disarmed, evidence(6, 3));
    expect(rel.shouldRearm).toBe(false);
    expect(rel.reason).toContain("unproven");
  });

  it("waits while no session has closed since the trip", () => {
    const rel = shouldRearmOnSession(manualCfg, disarmed, null);
    expect(rel.shouldRearm).toBe(false);
    expect(rel.reason).toContain("no session has closed");
  });

  it("stays a pure latch when the session release is switched off", () => {
    const rel = shouldRearmOnSession(
      { ...manualCfg, liveBreakerRearmOnSession: false },
      disarmed,
      evidence(9),
    );
    expect(rel.shouldRearm).toBe(false);
    expect(rel.reason).toContain("manual re-arm only");
  });

  it("never fights the cooldown mode, which owns its own release", () => {
    const rel = shouldRearmOnSession(cooldownCfg, {}, evidence(9));
    expect(rel.shouldRearm).toBe(false);
    expect(rel.reason).toContain("cooldown");
  });

  it("does nothing when the book is not disarmed", () => {
    const rel = shouldRearmOnSession(manualCfg, {}, evidence(9));
    expect(rel.shouldRearm).toBe(false);
    expect(rel.reason).toBe("not disarmed");
  });

  it("does nothing when the breaker is disabled", () => {
    const rel = shouldRearmOnSession(
      { ...manualCfg, liveBreakerEnabled: false },
      disarmed,
      evidence(9),
    );
    expect(rel.shouldRearm).toBe(false);
  });
});

describe("withRearmNote", () => {
  it("leaves a status untouched when no re-arm happened this tick", () => {
    expect(withRearmNote("SESSION BLOCKED — no entry scan: x", null)).toBe(
      "SESSION BLOCKED — no entry scan: x",
    );
    expect(withRearmNote("POSITION CAP REACHED — 10 of 10 open", undefined)).toBe(
      "POSITION CAP REACHED — 10 of 10 open",
    );
  });

  it("prefixes the release line so an auto re-arm is never silent", () => {
    const note = "CIRCUIT BREAKER auto re-armed: late closed at +9.10R over 16 paper closes — re-armed";
    expect(withRearmNote("SESSION BLOCKED — no entry scan: x", note)).toBe(
      `${note} · SESSION BLOCKED — no entry scan: x`,
    );
    // Every terminal branch shares this one shape: release first, status second.
    expect(withRearmNote("TICK FAILED — boom", note).startsWith(note)).toBe(true);
  });

  it("cannot be applied twice by accident: the prefix is the whole note", () => {
    const note = "CIRCUIT BREAKER auto re-armed: ny closed at +2.40R over 12 paper closes — re-armed";
    expect(withRearmNote(note, note)).toBe(`${note} · ${note}`);
  });
});
