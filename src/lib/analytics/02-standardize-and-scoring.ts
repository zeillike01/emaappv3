/**
 * Trade Analytics Pipeline -- Part 2 of 4: Standardization & Scoring
 *
 * Requires 01-types-and-split.ts in the same folder.
 *
 * This part combines several weak, partially-informative numeric
 * features into one continuous score via logistic regression, so no
 * single feature has to carry the whole edge on its own. WHAT THIS
 * CANNOT DO: if a feature (or combination of features) has genuinely
 * zero relationship to forward returns, no amount of combining or
 * reweighting invents one. The decile evaluation on the test set
 * (evaluateDeciles, below) is the honest readout either way -- a flat
 * decile table on the test set means the model didn't find anything
 * real, and that's a valid, useful result, not a failure to fix.
 *
 * HOW TO USE:
 *   1. Build a TradeRecord[] (see part 1) from your trade history.
 *   2. Call runCompositeScoring(records, featureNames, config).
 *   3. Read result.testDeciles. Roughly monotonic (decile 10 clearly
 *      better than decile 1) = real out-of-sample structure. Flat or
 *      noisy = it isn't -- don't deploy it, and don't re-tune features
 *      against the same test split (that's overfitting with extra
 *      steps; use a fresh time period as the next test set instead).
 */

import { TradeRecord, chronologicalSplit, filterCompleteRecords } from "./01-types-and-split";

export interface Standardizer {
  featureNames: string[];
  mean: number[];
  std: number[]; // guarded against 0 (see computeStandardizer)
}

export interface LogisticModel {
  weights: number[]; // aligned with featureNames order
  bias: number;
  featureNames: string[];
}

/** Fit mean/std ONLY on the train set. Never call this on test data. */
export function computeStandardizer(train: TradeRecord[], featureNames: string[]): Standardizer {
  const mean = featureNames.map(
    (f) => train.reduce((s, r) => s + r.features[f], 0) / train.length,
  );
  const std = featureNames.map((f, i) => {
    const variance = train.reduce((s, r) => s + (r.features[f] - mean[i]) ** 2, 0) / train.length;
    const sd = Math.sqrt(variance);
    return sd > 1e-9 ? sd : 1; // guard against a constant feature causing divide-by-zero
  });
  return { featureNames, mean, std };
}

/** Apply a standardizer fit on train to ANY record (train or test) -- no refitting on test, ever. */
export function applyStandardizer(record: TradeRecord, standardizer: Standardizer): number[] {
  return standardizer.featureNames.map(
    (f, i) => (record.features[f] - standardizer.mean[i]) / standardizer.std[i],
  );
}

function sigmoid(z: number): number {
  return 1 / (1 + Math.exp(-z));
}

export interface LogisticTrainConfig {
  epochs?: number;
  learningRate?: number;
  l2?: number; // L2 regularization strength -- keeps weights modest given a wide feature set relative to trade count
}

/**
 * Trains a logistic regression predicting P(forwardR > 0) from
 * standardized features, via batch gradient descent with L2
 * regularization. Call this on the TRAIN set only.
 */
export function trainLogisticRegression(
  X: number[][],
  y: number[], // 1 if forwardR > 0 (or, in part 4, 1 if "mistake"), else 0
  featureNames: string[],
  config: LogisticTrainConfig = {},
): LogisticModel {
  const epochs = config.epochs ?? 500;
  const lr = config.learningRate ?? 0.1;
  const l2 = config.l2 ?? 0.05;

  const n = X.length;
  const d = featureNames.length;
  let weights = new Array(d).fill(0);
  let bias = 0;

  for (let _epoch = 0; _epoch < epochs; _epoch++) {
    const gradW = new Array(d).fill(0);
    let gradB = 0;

    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((s, xij, j) => s + xij * weights[j], bias);
      const pred = sigmoid(z);
      const err = pred - y[i];
      for (let j = 0; j < d; j++) gradW[j] += err * X[i][j];
      gradB += err;
    }

    for (let j = 0; j < d; j++) {
      weights[j] -= lr * (gradW[j] / n + l2 * weights[j]);
    }
    bias -= lr * (gradB / n);
  }

  return { weights, bias, featureNames };
}

export function predictProba(model: LogisticModel, x: number[]): number {
  const z = x.reduce((s, xj, j) => s + xj * model.weights[j], model.bias);
  return sigmoid(z);
}

export const MIN_RECORDS_PER_DECILE = 15; // below this, treat the decile's stats as unreliable (same lesson as the 15-trade FARTCOIN result)

export interface DecileStats {
  decile: number; // 1 (lowest score) .. 10 (highest score)
  count: number;
  winRate: number;
  avgR: number;
  profitFactor: number;
  lowSampleWarning: boolean;
}

/**
 * Scores every test record, sorts by score, buckets into deciles, and
 * reports WR/avgR/PF per decile. This is the honest readout of whether
 * the model found real structure.
 */
export function evaluateDeciles(
  test: TradeRecord[],
  standardizer: Standardizer,
  model: LogisticModel,
): DecileStats[] {
  const scored = test.map((r) => ({
    record: r,
    score: predictProba(model, applyStandardizer(r, standardizer)),
  }));
  scored.sort((a, b) => a.score - b.score);

  const n = scored.length;
  const deciles: DecileStats[] = [];
  for (let d = 1; d <= 10; d++) {
    const startIdx = Math.floor(((d - 1) / 10) * n);
    const endIdx = Math.floor((d / 10) * n);
    const bucket = scored.slice(startIdx, endIdx).map((s) => s.record);
    if (bucket.length === 0) {
      deciles.push({ decile: d, count: 0, winRate: 0, avgR: 0, profitFactor: 0, lowSampleWarning: true });
      continue;
    }
    const wins = bucket.filter((r) => r.forwardR > 0);
    const losses = bucket.filter((r) => r.forwardR <= 0);
    const winRate = wins.length / bucket.length;
    const avgR = bucket.reduce((s, r) => s + r.forwardR, 0) / bucket.length;
    const grossWin = wins.reduce((s, r) => s + r.forwardR, 0);
    const grossLoss = Math.abs(losses.reduce((s, r) => s + r.forwardR, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? Infinity : 0;
    deciles.push({
      decile: d,
      count: bucket.length,
      winRate,
      avgR,
      profitFactor,
      lowSampleWarning: bucket.length < MIN_RECORDS_PER_DECILE,
    });
  }
  return deciles;
}

export interface CompositeScoringResult {
  model: LogisticModel;
  standardizer: Standardizer;
  trainCount: number;
  testCount: number;
  testDeciles: DecileStats[];
  droppedForMissingFeatures: number;
}

export interface CompositeScoringConfig {
  trainFraction?: number;
  logisticConfig?: LogisticTrainConfig;
}

/**
 * End-to-end plain win/loss scoring: split -> standardize (train-only)
 * -> train (train-only) -> evaluate (test-only).
 */
export function runCompositeScoring(
  records: TradeRecord[],
  featureNames: string[],
  config: CompositeScoringConfig = {},
): CompositeScoringResult {
  const { complete, droppedCount } = filterCompleteRecords(records, featureNames);
  const { train, test } = chronologicalSplit(complete, config.trainFraction ?? 0.7);

  const standardizer = computeStandardizer(train, featureNames);
  const X = train.map((r) => applyStandardizer(r, standardizer));
  const y = train.map((r) => (r.forwardR > 0 ? 1 : 0));
  const model = trainLogisticRegression(X, y, featureNames, config.logisticConfig);

  const testDeciles = evaluateDeciles(test, standardizer, model);

  return {
    model,
    standardizer,
    trainCount: train.length,
    testCount: test.length,
    testDeciles,
    droppedForMissingFeatures: droppedCount,
  };
}
