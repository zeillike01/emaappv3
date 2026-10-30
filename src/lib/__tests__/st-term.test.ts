/**
 * SUPERTREND SCORE TERM (lab-only 2026-10-11). Pins the experiment contract:
 * default-off (bit-identical scoring without ohl), zeros-component shape,
 * and the bonus/penalty/symmetric arithmetic + the noEmaTerm kill switch.
 */
import { describe, expect, it } from "vitest";
import { computeLayer2Signal, DEFAULT_CONFIG } from "../layer2-signal";

const N = 120;
const closes = Array.from({ length: N }, (_, i) => 100 + i * 0.2); // steady uptrend
const high = closes.map((c) => c * 1.001);
const low = closes.map((c) => c * 0.999);

function sig(cfg: any, ohl?: { high: number[]; low: number[] }) {
  return computeLayer2Signal(closes, 0.2, 0.3, 0.0001, 0.2, 0.8, 0.3, 0.02, 5_000_000, cfg, ohl);
}

describe("SuperTrend score term", () => {
  it("is bit-identical to default scoring when off (no ohl)", () => {
    const a = sig(DEFAULT_CONFIG);
    const b = sig({ ...DEFAULT_CONFIG, stMode: "bonus", stWeight: 8 });
    expect(b.longScore).toBe(a.longScore);
    expect(b.shortScore).toBe(a.shortScore);
    const st = b.components.find((c) => c.k === "st")!;
    expect(st.long).toBe(0);
    expect(st.short).toBe(0);
    expect(st.v).toBeNull();
  });

  it("credits the agreeing side in bonus mode on a steady uptrend", () => {
    const s = sig({ ...DEFAULT_CONFIG, stMode: "bonus", stWeight: 8 }, { high, low });
    const st = s.components.find((c) => c.k === "st")!;
    expect(st.v).toBe(1); // recovery trend up on a steady climb
    expect(st.long).toBe(8);
    expect(st.short).toBe(0);
    const base = sig(DEFAULT_CONFIG);
    expect(s.longScore - base.longScore).toBe(8);
    expect(s.shortScore).toBe(base.shortScore);
  });

  it("charges the disagreeing side in penalty mode", () => {
    const s = sig({ ...DEFAULT_CONFIG, stMode: "penalty", stWeight: 8 }, { high, low });
    const st = s.components.find((c) => c.k === "st")!;
    expect(st.long).toBe(0);
    expect(st.short).toBe(-8);
  });

  it("splits half-weight both ways in symmetric mode", () => {
    const s = sig({ ...DEFAULT_CONFIG, stMode: "symmetric", stWeight: 8 }, { high, low });
    const st = s.components.find((c) => c.k === "st")!;
    expect(st.long).toBe(4);
    expect(st.short).toBe(-4);
  });

  it("noEmaTerm removes exactly the cross-term and keeps attribution additive", () => {
    const base = sig(DEFAULT_CONFIG);
    const s = sig({ ...DEFAULT_CONFIG, noEmaTerm: true });
    const ema = s.components.find((c) => c.k === "ema")!;
    expect(ema.long).toBe(0);
    expect(ema.short).toBe(0);
    // uptrend fixture: ema term was +16 long / -10 short
    expect(base.longScore - s.longScore).toBe(16);
    expect(base.shortScore - s.shortScore).toBe(-10);
    const longSum = s.components.reduce((a, c) => a + c.long, 0);
    expect(longSum).toBeCloseTo(s.longScore, 6);
  });
});

describe("stVeto gate", () => {
  // Downtrend fixture: closes falling; ST recovery trend should read down.
  const dn = Array.from({ length: N }, (_, i) => 100 - i * 0.2);
  const dnH = dn.map((c) => c * 1.001);
  const dnL = dn.map((c) => c * 0.999);
  const ohl = { high, low }; // uptrend arrays from above
  const ohlDn = { high: dnH, low: dnL };
  function sigDn(cfg: any) {
    return computeLayer2Signal(dn, -0.2, -0.3, 0.0001, 0.2, 0.8, 0.3, 0.02, 5_000_000, cfg, ohlDn);
  }
  it("measures the trend into the component even with everything off", () => {
    const s = sigDn(DEFAULT_CONFIG);
    const st = s.components.find((c) => c.k === "st")!;
    expect(st.v).toBe(-1);
    expect(st.long).toBe(0);
    expect(st.short).toBe(0);
    expect(s.stVetoBlocked).toBe(false);
  });
  it("is inert without the ohl read (fail-off)", () => {
    const s = computeLayer2Signal(dn, -0.2, -0.3, 0.0001, 0.2, 0.8, 0.3, 0.02, 5_000_000, {
      ...DEFAULT_CONFIG, stVeto: "on",
    });
    expect(s.stVetoBlocked).toBe(false);
  });
  it("blocks a side taken against the ST trend and reports its cause", () => {
    // Long climb then a 6-bar -0.4% dump: EMA7/30 still up (LONG offered)
    // but the recovery ST has flipped down — the exact conflict the veto
    // exists for. Deterministic: LONG offered with stVeto off.
    const c: number[] = [];
    for (let i = 0; i < 100; i++) c.push(100 + i * 0.3);
    for (let i = 0; i < 6; i++) c.push(c[c.length - 1]! * 0.996);
    const hh = c.map((x) => x * 1.001);
    const ll = c.map((x) => x * 0.999);
    const args = [c, 0.5, 0.5, 0.0001, 0.2, 0.8, 0.3, 0.02, 5_000_000] as const;
    const off = computeLayer2Signal(...args, DEFAULT_CONFIG, { high: hh, low: ll });
    expect(off.side).toBe("LONG");
    expect(off.components.find((k) => k.k === "st")!.v).toBe(-1);
    const on = computeLayer2Signal(...args, { ...DEFAULT_CONFIG, stVeto: "on" }, { high: hh, low: ll });
    expect(on.side).toBeNull();
    expect(on.stVetoBlocked).toBe(true);
    expect(on.reasons.join(" ")).toContain("ST-disagreement");
    // Scores untouched — a veto, not a term.
    expect(on.longScore).toBe(off.longScore);
    expect(on.shortScore).toBe(off.shortScore);
    // Shadow mode tags the same trade without touching it.
    const sh = computeLayer2Signal(...args, { ...DEFAULT_CONFIG, stVeto: "shadow" }, { high: hh, low: ll });
    expect(sh.side).toBe("LONG");
    expect(sh.stVetoBlocked).toBe(false);
    expect(sh.stShadowHit).toBe(true);
    expect(sh.reasons.join(" ")).toContain("shadow");
  });

  it("never touches an agreeing side", () => {
    const s = sig({ ...DEFAULT_CONFIG, stVeto: "on" }, ohl);
    const st = s.components.find((c) => c.k === "st")!;
    if (s.side === "LONG" && st.v === 1) expect(s.stVetoBlocked).toBe(false);
    if (s.side === "SHORT" && st.v === -1) expect(s.stVetoBlocked).toBe(false);
  });
});
