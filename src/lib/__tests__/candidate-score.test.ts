import { describe, expect, it } from "vitest";
import {
  CAND_AS_WRITTEN_SETTINGS,
  CAND_DEFAULT_SETTINGS,
  candFeatures,
  closeRun,
  scoreCandidate,
  wickShare,
  type CandFeatures,
  type CandSettings,
  type CandSnap,
} from "../candidate-score";

/** Build n identical-shape candles from a close path. */
const mkCandles = (closes: number[]): NonNullable<CandSnap["candles"]> =>
  closes.map((c) => ({ open: c, high: c * 1.001, low: c * 0.999, close: c }));

const upPath = (n: number, from = 100, step = 0.5): number[] =>
  Array.from({ length: n }, (_, i) => from + i * step);

const baseSnap = (over: Partial<CandSnap> = {}): CandSnap => ({
  candles: mkCandles(upPath(60)),
  lastPrice: 129.5,
  imbalance: 0,
  flowBias: 0,
  spreadPct: 0.05,
  fundingRate: 0,
  volume24: 1_000_000,
  ...over,
});

/** Hand-built features for precise side-rule tests. */
const feat = (over: Partial<CandFeatures> = {}): CandFeatures => ({
  emaFast: 110,
  emaSlow: 105,
  emaGap: 4.76,
  atrPct: 0.8,
  rangePct: 0.2,
  extAtr: 0.3,
  run: 1,
  rsi7: 50,
  wickUpper: 0.3,
  wickLower: 0.3,
  imbalance: 0,
  flowBias: 0,
  spreadPct: 0.05,
  fundingRate: 0,
  volume24: 1_000_000,
  exhLong: 0,
  exhShort: 0,
  exhBlockers: [],
  exhReasons: [],
  ...over,
});

const sett = (over: Partial<CandSettings> = {}): CandSettings => ({
  ...CAND_DEFAULT_SETTINGS,
  ...over,
});

const margin = (d: { longScore: number; shortScore: number }): number => d.longScore - d.shortScore;

describe("closeRun", () => {
  it("counts consecutive same-direction closes, capped at ±cap", () => {
    // all up
    expect(closeRun(mkCandles(upPath(10)), 6)).toBe(6);
    // 4 up then a down close breaks the streak at the end
    const path = [...upPath(9), upPath(9)[8]! - 1];
    expect(closeRun(mkCandles(path), 6)).toBe(-1);
    // trailing up-streak of 4 (…100, 100.5, 101, 101.5, 102), broken by the −1 before it
    const p2 = [100, 101, 100, 100.5, 101, 101.5, 102];
    expect(closeRun(mkCandles(p2), 6)).toBe(4);
  });

  it("stops on a flat close", () => {
    const p = [100, 101, 102, 102, 103];
    expect(closeRun(mkCandles(p), 6)).toBe(1);
  });
});

describe("wickShare", () => {
  it("measures wicks against the full range", () => {
    // open=close=100 body at the bottom: full upper wick
    const c = { open: 100, close: 100, high: 110, low: 100 };
    expect(wickShare(c).upper).toBeCloseTo(1, 6);
    expect(wickShare(c).lower).toBeCloseTo(0, 6);
  });

  it("returns 0 on a zero-range candle (no division by zero)", () => {
    expect(wickShare({ open: 100, close: 100, high: 100, low: 100 })).toEqual({ upper: 0, lower: 0 });
  });
});

describe("candFeatures", () => {
  it("returns null under 22 candles (ATR warmup guard)", () => {
    expect(candFeatures(baseSnap({ candles: mkCandles(upPath(20)) }))).toBeNull();
  });

  it("detects an uptrend EMA stack on a rising path", () => {
    const f = candFeatures(baseSnap())!;
    expect(f.emaFast).toBeGreaterThan(f.emaSlow);
    expect(f.emaGap).toBeGreaterThan(0);
  });

  it("computes ATR/range with the proposal's windows", () => {
    const f = candFeatures(baseSnap())!;
    expect(f.atrPct).toBeGreaterThan(0);
    expect(f.rangePct).toBeCloseTo(0.2, 1); // high-low = 0.2% of price by construction
  });
});

describe("scoreCandidate — proposal fidelity", () => {
  it("applies the +16/−10 trend tilt and picks LONG on an up stack", () => {
    const f = feat({ emaFast: 110, emaSlow: 105 });
    const d = scoreCandidate(f, sett({ useImbalance: false, useFlow: false }));
    expect(d.side).toBe("LONG");
    expect(d.reasons.some((r) => r.includes("above"))).toBe(true);
    // 50 + 16 = 66 base; spreadPct 0.05 sits in the neutral band (0.04..0.12) so no spread term
    expect(d.longScore).toBe(66);
    expect(d.shortScore).toBe(40); // 50 − 10
  });

  it("mirror-images on a down stack", () => {
    const f = feat({ emaFast: 90, emaSlow: 100 });
    const d = scoreCandidate(f, sett({ useImbalance: false, useFlow: false }));
    expect(d.side).toBe("SHORT");
    expect(d.longScore).toBeLessThan(d.shortScore);
  });

  it("fires the gap bonus ONLY when exhaustion is off (carried inversion)", () => {
    const f = feat({ emaGap: 1.5 });
    const off = scoreCandidate(f, sett({ useExhaustion: false, useImbalance: false, useFlow: false }));
    const on = scoreCandidate(f, sett({ useExhaustion: true, useImbalance: false, useFlow: false }));
    expect(off.longScore - on.longScore).toBe(6); // gap bonus missing when exhaustion on
  });

  it("funding: negative favors long by 6, > 0.0002 favors short by 6, dead zone is neutral", () => {
    const neutral = margin(scoreCandidate(feat(), sett({ useImbalance: false, useFlow: false })));
    const neg = scoreCandidate(feat({ fundingRate: -0.0001 }), sett({ useImbalance: false, useFlow: false }));
    expect(margin(neg)).toBe(neutral + 6);
    const hot = scoreCandidate(feat({ fundingRate: 0.0005 }), sett({ useImbalance: false, useFlow: false }));
    expect(margin(hot)).toBe(neutral - 6);
    const dead = scoreCandidate(feat({ fundingRate: 0.0001 }), sett({ useImbalance: false, useFlow: false }));
    expect(margin(dead)).toBe(neutral);
  });
});

describe("scoreCandidate — structural properties", () => {
  it("PIN: shared penalties cancel in the margin — while both sides stay off the floor", () => {
    const clean = scoreCandidate(feat({ spreadPct: 0.05 }), sett({ useImbalance: false, useFlow: false }));
    const wide = scoreCandidate(feat({ spreadPct: 0.2 }), sett({ useImbalance: false, useFlow: false }));
    expect(margin(wide)).toBe(margin(clean)); // −14/−14 is invisible to the margin
    expect(wide.longScore).toBe(clean.longScore - 14);
    expect(wide.blockers).toContain("wide spread");
  });

  it("PIN (defect): the 0-clamp lets shared penalties ERODE the margin", () => {
    const clean = scoreCandidate(feat({ spreadPct: 0.05 }), sett({ useImbalance: false, useFlow: false }));
    const dirty = scoreCandidate(
      feat({ spreadPct: 0.2, rangePct: 9.9, atrPct: 0.05, volume24: 0 }),
      sett({ useImbalance: false, useFlow: false, skipSpike: true }),
    );
    expect(dirty.blockers).toContain("ATR spike");
    expect(dirty.blockers).toContain("no 24h volume");
    // −62 on both sides, but the losing side is lifted to the 0 floor:
    // margin 26 → 4. Shared penalties are NOT pure level shifts.
    expect(clean.longScore - dirty.longScore).toBe(62);
    expect(dirty.shortScore).toBe(0);
    expect(margin(dirty)).toBe(4);
    expect(margin(clean)).toBe(26);
  });

  it("PIN: blockers never veto — a 'blocked' bar still trades if it clears the rule", () => {
    const blocked = scoreCandidate(
      feat({ spreadPct: 0.2, volume24: 0, emaFast: 400, emaSlow: 100 }),
      sett({ useImbalance: false, useFlow: false, minScore: 10 }),
    );
    // −14 wide spread and −20 no-volume both fired…
    expect(blocked.blockers).toContain("wide spread");
    expect(blocked.blockers).toContain("no 24h volume");
    // …and the bar still goes LONG: 66−34 = 32 ≥ minScore 10, margin intact.
    expect(blocked.side).toBe("LONG");
    expect(blocked.longScore).toBe(32);
  });

  it("PIN: missing order book (spreadPct 0) earns the tight-spread bonus", () => {
    const missing = scoreCandidate(feat({ spreadPct: 0 }), sett({ useImbalance: false, useFlow: false }));
    const normal = scoreCandidate(feat({ spreadPct: 0.05 }), sett({ useImbalance: false, useFlow: false }));
    const tight = scoreCandidate(feat({ spreadPct: 0.02 }), sett({ useImbalance: false, useFlow: false }));
    const mid = scoreCandidate(feat({ spreadPct: 0.08 }), sett({ useImbalance: false, useFlow: false }));
    expect(tight.longScore - mid.longScore).toBe(4);
    // spreadPct falls back to 0 when the book is absent → 0 < 0.04 → the
    // TIGHT-SPREAD bonus fires: missing data scores exactly like a perfect book
    // and 4 points BETTER than a normal one.
    expect(missing.longScore).toBe(tight.longScore);
    expect(missing.longScore - normal.longScore).toBe(4);
  });

  it("microstructure terms move the margin by ±2*22 at full weight", () => {
    const pos = scoreCandidate(feat({ imbalance: 1, flowBias: 0 }), sett({ useImbalance: true, useFlow: false }));
    const neg = scoreCandidate(feat({ imbalance: -1, flowBias: 0 }), sett({ useImbalance: true, useFlow: false }));
    const neu = scoreCandidate(feat({ imbalance: 0 }), sett({ useImbalance: false, useFlow: false }));
    // imbalance ±1 moves LONG−SHORT by 2*22 = 44 each way around neutral
    expect(margin(pos) - margin(neu)).toBe(44);
    expect(margin(neg) - margin(neu)).toBe(-44);
    // both micro terms at full strength (±88 on the margin) out-vote the
    // trend tilt (26): a bearish EMA stack flips to LONG on flow alone.
    const against = scoreCandidate(
      feat({ emaFast: 90, emaSlow: 100, imbalance: 1, flowBias: 1 }),
      sett({ useImbalance: true, useFlow: true }),
    );
    expect(against.side).toBe("LONG");
    expect(against.longScore).toBe(84); // 50 − 10 + 22 + 22
    expect(against.shortScore).toBe(22); // 66 − 22 − 22
  });

  it("enforces minScore and edge on the winning side", () => {
    const f = feat({ emaFast: 100.1, emaSlow: 100 }); // tiny tilt → still +16 though
    const strict = scoreCandidate(f, sett({ minScore: 90, useImbalance: false, useFlow: false }));
    expect(strict.side).toBeNull(); // 70 < 90
    const wide = scoreCandidate(f, sett({ edge: 50, useImbalance: false, useFlow: false }));
    expect(wide.side).toBeNull(); // 70 − 40 = 30 < 50
    const ok = scoreCandidate(f, sett({ minScore: 64, edge: 6, useImbalance: false, useFlow: false }));
    expect(ok.side).toBe("LONG");
  });

  it("as-written settings (all toggles undefined→off) differ from all-on", () => {
    const f = feat({ imbalance: 0.8, flowBias: 0.6, emaGap: 1 });
    const asWritten = scoreCandidate(f, CAND_AS_WRITTEN_SETTINGS);
    const allOn = scoreCandidate(f, CAND_DEFAULT_SETTINGS);
    expect(asWritten.longScore).not.toBe(allOn.longScore);
    // as-written gets the gap bonus; all-on spends its budget on exhaustion instead
    expect(asWritten.longScore).toBeGreaterThanOrEqual(allOn.longScore - 100);
  });
});
