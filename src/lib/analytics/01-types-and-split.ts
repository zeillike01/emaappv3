/**
 * Trade Analytics Pipeline -- Part 1 of 4: Types & Data Splitting
 *
 * Full pipeline is split across 4 files for easier copying:
 *   1. 01-types-and-split.ts       <- you are here
 *   2. 02-standardize-and-scoring.ts
 *   3. 03-mistake-taxonomy.ts
 *   4. 04-rules-and-pipeline.ts
 * Each file imports from the ones before it. Copy/paste them in order
 * into the same folder and the imports will resolve.
 *
 * THE NON-NEGOTIABLE PART OF THIS WHOLE PIPELINE: standardization
 * parameters, model weights, and any score threshold are fit ONLY on
 * a chronological train split, then applied UNCHANGED to a test split
 * the fitting process never sees. This is the direct fix for what
 * happened to the ADX 20-30 finding earlier -- that "edge" was found
 * by slicing one fixed dataset many ways and reporting the best-
 * looking slice, which collapsed the moment it was checked out-of-
 * sample. This file's split functions exist specifically so it's
 * structurally hard to leak test-set information into fitting later on.
 */

export interface TradeRecord {
  id: string;
  timestamp: number; // entry time (ms) -- used for chronological ordering/splitting
  features: Record<string, number>; // arbitrary numeric features
  forwardR: number; // realized R-multiple outcome (the label)
}

export function chronologicalSplit(
  records: TradeRecord[],
  trainFraction: number = 0.7,
): { train: TradeRecord[]; test: TradeRecord[] } {
  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp);
  const splitIdx = Math.floor(sorted.length * trainFraction);
  return { train: sorted.slice(0, splitIdx), test: sorted.slice(splitIdx) };
}

/**
 * Rolling walk-forward splits, for more rigorous validation than a
 * single train/test cut: produces multiple (train, test) pairs, each
 * test fold immediately following its train fold in time, moving
 * forward through the dataset. More expensive to run but much harder
 * to accidentally get a lucky single split.
 */
export function rollingWalkForwardSplits(
  records: TradeRecord[],
  numFolds: number,
  trainFraction: number = 0.7,
): { train: TradeRecord[]; test: TradeRecord[] }[] {
  const sorted = [...records].sort((a, b) => a.timestamp - b.timestamp);
  const foldSize = Math.floor(sorted.length / numFolds);
  const out: { train: TradeRecord[]; test: TradeRecord[] }[] = [];

  for (let f = 0; f < numFolds; f++) {
    const foldStart = f * foldSize;
    const foldEnd = f === numFolds - 1 ? sorted.length : (f + 1) * foldSize;
    const fold = sorted.slice(foldStart, foldEnd);
    if (fold.length < 20) continue; // too small a fold to be meaningful
    const trainSplitIdx = Math.floor(fold.length * trainFraction);
    out.push({ train: fold.slice(0, trainSplitIdx), test: fold.slice(trainSplitIdx) });
  }
  return out;
}

/** Drops records missing any of the required features, rather than silently imputing. */
export function filterCompleteRecords(
  records: TradeRecord[],
  featureNames: string[],
): { complete: TradeRecord[]; droppedCount: number } {
  const complete = records.filter((r) =>
    featureNames.every((f) => typeof r.features[f] === "number" && !Number.isNaN(r.features[f])),
  );
  return { complete, droppedCount: records.length - complete.length };
}
