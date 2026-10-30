#!/usr/bin/env bun
/**
 * LIVE BOOK — PER-TRADE JOURNAL (2026-09-24)
 *
 * Reads `liveTrades` as JSONL on stdin:
 *
 *   bun convex data liveTrades --limit 1000 --format jsonLines | bun run journal:live
 *
 * WHY IT EXISTS. `audit-live-book.ts` answers "where does the money go?" with
 * COHORTS. This answers the other question — "what did the book actually do,
 * trade by trade, and which of those trades were engineering mistakes rather
 * than market outcomes?" — with one row per trade and a flagged defect list.
 *
 * The split matters. A losing stop is not a bug. A row that closed with no
 * exchange bracket, a row whose exit the engine could not name, a row whose
 * realized R exceeds the peak it recorded, a row that reached +1R and handed
 * the whole thing back because the lock never armed — those are defects, and
 * each one below is printed with the evidence on the row itself.
 *
 * Exit labels are re-derived here with the SAME rules as audit-live-book.ts
 * (fill within ±0.5% of a bracket level is that level), so the label counts
 * printed at the end must equal that audit's exit table. If they diverge, this
 * script is wrong, not the audit.
 *
 * REPORT ONLY — it edits nothing and is not imported by any engine.
 */

import * as fs from "node:fs";
// The real safety limit. 20x is only the DEFAULT seed — the entry path clamps
// leverage to maxSafeLeverage(stopPct), so a row is only wrong if its leverage
// beats that cap (liquidation would precede the stop). Comparing against the
// 20x default instead would flag every row in the book as a defect.
import { maxSafeLeverage } from "./live-math";

interface LiveRow {
  _id: string;
  coin: string;
  type: string;
  status: string;
  entryTime: number;
  exitTime?: number;
  entryPrice?: number;
  slPrice: number;
  tpPrice: number;
  riskPx?: number;
  leverage?: number;
  notionalUsd?: number;
  trailStartR?: number;
  trailPeakR?: number;
  trailLockPrice?: number;
  exitPrice?: number;
  exitOrderId?: string;
  reason?: string;
  pnlUsd?: number;
  realizedR?: number;
  feesUsd?: number;
  session?: string;
  spreadPct?: number;
  btcTrendAtEntry?: string;
  htfTrend1h?: string;
  exchangeStop?: boolean;
  attributionAnomaly?: string;
}

type ExitLabel = "Stop" | "TP" | "Trail" | "ABOVE RUNG" | "Max" | "Other";

const r2 = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "—");
const r4 = (x: number) => (Number.isFinite(x) ? x.toFixed(4) : "—");
const utc = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ");
const hrs = (ms: number) => (Number.isFinite(ms) ? (ms / 3_600_000).toFixed(1) : "—");
const pct3 = (x?: number) => (x != null && Number.isFinite(x) ? `${(x * 100).toFixed(3)}%` : "—");

/** Same rules as audit-live-book.ts's reconcile(). */
function reconcile(t: LiveRow): { label: ExitLabel; anomaly: boolean } {
  const px = t.exitPrice ?? 0;
  const r = t.realizedR ?? 0;
  const peak = t.trailPeakR ?? 0;
  const near = (level: number) => level > 0 && px > 0 && Math.abs(px - level) / level <= 0.005;
  const anomaly = !!t.attributionAnomaly || (peak > 0 && r > peak + 0.05 && !t.exitOrderId);
  if (near(t.slPrice)) return { label: "Stop", anomaly };
  if (near(t.tpPrice)) return { label: "TP", anomaly };
  if (r > 0 && peak > 0 && r > peak + 0.05 && !t.exitOrderId) return { label: "ABOVE RUNG", anomaly };
  if (t.trailLockPrice && t.trailLockPrice > 0 && r > 0) return { label: "Trail", anomaly };
  if (t.reason === "R-Lock Max") return { label: "Max", anomaly };
  return { label: "Other", anomaly };
}

/** Stop distance in PERCENT, as the leverage guard measures it. */
function stopPctOf(t: LiveRow): number {
  const entry = t.entryPrice ?? 0;
  if (!(entry > 0) || !(t.slPrice > 0)) return 0;
  return (Math.abs(entry - t.slPrice) / entry) * 100;
}

/**
 * Defects, in the order they cost money. Every one is a property of the row —
 * nothing here is inferred from a mood, and none of them is "the trade lost".
 */
function defects(t: LiveRow, label: ExitLabel): string[] {
  const out: string[] = [];
  const r = t.realizedR ?? 0;
  const peak = t.trailPeakR ?? 0;
  if (t.attributionAnomaly) out.push("attr-anomaly");
  if (r < 0 && peak >= 1) out.push(`gave back ${r2(peak)}R`);
  if (t.exchangeStop !== true) out.push("no exchange stop");
  if (t.riskPx == null) out.push("pre-ruler");
  if (String(t.reason ?? "").toLowerCase().includes("off-engine")) out.push("off-engine close");
  if (label === "Other") out.push("unlabelled exit");
  if (stopPctOf(t) > 0 && (t.leverage ?? 0) > maxSafeLeverage(stopPctOf(t))) {
    out.push(`liq before stop (${t.leverage}x > ${maxSafeLeverage(stopPctOf(t))}x)`);
  }
  return out;
}

const raw = fs.readFileSync(0, "utf8");
const all: LiveRow[] = raw
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l) as LiveRow);

if (all.length === 0) {
  console.error("no rows on stdin — pipe `bun convex data liveTrades --format jsonLines` in");
  process.exit(1);
}

const closed = all.filter((t) => t.status === "closed" && t.realizedR != null);
const open = all.filter((t) => t.status === "open");
closed.sort((a, b) => a.entryTime - b.entryTime);

console.log(`rows ${all.length} · closed ${closed.length} · open ${open.length}`);
console.log(
  `window ${utc(all.reduce((m, t) => Math.min(m, t.entryTime), Infinity))} → ` +
    `${utc(all.reduce((m, t) => Math.max(m, t.exitTime ?? t.entryTime), -Infinity))} UTC`,
);

// ── Per-trade ledger ────────────────────────────────────────────────────────
console.log("\n| # | Entry (UTC) | Coin | R | $ | Hold | Peak | Exit | BTC/1h | Spread | Flags |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|");
closed.forEach((t, i) => {
  const { label } = reconcile(t);
  const peak = t.trailPeakR ?? 0;
  console.log(
    `| ${i + 1} | ${utc(t.entryTime)} | ${t.coin} | ${r2(t.realizedR!)} | ${r4(t.pnlUsd ?? 0)} | ` +
      `${hrs((t.exitTime ?? 0) - t.entryTime)}h | ${peak ? r2(peak) : "—"} | ${label} | ` +
      `${t.btcTrendAtEntry ?? "—"}/${t.htfTrend1h ?? "—"} | ${pct3(t.spreadPct)} | ` +
      `${defects(t, label).join(" · ")} |`,
  );
});

if (open.length) {
  console.log("\n| Open | Entry (UTC) | Coin | Entry | SL | TP | Peak |");
  console.log("|---|---|---|---|---|---|---|");
  for (const t of open) {
    console.log(
      `| Open | ${utc(t.entryTime)} | ${t.coin} | ${t.entryPrice ?? "—"} | ${t.slPrice} | ${t.tpPrice} | ${r2(t.trailPeakR ?? 0)} |`,
    );
  }
}

// ── Exit label totals — MUST equal audit-live-book.ts's exit table ──────────
console.log("\n## Exit labels (must match audit:live)");
const buckets = new Map<ExitLabel, { n: number; net: number; usd: number }>();
for (const t of closed) {
  const { label } = reconcile(t);
  const b = buckets.get(label) ?? { n: 0, net: 0, usd: 0 };
  b.n++;
  b.net += t.realizedR ?? 0;
  b.usd += t.pnlUsd ?? 0;
  buckets.set(label, b);
}
let tn = 0, tnet = 0, tusd = 0;
for (const [k, v] of [...buckets.entries()].sort((a, b) => b[1].net - a[1].net)) {
  console.log(`  ${k.padEnd(11)} n=${String(v.n).padStart(3)} net ${v.net.toFixed(2).padStart(7)}R  $${v.usd.toFixed(4)}`);
  tn += v.n; tnet += v.net; tusd += v.usd;
}
console.log(`  ${"TOTAL".padEnd(11)} n=${String(tn).padStart(3)} net ${tnet.toFixed(2).padStart(7)}R  $${tusd.toFixed(4)}`);

// ── Defect register, priced ─────────────────────────────────────────────────
console.log("\n## Defect register");
const kinds: Array<[string, (t: LiveRow, l: ExitLabel) => boolean]> = [
  ["no exchange stop", (t) => t.exchangeStop !== true],
  ["pre-ruler (riskPx missing)", (t) => t.riskPx == null],
  ["exit the engine did not name", (t, l) => l === "Other" || String(t.reason ?? "").toLowerCase().includes("off-engine")],
  ["attribution anomaly", (t) => !!t.attributionAnomaly],
  ["reached +1R, never locked", (t) => (t.realizedR ?? 0) < 0 && (t.trailPeakR ?? 0) >= 1],
  ["leverage past the liquidation guard", (t) => stopPctOf(t) > 0 && (t.leverage ?? 0) > maxSafeLeverage(stopPctOf(t))],
];
for (const [name, test] of kinds) {
  const hit = closed.filter((t) => test(t, reconcile(t).label));
  const net = hit.reduce((s, t) => s + (t.realizedR ?? 0), 0);
  console.log(
    `  ${name.padEnd(32)} n=${String(hit.length).padStart(3)}/${closed.length}  net ${net.toFixed(2).padStart(7)}R  ` +
      `[${hit.map((t) => t.coin).join(", ") || "—"}]`,
  );
}

// ── Stop population, split the way the paper stop journal splits it ─────────
const stops = closed.filter((t) => reconcile(t).label === "Stop");
const neverRan = stops.filter((t) => (t.trailPeakR ?? 0) < 1);
const gaveBack = stops.filter((t) => (t.trailPeakR ?? 0) >= 1);
console.log("\n## Stop population");
console.log(`  stops ${stops.length} · net ${stops.reduce((s, t) => s + (t.realizedR ?? 0), 0).toFixed(2)}R`);
console.log(`  A never reached +1R : ${neverRan.length} · net ${neverRan.reduce((s, t) => s + (t.realizedR ?? 0), 0).toFixed(2)}R`);
console.log(`  B reached +1R       : ${gaveBack.length} · net ${gaveBack.reduce((s, t) => s + (t.realizedR ?? 0), 0).toFixed(2)}R`);
if (gaveBack.length) {
  for (const t of gaveBack) {
    console.log(
      `      ${utc(t.entryTime)} ${t.coin.padEnd(5)} peak ${r2(t.trailPeakR!)}R → ${r2(t.realizedR!)}R  ` +
        `hold ${hrs((t.exitTime ?? 0) - t.entryTime)}h  ${t.session ?? "—"}`,
    );
  }
}

// ── PER-STOP FORENSICS ──────────────────────────────────────────────────────
//
// A stop is not one event. Every row below was checked against its OWN bracket,
// because "lost about 1R" hides three very different things: a stop that filled
// where it was placed, a stop that filled WORSE than it was placed (slippage, or
// no bracket at all), and a trade that was never given a chance to work. The
// columns separate them:
//
//   thru  = realizedR beyond −1R (negative = filled better than the stop)
//   slip  = the fill vs the stop level in bps, signed so POSITIVE IS WORSE
//   peak  = stored trailPeakR (MFE proxy; — = pre-r-lock, never tracked)
//   gap   = minutes until the next entry on the SAME coin (churn, not analysis)
const slipBps = (t: LiveRow): number => {
  const sl = t.slPrice ?? 0;
  const px = t.exitPrice ?? 0;
  if (!(sl > 0) || !(px > 0)) return NaN;
  const sign = t.type === "LONG" ? -1 : 1; // long filling below SL = worse
  return (sign * (px - sl)) / sl * 10_000;
};
const byEntryTime = [...all].sort((a, b) => a.entryTime - b.entryTime);
const nextSameCoinGapMin = (t: LiveRow): number | null => {
  const nxt = byEntryTime.find(
    (o) => o._id !== t._id && o.coin === t.coin && o.entryTime > t.entryTime,
  );
  return nxt ? Math.round((nxt.entryTime - (t.exitTime ?? t.entryTime)) / 60_000) : null;
};

console.log("\n## Every stop, forensically (all " + stops.length + ")");
console.log(
  `  ${"#".padStart(3)}  ${"entry(UTC)".padEnd(12)} ${"coin".padEnd(5)} ${"R".padStart(6)} ${"thru".padStart(6)} ` +
    `${"slip".padStart(7)} ${"peak".padStart(6)} ${"hold".padStart(6)} ${"sess".padEnd(7)} ${"gap".padStart(6)}  flags`,
);
stops.forEach((t, i) => {
  const r = t.realizedR ?? 0;
  const thru = r + 1;
  const peak = t.trailPeakR ?? 0;
  const gap = nextSameCoinGapMin(t);
  const slip = slipBps(t);
  const flags: string[] = [];
  if (t.exchangeStop !== true) flags.push("NO-BRACKET");
  if (t.riskPx == null) flags.push("pre-ruler");
  if (Number.isFinite(slip) && slip > 5) flags.push(`filled ${Math.round(slip)}bps past stop`);
  if (r < -1.05) flags.push("lost more than 1R");
  // `trailPeakR == null` means the peak was NEVER TRACKED (pre-ruler), which is
  // not the same claim as "this trade never moved". Conflating the two inflated
  // the dead-on-arrival class from 8 rows to 27 — the exact kind of reading a
  // per-trade pass exists to catch.
  if (t.trailPeakR == null) flags.push("peak untracked");
  else if (t.trailPeakR < 0.15) flags.push("dead on arrival");
  if (peak >= 1) flags.push(`gave back ${r2(peak)}R`);
  console.log(
    `  ${String(i + 1).padStart(3)}  ${utc(t.entryTime).padEnd(12)} ${t.coin.padEnd(5)} ${r2(r).padStart(6)} ` +
      `${(thru >= 0 ? "+" : "") + thru.toFixed(2)}`.padStart(6) +
      ` ${(Number.isFinite(slip) ? (slip >= 0 ? "+" : "") + slip.toFixed(0) : "—").padStart(7)} ` +
      // A TRACKED peak of exactly 0 (the sampler recorded no favourable
      // excursion) is a real reading and must not print the same "—" as a peak
      // that was never tracked at all. Those are different claims.
      `${(t.trailPeakR == null ? "—" : r2(t.trailPeakR)).padStart(6)} ${hrs((t.exitTime ?? 0) - t.entryTime).padStart(5)}h ` +
      `${(t.session ?? "—").padEnd(7)} ${(gap == null ? "—" : `${gap}m`).padStart(6)}  ${flags.join(" · ")}`,
  );
});

// ── Stop anomaly classes, each named with its members ──────────────────────
console.log("\n## Stop anomaly classes");
const classes: Array<[string, (t: LiveRow) => boolean]> = [
  ["filled >5bps through the stop", (t) => { const s = slipBps(t); return Number.isFinite(s) && s > 5; }],
  ["lost more than the stop allowed (>1.05R)", (t) => (t.realizedR ?? 0) < -1.05],
  ["peak NEVER TRACKED (pre-ruler, unknown)", (t) => t.trailPeakR == null],
  ["dead on arrival (tracked peak < 0.15R)", (t) => t.trailPeakR != null && t.trailPeakR < 0.15],
  ["never reached +1R", (t) => (t.trailPeakR ?? 0) < 1],
  ["gave back a +1R peak", (t) => (t.trailPeakR ?? 0) >= 1],
  ["no exchange bracket", (t) => t.exchangeStop !== true],
  ["re-entered the same coin within 60m of the stop", (t) => { const g = nextSameCoinGapMin(t); return g != null && g <= 60; }],
];
for (const [name, test] of classes) {
  const hit = stops.filter(test);
  console.log(
    `  ${name.padEnd(44)} n=${String(hit.length).padStart(3)}/${stops.length}  net ${hit.reduce((s, t) => s + (t.realizedR ?? 0), 0).toFixed(2).padStart(7)}R`,
  );
  if (hit.length && hit.length <= 14) {
    console.log(`      ${hit.map((t) => `${t.coin} ${utc(t.entryTime)}`).join(" | ")}`);
  }
}
console.log("\n  session spread of the stops:");
const sess = new Map<string, number>();
for (const t of stops) sess.set(t.session ?? "—", (sess.get(t.session ?? "—") ?? 0) + 1);
for (const [k, v] of [...sess.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`      ${k.padEnd(8)} ${String(v).padStart(3)}`);
}
