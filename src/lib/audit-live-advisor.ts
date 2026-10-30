#!/usr/bin/env bun
/**
 * LIVE ADVISOR PERFORMANCE AUDIT (2026-09-23) — "how do the 4H advisors
 * perform in the live trades? Check it thoroughly."
 *
 * METHOD (honest reconstruction, not forward data): advisorTicks rows are
 * pruned after 48h, so the per-pair advisor state AT each live entry is gone.
 * But the verdict is a pure function of the 4H kline series (evaluateAdvisor,
 * src/lib/htf-advisor.ts) — so for every live trade we take the 4H klines up
 * to the last CLOSED 4H bar at entry time, run the exact detector the engines
 * run, and read off:
 *   · longVotes / shortVotes and status (veto would have blocked the entry —
 *     fail-open stale-doc cases included),
 *   · WHICH of the 7 signal sources fired (stochRsi/obv/ad/cmf divergence,
 *     macd, vwapExhaust, thinZone),
 *   · the trade's realized R (the live ledger's native R field).
 *
 * Population: ALL closed live trades (raw scan — no sampling). Config read
 * from the live row so the weights/thresholds match what the book enforces.
 *
 * CAVEATS (recorded, not hidden):
 *  · 1H advisor layer is NOT reconstructed (it runs on hourly bars; separate
 *    cache depth and detector instance). This audit prices the 4H layer.
 *  · The reconstruction assumes the advisor doc was fresh at entry. The
 *    engine fails OPEN on a stale doc (>5h old); we cannot distinguish that
 *    from the ledger, so 'veto at entry' rows are labeled "would have
 *    blocked under fresh-doc assumption".
 *  · rSign conventions: liveTrades rows carry `realizedR`. Realized
 *    R includes funding/fees via the row's own accounting — same number the
 *    live book journals.
 *
 * Usage: bun run audit:advisor
 */

import { getCachedKlines } from "./kline-cache";
import type { Kline } from "./types";
import { evaluateAdvisor, ADVISOR_MACD_DEFAULTS, ADVISOR_STOCHRSI_DEFAULTS } from "./htf-advisor";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api";

const TF_4H = 4 * 3_600_000;
const BAR_CLOSE_FLOOR = (t: number) => Math.floor(t / TF_4H) * TF_4H - TF_4H; // last closed 4h bar's OPEN time given t
const WARMUP_4H = 300;

type LiveRow = {
  _id: string;
  coin: string; // liveTrades keys the instrument as `coin` (no _USDT suffix)
  type: string; // "LONG" | "SHORT"
  entryTime: number;
  exitTime?: number;
  status?: string; // open/closed
  realizedR?: number;
  reason?: string;
  shadowTags?: string[];
  // Needed to split the population by exit type (see the stop-out section).
  slPrice?: number;
  exitPrice?: number;
  trailPeakR?: number;
};

async function fetchLiveRows(client: ConvexHttpClient): Promise<LiveRow[]> {
  // getLiveTradesRaw collects the whole table (no args).
  const res = await client.query(api.liveEngine.getLiveTradesRaw, {});
  return (res as unknown as LiveRow[]) ?? [];
}

async function fetchLiveCfg(client: ConvexHttpClient) {
  const cfg = await client.query(api.strategyEngine.getConfig, { book: "live" });
  return cfg as unknown as Record<string, any>;
}

// ── Build the advisor cfg EXACTLY as the live book resolves it ───────────────
function advisorCfgFrom(c: Record<string, any>) {
  return {
    advisorVetoThreshold: c.advisorVetoThreshold ?? 2,
    advisorLongThreshold: c.advisorLongThreshold ?? 2,
    advisorShortThreshold: c.advisorShortThreshold ?? 1,
    advisorStrongWeight: c.advisorStrongWeight ?? 2,
    advisorWeakWeight: c.advisorWeakWeight ?? 0.5,
    advisorMacdEnabled: c.advisorMacdEnabled ?? true,
    advisorMacdWeight: c.advisorMacdWeight ?? 1,
    ...ADVISOR_MACD_DEFAULTS,
    advisorSmartVolEnabled: c.advisorSmartVolEnabled ?? false,
    advisorSmartVolWeight: c.advisorSmartVolWeight ?? 0,
    advisorRsiDivEnabled: c.advisorRsiDivEnabled ?? false,
    advisorRsiDivWeight: c.advisorRsiDivWeight ?? 0,
    advisorStochRsiEnabled: c.advisorStochRsiEnabled ?? true,
    ...ADVISOR_STOCHRSI_DEFAULTS,
    advisorDivergenceAgeBars: c.advisorDivergenceAgeBars ?? 4,
    advisorVwapExtremePct: c.advisorVwapExtremePct ?? 3,
    advisorRsiExtreme: c.advisorRsiExtreme ?? 70,
  };
}

// ── R/pf helpers ─────────────────────────────────────────────────────────────
function mean(a: number[]): number { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN; }
function pf(rs: number[]): number {
  const gp = rs.filter((r) => r > 0).reduce((s, v) => s + v, 0);
  const gl = -rs.filter((r) => r < 0).reduce((s, v) => s + v, 0);
  return gl > 0 ? gp / gl : gp > 0 ? Infinity : NaN;
}
const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : "—");

async function main(): Promise<void> {
  const url = process.env.CONVEX_URL ?? process.env.VITE_CONVEX_URL;
  if (!url) { console.error("no CONVEX_URL in env"); process.exit(1); }
  const client = new ConvexHttpClient(url);

  const cfgRow = await fetchLiveCfg(client);
  const acfg = advisorCfgFrom(cfgRow);
  const rows = await fetchLiveRows(client);
  const closed = rows.filter((r) => r.exitTime && r.realizedR != null);
  console.log(`live rows: ${rows.length} · closed with R: ${closed.length}\n`);

  // Group by pair; one 4h fetch per pair.
  const byPair = new Map<string, LiveRow[]>();
  for (const t of closed) {
    const key = t.coin ?? (t as any).pair;
    const a = byPair.get(key) ?? [];
    a.push(t);
    byPair.set(key, a);
  }

  type Tagged = { row: LiveRow; votes: number; status: string; reasons: string[]; flags: string[] };
  const tagged: Tagged[] = [];

  for (const [pair, trades] of byPair) {
    let k4h: Awaited<ReturnType<typeof getCachedKlines>> = [];
    try {
      k4h = await getCachedKlines(pair, "4h", { localOnly: true });
    } catch { /* fallthrough */ }
    if (!k4h || k4h.length < 60) {
      try {
        k4h = await getCachedKlines(pair, "4h", { startMs: WARMUP_4H * TF_4H, localOnly: false });
      } catch { continue; }
    }
    // Join on the last CLOSED 4h bar at entry time. klinesCache closes at
    // endMs=now, so entries near the newest closed bar can sit beyond the
    // cached tail — fall back to the newest bar whose openTime < entryTime.
    const rowsIdx = trades.map((t) => {
      const barOpen = BAR_CLOSE_FLOOR(t.entryTime);
      let j = k4h.findIndex((k) => k.openTime === barOpen);
      if (j < 0) j = k4h.findIndex((k) => k.closeTime > t.entryTime) - 1;
      if (j < 0) j = k4h.length - 1; // entry beyond cached tail: newest bar
      return { t, j };
    }).filter((x) => x.j >= 30);

    // evaluateAdvisor types its input as the full Kline; the cache rows carry
    // OHLCV + times, which is all the detector reads.
    const asK = k4h as unknown as Kline[];
    for (const { t, j } of rowsIdx) {
      const state = evaluateAdvisor(asK.slice(0, j + 1), acfg as any);
      if (!state) continue;
      const side = t.type as "LONG" | "SHORT";
      const votes = side === "LONG" ? state.long.votes : state.short.votes;
      const status = side === "LONG" ? state.long.status : state.short.status;
      const reasons = side === "LONG" ? state.long.reasons : state.short.reasons;
      // Which individual sources fired on this side (the state is flat):
      const m = state;
      const flags: string[] = [];
      if (side === "LONG") {
        if (m.rsiBear) flags.push("stochRsi-div");
        if (m.obvBear) flags.push("obv-div");
        if (m.adBear) flags.push("ad-div");
        if (m.cmfBear) flags.push("cmf-div");
        if (m.histXDown) flags.push("macd-flip");
        if (m.vwapExhaustLong) flags.push("vwap-exhaust");
        if (m.thinZoneLong) flags.push("thin-zone");
      } else {
        if (m.rsiBull) flags.push("stochRsi-div");
        if (m.obvBull) flags.push("obv-div");
        if (m.adBull) flags.push("ad-div");
        if (m.cmfBull) flags.push("cmf-div");
        if (m.histXUp) flags.push("macd-flip");
        if (m.vwapExhaustShort) flags.push("vwap-exhaust");
        if (m.thinZoneShort) flags.push("thin-zone");
      }
      tagged.push({ row: t, votes, status, reasons, flags });
    }
  }

  console.log(`advisor state reconstructed for ${tagged.length}/${closed.length} closed live trades\n`);

  // ── 1. Verdict distribution + pricing ──────────────────────────────────────
  const price = (label: string, g: Tagged[]) => {
    if (!g.length) { console.log(`${label.padEnd(30)} n=0`); return; }
    const rs = g.map((x) => x.row.realizedR!);
    console.log(
      `${label.padEnd(30)} n=${String(g.length).padStart(3)}  net ${f(rs.reduce((s, v) => s + v, 0), 2).padStart(7)}R  R/t ${f(mean(rs))}  WR ${f((rs.filter((r) => r > 0).length / rs.length) * 100, 1)}%  PF ${f(pf(rs))}`,
    );
  };
  console.log("── ADVISOR STATE AT ENTRY vs realized R ──");
  const wouldVeto = tagged.filter((x) => x.status === "veto");
  price("veto fired (would block)", wouldVeto);
  price("1 vote", tagged.filter((x) => x.status !== "veto" && x.votes >= 1));
  price("0 votes (clean)", tagged.filter((x) => x.votes < 1));

  // ── 2. Per-source performance ─────────────────────────────────────────────
  console.log("\n── PER-SOURCE: trades where THIS source fired on the entry side ──");
  const sources = ["stochRsi-div", "obv-div", "ad-div", "cmf-div", "macd-flip", "vwap-exhaust", "thin-zone"];
  for (const src of sources) {
    price(src, tagged.filter((x) => x.flags.includes(src)));
  }

  // ── 2b. STOP-OUT CROSS-TAB (2026-09-24) ───────────────────────────────────
  // The question: when a live position was STOPPED OUT, what had the advisor
  // said about its side at entry? An advisor whose veto is concentrated in the
  // stop population is doing its job; one that appears equally in the winners
  // is noise wearing a signal's clothes. Stops are identified the same way
  // audit-live-book.ts identifies them — the fill landed within ±0.5% of the
  // row's own slPrice — so the two reports cannot disagree about which trades
  // were stops.
  const isStop = (t: LiveRow) => {
    const px = t.exitPrice ?? 0;
    return (t.slPrice ?? 0) > 0 && px > 0 && Math.abs(px - (t.slPrice as number)) / (t.slPrice as number) <= 0.005;
  };
  const stopTagged = tagged.filter((x) => isStop(x.row));
  const noStopTagged = tagged.filter((x) => !isStop(x.row));
  console.log(`\n── ADVISOR AT ENTRY · STOP-OUTS vs THE REST ──`);
  console.log(`stop-outs ${stopTagged.length} · everything else ${noStopTagged.length}\n`);
  console.log("inside the STOP population:");
  price("  veto fired (would block)", stopTagged.filter((x) => x.status === "veto"));
  price("  exactly 1 vote", stopTagged.filter((x) => x.status !== "veto" && x.votes >= 1));
  price("  0 votes (clean)", stopTagged.filter((x) => x.votes < 1));
  console.log("the same buckets outside the stop population:");
  price("  veto fired (would block)", noStopTagged.filter((x) => x.status === "veto"));
  price("  exactly 1 vote", noStopTagged.filter((x) => x.status !== "veto" && x.votes >= 1));
  price("  0 votes (clean)", noStopTagged.filter((x) => x.votes < 1));
  console.log("\nper-source, STOP population only:");
  for (const src of sources) price(`  ${src}`, stopTagged.filter((x) => x.flags.includes(src)));
  console.log("\nevery stop-out row, with the advisor's entry-time read:");
  for (const x of [...stopTagged].sort((a, b) => a.row.entryTime - b.row.entryTime)) {
    console.log(
      `    ${new Date(x.row.entryTime).toISOString().slice(5, 16).replace("T", " ")} ` +
        `${String(x.row.coin).padEnd(5)} ${f(x.row.realizedR!, 2).padStart(6)}R  ` +
        `peak ${f(x.row.trailPeakR ?? 0, 2).padStart(5)}  ${x.status.padEnd(5)} v${x.votes}  [${x.flags.join(", ")}]`,
    );
  }

  // ── 3. What-if: had LONG needed 2 vs SHORT 1 (the shipped rule) — count ────
  // How many of today's LIVE trades would the shipped thresholds have blocked?
  const blockedShipped = wouldVeto.length;
  const blockedNet = wouldVeto.reduce((s, x) => s + x.row.realizedR!, 0);
  console.log(`\n── SHIPPED RULE APPLIED TO THIS LEDGER ──`);
  console.log(`entries with advisor veto at entry time: ${blockedShipped}/${tagged.length} · their net R: ${f(blockedNet)}R`);
  if (wouldVeto.length) {
    const rs = wouldVeto.map((x) => x.row.realizedR!);
    console.log(`  → the veto population's R/t ${f(mean(rs))} vs book ${f(mean(tagged.map((x) => x.row.realizedR!)))} · WR ${f((rs.filter((r) => r > 0).length / rs.length) * 100, 1)}%`);
    for (const x of wouldVeto) {
      const p = x.row.coin ?? (x.row as any).pair;
      console.log(`    ${p} ${x.row.type} ${new Date(x.row.entryTime).toISOString().slice(5, 16)}  ${f(x.row.realizedR!)}R  [${x.flags.join(", ")}]`);
    }
  }

  // ── BTC-mirror short analysis ─────────────────────────────────────────────
  // live runs advisorMode "pair" for the 4H layer, but the 1H layer runs
  // mode "btc" — BTC's verdict gates BOTH sides. Reconstruct BTC's 4H state
  // at each entry and price "what if BTC had vetoed this side".
  try {
    let btc4h: Awaited<ReturnType<typeof getCachedKlines>> = [];
    try { btc4h = await getCachedKlines("BTC", "4h", { localOnly: true }); } catch {}
    if (btc4h && btc4h.length > 60) {
      const asB = btc4h as unknown as Kline[];
      let veto = 0, vetoNet = 0, clean = 0, cleanNet = 0;
      for (const x of tagged) {
        const barOpen = BAR_CLOSE_FLOOR(x.row.entryTime);
        let j = asB.findIndex((k) => k.openTime === barOpen);
        if (j < 0) j = asB.findIndex((k) => k.closeTime > x.row.entryTime) - 1;
        if (j < 0) j = asB.length - 1;
        if (j < 30) continue;
        const st = evaluateAdvisor(asB.slice(0, j + 1), acfg as any);
        if (!st) continue;
        const side = x.row.type as "LONG" | "SHORT";
        const votes = side === "LONG" ? st.long.votes : st.short.votes;
        const thr = side === "LONG" ? (acfg.advisorLongThreshold as number) : (acfg.advisorShortThreshold as number);
        if (votes >= thr) { veto++; vetoNet += x.row.realizedR!; }
        else { clean++; cleanNet += x.row.realizedR!; }
      }
      console.log(`\n── BTC-MIRROR 4H VERDICT AT ENTRY (what the 1H layer's mode would do on 4H) ──`);
      console.log(`  BTC would veto: n=${veto} net ${f(vetoNet)}R · clean: n=${clean} net ${f(cleanNet)}R`);
    }
  } catch { /* BTC cache missing — skip */ }
}

main().catch((e) => { console.error(e); process.exit(1); });
