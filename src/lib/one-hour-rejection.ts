/**
 * ONE-HOUR REJECTION (1HR-FB) — local failed-breakout detector.
 *
 * This is intentionally different from the 4H advisor: it does not measure
 * 4H divergence, VWAP stretch, or volume exhaustion. It watches the inside
 * of the current 1H structure for a breakout that was accepted for one closed
 * candle and then rejected back into the prior range.
 *
 * Bullish failed breakout -> veto LONG.
 * Bearish failed breakout -> veto SHORT.
 *
 * Only closed candles are used. A missing/incomplete read fails open.
 */

export type RejectionSide = "LONG" | "SHORT";

export type OneHourRejection = {
  side: RejectionSide;
  direction: "bullish-failure" | "bearish-failure";
  breakoutIndex: number;
  confirmationIndex: number;
  ageBars: number;
  priorHigh: number;
  priorLow: number;
  reason: string;
};

type Ohlc = { closeTime: number; high: number; low: number; close: number };

/**
 * Return the most recent fresh failed breakout, or null.
 *
 * `rangeBars` defines the prior acceptance range. A breakout must close
 * outside it; the next closed 1H candle must close back inside it. The result
 * remains actionable for `maxAgeBars` closed candles after confirmation.
 */
export function oneHourRejectionAt(
  bars: readonly Ohlc[],
  at: number,
  rangeBars = 3,
  maxAgeBars = 2,
  forSide?: RejectionSide,
): OneHourRejection | null {
  if (rangeBars < 2 || maxAgeBars < 0) return null;
  let end = bars.length - 1;
  while (end >= 0 && bars[end]!.closeTime > at) end--;
  if (end < rangeBars) return null;

  for (let confirmation = end; confirmation >= rangeBars; confirmation--) {
    const age = end - confirmation;
    if (age > maxAgeBars) break;
    const breakout = bars[confirmation - 1]!;
    // The range must end immediately BEFORE the breakout candle. The old
    // slice included the breakout itself, so a close above its own high could
    // never be recognized as a breakout.
    const prior = bars.slice(confirmation - rangeBars - 1, confirmation - 1);
    if (prior.length !== rangeBars) continue;
    const priorHigh = Math.max(...prior.map((b) => b.high));
    const priorLow = Math.min(...prior.map((b) => b.low));
    const confirm = bars[confirmation]!;

    if ((!forSide || forSide === "LONG") && breakout.close > priorHigh && confirm.close <= priorHigh) {
      return {
        side: "LONG",
        direction: "bullish-failure",
        breakoutIndex: confirmation - 1,
        confirmationIndex: confirmation,
        ageBars: age,
        priorHigh,
        priorLow,
        reason: `1H breakout above ${priorHigh.toPrecision(8)} was rejected back inside the prior range`,
      };
    }
    if ((!forSide || forSide === "SHORT") && breakout.close < priorLow && confirm.close >= priorLow) {
      return {
        side: "SHORT",
        direction: "bearish-failure",
        breakoutIndex: confirmation - 1,
        confirmationIndex: confirmation,
        ageBars: age,
        priorHigh,
        priorLow,
        reason: `1H breakdown below ${priorLow.toPrecision(8)} was rejected back inside the prior range`,
      };
    }
  }
  return null;
}
