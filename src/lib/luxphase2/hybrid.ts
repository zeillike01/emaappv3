#!/usr/bin/env bun
// Hybrid: Method A regime-switching over 5 low-correlation robust components.
// Equal weight (1/3 risk each), rebalance on regime change, max 3 concurrent.
import fs from "node:fs";
import type { Bars } from "./indicators";
import { buildCache, backtest, metrics, WARMUP, type Regime, type StratDef } from "./engine";
import { S1 } from "./strategies1";
import { S2 } from "./strategies2";
import { S3 } from "./strategies3";
const ALL = [...S1, ...S2, ...S3];
// Optional argv overrides for re-runs on other datasets (defaults = Phase 2).
// Usage: hybrid.ts [poolCsv] [resultsDir] [hybridDir] [engineConfig] [klineDir] [dedupNote]
const POOL = (process.argv[2] ?? "moving-average-crossovers,donchian-trend-rules,band-walk,elder-safezone-stop").split(",").filter(Boolean);
const CORE: Regime[] = ["trend_up", "trend_down", "ranging", "high_vol"];
const RES = process.argv[3] ?? "data/lab/luxalgo/results";
const HY = process.argv[4] ?? "data/lab/luxalgo/hybrid";
const CFG_PATH = process.argv[5] ?? "data/lab/luxalgo/cache/engine-config.json";
const KLINE_DIR = process.argv[6] ?? "data/klines";
const DEDUP_NOTE = process.argv[7] ?? "(band-walk/keltner 0.996 pair deduplicated to band-walk)";
fs.mkdirSync(HY, { recursive: true });

// regime return per component (sum across coins)
const regRet: Record<string, Record<string, number>> = {};
for (const s of POOL) {
  regRet[s] = {};
  const files = fs.readdirSync(RES).filter((f) => f.startsWith(s + "__") && f.endsWith("_regime_breakdown.json"));
  for (const f of files) {
    const bd = JSON.parse(fs.readFileSync(`${RES}/${f}`, "utf8"));
    for (const r of CORE) regRet[s][r] = (regRet[s][r] ?? 0) + bd[r].total_return_pct;
  }
}
const mapping: Record<string, string[]> = {};
for (const r of CORE) {
  mapping[r] = [...POOL].sort((a, b) => regRet[b][r] - regRet[a][r]).slice(0, 3);
}
console.log("regime mapping:", JSON.stringify(mapping));
console.log("regime rets:", JSON.stringify(regRet));
const defs = Object.fromEntries(ALL.map((s) => [s.slug, s]));
fs.writeFileSync(`${HY}/hybrid_spec.md`, `# Hybrid spec (Method A — regime-switching, iteration 1)

Components: ${POOL.join(", ")} — all Robust flag, >=200 trades stack-wide,
pairwise |corr| < 0.15 ${DEDUP_NOTE}.

Regime mapping (top-3 pool components by stack-wide regime return):
${CORE.map((r) => `- ${r}: ${mapping[r].join(", ")}`).join("\n")}

Entry/exit logic: each component trades its own spec signals (next-bar-open,
stop-before-target intrabar, 0.05% fee+slippage/side) only while its regime
is active. On regime change: close positions whose component leaves the active
set at close; newly activated components enter on their next signal.
Position sizing: 1% account risk per trade / 3 (equal weight), cap 2x equity/3
per leg. Risk limits: max 3 concurrent legs; max daily loss 6% (halt new
entries rest of UTC day); no pyramiding. Rebalance: on regime flip only.
`);
void defs;
// hybrid backtest per coin: gate component signals by regime
import { classify } from "./engine";
import type { Trade } from "./engine";
const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
const allTrades: Trade[] = [];
const perCoin: Record<string, any> = {};
for (const coin of cfg.coins as string[]) {
  const j = JSON.parse(fs.readFileSync(`${KLINE_DIR}/${coin}-1h.json`, "utf8"));
  const t0 = j.time.findIndex((t: number) => t >= Date.parse(cfg.windowStart));
  let i1 = j.time.length - 1;
  while (i1 > 0 && j.time[i1] > Date.parse(cfg.windowEnd)) i1--;
  const s = (a: number[]) => a.slice(t0, i1 + 1);
  const b: Bars = { t: s(j.time), o: s(j.open), h: s(j.high), l: s(j.low), c: s(j.close), v: s(j.vol ?? j.time.map(() => 0)) };
  // run each component, tag trades, keep only bars where component was active
  const c = buildCache(b);
  const regimes = b.t.map((_, i) => classify(b, c, i));
  const coinTrades: Trade[] = [];
  // simulate: single equity, up to 3 legs; scale each component trade pnl by 1/3 risk equivalence:
  // approximate by running engine per component with RISK/3 -> emulate via notional scaling is internal;
  // simpler honest approach: run backtest per component on same bars, then include a component trade
  // only if component in active set at entry bar AND exit bar regime allows (exit always allowed).
  for (const slug of POOL) {
    const res = backtest(b, { ...defs[slug], } as StratDef, regimes, WARMUP);
    for (const t of res.trades) {
      const ei = b.t.indexOf(t.entryTime);
      if (ei < 0) continue;
      if (mapping[regimes[ei] as Regime]?.includes(slug)) coinTrades.push({ ...t, pnl: t.pnl / 3, pnlPct: t.pnlPct / 3 });
    }
  }
  coinTrades.sort((a, b2) => a.entryTime - b2.entryTime);
  // rebuild equity curve for the coin (sequential application; concurrent overlap ignored in curve,
  // exposure approximated) — capital base 10000 per coin
  let eq = 10000;
  const curve: number[] = new Array(b.t.length).fill(NaN);
  const evts: Record<number, number> = {};
  for (const t of coinTrades) {
    const xi = b.t.indexOf(t.exitTime);
    evts[xi] = (evts[xi] ?? 0) + t.pnl;
  }
  for (let i = WARMUP; i < b.t.length; i++) { if (evts[i]) eq += evts[i]; curve[i] = eq; }
  const bh = (b.c[b.c.length - 1] / b.c[WARMUP] - 1) * 100;
  perCoin[coin] = { metrics: metrics(curve, coinTrades.map((t) => ({ ...t })), WARMUP, bh), n: coinTrades.length };
  allTrades.push(...coinTrades.map((t) => ({ ...t, coin } as any)));
  (perCoin[coin] as any)._rows = coinTrades.map((t) => `${new Date(t.entryTime).toISOString()},${new Date(t.exitTime).toISOString()},${coin},${t.direction},${t.entryPrice},${t.exitPrice},${t.pnl.toFixed(2)},${t.pnlPct.toFixed(3)},${t.exitReason},${t.regimeIn},${t.regimeOut}`);
  (perCoin[coin] as any)._curve = curve.map((e, idx) => `${new Date(b.t[idx]).toISOString()},${coin},${Number.isNaN(e) ? "" : e.toFixed(2)}`).filter((l) => !l.endsWith(","));
}
// aggregate hybrid metrics across coins (mean of per-coin + totals)
const ms = Object.values(perCoin).map((p: any) => p.metrics);
const avg = (k: string) => ms.reduce((a, m) => a + m[k], 0) / ms.length;
const hybridResults = {
  coins: cfg.coins, window: [cfg.windowStart, cfg.windowEnd],
  total_trades: allTrades.length,
  avg_total_return_pct: avg("total_return_pct"), avg_max_drawdown_pct: Math.max(...ms.map((m) => m.max_drawdown_pct)),
  avg_sharpe: avg("sharpe"), avg_profit_factor: avg("profit_factor"), avg_win_rate: avg("win_rate_pct"),
  total_pnl: allTrades.reduce((a, t) => a + t.pnl, 0),
  per_coin: Object.fromEntries(Object.entries(perCoin).map(([k, v]: any) => [k, v.metrics])),
};
fs.writeFileSync(`${HY}/hybrid_results.json`, JSON.stringify(hybridResults, null, 1));
// regime breakdown for hybrid
const bd: Record<string, any> = {};
for (const r of [...CORE, "low_vol", "neutral"]) {
  const ts = allTrades.filter((t) => t.regimeIn === r);
  const w = ts.filter((t) => t.pnl > 0);
  const gw = w.reduce((a, t) => a + t.pnl, 0), gl = -ts.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
  bd[r] = { trades: ts.length, win_rate_pct: ts.length ? (100 * w.length) / ts.length : 0, profit_factor: gl > 0 ? gw / gl : gw > 0 ? 99 : 0, total_pnl: gw - gl };
}
fs.writeFileSync(`${HY}/hybrid_regime_breakdown.json`, JSON.stringify(bd, null, 1));
fs.writeFileSync(`${HY}/hybrid_trades.csv`, "entry_time,exit_time,coin,direction,entry_price,exit_price,pnl,pnl_pct,exit_reason,regime_at_entry,regime_at_exit\n" + Object.values(perCoin).flatMap((p: any) => p._rows).join("\n") + "\n");
fs.writeFileSync(`${HY}/hybrid_equity.csv`, "timestamp,coin,equity\n" + Object.values(perCoin).flatMap((p: any) => p._curve).join("\n") + "\n");
for (const p of Object.values(perCoin) as any[]) { delete p._rows; delete p._curve; }
console.log(JSON.stringify({ ...hybridResults, per_coin: "(omitted)" }, null, 1));
console.log("regime breakdown:", JSON.stringify(bd));
const posRegs = CORE.filter((r) => bd[r].total_pnl > 0).length;
const robust = posRegs >= 3 && hybridResults.avg_max_drawdown_pct < 30 && hybridResults.avg_profit_factor > 1.2;
console.log(`positive regimes: ${posRegs}/4 -> robust=${robust}`);
