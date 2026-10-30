#!/usr/bin/env bun
/**
 * LIVE BOOK AUDIT — every closed trade, reconciled and stress-tested.
 *
 * Reads `liveTrades` as JSONL on stdin (or a file path as argv[1]):
 *
 *   bun convex data liveTrades --limit 1000 --format jsonLines | bun run src/lib/audit-live-book.ts
 *
 * WHY IT EXISTS. The live ledger's `reason` string used to be a shrug on ~half
 * the rows ("Closed on exchange (manual / TP-SL / liquidation)") because the
 * engine only labels an exit it placed itself, and a ledger where 47% of exits
 * are unlabelled cannot answer "where does the money actually go?" — the only
 * question that matters for improving R and profit factor. This script
 * re-derives each exit from the row's OWN bracket (slPrice / tpPrice /
 * trailLockPrice) and the recorded fill, then measures the book against the
 * levers that could move it.
 *
 * 2026-09-23 UPDATE: the shrug is extinct. The forward path names a reconciled
 * close from its fill (liveBroker → nameExitFromFill, 2026-09-22) and the
 * pre-existing rows were relabelled by liveEngine.relabelLiveExitProvenance, so
 * **78 of 86 live exits (91%) now carry a real cause**, six of them with a
 * stored attributionAnomaly. The fill is still the evidence, so this script
 * keeps re-deriving rather than trusting the label — which is exactly how the
 * original shrug was caught, and now doubles as a check that the label and the
 * fill agree.
 *
 * It is a REPORT, not a strategy change: nothing here edits config. Every
 * counterfactual it prints is a bound with its assumptions stated, because a
 * live sample this size (tens of trades) can only support bounds, not verdicts.
 *
 * Analysis sections:
 *   1. headline + parity anchor against the frozen 2026-09-22 ledger
 *   2. exit reconciliation (what actually closed each trade)
 *   3. GIVE-BACK — trades that reached +xR and still closed red. This is the
 *      one population where a fix is mathematically safe: the peak proves price
 *      was at +xR, so any lock armed at or below the peak converts the row to
 *      at least that rung. Nothing else in the book has that property.
 *   4. cohorts (pair / session / regime / vol / spread / hold / side / cluster)
 *   5. sequencing — same-pair re-entry, simultaneous clusters, loss streaks
 *   6. counterfactuals — BE stop, earlier lock start, filters, each as a bound
 */

import * as fs from "node:fs";
import type { Kline } from "./types";

// ── Row shape (only the fields the audit reads) ──────────────────────────────
interface LiveRow {
  _id: string;
  coin: string;
  type: string;
  status: string;
  entryTime: number;
  signalTime?: number;
  entryPrice?: number;
  slPrice: number;
  tpPrice: number;
  riskPx?: number;
  leverage?: number;
  notionalUsd?: number;
  trailStartR?: number;
  trailStepR?: number;
  trailMaxR?: number;
  trailPeakR?: number;
  trailLockPrice?: number;
  exitPrice?: number;
  exitTime?: number;
  exitOrderId?: string;
  reason?: string;
  pnlUsd?: number;
  realizedR?: number;
  feesUsd?: number;
  session?: string;
  regime?: string;
  volPct?: number;
  atrPctAtEntry?: number;
  spreadPct?: number;
  btcTrendAtEntry?: string;
  htfTrend1h?: string;
  distToSwingSr?: number;
  fundingRate?: number;
  pairVsBtc1h?: number;
  bidAskImbalance?: number;
  exchangeStop?: boolean;
  attributionAnomaly?: string;
}

/** Frozen ledger baseline (LIVE_BOOK_LEDGER.md, written 2026-09-22 05:30Z). */
const LEDGER = {
  lastEntry: Date.parse("2026-09-22T04:18:00Z"),
  /**
   * When the ledger was written. Its "72 closed" excludes the rows that were
   * still OPEN at that moment — and one of those (TIA, entered 09-21 23:03)
   * closed three minutes after the snapshot, INSIDE the entry window above. So a
   * pure entry-time filter reports a permanent one-trade mismatch (73 closed /
   * −$0.1831) and every number below inherits an asterisk it does not deserve.
   * Filtering on the snapshot too makes the anchor exact and stays exact as the
   * book grows, because a row that was open then can never become closed then.
   */
  snapshot: Date.parse("2026-09-22T05:30:00Z"),
  closed: 72,
  wins: 32,
  losses: 40,
  winRate: 44.44,
  netUsd: 2.3466,
  feesUsd: 0.6219,
} as const;

// ── Helpers ─────────────────────────────────────────────────────────────────
const r2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const r3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : "—");
const pct = (x: number) => (Number.isFinite(x) ? `${x.toFixed(1)}%` : "—");
const utc = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

type ExitLabel = "Stop" | "TP" | "Trail" | "ABOVE RUNG" | "Max" | "Other";

interface Recon {
  label: ExitLabel;
  /** R the exit actually booked (realizedR), cleaned of anomalies. */
  r: number;
  anomaly: boolean;
}

/**
 * Re-derive the exit from the row's own bracket. Mirrors LIVE_BOOK_LEDGER.md's
 * rules: a fill within ±0.5% of a level is that level; a winning fill above the
 * recorded lock with no exitOrderId is an exit the engine did not place.
 */
function reconcile(t: LiveRow): Recon {
  const px = t.exitPrice ?? 0;
  const r = t.realizedR ?? 0;
  const near = (level: number) => level > 0 && px > 0 && Math.abs(px - level) / level <= 0.005;
  const peak = t.trailPeakR ?? 0;
  const anomaly =
    !!t.attributionAnomaly || (peak > 0 && r > peak + 0.05 && !t.exitOrderId);

  if (near(t.slPrice)) return { label: "Stop", r, anomaly };
  if (near(t.tpPrice)) return { label: "TP", r, anomaly };
  if (r > 0 && peak > 0 && r > peak + 0.05 && !t.exitOrderId) return { label: "ABOVE RUNG", r, anomaly };
  if (t.trailLockPrice && t.trailLockPrice > 0 && r > 0) return { label: "Trail", r, anomaly };
  if (t.reason === "R-Lock Max") return { label: "Max", r, anomaly };
  return { label: "Other", r, anomaly };
}

interface Stats {
  n: number; wins: number; losses: number; wr: number; netR: number; netUsd: number;
  avgWinR: number; avgLossR: number; pf: number; maxDDr: number; expectancy: number;
}

function stats(rows: Array<{ r: number; usd: number; exitTime: number }>): Stats {
  const n = rows.length;
  if (!n) return { n: 0, wins: 0, losses: 0, wr: NaN, netR: 0, netUsd: 0, avgWinR: NaN, avgLossR: NaN, pf: NaN, maxDDr: 0, expectancy: NaN };
  const wins = rows.filter((t) => t.r > 0);
  const losses = rows.filter((t) => t.r <= 0);
  const gp = wins.reduce((a, t) => a + t.r, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.r, 0));
  const chrono = [...rows].sort((a, b) => a.exitTime - b.exitTime);
  let cum = 0, peak = 0, maxDDr = 0;
  for (const t of chrono) { cum += t.r; if (cum > peak) peak = cum; if (peak - cum > maxDDr) maxDDr = peak - cum; }
  return {
    n, wins: wins.length, losses: losses.length, wr: (wins.length / n) * 100,
    netR: cum, netUsd: rows.reduce((a, t) => a + t.usd, 0),
    avgWinR: wins.length ? gp / wins.length : NaN,
    avgLossR: losses.length ? -gl / losses.length : NaN,
    pf: gl > 0 ? gp / gl : gp > 0 ? Infinity : NaN,
    maxDDr, expectancy: cum / n,
  };
}

const statLine = (label: string, s: Stats) =>
  `${label.padEnd(26)} ${String(s.n).padStart(4)} ${pct(s.wr).padStart(7)} ${r2(s.netR).padStart(8)} ` +
  `${r3(s.expectancy).padStart(8)} ${r2(s.avgWinR).padStart(6)} ${r2(s.avgLossR).padStart(7)} ${r2(s.pf).padStart(6)} ${r2(s.maxDDr).padStart(8)}`;
const STAT_HEAD = `${"cohort".padEnd(26)} ${"n".padStart(4)} ${"WR".padStart(7)} ${"net R".padStart(8)} ${"R/trade".padStart(8)} ${"avgW".padStart(6)} ${"avgL".padStart(7)} ${"PF".padStart(6)} ${"maxDD R".padStart(8)}`;

/** Bucket rows by a key, print a table, return the buckets. */
function byCohort<T extends { r: number; usd: number; exitTime: number }>(
  rows: T[],
  keyOf: (t: T) => string,
  order?: string[],
): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const t of rows) {
    const k = keyOf(t);
    const arr = m.get(k) ?? [];
    arr.push(t);
    m.set(k, arr);
  }
  const keys = order ?? [...m.keys()].sort();
  console.log(STAT_HEAD);
  for (const k of keys) {
    const g = m.get(k);
    if (!g?.length) continue;
    console.log(statLine(k, stats(g)));
  }
  return m;
}

function bucket(v: number | undefined, edges: number[], labels: string[]): string {
  if (v == null || !Number.isFinite(v)) return "n/a";
  for (let i = 0; i < edges.length; i++) if (v < edges[i]) return labels[i];
  return labels[labels.length - 1];
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const fileArg = process.argv[2];
  // node:fs (fd 0 for stdin), not Bun globals — every other script in this
  // project reads this way and the Bun global is not in the type environment.
  const raw = fs.readFileSync(fileArg ?? 0, "utf8");
  const all: LiveRow[] = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as LiveRow)
    .sort((a, b) => a.entryTime - b.entryTime);

  // Reading fd 0 on a TTY gives nothing, and a report over zero rows reads like
  // a flat book rather than a missing pipe — say which it is.
  if (all.length === 0) {
    console.error(
      "no rows on stdin.\n" +
        "  bun convex data liveTrades --limit 1000 --format jsonLines | bun run audit:live",
    );
    process.exit(1);
  }

  const open = all.filter((t) => t.status !== "closed");
  const closed = all.filter((t) => t.status === "closed");
  const recon = new Map<string, Recon>();
  for (const t of closed) recon.set(t._id, reconcile(t));

  type T = { row: LiveRow; r: number; usd: number; exitTime: number; entryTime: number; peak: number };
  const book: T[] = closed.map((row) => ({
    row,
    r: row.realizedR ?? 0,
    usd: row.pnlUsd ?? 0,
    exitTime: row.exitTime ?? row.entryTime,
    entryTime: row.entryTime,
    peak: row.trailPeakR ?? 0,
  }));

  console.log("══════════════════ LIVE BOOK AUDIT ══════════════════");
  console.log(`rows pulled: ${all.length} · closed ${closed.length} + open ${open.length}`);
  console.log(`window: ${utc(all[0]?.entryTime ?? 0)} → ${utc(all[all.length - 1]?.entryTime ?? 0)} UTC`);

  // ── 1. Parity against the frozen ledger ─────────────────────────────────
  const frozen = book.filter(
    (t) => t.entryTime <= LEDGER.lastEntry && t.exitTime <= LEDGER.snapshot,
  );
  const openAtSnapshot = book.filter(
    (t) => t.entryTime <= LEDGER.lastEntry && t.exitTime > LEDGER.snapshot,
  );
  const sFrozen = stats(frozen);
  const parity =
    Math.abs(sFrozen.n - LEDGER.closed) === 0 &&
    Math.abs(sFrozen.netUsd - LEDGER.netUsd) < 0.001 &&
    Math.abs(sFrozen.wr - LEDGER.winRate) < 0.01;
  console.log(
    `\n── PARITY vs LIVE_BOOK_LEDGER.md (entered ≤ ${utc(LEDGER.lastEntry)} and CLOSED by the ` +
      `${utc(LEDGER.snapshot)} UTC snapshot) ──`,
  );
  console.log(`  ledger:   ${LEDGER.closed} closed · ${LEDGER.wins}W/${LEDGER.losses}L · WR ${LEDGER.winRate}% · net $${LEDGER.netUsd} · fees $${LEDGER.feesUsd}`);
  console.log(`  this run: ${sFrozen.n} closed · ${sFrozen.wins}W/${sFrozen.losses}L · WR ${pct(sFrozen.wr)} · net $${sFrozen.netUsd.toFixed(4)}`);
  console.log(`  ${parity ? "PARITY OK — the audit reads the same book the ledger recorded" : "PARITY MISMATCH — treat the numbers below with suspicion"}`);
  if (!parity) {
    console.log(`  (differs by ${sFrozen.n - LEDGER.closed} trades / $${(sFrozen.netUsd - LEDGER.netUsd).toFixed(4)})`);
  }
  for (const t of openAtSnapshot) {
    console.log(
      `  excluded — still open at the snapshot, closed ${utc(t.exitTime)} (${t.row.coin} ${r2(t.r)}R): ` +
        "present in today's rows, absent from the ledger's 72",
    );
  }

  // ── 2. Headline ─────────────────────────────────────────────────────────
  const s = stats(book);
  console.log("\n── HEADLINE (all closed) ──");
  console.log(`  trades ${s.n} · ${s.wins}W/${s.losses}L · WR ${pct(s.wr)}`);
  console.log(`  net ${r2(s.netR)}R / $${s.netUsd.toFixed(4)} · expectancy ${r3(s.expectancy)} R/trade`);
  console.log(`  avg win ${r2(s.avgWinR)}R · avg loss ${r2(s.avgLossR)}R · PF ${r2(s.pf)} · maxDD ${r2(s.maxDDr)}R`);
  console.log(`  fees $${book.reduce((a, t) => a + (t.row.feesUsd ?? 0), 0).toFixed(4)}`);
  const shorts = closed.filter((t) => t.type === "SHORT").length;
  console.log(`  sides: ${closed.length - shorts} LONG · ${shorts} SHORT`);
  const openRows = open.map((t) => `${t.coin} ${t.realizedR != null ? `${r2(t.realizedR)}R` : "unrealized"}`);
  console.log(`  open: ${openRows.join(" · ") || "none"}`);

  // ── 3. Exit reconciliation ──────────────────────────────────────────────
  console.log("\n── EXIT RECONCILIATION ──");
  const labels = ["Stop", "TP", "Trail", "ABOVE RUNG", "Max", "Other"] as ExitLabel[];
  console.log(STAT_HEAD);
  for (const l of labels) {
    const g = book.filter((t) => recon.get(t.row._id)!.label === l);
    if (!g.length) continue;
    console.log(statLine(l, stats(g)));
  }
  const reasons = new Map<string, number>();
  for (const t of closed) {
    const k = t.reason ?? "(none)";
    reasons.set(k, (reasons.get(k) ?? 0) + 1);
  }
  console.log(`  raw \`reason\` strings: ${[...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" · ")}`);
  const shrug = closed.filter((t) => !/stop loss|take profit|trail|r-lock/i.test(t.reason ?? "")).length;
  console.log(`  rows where the engine did not label its own exit: ${shrug}/${closed.length} (${pct((100 * shrug) / closed.length)}) — these are the rows reconciliation exists for`);
  const anomalies = book.filter((t) => recon.get(t.row._id)!.anomaly);
  console.log(`  attribution anomalies (realizedR > recorded peak): ${anomalies.length} → ${anomalies.map((t) => `${t.row.coin} ${r2(t.r)}R/peak ${r2(t.peak)}`).join(", ") || "none"}`);

  // ── 4. GIVE-BACK — the safe lever ───────────────────────────────────────
  console.log("\n── GIVE-BACK: reached +xR and closed red ──");
  const peakRows = book.filter((t) => t.peak > 0);
  console.log(`  rows with a recorded peak (r-lock era): ${peakRows.length}/${book.length}`);
  const bands: Array<[string, (p: number) => boolean]> = [
    ["peak  ≥ 1.50R (lock armed)", (p) => p >= 1.5],
    ["peak 1.00–1.50R (NEVER locked)", (p) => p >= 1.0 && p < 1.5],
    ["peak 0.50–1.00R", (p) => p >= 0.5 && p < 1.0],
    ["peak < 0.50R", (p) => p < 0.5],
  ];
  console.log(STAT_HEAD);
  for (const [label, f] of bands) {
    const g = peakRows.filter((t) => f(t.peak));
    if (!g.length) continue;
    console.log(statLine(label, stats(g)));
  }
  const giveBack = peakRows.filter((t) => t.peak >= 1.0 && t.r < 0);
  const neverLocked = giveBack.filter((t) => t.peak < 1.5);
  console.log(`\n  reached +1R then closed red: ${giveBack.length} rows, ${r2(giveBack.reduce((a, t) => a + t.r, 0))}R booked`);
  console.log(`  of those, NEVER locked (peak < 1.5R): ${neverLocked.length} rows, ${r2(neverLocked.reduce((a, t) => a + t.r, 0))}R`);
  console.log(`  of those, gapped through an armed lock: ${giveBack.length - neverLocked.length} rows, ${r2(giveBack.filter((t) => t.peak >= 1.5).reduce((a, t) => a + t.r, 0))}R`);
  for (const t of giveBack.sort((a, b) => b.peak - a.peak)) {
    console.log(
      `    ${utc(t.entryTime)} ${t.row.coin.padEnd(7)} peak ${r2(t.peak).padStart(5)}R → ${r2(t.r).padStart(6)}R  ` +
      `${recon.get(t.row._id)!.label.padEnd(11)} hold ${(((t.exitTime - t.entryTime) / 3.6e6)).toFixed(1)}h  ${t.row.session ?? "—"}`,
    );
  }

  // ── 5. Cohorts ──────────────────────────────────────────────────────────
  console.log("\n── BY PAIR ──");
  byCohort(book, (t) => t.row.coin);
  console.log("\n── BY SESSION ──");
  byCohort(book, (t) => t.row.session ?? "n/a", ["asia", "london", "ldn-ny", "ny", "late", "n/a"]);
  console.log("\n── BY 4H REGIME ──");
  byCohort(book, (t) => t.row.regime ?? "n/a", ["trend-up", "trend-down", "chop", "n/a"]);
  console.log("\n── BY BTC TREND AT ENTRY ──");
  byCohort(book, (t) => t.row.btcTrendAtEntry ?? "n/a", ["up", "down", "chop", "n/a"]);
  console.log("\n── BY 1H TREND AT ENTRY ──");
  byCohort(book, (t) => t.row.htfTrend1h ?? "n/a", ["up", "down", "chop", "n/a"]);
  console.log("\n── BY ENTRY ATR% ──");
  byCohort(book, (t) => bucket(t.row.atrPctAtEntry ?? t.row.volPct, [0.8, 1.0, 1.2, 1.5], ["<0.8%", "0.8–1.0%", "1.0–1.2%", "1.2–1.5%", "≥1.5%"]),
    ["<0.8%", "0.8–1.0%", "1.0–1.2%", "1.2–1.5%", "≥1.5%", "n/a"]);
  console.log("\n── BY ENTRY SPREAD ──");
  byCohort(book, (t) => bucket(t.row.spreadPct, [0.015, 0.025, 0.04], ["<0.015%", "0.015–0.025%", "0.025–0.04%", "≥0.04%"]),
    ["<0.015%", "0.015–0.025%", "0.025–0.04%", "≥0.04%", "n/a"]);
  console.log("\n── BY HOLD TIME (exit − entry) ──");
  byCohort(book, (t) => bucket((t.exitTime - t.entryTime) / 3.6e6, [0.5, 1, 2, 4], ["<0.5h", "0.5–1h", "1–2h", "2–4h", "≥4h"]),
    ["<0.5h", "0.5–1h", "1–2h", "2–4h", "≥4h"]);
  console.log("\n── BY FUNDING RATE AT ENTRY (long pays when > 0) ──");
  byCohort(book, (t) => bucket(t.row.fundingRate, [0, 0.00005, 0.0001], ["≤0 (long gets paid)", "0–0.005%", "0.005–0.01%", "≥0.01%"]),
    ["≤0 (long gets paid)", "0–0.005%", "0.005–0.01%", "≥0.01%", "n/a"]);

  // ── 6. Sequencing / portfolio ───────────────────────────────────────────
  console.log("\n── SEQUENCING ──");
  // Simultaneous clusters: entries within 45 min of each other.
  const clusters: T[][] = [];
  for (const t of book) {
    const last = clusters[clusters.length - 1];
    if (last && t.entryTime - last[0].entryTime <= 45 * 60_000) last.push(t);
    else clusters.push([t]);
  }
  const sizeOf = (c: T[]) => (c.length >= 3 ? "3+" : String(c.length));
  console.log("simultaneous entries (within 45 min)");
  byCohort(clusters.flatMap((c, i) => c.map((t) => ({ ...t, _c: sizeOf(c), _i: i }))),
    (t: any) => t._c, ["1", "2", "3+"]);
  const bigClusters = clusters.filter((c) => c.length >= 3);
  console.log(`  clusters of 3+ simultaneous entries: ${bigClusters.length} (${bigClusters.reduce((a, c) => a + c.length, 0)} trades, ${r2(bigClusters.flat().reduce((a, t) => a + t.r, 0))}R)`);

  // Same-pair re-entry within 6h.
  const reentries: T[] = [];
  const byPair = new Map<string, T[]>();
  for (const t of book) {
    const arr = byPair.get(t.row.coin) ?? [];
    arr.push(t);
    byPair.set(t.row.coin, arr);
  }
  for (const arr of byPair.values()) {
    for (let i = 1; i < arr.length; i++) {
      if (arr[i].entryTime - arr[i - 1].exitTime <= 6 * 3.6e6) reentries.push(arr[i]);
    }
  }
  const reentryIds = new Set(reentries.map((t) => t.row._id));
  console.log("\nsame-pair re-entry within 6h of the previous exit");
  console.log(STAT_HEAD);
  console.log(statLine("re-entry", stats(reentries)));
  console.log(statLine("first entry", stats(book.filter((t) => !reentryIds.has(t.row._id)))));
  const afterLoss = reentries.filter((t) => (byPair.get(t.row.coin) ?? []).some((p) => p.exitTime < t.entryTime && p.r <= 0));
  const prevLoser = reentries.filter((t) => {
    const arr = byPair.get(t.row.coin) ?? [];
    const prev = [...arr].reverse().find((p) => p.exitTime < t.entryTime);
    return prev && prev.r <= 0;
  });
  console.log(`  of which after a LOSING exit on the same pair: ${prevLoser.length} rows, ${r2(prevLoser.reduce((a, t) => a + t.r, 0))}R`);
  console.log(`  (same-pair-after-any-loss count: ${afterLoss.length})`);

  // Loss streak
  const chrono = [...book].sort((a, b) => a.exitTime - b.exitTime);
  let streak = 0, worst = 0;
  for (const t of chrono) { streak = t.r <= 0 ? streak + 1 : 0; worst = Math.max(worst, streak); }
  console.log(`  longest losing streak: ${worst} trades`);

  // ── 7. Counterfactuals (bounds, not verdicts) ───────────────────────────
  console.log("\n── COUNTERFACTUALS · bounds on the r-lock-era rows ──");
  console.log("(a row with peak ≥ x proves price WAS at +xR; a lock armed at ≤ x turns it into ≥ the rung.");
  console.log(" Rows without a recorded peak are left unchanged, so every figure below is a LOWER bound.)");
  const SLIP = 0.05; // conservative cost of a stop-style fill at the rung
  function cf(fn: (t: T) => number): Stats {
    return stats(book.map((t) => ({ r: fn(t), usd: t.usd, exitTime: t.exitTime })));
  }
  const base = stats(book.map((t) => ({ r: t.r, usd: t.usd, exitTime: t.exitTime })));
  const shown: Array<[string, Stats]> = [
    ["as booked", base],
    ["break-even stop at +1.0R", cf((t) => (t.peak >= 1.0 && t.r < 0 ? -SLIP : t.r))],
    ["lock from 1.0R (0.25 step)", cf((t) => {
      if (!(t.peak >= 1.0)) return t.r;
      if (t.r >= 1.0 - SLIP) return t.r; // already did at least as well
      const rung = 1.0 + Math.floor((t.peak - 1.0) / 0.25) * 0.25;
      return Math.min(rung, t.peak) - SLIP;
    })],
    ["lock from 0.75R (0.25 step)", cf((t) => {
      if (!(t.peak >= 0.75)) return t.r;
      if (t.r >= 0.75 - SLIP) return t.r;
      const rung = 0.75 + Math.floor((t.peak - 0.75) / 0.25) * 0.25;
      return Math.min(rung, t.peak) - SLIP;
    })],
  ];
  console.log(STAT_HEAD);
  for (const [label, st] of shown) console.log(statLine(label, st));
  console.log("   Δ vs booked:");
  for (const [label, st] of shown.slice(1)) {
    console.log(
      `     ${label.padEnd(28)} Δnet ${r2(st.netR - base.netR).padStart(7)}R · ΔPF ${(st.pf - base.pf >= 0 ? "+" : "")}${r3(st.pf - base.pf)} · ΔR/trade ${r3(st.expectancy - base.expectancy)}`,
    );
  }

  // ── 8. Drop-the-worst-cohort counterfactuals ────────────────────────────
  console.log("\n── COHORT REMOVAL · what would dropping each cohort have done? ──");
  console.log("(single-cohort, in-sample on THIS sample — a menu of hypotheses, not evidence.)");
  const cuts: Array<[string, (t: T) => boolean]> = [
    ["drop session = ldn-ny", (t) => t.row.session === "ldn-ny"],
    ["drop session = ny", (t) => t.row.session === "ny"],
    ["drop session = late", (t) => t.row.session === "late"],
    ["drop pair = TIA", (t) => t.row.coin === "TIA"],
    ["drop pair = INJ", (t) => t.row.coin === "INJ"],
    ["drop regime = chop", (t) => t.row.regime === "chop"],
    ["drop btcTrend = down", (t) => t.row.btcTrendAtEntry === "down"],
    ["drop htf1h = up", (t) => t.row.htfTrend1h === "up"],
    ["drop spread ≥ 0.04%", (t) => (t.row.spreadPct ?? 0) >= 0.04],
    ["drop hold < 0.5h", (t) => t.exitTime - t.entryTime < 0.5 * 3.6e6],
    ["drop same-pair re-entry ≤6h", (t) => reentryIds.has(t.row._id)],
    ["drop 3+ simultaneous cluster", (t) => bigClusters.flat().some((c) => c.row._id === t.row._id)],
    ["drop funding ≥ 0.01%", (t) => (t.row.fundingRate ?? 0) >= 0.0001],
  ];
  console.log(`  ${"cut".padEnd(30)} ${"dropped".padStart(8)} ${"Δnet R".padStart(8)} ${"ΔPF".padStart(7)} ${"ΔR/trade".padStart(9)} ${"kept n".padStart(7)}`);
  for (const [label, f] of cuts) {
    const kept = book.filter((t) => !f(t));
    const dropped = book.length - kept.length;
    if (!dropped) { console.log(`  ${label.padEnd(30)} ${"0".padStart(8)} ${"(no rows match)".padStart(8)}`); continue; }
    const st = stats(kept.map((t) => ({ r: t.r, usd: t.usd, exitTime: t.exitTime })));
    console.log(
      `  ${label.padEnd(30)} ${String(dropped).padStart(8)} ${r2(st.netR - base.netR).padStart(8)} ${((st.pf - base.pf) >= 0 ? "+" : "") + r3(st.pf - base.pf).padStart(6)} ${r3(st.expectancy - base.expectancy).padStart(9)} ${String(st.n).padStart(7)}`,
    );
  }

  console.log(`\nNOTE: ${book.length} closed trades is a small sample. Any cohort cut above is one look at one`);
  console.log("window; the paired-day test and an out-of-sample window are what separate a finding from noise.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export type { LiveRow, Kline };
