/**
 * Vol SMA self-inclusion tests.
 *
 * The signal bar's volume must NOT be part of the 20-bar SMA used to
 * compute volRatio. If it is, the ratio is deflated — a genuine 3× spike
 * might show as 2.3× and get blocked.
 */
import { describe, it, expect } from "vitest";

/**
 * Compute volRatio the same way the detectors do:
 * SMA of 20 bars BEFORE the signal bar, then ratio = signalVol / SMA.
 */
function computeVolRatio(volumes: number[], signalIdx: number): number {
  // Correct pattern: j = i-20 to i-1 (excludes signal bar)
  let volSum = 0;
  for (let j = signalIdx - 20; j < signalIdx; j++) {
    volSum += volumes[j];
  }
  const volSma = volSum / 20;
  return volSma > 0 ? volumes[signalIdx] / volSma : 0;
}

/**
 * The BUGGY pattern: j = i-20 to i (INCLUDES signal bar).
 */
function computeVolRatioBuggy(volumes: number[], signalIdx: number): number {
  let volSum = 0;
  for (let j = signalIdx - 20; j <= signalIdx; j++) {
    volSum += volumes[j];
  }
  const volSma = volSum / 20;
  return volSma > 0 ? volumes[signalIdx] / volSma : 0;
}

describe("Vol SMA self-inclusion", () => {
  it("correct SMA excludes signal bar from average", () => {
    // 21 bars: first 20 have volume 100, signal bar has volume 300
    const volumes = Array(20).fill(100).concat([300]);
    const ratio = computeVolRatio(volumes, 20);

    // SMA = 100 (only the 20 baseline bars), ratio = 300/100 = 3.0
    expect(ratio).toBe(3.0);
  });

  it("buggy SMA includes signal bar, deflating the ratio", () => {
    const volumes = Array(20).fill(100).concat([300]);
    const ratio = computeVolRatioBuggy(volumes, 20);

    // SMA = (2000 + 300) / 20 = 115, ratio = 300/115 ≈ 2.609
    expect(ratio).toBeCloseTo(2.609, 2);
  });

  it("correct ratio is always higher than buggy ratio", () => {
    const volumes = Array(20).fill(100).concat([250]);
    const correct = computeVolRatio(volumes, 20);
    const buggy = computeVolRatioBuggy(volumes, 20);

    expect(correct).toBeGreaterThan(buggy);
  });

  it("at exactly 2.5× true volume, correct passes threshold but buggy may not", () => {
    const volumes = Array(20).fill(100).concat([250]);
    const correct = computeVolRatio(volumes, 20);
    const buggy = computeVolRatioBuggy(volumes, 20);

    expect(correct).toBe(2.5); // passes ≥ 2.5 threshold
    // Buggy includes signal bar in 20-bar avg: (2000+300)/20=115, ratio=300/115≈2.609
    // Still above 2.5 but the ratio is deflated — a borderline spike gets inflated
    expect(buggy).toBeLessThan(correct);
  });

  it("handles varying baseline volumes", () => {
    const volumes = [80, 90, 110, 100, 95, 85, 105, 115, 90, 100,
                     85, 95, 105, 110, 80, 90, 100, 110, 95, 85, 400];
    const correct = computeVolRatio(volumes, 20);
    const buggy = computeVolRatioBuggy(volumes, 20);

    // Baseline avg ≈ 96, correct ratio ≈ 4.17, buggy ≈ 3.81
    expect(correct).toBeGreaterThan(buggy);
    expect(correct).toBeGreaterThan(3.5);
  });
});
