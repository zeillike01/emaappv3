/**
 * PAIR REVIEW — per-coin profitability on the layer-2 book.
 *
 * Purpose: decide which pairs belong on the strategy blocklist. Mirrors how
 * ARB/ENA originally got flagged (mistake-taxonomy + per-era R), but kept as a
 * simple drill-down you can re-run after any tuning change.
 *
 * Usage:
 *   bun convex run pairReview:reviewLayer2
 *
 * Returns per coin:
 *   n, wins, WR, sumR, avgR, PF, avg MFE/MAE, LONG vs SHORT sumR,
 *   exit-format signature (avg SL%/TP%), first entry / last exit, open count.
 * The SL%/TP% columns are an era proxy: the layer-2 book traded several exit
 * regimes (0.3% SL old era, TP 1.33R era, live TP 2.0R era + rlock).
 *
 * Read-only — no cron, no writes, cheap enough to re-run anytime.
 */
import { query } from "./_generated/server";
import { blocklistUnion } from "../lib/layer2-signal";

function avg(nums: number[]): number | null {
  if (nums.length === 0) return null;
  return nums.reduce((s, n) => s + n, 0) / nums.length;
}

interface CoinAgg {
  coin: string;
  closed: number;
  open: number;
  wins: number;
  sumR: number;
  grossWinR: number;
  grossLossR: number;
  longSumR: number;
  shortSumR: number;
  mfe: number[];
  mae: number[];
  slPcts: number[];
  tpPcts: number[];
  firstEntry: number;
  lastExit: number;
}

export const reviewLayer2 = query({
  args: {},
  handler: async (ctx) => {
    // BOTH layer-2 rows. This review DECIDES the blocklist, and the two books
    // read different rows (paper "ema-momentum", live "live"), so reporting
    // one list silently hides the other. 2026-09-22: the lists had diverged
    // 2 vs 21 and nothing in this panel could show it.
    const cfg = await ctx.db
      .query("strategyConfig")
      .withIndex("by_name", (q) => q.eq("name", "ema-momentum"))
      .first();
    const liveCfg = await ctx.db
      .query("strategyConfig")
      .withIndex("by_name", (q) => q.eq("name", "live"))
      .first();
    const paperList = ((cfg as any)?.blocklist ?? []) as string[];
    const liveList = ((liveCfg as any)?.blocklist ?? []) as string[];
    const blocklistDivergence = [...new Set([...paperList, ...liveList])]
      .filter((p) => !(paperList.includes(p) && liveList.includes(p)))
      .sort();

    const trades = await ctx.db
      .query("paperTrades")
      .withIndex("by_book", (q) => q.eq("book", "layer2"))
      .collect();

    const byCoin = new Map<string, CoinAgg>();
    const get = (coin: string): CoinAgg => {
      let a = byCoin.get(coin);
      if (!a) {
        a = {
          coin,
          closed: 0,
          open: 0,
          wins: 0,
          sumR: 0,
          grossWinR: 0,
          grossLossR: 0,
          longSumR: 0,
          shortSumR: 0,
          mfe: [],
          mae: [],
          slPcts: [],
          tpPcts: [],
          firstEntry: Infinity,
          lastExit: 0,
        };
        byCoin.set(coin, a);
      }
      return a;
    };

    for (const t of trades) {
      const a = get(t.coin);
      if (t.entryTime < a.firstEntry) a.firstEntry = t.entryTime;

      if (t.status === "open") {
        a.open++;
        continue;
      }
      if (t.status !== "closed" || typeof t.realizedR !== "number") continue;

      a.closed++;
      a.sumR += t.realizedR;
      a.lastExit = Math.max(a.lastExit, t.exitTime ?? 0);
      if (t.realizedR > 0) {
        a.wins++;
        a.grossWinR += t.realizedR;
      } else {
        a.grossLossR += Math.abs(t.realizedR);
      }
      if (t.type === "LONG") a.longSumR += t.realizedR;
      else a.shortSumR += t.realizedR;

      if (typeof t.mfeR === "number") a.mfe.push(t.mfeR);
      if (typeof t.maeR === "number") a.mae.push(t.maeR);
      if (t.entryPrice && t.slPrice) {
        const risk = Math.abs(t.entryPrice - t.slPrice);
        if (t.entryPrice > 0) a.slPcts.push((risk / t.entryPrice) * 100);
      }
      if (t.entryPrice && t.tpPrice && t.type) {
        const isLong = t.type === "LONG";
        const tpDist = isLong
          ? (t.tpPrice - t.entryPrice) / t.entryPrice
          : (t.entryPrice - t.tpPrice) / t.entryPrice;
        a.tpPcts.push(tpDist * 100);
      }
    }

    const rows = [...byCoin.values()]
      .map((a) => {
        const n = a.closed;
        const avgR = n > 0 ? a.sumR / n : 0;
        const winRate = n > 0 ? (a.wins / n) * 100 : 0;
        const pf =
          a.grossLossR > 0
            ? a.grossWinR / a.grossLossR
            : a.grossWinR > 0
              ? Infinity
              : null;
        return {
          coin: a.coin,
          closed: n,
          open: a.open,
          wins: a.wins,
          lossRate: n > 0 ? +(100 - winRate).toFixed(1) : 0,
          winRate: +winRate.toFixed(1),
          sumR: +a.sumR.toFixed(2),
          avgR: +avgR.toFixed(3),
          profitFactor: pf === null ? null : pf === Infinity ? Infinity : +pf.toFixed(2),
          grossWinR: +a.grossWinR.toFixed(2),
          grossLossR: +a.grossLossR.toFixed(2),
          longSumR: +a.longSumR.toFixed(2),
          shortSumR: +a.shortSumR.toFixed(2),
          avgMfeR: avg(a.mfe) === null ? null : +avg(a.mfe)!.toFixed(3),
          avgMaeR: avg(a.mae) === null ? null : +avg(a.mae)!.toFixed(3),
          avgSlPct: avg(a.slPcts) === null ? null : +avg(a.slPcts)!.toFixed(2),
          avgTpPct: avg(a.tpPcts) === null ? null : +avg(a.tpPcts)!.toFixed(2),
          firstEntry: new Date(a.firstEntry).toISOString().slice(0, 16),
          lastExit: a.lastExit
            ? new Date(a.lastExit).toISOString().slice(0, 16)
            : null,
        };
      })
      .sort((a, b) => a.sumR - b.sumR);

    const closed = trades.filter(
      (t) => t.status === "closed" && typeof t.realizedR === "number",
    );
    const sumR = closed.reduce((s, t) => s + (t.realizedR as number), 0);

    return {
      config: cfg
        ? {
            /** What the PAPER gate ENFORCES. getConfig resolves the union of
             *  the two stored rows at read time, so this is deliberately NOT
             *  the stored paper row — that would under-report the gate. */
            blocklist: blocklistUnion(paperList, liveList),
            /** The raw stored paper row (what a panel save writes back). */
            paperBlocklist: paperList,
            /** The raw stored live row — the one that was divergent. */
            liveBlocklist: liveList,
            /** Pairs blocked by exactly one book. Non-empty = the paper book is
             *  trading (or refusing) pairs the live book does not, and no
             *  measurement taken here transfers. */
            blocklistDivergence,
            fundingWeight: (cfg as any).fundingWeight ?? null,
            updatedAt: (cfg as any).updatedAt ?? null,
          }
        : null,
      totals: {
        all: trades.length,
        open: trades.filter((t) => t.status === "open").length,
        closed: closed.length,
        sumR: +sumR.toFixed(2),
        avgR: closed.length ? +(sumR / closed.length).toFixed(3) : 0,
      },
      coins: rows,
    };
  },
});
