import { describe, expect, it } from "vitest";
import { bookSeedBalance, latestTradeTimeByCoin } from "../trade-utils";

describe("latestTradeTimeByCoin", () => {
  it("uses exit time for closed trades and entry time for open trades", () => {
    const map = latestTradeTimeByCoin([
      { coin: "SOL", entryTime: 1000, exitTime: 2000 }, // closed → exit time
      { coin: "SOL", entryTime: 1500 }, // still open → entry time (lower, ignored)
      { coin: "INJ", entryTime: 3000 }, // open → entry time
    ]);
    expect(map.get("SOL")).toBe(2000);
    expect(map.get("INJ")).toBe(3000);
  });

  it("keeps the single latest activity time per coin", () => {
    const map = latestTradeTimeByCoin([
      { coin: "SOL", entryTime: 100, exitTime: 200 },
      { coin: "SOL", entryTime: 300, exitTime: 400 },
    ]);
    expect(map.size).toBe(1);
    expect(map.get("SOL")).toBe(400);
  });

  it("skips trades with no usable timestamp (0 would never trip a cooldown)", () => {
    const map = latestTradeTimeByCoin([{ coin: "SOL" }]);
    expect(map.size).toBe(0);
  });

  it("is empty for no trades", () => {
    expect(latestTradeTimeByCoin([]).size).toBe(0);
  });
});

describe("bookSeedBalance", () => {
  it("equals the start balance when there are no closed trades", () => {
    expect(bookSeedBalance(150, [])).toBe(150);
  });

  it("adds the book's own closed P&L to the start balance", () => {
    expect(
      bookSeedBalance(150, [
        { pnlUsd: 12.5 },
        { pnlUsd: -3.25 },
        { pnlUsd: null },
        {},
        { pnlUsd: 0 },
      ]),
    ).toBeCloseTo(159.25);
  });
});
