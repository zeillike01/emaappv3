"use node";

/**
 * PRICE RELAY — Node-runtime ticker reads for default-runtime callers.
 *
 * WHY `"use node"` (2026-10-16): MEXC's WAF returns 403 HTML to every
 * default Convex runtime fetch (contract.mexc.com/api/v1/contract/ticker
 * included), while the Node runtime gets clean JSON from the same
 * deployment. Default-runtime
 * actions (e.g. strategyEngine.resolveLayer2Exits) cannot fetch MEXC
 * directly, so they call this action to obtain last prices.
 *
 * Returns a plain record so the result survives the action boundary. Pairs
 * missing from the batched universe response fall back to a per-pair ticker
 * read, so one bad batch can never strand an open trade with "no price".
 */
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { fetchAllTickers, fetchTickerPrice } from "../lib/mexc/mexcFetchers";

export const layer2Prices = internalAction({
  args: { pairs: v.array(v.string()) },
  handler: async (_ctx, args): Promise<Record<string, number>> => {
    const prices: Record<string, number> = {};
    let tickerMap: Awaited<ReturnType<typeof fetchAllTickers>> | undefined;
    try {
      tickerMap = await fetchAllTickers();
    } catch {
      tickerMap = undefined; // per-pair fallback below
    }
    if (tickerMap) {
      for (const pair of args.pairs) {
        const last = tickerMap.get(pair)?.last;
        if (last && last > 0) prices[pair] = last;
      }
    }
    const missing = args.pairs.filter((pair) => !(prices[pair] > 0));
    await Promise.all(
      missing.map(async (pair) => {
        try {
          const price = await fetchTickerPrice(pair);
          if (price && price > 0) prices[pair] = price;
        } catch {
          /* skip: pair stays unpriced this tick */
        }
      }),
    );
    return prices;
  },
});
