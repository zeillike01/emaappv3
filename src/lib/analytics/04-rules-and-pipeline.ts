/**
 * Trade Analytics Pipeline -- Part 4 of 4: Rule Extraction & Orchestration
 *
 * Requires 01-types-and-split.ts, 02-standardize-and-scoring.ts, and
 * 03-mistake-taxonomy.ts in the same folder. This is the file you
 * actually call.
 *
 * findBestSplitRule finds the single feature + threshold that best
 * separates mistake rate on TRAIN, then evaluateRuleOnBothSets reports
 * how well that same rule holds on TEST. The train-vs-test comparison
 * is the whole point: this is exactly the check that was missing when
 * the ADX 20-30 "sweet spot" was found by eye earlier and later
 * collapsed under walk-forward. Trust a rule only if its test-set
 * mistake rates roughly track its train-set mistake rates -- if they
 * diverge sharply, that's the pipeline correctly telling you the
 * pattern doesn't generalize. Don't keep adjusting features against
 * the same test split until it looks better; that's manual overfitting.
 *
 * HOW TO USE:
 *   const result = runMistakePipeline(mistakeTrades, featureNames);
 *   console.log(result.tally);         // BAD_ENTRY vs REVERSAL vs NORMAL_LOSS counts
 *   console.log(result.testDeciles);   // does the model separate mistake-prone trades out-of-sample
 *   console.log(result.candidateRule); // single best feature+threshold, train vs test shown side by side
 */

import { chronologicalSplit, filterCompleteRecords } from "./01-types-and-split";
import {
  Standardizer,
  LogisticModel,
  LogisticTrainConfig,
  computeStandardizer,
  applyStandardizer,
  trainLogisticRegression,
} from "./02-standardize-and-scoring";
import {
  MistakeTradeRecord,
  MistakeTally,
  MistakeDecileStats,
  MISTAKE_CATEGORIES,
  classifyMistake,
  tallyMistakes,
  evaluateMistakeDeciles,
} from "./03-mistake-taxonomy";

export interface CandidateRule {
  feature: string;
  threshold: number;
  trainMistakeRateAbove: number;
  trainMistakeRateBelow: number;
  trainCountAbove: number;
  trainCountBelow: number;
  testMistakeRateAbove: number;
  testMistakeRateBelow: number;
  testCountAbove: number;
  testCountBelow: number;
}

const MIN_GROUP_SIZE = 30; // don't consider a split that leaves either side thinner than this

function findBestSplitRule(
  train: MistakeTradeRecord[],
  featureNames: string[],
): { feature: string; threshold: number } | null {
  let best: { feature: string; threshold: number; separation: number } | null = null;

  for (const feature of featureNames) {
    const values = [...new Set(train.map((r) => r.features[feature]))].sort(
      (a, b) => a - b,
    );
    const candidateThresholds = [10, 20, 30, 40, 50, 60, 70, 80, 90].map(
      (pct) => {
        const idx = Math.floor((pct / 100) * (values.length - 1));
        return values[idx];
      },
    );

    for (const threshold of candidateThresholds) {
      const above = train.filter(
        (r) => r.features[feature] >= threshold,
      );
      const below = train.filter(
        (r) => r.features[feature] < threshold,
      );
      if (above.length < MIN_GROUP_SIZE || below.length < MIN_GROUP_SIZE)
        continue;

      const mistakeRateAbove =
        above.filter((r) =>
          MISTAKE_CATEGORIES.includes(classifyMistake(r)),
        ).length / above.length;
      const mistakeRateBelow =
        below.filter((r) =>
          MISTAKE_CATEGORIES.includes(classifyMistake(r)),
        ).length / below.length;
      const separation = Math.abs(mistakeRateAbove - mistakeRateBelow);

      if (!best || separation > best.separation) {
        best = { feature, threshold, separation };
      }
    }
  }

  return best
    ? { feature: best.feature, threshold: best.threshold }
    : null;
}

function evaluateRuleOnBothSets(
  train: MistakeTradeRecord[],
  test: MistakeTradeRecord[],
  rule: { feature: string; threshold: number },
): CandidateRule {
  const trainAbove = train.filter(
    (r) => r.features[rule.feature] >= rule.threshold,
  );
  const trainBelow = train.filter(
    (r) => r.features[rule.feature] < rule.threshold,
  );
  const testAbove = test.filter(
    (r) => r.features[rule.feature] >= rule.threshold,
  );
  const testBelow = test.filter(
    (r) => r.features[rule.feature] < rule.threshold,
  );

  const rate = (group: MistakeTradeRecord[]) =>
    group.length > 0
      ? group.filter((r) =>
          MISTAKE_CATEGORIES.includes(classifyMistake(r)),
        ).length / group.length
      : 0;

  return {
    feature: rule.feature,
    threshold: rule.threshold,
    trainMistakeRateAbove: rate(trainAbove),
    trainMistakeRateBelow: rate(trainBelow),
    trainCountAbove: trainAbove.length,
    trainCountBelow: trainBelow.length,
    testMistakeRateAbove: rate(testAbove),
    testMistakeRateBelow: rate(testBelow),
    testCountAbove: testAbove.length,
    testCountBelow: testBelow.length,
  };
}

export interface MistakePipelineResult {
  tally: MistakeTally;
  model: LogisticModel;
  standardizer: Standardizer;
  trainCount: number;
  testCount: number;
  testDeciles: MistakeDecileStats[];
  droppedForMissingFeatures: number;
  candidateRule: CandidateRule | null;
}

export interface MistakePipelineConfig {
  trainFraction?: number;
  logisticConfig?: LogisticTrainConfig;
  extractCandidateRule?: boolean; // default true
}

export function runMistakePipeline(
  trades: MistakeTradeRecord[],
  featureNames: string[],
  config: MistakePipelineConfig = {},
): MistakePipelineResult {
  const tally = tallyMistakes(trades);

  const { complete, droppedCount } = filterCompleteRecords(
    trades,
    featureNames,
  );
  const completeMistake = complete as MistakeTradeRecord[];
  const { train, test } = chronologicalSplit(
    completeMistake,
    config.trainFraction ?? 0.7,
  );
  const trainM = train as MistakeTradeRecord[];
  const testM = test as MistakeTradeRecord[];

  const standardizer = computeStandardizer(trainM, featureNames);
  const X = trainM.map((r) => applyStandardizer(r, standardizer));
  const y = trainM.map((r) =>
    MISTAKE_CATEGORIES.includes(classifyMistake(r)) ? 1 : 0,
  );
  const model = trainLogisticRegression(
    X,
    y,
    featureNames,
    config.logisticConfig,
  );

  const testDeciles = evaluateMistakeDeciles(
    testM,
    standardizer,
    model,
  );

  let candidateRule: CandidateRule | null = null;
  if (config.extractCandidateRule ?? true) {
    const rule = findBestSplitRule(trainM, featureNames);
    if (rule) candidateRule = evaluateRuleOnBothSets(trainM, testM, rule);
  }

  return {
    tally,
    model,
    standardizer,
    trainCount: trainM.length,
    testCount: testM.length,
    testDeciles,
    droppedForMissingFeatures: droppedCount,
    candidateRule,
  };
}
