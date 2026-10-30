import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";
import { auth } from "./auth";

const http = httpRouter();

auth.addHttpRoutes(http);

// NOTE: /api/mexc moved to separate chart-proxy deployment
// to keep chart usage outside this deployment's 1M/month quota.

// ── Bot trades endpoint — DISABLED until chart-proxy is deployed ──
// Uncomment when moving to separate deployment.
// http.route({
//   path: "/api/trades",
//   method: "GET",
//   handler: httpAction(async (ctx, request) => {
//     const url = new URL(request.url);
//     const coin = url.searchParams.get("coin");
//     if (!coin) {
//       return new Response(JSON.stringify({ error: "?coin=SOL required" }), {
//         status: 400,
//         headers: { "content-type": "application/json" },
//       });
//     }
//     const all = await ctx.runQuery(api.paperTrading.getAllTradesRaw);
//     const trades = all
//       .filter((t: any) => t.coin === coin)
//       .sort((a: any, b: any) => (a.entryTime ?? 0) - (b.entryTime ?? 0))
//       .slice(-50)
//       .map((t: any) => ({
//         id: t._id, coin: t.coin, type: t.type, book: t.book,
//         entryPrice: t.entryPrice, exitPrice: t.exitPrice,
//         entryTime: t.entryTime, exitTime: t.exitTime, status: t.status,
//         slPrice: t.slPrice, tpPrice: t.tpPrice, pnlUsd: t.pnlUsd,
//         reason: t.reason, session: t.session,
//         volRatioAtEntry: t.volRatioAtEntry,
//       }));
//     return new Response(JSON.stringify({ trades }), {
//       status: 200,
//       headers: {
//         "content-type": "application/json",
//         "access-control-allow-origin": "*",
//         "cache-control": "public, max-age=5",
//       },
//     });
//   }),
// });

// ── Forward-test klines proxy — public market data, no auth ──
// Lets the sandbox (whose egress to MEXC is blocked) pull MEXC futures 1H
// klines through the Convex runtime. Paper data only — no orders.
http.route({
  path: "/api/forward-klines",
  method: "GET",
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const coin = url.searchParams.get("coin");
    const bars = Math.min(Math.max(Number(url.searchParams.get("bars") ?? 800), 1), 5000);
    const endMs = Number(url.searchParams.get("endMs") ?? Date.now());
    if (!coin) {
      return new Response(JSON.stringify({ error: "?coin=BTC&bars=800 required" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }
    try {
      const data = await ctx.runAction(api.mexcForward.fetchBatch, { coin, bars, endMs });
      return new Response(JSON.stringify({ coin, bars: data }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    } catch (e: any) {
      return new Response(JSON.stringify({ error: String(e?.message ?? e).slice(0, 300) }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    }
  }),
});

export default http;
