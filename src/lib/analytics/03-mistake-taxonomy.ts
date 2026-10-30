/**
 * Trade Analytics Pipeline -- Part 3 of 4: Mistake Taxonomy
 *
 * Requires 01-types-and-split.ts and 02-standardize-and-scoring.ts in
 * the same folder.
 *
 * Before training anything, each LOSING trade is classified into one
 * of three categories, because "mistake" is not one thing and lumping
 * them together hides which problem you actually have (the same way
 * the combined regime-adaptive PnL hid that the range branch alone was
 * negative -- see that finding earlier in this codebase's history):
 *
 *   BAD_ENTRY   -- MAE was hit fast (within EARLY_MAE_BAR_THRESHOLD
 *                  bars). The trade went wrong almost immediately --
 *                  points at the ENTRY filter being wrong, not the exit.
 *   REVERSAL    -- MFE reached a meaningful level (>= REVERSAL_MFE_
 *                  THRESHOLD) before the trade still closed as a loss.
 *                  Direction was right for a while; the exit/hold
 *                  logic gave it back. Points at TP/ratchet tuning.
 *   NORMAL_LOSS -- neither of the above: ordinary variance, not a
 *                  systematic pattern. Excluded from the classifier
 *                  target by default in part 4 (see MISTAKE_CATEGORIES).
 *
 * This requires two fields not in the base TradeRecord: barsToMAE and
 * barsToMFE (bar index, relative to entry, at which the trade's worst/
 * best excursion occurred). If you haven't been capturing these, they
 * need to be added before this part of the pipeline is useful --
 * without them, BAD_ENTRY vs REVERSAL can't be distinguished at all,
 * and this degrades to the plain win/loss classifier from part 2.
 */

import { TradeRecord } from "./01-types-and-split";
import {
  Standardizer,
  LogisticModel,
  applyStandardizer,
  predictProba,
  MIN_RECORDS_PER_DECILE,
} from "./02-standardize-and-scoring";

export const EARLY_MAE_BAR_THRESHOLD = 3; // MAE within this many bars of entry = "bad entry", not "bad luck"
export const REVERSAL_MFE_THRESHOLD = 0.5; // MFE >= this many R = "the trade had a real move in its favor"

export type MistakeLabel = "WIN" | "BAD_ENTRY" | "REVERSAL" | "NORMAL_LOSS";

// Which categories the classifier tries to predict, by default (used in part 4).
// NORMAL_LOSS is deliberately excluded -- it's the "ordinary variance"
// bucket, not a fixable pattern.
export const MISTAKE_CATEGORIES: MistakeLabel[] = ["BAD_ENTRY", "REVERSAL"];

export interface MistakeTradeRecord extends TradeRecord {
  mfeR: number;
  maeR: number;
  barsToMAE?: number; // bar index of worst excursion, relative to entry (0 = entry bar). Required for BAD_ENTRY/REVERSAL to be distinguishable.
  barsToMFE?: number;
}

export function classifyMistake(trade: MistakeTradeRecord): MistakeLabel {
  if (trade.forwardR > 0) return "WIN";

  if (trade.barsToMAE !== undefined && trade.barsToMAE <= EARLY_MAE_BAR_THRESHOLD) {
    return "BAD_ENTRY";
  }
  if (trade.mfeR >= REVERSAL_MFE_THRESHOLD) {
    return "REVERSAL";
  }
  return "NORMAL_LOSS";
}

export interface MistakeTally {
  total: number;
  counts: Record<MistakeLabel, number>;
  pct: Record<MistakeLabel, number>;
}

export function tallyMistakes(trades: MistakeTradeRecord[]): MistakeTally {
  const counts: Record<MistakeLabel, number> = {
    WIN: 0,
    BAD_ENTRY: 0,
    REVERSAL: 0,
    NORMAL_LOSS: 0,
  };
  for (const t of trades) counts[classifyMistake(t)]++;
  const total = trades.length;
  const pct: Record<MistakeLabel, number> = {
    WIN: total > 0 ? counts.WIN / total : 0,
    BAD_ENTRY: total > 0 ? counts.BAD_ENTRY / total : 0,
    REVERSAL: total > 0 ? counts.REVERSAL / total : 0,
    NORMAL_LOSS: total > 0 ? counts.NORMAL_LOSS / total : 0,
  };
  return { total, counts, pct };
}

export interface MistakeDecileStats {
  decile: number; // 1 (lowest predicted mistake risk) .. 10 (highest)
  count: number;
  mistakeRate: number;
  avgR: number;
  lowSampleWarning: boolean;
}

/** Used by part 4's runMistakePipeline -- exported here since that's where mistake classification lives. */
export function evaluateMistakeDeciles(
  test: MistakeTradeRecord[],
  standardizer: Standardizer,
  model: LogisticModel,
): MistakeDecileStats[] {
  const scored = test.map((r) => ({
    record: r,
    isMistake: MISTAKE_CATEGORIES.includes(classifyMistake(r)),
    score: predictProba(model, applyStandardizer(r, standardizer)),
  }));
  scored.sort((a, b) => a.score - b.score);

  const n = scored.length;
  const deciles: MistakeDecileStats[] = [];
  for (let d = 1; d <= 10; d++) {
    const startIdx = Math.floor(((d - 1) / 10) * n);
    const endIdx = Math.floor((d / 10) * n);
    const bucket = scored.slice(startIdx, endIdx);
    if (bucket.length === 0) {
      deciles.push({
        decile: d,
        count: 0,
        mistakeRate: 0,
        avgR: 0,
        lowSampleWarning: true,
      });
      continue;
    }
    const mistakeRate =
      bucket.filter((b) => b.isMistake).length / bucket.length;
    const avgR =
      bucket.reduce((s, b) => s + b.record.forwardR, 0) / bucket.length;
    deciles.push({
      decile: d,
      count: bucket.length,
      mistakeRate,
      avgR,
      lowSampleWarning: bucket.length < MIN_RECORDS_PER_DECILE,
    });
  }
  return deciles;
}
