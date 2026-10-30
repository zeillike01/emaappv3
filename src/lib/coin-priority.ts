/**
 * COIN PRIORITY (2026-10-21) — the live book spends its scarce position slots
 * on the coins that have actually been making money.
 *
 * WHY. The live book caps open positions (3 by default) and scans ~30 pairs
 * per tick. Before this, the scan order was whatever `getAllStrategyStates`
 * returned — effectively arbitrary — so when two signals arrived while one
 * slot was free, the slot went to the alphabetically earlier pair, not the
 * better one. Measured over the last 14 days of paper closes, the spread
 * between the best and worst pair is enormous (PUMP +11.04R vs TAO −3.88R over
 * the same window), so WHO gets the slot is a real edge, not a tie-break.
 *
 * WHAT IT IS, AND WHAT IT IS NOT.
 *   · PAPER measures, LIVE orders. The per-coin record is read from the paper
 *     ledger (the same sensor the session breaker uses — paper is never
 *     blocked, so it keeps producing evidence).
 *   · This is a PRIORITISATION, not a veto. A coin whose paper record is
 *     negative is not banned; it simply sorts behind every profitable coin.
 *     If the profitable coins produce no signal this tick, the rest still
 *     trade — the book keeps gathering live evidence about them.
 *   · The record is a 14-day rolling window, refreshed once a day and pruned
 *     to the same window (see the Convex seam: recomputeCoinPriority /
 *     coinPriorityRefreshTick / readCoinPriority).
 *
 * PURE: no I/O, no clock. Unit-tested in
 * `src/lib/__tests__/coin-priority.test.ts`.
 */

export const COIN_PRIORITY_DEFAULTS = {
  coinPriorityLookbackDays: 14,
  coinPriorityMinTrades: 10,
} as const;

export interface CoinPriorityConfig {
  coinPriorityLookbackDays: number;
  coinPriorityMinTrades: number;
}

/** One coin's paper record over the window. */
export interface CoinPriorityBucket {
  coin: string;
  trades: number;
  wins: number;
  sumR: number;
  winRate: number | null;
  /**
   * priority — enough closes and profitable: slot first.
   * neutral  — too few closes to judge: sorted behind priority coins.
   * avoid    — enough closes and NOT profitable: sorted last.
   */
  tier: CoinPriorityTier;
}

export type CoinPriorityTier = "priority" | "neutral" | "avoid";

export interface CoinPriorityState {
  lookbackDays: number;
  minTrades: number;
  from: number;
  to: number;
  buckets: CoinPriorityBucket[];
}

/** The subset of a closed PAPER trade this module reads. */
export interface CoinPriorityClosedLike {
  /** Stored engine coin id (BTC, PUMP, …). */
  coin?: string | null;
  exitTime?: number | null;
  /** Realized R — the unit the ranking is denominated in. */
  realizedR?: number | null;
}

const DAY_MS = 86_400_000;

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function sanitize(cfg: CoinPriorityConfig): CoinPriorityConfig {
  return {
    coinPriorityLookbackDays: Math.min(
      Math.max(Math.round(cfg.coinPriorityLookbackDays) || 0, 1),
      90,
    ),
    coinPriorityMinTrades: Math.max(Math.round(cfg.coinPriorityMinTrades) || 0, 1),
  };
}

/**
 * Bucket the closed paper book by coin over the lookback window.
 *
 * Closes without a coin, a close time or a finite R are ignored: an
 * unreconciled row is not evidence about a coin, and counting it as a loss
 * would demote a pair on bookkeeping noise.
 */
export function computeCoinPriority(
  closes: readonly CoinPriorityClosedLike[],
  cfg: CoinPriorityConfig,
  now: number,
): CoinPriorityState {
  const c = sanitize(cfg);
  const to = now;
  const from = now - c.coinPriorityLookbackDays * DAY_MS;

  const byCoin = new Map<string, { trades: number; wins: number; sumR: number }>();
  for (const t of closes) {
    const coin = typeof t.coin === "string" ? t.coin.trim().toUpperCase() : "";
    const exitTime = finiteNumber(t.exitTime);
    const r = finiteNumber(t.realizedR);
    if (!coin || exitTime == null || r == null || exitTime < from || exitTime > to) continue;
    const b = byCoin.get(coin) ?? { trades: 0, wins: 0, sumR: 0 };
    b.trades += 1;
    if (r > 0) b.wins += 1;
    b.sumR += r;
    byCoin.set(coin, b);
  }

  const buckets = [...byCoin.entries()]
    .map(([coin, b]) => {
      const sumR = +b.sumR.toFixed(4);
      const tier: CoinPriorityTier =
        b.trades < c.coinPriorityMinTrades
          ? "neutral"
          : sumR > 0
            ? "priority"
            : "avoid";
      return {
        coin,
        trades: b.trades,
        wins: b.wins,
        sumR,
        winRate: b.trades > 0 ? b.wins / b.trades : null,
        tier,
      };
    })
    // Stored in SCAN ORDER, not by P&L: tier first (profitable → unproven →
    // avoid), then win rate, then net R. The snapshot is what the live tick and
    // the monitor both read, so its order must be the order the book scans.
    .sort(
      (a, b) =>
        coinPriorityRank(a.tier) - coinPriorityRank(b.tier) ||
        (b.winRate ?? -1) - (a.winRate ?? -1) ||
        b.sumR - a.sumR ||
        a.coin.localeCompare(b.coin),
    );

  return {
    lookbackDays: c.coinPriorityLookbackDays,
    minTrades: c.coinPriorityMinTrades,
    from,
    to,
    buckets,
  };
}

/** Rank used for ordering: lower sorts first. */
export function coinPriorityRank(tier: CoinPriorityTier): number {
  return tier === "priority" ? 0 : tier === "neutral" ? 1 : 2;
}

/**
 * Order a tick's candidate metrics by coin priority.
 *
 * PROFITABLE COINS FIRST, then unproven ones, then the losing ones — each
 * group by 14d net R (desc), ties broken by pair name so the order is stable
 * across ticks. Metrics whose coin has no record in the window sort with the
 * unproven group (a coin the paper book has not traded is unknown, not bad).
 *
 * Fail-open: a null/empty state (gate disabled, snapshot missing) returns the
 * input order untouched.
 */
/** The part of a ranking the ordering needs — a stored snapshot has no window. */
export interface CoinPriorityRanking {
  buckets: readonly CoinPriorityBucket[];
}

export function orderByCoinPriority<T extends { pair?: string | null }>(
  metrics: readonly T[],
  state: CoinPriorityRanking | null | undefined,
): T[] {
  const out = [...metrics];
  if (!state || state.buckets.length === 0) return out;
  const byCoin = new Map(state.buckets.map((b) => [b.coin, b]));
  // WITHIN A TIER: higher WIN RATE first (2026-10-21 operator spec — "priority
  // coins that have higher win rate"), then net R, then pair name. A coin with
  // no record has no win rate, so it sorts after ranked coins of its tier but
  // ahead of anything with a negative record.
  const key = (m: T) => {
    const coin = typeof m.pair === "string" ? m.pair.toUpperCase() : "";
    const b = byCoin.get(coin);
    return b
      ? { rank: coinPriorityRank(b.tier), winRate: b.winRate ?? -1, sumR: b.sumR, coin }
      : { rank: coinPriorityRank("neutral"), winRate: -1, sumR: 0, coin };
  };
  out.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return (
      ka.rank - kb.rank ||
      kb.winRate - ka.winRate ||
      kb.sumR - ka.sumR ||
      ka.coin.localeCompare(kb.coin)
    );
  });
  return out;
}

/**
 * Split candidates into the priority pass and the rest.
 *
 * The live tick scans BOTH lists in order, but only starts the second one when
 * the position cap still has room after the first — so a losing coin can never
 * take the last slot while a profitable coin had a signal in the same tick.
 * Unproven coins ride in the first pass: they are not known-bad, and starving
 * them would mean never learning their live record.
 */
export function splitByCoinPriority<T extends { pair?: string | null }>(
  metrics: readonly T[],
  state: CoinPriorityRanking | null | undefined,
): { preferred: T[]; rest: T[] } {
  const ordered = orderByCoinPriority(metrics, state);
  if (!state || state.buckets.length === 0) return { preferred: ordered, rest: [] };
  const byCoin = new Map(state.buckets.map((b) => [b.coin, b]));
  const preferred: T[] = [];
  const rest: T[] = [];
  for (const m of ordered) {
    const coin = typeof m.pair === "string" ? m.pair.toUpperCase() : "";
    const b = byCoin.get(coin);
    if (b && b.tier === "avoid") rest.push(m);
    else preferred.push(m);
  }
  return { preferred, rest };
}

/**
 * The LIVE veto: a coin whose paper record is negative enough to be in the
 * "avoid" tier refuses live entries when the operator arms the block.
 *
 * The tier itself is unchanged — this only says "may live trade it". Paper
 * never consults this: it is the sensor, and starving it would freeze the very
 * evidence that lets a coin climb back out of the tier.
 *
 * Fails open on: missing state, block disabled, no bucket for the coin, or a
 * coin still under the sample floor (tier neutral).
 */
export function coinPriorityBlock(
  state: CoinPriorityRanking | null | undefined,
  coin: string,
  enabled = true,
): CoinPriorityBucket | undefined {
  if (!enabled || !state || !Array.isArray(state.buckets)) return undefined;
  const key = coin.toUpperCase();
  const bucket = state.buckets.find((b) => b.coin === key);
  return bucket && bucket.tier === "avoid" ? bucket : undefined;
}

/** Human-readable veto line, in the engine's canonical `blocked — …` shape. */
export function coinPriorityReason(bucket: CoinPriorityBucket): string {
  const wr = bucket.winRate == null ? "—" : `${Math.round(bucket.winRate * 100)}%`;
  return `coin not profitable: ${bucket.coin} ${bucket.sumR.toFixed(2)}R at ${wr} WR over ${bucket.trades} paper closes`;
}

/** Human-readable one-liner for the tick summary / diagnostics. */
export function coinPriorityNote(
  bucket: Pick<CoinPriorityBucket, "coin" | "sumR" | "trades" | "tier">,
): string {
  const r = `${bucket.sumR >= 0 ? "+" : "−"}${Math.abs(bucket.sumR).toFixed(2)}R`;
  return bucket.tier === "priority"
    ? `${bucket.coin} prioritized (${r} over ${bucket.trades} paper closes)`
    : bucket.tier === "avoid"
      ? `${bucket.coin} last (${r} over ${bucket.trades} paper closes)`
      : `${bucket.coin} unproven (${bucket.trades} paper closes)`;
}
