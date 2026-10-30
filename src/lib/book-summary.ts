/**
 * Shared closed-book analytics aggregator.
 *
 * One pure function feeds the paper and the live Advanced Data panels so the
 * session / side / reason / pair math can never drift between the two books
 * (they previously duplicated it, and the two copies disagreed on the win
 * definition). The worst-cell / worst-trade lists are rendered by the live
 * panel only (the paper panel dropped those two cards on 2026-10-23) but are
 * still computed here for both. Wins are counted as
 * (pnlUsd ?? 0) > 0 — the same definition bookStats, liveStats, and the
 * mining export use. Fees are intentionally excluded: paper rows carry
 * `totalFeesUsd`/`fundingCostUsd`, live rows carry `feesUsd`, and each panel
 * sums its own.
 *
 * Pure and unit-testable. No I/O — keep it that way.
 */

export type TradeLike = {
  coin?: string;
  type?: string;
  session?: string;
  reason?: string;
  pnlUsd?: number | null;
  realizedR?: number | null;
  entryTime?: number;
  [key: string]: unknown;
};

export type CellStats = {
  trades: number;
  wins: number;
  winRate: number;
  pnl: number;
  avgR: number;
};

export type GroupedStats = CellStats & { key: string };

/**
 * A session row also reports its long/short split: how many trades each side
 * took, and the realized PnL each side produced (fees excluded, like every
 * other PnL in this aggregator). `longPnl + shortPnl` equals the row's `pnl`.
 */
export type SessionStats = GroupedStats & {
  longs: number;
  shorts: number;
  longPnl: number;
  shortPnl: number;
};

export type SessionDirCell = CellStats & { session: string; side: string };

export type BookSummary = {
  total: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  grossWin: number;
  grossLoss: number;
  profitFactor: number;
  avgR: number;
  perSession: SessionStats[]; // by session, best PnL first (+ long/short split)
  perPair: GroupedStats[]; // by coin, best PnL first
  perReason: GroupedStats[]; // by exit reason (unsorted: caller colors buckets)
  longs: CellStats;
  shorts: CellStats;
  perSessionDirection: SessionDirCell[]; // worst PnL first (any sign)
  worstCells: SessionDirCell[]; // perSessionDirection filtered to pnl < 0
  worstTrades: TradeLike[]; // top N losers by pnlUsd (ascending)
};

const isWin = (t: TradeLike) => (t.pnlUsd ?? 0) > 0;

const avg = (vals: number[]) =>
  vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
const sum = (vals: number[]) => vals.reduce((a, b) => a + b, 0);

function cellStats(ts: TradeLike[]): CellStats {
  const wins = ts.filter(isWin).length;
  return {
    trades: ts.length,
    wins,
    winRate: ts.length ? (wins / ts.length) * 100 : 0,
    pnl: sum(ts.map((t) => t.pnlUsd ?? 0)),
    avgR: avg(ts.map((t) => t.realizedR ?? 0)),
  };
}

function groupBy(
  closed: TradeLike[],
  keyOf: (t: TradeLike) => string,
): GroupedStats[] {
  const map = new Map<string, TradeLike[]>();
  for (const t of closed) {
    const k = keyOf(t);
    const arr = map.get(k) || [];
    arr.push(t);
    map.set(k, arr);
  }
  return [...map.entries()]
    .map(([key, ts]) => ({ key, ...cellStats(ts) }))
    .sort((a, b) => b.pnl - a.pnl);
}

/**
 * Same grouping as `groupBy`, plus the session's long/short split: trade
 * counts and realized PnL per side. Side follows the book convention —
 * `type === "LONG"` is long, everything else short — so the counts always sum
 * to `trades` and the two PnL figures always sum to the row's `pnl`.
 */
function groupBySession(closed: TradeLike[]): SessionStats[] {
  const map = new Map<string, TradeLike[]>();
  for (const t of closed) {
    const k = t.session || "unknown";
    const arr = map.get(k) || [];
    arr.push(t);
    map.set(k, arr);
  }
  return [...map.entries()]
    .map(([key, ts]) => {
      const longRows = ts.filter((t) => t.type === "LONG");
      const shortRows = ts.filter((t) => t.type !== "LONG");
      return {
        key,
        ...cellStats(ts),
        longs: longRows.length,
        shorts: shortRows.length,
        longPnl: sum(longRows.map((t) => t.pnlUsd ?? 0)),
        shortPnl: sum(shortRows.map((t) => t.pnlUsd ?? 0)),
      };
    })
    .sort((a, b) => b.pnl - a.pnl);
}

/**
 * Summarize a closed-trade list. `closed` should already be filtered to
 * status === "closed" with a pnlUsd; rows without a pnlUsd are skipped.
 * Returns null when nothing is analyzable.
 */
export function summarizeBook(closed: TradeLike[], topLosers = 10): BookSummary | null {
  const rows = closed.filter((t) => t.pnlUsd != null);
  if (rows.length === 0) return null;

  const wins = rows.filter(isWin);
  const losses = rows.filter((t) => !isWin(t));
  const grossWin = sum(wins.map((t) => t.pnlUsd ?? 0));
  const grossLoss = Math.abs(sum(losses.map((t) => t.pnlUsd ?? 0)));
  const totalPnl = sum(rows.map((t) => t.pnlUsd ?? 0));

  const perSessionDirection = (() => {
    const map = new Map<string, { session: string; side: string; ts: TradeLike[] }>();
    for (const t of rows) {
      const side = t.type === "LONG" ? "LONG" : "SHORT";
      const session = t.session || "unknown";
      const k = session + "\u0000" + side;
      let cell = map.get(k);
      if (!cell) {
        cell = { session, side, ts: [] };
        map.set(k, cell);
      }
      cell.ts.push(t);
    }
    return [...map.values()]
      .map(({ session, side, ts }) => ({ session, side, ...cellStats(ts) }))
      .sort((a, b) => a.pnl - b.pnl); // worst first, any sign
  })();

  return {
    total: rows.length,
    wins: wins.length,
    losses: losses.length,
    winRate: (wins.length / rows.length) * 100,
    totalPnl,
    grossWin,
    grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    avgR: avg(rows.map((t) => t.realizedR ?? 0)),
    perSession: groupBySession(rows),
    perPair: groupBy(rows, (t) => t.coin || "?"),
    perReason: groupBy(rows, (t) => t.reason || "unknown"),
    longs: cellStats(rows.filter((t) => t.type === "LONG")),
    shorts: cellStats(rows.filter((t) => t.type !== "LONG")),
    perSessionDirection,
    worstCells: perSessionDirection.filter((c) => c.pnl < 0),
    worstTrades: [...rows].sort((a, b) => a.pnlUsd! - b.pnlUsd!).slice(0, topLosers),
  };
}
