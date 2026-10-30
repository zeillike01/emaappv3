/**
 * PARITY REPLAY HARNESS (verification gate #2).
 *
 * Runs the shipped signal core + exit engine over a fixed cached window and
 * prints one line per pair. Identical code + identical bars + identical config
 * must produce identical lines; run it in two trees and diff the output.
 *
 * Reads ONLY the local kline cache (localOnly) so two trees cannot diverge by
 * fetching different data. Not runtime code, not a lab experiment.
 *
 *   PAIRS=BTC,ETH,SOL bun run scripts/verify-parity-replay.ts
 */
import type { Kline } from "../src/lib/types";
import { getCachedKlines } from "../src/lib/kline-cache";
import { scanForSignals } from "../src/lib/strategy";
import { runBacktest } from "../src/lib/backtest";

const pairs = (process.env.PAIRS ?? "BTC,ETH,SOL").split(",");
const startMs = Date.parse(process.env.START ?? "2026-09-01T00:00:00.000Z");
const endMs = Date.parse(process.env.END ?? "2026-10-01T00:00:00.000Z");

/** CachedKline -> Kline. The scanner keys pivots off openTime/closeTime, so a
 *  hand-rolled `{time, ...}` map silently yields zero signals. */
const toK = (b: any): Kline => ({
  openTime: b.openTime,
  open: b.open,
  high: b.high,
  low: b.low,
  close: b.close,
  volume: b.volume,
  closeTime: b.closeTime,
  quoteVolume: b.quoteVolume ?? 0,
  trades: b.trades ?? 0,
  isClosed: b.closeTime <= Date.now(),
});

for (const pair of pairs) {
  const k15 = await getCachedKlines(pair, "15m", { startMs, endMs, localOnly: true });
  const k4h = await getCachedKlines(pair, "4h", { startMs, endMs, localOnly: true });
  if (k15.length < 100 || k4h.length < 40) {
    console.log(`${pair}\tNO-DATA\t15m=${k15.length}\t4h=${k4h.length}`);
    continue;
  }
  const s15 = k15.map(toK);
  const s4h = k4h.map(toK);
  const raw = scanForSignals(s15, s4h, 5, "ema", 50);
  const longs = raw.filter((s) => s.type === "LONG").length;
  const shorts = raw.filter((s) => s.type === "SHORT").length;
  const r = runBacktest(s15, s4h, {});
  console.log(
    [
      pair,
      `bars=${k15.length}/${k4h.length}`,
      `signals=${raw.length}(L${longs}/S${shorts})`,
      `trades=${r.totalTrades}`,
      `wr=${r.winRate.toFixed(1)}%`,
      `return=${r.totalReturnPct.toFixed(3)}%`,
      `dd=${r.maxDrawdown.toFixed(3)}`,
      `pf=${r.profitFactor.toFixed(3)}`,
    ].join("\t"),
  );
}
