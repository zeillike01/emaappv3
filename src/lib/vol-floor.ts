/**
 * 15m VOLATILITY FLOOR (ATR% floor) — PURE module. Ships OFF by default.
 *
 * WHY (2026-09-27, user decision: "better to have fewer trades that have
 * quality"). The book was buying dead tape and paying a full 1R for it. Two
 * independent measurements, same conclusion from different directions:
 *
 *   · `run-stop-width-sweep.ts` — split the 6-month anchor book at its own
 *     median entry ATR%: the CALM half (median entry ATR 0.45%) is
 *     net-NEGATIVE at every stop width from 0.75% to 3.0% (−242R … −43R),
 *     while the volatile half carries the entire edge (+127.5R at the
 *     shipped 1.5% stop). The stop is not the variable — the sweep also
 *     showed the stop-out SHARE is flat at ~59% across every width.
 *   · `run-vol-floor-rejudge.ts` — the floor grid, re-judged. Floor 0.60%
 *     globally: net +117.1R vs the +84.9R anchor, maxDD 216.0R → 85.8R,
 *     compounded ×1.71 → ×2.74, on 1,569 of 3,212 trades. Restricted to
 *     LONGS it is strictly better — LONG 0.65%: **+136.2R, maxDD 185.2R,
 *     compounded ×3.03**, removing 693 longs worth −56.2R (−0.081 R/t, 58%
 *     of them stops) — while every SHORT-side floor removes trades that were
 *     MAKING money (+16.2R at 0.60). Hence: per-side, longs only.
 *
 * HONEST STATE — ARMED 2026-09-27 ON PAPER *AND* LIVE at the operator's
 * direction, NOT because it cleared the promotion bar. It does not: no arm
 * reaches |t| ≥ 2 on either the per-trade or the net-R/day paired statistic
 * (best LONG 0.65: +0.279 R/day, t = 0.82). The reason it is armed anyway is
 * that the previous REJECTION was read off a statistic a gate cannot move —
 * the 2026-09-21 verdict quotes "best arm t ≈ 0" for a floor that made
 * +32.2R and halved drawdown, and on re-run that statistic reads −0.000
 * while the money statistic reads +0.175 R/day. So this is an UNCERTIFIED
 * POSITIVE, armed deliberately for a forward test with a week of journaling.
 * Two cautions stand against it: the optimum sits one step from collapse
 * (LONG 0.75% → −36R), and ATR% is correlated with trend, so part of the
 * effect may be a regime bet on a trending window.
 *
 * SEMANTICS (mirrors src/lib/chop-gate.ts, the sibling per-side floor):
 *   · `atrFloorPct`        shared floor, 0/null/negative = OFF (allow all)
 *   · `atrFloorPctLong` / `atrFloorPctShort`  per-side override, wins when > 0
 *   · an override of 0 does NOT mean "off" — it means "fall back to shared",
 *     which is what makes the shared knob usable as the global setting.
 *   · the quantity is the **15m** ATR% at the decision bar — `atrPct15m` in
 *     computeLayer2Signal, computed by each engine as
 *     `computeAtrPct(klines15m, 14)` (EMA-smoothed TR, seed TR[0]=high−low).
 *     That is exactly the series the `rtL` calibration arms of
 *     run-vol-floor-rejudge.ts measure.
 *
 *     ⚠⚠ DO NOT FEED THIS GATE `metrics.atrPct`. That parameter is a DIFFERENT
 *     quantity: the Layer-1 tick's **1-minute** read (marketData fetches 1m
 *     klines). Live, the two are an order of magnitude apart — the tick's
 *     reading across all 30 tracked pairs is 0.057–0.391 (median 0.205) while
 *     the 15m value for the same pairs is 0.24–1.60 (median 0.918). The first
 *     version of this gate read the tick value, which put the armed 0.60 floor
 *     ABOVE every pair's reading and blocked every long until the audit caught
 *     it (see VOL_FLOOR_JOURNAL.md §7). `atrPct15m` is a REQUIRED parameter so
 *     TypeScript forces every caller to state which ATR it means.
 *
 * FAIL-CLOSED, deliberately, and it is the one place this module diverges from
 * the chop gate's fail-open: when the floor is ARMED for a side and the ATR
 * reading is not a usable positive number, the entry is BLOCKED. That is the
 * convention the backtest's volatility gate (`volGateAllows`) measured and the
 * one documented at `minAtrPct`, and it keeps the armed gate and the lab that
 * justified it on the same rule.
 */

export const VOL_FLOOR_DEFAULTS = { floor: 0 } as const;

/** Resolved config shape the floor reads (StrategyConfig after resolveConfig). */
export interface AtrFloorConfig {
  atrFloorPct: number;                     // shared floor, 0 = off
  atrFloorPctLong?: number | null;         // per-side override; unset = shared
  atrFloorPctShort?: number | null;        // per-side override; unset = shared
}

/** The floor that applies to a side. Returns 0 when the floor is OFF. */
export function atrFloorFor(cfg: AtrFloorConfig, side: "LONG" | "SHORT"): number {
  const per = side === "LONG" ? cfg.atrFloorPctLong : cfg.atrFloorPctShort;
  if (per != null && Number.isFinite(per) && per > 0) return per;
  return Number.isFinite(cfg.atrFloorPct) && cfg.atrFloorPct > 0 ? cfg.atrFloorPct : VOL_FLOOR_DEFAULTS.floor;
}

export interface VolFloorVerdict {
  blocked: boolean;
  floor: number;         // the floor this side was measured against (0 = off)
  atrPct: number;        // the reading (may be NaN/0 when unusable)
}

/**
 * The gate. `atrPct` is the engine's own ATR% for the decision bar.
 * Off / no floor for this side → never blocks. Armed + unusable reading →
 * blocks (fail-closed, see the header).
 */
export function volFloorBlocks(
  atrPct: number,
  cfg: AtrFloorConfig,
  side: "LONG" | "SHORT",
): VolFloorVerdict {
  const floor = atrFloorFor(cfg, side);
  if (floor <= 0) return { blocked: false, floor: 0, atrPct };
  if (!Number.isFinite(atrPct) || atrPct <= 0) return { blocked: true, floor, atrPct };
  return { blocked: atrPct < floor, floor, atrPct };
}
