import { action } from "./_generated/server";
import { v } from "convex/values";
import { relayKlines } from "./marketFetch";

/**
 * Fetch MEXC futures 1H klines through the Convex runtime (which is not
 * subject to the sandbox egress block). Used by the LuxAlgo Phase-3 forward
 * test to extend the local 1H cache past 2026-09-12 and to seed VIRTUAL/SHIB.
 * Paper data only — no orders.
 *
 * The klines come from the Node relay (marketRelay.klines): this action runs on
 * the DEFAULT runtime, where MEXC's WAF answers every direct fetch with 403
 * HTML, so the paging loop that used to live here now lives in the relay. The
 * returned shape is unchanged ({ t, o, h, l, c, v } per bar) — the forward-test
 * harness on the other side of the HTTP route reads those keys.
 */
export const fetchBatch = action({
  args: { coin: v.string(), bars: v.number(), endMs: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const klines = await relayKlines(ctx, args.coin, "1h", args.bars, args.endMs);
    return klines.map((k) => ({
      t: k.openTime,
      o: k.open,
      h: k.high,
      l: k.low,
      c: k.close,
      v: k.volume,
    }));
  },
});
