/**
 * KLINE CACHE SEEDER — download the tracked universe once into data/klines/
 *
 *   bun run src/lib/fetch-kline-cache.ts                  # seed default window (CACHE_START_MS → now)
 *   bun run src/lib/fetch-kline-cache.ts --since 2026-09-01
 *   bun run src/lib/fetch-kline-cache.ts --since 2026-09-01 --until 2026-09-12
 *   bun run src/lib/fetch-kline-cache.ts --since disk      # DAILY UPDATE: top up every file from
 *                                                          #   its own recorded start (never widens
 *                                                          #   history; new pairs get full horizon)
 *   bun run src/lib/fetch-kline-cache.ts --pairs SOL,BTC   # restrict pairs
 *   bun run src/lib/fetch-kline-cache.ts --only 15m,4h     # restrict intervals
 *
 * The pair list comes from src/lib/tracked-pairs.ts (LAYER1_PAIRS) — the SAME
 * list the bot scans — so the cache can never drift from the traded universe.
 * Symbol aliases (PUMP → PUMPFUN_USDT) are honored by kline-cache's fetcher.
 *
 * Subsequent runs are incremental: only the missing tail is fetched, so a
 * daily refresh costs a couple of requests per pair, not the whole history.
 */
import { getCachedKlines, cacheInfo, CACHE_START_MS } from "./kline-cache";
import { LAYER1_PAIRS } from "./tracked-pairs";

const CORE_INTERVALS = ["15m", "1h", "4h"];

// ── Parse args ──
const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
}

const sinceArg = argValue("--since");
const untilArg = argValue("--until");
// `--since disk` = maintenance mode: each file is topped up from its own
// recorded start, so the daily refresh can never re-download history and
// never widens the dataset (a pair added later still gets the full horizon).
const DISK_MODE = sinceArg === "disk";
const startMs = sinceArg && !DISK_MODE ? Date.parse(`${sinceArg}T00:00:00.000Z`) : CACHE_START_MS;
const untilMs = untilArg ? Date.parse(`${untilArg}T23:59:59.999Z`) : Date.now();
if (sinceArg && !DISK_MODE && Number.isNaN(startMs)) throw new Error(`Bad --since value: ${sinceArg}`);
if (Number.isNaN(untilMs)) throw new Error(`Bad --until value: ${untilArg}`);

const onlyIdx = argv.indexOf("--only");
const intervals =
  onlyIdx >= 0 && argv[onlyIdx + 1]
    ? argv[onlyIdx + 1].split(",").map((s) => s.trim()).filter(Boolean)
    : CORE_INTERVALS;

const pairsIdx = argv.indexOf("--pairs");
const pairFilter =
  pairsIdx >= 0 && argv[pairsIdx + 1]
    ? argv[pairsIdx + 1].split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : null;
const pairs = pairFilter ? LAYER1_PAIRS.filter((p) => pairFilter.includes(p)) : LAYER1_PAIRS;

console.log("════════════════════════ kline cache seed ════════════════════════");
console.log(
  DISK_MODE
    ? "window: per-file recorded start → now (incremental update)"
    : `window: ${new Date(startMs).toISOString()} → ${new Date(untilMs).toISOString()}`,
);
console.log(`pairs (${pairs.length}, from tracked-pairs.ts): ${pairs.join(", ")}`);
console.log(`intervals: ${intervals.join(", ")}\n`);

async function main(): Promise<void> {
  let failed = 0;
  for (const pair of pairs) {
    for (const interval of intervals) {
      try {
        const jobStart = DISK_MODE ? (Date.parse(cacheInfo(pair, interval)?.start ?? "") || CACHE_START_MS) : startMs;
        const bars = await getCachedKlines(pair, interval, { startMs: jobStart, endMs: untilMs });
        const info = cacheInfo(pair, interval);
        console.log(
          `${pair.padEnd(9)} ${interval.padEnd(4)} ${String(bars.length).padStart(6)} bars in window  ` +
            `${info ? `file: ${info.start.slice(0, 10)} → ${info.end.slice(0, 10)} (${info.bars} bars)` : ""}`,
        );
      } catch (e: any) {
        failed++;
        console.error(`  ${pair} ${interval}: FAILED ${e?.message ?? e}`);
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  console.log(`\ndone — ${failed} failed job(s)`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
