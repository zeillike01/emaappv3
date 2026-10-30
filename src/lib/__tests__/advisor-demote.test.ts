import { describe, expect, it } from "vitest";

import { DEFAULT_CONFIG, resolveConfig, resolvePaperConfig } from "../layer2-signal";

/**
 * 4H ADVISOR DEMOTE (2026-10-06, ADVISOR_REPRICE_JOURNAL §3).
 *
 * The 6-month reprice deleted +104R of winners at paired-day t=−0.62, so the
 * veto layer is TAG-ONLY by default: a fresh/unset row must never enforce.
 * The vote knobs are unchanged (they still shape the adv4h-* shadow tags),
 * and an explicit stored `true` still re-arms (panel opt-in).
 */
describe("4H advisor demote", () => {
  it("defaults tag-only (fresh rows never enforce)", () => {
    expect(DEFAULT_CONFIG.advisorEnabled).toBe(false);
    expect(resolveConfig({}).advisorEnabled).toBe(false);
    expect(resolveConfig(null).advisorEnabled).toBe(false);
    expect(resolvePaperConfig({}).advisorEnabled).toBe(false);
  });

  it("explicit stored true still re-arms (panel opt-in survives)", () => {
    expect(resolveConfig({ advisorEnabled: true }).advisorEnabled).toBe(true);
  });

  it("vote knobs are untouched by the demote (tags keep their shape)", () => {
    // Fresh-row contract (pre-existing): unset sides sync to the shared knob
    // (2/2) — the shipped L2/S1 split lives in the stored rows' explicit
    // per-side values, which this change does not touch.
    const cfg = resolveConfig({});
    expect(cfg.advisorMode).toBe("both");
    expect(cfg.advisorLongThreshold).toBe(2);
    expect(cfg.advisorShortThreshold).toBe(2);
    expect(resolveConfig({ advisorShortThreshold: 1 }).advisorShortThreshold).toBe(1);
  });
});
