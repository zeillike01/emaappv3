#!/usr/bin/env bun
// Step 2: fetch every concept page (cached, resumable), rank tradeable candidates.
import fs from "node:fs";

const MCP = "https://mcp.luxalgo.com/mcp";
const CTX = "Extracting tradeable strategy rules to support a user building a backtest-ready strategy catalog.";
const CACHE = "data/lab/luxalgo/cache";
const CDIR = CACHE + "/concepts";
fs.mkdirSync(CDIR, { recursive: true });

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
      return j.result?.content?.map((c: any) => c.text).join("\n") ?? "";
    } catch (e: any) {
      if (attempt === 0) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      throw e;
    }
  }
}

const inv: any[] = JSON.parse(fs.readFileSync(CACHE + "/inventory.json", "utf8"));
const failures: Array<{ slug: string; error: string }> = [];
try { failures.push(...JSON.parse(fs.readFileSync(CACHE + "/failures-step2.json", "utf8"))); } catch {}

function cached(slug: string): boolean {
  try { return fs.statSync(`${CDIR}/${slug}.json`).size > 500; } catch { return false; }
}

let done = 0, failed = 0;
const queue = inv.filter((c) => !cached(c.slug));
console.log(`cached: ${inv.length - queue.length}/${inv.length}, to fetch: ${queue.length}`);

const WORKERS = 6;
async function worker(ids: number) {
  for (;;) {
    const c = queue.shift();
    if (!c) return;
    try {
      const txt = await mcp("library_get_concept", { slug: c.slug });
      const j = JSON.parse(txt);
      fs.writeFileSync(`${CDIR}/${c.slug}.json`, JSON.stringify(j, null, 1));
      done++;
    } catch (e: any) {
      failed++;
      failures.push({ slug: c.slug, error: String(e?.message ?? e).slice(0, 300) });
    }
    if ((done + failed) % 50 === 0) console.log(`progress ${done} ok, ${failed} fail, ${queue.length} left`);
  }
}
await Promise.all(Array.from({ length: WORKERS }, (_, i) => worker(i)));
fs.writeFileSync(CACHE + "/failures-step2.json", JSON.stringify(failures, null, 1));
console.log(`DONE ok=${done} fail=${failed}`);

// ---- rank tradeable candidates ----
const TRADE_HEAD = /trading method|how traders use|how it.?s traded|strategy|strategies|entry|entries|exit|stop.?loss|take.?profit|setup|signal/i;
const RULE_WORD = /\b(entry|entries|enter long|enter short|exit|stop-loss|stop loss|take-profit|take profit|buy when|sell when|go long|go short|position)\b/i;
const EXCLUDE = /^(what is a wick|candlestick anatomy|anatomy of|glossary|history of)/i;

type Cand = { slug: string; name: string; family: string; url: string; score: number; why: string[] };
const cands: Cand[] = [];
for (const c of inv) {
  let j: any;
  try { j = JSON.parse(fs.readFileSync(`${CDIR}/${c.slug}.json`, "utf8")); } catch { continue; }
  const md: string = j.content_markdown ?? "";
  if (!md || md.length < 800) continue;
  if (EXCLUDE.test(j.name ?? "")) continue;
  const why: string[] = [];
  let score = 0;
  const heads = md.match(/^#{1,4}\s+.*$/gm) ?? [];
  for (const h of heads) {
    if (/trading method|how traders use|strategy|strategies|trading.*(setup|signal|rules?)/i.test(h)) { score += 5; why.push("head:" + h.slice(0, 60)); }
    else if (/how it.?s calculated|calculation|formula/i.test(h)) score += 0;
  }
  const hasEntry = /\bentry\b/i.test(md), hasExit = /\bexit\b/i.test(md);
  const hasSL = /stop.?loss/i.test(md), hasTP = /take.?profit/i.test(md);
  if (hasEntry) { score += 3; why.push("entry"); }
  if (hasExit) { score += 3; why.push("exit"); }
  if (hasSL) { score += 2; why.push("sl"); }
  if (hasTP) { score += 2; why.push("tp"); }
  if (/strategy\.entry|strategy\.exit/i.test(md)) { score += 4; why.push("pine-strategy"); }
  if (/buy when|sell when|go long|go short|enter long|enter short/i.test(md)) { score += 2; why.push("explicit-signal"); }
  if (!RULE_WORD.test(md)) score -= 5;
  // families unlikely to be tradeable on their own
  if (["statistics", "machine-learning", "validation"].includes(c.family)) score -= 4;
  if (c.family === "risk-exits" && /kelly|optimal f|risk of ruin|martingale|fixed ratio|fixed fractional/i.test(j.name ?? "")) { score -= 3; why.push("sizing-not-setup"); }
  if (score >= 5) cands.push({ slug: c.slug, name: j.name ?? c.slug, family: c.family, url: j.url ?? "", score, why });
}
cands.sort((a, b) => b.score - a.score);
fs.writeFileSync(CACHE + "/candidates.json", JSON.stringify(cands, null, 1));
console.log("CANDIDATES:", cands.length);
for (const c of cands.slice(0, 80)) console.log(`${c.score} ${c.family}/${c.slug} [${c.why.join(",")}]`);
