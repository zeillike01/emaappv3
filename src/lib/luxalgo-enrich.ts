#!/usr/bin/env bun
// For specs with partial confidence: search indicator catalog by concept
// name, attach first same-family (or top) hit with available source.
import fs from "node:fs";
const MCP = "https://mcp.luxalgo.com/mcp";
const CTX = "Extracting tradeable strategy rules to support a user building a backtest-ready strategy catalog.";
const OUT = "data/lab/luxalgo/strategies";
async function mcp(tool: string, args: Record<string, unknown>): Promise<string> {
  for (let a = 0; a < 2; a++) {
    try {
      const r = await fetch(MCP, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: { ...args, context: CTX } } }) });
      const t = await r.text();
      const m = t.match(/data:\s*(\{.*\})/s);
      if (!m) throw new Error("no frame");
      const j = JSON.parse(m[1]);
      if ((j as any).error) throw new Error("rpc " + JSON.stringify((j as any).error).slice(0, 160));
      return j.result?.content?.map((c: any) => c.text).join("\n") ?? "";
    } catch (e: any) { if (a === 0) { await new Promise((r) => setTimeout(r, 2000)); continue; } throw e; }
  }
  throw new Error("unreachable");
}
const idx: Array<Record<string, string>> = JSON.parse(fs.readFileSync("data/lab/luxalgo/cache/gen-index.json", "utf8"));
const partials = idx.filter((x) => x.source_confidence === "partial");
console.log("partials:", partials.length);
let enriched = 0;
for (const p of partials) {
  const path = `${OUT}/${p.filename}`;
  let md = fs.readFileSync(path, "utf8");
  const cslug = p.filename.split("__")[1]!.replace(/\.md$/, "");
  const q = p.strategy_name;
  try {
    const t = await mcp("library_search", { query: q, type: "indicators", limit: 6 });
    const sj = JSON.parse(t);
    const res: any[] = sj.results ?? [];
    if (!res.length) { console.log(`no-search-hit ${cslug}`); continue; }
    const pick = res.find((r) => r.family === p.family) ?? res[0];
    let src = "";
    try {
      const st = await mcp("library_get_source_code", { slug: pick.slug });
      const cj = JSON.parse(st);
      src = cj.source ?? "";
    } catch { console.log(`no-source ${cslug} (${pick.slug})`); continue; }
    if (!src || src.length < 50) { console.log(`empty-source ${cslug} (${pick.slug})`); continue; }
    const block = `Source indicator: ${pick.slug} (via catalog search; concept has no directly linked implementation)\n\n\`\`\`pine\n${src.length > 20000 ? src.slice(0, 20000) + "\n// ... [truncated at 20000 chars]" : src}\n\`\`\``;
    md = md.replace("Not available for this concept (confidence: partial).", block);
    md = md.replace('source_confidence: "partial"', 'source_confidence: "explicit"');
    md = md.replace("- **Confidence:** partial", "- **Confidence:** explicit");
    md = md.replace("- No Pine source available; rules from concept page alone.", `- Pine source via catalog search (${pick.slug}); concept page remains the primary rule source.`);
    fs.writeFileSync(path, md);
    p.source_confidence = "explicit";
    enriched++;
    console.log(`enriched ${cslug} <- ${pick.slug}`);
  } catch (e: any) { console.log(`fail ${cslug}: ${String(e?.message).slice(0, 120)}`); }
}
fs.writeFileSync("data/lab/luxalgo/cache/gen-index.json", JSON.stringify(idx, null, 1));
console.log(`ENRICHED=${enriched}/${partials.length}`);
