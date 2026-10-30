/**
 * Analytics pipeline tests.
 *
 * Verifies the core pipeline: chronological split, standardization,
 * logistic regression, and decile evaluation. The key invariant:
 * test-set data is NEVER seen during training.
 */
import { describe, it, expect } from "vitest";
import {
  chronologicalSplit,
  rollingWalkForwardSplits,
  filterCompleteRecords,
  TradeRecord,
} from "../analytics/01-types-and-split";
import {
  computeStandardizer,
  applyStandardizer,
  trainLogisticRegression,
  predictProba,
  evaluateDeciles,
  runCompositeScoring,
} from "../analytics/02-standardize-and-scoring";
import {
  classifyMistake,
  tallyMistakes,
  MistakeTradeRecord,
} from "../analytics/03-mistake-taxonomy";

function makeTrade(
  id: string,
  timestamp: number,
  features: Record<string, number>,
  forwardR: number,
): TradeRecord {
  return { id, timestamp, features, forwardR };
}

describe("Chronological split", () => {
  it("splits 70/30 by default", () => {
    const records = Array.from({ length: 100 }, (_, i) =>
      makeTrade(`t${i}`, i * 1000, { vol: Math.random() }, Math.random() - 0.5)
    );
    const { train, test } = chronologicalSplit(records);

    expect(train.length).toBe(70);
    expect(test.length).toBe(30);
  });

  it("train is always before test in time", () => {
    const records = Array.from({ length: 50 }, (_, i) =>
      makeTrade(`t${i}`, (50 - i) * 1000, { vol: 1 }, 0.5) // shuffled timestamps
    );
    const { train, test } = chronologicalSplit(records);

    const maxTrainTime = Math.max(...train.map((r) => r.timestamp));
    const minTestTime = Math.min(...test.map((r) => r.timestamp));
    expect(maxTrainTime).toBeLessThanOrEqual(minTestTime);
  });

  it("custom split fraction", () => {
    const records = Array.from({ length: 100 }, (_, i) =>
      makeTrade(`t${i}`, i * 1000, { vol: 1 }, 0)
    );
    const { train, test } = chronologicalSplit(records, 0.8);

    expect(train.length).toBe(80);
    expect(test.length).toBe(20);
  });
});

describe("Rolling walk-forward splits", () => {
  it("produces multiple folds", () => {
    const records = Array.from({ length: 100 }, (_, i) =>
      makeTrade(`t${i}`, i * 1000, { vol: 1 }, 0)
    );
    const folds = rollingWalkForwardSplits(records, 5);

    expect(folds.length).toBeGreaterThan(0);
    expect(folds.length).toBeLessThanOrEqual(5);
  });

  it("each fold's test is after its train", () => {
    const records = Array.from({ length: 100 }, (_, i) =>
      makeTrade(`t${i}`, i * 1000, { vol: 1 }, 0)
    );
    const folds = rollingWalkForwardSplits(records, 5);

    for (const { train, test } of folds) {
      const maxTrain = Math.max(...train.map((r) => r.timestamp));
      const minTest = Math.min(...test.map((r) => r.timestamp));
      expect(maxTrain).toBeLessThanOrEqual(minTest);
    }
  });
});

describe("Filter complete records", () => {
  it("drops records with missing features", () => {
    const records = [
      makeTrade("t1", 1000, { vol: 1, atr: 0.5 }, 1),
      makeTrade("t2", 2000, { vol: 1 }, 0.5), // missing atr
      makeTrade("t3", 3000, { vol: 1, atr: 0.3 }, -0.5),
    ];
    const { complete, droppedCount } = filterCompleteRecords(records, ["vol", "atr"]);

    expect(complete.length).toBe(2);
    expect(droppedCount).toBe(1);
  });
});

describe("Standardizer", () => {
  it("mean/std computed only on train set", () => {
    const train = [
      makeTrade("t1", 1000, { vol: 2 }, 1),
      makeTrade("t2", 2000, { vol: 4 }, 1),
      makeTrade("t3", 3000, { vol: 6 }, -1),
    ];
    const std = computeStandardizer(train, ["vol"]);

    // Mean of [2, 4, 6] = 4, Std = sqrt(8/3) ≈ 1.633
    expect(std.mean[0]).toBe(4);
    expect(std.std[0]).toBeCloseTo(1.633, 2);
  });

  it("applyStandardizer normalizes correctly", () => {
    const train = [
      makeTrade("t1", 1000, { vol: 2 }, 1),
      makeTrade("t2", 2000, { vol: 4 }, 1),
      makeTrade("t3", 3000, { vol: 6 }, -1),
    ];
    const std = computeStandardizer(train, ["vol"]);
    const normalized = applyStandardizer(train[1], std); // vol=4, mean=4

    expect(normalized[0]).toBeCloseTo(0, 5); // z-score = 0
  });
});

describe("Logistic regression", () => {
  it("trains and predicts", () => {
    const X = [[1], [2], [3], [10], [11], [12]];
    const y = [0, 0, 0, 1, 1, 1];
    const model = trainLogisticRegression(X, y, ["feat"], { epochs: 100 });

    const predLow = predictProba(model, [1]);
    const predHigh = predictProba(model, [12]);

    expect(predLow).toBeLessThan(0.5);
    expect(predHigh).toBeGreaterThan(0.5);
  });
});

describe("Decile evaluation", () => {
  it("monotonic data produces monotonic deciles", () => {
    // Create synthetic data where higher feature = better outcome
    const records: TradeRecord[] = Array.from({ length: 100 }, (_, i) =>
      makeTrade(`t${i}`, i * 1000, { vol: i / 10 }, i > 50 ? 1 : -1)
    );
    const result = runCompositeScoring(records, ["vol"]);

    expect(result.testDeciles.length).toBe(10);
    // Top decile should have higher win rate than bottom
    const topDecile = result.testDeciles[result.testDeciles.length - 1];
    const bottomDecile = result.testDeciles[0];

    if (topDecile.count > 0 && bottomDecile.count > 0) {
      expect(topDecile.winRate).toBeGreaterThanOrEqual(bottomDecile.winRate);
    }
  });

  it("low sample warning triggers below threshold", () => {
    const records: TradeRecord[] = Array.from({ length: 5 }, (_, i) =>
      makeTrade(`t${i}`, i * 1000, { vol: i }, i > 2 ? 1 : -1)
    );
    const result = runCompositeScoring(records, ["vol"]);

    // With only 5 records, each decile has < 1 sample
    const hasWarning = result.testDeciles.some((d) => d.lowSampleWarning);
    expect(hasWarning).toBe(true);
  });
});

describe("Mistake taxonomy", () => {
  it("WIN classified correctly", () => {
    const trade: MistakeTradeRecord = {
      id: "t1", timestamp: 1000, features: {}, forwardR: 0.5,
      mfeR: 1.0, maeR: 0.2,
    };
    expect(classifyMistake(trade)).toBe("WIN");
  });

  it("BAD_ENTRY classified correctly (MAE within 3 bars)", () => {
    const trade: MistakeTradeRecord = {
      id: "t1", timestamp: 1000, features: {}, forwardR: -0.5,
      mfeR: 0.1, maeR: 1.2, barsToMAE: 2,
    };
    expect(classifyMistake(trade)).toBe("BAD_ENTRY");
  });

  it("REVERSAL classified correctly (MFE >= 0.5R then loss)", () => {
    const trade: MistakeTradeRecord = {
      id: "t1", timestamp: 1000, features: {}, forwardR: -0.3,
      mfeR: 0.8, maeR: 1.0, barsToMAE: 10,
    };
    expect(classifyMistake(trade)).toBe("REVERSAL");
  });

  it("NORMAL_LOSS classified correctly", () => {
    const trade: MistakeTradeRecord = {
      id: "t1", timestamp: 1000, features: {}, forwardR: -0.2,
      mfeR: 0.3, maeR: 0.8, barsToMAE: 10,
    };
    expect(classifyMistake(trade)).toBe("NORMAL_LOSS");
  });

  it("tallyMistakes counts correctly", () => {
    const trades: MistakeTradeRecord[] = [
      { id: "t1", timestamp: 1000, features: {}, forwardR: 1.0, mfeR: 1, maeR: 0 },
      { id: "t2", timestamp: 2000, features: {}, forwardR: -0.5, mfeR: 0.1, maeR: 1.2, barsToMAE: 2 },
      { id: "t3", timestamp: 3000, features: {}, forwardR: -0.3, mfeR: 0.8, maeR: 1.0, barsToMAE: 10 },
      { id: "t4", timestamp: 4000, features: {}, forwardR: -0.2, mfeR: 0.3, maeR: 0.8, barsToMAE: 10 },
    ];
    const tally = tallyMistakes(trades);

    expect(tally.total).toBe(4);
    expect(tally.counts.WIN).toBe(1);
    expect(tally.counts.BAD_ENTRY).toBe(1);
    expect(tally.counts.REVERSAL).toBe(1);
    expect(tally.counts.NORMAL_LOSS).toBe(1);
  });
});
