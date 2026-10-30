#!/usr/bin/env bun
// Hybrid FORWARD TEST — true out-of-sample replay on data the backtest never saw.
//
// The in-sample window ended 2026-09-12 (see cache/engine-config.json). The
// cache has since been extended to today via /api/forward-klines. This script
// runs the FROZEN hybrid spec (same 5 components, same regime mapping derived
// from in-sample results, same execution model) over the full per-coin history
// but counts ONLY trades entered on/after the in-sample window end.
//
// Indicator continuity is preserved (cache/regimes computed over full history;
// warmup identical to Phase 2), so the OOS attribution is exact — the closest
// offline analogue to Layer 2's live paper book, at zero cron/Convex cost.
import fs from "node:fs";
import type { Bars } from "./indicators";
import { buildCache, classify, backtest, metrics, WARMUP, type Regime, type StratDef, type Trade } from "./engine";
import { S1 } from "./strategies1";
import { S2 } from "./strategies2";
import { S3 } from "./strategies3";
import { LAYER1_PAIRS } from "../tracked-pairs";

const ALL = [...S1, ...S2, ...S3];
const defs = Object.fromEntries(ALL.map((s) => [s.slug, s]));
const POOL = ["moving-average-crossovers", "donchian-trend-rules", "band-walk", "elder-safezone-stop"];
// Frozen in-sample mapping (hybrid/hybrid_spec.md — do NOT recompute on OOS data).
const MAPPING: Record<string, string[]> = {
  trend_up: ["donchian-trend-rules", "band-walk", "elder-safezone-stop"],
  trend_down: ["moving-average-crossovers", "elder-safezone-stop"],
  ranging: ["moving-average-crossovers", "elder-safezone-stop"],
  high_vol: ["band-walk", "donchian-trend-rules", "moving-average-crossovers"],
};
const HY = "data/lab/luxalgo/hybrid";

const cfg = JSON.parse(fs.readFileSync("data/lab/luxalgo/cache/engine-config.json", "utf8"));
const OOS_START = Date.parse(cfg.windowEnd);
console.log("in-sample end (OOS start):", cfg.windowEnd);

const perCoin: Record<string, any> = {};
const allTrades: any[] = [];
const skipped: string[] = [];

for (const coin of LAYER1_PAIRS) {
  let j: any;
  try {
    j = JSON.parse(fs.readFileSync(`data/klines/${coin}-1h.json`, "utf8"));
    if (!j.time?.length) throw new Error("empty");
  } catch { skipped.push(coin); continue; }
  const b: Bars = { t: j.time, o: j.open, h: j.high, l: j.low, c: j.close, v: j.vol ?? j.time.map(() => 0) };
  const oosIdx = b.t.findIndex((t: number) => t >= OOS_START);
  if (oosIdx < WARMUP + 10 || oosIdx >= b.t.length - 24) { skipped.push(`${coin}(short-oos)`); continue; }

  const c = buildCache(b);
  const regimes = b.t.map((_, i) => classify(b, c, i));
  const coinTrades: Trade[] = [];
  for (const slug of POOL) {
    const res = backtest(b, { ...defs[slug] } as StratDef, regimes, WARMUP);
    for (const t of res.trades) {
      if (t.entryTime < OOS_START) continue; // in-sample: ignore
      const ei = b.t.indexOf(t.entryTime);
      if (ei < 0) continue;
      if (MAPPING[regimes[ei] as Regime]?.includes(slug)) coinTrades.push({ ...t, pnl: t.pnl / 3, pnlPct: t.pnlPct / 3 });
    }
  }
  coinTrades.sort((a, b2) => a.entryTime - b2.entryTime);
  let eq = 10000;
  const curve: number[] = new Array(b.t.length).fill(NaN);
  const evts: Record<number, number> = {};
  for (const t of coinTrades) {
    const xi = b.t.indexOf(t.exitTime);
    evts[xi] = (evts[xi] ?? 0) + t.pnl;
  }
  for (let i = oosIdx; i < b.t.length; i++) { if (evts[i]) eq += evts[i]; curve[i] = eq; }
  const bh = (b.c[b.c.length - 1] / b.c[oosIdx] - 1) * 100;
  const m = metrics(curve, coinTrades, oosIdx, bh);
  perCoin[coin] = { ...m, oos_bars: b.t.length - oosIdx, oos_start: new Date(b.t[oosIdx]).toISOString() };
  allTrades.push(...coinTrades.map((t) => ({ ...t, coin })));
}
if (skipped.length) console.log("skipped:", skipped.join(","));

const ms = Object.values(perCoin).map((p: any) => p.metrics ?? p);
const avg = (k: string) => ms.reduce((a: number, m: any) => a + m[k], 0) / Math.max(1, ms.length);
const r2 = (v: number) => Math.round(v * 100) / 100;
const out = {
  oos_start: cfg.windowEnd,
  oos_end: new Date().toISOString(),
  coins: Object.keys(perCoin),
  total_trades: allTrades.length,
  total_pnl: r2(allTrades.reduce((a, t) => a + t.pnl, 0)),
  avg_total_return_pct: r2(avg("total_return_pct")),
  avg_max_drawdown_pct: r2(Math.max(...ms.map((m: any) => m.max_drawdown_pct))),
  avg_sharpe: r2(avg("sharpe")),
  avg_win_rate: r2(avg("win_rate_pct")),
  expectancy_per_trade: allTrades.length ? r2(allTrades.reduce((a, t) => a + t.pnlPct, 0) / allTrades.length) : 0,
  profit_factor: (() => {
    const gw = allTrades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
    const gl = -allTrades.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
    return gl > 0 ? r2(gw / gl) : gw > 0 ? 99 : 0;
  })(),
  per_coin: perCoin,
};
fs.writeFileSync(`${HY}/forward_results.json`, JSON.stringify(out, null, 1));
let tc = "entry_time,exit_time,coin,direction,entry_price,exit_price,pnl,pnl_pct,exit_reason,regime_at_entry,regime_at_exit\n";
for (const t of allTrades) tc += `${new Date(t.entryTime).toISOString()},${new Date(t.exitTime).toISOString()},${t.coin},${t.direction},${t.entryPrice},${t.exitPrice},${t.pnl.toFixed(2)},${t.pnlPct.toFixed(3)},${t.exitReason},${t.regimeIn},${t.regimeOut}\n`;
fs.writeFileSync(`${HY}/forward_trades.csv`, tc);

// in-sample baseline for comparison
const hy = JSON.parse(fs.readFileSync(`${HY}/hybrid_results.json`, "utf8"));
console.log("\n=== HYBRID FORWARD TEST (out-of-sample) ===");
console.log(`window : ${cfg.windowEnd} -> ${out.oos_end} (~${Math.round((Date.now() - OOS_START) / 86400000)}d)`);
console.log(`coins  : ${out.coins.length}  trades: ${out.total_trades}  pnl: ${out.total_pnl}`);
console.log(`OOS    : ret/coin ${out.avg_total_return_pct}%  PF ${out.profit_factor}  WR ${out.avg_win_rate}%  exp/trade ${out.expectancy_per_trade}%  maxDD ${out.avg_max_drawdown_pct}%`);
console.log(`IN-SAM : ret/coin ${hy.avg_total_return_pct}%  PF ${hy.avg_profit_factor}  WR ${hy.avg_win_rate}%  maxDD ${hy.avg_max_drawdown_pct}%  (n=${hy.total_trades})`);
console.log("\nper-coin OOS (ret% | PF | WR% | n):");
for (const [coin, p] of Object.entries(perCoin) as any[]) {
  console.log(`  ${coin.padEnd(9)} ${String(p.total_return_pct).padStart(8)} | ${String(p.profit_factor).padStart(6)} | ${String(p.win_rate_pct).padStart(5)} | ${p.num_trades}`);
}
