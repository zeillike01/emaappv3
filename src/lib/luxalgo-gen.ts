#!/usr/bin/env bun
// Generates one backtest-ready markdown spec per curated LuxAlgo concept.
// Honest extraction: verbatim rule bullets; "not specified" where absent.
import fs from "node:fs";
const MCP = "https://mcp.luxalgo.com/mcp";
const CTX = "Extracting tradeable strategy rules to support a user building a backtest-ready strategy catalog.";
const CACHE = "data/lab/luxalgo/cache";
const OUT = "data/lab/luxalgo/strategies";
fs.mkdirSync(OUT, { recursive: true });
async function mcp(tool: string, args: Record<string, unknown>): Promise<string> {
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
  throw new Error("unreachable");
}
const SLUGS: string[] = JSON.parse(fs.readFileSync(CACHE + "/shortlist.json", "utf8"));
const strip = (s: string) => s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/\s+/g, " ").trim();
const esc = (s: string) => s.replace(/"/g, "'");
function section(md: string, re: RegExp): string {
  const m = md.match(re);
  return (m?.[1] ?? "").trim();
}
function bullets(sec: string): string[] {
  return sec.split("\n").map((l) => l.trim()).filter((l) => /^[-*]\s+/.test(l)).map((l) => strip(l.replace(/^[-*]\s+/, "")));
}
const failures: Array<{ slug: string; error: string }> = [];
const index: Array<Record<string, string>> = [];
let tier1 = 0, tier2 = 0, explicit = 0, partial = 0, excluded = 0;
async function one(slug: string) {
  let j: any;
  try { j = JSON.parse(fs.readFileSync(`${CACHE}/concepts/${slug}.json`, "utf8")); }
  catch (e: any) { failures.push({ slug, error: "concept cache missing: " + String(e?.message).slice(0, 160) }); return; }
  const md: string = j.content_markdown ?? "";
  const name: string = j.name ?? slug;
  const family: string = j.family ?? "unknown";
  const url: string = j.url ?? `https://www.luxalgo.com/library/concept/${slug}/`;
  const useIt = section(md, /## How traders use it([\s\S]*?)(?=\n## |\n# |$)/);
  const calc = section(md, /## How (?:it'?s calculated|to calculate [\s\S]*?)(?=\n## |\n# |$)/);
  const calc2 = section(md, /## How to calculate[\s\S]*?(?=\n## |\n# |$)/);
  const all = bullets(useIt);
  if (!all.length) { excluded++; failures.push({ slug, error: "excluded: no tradeable rule bullets in concept page" }); return; }
  const hasL = (s: string) => /\b(long|longs|buy|buying|bullish|cover)\b/i.test(s);
  const hasS = (s: string) => /\b(short|shorts|sell|selling|bearish)\b/i.test(s);
  const joined = all.join(" ");
  const direction = hasL(joined) && hasS(joined) ? "Both" : hasL(joined) ? "Long" : hasS(joined) ? "Short" : "not specified";
  const lScore = (b: string) => (b.match(/\b(long|longs|buy|buying|bullish|dip|support|bounce|higher|uptrend|uptrends)\b/gi) ?? []).length;
  const sScore = (b: string) => (b.match(/\b(short|shorts|sell|selling|bearish|rally|rallies|resistance|fade|fades|lower|downtrend|downtrends|mirror|mirrored|mirror)\b/gi) ?? []).length;
  const sidePick = (bs: string[], want: "L" | "S") => bs.filter((b) => want === "L" ? lScore(b) >= sScore(b) : sScore(b) > lScore(b)).slice(0, 3);
  const entryB = all.filter((b) => /entr|enter|buy |sell |trigger|signal|cross|break|close (above|below|through|back)|pop |hook|stretch|rall|fade|mirror|dip|pullback|reclaim|hold|bounce|tag |touch|rejection|confirm|fade-the|joining|join |fire|fires/i.test(b)).slice(0, 5);
  const exitB = all.filter((b) => /exit|close|target|stop|trail|reverse|flip|invalidation|fail|hold|scale out|take profit/i.test(b)).slice(0, 4);
  const entrySrc = entryB.length ? entryB : all.slice(0, 3);
  const exitSrc = exitB.length ? exitB : [];
  const longPick = sidePick(entrySrc, "L"), shortPick0 = sidePick(entrySrc, "S");
  const shortPick = shortPick0.length ? shortPick0 : entrySrc.filter((b) => sScore(b) > 0).slice(0, 3);
  const entry_long = direction === "Short" ? "not specified" : (longPick.length ? longPick : entrySrc.slice(0, 3)).map((b) => `- ${b}`).join("\n") || "not specified";
  const entry_short = direction === "Long" ? "not specified" : shortPick.length ? shortPick.map((b) => `- ${b}`).join("\n") : "not specified (mirror of long rules; source describes long side explicitly)";
  const exit_long = exitSrc.filter((b) => !hasS(b) || hasL(b)).slice(0, 3).map((b) => `- ${b}`).join("\n") || (exitSrc.length ? exitSrc.slice(0, 3).map((b) => `- ${b}`).join("\n") : "not specified");
  const exit_short = exitSrc.filter(hasS).slice(0, 3).map((b) => `- ${b}`).join("\n") || (direction === "Long" ? "not specified" : exitSrc.length ? exitSrc.slice(0, 3).map((b) => `- ${b}`).join("\n") : "not specified");
  const slB = all.filter((b) => /stop|invalidation|beyond|behind|atr/i.test(b)).slice(0, 2);
  const tpB = all.filter((b) => /take-?profit|profit target|measured move|projection|reward-to-risk|R multiple|second target/i.test(b)).slice(0, 2);
  const tmB = all.filter((b) => /trail|breakeven|scale|partial|add |pyramid|time |stall/i.test(b)).slice(0, 2);
  const stop_loss = slB.length ? slB.map((b) => `- ${b}`).join("\n") : "not specified";
  const take_profit = tpB.length ? tpB.map((b) => `- ${b}`).join("\n") : "not specified";
  const trade_management = tmB.length ? tmB.map((b) => `- ${b}`).join("\n") : "not specified";
  const tfm = md.match(/\b(intraday|day-trading|daily|weekly|monthly|higher timeframe|multi-timeframe|scalping|swing trading|position trading)\b/i);
  const timeframe = tfm ? strip(tfm[0]) + " (as referenced; default to 1H for backtest)" : "not specified";
  const sessm = useIt.match(/\b(killzones?|trading sessions?|session (high|low|range|vwap)|London|New York|Asian session|RTH|ETH|regular trading hours|overnight|opening range)[^.]{0,100}/i);
  const session_filter = sessm ? strip(sessm[0]).slice(0, 220) : "not specified";
  const assetm = (md.slice(0, 1500) + " " + useIt).match(/\b(forex|stocks?|equities|crypto|futures|options|indices)\b/i);
  const asset_class = assetm ? strip(assetm[0]).slice(0, 60) : "not specified";
  const posm = md.match(/(position siz[^.]{0,120}|risk [^.]{0,80}|% risk[^.]{0,60})/i);
  const position_sizing = posm ? strip(posm[0]).slice(0, 200) : "not specified";
  // indicators + source
  let indNames = name, indSlug = "";
  try {
    const t = await mcp("library_list_indicators", { concept: slug, page_size: 5 });
    const lj = JSON.parse(t);
    if (lj.indicators?.length) { indNames = lj.indicators.slice(0, 3).map((x: any) => x.name).join("; "); indSlug = lj.indicators[0].slug; }
  } catch (e: any) { failures.push({ slug, error: "indicators fetch failed: " + String(e?.message).slice(0, 160) }); }
  let pine = "", hasSrc = false;
  if (indSlug) {
    try {
      const t = await mcp("library_get_source_code", { slug: indSlug });
      const sj = JSON.parse(t);
      pine = sj.source ?? sj.source_code ?? sj.code ?? "";
      if (pine && pine.length > 50) hasSrc = true;
      else failures.push({ slug, error: `source empty for indicator ${indSlug}` });
    } catch (e: any) { failures.push({ slug, error: `source fetch failed (${indSlug}): ` + String(e?.message).slice(0, 160) }); }
  } else failures.push({ slug, error: "no indicator found for concept" });
  const praw = (calc + " " + calc2 + " " + md.slice(0, 4000)).match(/\b\d{1,3}(?:\.\d+)?\s*(?:period|bar|day|week|month|length|lookback)[^.]{0,60}|ATR\(\d+\)|\b(?:50|100|200)[- ]day|multiplier[^.]{0,40}\d[\d.]*/gi);
  const puniq = [...new Set((praw ?? []).map((x: string) => strip(x).toLowerCase()))];
  const indicator_parameters = puniq.length ? strip(puniq.slice(0, 2).join("; ")).slice(0, 300) : "not specified";
  const tier = entry_long !== "not specified" && exit_long !== "not specified" && (stop_loss !== "not specified" || take_profit !== "not specified" || trade_management !== "not specified") ? "Tier 1" : "Tier 2";
  if (tier === "Tier 1") tier1++; else tier2++;
  const confidence = hasSrc ? "explicit" : "partial";
  if (hasSrc) explicit++; else partial++;
  const dirOut = direction === "not specified" ? "Both" : direction;
  const notes: string[] = [];
  if (direction === "not specified") notes.push("Direction not stated in source; spec defaults to Both for backtestability.");
  const missing: string[] = [];
  if (asset_class === "not specified") missing.push("asset class");
  if (timeframe === "not specified") missing.push("timeframe");
  if (indicator_parameters === "not specified") missing.push("indicator parameters");
  if (session_filter === "not specified") missing.push("session filter");
  if (take_profit === "not specified") missing.push("take-profit");
  if (trade_management === "not specified") missing.push("trade management");
  if (missing.length) notes.push(`Fields marked "not specified" (${missing.join(", ")}) are absent from the source; see Backtest Assumptions for testable placeholders.`);
  if (entry_short.startsWith("not specified (mirror")) notes.push("Short rules mirrored from long description; source details long side.");
  if (!hasSrc) notes.push("No Pine source available; rules from concept page alone.");
  if (stop_loss === "not specified") notes.push("No explicit stop-loss; Backtest Assumptions supply 1.5xATR(14).");
  if (take_profit === "not specified") notes.push("No explicit take-profit; Backtest Assumptions supply 2R.");
  if (timeframe === "not specified") notes.push("No timeframe stated; Backtest Assumptions default to 1H.");
  if (position_sizing === "not specified") notes.push("No sizing rule; Backtest Assumptions use 1% risk/trade.");
  const needAssump = [stop_loss, take_profit, timeframe, position_sizing].some((v) => v === "not specified");
  const assump = needAssump ? `\n## Backtest Assumptions\n> Placeholder values ONLY - not part of the source strategy.\n\n- Timeframe: 1H\n- Stop Loss: 1.5 x ATR(14)${stop_loss === "not specified" ? " (assumed)" : " (fallback where source silent)"}\n- Take Profit: 2 x risk${take_profit === "not specified" ? " (assumed)" : " (fallback)"}\n- Position Sizing: 1% account risk per trade (assumed)\n- Fees/Slippage: 0.05% per side (assumed)\n` : `\n## Backtest Assumptions\n> Source specifies core risk fields; standard backtest overheads only.\n\n- Fees/Slippage: 0.05% per side (assumed)\n`;
  const pineBlock = hasSrc ? `\n## Pine Script Source (if available)\nSource indicator: ${indSlug}\n\n\`\`\`pine\n${pine.length > 20000 ? pine.slice(0, 20000) + "\n// ... [truncated at 20000 chars; full source via library_get_source_code]" : pine}\n\`\`\`\n` : `\n## Pine Script Source (if available)\nNot available for this concept (confidence: partial).\n`;
  const file = `---\nstrategy_name: "${esc(name)}"\nslug: "${slug}"\nfamily: "${family}"\nsource_url: "${url}"\nquality_tier: "${tier}"\ndirection: "${dirOut}"\nsource_confidence: "${confidence}"\n---\n\n# ${name}\n\n## Source\n- **Library URL:** ${url}\n- **Family:** ${family}\n- **Quality Tier:** ${tier}\n- **Confidence:** ${confidence}\n\n## Specification\n\n| Field | Value |\n|---|---|\n| Direction | ${dirOut} |\n| Asset Class | ${asset_class} |\n| Timeframe | ${timeframe} |\n| Indicators | ${esc(indNames).slice(0, 300)} |\n| Parameters | ${esc(indicator_parameters)} |\n\n## Entry Rules\n\n**Long:**\n${entry_long}\n\n**Short:**\n${entry_short}\n\n## Exit Rules\n\n**Long:**\n${exit_long}\n\n**Short:**\n${exit_short}\n\n## Risk Management\n\n- **Stop Loss:**\n${stop_loss}\n- **Take Profit:**\n${take_profit}\n- **Trade Management:**\n${trade_management}\n- **Position Sizing:**\n${position_sizing}\n\n## Filters\n- **Session:** ${session_filter}\n\n## Data Requirements\nOHLCV bars on the traded timeframe${session_filter === "not specified" ? "" : " with session timestamps"}; volume where referenced.\n${assump}\n## Extraction Notes\n${notes.map((n) => `- ${n}`).join("\n")}\n${pineBlock}`;
  fs.writeFileSync(`${OUT}/${family}__${slug}.md`, file);
  index.push({ filename: `${family}__${slug}.md`, strategy_name: name, family, quality_tier: tier, direction: dirOut, source_confidence: confidence });
  console.log(`${tier} ${confidence} ${family}/${slug}`);
}
// batches of 10: write files per batch before continuing
for (let i = 0; i < SLUGS.length; i += 10) {
  await Promise.all(SLUGS.slice(i, i + 10).map(one));
  console.log(`--- batch ${i / 10 + 1} done (${Math.min(i + 10, SLUGS.length)}/${SLUGS.length}) ---`);
}
fs.writeFileSync(CACHE + "/gen-index.json", JSON.stringify(index, null, 1));
fs.writeFileSync(CACHE + "/gen-failures.json", JSON.stringify(failures, null, 1));
console.log(`\nTIER1=${tier1} TIER2=${tier2} EXPLICIT=${explicit} PARTIAL=${partial} EXCLUDED=${excluded} FAILS=${failures.length}`);
