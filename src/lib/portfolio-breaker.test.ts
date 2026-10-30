import { describe, expect, test } from "vitest";
import {
  breakerHaltIntervals,
  haltCoverage,
  isHalted,
  PORTFOLIO_BREAKER_DEFAULTS,
  type ClosedLike,
  type PortfolioBreakerCfg,
} from "./portfolio-breaker";

const BAR = 900_000;
const DAY = 86_400_000;
const T0 = Date.parse("2026-03-02T00:00:00Z");

/** One close every `gapMs`, starting at T0. */
const closes = (rs: number[], gapMs = BAR, pair = "SOL"): ClosedLike[] =>
  rs.map((r, i) => ({ pair, exitTime: T0 + i * gapMs, r }));

const cfg = (over: Partial<PortfolioBreakerCfg> = {}): PortfolioBreakerCfg => ({
  ...PORTFOLIO_BREAKER_DEFAULTS,
  ...over,
});

describe("portfolio breaker triggers", () => {
  test("off produces no halts at all", () => {
    const iv = breakerHaltIntervals(closes([-1, -1, -1, -1, -1]), cfg({ trigger: "off" }));
    expect(iv).toEqual([]);
  });

  test("daily_loss_r halts once the day's realized R crosses the cap", () => {
    // -1, -1, -1 trips a -3R cap; the halt runs to the end of the UTC day.
    const iv = breakerHaltIntervals(closes([-1, -1, -1, 2, 2]), cfg({ trigger: "daily_loss_r", threshold: 3 }));
    expect(iv).toHaveLength(1);
    expect(iv[0]!.from).toBe(T0 + 2 * BAR);
    expect(iv[0]!.until).toBe(Date.parse("2026-03-03T00:00:00Z"));
    expect(iv[0]!.reason).toMatch(/day R -3/);
  });

  test("daily_loss_r resets at the UTC day boundary", () => {
    // 4h spacing keeps several closes inside each UTC day. Day 1 trips on its
    // third loss; day 2 recovers (+5R); day 3 trips again. Two halts proves the
    // counter actually reset instead of latching on.
    const rs = [-1, -1, -1, 5, -1, -1, -1, -1, -1];
    const iv = breakerHaltIntervals(closes(rs, 4 * 3_600_000), cfg({ trigger: "daily_loss_r", threshold: 3 }));
    expect(iv).toHaveLength(2);
    expect(iv[0]!.from).toBe(T0 + 2 * 4 * 3_600_000);
    expect(iv[0]!.until).toBe(Date.parse("2026-03-03T00:00:00Z"));
    expect(iv[1]!.from).toBeGreaterThan(iv[0]!.until);
  });

  test("loss_streak trips on consecutive losses and clears on a win", () => {
    const win = breakerHaltIntervals(closes([1, 1, 1, 1, 1]), cfg({ trigger: "loss_streak", threshold: 3, cooldownBars: 16 }));
    expect(win).toEqual([]);

    const iv = breakerHaltIntervals(closes([-1, -1, -1, 1, 1]), cfg({ trigger: "loss_streak", threshold: 3, cooldownBars: 16 }));
    expect(iv).toHaveLength(1);
    expect(iv[0]!.until).toBe(T0 + 2 * BAR + 16 * BAR);
  });

  test("a win inside the streak does not count toward it", () => {
    // -1,-1,+1,-1,-1,-1 -> the three trailing losses are what trip it.
    const iv = breakerHaltIntervals(closes([-1, -1, 1, -1, -1, -1]), cfg({ trigger: "loss_streak", threshold: 3, cooldownBars: 4 }));
    expect(iv).toHaveLength(1);
    expect(iv[0]!.from).toBe(T0 + 5 * BAR);
  });

  test("rolling_wr trips only once the window has enough closes", () => {
    // Two early losses must NOT trip a 20-trade window; the rule is inert until
    // it has evidence.
    const early = breakerHaltIntervals(closes([-1, -1, -1]), cfg({ trigger: "rolling_wr", threshold: 0.3, window: 20, cooldownBars: 8 }));
    expect(early).toEqual([]);

    const many = Array.from({ length: 20 }, () => -1);
    const iv = breakerHaltIntervals(closes(many), cfg({ trigger: "rolling_wr", threshold: 0.3, window: 20, cooldownBars: 8 }));
    expect(iv.length).toBeGreaterThan(0);
  });
});

describe("portfolio breaker re-arm", () => {
  test("a trade-derived trigger still re-arms on time, not on new trades", () => {
    // THE DEADLOCK GUARD. A book that is halted takes no trades, so it produces
    // no closes. If the halt could only be released by a better rolling
    // metric, the book would halt forever. Feeding NO further closes after the
    // trip must still produce a halt interval that ends on its own.
    const iv = breakerHaltIntervals(closes([-1, -1, -1]), cfg({ trigger: "loss_streak", threshold: 3, cooldownBars: 32 }));
    expect(iv).toHaveLength(1);
    expect(iv[0]!.until).toBeGreaterThan(iv[0]!.from);
  });

  test("a rolling_dd_r halt also expires on the clock", () => {
    const rs = Array.from({ length: 20 }, () => -1);
    const iv = breakerHaltIntervals(closes(rs), cfg({ trigger: "rolling_dd_r", threshold: 4, window: 20, cooldownBars: 96 }));
    expect(iv.length).toBeGreaterThan(0);
    for (const h of iv) expect(h.until).toBeGreaterThan(h.from);
  });

  test("halts come back sorted so isHalted can binary-search them", () => {
    // The second cluster straddles the UTC day boundary on purpose: a streak
    // breaker that cleared its counter at midnight would only ever find one.
    const rs = [-1, -1, -1, 1, 1, -1, -1, -1];
    const iv = breakerHaltIntervals(closes(rs, 4 * 3_600_000), cfg({ trigger: "loss_streak", threshold: 3, cooldownBars: 8 }));
    expect(iv.length).toBeGreaterThan(1);
    for (let i = 1; i < iv.length; i++) expect(iv[i]!.from).toBeGreaterThanOrEqual(iv[i - 1]!.from);
  });
});

describe("portfolio breaker causality and scope", () => {
  test("a halt never begins before the close that caused it", () => {
    const rs = [1, 1, -1, -1, -1, -1];
    const iv = breakerHaltIntervals(closes(rs), cfg({ trigger: "loss_streak", threshold: 3, cooldownBars: 4 }));
    for (const h of iv) {
      // Every close at or before h.from must already be in the sequence.
      expect(h.from).toBeGreaterThanOrEqual(T0);
      const caused = rs.filter((_, i) => T0 + i * BAR <= h.from);
      expect(caused.length).toBeGreaterThan(0);
    }
  });

  test("pair scope halts one pair without touching another", () => {
    const mixed: ClosedLike[] = [
      { pair: "SOL", exitTime: T0, r: -1 },
      { pair: "SOL", exitTime: T0 + BAR, r: -1 },
      { pair: "SOL", exitTime: T0 + 2 * BAR, r: -1 },
      { pair: "ADA", exitTime: T0 + 3 * BAR, r: 5 },
      { pair: "ADA", exitTime: T0 + 4 * BAR, r: 5 },
    ];
    const iv = breakerHaltIntervals(mixed, cfg({ trigger: "loss_streak", threshold: 3, cooldownBars: 8, scope: "pair" }));
    // SOL trips; ADA's winning streak never can, so exactly one halt exists.
    expect(iv).toHaveLength(1);
    expect(iv[0]!.reason).toMatch(/consecutive losses/);
  });

  test("portfolio scope treats every pair as one book", () => {
    const mixed: ClosedLike[] = [
      { pair: "SOL", exitTime: T0, r: -1 },
      { pair: "ADA", exitTime: T0 + BAR, r: -1 },
      { pair: "XRP", exitTime: T0 + 2 * BAR, r: -1 },
    ];
    const iv = breakerHaltIntervals(mixed, cfg({ trigger: "loss_streak", threshold: 3, cooldownBars: 8, scope: "portfolio" }));
    expect(iv).toHaveLength(1);
  });
});

describe("halt interval queries", () => {
  const iv = breakerHaltIntervals(closes([-1, -1, -1, 1, 1]), cfg({ trigger: "loss_streak", threshold: 3, cooldownBars: 8 }));

  test("isHalted answers inside, before and after a window", () => {
    expect(isHalted(iv, T0 + 2 * BAR + 3 * BAR)).not.toBeNull();
    expect(isHalted(iv, T0)).toBeNull();
    expect(isHalted(iv, T0 + 2 * BAR + 100 * BAR)).toBeNull();
  });

  test("haltCoverage is bounded and zero without halts", () => {
    const cov = haltCoverage(iv, T0, T0 + 20 * BAR);
    expect(cov).toBeGreaterThan(0);
    expect(cov).toBeLessThanOrEqual(1);
    expect(haltCoverage([], T0, T0 + 20 * BAR)).toBe(0);
  });
});
