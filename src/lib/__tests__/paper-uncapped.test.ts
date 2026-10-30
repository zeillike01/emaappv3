/**
 * PAPER IS UNCAPPED — a regression guard, not a feature.
 *
 * The operator's rule (2026-10-21): the live book is the only book with a
 * concurrent-position limit (10), because it spends a finite margin. Paper is
 * the data-gathering sensor every gate is validated on, so it takes every
 * qualified signal it can and nothing may quietly limit how many positions it
 * holds.
 *
 * There is no cap field on the paper side to test against (that is the point),
 * so these tests pin the two places a cap would actually appear: the reads the
 * entry tick and both exit paths use to enumerate the open book. A `.take(n)`
 * added to either query — the cheapest possible way to "protect" the book under
 * load — would truncate the open set: entry would retry a coin it already holds
 * and the exit tick would stop managing stops on the positions past the limit.
 * The fake below implements BOTH `collect()` and `take()`, so a truncating
 * change fails on the count instead of crashing on a missing method.
 */
import { describe, expect, it } from "vitest";
import { getLayer2OpenCoins, getOpenLayer2Trades } from "../../convex/paperTrading";
import { LAYER2_BOOK, A_PLUS_BOOK } from "../books";

function fakeDb(byBook: Record<string, any[]>) {
  return {
    query: (_table: string) => ({
      withIndex: (_index: string, build: (q: any) => any) => {
        const conditions: Array<[string, unknown]> = [];
        const q: any = {
          eq: (field: string, value: unknown) => {
            conditions.push([field, value]);
            return q;
          },
        };
        build(q);
        const book = conditions.find(([field]) => field === "book")?.[1];
        const status = conditions.find(([field]) => field === "status")?.[1];
        const rows = (byBook[String(book)] ?? []).filter(
          (row: any) => status == null || row.status === status,
        );
        return {
          collect: async () => rows,
          take: async (n: number) => rows.slice(0, n),
        };
      },
    }),
  };
}

const COINS = Array.from({ length: 60 }, (_, i) => `COIN${i}`);

describe("paper book has no open-position cap", () => {
  it("enumerates every open layer2 position for the exit ticks", async () => {
    const rows = COINS.map((coin, i) => ({
      _id: `t${i}`,
      book: LAYER2_BOOK,
      status: "open",
      coin,
    }));
    const ctx = { db: fakeDb({ [LAYER2_BOOK]: rows, [A_PLUS_BOOK]: [] }) } as unknown as any;

    const open = await (getOpenLayer2Trades as any)._handler(ctx, {});

    expect(open).toHaveLength(COINS.length);
    expect(new Set(open.map((t: any) => t.coin)).size).toBe(COINS.length);
  });

  it("enumerates every open coin for the entry tick's duplicate lock", async () => {
    const rows = COINS.map((coin, i) => ({
      _id: `t${i}`,
      book: LAYER2_BOOK,
      status: "open",
      coin,
    }));
    const ctx = { db: fakeDb({ [LAYER2_BOOK]: rows }) } as unknown as any;

    const coins = await (getLayer2OpenCoins as any)._handler(ctx, {});

    expect(coins).toHaveLength(COINS.length);
  });

  it("still includes the aplus book's open rows in the shared exit read", async () => {
    const ctx = {
      db: fakeDb({
        [LAYER2_BOOK]: [{ _id: "a", book: LAYER2_BOOK, status: "open", coin: "BTC" }],
        [A_PLUS_BOOK]: [{ _id: "b", book: A_PLUS_BOOK, status: "open", coin: "ETH" }],
      }),
    } as unknown as any;

    const open = await (getOpenLayer2Trades as any)._handler(ctx, {});

    expect(open.map((t: any) => t.coin).sort()).toEqual(["BTC", "ETH"]);
  });
});
