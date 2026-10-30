#!/usr/bin/env bun
// KLINE PURITY AUDIT — is the data we backtest on clean?
//
// Checks per (coin, timeframe) file:
//   1. duplicate openTimes
//   2. non-monotonic time
//   3. gaps in the 1H grid (missing hours) — counted, largest gap reported
//   4. OHLC validity: high >= max(open,close,low), low <= min(open,close,high)
//   5. non-finite / non-positive prices
//   6. zero or negative volume
//   7. partial (unclosed) tail bar — closeTime in the future
//   8. flat bars (open==high==low==close) — a known MEXC artifact when a bar
//      has no trades; counted separately, not treated as corruption
//   9. extreme 1-bar moves (|ret| > 35%) — spike/erroneous-print candidates
//
// Usage: bun run src/lib/luxphase2/audit-klines.ts <dir> [interval] [coin...]
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? "data/lab/luxalgo/cache-4y";
const interval = process.argv[3] ?? "1h";
const only = process.argv.slice(4);
const STEP = interval === "1h" ? 3600_000 : interval === "15m" ? 900_000 : 3600_000;

const files = fs.readdirSync(dir).filter((f) => f.endsWith(`-${interval}.json`))
  .filter((f) => !only.length || only.includes(f.replace(`-${interval}.json`, "")));

type Row = { coin: string; bars: number; dup: number; nonMono: number; gaps: number; maxGapH: number; badOHLC: number; badPx: number; zeroVol: number; partial: number; flat: number; spikes: number; start: string; end: string };
const rows: Row[] = [];

for (const f of files) {
  const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  const coin = f.replace(`-${interval}.json`, "");
  const t: number[] = j.time ?? [];
  const o: number[] = j.open, h: number[] = j.high, l: number[] = j.low, c: number[] = j.close, v: number[] = j.vol ?? [];

  let dup = 0, nonMono = 0, gaps = 0, maxGapH = 0, badOHLC = 0, badPx = 0, zeroVol = 0, flat = 0, spikes = 0;
  const seen = new Set<number>();
  const now = Date.now();

  for (let i = 0; i < t.length; i++) {
    if (seen.has(t[i])) dup++;
    seen.add(t[i]);
    if (i > 0 && t[i] <= t[i - 1]) nonMono++;
    if (i > 0) {
      const d = (t[i] - t[i - 1]) / STEP;
      if (d > 1.5) { gaps += 1; maxGapH = Math.max(maxGapH, d * (STEP / 3600_000)); }
    }
    const [O, H, L, C] = [o[i], h[i], l[i], c[i]];
    if (![O, H, L, C].every(Number.isFinite) || O <= 0 || H <= 0 || L <= 0 || C <= 0) { badPx++; continue; }
    if (H < Math.max(O, C, L) - 1e-12 || L > Math.min(O, C, H) + 1e-12) badOHLC++;
    if (!(v[i] > 0)) zeroVol++;
    if (H === L && O === C && H === O) flat++;
    // revert-gap spike guard: >35% move from the PREVIOUS close (same bar) — likely a bad print
    if (i > 0 && Number.isFinite(c[i - 1]) && c[i - 1] > 0) {
      const ret = Math.abs(C / c[i - 1] - 1);
      if (ret > 0.35) spikes++;
    }
  }
  const partial = t.length && t[t.length - 1] + STEP > now ? 1 : 0;

  rows.push({
    coin, bars: t.length, dup, nonMono, gaps, maxGapH, badOHLC, badPx, zeroVol, partial, flat, spikes,
    start: t.length ? new Date(t[0]).toISOString().slice(0, 10) : "n/a",
    end: t.length ? new Date(t[t.length - 1]).toISOString().slice(0, 10) : "n/a",
  });
}

const pad = (s: any, w: number) => String(s).padEnd(w);
const padL = (s: any, w: number) => String(s).padStart(w);
console.log(`\nKLINE AUDIT — ${dir} (${interval})  files=${rows.length}\n`);
console.log(`${pad("coin", 8)}${padL("bars", 7)}${padL("dup", 5)}${padL("nonMono", 8)}${padL("gaps", 6)}${padL("maxGapH", 9)}${padL("badOHLC", 9)}${padL("badPx", 7)}${padL("zeroVol", 9)}${padL("flat", 7)}${padL("spikes", 8)}${padL("part", 6)}  window`);
let T = { bars: 0, dup: 0, nonMono: 0, gaps: 0, badOHLC: 0, badPx: 0, zeroVol: 0, flat: 0, spikes: 0, partial: 0 };
for (const r of rows.sort((a, b) => a.coin.localeCompare(b.coin))) {
  console.log(`${pad(r.coin, 8)}${padL(r.bars, 7)}${padL(r.dup, 5)}${padL(r.nonMono, 8)}${padL(r.gaps, 6)}${padL(r.maxGapH.toFixed(0), 9)}${padL(r.badOHLC, 9)}${padL(r.badPx, 7)}${padL(r.zeroVol, 9)}${padL(r.flat, 7)}${padL(r.spikes, 8)}${padL(r.partial, 6)}  ${r.start} -> ${r.end}`);
  for (const k of Object.keys(T) as (keyof typeof T)[]) T[k] += (r as any)[k];
}
console.log(`\nTOTALS  bars=${T.bars} dup=${T.dup} nonMono=${T.nonMono} gaps=${T.gaps} badOHLC=${T.badOHLC} badPx=${T.badPx} zeroVol=${T.zeroVol} flat=${T.flat} spikes=${T.spikes} partial=${T.partial}`);
const fatal = T.dup + T.nonMono + T.badOHLC + T.badPx + T.partial;
console.log(`\nFATAL ISSUES (dup+nonMono+badOHLC+badPx+partial): ${fatal}`);
console.log(`ADVISORY (gaps=${T.gaps}, zeroVol=${T.zeroVol}, flat=${T.flat}, spikes=${T.spikes}) — exchange microstructure, retained`);
console.log(`VERDICT: ${fatal === 0 ? "PURE — no structural corruption found" : "IMPURE — investigate before trusting results"}\n`);
// Keyed by interval: two intervals audited in the same dir must not clobber
// each other's evidence (found when the 15m run overwrote the 1h report).
fs.writeFileSync(`${dir}/_audit-${interval}.json`, JSON.stringify({ dir, interval, generatedAt: new Date().toISOString(), totals: T, rows }, null, 1));
