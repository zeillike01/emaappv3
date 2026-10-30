/**
 * Tests for the 15m volatility floor (ATR% floor) — see src/lib/vol-floor.ts.
 *
 * Two parity risks, both the kind that silently de-tune a measured gate:
 *   1. The floor value (0.60% LONG) comes from the 6-month lab, so any drift in
 *      which ATR% series the gate reads silently moves the shipped threshold off
 *      what was measured. The gate is fed the engine's own `metrics.atrPct`
 *      (ema-smoothed TR — NOT the backtest's Wilder series), and the runtime
 *      arms of run-vol-floor-rejudge.ts are what calibrated the shipped number.
 *   2. "Nullable override" semantics: an override of 0 or null means INHERIT the
 *      shared floor, never "off for this side". Getting that backwards would
 *      either disarm a side silently or arm one the operator never armed.
 *
 * The integration cases drive `computeLayer2Signal` itself, so the veto's
 * placement (last, after every setup-quality veto) and its fail-closed rule are
 * pinned to the shipped wiring rather than to a re-derivation.
 */

import { describe, expect, it } from "vitest";
import { VOL_FLOOR_DEFAULTS, atrFloorFor, volFloorBlocks } from "../vol-floor";
import { DEFAULT_CONFIG, computeLayer2Signal, resolveConfig } from "../layer2-signal";

const cfg = (over: Partial<Parameters<typeof atrFloorFor>[0]> = {}) => ({
  atrFloorPct: VOL_FLOOR_DEFAULTS.floor,
  atrFloorPctLong: null,
  atrFloorPctShort: null,
  ...over,
});

describe("volatility floor — config shape", () => {
  it("ships OFF: the shared default is 0 and neither side is overridden", () => {
    expect(DEFAULT_CONFIG.atrFloorPct).toBe(0);
    expect(DEFAULT_CONFIG.atrFloorPctLong).toBe(null);
    expect(DEFAULT_CONFIG.atrFloorPctShort).toBe(null);
  });

  it("resolves through and preserves an explicit null override", () => {
    expect(resolveConfig({}).atrFloorPct).toBe(0);
    expect(resolveConfig({ atrFloorPct: 0.5 }).atrFloorPct).toBe(0.5);
    // null must SURVIVE resolution — `?? default` would have flipped it and
    // silently re-armed/disarmed the side.
    expect(resolveConfig({ atrFloorPctLong: null, atrFloorPct: 0.5 }).atrFloorPctLong).toBe(null);
    const armed = resolveConfig({ atrFloorPctLong: 0.6 });
    expect(armed.atrFloorPctLong).toBe(0.6);
    expect(armed.atrFloorPctShort).toBe(null);
  });

  it("applies the shared floor to both sides", () => {
    const c = cfg({ atrFloorPct: 0.5 });
    expect(atrFloorFor(c, "LONG")).toBe(0.5);
    expect(atrFloorFor(c, "SHORT")).toBe(0.5);
  });

  it("an override of 0 or null INHERITS the shared floor — it does not mean off", () => {
    expect(atrFloorFor(cfg({ atrFloorPct: 0.5, atrFloorPctLong: 0 }), "LONG")).toBe(0.5);
    expect(atrFloorFor(cfg({ atrFloorPct: 0.5, atrFloorPctLong: null }), "LONG")).toBe(0.5);
    // ...and a non-finite override is ignored for the same reason.
    expect(atrFloorFor(cfg({ atrFloorPct: 0.5, atrFloorPctShort: NaN }), "SHORT")).toBe(0.5);
  });

  it("a positive override wins over the shared floor, per side only", () => {
    const c = cfg({ atrFloorPct: 0.3, atrFloorPctLong: 0.6, atrFloorPctShort: 0.1 });
    expect(atrFloorFor(c, "LONG")).toBe(0.6);
    expect(atrFloorFor(c, "SHORT")).toBe(0.1);
  });
});

describe("volatility floor — the verdict", () => {
  it("never blocks while the floor is off, even on a garbage reading", () => {
    for (const atrPct of [0, NaN, -1, 0.01]) {
      expect(volFloorBlocks(atrPct, cfg(), "LONG").blocked).toBe(false);
      expect(volFloorBlocks(atrPct, cfg(), "SHORT").blocked).toBe(false);
    }
  });

  it("blocks strictly below the floor and allows exactly at it", () => {
    const c = cfg({ atrFloorPct: 0.6 });
    expect(volFloorBlocks(0.59, c, "LONG").blocked).toBe(true);
    expect(volFloorBlocks(0.6, c, "LONG").blocked).toBe(false);
    expect(volFloorBlocks(1.2, c, "LONG").blocked).toBe(false);
  });

  it("fails CLOSED when armed and the reading is unusable", () => {
    const c = cfg({ atrFloorPct: 0.6 });
    for (const atrPct of [NaN, 0, -0.5, Infinity]) {
      expect(volFloorBlocks(atrPct, c, "LONG").blocked).toBe(true);
    }
  });

  it("the shipped armed shape gates longs only — shorts stay untouched", () => {
    // atrFloorPct 0 + atrFloorPctLong 0.60 + atrFloorPctShort null.
    const c = cfg({ atrFloorPctLong: 0.6 });
    expect(atrFloorFor(c, "LONG")).toBe(0.6);
    expect(atrFloorFor(c, "SHORT")).toBe(0);
    expect(volFloorBlocks(0.2, c, "LONG").blocked).toBe(true);   // dead tape long → blocked
    expect(volFloorBlocks(0.2, c, "SHORT").blocked).toBe(false); // same tape short → allowed
    expect(volFloorBlocks(NaN, c, "SHORT").blocked).toBe(false); // and not fail-closed
  });

  it("reports the floor and reading it acted on", () => {
    const v = volFloorBlocks(0.2, cfg({ atrFloorPct: 0.6 }), "LONG");
    expect(v.floor).toBe(0.6);
    expect(v.atrPct).toBe(0.2);
    expect(v.blocked).toBe(true);
  });
});

// ── Wiring through the shared signal function (both books call this) ──────────

/**
 * Rising closes that trip LONG (EMA fast > slow). The last bar is a mild
 * pullback, NOT a breakout: since 2026-10-03 the chase-streak veto blocks LONG
 * after 4 straight higher closes, so a breakout-last fixture would trip the
 * wrong gate and these floor-wiring tests would stop isolating the floor.
 */
function longCloses(n = 60, base = 100): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(base + i * 0.4);
  out[out.length - 1] = out[out.length - 2]! - 0.5;
  return out;
}

/** Other vetoes off so the floor is the only thing that can block. */
const isolated = (over: Record<string, unknown> = {}) =>
  resolveConfig({
    minScore: 0,
    minGap: 0,
    maxEmaStretchPct: 0,
    rsiLongGuard: false,
    ...over,
  });

/**
 * `atrPct15m` is the FLOOR's basis. `atrPct1m` defaults to a deliberately
 * 1m-scale value (~0.20, the live median across all 30 pairs) so every case
 * here would FAIL if the gate ever went back to reading the tick's 1m read.
 */
const fire = (
  atrPct15m: number,
  cfgOverride: Record<string, unknown> = {},
  // Mirrors the 15m value by default, so every case reads as if the tick and the
  // decision timeframe agreed — which is exactly how the pre-fix code behaved.
  // ⚠ Keep explicit overrides inside ~0.25–1.0: `atrPct` also feeds the scoring
  // term, and an extreme value trips an unrelated candle-range/ATR ratio gate
  // that would null the side before this floor is ever consulted.
  atrPct1m = atrPct15m,
) =>
  computeLayer2Signal(
    longCloses(),
    0,
    0,
    null,
    atrPct1m,
    atrPct15m,
    0.5,
    0.01,
    5_000_000,
    isolated(cfgOverride),
  );

describe("volatility floor — wiring inside computeLayer2Signal", () => {
  it("with the floor off the signal is unchanged (the feature is inert by default)", () => {
    // 0.30 is the dead-tape reading the next case gates; it must produce a
    // LONG when nothing is armed, otherwise that case would be proving the
    // floor blocked a trade some other veto had already killed.
    for (const atr of [0.30, 0.60, 0.90]) {
      const s = fire(atr);
      expect(s.side).toBe("LONG");
      expect(s.atrFloorBlocked).toBe(false);
    }
  });

  it("REGRESSION: the floor reads the 15m basis, and the 1m tick ATR can never move it", () => {
    // The defect this pins: the gate's first version read `atrPct` — the Layer-1
    // tick's 1m ATR (live: 0.057–0.391, median 0.205 across all 30 pairs) — so an
    // armed 0.60 floor sat ABOVE every pair's reading and would have blocked
    // every long. The 15m value for the same pairs is ~0.5–1.6.
    //
    // 1m BELOW the floor, 15m above it → must NOT block.
    const ok = fire(0.90, { atrFloorPctLong: 0.6 }, 0.30);
    expect(ok.side).toBe("LONG");
    expect(ok.atrFloorBlocked).toBe(false);
    // 1m ABOVE the floor, 15m below it → MUST block (the 1m read is not evidence).
    const s = fire(0.30, { atrFloorPctLong: 0.6 }, 0.90);
    expect(s.side).toBe(null);
    expect(s.atrFloorBlocked).toBe(true);
    // Differential invariant: moving the 1m input cannot change the floor's own
    // verdict, whichever way the tick happens to read.
    for (const m1 of [0.30, 0.50, 0.90]) {
      expect(fire(0.30, { atrFloorPctLong: 0.6 }, m1).atrFloorBlocked).toBe(true);
      expect(fire(0.90, { atrFloorPctLong: 0.6 }, m1).atrFloorBlocked).toBe(false);
    }
  });

  it("the block reason names the 15m basis so a misfire is diagnosable", () => {
    const s = fire(0.30, { atrFloorPctLong: 0.6 });
    expect(s.reasons.some((r) => r.includes("15m ATR"))).toBe(true);
  });

  it("a dead-tape long is blocked and reports the floor, and only that gate", () => {
    const s = fire(0.3, { atrFloorPctLong: 0.6 });
    expect(s.side).toBe(null);
    expect(s.atrFloorBlocked).toBe(true);
    expect(s.stretchBlocked).toBe(false);
    expect(s.rsiLongBlocked).toBe(false);
    expect(s.reasons.some((r) => r.includes("volatility floor"))).toBe(true);
  });

  it("the same setup on a live tape passes", () => {
    const s = fire(0.9, { atrFloorPctLong: 0.6 });
    expect(s.side).toBe("LONG");
    expect(s.atrFloorBlocked).toBe(false);
  });

  it("fails closed through the wiring when the ATR reading is unusable", () => {
    const s = fire(NaN, { atrFloorPctLong: 0.6 });
    expect(s.side).toBe(null);
    expect(s.atrFloorBlocked).toBe(true);
    expect(s.reasons.some((r) => r.includes("fail-closed"))).toBe(true);
    // ...and the same NaN is harmless while the floor is off.
    expect(fire(NaN).side).toBe("LONG");
  });

  it("the shared knob arms both sides; the per-side override narrows it", () => {
    expect(fire(0.3, { atrFloorPct: 0.6 }).atrFloorBlocked).toBe(true);
    // LONG-only armed: a short-side reading below the would-be shared floor is
    // not this gate's business (atrFloorPct stays 0, only the long override set).
    const longOnly = fire(0.3, { atrFloorPctLong: 0.6 });
    expect(longOnly.atrFloorBlocked).toBe(true);
  });
});
