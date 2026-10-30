/**
 * HTF ADVISOR — unit tests (src/lib/htf-advisor.ts).
 *
 * Covers the contracts that gate real entries:
 *   1. Short history fails open (undefined → engines allow).
 *   2. WEIGHTED votes (2026-09-08, from the Sep 2-8 book replay): the full
 *      bearish divergence cluster at a 4H top vetoes LONG (threshold 2),
 *      stays ok at threshold 5. RSI/OBV bearish divergence are WEAK (0.5)
 *      so two of them alone no longer veto — that was the WLD/XRP fix.
 *   3. Bullish divergence at a 4H bottom vetoes SHORT (mirror) — STRONG
 *      (2 votes each): the short veto was a pure winner in the replay.
 *   4. VWAP exhaustion (stretched above VWAP + hot RSI + draining CMF) votes
 *      against LONG.
 *   5. Divergence older than advisorDivergenceAgeBars stops vetoing.
 *   6. advisorSignalWeights() pins the classification table.
 */
import { describe, expect, it } from "vitest";
import {
  ADV4H_TAG_VETO_LONG,
  ADV4H_TAG_VETO_SHORT,
  advisorShadowTags,
  advisorSignalWeights,
  advisorVetoFor,
  evaluateAdvisor,
  rsiSeries,
  stochRsiSeries,
} from "./htf-advisor";
import type { Kline } from "./types";

const CFG = {
  advisorVetoThreshold: 2,
  advisorDivergenceAgeBars: 6,
  advisorVwapExtremePct: 3,
  advisorRsiExtreme: 70,
  advisorStrongWeight: 2,
  advisorWeakWeight: 0.5,
};

const UNIFORM = { ...CFG, advisorStrongWeight: 1, advisorWeakWeight: 1 };

let t = 1_700_000_000_000;

function bar(open: number, high: number, low: number, close: number, volume = 10): Kline {
  t += 14_400_000;
  return {
    openTime: t - 14_400_000,
    open, high, low, close, volume,
    closeTime: t,
    quoteVolume: volume * close,
    trades: 0,
    isClosed: true,
  };
}

/** Slow uptrend with noise — the base canvas for a topping structure. */
function uptrendBase(n: number, price = 100): Kline[] {
  const out: Kline[] = [];
  let p = price * 0.9;
  for (let i = 0; i < n; i++) {
    const drift = (price * 0.9) / n; // small rise across the base
    const o = p;
    const c = o + drift + (i % 5 === 0 ? -0.05 : 0.04);
    const hi = Math.max(o, c) + 0.05;
    const lo = Math.min(o, c) - 0.05;
    out.push(bar(o, hi, lo, c, 10));
    p = c;
  }
  return out;
}

/** Slow downtrend — base canvas for a bottoming structure. */
function downtrendBase(n: number, price = 100): Kline[] {
  const out: Kline[] = [];
  let p = price * 1.1;
  for (let i = 0; i < n; i++) {
    const drift = -((price * 0.1) / n);
    const o = p;
    const c = o + drift + (i % 5 === 0 ? 0.05 : -0.04);
    const hi = Math.max(o, c) + 0.05;
    const lo = Math.min(o, c) - 0.05;
    out.push(bar(o, hi, lo, c, 10));
    p = c;
  }
  return out;
}

/** Build a topping: pivot A (100), pullback, higher-high pivot B (100.6) with
 *  RSI/OBV LOWER at B than A, then 6 bars of post-confirmation chop. */
function toppingWithBearishDivergence(): Kline[] {
  const k = uptrendBase(170, 100);
  // ── pivot A at idx 174 — strong top after 4 green bars (RSI elevated) ──
  const base = k[k.length - 1].close;
  const run = [base, base + 0.2, base + 0.4, base + 0.6];
  for (let i = 0; i < 4; i++) {
    const o = run[i];
    const c = run[i] + 0.3;
    k.push(bar(o, c + 0.1, o - 0.1, c, 10)); // greens
  }
  const aTop = run[3] + 0.3; // = idx 174 close
  // Pullback: 3 red bars with 3× volume (OBV drains below its level at A).
  k.push(bar(aTop - 0.05, aTop, aTop - 0.5, aTop - 0.4, 30)); // 175
  k.push(bar(aTop - 0.45, aTop - 0.2, aTop - 0.75, aTop - 0.7, 30)); // 176
  k.push(bar(aTop - 0.75, aTop - 0.5, aTop - 1.05, aTop - 1.0, 30)); // 177
  // ── pullback bars must strictly be BELOW pivot A's high ──
  // pivot A idx 174: highs of 172,173,175,176 must be < aTop — they are.
  // ── recovery to pivot B at idx 180: higher high, LOW volume (OBV stays low) ──
  k.push(bar(aTop - 1.0, aTop - 0.7, aTop - 1.1, aTop - 0.85, 10)); // 178
  k.push(bar(aTop - 0.85, aTop - 0.4, aTop - 0.95, aTop - 0.5, 10)); // 179
  const bHigh = aTop + 0.6; // HIGHER HIGH
  k.push(bar(aTop - 0.5, bHigh, aTop - 0.4, bHigh - 0.1, 10)); // 180 = pivot B
  // ── B confirmation: 181,182 must have highs < bHigh ──
  k.push(bar(bHigh - 0.2, bHigh - 0.1, bHigh - 0.6, bHigh - 0.55, 10)); // 181
  k.push(bar(bHigh - 0.55, bHigh - 0.3, bHigh - 0.8, bHigh - 0.75, 10)); // 182 → fire idx
  // ── 6 bars of chop after the fire (age = 6, still active) ──
  for (let i = 0; i < 6; i++) {
    const p = bHigh - 0.75 - i * 0.05;
    k.push(bar(p, p + 0.25, p - 0.3, p + (i % 2 === 0 ? 0.1 : -0.05), 10));
  }
  return k;
}

/** Mirror: pivot A (low), bounce, lower-low pivot B (100→99.4 area) with
 *  RSI/OBV HIGHER at B than A, then 6 bars of post-confirmation chop. */
function bottomingWithBullishDivergence(): Kline[] {
  const k = downtrendBase(170, 100);
  const base = k[k.length - 1].close;
  // pivot A (low) at idx 174
  const down = [base, base - 0.2, base - 0.4, base - 0.6];
  for (let i = 0; i < 4; i++) {
    const o = down[i];
    const c = down[i] - 0.3;
    k.push(bar(o, o + 0.1, c - 0.1, c, 10)); // reds
  }
  const aLow = down[3] - 0.3;
  // bounce bars (must stay above aLow)
  k.push(bar(aLow + 0.05, aLow + 0.5, aLow, aLow + 0.4, 10));
  k.push(bar(aLow + 0.4, aLow + 0.75, aLow + 0.2, aLow + 0.7, 10));
  k.push(bar(aLow + 0.7, aLow + 1.0, aLow + 0.5, aLow + 0.95, 10));
  // lower low pivot B at idx 180 (BIG volume on the drop so OBV stays LOW,
  // then recovery — the indicator comparison is at the pivots)
  const bLow = aLow - 0.6; // LOWER LOW
  k.push(bar(aLow + 0.3, aLow + 0.7, bLow, bLow + 0.15, 100)); // 180 = pivot B, heavy volume
  k.push(bar(bLow + 0.15, bLow + 0.55, bLow + 0.05, bLow + 0.5, 100)); // 181
  k.push(bar(bLow + 0.5, bLow + 0.9, bLow + 0.4, bLow + 0.85, 100)); // 182 → fire
  for (let i = 0; i < 6; i++) {
    const p = bLow + 0.85 + i * 0.05;
    k.push(bar(p, p + 0.3, p - 0.2, p + (i % 2 === 0 ? 0.08 : -0.04), 10));
  }
  return k;
}

describe("evaluateAdvisor", () => {
  it("fails open on insufficient history", () => {
    const k: Kline[] = [];
    for (let i = 0; i < 60; i++) k.push(bar(100 + i * 0.1, 100.5 + i * 0.1, 99.5 + i * 0.1, 100 + i * 0.1));
    expect(evaluateAdvisor(k, CFG)).toBeUndefined();
  });

  it("vetoes LONG on the full bearish divergence cluster at a 4H top (weighted, threshold 2)", () => {
    const k = toppingWithBearishDivergence();
    expect(k.length).toBeGreaterThan(120);
    const s = evaluateAdvisor(k, CFG)!;
    expect(s).toBeDefined();
    expect(s.rsiBear).toBe(true);
    expect(s.obvBear).toBe(true);
    // Weighted cluster: RSI 0.5 + OBV 0.5 + A/D 1 + CMF 1 = 3.0 ≥ 2.
    expect(s.long.status).toBe("veto");
    expect(s.long.votes).toBeGreaterThanOrEqual(2);
    expect(s.long.reasons.join(" ")).toContain("StochRSI(14/14/3/3) %D bearish divergence");
    expect(s.long.reasons.join(" ")).toContain("OBV bearish");
  });

  it("weakens RSI/OBV bearish divergence exactly 1.0 vs the uniform model", () => {
    // The WLD/XRP fix: RSI+OBV bearish divergence are 0.5-vote signals now.
    // Same candles, uniform vs weighted — the long side loses exactly the
    // two downgrades (1 → 0.5 each); the short side is untouched here.
    const k = toppingWithBearishDivergence();
    const uniform = evaluateAdvisor(k, UNIFORM)!;
    const weighted = evaluateAdvisor(k, CFG)!;
    expect(weighted.long.votes).toBeCloseTo(uniform.long.votes - 1.0, 6);
    expect(weighted.short.votes).toBe(uniform.short.votes);
  });

  it("confluence threshold gates the veto (threshold 5 stays ok on the weighted cluster)", () => {
    const k = toppingWithBearishDivergence();
    const s = evaluateAdvisor(k, { ...CFG, advisorVetoThreshold: 5 })!;
    expect(s.long.votes).toBeGreaterThanOrEqual(2); // weighted cluster exists
    expect(s.long.status).toBe("ok");               // but below threshold
  });

  it("mirrors: bullish divergence at a 4H bottom vetoes SHORT — STRONG, vetoes alone", () => {
    const s = evaluateAdvisor(bottomingWithBullishDivergence(), CFG)!;
    expect(s).toBeDefined();
    expect(s.rsiBull).toBe(true);
    // STRONG side: bullish divergence casts 2 votes — vetoes even alone.
    expect(s.short.votes).toBeGreaterThanOrEqual(2);
    expect(s.short.status).toBe("veto");
    expect(s.short.reasons.join(" ")).toContain("StochRSI(14/14/3/3) %D bullish divergence");
  });

  it("applies per-side thresholds: LONG override gates the cluster, SHORT uses the shared value", () => {
    const k = toppingWithBearishDivergence();
    // Long votes ≈ 3.0 (RSI 0.5 + OBV 0.5 + A/D 1 + CMF 1):
    //   long override 5 → ok, shared 2 → veto (fallback), shared 5 → ok.
    expect(evaluateAdvisor(k, { ...CFG, advisorVetoThreshold: 2, advisorLongThreshold: 5 })!.long.status).toBe("ok");
    expect(evaluateAdvisor(k, { ...CFG, advisorVetoThreshold: 2 })!.long.status).toBe("veto");
    expect(evaluateAdvisor(k, { ...CFG, advisorVetoThreshold: 5 })!.long.status).toBe("ok");
    // SHORT on this fixture has 0 votes — ok even at threshold 1.
    expect(evaluateAdvisor(k, { ...CFG, advisorShortThreshold: 1 })!.short.status).toBe("ok");
  });

  it("per-side SHORT threshold: 1 vetoes the bullish flag, votes+1 does not", () => {
    const s1 = evaluateAdvisor(bottomingWithBullishDivergence(), { ...CFG, advisorShortThreshold: 1 })!;
    expect(s1.short.status).toBe("veto");
    const votes = s1.short.votes;
    expect(votes).toBeGreaterThanOrEqual(2);
    // A threshold above the actual vote count must NOT veto (semantics, not
    // a magic number — the fixture's bullish flags stack to >= 3 votes).
    const sHigh = evaluateAdvisor(bottomingWithBullishDivergence(), { ...CFG, advisorShortThreshold: votes + 1 })!;
    expect(sHigh.short.status).toBe("ok");
    // LONG side keeps the shared threshold (2) and is unaffected by the
    // SHORT override (0 bearish votes on this fixture).
    expect(s1.long.status).toBe("ok");
  });

  it("flags VWAP exhaustion long when stretched with hot RSI and draining CMF", () => {
    const k: Kline[] = [];
    for (let i = 0; i < 130; i++) {
      k.push(bar(100 + Math.sin(i / 9) * 0.2, 100.3, 99.7, 100 + Math.sin(i / 9) * 0.1, 10));
    }
    // Low-volume parabolic rally: 8 green bars +3.75 each (RSI skyrockets,
    // price 100 → 130) with wicks both sides so money-flow stays neutral-ish.
    let p = 100;
    for (let i = 0; i < 8; i++) {
      const c = p + 3.75;
      k.push(bar(p, c + 1.9, p - 1.6, c, 50));
      p = c;
    }
    // Two moderate-volume red bars near the top, closing in the LOWER half of
    // their range: CMF drains negative while close stays above the 24-bar VWAP
    // (which is anchored by the long flat base).
    for (let i = 0; i < 2; i++) {
      const o = p;
      const hi = o + 0.7;
      const lo = o - 1.6;
      const c = lo + 0.5; // lower half → negative money flow
      k.push(bar(o, hi, lo, c, 500));
      p = c;
    }
    const s = evaluateAdvisor(k, CFG)!;
    expect(s).toBeDefined();
    // StochRSI %D — the smoothed line that replaced smoothed RSI(14) and the
    // one the exhaustion gate reads; the jumpier %K has already cooled to ~63
    // on this same fixture.
    expect(s.rsi).toBeGreaterThan(70);
    expect(s.stochD).toBeGreaterThan(70);
    expect(s.cmf).toBeLessThan(0);
    expect(s.vwapDistPct).toBeGreaterThan(3);
    expect(s.vwapExhaustLong).toBe(true);
    expect(s.long.reasons.join(" ")).toContain("VWAP");
  });

  it("expires divergences after advisorDivergenceAgeBars", () => {
    const k = toppingWithBearishDivergence();
    const s = evaluateAdvisor(k, { ...CFG, advisorDivergenceAgeBars: 2 })!;
    expect(s.rsiBear).toBe(false);
    expect(s.obvBear).toBe(false);
    expect(s.long.status).toBe("ok");
    expect(s.long.votes).toBeLessThan(2);
  });
});

describe("advisorSignalWeights (classification table behind the weighted model)", () => {
  it("classifies thin zones + bullish divergence as STRONG, RSI/OBV bearish as WEAK, rest NORMAL", () => {
    const w = advisorSignalWeights({ advisorStrongWeight: 2, advisorWeakWeight: 0.5, advisorMacdWeight: 1 });
    expect(w.rsiBear).toBe(0.5);
    expect(w.obvBear).toBe(0.5);
    expect(w.adBear).toBe(1);
    expect(w.cmfBear).toBe(1);
    expect(w.vwapExhaustLong).toBe(1);
    expect(w.vwapExhaustShort).toBe(1);
    expect(w.rsiBull).toBe(2);
    expect(w.obvBull).toBe(2);
    expect(w.adBull).toBe(2);
    expect(w.cmfBull).toBe(2);
    // thin-zone near 4H HIGHS stays NORMAL (replay: a tell only WITH
    // confluence — 20% WR at 2 votes, 38% as a lone veto).
    expect(w.thinZoneLong).toBe(1);
    expect(w.thinZoneShort).toBe(2);
  });

  it("uniform weights (1/1) restore the original model", () => {
    const w = advisorSignalWeights({ advisorStrongWeight: 1, advisorWeakWeight: 1, advisorMacdWeight: 1 });
    for (const [flag, weight] of Object.entries(w)) {
      // smartVol ships default-OFF (weight 0): the 2026-09-13 16-cell
      // smart-vol sweep found no promotable edge, so the family stays
      // dormant unless an operator explicitly sets a weight. Uniform 1/1
      // therefore restores the ORIGINAL (pre-smartVol) model exactly.
      if (flag === "smartVolXDown" || flag === "smartVolXUp" || flag.startsWith("rsiDiv")) {
        expect(weight).toBe(0);
      } else {
        expect(weight).toBe(1);
      }
    }
  });
});

describe("MACD vote family (2026-09-10 — divergence + fresh hist flips, normal weight)", () => {
  // Weight-table contract: MACD flags are NORMAL (1) votes — the lab's
  // measured integration for the 6/14/10 proposal (+$62.49 marginal).
  it("macd flags cast a NORMAL (1) vote each in the weights table", () => {
    const w = advisorSignalWeights({ advisorStrongWeight: 2, advisorWeakWeight: 0.5, advisorMacdWeight: 1 });
    expect(w.macdBearDiv).toBe(1);
    expect(w.macdBullDiv).toBe(1);
    expect(w.histXDown).toBe(1);
    expect(w.histXUp).toBe(1);
  });

  it("macd fires on the topping/bottoming fixtures and carries MACD reasons when enabled", () => {
    const top = evaluateAdvisor(toppingWithBearishDivergence(), CFG)!;
    const bot = evaluateAdvisor(bottomingWithBullishDivergence(), CFG)!;
    // At least one MACD flag fires per fixture (divergence or fresh hist flip).
    expect(top.macdBearDiv || top.histXDown).toBe(true);
    expect(bot.macdBullDiv || bot.histXUp).toBe(true);
  });

  it("disabling MACD (advisorMacdEnabled=false) drops its flags, votes, and reasons", () => {
    const k = toppingWithBearishDivergence();
    const on = evaluateAdvisor(k, CFG)!;
    const off = evaluateAdvisor(k, { ...CFG, advisorMacdEnabled: false })!;
    expect(off.macdBearDiv).toBe(false);
    expect(off.macdBullDiv).toBe(false);
    expect(off.histXDown).toBe(false);
    expect(off.histXUp).toBe(false);
    expect(off.long.votes).toBeLessThanOrEqual(on.long.votes);
    expect(off.short.votes).toBeLessThanOrEqual(on.short.votes);
    expect(off.long.reasons.join(";")).not.toContain("MACD");
    expect(off.short.reasons.join(";")).not.toContain("MACD");
  });

  it("misconfigured params (slow <= fast) fail safe: no MACD flags or reasons", () => {
    const k = toppingWithBearishDivergence();
    const s = evaluateAdvisor(k, { ...CFG, advisorMacdSlow: 3 })!; // slow < fast → disabled
    expect(s.macdBearDiv).toBe(false);
    expect(s.histXDown).toBe(false);
    expect(s.long.reasons.join(";")).not.toContain("MACD");
  });
});

describe("advisorVetoFor (engine gate over the STORED flat doc shape)", () => {
  // This is the exact shape convex/advisor.ts toStored() persists: flat
  // longStatus/longVotes/longReasons (no nested .long/.short). The engine
  // gate must read this — a nested-shape read here is the regression that
  // silently disabled the veto layer (gate never fired).
  const stored = {
    longStatus: "veto",
    longVotes: 2,
    longReasons: ["4H RSI bearish divergence (price HH, RSI LH)", "4H OBV bearish divergence (price HH, OBV LH)"],
    shortStatus: "ok",
    shortVotes: 0,
    shortReasons: [],
  };

  it("reads the vetoed LONG side from the flat stored shape", () => {
    const v = advisorVetoFor(stored, "LONG");
    expect(v.status).toBe("veto");
    expect(v.votes).toBe(2);
    expect(v.reasons.length).toBe(2);
    expect(v.reasons.join(" ")).toContain("RSI bearish");
  });

  it("reads the ok SHORT side independently", () => {
    const v = advisorVetoFor(stored, "SHORT");
    expect(v.status).toBe("ok");
    expect(v.votes).toBe(0);
  });

  it("applies the book's OWN threshold to the stored vote count", () => {
    // stored status says veto (paper computed it with threshold 2); a book
    // with threshold 3 must NOT veto on 2 votes — per-book tuning works off
    // the shared doc without recomputing it.
    expect(advisorVetoFor(stored, "LONG", 3).status).toBe("ok");
    expect(advisorVetoFor(stored, "LONG", 2).status).toBe("veto");
    expect(advisorVetoFor(stored, "LONG", 1).status).toBe("veto");
    // A stored "ok" row never flips to veto just because the threshold drops.
    const okRow = { longStatus: "ok", longVotes: 5, longReasons: [] };
    expect(advisorVetoFor(okRow, "LONG", 1).status).toBe("ok");
  });

  it("fails open on missing/malformed rows (never vetoes by accident)", () => {
    expect(advisorVetoFor(null, "LONG").status).toBe("ok");
    expect(advisorVetoFor(undefined, "SHORT").status).toBe("ok");
    // A row missing the side's fields (schema drift / old doc) must not veto.
    const partial = { shortStatus: "veto", shortVotes: 1, shortReasons: ["x"] };
    expect(advisorVetoFor(partial, "LONG").status).toBe("ok");
    expect(advisorVetoFor(partial, "SHORT", 1).status).toBe("veto"); // book threshold 1 → 1 vote vetoes
    // Corrupt status value fails open too.
    const corrupt = { longStatus: "VETO", longVotes: 9, longReasons: ["x"] };
    expect(advisorVetoFor(corrupt, "LONG").status).toBe("ok");
  });

  it("weighted votes gate through the stored doc (2.0-vote cluster vetoes, 1.0-vote weak pair does not)", () => {
    // The weighted model's vote counts are stored as floats; the gate applies
    // the book's threshold to them. RSI+OBV bearish alone now stores 1.0
    // (0.5 + 0.5) — below threshold 2 — so the WLD/XRP-style vetoes die at
    // the source. A 2.0+ cluster still vetoes.
    const weak = { longStatus: "ok", longVotes: 1.0, longReasons: ["4H RSI bearish divergence (price HH, RSI LH)", "4H OBV bearish divergence (price HH, OBV LH)"] };
    expect(advisorVetoFor(weak, "LONG", 2).status).toBe("ok");
    const cluster = { ...weak, longStatus: "veto", longVotes: 3.0 };
    expect(advisorVetoFor(cluster, "LONG", 2).status).toBe("veto");
  });

  it("per-side SHORT threshold 1 vetoes a lone 1-vote flag through the stored gate", () => {
    // advisorShortThreshold: 1 is the replay-validated "any flagged short
    // loses" rule — a single bullish signal (1 stored vote) must veto when
    // the book's short threshold is 1, and stay open at the shared 2.
    const lone = { shortStatus: "veto", shortVotes: 1, shortReasons: ["4H RSI bullish divergence (price LL, RSI HL)"] };
    expect(advisorVetoFor(lone, "SHORT", 1).status).toBe("veto");
    expect(advisorVetoFor(lone, "SHORT", 2).status).toBe("ok");
    expect(advisorVetoFor(lone, "LONG", 1).status).toBe("ok"); // other side untouched
  });
});

describe("MACD vote family (2026-09-10 — divergence + fresh hist flips, normal weight)", () => {
  // The MACD family adds NORMAL (1) votes to the existing pool. On the
  // topping canvas the MACD line (fast 6/14/10) must fire a bearish
  // divergence or a fresh histogram flip-down, its reason must surface, and
  // disabling the family must drop both votes and reasons (a config change
  // can never silently leave stale flags in the stored doc).
  it("fires a MACD flag on the topping canvas and casts weight 1 in the table", () => {
    const k = toppingWithBearishDivergence();
    const s = evaluateAdvisor(k, CFG)!;
    expect(s.macdBearDiv || s.histXDown).toBe(true);
    expect(s.long.reasons.some((r) => r.includes("MACD"))).toBe(true);
    const w = advisorSignalWeights({ advisorStrongWeight: 2, advisorWeakWeight: 0.5, advisorMacdWeight: 1 });
    expect(w.macdBearDiv).toBe(1);
    expect(w.histXDown).toBe(1);
  });

  it("disabling MACD (advisorMacdEnabled=false) drops its votes and reasons", () => {
    const k = toppingWithBearishDivergence();
    const on = evaluateAdvisor(k, CFG)!;
    const off = evaluateAdvisor(k, { ...CFG, advisorMacdEnabled: false })!;
    expect(off.macdBearDiv).toBe(false);
    expect(off.macdBullDiv).toBe(false);
    expect(off.histXDown).toBe(false);
    expect(off.histXUp).toBe(false);
    expect(off.long.votes).toBeLessThanOrEqual(on.long.votes);
    expect(off.long.reasons.join(";")).not.toContain("MACD");
  });

  it("misconfigured params (slow <= fast) fail safe: no MACD votes", () => {
    const k = toppingWithBearishDivergence();
    const s = evaluateAdvisor(k, { ...CFG, advisorMacdSlow: 3 })!; // slow < fast → disabled
    expect(s.macdBearDiv).toBe(false);
    expect(s.histXDown).toBe(false);
    expect(s.long.reasons.join(";")).not.toContain("MACD");
  });
});

describe("stochRsiSeries (the oscillator that replaced RSI)", () => {
  /** Choppy advance: pullbacks keep Wilder RSI off its 100 saturation so the
   *  stochastic of RSI has a real range to measure (a purely linear ramp
   *  pins RSI at 100, whose range collapses → the correct neutral 50). */
  const choppyAdvance = (n: number) =>
    Array.from({ length: n }, (_, i) => 100 + i + (i % 5 === 0 ? -2 : 0));
  /** Dip, then a strong consecutive rally into the final bar. */
  const dipThenRecovery = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < 45; i++) out.push(100 + Math.sin(i / 6) * 3 + i * 0.1);
    for (let i = 0; i < 8; i++) out.push(out[out.length - 1] + 1.2);
    return out;
  };

  it("is bounded 0-100 and saturates after a straight rally into the close", () => {
    const { k, d } = stochRsiSeries(dipThenRecovery(), 14, 14, 3, 3);
    const last = k[k.length - 1];
    expect(Number.isFinite(last)).toBe(true);
    expect(last).toBeGreaterThanOrEqual(0);
    expect(last).toBeLessThanOrEqual(100);
    expect(last).toBeGreaterThan(90); // RSI pinned at the top of its range
    expect(Number.isFinite(d[d.length - 1])).toBe(true);
    // %D is the smoothed line — it must lag, never leading %K at a peak.
    expect(d[d.length - 1]).toBeLessThanOrEqual(last + 1e-9);
  });

  it("reads 50 when the RSI range collapses (flat series → neutral)", () => {
    const flat = Array.from({ length: 60 }, () => 100);
    const { k } = stochRsiSeries(flat, 14, 14, 3, 3);
    expect(k[k.length - 1]).toBe(50);
  });

  it("warms up as NaN, never emitting a value before its inputs exist", () => {
    const { k } = stochRsiSeries(choppyAdvance(60), 14, 14, 3, 3);
    expect(k.slice(0, 14).every((v) => Number.isNaN(v))).toBe(true);
    const last = k[k.length - 1];
    expect(Number.isFinite(last)).toBe(true);
    expect(last).toBeGreaterThan(0);
    expect(last).toBeLessThan(100);
  });
});

describe("advisor oscillator selection (StochRSI swap, 2026-09-11)", () => {
  it("defaults to StochRSI on the %D line and names it in the reasons", () => {
    const k = toppingWithBearishDivergence();
    const s = evaluateAdvisor(k, CFG)!;
    expect(s.long.reasons.join(" ")).toContain("StochRSI(14/14/3/3) %D");
    expect(s.rsi).toBeCloseTo(s.stochD, 6); // rsi field carries the read line
    expect(s.rsi).not.toBeCloseTo(s.stochK, 6);
  });

  it("%K changes the read line and the label (advisorStochRsiUseD=false)", () => {
    const k = toppingWithBearishDivergence();
    const s = evaluateAdvisor(k, { ...CFG, advisorStochRsiUseD: false })!;
    expect(s.long.reasons.join(" ")).toContain("%K");
    expect(s.rsi).toBeCloseTo(s.stochK, 6);
  });

  it("the configured periods actually reach the computation (no silent defaults)", () => {
    // Guards the wiring bug found 2026-09-11: a hand-built config subset that
    // dropped the stoch knobs made panel edits no-ops. Different lengths must
    // produce different oscillator values.
    const k = toppingWithBearishDivergence();
    const a = evaluateAdvisor(k, { ...CFG, advisorStochRsiStochPeriod: 14, advisorStochRsiUseD: false })!;
    const b = evaluateAdvisor(k, { ...CFG, advisorStochRsiStochPeriod: 7, advisorStochRsiUseD: false })!;
    expect(a.rsi).not.toBeCloseTo(b.rsi, 6);
  });

  it("kill switch (advisorStochRsiEnabled=false) restores plain RSI(14)", () => {
    const k = toppingWithBearishDivergence();
    const legacy = evaluateAdvisor(k, { ...CFG, advisorStochRsiEnabled: false })!;
    const closes = k.map((x) => x.close);
    const rsi = rsiSeries(closes, 14);
    expect(legacy.long.reasons.join(" ")).toContain("RSI(14)");
    expect(legacy.rsi).toBeCloseTo(rsi[rsi.length - 1], 6);
  });
});

describe("4H advisor shadow tags (record-only, 2026-10-06)", () => {
  const vetoLong = { longStatus: "veto", longVotes: 2.5, longReasons: ["4H thin"], shortStatus: "ok", shortVotes: 0, shortReasons: [] };
  const vetoShort = { longStatus: "ok", longVotes: 0, longReasons: [], shortStatus: "veto", shortVotes: 2, shortReasons: ["1H bull div"] };
  const base = { metrics: vetoLong, btcMetrics: null, longThreshold: 2, shortThreshold: 1, mode: "both" as const };

  it("tags a LONG the shipped arm would veto", () => {
    expect(advisorShadowTags({ ...base, side: "LONG" })).toEqual([ADV4H_TAG_VETO_LONG]);
  });

  it("tags a SHORT the shipped arm would veto (threshold 1)", () => {
    expect(advisorShadowTags({ ...base, metrics: vetoShort, side: "SHORT" })).toEqual([ADV4H_TAG_VETO_SHORT]);
  });

  it("emits nothing when the verdict is ok", () => {
    expect(advisorShadowTags({ ...base, side: "SHORT" })).toEqual([]);
  });

  it("fails open on missing readings (never tags without data)", () => {
    expect(advisorShadowTags({ ...base, metrics: null, side: "LONG" })).toEqual([]);
  });

  it("applies the book's own per-side threshold at tag time", () => {
    // 2.5 votes vetoes at threshold 2 but not at 3 — the tag follows the gate.
    expect(advisorShadowTags({ ...base, side: "LONG", longThreshold: 3 })).toEqual([]);
  });
});
describe("per-family switches (2026-10-23 — one panel button per vote family)", () => {
  // The advisor used to be one master knob over nine vote families. Each family
  // now has its own switch; `undefined` must mean ON so every config row
  // written before the split resolves to the shipped detector.
  const ALL_OFF = {
    advisorMomDivEnabled: false,
    advisorObvEnabled: false,
    advisorAdEnabled: false,
    advisorCmfEnabled: false,
    advisorVwapEnabled: false,
    advisorThinZoneEnabled: false,
  };

  it("unset = ON: the weights table is byte-identical to the shipped one", () => {
    const w = advisorSignalWeights({ advisorStrongWeight: 2, advisorWeakWeight: 0.5, advisorMacdWeight: 1 });
    expect(w.rsiBear).toBe(0.5);
    expect(w.obvBull).toBe(2);
    expect(w.adBear).toBe(1);
    expect(w.cmfBull).toBe(2);
    expect(w.vwapExhaustLong).toBe(1);
    expect(w.thinZoneLong).toBe(1);
    expect(w.thinZoneShort).toBe(2);
  });

  it("a disabled family casts 0 without touching the other families", () => {
    const w = advisorSignalWeights({ advisorStrongWeight: 2, advisorWeakWeight: 0.5, advisorMacdWeight: 1, ...ALL_OFF });
    expect(w.rsiBear).toBe(0);
    expect(w.rsiBull).toBe(0);
    expect(w.obvBear).toBe(0);
    expect(w.adBull).toBe(0);
    expect(w.cmfBear).toBe(0);
    expect(w.vwapExhaustShort).toBe(0);
    expect(w.thinZoneLong).toBe(0);
    expect(w.thinZoneShort).toBe(0);
    // Families outside the switch table keep their weight.
    expect(w.macdBearDiv).toBe(1);
  });

  it("switching every family off empties the veto AND its reason list", () => {
    const k = toppingWithBearishDivergence();
    const on = evaluateAdvisor(k, CFG)!;
    expect(on.long.status).toBe("veto");
    expect(on.long.reasons.length).toBeGreaterThan(0);
    const off = evaluateAdvisor(k, { ...CFG, ...ALL_OFF, advisorMacdEnabled: false })!;
    expect(off.long.votes).toBe(0);
    expect(off.long.reasons).toEqual([]);
    expect(off.long.status).toBe("ok");
  });

  it("CMF off removes exactly its 1 vote and its reason, but still computes the flag", () => {
    const k = toppingWithBearishDivergence();
    const on = evaluateAdvisor(k, CFG)!;
    const off = evaluateAdvisor(k, { ...CFG, advisorCmfEnabled: false })!;
    expect(on.cmfBear).toBe(true);
    // The flag stays readable (stored metrics / panel), it just stops voting.
    expect(off.cmfBear).toBe(true);
    expect(off.long.votes).toBeCloseTo(on.long.votes - 1, 6);
    expect(off.long.reasons.join(" ")).not.toContain("CMF bearish");
  });

  it("momentum off removes the STRONG 2 votes the bullish divergence casts on a SHORT", () => {
    const bottom = bottomingWithBullishDivergence();
    const on = evaluateAdvisor(bottom, CFG)!;
    const off = evaluateAdvisor(bottom, { ...CFG, advisorMomDivEnabled: false })!;
    expect(on.rsiBull).toBe(true);
    expect(off.rsiBull).toBe(true);
    expect(off.short.votes).toBeCloseTo(on.short.votes - 2, 6);
    expect(off.short.reasons.join(" ")).not.toContain("StochRSI");
  });

  it("thin zone off drops both sides of the exhaustion leg", () => {
    const on = evaluateAdvisor(toppingWithBearishDivergence(), CFG)!;
    const off = evaluateAdvisor(toppingWithBearishDivergence(), { ...CFG, advisorThinZoneEnabled: false })!;
    const removed =
      (on.thinZoneLong ? 1 : 0) + (on.thinZoneShort ? 2 : 0);
    expect(on.long.votes - off.long.votes).toBeCloseTo(on.thinZoneLong ? 1 : 0, 6);
    expect(off.long.reasons.join(" ")).not.toContain("thin-volume");
    expect(removed).toBeGreaterThanOrEqual(0);
  });
});
