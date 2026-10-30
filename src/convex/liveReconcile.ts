"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { fetchAllTickers, fetchTickerPrice } from "../lib/mexc/mexcFetchers";
import { toMexcSymbol } from "../lib/tracked-pairs";
import {
  BRACKET_BACKSTOP_MS,
  ensureLiveBracket,
  fetchOpenPositions,
  reconcileLiveCloseIntents,
  reconcilePendingLiveEntries,
  reconstructClosedPnl,
  submitLiveMarketClose,
} from "./liveBroker";
import {
  estimateExit,
  matchPositionEntry,
  expectedMarketExitPrice,
  manualCloseAck,
  nameExitFromFill,
  recordLiveCloseWrite,
} from "../lib/live-math";

type BracketRecovery = { checked: number; attached: number; pending: number; failed: number; unmanaged: number; results: string[] };

/**
 * Adopt or attach protection for every open row that has not been bracketed.
 * This runs only after the entry ledger has acknowledged the fill; each write is
 * fenced by liveEngine's durable bracket intent and every position match is
 * exact-side aware.
 */
async function reconcileBrackets(ctx: any): Promise<BracketRecovery> {
    const open: any[] = await ctx.runQuery(api.liveEngine.getLiveOpenTrades);
    const targets = open.filter(
      (trade) => trade.exchangeStop !== true && trade.bracketIntentStatus !== "attached",
    );
    const summary: BracketRecovery = {
      checked: targets.length,
      attached: 0,
      pending: 0,
      failed: 0,
      unmanaged: 0,
      results: [],
    };
    if (targets.length === 0) return summary;

    let positions: Awaited<ReturnType<typeof fetchOpenPositions>>;
    try {
      positions = await fetchOpenPositions();
    } catch (e: any) {
      summary.failed = targets.length;
      summary.results.push(`bracket recovery: exchange positions unavailable — ${e?.message ?? e}`);
      return summary;
    }

    for (const trade of targets) {
      const side: "LONG" | "SHORT" = trade.type === "LONG" ? "LONG" : "SHORT";
      const position = matchPositionEntry(
        positions,
        toMexcSymbol(trade.coin),
        side === "LONG" ? 1 : 2,
      );
      if (!position) {
        summary.unmanaged++;
        summary.results.push(`${trade.coin}: bracket recovery waiting for exact-side position`);
        continue;
      }
      try {
        const bracket = await ensureLiveBracket({ ctx, trade, position });
        if (bracket.state === "attached") summary.attached++;
        else if (bracket.state === "pending") summary.pending++;
        else if (bracket.state === "failed") summary.failed++;
        else summary.unmanaged++;
        if (bracket.state !== "attached" || bracket.detail) {
          summary.results.push(
            `${trade.coin}: bracket ${bracket.state}${bracket.detail ? ` — ${bracket.detail}` : ""}`,
          );
        }
      } catch (e: any) {
        summary.failed++;
        summary.results.push(`${trade.coin}: bracket recovery error — ${e?.message ?? e}`);
      }
    }
    return summary;
}

export const reconcileLiveBrackets = internalAction({
  args: {},
  handler: reconcileBrackets,
});

/**
 * Crash-recovery pass for the real-money book. It is deliberately separate
 * from market-sensitive entry/exit actions: reconciliation is safe to run on a
 * short cadence, while the existing L1/L2/live cadences remain unchanged.
 */
export const reconcileLiveIntents = internalAction({
  // `silent` is set by the live-entry / live-exit cron wrappers, which invoke
  // this pass inline before their own tick. A stamp means "the SCHEDULER's
  // dedicated reconcile cron fired" — letting the wrappers beat the same row
  // would mask a dead */5 cron behind the :03 entry/exit cluster (audit
  // 2026-10-01: the row was stamped ~96 extra times/day by the wrappers).
  // The dedicated registration in crons.ts passes nothing and still beats.
  args: { silent: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const startedAt = Date.now();
    if (!args.silent) {
      await ctx.runMutation(internal.heartbeat.record, { job: "live-intent-reconcile" }).catch(() => {});
    }
    const entries = await reconcilePendingLiveEntries(ctx);
    const closes = await reconcileLiveCloseIntents(ctx);
    const brackets = await reconcileBrackets(ctx);
    const result = {
      status: "ok",
      entries,
      closes,
      brackets,
      pending: entries.pending + closes.pending + brackets.pending + brackets.unmanaged,
      settled: entries.opened + closes.settled + brackets.attached,
      failed: entries.failed + closes.failed + brackets.failed,
    };
    await ctx.runMutation(internal.liveEngine.setLiveMeta, {
      lastIntentAt: Date.now(),
      lastIntentResult:
        `INTENT RECONCILIATION — entries ${entries.opened} opened/${entries.pending} pending/${entries.failed} failed · ` +
        `closes ${closes.settled} settled/${closes.pending} pending/${closes.failed} failed · ` +
        `brackets ${brackets.attached} attached/${brackets.pending + brackets.unmanaged} pending/${brackets.failed} failed`,
      lastIntentPending: result.pending,
      lastIntentFailed: result.failed,
    }).catch(() => {});
    // Duration for the DEDICATED cron only (2026-10-28): the live-entry and
    // live-exit wrappers call this pass with `silent: true`, and their rows own
    // their own timings. See convex/tickTiming.ts.
    if (!args.silent) {
      await ctx
        .runMutation(internal.heartbeat.recordDuration, {
          job: "live-intent-reconcile",
          durationMs: Date.now() - startedAt,
        })
        .catch(() => {});
    }
    return result;
  },
});

async function priceMapFor(pairs: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  let tickers: Awaited<ReturnType<typeof fetchAllTickers>> | undefined;
  try {
    tickers = await fetchAllTickers();
  } catch {
    tickers = undefined;
  }
  const missing = tickers
    ? pairs.filter((pair) => !((tickers!.get(pair)?.last ?? 0) > 0))
    : pairs;
  await Promise.all(
    missing.map(async (pair) => {
      try {
        const value = await fetchTickerPrice(pair);
        if (value > 0) out.set(pair, value);
      } catch {
        // Keep the row open; a ticker failure is not a close.
      }
    }),
  );
  if (tickers) {
    for (const pair of pairs) {
      const value = tickers.get(pair)?.last;
      if (value != null && value > 0) out.set(pair, value);
    }
  }
  return out;
}

/**
 * Live settlement worker used by the cron wrapper. Every market close claims a
 * durable close intent; every position lookup is side-aware. The old raw-order
 * path is intentionally not used here.
 */
export const liveExitTickSafe = internalAction({
  args: {},
  handler: async (ctx): Promise<{ status: string; checked: number; closed: number; results: string[] }> => {
    await ctx.runMutation(internal.heartbeat.record, { job: "live-exit" }).catch(() => {});
    const openTrades: any[] = await ctx.runQuery(api.liveEngine.getLiveOpenTrades);
    const now = Date.now();
    const results: string[] = [];
    if (openTrades.length === 0) {
      await ctx.runMutation(internal.liveEngine.setLiveMeta, {
        lastExitAt: now,
        lastExitResult: "no open positions",
      }).catch(() => {});
      return { status: "ok", checked: 0, closed: 0, results: ["no open live positions"] };
    }

    const reconciled = await reconcileLiveCloseIntents(ctx);
    if (reconciled.results.length) results.push(...reconciled.results);
    let positions: Awaited<ReturnType<typeof fetchOpenPositions>>;
    try {
      positions = await fetchOpenPositions();
    } catch (e: any) {
      const note = `open positions fetch failed — no ledger closes fabricated: ${e?.message ?? e}`;
      await ctx.runMutation(internal.liveEngine.setLiveMeta, {
        lastExitAt: now,
        lastExitResult: note,
      }).catch(() => {});
      return { status: "error", checked: openTrades.length, closed: 0, results: [note] };
    }

    const priceMap = await priceMapFor([...new Set(openTrades.map((t) => t.coin))]);
    let closed = 0;
    for (const trade of openTrades) {
      const side: "LONG" | "SHORT" = trade.type === "LONG" ? "LONG" : "SHORT";
      const sym = toMexcSymbol(trade.coin);
      const pos = matchPositionEntry(positions, sym, side === "LONG" ? 1 : 2);
      const price = priceMap.get(trade.coin);
      if (!pos) {
        const recon = await reconstructClosedPnl({
          coin: trade.coin,
          type: trade.type,
          entryTime: trade.entryTime,
          entryPrice: trade.entryPrice,
          volContracts: trade.volContracts,
          notionalUsd: trade.notionalUsd,
          slPrice: trade.slPrice,
        });
        if (!recon) {
          results.push(`${trade.coin}: position absent but no close fill recovered — remains open/pending`);
          continue;
        }
        const named = nameExitFromFill({
          fillPrice: recon.exitPrice,
          slPrice: trade.slPrice,
          tpPrice: trade.tpPrice,
          trailLockPrice: trade.trailLockPrice,
        });
        const write = await recordLiveCloseWrite(() =>
          ctx.runMutation(internal.liveEngine.markLiveClosed, {
            id: trade._id,
            exitPrice: recon.exitPrice,
            exitTime: now,
            reason: named.name,
            pnlUsd: recon.pnlUsd,
            realizedR: recon.realizedR,
            feesUsd: recon.feesUsd,
          }),
        );
        if (write === "recorded") closed++;
        results.push(`${trade.coin}: off-engine ${named.name} reconciled (${write})`);
        continue;
      }
      if (!price || price <= 0) {
        results.push(`${trade.coin}: holding — ticker unavailable`);
        continue;
      }

      const isLong = side === "LONG";
      const sl = Number(trade.slPrice);
      const tp = Number(trade.tpPrice);
      let trigger: "Stop Loss" | "Take Profit" | null = null;
      if (isLong) {
        if (price <= sl) trigger = "Stop Loss";
        else if (tp > 0 && price >= tp) trigger = "Take Profit";
      } else if (price >= sl) trigger = "Stop Loss";
      else if (tp > 0 && price <= tp) trigger = "Take Profit";

      if (!trigger) {
        if (trade.exchangeStop && trade.bracketBreachSince != null) {
          await ctx.runMutation(internal.liveEngine.setLiveBracketBreach, { id: trade._id }).catch(() => {});
        }
        results.push(`${trade.coin}: holding (${price.toFixed(6)})`);
        continue;
      }
      if (trade.exchangeStop) {
        const breachAt = trade.bracketBreachSince ?? now;
        if (trade.bracketBreachSince == null) {
          await ctx.runMutation(internal.liveEngine.setLiveBracketBreach, { id: trade._id, since: now }).catch(() => {});
        }
        if (now - breachAt < BRACKET_BACKSTOP_MS) {
          results.push(`${trade.coin}: ${trigger} breached — exchange bracket owns the close`);
          continue;
        }
      }

      const closeVol = pos.vol > 0 ? Math.min(trade.volContracts, pos.vol) : trade.volContracts;
      if (!(closeVol > 0)) {
        results.push(`${trade.coin}: ${trigger} detected but no closeable volume`);
        continue;
      }
      // This worker submits a market close for both triggers. The sampled
      // ticker plus adverse slippage is therefore the honest ledger estimate;
      // booking the fixed TP (or stop level) would overstate a market fill.
      const expectedExit = expectedMarketExitPrice({ side, price });
      const ratio = trade.volContracts > 0 ? Math.min(1, closeVol / trade.volContracts) : 1;
      const estimate = estimateExit({
        notionalUsd: (trade.notionalUsd ?? 0) * ratio,
        entryPrice: pos.avgPrice || trade.entryPrice,
        exitPrice: expectedExit,
        side,
        slPrice: sl,
      });
      const submitted = await submitLiveMarketClose({
        ctx,
        trade,
        symbol: sym,
        side,
        closeVol,
        reason: trigger,
        expectedExit,
        exitTime: now,
        pnlUsd: estimate.pnlUsd,
        realizedR: estimate.realizedR,
        feesUsd: estimate.fees,
      });
      if (submitted.writeState === "recorded") closed++;
      results.push(
        `${trade.coin}: ${trigger} close ${submitted.writeState}` +
          (submitted.orderId ? ` order ${submitted.orderId}` : "") +
          (submitted.error ? ` — ${submitted.error}` : ""),
      );
    }

    await ctx.runMutation(internal.liveEngine.setLiveMeta, {
      lastExitAt: now,
      lastExitResult: `${openTrades.length} checked · ${closed} closed · ${reconciled.pending} close intent(s) pending`,
    }).catch(() => {});
    return { status: "ok", checked: openTrades.length, closed, results };
  },
});

/** Manual close adapter with the same durable fence and side-aware match. */
export const manualCloseLiveTradeSafe = action({
  args: { id: v.id("liveTrades") },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string; accepted?: boolean }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required");
    await ctx.runMutation(api.liveEngine.assertLiveOwner, {});
    const open: any[] = await ctx.runQuery(api.liveEngine.getLiveOpenTrades);
    const trade = open.find((row) => row._id === args.id);
    if (!trade) return { ok: false, reason: "trade is not open" };
    const side: "LONG" | "SHORT" = trade.type === "LONG" ? "LONG" : "SHORT";
    const sym = toMexcSymbol(trade.coin);
    let positions: Awaited<ReturnType<typeof fetchOpenPositions>>;
    try {
      positions = await fetchOpenPositions();
    } catch (e: any) {
      return { ok: false, reason: `exchange position lookup failed: ${e?.message ?? e}` };
    }
    const pos = matchPositionEntry(positions, sym, side === "LONG" ? 1 : 2);
    if (!pos) {
      const recon = await reconstructClosedPnl({
        coin: trade.coin,
        type: trade.type,
        entryTime: trade.entryTime,
        entryPrice: trade.entryPrice,
        volContracts: trade.volContracts,
        notionalUsd: trade.notionalUsd,
        slPrice: trade.slPrice,
      });
      if (!recon) return { ok: false, reason: "position absent and no exchange fill was recoverable" };
      const named = nameExitFromFill({
        fillPrice: recon.exitPrice,
        slPrice: trade.slPrice,
        tpPrice: trade.tpPrice,
        trailLockPrice: trade.trailLockPrice,
      });
      const write = await recordLiveCloseWrite(() =>
        ctx.runMutation(internal.liveEngine.markLiveClosed, {
          id: trade._id,
          exitPrice: recon.exitPrice,
          exitTime: Date.now(),
          reason: named.name,
          pnlUsd: recon.pnlUsd,
          realizedR: recon.realizedR,
          feesUsd: recon.feesUsd,
        }),
      );
      return manualCloseAck({ reportedOk: write === "recorded", stillOpen: write !== "recorded", reason: `${named.name}: ${write}` });
    }
    const price = await fetchTickerPrice(trade.coin);
    if (!(price > 0)) return { ok: false, reason: "ticker unavailable" };
    const closeVol = pos.vol > 0 ? Math.min(trade.volContracts, pos.vol) : trade.volContracts;
    const expectedExit = expectedMarketExitPrice({ side, price });
    const ratio = trade.volContracts > 0 ? Math.min(1, closeVol / trade.volContracts) : 1;
    const estimate = estimateExit({
      notionalUsd: (trade.notionalUsd ?? 0) * ratio,
      entryPrice: pos.avgPrice || trade.entryPrice,
      exitPrice: expectedExit,
      side,
      slPrice: trade.slPrice,
    });
    const submitted = await submitLiveMarketClose({
      ctx,
      trade,
      symbol: sym,
      side,
      closeVol,
      reason: "Manual close",
      expectedExit,
      exitTime: Date.now(),
      pnlUsd: estimate.pnlUsd,
      realizedR: estimate.realizedR,
      feesUsd: estimate.fees,
    });
    const stillOpen = submitted.writeState !== "recorded" && submitted.writeState !== "already-closed";
    const accepted = submitted.sent;
    return {
      ...manualCloseAck({
        reportedOk: submitted.writeState === "recorded",
        stillOpen,
        accepted,
        reason: submitted.error ?? `close intent ${submitted.writeState}`,
      }),
      accepted,
    };
  },
});
