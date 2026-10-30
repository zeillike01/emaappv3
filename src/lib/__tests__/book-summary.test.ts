import { describe, expect, it } from "vitest";

import { summarizeBook, type TradeLike } from "../book-summary";

function trade(partial: Partial<TradeLike> & { pnlUsd: number }): TradeLike {
  return {
    coin: "BTC",
    type: "LONG",
    session: "asia",
    reason: "Take Profit",
    realizedR: 1,
    entryTime: Date.UTC(2026, 8, 2, 1, 0),
    ...partial,
  };
}

describe("summarizeBook", () => {
  it("returns null when nothing analyzable is passed", () => {
    expect(summarizeBook([])).toBeNull();
    // Rows without a pnlUsd are skipped, leaving nothing to analyze.
    expect(summarizeBook([{ coin: "BTC" } as TradeLike])).toBeNull();
  });

  it("computes totals, win rate and profit factor on pnlUsd > 0", () => {
    const rows = [
      trade({ pnlUsd: 10, realizedR: 2 }),
      trade({ pnlUsd: 5, realizedR: 1 }),
      trade({ pnlUsd: -4, realizedR: -1 }),
      trade({ type: "SHORT", pnlUsd: -6, realizedR: -1.2 }),
    ];
    const s = summarizeBook(rows)!;
    expect(s.total).toBe(4);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.winRate).toBe(50);
    expect(s.totalPnl).toBe(5);
    expect(s.grossWin).toBe(15);
    expect(s.grossLoss).toBe(10);
    expect(s.profitFactor).toBe(1.5);
    expect(s.avgR).toBeCloseTo((2 + 1 - 1 - 1.2) / 4, 6);
  });

  it("counts wins by pnlUsd > 0 even when realizedR disagrees", () => {
    // Win definition must match bookStats/liveStats — pnlUsd, not realizedR.
    const s = summarizeBook([
      trade({ pnlUsd: 0.01, realizedR: 0 }),
      trade({ pnlUsd: -0.01, realizedR: 0 }),
    ])!;
    expect(s.wins).toBe(1);
    expect(s.losses).toBe(1);
    expect(s.winRate).toBe(50);
  });

  it("splits LONG vs SHORT (anything non-LONG lands in shorts)", () => {
    const s = summarizeBook([
      trade({ type: "LONG", pnlUsd: 1 }),
      trade({ type: "SHORT", pnlUsd: -2 }),
      trade({ type: "SHORT", pnlUsd: 3 }),
    ])!;
    expect(s.longs.trades).toBe(1);
    expect(s.shorts.trades).toBe(2);
    expect(s.shorts.pnl).toBe(1);
  });

  it("reports each session's long/short split (non-LONG counts as short)", () => {
    const s = summarizeBook([
      trade({ session: "asia", type: "LONG", pnlUsd: 1 }),
      trade({ session: "asia", type: "SHORT", pnlUsd: -2 }),
      trade({ session: "asia", type: "SHORT", pnlUsd: 3 }),
      trade({ session: "ny", type: "SHORT", pnlUsd: -1 }),
    ])!;
    const asia = s.perSession.find((x) => x.key === "asia")!;
    expect(asia.trades).toBe(3);
    expect(asia.longs).toBe(1);
    expect(asia.shorts).toBe(2);
    // Per-side PnL answers "was this side profitable here?" and reconciles
    // with the row total (fees excluded, like every other PnL here).
    expect(asia.longPnl).toBe(1);
    expect(asia.shortPnl).toBe(1);
    expect(asia.longPnl + asia.shortPnl).toBe(asia.pnl);
    const ny = s.perSession.find((x) => x.key === "ny")!;
    expect(ny.longs).toBe(0);
    expect(ny.longPnl).toBe(0);
    expect(ny.shorts).toBe(1);
    expect(ny.shortPnl).toBe(-1);
  });

  it("orders session × direction worst-first and exposes only red cells", () => {
    const rows = [
      trade({ session: "asia", type: "LONG", pnlUsd: 5 }),
      trade({ session: "asia", type: "SHORT", pnlUsd: -8 }),
      trade({ session: "london", type: "LONG", pnlUsd: -3 }),
      trade({ session: "london", type: "SHORT", pnlUsd: 4 }),
    ];
    const s = summarizeBook(rows)!;
    // worst cell first: asia SHORT (-8), then london LONG (-3), london SHORT, asia LONG
    expect(s.perSessionDirection.map((c) => `${c.session}:${c.side}`)).toEqual([
      "asia:SHORT",
      "london:LONG",
      "london:SHORT",
      "asia:LONG",
    ]);
    expect(s.worstCells.map((c) => `${c.session}:${c.side}:${c.pnl}`)).toEqual([
      "asia:SHORT:-8",
      "london:LONG:-3",
    ]);
    expect(s.worstCells.every((c) => c.pnl < 0)).toBe(true);
  });

  it("groups unknown sessions and honors the top-losers cap", () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      trade({ session: undefined, pnlUsd: -(i + 1), realizedR: -1 }),
    );
    const s = summarizeBook(rows, 5)!;
    expect(s.perSession[0].key).toBe("unknown");
    expect(s.worstTrades).toHaveLength(5);
    // ascending order: smallest (most negative) first
    expect(s.worstTrades[0].pnlUsd).toBe(-12);
    expect(s.worstTrades[4].pnlUsd).toBe(-8);
  });

  it("sorts per-session and per-pair by descending PnL", () => {
    const s = summarizeBook([
      trade({ session: "asia", coin: "BTC", pnlUsd: 1 }),
      trade({ session: "ny", coin: "ETH", pnlUsd: 9 }),
      trade({ session: "asia", coin: "SOL", pnlUsd: -2 }),
    ])!;
    expect(s.perSession.map((x) => x.key)).toEqual(["ny", "asia"]);
    expect(s.perPair.map((x) => x.key)).toEqual(["ETH", "BTC", "SOL"]);
  });
});
