/**
 * DCP — Directional-Change Pressure.
 * Ported 2026-09-26 from the user's pasted indicator, with three fixes
 * (house lab only, NOT wired into any engine, book, or advisor).
 *
 * Directional-Change (DC) leg detection (Tsang-style event segmentation):
 * a leg is CONFIRMED only when price reverses thetaPct% from the running
 * extreme — the market, not a fixed window, defines the swings. Over the last
 * K confirmed legs, DCP blends
 *   magBias = (Σup-mag − Σdown-mag) / Σmag          (signed net displacement / path)
 *   spdBias = (sUp − sDown) / (sUp + sDown), s = mag/duration  (swing-speed asymmetry)
 * into raw ∈ [-1, +1], smoothed EMA(M) with signal EMA(S).
 *
 * FIXES vs the paste (each covered by a test):
 *  1. CAUSALITY LEAK (critical): the paste admitted a leg into the rolling
 *     window at endIndex <= t, but endIndex is the EXTREME's bar — the leg is
 *     only knowable at the CONFIRMATION bar (thetaPct% later). Every DCPPoint
 *     saw reversals before the market printed them. Fixed: legs carry
 *     `confirmIndex` and are admitted when confirmIndex <= t.
 *  2. NO WARMUP GATE: the paste computed raw on partial leg windows (1..K-1
 *     legs), an unbiased-at-zero but noisy regime. Fixed: raw is NaN until
 *     `minLegs` (default = K) confirmed legs are in the window.
 *  3. PHANTOM LEG: a θ-reversal immediately from bar 0 emitted a zero-magnitude
 *     leg that added duration without magnitude, polluting spdBias. Fixed:
 *     zero-magnitude legs are not emitted.
 *
 * Causality contract: compute on CLOSED bars and read the last closed bar at
 * signal time (advisor signal-open convention). A leg's data is derived only
 * from bars ≤ its confirmIndex; the confirming bar itself closes before its
 * information is usable at the NEXT decision point.
 *
 * House conventions: warmup values are NaN (not null), matching
 * wilderRsiSeries / atrSeries / volume-centroid across this repo's labs.
 *
 * VERDICT (2026-09-26, raw-stream probe, 654,569 trend-context entries, 360d,
 * pair-pinned θ from H1 leg-duration targeting, PnL never consulted at pin):
 *  RETIRED AT THE PROBE GATE — nothing carried to a full-stack lab.
 *  - Pre-registered VETO (raw ≤ −0.3 against the position): WRONG SIGN in both
 *    halves (vetoed +0.111 R/t vs kept +0.055; H1 +0.114/+0.071, H2 +0.108/+0.039).
 *  - Pre-registered GREEN (raw ≥ +0.5 with): n=69 total, ALL in half 2 —
 *    one-half tail, regime artifact, untestable.
 *  - Blended deciles: monotone INVERTED in H1 (dec3 +0.116 → dec7 −0.208:
 *    with-trend swing pressure loses — the known chase/extension inversion),
 *    non-monotone mush in H2. Half-unstable.
 *  - spdBias (the novel axis): OPPOSITE gradients across halves. Dead.
 *  - magBias ≈ signed ER: same inversion shape as the ER-family findings;
 *    cross-tab vs ER(10) shows near-zero added information (within-band
 *    splits differ by ≤ 0.035 R/t in LO/MID).
 *  Do not re-test without a fundamentally different exit regime.
 */

export interface DCPOptions {
  thetaPct?: number; // DC threshold %, e.g. 1.0 = 1%
  rollingLegs?: number; // K
  minLegs?: number; // FIX #2: raw NaN until this many confirmed legs (default K)
  dcpSmoothing?: number; // M
  signalSmoothing?: number; // S
  magnitudeWeight?: number;
  speedWeight?: number;
}

export interface DCLeg {
  direction: 1 | -1;
  startIndex: number;
  endIndex: number; // bar of the leg extreme (NOT the confirmation bar)
  confirmIndex: number; // FIX #1: bar where the θ reversal printed
  magnitude: number; // always positive
  duration: number; // endIndex - startIndex + 1
}

export interface DCPPoint {
  dcp: number; // NaN during warmup
  signal: number;
  histogram: number;
  raw: number;
  legsCount: number;
}

export const DCP_DEFAULTS = {
  thetaPct: 1.0,
  rollingLegs: 8,
  dcpSmoothing: 5,
  signalSmoothing: 3,
  magnitudeWeight: 0.6,
  speedWeight: 0.4,
} as const;

export function detectDCLegs(prices: number[], thetaPct: number): DCLeg[] {
  const legs: DCLeg[] = [];
  if (prices.length < 2) return legs;
  if (thetaPct <= 0) throw new Error("thetaPct must be > 0");

  const theta = thetaPct / 100;

  let refPrice = prices[0]!;
  let refIdx = 0;
  let legExtreme = prices[0]!;
  let legExtremeIdx = 0;
  let dir: 1 | -1 = 1;

  for (let i = 1; i < prices.length; i++) {
    const p = prices[i]!;
    if (dir === 1) {
      if (p > legExtreme) {
        legExtreme = p;
        legExtremeIdx = i;
      } else if (p <= legExtreme * (1 - theta)) {
        const magnitude = refPrice > 0 ? Math.abs(legExtreme - refPrice) / refPrice : 0;
        // FIX #3: never emit zero-magnitude (phantom) legs
        if (magnitude > 0) {
          legs.push({
            direction: 1,
            startIndex: refIdx,
            endIndex: legExtremeIdx,
            confirmIndex: i,
            magnitude,
            duration: legExtremeIdx - refIdx + 1,
          });
        }
        refPrice = legExtreme;
        refIdx = legExtremeIdx;
        legExtreme = p;
        legExtremeIdx = i;
        dir = -1;
      }
    } else {
      if (p < legExtreme) {
        legExtreme = p;
        legExtremeIdx = i;
      } else if (p >= legExtreme * (1 + theta)) {
        const magnitude = refPrice > 0 ? Math.abs(legExtreme - refPrice) / refPrice : 0;
        if (magnitude > 0) {
          legs.push({
            direction: -1,
            startIndex: refIdx,
            endIndex: legExtremeIdx,
            confirmIndex: i,
            magnitude,
            duration: legExtremeIdx - refIdx + 1,
          });
        }
        refPrice = legExtreme;
        refIdx = legExtremeIdx;
        legExtreme = p;
        legExtremeIdx = i;
        dir = 1;
      }
    }
  }

  return legs;
}

/** NaN-preserving EMA seeded with the SMA of the first `period` valid values. */
function emaSeries(values: number[], period: number): number[] {
  const out: number[] = new Array(values.length).fill(NaN);
  if (period < 1) return out;
  const alpha = 2 / (period + 1);
  let prev = NaN;
  let seedSum = 0;
  let seedCount = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFinite(v)) continue;
    if (!isFinite(prev)) {
      seedSum += v;
      seedCount++;
      if (seedCount < period) continue;
      prev = seedSum / period;
      out[i] = prev;
    } else {
      prev = alpha * v + (1 - alpha) * prev;
      out[i] = prev;
    }
  }
  return out;
}

export function computeDCP(prices: number[], options: DCPOptions = {}): DCPPoint[] {
  const {
    thetaPct,
    rollingLegs: K,
    dcpSmoothing: M,
    signalSmoothing: S,
    magnitudeWeight: wMag,
    speedWeight: wSpd,
  } = { ...DCP_DEFAULTS, ...options };
  const minLegs = options.minLegs ?? K;

  if (K < 2) throw new Error("rollingLegs must be >= 2");
  if (minLegs > K) throw new Error("minLegs must be <= rollingLegs");
  if (minLegs < 1) throw new Error("minLegs must be >= 1");
  if (M < 1 || S < 1) throw new Error("smoothing periods must be >= 1");
  if (wMag < 0 || wSpd < 0 || wMag + wSpd <= 0) {
    throw new Error("weights must be >= 0 with a positive sum");
  }

  // FIX #1 (causality): legs are admitted at their CONFIRMATION bar, not the
  // extreme bar. detectDCLegs returns legs sorted by confirmIndex (each leg's
  // confirmation strictly follows the previous leg's).
  const legs = detectDCLegs(prices, thetaPct);
  const n = prices.length;

  const raw: number[] = new Array(n).fill(NaN);
  const legsCount: number[] = new Array(n).fill(0);

  const window: DCLeg[] = [];
  let legPtr = 0;

  for (let t = 0; t < n; t++) {
    while (legPtr < legs.length && legs[legPtr]!.confirmIndex <= t) {
      window.push(legs[legPtr]!);
      if (window.length > K) window.shift();
      legPtr++;
    }
    legsCount[t] = window.length;
    // FIX #2 (warmup): raw stays NaN until minLegs confirmed legs exist
    if (window.length < minLegs) continue;

    let MUp = 0, MDown = 0, TUp = 0, TDown = 0;
    for (const leg of window) {
      if (leg.direction === 1) {
        MUp += leg.magnitude;
        TUp += leg.duration;
      } else {
        MDown += leg.magnitude;
        TDown += leg.duration;
      }
    }

    const magBias = MUp + MDown > 0 ? (MUp - MDown) / (MUp + MDown) : 0;
    const sUp = TUp > 0 ? MUp / TUp : 0;
    const sDown = TDown > 0 ? MDown / TDown : 0;
    const spdBias = sUp + sDown > 0 ? (sUp - sDown) / (sUp + sDown) : 0;

    const wSum = wMag + wSpd;
    raw[t] = wSum > 0 ? (wMag * magBias + wSpd * spdBias) / wSum : 0;
  }

  const dcp = emaSeries(raw, M);
  const signal = emaSeries(dcp, S);

  return prices.map((_, i) => ({
    dcp: dcp[i]!,
    signal: signal[i]!,
    histogram: isFinite(dcp[i]) && isFinite(signal[i]) ? dcp[i]! - signal[i]! : NaN,
    raw: raw[i]!,
    legsCount: legsCount[i]!,
  }));
}
