/**
 * HISTORY ARCHIVE — closed-trade detail export + retention pruning.
 *
 * Why this exists (monthly cost/retention protocol, 2026-09):
 *
 *   - Every closed trade row is a detail record (~1.5 KB). The books grow
 *     ~750 rows/month, and whole-book reads (deep analytics, mining exports,
 *     Claude-bound backtest dumps) cost Database I/O proportional to the
 *     stored book. Pruning old detail rows keeps those reads bounded forever.
 *   - The per-book AGGREGATE docs (bookStats for paper / liveStats for live)
 *     are LIFETIME counters and are deliberately NOT touched here: header
 *     stats (Balance / Return / Closed / Win Rate / Realized PnL) keep
 *     counting all-time, so a prune never looks like the account lost money.
 *     Deleting rows only shrinks the detail ledger (list, exports, analytics
 *     over the retained window).
 *   - Workflow this powers (manual, from the UI): once a month click
 *     "Download JSON" to snapshot the stored book for offline/Claude
 *     backtesting, then "Prune" to drop detail rows closed before the
 *     retention window. Open trades are never touched.
 *
 * The two books:
 *   - book = "layer2" → paperTrades (paper workspace, book "layer2")
 *   - book = "live"   → liveTrades (real MEXC ledger)
 */
import { v } from "convex/values";
import { action, internalMutation, query } from "./_generated/server";
import { internal } from "./_generated/api";

export const BOOK_VALIDATOR = v.union(v.literal("layer2"), v.literal("live"));

export type Book = "layer2" | "live";

/** Hard floor so a stray caller can never wipe the whole book in one shot. */
export const MIN_RETENTION_DAYS = 7;
/** Hard ceiling. */
export const MAX_RETENTION_DAYS = 365;

async function pageClosed(
  ctx: any,
  book: Book,
  cursor: string | null,
  numItems: number,
): Promise<{ page: any[]; continueCursor: string | null; isDone: boolean }> {
  const base =
    book === "layer2"
      ? ctx.db
          .query("paperTrades")
          .withIndex("by_book_status_entryTime", (q: any) =>
            q.eq("book", "layer2").eq("status", "closed"),
          )
      : ctx.db
          .query("liveTrades")
          .withIndex("by_status_entryTime", (q: any) => q.eq("status", "closed"));
  const result = await base.order("desc").paginate({ numItems, cursor });
  return {
    page: (result.page ?? []) as any[],
    continueCursor: (result.continueCursor as string | null) ?? null,
    isDone: Boolean(result.isDone),
  };
}

/**
 * One keyset-paginated page of CLOSED detail rows (newest first). The export
 * flow in the UI loops this until isDone, assembling the JSON file client-side
 * — so a full-book export costs ~1 MB of reads once per click instead of a
 * standing subscription, and never blows Convex's per-result size limits.
 */
export const getClosedArchivePage = query({
  args: {
    book: BOOK_VALIDATOR,
    cursor: v.union(v.string(), v.null()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 200);
    return await pageClosed(ctx, args.book, args.cursor, limit);
  },
});

/**
 * Delete one bounded page of CLOSED detail rows. This is a separate mutation
 * because Convex permits only one paginated query per function invocation.
 * The public prune action invokes this once per page, each in its own
 * transaction, so large books do not hit that restriction.
 */
export const pruneClosedDetailsPage = internalMutation({
  args: {
    book: BOOK_VALIDATOR,
    cutoff: v.number(),
    cursor: v.union(v.string(), v.null()),
  },
  handler: async (ctx, args) => {
    const result = await pageClosed(ctx, args.book, args.cursor, 200);
    let deleted = 0;
    // CARRY FOLD (2026-10-21 third pass). This prune deletes DETAIL rows while
    // the lifetime counters deliberately stay put — which is only safe if the
    // P&L leaves the ledger, not the book. The paper book re-derives its
    // balance from `ledger + carry` (paperTrading.restoreLayer2Balance,
    // mining.reconcileBalances), so deleting rows here without folding their
    // result into the carry made that rebuild SHORT by exactly the pruned P&L:
    // the card promises "Balance is NOT touched", and a later "restore balance"
    // would have moved it. Same accumulators the measured-window prune writes,
    // so the two prune paths agree on what "carried" means.
    let trades = 0;
    let wins = 0;
    let pnlUsd = 0;
    let feesUsd = 0;
    let realizedR = 0;
    let newestExit: number | null = null;
    for (const row of result.page) {
      const closeAt = row.exitTime ?? row.entryTime ?? 0;
      if (closeAt > 0 && closeAt < args.cutoff) {
        await ctx.db.delete(row._id);
        deleted++;
        trades++;
        const pnl = typeof row.pnlUsd === "number" && Number.isFinite(row.pnlUsd) ? row.pnlUsd : 0;
        if (pnl > 0) wins++;
        pnlUsd += pnl;
        feesUsd +=
          typeof row.totalFeesUsd === "number" && Number.isFinite(row.totalFeesUsd)
            ? row.totalFeesUsd
            : 0;
        realizedR +=
          typeof row.realizedR === "number" && Number.isFinite(row.realizedR) ? row.realizedR : 0;
        const exit = typeof row.exitTime === "number" ? row.exitTime : null;
        if (exit != null) newestExit = newestExit == null ? exit : Math.max(newestExit, exit);
      }
    }
    // The LIVE book has no ledger-derived balance (equity is the exchange's),
    // and its lifetime counters are never rebuilt from the ledger, so there is
    // no carry to maintain there.
    if (deleted > 0 && args.book !== "live") {
      const acc: any = await ctx.db
        .query("paperAccount")
        .withIndex("by_name", (q: any) => q.eq("name", args.book))
        .first();
      if (acc) {
        await ctx.db.patch(acc._id, {
          archivedRealizedPnlUsd: (acc.archivedRealizedPnlUsd ?? 0) + pnlUsd,
          archivedTrades: (acc.archivedTrades ?? 0) + trades,
          archivedWins: (acc.archivedWins ?? 0) + wins,
          archivedFeesUsd: (acc.archivedFeesUsd ?? 0) + feesUsd,
          archivedR: (acc.archivedR ?? 0) + realizedR,
          archivedUntil:
            Math.max(acc.archivedUntil ?? 0, newestExit ?? 0) || undefined,
        });
      }
    }
    return {
      scanned: result.page.length,
      deleted,
      remainingClosed: result.page.length - deleted,
      continueCursor: result.continueCursor,
      isDone: result.isDone || result.page.length === 0,
    };
  },
});

/**
 * Delete CLOSED detail rows whose close time (exitTime, falling back to
 * entryTime) is older than `olderThanDays`. Pages are read/deleted in separate
 * transactions by pruneClosedDetailsPage, avoiding multiple paginated queries
 * in one Convex function invocation.
 *
 * Deliberately does NOT touch bookStats / liveStats — those are lifetime
 * aggregates (see header comment). Returns what was scanned/deleted so the UI
 * can report exactly what happened.
 */
export const pruneClosedDetails = action({
  args: {
    book: BOOK_VALIDATOR,
    olderThanDays: v.number(),
  },
  handler: async (ctx, args) => {
    const days = Math.min(
      Math.max(Math.floor(args.olderThanDays), MIN_RETENTION_DAYS),
      MAX_RETENTION_DAYS,
    );
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    let scanned = 0;
    let deleted = 0;
    let remainingClosed = 0;
    let cursor: string | null = null;

    for (;;) {
      const page: {
        scanned: number;
        deleted: number;
        remainingClosed: number;
        continueCursor: string | null;
        isDone: boolean;
      } = await ctx.runMutation(internal.archive.pruneClosedDetailsPage, {
        book: args.book,
        cutoff,
        cursor,
      });
      scanned += page.scanned;
      deleted += page.deleted;
      remainingClosed += page.remainingClosed;
      if (page.isDone) break;
      if (!page.continueCursor) {
        throw new Error("Prune pagination ended before the closed-trade scan completed");
      }
      if (page.continueCursor === cursor) {
        throw new Error("Prune pagination did not advance to the next page");
      }
      cursor = page.continueCursor;
    }

    return {
      book: args.book,
      cutoff,
      scanned,
      deleted,
      remainingClosed,
    };
  },
});
