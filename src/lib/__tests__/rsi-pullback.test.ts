import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  computeLayer2Signal,
  resolveConfig,
  wilderRsi,
  type StrategyConfig,
} from "../layer2-signal";

/** Rising closes that read as a LONG candidate (EMA5 > EMA20, minScore 0). */
function longCloses(n = 80, base = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(base + i * 0.4);
  return out;
}

/** Falling closes that read as a SHORT candidate. */
function shortCloses(n = 80, base = 200): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(base - i * 0.4);
  return out;
}

/**
 * Run-BROKEN variants (2026-10-03, chase-streak veto): same trend, last bar
 * counter-moves so the streak veto stays silent and these tests keep isolating
 * the pullback term. RSI bands below are derived from the same series, so they
 * stay consistent. The veto itself is pinned in streak-veto.test.ts.
 */
function longClosesCool(n = 80, base = 100): number[] {
  const out = longCloses(n, base);
  out[out.length - 1] = out[out.length - 2]! - 0.2;
  return out;
}
function shortClosesCool(n = 80, base = 200): number[] {
  const out = shortCloses(n, base);
  out[out.length - 1] = out[out.length - 2]! + 0.2;
  return out;
}

/** Base config with every other veto neutralised, so a test isolates this term. */
const BASE_CFG: StrategyConfig = resolveConfig({
  minScore: 0,
  minGap: 0,
  maxEmaStretchPct: 0,
  rsiLongGuard: false,
});

const call = (closes: number[], cfg: StrategyConfig) =>
  computeLayer2Signal(closes, 0.5, 0, null, 0.5, 0.5, 1, 0.01, 1e8, cfg);

describe("wilderRsi", () => {
  it("returns null when there is not enough history to carry a reading", () => {
    expect(wilderRsi([100, 101, 102], 14)).toBeNull();
    expect(wilderRsi(longCloses(80), 1)).toBeNull(); // period must be > 1
  });

  it("pins the recursion: monotone-up = 100, monotone-down = 0, chop ≈ 50", () => {
    expect(wilderRsi(longCloses(80), 14)).toBe(100);
    expect(wilderRsi(shortCloses(80), 14)).toBe(0);
    const chop: number[] = [100];
    for (let i = 1; i < 80; i++) chop.push(chop[i - 1] + (i % 2 ? 1 : -1));
    const r = wilderRsi(chop, 14);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThan(45);
    expect(r!).toBeLessThan(55);
  });
});

describe("RSI pullback term — shipped state and resolution", () => {
  it("ships OFF: mode \"off\", period 14, long band 40-75, short band 30-60", () => {
    expect(DEFAULT_CONFIG.rsiPullbackMode).toBe("off");
    expect(DEFAULT_CONFIG.rsiPullbackPeriod).toBe(14);
    expect(DEFAULT_CONFIG.rsiPullbackLongMin).toBe(40);
    expect(DEFAULT_CONFIG.rsiPullbackLongMax).toBe(75);
    expect(DEFAULT_CONFIG.rsiPullbackShortMin).toBe(30);
    expect(DEFAULT_CONFIG.rsiPullbackShortMax).toBe(60);
    expect(resolveConfig({}).rsiPullbackMode).toBe("off");
  });

  it("accepts bonus/veto from a stored row and refuses to arm on junk", () => {
    expect(resolveConfig({ rsiPullbackMode: "veto" }).rsiPullbackMode).toBe("veto");
    expect(resolveConfig({ rsiPullbackMode: "bonus" }).rsiPullbackMode).toBe("bonus");
    // An unrecognised stored value must fall back to the OFF default, never
    // to an armed state.
    expect(resolveConfig({ rsiPullbackMode: "on" }).rsiPullbackMode).toBe("off");
    expect(resolveConfig({ rsiPullbackMode: 1 }).rsiPullbackMode).toBe("off");
  });

  it("honours a stored band and period", () => {
    const c = resolveConfig({
      rsiPullbackMode: "veto",
      rsiPullbackPeriod: 7,
      rsiPullbackLongMin: 35,
      rsiPullbackLongMax: 65,
    });
    expect(c.rsiPullbackPeriod).toBe(7);
    expect(c.rsiPullbackLongMin).toBe(35);
    expect(c.rsiPullbackLongMax).toBe(65);
  });
});

describe("RSI pullback term — veto mode", () => {
  it("is a strict no-op while the mode is off (identical scores and side)", () => {
    const closes = longCloses();
    const off = call(closes, BASE_CFG);
    // A band that excludes the real reading entirely — if "off" leaked into the
    // logic at all, this would veto the entry.
    const off2 = call(closes, { ...BASE_CFG, rsiPullbackMode: "off", rsiPullbackLongMin: 99, rsiPullbackLongMax: 100 });
    expect(off2.side).toBe(off.side);
    expect(off2.longScore).toBe(off.longScore);
    expect(off2.rsiPullbackBlocked).toBe(false);
  });

  it("blocks LONG when its RSI sits outside the configured band", () => {
    const closes = longClosesCool();
    const rsi = wilderRsi(closes, 14)!;
    // Band strictly ABOVE the reading → outside → veto.
    const cfg = { ...BASE_CFG, rsiPullbackMode: "veto" as const, rsiPullbackLongMin: rsi + 5, rsiPullbackLongMax: rsi + 10 };
    const s = call(closes, cfg);
    expect(s.side).toBeNull();
    expect(s.rsiPullbackBlocked).toBe(true);
    expect(s.reasons.join(" ")).toMatch(/outside LONG pullback band/);
  });

  it("allows LONG when its RSI sits inside the band", () => {
    const closes = longClosesCool();
    const rsi = wilderRsi(closes, 14)!;
    const cfg = { ...BASE_CFG, rsiPullbackMode: "veto" as const, rsiPullbackLongMin: rsi - 1, rsiPullbackLongMax: rsi + 1 };
    const s = call(closes, cfg);
    expect(s.side).toBe("LONG");
    expect(s.rsiPullbackBlocked).toBe(false);
  });

  it("bands are inclusive at both edges", () => {
    const closes = longClosesCool();
    const rsi = wilderRsi(closes, 14)!;
    for (const band of [
      { min: rsi, max: rsi + 5 },
      { min: rsi - 5, max: rsi },
    ]) {
      const s = call(closes, {
        ...BASE_CFG,
        rsiPullbackMode: "veto",
        rsiPullbackLongMin: band.min,
        rsiPullbackLongMax: band.max,
      });
      expect(s.side).toBe("LONG");
    }
  });

  it("uses the SHORT band for a short candidate (bands never cross sides)", () => {
    const closes = shortClosesCool();
    const rsi = wilderRsi(closes, 14)!;
    // LONG band would allow nothing here; the SHORT band is what decides.
    const blocked = call(closes, {
      ...BASE_CFG,
      rsiPullbackMode: "veto",
      rsiPullbackLongMin: 99,
      rsiPullbackLongMax: 100,
      rsiPullbackShortMin: rsi + 5,
      rsiPullbackShortMax: rsi + 10,
    });
    expect(blocked.side).toBeNull();
    expect(blocked.rsiPullbackBlocked).toBe(true);
    const allowed = call(closes, {
      ...BASE_CFG,
      rsiPullbackMode: "veto",
      rsiPullbackShortMin: rsi - 1,
      rsiPullbackShortMax: rsi + 1,
    });
    expect(allowed.side).toBe("SHORT");
  });

  it("fails OPEN on missing history: too few closed bars is no opinion, not a veto", () => {
    const closes = longClosesCool(12); // shorter than period + 2
    expect(wilderRsi(closes, 14)).toBeNull();
    const s = call(closes, {
      ...BASE_CFG,
      rsiPullbackMode: "veto",
      rsiPullbackLongMin: 99,
      rsiPullbackLongMax: 100,
    });
    expect(s.rsiPullbackBlocked).toBe(false);
    expect(s.side).toBe("LONG");
  });
});

describe("RSI pullback term — bonus mode", () => {
  it("adds exactly rsiPullbackWeight to the long score when the trend agrees", () => {
    const closes = longCloses();
    const rsi = wilderRsi(closes, 14)!;
    const off = call(closes, BASE_CFG);
    const bonus = call(closes, {
      ...BASE_CFG,
      rsiPullbackMode: "bonus",
      rsiPullbackWeight: 4,
      rsiPullbackLongMin: rsi - 1,
      rsiPullbackLongMax: rsi + 1,
    });
    expect(bonus.longScore).toBeCloseTo(off.longScore + 4, 6);
    expect(bonus.shortScore).toBeCloseTo(off.shortScore, 6);
    expect(bonus.reasons.join(" ")).toMatch(/pullback band/);
  });

  it("adds nothing when the reading is outside the band", () => {
    const closes = longCloses();
    const rsi = wilderRsi(closes, 14)!;
    const off = call(closes, BASE_CFG);
    const bonus = call(closes, {
      ...BASE_CFG,
      rsiPullbackMode: "bonus",
      rsiPullbackWeight: 4,
      rsiPullbackLongMin: rsi + 5,
      rsiPullbackLongMax: rsi + 10,
    });
    expect(bonus.longScore).toBeCloseTo(off.longScore, 6);
  });

  it("credits the SHORT side on a down trend, and only one side per reading", () => {
    const closes = shortCloses();
    const rsi = wilderRsi(closes, 14)!;
    const off = call(closes, BASE_CFG);
    const band = { rsiPullbackShortMin: rsi - 1, rsiPullbackShortMax: rsi + 1 };
    const bonus = call(closes, { ...BASE_CFG, rsiPullbackMode: "bonus", rsiPullbackWeight: 3, ...band });
    expect(bonus.shortScore).toBeCloseTo(off.shortScore + 3, 6);
    expect(bonus.longScore).toBeCloseTo(off.longScore, 6);
    // A band wide enough to contain the reading on BOTH sides must still only
    // pay the side the trend agrees with — one RSI value, one credit.
    const both = call(closes, {
      ...BASE_CFG,
      rsiPullbackMode: "bonus",
      rsiPullbackWeight: 3,
      rsiPullbackLongMin: 0,
      rsiPullbackLongMax: 100,
      rsiPullbackShortMin: 0,
      rsiPullbackShortMax: 100,
    });
    expect(both.shortScore).toBeCloseTo(off.shortScore + 3, 6);
    expect(both.longScore).toBeCloseTo(off.longScore, 6);
  });

  it("a zero weight is inert even with the mode armed", () => {
    const closes = longCloses();
    const off = call(closes, BASE_CFG);
    const s = call(closes, { ...BASE_CFG, rsiPullbackMode: "bonus", rsiPullbackWeight: 0, rsiPullbackLongMin: 0, rsiPullbackLongMax: 100 });
    expect(s.longScore).toBeCloseTo(off.longScore, 6);
  });
});
