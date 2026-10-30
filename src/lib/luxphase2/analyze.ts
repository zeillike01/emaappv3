#!/usr/bin/env bun
// Phase-2 analysis: per-strategy profiles, family insights, failure modes.
import fs from "node:fs";
// Optional argv overrides for re-runs on other datasets (defaults = Phase 2 paths).
// Usage: bun run src/lib/luxphase2/analyze.ts [resultsDir] [analysisDir]
const RES = process.argv[2] ?? "data/lab/luxalgo/results";
const AN = process.argv[3] ?? "data/lab/luxalgo/analysis";
fs.mkdirSync(AN, { recursive: true });
type M = Record<string, any>;
const files = fs.readdirSync(RES).filter((f) => /__.*\.json$/.test(f) && !f.startsWith("_") && !f.includes("regime_breakdown"));
const byStrat: Record<string, M[]> = {};
for (const f of files) {
  const j = JSON.parse(fs.readFileSync(`${RES}/${f}`, "utf8"));
  if (!j.strategy) continue;
  (byStrat[j.strategy] ??= []).push(j);
}
// regime aggregates per strategy
const regOf = (s: string, coin: string) => JSON.parse(fs.readFileSync(`${RES}/${s}__${coin}_regime_breakdown.json`, "utf8"));
const REGS = ["trend_up", "trend_down", "ranging", "high_vol", "low_vol", "neutral"];
const engCfg = JSON.parse(fs.readFileSync(`${RES}/_engine_config.json`, "utf8"));
let md = `# Strengths & Weaknesses (1H)\n\nWindow ${engCfg.windowStart} -> ${engCfg.windowEnd}, ${engCfg.coins.length} coins (${engCfg.coins.join(", ")}), fees+slippage 0.05%/side, 1% risk/trade.\n\n## 5a. Per-strategy profiles\n\n`;
const prof: Record<string, any> = {};
for (const [s, runs] of Object.entries(byStrat)) {
  const tot = runs.reduce((a, r) => a + r.total_return_pct, 0) / runs.length;
  const nt = runs.reduce((a, r) => a + r.num_trades, 0);
  const dd = Math.max(...runs.map((r) => r.max_drawdown_pct));
  const sharpe = runs.reduce((a, r) => a + r.sharpe, 0) / runs.length;
  // regime PF/TR totals
  const rg: Record<string, { t: number; w: number; gw: number; gl: number; ret: number }> = {};
  for (const r of runs) {
    const bd = regOf(s, r.coin);
    for (const g of REGS) {
      rg[g] ??= { t: 0, w: 0, gw: 0, gl: 0, ret: 0 };
      const b = bd[g];
      rg[g].t += b.trades;
      rg[g].w += (b.win_rate_pct / 100) * b.trades;
      rg[g].ret += b.total_return_pct;
    }
  }
  // PF per regime needs gw/gl — recompute from breakdown? breakdown lacks gw; use ret/trades proxy + totals from metrics
  const order = [...REGS].sort((a, b2) => rg[b2].ret - rg[a].ret);
  const best = order[0], worst = order[order.length - 1];
  const byCoin = [...runs].sort((a, b2) => b2.sharpe - a.sharpe);
  const posRegs = REGS.filter((g) => rg[g].ret > 0 && rg[g].t >= 10).length;
  const flag = nt < 30 ? "Fragile" : dd > 50 ? "Fragile" : posRegs >= 3 && tot > 0 ? "Robust" : posRegs >= 2 ? "Regime-dependent" : "Fragile";
  prof[s] = { tot, nt, dd, sharpe, best, worst, flag, fam: runs[0].family };
  const wr = (g: string) => (rg[g].t ? ((100 * rg[g].w) / rg[g].t).toFixed(1) : "—");
  md += `### ${s} (${runs[0].family}) — ${flag}\n`;
  md += `- Avg return/coin: ${tot.toFixed(2)}% · trades: ${nt} · worst-coin DD: ${dd.toFixed(1)}% · avg Sharpe: ${sharpe.toFixed(2)}\n`;
  md += `- Best regime: ${best} (ret ${rg[best].ret.toFixed(1)}%, WR ${wr(best)}%, n=${rg[best].t}) · Worst: ${worst} (ret ${rg[worst].ret.toFixed(1)}%, WR ${wr(worst)}%, n=${rg[worst].t})\n`;
  md += `- Best coin: ${byCoin[0].coin} (Sharpe ${byCoin[0].sharpe}) · Worst: ${byCoin[byCoin.length - 1].coin} (Sharpe ${byCoin[byCoin.length - 1].sharpe})\n`;
  const strengths: string[] = [], weak: string[] = [];
  if (rg.trend_up.ret > 0) strengths.push("earns in trending-up markets");
  if (rg.trend_down.ret > 0) strengths.push("earns in trending-down markets");
  if (rg.ranging.ret > 0) strengths.push("holds up while ranging");
  if (rg.high_vol.ret > 0) strengths.push("survives high-volatility bars");
  if (dd < 15) strengths.push("contained drawdowns");
  if (rg.trend_up.ret <= 0 && rg.trend_down.ret <= 0) weak.push("loses in both trend directions");
  if (rg.ranging.ret <= 0) weak.push("bleeds in ranges");
  if (rg.high_vol.ret <= 0) weak.push("bleeds in high volatility");
  if (nt < 100) weak.push(`thin sample (${nt} trades stack-wide)`);
  if (dd > 30) weak.push(`deep drawdowns (worst ${dd.toFixed(0)}%)`);
  md += `- Strengths: ${strengths.length ? strengths.join("; ") : "none identified"}\n`;
  md += `- Weaknesses: ${weak.length ? weak.join("; ") : "none identified"}\n\n`;
}
fs.writeFileSync(`${AN}/strengths_weaknesses.md`, md);
fs.writeFileSync(`${AN}/_profiles.json`, JSON.stringify(prof, null, 1));
// 5b family insights
const fam = JSON.parse(fs.readFileSync(`${RES}/family_summary.json`, "utf8"));
let fmd = "## 5b. Family-level insights\n\n";
for (const [f, v] of Object.entries<any>(fam).sort((a, b) => b[1].avg_total_return_pct - a[1].avg_total_return_pct)) {
  fmd += `- ${f}: avgRet ${v.avg_total_return_pct}% · avgDD ${v.avg_max_drawdown_pct}% · avgWR ${v.avg_win_rate_pct}% · avgPF ${v.avg_profit_factor} · avgN ${v.avg_num_trades}\n`;
}
fs.writeFileSync(`${AN}/family_insights.md`, fmd);
// 5c failure modes
const all = Object.entries(prof);
const losers = all.filter(([_, p]) => p.tot <= 0).map(([s]) => s);
const thin = all.filter(([_, p]) => p.nt < 30).map(([s]) => s);
const blew = all.filter(([_, p]) => p.dd > 50).map(([s]) => s);
const oneReg = all.filter(([s, p]) => {
  void s;
  return p.flag === "Fragile" && p.nt >= 30;
}).map(([s]) => s);
const fail = `# Failure modes\n\n- Lost money on average across coins (${losers.length}): ${losers.join(", ")}\n- Fewer than 30 trades stack-wide (${thin.length}): ${thin.join(", ")}\n- Blew up, worst-coin maxDD > 50% (${blew.length}): ${blew.join(", ")}\n- Fragile with adequate sample (${oneReg.length}): ${oneReg.join(", ")}\n`;
fs.writeFileSync(`${AN}/failure_modes.md`, fail);
console.log(`robust=${all.filter(([_, p]) => p.flag === "Robust").length} regime-dep=${all.filter(([_, p]) => p.flag === "Regime-dependent").length} fragile=${all.filter(([_, p]) => p.flag === "Fragile").length}`);
console.log("losers:", losers.length, "thin:", thin.length, "blew:", blew.length);
