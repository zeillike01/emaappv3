/**
 * BOOK RESET — clear the trade ledgers so a clean data window can start.
 *
 * WHY THIS EXISTS: the book has been mined twice (issue 1 = entry timing,
 * issue 2 = the never-moved cohort) off ONE 10-day sample, and a ledger that
 * mixes trades taken under the old config with trades taken under a new gate
 * set cannot answer either question cleanly — every later analysis first has to
 * guess which rows predate the change. This is the "reset and re-arm"
 * primitive: the rows go, the config and the accounts' own settings
 * (leverage / risk / pairs / enablement) stay, so the next entry is the first
 * row of the new window.
 *
 * Run it with:
 *   bun convex run reset:resetBookData '{"reason":"new gates"}'
 *   bun convex run reset:resetBookData '{"paper":true,"live":false}'
 *   bun convex run reset:resetBookData '{"includeSignalLog":true}'   // also drops the signal log
 *   bun convex run reset:resetBookData '{"paperBook":"layer2"}'     // ONLY the layer2 book
 *
 * SCOPING (audit fix 2026-09-12): omit `paperBook` and the paper clear hits
 * EVERY paper book — which is what the CLI form above was written for. But
 * this mutation now coexists with a second, independent paper book ("proxy"),
 * and the mining-window card's reset button is a layer2 control, so the UI
 * passes `paperBook: "layer2"`. Without that, one click would erase the proxy
 * book's forward record and reset its balance — see the arg doc below.
 *
 * WHAT IT TOUCHES, in order:
 *
 *   PAPER
 *     1. ARCHIVE FIRST (mirrors purgeLiveLedger's 2026-09-11 audit fix — a
 *        destructive reset must never leave the only copy of the book in the
 *        bin). The whole ledger is written to paperLedgerArchive in parts of
 *        100 rows sharing one batchId, so no single document approaches
 *        Convex's per-document size limit.
 *     2. DELETE every paperTrades row.
 *     3. DELETE the bookStats aggregate doc(s). They are lifetime counters
 *        folded per close, so leaving them would summarise trades that no
 *        longer exist; the existing self-heal (foldLayer2Stats -> full
 *        recompute) rebuilds them from the empty book on the next close.
 *     4. RESET the account(s): balance back to startBalance, and the per-pair /
 *        scan state cleared — a stale lastSignalTimes (the 1h entry cooldown)
 *        or a pending signal would otherwise suppress the FIRST entry of the
 *        new window, which is exactly the row the new gates are judged from.
 *
 *   LIVE
 *     5. Same shape, but REFUSES to run while liveAccount.enabled is true AND
 *        while any liveTrades row is still open. Deleting a real-money ledger
 *        while the bot is armed — or while a real exchange position is still
 *        live — would bury it (the engine would forget the position, stop
 *        managing its SL/TP and could re-enter the same setup), so both guards
 *        are deliberate: stop live and close/reconcile the position first.
 *        When it does run, liveTrades + liveStats are archived to
 *        liveLedgerArchive and the account's trade counters and per-pair
 *        signal state are zeroed. `enabled`, leverage, risk% and the balance
 *        snapshots survive.
 *
 *        The Live page's "reset live book" button calls exactly this branch
 *        (`paper: false, live: true`) — see src/components/LiveLedgerReset.tsx.
 *
 * NOT TOUCHED: strategyConfig (your gates), every other table, and — unless
 * `includeSignalLog` is passed — the strategySignals decision log. The log is
 * deliberately kept by default: it is not a trade ledger, it is the only record
 * of the score's flow/book/spread snapshots and the A/B replays read it. Pass
 * the flag when you want the log's window to match the ledger's.
 *
 * Note the paper scan has no on/off switch wired — paperAccount.enabled is
 * written but never read by strategyTick — so a paper reset cannot pause
 * collection. Apply the new gates in the strategy console; the first 15m close
 * after that is the new window's first row. Safe to run repeatedly.
 */
import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOperator } from "./users";

/** Rows per archive document (see schema.paperLedgerArchive). */
const ARCHIVE_PART = 100;

/**
 * The most recent paper book reset (for the UI's mining-window card).
 * Reads ONE doc off the by_purgedAt index — not the archives themselves.
 * Proves the reset archived the ledger instead of destroying it, and marks
 * when the current homogeneous data window started.
 */
export const getLatestPaperArchive = query({
  args: {},
  handler: async (ctx) => {
    const doc = await ctx.db
      .query("paperLedgerArchive")
      .withIndex("by_purgedAt")
      .order("desc")
      .first();
    if (!doc) return null;
    return {
      purgedAt: doc.purgedAt,
      batchId: doc.batchId,
      partCount: doc.partCount,
      tradeCount: doc.tradeCount,
      reason: doc.reason ?? null,
    };
  },
});

/**
 * The most recent LIVE book reset (for the Live page's reset card). Mirrors
 * getLatestPaperArchive: ONE doc off the by_purgedAt index, never the archive
 * bodies — proves the wipe archived the ledger first and dates the new window.
 */
export const getLatestLiveArchive = query({
  args: {},
  handler: async (ctx) => {
    const doc = await ctx.db
      .query("liveLedgerArchive")
      .withIndex("by_purgedAt")
      .order("desc")
      .first();
    if (!doc) return null;
    return {
      purgedAt: doc.purgedAt,
      tradeCount: doc.tradeCount,
      reason: doc.reason ?? null,
    };
  },
});

/**
 * Live ledger size, for the reset card's "what will be deleted" number.
 *
 * WHY NOT USE THE PAGE'S LIST: getLiveClosedTrades is capped at 100 rows so the
 * table stays cheap, so its `.length` undercounts the wipe (measured
 * 2026-10-21: the card promised "All 100 stored live trades" while the reset
 * deleted 138). A reset that deletes more than it announced is exactly the kind
 * of surprise this card exists to prevent, so the number comes from the ledger
 * itself. Indexed and bounded: neither cron prunes liveTrades, but a page query
 * still must not scan without a ceiling.
 */
export const getLiveLedgerCounts = query({
  args: {},
  handler: async (ctx) => {
    const CAP = 2000;
    const closed = await ctx.db
      .query("liveTrades")
      .withIndex("by_status", (q) => q.eq("status", "closed"))
      .take(CAP);
    const open = await ctx.db
      .query("liveTrades")
      .withIndex("by_status", (q) => q.eq("status", "open"))
      .take(CAP);
    return { closed: closed.length, open: open.length, capped: closed.length >= CAP };
  },
});

export const resetBookData = mutation({
  args: {
    reason: v.optional(v.string()),
    /** Clear the paper ledger (default true). */
    paper: v.optional(v.boolean()),
    /**
     * Scope the PAPER clear to ONE book (e.g. "layer2", "proxy").
     *
     * Audit fix 2026-09-12: this mutation predates the second paper book and
     * cleared EVERY book's ledger, stats and account. The reset button in the
     * mining-window card is a layer2 control, so pressing it would silently
     * destroy the proxy book's independent forward record and reset its
     * balance to $150 — the one thing that book exists to accumulate. When this
     * is set, only that book's rows are archived + deleted, only its stats doc
     * is dropped, and only its account and its stats counter are reset; every
     * other book is left byte-for-byte intact. Omit it for the old
     * every-book behaviour (the CLI form still resets everything).
     */
    paperBook: v.optional(v.string()),
    /** Clear the live ledger (default true; skipped while live is armed). */
    live: v.optional(v.boolean()),
    /** Also delete strategySignals (default false — see the header note). */
    includeSignalLog: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    await requireOperator(ctx);
    const reason = args.reason;
    const result: {
      paper?: {
        batchId: string;
        archivedTrades: number;
        archiveParts: number;
        deletedStatsDocs: number;
        cooldownsCleared: number;
        accountsReset: string[];
      };
      live?: {
        archivedTrades: number;
        statsReset: boolean;
        accountReset: boolean;
        skipped?: string;
      };
      signalsDeleted: number;
      asOf: number;
    } = { signalsDeleted: 0, asOf: Date.now() };

    // ── PAPER ────────────────────────────────────────────────────────────────
    if (args.paper ?? true) {
      const scope = args.paperBook;
      const rows = scope
        ? await ctx.db
            .query("paperTrades")
            .withIndex("by_book", (q) => q.eq("book", scope))
            .collect()
        : await ctx.db.query("paperTrades").collect();
      const allStats = await ctx.db.query("bookStats").collect();
      const stats = scope ? allStats.filter((s) => s.book === scope) : allStats;

      const batchId = `paper-reset-${Date.now().toString(36)}`;
      const partCount = Math.max(1, Math.ceil(rows.length / ARCHIVE_PART));
      for (let part = 0; part < partCount; part++) {
        await ctx.db.insert("paperLedgerArchive", {
          purgedAt: Date.now(),
          batchId,
          part,
          partCount,
          reason,
          book: scope ?? "all",
          tradeCount: rows.length,
          trades: rows.slice(part * ARCHIVE_PART, (part + 1) * ARCHIVE_PART),
          stats: part === 0 ? stats : undefined,
        });
      }

      for (const t of rows) await ctx.db.delete(t._id);
      for (const s of stats) await ctx.db.delete(s._id);

      const allAccounts = await ctx.db.query("paperAccount").collect();
      const accounts = scope
        ? allAccounts.filter((a) => a.name === scope)
        : allAccounts;
      for (const acc of accounts) {
        await ctx.db.patch(acc._id, {
          balance: acc.startBalance ?? acc.balance,
          lastSignalTimes: undefined,
          cooldownUntil: undefined,
          pendingSignals: undefined,
          pendingDirections: undefined,
          lastScanBarClose: undefined,
          fastScanUntil: undefined,
          scanLockUntil: undefined,
          scansToday: undefined,
          scansDate: undefined,
          // Refill counters belong to the previous window too — carrying a
          // deposits balance across a reset would inflate the new window's
          // Return% (the UI subtracts deposits from PnL).
          deposits: undefined,
          lastRefillAt: undefined,
          // SESSION WINDOW CARRY (2026-10-21): the reset wipes the ledger, so
          // the carry of the pruned rows goes with it — a fresh book starts at
          // the start balance with nothing carried.
          archivedRealizedPnlUsd: undefined,
          archivedTrades: undefined,
          archivedWins: undefined,
          archivedFeesUsd: undefined,
          archivedR: undefined,
          archivedUntil: undefined,
          lastScanResult: `Book reset — ${rows.length} trade(s) archived as ${batchId} — awaiting new gates`,
        });
      }

      // The engine's ACTUAL per-pair cooldown source is the single
      // `cooldowns` document (read via getLayer2Cooldowns), not
      // paperAccount.lastSignalTimes — the account reset above never touched
      // it. A stale map here suppresses the new window's first entries per
      // pair (up to 1h), which is exactly the row the new gates are judged
      // from. Delete the doc; ensureCooldownData re-seeds it (empty — the
      // book is empty) on the next strategy tick.
      // The `cooldowns` doc belongs to layer2 only (the proxy book keeps its
      // own per-pair map on its account row), so a reset scoped to any OTHER
      // book must leave it alone rather than clear the layer2 book's cooldowns.
      let cooldownsCleared = 0;
      if (!scope || scope === "layer2") {
        for (const c of await ctx.db.query("cooldowns").collect()) {
          await ctx.db.delete(c._id);
          cooldownsCleared++;
        }
      }

      result.paper = {
        batchId,
        archivedTrades: rows.length,
        archiveParts: partCount,
        deletedStatsDocs: stats.length,
        cooldownsCleared,
        accountsReset: accounts.map((a) => a.name),
      };
    }

    // ── LIVE ─────────────────────────────────────────────────────────────────
    if (args.live ?? true) {
      const acc = await ctx.db
        .query("liveAccount")
        .withIndex("by_name", (q) => q.eq("name", "live"))
        .first();

      // A real position the engine still manages must never be deleted out
      // from under the exchange (see the header note). Counted, not collected:
      // the cap is <= 20, so a bounded read is enough to prove the guard.
      const openTrades = await ctx.db
        .query("liveTrades")
        .withIndex("by_status_entryTime", (q) => q.eq("status", "open"))
        .take(20);

      if (acc?.enabled) {
        // Refuse rather than bury open positions (see the header note).
        result.live = {
          archivedTrades: 0,
          statsReset: false,
          accountReset: false,
          skipped:
            "live is ARMED (liveAccount.enabled) — stop live first, then re-run",
        };
      } else if (openTrades.length > 0) {
        result.live = {
          archivedTrades: 0,
          statsReset: false,
          accountReset: false,
          skipped: `${openTrades.length} live position(s) are still OPEN — close or reconcile them first; deleting the ledger would orphan a real exchange position`,
        };
      } else {
        const trades = await ctx.db.query("liveTrades").collect();
        const stats = await ctx.db.query("liveStats").first();

        if (trades.length > 0 || stats) {
          await ctx.db.insert("liveLedgerArchive", {
            purgedAt: Date.now(),
            reason,
            tradeCount: trades.length,
            trades: trades as unknown as any[],
            stats: stats ?? undefined,
          });
        }
        for (const t of trades) await ctx.db.delete(t._id);
        if (stats) await ctx.db.delete(stats._id);

        if (acc) {
          await ctx.db.patch(acc._id, {
            totalEntries: 0,
            totalCloses: 0,
            totalEntryErrors: 0,
            lastSignalTimes: undefined,
            pendingSignals: undefined,
            entryErrors: undefined,
            lastScanResult: "Ledger reset — awaiting re-arm with new gates",
          });
        }

        result.live = {
          archivedTrades: trades.length,
          statsReset: !!stats,
          accountReset: !!acc,
        };
      }
    }

    // ── OPTIONAL: the decision-time signal log ───────────────────────────────
    // Do not even read this table unless deletion was explicitly requested. It
    // grows much faster than the trade ledger, and counting every signal made
    // an ordinary reset exceed Convex's per-execution read budget.
    if (args.includeSignalLog) {
      const signals = await ctx.db.query("strategySignals").collect();
      for (const s of signals) await ctx.db.delete(s._id);
      result.signalsDeleted = signals.length;
    }

    return result;
  },
});
