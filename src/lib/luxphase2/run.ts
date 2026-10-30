#!/usr/bin/env bun
// Phase-2 orchestrator: common 1H window -> regimes -> 85 x N backtests ->
// per-run metrics/trades/equity/regime-breakdown + correlation + family summary.
import fs from "node:fs";
import type { Bars } from "./indicators";
import { buildCache, classify, backtest, metrics, WARMUP, FEE, SLIP, RISK, type Regime } from "./engine";
import { S1 } from "./strategies1";
import { S2 } from "./strategies2";
import { S3 } from "./strategies3";
import { LAYER1_PAIRS } from "../tracked-pairs";

const STRATS = [...S1, ...S2, ...S3];
console.log("strategies:", STRATS.length);
const RES = "data/lab/luxalgo/results";
const REG = "data/lab/luxalgo/regimes";
fs.mkdirSync(RES, { recursive: true });
fs.mkdirSync(REG, { recursive: true });

// ---- load 1H cache (local only: MEXC blocked in this env) ----
type Coin = { coin: string; b: Bars };
const coins: Coin[] = [];
const unsupported: Array<{ slug: string; coin: string; reason: string }> = [];
for (const coin of LAYER1_PAIRS) {
  try {
    const j = JSON.parse(fs.readFileSync(`data/klines/${coin}-1h.json`, "utf8"));
    if (!j.time?.length) throw new Error("empty");
    coins.push({ coin, b: { t: j.time, o: j.open, h: j.high, l: j.low, c: j.close, v: j.vol ?? j.time.map(() => 0) } });
  } catch {
    unsupported.push({ slug: "*", coin, reason: "no local 1H cache and MEXC fetch blocked (HTTP 403)" });
  }
}
console.log("coins with 1H:", coins.map((c) => c.coin).join(","));
// ---- common window (intersection) ----
let start = 0, end = Infinity;
for (const c of coins) { start = Math.max(start, c.b.t[0]); end = Math.min(end, c.b.t[c.b.t.length - 1]); }
console.log("common window:", new Date(start).toISOString(), "->", new Date(end).toISOString());
const sliced = coins.map(({ coin, b }) => {
  const i0 = b.t.findIndex((t: number) => t >= start);
  let i1 = b.t.length - 1;
  while (i1 > 0 && b.t[i1] > end) i1--;
  const s = (a: number[]) => a.slice(i0, i1 + 1);
  return { coin, b: { t: s(b.t), o: s(b.o), h: s(b.h), l: s(b.l), c: s(b.c), v: s(b.v) } as Bars };
});
const cfg = {
  timeframe: "1H", coins: sliced.map((c) => c.coin),
  windowStart: new Date(start).toISOString(), windowEnd: new Date(end).toISOString(),
  barsPerCoin: sliced[0].b.t.length, warmupBars: WARMUP,
  feesPerSide: FEE, slippagePerSide: SLIP, riskPerTrade: RISK,
  execution: "next-bar-open; intrabar stop-before-target (pessimistic)",
  dataSource: "local data/klines/*-1h.json (MEXC cache); VIRTUAL/SHIB absent",
  seed: 7, engineVersion: "luxphase2-v1",
};
fs.writeFileSync("data/lab/luxalgo/cache/engine-config.json", JSON.stringify(cfg, null, 1));
fs.writeFileSync("data/lab/luxalgo/results/_engine_config.json", JSON.stringify(cfg, null, 1));

// ---- regimes ----
const REGIMES: Record<string, Regime[]> = {};
for (const { coin, b } of sliced) {
  const c = buildCache(b);
  const labels = b.t.map((_, i) => classify(b, c, i));
  REGIMES[coin] = labels;
  let csv = "timestamp,regime,adx,atr_ratio\n";
  for (let i = 0; i < b.t.length; i++) {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - 29); k <= i; k++) { if (Number.isFinite(c.atr14[k])) { sum += c.atr14[k]; n++; } }
    const avg = n ? sum / n : 1;
    csv += `${new Date(b.t[i]).toISOString()},${labels[i]},${Number.isFinite(c.adx[i]) ? c.adx[i].toFixed(1) : ""},${Number.isFinite(c.atr14[i]) ? (c.atr14[i] / avg).toFixed(2) : ""}\n`;
  }
  fs.writeFileSync(`${REG}/${coin}_1h_regimes.csv`, csv);
}
console.log("regimes written");

// ---- backtests ----
const daily: Record<string, Record<string, number>> = {}; // slug -> day -> ret sum
const famAgg: Record<string, { tr: number[]; dd: number[]; wr: number[]; pf: number[]; nt: number[] }> = {};
const t0 = Date.now();
let runs = 0;
for (const s of STRATS) {
  if (!famAgg[s.family]) famAgg[s.family] = { tr: [], dd: [], wr: [], pf: [], nt: [] };
  for (const { coin, b } of sliced) {
    const res = backtest(b, s, REGIMES[coin], WARMUP);
    const bh = ((b.c[b.c.length - 1] / b.c[WARMUP]) - 1) * 100;
    const m = metrics(res.equity, res.trades, WARMUP, bh);
    const key = `${s.slug}__${coin}`;
    fs.writeFileSync(`${RES}/${key}.json`, JSON.stringify({ strategy: s.slug, family: s.family, coin, ...m, exposure_pct: Math.round(res.exposure * 100000) / 1000 }, null, 1));
    let tc = "entry_time,exit_time,direction,entry_price,exit_price,size,notional,pnl,pnl_pct,exit_reason,regime_at_entry,regime_at_exit,hold_bars\n";
    for (const t of res.trades) {
      tc += `${new Date(t.entryTime).toISOString()},${new Date(t.exitTime).toISOString()},${t.direction},${t.entryPrice},${t.exitPrice},${t.notional / t.entryPrice},${t.notional.toFixed(2)},${t.pnl.toFixed(2)},${t.pnlPct.toFixed(3)},${t.exitReason},${t.regimeIn},${t.regimeOut},${t.holdBars}\n`;
    }
    fs.writeFileSync(`${RES}/${key}_trades.csv`, tc);
    let ec = "timestamp,equity,drawdown_pct\n";
    let peak = 10000;
    for (let i = WARMUP; i < b.t.length; i++) {
      const e = res.equity[i];
      if (e > peak) peak = e;
      ec += `${new Date(b.t[i]).toISOString()},${e.toFixed(2)},${(((peak - e) / peak) * 100).toFixed(3)}\n`;
    }
    fs.writeFileSync(`${RES}/${key}_equity.csv`, ec);
    // regime breakdown (by entry regime)
    const regs: Regime[] = ["trend_up", "trend_down", "ranging", "high_vol", "low_vol", "neutral"];
    const bd: Record<string, any> = {};
    for (const rg of regs) {
      const ts = res.trades.filter((t) => t.regimeIn === rg);
      const w = ts.filter((t) => t.pnl > 0);
      const gw = w.reduce((a, t) => a + t.pnl, 0), gl = -ts.filter((t) => t.pnl <= 0).reduce((a, t) => a + t.pnl, 0);
      const rets = ts.map((t) => t.pnlPct);
      bd[rg] = {
        trades: ts.length,
        win_rate_pct: ts.length ? Math.round((10000 * w.length) / ts.length) / 100 : 0,
        profit_factor: gl > 0 ? Math.round((1000 * gw) / gl) / 1000 : gw > 0 ? 99 : 0,
        avg_return_pct: ts.length ? Math.round((1000 * rets.reduce((a, v) => a + v, 0)) / ts.length) / 1000 : 0,
        total_return_pct: Math.round(rets.reduce((a, v) => a + v, 0) * 1000) / 1000,
      };
    }
    fs.writeFileSync(`${RES}/${key}_regime_breakdown.json`, JSON.stringify(bd, null, 1));
    // daily returns for correlation (avg across coins later)
    for (let i = WARMUP + 1; i < b.t.length; i += 24) {
      const day = new Date(b.t[i]).toISOString().slice(0, 10);
      const r = res.equity[i] / res.equity[Math.max(WARMUP, i - 24)] - 1;
      if (!daily[s.slug]) daily[s.slug] = {};
      daily[s.slug][day] = (daily[s.slug][day] ?? 0) + r;
    }
    famAgg[s.family].tr.push(m.total_return_pct); famAgg[s.family].dd.push(m.max_drawdown_pct);
    famAgg[s.family].wr.push(m.win_rate_pct); famAgg[s.family].pf.push(Math.min(m.profit_factor, 10)); famAgg[s.family].nt.push(m.num_trades);
    runs++;
  }
  console.log(`done ${s.slug} (${((Date.now() - t0) / 1000).toFixed(0)}s, ${runs} runs)`);
}
// normalize daily (avg across coins)
const slugs = Object.keys(daily);
for (const sl of slugs) for (const d of Object.keys(daily[sl])) daily[sl][d] /= sliced.length;
// correlation matrix
const days = [...new Set(slugs.flatMap((sl) => Object.keys(daily[sl])))].sort();
const series: Record<string, number[]> = {};
for (const sl of slugs) series[sl] = days.map((d) => daily[sl][d] ?? 0);
const mean = (a: number[]) => a.reduce((x, v) => x + v, 0) / a.length;
let cor = "strategy," + slugs.join(",") + "\n";
for (const a of slugs) {
  const row = [a];
  for (const bb of slugs) {
    const A = series[a], Bc = series[bb];
    const ma = mean(A), mb = mean(Bc);
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < A.length; i++) { num += (A[i] - ma) * (Bc[i] - mb); da += (A[i] - ma) ** 2; db += (Bc[i] - mb) ** 2; }
    row.push(da > 0 && db > 0 ? (num / Math.sqrt(da * db)).toFixed(3) : "0.000");
  }
  cor += row.join(",") + "\n";
}
fs.writeFileSync(`${RES}/strategy_correlation.csv`, cor);
// family summary
const fam: Record<string, any> = {};
for (const [f, v] of Object.entries(famAgg)) {
  const av = (a: number[]) => Math.round((1000 * a.reduce((x, y) => x + y, 0)) / a.length) / 1000;
  fam[f] = { runs: v.tr.length, avg_total_return_pct: av(v.tr), avg_max_drawdown_pct: av(v.dd), avg_win_rate_pct: av(v.wr), avg_profit_factor: av(v.pf), avg_num_trades: av(v.nt) };
}
fs.writeFileSync(`${RES}/family_summary.json`, JSON.stringify(fam, null, 1));
fs.writeFileSync("data/lab/luxalgo/results/_unsupported.json", JSON.stringify(unsupported, null, 1));
let umd = "# Unsupported runs\n\nNo coin list config found; stack = workspace LAYER1_PAIRS.\n\n";
for (const u of unsupported) umd += `- ${u.coin} (${u.slug}): ${u.reason}\n`;
umd += `\nCommon window: ${cfg.windowStart} -> ${cfg.windowEnd} (${cfg.barsPerCoin} bars/coin, warmup ${WARMUP}).\n`;
umd += `\nMEXC live fetch returned HTTP 403 in this environment, so VIRTUAL/SHIB 1H could not be seeded and the tail could not be extended past cache end. All runs use identical local windows.\n`;
fs.writeFileSync("data/lab/luxalgo/results/unsupported.md", umd);
console.log(`\nTOTAL RUNS=${runs} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
