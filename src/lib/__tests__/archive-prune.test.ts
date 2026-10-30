import { describe, expect, it } from "vitest";
import { pruneClosedDetails, pruneClosedDetailsPage } from "../../convex/archive";

describe("pruneClosedDetails", () => {
  it("fails instead of reporting success if a non-final page has no cursor", async () => {
    const ctx = {
      runMutation: async () => ({
        scanned: 200,
        deleted: 100,
        remainingClosed: 100,
        continueCursor: null,
        isDone: false,
      }),
    } as unknown as any;

    await expect(
      (pruneClosedDetails as any)._handler(ctx, {
        book: "layer2",
        olderThanDays: 30,
      }),
    ).rejects.toThrow("Prune pagination ended before the closed-trade scan completed");
  });

  it("runs each page in a separate transaction and aggregates the counts", async () => {
    const calls: Array<{ cursor: string | null; cutoff: number }> = [];
    const pages = [
      {
        scanned: 200,
        deleted: 175,
        remainingClosed: 25,
        continueCursor: "cursor-1",
        isDone: false,
      },
      {
        scanned: 40,
        deleted: 40,
        remainingClosed: 0,
        continueCursor: null,
        isDone: true,
      },
    ];
    const ctx = {
      runMutation: async (_reference: unknown, args: { cursor: string | null; cutoff: number }) => {
        calls.push(args);
        return pages.shift()!;
      },
    } as unknown as any;

    const result = await (pruneClosedDetails as any)._handler(ctx, {
      book: "layer2",
      olderThanDays: 30,
    });

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.cursor)).toEqual([null, "cursor-1"]);
    expect(calls[0]?.cutoff).toBe(result.cutoff);
    expect(result).toMatchObject({
      book: "layer2",
      scanned: 240,
      deleted: 215,
      remainingClosed: 25,
    });
  });
});

describe("pruneClosedDetailsPage", () => {
  /** Table-aware fake: the account read must not reuse the trade paginator. */
  function makeCtx(rows: any[], account: any = null) {
    const deleted: string[] = [];
    const patches: Array<{ id: string; patch: any }> = [];
    const query = {
      withIndex() {
        return this;
      },
      order() {
        return this;
      },
      async paginate() {
        return { page: rows, continueCursor: "next", isDone: false };
      },
      async first() {
        return account;
      },
    };
    const ctx = {
      db: {
        query: (_table: string) => query,
        delete: async (id: string) => {
          deleted.push(id);
        },
        patch: async (id: string, patch: any) => {
          patches.push({ id, patch });
        },
      },
    } as unknown as any;
    return { ctx, deleted, patches };
  }

  it("deletes only old closed rows and returns cursor info", async () => {
    const { ctx, deleted } = makeCtx([
      { _id: "old", exitTime: 10, entryTime: 1 },
      { _id: "recent", exitTime: 500, entryTime: 1 },
      { _id: "no-exit", entryTime: 5 },
    ]);

    const result = await (pruneClosedDetailsPage as any)._handler(ctx, {
      book: "layer2",
      cutoff: 100,
      cursor: null,
    });

    expect(deleted).toEqual(["old", "no-exit"]);
    expect(result).toMatchObject({
      scanned: 3,
      deleted: 2,
      remainingClosed: 1,
      continueCursor: "next",
      isDone: false,
    });
  });

  /**
   * The prune promises the BALANCE is untouched, but the paper balance is
   * re-derived as `start + carry + ledger` — so a deleted row's P&L has to move
   * into the carry, exactly like the measured-window prune does.
   */
  it("folds the pruned paper rows into the account carry", async () => {
    const { ctx, patches } = makeCtx(
      [
        { _id: "a", exitTime: 10, pnlUsd: 4.25, totalFeesUsd: 0.1, realizedR: 0.5 },
        { _id: "b", exitTime: 20, pnlUsd: -1.25, totalFeesUsd: 0.2, realizedR: -0.25 },
        { _id: "c", exitTime: 500, pnlUsd: 9, totalFeesUsd: 1, realizedR: 2 },
        { _id: "d", entryTime: 5, pnlUsd: 1, totalFeesUsd: 0.05, realizedR: 0.1 },
      ],
      {
        _id: "acc",
        archivedRealizedPnlUsd: 1,
        archivedTrades: 2,
        archivedWins: 1,
        archivedFeesUsd: 0.5,
        archivedR: 0.25,
        archivedUntil: 5,
      },
    );

    await (pruneClosedDetailsPage as any)._handler(ctx, {
      book: "layer2",
      cutoff: 100,
      cursor: null,
    });

    expect(patches).toHaveLength(1);
    const patch = patches[0]!.patch;
    // 4.25 - 1.25 + 1 = 4 realized on the three deleted rows.
    expect(patch.archivedRealizedPnlUsd).toBeCloseTo(5, 9);
    expect(patch.archivedTrades).toBe(5);
    // positive closes only: +4.25 and +1 (the exit-less row still carries P&L).
    expect(patch.archivedWins).toBe(3);
    expect(patch.archivedFeesUsd).toBeCloseTo(0.85, 9);
    expect(patch.archivedR).toBeCloseTo(0.6, 9);
    // Newest EXIT among the deleted rows (the exit-less row contributes none).
    expect(patch.archivedUntil).toBe(20);
  });

  it("leaves the live book's counters alone — equity is the exchange's", async () => {
    const { ctx, patches } = makeCtx(
      [{ _id: "a", exitTime: 10, pnlUsd: 4, feesUsd: 0.1, realizedR: 0.5 }],
      { _id: "acc" },
    );

    const result = await (pruneClosedDetailsPage as any)._handler(ctx, {
      book: "live",
      cutoff: 100,
      cursor: null,
    });

    expect(result.deleted).toBe(1);
    expect(patches).toHaveLength(0);
  });
});
