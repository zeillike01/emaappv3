/**
 * R-LOCK ENGINE PARITY — the harness and the books run the SAME bar rule.
 *
 * WHY THIS FILE EXISTS. `src/lib/backtest.ts` (tpMode "rlock") is where the
 * r-lock edge was measured (+0.026 R/trade over 6 months vs −0.065 for a fixed
 * 2R target). The live and paper books trade it through `rLockBarStep` /
 * `rLockReplayBars`. Until 2026-09-22 those were TWO implementations of one
 * decision rule: the harness ranged over a bar's high and low, while the books
 * sampled a single spot price per 5-minute tick and therefore armed the lock
 * later or never. The live ledger recorded the cost in its own rows — 14 of 23
 * measurable rows under-recorded their peak, and 6 rows booked more R than their
 * stored peak allowed (+15.40R, 74% of net).
 *
 * So the harness now calls `rLockBarStep` too, and this file pins the two
 * together:
 *   1. randomised differential — the shared bar rule vs a TRANSCRIPTION of the
 *      inline engine branch it replaced, bar for bar, both sides, over a random
 *      walk of lock states (peak, armed rung, breached rung, max target);
 *   2. a source guard: `backtest.ts` must go on calling the shared rule, because
 *      the failure mode this file exists for is someone re-inlining a second copy.
 *
 * Everything in section 1 is in-band (the adverse side never breaches the
 * original stop). That is not a shortcut: the harness checks the stop BEFORE it
 * calls the lock rule and closes the trade itself, so the lock rule is only ever
 * reached on bars that did not stop out. The stand-down ordering for a sample
 * that DID breach the stop is pinned in r-lock.test.ts.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { rLockBarStep, type RLockBar, type RLockParams } from "../r-lock";

// ── Deterministic PRNG (a failure must reproduce on the next run) ────────────
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(0x9e3779b9);
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length) % xs.length];

/**
 * The inline engine branch as it stood before 2026-09-22, transcribed verbatim
 * from git history (tpMode "rlock" in src/lib/backtest.ts). This is the
 * reference the shared rule must reproduce — deliberately a copy, so that a
 * change to the shared rule has to change behaviour HERE first.
 */
function engineBar(args: {
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  riskDist: number;
  bar: RLockBar;
  peakR: number;
  lockPrice: number;
  params: RLockParams;
}): { peakR: number; lockPrice: number; exit: "Trail Lock" | "Max Target 8R" | null; exitPrice: number } {
  const { side, entryPrice, slPrice, riskDist, bar } = args;
  let { peakR, lockPrice } = args;
  const start = args.params.startR;
  const step = args.params.stepR ?? 1;

  if (side === "LONG") {
    const maxPrice = entryPrice + riskDist * args.params.maxR;
    if (bar.low <= slPrice) return { peakR, lockPrice, exit: null, exitPrice: NaN };
    if (lockPrice > 0 && bar.low <= lockPrice) {
      return { peakR, lockPrice, exit: "Trail Lock", exitPrice: lockPrice };
    }
    if (bar.high >= maxPrice) return { peakR, lockPrice, exit: "Max Target 8R", exitPrice: maxPrice };
    const barPeakR = (bar.high - entryPrice) / riskDist;
    if (barPeakR > peakR) peakR = barPeakR;
    if (peakR >= start) {
      const lockR = start + Math.floor((peakR - start) / step) * step;
      const newLock = entryPrice + riskDist * lockR;
      if (newLock > lockPrice) lockPrice = newLock;
    }
    return { peakR, lockPrice, exit: null, exitPrice: NaN };
  }

  const maxPrice = entryPrice - riskDist * args.params.maxR;
  if (bar.high >= slPrice) return { peakR, lockPrice, exit: null, exitPrice: NaN };
  if (lockPrice > 0 && bar.high >= lockPrice) {
    return { peakR, lockPrice, exit: "Trail Lock", exitPrice: lockPrice };
  }
  if (bar.low <= maxPrice) return { peakR, lockPrice, exit: "Max Target 8R", exitPrice: maxPrice };
  const barPeakR = (entryPrice - bar.low) / riskDist;
  if (barPeakR > peakR) peakR = barPeakR;
  if (peakR >= start) {
    const lockR = start + Math.floor((peakR - start) / step) * step;
    const newLock = entryPrice - riskDist * lockR;
    if (lockPrice === 0 || newLock < lockPrice) lockPrice = newLock;
  }
  return { peakR, lockPrice, exit: null, exitPrice: NaN };
}

/** Map the shared rule's reason onto the harness's string, as backtest.ts does. */
const harnessReason = (r: "Trail Lock" | "R-Lock Max" | null | undefined) =>
  r == null ? null : r === "Trail Lock" ? "Trail Lock" : "Max Target 8R";

describe("rLockBarStep — parity with the inline engine branch it replaced", () => {
  it("LONG: identical state and identical exits, bar for bar, over 20,000 random bars", () => {
    let mismatches = 0;
    let exits = 0;
    let locked = 0;

    for (let trial = 0; trial < 20_000; trial++) {
      const entryPrice = 100;
      const riskDist = 0.5 + rand() * 2.5; // 0.5–3.0 in price = 1R
      const slPrice = entryPrice - riskDist;
      const params: RLockParams = {
        startR: pick([1.0, 1.5, 2.0, 3.0]),
        stepR: pick([0.25, 0.5, 1]),
        maxR: pick([4, 6, 8]),
      };
      // In-band bar: the adverse side stays clear of the stop (see file header).
      const low = slPrice + rand() * (entryPrice + 3 * riskDist - slPrice);
      const high = low + rand() * 2 * riskDist;
      const bar: RLockBar = { openTime: 0, closeTime: 299_000, low, high };
      const state = {
        peakR: rand() < 0.5 ? 0 : rand() * params.maxR,
        lockPrice: 0,
      };
      // Arm the starting lock the only way the engine ever could: from the peak.
      if (state.peakR >= params.startR) {
        const lockR = params.startR + Math.floor((state.peakR - params.startR) / (params.stepR ?? 1)) * (params.stepR ?? 1);
        if (lockR <= params.maxR) state.lockPrice = entryPrice + riskDist * lockR;
      }
      if (state.lockPrice > 0) locked++;

      const shared = rLockBarStep({
        side: "LONG",
        entryPrice,
        slPrice,
        riskPx: riskDist,
        params,
        bar,
        state,
      });
      const ref = engineBar({ side: "LONG", entryPrice, slPrice, riskDist, bar, peakR: state.peakR, lockPrice: state.lockPrice, params });

      if (shared.exit) exits++;
      const reasonOk = harnessReason(shared.exit?.reason) === ref.exit;
      const priceOk = ref.exit === null || Math.abs((shared.exit?.rungPrice ?? NaN) - ref.exitPrice) < 1e-9;
      // State is compared only while the trade is LIVE. On a closing bar the
      // engine resets peak/lock in closePosition while rLockStep reports the
      // running peak it just measured — the harness discards it one line later,
      // so the difference is bookkeeping, not a decision.
      const live = ref.exit === null && shared.exit === null;
      const peakOk = !live || Math.abs(shared.peakR - ref.peakR) < 1e-9;
      const lockOk = !live || Math.abs(shared.lockPrice - ref.lockPrice) < 1e-9;
      if (!(reasonOk && priceOk && peakOk && lockOk)) {
        mismatches++;
        if (mismatches === 1) {
          // eslint-disable-next-line no-console
          console.log("first mismatch", { trial, bar, state, params, shared, ref });
        }
      }
    }

    expect({ mismatches, exits, locked }).toEqual({ mismatches: 0, exits, locked });
    // The random walk has to actually exercise the rule, or "0 mismatches" is vacuous.
    expect(exits).toBeGreaterThan(1_000);
    expect(locked).toBeGreaterThan(1_000);
  });

  it("SHORT: identical state and identical exits, bar for bar, over 20,000 random bars", () => {
    let mismatches = 0;
    let exits = 0;
    let locked = 0;

    for (let trial = 0; trial < 20_000; trial++) {
      const entryPrice = 100;
      const riskDist = 0.5 + rand() * 2.5;
      const slPrice = entryPrice + riskDist;
      const params: RLockParams = {
        startR: pick([1.0, 1.5, 2.0, 3.0]),
        stepR: pick([0.25, 0.5, 1]),
        maxR: pick([4, 6, 8]),
      };
      const high = slPrice - rand() * (slPrice - (entryPrice - 3 * riskDist));
      const low = high - rand() * 2 * riskDist;
      const bar: RLockBar = { openTime: 0, closeTime: 299_000, low, high };
      const state = { peakR: rand() < 0.5 ? 0 : rand() * params.maxR, lockPrice: 0 };
      if (state.peakR >= params.startR) {
        const lockR = params.startR + Math.floor((state.peakR - params.startR) / (params.stepR ?? 1)) * (params.stepR ?? 1);
        if (lockR <= params.maxR) state.lockPrice = entryPrice - riskDist * lockR;
      }
      if (state.lockPrice > 0) locked++;

      const shared = rLockBarStep({
        side: "SHORT",
        entryPrice,
        slPrice,
        riskPx: riskDist,
        params,
        bar,
        state,
      });
      const ref = engineBar({ side: "SHORT", entryPrice, slPrice, riskDist, bar, peakR: state.peakR, lockPrice: state.lockPrice, params });

      if (shared.exit) exits++;
      const reasonOk = harnessReason(shared.exit?.reason) === ref.exit;
      const priceOk = ref.exit === null || Math.abs((shared.exit?.rungPrice ?? NaN) - ref.exitPrice) < 1e-9;
      const live = ref.exit === null && shared.exit === null;
      const peakOk = !live || Math.abs(shared.peakR - ref.peakR) < 1e-9;
      const lockOk = !live || Math.abs(shared.lockPrice - ref.lockPrice) < 1e-9;
      if (!(reasonOk && priceOk && peakOk && lockOk)) mismatches++;
    }

    expect({ mismatches, exits, locked }).toEqual({ mismatches: 0, exits, locked });
    expect(exits).toBeGreaterThan(1_000);
    expect(locked).toBeGreaterThan(1_000);
  });

  it("a bar that ARMS the lock cannot breach it (the adverse-first ordering)", () => {
    // One bar, low far below the would-be rung, high far above the arming level.
    const riskDist = 1;
    const entryPrice = 100;
    const slPrice = 99;
    const out = rLockBarStep({
      side: "LONG",
      entryPrice,
      slPrice,
      riskPx: riskDist,
      params: { startR: 1.5, stepR: 0.25, maxR: 6 },
      bar: { low: 99.5, high: 103 },
      state: { peakR: 0, lockPrice: 0 },
    });
    expect(out.exit).toBeNull();
    expect(out.peakR).toBeCloseTo(3, 10);
    // 1.5 + floor((3 − 1.5)/0.25) × 0.25 = 3.0 → lock = 100 + 1 × 3.0 = 103.
    expect(out.lockPrice).toBeCloseTo(103, 10);
  });
});

describe("backtest.ts keeps calling the shared rule", () => {
  it("has one r-lock implementation, not two", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "backtest.ts"), "utf8");
    expect(src).toContain("rLockBarStep");
    // The inline arithmetic this file replaces: `lockR = start + Math.floor(...)`.
    // If it comes back, the harness and the books are two implementations again —
    // which is precisely the bug the bar replay fixed.
    expect(src).not.toMatch(/Math\.floor\(\(peakR - start\)/);
  });
});
