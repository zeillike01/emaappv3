/**
 * MEASURED OUTPUT of `bun run backtest:displacement` (2026-09-22).
 *
 * These numbers are a RECORD, not a computation — they are pasted from the lab's
 * stdout for the window/universe stated below, so the dashboard can show what
 * was actually measured instead of a re-derived guess. Re-run the lab and update
 * this file together; a stale constant here is a lie with a timestamp.
 *
 * Harness: src/lib/run-displacement-lab.ts, 2026-03-20 → 2026-09-19,
 * SEP11_25_SNAPSHOT (25 pairs, 437,557 x 15m bars), shipped layer-2 brackets
 * (SL 1.5% / 20x-safe 50x leverage / 1% risk), R-LOCK 1.5→6R exit, real MEXC
 * fees + slippage + funding.
 *
 * Parity anchors: the momentum core reproduced the documented 6-month book
 * exactly (3,212 trades, +0.026 R/trade; fixed-2R 3,071 trades, −0.065) —
 * without that the grid would not be interpretable.
 */

export interface LabArm {
  label: string;
  trades: number;
  winRate: number;
  netR: number;
  netPerT: number;
  /** Net R/trade minus the anchor's, on shared days. */
  deltaNetPerT: number;
  /** Paired-day t statistic vs the anchor. */
  t: number;
  clears: boolean;
}

export interface LabBand {
  label: string;
  trades: number;
  winRate: number;
  netR: number;
  netPerT: number;
}

export const DISPLACEMENT_BACKTEST = {
  ranAt: "2026-09-22",
  window: "2026-03-20 → 2026-09-19",
  universe: "25 pairs · 437,557 × 15m bars",
  exit: "R-LOCK 1.5 → 6R · real fees + slippage + funding",
  anchor: {
    label: "shipped momentum core",
    trades: 3212,
    netPerT: 0.026,
    fixed2R: { trades: 3071, netPerT: -0.065 },
  },
  /** The anchor's own trades, bucketed by how far their setup displaced the
   *  prior opposite pivot. This is the table that decides whether the metric is
   *  pointed at where the R actually comes from. */
  bands: [
    { label: "never displaced", trades: 622, winRate: 6.1, netR: -591.73, netPerT: -0.951 },
    { label: "0.5 – 1.0 ATR", trades: 27, winRate: 37.0, netR: -3.19, netPerT: -0.118 },
    { label: "1.0 – 2.0 ATR", trades: 213, winRate: 32.9, netR: -44.69, netPerT: -0.21 },
    { label: "≥ 2.0 ATR", trades: 2350, winRate: 51.3, netR: 722.5, netPerT: 0.307 },
  ] as LabBand[],
  neverDisplacedShare: 19.4,
  arms: [
    { label: "break · k = 1.00 (PRIMARY)", trades: 2025, winRate: 38.4, netR: -94.86, netPerT: -0.047, deltaNetPerT: -0.073, t: -1.45, clears: false },
    { label: "break · k = 1.25", trades: 2002, winRate: 38.6, netR: -77.43, netPerT: -0.039, deltaNetPerT: -0.064, t: -1.08, clears: false },
    { label: "confirm · k = 1.00", trades: 1447, winRate: 37.5, netR: -102.9, netPerT: -0.071, deltaNetPerT: -0.097, t: -1.27, clears: false },
    { label: "confirm · k = 1.25", trades: 1414, winRate: 37.9, netR: -84.08, netPerT: -0.059, deltaNetPerT: -0.085, t: -0.76, clears: false },
  ] as LabArm[],
  /**
   * The decomposition that explains the result: how the arm's trades line up
   * with the anchor's, through the HL/LH pivot both cores share.
   */
  autopsy: [
    {
      label: "break timing",
      kept: { trades: 1556, anchorNetPerT: 0.305, armNetPerT: -0.011, timingCost: -0.316 },
      dropped: { trades: 1656, anchorNetPerT: -0.237 },
      armOnly: { trades: 469, netPerT: -0.166 },
    },
    {
      label: "confirm timing (same entry bar as the core)",
      kept: { trades: 937, anchorNetPerT: -0.056, armNetPerT: -0.056, timingCost: 0 },
      dropped: { trades: 2275, anchorNetPerT: 0.06 },
      armOnly: { trades: 510, netPerT: -0.099 },
    },
  ],
  verdict: {
    clears: false,
    headline:
      "The displacement test targets the right cohort and still loses: waiting for the break costs −0.316 R/trade of entry price on the setups it keeps.",
    detail: [
      "The cohort it deletes is real — the anchor's setups that never displaced the prior pivot run −0.951 R/trade over 622 trades at 6.1% win rate, 19.4% of the book.",
      "But «break timing» enters only after price has already closed through the prior swing high, which is systematically later and higher than the shipped core's entry: −0.316 R/trade on the very setups both cores keep.",
      "«Confirm timing» removes that cost completely (both cores enter on the same bar — measured timing cost 0.000), and then the selection is plainly worse: it drops setups averaging +0.060 R/trade and keeps ones averaging −0.056.",
      "So the fast, immediate break through structure is a worse entry than a slower structure build. The amplitude knob is also nearly inert in confirm mode (k = 0 → k = 1.25 moves 60 trades), so there is no second dial to tune.",
    ],
    shipped: "off — nothing in the engine imports the displacement core; the live board is read-only",
  },
} as const;
