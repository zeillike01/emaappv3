import { describe, it, expect } from "vitest";
import type { Kline } from "./types";

// ── Helpers ──

function kline(
  close: number,
  open: number,
  high: number,
  low: number,
  vol: number,
  utcHour: number,
): Kline {
  // Build a timestamp at the given UTC hour on a fixed date
  const base = Date.UTC(2026, 0, 15, utcHour, 0, 0); // Jan 15 2026
  return {
    openTime: base,
    open,
    high,
    low,
    close,
    volume: vol,
    closeTime: base + 899_000, // 15m bar
    quoteVolume: vol * close,
    trades: 10,
    isClosed: true,
  };
}

/**
 * Build a 50-bar kline series where every bar has the same UTC hour.
 * The LAST bar gets the spike volume + direction; the rest are baseline.
 */
function buildSessionBars(
  utcHour: number,
  opts: {
    lastClose?: number;
    lastOpen?: number;
    lastHigh?: number;
    lastLow?: number;
    lastVol?: number;
    baselineVol?: number;
  } = {},
): Kline[] {
  const {
    lastClose = 100,
    lastOpen = 101,
    lastHigh = 102,
    lastLow = 99,
    lastVol = 5000,
    baselineVol = 100,
  } = opts;

  const bars: Kline[] = [];
  for (let i = 0; i < 49; i++) {
    bars.push(kline(100, 100, 100.5, 99.5, baselineVol, utcHour));
  }
  // Last bar: volume spike with clear direction
  bars.push(kline(lastClose, lastOpen, lastHigh, lastLow, lastVol, utcHour));
  return bars;
}

// Reimplement the session gate logic from orbStrategy.ts to test it directly
function isAllowedSession(utcHour: number): boolean {
  return (
    (utcHour >= 7 && utcHour < 13) ||  // London
    (utcHour >= 13 && utcHour < 17) || // LDN-NY overlap
    (utcHour >= 17 && utcHour < 22)    // NY
  );
}

function sessionLabel(h: number): string {
  if (h < 7) return "asia";
  if (h < 13) return "london";
  if (h < 17) return "ldn-ny";
  if (h < 22) return "ny";
  return "late";
}

function detectSessionSpike(klines: Kline[]): { type: string; session: string; volRatio: number } | null {
  if (klines.length < 30) return null;
  const closed = klines.filter((b) => b.isClosed !== false);
  if (closed.length < 25) return null;

  const last = closed[closed.length - 1];
  const prev = closed[closed.length - 2];
  if (!prev) return null;

  const utcHour = new Date(last.closeTime).getUTCHours();
  const session = sessionLabel(utcHour);
  if (!isAllowedSession(utcHour)) return null;

  // Volume spike >= 2x 20-bar SMA
  let volSum = 0;
  for (let i = closed.length - 20; i < closed.length; i++) volSum += closed[i].volume;
  const volSma = volSum / 20;
  if (volSma <= 0) return null;
  const volRatio = last.volume / volSma;
  if (volRatio < 2.0) return null;

  // Body ratio 0.3-0.7
  const range = last.high - last.low;
  if (range <= 0) return null;
  const body = Math.abs(last.close - last.open);
  const bodyRatio = body / range;
  if (bodyRatio < 0.3 || bodyRatio > 0.7) return null;

  // Direction
  const mid = (last.high + last.low) / 2;
  let type: string;
  if (last.close > last.open && last.close > mid) {
    type = "LONG";
    if (last.close < last.high * 0.999) return null;
  } else if (last.close < last.open && last.close < mid) {
    type = "SHORT";
    if (last.close > last.low * 1.001) return null;
  } else {
    return null;
  }

  return { type, session, volRatio };
}

// ── Tests ──

describe("Session filter gate", () => {
  it("allows London session (UTC 07-13)", () => {
    expect(isAllowedSession(7)).toBe(true);
    expect(isAllowedSession(10)).toBe(true);
    expect(isAllowedSession(12)).toBe(true);
  });

  it("allows LDN-NY overlap (UTC 13-17)", () => {
    expect(isAllowedSession(13)).toBe(true);
    expect(isAllowedSession(15)).toBe(true);
    expect(isAllowedSession(16)).toBe(true);
  });

  it("allows NY session (UTC 17-22)", () => {
    expect(isAllowedSession(17)).toBe(true);
    expect(isAllowedSession(20)).toBe(true);
    expect(isAllowedSession(21)).toBe(true);
  });

  it("blocks Asia session (UTC 00-07)", () => {
    expect(isAllowedSession(0)).toBe(false);
    expect(isAllowedSession(3)).toBe(false);
    expect(isAllowedSession(6)).toBe(false);
  });

  it("blocks Late session (UTC 22-00)", () => {
    expect(isAllowedSession(22)).toBe(false);
    expect(isAllowedSession(23)).toBe(false);
  });
});

describe("Session label", () => {
  it("returns correct labels for all hours", () => {
    expect(sessionLabel(0)).toBe("asia");
    expect(sessionLabel(6)).toBe("asia");
    expect(sessionLabel(7)).toBe("london");
    expect(sessionLabel(12)).toBe("london");
    expect(sessionLabel(13)).toBe("ldn-ny");
    expect(sessionLabel(16)).toBe("ldn-ny");
    expect(sessionLabel(17)).toBe("ny");
    expect(sessionLabel(21)).toBe("ny");
    expect(sessionLabel(22)).toBe("late");
    expect(sessionLabel(23)).toBe("late");
  });
});

describe("Session-filtered volume spike detector", () => {
  it("detects LONG signal during London session", () => {
    const bars = buildSessionBars(10, {
      lastClose: 101.95, // near high for strong close
      lastOpen: 100,
      lastHigh: 102,
      lastLow: 99,
      lastVol: 5000,
    });
    const result = detectSessionSpike(bars);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("LONG");
    expect(result!.session).toBe("london");
    expect(result!.volRatio).toBeGreaterThanOrEqual(2);
  });

  it("detects SHORT signal during NY session", () => {
    const bars = buildSessionBars(19, {
      lastClose: 98.05, // near low (within 0.1%) for strong close, body ~49%
      lastOpen: 100,
      lastHigh: 102,
      lastLow: 98,
      lastVol: 5000,
    });
    const result = detectSessionSpike(bars);
    expect(result).not.toBeNull();
    expect(result!.type).toBe("SHORT");
    expect(result!.session).toBe("ny");
  });

  it("BLOCKS signal during Asia session (UTC 3)", () => {
    const bars = buildSessionBars(3, {
      lastClose: 101,
      lastOpen: 100,
      lastHigh: 102,
      lastLow: 99,
      lastVol: 5000,
    });
    const result = detectSessionSpike(bars);
    expect(result).toBeNull();
  });

  it("BLOCKS signal during Late session (UTC 23)", () => {
    const bars = buildSessionBars(23, {
      lastClose: 101,
      lastOpen: 100,
      lastHigh: 102,
      lastLow: 99,
      lastVol: 5000,
    });
    const result = detectSessionSpike(bars);
    expect(result).toBeNull();
  });

  it("detects signal during LDN-NY overlap (UTC 14)", () => {
    const bars = buildSessionBars(14, {
      lastClose: 101.95, // near high for strong close
      lastOpen: 100,
      lastHigh: 102,
      lastLow: 99,
      lastVol: 5000,
    });
    const result = detectSessionSpike(bars);
    expect(result).not.toBeNull();
    expect(result!.session).toBe("ldn-ny");
  });

  it("rejects signal with low volume (no spike)", () => {
    const bars = buildSessionBars(10, {
      lastVol: 200, // barely above baseline, ratio < 2x
    });
    const result = detectSessionSpike(bars);
    expect(result).toBeNull();
  });

  it("rejects doji bar (body too small)", () => {
    const bars = buildSessionBars(10, {
      lastClose: 100.01,
      lastOpen: 100,
      lastHigh: 102,
      lastLow: 98,
      lastVol: 5000,
    });
    // body = 0.01, range = 4 → bodyRatio = 0.25% — below 30%
    const result = detectSessionSpike(bars);
    expect(result).toBeNull();
  });

  it("rejects marubozu bar (body too large)", () => {
    const bars = buildSessionBars(10, {
      lastClose: 101,
      lastOpen: 99.5,
      lastHigh: 101.1,
      lastLow: 99.4,
      lastVol: 5000,
    });
    // body = 1.5, range = 1.7 → bodyRatio = 88% — above 70%
    const result = detectSessionSpike(bars);
    expect(result).toBeNull();
  });

  it("requires too few bars returns null", () => {
    const bars = buildSessionBars(10).slice(0, 10);
    const result = detectSessionSpike(bars);
    expect(result).toBeNull();
  });
});
