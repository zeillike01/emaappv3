import { COSTS } from "./costs";
import { mean, type Side } from "./residual-breakout";
import type { CachedKline } from "./kline-cache";

export type Candidate = { pair: string; side: Side; signalTime: number; entryTime: number; day: string; index: number; bars: CachedKline[]; beta: number | null; entry: number; risk: number; exitTime: number; exitPrice: number; r: number; reason: string };
export type PortfolioSpec = { stopLossPct: number; riskPct: number; maxOpen: number; cooldownMs: number; horizonBars: number };
export const PORTFOLIO_SPEC: PortfolioSpec = { stopLossPct: 1.5, riskPct: 1, maxOpen: 0, cooldownMs: 3_600_000, horizonBars: 192 };
const DAY = 86_400_000;
export const stratum = (c: Pick<Candidate, "day" | "side">) => `${c.day}|${c.side}`;

/** Complete contiguous forward horizon required, even for early exits (equal censoring across arms).
 * Stop/old lock before favorable high; newly ratcheted locks become active NEXT bar.
 * Gaps through stop/lock fill at adverse open, never the better theoretical bracket.
 */
export function priceCandidate(pair: string, side: Side, bars: CachedKline[], signalIndex: number, beta: number | null, spec: PortfolioSpec): Candidate | null {
  const index = signalIndex + 1, fwd = bars.slice(index, index + spec.horizonBars);
  if (fwd.length !== spec.horizonBars || fwd[0].openTime !== bars[signalIndex].closeTime ||
    fwd.some((b, j) => b.closeTime - b.openTime !== 900_000 || (j > 0 && b.openTime !== fwd[j - 1].closeTime) ||
      ![b.open, b.high, b.low, b.close].every((v) => Number.isFinite(v) && v > 0) || b.high < Math.max(b.open, b.close, b.low) || b.low > Math.min(b.open, b.close, b.high))) return null;
  const sign = side === "LONG" ? 1 : -1;
  const entry = fwd[0].open * (1 + sign * COSTS.entrySlipPct / 100);
  const risk = entry * spec.stopLossPct / 100;
  const stop = entry - sign * risk, target = entry + sign * risk * 6;
  let lock: number | null = null, peak = 0;
  let exitPrice = fwd[fwd.length - 1].close, exitTime = fwd[fwd.length - 1].closeTime, reason = "Horizon";
  for (const b of fwd) {
    const hit = (p: number) => sign === 1 ? b.low <= p : b.high >= p;
    const adverse = (p: number) => sign === 1 ? Math.min(p, b.open) : Math.max(p, b.open);
    if (hit(stop)) { exitPrice = adverse(stop); exitTime = b.closeTime; reason = "Stop"; break; }
    if (lock != null && hit(lock)) { exitPrice = adverse(lock); exitTime = b.closeTime; reason = "Lock"; break; }
    if (sign === 1 ? b.high >= target : b.low <= target) { exitPrice = target; exitTime = b.closeTime; reason = "Target"; break; }
    peak = Math.max(peak, sign === 1 ? (b.high - entry) / risk : (entry - b.low) / risk);
    if (peak >= 1.5) lock = entry + sign * risk * (1.5 + Math.floor((peak - 1.5) / 0.25) * 0.25);
  }
  const slipped = exitPrice * (1 - sign * (reason === "Target" ? 0 : COSTS.exitSlipPct / 100));
  const funding = Math.floor((exitTime - fwd[0].openTime) / (8 * 3_600_000)) * entry * COSTS.fundingPctPer8h / 100;
  const fees = (entry * COSTS.takerFeePct + slipped * (reason === "Target" ? COSTS.makerFeePct : COSTS.takerFeePct)) / 100;
  return { pair, side, signalTime: bars[signalIndex].closeTime, entryTime: fwd[0].openTime, day: new Date(fwd[0].openTime).toISOString().slice(0, 10), index, bars, beta, entry, risk, exitTime, exitPrice: slipped, r: ((slipped - entry) * sign - fees - funding) / risk, reason };
}
export type Replay = { trades: Candidate[]; netR: number; rPerTrade: number; winRate: number; maxDrawdownR: number; peakOpen: number; blocked: { position: number; cooldown: number; cap: number }; equityCurve: { time: number; equityR: number }[] };
export function replay(candidates: readonly Candidate[], spec: PortfolioSpec, quotas?: ReadonlyMap<string, number>, random?: () => number, markEquity = true): Replay {
  const sorted = [...candidates].sort((a, b) => a.entryTime - b.entryTime || a.pair.localeCompare(b.pair) || a.side.localeCompare(b.side));
  const remaining = counts(sorted), used = new Map<string, number>();
  const trades: Candidate[] = [], active: Candidate[] = [], lastEntry = new Map<string, number>();
  const blocked = { position: 0, cooldown: 0, cap: 0 };
  let cash = 0, high = 0, maxDrawdownR = 0, peakOpen = 0, cursor = 0;
  const equityCurve: Replay["equityCurve"] = [];
  if (!sorted.length) return { trades, netR: 0, rPerTrade: 0, winRate: 0, maxDrawdownR, peakOpen, blocked, equityCurve };
  const end = Math.max(...sorted.map((c) => c.exitTime));
  for (let time = sorted[0].entryTime; time <= end; time += 900_000) {
    for (let j = active.length - 1; j >= 0; j--) if (active[j].exitTime <= time) { cash += active[j].r; active.splice(j, 1); }
    while (cursor < sorted.length && sorted[cursor].entryTime <= time) {
      const c = sorted[cursor++], key = stratum(c);
      const left = remaining.get(key)!; remaining.set(key, left - 1);
      if (active.some((p) => p.pair === c.pair)) { blocked.position++; continue; }
      if (time - (lastEntry.get(c.pair) ?? -Infinity) < spec.cooldownMs) { blocked.cooldown++; continue; }
      if (spec.maxOpen > 0 && active.length >= spec.maxOpen) { blocked.cap++; continue; }
      if (quotas) {
        const need = (quotas.get(key) ?? 0) - (used.get(key) ?? 0);
        // Offline placebo only: quota is known from the experiment, never used by a strategy arm.
        if (need <= 0 || (random && random() >= Math.min(1, need / left))) continue;
      }
      active.push(c); trades.push(c); lastEntry.set(c.pair, time); used.set(key, (used.get(key) ?? 0) + 1);
    }
    peakOpen = Math.max(peakOpen, active.length);
    if (!markEquity) continue;
    let equityR = cash;
    for (const c of active) {
      const offset = Math.floor((time - c.entryTime) / 900_000) - 1;
      const mark = offset < 0 ? c.bars[c.index].open : c.bars[c.index + offset].close;
      const sign = c.side === "LONG" ? 1 : -1;
      const funding = Math.floor((time - c.entryTime) / (8 * 3_600_000)) * c.entry * COSTS.fundingPctPer8h / 100;
      equityR += ((mark - c.entry) * sign - c.entry * COSTS.takerFeePct / 100 - funding) / c.risk;
    }
    high = Math.max(high, equityR); maxDrawdownR = Math.max(maxDrawdownR, high - equityR);
    equityCurve.push({ time, equityR });
  }
  const netR = trades.reduce((a, c) => a + c.r, 0);
  return { trades, netR, rPerTrade: mean(trades.map((c) => c.r)), winRate: trades.length ? trades.filter((c) => c.r > 0).length / trades.length : 0, maxDrawdownR, peakOpen, blocked, equityCurve };
}
export function counts(cs: readonly Candidate[]): Map<string, number> {
  const out = new Map<string, number>(); for (const c of cs) out.set(stratum(c), (out.get(stratum(c)) ?? 0) + 1); return out;
}
export function rng(seed: number) { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 4294967296; }; }
export function matchedControls(pool: Candidate[], reference: Replay, spec: PortfolioSpec, draws = 500, seed = 7) {
  const quota = counts(reference.trades), random = rng(seed), controls: Replay[] = [];
  let attempts = 0;
  while (controls.length < draws && attempts < draws * 10) {
    attempts++;
    const control = replay(pool, spec, quota, random, false), actual = counts(control.trades);
    if ([...quota].every(([k, n]) => actual.get(k) === n) && control.trades.length === reference.trades.length) {
      const marked = replay(control.trades, spec);
      controls.push({ ...marked, equityCurve: [] });
    }
  }
  return { controls, attempts, exactMatched: controls.length === draws };
}
function tStat(diffs: number[]) {
  const m = mean(diffs), variance = diffs.length > 1 ? diffs.reduce((a, d) => a + (d - m) ** 2, 0) / (diffs.length - 1) : 0;
  return { blocks: diffs.length, meanDiff: m, t: variance > 0 ? m / Math.sqrt(variance / diffs.length) : null };
}
export function pairedDays(a: Candidate[], b: Candidate[], start: number, end: number) {
  const days = new Map<number, { a: number[]; b: number[] }>();
  for (let d = Math.floor(start / DAY); d <= Math.floor((end - 1) / DAY); d++) days.set(d, { a: [], b: [] });
  for (const c of a) days.get(Math.floor(c.entryTime / DAY))?.a.push(c.r);
  for (const c of b) days.get(Math.floor(c.entryTime / DAY))?.b.push(c.r);
  const shared = [...days.values()].filter((d) => d.a.length && d.b.length);
  return { perTrade: tStat(shared.map((d) => mean(d.a) - mean(d.b))), netPerDay: tStat([...days.values()].map((d) => d.a.reduce((x, y) => x + y, 0) - d.b.reduce((x, y) => x + y, 0))) };
}
export function promotion(a: Replay, b: Replay, controls: Replay[], start: number, end: number, complete: boolean) {
  const paired = pairedDays(a.trades, b.trades, start, end);
  const p = controls.length ? (1 + controls.filter((c) => c.netR >= a.netR).length) / (controls.length + 1) : null;
  const pass = complete && a.trades.length >= 30 && b.trades.length >= 30 && paired.perTrade.blocks >= 10 &&
    paired.perTrade.t != null && paired.perTrade.t >= 2.5 && paired.netPerDay.meanDiff > 0 && a.rPerTrade > b.rPerTrade && p != null && p <= 0.05;
  return { pass, paired, placeboP: p, netDifferenceR: a.netR - b.netR };
}
export function serializeReplay(r: Replay) {
  return { ...r, trades: r.trades.map(({ bars: _bars, ...c }) => c) };
}
