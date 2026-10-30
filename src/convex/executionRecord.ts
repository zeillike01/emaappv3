/**
 * EXECUTION RECORD (2026-10-10) — the fail-open writers behind Stage 3.
 *
 * THE CONTRACT, in order of importance:
 *   1. RECORD-ONLY. Nothing here changes status, size, price, P&L or any field
 *      the trading path reads. It writes exactly one field: `exec`.
 *   2. FAIL-OPEN. Every writer is a SEPARATE mutation reached through
 *      `ctx.scheduler.runAfter(0, …)`, and every call site wraps that schedule
 *      in `.catch(() => {})`. A logging error cannot block, alter or roll back
 *      a trade: the trade mutation has already committed, and this runs after.
 *   3. ALL-OR-NOTHING PER WRITE. The pure builders in
 *      `src/lib/execution-record.ts` return null on unusable input, and a null
 *      merge means NO database write at all — a bad log leaves the row exactly
 *      as it was (this is what the Stage 3 exception test asserts).
 *
 * The writers derive everything from the row they already have, so no call
 * site has to thread new values through the trading code.
 */
import {
  internalMutation,
  query,
  type MutationCtx,
  type ActionCtx,
} from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { buildEntryExec, buildExitExec, mergeExec, stopBeyondLiquidation } from "../lib/execution-record";

/**
 * Schedule an execution-record write. Callers use this from inside the trading
 * path — it can never throw, and it never blocks the trade on the write.
 */
export async function scheduleExecRecord(
  ctx: MutationCtx | ActionCtx,
  args:
    | { kind: "entry"; ref: { table: "paperTrades" | "liveTrades"; id: string } }
    | { kind: "exit"; ref: { table: "paperTrades" | "liveTrades"; id: string } },
): Promise<boolean> {
  try {
    const fn = args.kind === "entry" ? internal.executionRecord.recordEntry : internal.executionRecord.recordExit;
    await ctx.scheduler.runAfter(0, fn, args.ref);
    return true;
  } catch {
    return false; // logging must never break a trade
  }
}

/** Either book's trade row — the record is written to both. */
type TradeRow = Doc<"paperTrades"> | Doc<"liveTrades">;

/** Shared entry-half body, so the id and by-key writers cannot diverge. */
async function applyEntryRecord(ctx: MutationCtx, row: TradeRow | null) {
  if (!row) return { ok: false, reason: "not-found" };

  // Fields that exist on one book but not the other (volContracts vs sizeCoin,
  // confirmedAt vs entrySubmittedAt) are read through the loose view; the two
  // tables genuinely differ and a union type would forbid every shared read.
  const v = row as unknown as Record<string, number | string | null | undefined>;
  const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
  const side: "LONG" | "SHORT" = v.type === "SHORT" ? "SHORT" : "LONG";
  const built = buildEntryExec({
    side,
    intendedPrice: num(v.signalPrice),
    fillPrice: num(v.entryPrice) ?? 0,
    stopPrice: num(v.slPrice),
    targetPrice: num(v.tpPrice),
    decisionTs: num(v.signalTime),
    submittedAt: num(v.confirmedAt) ?? num(v.entrySubmittedAt),
    fillTime: num(v.entryTime),
    leverage: num(v.leverage),
    requestedQty: num(v.volContracts) ?? num(v.sizeCoin),
    filledQty: num(v.volContracts) ?? num(v.sizeCoin),
    rejects: v.entryAttempts != null && v.entryError ? 1 : 0,
  });
  const next = mergeExec(row.exec ?? null, built);
  if (!next) return { ok: false, reason: "invalid-input" }; // no write: fail-open
  await ctx.db.patch(row._id, { exec: next });
  return { ok: true, liqPrice: next.liqPrice, slippageBps: next.slippageBps };
}

/**
 * Schedule an entry record by natural key (the paper path's shape). Never
 * throws: a logging failure must not touch the trade.
 */
export async function scheduleEntryRecordByKey(
  ctx: MutationCtx | ActionCtx,
  args: { table: "paperTrades" | "liveTrades"; book: string; coin: string; signalTime: number },
): Promise<boolean> {
  try {
    await ctx.scheduler.runAfter(0, internal.executionRecord.recordEntryByKey, args);
    return true;
  } catch {
    return false;
  }
}

/** Entry half: intended vs fill, liq level, latency, rejects/partials. */
export const recordEntry = internalMutation({
  args: { table: v.union(v.literal("paperTrades"), v.literal("liveTrades")), id: v.string() },
  handler: async (ctx, args) =>
    applyEntryRecord(
      ctx,
      (await ctx.db.get(args.table === "paperTrades" ? (args.id as Id<"paperTrades">) : (args.id as Id<"liveTrades">))) as TradeRow | null,
    ),
});

/**
 * Entry half addressed by the trade's NATURAL KEY instead of its id — the paper
 * entry path's insert returns a boolean, so the caller schedules this with the
 * (book, coin, signalTime) it already has. Idempotent and fail-open.
 */
export const recordEntryByKey = internalMutation({
  args: {
    table: v.union(v.literal("paperTrades"), v.literal("liveTrades")),
    book: v.string(),
    coin: v.string(),
    signalTime: v.number(),
  },
  handler: async (ctx, args) => {
    const row =
      args.table === "paperTrades"
        ? await ctx.db
            .query("paperTrades")
            .withIndex("by_book_coin_signalTime", (q) =>
              q.eq("book", args.book).eq("coin", args.coin).eq("signalTime", args.signalTime),
            )
            .first()
        : await ctx.db
            .query("liveTrades")
            .withIndex("by_coin_signalTime", (q) => q.eq("coin", args.coin).eq("signalTime", args.signalTime))
            .first();
    return await applyEntryRecord(ctx, (row ?? null) as TradeRow | null);
  },
});

/** Exit half: stop trigger vs fill, realized R from the actual fill, flags. */
export const recordExit = internalMutation({
  args: { table: v.union(v.literal("paperTrades"), v.literal("liveTrades")), id: v.string() },
  handler: async (ctx, args) => {
    const row = (await ctx.db.get(
      args.table === "paperTrades" ? (args.id as Id<"paperTrades">) : (args.id as Id<"liveTrades">),
    )) as TradeRow | null;
    if (!row) return { ok: false, reason: "not-found" };
    const v = row as unknown as Record<string, number | string | null | undefined>;
    const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
    const side: "LONG" | "SHORT" = v.type === "SHORT" ? "SHORT" : "LONG";
    const reason = String(v.reason ?? v.closeReason ?? "");
    const exitPrice = num(v.exitPrice) ?? num(v.closeExpectedPrice) ?? 0;

    const built = buildExitExec({
      entry: (row.exec ?? null) as Record<string, unknown> | null,
      side,
      entryPrice: num(v.entryPrice) ?? 0,
      stopPrice: num(v.slPrice),
      stopTrigger: num(v.slPrice),
      stopFill: /stop/i.test(reason) ? exitPrice : null,
      exitPrice,
      exitTime: num(v.exitTime) ?? 0,
      entryTime: num(v.entryTime),
      riskPx: num(v.riskPx),
      reason,
      feeUsd: num(v.totalFeesUsd) ?? num(v.closeFeesUsd) ?? num(v.feesUsd),
      fundingPaidUsd: num(v.fundingCostUsd),
      mfeR: num(v.mfeR),
      maeR: num(v.maeR),
    });
    const next = mergeExec((row.exec ?? null) as Record<string, unknown> | null, built);
    if (!next) return { ok: false, reason: "invalid-input" }; // no write: fail-open
    await ctx.db.patch(
      args.table === "paperTrades" ? (args.id as Id<"paperTrades">) : (args.id as Id<"liveTrades">),
      { exec: next } as never,
    );
    return { ok: true, realizedR: next.realizedR, anomaly: stopBeyondLiquidation(next) };
  },
});

/**
 * Backfill the record for rows written before this instrumentation existed.
 * Bounded, scheduled, and idempotent: it only patches rows with no `exec`.
 * Pure reads of the row itself — no exchange calls.
 */
export const backfillExecutionRecords = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 100, 1), 400);
    const out = { paper: 0, live: 0, flagged: 0, skipped: 0 };
    // OLDEST FIRST. This job exists for rows written BEFORE the instrumentation
    // existed — which are the oldest closed trades. Scanning `desc` took the
    // newest `limit` rows and skipped every one that already had an `exec`
    // (i.e. nearly all of them), so as soon as ~limit new trades accumulated the
    // rows it was written for fell outside the window and were NEVER backfilled.
    const closed = await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status", (q) => q.eq("book", "layer2").eq("status", "closed"))
      .order("asc")
      .take(limit);
    for (const row of closed) {
      if (row.exec) continue;
      const side: "LONG" | "SHORT" = row.type === "SHORT" ? "SHORT" : "LONG";
      const built = buildExitExec({
        entry: null,
        side,
        entryPrice: row.entryPrice ?? 0,
        stopPrice: row.slPrice ?? null,
        stopTrigger: row.slPrice ?? null,
        stopFill: /stop/i.test(String(row.reason ?? "")) ? row.exitPrice ?? null : null,
        exitPrice: row.exitPrice ?? 0,
        exitTime: row.exitTime ?? 0,
        entryTime: row.entryTime ?? null,
        riskPx: Math.abs((row.entryPrice ?? 0) - (row.slPrice ?? 0)) || null,
        reason: String(row.reason ?? ""),
        feeUsd: row.totalFeesUsd ?? null,
        fundingPaidUsd: row.fundingCostUsd ?? null,
        mfeR: row.mfeR ?? null,
        maeR: row.maeR ?? null,
      });
      const next = mergeExec(null, built && { ...built, intendedPrice: row.signalPrice ?? null, leverage: row.leverage ?? null });
      if (!next) {
        out.skipped++;
        continue;
      }
      await ctx.db.patch(row._id, { exec: next });
      out.paper++;
      if (stopBeyondLiquidation(next)) out.flagged++;
    }
    return out;
  },
});

/**
 * Flag (and count) rows whose stop fill sits beyond the liquidation level. The
 * numbers are never rewritten — this only surfaces the impossibility, exactly
 * like `attributionAnomaly` does for peak-vs-realized.
 */
export const scanLiquidationAnomalies = internalMutation({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 200, 1), 500);
    const rows = await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status", (q) => q.eq("book", "layer2").eq("status", "closed"))
      .order("desc")
      .take(limit);
    const hits: Array<{ id: string; coin: string; side: string; stopFill: number; liqPrice: number }> = [];
    for (const r of rows) {
      if (!stopBeyondLiquidation(r.exec)) continue;
      hits.push({
        id: String(r._id),
        coin: r.coin,
        side: r.type,
        stopFill: r.exec?.stopFill ?? 0,
        liqPrice: r.exec?.liqPrice ?? 0,
      });
    }
    return { scanned: rows.length, flagged: hits.length, hits: hits.slice(0, 25) };
  },
});

/** Recent execution records for the dashboard (auth-protected). */
export const recentExecRecords = query({
  args: { book: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required");
    const limit = Math.min(Math.max(args.limit ?? 25, 1), 100);
    const book = args.book ?? "layer2";
    // This read paperTrades for ANY `book`, so asking for the live book matched
    // no row and returned an empty list — the panel would show "no executions"
    // for a book that has them. Branch on the table instead.
    const rows =
      book === "live"
        ? await ctx.db.query("liveTrades").withIndex("by_status", (q) => q.eq("status", "closed")).order("desc").take(limit)
        : await ctx.db
            .query("paperTrades")
            .withIndex("by_book_status", (q) => q.eq("book", book).eq("status", "closed"))
            .order("desc")
            .take(limit);
    return rows.map((r) => ({
      coin: r.coin,
      side: r.type,
      entryTime: r.entryTime,
      exitTime: r.exitTime ?? null,
      reason: r.reason ?? null,
      realizedR: r.realizedR ?? null,
      exec: r.exec ?? null,
    }));
  },
});
