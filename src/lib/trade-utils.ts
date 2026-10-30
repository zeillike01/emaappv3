/**
 * Shared pure trade helpers used by the trading engines (paper + live).
 *
 * Kept dependency-free so the bot's core accounting logic is unit-testable
 * without pulling in the Convex runtime.
 */

/** Latest activity time per coin: exit time when closed, entry time while open. */
export function latestTradeTimeByCoin(
  trades: Array<{ coin: string; exitTime?: number | null; entryTime?: number | null }>,
): Map<string, number> {
  const byCoin = new Map<string, number>();
  for (const t of trades) {
    const time = t.exitTime ?? t.entryTime ?? 0;
    const prev = byCoin.get(t.coin) ?? 0;
    if (time > prev) byCoin.set(t.coin, time);
  }
  return byCoin;
}

/** Opening balance for a book account: start balance + its own closed P&L. */
export function bookSeedBalance(
  startBalance: number,
  closedTrades: Array<{ pnlUsd?: number | null }>,
): number {
  return startBalance + closedTrades.reduce((s, t) => s + (t.pnlUsd ?? 0), 0);
}