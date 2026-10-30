/**
 * SESSION WINDOW PRUNE (2026-10-21) — the 14-day measurement window.
 *
 * The prune removes the paper rows that aged out of the window. Three things
 * must hold afterwards, and they are what these tests pin down:
 *   1. the rows are gone and the fresh ones are untouched,
 *   2. the lifetime counters (bookStats) are folded OUT, so "Closed / Win
 *      Rate / Realized PnL" do not move,
 *   3. the balance does NOT move — the P&L was applied when the trade closed,
 *      and it is CARRIED on the account so every ledger-derived balance stays
 *      the same number.
 */

import { describe, expect, it } from "vitest";
import { pruneSessionWindow } from "../../convex/strategyEngine";

const DAY = 86_400_000;

function makeCtx(opts: {
  expired: any[];
  band?: any[];
  account: any;
  stats: any;
  config?: any;
  snapshots?: any[];
}) {
  const patches: Array<{ id: string; patch: any }> = [];
  const deletes: string[] = [];
  let paperTradesReads = 0;

  const db = {
    query: (table: string) => {
      const q: any = {
        eq: () => q,
        lt: () => q,
        gte: () => q,
        order: () => q,
        take: async (n: number) => {
          if (table === "paperTrades") {
            paperTradesReads += 1;
            // Read 1 = the exitTime band (the expired closes).
            // Read 2 = the entryTime band (the closes with NO exit time).
            return paperTradesReads === 1 ? opts.expired : (opts.band ?? []);
          }
          if (table === "sessionBreakerState") return (opts.snapshots ?? []).slice(0, n);
          return [];
        },
        first: async () => {
          if (table === "paperAccount") return opts.account;
          if (table === "strategyConfig") return opts.config ?? null;
          if (table === "bookStats") return opts.stats;
          return null;
        },
        paginate: async () => ({ page: [], continueCursor: null, isDone: true }),
      };
      return { withIndex: () => q };
    },
    patch: async (id: string, patch: any) => {
      patches.push({ id, patch });
    },
    delete: async (id: string) => {
      deletes.push(id);
    },
    insert: async () => "inserted",
    get: async () => undefined,
  };

  return { ctx: { db } as any, patches, deletes };
}

const ACCOUNT = {
  _id: "acc-1",
  name: "layer2",
  balance: 215.030405,
  startBalance: 150,
  archivedRealizedPnlUsd: 0,
  archivedTrades: 0,
  archivedWins: 0,
  archivedFeesUsd: 0,
  archivedR: 0,
};

const STATS = {
  _id: "stats-1",
  book: "layer2",
  closedCount: 196,
  wins: 100,
  realizedPnl: 65.030405,
  totalFeesUsd: 12.5,
};

describe("pruneSessionWindow", () => {
  it("deletes the expired closes, carries their P&L and folds the counters", async () => {
    const now = Date.now();
    const expired = [
      {
        _id: "old-1",
        exitTime: now - 20 * DAY,
        pnlUsd: 12.5,
        totalFeesUsd: 0.4,
        realizedR: 1.2,
      },
      {
        _id: "old-2",
        exitTime: now - 15 * DAY,
        pnlUsd: -3.25,
        totalFeesUsd: 0.2,
        realizedR: -0.5,
      },
    ];
    const { ctx, patches, deletes } = makeCtx({
      expired,
      account: { ...ACCOUNT },
      stats: { ...STATS },
      config: { name: "ema-momentum", sessionBreakerLookbackDays: 14 },
    });

    const result = await (pruneSessionWindow as any)._handler(ctx, {});

    expect(result.pruned).toBe(2);
    expect(result.carry.trades).toBe(2);
    expect(result.carry.wins).toBe(1);
    expect(result.carry.realizedPnlUsd).toBeCloseTo(9.25, 9);
    expect(result.carry.totalFeesUsd).toBeCloseTo(0.6, 9);
    expect(result.carry.realizedR).toBeCloseTo(0.7, 9);

    // 1. the expired rows are gone
    expect(deletes).toEqual(["old-1", "old-2"]);

    // 2. the lifetime counters are folded OUT
    const statsPatch = patches.find((p) => p.id === "stats-1");
    expect(statsPatch?.patch.closedCount).toBe(194);
    expect(statsPatch?.patch.wins).toBe(99);
    expect(statsPatch?.patch.realizedPnl).toBeCloseTo(65.030405 - 9.25, 9);
    expect(statsPatch?.patch.totalFeesUsd).toBeCloseTo(12.5 - 0.6, 9);

    // 3. the P&L is carried on the account
    const accPatch = patches.find((p) => p.id === "acc-1");
    expect(accPatch?.patch.archivedRealizedPnlUsd).toBeCloseTo(9.25, 9);
    expect(accPatch?.patch.archivedTrades).toBe(2);
    expect(accPatch?.patch.archivedWins).toBe(1);
    expect(accPatch?.patch.archivedFeesUsd).toBeCloseTo(0.6, 9);
    expect(accPatch?.patch.archivedR).toBeCloseTo(0.7, 9);

    // 4. and the BALANCE is not touched — the P&L was applied at close time.
    expect(accPatch?.patch).not.toHaveProperty("balance");
  });

  it("is a no-op when nothing has aged out", async () => {
    const { ctx, patches, deletes } = makeCtx({
      expired: [],
      account: { ...ACCOUNT },
      stats: { ...STATS },
      config: { name: "ema-momentum", sessionBreakerLookbackDays: 14 },
    });

    const result = await (pruneSessionWindow as any)._handler(ctx, {});

    expect(result.pruned).toBe(0);
    expect(result.cutoff).toBeGreaterThan(0);
    expect(result.snapshotsDeleted).toBe(0);
    expect(deletes).toEqual([]);
    expect(patches).toEqual([]);
  });

  it("also removes closes that have no exit time at all", async () => {
    const now = Date.now();
    const { ctx, deletes } = makeCtx({
      expired: [],
      band: [
        { _id: "orphan", exitTime: null, entryTime: now - 30 * DAY, pnlUsd: 1 },
        // A row WITH an exit time is not an orphan — the exitTime band owns it.
        { _id: "normal", exitTime: now - 30 * DAY, entryTime: now - 31 * DAY },
      ],
      account: { ...ACCOUNT },
      stats: { ...STATS },
      config: { name: "ema-momentum", sessionBreakerLookbackDays: 14 },
    });

    const result = await (pruneSessionWindow as any)._handler(ctx, {});

    expect(result.pruned).toBe(1);
    expect(deletes).toEqual(["orphan"]);
  });

  it("drops the daily snapshots older than the window and keeps the recent ones", async () => {
    const now = Date.now();
    const cutoffDay = new Date(now - 14 * DAY).toISOString().slice(0, 10);
    const today = new Date(now).toISOString().slice(0, 10);
    const { ctx, deletes } = makeCtx({
      expired: [],
      account: { ...ACCOUNT },
      stats: { ...STATS },
      config: { name: "ema-momentum", sessionBreakerLookbackDays: 14 },
      snapshots: [
        { _id: "snap-old", day: "2020-01-01" },
        { _id: "snap-fresh", day: today },
      ],
    });

    const result = await (pruneSessionWindow as any)._handler(ctx, {});

    expect(result.snapshotsDeleted).toBe(1);
    expect(deletes).toEqual(["snap-old"]);
    expect(cutoffDay < today).toBe(true);
  });
});
