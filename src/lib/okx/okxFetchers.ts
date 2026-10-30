/**
 * OKX USDT-margined perpetual (SWAP) kline fetcher for deep-history labs.
 *
 * WHY: MEXC only retains ~12 months of 15m/5m klines (probed 2026-10-08),
 * so multi-year LTF backtests are impossible from MEXC. OKX
 * /api/v5/market/history-candles serves 2022+ history (verified BTC 15m
 * Aug-2022). Public endpoint, no API key needed.
 *
 * Pagination semantics (verified by probe, NOT the docs' guess):
 *   after  = newer (exclusive) bound, before = older (exclusive) bound.
 *   Returns up to `limit` bars with openTime in (before, after), newest first.
 *   Walk a chunk backwards: next after = oldest.openTime of the page.
 *   `before` alone is ignored by the API; `after` alone works.
 *
 * Rate limit: 20 req / 2s per IP. Keep global dispatch <= ~8/s and retry
 * HTTP 429 / code 50011 with backoff.
 */
export type OkxBar = {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
};

export const OKX_BAR: Record<string, string> = {
  "5m": "5m",
  "15m": "15m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
};

export const OKX_STEP_MS: Record<string, number> = {
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

/** JASMY has no USDT-SWAP on OKX (verified 2026-10-08) — callers must skip it. */
export function toOkxInst(coin: string): string {
  if (coin === "JASMY") throw new Error("JASMY has no OKX USDT-SWAP instrument");
  return `${coin}-USDT-SWAP`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchPage(
  instId: string,
  bar: string,
  after: number,
  before: number,
  retries = 6,
): Promise<OkxBar[]> {
  const url =
    `https://www.okx.com/api/v5/market/history-candles` +
    `?instId=${instId}&bar=${bar}&after=${after}&before=${before}&limit=100`;
  let lastErr: any = null;
  for (let a = 0; a < retries; a++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) {
        lastErr = new Error("HTTP 429");
        await sleep(1500 * (a + 1));
        continue;
      }
      const j = (await res.json()) as any;
      if (j.code === "50011") {
        // rate limit
        lastErr = new Error("OKX 50011 rate limit");
        await sleep(1500 * (a + 1));
        continue;
      }
      if (j.code !== "0") {
        lastErr = new Error(`OKX code=${j.code} msg=${j.msg ?? ""}`);
        await sleep(800 * (a + 1));
        continue;
      }
      const rows: any[][] = j.data ?? [];
      return rows.map((r) => ({
        openTime: Number(r[0]),
        open: Number(r[1]),
        high: Number(r[2]),
        low: Number(r[3]),
        close: Number(r[4]),
        volume: Number(r[5]),
        closeTime: Number(r[0]) + (OKX_STEP_MS[barToInterval(bar)] ?? 0),
      }));
    } catch (e) {
      lastErr = e;
      await sleep(800 * (a + 1));
    }
  }
  throw lastErr ?? new Error("OKX fetch failed");
}

function barToInterval(bar: string): string {
  for (const [k, v] of Object.entries(OKX_BAR)) if (v === bar) return k;
  return "";
}

/** Walk one time-chunk backwards, oldest-first. Stops at chunkStart or gap. */
export async function fetchOkxChunk(
  instId: string,
  interval: string,
  chunkStart: number,
  chunkEnd: number,
  onProgress?: (pages: number, bars: number) => void,
): Promise<OkxBar[]> {
  const bar = OKX_BAR[interval];
  if (!bar) throw new Error(`Unsupported interval: ${interval}`);
  const out: OkxBar[] = [];
  let after = chunkEnd;
  let pages = 0;
  for (let guard = 0; guard < 3000; guard++) {
    const page = await fetchPage(instId, bar, after, chunkStart);
    pages++;
    if (page.length === 0) break;
    // page is newest-first; keep only bars strictly inside (chunkStart, chunkEnd]
    for (const b of page) {
      if (b.openTime > chunkStart && b.openTime <= chunkEnd) out.push(b);
    }
    if (onProgress) onProgress(pages, out.length);
    const oldest = page[page.length - 1].openTime;
    if (oldest <= chunkStart) break;
    if (page.length < 100) break; // exhausted listing history inside chunk
    after = oldest;
    await sleep(120); // ~8/s global budget shared across workers
  }
  out.sort((a, b) => a.openTime - b.openTime);
  return out;
}
