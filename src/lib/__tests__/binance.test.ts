import { describe, it, expect } from "vitest";
import type { Kline } from "../types";

// We can't easily test fetchKlines directly without mocking fetch,
// so we test the deduplication logic by simulating what fetchKlines does.

function makeKline(openTime: number, close: number): Kline {
  return {
    openTime,
    open: close - 0.5,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
    closeTime: openTime + 899999,
    quoteVolume: 100,
    trades: 1,
    isClosed: true,
  };
}

describe("kline deduplication (simulating binance.ts logic)", () => {
  // Replicate the dedup logic from binance.ts
  function dedup(existing: Kline[], fresh: Kline[]): Kline[] {
    const seen = new Set(existing.map((k) => k.openTime));
    return [...existing, ...fresh.filter((k) => !seen.has(k.openTime))];
  }

  it("merges two non-overlapping sets", () => {
    const batch1 = [makeKline(1000, 100), makeKline(2000, 101)];
    const batch2 = [makeKline(3000, 102), makeKline(4000, 103)];

    const result = dedup(batch1, batch2);
    expect(result.length).toBe(4);
    expect(result.map((k) => k.openTime)).toEqual([1000, 2000, 3000, 4000]);
  });

  it("deduplicates overlapping entries", () => {
    const batch1 = [makeKline(1000, 100), makeKline(2000, 101)];
    const batch2 = [makeKline(2000, 101), makeKline(3000, 102)];

    const result = dedup(batch1, batch2);
    expect(result.length).toBe(3);
    expect(result.map((k) => k.openTime)).toEqual([1000, 2000, 3000]);
  });

  it("handles fully overlapping batches", () => {
    const batch1 = [makeKline(1000, 100), makeKline(2000, 101)];
    const batch2 = [makeKline(1000, 100), makeKline(2000, 101)];

    const result = dedup(batch1, batch2);
    expect(result.length).toBe(2);
  });

  it("handles empty existing array", () => {
    const fresh = [makeKline(1000, 100), makeKline(2000, 101)];
    const result = dedup([], fresh);
    expect(result.length).toBe(2);
  });

  it("handles empty fresh array", () => {
    const existing = [makeKline(1000, 100)];
    const result = dedup(existing, []);
    expect(result.length).toBe(1);
  });

  it("preserves order", () => {
    const batch1 = [makeKline(3000, 102), makeKline(1000, 100)];
    const batch2 = [makeKline(2000, 101), makeKline(4000, 103)];

    const result = dedup(batch1, batch2);
    expect(result.map((k) => k.openTime)).toEqual([3000, 1000, 2000, 4000]);
  });

  it("keeps first occurrence on duplicate timestamps", () => {
    const batch1 = [makeKline(1000, 100)];
    const batch2 = [makeKline(1000, 999)]; // same timestamp, different close

    const result = dedup(batch1, batch2);
    expect(result.length).toBe(1);
    expect(result[0].close).toBe(100); // original kept
  });
});
