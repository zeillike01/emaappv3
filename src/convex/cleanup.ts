/**
 * Data-retention prunes — I/O optimization (2026-09).
 *
 * Convex has no TTL index, so history growth has to be bounded by an explicit
 * scheduled mutation. These run once a day via crons.ts (inside the
 * CRONS_ENABLED gate) and keep recurring tables from replicating the growth
 * pattern that blew the free-tier Database I/O meter.
 *
 *   - pruneLayer1Ticks: old layer1Ticks rows — the batched per-tick doc
 *     (marketData.recordLayer1Tick, 2026-09) is now Layer 1's only write;
 *     history is capped to MAX_AGE_MS so the table can't grow unbounded.
 *   - pruneMarketMetrics: legacy per-pair table — the cron no longer writes
 *     to it after the batched-tick switch, so rows simply age out.
 *
 * Internal-only: nothing in the dashboard calls these directly.
 */
import { internalMutation } from "./_generated/server";

/** Max age for retained rows (7 days, per the optimization brief). */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// strategySignals keep longer (2026-09-09): the signal log is the ONLY
// record of the score's flow/book/spread snapshots — the 7-day cap made
// backtests longer than a week impossible. 60 days of signals ≈ ~25k rows
// (≈2,900/week), well within free-tier bounds.
const SIGNAL_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
// layer1Ticks keep as long as the signal log (2026-09-09): the L1 snapshots
// are the only *real* flowBias/imbalance/spread source that predates a
// signal, so the 7-day cap limited the flow gate's backtest to the same
// window as the old log. 60 days ≈ ~17k docs (288/day × 20 pairs), fine.
const L1_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

/** Safety cap per run — a very large backlog gets drained over a few days. */
const MAX_DELETIONS_PER_RUN = 2_000;

export const pruneLayer1Ticks = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - L1_MAX_AGE_MS;
    const old = await ctx.db
      .query("layer1Ticks")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", cutoff))
      .take(MAX_DELETIONS_PER_RUN);
    for (const row of old) await ctx.db.delete(row._id);
    return { deleted: old.length, cutoff };
  },
});

/**
 * Drain the legacy per-pair marketMetrics rows (no longer written since the
 * batched layer1Ticks switch). No timestamp index exists on that table, so
 * scan-and-filter with a per-run cap like the other prunes.
 */
export const pruneMarketMetrics = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - MAX_AGE_MS;
    const rows = await ctx.db.query("marketMetrics").take(MAX_DELETIONS_PER_RUN);
    let deleted = 0;
    for (const row of rows) {
      if ((row.fetchedAt ?? 0) < cutoff) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    return { deleted, cutoff };
  },
});

/**
 * Cap the h4ShadowCache (2026-09-23). One row per (pair, 4h bar): ~32 pairs ×
 * 6 bars/day = ~192 writes/day ≈ 26 B/row. 8 days of retention ≈ 1,536 rows —
 * the tags only need to match entries recorded in the last week, and a stale
 * per-pair row is re-fetched (never trusted) once its 4h bucket passes, so
 * old rows are pure dead weight. indexed by_fetched makes this a cheap range
 * scan.
 */
export const pruneH4ShadowCache = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - 8 * 24 * 60 * 60 * 1000;
    const rows = await ctx.db
      .query("h4ShadowCache")
      .withIndex("by_fetched", (q) => q.lt("fetchedAt", cutoff))
      .take(MAX_DELETIONS_PER_RUN);
    let deleted = 0;
    for (const row of rows) {
      await ctx.db.delete(row._id);
      deleted++;
    }
    // D1 shadow cache rides the same daily prune (2026-09-26): 8-day
    // retention, ~240 rows max (one per pair per UTC day).
    const d1Rows = await ctx.db
      .query("d1ShadowCache")
      .withIndex("by_fetched", (q) => q.lt("fetchedAt", cutoff))
      .take(MAX_DELETIONS_PER_RUN);
    let d1Deleted = 0;
    for (const row of d1Rows) {
      await ctx.db.delete(row._id);
      d1Deleted++;
    }
    return { deleted, cutoff, d1Deleted };
  },
});

/**
 * Cap the strategySignals audit log.
 *
 * NOTE (updated 2026-09-17): the log now carries BOTH entry rows (logSignal,
 * written only when a trade actually opened) and the veto journal (logVeto —
 * ONE batched row per tick, side="VETO", entered=false, blockers = the
 * tick's "PAIR SIDE: reason" veto list). Quiet stretches are therefore
 * auditable; a tick with zero qualified candidates writes nothing. Veto rows
 * are pruned by this same pass, same retention.
 * Indexed by timestamp, so same shape as pruneLayer1Ticks.
 */
export const pruneStrategySignals = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - SIGNAL_MAX_AGE_MS;
    const old = await ctx.db
      .query("strategySignals")
      .withIndex("by_timestamp", (q) => q.lt("timestamp", cutoff))
      .take(MAX_DELETIONS_PER_RUN);
    for (const row of old) await ctx.db.delete(row._id);
    return { deleted: old.length, cutoff };
  },
});

/**
 * Rejection rows ride the SAME 60-day pass as entries.
 *
 * 2026-09-23 (first draft): a separate 21-day cron (pruneStrategyRejections)
 * was added here to cap the decision record below the entry log. It was
 * REMOVED the next morning because it could not fire — the same measurement
 * that justified the shorter cap also made it unreachable:
 *
 *   - `strategySignals` has ONE index (by_timestamp), so the only way to reach
 *     old reject rows is a page of the OLDEST rows below the cutoff.
 *   - That band (21-60 days old) is dominated by non-reject rows: the entry
 *     log plus the batched veto journal are ~164 rows/day, i.e. ~6,400 rows
 *     across the band, against MAX_DELETIONS_PER_RUN = 2,000.
 *   - So the page filled with rows the pass refuses to delete (`veto == null`),
 *     returned `deleted: 0`, and the rejects it was written to cap sat just
 *     past the page forever. A daily read of 2,000 docs that deleted nothing.
 *
 * Volume was never the problem it was assumed to be either. MEASURED inflow
 * (2026-09-23, not the estimated ceiling): ~4 reject rows per tick ≈ 370/day,
 * against ~68 entries/day — so 60-day retention is ~22k reject rows, a few MB
 * on a table already bounded at ~33k rows by the pass above. The entry log's
 * retention bounds the whole table, and it is the only prune this table needs.
 *
 * Keeping the reject rows LONGER is also the better default for the reason
 * they exist (mining refused setups), so nothing was lost by removing the cap.
 */
