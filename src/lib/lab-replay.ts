/**
 * SHARED REPLAY HARNESS for the entry-feature labs (2026-09-23).
 *
 * Owns everything the labs must do identically so their entry sets are
 * comparable byte-for-byte:
 *   - L1 snapshot archive loading (shared src/lib/l1-archive.ts: paged, cached
 *     on disk, tail page always re-fetched so a growing archive is picked up)
 *   - paper config loading (data/lab/2sided-config.json, else getConfig)
 *   - the per-bar BASE pass: one computeLayer2Signal call with the exhaustion
 *     guards OFF (trend gates + funding as-shipped) — every lab arm is then a
 *     pure filter over the same base decisions, bit-equivalent to re-running
 *     the full signal per arm (the guards only null the side after scoring)
 *   - the shipped rlock exit simulation (adverse-before-favourable, 192-bar
 *     forward bound, per-pair outcome completeness)
 *   - stats/format helpers (metrics, day-paired t, buckets, formatting)
 *
 * Labs built on this: run-exhaustion-lab.ts, run-volume-size-lab.ts.
 * Conventions inherited from run-candidate-score-lab.ts / run-2sided-score-lab.ts.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { getCachedKlines, type CachedKline } from "./kline-cache";
import { computeAtrPct } from "./mexc/indicators";
import { candFeatures } from "./candidate-score";
import { loadL1Ticks, type L1PairRow, type L1Tick } from "./l1-archive";
import {
  computeLayer2Signal,
  resolveFundingRate,
  resolvePaperConfig,
  type StrategyConfig,
} from "./layer2-signal";

export const LAB_DIR = path.join(process.cwd(), "data", "lab");
export const CONFIG_JSON = path.join(LAB_DIR, "2sided-config.json");

export const EMA_KLINE_BARS = 400; // strategyEngine.EMA_KLINE_BARS
export const MIN_BARS = 60; // strategyEngine.EMA_MIN_BARS
export const L1_MAX_STALE_MS = 20 * 60_000;
export const FWD_BARS = 192; // 48h of 15m — every outcome fully resolved
export const MIN_N = 30; // a cut/curve arm below this is reported but cannot win
export const CONTROL_DRAWS = 500;

// ── L1 archive (shared loader; see src/lib/l1-archive.ts for the tail fence) ──
export { L1_DIR, L1_LIMIT, loadL1Ticks } from "./l1-archive";
export type { L1Page, L1PairRow, L1Tick } from "./l1-archive";

export function loadConfig(): StrategyConfig {
  const raw = fs.existsSync(CONFIG_JSON)
    ? fs.readFileSync(CONFIG_JSON, "utf8")
    : execSync(`bunx convex run strategyEngine:getConfig '{"book":"paper"}'`, {
        cwd: process.cwd(),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
  return resolvePaperConfig(JSON.parse(raw) as Record<string, never>);
}

export type PairSeries = { ts: number[]; rows: L1PairRow[] };

export function buildSeries(ticks: L1Tick[]): Map<string, PairSeries> {
  const byPair = new Map<string, PairSeries>();
  for (const [ts, pairs] of ticks) {
    for (const row of pairs) {
      let s = byPair.get(row[0]);
      if (!s) {
        s = { ts: [], rows: [] };
        byPair.set(row[0], s);
      }
      s.ts.push(ts);
      s.rows.push(row);
    }
  }
  return byPair;
}

/** Last L1 read at or before `t`, within L1_MAX_STALE_MS. Null when stale. */
export function l1At(s: PairSeries, t: number): L1PairRow | null {
  let lo = 0;
  let hi = s.ts.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (s.ts[mid]! <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 0) return null;
  if (t - s.ts[best]! > L1_MAX_STALE_MS) return null;
  return s.rows[best]!;
}

// ── Exit simulation — backtest.ts tpMode "rlock", verbatim semantics ─────────

export type Exit = { r: number; reason: string };

export function simulateExit(args: {
  side: "LONG" | "SHORT";
  entry: number;
  sl: number;
  riskDist: number;
  fwd: CachedKline[];
  lockStartR: number;
  lockStepR: number;
  lockMaxR: number;
}): Exit {
  const { side, entry, sl, riskDist, fwd, lockStartR, lockStepR, lockMaxR } = args;
  const long = side === "LONG";
  const sign = long ? 1 : -1;
  const maxPrice = entry + sign * riskDist * lockMaxR;
  const done = (price: number, reason: string): Exit => ({ r: ((price - entry) * sign) / riskDist, reason });

  let peakR = 0;
  let lockPrice = 0;
  const n = Math.min(fwd.length, FWD_BARS);
  for (let k = 0; k < n; k++) {
    const bar = fwd[k]!;
    if (long ? bar.low <= sl : bar.high >= sl) return done(sl, "Stop Loss");
    if (lockPrice !== 0 && (long ? bar.low <= lockPrice : bar.high >= lockPrice)) {
      return done(lockPrice, "Trail Lock");
    }
    if (long ? bar.high >= maxPrice : bar.low <= maxPrice) return done(maxPrice, "Max Target");
    const barPeakR = long ? (bar.high - entry) / riskDist : (entry - bar.low) / riskDist;
    if (barPeakR > peakR) peakR = barPeakR;
    if (peakR >= lockStartR) {
      const lockR = lockStartR + Math.floor((peakR - lockStartR) / lockStepR) * lockStepR;
      const newLock = entry + sign * riskDist * lockR;
      if (lockPrice === 0 || (long ? newLock > lockPrice : newLock < lockPrice)) lockPrice = newLock;
    }
  }
  const last = n > 0 ? fwd[n - 1]! : null;
  return done(last ? last.close : entry, "End of data");
}

/**
 * The SHIPPED entry sequence: the guards-off base pass plus the book's two
 * entry guards (EMA stretch, RSI-heat on longs) and its freshness rule — a pair
 * must go quiet or flip side before it can re-signal. Every lab that reasons
 * about "the book we run" must reason about this ONE sequence; a second copy is
 * how lab verdicts silently stop being comparable. (Moved here from
 * run-arm-score-lab.ts, 2026-09-25, for exactly that reason.)
 */
export function guardedEntries(
  obs: BaseBar[],
  cfg: { maxEmaStretchPct: number; maxRsiLong: number; rsiLongGuard: boolean },
): BaseBar[] {
  const out: BaseBar[] = [];
  const prevGated = new Map<string, boolean>();
  const prevSide = new Map<string, "LONG" | "SHORT" | null>();
  for (const o of obs) {
    const fresh = !(prevGated.get(o.pair) ?? false);
    const wasSide = prevSide.get(o.pair) ?? null;
    let side: "LONG" | "SHORT" | null = null;
    if (o.baseSide !== null) {
      const st =
        o.emaFast > 0
          ? o.baseSide === "LONG"
            ? ((o.lastClose - o.emaFast) / o.emaFast) * 100
            : ((o.emaFast - o.lastClose) / o.emaFast) * 100
          : 0;
      const rsiOk = o.baseSide !== "LONG" || !cfg.rsiLongGuard || o.rsi7 <= cfg.maxRsiLong;
      if (st <= cfg.maxEmaStretchPct && rsiOk) side = o.baseSide;
    }
    prevGated.set(o.pair, side !== null);
    prevSide.set(o.pair, side);
    if (side === null || (!fresh && side === wasSide)) continue;
    out.push(o);
  }
  return out;
}

// ── Base bar (computed once; every lab arm is a filter over these) ───────────

export type BaseBar = {
  pair: string;
  t: number; // signal-bar close time (decision time)
  day: string;
  /** shipped side with the stretch/RSI guards OFF (trend gates + funding as-shipped) */
  baseSide: "LONG" | "SHORT" | null;
  ownScore: number;
  oppScore: number;
  /** signal-bar OHLC (closed 15m bar) */
  barOpen: number;
  barHigh: number;
  barLow: number;
  lastClose: number;
  /** shipped EMA values at the signal bar */
  emaFast: number;
  emaSlow: number;
  /** L1 microstructure readings (nn-normalised; may be NaN-free by construction) */
  imb: number;
  flow: number;
  spreadPct: number;
  atrPct: number; // L1 atr gauge (matches computeLayer2Signal input)
  rangePct: number; // L1 range gauge
  vol24: number;
  /** Resolved L1 funding read (undefined when the gauge was missing/invalid;
   *  the funding-extreme lab reads this — the sentinel-0 conflation noted
   *  there does not apply since this is the PRE-coalesced value). */
  fundingRate?: number;
  /** candidate exhaustion features (candFeatures) */
  extAtr: number; // (price - slowEMA)/ATR, signed
  run: number; // signed close streak, capped ±6
  rsi7: number;
  wickUpper: number;
  wickLower: number;
  candAtrPct: number; // computeAtrPct over the last 21 candles
  /** last 21 closed bars' closes and volumes ending at the signal bar
   *  (same slice — the volume labs compute net-volume bias on aligned windows) */
  closeWindow: number[];
  volWindow: number[];
  /** outcomes from this bar, both sides, shipped rlock exit */
  long: Exit;
  short: Exit;
  /** realised peak excursion in R on each side (`simulateExitDetailed`): the ARM
   *  event the arm-score lab predicts is peak ≥ trailLockStartR */
  longPeak: number;
  shortPeak: number;
};

export type BuildReport = {
  bars: BaseBar[];
  cfg: StrategyConfig;
  t0: number;
  t1: number;
  seriesSize: number;
  ticks: number;
  scored: number;
  staleSkipped: number;
  warmupSkipped: number;
  noFeature: number;
};

/**
 * The SAME shipped exit, but reporting the PEAK it reached and how long it
 * lived. The ARM-score lab needs the peak because arming the lock
 * (peak ≥ lockStartR) is the event that decides these trades, and `simulateExit`
 * reports only the realized R.
 *
 * This is a DELIBERATE COPY of the loop above, not a refactor of it: `simulateExit`
 * is load-bearing for every existing lab, and the two disagreeing silently would
 * poison both. `run-score.test.ts` pins the equivalence — for a set of synthetic
 * forward series, `simulateExitDetailed(...).r/reason` must equal
 * `simulateExit(...).r/reason` exactly. Change one, the test fails.
 */
export function simulateExitDetailed(args: {
  side: "LONG" | "SHORT";
  entry: number;
  sl: number;
  riskDist: number;
  fwd: CachedKline[];
  lockStartR: number;
  lockStepR: number;
  lockMaxR: number;
}): Exit & { peakR: number; barsHeld: number } {
  const { side, entry, sl, riskDist, fwd, lockStartR, lockStepR, lockMaxR } = args;
  const long = side === "LONG";
  const sign = long ? 1 : -1;
  const maxPrice = entry + sign * riskDist * lockMaxR;
  const done = (price: number, reason: string, peakR: number, barsHeld: number) => ({
    r: ((price - entry) * sign) / riskDist,
    reason,
    peakR,
    barsHeld,
  });

  let peakR = 0;
  let lockPrice = 0;
  const n = Math.min(fwd.length, FWD_BARS);
  for (let k = 0; k < n; k++) {
    const bar = fwd[k]!;
    // Adverse-first, then the lock, then the max target — the peak is only
    // advanced on bars the trade SURVIVED, so it is a realised excursion, not a
    // hypothetical one.
    if (long ? bar.low <= sl : bar.high >= sl) return done(sl, "Stop Loss", peakR, k + 1);
    if (lockPrice !== 0 && (long ? bar.low <= lockPrice : bar.high >= lockPrice)) {
      return done(lockPrice, "Trail Lock", peakR, k + 1);
    }
    if (long ? bar.high >= maxPrice : bar.low <= maxPrice) {
      return done(maxPrice, "Max Target", peakR, k + 1);
    }
    const barPeakR = long ? (bar.high - entry) / riskDist : (entry - bar.low) / riskDist;
    if (barPeakR > peakR) peakR = barPeakR;
    if (peakR >= lockStartR) {
      const lockR = lockStartR + Math.floor((peakR - lockStartR) / lockStepR) * lockStepR;
      const newLock = entry + sign * riskDist * lockR;
      if (lockPrice === 0 || (long ? newLock > lockPrice : newLock < lockPrice)) lockPrice = newLock;
    }
  }
  const last = n > 0 ? fwd[n - 1]! : null;
  return done(last ? last.close : entry, "End of data", peakR, n);
}

/**
 * Build the base bar set: L1 ticks × 15m klines over the archive window,
 * one guards-off signal pass per bar, candidate features, both-side exits.
 */
export async function buildBaseBars(verbose = false): Promise<BuildReport> {
  const ticks = loadL1Ticks(verbose);
  const cfg = loadConfig();
  const t0 = ticks.length > 0 ? ticks[0]![0] : 0;
  const t1 = ticks.length > 0 ? ticks[ticks.length - 1]![0] : 0;
  const series = buildSeries(ticks);

  const allBars = new Map<string, CachedKline[]>();
  for (const pair of series.keys()) {
    allBars.set(pair, await getCachedKlines(pair, "15m", { localOnly: true }));
  }
  const fwdMs = FWD_BARS * 15 * 60_000;

  // Guards-off twin of the shipped config: identical except the two vetoes.
  // "No guards" must mean no guards. `cfg` is loaded from the LIVE paper config
  // row (see loadConfig), so any gate armed there leaks into this replay unless
  // it is stripped here — and a lab whose inputs silently change stops being
  // comparable to its own journal. 2026-09-27: the volatility floor
  // (`atrFloorPct*`, armed longs-only 0.60 on both books that day) joined the
  // list for exactly that reason.
  const cfgNoGuards: StrategyConfig = {
    ...cfg,
    maxEmaStretchPct: 0,
    rsiLongGuard: false,
    atrFloorPct: 0,
    atrFloorPctLong: null,
    atrFloorPctShort: null,
  };

  const bars: BaseBar[] = [];
  let scored = 0;
  let staleSkipped = 0;
  let warmupSkipped = 0;
  let noFeature = 0;

  for (const [pair, s] of series) {
    const pairBars = allBars.get(pair) ?? [];
    if (pairBars.length < MIN_BARS) continue;
    const pairLast = pairBars[pairBars.length - 1]!.closeTime;
    const winEnd = Math.min(t1, pairLast - fwdMs);
    for (let i = 0; i < pairBars.length; i++) {
      const bar = pairBars[i]!;
      if (bar.closeTime < t0 || bar.closeTime > winEnd) continue;
      const m = l1At(s, bar.closeTime);
      if (!m) {
        staleSkipped++;
        continue;
      }
      const from = Math.max(0, i + 1 - EMA_KLINE_BARS);
      const slice = pairBars.slice(from, i + 1);
      const closes = slice.map((b) => b.close);
      if (closes.length < MIN_BARS) {
        warmupSkipped++;
        continue;
      }
      const imb = nn(m[1]);
      const flow = nn(m[2]);
      const spread = nn(m[3]);
      const atr = nn(m[4]);
      const range = nn(m[5]);
      const vol = nn(m[6]);
      if (![imb, flow, spread, atr, range, vol].every(Number.isFinite)) {
        staleSkipped++;
        continue;
      }
      const funding = resolveFundingRate(m[7], m[8] === 1);

      const sig = computeLayer2Signal(closes, imb, flow, funding, atr, computeAtrPct(slice, 14), range, spread, vol, cfgNoGuards);

      const riskDist = bar.close * (cfg.stopLossPct / 100);
      const fwd = pairBars.slice(i + 1);
      const lock = {
        riskDist,
        fwd,
        lockStartR: cfg.trailLockStartR,
        lockStepR: cfg.trailLockStepR,
        lockMaxR: cfg.trailLockMaxR,
      };
      // Detailed twins: identical loop, plus the realised peak (the ARM event).
      // Equivalence of r/reason with simulateExit is pinned in
      // src/lib/run-score.test.ts — if the two ever drift, that test fails.
      const longEx = simulateExitDetailed({
        side: "LONG",
        entry: bar.close,
        sl: bar.close * (1 - cfg.stopLossPct / 100),
        ...lock,
      });
      const shortEx = simulateExitDetailed({
        side: "SHORT",
        entry: bar.close,
        sl: bar.close * (1 + cfg.stopLossPct / 100),
        ...lock,
      });

      // candFeatures is optional (warmup); the signal pass above already
      // enforced MIN_BARS, so a null here is an implementation mismatch —
      // count it and skip rather than fabricate readings.
      const f = candFeatures({
        candles: slice.map((b) => ({ open: b.open, high: b.high, low: b.low, close: b.close })),
        lastPrice: bar.close,
        imbalance: imb,
        flowBias: flow,
        spreadPct: spread,
        fundingRate: funding ?? 0,
        volume24: vol,
      });
      if (!f) {
        noFeature++;
        continue;
      }

      bars.push({
        pair,
        t: bar.closeTime,
        day: new Date(bar.closeTime).toISOString().slice(0, 10),
        baseSide: sig.side,
        ownScore: sig.side === "LONG" ? sig.longScore : sig.side === "SHORT" ? sig.shortScore : 0,
        oppScore: sig.side === "LONG" ? sig.shortScore : sig.side === "SHORT" ? sig.longScore : 0,
        barOpen: bar.open,
        barHigh: bar.high,
        barLow: bar.low,
        lastClose: bar.close,
        emaFast: sig.emaFast,
        emaSlow: sig.emaSlow,
        imb,
        flow,
        spreadPct: spread,
        atrPct: atr,
        rangePct: range,
        vol24: vol,
        fundingRate: funding,
        extAtr: f.extAtr,
        run: f.run,
        rsi7: f.rsi7,
        wickUpper: f.wickUpper,
        wickLower: f.wickLower,
        candAtrPct: f.atrPct,
        closeWindow: slice.slice(-21).map((b) => b.close),
        volWindow: slice.slice(-21).map((b) => b.volume),
        long: longEx,
        short: shortEx,
        longPeak: longEx.peakR,
        shortPeak: shortEx.peakR,
      });
      scored++;
    }
  }
  bars.sort((a, b) => a.t - b.t);
  return { bars, cfg, t0, t1, seriesSize: series.size, ticks: ticks.length, scored, staleSkipped, warmupSkipped, noFeature };
}

// ── Stats & formatting ───────────────────────────────────────────────────────

export const mean = (xs: number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);
export const sd = (xs: number[]): number => {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / (xs.length - 1));
};
export const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "  -  ");
export const f1 = (x: number): string => (Number.isFinite(x) ? x.toFixed(1) : "  - ");
export const iso = (t: number): string => new Date(t).toISOString().slice(0, 16).replace("T", " ");
export const nn = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : NaN);

export type Metrics = {
  n: number;
  net: number;
  rPerTrade: number;
  wr: number;
  pf: number;
  maxDD: number;
  netDD: number;
  long: number;
  short: number;
  stopShare: number;
};

export function metrics(entries: { t: number; r: number; side: "LONG" | "SHORT"; reason: string }[]): Metrics {
  const sorted = [...entries].sort((a, b) => a.t - b.t);
  const n = sorted.length;
  const net = sorted.reduce((a, e) => a + e.r, 0);
  const wins = sorted.filter((e) => e.r > 0).reduce((a, e) => a + e.r, 0);
  const losses = sorted.filter((e) => e.r <= 0).reduce((a, e) => a + e.r, 0);
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  for (const e of sorted) {
    cum += e.r;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDD) maxDD = dd;
  }
  const stops = sorted.filter((e) => e.reason === "Stop Loss").length;
  return {
    n,
    net,
    rPerTrade: n > 0 ? net / n : NaN,
    wr: n > 0 ? (sorted.filter((e) => e.r > 0).length / n) * 100 : NaN,
    pf: losses !== 0 ? wins / -losses : wins > 0 ? Infinity : NaN,
    maxDD,
    netDD: maxDD > 0 ? net / maxDD : NaN,
    long: sorted.filter((e) => e.side === "LONG").length,
    short: sorted.filter((e) => e.side === "SHORT").length,
    stopShare: n > 0 ? (stops / n) * 100 : NaN,
  };
}

/** Day-paired t between two entry sets' daily mean R (kept vs deleted etc.). */
export function dayPairedT(
  a: { day: string; r: number }[],
  b: { day: string; r: number }[],
): { t: number; blocks: number } {
  const byBlock = new Map<string, { a: number[]; b: number[] }>();
  for (const e of a) {
    const rec = byBlock.get(e.day) ?? { a: [], b: [] };
    rec.a.push(e.r);
    byBlock.set(e.day, rec);
  }
  for (const e of b) {
    const rec = byBlock.get(e.day) ?? { a: [], b: [] };
    rec.b.push(e.r);
    byBlock.set(e.day, rec);
  }
  const diffs: number[] = [];
  for (const rec of byBlock.values()) {
    if (rec.a.length > 0 && rec.b.length > 0) diffs.push(mean(rec.a) - mean(rec.b));
  }
  if (diffs.length < 2) return { t: NaN, blocks: diffs.length };
  const se = sd(diffs) / Math.sqrt(diffs.length);
  return { t: se === 0 ? 0 : mean(diffs) / se, blocks: diffs.length };
}

/** Bucket attribution: avg R + WR per label bucket over an entry set. */
export function bucketReport(
  title: string,
  entries: { r: number }[],
  key: (e: { r: number }) => number,
  edges: number[],
  labelFor: (label: string) => number,
): string {
  const buckets = new Map<string, { n: number; sum: number; wins: number }>();
  for (const e of entries) {
    const v = key(e);
    let label = `≥${edges[edges.length - 1]}`;
    for (let i = 0; i < edges.length; i++) {
      if (v < edges[i]!) {
        label = i === 0 ? `<${edges[0]}` : `[${edges[i - 1]},${edges[i]})`;
        break;
      }
    }
    const rec = buckets.get(label) ?? { n: 0, sum: 0, wins: 0 };
    rec.n++;
    rec.sum += e.r;
    if (e.r > 0) rec.wins++;
    buckets.set(label, rec);
  }
  const ordered = [...buckets.entries()].sort((a, b) => labelFor(a[0]) - labelFor(b[0]));
  const line = ordered
    .map(([label, b]) => `${label}: n=${b.n} R/t ${f2(b.sum / Math.max(1, b.n))} WR ${f1((b.wins / Math.max(1, b.n)) * 100)}%`)
    .join("  ·  ");
  return `  ${title}\n    ${line}`;
}
