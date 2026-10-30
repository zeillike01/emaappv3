/**
 * 4H CHOPPINESS GATE — Kaufman Efficiency Ratio (ER) floor (PURE module).
 *
 * Born 2026-09-22 from the operator watching INJ's 4H weave around its
 * filter EMA (ER(10) = 0.14): price crosses the EMA75 repeatedly, the HTF
 * verdict flips which side is allowed, and 15m HL/LH setups inside the
 * range get stopped out. The fix that fits this stack is one number on the
 * timeframe the strategy already filters on:
 *
 *   ER(period) = |close[i] − close[i−period]|  /  Σ |close[j] − close[j−1]|
 *               (net move ÷ path length over the last `period` CLOSED 4H
 *                bars — 1 = straight line, 0 = pure sideways weave)
 *
 *   block a side while ER < floor   (shared floor, optional per-side
 *   override — both sides by default, because chop is not directional)
 *
 * Contracts (mirrored by run-4h-chop-gate-lab.ts, which imports the SAME
 * `efficiencyRatio` so the lab can never drift from the shipped gate):
 *   - CLOSED candles only: callers pass only closed 4H closes (the engine's
 *     fetchKlines already excludes the live candle).
 *   - Fail-open: gate off, invalid period, or insufficient history
 *     (< period+1 closes) → allow. A blackout must not freeze the book.
 *   - Flat tape (path length 0) → ER = 0 = maximum chop.
 *   - Ships OFF (chopGateEnabled default false) AND STAYS OFF: the 6-month
 *     A/B ran (backtest:chopgate, 2026-09-22) and did NOT clear the promotion
 *     bar. Measured, in the repo's own numbers:
 *       ER(10) < 0.25 both sides → 1,826t, net/t +0.035 vs anchor +0.026
 *       (Δ +0.009) but paired-day t = 0.34, IS +0.030 → OOS −0.012 and
 *       −19.7R of TOTAL net R. Steeper floors (0.30 / 0.35) lift net/t to
 *       +0.057 / +0.055 on Δnet −6.5R / −18.6R — that is dilution, not edge:
 *       the 0.30 arm drops 695 winners worth +1,126R to avoid 1,023 losers
 *       worth −1,143R. A wash paid for with 1,644 fewer trades.
 *     The anchor cohort table is the tell: the ER < 0.20 band — the cohort a
 *     floor is built to remove — is the WEAKEST evidence of a bleed
 *     (+0.014 net/t over 1,176 trades) while 0.25–0.30 is the negative band
 *     (−0.039). ER is not aligned with where the anchor's R comes from, so a
 *     floor cannot separate the bleed from the edge. The slope-label pass
 *     (EMA50 ±0.3%/6 bars, the shipped regime label) failed the same bar the
 *     same day.
 *     Kept in the tree, default OFF, so the negative result stays reachable
 *     and re-runnable instead of being deleted into folklore.
 */

export const CHOP_GATE_DEFAULTS = { period: 10, floor: 0.25 } as const;

/** Resolved config shape the gate reads (StrategyConfig after resolveConfig). */
export interface ChopGateConfig {
  chopGateEnabled: boolean;
  chopGatePeriod: number;          // ER lookback in closed 4H bars
  chopGateFloor: number;           // shared ER floor (both sides)
  chopGateFloorLong?: number | null;   // per-side override; unset = shared
  chopGateFloorShort?: number | null;  // per-side override; unset = shared
}

/**
 * Kaufman Efficiency Ratio over the last `period` changes of `closes`
 * (oldest → newest). Returns undefined when the history is insufficient or
 * contains a non-finite value — callers MUST treat that as "allow".
 */
export function efficiencyRatio(closes: number[], period: number): number | undefined {
  if (!Number.isFinite(period) || period < 1) return undefined;
  const n = Math.floor(period);
  if (closes.length < n + 1) return undefined;
  const win = closes.slice(-(n + 1));
  for (const c of win) if (!Number.isFinite(c)) return undefined;
  let path = 0;
  for (let i = 1; i < win.length; i++) path += Math.abs(win[i] - win[i - 1]);
  if (path <= 0) return 0; // price never moved sideways = maximum chop
  return Math.abs(win[win.length - 1] - win[0]) / path;
}

/** The floor that applies to a side: per-side override wins when set (> 0). */
export function chopGateFloorFor(cfg: ChopGateConfig, side: "LONG" | "SHORT"): number {
  const per = side === "LONG" ? cfg.chopGateFloorLong : cfg.chopGateFloorShort;
  if (per != null && Number.isFinite(per) && per > 0) return per;
  return Number.isFinite(cfg.chopGateFloor) ? cfg.chopGateFloor : CHOP_GATE_DEFAULTS.floor;
}

export interface ChopGateVerdict {
  blocked: boolean;
  er?: number;      // present only when ER could be computed
  floor: number;    // the floor this side was measured against
}

/**
 * The gate itself. `closes` are the closed 4H closes (oldest → newest) at
 * decision time. Fail-open everywhere: gate off / bad period / short
 * history → { blocked: false }.
 */
export function chopGateVerdict(
  closes: number[],
  cfg: ChopGateConfig,
  side: "LONG" | "SHORT",
): ChopGateVerdict {
  const floor = chopGateFloorFor(cfg, side);
  if (!cfg.chopGateEnabled) return { blocked: false, floor };
  const period = Number.isFinite(cfg.chopGatePeriod) && cfg.chopGatePeriod >= 1
    ? cfg.chopGatePeriod
    : CHOP_GATE_DEFAULTS.period;
  const er = efficiencyRatio(closes, period);
  if (er === undefined) return { blocked: false, floor }; // fail-open
  return { blocked: er < floor, er, floor };
}
