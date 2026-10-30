/**
 * Wilder-smoothed RSI over a full close series, anchored to the last bar.
 *
 * The SAME recursion the RSI(7) wick guard uses inline and the one
 * htf-advisor's `rsiSeries` walks — seeded from the first `period` changes and
 * then smoothed (6/7)^k, so a 400-bar series is indistinguishable from a
 * 1000-bar replay (the 2026-09-10 wick-guard audit). Returns null when the
 * series is too short to carry a reading: the callers treat null as NO
 * OPINION (fail open), never as a silent veto.
 *
 * MOVED OUT OF layer2-signal.ts (2026-09-22) unchanged, and re-exported from
 * there so every existing importer keeps working. It is pure and has no
 * dependency on the strategy config, which is the test this repo applies
 * elsewhere (`chop-gate.ts`, `r-lock.ts`).
 */
export function wilderRsi(closes: number[], period: number): number | null {
  if (!(period > 1) || closes.length < period + 2) return null;
  let avgG = 0;
  let avgL = 0;
  for (let i = 1; i <= period && i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    if (ch >= 0) avgG += ch;
    else avgL -= ch;
  }
  avgG /= period;
  avgL /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + Math.max(ch, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-ch, 0)) / period;
  }
  return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
}
