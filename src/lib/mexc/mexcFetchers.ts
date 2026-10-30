/**
 * Shared MEXC API fetchers used by both Layer 1 (marketData.ts) and Layer 2 (strategyEngine.ts).
 * Eliminates duplication and ensures consistent data fetching.
 */

import type { Kline } from "../types";
import { htfTrendFromCloses, htfTrendRawFromCloses } from "../layer2-signal";
import { toMexcSymbol, fromMexcSymbol } from "../tracked-pairs";
import { pacedFetch } from "./rate-gate";

const MEXC_BASE = "https://contract.mexc.com";
const MEXC_V3_BASE = "https://api.mexc.com";

const IV_MAP: Record<string, string> = {
  "1m": "Min1", "5m": "Min5", "15m": "Min15", "30m": "Min30",
  "1h": "Min60", "4h": "Hour4", "1d": "Day1",
};

const IV_SEC: Record<string, number> = {
  "1m": 60, "5m": 300, "15m": 900, "30m": 1800,
  "1h": 3600, "4h": 14400, "1d": 86400,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a MEXC JSON endpoint with retry/backoff on the failure modes that
 * actually happen under Layer 1/2 concurrency: HTTP 429/5xx and MEXC's soft
 * rate-limit replies (HTTP 200 with success:false + "Requests are too
 * frequent"). The Layer 1 tick races ~24 calls per batch with no retry, so
 * the pair-level fetchers that throw (depth, klines) used to drop random
 * pairs every tick. Returns parsed JSON once a non-limited reply arrives.
 */
async function fetchJsonRetry(url: string, retries = 4): Promise<any> {
  let lastErr: any;
  for (let attempt = 0; attempt < retries; attempt++) {
    let res: Response;
    try {
      res = await pacedFetch(url);
    } catch (e) {
      lastErr = e;
      await sleep(400 * (attempt + 1));
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`HTTP ${res.status}`);
      await sleep(500 * (attempt + 1));
      continue;
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(400 * (attempt + 1));
      continue;
    }
    const msg: string = typeof json?.message === "string" ? json.message : "";
    if (json?.success === false && /frequent|too often|limit/i.test(msg)) {
      lastErr = new Error(msg);
      await sleep(600 * (attempt + 1));
      continue;
    }
    return json;
  }
  throw lastErr ?? new Error("fetch failed after retries");
}

/**
 * Fetch klines from MEXC futures API.
 * Returns completed candles only — excludes the live (incomplete) candle.
 *
 * `endMs` anchors the fetch so the newest returned candle is the last one
 * CLOSED at or before that moment (defaults to now). Pass a historical
 * entryTime to reconstruct the exact bar set the engine saw at entry.
 */
export async function fetchKlines(
  coin: string,
  interval: string,
  bars: number,
  endMs?: number,
): Promise<Kline[]> {
  const iv = IV_MAP[interval];
  if (!iv) throw new Error(`Unsupported interval: ${interval}`);
  const step = IV_SEC[interval];
  const collected: Kline[] = [];
  // End one full candle back to exclude the live (incomplete) candle
  let end = Math.floor((endMs ?? Date.now()) / 1000) - step;
  while (collected.length < bars) {
    const start = end - 999 * step;
    const json = await fetchJsonRetry(
      `${MEXC_BASE}/api/v1/contract/kline/${toMexcSymbol(coin)}?interval=${iv}&start=${start}&end=${end}`,
    );
    if (!json.success) throw new Error(`MEXC kline: ${json.message}`);
    const d = json.data as any;
    const n = d.time?.length ?? 0;
    if (n === 0) break;
    for (let i = 0; i < n; i++) {
      collected.push({
        openTime: d.time[i] * 1000,
        open: d.open[i], high: d.high[i], low: d.low[i],
        close: d.close[i], volume: d.vol[i],
        closeTime: d.time[i] * 1000 + step * 1000,
        quoteVolume: d.amount?.[i] ?? 0, trades: 0, isClosed: true,
      });
    }
    end = start - 1;
    if (n < 900) break;
  }
  collected.sort((a, b) => a.openTime - b.openTime);
  return collected.slice(-bars);
}

/**
 * HTF 1h trend read for the direction gates (price-vs-EMA rule,
 * 2026-09-11): SHORT blocked on "up" (last closed 1h close ABOVE the EMA),
 * LONG blocked on "down" (close BELOW the EMA). Mirrors exactly what the
 * engines evaluate at decision time: last <=60 CLOSED 1h bars, close vs
 * EMA(period), fail-open (undefined = allow) when history is short or the
 * fetch fails.
 */
/** Values behind an HTF trend verdict — the bar-guarded cache (2026-09-16)
 *  stores exactly these, and the verdict comes from `htfVerdictOf`, so a cache
 *  hit and a fresh fetch can never disagree. `barOpenTime` is the newest
 *  CLOSED HTF bar the values were computed from (the cache's freshness key). */
export interface HtfTrendRaw {
  ema: number;
  close: number;
  barOpenTime: number;
}

/** up = close ABOVE the EMA (longs ok, shorts vetoed), down = below, flat = equal. */
export function htfVerdictOf(raw: HtfTrendRaw): "up" | "down" | "flat" {
  return raw.ema > raw.close ? "down" : raw.ema < raw.close ? "up" : "flat";
}

export async function fetchHtfTrend1hRaw(
  coin: string,
  period: number,
): Promise<HtfTrendRaw | undefined> {
  try {
    const klines = await fetchKlines(coin, "1h", 60);
    if (!klines || klines.length < 20) return undefined;
    const closes = klines.map((k) => k.close);
    const raw = htfTrendRawFromCloses(closes, period);
    if (!raw) return undefined;
    // fetchKlines drops the forming candle — the last element IS the newest
    // closed bar, and its openTime is the cache key.
    return { ...raw, barOpenTime: klines[klines.length - 1].openTime };
  } catch {
    return undefined;
  }
}

export async function fetchHtfTrend1h(
  coin: string,
  period: number,
): Promise<"up" | "down" | "flat" | undefined> {
  const raw = await fetchHtfTrend1hRaw(coin, period);
  return raw ? htfVerdictOf(raw) : undefined;
}

/**
 * HTF 4h trend read for the direction gates (proxy-style deep EMA,
 * 2026-09-13): same price-vs-EMA verdict rule as fetchHtfTrend1h but on 4h
 * bars with an SMA-seeded EMA over a deep 240-bar window so period-75 reads
 * are converged — a 75-period EMA inside the 1h gate's 60-bar window would
 * be pure seed lag. The 240-bar window matches the swap measurement
 * (run-layer2-htf-swap.ts) bit-for-bit: that analyzer used emaSeeded on the
 * last 240 4h closes up to the last CLOSED 4h bar. emaSmaSeeded here is the
 * same algorithm as proxy-signal.emaSeeded, kept local to avoid a
 * layer2-signal → proxy-signal import edge.
 * Fail-open (undefined = allow) when history is short or the fetch fails.
 */
export function emaSmaSeeded(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (period <= 0 || values.length < period) return out;
  const k = 2 / (period + 1);
  let acc = 0;
  for (let i = 0; i < period; i++) acc += values[i];
  out[period - 1] = acc / period;
  for (let i = period; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
  return out;
}

export async function fetchHtfTrend4hRaw(
  coin: string,
  period: number,
): Promise<HtfTrendRaw | undefined> {
  try {
    // Exactly 240 closed 4h bars — the analyzer's window (pre.slice(-240)).
    const klines = await fetchKlines(coin, "4h", 240);
    if (!klines || klines.length < period + 5) return undefined;
    const closes = klines.map((k) => k.close);
    const e = emaSmaSeeded(closes, period);
    const emaVal = e[e.length - 1];
    const lastClose = closes[closes.length - 1];
    if (!Number.isFinite(emaVal) || lastClose == null) return undefined;
    return { ema: emaVal, close: lastClose, barOpenTime: klines[klines.length - 1].openTime };
  } catch {
    return undefined;
  }
}

export async function fetchHtfTrend4h(
  coin: string,
  period: number,
): Promise<"up" | "down" | "flat" | undefined> {
  const raw = await fetchHtfTrend4hRaw(coin, period);
  return raw ? htfVerdictOf(raw) : undefined;
}

/** Fetch current price from MEXC futures ticker. */
export async function fetchTickerPrice(coin: string): Promise<number> {
  const res = await pacedFetch(`${MEXC_BASE}/api/v1/contract/ticker?symbol=${toMexcSymbol(coin)}`);
  if (!res.ok) return 0;
  const json = (await res.json()) as any;
  return Number(json?.data?.lastPrice ?? 0);
}

/** Fetch ticker with both price and 24h volume. */
export async function fetchTicker(coin: string): Promise<{ last: number; volume24: number }> {
  const res = await pacedFetch(`${MEXC_BASE}/api/v1/contract/ticker?symbol=${toMexcSymbol(coin)}`);
  if (!res.ok) return { last: 0, volume24: 0 };
  const json = (await res.json()) as any;
  return {
    last: Number(json?.data?.lastPrice ?? 0),
    volume24: Number(json?.data?.amount24 ?? 0),
  };
}

/**
 * The raw per-symbol ticker fields the entry enrichment needs (spread, funding
 * snapshot, open interest). `fetchTicker` deliberately exposes only
 * price/volume; this keeps the microstructure fields in one place so the
 * default-runtime enrichment can get them through the Node relay.
 *
 * Only fields that actually exist on MEXC's contract ticker are returned:
 * there is NO `openInterest` field (the snapshot lives in `holdVol`).
 */
export async function fetchTickerRaw(coin: string): Promise<{
  last: number;
  bid1: number | null;
  ask1: number | null;
  fundingRate: number | null;
  holdVol: number | null;
}> {
  const res = await pacedFetch(`${MEXC_BASE}/api/v1/contract/ticker?symbol=${toMexcSymbol(coin)}`);
  const json = res.ok ? ((await res.json()) as any) : null;
  const d = json?.data;
  const num = (value: any): number | null =>
    value != null && Number.isFinite(Number(value)) ? Number(value) : null;
  return {
    last: num(d?.lastPrice) ?? 0,
    bid1: num(d?.bid1),
    ask1: num(d?.ask1),
    fundingRate: num(d?.fundingRate),
    holdVol: num(d?.holdVol),
  };
}

/**
 * Batch ticker: MEXC's contract ticker endpoint returns ALL listed contracts
 * in one unauthenticated call when `symbol` is omitted. One request replaces
 * N per-pair `fetchTicker` calls in the Layer-1 tick (biggest single cron I/O
 * saver available). Returns a map keyed by base coin ("BTC") with `last`,
 * `amount24` (USD 24h volume — same field fetchTicker reads) and `holdVol`
 * (open interest in contracts). Pairs MEXC doesn't list are simply absent;
 * callers must treat missing keys as "no data" (fail-open) rather than 0.
 */
export async function fetchAllTickers(): Promise<
  Map<string, { last: number; volume24: number; holdVol?: number }>
> {
  const out = new Map<string, { last: number; volume24: number; holdVol?: number }>();
  const res = await pacedFetch(`${MEXC_BASE}/api/v1/contract/ticker`);
  if (!res.ok) return out;
  const json = (await res.json()) as any;
  const rows: any[] = json?.data ?? [];
  for (const r of rows) {
    const sym = typeof r?.symbol === "string" ? r.symbol : "";
    if (!sym.endsWith("_USDT")) continue;
    const last = Number(r?.lastPrice ?? 0);
    const volume24 = Number(r?.amount24 ?? 0);
    const holdVol = r?.holdVol != null ? Number(r.holdVol) : undefined;
    if (last > 0) out.set(fromMexcSymbol(sym), { last, volume24, holdVol });
  }
  return out;
}

/** Fetch 20-level order book from MEXC futures. */
export async function fetchDepth(coin: string): Promise<{
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
}> {
  const json = await fetchJsonRetry(`${MEXC_BASE}/api/v1/contract/depth/${toMexcSymbol(coin)}?limit=20`);
  if (!json.success) throw new Error(`Depth error: ${json.message}`);
  const bids = (json.data?.bids ?? []).map((l: any) => ({ price: l[0], size: l[1] }));
  const asks = (json.data?.asks ?? []).map((l: any) => ({ price: l[0], size: l[1] }));
  return { bids, asks };
}

/**
 * Fetch recent trades (for flow bias). Primary: v1 contract/deals (futures
 * native, taker-side flag). Fallback: v3 trades (spot-style symbol query).
 * 2026-09-11: v3 trades started returning HTTP 403 from some runtimes while
 * depth/klines kept working — every pair's flowBias silently became 0 (empty
 * array), which the short-flow gate reads as a veto. Contract deals (v1) was
 * unaffected, so it is now tried FIRST and v3 kept as fallback.
 */
export async function fetchRecentTrades(coin: string): Promise<{
  price: number; size: number; time: number; isBuyerMaker: boolean;
}[]> {
  // v1 contract deals: { p, v, T (1=buy taker, 2=sell taker), t (ms) }.
  try {
    const json = await fetchJsonRetry(`${MEXC_BASE}/api/v1/contract/deals/${toMexcSymbol(coin)}`);
    if (json.success && Array.isArray(json.data) && json.data.length > 0) {
      return json.data.map((t: any) => ({
        price: parseFloat(t.p),
        size: parseFloat(t.v),
        time: Number(t.t),
        isBuyerMaker: t.T === 2, // sell-taker row == buyer was maker (v3 semantics)
      }));
    }
  } catch {
    // fall through to v3
  }
  // Spot v3 wants the concatenated pair (BTCUSDT), not the futures underscore
  // form and not the bare base asset: stripping "_USDT" entirely sent
  // `symbol=BTC`, which the endpoint answers with an error, so this fallback
  // had been returning [] — flowBias 0, which the SHORT flow gate reads as a
  // veto — whenever the futures deals call above failed.
  const res = await pacedFetch(`${MEXC_V3_BASE}/api/v3/trades?symbol=${toMexcSymbol(coin).replace("_USDT", "USDT")}&limit=500`);
  if (!res.ok) return [];
  const raw = (await res.json()) as any[];
  return raw.map((t: any) => ({
    price: parseFloat(t.price),
    size: parseFloat(t.qty),
    time: t.time,
    isBuyerMaker: t.isBuyerMaker,
  }));
}

/** Fetch the current perpetual funding rate from MEXC Futures. */
export async function fetchFundingRateWithStatus(
  coin: string,
): Promise<{ rate: number; ok: boolean }> {
  try {
    const res = await pacedFetch(`${MEXC_BASE}/api/v1/contract/funding_rate/${toMexcSymbol(coin)}`);
    if (!res.ok) return { rate: 0, ok: false };
    const raw = (await res.json()) as any;
    const value = Number(raw?.data?.fundingRate);
    return Number.isFinite(value) ? { rate: value, ok: true } : { rate: 0, ok: false };
  } catch {
    return { rate: 0, ok: false };
  }
}

/**
 * Fetch the current perpetual funding rate from MEXC Futures.
 *
 * This must use the contract API, not the spot/v3 family. A failed response
 * remains fail-safe as 0 for scoring, while marketData's 8-hour cache avoids
 * refetching all pairs on every 5-minute tick.
 */
export async function fetchFundingRate(coin: string): Promise<number> {
  return (await fetchFundingRateWithStatus(coin)).rate;
}


/**
 * One page of historical perpetual funding settlements from MEXC.
 * The endpoint is paginated by page_num/page_size; an empty page ends the
 * walk. Callers should bound the walk because old contracts may have a long
 * listing history.
 */
export async function fetchFundingRateHistoryPage(
  coin: string,
  pageNum: number,
  pageSize = 1000,
): Promise<Array<{ rate: number; settleTime: number }>> {
  const json = await fetchJsonRetry(
    `${MEXC_BASE}/api/v1/contract/funding_rate/history?symbol=${toMexcSymbol(coin)}&page_num=${pageNum}&page_size=${Math.min(Math.max(pageSize, 1), 1000)}`,
  );
  if (json?.success === false) throw new Error(`MEXC funding history: ${json.message ?? "request failed"}`);
  const rows = Array.isArray(json?.data?.resultList)
    ? json.data.resultList
    : Array.isArray(json?.data)
      ? json.data
      : [];
  return rows
    .map((row: any) => ({
      rate: Number(row.fundingRate),
      settleTime: Number(row.settleTime) < 1_000_000_000_000
        ? Number(row.settleTime) * 1000
        : Number(row.settleTime),
    }))
    .filter((row: { rate: number; settleTime: number }) =>
      Number.isFinite(row.rate) && Number.isFinite(row.settleTime) && row.settleTime > 0,
    );
}

/**
 * Fetch enough funding history to cover a set of trade entry timestamps.
 * A successful empty result is valid; errors are allowed to reach the caller
 * so a failed request cannot be mistaken for a zero funding rate.
 */
export async function fetchFundingRateHistory(
  coin: string,
  earliestEntryMs: number,
  latestEntryMs = Date.now(),
  maxPages = 10,
): Promise<Array<{ rate: number; settleTime: number }>> {
  const all: Array<{ rate: number; settleTime: number }> = [];
  for (let page = 1; page <= Math.max(1, maxPages); page++) {
    const rows = await fetchFundingRateHistoryPage(coin, page);
    all.push(...rows);
    if (rows.length < 1000) break;
    const oldest = Math.min(...rows.map((row) => row.settleTime));
    if (oldest <= earliestEntryMs) break;
  }
  return all
    .filter((row) => row.settleTime >= earliestEntryMs && row.settleTime <= latestEntryMs + 8 * 60 * 60 * 1000)
    .sort((a, b) => a.settleTime - b.settleTime);
}

/** Match the first funding settlement at/after a trade's entry timestamp. */
export function fundingRateAtEntry(
  history: Array<{ rate: number; settleTime: number }>,
  entryTime: number,
): { rate: number; settleTime: number } | undefined {
  return history.find((row) => row.settleTime >= entryTime);
}

/** Fetch contract size from MEXC futures. */
export async function fetchContractSize(coin: string): Promise<number> {
  try {
    const res = await pacedFetch(`${MEXC_BASE}/api/v1/contract/detail?symbol=${toMexcSymbol(coin)}`);
    if (!res.ok) return 1;
    const json = (await res.json()) as any;
    return Number(json?.data?.contSize ?? 1);
  } catch {
    return 1;
  }
}
