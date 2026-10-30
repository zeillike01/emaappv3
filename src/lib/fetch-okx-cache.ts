#!/usr/bin/env bun
// Seed/resume OKX SWAP kline cache for deep-history labs.
// Columnar JSON per (coin, interval) under data/klines-okx/, same shape as
// src/lib/kline-cache.ts files: { pair, interval, startMs, endMs, updatedAt,
// time[], open[], high[], low[], close[], vol[] }.
//
// Resumable: month-chunks already fully covered by the file are skipped, the
// file is rewritten after every fetched chunk, and --max-pages bounds one
// invocation so it fits a bounded command. Re-run until "COMPLETE".
//
// Usage:
//   bun run src/lib/fetch-okx-cache.ts --coins=BTC --intervals=5m,15m,1h,4h \
//     --start=2022-08-22 --end=2026-10-07 --workers=3 --max-pages=1400
import fs from "node:fs";
import path from "node:path";
import { fetchOkxChunk, toOkxInst, OKX_STEP_MS, type OkxBar } from "./okx/okxFetchers";

const arg = (n: string) => {
  const h = process.argv.find((a) => a.startsWith(`--${n}=`));
  return h ? h.slice(n.length + 3) : null;
};
const COINS = (arg("coins") ?? "BTC").split(",").filter(Boolean);
const INTERVALS = (arg("intervals") ?? "5m,15m,1h,4h").split(",").filter(Boolean);
const START = Date.parse((arg("start") ?? "2022-08-22") + "T00:00:00Z");
const END = Date.parse((arg("end") ?? "2026-10-07") + "T00:00:00Z");
const WORKERS = Math.max(1, Number(arg("workers") ?? 3));
const MAX_PAGES = Number(arg("max-pages") ?? 1400);
const OUT = arg("out") ?? "data/klines-okx";
fs.mkdirSync(OUT, { recursive: true });

type Col = {
  pair: string; interval: string; startMs: number; endMs: number; updatedAt: number;
  time: number[]; open: number[]; high: number[]; low: number[]; close: number[]; vol: number[];
};

const fpath = (coin: string, iv: string) => path.join(OUT, `${coin}-${iv}.json`);
function load(coin: string, iv: string): Col | null {
  const p = fpath(coin, iv);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")) as Col; } catch { return null; }
}
function save(col: Col) {
  col.endMs = col.time.length ? col.time[col.time.length - 1] : col.startMs;
  col.updatedAt = Date.now();
  fs.writeFileSync(fpath(col.pair, col.interval), JSON.stringify(col));
}
function merge(col: Col, bars: OkxBar[]) {
  const m = new Map<number, number>();
  col.time.forEach((t, i) => m.set(t, i));
  for (const b of bars) {
    const i = m.get(b.openTime);
    if (i === undefined) {
      m.set(b.openTime, col.time.length);
      col.time.push(b.openTime); col.open.push(b.open); col.high.push(b.high);
      col.low.push(b.low); col.close.push(b.close); col.vol.push(b.volume);
    } else {
      col.open[i] = b.open; col.high[i] = b.high; col.low[i] = b.low;
      col.close[i] = b.close; col.vol[i] = b.volume;
    }
  }
  const idx = col.time.map((_, i) => i).sort((a, b) => col.time[a] - col.time[b]);
  for (const k of ["time", "open", "high", "low", "close", "vol"] as const) {
    const arr = col[k] as number[];
    col[k] = idx.map((i) => arr[i]) as never;
  }
}
/**
 * Half-open month chunks [s, e) covering [START, END].
 * OKX bounds are BOTH exclusive — bars satisfy before < t < after — so a
 * chunk is fetched with after=e (covers up to e-step) and before=s-1
 * (covers from s). Coverage requires every step t with s<=t<e held.
 */
function monthChunks(): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const d = new Date(START);
  d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0);
  while (d.getTime() < END) {
    const s = Math.max(d.getTime(), START);
    d.setUTCMonth(d.getUTCMonth() + 1);
    out.push([s, Math.min(d.getTime(), END)]);
  }
  return out;
}
/** True when every step-aligned bar in [s, e) is held. */
function chunkCovered(held: Set<number>, step: number, s: number, e: number): boolean {
  for (let t = Math.ceil(s / step) * step; t < e; t += step) {
    if (!held.has(t)) return false;
  }
  return true;
}

let pageBudget = MAX_PAGES;
let incomplete = false;

async function seedPair(coin: string, iv: string) {
  const step = OKX_STEP_MS[iv];
  const inst = toOkxInst(coin);
  let col = load(coin, iv);
  if (!col) col = { pair: coin, interval: iv, startMs: START, endMs: START, updatedAt: Date.now(), time: [], open: [], high: [], low: [], close: [], vol: [] };
  const held = new Set(col.time);
  const chunks = monthChunks().filter(([s, e]) => !chunkCovered(held, step, s, e));
  if (!chunks.length) { console.log(`${coin}-${iv}: COMPLETE (${col.time.length} bars)`); return; }
  console.log(`${coin}-${iv}: ${chunks.length} month-chunks missing, ${col.time.length} bars held`);
  // worker pool over chunks (oldest first)
  let ci = 0;
  const worker = async () => {
    while (ci < chunks.length && pageBudget > 0) {
      const [s, e] = chunks[ci++];
      // before=s-1 makes the s-bar inclusive (API bound is exclusive)
      const bars = await fetchOkxChunk(inst, iv, s - 1, e, (pages) => { pageBudget -= 0; void pages; });
      merge(col!, bars);
      save(col!);
      pageBudget -= Math.max(1, Math.ceil(bars.length / 100));
    }
  };
  await Promise.all(Array.from({ length: Math.min(WORKERS, chunks.length) }, worker));
  // recount coverage
  const heldNow = new Set(col.time);
  const stillMissing = monthChunks().filter(([s, e]) => !chunkCovered(heldNow, step, s, e));
  if (stillMissing.length && pageBudget <= 0) { incomplete = true; console.log(`${coin}-${iv}: INCOMPLETE (budget spent, ${col.time.length} bars, ${stillMissing.length} chunks left)`); }
  else console.log(`${coin}-${iv}: ${stillMissing.length ? `INCOMPLETE (${stillMissing.length} chunks left)` : `COMPLETE`} (${col.time.length} bars)`);
  if (stillMissing.length) incomplete = true;
}

const t0 = Date.now();
for (const c of COINS) {
  for (const iv of INTERVALS) {
    try { await seedPair(c, iv); }
    catch (e: any) { incomplete = true; console.error(`${c}-${iv}: ERROR ${e?.message ?? e}`); }
    if (pageBudget <= 0) break;
  }
  if (pageBudget <= 0) break;
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)}s ${incomplete ? "(MORE NEEDED — re-run)" : "(ALL COMPLETE)"}`);
