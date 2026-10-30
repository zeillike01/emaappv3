import { describe, expect, it } from "vitest";
import { oneHourRejectionAt } from "./one-hour-rejection";

const bar = (closeTime: number, high: number, low: number, close: number) => ({ closeTime, high, low, close });

describe("oneHourRejectionAt", () => {
  it("flags a bullish failed breakout for a long", () => {
    const bars = [
      bar(1, 101, 99, 100),
      bar(2, 102, 98, 100),
      bar(3, 103, 99, 100),
      bar(4, 106, 100, 105),
      bar(5, 105, 99, 101),
    ];
    expect(oneHourRejectionAt(bars, 5, 3, 2, "LONG")?.direction).toBe("bullish-failure");
  });

  it("flags a bearish failed breakout for a short", () => {
    const bars = [
      bar(1, 101, 99, 100),
      bar(2, 102, 98, 100),
      bar(3, 103, 97, 100),
      bar(4, 100, 94, 95),
      bar(5, 101, 95, 99),
    ];
    expect(oneHourRejectionAt(bars, 5, 3, 2, "SHORT")?.direction).toBe("bearish-failure");
  });

  it("does not return the opposite-side rejection", () => {
    const bars = [
      bar(1, 101, 99, 100),
      bar(2, 102, 98, 100),
      bar(3, 103, 97, 100),
      bar(4, 100, 94, 95),
      bar(5, 101, 95, 99),
    ];
    expect(oneHourRejectionAt(bars, 5, 3, 2, "LONG")).toBeNull();
  });

  it("ignores an unconfirmed breakout and fails open on short history", () => {
    const unconfirmed = [
      bar(1, 101, 99, 100),
      bar(2, 102, 98, 100),
      bar(3, 103, 99, 100),
      bar(4, 106, 100, 105),
    ];
    expect(oneHourRejectionAt(unconfirmed, 4, 3, 2, "LONG")).toBeNull();
    expect(oneHourRejectionAt([bar(1, 101, 99, 100)], 1, 3, 2, "LONG")).toBeNull();
  });

  it("does not treat a close exactly on the range boundary as a breakout", () => {
    const bars = [
      bar(1, 101, 99, 100),
      bar(2, 102, 98, 100),
      bar(3, 103, 99, 100),
      bar(4, 103, 100, 103),
      bar(5, 104, 99, 101),
    ];
    expect(oneHourRejectionAt(bars, 5, 3, 2, "LONG")).toBeNull();
  });

  it("honors the maximum confirmation age boundary", () => {
    const bars = [
      bar(1, 101, 99, 100),
      bar(2, 102, 98, 100),
      bar(3, 103, 99, 100),
      bar(4, 106, 100, 106),
      bar(5, 105, 99, 101),
      bar(6, 105, 99, 100),
      bar(7, 105, 99, 100),
    ];
    expect(oneHourRejectionAt(bars, 7, 3, 2, "LONG")).not.toBeNull();
    expect(oneHourRejectionAt(bars, 7, 3, 1, "LONG")).toBeNull();
  });
});
