#!/usr/bin/env bun
/**
 * ARM-READINESS CHECK — one command that answers "is it ok to arm the live book
 * right now?" from live state, not from memory. (2026-09-23)
 *
 *   bun run lab:armcheck
 *
 * WHY IT EXISTS. Deciding to arm took five separate reads (account, config,
 * BTC regime, 4h advisor, per-pair HTF cache) and a manual join, and the
 * answer changes with the tape rather than with the code. The operator's
 * standing instruction was "let's check again later for edge" — this makes
 * "later" a single command whose output diffs against the previous run.
 *
 * WHAT IT REPORTS, in the order the decision actually goes:
 *   1. STATE   — armed or not, balance, open positions, sizing, breaker.
 *   2. REGIME  — BTC's 4h position vs its EMA 75, and which SIDE that permits.
 *                With btcRegimeDownBlock on, one side is closed for the whole
 *                universe; that is a gate, not an opinion.
 *   3. TAPE    — how extended the universe is above its own 4h EMA 75. The 4H
 *                filter stops SELECTING when everything has run: it is
 *                permissive everywhere, so the advisor does all the work.
 *   4. UNIVERSE— the tradable pairs (config blocklist removed) with both gates
 *                and the verdict per pair.
 *   5. BASELINE— the live ledger's own record, so the entry conditions are read
 *                against how the book has actually done, not in the abstract.
 *
 * READ-ONLY. Every call is a query or a table dump; nothing here writes config,
 * arms the book, or touches a position. It is a report.
 *
 * NOT A VERDICT GENERATOR. It prints the conditions and the measured baseline.
 * Whether to arm is still an operator decision, because the thing that actually
 * damages this book — many correlated longs stopped out together — has no
 * validated instrument in the stack (the beta cap measured as a null; the
 * position cap cut drawdown LESS than random deletion of the same size).
 */

import { execSync } from "node:child_process";

const sh = (cmd: string): string =>
  execSync(cmd, { cwd: process.cwd(), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const runJson = <T>(cmd: string): T => JSON.parse(sh(cmd)) as T;

const f1 = (n: number) => n.toFixed(1);
const pct = (a: number, b: number) => ((a - b) / b) * 100;
const pad = (s: string, n: number) => s.padEnd(n);

type LiveAccount = {
  enabled?: boolean;
  balanceUsd?: number;
  riskPct?: number;
  leverage?: number;
  maxOpenPositions?: number;
  liveBreakerEnabled?: boolean;
  liveBreakerPausedUntil?: number;
  lastScanAt?: number;
  lastProbeAt?: number;
  lastProbeOk?: boolean;
  lastProbeDetail?: string;
};
type Config = {
  blocklist?: string[];
  btcRegimeEnabled?: boolean;
  btcRegimeDownBlock?: boolean;
  allowLong?: boolean;
  allowShort?: boolean;
  maxEmaStretchPct?: number;
  minScore?: number;
  minGap?: number;
  maxNetBtcBeta?: number;
  trailLockStartR?: number;
};
type Regime = { regime?: string; ema?: number; slopePct?: number; barOpenTime?: number };
type Advisor = {
  ageMs?: number;
  timestamp?: number;
  vetoLong?: number;
  vetoShort?: number;
  metrics?: Record<string, { price?: number; longStatus?: string; shortStatus?: string; rsi?: number; vwapDistPct?: number }>;
};
type Htf = { coin: string; ema: number; close: number; barOpenTime: number; fetchedAt: number; period: number; tf: string };
type Closed = { closedCount?: number; wins?: number; losses?: number; avgR?: number; winRate?: number; totalPnl?: number; totalFees?: number };

const now = Date.now();
const fmtAge = (ms?: number) => (ms == null ? "—" : `${f1((now - ms) / 3_600_000)}h old`);

console.log("═".repeat(78));
console.log("ARM-READINESS CHECK · live book · " + new Date(now).toISOString().slice(0, 16) + "Z");
console.log("═".repeat(78));

// ── 1 · STATE ────────────────────────────────────────────────────────────────
const account = runJson<LiveAccount>(`bunx convex run liveEngine:getLiveAccount`);
const liveCfg = runJson<Config>(`bunx convex run strategyEngine:getConfig '{"book":"live"}'`);
const open = runJson<unknown[]>(`bunx convex run liveEngine:getLiveOpenTrades`);
const stats = runJson<Closed>(`bunx convex run liveEngine:getLiveClosedStats`);

console.log("\n── 1 · STATE ──");
console.log(`  armed                 ${account.enabled ? "YES" : "NO"}`);
console.log(`  open positions        ${open.length}`);
console.log(`  balance               $${(account.balanceUsd ?? 0).toFixed(2)}`);
const riskUsd = ((account.balanceUsd ?? 0) * ((account.riskPct ?? 0) / 100));
console.log(
  `  sizing                risk ${account.riskPct}% (account doc) = $${riskUsd.toFixed(3)}/entry · ` +
    `${account.leverage}x · ${account.maxOpenPositions} slot(s)`,
);
console.log(`  breaker               ${account.liveBreakerEnabled ? "enabled" : "DISABLED — no auto-pause on a loss streak"}`);
console.log(`  last probe            ${account.lastProbeOk ? "ok" : "FAILED"} (${fmtAge(account.lastProbeAt)})`);
console.log(`  last scan             ${fmtAge(account.lastScanAt)} · ${account.lastScanAt ? new Date(account.lastScanAt).toISOString().slice(0, 16) + "Z" : "never"}`);
console.log(`  maxNetBtcBeta         ${liveCfg.maxNetBtcBeta ?? 0} ${liveCfg.maxNetBtcBeta ? "" : "(OFF — measured null, 2026-09-23)"}`);

// ── 2 · REGIME ───────────────────────────────────────────────────────────────
const regime = runJson<Regime>(`bunx convex run btcRegimeCache:getBtcRegime`);
const advisor = runJson<Advisor>(`bunx convex run advisor:getAdvisorState`);
const btcPx = advisor.metrics?.["BTC"]?.price ?? NaN;
const btcDist = btcPx && regime.ema ? pct(btcPx, regime.ema) : NaN;

console.log("\n── 2 · REGIME (which side is even permitted) ──");
console.log(
  `  BTC 4h regime         ${regime.regime} (slope ${f1(regime.slopePct ?? 0)}%) · price ${btcPx} vs 4h EMA75 ${regime.ema?.toFixed(0)} = ${btcDist >= 0 ? "+" : ""}${f1(btcDist)}%`,
);
const longsOnly = regime.regime === "up" && liveCfg.btcRegimeDownBlock !== false;
console.log(
  `  side gate             ${longsOnly ? "LONG ONLY — every SHORT is blocked by btcRegimeDownBlock" : regime.regime === "down" ? "SHORT ONLY — every LONG is blocked" : "both sides permitted"}`,
);
console.log(`  advisor               vetoes ${advisor.vetoLong}/32 longs · ${advisor.vetoShort}/32 shorts · snapshot ${fmtAge(advisor.timestamp)}`);
console.log(`  config sides          allowLong=${liveCfg.allowLong} allowShort=${liveCfg.allowShort}`);

// ── 3 · TAPE ─────────────────────────────────────────────────────────────────
const htf = sh(`bunx convex data htfCache --limit 200 --format jsonl`)
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Htf);
const priced = htf
  .map((h) => ({ ...h, px: advisor.metrics?.[h.coin]?.price ?? NaN }))
  .filter((h) => Number.isFinite(h.px) && h.ema > 0)
  .map((h) => ({ ...h, dist: pct(h.px!, h.ema) }));
const above = priced.filter((h) => h.dist > 0);
const dists = priced.map((h) => h.dist).sort((a, b) => a - b);
const median = dists[Math.floor(dists.length / 2)] ?? NaN;

console.log("\n── 3 · TAPE (how much has already run) ──");
console.log(`  above own 4h EMA75    ${above.length} of ${priced.length} pairs (median ${median >= 0 ? "+" : ""}${f1(median)}%)`);
const top = [...priced].sort((a, b) => b.dist - a.dist).slice(0, 5);
console.log(`  most extended         ${top.map((h) => `${h.coin} +${f1(h.dist)}%`).join(" · ")}`);
const stale = priced.filter((h) => (now - h.fetchedAt) / 3_600_000 > 24);
console.log(
  `  HTF cache freshness   ${stale.length} pair(s) >24h old${stale.length ? ` (${stale.map((h) => h.coin).join(", ")}) — those pairs were not re-evaluated` : ""}`,
);

// ── 4 · UNIVERSE (both gates) ────────────────────────────────────────────────
const blocked = new Set(liveCfg.blocklist ?? []);
const tradable = priced.filter((h) => !blocked.has(h.coin)).sort((a, b) => a.coin.localeCompare(b.coin));
const eligibleLong: string[] = [];
const eligibleShort: string[] = [];

console.log(`\n── 4 · UNIVERSE — ${tradable.length} tradable (blocklist removes ${blocked.size} of ${htf.length}) ──`);
console.log(`  ${pad("pair", 7)} ${pad("price", 11)} ${pad("4hEMA75", 11)} ${pad("dist", 8)} ${pad("4H filter", 10)} ${pad("advisor L/S", 12)} eligible`);
for (const h of tradable) {
  const a = advisor.metrics?.[h.coin] ?? {};
  const filt = h.dist > 0 ? "LONG ok" : "SHORT ok";
  const ls = `${a.longStatus}/${a.shortStatus}`;
  let verdict = "no";
  if (h.dist > 0 && a.longStatus === "ok") {
    verdict = "LONG";
    eligibleLong.push(h.coin);
  } else if (h.dist < 0 && a.shortStatus === "ok") {
    verdict = "SHORT";
    eligibleShort.push(h.coin);
  }
  console.log(
    `  ${pad(h.coin, 7)} ${pad(h.px!.toPrecision(6), 11)} ${pad(h.ema.toFixed(4), 11)} ` +
      `${pad(`${h.dist >= 0 ? "+" : ""}${f1(h.dist)}%`, 8)} ${pad(filt, 10)} ${pad(ls, 12)} ${verdict}`,
  );
}

// ── 5 · BASELINE ─────────────────────────────────────────────────────────────
console.log("\n── 5 · LIVE BASELINE (read the entries above against this) ──");
console.log(
  `  ${stats.closedCount} closed · WR ${f1(stats.winRate ?? 0)}% · avgR ${(stats.avgR ?? 0).toFixed(3)} · ` +
    `PnL $${(stats.totalPnl ?? 0).toFixed(2)} · fees $${(stats.totalFees ?? 0).toFixed(2)}`,
);

// ── READ ─────────────────────────────────────────────────────────────────────
const enterable = longsOnly ? eligibleLong : [...eligibleLong, ...eligibleShort];
console.log("\n" + "─".repeat(78));
console.log(
  `READ: ${enterable.length} of ${tradable.length} tradable pairs clear BOTH gates ` +
    `(${longsOnly ? "long side only" : "both sides"})${enterable.length ? ` — ${enterable.join(", ")}` : ""}`,
);
if (enterable.length === 0) {
  console.log("      Nothing is enterable right now: a quiet book here is the gates working, not a fault.");
} else if (median > 10) {console.log(
  `      Universe median +${f1(median)}% above its 4h EMA75, so the 4H filter is permissive everywhere — ` +
    `entries available now are LONG into extension.`,
  );
}
console.log("      No validated instrument exists for the cluster risk (many correlated longs stopped together):");
console.log("      the beta cap measured as a null, and the position cap cut drawdown LESS than random deletion.");
console.log("─".repeat(78));
