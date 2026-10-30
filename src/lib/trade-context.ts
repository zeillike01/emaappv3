/**
 * Pure trade-context derivations used by the mining backfill (and, by mirror,
 * the engine enrichment paths they replicate).
 *
 * Extracted from src/convex/mining.ts so the exact formulas can be
 * unit-tested against the engine semantics they mirror. The engines' own
 * copies live inside paperTrading.ts (atrPct / classifyRegime4h / sessionOf)
 * and strategyEngine.ts (sessionOf) — this module must stay formula-identical
 * to them. No I/O — keep it that way.
 */

export type ContextPatch = {
  session?: string;
  regime?: string;
  volPct?: number;
};

/**
 * Strip `undefined` keys from a context patch. Convex's ctx.db.patch treats
 * an explicit `undefined` value as DELETE — passing one through silently
 * wipes an already-correct field. This caused a real data-loss bug once (the
 * regime backfill deleted good session/volPct on 78 rows), so the strip is a
 * pure, unit-tested rule that every patch path must run its input through.
 */
export function compactContextPatch(p: ContextPatch): ContextPatch {
  const out: ContextPatch = {};
  if (p.session !== undefined) out.session = p.session;
  if (p.regime !== undefined) out.regime = p.regime;
  if (p.volPct !== undefined) out.volPct = p.volPct;
  return out;
}

export type Candle = {
  high: number;
  low: number;
  close: number;
  closeTime?: number;
};

/**
 * Every session label the engines can produce, in UTC order.
 *
 * The session breaker buckets the FULL grid (session × side), so a
 * (session, side) the paper book has never closed is still a bucket — with
 * zero evidence — instead of an absent row nobody can refuse.
 */
export const SESSION_LABELS = ["asia", "london", "ldn-ny", "ny", "late"] as const;

/** Trading session from UTC hour (PHT = UTC+8). Same buckets as the engines. */
export function sessionOf(ms: number): string {
  const h = new Date(ms).getUTCHours();
  if (h < 7) return "asia";
  if (h < 13) return "london";
  if (h < 17) return "ldn-ny";
  if (h < 22) return "ny";
  return "late";
}

/**
 * 15m ATR(14) as % of the latest close, over bars that all CLOSED at/before
 * the anchor moment. Mirrors the engine's atrPct() exactly (last 14 bars,
 * TR = max(range, |high−prevClose|, |low−prevClose|), normalized by the final
 * close) — the input is the same "bars the engine saw at entry" list, so the
 * result equals what the entry-time enrichment would have stored. Returns
 * undefined when fewer than 15 closed bars are available.
 */
export function atrPctOf(bars: Candle[]): number | undefined {
  if (bars.length < 15) return undefined;
  let sum = 0;
  for (let i = bars.length - 14; i < bars.length; i++) {
    sum += Math.max(
      bars[i].high - bars[i].low,
      Math.abs(bars[i].high - bars[i - 1].close),
      Math.abs(bars[i].low - bars[i - 1].close),
    );
  }
  const atr = sum / 14;
  const last = bars[bars.length - 1].close;
  return last > 0 ? (atr / last) * 100 : undefined;
}

/**
 * Wilder's ADX(14) — trend strength at the anchor bar, timeframe-agnostic
 * Standard construction: Wilder-smoothed
 * TR/+DM/−DM over 14, DX from the smoothed DIs, ADX as the 14-bar Wilder
 * average of DX. Needs 28+ candles (14 to seed the smoothers + 14 DX
 * values); undefined below that. Rounded to 2dp; NaN-safe (0/0 → 0 DX).
 */
export function adx14Of(bars: Candle[]): number | undefined {
  if (bars.length < 28) return undefined;
  const TR: number[] = [];
  const pDM: number[] = [];
  const mDM: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    pDM.push(up > dn && up > 0 ? up : 0);
    mDM.push(dn > up && dn > 0 ? dn : 0);
    TR.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close),
      ),
    );
  }
  const wilder = (xs: number[]): number[] => {
    const out: number[] = [];
    let acc = 0;
    for (let i = 0; i < 14; i++) acc += xs[i];
    out.push(acc);
    for (let i = 14; i < xs.length; i++) out.push(out[out.length - 1] - out[out.length - 1] / 14 + xs[i]);
    return out;
  };
  const sTR = wilder(TR);
  const sP = wilder(pDM);
  const sM = wilder(mDM);
  const DX: number[] = [];
  for (let i = 0; i < sTR.length; i++) {
    const atr = sTR[i];
    if (!(atr > 0)) {
      DX.push(0);
      continue;
    }
    const pdi = (100 * sP[i]) / atr;
    const mdi = (100 * sM[i]) / atr;
    const sum = pdi + mdi;
    DX.push(sum > 0 ? (100 * Math.abs(pdi - mdi)) / sum : 0);
  }
  let adx = 0;
  for (let i = 0; i < 14; i++) adx += DX[i];
  adx /= 14;
  for (let i = 14; i < DX.length; i++) adx = adx - adx / 14 + DX[i] / 14;
  return Number.isFinite(adx) ? +adx.toFixed(2) : undefined;
}

/**
 * 4H EMA50 slope regime over bars that all CLOSED at/before the anchor
 * moment. Mirrors the engine's classifyRegime4h() exactly: slope of the EMA50
 * over the last 6 × 4h bars, ±0.3% thresholds, "unknown" when fewer than 60
 * bars. The mining backfill treats the null return (insufficient history) as
 * "leave the field missing for the next run" — never persist "unknown".
 */
export function regimeFrom4hBars(bars: Candle[]): string | null {
  if (bars.length < 60) return null;
  const period = 50;
  const k = 2 / (period + 1);
  let ema = bars[0].close;
  const emas: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    ema = bars[i].close * k + ema * (1 - k);
    emas.push(ema);
  }
  const now = emas[emas.length - 1];
  const ago = emas[emas.length - 7]; // 6 × 4h bars = 24h ago
  const slopePct = ((now - ago) / ago) * 100;
  if (slopePct > 0.3) return "trend-up";
  if (slopePct < -0.3) return "trend-down";
  return "chop";
}
