/**
 * EXIT-REPLAY PLANNING (2026-10-10) — from a decision record + a book's config
 * to the concrete brackets the counterfactual pricer runs.
 *
 * WHY A SEPARATE PURE MODULE. `exit-replay.ts` prices one bracket; this file
 * decides WHICH brackets to price and out of WHICH numbers, so the daily
 * backfill action stays I/O-only and the whole plan can be unit-tested against
 * the same config resolver the engines use (`resolvePaperConfig`).
 *
 * THE RULES THAT MATTER:
 *   - The stop is the book's own `stopLossPct` off the ENTRY BAR'S OPEN — the
 *     price the spec says to enter at, for taken and blocked candidates alike.
 *   - 1R is the frozen distance |entry − stop| (never re-derived), so replay R
 *     is comparable to `paperTrades.realizedR`.
 *   - The R-lock variants come from the book's own trailLock* knobs, and the
 *     fixed variant is the spec's 2R. Both price the SAME entry.
 *   - A candidate is only resolvable once its full horizon is inside the bars
 *     we fetched; `horizonEnded` is that test, and it is the only reason a
 *     pending candidate is left pending.
 */
import type { StrategyConfig } from "./layer2-signal";
import { rLockEnabled, type RLockParams } from "./r-lock";
import {
  DEFAULT_HORIZON_MS,
  bracketForVariant,
  type ReplayBar,
  type VariantSpec,
} from "./exit-replay";

/** Ship-by-default variants: the unit's own lock, then the spec's fixed 2R. */
export const FIXED_2R_VARIANT = "fixed2R";

/** The book's R-lock policy, or null when the book ships the lock off. */
export function lockFromConfig(cfg: Pick<StrategyConfig, "trailLockStartR" | "trailLockStepR" | "trailLockMaxR">): RLockParams | null {
  const lock: RLockParams = {
    startR: Number(cfg.trailLockStartR) || 0,
    stepR: Number(cfg.trailLockStepR) || 0,
    maxR: Number(cfg.trailLockMaxR) || 0,
  };
  return rLockEnabled(lock) ? lock : null;
}

/** Stop level the book's own config would have used, off a given entry price. */
export function slPriceFor(args: {
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopLossPct: number;
}): number {
  const sign = args.side === "LONG" ? 1 : -1;
  const frac = (Number(args.stopLossPct) || 0) / 100;
  return args.entryPrice * (1 - sign * frac);
}

export interface PlannedVariant {
  variant: string;
  lock: RLockParams | null;
  slPrice: number;
  tpPrice: number;
  riskPx: number;
}

export interface PlannedEntry {
  entryBar: ReplayBar;
  entryTime: number;
  entryPrice: number;
  variants: PlannedVariant[];
}

/**
 * Resolve the decision into entry + one bracket per variant. Uses the FIRST 1m
 * bar whose openTime is at/after the decision time (spec §Stage 2), and the
 * bar's OPEN as the entry price.
 */
export function planEntry(args: {
  cfg: StrategyConfig;
  side: "LONG" | "SHORT";
  decisionTs: number;
  bars: readonly ReplayBar[];
  /** Variant list to plan; defaults to the shipped rlock + fixed 2R. */
  variants?: VariantSpec[];
  horizonMs?: number;
}): PlannedEntry | null {
  const bar = args.bars
    .filter((b) => b.openTime >= args.decisionTs)
    .sort((a, b) => a.openTime - b.openTime)[0] as ReplayBar | undefined;
  if (!bar || !(bar.open > 0)) return null;

  const entryPrice = bar.open;
  const slPrice = slPriceFor({ side: args.side, entryPrice, stopLossPct: args.cfg.stopLossPct });
  const riskPx = Math.abs(entryPrice - slPrice);
  if (!(riskPx > 0)) return null;

  const specs = args.variants ?? defaultVariants(args.cfg);
  const variants: PlannedVariant[] = [];
  for (const spec of specs) {
    const bracket = bracketForVariant({
      variant: spec,
      side: args.side,
      entryPrice,
      riskPx,
      fallbackTpR: spec.tpR ?? 2,
    });
    variants.push({
      variant: spec.name,
      lock: bracket.lock,
      slPrice,
      tpPrice: bracket.tpPrice,
      riskPx,
    });
  }
  return { entryBar: bar, entryTime: bar.openTime, entryPrice, variants };
}

/** The shipped variant set: the book's own lock, then a fixed 2R on the same entries. */
export function defaultVariants(cfg: StrategyConfig): VariantSpec[] {
  const lock = lockFromConfig(cfg);
  // The config's take-profit is a PERCENT OF PRICE, not an R multiple: at the
  // shipped 1.5% stop a 3% target is 2R. Convert, or the fixed variant would
  // price a 3R target the books never had.
  const stop = Number(cfg.stopLossPct) || 0;
  const tpR = stop > 0 && Number(cfg.takeProfitPct) > 0 ? Number(cfg.takeProfitPct) / stop : 2;
  const specs: VariantSpec[] = [{ name: lock ? "rlock" : "fixedTp", lock, tpR: lock ? null : tpR }];
  specs.push({ name: FIXED_2R_VARIANT, lock: null, tpR: 2 });
  return specs;
}

/** True once a decision's whole horizon lies in bars that already exist. */
export function horizonEnded(args: {
  decisionTs: number;
  now: number;
  horizonMs?: number;
}): boolean {
  return args.now >= args.decisionTs + (args.horizonMs ?? DEFAULT_HORIZON_MS);
}

/** Round-trip variant label carried into the report ("rlock@1.5/0.25/8"). */
export function variantLabel(v: PlannedVariant): string {
  if (!v.lock) return v.variant;
  return `${v.variant}@${v.lock.startR}/${v.lock.stepR}/${v.lock.maxR}`;
}
