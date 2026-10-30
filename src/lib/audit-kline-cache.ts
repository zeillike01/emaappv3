/**
 * KLINE CACHE AUDIT — verify the on-disk dataset is actually trustworthy.
 *
 *   bun run src/lib/audit-kline-cache.ts            # structure + integrity, all files
 *   bun run src/lib/audit-kline-cache.ts --live     # + fetch live bars and diff them
 *
 * Checks per (pair, interval) file:
 *   1. column arrays all same length, non-empty
 *   2. openTime strictly increasing, zero duplicates
 *   3. bar spacing = k × interval (counts internal gaps — halts/missing data)
 *   4. OHLC sanity: high ≥ max(open,close), low ≤ min(open,close), prices > 0
 *   5. STALE-FORMING detection: last bar's closeTime > file updatedAt → the
 *      bar was still forming when cached, so its OHLC is partial and must be
 *      refreshed on the next tail fetch (merge precedence decides if it CAN be)
 *   6. coverage vs CACHE_START_MS
 *   7. CROSS-INTERVAL consistency (always on): a 1h bar's OHLC must equal the
 *      aggregate of its four 15m bars (o = first open, c = last close,
 *      h = max highs, l = min lows, vol ≈ sum). This is the independent
 *      wrong-symbol tripwire: files fetch independently, so a pair filled
 *      from the WRONG MEXC market in one interval fails to match the others
 *      without any network call at all.
 *   8. LIVE PRICE sanity (--live or always? see --no-price): one batch ticker
 *      call per run; each pair's newest cached 15m close must sit within a
 *      few % of the exchange's current price. Catches a cache whose newest
 *      bars belong to a different market than the tracked universe.
 * With --live: re-fetch a sample of stored bars directly from MEXC and diff
 * OHLCV exactly — catches silent corruption (unit mixups, revision, merge bugs).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { CACHE_START_MS } from "./kline-cache";
// Alias-aware symbol mapper — the live check must hit the SAME market the
// seeder hit. Naive `${pair}_USDT` made every PUMP bar "not returned by MEXC"
// (its real symbol is PUMPFUN_USDT), which read as poisoned data when the
// poison was in the check, not the cache.
import { toMexcSymbol } from "./tracked-pairs";

const CACHE_DIR = path.join(process.cwd(), "data", "klines");
const MEXC_FUTURES = "https://contract.mexc.com";

const INTERVAL_SEC: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600, "4h": 14400, "1d": 86400,
};
const MEXC_INTERVAL: Record<string, string> = {
  "1m": "Min1", "5m": "Min5", "15m": "Min15", "30m": "Min30", "1h": "Min60", "4h": "Hour4", "1d": "Day1",
};

type CacheFile = {
  pair: string; interval: string; startMs: number; endMs: number; updatedAt: number;
  time: number[]; open: number[]; high: number[]; low: number[]; close: number[]; vol: number[];
};

type Issue = { file: string; kind: string; detail: string };

async function fetchLiveBars(pair: string, interval: string, startSec: number, endSec: number) {
  const url = `${MEXC_FUTURES}/api/v1/contract/kline/${toMexcSymbol(pair)}?interval=${MEXC_INTERVAL[interval]}&start=${startSec}&end=${endSec}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as any;
  if (!json.success) throw new Error(json.message ?? "mexc error");
  const d = json.data as any;
  const step = INTERVAL_SEC[interval];
  const out: Record<number, { o: number; h: number; l: number; c: number; v: number }> = {};
  for (let i = 0; i < (d.time?.length ?? 0); i++) {
    out[d.time[i] * 1000] = { o: d.open[i], h: d.high[i], l: d.low[i], c: d.close[i], v: d.vol[i] };
  }
  void step;
  return out;
}

async function main() {
  const withLive = process.argv.includes("--live");
  // Expected dataset horizon can be narrowed: `--since 2026-09-01` validates
  // coverage from that date (e.g. after a windowed seed) instead of flagging
  // every file that legitimately starts later than CACHE_START_MS.
  const sinceIdx = process.argv.indexOf("--since");
  const sinceArg = sinceIdx >= 0 ? process.argv[sinceIdx + 1] : undefined;
  const expectedStart = sinceArg ? Date.parse(`${sinceArg}T00:00:00.000Z`) : CACHE_START_MS;
  if (Number.isNaN(expectedStart)) throw new Error(`Bad --since value: ${sinceArg}`);
  const issues: Issue[] = [];
  let filesChecked = 0;
  let barsChecked = 0;
  let liveDiffs = 0;
  let liveChecked = 0;
  let crossIntervalChecked = 0;

  const files = fs.existsSync(CACHE_DIR)
    ? fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith(".json")).sort()
    : [];

  if (files.length === 0) {
    console.log("No cache files found in data/klines/ — run `bun run cache:seed` first.");
    return;
  }

  for (const fileName of files) {
    const f = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, fileName), "utf8")) as CacheFile;
    filesChecked++;
    const step = INTERVAL_SEC[f.interval];
    const n = f.time.length;

    const bad = (kind: string, detail: string) => issues.push({ file: fileName, kind, detail });

    // 1. array lengths
    if (n === 0) { bad("empty", "no bars"); continue; }
    if (f.open.length !== n || f.high.length !== n || f.low.length !== n || f.close.length !== n || f.vol.length !== n) {
      bad("ragged-columns", `time=${n} open=${f.open.length} high=${f.high.length} low=${f.low.length} close=${f.close.length} vol=${f.vol.length}`);
      continue;
    }

    // 2. monotonic + dedupe
    let dups = 0, unordered = 0;
    for (let i = 1; i < n; i++) {
      if (f.time[i] === f.time[i - 1]) dups++;
      else if (f.time[i] < f.time[i - 1]) unordered++;
    }
    if (dups) bad("duplicate-openTimes", `${dups} duplicate(s)`);
    if (unordered) bad("unordered", `${unordered} out-of-order pair(s)`);

    // 3. spacing → internal gaps
    let gaps = 0;
    let firstGap: string | null = null;
    for (let i = 1; i < n; i++) {
      const delta = f.time[i] - f.time[i - 1];
      if (delta !== step * 1000) {
        gaps++;
        if (!firstGap) firstGap = `${new Date(f.time[i - 1]).toISOString()} → +${delta / 1000}s`;
      }
    }
    if (gaps) bad("internal-gaps", `${gaps} gap(s); first: ${firstGap}`);

    // 4. OHLC sanity
    let badBars = 0;
    for (let i = 0; i < n; i++) {
      const { open: o, high: h, low: l, close: c } = f;
      if (!(o[i] > 0) || !(h[i] > 0) || !(l[i] > 0) || !(c[i] > 0) ||
          h[i] < Math.max(o[i], c[i]) || l[i] > Math.min(o[i], c[i]) || h[i] < l[i]) {
        badBars++;
        if (badBars <= 3) bad("ohlc-sanity", `bar ${new Date(f.time[i]).toISOString()} o=${o[i]} h=${h[i]} l=${l[i]} c=${c[i]}`);
      }
    }
    if (badBars > 3) bad("ohlc-sanity", `... ${badBars} total bad bars`);
    barsChecked += n;

    // 5. stale-forming tail
    const lastClose = f.time[n - 1] + step * 1000;
    if (lastClose > f.updatedAt) {
      bad("stale-forming-tail", `last bar ${new Date(f.time[n - 1]).toISOString()} closed ${new Date(lastClose).toISOString()} > updatedAt ${new Date(f.updatedAt).toISOString()} — partial OHLC on disk`);
    }

    // 6. coverage — each file is validated against the LATER of the audit
    // horizon (--since) and the file's OWN recorded request start (f.startMs =
    // what its seed was asked for). A file requested from 2026-09-01 isn't
    // flagged for starting 2026-09-01; one that promised 2026-05-15 but
    // delivers less still is.
    const fileExpected = Math.max(expectedStart, f.startMs ?? expectedStart);
    if (f.time[0] > fileExpected) {
      bad("coverage", `starts ${new Date(f.time[0]).toISOString()} — expected from ${new Date(fileExpected).toISOString()} (listing date or empty head-fetch)`);
    }

    // 7. live fidelity spot-check (5 bars spread across the file)
    if (withLive) {
      const samples = [0.05, 0.3, 0.55, 0.8, n - 1].map((frac) => Math.min(n - 1, Math.floor(frac * n)));
      for (const idx of samples) {
        const t = f.time[idx];
        try {
          const live = await fetchLiveBars(f.pair, f.interval, Math.floor(t / 1000), Math.floor(t / 1000) + 1);
          const lb = live[t];
          liveChecked++;
          if (!lb) { issues.push({ file: fileName, kind: "live-missing", detail: `bar ${new Date(t).toISOString()} not returned by MEXC` }); continue; }
          const diffs: string[] = [];
          if (lb.o !== f.open[idx]) diffs.push(`open ${f.open[idx]}≠${lb.o}`);
          if (lb.h !== f.high[idx]) diffs.push(`high ${f.high[idx]}≠${lb.h}`);
          if (lb.l !== f.low[idx]) diffs.push(`low ${f.low[idx]}≠${lb.l}`);
          if (lb.c !== f.close[idx]) diffs.push(`close ${f.close[idx]}≠${lb.c}`);
          if (lb.v !== f.vol[idx]) diffs.push(`vol ${f.vol[idx]}≠${lb.v}`);
          if (diffs.length) {
            liveDiffs++;
            issues.push({ file: fileName, kind: "live-diff", detail: `bar ${new Date(t).toISOString()}: ${diffs.join(", ")}` });
          }
        } catch (e: any) {
          issues.push({ file: fileName, kind: "live-fetch-failed", detail: e?.message ?? String(e) });
        }
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  }

  // Group files once: pair → (interval → parsed file). Shared by checks 7+8.
  const byPair = new Map<string, Map<string, CacheFile>>();
  for (const fileName of files) {
    const f = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, fileName), "utf8")) as CacheFile;
    if (!byPair.has(f.pair)) byPair.set(f.pair, new Map());
    byPair.get(f.pair)!.set(f.interval, f);
  }

  // ── 7. Cross-interval consistency (15m → 1h aggregation) ──
  // Pure internal check, zero MEXC calls. Closed bars are immutable on MEXC,
  // so a 1h bar and its four 15m constituents must agree EXACTLY on OHLC —
  // regardless of when each file was seeded. Volume is summed from the same
  // market's trades but rounding/unit drift is possible; allow 0.1% slack.
  // A mismatch here means at least one of the two files was filled from a
  // different market (or corrupted) — the strongest wrong-symbol tripwire
  // available without trusting the fetch path itself.
  {
    let aggChecked = 0;
    for (const [pair, ivs] of byPair) {
      const f15 = ivs.get("15m");
      const f1h = ivs.get("1h");
      if (!f15 || !f1h) continue;
      const map15 = new Map<number, number>(); // openTime → index
      for (let i = 0; i < f15.time.length; i++) map15.set(f15.time[i], i);
      // Sample up to 8 bars spread through the overlap region of both files
      // (skip the newest 1h bar — its 15m constituents may not all be cached).
      const lo = Math.max(f15.time[0], f1h.time[0]);
      const hiIdx = f1h.time.length - 2;
      let sampled = 0;
      for (let j = 0; j < f1h.time.length && sampled < 8; j++) {
        const idx = Math.min(hiIdx, Math.floor((j / 8) * f1h.time.length));
        const t1h = f1h.time[idx];
        if (t1h < lo) continue;
        const i0 = map15.get(t1h);
        const i1 = map15.get(t1h + 900_000);
        const i2 = map15.get(t1h + 1_800_000);
        const i3 = map15.get(t1h + 2_700_000);
        if (i0 == null || i1 == null || i2 == null || i3 == null) continue;
        aggChecked++;
        sampled++;
        const o = f15.open[i0];
        const c = f15.close[i3];
        const h = Math.max(f15.high[i0], f15.high[i1], f15.high[i2], f15.high[i3]);
        const l = Math.min(f15.low[i0], f15.low[i1], f15.low[i2], f15.low[i3]);
        const vSum = f15.vol[i0] + f15.vol[i1] + f15.vol[i2] + f15.vol[i3];
        const diffs: string[] = [];
        if (f1h.open[idx] !== o) diffs.push(`open ${f1h.open[idx]}≠${o}`);
        if (f1h.close[idx] !== c) diffs.push(`close ${f1h.close[idx]}≠${c}`);
        if (f1h.high[idx] !== h) diffs.push(`high ${f1h.high[idx]}≠${h}`);
        if (f1h.low[idx] !== l) diffs.push(`low ${f1h.low[idx]}≠${l}`);
        if (Math.abs(f1h.vol[idx] - vSum) > vSum * 0.001) diffs.push(`vol ${f1h.vol[idx]}≠Σ${vSum.toFixed(2)}`);
        if (diffs.length) {
          issues.push({ file: `${pair}-1h.json`, kind: "interval-mismatch", detail: `1h bar ${new Date(t1h).toISOString()} vs its four 15m bars: ${diffs.join(", ")}` });
        }
      }
    }
    crossIntervalChecked = aggChecked;
  }

  // ── 8. Live price sanity (one batched ticker call for the whole universe) ──
  // The newest cached 15m close of each pair must sit near the exchange's
  // CURRENT price (crypto drifts, but 15m-old closes should be within a few
  // percent; 15% tolerance = generous). A cache filled with another symbol's
  // OHLC (PONKE vs PONS class of bug) shows up here as an absurd deviation,
  // and the printed price table also makes each pair's price level visually
  // verifiable — distinct levels per distinct market.
  let priceTable: Array<{ pair: string; last: number; live: number | null; devPct: number | null }> = [];
  {
    let livePrices: Map<string, number> | null = null;
    try {
      const { fetchAllTickers } = await import("./mexc/mexcFetchers");
      const uni = await fetchAllTickers();
      livePrices = new Map([...uni.entries()].map(([p, t]) => [p, t.last]));
    } catch {
      // Universe call failed (offline / rate-limited) — skip silently; the
      // bar-level --live diff already covers fidelity when reachable.
      livePrices = null;
    }
    if (livePrices) {
      for (const [pair, ivs] of byPair) {
        const f15 = ivs.get("15m");
        if (!f15) continue;
        const lastClose = f15.close[f15.time.length - 1];
        const live = livePrices.get(pair);
        if (live == null || !(live > 0)) {
          issues.push({ file: `${pair}-15m.json`, kind: "price-no-live", detail: `pair not in MEXC universe ticker — cannot sanity-check price level` });
          priceTable.push({ pair, last: lastClose, live: null, devPct: null });
          continue;
        }
        const devPct = ((lastClose - live) / live) * 100;
        priceTable.push({ pair, last: lastClose, live, devPct });
        if (Math.abs(devPct) > 15) {
          issues.push({ file: `${pair}-15m.json`, kind: "price-sanity", detail: `newest cached close ${lastClose} is ${devPct.toFixed(1)}% from live ${live} — wrong-market or stale tail suspected` });
        }
      }
    }
  }

  console.log("════════════════════════ kline cache audit ════════════════════════");
  console.log(`files: ${filesChecked} · bars: ${barsChecked.toLocaleString()} · horizon: ${new Date(expectedStart).toISOString().slice(0, 10)} → · cross-interval: ${crossIntervalChecked} · live-compared: ${liveChecked}\n`);

  if (priceTable.length > 0) {
    console.log("  price levels (cached 15m close vs live ticker):");
    for (const p of priceTable.sort((a, b) => b.last - a.last)) {
      console.log(`    ${p.pair.padEnd(8)} cached≈${p.last.toPrecision(6).padEnd(12)} live=${p.live != null ? p.live.toPrecision(6) : "—"}${p.devPct != null ? ` (${p.devPct >= 0 ? "+" : ""}${p.devPct.toFixed(2)}%)` : ""}`);
    }
    console.log("");
  }

  if (issues.length === 0) {
    console.log("✅ CLEAN — no structural, cross-interval, or (if --live) fidelity issues found.");
  } else {
    const byKind: Record<string, Issue[]> = {};
    for (const i of issues) (byKind[i.kind] ??= []).push(i);
    console.log(`⚠️  ${issues.length} issue(s):`);
    for (const [kind, list] of Object.entries(byKind)) {
      console.log(`\n  ${kind} × ${list.length}`);
      for (const i of list.slice(0, 6)) console.log(`    ${i.file}: ${i.detail}`);
      if (list.length > 6) console.log(`    … ${list.length - 6} more`);
    }
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
