#!/usr/bin/env bun
// LuxAlgo strategy extraction pipeline.
// Enumerates all concepts, fetches pages, ranks tradeable candidates,
// fetches indicator/source, writes backtest-ready specs.
import fs from "node:fs";
import path from "node:path";

const MCP = "https://mcp.luxalgo.com/mcp";
const CTX = "Extracting tradeable strategy rules to support a user building a backtest-ready strategy catalog.";
const OUT = "data/lab/luxalgo/strategies";
const CACHE = "data/lab/luxalgo/cache";
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(CACHE + "/concepts", { recursive: true });
fs.mkdirSync(CACHE + "/indicators", { recursive: true });

async function mcp(tool: string, args: Record<string, unknown>): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(MCP, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { ...args, context: CTX } } }),
      });
      const t = await r.text();
      const m = t.match(/data:\s*(\{.*\})/s);
      if (!m) throw new Error("no data frame: " + t.slice(0, 200));
      const j = JSON.parse(m[1]);
      if ((j as any).error) throw new Error("rpc: " + JSON.stringify((j as any).error).slice(0, 300));
      const txt = (j.result?.content ?? []).map((c: any) => c.text).join("\n");
      return JSON.parse(txt);
    } catch (e: any) {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      throw e;
    }
  }
}

const FAMILIES = ["trend","momentum","volatility","volume-orderflow","market-structure","smc-ict","wyckoff","elliott-harmonics","patterns","levels","statistics","machine-learning","time-seasonality","sentiment-breadth","risk-exits","meta-composition","validation"];

async function step1() {
  const fams = await mcp("library_list_families", {});
  fs.writeFileSync(CACHE + "/families.json", JSON.stringify(fams, null, 1));
  const all: any[] = [];
  for (const f of FAMILIES) {
    let page = 0; const ps = 200;
    for (;;) {
      const r = await mcp("library_list_concepts", { family: f, page, page_size: ps });
      all.push(...r.concepts);
      console.log(`${f} p${page}: ${r.concepts.length}/${r.total}`);
      if (all.filter((c) => c.family === f).length >= r.total || r.concepts.length < ps) break;
      page++;
    }
  }
  fs.writeFileSync(CACHE + "/inventory.json", JSON.stringify(all, null, 1));
  console.log("TOTAL concepts:", all.length);
}

await step1();
