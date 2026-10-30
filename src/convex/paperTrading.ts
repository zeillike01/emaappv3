/**
 * Paper trading on LIVE MEXC futures data.
 *
 * One active simulated book (no orders ever placed):
 *   - layer2 book: EMA momentum + order flow (layer2-v1)
 * Shared: trade lifecycle mutations, kline fetches, enrichment logging.
 *
 * The former main book (VWAP pullback v2), the Fibonacci book (fib-v1, incl.
 * its fibLevel context tag) and the live MEXC engine were removed 2026-09;
 * book="main" / "fibonacci" / liveAccount / liveTrades data was purged.
 */
import { v } from "convex/values";
import {
  action,
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { requireOperator } from "./users";
import type { Kline } from "../lib/types";
import { PAIR_CONFIGS } from "../lib/pair-config";
import { latestTradeTimeByCoin, bookSeedBalance } from "../lib/trade-utils";
// Session-window carry (2026-10-21): the P&L of rows that aged out of the
// 14-day measurement window. See src/lib/session-breaker.ts.
import {
  emptySessionWindowCarry,
  statsWithCarry,
  type SessionWindowCarry,
} from "../lib/session-breaker";
import { duplicateRejection } from "../lib/strategy-utils";
// Shared pure analytics (excursion profile etc.) so paper and live compute the
// identical number from identical bars — see src/lib/trade-analytics.ts.
import { excursionR } from "../lib/trade-analytics";
import { fundingRateAtEntry } from "../lib/mexc/mexcFetchers";
// MEXC reads from this default-runtime file go through the Node relay: the WAF
// 403s direct fetches here (see marketRelay.ts). fundingRateAtEntry stays a
// local pure import — it is bar arithmetic, not I/O.
import {
  relayDepth,
  relayFundingHistory,
  relayKlines,
  relayTickerPrice,
  relayTickerRaw,
} from "./marketFetch";
// Book identity lives in ONE place — see src/lib/books.ts for why a duplicated
// literal is a silent-failure hazard rather than a style preference.
import {
  A_PLUS_BOOK,
  LAYER2_BOOK,
  STATS_BOOKS,
} from "../lib/books";
import {
  captureRatio,
  closeFeesUsd,
  fundingCostUsd as fundingCostFor,
  holdProfile,
  snapshotExcursion,
} from "../lib/exit-telemetry";

// Real MEXC futures fees (standard tier):
//   maker 0.02% (TP limit exits) · taker 0.06% (market entry + SL trigger exits)
// Worst-case round trip: 0.12% of notional · TP round trip: 0.08%
const MEXC_MAKER_FEE_PCT = 0.02;
const MEXC_TAKER_FEE_PCT = 0.06;
const MAX_MARGIN_FRACTION = 0.85; // never commit more than 85% of balance as margin
const START_BALANCE = 150;

// ── Simulated frictions (PAPER BOT ONLY — live fills carry the real costs) ──
const DEFAULT_SLIPPAGE_BPS = 3; // 0.03% — typical MEXC perp fill at these sizes
const SLIPPAGE_BPS_OVERRIDES: Record<string, number> = {
  PUMPFUN: 8, // thin book
  PEPE: 50, // micro-cap, wide spread
  FARTCOIN: 80, // micro-cap, very thin book
  NEAR: 30, // mid-cap, moderate spread
  INJ: 15, // mid-cap
  ARB: 10, // mid-cap
  ADA: 8, // large-cap
  SOL: 5, // large-cap, tightest spread
  OP: 10, // large-cap
  DOT: 10, // large-cap
};
const EXIT_SLIP_EXTRA_BPS = 2; // stops can gap through in fast moves
const FUNDING_COST_PER_8H = 0.0001;

function slipBps(coin: string): number {
  return SLIPPAGE_BPS_OVERRIDES[coin] ?? DEFAULT_SLIPPAGE_BPS;
}

/** Adverse entry fill for a taker market order */
function applyEntrySlip(
  price: number,
  type: "LONG" | "SHORT",
  coin: string,
): number {
  const s = slipBps(coin) / 10_000;
  return type === "LONG" ? price * (1 + s) : price * (1 - s);
}

// ── MEXC live data helpers (public, key-free) ─────────────────

/** The only context the relay helpers need (they call `runAction`). */
type PaperActionCtx = Pick<ActionCtx, "runAction">;

/**
 * Live MEXC futures klines (oldest→newest), read through the Node relay.
 *
 * This file is default-runtime, where MEXC's WAF answers every direct fetch
 * with 403 HTML (see marketRelay.ts) — so the paging loop that used to live
 * here now lives in the relay's Node action, with the identical semantics
 * (999 bars per page, one full candle back, oldest→newest, last `bars` kept).
 */
async function fetchMexcKlines(
  ctx: PaperActionCtx,
  coin: string,
  interval: string,
  bars: number,
): Promise<Kline[]> {
  return relayKlines(ctx, coin, interval, bars);
}

// ── Trade enrichment: regime/session context for live-data tuning ──

/** Trading session from UTC hour (PHT = UTC+8). */
function sessionOf(ms: number): string {
  const h = new Date(ms).getUTCHours();
  if (h < 7) return "asia";
  if (h < 13) return "london";
  if (h < 17) return "ldn-ny";
  if (h < 22) return "ny";
  return "late";
}

/** ATR(14) as a % of the latest close — volatility at signal time. */
function atrPct(k15: Kline[]): number | undefined {
  if (k15.length < 15) return undefined;
  let sum = 0;
  for (let i = k15.length - 14; i < k15.length; i++) {
    sum += Math.max(
      k15[i].high - k15[i].low,
      Math.abs(k15[i].high - k15[i - 1].close),
      Math.abs(k15[i].low - k15[i - 1].close),
    );
  }
  const atr = sum / 14;
  const last = k15[k15.length - 1].close;
  return last > 0 ? (atr / last) * 100 : undefined;
}

/** 4H EMA50 slope regime: trend-up / trend-down / chop over the last 24h. */
function classifyRegime4h(k4h: Kline[]): string {
  if (k4h.length < 60) return "unknown";
  const period = 50;
  const k = 2 / (period + 1);
  let ema = k4h[0].close;
  const emas: number[] = [];
  for (let i = 1; i < k4h.length; i++) {
    ema = k4h[i].close * k + ema * (1 - k);
    emas.push(ema);
  }
  const now = emas[emas.length - 1];
  const ago = emas[emas.length - 7]; // 6 × 4h bars = 24h ago
  const slopePct = ((now - ago) / ago) * 100;
  if (slopePct > 0.3) return "trend-up";
  if (slopePct < -0.3) return "trend-down";
  return "chop";
}

/**
 * Build the enrichment record for a new trade. Best-effort: any failure
 * returns undefined fields — enrichment must NEVER block an entry.
 *
 * `oiCtx` (optional, 2026-09-09): the pair's OI context from the Layer-1
 * tick series (marketData.getOiContext) — { oiNow, oi4hAgo, deltaPct }.
 * Passed in by the caller because this helper has no db access. When absent
 * or the series doesn't cover the pair yet, `openInterestDelta` stays
 * undefined and `oiAtEntry` falls back to the entry-ticker holdVol snapshot.
 * (2026-10-06: the caller now actually PASSES oiCtx — it was fetched every
 * entry and then dropped, which is why openInterestDelta was undefined on
 * every paper row while the live book recorded it.)
 *
 * `volRatioAtEntry` (2026-10-06): the SIGNAL bar's volume against the 20-bar
 * SMA before it, anchored at `signalTime`. The column was declared — and the
 * one-time backfill could fill it — but nothing wrote it at entry, so every
 * paper row carried no volume reading at all. Definition matches
 * liveEngine.backfillLiveCloseAnalytics, so the two books' tags compare.
 *
 * `pairVsBtc1h` (2026-10-06): the pair's 1h return now comes from the SAME
 * 1h fetch that already serves htfTrend1h, instead of a third per-entry MEXC
 * request that frequently failed and left this field undefined.
 */
export async function buildTradeEnrichment(
  ctx: PaperActionCtx,
  coin: string,
  k15: Kline[],
  signalTime: number,
  oiCtx?: {
    oiNow: number | null;
    oi4hAgo: number | null;
    deltaPct: number | null;
  } | null,
): Promise<Record<string, any>> {
  const session = sessionOf(signalTime);
  const volPct = atrPct(k15);

  // I/O dedupe (2026-09): this used to fetch the coin's 4h klines TWICE
  // (once for regime classification, again for the HTF-EMA tier) and hit the
  // contract/ticker endpoint TWICE (once for spread, once for funding/OI) —
  // ~3 wasted MEXC calls per entry. One fetch per endpoint now feeds every
  // consumer and the whole tier group runs in parallel; the enrichment
  // fields stored on the trade are unchanged. Shared by the paper engine
  // (strategyEngine) — the live engine's entries mirror the same inputs.
  let regime: string | undefined;
  let spreadPct: number | undefined;
  let btcTrendAtEntry: string | undefined;
  let btcChange1h: number | undefined;
  let htfEma20_4h: number | undefined;
  let htfEma50_4h: number | undefined;
  let htfTrend1h: string | undefined;
  let htfVol4h: number | undefined;
  let htfVol4hAvg: number | undefined;
  let distToSwingSr: number | undefined;
  let fundingRate: number | undefined;
  let openInterestDelta: number | undefined;
  let oiAtEntry: number | undefined;
  let bidAskImbalance: number | undefined;
  let pairVsBtc1h: number | undefined;
  let volRatioAtEntry: number | undefined;

  // BTC 1h history (single 720-bar fetch) → percentile-EMA20 regime + 1h
  // change; its last two closes also serve as the BTC leg of pair-vs-BTC
  // relative strength, so no second BTC request is needed.
  let btcCloses1h: number[] = [];
  let pairRet1h: number | undefined;

  await Promise.all([
    // Tier 2 + regime: ONE 4h fetch feeds classifyRegime4h AND the HTF-EMA
    // HTF block (ema20/50 levels, volume, distance to swing S/R).
    fetchMexcKlines(ctx, coin, "4h", 80)
      .then((k4h) => {
        regime = classifyRegime4h(k4h);
        if (k4h.length >= 50) {
          const closes4h = k4h.map((k) => k.close);
          let ema20 = closes4h[0];
          const k20 = 2 / 21;
          for (let i = 1; i < closes4h.length; i++)
            ema20 = closes4h[i] * k20 + ema20 * (1 - k20);
          htfEma20_4h = +ema20.toFixed(8);
          let ema50 = closes4h[0];
          const k50 = 2 / 51;
          for (let i = 1; i < closes4h.length; i++)
            ema50 = closes4h[i] * k50 + ema50 * (1 - k50);
          htfEma50_4h = +ema50.toFixed(8);
          const vols4h = k4h.map((k) => k.volume);
          htfVol4h = vols4h[vols4h.length - 1];
          htfVol4hAvg =
            vols4h.slice(-20).reduce((a, b) => a + b, 0) /
            Math.min(20, vols4h.length);
          const recent = k4h.slice(-20);
          const swingHigh = Math.max(...recent.map((k) => k.high));
          const swingLow = Math.min(...recent.map((k) => k.low));
          const currentPrice = closes4h[closes4h.length - 1];
          distToSwingSr = +Math.min(
            (Math.abs(currentPrice - swingHigh) / currentPrice) * 100,
            (Math.abs(currentPrice - swingLow) / currentPrice) * 100,
          ).toFixed(4);
        }
      })
      .catch(() => {}),
    // Tier 3 microstructure + spread: ONE ticker call → bid/ask spread,
    // funding rate and open interest (previously two identical calls).
    relayTickerRaw(ctx, coin)
      .then((td) => {
        const bid = td.bid1,
          ask = td.ask1;
        if (bid && ask) {
          const mid = (bid + ask) / 2;
          if (mid > 0) spreadPct = ((ask - bid) / mid) * 100;
        }
        fundingRate =
          td.fundingRate != null
            ? +Number(td.fundingRate).toFixed(6)
            : undefined;
        // 2026-09-09 FIX: MEXC's contract ticker has NO `openInterest` field
        // (checked live — that's why openInterestDelta logged 0/303 trades).
        // The OI snapshot lives in `holdVol` (contracts). Stored as oiAtEntry
        // (raw snapshot); the true % DELTA comes from the caller's oiCtx —
        // the Layer-1 tick series — not from this point-in-time snapshot.
        if (td.holdVol != null) oiAtEntry = +Number(td.holdVol).toFixed(2);
      })
      .catch(() => {}),
    // 1h coin klines → htfTrend1h (EMA20 vs prior close) AND the pair leg of
    // pair-vs-BTC (its last two closes — exactly what the separate 2-bar
    // request used to return, so that third per-entry MEXC call is gone).
    fetchMexcKlines(ctx, coin, "1h", 60)
      .then((k1h) => {
        if (k1h.length >= 2) {
          pairRet1h =
            (k1h[k1h.length - 1].close - k1h[k1h.length - 2].close) /
            k1h[k1h.length - 2].close;
        }
        if (k1h.length >= 20) {
          const c1h = k1h.map((k) => k.close);
          let ema1h = c1h[0];
          const k1 = 2 / 21;
          for (let i = 1; i < c1h.length; i++)
            ema1h = c1h[i] * k1 + ema1h * (1 - k1);
          htfTrend1h =
            ema1h > (c1h[c1h.length - 2] ?? ema1h)
              ? "up"
              : ema1h < (c1h[c1h.length - 2] ?? ema1h)
                ? "down"
                : "flat";
        }
      })
      .catch(() => {}),
    // BTC trend: 1h klines → percentile-based EMA20 slope classification
    fetchMexcKlines(ctx, "BTC", "1h", 720)
      .then((k1h) => {
        if (k1h.length < 20) return;
        const closes = k1h.map((k) => k.close);
        btcCloses1h = closes;
        const k_factor = 2 / 21;
        // Compute EMA and per-bar slopes
        let ema = closes[0];
        const slopes: number[] = [];
        for (let i = 1; i < closes.length; i++) {
          const prevEma = ema;
          ema = closes[i] * k_factor + ema * (1 - k_factor);
          if (prevEma > 0) slopes.push((ema - prevEma) / prevEma);
        }
        if (slopes.length >= 5) {
          const sorted = [...slopes].sort((a, b) => a - b);
          const p33 = sorted[Math.floor(sorted.length * 0.33)];
          const p67 = sorted[Math.floor(sorted.length * 0.67)];
          const currentSlope = slopes[slopes.length - 1];
          btcTrendAtEntry =
            currentSlope > p67 ? "up" : currentSlope < p33 ? "down" : "chop";
          (globalThis as any).__btcSlopeRaw = currentSlope;
        }
        if (closes.length >= 2)
          btcChange1h =
            ((closes[closes.length - 1] - closes[closes.length - 2]) /
              closes[closes.length - 2]) *
            100;
      })
      .catch(() => {}),
    // 20-level order book → bid/ask imbalance
    relayDepth(ctx, coin)
      .then((book) => {
        const bidVol = book.bids.reduce((s, l) => s + l.size, 0);
        const askVol = book.asks.reduce((s, l) => s + l.size, 0);
        if (bidVol + askVol > 0)
          bidAskImbalance = +(bidVol / (bidVol + askVol)).toFixed(4);
      })
      .catch(() => {}),
  ]);

  // BTC leg of pair-vs-BTC from the same history fetched above.
  if (pairRet1h !== undefined && btcCloses1h.length >= 2) {
    const btcRet =
      (btcCloses1h[btcCloses1h.length - 1] -
        btcCloses1h[btcCloses1h.length - 2]) /
      btcCloses1h[btcCloses1h.length - 2];
    pairVsBtc1h = +((pairRet1h - btcRet) * 100).toFixed(4);
  }

  // OI (2026-09-09): openInterestDelta = true % change vs the Layer-1 tick
  // ~4h ago (caller-supplied from the tick OI series). oiAtEntry (2026-09-10
  // audit): the entry-ticker holdVol is the FRESHEST read (taken at the entry
  // moment; the newest tick can be ≤5 min stale), so it wins — the tick
  // series value is only a fallback when the ticker snapshot is missing.
  if (oiCtx?.deltaPct != null) openInterestDelta = oiCtx.deltaPct;
  if (oiAtEntry === undefined && oiCtx?.oiNow != null) oiAtEntry = oiCtx.oiNow;

  // volRatioAtEntry (2026-10-06): the signal bar's volume against the 20-bar
  // SMA BEFORE it — the paper twin of liveEngine.backfillLiveCloseAnalytics,
  // which is the only place this was ever computed. Anchored at the signal
  // bar's close, so an overlapping tick or a late fill cannot move it. `k15`
  // is the same 400-bar array processPair just scored: no extra I/O.
  if (k15.length >= 21) {
    const closed = k15.filter((k) => k.closeTime <= signalTime);
    if (closed.length >= 21) {
      let volSum = 0;
      for (let i = closed.length - 21; i < closed.length - 1; i++)
        volSum += closed[i].volume;
      const volSma = volSum / 20;
      if (volSma > 0)
        volRatioAtEntry = +(closed[closed.length - 1].volume / volSma).toFixed(
          3,
        );
    }
  }

  return {
    session,
    regime,
    volPct,
    spreadPct,
    btcTrendAtEntry,
    btcChange1h,
    atrPctAtEntry: volPct,
    htfEma20_4h,
    htfEma50_4h,
    htfTrend1h,
    htfVol4h,
    htfVol4hAvg,
    distToSwingSr,
    fundingRate,
    openInterestDelta,
    oiAtEntry,
    bidAskImbalance,
    pairVsBtc1h,
    volRatioAtEntry,
  };
}
// ── Account management ────────────────────────────────────────

/** Layer 2 book: trades entered by the EMA momentum strategy engine. */
export const getLayer2Trades = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db
      .query("paperTrades")
      .withIndex("by_book", (q) => q.eq("book", "layer2"))
      .collect();
    return all.sort((a, b) => b.entryTime - a.entryTime);
  },
});

/**
 * Open trades for EVERY book with its own stats — the exit path's read.
 *
 * The exit resolver is deliberately book-agnostic: it breaches against the
 * trade's own slPrice/tpPrice/r-lock and hands the result to the shared close
 * path, which credits the trade's OWN book. Returning every book's open rows
 * is therefore all a second book needs in order to be exited under exactly the
 * same rules as layer2 — no per-book exit logic to drift.
 *
 * WARNING (2026-09-26): the NAME still says layer2, but the RESULT is every
 * stats book. The exit resolver and the r-lock tick both need that; the UI and
 * getLayer2OpenPnl do not, and must scope themselves by book (they do — see
 * the filter in getLayer2OpenPnl and Layer2TradesView's getOpenBookTrades).
 * Renaming it is not free: strategyEngine.resolveLayer2Exits and rLockExit both
 * call it by this name.
 */
export const getOpenLayer2Trades = query({
  args: {},
  handler: async (ctx) => {
    const out: any[] = [];
    for (const book of [LAYER2_BOOK, A_PLUS_BOOK]) {
      out.push(
        ...(await ctx.db
          .query("paperTrades")
          .withIndex("by_book_status", (q) =>
            q.eq("book", book).eq("status", "open"),
          )
          .collect()),
      );
    }
    return out;
  },
});

/** ANY book's OPEN trades (used by the exit tick — near-zero I/O). */
export const getOpenBookTrades = query({
  args: { book: v.string() },
  handler: async (ctx, args) =>
    await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status", (q) =>
        q.eq("book", args.book).eq("status", "open"),
      )
      .collect(),
});

/**
 * Layer 2 book: the N most recent CLOSED trades (newest first). Index-scoped
 * desc read used by the circuit breaker (strategyTick + getBreakerState) —
 * O(n) with n = window size, never the whole book.
 */
export const getLayer2RecentClosed = query({
  args: { n: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const n = Math.min(Math.max(args.n ?? 20, 1), 100);
    // Audit fix 2026-09-11: order by EXIT time. "The last N closes" means the
    // last N things that closed — the old entryTime ordering mixed a
    // long-held loser that closed minutes ago with trades entered days later.
    return await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status_exitTime", (q) =>
        q.eq("book", "layer2").eq("status", "closed"),
      )
      .order("desc")
      .take(n);
  },
});

/**
 * EVERY layer2 trade closed since `since` (ms epoch), by exit time ascending.
 *
 * Audit fix 2026-09-11: the circuit breaker's daily-loss cap used to be summed
 * from the same truncated last-20-closes read as its win-rate window, so on a
 * busy day (>20 closes — the Sep 7-8 bleed was 63 closes in two days) the
 * day's real loss could never be seen and the cap never fired. This query
 * ranges the exit-time index so the caller always sums the COMPLETE day.
 */
export const getLayer2ClosedSince = query({
  args: { since: v.number() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status_exitTime", (q) =>
        q
          .eq("book", "layer2")
          .eq("status", "closed")
          .gte("exitTime", args.since),
      )
      .collect();
  },
});

// ── Layer 2 closed-book summary (I/O optimization, 2026-09) ──
// The trades tab's header stats (Balance / Closed / Win Rate) used to be
// computed from a live subscription to the WHOLE layer2 book — a 239+ row
// collect re-run on every layer2 write while the dashboard was open. Now ONE
// `bookStats` doc drives the header, and the close path maintains it
// INCREMENTALLY (see foldLayer2Stats): each close adds its own P&L to the
// running counters instead of re-scanning the entire closed book — an O(n)
// read on every close, where n = lifetime closed rows, growing weekly. The
// full recompute below survives only for one-time seeding when the doc is
// missing (ensureLayer2Stats / first close / after manual doc deletion).

/** Full recompute of the layer2 bookStats doc from the closed book (O(n) —
 *  used ONLY to (re)seed a missing doc, never on the per-close path). */
/**
 * Full re-scan of ONE book's closed rows into its `bookStats` doc.
 *
 * Generalized from `recomputeLayer2Stats` (2026-09-12) so every book keeps its
 * own summary doc: a second book would have the same per-book stats
 * contract as layer2, and closeTrade's incremental fold needs a per-book
 * fallback. Behaviour for layer2 is unchanged — same query, same payload with
 * `book` now coming from the argument instead of the literal.
 */
async function recomputeBookStats(ctx: MutationCtx, book: string) {
  const closed = await ctx.db
    .query("paperTrades")
    .withIndex("by_book_status", (q) =>
      q.eq("book", book).eq("status", "closed"),
    )
    .collect();
  let wins = 0;
  let realizedPnl = 0;
  let totalFeesUsd = 0;
  for (const t of closed) {
    const pnl = t.pnlUsd ?? 0;
    if (pnl > 0) wins++;
    realizedPnl += pnl;
    totalFeesUsd += t.totalFeesUsd ?? 0;
  }
  // SESSION WINDOW CARRY (2026-10-21): the ledger only holds the CURRENT
  // measurement window — rows that aged out were pruned
  // (strategyEngine.pruneSessionWindow). Their result lives on the book's
  // account as a carry, so counters rebuilt from what is left stay ALL-TIME.
  const payload = {
    book,
    ...statsWithCarry(
      { closedCount: closed.length, wins, realizedPnl, totalFeesUsd },
      await readSessionWindowCarry(ctx, book),
    ),
    updatedAt: Date.now(),
  };
  const doc = await ctx.db
    .query("bookStats")
    .withIndex("by_book", (q) => q.eq("book", book))
    .first();
  if (doc) await ctx.db.patch(doc._id, payload);
  else await ctx.db.insert("bookStats", payload);
}

/**
 * The pruned-window carry of a book (zero for books that are never pruned).
 *
 * The carry lives on the book's `paperAccount` row (see the schema note) and
 * holds the realized result of the closes that aged out of the measurement
 * window. Read by every path that rebuilds a lifetime number from the ledger.
 */
export async function readSessionWindowCarry(
  ctx: { db: any },
  book: string,
): Promise<SessionWindowCarry> {
  const acc: any = await ctx.db
    .query("paperAccount")
    .withIndex("by_name", (q: any) => q.eq("name", book))
    .first();
  if (!acc) return emptySessionWindowCarry();
  return {
    trades: acc.archivedTrades ?? 0,
    wins: acc.archivedWins ?? 0,
    realizedPnlUsd: acc.archivedRealizedPnlUsd ?? 0,
    totalFeesUsd: acc.archivedFeesUsd ?? 0,
    realizedR: acc.archivedR ?? 0,
    oldestExitTime: null,
    newestExitTime: acc.archivedUntil ?? null,
  };
}

/**
 * Fold a BATCH of closed rows into (or out of) the running counters in ONE
 * patch.
 *
 * `foldBookStats` is per-row, which is right for the close path (one row) and
 * wrong for a prune (hundreds of rows = hundreds of writes against the same
 * doc). direction = -1 when the rows are being REMOVED from the ledger, so the
 * lifetime totals stay exactly where they were.
 */
export async function foldBookStatsBatch(
  ctx: MutationCtx,
  book: string,
  rows: Array<{ pnlUsd?: number | null; totalFeesUsd?: number | null }>,
  direction: 1 | -1,
): Promise<void> {
  if (rows.length === 0) return;
  const doc = await ctx.db
    .query("bookStats")
    .withIndex("by_book", (q) => q.eq("book", book))
    .first();
  if (!doc) {
    // The doc is missing: rebuild it from the ledger. The rows being folded
    // are still IN the ledger at this point, so the rebuild already counts
    // them and the fold below removes them.
    await recomputeBookStats(ctx, book);
    return;
  }
  let wins = 0;
  let realizedPnl = 0;
  let totalFeesUsd = 0;
  for (const row of rows) {
    const pnl = row.pnlUsd ?? 0;
    if (pnl > 0) wins++;
    realizedPnl += pnl;
    totalFeesUsd += row.totalFeesUsd ?? 0;
  }
  await ctx.db.patch(doc._id, {
    closedCount: Math.max(0, (doc.closedCount ?? 0) + rows.length * direction),
    wins: Math.max(0, (doc.wins ?? 0) + wins * direction),
    realizedPnl: (doc.realizedPnl ?? 0) + realizedPnl * direction,
    totalFeesUsd: (doc.totalFeesUsd ?? 0) + totalFeesUsd * direction,
    updatedAt: Date.now(),
  });
}

/**
 * Incrementally fold ONE layer2 trade into the bookStats running counters —
 * O(1), the per-close path (replaces the O(n) full re-scan). direction = +1
 * when the trade was just closed (closeTrade), -1 when a closed row is being
 * deleted (deleteTrade). Self-heals: if the doc is missing (should only
 * happen on the very first close or after manual deletion) it falls back to
 * the full recompute so the counters can never silently drift.
 */
async function foldBookStats(
  ctx: MutationCtx,
  book: string,
  row: { pnlUsd?: number; totalFeesUsd?: number },
  direction: 1 | -1,
) {
  const doc = await ctx.db
    .query("bookStats")
    .withIndex("by_book", (q) => q.eq("book", book))
    .first();
  if (!doc) {
    await recomputeBookStats(ctx, book);
    return;
  }
  const pnl = row.pnlUsd ?? 0;
  await ctx.db.patch(doc._id, {
    closedCount: Math.max(0, (doc.closedCount ?? 0) + direction),
    wins: Math.max(0, (doc.wins ?? 0) + (pnl > 0 ? 1 : 0) * direction),
    realizedPnl: (doc.realizedPnl ?? 0) + pnl * direction,
    totalFeesUsd: (doc.totalFeesUsd ?? 0) + (row.totalFeesUsd ?? 0) * direction,
    updatedAt: Date.now(),
  });
}

/** Layer 2 header stats (Balance / Closed / Win Rate) — one doc, not the book. */
export const getLayer2Stats = query({
  args: {},
  handler: async (ctx) =>
    await ctx.db
      .query("bookStats")
      .withIndex("by_book", (q) => q.eq("book", "layer2"))
      .first(),
});

/** Seed/refresh the layer2 stats doc (idempotent). The dashboard fires this
 *  once per open if the doc is missing; the close path keeps it fresh after. */
export const ensureLayer2Stats = mutation({
  args: {},
  handler: async (ctx) => {
    await recomputeBookStats(ctx, "layer2");
    return true;
  },
});

/**
 * Rebuild the cooldowns document from trade history.
 *
 * The document is DERIVED state — one entry per symbol the engine has touched,
 * stamped by noteCooldown on entry and close — so the safe way to change it is
 * to re-derive, never to filter it. It carries no information that history does
 * not already hold: cooldownSeedData takes the max of `exitTime ?? entryTime`
 * per coin over open + 7-day-closed trades, which is exactly what the
 * incremental stamps would have produced.
 *
 * WHY THIS EXISTS (2026-09-26): a prune built on `PAIR_CONFIGS` was run against
 * this document and was WRONG — the live scan universe is the pair list in the
 * newest layer1Ticks doc (31 pairs), which is not PAIR_CONFIGS (32, a different
 * set). It dropped the entry for PUMP, whose last trade was 30 minutes old and
 * whose 1h cooldown was therefore still active, letting the pair re-enter early.
 * Re-seeding restores it from the trade record. Prefer this over any future
 * "remove stale keys" pass: a wrong removal is a silent behaviour change, while
 * a re-seed can only ever reproduce what the trades already say.
 */
export const reseedCooldowns = mutation({
  args: {},
  handler: async (ctx) => {
    const doc = await ctx.db.query("cooldowns").first();
    const before = doc ? Object.keys(doc.data).length : 0;
    if (doc) await ctx.db.delete(doc._id);
    const data = await ensureCooldownData(ctx);
    return {
      before,
      after: Object.keys(data).length,
      pairs: Object.keys(data).sort(),
    };
  },
});

/**
 * Closed-trades list, newest first, keyset-paginated.
 *
 * Returns one page of CLOSED layer2 trades via Convex's built-in cursor
 * pagination over the (book, status, entryTime) index (desc). Cursors are
 * opaque and stay valid as newer trades land on page 1, so "Next page" never
 * skips or duplicates rows even when multiple trades share the same bar time.
 */
export const getLayer2ClosedPage = query({
  // `cursor` must ACCEPT null, not just omit it: older cached client bundles
  // send `cursor: null` on the first page, and v.optional(v.string()) rejects
  // null with ArgumentValidationError before the handler runs (the handler
  // below already treats null as "start at the beginning"). Same shape as
  // Convex's own paginationOptsValidator.
  args: {
    cursor: v.union(v.string(), v.null()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = Math.min(Math.max(args.limit ?? 20, 1), 100);
    const base = ctx.db
      .query("paperTrades")
      .withIndex("by_book_status_entryTime", (q) =>
        q.eq("book", "layer2").eq("status", "closed"),
      );
    const result = await base
      .order("desc")
      .paginate({ numItems: limit, cursor: args.cursor ?? null });
    return {
      page: result.page,
      continueCursor: result.continueCursor,
      isDone: result.isDone,
    };
  },
});

// ── Cooldown tracker — I/O optimization (2026-09) ──
// Replaces the getLayer2Cooldowns history re-scan: all 20 symbols' last
// signal times live in ONE `cooldowns` document. Read cost per strategy tick
// is now one doc read, flat forever — it no longer scales with trade count.
//
// Trade-off (deliberate, per the optimization brief): every pair's entry/exit
// writes to this same shared document, so Convex serializes conflicting writes
// via optimistic concurrency — simultaneous writes from different pairs cause
// one to retry. At current trade volume this is negligible. If trade frequency
// scales up significantly, revisit with a per-symbol indexed table instead
// (better for high write concurrency, worse for this cron's "read all 20 at
// once" access pattern).

/**
 * Internal: build the cooldown seed map from layer2 history rows.
 */
function cooldownSeedData(
  trades: Array<{
    coin: string;
    type: string;
    exitTime?: number;
    entryTime?: number;
  }>,
): Record<string, { lastSignalTime: number; lastSide: string }> {
  const data: Record<string, { lastSignalTime: number; lastSide: string }> = {};
  for (const t of trades) {
    const time = t.exitTime ?? t.entryTime ?? 0;
    const prev = data[t.coin]?.lastSignalTime ?? 0;
    if (time > prev) data[t.coin] = { lastSignalTime: time, lastSide: t.type };
  }
  return data;
}

/**
 * Internal: fetch the single cooldowns document, creating + seeding it if
 * missing (mutation context only — queries cannot write). Seeding reads the
 * layer2 book's recent history via indexes, never a full-table scan.
 */
async function ensureCooldownData(
  ctx: MutationCtx,
): Promise<Record<string, { lastSignalTime: number; lastSide: string }>> {
  const doc = await ctx.db.query("cooldowns").first();
  if (doc) return doc.data;
  const open = await ctx.db
    .query("paperTrades")
    .withIndex("by_book_status", (q) =>
      q.eq("book", "layer2").eq("status", "open"),
    )
    .collect();
  const closed = await ctx.db
    .query("paperTrades")
    .withIndex("by_book_entryTime", (q) =>
      q.eq("book", "layer2").gte("entryTime", Date.now() - 7 * 24 * 3_600_000),
    )
    .collect();
  const data = cooldownSeedData([...open, ...closed]);
  await ctx.db.insert("cooldowns", { data });
  return data;
}

/**
 * Internal: stamp one symbol's last signal into the cooldowns document.
 * Self-heals (creates + seeds) if the doc is missing. Reads the doc once and
 * patches the merged map — Convex records cannot be patched per-field.
 */
async function noteCooldown(
  ctx: MutationCtx,
  symbol: string,
  time: number,
  side: string,
) {
  const doc = await ctx.db.query("cooldowns").first();
  if (!doc) {
    await ensureCooldownData(ctx);
    const fresh = await ctx.db.query("cooldowns").first();
    if (!fresh) return;
    await ctx.db.patch(fresh._id, {
      data: {
        ...fresh.data,
        [symbol]: {
          lastSignalTime: Math.max(
            time,
            fresh.data[symbol]?.lastSignalTime ?? 0,
          ),
          lastSide: side,
        },
      },
    });
    return;
  }
  await ctx.db.patch(doc._id, {
    data: {
      ...doc.data,
      [symbol]: {
        lastSignalTime: Math.max(time, doc.data[symbol]?.lastSignalTime ?? 0),
        lastSide: side,
      },
    },
  });
}

/**
 * Layer 2 cooldowns for the strategy tick — ONE document read, flat forever.
 * Shape matches the old getLayer2Cooldowns rows: { coin, time }.
 * Read-only: if the doc has not been seeded yet this returns empty; the tick
 * seeds it via ensureLayer2Account before consulting cooldowns.
 */
export const getLayer2Cooldowns = query({
  args: {},
  handler: async (ctx) => {
    const doc = await ctx.db.query("cooldowns").first();
    if (!doc) return [];
    return Object.entries(doc.data).map(([coin, v]) => ({
      coin,
      time: v.lastSignalTime,
    }));
  },
});

/**
 * Open-coin lock for the layer2 book (2026-09-09, I/O fix): coins with an
 * OPEN position, so strategyTick can skip their signal computation + MEXC
 * fetches. insertTrade's openDup would reject those entries anyway — but
 * only AFTER the klines + price fetch + enrichment (~3 MEXC calls per open
 * coin per 15m tick, 10-26 open positions = 30-80 calls). One DB read per
 * tick, mirrors live's openCoinSet skip.
 */
export const getLayer2OpenCoins = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status_coin", (q) =>
        q.eq("book", "layer2").eq("status", "open"),
      )
      .collect();
    return rows.map((r) => r.coin);
  },
});

/**
 * Layer 2 book: the OPEN positions' factor-exposure inputs (side + entry BTC
 * beta). Feeds the factor-exposure cap (2026-09-23) — the signed sum of
 * per-position beta across the open book is the quantity that cap bounds,
 * which a position COUNT cannot express. `btcBetaAtEntry` is absent while the
 * cap is off; the pure helper charges a conservative 1.0 for a missing beta.
 */
export const getLayer2OpenRisk = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status_coin", (q) =>
        q.eq("book", "layer2").eq("status", "open"),
      )
      .collect();
    return rows.map((r) => ({
      coin: r.coin,
      side: r.type,
      beta: r.btcBetaAtEntry,
    }));
  },
});

/**
 * Internal: find or create the Layer 2 book account.
 *
 * The layer2 account was missing entirely — layer2 closes used to call
 * closeTrade, find no account named "layer2", and vanish without crediting
 * or debiting any balance (position sizing read the static main balance).
 * On first creation the balance is seeded with the book's own accumulated
 * closed P&L so the account reflects history, mirroring reconcileBalances.
 */
async function ensureBookAccountRecord(ctx: MutationCtx, book: string) {
  const existing = await ctx.db
    .query("paperAccount")
    .withIndex("by_name", (q) => q.eq("name", book))
    .first();
  if (existing) return existing;
  const closed = await ctx.db
    .query("paperTrades")
    .withIndex("by_book", (q) => q.eq("book", book))
    .collect();
  const id = await ctx.db.insert("paperAccount", {
    name: book,
    balance: bookSeedBalance(
      START_BALANCE,
      closed.filter((t) => t.status === "closed"),
    ),
    startBalance: START_BALANCE,
    pairs: Object.keys(PAIR_CONFIGS),
    enabled: true,
    strategyVersion: "layer2-v1",
    lastSignalTimes: {},
    totalScans: 0,
  });
  await ensureCooldownData(ctx);
  return await ctx.db.get(id);
}

/** Ensure the Layer 2 book's own paperAccount exists (created once, seeded with its closed P&L). */
export const ensureLayer2Account = mutation({
  args: {},
  handler: async (ctx) => ensureBookAccountRecord(ctx, LAYER2_BOOK),
});

/** The Layer 2 book's own account (balance = start + its own closed P&L). */
export const getLayer2Account = query({
  args: {},
  handler: async (ctx) =>
    ctx.db
      .query("paperAccount")
      .withIndex("by_name", (q) => q.eq("name", LAYER2_BOOK))
      .first(),
});

/** Refill the Layer 2 paper account (2026-09-09). Paper is the unfiltered
 *  data-gathering instrument, so a drawdown can burn the balance down to
 *  dust-sized positions; this tops the balance back up WITHOUT wiping the
 *  trade history (the data stays). Sets balance to `amount` (default
 *  START_BALANCE) and accumulates `deposits` so the UI can separate
 *  injected capital from real PnL. */
export const refillPaperBalance = mutation({
  args: { amount: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const acc = await ctx.db
      .query("paperAccount")
      .withIndex("by_name", (q) => q.eq("name", "layer2"))
      .first();
    if (!acc)
      return { ok: false, balance: null, added: 0, reason: "no account" };
    const target = args.amount && args.amount > 0 ? args.amount : START_BALANCE;
    const added = Math.max(0, target - acc.balance);
    await ctx.db.patch(acc._id, {
      balance: target,
      deposits: ((acc as any).deposits ?? 0) + added,
      lastRefillAt: Date.now(),
    });
    return { ok: true, balance: target, added };
  },
});

/** Restore the Layer 2 balance from its own ledger: START_BALANCE + sum of
 *  closed PnL. Used 2026-09-09 after an accidental Refill press trimmed the
 *  balance from $322.48 to $150 (the refill sets balance = target even when
 *  the account was ahead). Safe to re-run — it reconciles to the ledger
 *  rather than hard-coding a number, so it's a no-op once balanced. */
export const restoreLayer2Balance = mutation({
  args: {},
  handler: async (ctx) => {
    const acc = await ctx.db
      .query("paperAccount")
      .withIndex("by_name", (q) => q.eq("name", "layer2"))
      .first();
    if (!acc) return { ok: false, reason: "no layer2 account" };
    const closed = await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status", (q) =>
        q.eq("book", "layer2").eq("status", "closed"),
      )
      .collect();
    // SESSION WINDOW CARRY (2026-10-21): the ledger holds only the current
    // measurement window, so the carry of the rows that aged out is added
    // back — the balance this restores is the SAME balance the book has, not
    // a number that forgets everything older than 14 days.
    const carry = await readSessionWindowCarry(ctx, "layer2");
    const ledgerBalance =
      bookSeedBalance(
        START_BALANCE,
        closed.filter((t) => t.status === "closed"),
      ) + carry.realizedPnlUsd;
    const delta = ledgerBalance - acc.balance;
    if (Math.abs(delta) < 0.005) {
      return {
        ok: true,
        balance: acc.balance,
        delta: 0,
        reason: "already balanced",
      };
    }
    await ctx.db.patch(acc._id, { balance: ledgerBalance });
    return {
      ok: true,
      balance: ledgerBalance,
      delta,
      closedTrades: closed.length,
    };
  },
});

/** Mining export: ALL trades across all books, unfiltered. */
export const getAllTradesRaw = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("paperTrades").collect();
  },
});

/**
 * Live PnL for Layer 2 book open positions.
 */
export const getLayer2OpenPnl = action({
  args: {},

  handler: async (
    ctx,
  ): Promise<{
    positions: Array<{
      id: string;
      coin: string;
      type: string;
      entryPrice: number;
      currentPrice: number;
      pnlUsd: number;
      pnlPct: number;
      winning: boolean;
      progressPct: number;
      distToSlPct: number;
      distToTpPct: number;
    }>;
    totalUnrealized: number;
    asOf: number;
  }> => {
    // Open-only, index-scoped read: the old getLayer2Trades collect() re-read
    // all ~148 layer-2 docs (open + closed) on every 2-min UI poll — roughly
    // 5 MB/hour of Database I/O while the app tab is visible. Only open
    // trades are needed for unrealized PnL, and closed docs never change.
    // Scoped back to layer2 explicitly (2026-09-26): getOpenLayer2Trades now
    // returns every stats book so the exit resolver can close them all, but
    // this action is documented as the LAYER 2 book's unrealized PnL — without
    // this filter the A+ book's open positions would leak into layer2's total.
    const open = (
      (await ctx.runQuery(api.paperTrading.getOpenLayer2Trades)) as any[]
    ).filter((t: any) => t.book === LAYER2_BOOK);
    if (open.length === 0)
      return { positions: [], totalUnrealized: 0, asOf: Date.now() };

    const positions = await Promise.all(
      open.map(
        async (
          t: any,
        ): Promise<{
          id: string;
          coin: string;
          type: string;
          entryPrice: number;
          currentPrice: number;
          pnlUsd: number;
          pnlPct: number;
          winning: boolean;
          progressPct: number;
          distToSlPct: number;
          distToTpPct: number;
        }> => {
          try {
            const price = await relayTickerPrice(ctx, t.coin);
            if (!(price > 0)) throw new Error("no ticker price");
            const side = t.type === "LONG" ? 1 : -1;
            const notional = t.entryPrice * t.sizeCoin;
            const grossUsd = (price - t.entryPrice) * t.sizeCoin * side;
            const estFees = notional * ((MEXC_TAKER_FEE_PCT * 2) / 100);
            const pnlUsd = grossUsd - estFees;
            const marginUsd = notional / t.leverage;
            const distToSl = Math.abs((price - t.slPrice) / price) * 100;
            const distToTp = Math.abs((t.tpPrice - price) / price) * 100;
            return {
              id: t._id as string,
              coin: t.coin as string,
              type: t.type as string,
              entryPrice: t.entryPrice as number,
              currentPrice: price,
              pnlUsd,
              pnlPct: (pnlUsd / marginUsd) * 100,
              winning: pnlUsd > 0,
              progressPct: Math.max(
                0,
                Math.min(
                  100,
                  t.type === "LONG"
                    ? ((price - t.entryPrice) / (t.tpPrice - t.entryPrice)) *
                        100
                    : ((t.entryPrice - price) / (t.entryPrice - t.tpPrice)) *
                        100,
                ),
              ),
              distToSlPct: distToSl,
              distToTpPct: distToTp,
            };
          } catch {
            return {
              id: t._id as string,
              coin: t.coin as string,
              type: t.type as string,
              entryPrice: t.entryPrice as number,
              currentPrice: 0,
              pnlUsd: 0,
              pnlPct: 0,
              winning: false,
              progressPct: 0,
              distToSlPct: 0,
              distToTpPct: 0,
            };
          }
        },
      ),
    );

    const totalUnrealized: number = positions.reduce(
      (s: number, p) => s + p.pnlUsd,
      0,
    );
    return { positions, totalUnrealized, asOf: Date.now() };
  },
});

/**
 * 15m bars covering a trade's ENTIRE life (entry → now) plus ~20 bars (5h) of
 * slack, so a full-life excursion scan never clips the entry candle or the
 * newest closed bar. Grows with trade age — a fixed window (the old 30 bars ≈
 * 7.5h) silently hid the early-life peaks of long manual holds.
 */
async function fullLifeKlines(
  ctx: PaperActionCtx,
  coin: string,
  entryTime: number,
  now: number,
): Promise<Kline[]> {
  const ageBars = Math.max(1, Math.ceil((now - entryTime) / 900_000));
  return fetchMexcKlines(ctx, coin, "15m", ageBars + 20);
}

// The excursion profile now lives in src/lib/trade-analytics.ts (shared with
// the live book); `excursionRFull` was its private copy here.

async function closePaperTrade(
  ctx: any,
  trade: any,
  rawExitPrice: number,
  exitTime: number,
  reason: string,
  mfeR?: number,
  maeR?: number,
  timeToMfe?: number,
  timeToMae?: number,
) {
  const side = trade.type === "LONG" ? 1 : -1;
  const notional = trade.entryPrice * trade.sizeCoin;
  const exitFeePct =
    reason === "Take Profit" ? MEXC_MAKER_FEE_PCT : MEXC_TAKER_FEE_PCT;
  const feesUsd = notional * ((MEXC_TAKER_FEE_PCT + exitFeePct) / 100);

  let exitPrice = rawExitPrice;
  if (reason !== "Take Profit") {
    const s = (slipBps(trade.coin) + EXIT_SLIP_EXTRA_BPS) / 10_000;
    exitPrice =
      trade.type === "LONG" ? rawExitPrice * (1 - s) : rawExitPrice * (1 + s);
  }

  const held8hWindows = Math.floor(
    (exitTime - trade.entryTime) / (8 * 3_600_000),
  );
  const fundingUsd = held8hWindows * FUNDING_COST_PER_8H * notional;

  const pnlUsd =
    (exitPrice - trade.entryPrice) * trade.sizeCoin * side -
    feesUsd -
    fundingUsd;
  const marginUsd = notional / trade.leverage;

  // Tier 1: entry slippage
  const entrySlippageBps =
    trade.signalPrice && trade.signalPrice > 0
      ? (Math.abs(trade.entryPrice - trade.signalPrice) / trade.entryPrice) *
        10000
      : 0;
  // Tier 5: duration bucket
  const barsHeld = Math.round((exitTime - trade.entryTime) / 900000);
  const durationBucket =
    barsHeld <= 4 ? "fast" : barsHeld <= 16 ? "medium" : "slow";
  // Tier 5: MFE capture ratio
  const risk = Math.abs(trade.entryPrice - trade.slPrice);
  const move =
    side > 0 ? exitPrice - trade.entryPrice : trade.entryPrice - exitPrice;
  const realizedR = risk > 0 ? move / risk : 0;
  const mfeCaptureRatio =
    mfeR && mfeR !== 0 ? +(realizedR / mfeR).toFixed(4) : undefined;
  // Tier 5: vol at exit
  let volAtExit: number | undefined;
  try {
    const kExit = await fetchMexcKlines(ctx, trade.coin, "15m", 20);
    if (kExit.length >= 14) {
      let atrSum = 0;
      for (let i = kExit.length - 14; i < kExit.length; i++) {
        atrSum += Math.max(
          kExit[i].high - kExit[i].low,
          Math.abs(kExit[i].high - kExit[i - 1].close),
          Math.abs(kExit[i].low - kExit[i - 1].close),
        );
      }
      volAtExit = +(
        (atrSum / 14 / (kExit[kExit.length - 1]?.close || 1)) *
        100
      ).toFixed(4);
    }
  } catch {
    /* optional */
  }
  const volAtEntry = trade.volPct ?? trade.tags?.volPct ?? undefined;
  const volDelta =
    volAtEntry != null && volAtExit != null
      ? +(volAtExit - volAtEntry).toFixed(4)
      : undefined;
  // Tier 6: BTC/ETH move during trade (full trade duration, not just last hour)
  let btcMoveDuringTrade: number | undefined;
  let ethMoveDuringTrade: number | undefined;
  try {
    const tradeHours = Math.max(
      2,
      Math.ceil((exitTime - trade.entryTime) / 3_600_000),
    );
    const btcBars = Math.min(tradeHours + 2, 100);
    const btcK = await fetchMexcKlines(ctx, "BTC", "1h", btcBars);
    if (btcK.length >= 2)
      btcMoveDuringTrade = +(
        ((btcK[btcK.length - 1].close - btcK[0].close) / btcK[0].close) *
        100
      ).toFixed(4);
  } catch {
    /* optional */
  }
  try {
    const tradeHours = Math.max(
      2,
      Math.ceil((exitTime - trade.entryTime) / 3_600_000),
    );
    const ethBars = Math.min(tradeHours + 2, 100);
    const ethK = await fetchMexcKlines(ctx, "ETH", "1h", ethBars);
    if (ethK.length >= 2)
      ethMoveDuringTrade = +(
        ((ethK[ethK.length - 1].close - ethK[0].close) / ethK[0].close) *
        100
      ).toFixed(4);
  } catch {
    /* optional */
  }

  const closeArgs = {
    id: trade._id,
    exitPrice,
    exitTime,
    reason,
    pnlUsd,
    pnlPercent: (pnlUsd / marginUsd) * 100,
    mfeR,
    maeR,
    timeToMfe,
    timeToMae,
    entrySlippageBps,
    totalFeesUsd: +feesUsd.toFixed(6),
    fundingCostUsd: +fundingUsd.toFixed(6),
    durationBucket,
    mfeCaptureRatio,
    volAtEntry,
    volAtExit,
    volDelta,
    btcMoveDuringTrade,
    ethMoveDuringTrade,
  };
  await ctx.runMutation(api.paperTrading.closeTrade, closeArgs);
}

export const insertTrade = mutation({
  args: {
    coin: v.string(),
    type: v.string(),
    entryPrice: v.number(),
    slPrice: v.number(),
    tpPrice: v.number(),
    // R-lock trailing exit policy (2026-09-20). Omitted = fixed TP.
    trailStartR: v.optional(v.number()),
    trailStepR: v.optional(v.number()),
    trailMaxR: v.optional(v.number()),
    sizeCoin: v.number(),
    leverage: v.number(),
    entryTime: v.number(),
    signalTime: v.optional(v.number()),
    signalPrice: v.optional(v.number()),
    confirmedAt: v.optional(v.number()),
    variant: v.optional(v.string()),
    book: v.optional(v.string()),
    session: v.optional(v.string()),
    regime: v.optional(v.string()),
    volPct: v.optional(v.number()),
    spreadPct: v.optional(v.number()),
    volRatioAtEntry: v.optional(v.number()),
    atrPctAtEntry: v.optional(v.number()),
    adx14_1h: v.optional(v.number()),
    btcTrendAtEntry: v.optional(v.string()),
    btcChange1h: v.optional(v.number()),
    btcSlopeRaw: v.optional(v.number()),
    dayOfWeek: v.optional(v.number()),
    htfEma20_4h: v.optional(v.number()),
    htfEma50_4h: v.optional(v.number()),
    htfTrend1h: v.optional(v.string()),
    htfVol4h: v.optional(v.number()),
    htfVol4hAvg: v.optional(v.number()),
    distToSwingSr: v.optional(v.number()),
    fundingRate: v.optional(v.number()),
    shortMrRsi7: v.optional(v.number()),
    shortMrRsi14: v.optional(v.number()),
    shortMrUpperBand: v.optional(v.number()),
    shortMrMiddleBand: v.optional(v.number()),
    shortMrVolumeRatio: v.optional(v.number()),
    openInterestDelta: v.optional(v.number()),
    oiAtEntry: v.optional(v.number()),
    bidAskImbalance: v.optional(v.number()),
    consecutiveStreak: v.optional(v.number()),
    rollingWr20: v.optional(v.number()),
    drawdownPct: v.optional(v.number()),
    portfolioHeat: v.optional(v.number()),
    pairVsBtc1h: v.optional(v.number()),
    longScore: v.optional(v.number()),
    shortScore: v.optional(v.number()),
    // Factor-exposure cap (2026-09-23): the pair's estimated BTC beta at
    // this entry, and the book's signed net beta AFTER admitting it. Both
    // are recorded whenever the scan measured them (a beta row is written
    // even while the cap is off) so the rule's path is auditable and the
    // lab can price it on the recorded book.
    btcBetaAtEntry: v.optional(v.number()),
    netBtcBetaAtEntry: v.optional(v.number()),
    // H4 shadow tags (2026-09-23, audit fix): WITHOUT these in the
    // validator, v.object silently STRIPPED them from every paper entry —
    // the forward-test tags never landed on paperTrades (live rows were
    // unaffected: recordLiveEntry declares all five). Same fields as schema.
    shadowTags: v.optional(v.array(v.string())),
    shadowH4RangePct: v.optional(v.number()),
    shadowH4VolLog2: v.optional(v.number()),
    shadowRsi7: v.optional(v.number()),
    // D1 shadow tags v3 (2026-09-26, record-only): daily wick % + 5d return.
    // MUST be declared here — an undeclared field is silently stripped by the
    // validator (the exact bug class the comment above documents).
    d1UpWickPct: v.optional(v.number()),
    d1R5Pct: v.optional(v.number()),
    // Daily StochRSI %K (2026-10-02): same declaration rule as logRejections —
    // an undeclared d1StochK rejects the whole insertTrade call (no entry, and
    // processPair reports an error string that no journal records).
    d1StochK: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const book = args.book ?? "main";
    // ── Idempotency-key dedupe (2026-09) ──
    // A strategy signal's natural key is (book, coin, signalTime) — the close
    // of the 15m bar the signal was computed on, which callers anchor to a
    // deterministic closed-bar timestamp (strategyEngine.processPair does this
    // explicitly). The key is checked across ALL statuses (open or already
    // closed) so re-firing the same signal — an overlapping tick or a manual
    // re-run — can never open a second trade. Convex indexes can't enforce
    // uniqueness, so this is a guarded
    // check + insert: if two identical calls race, both read empty, one
    // commits and the other is OCC-retried, then finds the key row here and
    // returns false. Exactly one row ever exists per key. The precedence rule
    // (duplicate-signal before open-position) is unit-tested in
    // src/lib/__tests__/strategy-utils.test.ts.
    const sameSignal =
      args.signalTime != null
        ? await ctx.db
            .query("paperTrades")
            .withIndex("by_book_coin_signalTime", (q) =>
              q
                .eq("book", book)
                .eq("coin", args.coin)
                .eq("signalTime", args.signalTime),
            )
            .first()
        : undefined;
    const openDup = await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status_coin", (q) =>
        q.eq("book", book).eq("status", "open").eq("coin", args.coin),
      )
      .first();
    if (
      duplicateRejection(args.signalTime, sameSignal != null, openDup != null)
    ) {
      return false;
    }
    await ctx.db.insert("paperTrades", {
      ...args,
      book,
      status: "open",
      trailPeakR: 0,
      trailLockPrice: 0,
      // Enrol the Layer 2 book's entries in the shadow leg (see schema note).
      // Costs nothing here: the flag rides on a row being written anyway, and
      // the shadow itself is advanced by the EXISTING 5-minute exit tick, so
      // there is no second cron and no extra price fetch.
      ...(book === "layer2" ? { shadowOpen: 1, shadowBankedR: 0 } : {}),
      confirmedAt: Date.now(),
      dayOfWeek: args.dayOfWeek ?? new Date(args.entryTime).getUTCDay(),
    });
    // Cooldown tracker: stamp this entry into the single cooldowns document
    // (layer2 book only) so the strategy tick never re-scans trade history.
    if (book === "layer2") {
      await noteCooldown(ctx, args.coin, args.entryTime, args.type);
    }
    return true;
  },
});

/**
 * Persist R-lock trailing state (2026-09-20).
 *
 * The exit tick is a poll — it sees ONE price per run — so the running peak
 * has to live on the row or the lock could never ratchet across ticks. Both
 * fields are one-way: a stale or overlapping tick may never walk the lock
 * back down (or the peak back up), which would silently resurface a full-R
 * loss the lock had already banked.
 */
export const setTrailState = mutation({
  args: {
    tradeId: v.id("paperTrades"),
    peakR: v.number(),
    lockPrice: v.number(),
    replayCursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const trade: any = await ctx.db.get(args.tradeId);
    if (!trade || trade.status !== "open") return false;
    const isLong = trade.type === "LONG";
    const curLock = trade.trailLockPrice ?? 0;
    const nextLock =
      curLock > 0 && args.lockPrice > 0
        ? isLong
          ? Math.max(curLock, args.lockPrice)
          : Math.min(curLock, args.lockPrice)
        : args.lockPrice > 0
          ? args.lockPrice
          : curLock;
    const nextPeak = Math.max(trade.trailPeakR ?? 0, args.peakR);
    const nextCursor =
      args.replayCursor != null
        ? Math.max(trade.trailReplayCursor ?? 0, args.replayCursor)
        : trade.trailReplayCursor;
    await ctx.db.patch(args.tradeId, {
      trailPeakR: nextPeak,
      trailLockPrice: nextLock,
      ...(nextCursor != null ? { trailReplayCursor: nextCursor } : {}),
    });
    return true;
  },
});

/**
 * SHADOW BOOK (see schema note + lib/shadow-book.ts) — legs that OUTLIVED
 * their position.
 *
 * Deliberately NOT the whole pending set. A leg on an OPEN trade is already
 * in the exit tick's open-trades read, so returning it here made the tick
 * pay for the same ~19 KB of enrichment twice every 5 minutes (~5.4 MB/day,
 * measured) to learn nothing. Only a CLOSED trade can carry an orphaned leg
 * — the policy's first target sits beyond the real take-profit, so the
 * position closes first — and there are usually zero or one of those.
 *
 * Docs whose shadowOpen was removed on resolution drop out of the index
 * entirely, so "in the index" and "pending" are the same set by construction.
 */
export const getShadowPendingClosedTrades = query({
  args: { book: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("paperTrades")
      .withIndex("by_book_shadowOpen", (q) =>
        q.eq("book", args.book).eq("shadowOpen", 1).eq("status", "closed"),
      )
      .collect();
  },
});

/**
 * Persist a shadow leg's progress. Called by resolveLayer2Exits ONLY when the
 * leg moved (first target filled) or finished, so the steady-state write cost
 * is ~2 small patches per trade across its whole life — not one per tick.
 * Passing `resolved` clears shadowOpen, dropping the row out of the pending
 * index.
 */
export const patchShadowState = mutation({
  args: {
    tradeId: v.id("paperTrades"),
    /** True when the first target is filled as of this write. */
    tp1Filled: v.boolean(),
    bankedR: v.number(),
    resolved: v.optional(
      v.object({
        at: v.number(),
        reason: v.string(),
        totalR: v.number(),
        tp1At: v.optional(v.number()),
      }),
    ),
  },
  handler: async (ctx, args) => {
    if (args.resolved) {
      await ctx.db.patch(args.tradeId, {
        shadowOpen: undefined, // leaves the pending index
        shadowBankedR: args.bankedR,
        shadowTp1At: args.resolved.tp1At,
        shadowResolvedAt: args.resolved.at,
        shadowExitReason: args.resolved.reason,
        shadowR: args.resolved.totalR,
      });
      return;
    }
    await ctx.db.patch(args.tradeId, {
      shadowBankedR: args.bankedR,
      // Stamped only when this write IS the first-target fill. The caller only
      // reaches this branch on a move that does not resolve the leg, and the
      // only such move is the first target — but asserting it here keeps the
      // two files from silently disagreeing about what that means.
      shadowTp1At: args.tp1Filled ? Date.now() : undefined,
    });
  },
});

/**
 * One-off migration: enrol trades that predate the `shadowOpen` flag.
 *
 * Trades inserted before the shadow book existed carry no flag, so they are
 * invisible to the shadow scan and would never be tracked. Run once
 * after deploying; safe to re-run (it only touches rows missing the flag).
 *
 * CAVEAT, deliberately accepted: a leg enrolled MID-FLIGHT starts from the
 * live tick, not from some earlier replay, so for such a leg `shadowTp1At`
 * records when THIS process noticed the first target rather than when price
 * truly crossed it. R outcomes stay correct; only that timestamp is late. The
 * offline runner (bun run shadow:book) is the right tool for exact history —
 * this exists so live positions are not simply ignored.
 */
export const backfillShadowOpen = mutation({
  args: { book: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const book = args.book ?? "layer2";
    const rows = await ctx.db
      .query("paperTrades")
      .withIndex("by_book_status", (q) =>
        q.eq("book", book).eq("status", "open"),
      )
      .collect();
    let enrolled = 0;
    for (const t of rows) {
      if (t.shadowOpen === 1) continue;
      await ctx.db.patch(t._id, {
        shadowOpen: 1,
        shadowBankedR: t.shadowBankedR ?? 0,
      });
      enrolled++;
    }
    return { book, scanned: rows.length, enrolled };
  },
});

export const deleteTrade = mutation({
  args: { id: v.id("paperTrades") },
  handler: async (ctx, args) => {
    const trade = await ctx.db.get(args.id);
    await ctx.db.delete(args.id);
    // Deleted closed rows would silently skew the book's summary doc. Guarded
    // to the books that maintain a stats doc; every other book has no
    // summary to skew.
    const deletedBook = trade?.book ?? "main";
    if (STATS_BOOKS.includes(deletedBook) && trade?.status === "closed") {
      try {
        await foldBookStats(ctx, deletedBook, trade, -1);
      } catch (e) {
        console.error("[paperTrading] stats fold failed after delete:", e);
      }
    }
    return true;
  },
});

export const closeTrade = mutation({
  args: {
    id: v.id("paperTrades"),
    exitPrice: v.number(),
    exitTime: v.number(),
    reason: v.string(),
    pnlUsd: v.number(),
    pnlPercent: v.number(),
    mfeR: v.optional(v.number()),
    maeR: v.optional(v.number()),
    realizedR: v.optional(v.number()),
    barsHeld: v.optional(v.number()),
    entrySlippageBps: v.optional(v.number()),
    timeToMfe: v.optional(v.number()),
    timeToMae: v.optional(v.number()),
    totalFeesUsd: v.optional(v.number()),
    fundingCostUsd: v.optional(v.number()),
    durationBucket: v.optional(v.string()),
    mfeCaptureRatio: v.optional(v.number()),
    volAtEntry: v.optional(v.number()),
    volAtExit: v.optional(v.number()),
    volDelta: v.optional(v.number()),
    btcMoveDuringTrade: v.optional(v.number()),
    ethMoveDuringTrade: v.optional(v.number()),
    pairVsBtc1h: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const trade = await ctx.db.get(args.id);
    // Idempotency guard (2026-09): never close a trade twice. The 5-min exit
    // cron, the manual Close button and the layer2 exit resolver can all
    // target the same OPEN trade within the same window — two
    // concurrent closeTrade calls both read status="open", both patch the doc
    // and both credit the book balance → the P&L is applied twice. The loser
    // of the write race is retried by Convex, re-reads status="closed" here
    // and no-ops. This also removes a whole class of "Retried due to write
    // conflicts in table paperTrades" retries.
    if (!trade || trade.status !== "open") return;
    // Compute realized R if not provided
    let realizedR = args.realizedR;
    if (realizedR == null && trade) {
      const risk = Math.abs(trade.entryPrice - trade.slPrice);
      if (risk > 0) {
        const isLong = trade.type === "LONG";
        const move = isLong
          ? args.exitPrice - trade.entryPrice
          : trade.entryPrice - args.exitPrice;
        realizedR = move / risk;
      }
    }
    // Compute bars held if not provided
    let barsHeld = args.barsHeld;
    if (barsHeld == null && trade) {
      barsHeld = Math.round((args.exitTime - trade.entryTime) / 900_000); // 15m bars
    }
    await ctx.db.patch(args.id, {
      status: "closed",
      exitPrice: args.exitPrice,
      exitTime: args.exitTime,
      reason: args.reason,
      pnlUsd: args.pnlUsd,
      pnlPercent: args.pnlPercent,
      mfeR: args.mfeR,
      maeR: args.maeR,
      realizedR,
      barsHeld,
      entrySlippageBps: args.entrySlippageBps,
      timeToMfe: args.timeToMfe,
      timeToMae: args.timeToMae,
      totalFeesUsd: args.totalFeesUsd,
      fundingCostUsd: args.fundingCostUsd,
      durationBucket: args.durationBucket,
      mfeCaptureRatio: args.mfeCaptureRatio,
      volAtEntry: args.volAtEntry,
      volAtExit: args.volAtExit,
      volDelta: args.volDelta,
      btcMoveDuringTrade: args.btcMoveDuringTrade,
      ethMoveDuringTrade: args.ethMoveDuringTrade,
      // pairVsBtc1h is an ENTRY-time field (schema: "pair return vs BTC return
      // over 1H at entry") and NO exit path passes it — the unconditional write
      // here was therefore patching every closed row's entry reading to
      // undefined. Measured on the deployment: 1 of 544 layer2 rows carries a
      // value, and that one is the only row still OPEN. Write it only when a
      // caller actually supplies a reading.
      ...(args.pairVsBtc1h != null ? { pairVsBtc1h: args.pairVsBtc1h } : {}),
    });
    // BUGFIX: patch the trade's OWN book's balance — previously every close
    // patched the MAIN account, leaking all books' P&L into the main balance.
    const bookName = trade?.book ?? "main";
    let acc = await ctx.db
      .query("paperAccount")
      .withIndex("by_name", (q) => q.eq("name", bookName))
      .first();
    if (acc) {
      await ctx.db.patch(acc._id, {
        balance: Math.max(0, acc.balance + args.pnlUsd),
      });
    }
    // Cooldown tracker: stamp this exit into the single cooldowns document
    // (layer2 book only) so the strategy tick never re-scans trade history.
    if (bookName === "layer2" && trade) {
      await noteCooldown(ctx, trade.coin, args.exitTime, trade.type);
    }
    // Keep the closed-book summary doc in sync — INCREMENTAL fold (O(1)):
    // add this close's P&L/fees to the running counters instead of re-scanning
    // the whole closed book. Guarded: a stats failure must never block the
    // close itself — this mutation is on the bot's exit path.
    if (STATS_BOOKS.includes(bookName)) {
      try {
        await foldBookStats(
          ctx,
          bookName,
          { pnlUsd: args.pnlUsd, totalFeesUsd: args.totalFeesUsd },
          1,
        );
      } catch (e) {
        console.error("[paperTrading] stats fold failed after close:", e);
      }
    }
  },
});

/**
 * Close ANY book's open trade by rule, reusing the shared close path.
 *
 * A second book's exit tick would need the same fee model, slippage and
 * enrichment that layer2 gets from `closePaperTrade` — re-implementing that in
 * the proxy engine would have let the two books' P&L maths drift, and the
 * whole point of an independent book is that its record is comparable. The
 * internal helper is module-private, so this action is the seam: it re-reads
 * the trade (idempotent — a trade already closed by anyone else is a no-op),
 * then hands off to `closePaperTrade`, which credits the trade's OWN book's
 * balance and folds that book's stats.
 */
export const closeBookTrade = action({
  args: {
    id: v.id("paperTrades"),
    exitPrice: v.number(),
    exitTime: v.number(),
    reason: v.string(),
    mfeR: v.optional(v.number()),
    maeR: v.optional(v.number()),
    timeToMfe: v.optional(v.number()),
    timeToMae: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const trade: any = await ctx.runQuery(api.paperTrading.getTradeById, {
      id: args.id,
    });
    if (!trade || trade.status !== "open") return false;
    await closePaperTrade(
      ctx,
      trade,
      args.exitPrice,
      args.exitTime,
      args.reason,
      args.mfeR,
      args.maeR,
      args.timeToMfe,
      args.timeToMae,
    );
    return true;
  },
});

/** Get a single trade by ID (any book). */
export const getTradeById = query({
  args: { id: v.id("paperTrades") },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id);
  },
});

/**
 * MANUAL ENTRY — panel LONG/SHORT buttons (2026-09). Opens a paper trade on
 * the layer2 book with the same entry recipe as strategyEngine.processPair:
 * current MEXC price, SL/TP % from the live config, size = risk 2.5% of the
 * layer2 balance / SL distance, 50x leverage. Deliberate overrides (the tap
 * IS the intent): no momentum scoring, auto side kill-switches bypassed.
 * Deliberate guards (same as the bot): one open trade per (book, coin)
 * (inside insertTrade) + the 1h per-pair cooldown below, so a manual entry
 * can never double the book's exposure on a coin.
 *
 * Tap-latency note: the bot's full enrichment (regime, HTF EMAs, BTC
 * context, order-book depth) is skipped here. Core fields are stamped; the
 * 2-min exit cron enriches closes exactly as for bot entries.
 */
// Mirrors strategyEngine's LEVERAGE 50x / RISK_PCT 2.5% / COOLDOWN_MS 1h
// without importing that module (it imports buildTradeEnrichment from here —
// importing back would be a module cycle). Keep in sync if the engine's change.
const MANUAL_LEVERAGE = 50;
const MANUAL_RISK_PCT = 0.025;
const MANUAL_COOLDOWN_MS = 60 * 60_000;

export const openLayer2Manual = action({
  args: {
    coin: v.string(),
    type: v.union(v.literal("LONG"), v.literal("SHORT")),
  },
  handler: async (ctx, args) => {
    const coin = args.coin.toUpperCase().replace(/_USDT$/i, "");
    if (!/^[A-Z0-9]{2,20}$/.test(coin)) {
      throw new Error(`Invalid coin: ${args.coin}`);
    }
    const now = Date.now();

    // Current entry fill from MEXC (same relay the bot entry + manual close use).
    let price = 0;
    try {
      price = await relayTickerPrice(ctx, coin);
    } catch {
      /* price stays 0 → thrown below */
    }
    if (!(price > 0)) {
      throw new Error(
        `No live MEXC price for ${coin} — check the symbol and retry`,
      );
    }

    // SL/TP % from the live Layer 2 config (what the bot is using right now).
    const cfg: any = await ctx.runQuery(api.strategyEngine.getConfig, {});
    const slPct = Number(cfg?.stopLossPct ?? 1.5) / 100;
    const tpPct = Number(cfg?.takeProfitPct ?? 2.0) / 100;

    // 1h per-pair cooldown, same rule as the bot. Enforced here (not just in
    // the UI): double-taps race through the panel.
    const cooldowns: Array<{ coin: string; time: number }> = await ctx.runQuery(
      api.paperTrading.getLayer2Cooldowns,
      {},
    );
    const lastTime = cooldowns.find((c) => c.coin === coin)?.time ?? 0;
    if (lastTime && now - lastTime < MANUAL_COOLDOWN_MS) {
      const left = Math.round((MANUAL_COOLDOWN_MS - (now - lastTime)) / 60_000);
      throw new Error(
        `${coin}: 1h book cooldown (${left}m left) — last entry/exit was recent`,
      );
    }

    // Size off the layer2 account balance — the same balance the bot sizes off.
    const account: any = await ctx.runMutation(
      api.paperTrading.ensureLayer2Account,
      {},
    );
    const balance = Number(account?.balance ?? START_BALANCE);
    const slPrice =
      args.type === "LONG" ? price * (1 - slPct) : price * (1 + slPct);
    const tpPrice =
      args.type === "LONG" ? price * (1 + tpPct) : price * (1 - tpPct);
    const riskAmount = balance * MANUAL_RISK_PCT;
    const sizeCoin = price * slPct > 0 ? riskAmount / (price * slPct) : 0;
    if (!(sizeCoin > 0))
      throw new Error("Sizing failed — balance/SL misconfigured");

    const inserted = await ctx.runMutation(api.paperTrading.insertTrade, {
      coin,
      type: args.type,
      entryPrice: price,
      slPrice,
      tpPrice,
      sizeCoin,
      leverage: MANUAL_LEVERAGE,
      entryTime: now,
      // Manual taps have no 15m signal bar; anchor to entryTime (a double-tap
      // still hits the open-dup guard in insertTrade, so exactly one opens).
      signalTime: now,
      signalPrice: price,
      variant: "manual",
      book: "layer2",
      session: sessionOf(now),
      dayOfWeek: new Date(now).getUTCDay(),
      confirmedAt: now,
    });
    if (!inserted) {
      throw new Error(
        `${coin}: blocked — a position on ${coin} is already open (one per coin)`,
      );
    }
    return {
      ok: true as const,
      coin,
      type: args.type,
      entryPrice: price,
      slPrice,
      tpPrice,
      sizeCoin,
      leverage: MANUAL_LEVERAGE,
    };
  },
});

/**
 * Close a single open trade at current market price.
 * Used by the frontend "Close" button on each open position.
 */
export const closeTradeManual = action({
  args: { tradeId: v.id("paperTrades") },
  handler: async (ctx: any, args: { tradeId: any }) => {
    const found: any = await ctx.runQuery(api.paperTrading.getTradeById, {
      id: args.tradeId,
    });
    if (!found) throw new Error("Trade not found");
    if (found.status !== "open") throw new Error("Trade is not open");

    // Fetch current price from MEXC
    const price = await relayTickerPrice(ctx, found.coin);
    if (!(price > 0)) throw new Error("Failed to fetch current price");
    const now = Date.now();

    // Excursion over the trade's ENTIRE life (entry → now), not the old fixed
    // 30-bar (~7.5h) window: manual closes of long-running positions missed
    // their early-life peaks, and timeToMfe/timeToMae were never recorded on
    // this path (6/159 closed trades had no timeToMfe). Same full-life scan
    // the 5-min exit cron performs at close; only completed 15m bars count
    // (k.closeTime <= now drops the in-progress candle).
    const k15 = await fullLifeKlines(ctx, found.coin, found.entryTime, now);
    const held = k15.filter(
      (k: any) => k.closeTime > found.entryTime && k.closeTime <= now,
    );
    const exc = excursionR(
      found.type as "LONG" | "SHORT",
      found.entryPrice,
      found.slPrice,
      held,
    );

    await closePaperTrade(
      ctx,
      found,
      price,
      now,
      "Manual Close",
      exc.mfeR,
      exc.maeR,
      exc.timeToMfe,
      exc.timeToMae,
    );
    return { closed: true, exitPrice: price, coin: found.coin };
  },
});

/** Clear BTC trend fields for re-backfill with percentile thresholds. */
export const clearBtcFields = mutation({
  args: {},
  handler: async (ctx) => {
    await requireOperator(ctx);
    const all = await ctx.db.query("paperTrades").collect();
    let patched = 0;
    for (const trade of all) {
      if (trade.btcTrendAtEntry != null || trade.btcChange1h != null) {
        await ctx.db.patch(trade._id, {
          btcTrendAtEntry: undefined,
          btcChange1h: undefined,
        });
        patched++;
      }
    }
    return { patched, total: all.length };
  },
});

/** One-time backfill: compute dayOfWeek, barsHeld, realizedR from existing trade data (no klines needed). */
export const backfillBasicFields = mutation({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query("paperTrades").collect();
    let patched = 0;
    for (const trade of all) {
      const updates: Record<string, any> = {};
      if (trade.dayOfWeek == null && trade.entryTime) {
        updates.dayOfWeek = new Date(trade.entryTime).getUTCDay();
      }
      if (trade.barsHeld == null && trade.exitTime && trade.entryTime) {
        updates.barsHeld = Math.round(
          (trade.exitTime - trade.entryTime) / 900_000,
        );
      }
      if (
        trade.realizedR == null &&
        trade.exitPrice != null &&
        trade.entryPrice &&
        trade.slPrice
      ) {
        const risk = Math.abs(trade.entryPrice - trade.slPrice);
        if (risk > 0) {
          const isLong = trade.type === "LONG";
          const move = isLong
            ? trade.exitPrice - trade.entryPrice
            : trade.entryPrice - trade.exitPrice;
          updates.realizedR = +(move / risk).toFixed(4);
        }
      }
      if (Object.keys(updates).length > 0) {
        await ctx.db.patch(trade._id, updates);
        patched++;
      }
    }
    return { patched, total: all.length };
  },
});

/**
 * One-time, opt-in funding backfill for existing paper trades.
 *
 * MEXC history is fetched once per coin and paged backwards as needed. Only
 * trades with a missing fundingRate are patched; unavailable history and
 * request failures remain undefined rather than becoming fabricated zeroes.
 * The matched value is the first published settlement at/after entryTime.
 */
export const backfillFundingRates = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    patched: number;
    unavailable: number;
    failed: number;
    totalMissing: number;
  }> => {
    const all = (await ctx.runQuery(
      api.paperTrading.getAllTradesRaw,
      {},
    )) as any[];
    const missing = all.filter(
      (trade) => trade.fundingRate == null && Number.isFinite(trade.entryTime),
    );
    const byCoin = new Map<string, any[]>();
    for (const trade of missing) {
      const coin = String(trade.coin).toUpperCase();
      const bucket = byCoin.get(coin) ?? [];
      bucket.push(trade);
      byCoin.set(coin, bucket);
    }

    let patched = 0;
    let unavailable = 0;
    let failed = 0;
    for (const [coin, trades] of byCoin) {
      try {
        const earliest = Math.min(...trades.map((trade) => trade.entryTime));
        const latest = Math.max(...trades.map((trade) => trade.entryTime));
        const history = await relayFundingHistory(ctx, coin, earliest, latest);
        for (const trade of trades) {
          const match = fundingRateAtEntry(history, trade.entryTime);
          if (!match) {
            unavailable++;
            continue;
          }
          await ctx.runMutation(api.paperTrading.patchTradeFields, {
            tradeId: trade._id,
            fundingRate: match.rate,
          });
          patched++;
        }
      } catch {
        failed += trades.length;
      }
    }
    return { patched, unavailable, failed, totalMissing: missing.length };
  },
});

/**
 * Compare the safer bonus policy with strict funding on realized trades.
 * This is a policy replay, not a full signal backtest: it can evaluate trades
 * that were actually taken, but cannot include signals that were never logged.
 */
export const compareFundingPolicies = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{
    baseline: { trades: number; wins: number; pnlUsd: number };
    strict: { trades: number; wins: number; pnlUsd: number };
    strictBlocked: number;
    missingFunding: number;
  }> => {
    const all = (await ctx.runQuery(
      api.paperTrading.getAllTradesRaw,
      {},
    )) as any[];
    const closed = all.filter(
      (trade) => trade.status === "closed" && Number.isFinite(trade.pnlUsd),
    );
    const baseline = { trades: closed.length, wins: 0, pnlUsd: 0 };
    const strict = { trades: 0, wins: 0, pnlUsd: 0 };
    let strictBlocked = 0;
    let missingFunding = 0;

    for (const trade of closed) {
      const pnl = Number(trade.pnlUsd);
      baseline.pnlUsd += pnl;
      if (pnl > 0) baseline.wins++;
      const rate = trade.fundingRate;
      if (!Number.isFinite(rate)) {
        missingFunding++;
        continue;
      }
      const agrees = trade.type === "LONG" ? rate <= 0 : rate >= 0;
      if (!agrees) {
        strictBlocked++;
        continue;
      }
      strict.trades++;
      strict.pnlUsd += pnl;
      if (pnl > 0) strict.wins++;
    }

    return {
      baseline: { ...baseline, pnlUsd: +baseline.pnlUsd.toFixed(6) },
      strict: { ...strict, pnlUsd: +strict.pnlUsd.toFixed(6) },
      strictBlocked,
      missingFunding,
    };
  },
});

/** Helper: patch arbitrary fields on a trade (used by backfill actions). */
export const patchTradeFields = mutation({
  args: {
    tradeId: v.id("paperTrades"),
    volRatioAtEntry: v.optional(v.number()),
    atrPctAtEntry: v.optional(v.number()),
    adx14_1h: v.optional(v.number()),
    btcTrendAtEntry: v.optional(v.string()),
    btcChange1h: v.optional(v.number()),
    btcSlopeRaw: v.optional(v.number()),
    dayOfWeek: v.optional(v.number()),
    realizedR: v.optional(v.number()),
    barsHeld: v.optional(v.number()),
    entrySlippageBps: v.optional(v.number()),
    timeToMfe: v.optional(v.number()),
    timeToMae: v.optional(v.number()),
    totalFeesUsd: v.optional(v.number()),
    fundingCostUsd: v.optional(v.number()),
    htfEma20_4h: v.optional(v.number()),
    htfEma50_4h: v.optional(v.number()),
    htfTrend1h: v.optional(v.string()),
    htfVol4h: v.optional(v.number()),
    htfVol4hAvg: v.optional(v.number()),
    distToSwingSr: v.optional(v.number()),
    fundingRate: v.optional(v.number()),
    shortMrRsi7: v.optional(v.number()),
    shortMrRsi14: v.optional(v.number()),
    shortMrUpperBand: v.optional(v.number()),
    shortMrMiddleBand: v.optional(v.number()),
    shortMrVolumeRatio: v.optional(v.number()),
    openInterestDelta: v.optional(v.number()),
    bidAskImbalance: v.optional(v.number()),
    liquidationProx: v.optional(v.number()),
    consecutiveStreak: v.optional(v.number()),
    drawdownPct: v.optional(v.number()),
    portfolioHeat: v.optional(v.number()),
    rollingWr20: v.optional(v.number()),
    // Schema migration fields
    type: v.optional(v.string()),
    slPrice: v.optional(v.number()),
    tpPrice: v.optional(v.number()),
    session: v.optional(v.string()),
    regime: v.optional(v.string()),
    volPct: v.optional(v.number()),
    spreadPct: v.optional(v.number()),
    durationBucket: v.optional(v.string()),
    mfeCaptureRatio: v.optional(v.number()),
    // Excursion backfill (2026-10-08): legacy signal-exit rows that closed
    // before leg-B parity never got mfeR/maeR. Same columns closeTrade
    // writes — patch-only, never read by any gate.
    mfeR: v.optional(v.number()),
    maeR: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const updates: Record<string, any> = {};
    for (const [key, val] of Object.entries(args)) {
      if (key === "tradeId") continue;
      if (val != null) updates[key] = val;
    }
    if (Object.keys(updates).length > 0)
      await ctx.db.patch(args.tradeId, updates);
  },
});

/** One-time backfill: fetch klines to compute volRatio, ATR, BTC trend. */
export const backfillKlineFields = action({
  args: {},
  handler: async (
    ctx,
  ): Promise<{ patched: number; skipped: number; total: number }> => {
    const all = (await ctx.runQuery(
      api.paperTrading.getAllTradesRaw,
      {},
    )) as any[];
    const missing = all.filter(
      (t: any) =>
        t.volRatioAtEntry == null ||
        t.btcTrendAtEntry == null ||
        t.btcChange1h == null,
    );
    const byCoin = new Map<string, any[]>();
    for (const t of missing) {
      if (!byCoin.has(t.coin)) byCoin.set(t.coin, []);
      byCoin.get(t.coin)!.push(t);
    }
    let patched = 0,
      skipped = 0;
    for (const [coin, trades] of byCoin) {
      try {
        const k15 = await relayKlines(ctx, coin, "15m", 500);
        const k1hBTC = await relayKlines(ctx, "BTC", "1h", 720);
        for (const trade of trades) {
          try {
            const entryTime = trade.entryTime;
            const updates: Record<string, any> = {};
            if (trade.volRatioAtEntry == null && k15.length > 20) {
              const closed = k15.filter((k: any) => k.closeTime <= entryTime);
              if (closed.length >= 21) {
                let volSum = 0;
                for (let j = closed.length - 21; j < closed.length - 1; j++)
                  volSum += closed[j].volume;
                const volSma = volSum / 20;
                if (volSma > 0)
                  updates.volRatioAtEntry = +(
                    closed[closed.length - 1].volume / volSma
                  ).toFixed(3);
              }
            }
            if (trade.atrPctAtEntry == null && k15.length > 15) {
              const closed = k15.filter((k: any) => k.closeTime <= entryTime);
              if (closed.length >= 15) {
                let atrSum = 0;
                for (let i = closed.length - 14; i < closed.length; i++) {
                  const tr = Math.max(
                    closed[i].high - closed[i].low,
                    Math.abs(closed[i].high - closed[i - 1].close),
                    Math.abs(closed[i].low - closed[i - 1].close),
                  );
                  atrSum += tr;
                }
                const price = closed[closed.length - 1].close;
                if (price > 0)
                  updates.atrPctAtEntry = +(
                    (atrSum / 14 / price) *
                    100
                  ).toFixed(4);
              }
            }
            if (
              (trade.btcTrendAtEntry == null || trade.btcChange1h == null) &&
              k1hBTC.length >= 20
            ) {
              const closed = k1hBTC.filter(
                (k: any) => k.closeTime <= entryTime,
              );
              if (closed.length >= 20) {
                const closes = closed.map((k: any) => k.close);
                const kf = 2 / 21;
                let ema = closes[0];
                const slopes: number[] = [];
                for (let i = 1; i < closes.length; i++) {
                  const prev = ema;
                  ema = closes[i] * kf + ema * (1 - kf);
                  if (prev > 0) slopes.push((ema - prev) / prev);
                }
                if (trade.btcTrendAtEntry == null && slopes.length >= 5) {
                  const sorted = [...slopes].sort(
                    (a: number, b: number) => a - b,
                  );
                  const p33 = sorted[Math.floor(sorted.length * 0.33)];
                  const p67 = sorted[Math.floor(sorted.length * 0.67)];
                  const current = slopes[slopes.length - 1];
                  updates.btcTrendAtEntry =
                    current > p67 ? "up" : current < p33 ? "down" : "chop";
                  (updates as any).btcSlopeRaw = +current.toFixed(8);
                }
                if (trade.btcChange1h == null && closes.length >= 2)
                  updates.btcChange1h = +(
                    ((closes[closes.length - 1] - closes[closes.length - 2]) /
                      closes[closes.length - 2]) *
                    100
                  ).toFixed(4);
              }
            }
            if (Object.keys(updates).length > 0) {
              await ctx.runMutation(api.paperTrading.patchTradeFields, {
                tradeId: trade._id,
                ...updates,
              });
              patched++;
            } else {
              skipped++;
            }
          } catch {
            skipped++;
          }
        }
      } catch {
        skipped += trades.length;
      }
    }
    return { patched, skipped, total: missing.length };
  },
});

/** One-time migration: rename shadow account + trades to fibonacci. */
export const migrateShadowToFibonacci = mutation({
  args: {},
  handler: async (ctx) => {
    let accountsRenamed = 0;
    let tradesRetagged = 0;

    // 1. Rename account from "shadow" to "fibonacci"
    const shadowAcc = await ctx.db
      .query("paperAccount")
      .withIndex("by_name", (q) => q.eq("name", "shadow"))
      .first();
    if (shadowAcc) {
      // Check if a "fibonacci" account already exists
      const fibAcc = await ctx.db
        .query("paperAccount")
        .withIndex("by_name", (q) => q.eq("name", "fibonacci"))
        .first();
      if (!fibAcc) {
        await ctx.db.patch(shadowAcc._id, { name: "fibonacci" });
        accountsRenamed = 1;
      } else {
        // Both exist — merge shadow balance into fibonacci, then delete shadow
        await ctx.db.patch(fibAcc._id, {
          balance:
            fibAcc.balance +
            (shadowAcc.balance ?? 0) -
            (fibAcc.startBalance ?? 150),
        });
        await ctx.db.delete(shadowAcc._id);
        accountsRenamed = 1;
      }
    }

    // 2. Re-tag all trades with book="shadow" to book="fibonacci"
    const allTrades = await ctx.db.query("paperTrades").collect();
    for (const t of allTrades) {
      if (t.book === "shadow") {
        await ctx.db.patch(t._id, { book: "fibonacci" });
        tradesRetagged++;
      }
    }

    return { accountsRenamed, tradesRetagged };
  },
});

/** One-time cleanup: delete all sweep-v1 trades and reconcile fibonacci balance. */
export const deleteSweepTrades = mutation({
  args: {},
  handler: async (ctx) => {
    const allTrades = await ctx.db.query("paperTrades").collect();
    let deleted = 0;
    for (const t of allTrades) {
      if (t.variant === "sweep-v1") {
        await ctx.db.delete(t._id);
        deleted++;
      }
    }

    // Reconcile fibonacci account balance to start fresh with $150
    const acc = await ctx.db
      .query("paperAccount")
      .withIndex("by_name", (q) => q.eq("name", "fibonacci"))
      .first();
    if (acc) {
      await ctx.db.patch(acc._id, { balance: 150, startBalance: 150 });
    }

    return { deleted, accountReset: acc ? true : false };
  },
});
