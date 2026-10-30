/**
 * MARKET FETCH — default-runtime helpers that read MEXC via the Node relay.
 *
 * Default-runtime actions get 403 from MEXC's WAF on direct fetches (see
 * marketRelay.ts). Each helper here runs the matching `marketRelay` action,
 * so callers keep the same return shapes as the direct
 * `lib/mexc/mexcFetchers` functions they replace.
 *
 * FAN-OUT PACING (2026-10-21 second-pass audit). The request gate inside
 * `lib/mexc/rate-gate.ts` binds ONE action execution, and every `runAction`
 * below is a separate execution with its own gate — so an unpaced fan-out
 * (Layer 1 fires ~5 relay calls per pair, 40 pairs) would still hit MEXC as a
 * burst, which is the exact failure the gate exists to prevent. The gate here
 * lives in the CALLER's module instance, so it sees every relay call that one
 * tick makes and spaces them: 4 in flight, 125ms apart.
 *
 * Private/order calls are deliberately NOT routed through this file — execution
 * must never queue behind market data.
 */
import type { ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Kline } from "../lib/types";
import { createGate } from "../lib/mexc/rate-gate";
import type {
  fetchDepth as fetchDepthShape,
  fetchTickerRaw as tickerRawShape,
  fetchRecentTrades as fetchRecentTradesShape,
  fetchFundingRateWithStatus as fundingShape,
  fetchFundingRateHistory as fundingHistoryShape,
  fetchHtfTrend1hRaw as htfShape,
} from "../lib/mexc/mexcFetchers";

/** Per-execution gate: bounds the number of relay actions this tick fans out. */
const relayGate = createGate();

/** Queue a relay action behind the gate (see the header note). */
function pacedRelay<T>(task: () => Promise<T>): Promise<T> {
  return relayGate(task);
}

export function relayKlines(
  ctx: Pick<ActionCtx, "runAction">,
  coin: string,
  interval: string,
  bars: number,
  endMs?: number,
): Promise<Kline[]> {
  return pacedRelay(() => ctx.runAction(internal.marketRelay.klines, { coin, interval, bars, endMs }));
}

/**
 * Batched kline read (2026-10-28, action-compute opt): ONE relay action for a
 * list of series instead of one action per series.
 *
 * Same fetcher, same pacer, same bar data — only the action boundary is
 * shared, so this cannot change a signal. A failed series comes back as `null`
 * at its index and the caller falls back to its per-pair read.
 */
export function relayKlinesBatch(
  ctx: Pick<ActionCtx, "runAction">,
  requests: { coin: string; interval: string; bars: number; endMs?: number }[],
): Promise<(Kline[] | null)[]> {
  return pacedRelay(() => ctx.runAction(internal.marketRelay.klinesBatch, { requests }));
}

export function relayTickerPrice(ctx: Pick<ActionCtx, "runAction">, coin: string): Promise<number> {
  return pacedRelay(() => ctx.runAction(internal.marketRelay.tickerPrice, { coin }));
}

export function relayTicker(
  ctx: Pick<ActionCtx, "runAction">,
  coin: string,
): Promise<{ last: number; volume24: number }> {
  return pacedRelay(() => ctx.runAction(internal.marketRelay.ticker, { coin }));
}

export function relayTickerRaw(
  ctx: Pick<ActionCtx, "runAction">,
  coin: string,
): ReturnType<typeof tickerRawShape> {
  return pacedRelay(() => ctx.runAction(internal.marketRelay.tickerRaw, { coin }));
}

export async function relayAllTickers(
  ctx: Pick<ActionCtx, "runAction">,
): Promise<Map<string, { last: number; volume24: number; holdVol?: number }>> {
  const record = await pacedRelay(() => ctx.runAction(internal.marketRelay.allTickers, {}));
  return new Map(Object.entries(record));
}

export function relayDepth(
  ctx: Pick<ActionCtx, "runAction">,
  coin: string,
): ReturnType<typeof fetchDepthShape> {
  return pacedRelay(() => ctx.runAction(internal.marketRelay.depth, { coin }));
}

export function relayFundingWithStatus(
  ctx: Pick<ActionCtx, "runAction">,
  coin: string,
): ReturnType<typeof fundingShape> {
  return pacedRelay(() => ctx.runAction(internal.marketRelay.fundingWithStatus, { coin }));
}

export function relayFundingHistory(
  ctx: Pick<ActionCtx, "runAction">,
  coin: string,
  earliestMs: number,
  latestMs = Date.now(),
): ReturnType<typeof fundingHistoryShape> {
  return pacedRelay(() =>
    ctx.runAction(internal.marketRelay.fundingHistory, { coin, earliestMs, latestMs }),
  );
}

export function relayRecentTrades(
  ctx: Pick<ActionCtx, "runAction">,
  coin: string,
): ReturnType<typeof fetchRecentTradesShape> {
  return pacedRelay(() => ctx.runAction(internal.marketRelay.recentTrades, { coin }));
}

export function relayContractSize(ctx: Pick<ActionCtx, "runAction">, coin: string): Promise<number> {
  return pacedRelay(() => ctx.runAction(internal.marketRelay.contractSize, { coin }));
}

export function relayHtfRaw(
  ctx: Pick<ActionCtx, "runAction">,
  coin: string,
  tf: "1h" | "4h",
  period: number,
): Promise<NonNullable<Awaited<ReturnType<typeof htfShape>>> | null> {
  return pacedRelay(() => ctx.runAction(internal.marketRelay.htfTrendRaw, { coin, tf, period }));
}
