import { describe, expect, it } from "vitest";
import {
  COIN_PRIORITY_DEFAULTS,
  coinPriorityBlock,
  coinPriorityNote,
  coinPriorityReason,
  computeCoinPriority,
  orderByCoinPriority,
  splitByCoinPriority,
  type CoinPriorityClosedLike,
  type CoinPriorityConfig,
} from "../coin-priority";

const NOW = Date.UTC(2026, 9, 21, 10, 0, 0); // 2026-10-21T10:00Z
const HOUR = 3_600_000;
const DAY = 86_400_000;

const cfg = (over: Partial<CoinPriorityConfig> = {}): CoinPriorityConfig => ({
  coinPriorityLookbackDays: COIN_PRIORITY_DEFAULTS.coinPriorityLookbackDays,
  coinPriorityMinTrades: COIN_PRIORITY_DEFAULTS.coinPriorityMinTrades,
  ...over,
});

const close = (coin: string, r: number, hoursAgo = 1): CoinPriorityClosedLike => ({
  coin,
  exitTime: NOW - hoursAgo * HOUR,
  realizedR: r,
});

/** N closes for one coin, each `r` apart, one hour apart. */
const series = (coin: string, rs: number[]): CoinPriorityClosedLike[] =>
  rs.map((r, i) => close(coin, r, 1 + i));

/** `n` identical closes of `r` — the shorthand for "a coin with a record". */
const rep = (coin: string, r: number, n: number): CoinPriorityClosedLike[] =>
  Array.from({ length: n }, (_, i) => close(coin, r, 1 + i));

describe("computeCoinPriority", () => {
  it("buckets closes per coin and sums R", () => {
    const state = computeCoinPriority(
      [...series("PUMP", [2, -1, 3]), ...series("TAO", [-2, -1])],
      cfg({ coinPriorityMinTrades: 1 }),
      NOW,
    );
    const pump = state.buckets.find((b) => b.coin === "PUMP")!;
    const tao = state.buckets.find((b) => b.coin === "TAO")!;
    expect(pump).toMatchObject({ trades: 3, wins: 2, sumR: 4, tier: "priority" });
    expect(pump.winRate).toBeCloseTo(2 / 3);
    expect(tao).toMatchObject({ trades: 2, wins: 0, sumR: -3, tier: "avoid" });
  });

  it("marks a coin under the sample floor neutral — not priority, not avoid", () => {
    const state = computeCoinPriority(series("SHIB", [5, 5, 5]), cfg(), NOW);
    expect(state.buckets[0]).toMatchObject({ coin: "SHIB", tier: "neutral" });
  });

  it("treats a exactly-flat coin at the sample floor as avoid (0R is not profitable)", () => {
    const state = computeCoinPriority(
      series("BTC", [1, -1, 1, -1, 1, -1, 1, -1, 1, -1]),
      cfg(),
      NOW,
    );
    expect(state.buckets[0]!.sumR).toBe(0);
    expect(state.buckets[0]!.tier).toBe("avoid");
  });

  it("ignores closes outside the window, without an exit time, or without an R", () => {
    const state = computeCoinPriority(
      [
        close("ETH", 5, 1),
        close("ETH", 100, 24 * 15), // older than 14 days
        { coin: "ETH", realizedR: 5 }, // no exitTime
        { coin: "ETH", exitTime: NOW - HOUR }, // no R
        { exitTime: NOW - HOUR, realizedR: 5 }, // no coin
      ],
      cfg({ coinPriorityMinTrades: 1 }),
      NOW,
    );
    expect(state.buckets).toHaveLength(1);
    expect(state.buckets[0]).toMatchObject({ coin: "ETH", trades: 1, sumR: 5 });
  });

  it("normalises coin ids to upper case so an alias cannot split a bucket", () => {
    const state = computeCoinPriority(
      [close("pump", 1), close("PUMP", 1)],
      cfg({ coinPriorityMinTrades: 1 }),
      NOW,
    );
    expect(state.buckets).toHaveLength(1);
    expect(state.buckets[0]).toMatchObject({ coin: "PUMP", trades: 2 });
  });

  it("clamps an absurd lookback to the documented 1..90 day band", () => {
    expect(computeCoinPriority([], cfg({ coinPriorityLookbackDays: 0 }), NOW).lookbackDays).toBe(1);
    expect(computeCoinPriority([], cfg({ coinPriorityLookbackDays: 500 }), NOW).lookbackDays).toBe(90);
  });

  it("returns buckets in scan order — profitable first, then by win rate", () => {
    const state = computeCoinPriority(
      [
        ...series("TAO", [-3]), // avoid (1 close, -3R)
        ...series("PUMP", [11]), // priority, 100% WR
        ...series("DOGE", [4]), // priority, 100% WR, smaller R
      ],
      cfg({ coinPriorityMinTrades: 1 }),
      NOW,
    );
    expect(state.buckets.map((b) => b.coin)).toEqual(["PUMP", "DOGE", "TAO"]);
    // A better win rate outranks a bigger P&L inside the profitable tier.
    const wr = computeCoinPriority(
      [...series("AAA", [9, -1]), ...series("BBB", [1, 1])],
      cfg({ coinPriorityMinTrades: 2 }),
      NOW,
    );
    expect(wr.buckets.map((b) => b.coin)).toEqual(["BBB", "AAA"]);
  });
});

describe("orderByCoinPriority", () => {
  const state = computeCoinPriority(
    [
      ...rep("PUMP", 5.5, 2), // +11R over 2 closes — priority
      ...rep("SHIB", 3.5, 2), // +7R  over 2 closes — priority
      ...rep("TAO", -2, 2), //   -4R over 2 closes — avoid
      ...rep("NEWC", 1, 1), //    +1R over 1 close  — neutral (under the floor)
    ],
    { coinPriorityLookbackDays: 14, coinPriorityMinTrades: 2 },
    NOW,
  );
  const metrics = ["TAO", "ETH", "NEWC", "SHIB", "PUMP"].map((pair) => ({ pair }));

  it("puts profitable coins first, then unproven, then losers", () => {
    expect(orderByCoinPriority(metrics, state).map((m) => m.pair)).toEqual([
      "PUMP",
      "SHIB",
      "NEWC",
      "ETH",
      "TAO",
    ]);
  });

  it("orders each tier by 14d net R", () => {
    const s = computeCoinPriority(
      [...series("A", [1]), ...series("B", [9]), ...series("C", [-2]), ...series("D", [-7])],
      { coinPriorityLookbackDays: 14, coinPriorityMinTrades: 1 },
      NOW,
    );
    expect(orderByCoinPriority(["A", "B", "C", "D"].map((pair) => ({ pair })), s).map((m) => m.pair)).toEqual([
      "B",
      "A",
      "C",
      "D",
    ]);
  });

  it("returns the input order untouched when the snapshot is missing or empty", () => {
    const input = ["TAO", "PUMP"].map((pair) => ({ pair }));
    expect(orderByCoinPriority(input, null).map((m) => m.pair)).toEqual(["TAO", "PUMP"]);
    expect(orderByCoinPriority(input, undefined).map((m) => m.pair)).toEqual(["TAO", "PUMP"]);
    const empty = computeCoinPriority([], cfg(), NOW);
    expect(orderByCoinPriority(input, empty).map((m) => m.pair)).toEqual(["TAO", "PUMP"]);
  });

  it("is stable for equal scores (pair name breaks the tie)", () => {
    const s = computeCoinPriority(
      [...series("ZZZ", [3]), ...series("AAA", [3])],
      { coinPriorityLookbackDays: 14, coinPriorityMinTrades: 1 },
      NOW,
    );
    expect(orderByCoinPriority(["ZZZ", "AAA"].map((pair) => ({ pair })), s).map((m) => m.pair)).toEqual([
      "AAA",
      "ZZZ",
    ]);
  });
});

describe("splitByCoinPriority", () => {
  const state = computeCoinPriority(
    [...rep("PUMP", 5.5, 2), ...rep("SHIB", 3.5, 2), ...rep("TAO", -2, 2)],
    { coinPriorityLookbackDays: 14, coinPriorityMinTrades: 2 },
    NOW,
  );

  it("keeps losers out of the priority pass", () => {
    const { preferred, rest } = splitByCoinPriority(
      ["TAO", "PUMP", "SHIB"].map((pair) => ({ pair })),
      state,
    );
    expect(preferred.map((m) => m.pair)).toEqual(["PUMP", "SHIB"]);
    expect(rest.map((m) => m.pair)).toEqual(["TAO"]);
  });

  it("keeps unproven coins in the first pass — unknown is not bad", () => {
    const { preferred, rest } = splitByCoinPriority([{ pair: "WIF" }, { pair: "TAO" }], state);
    expect(preferred.map((m) => m.pair)).toEqual(["WIF"]);
    expect(rest.map((m) => m.pair)).toEqual(["TAO"]);
  });

  it("degrades to a single pass when the monitor has no data", () => {
    const { preferred, rest } = splitByCoinPriority([{ pair: "TAO" }, { pair: "WIF" }], null);
    expect(preferred.map((m) => m.pair)).toEqual(["TAO", "WIF"]);
    expect(rest).toEqual([]);
  });
});

describe("coinPriorityNote", () => {
  it("renders the three tiers in words", () => {
    expect(coinPriorityNote({ coin: "PUMP", sumR: 11.04, trades: 21, tier: "priority" })).toBe(
      "PUMP prioritized (+11.04R over 21 paper closes)",
    );
    expect(coinPriorityNote({ coin: "TAO", sumR: -3.88, trades: 14, tier: "avoid" })).toBe(
      "TAO last (−3.88R over 14 paper closes)",
    );
    expect(coinPriorityNote({ coin: "WIF", sumR: 0, trades: 3, tier: "neutral" })).toBe(
      "WIF unproven (3 paper closes)",
    );
  });
});

describe("window edges", () => {
  it("counts a close exactly on the 14-day boundary and excludes one a ms older", () => {
    const onEdge = { coin: "ETH", exitTime: NOW - 14 * DAY, realizedR: 1 };
    const justOutside = { coin: "ETH", exitTime: NOW - 14 * DAY - 1, realizedR: 1 };
    const state = computeCoinPriority([onEdge, justOutside], cfg({ coinPriorityMinTrades: 1 }), NOW);
    expect(state.buckets[0]!.trades).toBe(1);
  });
});

describe("win-rate priority (2026-10-21 operator spec)", () => {
  // Both coins are in the priority tier; A has the bigger net R, B the better
  // win rate. The operator asked for higher win rate to lead, so B must come
  // first — the tier guarantees profitability, the order expresses consistency.
  const state = computeCoinPriority(
    [
      ...series("AAA", [5, 5, 5, 5, 5, 5, -0.1, -0.1, -0.1, -0.1]), // 6/10 = 60% WR, +29.6R
      ...series("BBB", [1, 1, 1, 1, 1, 1, 1, 1, -0.5, -0.5]), //      8/10 = 80% WR, +7.0R
    ],
    { coinPriorityLookbackDays: 14, coinPriorityMinTrades: 10 },
    NOW,
  );

  it("orders the profitable tier by win rate, not by net R", () => {
    expect(orderByCoinPriority([{ pair: "AAA" }, { pair: "BBB" }], state).map((m) => m.pair)).toEqual([
      "BBB",
      "AAA",
    ]);
  });

  it("breaks a win-rate tie with net R", () => {
    const tie = computeCoinPriority(
      [...series("AAA", [2, 2, 2, -1, -1]), ...series("BBB", [9, 9, 9, -1, -1])],
      { coinPriorityLookbackDays: 14, coinPriorityMinTrades: 5 },
      NOW,
    );
    expect(tie.buckets[0]!.winRate).toBe(tie.buckets[1]!.winRate);
    expect(orderByCoinPriority([{ pair: "AAA" }, { pair: "BBB" }], tie).map((m) => m.pair)).toEqual([
      "BBB",
      "AAA",
    ]);
  });
});

describe("coinPriorityBlock (the live veto)", () => {
  const state = computeCoinPriority(
    [...rep("PUMP", 5.5, 2), ...rep("TAO", -2, 2), ...rep("WIF", 2, 1)],
    { coinPriorityLookbackDays: 14, coinPriorityMinTrades: 2 },
    NOW,
  );

  it("blocks a coin in the avoid tier", () => {
    const blocked = coinPriorityBlock(state, "TAO");
    expect(blocked).toMatchObject({ coin: "TAO", sumR: -4, tier: "avoid" });
  });

  it("never blocks a profitable or an unproven coin", () => {
    expect(coinPriorityBlock(state, "PUMP")).toBeUndefined();
    expect(coinPriorityBlock(state, "WIF")).toBeUndefined(); // under the sample floor
    expect(coinPriorityBlock(state, "NEWC")).toBeUndefined(); // no record at all
  });

  it("fails open when the block is disarmed or the snapshot is missing", () => {
    expect(coinPriorityBlock(state, "TAO", false)).toBeUndefined();
    expect(coinPriorityBlock(null, "TAO")).toBeUndefined();
    expect(coinPriorityBlock({ buckets: [] }, "TAO")).toBeUndefined();
  });

  it("matches the coin id case-insensitively", () => {
    expect(coinPriorityBlock(state, "tao")).toMatchObject({ coin: "TAO" });
  });

  it("renders a veto line the skip log can carry", () => {
    expect(coinPriorityReason(coinPriorityBlock(state, "TAO")!)).toBe(
      "coin not profitable: TAO -4.00R at 0% WR over 2 paper closes",
    );
  });
});
