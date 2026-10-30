import { beforeEach, describe, expect, it, vi } from "vitest";
import { getLiveLedgerCounts, resetBookData } from "../../convex/reset";

// resetBookData is operator-gated (2026-10-30). These tests invoke its handler
// directly, so stub an allowlisted identity for the gate to admit.
beforeEach(() => {
  vi.stubEnv("OPERATOR_EMAILS", "operator@example.com");
});

class MockQuery {
  private readonly table: string;
  private readonly queriedTables: string[];

  constructor(table: string, queriedTables: string[]) {
    this.table = table;
    this.queriedTables = queriedTables;
  }

  withIndex(_name: string, _range?: unknown) {
    return this;
  }

  async collect() {
    this.queriedTables.push(this.table);
    return [];
  }

  async take(_n: number) {
    this.queriedTables.push(this.table);
    return [];
  }

  async first() {
    this.queriedTables.push(this.table);
    return null;
  }
}

describe("resetBookData", () => {
  it("does not read the growing signal log unless deletion was requested", async () => {
    const queriedTables: string[] = [];
    const ctx = {
      db: {
        query: (table: string) => new MockQuery(table, queriedTables),
        insert: async () => "archive-id",
        patch: async () => undefined,
        delete: async () => undefined,
      },
      auth: {
        getUserIdentity: async () => ({ subject: "user|test", email: "operator@example.com" }),
      },
    } as unknown as any;

    const result = await (resetBookData as any)._handler(ctx, {
      paper: true,
      live: true,
      paperBook: "layer2",
      includeSignalLog: false,
    });

    expect(result.paper?.archivedTrades).toBe(0);
    expect(queriedTables).not.toContain("strategySignals");
  });
});

/**
 * The Live page's reset control calls `paper: false, live: true`. These cover
 * the two guards that keep it from orphaning a real exchange position, and the
 * archive-before-delete contract the UI's toast promises.
 */
function makeLiveCtx(tables: Record<string, any[]>) {
  const queried: string[] = [];
  const inserted: Array<{ table: string; doc: any }> = [];
  const deleted: string[] = [];
  const patched: Array<{ id: string; patch: any }> = [];

  const db = {
    query(name: string) {
      queried.push(name);
      const docs = tables[name] ?? [];
      // The reset filters open rows through by_status_entryTime and the account
      // through by_name; honour that predicate so the guards are really tested.
      let matches: (d: any) => boolean = () => true;
      const chain: any = {
        withIndex(_index: string, range?: (q: any) => any) {
          range?.({
            eq(key: string, value: any) {
              const prev = matches;
              matches = (d: any) => prev(d) && d[key] === value;
              return chain;
            },
          });
          return chain;
        },
        order() {
          return chain;
        },
        async collect() {
          return docs.filter(matches);
        },
        async take(n: number) {
          return docs.filter(matches).slice(0, n);
        },
        async first() {
          return docs.filter(matches)[0] ?? null;
        },
      };
      return chain;
    },
    async insert(table: string, doc: any) {
      inserted.push({ table, doc });
      return "new-id";
    },
    async delete(id: string) {
      deleted.push(id);
    },
    async patch(id: string, patch: any) {
      patched.push({ id, patch });
    },
  };

  return {
    ctx: {
      db,
      auth: {
        getUserIdentity: async () => ({ subject: "user|test", email: "operator@example.com" }),
      },
    } as any,
    queried,
    inserted,
    deleted,
    patched,
  };
}

describe("resetBookData — live book (the Live page reset button)", () => {
  it("archives then wipes every live trade, leaving the paper books untouched", async () => {
    const t = makeLiveCtx({
      liveAccount: [{ _id: "acc1", name: "live", enabled: false, totalEntries: 9 }],
      liveTrades: [
        { _id: "t1", status: "closed", pnlUsd: 1.5 },
        { _id: "t2", status: "closed", pnlUsd: -1 },
      ],
      liveStats: [{ _id: "s1", closedCount: 2, wins: 1 }],
    });

    const r = await (resetBookData as any)._handler(t.ctx, {
      paper: false,
      live: true,
      includeSignalLog: false,
      reason: "test",
    });

    expect(r.live).toMatchObject({ archivedTrades: 2, statsReset: true, accountReset: true });
    const archive = t.inserted.find((i) => i.table === "liveLedgerArchive");
    expect(archive?.doc.tradeCount).toBe(2);
    expect(archive?.doc.trades).toHaveLength(2);
    expect(archive?.doc.reason).toBe("test");
    expect(t.deleted.sort()).toEqual(["s1", "t1", "t2"]);
    expect(t.patched).toHaveLength(1);
    expect(t.patched[0].patch).toMatchObject({
      totalEntries: 0,
      totalCloses: 0,
      totalEntryErrors: 0,
      lastSignalTimes: undefined,
      pendingSignals: undefined,
    });
    // The live control must never reach a paper table.
    expect(t.queried).not.toContain("paperTrades");
    expect(t.queried).not.toContain("paperAccount");
    expect(t.queried).not.toContain("strategySignals");
    expect(t.inserted.some((i) => i.table === "paperLedgerArchive")).toBe(false);
  });

  it("refuses while the bot is armed — nothing is archived or deleted", async () => {
    const t = makeLiveCtx({
      liveAccount: [{ _id: "acc1", name: "live", enabled: true }],
      liveTrades: [{ _id: "t1", status: "open" }],
      liveStats: [{ _id: "s1" }],
    });

    const r = await (resetBookData as any)._handler(t.ctx, { paper: false, live: true });

    expect(r.live.skipped).toMatch(/ARMED/);
    expect(r.live.archivedTrades).toBe(0);
    expect(t.inserted).toHaveLength(0);
    expect(t.deleted).toHaveLength(0);
    expect(t.patched).toHaveLength(0);
  });

  it("refuses while a real position is still open — a stopped bot still manages it", async () => {
    const t = makeLiveCtx({
      liveAccount: [{ _id: "acc1", name: "live", enabled: false }],
      liveTrades: [
        { _id: "open1", status: "open" },
        { _id: "closed1", status: "closed" },
      ],
      liveStats: [{ _id: "s1" }],
    });

    const r = await (resetBookData as any)._handler(t.ctx, { paper: false, live: true });

    expect(r.live.skipped).toMatch(/OPEN/);
    expect(t.inserted).toHaveLength(0);
    expect(t.deleted).toHaveLength(0);
    // The guard is read off the open rows, not the whole ledger.
    expect(t.queried).toContain("liveTrades");
  });

  it("reports the ledger size the reset will delete, not the page's 100-row window", async () => {
    // The Live table fetches only 100 closed rows, so the card used to promise
    // "All 100 stored trades" while the wipe deleted 138 (measured 2026-10-21).
    const t = makeLiveCtx({
      liveTrades: [
        ...Array.from({ length: 138 }, (_, i) => ({ _id: `c${i}`, status: "closed" })),
        { _id: "o1", status: "open" },
      ],
    });

    const counts = await (getLiveLedgerCounts as any)._handler(t.ctx, {});

    expect(counts).toMatchObject({ closed: 138, open: 1, capped: false });
  });

  it("is a no-op wipe on an empty book (no archive doc for zero rows)", async () => {
    const t = makeLiveCtx({
      liveAccount: [{ _id: "acc1", name: "live", enabled: false }],
      liveTrades: [],
      liveStats: [],
    });

    const r = await (resetBookData as any)._handler(t.ctx, { paper: false, live: true });

    expect(r.live).toMatchObject({ archivedTrades: 0, statsReset: false, accountReset: true });
    expect(t.inserted).toHaveLength(0);
    expect(t.deleted).toHaveLength(0);
    expect(t.patched).toHaveLength(1);
  });
});
