/**
 * SHARED L1 SNAPSHOT ARCHIVE (2026-09-25).
 *
 * Every replay lab reads the same archive (`data/lab/2sided-l1`), which is a
 * paged dump of Convex's `layer1Ticks` table (`marketData:exportLayer1Ticks`),
 * 576 ticks per page. Three labs previously carried their own private copy of
 * this loader; they are now one module, so this fence can only rot in one
 * place.
 *
 * THE STALE-TAIL FENCE, AND THE BUG IT FIXES
 * The loader caches each page to disk. A page that reached the archive head is
 * written with `nextStart: null`, and trusting that file on the next run means
 * the walk stops there — permanently, and silently. MEASURED on 2026-09-25:
 * `p008.json` held the `nextStart: null` head of 2026-09-22T07:35, so every lab
 * replayed a 17.0-day window while Convex had kept recording and held 20.6
 * days. Nothing errored; the labs simply re-reported the same sample forever.
 *
 * Fix: a COMPLETED page (any page before the last one on disk) is trusted from
 * disk, but the LAST cached page is always re-fetched from the server and
 * rewritten, because only the server knows whether the archive has grown past
 * it. New pages are then appended from that page's `nextStart` as usual.
 *
 * Two consequences worth knowing:
 *   - one extra export call per lab run (the refreshed tail page);
 *   - pages the server has since PRUNED (cleanup.ts caps layer1Ticks at 60
 *     days) stay in the local archive, so the local window can be longer than
 *     the server's. The cache is append-only by design.
 *
 * `L1_CACHE_OFF=1` bypasses the cache entirely for a from-scratch re-dump.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const L1_DIR = path.join(process.cwd(), "data", "lab", "2sided-l1");
export const L1_LIMIT = 576; // exportLayer1Ticks max page
const MAX_PAGES = 400;
/** Warn when the archive head is this far behind now (silent-freeze alarm). */
const ARCHIVE_STALE_WARN_H = 6;

// Compact export shape (marketData.ts:exportLayer1Ticks):
//   rows: [ timestamp, [ [pair, imbalance, flowBias, spreadPct, atrPct,
//                         candleRangePct, vol24h, fundingRate, fundingValid],
//                         ... ] ]
export type L1PairRow = [string, number, number, number, number, number, number, number, number];
export type L1Tick = [number, L1PairRow[]];
export type L1Page = { rows: L1Tick[]; count: number; nextStart: number | null };
export type L1PageFetcher = (startMs: number) => L1Page;

export function l1PageFile(dir: string, page: number): string {
  return path.join(dir, `p${String(page).padStart(3, "0")}.json`);
}

/** Default page source: one Convex export call per page. */
export function fetchL1Page(startMs: number): L1Page {
  const out = execSync(
    `bunx convex run marketData:exportLayer1Ticks '{"startMs":${startMs},"endMs":99999999999999,"limit":${L1_LIMIT}}'`,
    { cwd: process.cwd(), encoding: "utf8", maxBuffer: 512 * 1024 * 1024 },
  );
  return JSON.parse(out) as L1Page;
}

/** Highest contiguous cached page number, or -1 when the cache is empty. */
export function lastCachedPage(dir: string): number {
  let last = -1;
  for (let page = 0; page < MAX_PAGES; page++) {
    if (!fs.existsSync(l1PageFile(dir, page))) break;
    last = page;
  }
  return last;
}

export type LoadL1Options = {
  /** Archive directory (defaults to L1_DIR). */
  dir?: string;
  /** Page source (defaults to the Convex export); injected by tests. */
  fetchPage?: L1PageFetcher;
  /** Re-fetch every page, ignore what is on disk (env: L1_CACHE_OFF=1). */
  noCache?: boolean;
  /** Timestamp the freshness alarm compares against (tests pin this). */
  now?: number;
};

/**
 * Load the archive oldest-first. Completed pages come from disk, the tail page
 * always comes from the server, new pages are appended and persisted.
 */
export function loadL1Ticks(verbose: boolean, opts: LoadL1Options = {}): L1Tick[] {
  const dir = opts.dir ?? L1_DIR;
  const fetchPage = opts.fetchPage ?? fetchL1Page;
  const noCache = opts.noCache ?? process.env.L1_CACHE_OFF === "1";
  fs.mkdirSync(dir, { recursive: true });
  const tail = noCache ? -1 : lastCachedPage(dir);

  const merged: L1Tick[] = [];
  let start = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const file = l1PageFile(dir, page);
    // The tail page is deliberately NOT trusted from disk (see header).
    const cached = !noCache && page < tail;
    const payload = cached
      ? (JSON.parse(fs.readFileSync(file, "utf8")) as L1Page)
      : fetchPage(start);
    if (!cached) {
      fs.writeFileSync(file, JSON.stringify(payload));
      if (verbose && payload.count > 0) {
        const t = payload.rows[payload.rows.length - 1]![0];
        const tag = page === tail ? `refreshed tail page ${page}` : `fetched page ${page}`;
        console.log(`  ${tag}: ${payload.count} ticks -> ${new Date(t).toISOString()}`);
      }
    }
    for (const row of payload.rows) merged.push(row);
    if (payload.nextStart == null) break;
    start = payload.nextStart;
  }

  merged.sort((a, b) => a[0] - b[0]);
  // A grown page can repeat a tick that the page after it already had.
  const unique = merged.filter((row, i) => i === 0 || row[0] !== merged[i - 1]![0]);

  if (verbose && unique.length > 0) {
    const { t0, t1, days } = l1Span(unique);
    const lagH = ((opts.now ?? Date.now()) - t1) / 3_600_000;
    console.log(
      `  L1 archive: ${unique.length} ticks, ${new Date(t0).toISOString()} -> ${new Date(t1).toISOString()} (${days.toFixed(1)} d, head ${lagH.toFixed(1)} h behind now)`,
    );
    if (lagH > ARCHIVE_STALE_WARN_H) {
      console.warn(
        `  WARNING: L1 archive head is ${lagH.toFixed(1)} h old — the export or the recording cron may be down. This run's window ends there.`,
      );
    }
  }
  return unique;
}

/** Archive span, for the labs' provenance lines. */
export function l1Span(ticks: L1Tick[]): { t0: number; t1: number; days: number } {
  const t0 = ticks.length > 0 ? ticks[0]![0] : 0;
  const t1 = ticks.length > 0 ? ticks[ticks.length - 1]![0] : 0;
  return { t0, t1, days: (t1 - t0) / 86_400_000 };
}
