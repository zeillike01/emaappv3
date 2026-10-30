/**
 * DISPLACEMENT BOARD — on-demand read of the displacement test over the
 * tracked universe (2026-09-22).
 *
 * READ-ONLY AND UNARMED. The displacement core measured NEGATIVE over the
 * documented 6-month window (`bun run backtest:displacement`): the cohort it
 * targets is real — the anchor's setups that never displace the prior pivot run
 * −0.951 R/trade at 6.1% WR — but requiring the displacement costs more in
 * entry price (−0.316 R/t on the setups it keeps) than the deleted cohort is
 * worth. It therefore ships OFF, like the 4H chop gate: nothing in the engine
 * imports it, no cron calls it, no order can be placed from it. This action
 * exists so the trader can watch the structure state the rule describes
 * (break / HL-LH formed / leg amplitude in ATR / 4H verdict) on live bars.
 *
 * Every state value here comes from `readDisplacementState` in
 * ../lib/displacement — the SAME pure function the scanner and the lab use, so
 * the board can never describe a rule the backtest did not measure.
 *
 * Convex note: actions may not return NaN (it fails value validation), and the
 * pure readout legitimately produces NaN for "not applicable" (no structure
 * formed yet, ATR not warmed up). `clean()` maps every non-finite number to
 * null at the boundary so a warm-up pair shows as blank instead of blowing up
 * the whole scan.
 */
import { v } from "convex/values";
import { action } from "./_generated/server";
// MEXC reads go through the Node relay: this file is default-runtime and the
// WAF 403s direct fetches here (see marketRelay.ts).
import { relayKlines } from "./marketFetch";
import {
  DISPLACEMENT_DEFAULTS,
  readDisplacementState,
  scanDisplacementSignals,
} from "../lib/displacement";
import { LAYER1_PAIRS } from "../lib/tracked-pairs";

/** Bars fetched per pair. 400 x 15m ≈ 4 days, 300 x 4h = 50 days: enough for
 *  the EMA warm-ups (50 / 75), Wilder ATR(14) and the pivot windows. */
const BARS_15M = 400;
const BARS_4H = 300;
/** Parallel pair scans. MEXC tolerates bursts; 4 keeps a 31-pair board inside
 *  a comfortable action budget without hammering the endpoint. */
const CONCURRENCY = 4;

/** Recursively replace every non-finite number with null (Convex rejects NaN). */
function clean<T>(value: T): any {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(value)) out[k] = clean(val);
    return out;
  }
  return value;
}

export const scanBoard = action({
  args: {
    kAtr: v.optional(v.number()),
    pairs: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    const kAtr = args.kAtr ?? DISPLACEMENT_DEFAULTS.kAtr;
    const pairs = (args.pairs?.length ? args.pairs : LAYER1_PAIRS).slice(0, 40);
    const rows: any[] = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < pairs.length) {
        const pair = pairs[cursor++];
        try {
          const [k15, k4h] = await Promise.all([
            relayKlines(ctx, pair, "15m", BARS_15M),
            relayKlines(ctx, pair, "4h", BARS_4H),
          ]);
          const state = readDisplacementState(k15, k4h, { kAtr });
          if (!state) {
            rows.push({ pair, error: `insufficient bars (${k15.length}×15m / ${k4h.length}×4h)` });
            continue;
          }
          // Most recent displacement signal in the fetched window — context for
          // "is this rule even producing events on this pair?", nothing more.
          const sigs = scanDisplacementSignals(k15, k4h, { kAtr });
          const last = sigs[sigs.length - 1];
          rows.push({
            pair,
            ...state,
            lastSignal: last
              ? {
                  side: last.type,
                  time: last.time,
                  index: last.index,
                  structureIndex: last.structureIndex,
                  displacementAtr: last.displacementAtr,
                  barsToBreak: last.barsToBreak,
                  breakLevel: last.breakLevel,
                  structurePrice: last.structurePrice,
                }
              : null,
          });
        } catch (e: any) {
          rows.push({ pair, error: e?.message ?? String(e) });
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pairs.length) }, () => worker()),
    );
    rows.sort((a, b) => String(a.pair).localeCompare(String(b.pair)));

    return clean({ kAtr, scannedAt: Date.now(), pairs: pairs.length, rows });
  },
});
