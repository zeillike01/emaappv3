#!/usr/bin/env bun
// Step 3: curated slugs -> indicator/source fetch -> backtest-ready spec files.
import fs from "node:fs";
const MCP = "https://mcp.luxalgo.com/mcp";
const CTX = "Extracting tradeable strategy rules to support a user building a backtest-ready strategy catalog.";
const CACHE = "data/lab/luxalgo/cache";
const OUT = "data/lab/luxalgo/strategies";
fs.mkdirSync(OUT, { recursive: true });
async function mcp(tool: string, args: Record<string, unknown>): Promise<any> {
  for (let a = 0; a < 2; a++) {
    try {
      const r = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { ...args, context: CTX } } }) });
      const t = await r.text();
      const m = t.match(/data:\s*(\{.*\})/s);
      if (!m) throw new Error("no frame " + t.slice(0, 150));
      const j = JSON.parse(m[1]);
      if ((j as any).error) throw new Error("rpc " + JSON.stringify((j as any).error).slice(0, 200));
      return j.result?.content?.map((c: any) => c.text).join("\n") ?? "";
    } catch (e: any) { if (a === 0) { await new Promise((r) => setTimeout(r, 2000)); continue; } throw e; }
  }
}
const SLUGS = ["supertrend","halftrend","parabolic-sar","donchian-trend-rules","moving-average-crossovers","gann-hilo-activator","chandelier-stop","breakout","retest","pullback","rsi-2","stochastic-rsi","stochastic-pop","macd","rsi-failure-swing","rsi-range-rules","regular-bullish-bearish-divergence","connors-rsi","elder-impulse-system","wave-trend-oscillator","overbought-oversold","bollinger-band-tag-reversion","bollinger-squeeze","ttm-squeeze","keltner-channels","donchian-channels","waddah-attar-explosion","squeeze-release-direction","session-vwap","anchored-vwap","vwap-mean-reversion-vs-trend-regimes","break-of-structure","change-of-character","swing-failure-pattern","turtle-soup","1-2-3-reversal","breakout-pullback-continuation","false-breakout","bullish-bearish-order-block","breaker-block","fair-value-gap","fvg-behavior-rules","liquidity-sweep","silver-bullet","optimal-trade-entry","mitigation-block","spring","upthrust","wyckoff-accumulation-schematic","gartley","bat","butterfly","crab","cypher","shark","abcd","potential-reversal-zone","bull-bear-flag","head-and-shoulders","inverse-head-and-shoulders","double-top-bottom","cup-and-handle","rising-falling-wedge","evening-star","morning-star","bullish-bearish-engulfing","pin-bar","inside-bar","hikkake","gap-and-go","wolfe-waves","pivot-points","central-pivot-range","fib-retracement","golden-pocket","supply-and-demand-zones","role-reversal","opening-range-and-orb","killzones","volatility-stop","elder-safezone-stop","pattern-invalidation-stop","stop-and-reverse","nr4-nr7-narrow-range-bars","band-walk"];
console.log("curated:", SLUGS.length);
fs.writeFileSync(CACHE + "/shortlist.json", JSON.stringify(SLUGS));
