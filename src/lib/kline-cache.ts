/**
 * KLINE CACHE — local disk cache for MEXC futures klines (lab/backtest use).
 *
 * WHY: every lab run used to re-download the same bars from MEXC (the old
 * fetch-1m5m-data wrote to /tmp, which evaporates). This module keeps one
 * columnar JSON file per (pair, interval) under data/klines/ and fetches ONLY
 * the missing head/tail on subsequent runs, so the exchange is touched once
 * per gap instead of on every experiment.
 *
 * FIXED START DATE: CACHE_START_MS below is the single source of truth for
 * how far back the dataset goes (set to 120 days before 2026-09-12 — covers
 * the deepest lab window (90d) plus the 30d BTC warmup the percentile-EMA
 * regime needs, while staying small enough to seed in one pass). Change that
 * one constant to move the whole dataset's horizon.
 *
 * FILE FORMAT (columnar, mirrors fetch-1m5m-data.ts to keep files small):
 *   { pair, interval, startMs, endMs, updatedAt, time[], open[], high[], low[], close[], vol[] }
 *
 * NODE-ONLY: uses node:fs — never import this from src/convex (actions have
 * no filesystem). Scripts and labs only.
 *
 * Usage from a lab:
 *   import { getCachedKlines } from "./kline-cache";
 *   const bars = await getCachedKlines("SOL", "15m"); // closed bars, CACHE_START → now
 *
 * Seed / refresh everything from the CLI:
 *   bun run src/lib/fetch-kline-cache.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
// Alias-aware symbol mapper — the SINGLE source of truth (tracked-pairs.ts):
// PUMP → PUMPFUN_USDT etc. Using the naive `${pair}_USDT` here silently
// returned 0 bars for aliased pairs (found on the 2026-09-01 seed).
import { toMexcSymbol } from "./tracked-pairs";

// ── The dataset horizon ──────────────────────────────────────────────────────
// One constant. 2026-05-15 = 120 days before 2026-09-12.
export const CACHE_START_MS = Date.parse("2026-05-15T00:00:00.000Z");

const CACHE_DIR = path.join(process.cwd(), "data", "klines");
const MEXC_FUTURES = "https://contract.mexc.com";
const POLITE_DELAY_MS = 150; // between paged requests

const INTERVAL_SEC: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

const MEXC_INTERVAL: Record<string, string> = {
  "1m": "Min1",
  "5m": "Min5",
  "15m": "Min15",
  "30m": "Min30",
  "1h": "Min60",
  "4h": "Hour4",
  "1d": "Day1",
};

export type CachedKline = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
};

type CacheFile = {
  pair: string;
  interval: string;
  startMs: number; // requested dataset start (CACHE_START_MS at seed time)
  endMs: number; // newest bar's openTime
  updatedAt: number;
  time: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  vol: number[];
};

function cachePath(pair: string, interval: string): string {
  return path.join(CACHE_DIR, `${pair}-${interval}.json`);
}

/** Fetch every bar whose openTime is inside [startSec, endSec] (paged backwards). */
async function fetchMexcRange(
  pair: string,
  interval: string,
  startSec: number,
  endSec: number,
): Promise<CachedKline[]> {
  const iv = MEXC_INTERVAL[interval];
  const step = INTERVAL_SEC[interval];
  if (!iv || !step) throw new Error(`Unsupported interval: ${interval}`);
  const out: CachedKline[] = [];
  let end = endSec;

  for (let guard = 0; guard < 200; guard++) {
    const start = Math.max(startSec, end - 999 * step);
    const url = `${MEXC_FUTURES}/api/v1/contract/kline/${toMexcSymbol(pair)}?interval=${iv}&start=${start}&end=${end}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`MEXC kline HTTP ${res.status} for ${pair} ${interval}`);
    const json = (await res.json()) as any;
    if (!json.success) throw new Error(`MEXC kline error: ${json.message}`);
    const d = json.data as any;
    const n = d.time?.length ?? 0;
    if (n === 0) break;
    for (let i = 0; i < n; i++) {
      out.push({
        openTime: d.time[i] * 1000,
        open: d.open[i],
        high: d.high[i],
        low: d.low[i],
        close: d.close[i],
        volume: d.vol[i],
        closeTime: d.time[i] * 1000 + step * 1000,
      });
    }
    // Reached the requested window's start (or the listing date).
    if (start <= startSec || n < 900) break;
    end = start - 1;
    await new Promise((r) => setTimeout(r, POLITE_DELAY_MS));
  }

  out.sort((a, b) => a.openTime - b.openTime);
  return out;
}

/** Load a cache file if present, converting columnar → Kline objects. */
function load(pair: string, interval: string): CacheFile | null {
  const p = cachePath(pair, interval);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8")) as CacheFile;
  } catch {
    return null; // corrupt file → refetch
  }
}

function toFile(
  pair: string,
  interval: string,
  bars: CachedKline[],
  datasetStartMs: number,
): CacheFile {
  return {
    pair,
    interval,
    startMs: datasetStartMs,
    endMs: bars.length ? bars[bars.length - 1].openTime : datasetStartMs,
    updatedAt: Date.now(),
    time: bars.map((b) => b.openTime),
    open: bars.map((b) => b.open),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: bars.map((b) => b.close),
    vol: bars.map((b) => b.volume),
  };
}

/**
 * Merge two bar lists by openTime. On collision the FIRST list wins — call
 * it merge(fetched, held) so freshly-fetched (authoritative, final-OHLC)
 * rows overwrite whatever the file held. The openTime collision case is
 * exactly how a stale partial bar gets healed: the tail fetch overlaps the
 * last held bar, and the fetched copy replaces the partial one.
 */
function merge(fetched: CachedKline[], held: CachedKline[]): CachedKline[] {
  const out = new Map<number, CachedKline>();
  for (const k of held) out.set(k.openTime, k); // held first…
  for (const k of fetched) out.set(k.openTime, k); // …fetched wins
  return [...out.values()].sort((x, y) => x.openTime - y.openTime);
}

export type CacheOptions = {
  /** Requested window start (default CACHE_START_MS — fetches older bars if the cache doesn't reach). */
  startMs?: number;
  /** Requested window end (default now). */
  endMs?: number;
  /** Drop the in-progress bar (closeTime in the future). Default true — labs act on closed candles only. */
  closedOnly?: boolean;
  /** Never write to disk (pure read). */
  readOnly?: boolean;
  /**
   * Serve from disk ONLY — never touch MEXC, even to widen the window. Used by
   * the offline shadow book (run-shadow-book.ts), whose whole point is that it
   * costs nothing: no cron, no Convex, no exchange traffic. Callers that want a
   * fresh dataset should refresh with `bun run cache:update` instead.
   */
  localOnly?: boolean;
};

/**
 * Get klines for (pair, interval) from the local cache, fetching from MEXC
 * only the ranges the cache doesn't cover yet, then persisting the merged
 * result. Returns oldest→newest Kline objects ready for the labs.
 */
export async function getCachedKlines(
  pair: string,
  interval: string,
  opts: CacheOptions = {},
): Promise<CachedKline[]> {
  const { closedOnly = true, readOnly = false, localOnly = false } = opts;
  const startMs = opts.startMs ?? CACHE_START_MS;
  const endMs = opts.endMs ?? Date.now();
  const step = INTERVAL_SEC[interval] ?? 900;

  // A bar is only "closed" once its closeTime has passed. Filtering on load
  // AND persist is what keeps a partial (still-forming) OHLC out of the file:
  // MEXC's range endpoint returns the in-progress bar at the head of a range,
  // and without this filter the tail check (which resumes AFTER the last held
  // openTime) would never refetch it — permanently freezing a partial bar in
  // the dataset. (Found by audit-kline-cache on the first seed: 42/42 files.)
  const nowMs = Date.now();
  const isClosed = (b: CachedKline) => b.closeTime <= nowMs;

  const cached = load(pair, interval);
  let bars: CachedKline[] = cached
    ? cached.time
        .map((t, i) => ({
          openTime: t,
          open: cached.open[i],
          high: cached.high[i],
          low: cached.low[i],
          close: cached.close[i],
          volume: cached.vol[i],
          closeTime: t + step * 1000,
        }))
        .filter(isClosed)
    : [];

  // Missing HEAD: requested start is older than what we hold. headEnd
  // OVERLAPS the first held bar (fetched wins the dedupe) so a partial first
  // row can also be healed.
  const heldStart = bars.length ? bars[0].openTime : Infinity;
  if (!localOnly && startMs < heldStart - step * 1000) {
    const headEnd = bars.length ? bars[0].openTime : endMs;
    const head = await fetchMexcRange(pair, interval, Math.floor(startMs / 1000), Math.floor(headEnd / 1000));
    bars = merge(head, bars);
  }

  // Missing TAIL: requested end is newer than what we hold. The fetch starts
  // AT the last held bar's openTime (one-bar overlap, fetched wins the
  // dedupe) so the just-closed bar is always refetched with its FINAL OHLC —
  // a partial copy stored earlier can never survive.
  const heldEnd = bars.length ? bars[bars.length - 1].openTime : -Infinity;
  if (!localOnly && endMs > heldEnd + step * 1000) {
    const tailStart = bars.length ? bars[bars.length - 1].openTime : startMs;
    const tail = await fetchMexcRange(pair, interval, Math.floor(tailStart / 1000), Math.floor(endMs / 1000));
    bars = merge(tail, bars);
  }

  // Persist the widened cache — CLOSED bars only (see isClosed above). Skip
  // when read-only or nothing changed.
  if (!readOnly && bars.length > 0) {
    const closed = bars.filter(isClosed);
    if (closed.length > 0) {
      const persisted = toFile(pair, interval, closed, Math.min(startMs, cached?.startMs ?? startMs));
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      fs.writeFileSync(cachePath(pair, interval), JSON.stringify(persisted));
    }
  }

  return bars
    .filter((b) => b.openTime >= startMs && b.openTime <= endMs)
    .filter((b) => (closedOnly ? b.closeTime <= Date.now() : true));
}

/** Coverage report for the seed CLI: what's on disk for one file. */
export function cacheInfo(pair: string, interval: string) {
  const f = load(pair, interval);
  if (!f) return null;
  return {
    pair: f.pair,
    interval: f.interval,
    bars: f.time.length,
    start: new Date(f.time[0]).toISOString(),
    end: new Date(f.time[f.time.length - 1] + INTERVAL_SEC[f.interval] * 1000).toISOString(),
    updatedAt: f.updatedAt,
  };
}
