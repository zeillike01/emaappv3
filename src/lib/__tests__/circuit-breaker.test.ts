import { describe, expect, it } from "vitest";
import { computeBreakerState } from "../circuit-breaker";

const now = Date.parse("2026-09-08T15:00:00Z");
const BASE_CFG = { breakerEnabled: true, breakerMinWr: 0.3, breakerMaxDailyLossPct: 0.05 };
const balance = 300;

const DAY = 86_400_000;

// n recent closes spread across the last `total` days (newest = today), so
// the WR window sees all of them but the daily-loss window sees only one.
function closes(wins: number, total: number, pnl = 10): Array<{ pnlUsd: number; exitTime: number }> {
  return Array.from({ length: total }, (_, i) => ({
    pnlUsd: i < wins ? pnl : -pnl,
    exitTime: now - (total - 1 - i) * DAY,
  }));
}

describe("computeBreakerState", () => {
  it("never pauses while disabled", () => {
    const state = computeBreakerState({
      recentClosed: closes(1, 20),
      balance,
      now,
      cfg: { ...BASE_CFG, breakerEnabled: false },
    });
    expect(state.paused).toBe(false);
    expect(state.maxDailyLossUsd).toBe(0);
  });

  it("is not paused with no closed trades (wr20 null)", () => {
    const state = computeBreakerState({ recentClosed: [], balance, now, cfg: BASE_CFG });
    expect(state.paused).toBe(false);
    expect(state.wr20).toBeNull();
  });

  it("pauses when rolling WR falls below the floor", () => {
    const state = computeBreakerState({ recentClosed: closes(5, 20), balance, now, cfg: BASE_CFG });
    expect(state.paused).toBe(true);
    expect(state.wr20).toBeCloseTo(0.25);
    expect(state.reasons.join(" ")).toContain("25%");
  });

  it("stays armed when rolling WR is at/above the floor", () => {
    const state = computeBreakerState({ recentClosed: closes(7, 20), balance, now, cfg: BASE_CFG });
    expect(state.paused).toBe(false);
    expect(state.wr20).toBeCloseTo(0.35);
  });

  it("pauses when today's realized loss exceeds the daily cap", () => {
    // All 20 closes today: 6 wins +10, 14 losses -13 -> daily -122 < -15.
    const recent = Array.from({ length: 20 }, (_, i) => ({
      pnlUsd: i < 6 ? 10 : -13,
      exitTime: now - (20 - i) * 60_000,
    }));
    const state = computeBreakerState({ recentClosed: recent, balance, now, cfg: BASE_CFG });
    expect(state.paused).toBe(true);
    expect(state.reasons.join(" ")).toContain("Daily loss");
  });

  it("does not count yesterday's losses toward the daily cap", () => {
    const yesterday = Date.parse("2026-09-07T15:00:00Z");
    const recent = [
      ...closes(20, 20, 10), // all wins; the newest (today) is +10
      { pnlUsd: -200, exitTime: yesterday }, // big loss yesterday: ignored for the daily trigger
    ];
    const state = computeBreakerState({ recentClosed: recent, balance, now, cfg: BASE_CFG });
    expect(state.paused).toBe(false); // WR floor still met, daily loss only today's
    expect(state.dailyPnl).toBeCloseTo(10);
  });

  it("ignores trades without an exitTime in both windows", () => {
    const recent = [
      ...closes(5, 20),
      { pnlUsd: -999, exitTime: undefined }, // open trade, no exitTime
    ];
    const state = computeBreakerState({ recentClosed: recent, balance, now, cfg: BASE_CFG });
    expect(state.wr20).toBeCloseTo(0.25);
    expect(state.paused).toBe(true);
  });

  it("reports the daily cap in USD from the balance", () => {
    const state = computeBreakerState({ recentClosed: closes(7, 20), balance, now, cfg: BASE_CFG });
    expect(state.maxDailyLossUsd).toBeCloseTo(15);
  });
});