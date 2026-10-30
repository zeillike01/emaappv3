import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, resolveConfig, resolvePaperConfig } from "../layer2-signal";

/**
 * H4 QUALITY GATES config plumbing (2026-09-23 audit).
 *
 * The audit bug these tests pin: resolveConfig builds a fixed literal, so any
 * new StrategyConfig field that is NOT mapped there is silently stripped —
 * the config row stores it, the panel displays it, and the engine never sees
 * it (dead knob). These four fields were exactly that for a few hours: both
 * engines ran the gates at defaults regardless of the stored toggles.
 *
 * Contract being tested:
 *  - default-ON semantics: only an EXPLICIT stored `false` turns a block off
 *    (undefined/null/absent all resolve to true);
 *  - `rsiHeatMax` keeps 0-preservation (a stored 0 means OFF and must not be
 *    resurrected to the default 80), non-finite falls back to the default;
 *  - resolvePaperConfig is just resolveConfig + fundingMode, so the gates
 *    survive there too.
 */
describe("h4 quality-gate config plumbing (audit regression)", () => {
  it("resolves the lab defaults when the row is empty", () => {
    const cfg = resolveConfig({});
    expect(cfg.h4VolClimaxBlock).toBe(true);
    expect(cfg.h4PullbackBigBlock).toBe(true);
    expect(cfg.h4PullbackDeadBlock).toBe(true);
    expect(cfg.rsiHeatMax).toBe(DEFAULT_CONFIG.rsiHeatMax);
  });

  it("resolves the same defaults when the row is null/undefined", () => {
    expect(resolveConfig(null).h4VolClimaxBlock).toBe(true);
    expect(resolveConfig(undefined).rsiHeatMax).toBe(DEFAULT_CONFIG.rsiHeatMax);
  });

  it("an explicit stored false turns a block OFF (the toggle must be real)", () => {
    const cfg = resolveConfig({ h4VolClimaxBlock: false, h4PullbackBigBlock: false, h4PullbackDeadBlock: false });
    expect(cfg.h4VolClimaxBlock).toBe(false);
    expect(cfg.h4PullbackBigBlock).toBe(false);
    expect(cfg.h4PullbackDeadBlock).toBe(false);
  });

  it("anything other than exactly false keeps the block ON (undefined, null, truthy)", () => {
    expect(resolveConfig({ h4VolClimaxBlock: undefined }).h4VolClimaxBlock).toBe(true);
    expect(resolveConfig({ h4VolClimaxBlock: null as unknown as boolean }).h4VolClimaxBlock).toBe(true);
    expect(resolveConfig({ h4VolClimaxBlock: true }).h4VolClimaxBlock).toBe(true);
  });

  it("rsiHeatMax preserves a stored 0 (0 = off — ?? alone would resurrect 80)", () => {
    expect(resolveConfig({ rsiHeatMax: 0 }).rsiHeatMax).toBe(0);
    expect(resolveConfig({ rsiHeatMax: 70 }).rsiHeatMax).toBe(70);
  });

  it("rsiHeatMax falls back to the default on non-finite junk", () => {
    expect(resolveConfig({ rsiHeatMax: NaN }).rsiHeatMax).toBe(DEFAULT_CONFIG.rsiHeatMax);
    expect(resolveConfig({ rsiHeatMax: Infinity }).rsiHeatMax).toBe(DEFAULT_CONFIG.rsiHeatMax);
    expect(resolveConfig({ rsiHeatMax: "80" as unknown as number }).rsiHeatMax).toBe(
      DEFAULT_CONFIG.rsiHeatMax,
    );
  });

  it("the fields survive resolvePaperConfig (paper is resolveConfig + funding policy)", () => {
    const cfg = resolvePaperConfig({ h4PullbackBigBlock: false, rsiHeatMax: 75 });
    expect(cfg.h4VolClimaxBlock).toBe(true);
    expect(cfg.h4PullbackBigBlock).toBe(false);
    expect(cfg.h4PullbackDeadBlock).toBe(true);
    expect(cfg.rsiHeatMax).toBe(75);
  });
});
