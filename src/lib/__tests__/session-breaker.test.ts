import { describe, expect, it } from "vitest";
import {
  bookBalanceWithCarry,
  computeSessionBreaker,
  emptySessionWindowCarry,
  measuredWindowDays,
  sessionBreakerBlock,
  sessionBreakerDayKey,
  sessionBreakerReason,
  sessionScanVerdict,
  type SessionScanConfig,
  sessionWindowCarryOf,
  sessionWindowCutoff,
  statsWithCarry,
  SESSION_BREAKER_DEFAULTS,
  type SessionBreakerClosedLike,
  type SessionBreakerConfig,
} from "../session-breaker";

const NOW = Date.UTC(2026, 9, 20, 23, 0, 0); // 2026-10-20T23:00Z
const HOUR = 3_600_000;
const DAY = 86_400_000;

const cfg = (over: Partial<SessionBreakerConfig> = {}): SessionBreakerConfig => ({
  sessionBreakerLookbackDays: SESSION_BREAKER_DEFAULTS.sessionBreakerLookbackDays,
  sessionBreakerMinTrades: SESSION_BREAKER_DEFAULTS.sessionBreakerMinTrades,
  sessionBreakerMinProfitR: SESSION_BREAKER_DEFAULTS.sessionBreakerMinProfitR,
  ...over,
});

/** A close `hoursAgo` before NOW with an explicit realized R. */
const close = (
  session: string,
  side: "LONG" | "SHORT",
  r: number,
  hoursAgo = 1,
): SessionBreakerClosedLike => ({
  session,
  type: side,
  exitTime: NOW - hoursAgo * HOUR,
  realizedR: r,
});

const bucket = (state: ReturnType<typeof computeSessionBreaker>, session: string, side: string) =>
  state.buckets.find((b) => b.session === session && b.side === side);

/**
 * The blocked buckets that actually hold closes, sorted — the grid seeds every
 * session × side, so a raw list always includes the zero-evidence ones too.
 */
const measuredBlocked = (state: ReturnType<typeof computeSessionBreaker>) =>
  state.blocked.filter((b) => b.trades > 0).map((b) => `${b.session}|${b.side}`);

describe("computeSessionBreaker — bucketing", () => {
  it("separates sessions and sides instead of pooling the book", () => {
    const state = computeSessionBreaker(
      [
        close("late", "SHORT", -1),
        close("late", "SHORT", -1),
        close("ny", "SHORT", 2),
        close("ny", "LONG", -1),
      ],
      cfg({ sessionBreakerMinTrades: 1 }),
      NOW,
    );
    expect(bucket(state, "late", "SHORT")!.sumR).toBe(-2);
    expect(bucket(state, "ny", "SHORT")!.sumR).toBe(2);
    expect(bucket(state, "ny", "LONG")!.sumR).toBe(-1);
    expect(measuredBlocked(state)).toEqual(["late|SHORT", "ny|LONG"]);
  });

  it("reads the side from `side` as well as `type`", () => {
    const state = computeSessionBreaker(
      [{ session: "asia", side: "LONG", exitTime: NOW - HOUR, realizedR: -1 }],
      cfg({ sessionBreakerMinTrades: 1 }),
      NOW,
    );
    expect(bucket(state, "asia", "LONG")!.trades).toBe(1);
  });

  it("falls back to the session of the signal bar when the stored label is missing", () => {
    // 2026-10-20T23:30Z ⇒ "late" (>= 22 UTC), signalTime drives the fallback.
    const signalTime = Date.UTC(2026, 9, 20, 23, 30);
    const state = computeSessionBreaker(
      [{ exitTime: NOW, signalTime, type: "SHORT", realizedR: -1 }],
      cfg({ sessionBreakerMinTrades: 1 }),
      NOW,
    );
    // The fallback labels the observed bucket; the grid adds the rest.
    expect(bucket(state, "late", "SHORT")!.trades).toBe(1);
    expect(state.buckets).toHaveLength(10);
  });
});

describe("computeSessionBreaker — profitability verdict", () => {
  it("leaves a profitable bucket open", () => {
    const state = computeSessionBreaker(
      Array.from({ length: 10 }, () => close("ny", "SHORT", 0.5)),
      cfg(),
      NOW,
    );
    expect(bucket(state, "ny", "SHORT")!.blocked).toBe(false);
    expect(measuredBlocked(state)).toEqual([]);
  });

  it("blocks a losing bucket that has enough evidence", () => {
    const state = computeSessionBreaker(
      Array.from({ length: 10 }, () => close("late", "SHORT", -0.5)),
      cfg(),
      NOW,
    );
    expect(measuredBlocked(state)).toEqual(["late|SHORT"]);
  });

  it("treats a flat bucket as not profitable (strictly positive is required)", () => {
    const flat = computeSessionBreaker(
      [
        ...Array.from({ length: 5 }, () => close("late", "SHORT", 1)),
        ...Array.from({ length: 5 }, () => close("late", "SHORT", -1)),
      ],
      cfg(),
      NOW,
    );
    expect(bucket(flat, "late", "SHORT")!.sumR).toBe(0);
    expect(bucket(flat, "late", "SHORT")!.blocked).toBe(true);
  });

  it("refuses a bucket below the minimum trade count — unproven, not unprofitable", () => {
    // 2026-10-22 operator rule: live spends real money, so a thin sample is a
    // refusal. It must be labelled as missing evidence, never as a loss.
    const state = computeSessionBreaker(
      Array.from({ length: 9 }, () => close("ny", "LONG", 1)),
      cfg(),
      NOW,
    );
    const b = bucket(state, "ny", "LONG")!;
    expect(b.trades).toBe(9);
    expect(b.insufficient).toBe(true);
    expect(b.blocked).toBe(true);
    expect(measuredBlocked(state)).toEqual(["ny|LONG"]);
    expect(sessionBreakerReason(b)).toBe(
      "session has too little evidence: ny LONG 9 paper close(s) < 10",
    );
  });

  it("emits the full session × side grid so a never-measured cohort cannot be traded", () => {
    const state = computeSessionBreaker([], cfg(), NOW);
    expect(state.buckets).toHaveLength(10);
    expect(state.blocked).toHaveLength(10);
    expect(state.buckets.map((b) => b.session)).toEqual([
      "asia",
      "asia",
      "late",
      "late",
      "ldn-ny",
      "ldn-ny",
      "london",
      "london",
      "ny",
      "ny",
    ]);
    const empty = bucket(state, "ny", "SHORT")!;
    expect(empty.trades).toBe(0);
    expect(empty.insufficient).toBe(true);
    expect(empty.minTrades).toBe(10);
    expect(sessionBreakerReason(empty)).toBe(
      "session has too little evidence: ny SHORT 0 paper close(s) < 10",
    );
    // And it refuses a live entry exactly like a losing bucket does.
    expect(sessionBreakerBlock(state, "ny", "SHORT")).toBeDefined();
  });

  it("keeps a proven-profitable bucket open while the unproven grid stays closed", () => {
    const state = computeSessionBreaker(
      Array.from({ length: 10 }, () => close("ny", "SHORT", 0.5)),
      cfg(),
      NOW,
    );
    const proven = bucket(state, "ny", "SHORT")!;
    expect(proven.insufficient).toBe(false);
    expect(proven.blocked).toBe(false);
    expect(state.blocked).toHaveLength(9);
  });

  it("does not let one side condemn the other in the same session", () => {
    const state = computeSessionBreaker(
      [
        ...Array.from({ length: 10 }, () => close("asia", "SHORT", -0.5)),
        ...Array.from({ length: 10 }, () => close("asia", "LONG", 0.5)),
      ],
      cfg(),
      NOW,
    );
    expect(bucket(state, "asia", "SHORT")!.blocked).toBe(true);
    expect(bucket(state, "asia", "LONG")!.blocked).toBe(false);
    expect(bucket(state, "asia", "LONG")!.insufficient).toBe(false);
  });

  it("honours a higher profit floor", () => {
    const state = computeSessionBreaker(
      Array.from({ length: 10 }, () => close("ny", "LONG", 0.5)), // +5R
      cfg({ sessionBreakerMinProfitR: 6 }),
      NOW,
    );
    expect(bucket(state, "ny", "LONG")!.blocked).toBe(true);
  });

  it("re-opens as soon as the paper record turns profitable (paper keeps trading)", () => {
    const losing = Array.from({ length: 10 }, () => close("late", "SHORT", -0.4)); // −4R
    expect(measuredBlocked(computeSessionBreaker(losing, cfg(), NOW))).toEqual(["late|SHORT"]);

    const recovered = [...losing, close("late", "SHORT", 4.5)]; // +0.5R
    const state = computeSessionBreaker(recovered, cfg(), NOW);
    expect(bucket(state, "late", "SHORT")!.sumR).toBeCloseTo(0.5, 6);
    expect(measuredBlocked(state)).toEqual([]);
  });

  it("re-arms by aging closes out of the window", () => {
    const recent = Array.from({ length: 10 }, () => close("late", "SHORT", -0.5, 1));
    expect(measuredBlocked(computeSessionBreaker(recent, cfg(), NOW))).toEqual(["late|SHORT"]);

    const old = Array.from({ length: 10 }, () => close("late", "SHORT", -0.5, 15 * 24));
    // The losing closes age out; the bucket does not re-open — it falls back to
    // unproven (0 closes), which the grid refuses too.
    const state = computeSessionBreaker(old, cfg(), NOW);
    expect(bucket(state, "late", "SHORT")!.trades).toBe(0);
    expect(bucket(state, "late", "SHORT")!.insufficient).toBe(true);
    expect(measuredBlocked(state)).toEqual([]);
  });
});

describe("computeSessionBreaker — data hygiene", () => {
  it("ignores unreconciled rows and rows outside the window", () => {
    const state = computeSessionBreaker(
      [
        { session: "late", type: "SHORT", exitTime: NOW, realizedR: null },
        { session: "late", type: "SHORT", exitTime: null, realizedR: -1 },
        { session: "late", type: "SHORT", exitTime: NOW + DAY, realizedR: -1 },
        { session: "late", type: "SHORT", exitTime: NOW - 20 * DAY, realizedR: -1 },
        close("late", "SHORT", -1),
      ],
      cfg({ sessionBreakerMinTrades: 1 }),
      NOW,
    );
    expect(bucket(state, "late", "SHORT")!.trades).toBe(1);
  });

  it("clamps a nonsense config instead of dividing by it", () => {
    const state = computeSessionBreaker(
      Array.from({ length: 10 }, () => close("ny", "LONG", -1)),
      cfg({
        sessionBreakerLookbackDays: 0,
        sessionBreakerMinTrades: 0,
        sessionBreakerMinProfitR: Number.NaN,
      }),
      NOW,
    );
    expect(state.minTrades).toBe(1);
    expect(state.minProfitR).toBe(0);
    expect(state.blocked.filter((b) => b.trades > 0)).toHaveLength(1);
  });
});

describe("sessionBreakerBlock", () => {
  const state = computeSessionBreaker(
    Array.from({ length: 10 }, () => close("late", "SHORT", -0.4)),
    cfg(),
    NOW,
  );

  it("blocks the unprofitable bucket and refuses the unproven ones", () => {
    expect(sessionBreakerBlock(state, "late", "SHORT")?.sumR).toBeCloseTo(-4, 6);
    // No closes at all is still a refusal now — but for lack of evidence.
    expect(sessionBreakerBlock(state, "late", "LONG")?.insufficient).toBe(true);
    expect(sessionBreakerBlock(state, "late", "LONG")?.trades).toBe(0);
    expect(sessionBreakerBlock(state, "ny", "SHORT")?.insufficient).toBe(true);
  });

  it("fails open on a missing/empty snapshot or an unknown side", () => {
    expect(sessionBreakerBlock(null, "late", "SHORT")).toBeUndefined();
    expect(sessionBreakerBlock({ blocked: [] }, "late", "SHORT")).toBeUndefined();
    expect(sessionBreakerBlock(state, "late", "ERROR")).toBeUndefined();
  });

  it("produces the engine's canonical reason line", () => {
    const b = sessionBreakerBlock(state, "late", "SHORT")!;
    expect(sessionBreakerReason(b)).toBe(
      "session not profitable: late SHORT -4.00R over 10 trades",
    );
  });
});

describe("sessionBreakerDayKey", () => {
  it("is the UTC calendar day", () => {
    expect(sessionBreakerDayKey(Date.UTC(2026, 9, 20, 23, 59))).toBe("2026-10-20");
    expect(sessionBreakerDayKey(Date.UTC(2026, 9, 21, 0, 1))).toBe("2026-10-21");
  });
});

describe("sessionWindowCutoff", () => {
  it("is the lookback window before now", () => {
    expect(sessionWindowCutoff(NOW, 14)).toBe(NOW - 14 * DAY);
  });

  it("clamps a nonsense lookback to at least one day", () => {
    expect(sessionWindowCutoff(NOW, 0)).toBe(NOW - DAY);
    expect(sessionWindowCutoff(NOW, -5)).toBe(NOW - DAY);
    expect(sessionWindowCutoff(NOW, 9999)).toBe(NOW - 90 * DAY);
  });
});

describe("measuredWindowDays (ledger retention)", () => {
  // TWO rankings read the pruned ledger: the session breaker and the per-coin
  // priority, each with its own lookback. Retaining the narrower one silently
  // starves the wider: a 30-day coin ranking over a 14-day ledger computes 14
  // days of evidence and labels it 30.
  it("keeps the wider of the two lookbacks", () => {
    expect(measuredWindowDays({ sessionBreakerLookbackDays: 14, coinPriorityLookbackDays: 30 })).toBe(30);
    expect(measuredWindowDays({ sessionBreakerLookbackDays: 21, coinPriorityLookbackDays: 7 })).toBe(21);
    expect(measuredWindowDays({ sessionBreakerLookbackDays: 14, coinPriorityLookbackDays: 14 })).toBe(14);
  });

  it("clamps to the documented 1..90 band and survives a missing coin lookback", () => {
    expect(measuredWindowDays({ sessionBreakerLookbackDays: 0, coinPriorityLookbackDays: 0 })).toBe(1);
    expect(measuredWindowDays({ sessionBreakerLookbackDays: 500, coinPriorityLookbackDays: 14 })).toBe(90);
    expect(measuredWindowDays({ sessionBreakerLookbackDays: 10 })).toBe(10);
  });
});

describe("sessionWindowCarryOf", () => {
  it("sums the P&L, fees and R of the rows leaving the window", () => {
    const carry = sessionWindowCarryOf([
      { exitTime: NOW - 20 * DAY, pnlUsd: 12.5, totalFeesUsd: 0.4, realizedR: 1.2 },
      { exitTime: NOW - 15 * DAY, pnlUsd: -3.25, totalFeesUsd: 0.2, realizedR: -0.5 },
      { exitTime: NOW - 19 * DAY, pnlUsd: 0, totalFeesUsd: 0.1, realizedR: 0 },
    ]);
    expect(carry.trades).toBe(3);
    expect(carry.wins).toBe(1);
    expect(carry.realizedPnlUsd).toBeCloseTo(9.25, 6);
    expect(carry.totalFeesUsd).toBeCloseTo(0.7, 6);
    expect(carry.realizedR).toBeCloseTo(0.7, 6);
    expect(carry.oldestExitTime).toBe(NOW - 20 * DAY);
    expect(carry.newestExitTime).toBe(NOW - 15 * DAY);
  });

  it("treats a missing P&L as zero but still counts the row", () => {
    const carry = sessionWindowCarryOf([{ exitTime: NOW - 20 * DAY }]);
    expect(carry.trades).toBe(1);
    expect(carry.wins).toBe(0);
    expect(carry.realizedPnlUsd).toBe(0);
  });

  it("is empty for no rows", () => {
    expect(sessionWindowCarryOf([])).toEqual(emptySessionWindowCarry());
  });
});

describe("bookBalanceWithCarry", () => {
  it("does not move the balance when P&L leaves the ledger for the carry", () => {
    const ledger = [
      { pnlUsd: 12.5 },
      { pnlUsd: -3.25 },
      { pnlUsd: 55.780405 },
    ];
    const before = bookBalanceWithCarry(150, 65.030405);
    // The oldest row ages out: its P&L moves from the ledger term into the
    // carry term. The balance must be identical on both sides.
    const carry = sessionWindowCarryOf([{ exitTime: NOW - 20 * DAY, pnlUsd: 12.5 }]);
    const after = bookBalanceWithCarry(150, 65.030405 - 12.5, carry.realizedPnlUsd);
    expect(after).toBeCloseTo(before, 9);
    expect(before).toBeCloseTo(215.030405, 6);
    expect(ledger.length).toBe(3);
  });

  it("falls back to the plain ledger balance with no carry", () => {
    expect(bookBalanceWithCarry(150, 10)).toBeCloseTo(160, 9);
  });
});

describe("sessionScanVerdict — whole-tick session prison (live only)", () => {
  const scanCfg = (over: Partial<SessionScanConfig> = {}): SessionScanConfig => ({
    allowLong: true,
    allowShort: true,
    longSessions: [],
    shortSessions: [],
    ...over,
  });
  const blockedBoth = {
    blocked: [
      { session: "london", side: "LONG" as const, trades: 12, wins: 4, sumR: -1.84, winRate: 1 / 3, blocked: true },
      { session: "london", side: "SHORT" as const, trades: 33, wins: 12, sumR: -2.34, winRate: 36 / 100, blocked: true },
    ],
  };

  it("skips only when BOTH sides are impossible", () => {
    expect(sessionScanVerdict(scanCfg(), "london", blockedBoth).skip).toBe(true);
    expect(sessionScanVerdict(scanCfg(), "asia", blockedBoth).skip).toBe(false);
  });

  it("names both vetoes in the summary line", () => {
    const v = sessionScanVerdict(scanCfg(), "london", blockedBoth);
    expect(v.longBlockedBy).toBe("session not profitable: london LONG -1.84R over 12 trades");
    expect(v.shortBlockedBy).toBe("session not profitable: london SHORT -2.34R over 33 trades");
    expect(v.reason).toContain("london");
    expect(v.reason).toContain("LONG blocked");
    expect(v.reason).toContain("SHORT blocked");
  });

  it("treats an unproven bucket as a refusal, without calling it a loss", () => {
    const thinBoth = {
      blocked: [
        { session: "late", side: "LONG" as const, trades: 3, wins: 3, sumR: 4.49, winRate: 1, insufficient: true, minTrades: 10, blocked: true },
        { session: "late", side: "SHORT" as const, trades: 17, wins: 6, sumR: -2.23, winRate: 6 / 17, blocked: true },
      ],
    };
    const v = sessionScanVerdict(scanCfg(), "late", thinBoth);
    expect(v.skip).toBe(true);
    expect(v.longBlockedBy).toBe("session has too little evidence: late LONG 3 paper close(s) < 10");
    expect(v.shortBlockedBy).toContain("session not profitable: late SHORT");
  });

  it("one blocked side is not a prison — the other side can still enter", () => {
    const oneSide = { blocked: [blockedBoth.blocked[0]!] };
    const v = sessionScanVerdict(scanCfg(), "london", oneSide);
    expect(v.skip).toBe(false);
    expect(v.longBlockedBy).not.toBeNull();
    expect(v.shortBlockedBy).toBeNull();
    expect(v.reason).toBe("");
  });

  it("both sides disabled in config is a prison with no breaker at all", () => {
    const v = sessionScanVerdict(scanCfg({ allowLong: false, allowShort: false }), "ny", null);
    expect(v.skip).toBe(true);
    expect(v.longBlockedBy).toBe("long disabled");
    expect(v.shortBlockedBy).toBe("short disabled");
  });

  it("an allowlist that excludes the session on both sides is a prison", () => {
    const v = sessionScanVerdict(
      scanCfg({ longSessions: ["asia"], shortSessions: ["ny"] }),
      "london",
      null,
    );
    expect(v.skip).toBe(true);
    expect(v.longBlockedBy).toContain("london not in the long allowlist");
    expect(v.shortBlockedBy).toContain("london not in the short allowlist");
  });

  it("fails OPEN on a missing snapshot (fail-open = run the scan)", () => {
    expect(sessionScanVerdict(scanCfg(), "london", null).skip).toBe(false);
    expect(sessionScanVerdict(scanCfg(), "london", undefined).skip).toBe(false);
    expect(sessionScanVerdict(scanCfg(), "london", { blocked: [] }).skip).toBe(false);
  });
});

describe("statsWithCarry", () => {
  it("keeps the lifetime counters where they were when rows are pruned", () => {
    const ledger = { closedCount: 10, wins: 6, realizedPnl: 65.03, totalFeesUsd: 4.2 };
    const carry = sessionWindowCarryOf([
      { exitTime: NOW - 20 * DAY, pnlUsd: 12.5, totalFeesUsd: 0.4 },
      { exitTime: NOW - 15 * DAY, pnlUsd: -3.25, totalFeesUsd: 0.2 },
    ]);
    const after = statsWithCarry(
      {
        closedCount: ledger.closedCount - carry.trades,
        wins: ledger.wins - carry.wins,
        realizedPnl: ledger.realizedPnl - carry.realizedPnlUsd,
        totalFeesUsd: ledger.totalFeesUsd - carry.totalFeesUsd,
      },
      carry,
    );
    expect(after).toEqual(ledger);
  });
});
