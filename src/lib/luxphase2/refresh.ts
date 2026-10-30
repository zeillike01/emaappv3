#!/usr/bin/env bun
// Refresh 1H klines for the Phase-2 stack (LAYER1_PAIRS), then print the
// common window (intersection) for the reproducible backtest config.
import { getCachedKlines } from "../kline-cache";
import { LAYER1_PAIRS } from "../tracked-pairs";
import fs from "node:fs";

const out: Array<{ coin: string; n: number; first: string; last: string }> = [];
for (const coin of LAYER1_PAIRS) {
  try {
    const bars = await getCachedKlines(coin, "1h", {});
    if (!bars.length) { console.log(`${coin}: EMPTY`); continue; }
    out.push({
      coin,
      n: bars.length,
      first: new Date(bars[0].openTime).toISOString(),
      last: new Date(bars[bars.length - 1].openTime).toISOString(),
    });
    console.log(`${coin}: ${bars.length} bars ${out[out.length - 1].first.slice(0, 10)} -> ${out[out.length - 1].last.slice(0, 10)}`);
  } catch (e: any) {
    console.log(`${coin}: FETCH-FAIL ${String(e?.message).slice(0, 120)}`);
  }
}
fs.writeFileSync("data/lab/luxalgo/cache/stack-1h-coverage.json", JSON.stringify(out, null, 1));
