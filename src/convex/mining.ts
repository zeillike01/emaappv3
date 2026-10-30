/**
 * MINING EXPORT — one-call dump of the active book's live trade data
 * (layer2).
 *
 * Run anytime with:
 *   bun convex run mining:exportTrades > /tmp/live-trades.json
 *
 * 2026-09: the main book and the live MEXC engine were removed; their data
 * was purged once via mining.purgeRemovedBooks (main/shadow accounts +
 * non-layer2 trades + all liveAccount/liveTrades rows) and the
 * live tables were dropped from the schema.
 *
 * Returns:
 *   - per-book summary (trades, WR, PnL, avg MAE/MFE)
 *   - session × book breakdown (does each book only work in some sessions?)
 *   - regime × book breakdown (trend-up / trend-down / chop)
 *   - winner retrace profile (how deep do winners pull back, in R?)
 *   - delay stats (signal → fill, per book)
 *   - monthly calendar buckets split into four weekly periods (UTC)
 *   - the full tagged trade dump for offline analysis
 *
 * This feeds the month-end tuning protocol: mine on weeks 1–3, validate
 * on week 4, forward-test before believing anything.
 */
import { v } from "convex/values";

import { action, mutation, query } from "./_generated/server";
import { api } from "./_generated/api";
import { bookSeedBalance } from "../lib/trade-utils";
// Session-window carry (2026-10-21) — the P&L of rows pruned out of the
// 14-day measurement window, read from the book's account.
import { readSessionWindowCarry } from "./paperTrading";
// MEXC reads go through the Node relay: this file is default-runtime and the
// WAF 403s direct fetches here (see marketRelay.ts).
import { relayKlines } from "./marketFetch";
import { atrPctOf, compactContextPatch, regimeFrom4hBars, sessionOf } from "../lib/trade-context";

type Trade = {
  book?: string; variant?: string; coin: string; type: string;
  entryPrice: number; slPrice: number; tpPrice: number;
  status: string; entryTime: number; signalTime?: number; confirmedAt?: number;
  exitPrice?: number; exitTime?: number; pnlUsd?: number; pnlPercent?: number;
  reason?: string; session?: string; regime?: string; volPct?: number;
  spreadPct?: number; mfeR?: number; maeR?: number;
  volRatioAtEntry?: number; atrPctAtEntry?: number;
  btcTrendAtEntry?: string; btcChange1h?: number; btcSlopeRaw?: number;
  dayOfWeek?: number; realizedR?: number; barsHeld?: number;
  // ── Layer 2 / enrichment extras — carried so per-book breakdowns can use them ──
  longScore?: number; shortScore?: number;
  fundingRate?: number; openInterestDelta?: number; bidAskImbalance?: number;
  htfEma20_4h?: number; htfEma50_4h?: number; htfTrend1h?: string;
  htfVol4h?: number; htfVol4hAvg?: number; distToSwingSr?: number;
  pairVsBtc1h?: number; consecutiveStreak?: number; rollingWr20?: number;
  totalFeesUsd?: number; fundingCostUsd?: number; entrySlippageBps?: number;
  timeToMfe?: number; timeToMae?: number; durationBucket?: string;
  volAtEntry?: number; volAtExit?: number; volDelta?: number;
  mfeCaptureRatio?: number; btcMoveDuringTrade?: number; ethMoveDuringTrade?: number;
};

function summarize(trades: Trade[]) {
  const closed = trades.filter((t) => t.status === "closed");
  const wins = closed.filter((t) => (t.pnlUsd ?? 0) > 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const grossWin = wins.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
  const grossLoss = Math.abs(closed.filter((t) => (t.pnlUsd ?? 0) <= 0).reduce((s, t) => s + (t.pnlUsd ?? 0), 0));
  const maeOf = (arr: Trade[]) => {
    const v = arr.map((t) => t.maeR).filter((x): x is number => typeof x === "number");
    return v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(2) : null;
  };
  const mfeOf = (arr: Trade[]) => {
    const v = arr.map((t) => t.mfeR).filter((x): x is number => typeof x === "number");
    return v.length ? +(v.reduce((s, x) => s + x, 0) / v.length).toFixed(2) : null;
  };
  const delays = trades
    .map((t) => (t.signalTime && t.confirmedAt ? (t.confirmedAt - t.signalTime) / 60_000 : null))
    .filter((x): x is number => x !== null);
  return {
    trades: trades.length,
    closed: closed.length,
    open: trades.length - closed.length,
    winRate: closed.length ? +((wins.length / closed.length) * 100).toFixed(1) : null,
    totalPnl: +totalPnl.toFixed(2),
    profitFactor: grossLoss > 0 ? +(grossWin / grossLoss).toFixed(2) : null,
    avgMaeR: maeOf(closed),
    avgMfeR: mfeOf(closed),
    avgDelayMin: delays.length ? +(delays.reduce((s, x) => s + x, 0) / delays.length).toFixed(1) : null,
    maxDelayMin: delays.length ? Math.max(...delays) : null,
  };
}

function groupBy(trades: Trade[], key: (t: Trade) => string | null | undefined) {
  const out: Record<string, Trade[]> = {};
  for (const t of trades) {
    const k = key(t);
    if (!k) continue;
    (out[k] ??= []).push(t);
  }
  const summarized: Record<string, ReturnType<typeof summarize>> = {};
  for (const [k, arr] of Object.entries(out)) summarized[k] = summarize(arr);
  return summarized;
}

/**
 * Calendar-month report split into four fixed UTC periods:
 * W1 = days 1–7, W2 = 8–14, W3 = 15–21, W4 = 22–month end.
 * The final bucket is intentionally month-end aware rather than a fifth
 * partial week, so an incomplete current month reports only collected rows.
 */
function groupByMonthWeek(trades: Trade[]) {
  const out: Record<string, Record<"W1" | "W2" | "W3" | "W4", Trade[]>> = {};
  for (const t of trades) {
    if (t.entryTime == null) continue;
    const date = new Date(t.entryTime);
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    const week: "W1" | "W2" | "W3" | "W4" =
      date.getUTCDate() <= 7 ? "W1" : date.getUTCDate() <= 14 ? "W2" : date.getUTCDate() <= 21 ? "W3" : "W4";
    (out[month] ??= { W1: [], W2: [], W3: [], W4: [] })[week].push(t);
  }
  return Object.fromEntries(
    Object.entries(out).map(([month, weeks]) => [
      month,
      {
        W1: summarize(weeks.W1),
        W2: summarize(weeks.W2),
        W3: summarize(weeks.W3),
        W4: summarize(weeks.W4),
        total: summarize([...weeks.W1, ...weeks.W2, ...weeks.W3, ...weeks.W4]),
      },
    ]),
  );
}

/**
 * MINING WINDOW — the collection-state readout for the ACTIVE book.
 *
 * After the 2026-09-12 reset the whole ledger is one homogeneous window: every
 * row in the book was taken under the CURRENT gate set. This query measures
 * that window so "let the data accumulate" becomes a number instead of a
 * feeling:
 *
 *   - windowStart = earliest entryTime in the book (≈ the reset moment),
 *   - days elapsed + trades so far (open/closed),
 *   - trades/day pace (the extrapolation input — "at this rate week 4 has N rows"),
 *   - enrichment coverage (how many rows actually carry the mining tags the
 *     analyses need: delay timeline, MFE/MAE + the early-vs-late order,
 *     entry context tags).
 *
 * Cheap: paperTrades is queried by book over the by_book index (small book —
 * hundreds of rows), never joins the archive.
 */
export const miningWindow = query({
  args: {},
  handler: async (ctx) => {
    const rows = (await ctx.db
      .query("paperTrades")
      .withIndex("by_book", (q) => q.eq("book", "layer2"))
      .collect()) as any[];
    const now = Date.now();
    const entryTimes = rows.map((r) => r.entryTime).filter((t) => typeof t === "number" && t > 0);
    const exitTimes = rows.map((r) => r.exitTime).filter((t) => typeof t === "number" && t > 0);
    const windowStart = entryTimes.length ? Math.min(...entryTimes) : null;
    const daysElapsed = windowStart ? Math.max(0.01, (now - windowStart) / 86_400_000) : 0;
    const closed = rows.filter((r) => r.status === "closed");

    // Delay timeline coverage: signalTime → confirmedAt → entryTime. The
    // "was the entry late" answer lives in this chain plus the MAE/MFE order.
    const withSignal = rows.filter((r) => typeof r.signalTime === "number").length;
    const withConfirmed = rows.filter((r) => typeof r.confirmedAt === "number").length;
    const withExcursionOrder = closed.filter(
      (r) => typeof r.timeToMfe === "number" && typeof r.timeToMae === "number",
    ).length;
    const withEntryContext = rows.filter(
      (r) => r.regime != null && r.volPct != null && r.session != null,
    ).length;

    return {
      asOf: now,
      windowStart,
      daysElapsed: +daysElapsed.toFixed(2),
      trades: rows.length,
      closed: closed.length,
      open: rows.length - closed.length,
      tradesPerDay: daysElapsed > 0 ? +(rows.length / daysElapsed).toFixed(2) : null,
      coverage: {
        signalTime: withSignal,
        confirmedAt: withConfirmed,
        excursionOrder: withExcursionOrder,
        entryContext: withEntryContext,
        total: rows.length,
      },
    };
  },
});

/**
 * One-time reconciliation: the old closeTrade bug leaked every book's P&L
 * into the MAIN balance. This resets each book's balance to
 * startBalance + (its OWN closed PnL) and zeroes trail state on open trades
 * of fixed-TP books (the main engine used to touch them via the getTrades
 * leak). Idempotent — safe to run repeatedly.
 */
export const reconcileBalances = mutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("paperTrades").collect();
    const accounts = await ctx.db.query("paperAccount").collect();
    // session-spike kept for legacy reconciliation; layer2 was previously
    // missing from this list (and had no account at all) so its P&L was never
    // tracked in any balance.
    const books = ["layer2"];
    const results: Record<string, { before: number; after: number; closedPnl: number }> = {};

    for (const book of books) {
      const acc = await reconcileOneBook(ctx, accounts, all, book);
      if (!acc) continue;
      const closedTrades = all.filter(
        (t: any) => (t.book ?? "main") === book && t.status === "closed",
      );
      const closedPnl = closedTrades.reduce((s: number, t: any) => s + (t.pnlUsd ?? 0), 0);
      // SESSION WINDOW CARRY (2026-10-21): rows that aged out of the 14-day
      // measurement window were pruned from the ledger, so their P&L lives on
      // the account as a carry. Without it this reconcile would "restore" a
      // balance that forgets every close older than the window.
      const carry = await readSessionWindowCarry(ctx, book);
      const correct = (acc.startBalance ?? 150) + carry.realizedPnlUsd + closedPnl;
      results[book] = { before: +(acc.balance ?? 0).toFixed(2), after: +correct.toFixed(2), closedPnl: +closedPnl.toFixed(2) };
      if (Math.abs((acc.balance ?? 0) - correct) > 0.005) {
        await ctx.db.patch(acc._id, { balance: correct });
      }
    }

    // Accounts for both books already exist (created by their engines);
    // layer2's account is found-or-created so its history is not lost.
    async function reconcileOneBook(
      ctx: any,
      accounts: any[],
      all: any[],
      book: string,
    ) {
      let acc = accounts.find((a: any) => a.name === book);
      if (!acc && book === "layer2") {
        const closedTrades = all.filter(
          (t: any) => (t.book ?? "main") === book && t.status === "closed",
        );
        const id = await ctx.db.insert("paperAccount", {
          name: "layer2",
          balance: bookSeedBalance(150, closedTrades),
          startBalance: 150,
          enabled: true,
          pairs: [],
          strategyVersion: "layer2-v1",
          lastSignalTimes: {},
          totalScans: 0,
        });
        return await ctx.db.get(id);
      }
      return acc;
    }

    return { results };
  },
});

export const exportTrades = action({
  args: {},
  handler: async (ctx) => {
    const raw = (await ctx.runQuery(api.paperTrading.getAllTradesRaw, {})) as any[];
    const liveRaw = (await ctx.runQuery(api.liveEngine.getLiveTradesRaw, {})) as any[];
    const live = liveRaw.map((r) => ({
      ...r,
      book: "live",
      status: r.status ?? "open",
      type: r.type ?? "",
      slPrice: r.slPrice,
      tpPrice: r.tpPrice,
      realizedR: r.realizedR,
      totalFeesUsd: r.feesUsd,
      dayOfWeek: r.entryTime != null ? new Date(r.entryTime).getUTCDay() : undefined,
    }));
    const all: Trade[] = [...raw, ...live].map((r) => ({
      ...r,
      type: r.type ?? r.side,
      slPrice: r.slPrice ?? r.sl,
      tpPrice: r.tpPrice ?? r.tp,
      session: r.session ?? r.tags?.session,
      regime: r.regime ?? r.tags?.regime,
      volPct: r.volPct ?? r.tags?.volPct,
      spreadPct: r.spreadPct ?? r.tags?.spreadPct,
    }));
    const books = ["layer2", "live"];

    const perBook: Record<string, any> = {};
    for (const b of books) {
      const bt = all.filter((t) => (t.book ?? "main") === b);
      if (bt.length === 0) continue;
      perBook[b] = {
        summary: summarize(bt),
        // UTC calendar month split: days 1–7, 8–14, 15–21, 22–month-end.
        // Empty future buckets return null; incomplete current months are not
        // projected or padded with missing days.
        byMonthWeek: groupByMonthWeek(bt),
        bySession: groupBy(bt, (t) => t.session),
        byRegime: groupBy(bt, (t) => t.regime),
        byCoin: groupBy(bt, (t) => t.coin),
        byBtcTrend: groupBy(bt, (t) => t.btcTrendAtEntry ?? null),
        byDayOfWeek: groupBy(bt, (t) => t.dayOfWeek != null ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][t.dayOfWeek] : null),
        byVolRatio: groupBy(bt, (t) => {
          const r = t.volRatioAtEntry;
          if (r == null) return null;
          return r < 2.5 ? '2-2.5x' : r < 3 ? '2.5-3x' : r < 4 ? '3-4x' : r < 5 ? '4-5x' : '5x+';
        }),
        byDirection: groupBy(bt, (t) => t.type),
        byScore: groupBy(bt, (t) => {
          const s = t.type === "LONG" ? t.longScore : t.shortScore;
          if (s == null) return null;
          return s >= 20 ? "20+" : s >= 10 ? "10-20" : s >= 0 ? "0-10" : "negative";
        }),
        byFunding: groupBy(bt, (t) => {
          const f = t.fundingRate;
          if (f == null) return null;
          return f < 0 ? "negative" : f > 0.0002 ? "high>0.0002" : "neutral";
        }),
        byHtfTrend: groupBy(bt, (t) => t.htfTrend1h ?? null),
        byDuration: groupBy(bt, (t) => t.durationBucket ?? null),
        byVolDelta: groupBy(bt, (t) => {
          const d = t.volDelta;
          if (d == null) return null;
          return d > 0.1 ? "expand>0.1" : d < -0.1 ? "contract<-0.1" : "flat";
        }),
        // session × direction: which session is worst, and is it long or short?
        bySessionAndDirection: sessionDirectionSummary(bt),
      };
    }

    // ── Entry-delay buckets (issue-1 follow-up) ──
    // "Was the entry late?" quantified: signal→confirmed→fill delay bucketed,
    // each bucket cross-tabbed with outcome. delayMs ≤ 0 (or missing chain) is
    // impossible on the engine path (signalBarTime < confirmedAt = now) and
    // reported as its own bucket rather than silently dropped.
    const delayBucketOf = (t: Trade): string => {
      if (t.signalTime == null || t.confirmedAt == null) return "no-timeline";
      const min = (t.confirmedAt - t.signalTime) / 60_000;
      if (min <= 0) return "≤0m";
      if (min < 5) return "0-5m";       // same-bar fill — the on-time case
      if (min < 15) return "5-15m";     // filled on the next scan tick
      if (min < 30) return "15-30m";
      if (min < 60) return "30-60m";
      return ">60m";                   // cap-blocked / chased-then-skipped zone
    };
    const byEntryDelay = groupBy(all, delayBucketOf);

    // Winner retrace profile: for closed WINNERS, how deep did they pull
    // back (maeR) relative to how far they ran (mfeR)? This tunes the ratchet.
    const winnerProfiles = all
      .filter((t) => t.status === "closed" && (t.pnlUsd ?? 0) > 0 && typeof t.maeR === "number")
      .map((t) => ({
        book: t.book ?? "main", coin: t.coin, type: t.type,
        mfeR: t.mfeR, maeR: t.maeR, pnlUsd: +(t.pnlUsd ?? 0).toFixed(2),
        reason: t.reason,
      }))
      .sort((a, b) => (b.mfeR ?? 0) - (a.mfeR ?? 0));

    // Volatility buckets: does high volPct help or hurt each book?
    const volBucket = (v?: number) =>
      v === undefined ? null : v < 0.4 ? "low<0.4" : v < 0.8 ? "mid0.4-0.8" : "high>0.8";
    const byVol: Record<string, any> = {};
    for (const t of all) {
      const b = volBucket(t.volPct);
      if (!b) continue;
      const k = `${t.book ?? "main"}|${b}`;
      (byVol[k] ??= { trades: 0, pnl: 0, wins: 0 });
      byVol[k].trades++;
      byVol[k].pnl = +(byVol[k].pnl + (t.pnlUsd ?? 0)).toFixed(2);
      if ((t.pnlUsd ?? 0) > 0) byVol[k].wins++;
    }

    return {
      exportedAt: Date.now(),
      totalTrades: all.length,
      perBook,
      byEntryDelay,
      winnerProfiles,
      byVolatility: byVol,
      trades: all, // full dump — every tag, every trade
    };
  },
});

/**
 * Offline signal-log dump for A/B replays of the scoring formula.
 *
 *   bun convex run mining:exportSignals > /tmp/signals.json
 *
 * strategySignals is the ONLY table that stores the decision-time inputs of
 * every fired signal (imbalance, flowBias, spreadPct, atrPct, the EMA
 * values, long/short scores) — the trade ledger keeps outcomes but not the
 * full flow snapshot. Dumping both lets a candidate formula be replayed
 * against the exact stream the engine acted on (see run-*-ab.ts scripts).
 * Optional args bound the window: sinceMs / untilMs (epoch ms).
 */
export const exportSignals = query({
  args: {
    sinceMs: v.optional(v.number()),
    untilMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("strategySignals")
      .withIndex("by_timestamp", (q) =>
        args.sinceMs != null && args.untilMs != null
          ? q.gte("timestamp", args.sinceMs).lte("timestamp", args.untilMs)
          : args.sinceMs != null
            ? q.gte("timestamp", args.sinceMs)
            : args.untilMs != null
              ? q.lt("timestamp", args.untilMs)
              : q,
      )
      .collect();
    return { exportedAt: Date.now(), count: rows.length, signals: rows };
  },
});

/** Lightweight query: return all paper trades (no enrichment). Used by verifyTrades action. */
export const getAllTrades = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("paperTrades").collect();
    return rows.map((r: any) => ({
      _id: r._id,
      book: r.book ?? "main",
      coin: r.coin,
      side: r.type ?? r.side,
      type: r.type ?? r.side,
      status: r.status,
      entryPrice: r.entryPrice,
      exitPrice: r.exitPrice,
      sl: r.slPrice ?? r.sl,
      tp: r.tpPrice ?? r.tp,
      slPrice: r.slPrice ?? r.sl,
      tpPrice: r.tpPrice ?? r.tp,
      leverage: r.leverage,
      // sizeCoin lets a replay reconcile its own cost model against what the
      // engine ACTUALLY charged: impliedCostR = realizedR - pnlUsd/riskUsd.
      sizeCoin: r.sizeCoin,
      pnlUsd: r.pnlUsd,
      pnlPercent: r.pnlPercent,
      maeR: r.maeR,
      mfeR: r.mfeR,
      trailPeakR: r.trailPeakR,
      entryTime: r.entryTime,
      exitTime: r.exitTime,
      signalTime: r.signalTime,
      confirmedAt: r.confirmedAt,
      reason: r.reason,
      session: r.session ?? r.tags?.session,
      regime: r.regime ?? r.tags?.regime,
      volPct: r.volPct ?? r.tags?.volPct,
      spreadPct: r.spreadPct ?? r.tags?.spreadPct,
      volRatioAtEntry: r.volRatioAtEntry,
      btcTrendAtEntry: r.btcTrendAtEntry,
      totalFeesUsd: r.totalFeesUsd,
      fundingCostUsd: r.fundingCostUsd,
      fundingRate: r.fundingRate,
      openInterestDelta: r.openInterestDelta,
      bidAskImbalance: r.bidAskImbalance,
      htfEma20_4h: r.htfEma20_4h,
      htfEma50_4h: r.htfEma50_4h,
      htfTrend1h: r.htfTrend1h,
      distToSwingSr: r.distToSwingSr,
      pairVsBtc1h: r.pairVsBtc1h,
      longScore: r.longScore,
      shortScore: r.shortScore,
      durationBucket: r.durationBucket,
      mfeCaptureRatio: r.mfeCaptureRatio,
      // Entry-timing dissection (2026-09-11): bars to the peak adverse and
      // peak favorable excursion. Their ORDER is the early-vs-late tell —
      // MAE-before-MFE means we entered before price went our way (early);
      // MFE-before-MAE with a shallow MFE means we entered after the move
      // and it reversed (late). Stored since Tier 1b but previously not
      // exported, so every prior timing analysis ran blind to it.
      timeToMfe: r.timeToMfe,
      timeToMae: r.timeToMae,
      // Remaining stored context the export was dropping.
      signalPrice: r.signalPrice,
      atrPctAtEntry: r.atrPctAtEntry,
      portfolioHeat: r.portfolioHeat,
      consecutiveStreak: r.consecutiveStreak,
      rollingWr20: r.rollingWr20,
      drawdownPct: r.drawdownPct,
      liquidationProx: r.liquidationProx,
      oiAtEntry: r.oiAtEntry,
      dayOfWeek: r.dayOfWeek,
      btcChange1h: r.btcChange1h,
      variant: r.variant,
      volAtEntry: r.volAtEntry,
      volAtExit: r.volAtExit,
      volDelta: r.volDelta,
      btcMoveDuringTrade: r.btcMoveDuringTrade,
      ethMoveDuringTrade: r.ethMoveDuringTrade,
      entrySlippageBps: r.entrySlippageBps,
      barsHeld: r.barsHeld,
      realizedR: r.realizedR,
      tags: { session: r.session ?? r.tags?.session, regime: r.regime ?? r.tags?.regime, volPct: r.volPct ?? r.tags?.volPct, spreadPct: r.spreadPct ?? r.tags?.spreadPct },
    }));
  },
});

/**
 * Backfill session / regime / volPct on trades missing them.
 *
 * Older layer2 rows were inserted while the entry-time enrichment only
 * sometimes recorded these fields (a transient 4h/15m fetch failure at entry
 * left regime/volPct unset, and regime pre-dates the layer2 enrichment on
 * some rows), so the mining breakdowns under-count them.
 *
 * This re-derives ONLY the fields each row is missing, from the SAME market
 * data the engine would have seen at that moment:
 *   - session = UTC-hour bucket of the 15m SIGNAL bar close (signalTime, the
 *     exact timestamp the engine tags from — falls back to entryTime),
 *   - volPct  = 15m ATR(14) as % of price over the bars CLOSED at/before
 *     entry (same formula as the engine's atrPct),
 *   - regime  = 4H EMA50 slope over the bars CLOSED at/before entry (same
 *     formula as the engine's classifyRegime4h).
 *
 * Fetches are anchored at entryTime (the fetch's endMs), so an old trade is
 * stamped with the regime/vol of ITS entry moment — never with today's
 * values. A fetch failure or shallow history leaves the field missing so the
 * next run retries; "unknown" is never written. Safe to re-run.
 */
export const backfillSessionData = action({
  args: {
    book: v.optional(v.string()),
    newerThanMs: v.optional(v.number()),
    // Report-only: compute every patch but skip the writes (safe preview).
    dryRun: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const raw = (await ctx.runQuery(api.paperTrading.getAllTradesRaw, {})) as any[];
    const liveRaw = (await ctx.runQuery(api.liveEngine.getLiveTradesRaw, {})) as any[];

    const all = [
      ...raw.map((r) => ({ ...r, book: r.book ?? "main" })),
      ...liveRaw.map((r) => ({ ...r, book: "live" })),
    ]
      .filter((t) => {
        if (args.book && t.book !== args.book) return false;
        if (args.newerThanMs && (t.entryTime ?? 0) < args.newerThanMs) return false;
        return !t.session || !t.regime || t.volPct == null;
      })
      .sort((a, b) => (a.entryTime ?? 0) - (b.entryTime ?? 0));

    type Patch = { id: string; session?: string; regime?: string; volPct?: number };
    const patches: Patch[] = [];
    let skippedNoHistory = 0;

    for (const t of all) {
      const entryTime = t.entryTime as number | undefined;
      const coin = t.coin as string | undefined;
      if (!entryTime || !coin) continue;

      const need = {
        session: t.session == null,
        regime: t.regime == null,
        volPct: t.volPct == null,
      };
      if (!need.session && !need.regime && !need.volPct) continue;

      const patch: Patch = { id: t._id };

      // session: derive from the 15m signal bar close, exactly like the
      // engine's enrichment (signalTime is the deterministic signal key).
      if (need.session) {
        patch.session = sessionOf((t.signalTime as number | undefined) ?? entryTime);
      }

      // regime: 4H EMA50 slope as of the last 4H bar closed at/before entry.
      if (need.regime) {
        try {
          const k4h = await relayKlines(ctx, coin, "4h", 80, entryTime);
          const closed = k4h.filter((k) => k.closeTime != null && k.closeTime <= entryTime);
          const regime = regimeFrom4hBars(closed);
          if (regime) patch.regime = regime; // null/"unknown" → leave missing for retry
        } catch {
          // per-trade fetch failure must not abort the whole backfill
        }
      }

      // volPct: ATR(14) % over the 15m bars closed at/before entry.
      if (need.volPct) {
        try {
          const k15 = await relayKlines(ctx, coin, "15m", 60, entryTime);
          const closed = k15.filter((k) => k.closeTime != null && k.closeTime <= entryTime);
          const volPct = atrPctOf(closed);
          if (volPct != null) patch.volPct = volPct;
        } catch {
          // leave missing for the next run
        }
      }

      if (patch.session !== undefined || patch.regime !== undefined || patch.volPct !== undefined) {
        if (need.regime && patch.regime === undefined) skippedNoHistory++;
        patches.push(patch);
      }
    }

    // Patch through an internal mutation so the action (which only has
    // runQuery/runMutation) can write. Chunks of 50 so a single large book
    // never builds one giant write.
    // Dedupe against accidental duplicate row ids (raw paper + raw live never
    // overlap, but the guard is free) and chunk writes of 50 so a single
    // large book never builds one giant mutation.
    const seen = new Set<string>();
    let patched = 0;
    if (args.dryRun) {
      return {
        book: args.book ?? "all",
        dryRun: true as const,
        scanned: all.length,
        wouldPatch: patches.filter((p) => (seen.has(p.id) ? false : seen.add(p.id))).length,
        regimeUnfilled: skippedNoHistory,
        sample: patches.slice(0, 5).map((p) => ({ ...p })),
        asOf: Date.now(),
      };
    }
    for (let i = 0; i < patches.length; i += 50) {
      const chunk = patches.slice(i, i + 50);
      const ids = chunk.filter((p) => seen.has(p.id) ? false : seen.add(p.id));
      if (ids.length === 0) continue;
      await ctx.runMutation(api.mining.patchTradeContext, { patches: ids });
      patched += ids.length;
    }

    return {
      book: args.book ?? "all",
      scanned: all.length,
      patched,
      regimeUnfilled: skippedNoHistory,
      asOf: Date.now(),
    };
  },
});

/**
 * Internal mutation: patch session / regime / volPct on a batch of trades.
 * Called by backfillSessionData (which does the MEXC fetches in the action).
 *
 * IMPORTANT: only keys that are actually present are written. In Convex,
 * patching a field with `undefined` DELETES it — a backfill must never be
 * able to wipe an already-correct field, so undefined keys are stripped
 * before the patch (this caused exactly that bug once: the 78 regime-less
 * rows lost their good session/volPct on the first corrected run).
 */
export const patchTradeContext = mutation({
  args: {
    patches: v.array(
      v.object({
        id: v.string(),
        session: v.optional(v.string()),
        regime: v.optional(v.string()),
        volPct: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    for (const p of args.patches) {
      const updates = compactContextPatch(p);
      if (Object.keys(updates).length === 0) continue;
      await ctx.db.patch(p.id as unknown as Parameters<typeof ctx.db.patch>[0], updates);
    }
    return { patched: args.patches.length };
  },
});

/**
 * session × direction cross-tab. Each cell = summarize() of the trades in that
 * (session, LONG|SHORT) bucket, so the JSON directly answers "which session is
 * worst, and is it long or short?" without opening every individual row.
 */
export function sessionDirectionSummary(trades: Trade[]): Record<string, Record<string, ReturnType<typeof summarize>>> {
  const out: Record<string, Record<string, Trade[]>> = {};
  for (const t of trades) {
    const s = t.session ?? "unknown";
    const d = t.type === "LONG" ? "LONG" : t.type === "SHORT" ? "SHORT" : "other";
    (out[s] ??= {});
    (out[s][d] ??= []);
    out[s][d].push(t);
  }
  const result: Record<string, Record<string, ReturnType<typeof summarize>>> = {};
  for (const [s, byDir] of Object.entries(out)) {
    result[s] = {};
    for (const [d, arr] of Object.entries(byDir)) {
      result[s][d] = summarize(arr);
    }
  }
  return result;
}
