"use node";

/**
 * MARKET RELAY — Node-runtime MEXC reads for default-runtime callers.
 *
 * WHY `"use node"` (2026-10-16): MEXC's WAF returns 403 HTML to every
 * default Convex runtime fetch, while the Node runtime gets clean JSON from
 * the same deployment (see priceRelay.ts). The paper
 * strategy, market-data and advisor ticks run on the default runtime, so they
 * route every MEXC read through the actions below. The live book already reads
 * MEXC from Node modules directly.
 *
 * Each action returns plain serialisable values (Maps are converted to
 * records) so results survive the action boundary.
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import {
  fetchContractSize,
  fetchDepth,
  fetchRecentTrades,
  fetchFundingRateHistory,
  fetchFundingRateWithStatus,
  fetchHtfTrend1hRaw,
  fetchHtfTrend4hRaw,
  fetchAllTickers,
  fetchKlines,
  fetchTickerPrice,
  fetchTicker,
  fetchTickerRaw,
} from "../lib/mexc/mexcFetchers";
import { contractMetaFull } from "../lib/contract-meta";
import type { ContractMeta } from "../lib/entry-guards";
import type { Kline } from "../lib/types";

export const klines = internalAction({
  args: {
    coin: v.string(),
    interval: v.string(),
    bars: v.number(),
    endMs: v.optional(v.number()),
  },
  handler: async (_ctx, args): Promise<Kline[]> => {
    return fetchKlines(args.coin, args.interval, args.bars, args.endMs);
  },
});

/**
 * BATCHED klines — many series in ONE action execution (2026-10-28).
 *
 * WHY. Every `klines` call above is its own action execution, and action
 * compute is billed on each one's wall-clock: when a default-runtime caller
 * fans out ~34 per-pair reads, it pays the caller's wait AND 34 separate
 * callee durations (see marketDataNode.ts's header for the same arithmetic on
 * Layer 1). This action takes the whole list and issues the same fetches from
 * ONE execution, so the per-hop overhead is paid once.
 *
 * WHAT DOES NOT CHANGE. Same fetcher (`lib/mexc/mexcFetchers`), hence the same
 * URLs, parsing and shared `mexcPacer`; `Promise.all` only replaces the parent's
 * fan-out, and the pacer still caps the burst (4 in flight, 125 ms apart).
 * Failures are per series: a failed read returns `null` at its index, exactly
 * the shape a rejected per-pair call produced, so callers keep their existing
 * fallback (a missing series is read again, not silently dropped).
 *
 * Chunking is the CALLER's job: a return value carrying a lot of bars should
 * stay small, and a chunk that fails costs only that chunk's series.
 */
export const klinesBatch = internalAction({
  args: {
    requests: v.array(
      v.object({
        coin: v.string(),
        interval: v.string(),
        bars: v.number(),
        endMs: v.optional(v.number()),
      }),
    ),
  },
  handler: async (_ctx, args): Promise<(Kline[] | null)[]> => {
    return await Promise.all(
      args.requests.map(async (r) => {
        try {
          return await fetchKlines(r.coin, r.interval, r.bars, r.endMs);
        } catch {
          return null;
        }
      }),
    );
  },
});

export const ticker = internalAction({
  args: { coin: v.string() },
  handler: async (_ctx, args): Promise<{ last: number; volume24: number }> => {
    return fetchTicker(args.coin);
  },
});

export const tickerRaw = internalAction({
  args: { coin: v.string() },
  handler: async (_ctx, args) => {
    return fetchTickerRaw(args.coin);
  },
});

export const tickerPrice = internalAction({
  args: { coin: v.string() },
  handler: async (_ctx, args): Promise<number> => {
    return fetchTickerPrice(args.coin);
  },
});

export const allTickers = internalAction({
  args: {},
  handler: async (): Promise<
    Record<string, { last: number; volume24: number; holdVol?: number }>
  > => {
    const map = await fetchAllTickers();
    return Object.fromEntries(map);
  },
});

export const depth = internalAction({
  args: { coin: v.string() },
  handler: async (_ctx, args) => {
    return fetchDepth(args.coin);
  },
});

export const fundingWithStatus = internalAction({
  args: { coin: v.string() },
  handler: async (_ctx, args) => {
    return fetchFundingRateWithStatus(args.coin);
  },
});

export const fundingHistory = internalAction({
  args: {
    coin: v.string(),
    earliestMs: v.number(),
    latestMs: v.number(),
  },
  handler: async (
    _ctx,
    args,
  ): Promise<Array<{ rate: number; settleTime: number }>> => {
    return fetchFundingRateHistory(args.coin, args.earliestMs, args.latestMs);
  },
});

export const recentTrades = internalAction({
  args: { coin: v.string() },
  handler: async (_ctx, args) => {
    return fetchRecentTrades(args.coin);
  },
});

export const contractSize = internalAction({
  args: { coin: v.string() },
  handler: async (_ctx, args): Promise<number> => {
    return fetchContractSize(args.coin);
  },
});

/**
 * Full contract metadata (price tick, volume step, min/max order size).
 *
 * The short-entry book sizes in EXCHANGE terms — its entry spec floors the
 * quantity to `step_size` and refuses anything below `min_qty` — so it needs
 * more than contractSize. Parsing stays in src/lib/entry-guards (pure, tested);
 * this relay only exists because MEXC's contract/detail read must run on the
 * Node runtime (see the module header). `missing` is passed through so the
 * caller can refuse to invent a value the exchange did not supply.
 */
export const contractMeta = internalAction({
  args: { coin: v.string() },
  handler: async (
    _ctx,
    args,
  ): Promise<{ meta: ContractMeta; missing: string[] }> => {
    return contractMetaFull(args.coin);
  },
});

export const htfTrendRaw = internalAction({
  args: {
    coin: v.string(),
    tf: v.union(v.literal("1h"), v.literal("4h")),
    period: v.number(),
  },
  handler: async (_ctx, args) => {
    // null (not undefined) so the value survives the Convex return boundary.
    const raw =
      args.tf === "1h"
        ? await fetchHtfTrend1hRaw(args.coin, args.period)
        : await fetchHtfTrend4hRaw(args.coin, args.period);
    return raw ?? null;
  },
});
