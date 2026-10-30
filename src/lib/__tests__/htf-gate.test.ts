import { describe, it, expect } from "vitest";
import {
  computeLayer2Signal,
  htfTrendFromCloses,
  resolveConfig,
  resolvePaperConfig,
  resolveFundingRate,
  DEFAULT_CONFIG,
} from "../layer2-signal";

const flat60 = Array.from({ length: 60 }, () => 100);

describe("htfTrendFromCloses (1H HTF gate classifier)", () => {
  it("returns undefined with less than 20 closed bars (fail-open)", () => {
    expect(htfTrendFromCloses(Array(19).fill(100), 20)).toBeUndefined();
  });

  it("uses at most the last 60 closes", () => {
    // 100 closes: first 40 garbage, last 60 rising 1/bar. A 60-bar window is
    // applied, so the garbage must not leak in (period 2 has no lag bias).
    const closes = [...Array(40).fill(0), ...Array.from({ length: 60 }, (_, i) => i + 1)];
    expect(closes.length).toBeGreaterThan(60);
    expect(htfTrendFromCloses(closes, 2)).toBe("up");
  });

  it("classifies a rising series as up", () => {
    const closes = flat60.map((v, i) => v + i);
    expect(htfTrendFromCloses(closes, 2)).toBe("up");
  });

  it("classifies a falling series as down", () => {
    const closes = flat60.map((v, i) => v - i);
    expect(htfTrendFromCloses(closes, 2)).toBe("down");
  });

  it("classifies a perfectly flat series as flat", () => {
    expect(htfTrendFromCloses(flat60, 20)).toBe("flat");
  });

  // ── PRICE-VS-EMA rule (2026-09-11) — fixtures that DISCRIMINATE from the
  // old EMA-slope rule (EMA vs prior close). Both were verified to flip
  // verdicts between the two semantics before being pinned here.

  it("blocks LONG semantics (down) when price closes below the EMA even while the EMA still rises", () => {
    // 58 gently rising bars, then 95, 93: the dump leaves EMA15 (≈97.05)
    // ABOVE the prior close (95) — the slope rule read "up" and allowed a
    // long with price 4% under the EMA. Price-vs-EMA must read "down".
    const closes = Array.from({ length: 58 }, (_, i) => 90 + i * 0.16);
    closes.push(95, 93);
    expect(htfTrendFromCloses(closes, 15)).toBe("down");
  });

  it("allows LONG semantics (up) when price closes above the EMA during a recovery the slope rule still calls down", () => {
    // Accelerating decline, then a bounce bar closing above the EMA: the
    // slope rule read "down" (EMA 85.4 < prior close 93) and blocked a long
    // whose price had already reclaimed the EMA. Price-vs-EMA reads "up".
    const closes: number[] = [];
    let x = 100;
    for (let i = 0; i < 57; i++) {
      closes.push(x);
      x -= 0.15 + i * 0.01;
    }
    closes.push(93, 94);
    expect(htfTrendFromCloses(closes, 30)).toBe("up");
  });

  it("mirrors for SHORT: close below the EMA is 'down' (short allowed), above is 'up' (short vetoed)", () => {
    // Same bounce fixture, short side: recovery close above EMA30 vetoes
    // SHORTS ("up"), while a close under the EMA keeps them allowed ("down").
    const bounce: number[] = [];
    let x = 100;
    for (let i = 0; i < 57; i++) {
      bounce.push(x);
      x -= 0.15 + i * 0.01;
    }
    bounce.push(93, 94);
    expect(htfTrendFromCloses(bounce, 30)).toBe("up"); // shorts vetoed here

    const dip = Array.from({ length: 58 }, (_, i) => 90 + i * 0.16);
    dip.push(95, 93);
    expect(htfTrendFromCloses(dip, 15)).toBe("down"); // shorts allowed here
  });

  it("is stable across typical gate periods on a monotonic series", () => {
    const closes = flat60.map((v, i) => v + i);
    for (const period of [10, 15, 20, 30, 50]) {
      const trend = htfTrendFromCloses(closes, period);
      expect(["up", "down", "flat"]).toContain(trend);
    }
  });

  it("EMA30 (2026-09-11 live long-gate period) converges within the 60-bar fetch window", () => {
    // The fetcher hardcodes 60 1h bars; htfTrendFromCloses seeds its EMA on
    // win[0], so the first ~41 bars of a 60-bar window still carry seed
    // memory for period 30. This test pins the practical tolerance: on a
    // realistic drift+noise series the 60-bar-window EMA30 must land within
    // 0.05% of a fully-converged 400-bar EMA30 (seed effect fades roughly
    // as (1-k)^n with k = 2/31 ≈ 6.5% per bar). Above ~0.05% the
    // ema-vs-prevClose comparison could flip on edge-of-trend bars.
    const k = 2 / (30 + 1);
    const emaLast = (win: number[]) => {
      let v = win[0];
      for (let i = 1; i < win.length; i++) v = win[i] * k + v * (1 - k);
      return v;
    };
    let x = 100;
    let seed = 42;
    const full: number[] = [];
    for (let i = 0; i < 400; i++) {
      seed = (seed * 9301 + 49297) % 233280;
      const noise = (seed / 233280 - 0.5) * 0.6;
      x = x * 1.0008 + noise;
      full.push(x);
    }
    const a = emaLast(full.slice(-60));
    const b = emaLast(full);
    const driftPct = Math.abs((a - b) / b) * 100;
    expect(driftPct).toBeLessThan(0.05);
  });
});

describe("funding policy scoring", () => {
  const closes = Array.from({ length: 60 }, () => 100);

  it("adds the aligned bonus without making funding mandatory", () => {
    const neutral = computeLayer2Signal(closes, 0, 0, 0, 0, 0, 0, 0.1, 1, DEFAULT_CONFIG);
    const longAligned = computeLayer2Signal(closes, 0, 0, -0.0001, 0, 0, 0, 0.1, 1, DEFAULT_CONFIG);
    const shortAligned = computeLayer2Signal(closes, 0, 0, 0.0001, 0, 0, 0, 0.1, 1, DEFAULT_CONFIG);

    expect(longAligned.longScore).toBe(neutral.longScore + DEFAULT_CONFIG.fundingWeight);
    expect(longAligned.shortScore).toBe(neutral.shortScore);
    expect(shortAligned.shortScore).toBe(neutral.shortScore + DEFAULT_CONFIG.fundingWeight);
    expect(shortAligned.longScore).toBe(neutral.longScore);
    expect(longAligned.reasons.some((reason) => reason.includes("LONG funding bonus"))).toBe(true);
    expect(shortAligned.reasons.some((reason) => reason.includes("SHORT funding bonus"))).toBe(true);
  });

  it("does not add a bonus for neutral or sub-threshold funding", () => {
    const neutral = computeLayer2Signal(closes, 0, 0, 0, 0, 0, 0, 0.1, 1, DEFAULT_CONFIG);
    const smallRate = computeLayer2Signal(
      closes,
      0,
      0,
      DEFAULT_CONFIG.fundingBonusThreshold / 2,
      0,
0,
      0,
      0.1,
      1,
      DEFAULT_CONFIG
    );

    expect(smallRate.longScore).toBe(neutral.longScore);
    expect(smallRate.shortScore).toBe(neutral.shortScore);
  });

  it("ignores funding on paper while the gate is off (no veto, no bonus)", () => {
    // Run broken at the last bar (2026-10-03, chase-streak veto): the dip keeps
    // EMA trend/scores identical while silencing the streak veto, so these
    // funding-policy tests keep isolating funding.
    const bullishCloses = [...Array.from({ length: 59 }, (_, i) => 100 + i), 157];
    // rsiLongGuard/maxEmaStretch disabled: these fixtures isolate FUNDING
    // policy, and monotone rising closes print RSI(7)=100 (would trip the
    // wick guard shipped 2026-09-09).
    const paper = resolvePaperConfig({ fundingMode: "bonus", rsiLongGuard: false, maxEmaStretchPct: 0 });
    const positiveFunding = computeLayer2Signal(
      bullishCloses,
      0,
      0,
      0.0001,
      0,
0,
      0,
      0.1,
      1,
      paper
    );
    const negativeFunding = computeLayer2Signal(
      bullishCloses,
      0,
      0,
      -0.0001,
      0,
0,
      0,
      0.1,
      1,
      paper
    );
    const neutral = computeLayer2Signal(
      bullishCloses,
      0,
      0,
      0,
      0,
0,
      0,
      0.1,
      1,
      resolvePaperConfig(null)
    );

    expect(paper.fundingMode).toBe("off");
    expect(positiveFunding.longFundingBlocked).toBe(false);
    expect(positiveFunding.side).toBe("LONG");
    expect(negativeFunding.longFundingBlocked).toBe(false);
    expect(negativeFunding.side).toBe("LONG");
    expect(positiveFunding.longScore).toBe(neutral.longScore); // no bonus either
    expect(positiveFunding.shortScore).toBe(neutral.shortScore);
  });

  it("does not block paper entries when funding is unavailable while the gate is off", () => {
    // Run broken at the last bar (2026-10-03, chase-streak veto): the dip keeps
    // EMA trend/scores identical while silencing the streak veto, so these
    // funding-policy tests keep isolating funding.
    const bullishCloses = [...Array.from({ length: 59 }, (_, i) => 100 + i), 157];
    const result = computeLayer2Signal(
      bullishCloses,
      0,
      0,
      undefined,
      0,
0,
      0,
      0.1,
      1,
      resolvePaperConfig({ rsiLongGuard: false, maxEmaStretchPct: 0 })
    );

    expect(result.side).toBe("LONG");
    expect(result.longFundingBlocked).toBe(false);
    expect(result.shortFundingBlocked).toBe(false);
    expect(result.blockers).not.toContain("Funding rate unavailable");
  });

  it("preserves a valid neutral rate while rejecting an invalid cached zero", () => {
    expect(resolveFundingRate(0, true)).toBe(0);
    expect(resolveFundingRate(0, false)).toBeUndefined();
    expect(resolveFundingRate(0, undefined)).toBeUndefined();
  });

  it("keeps live legacy bonus resolution separate from paper off resolution", () => {
    expect(resolveConfig({ fundingMode: "bonus" }).fundingMode).toBe("bonus");
    expect(resolveConfig({ fundingMode: "off" }).fundingMode).toBe("off");
    expect(resolvePaperConfig({ fundingMode: "bonus" }).fundingMode).toBe("off");
    expect(resolvePaperConfig({ fundingMode: "strict" }).fundingMode).toBe("off");
  });

  it("strict mode vetoes only the side that funding disagrees with", () => {
    // Run broken at the last bar (2026-10-03, chase-streak veto): the dip keeps
    // EMA trend/scores identical while silencing the streak veto, so these
    // funding-policy tests keep isolating funding.
    const bullishCloses = [...Array.from({ length: 59 }, (_, i) => 100 + i), 157];
    const strict = resolveConfig({ fundingMode: "strict", rsiLongGuard: false, maxEmaStretchPct: 0 });
    const positiveFunding = computeLayer2Signal(
      bullishCloses,
      0,
      0,
      0.0001,
      0,
0,
      0,
      0.1,
      1,
      strict
    );
    const negativeFunding = computeLayer2Signal(
      bullishCloses,
      0,
      0,
      -0.0001,
      0,
0,
      0,
      0.1,
      1,
      strict
    );

    expect(positiveFunding.longFundingBlocked).toBe(true);
    expect(positiveFunding.side).toBeNull();
    expect(negativeFunding.longFundingBlocked).toBe(false);
    expect(negativeFunding.side).toBe("LONG");
  });

  it("keeps live bonus defaults while resolvePaperConfig forces off", () => {
    const cfg = resolveConfig({ emaFast: 7, emaSlow: 30 });
    expect(cfg.fundingMode).toBe("bonus");
    expect(cfg.fundingWeight).toBe(2);
    expect(cfg.fundingBonusThreshold).toBe(0.00005);
    expect(resolvePaperConfig({ emaFast: 7, emaSlow: 30, fundingMode: "bonus" }).fundingMode).toBe("off");
  });
});

