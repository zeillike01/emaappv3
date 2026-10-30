"use node";


import { createHmac } from "node:crypto";
import { v } from "convex/values";
import { internalAction } from "./_generated/server";
const action = internalAction; // every handler in this module is internal-only
import { api as convexApi, internal } from "./_generated/api";

// The trading module historically called public ledger mutations through
// `api.liveEngine`. Keep that call syntax while routing every lifecycle write
// through Convex's internal API; public clients cannot reach these functions.
const api = convexApi as typeof convexApi & {
  liveEngine: typeof convexApi.liveEngine & typeof internal.liveEngine;
};
Object.assign(api.liveEngine, {
  patchLiveTradePnl: internal.liveEngine.patchLiveTradePnl,
  getLiveRecentClosedByExit: internal.liveEngine.getLiveRecentClosedByExit,
  setLiveMeta: internal.liveEngine.setLiveMeta,
  acquireLiveTickLock: internal.liveEngine.acquireLiveTickLock,
  releaseLiveTickLock: internal.liveEngine.releaseLiveTickLock,
  recordLiveEntry: internal.liveEngine.recordLiveEntry,
  beginLiveEntry: internal.liveEngine.beginLiveEntry,
  markLiveEntrySubmitting: internal.liveEngine.markLiveEntrySubmitting,
  markLiveEntrySubmitted: internal.liveEngine.markLiveEntrySubmitted,
  markLiveEntryIntentError: internal.liveEngine.markLiveEntryIntentError,
  claimLiveBracket: internal.liveEngine.claimLiveBracket,
  expireLiveBracketIntent: internal.liveEngine.expireLiveBracketIntent,
  markLiveBracketAttached: internal.liveEngine.markLiveBracketAttached,
  markLiveBracketFailed: internal.liveEngine.markLiveBracketFailed,
  claimLiveClose: internal.liveEngine.claimLiveClose,
  markLiveCloseSubmitted: internal.liveEngine.markLiveCloseSubmitted,
  markLiveCloseUnresolved: internal.liveEngine.markLiveCloseUnresolved,
  markLiveCloseFailed: internal.liveEngine.markLiveCloseFailed,
  updateLiveEnrichment: internal.liveEngine.updateLiveEnrichment,
  refineLiveEntry: internal.liveEngine.refineLiveEntry,
  setLiveExchangeStop: internal.liveEngine.setLiveExchangeStop,
  setLiveBracketBreach: internal.liveEngine.setLiveBracketBreach,
  setLiveTrailState: internal.liveEngine.setLiveTrailState,
  markLiveClosed: internal.liveEngine.markLiveClosed,
  patchLiveCloseAnalytics: internal.liveEngine.patchLiveCloseAnalytics,
  repairLiveCloseAnalytics: internal.liveEngine.repairLiveCloseAnalytics,
});
import { LIVE_DEFAULT_MAX_OPEN_POSITIONS, LIVE_DEFAULT_RISK_PCT } from "./liveEngine";
import { fetchKlines, fetchHtfTrend1hRaw, fetchHtfTrend4hRaw, htfVerdictOf, fetchTickerPrice, fetchAllTickers } from "../lib/mexc/mexcFetchers";
import { computeAtrPct } from "../lib/mexc/indicators";
import { newestClosedBarOpen } from "./htfCache";
import {
  btcDownBlockSkipsScan,
  btcRegimeBlocks,
  btcRegimeDownBlocks,
  type BtcRegime,
} from "../lib/btc-regime";
import { rLockEnabled, rLockStep, lockRFromPrice } from "../lib/r-lock";
import { clampRiskPct } from "../lib/costs";
import { contractMetaFull } from "../lib/contract-meta";
import { entryGuardBlock, riskPctUnset, type ContractMeta } from "../lib/entry-guards";
import { getBtcRegimeCached } from "./btcRegimeCache";
import { evalShadowTags, extAtrApprox, h4GateBlocks, PULLBACK_EXT_ATR, rsi7FromCloses } from "../lib/h4-shadow";
import { scheduleExecRecord } from "./executionRecord";
import { d1ShadowTags } from "../lib/d1-shadow";
import { ltf5mGateBlocks, ltf5mShadowTag } from "../lib/ltf5m";
import { getH4ShadowCached } from "./h4ShadowCache";
import { getD1ShadowCached } from "./d1ShadowCache";
import { buildTradeEnrichment } from "./paperTrading";
import { estimateBtcBeta, netBtcBeta, signedBeta, betaCapBlocks, BTC_BETA_FALLBACK } from "../lib/btc-beta";
import { resolveSignalBarTime, validateKlines } from "../lib/strategy-utils";
import { resolveConfig, computeLayer2Signal, resolveFundingRate, evaluateChaseGuard, mergePendingSignal, type PendingSignal } from "../lib/layer2-signal";
import { hydratePendingAnchors, describePendingDrops } from "../lib/pending-session";
import {
  sessionBreakerBlock,
  sessionBreakerReason,
  sessionScanVerdict,
  type SessionBreakerBucket,
} from "../lib/session-breaker";
import {
  coinPriorityBlock,
  coinPriorityReason,
  orderByCoinPriority,
  splitByCoinPriority,
} from "../lib/coin-priority";
import { computeOrderSize, expectedExitPrice, estimateExit, expectedMarketExitPrice, recordLiveCloseWrite, maxSafeLeverage, dealSidesFor, matchLiveDealVolume, matchPositionEntry, nameExitFromFill, LIVE_TAKER_FEE } from "../lib/live-math";
import { advisorShadowTags, advisorVetoForMode } from "../lib/htf-advisor";
import { computeLiveBreakerState, shouldRearmOnSession, withRearmNote } from "../lib/live-breaker";
import { toMexcSymbol, fromMexcSymbol, isLiveTradable } from "../lib/tracked-pairs";
const MEXC_HOST = "https://contract.mexc.com";
const COOLDOWN_MS = 60 * 60_000; // 1h cooldown between entries per pair (same as paper)
const STALE_METRICS_MAX_AGE_MS = 8 * 60_000; // same freshness gate as strategyEngine
const PARALLEL_BATCH_SIZE = 6;
const EMA_KLINE_BARS = 400;
const EMA_MIN_BARS = 60;
const TICK_LEASE_MS = 25 * 60_000; // run guard
const ADVISOR_MAX_AGE_MS = 5 * 60 * 60 * 1000;
export const BRACKET_BACKSTOP_MS = 10 * 60_000;
// How long an unresolved bracket claim may fence a retry (2026-09-24).
// A claim exists to stop two passes placing two stops for one position, which is
// only a risk while the request it fences could still be resolved. MEXC requests
// time out in seconds, so this is many times the lifetime of any in-flight
// place — and it is only ever acted on AFTER the exchange's stop-order book has
// been read and shows no resting bracket for the position (a bracket that did
// land is adopted first). Without a bound, one cut reply or one process death
// between claim and place left a REAL position with no stop at all, forever.
export const BRACKET_INTENT_STALE_MS = 15 * 60_000;
// HARD CEILING on ONE private (signed) MEXC request — the third-pass audit's
// finding. Every private call funnels through privateRequest (19 call sites:
// balance, open positions, order create/close, order history, TP/SL attach,
// cancel, amend), and NONE of them had a timeout: the public market reads are
// bounded by the pacer's AbortSignal.timeout, the real-money rail was not. A
// connection that never answers therefore held the whole tick — an exit pass
// that could not reach its own "open positions fetch failed" branch, and an
// entry pass stuck before its summary write, both until the platform killed the
// action. 15s is ~5x the slowest observed kline call (3.1s) and still ends
// inside a tick's slot. An aborted request is AMBIGUOUS (the order may have
// reached MEXC), which is exactly how the catch below already classifies every
// network failure — the durable intent ids make the retry safe.
export const PRIVATE_REQUEST_TIMEOUT_MS = 15_000;

function creds(): { key: string; secret: string } | null {
  const key = process.env.MEXC_API_KEY;
  const secret = process.env.MEXC_API_SECRET;
  return key && secret ? { key, secret } : null;
}


class MexcRequestError extends Error {
  readonly ambiguous: boolean;
  readonly httpStatus?: number;
  readonly code?: string | number;

  constructor(
    message: string,
    opts: { ambiguous?: boolean; httpStatus?: number; code?: string | number } = {},
  ) {
    super(message);
    this.name = "MexcRequestError";
    this.ambiguous = opts.ambiguous === true;
    this.httpStatus = opts.httpStatus;
    this.code = opts.code;
  }
}

export function isDefinitiveMexcError(error: unknown): boolean {
  return error instanceof MexcRequestError && !error.ambiguous;
}

export async function privateRequest(
  method: "GET" | "POST",
  path: string,
  body?: Record<string, unknown>,
): Promise<any> {
  const c = creds();
  if (!c) throw new Error("MEXC credentials missing (set MEXC_API_KEY + MEXC_API_SECRET)");
  if (method === "POST" && path.endsWith("/order/create") && body && (body.side === 2 || body.side === 4) && !body.externalOid) {
    throw new MexcRequestError("unfenced live close rejected: durable close intent required", {
      ambiguous: false,
    });
  }
  const reqTime = String(Date.now());
  let paramString = "";
  let url = `${MEXC_HOST}${path}`;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (method === "POST") {
    paramString = JSON.stringify(body ?? {}); // exact body string is signed
  } else if (body && Object.keys(body).length > 0) {
    const qs = Object.keys(body)
      .sort()
      .map((k) => `${k}=${encodeURIComponent(String((body as any)[k]))}`)
      .join("&");
    url += `?${qs}`;
    paramString = qs;
  }
  const signInput = c.key + reqTime + paramString;
  const signature = createHmac("sha256", c.secret).update(signInput).digest("hex");
  headers["ApiKey"] = c.key;
  headers["Request-Time"] = reqTime;
  headers["Signature"] = signature;
  headers["Recv-Window"] = "30";

  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: method === "POST" ? (body ? JSON.stringify(body) : undefined) : undefined,
      // Bounded request (2026-10-21 third pass). The body read sits inside the
      // same try because a stalled body is the same hang as a stalled connect,
      // and an abort there rejects `res.text()` rather than `fetch`.
      signal: AbortSignal.timeout(PRIVATE_REQUEST_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (e: any) {
    // Timeouts and resets are indistinguishable from MEXC's side, so the caller
    // must reconcile before retrying — never assume the order did not land.
    throw new MexcRequestError(
      `MEXC ${method} ${path} network failure after ${PRIVATE_REQUEST_TIMEOUT_MS / 1000}s: ${e?.message ?? e}`,
      { ambiguous: true },
    );
  }
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new MexcRequestError(
      `MEXC ${method} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`,
      { ambiguous: res.status >= 500, httpStatus: res.status },
    );
  }
  if (!res.ok) {
    throw new MexcRequestError(
      `MEXC ${method} ${path} → HTTP ${res.status}: ${json?.message ?? text.slice(0, 300)}`,
      { ambiguous: res.status >= 500, httpStatus: res.status, code: json?.code },
    );
  }
  if (json?.success === false) {
    throw new MexcRequestError(
      `MEXC ${path} error ${json.code ?? "?"}: ${json.message ?? JSON.stringify(json).slice(0, 200)}`,
      { ambiguous: false, httpStatus: res.status, code: json.code },
    );
  }
  return json?.data;
}

export async function fetchOrderStatus(orderId: string | number): Promise<any | null> {
  if (orderId == null || String(orderId).length === 0) return null;
  try {
    return await privateRequest(
      "GET",
      `/api/v1/private/order/get/${encodeURIComponent(String(orderId))}`,
    );
  } catch {
    return null;
  }
}

export type MexcOrderState = 1 | 2 | 3 | 4 | 5;
export function orderStateOf(order: any): MexcOrderState | null {
  const n = Number(order?.state ?? order?.status);
  return n === 1 || n === 2 || n === 3 || n === 4 || n === 5 ? n : null;
}

export async function inspectOrder(
  orderId: string | number | null | undefined,
  coin: string,
  externalOid: string,
  sinceMs: number,
): Promise<{ order: any | null; source: "id" | "externalOid" | "none"; error?: string; ambiguous: boolean }> {
  try {
    if (orderId != null && String(orderId).length > 0) {
      const data: any = await privateRequest(
        "GET",
        `/api/v1/private/order/get/${encodeURIComponent(String(orderId))}`,
      );
      if (data != null) return { order: data, source: "id", ambiguous: false };
    }
    const data: any = await privateRequest("GET", "/api/v1/private/order/list/history_orders", {
      symbol: toMexcSymbol(coin),
      states: "1,2,3,4,5",
      start_time: Math.max(0, sinceMs - 60_000),
      end_time: Date.now(),
      page_num: 1,
      page_size: 100,
    });
    const rows: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.resultList)
        ? data.resultList
        : [];
    const order = rows.find((row) => {
      const value = String(row?.externalOid ?? "");
      return value === externalOid || value.endsWith(externalOid);
    });
    return { order: order ?? null, source: order ? "externalOid" : "none", ambiguous: false };
  } catch (e: any) {
    return {
      order: null,
      source: "none",
      error: e?.message ?? String(e),
      ambiguous: !isDefinitiveMexcError(e),
    };
  }
}

export async function findOrderByExternalOid(
  coin: string,
  externalOid: string,
  sinceMs: number,
): Promise<any | null> {
  try {
    const data: any = await privateRequest("GET", "/api/v1/private/order/list/history_orders", {
      symbol: toMexcSymbol(coin),
      states: "1,2,3,4,5",
      start_time: Math.max(0, sinceMs - 60_000),
      end_time: Date.now(),
      page_num: 1,
      page_size: 100,
    });
    const rows: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.resultList)
        ? data.resultList
        : [];
    return rows.find((row) => {
      const value = String(row?.externalOid ?? "");
      return value === externalOid || value.endsWith(externalOid);
    }) ?? null;
  } catch {
    return null;
  }
}

export async function fetchOpenStopOrders(
  coin: string,
  positionId?: string | number | null,
): Promise<any[]> {
  try {
    const data: any = await privateRequest("GET", "/api/v1/private/stoporder/list/orders", {
      symbol: toMexcSymbol(coin),
      is_finished: 0,
      page_num: 1,
      page_size: 100,
    });
    const rows: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.resultList)
        ? data.resultList
        : [];
    return rows.filter(
      (row) =>
        Number(row?.state) === 1 &&
        (positionId == null || String(row?.positionId ?? "") === String(positionId)),
    );
  } catch {
    return [];
  }
}

export async function fetchRecentDeals(
  coin: string,
  sinceMs: number,
): Promise<Array<{ side: number; vol: number; price: number; profit: number; fee: number; ts: number }>> {
  const rows: any = await privateRequest(
    "GET",
    "/api/v1/private/order/list/order_deals/v3",
    {
      symbol: toMexcSymbol(coin),
      start_time: sinceMs,
      end_time: Date.now(),
      page_num: 1,
      page_size: 200,
    },
  );
  const list: any[] = Array.isArray(rows)
    ? rows
    : Array.isArray(rows?.resultList)
      ? rows.resultList
      : [];
  return list.map((d: any) => ({
    side: Number(d.side),
    vol: Number(d.vol),
    price: Number(d.price),
    profit: Number(d.profit ?? 0),
    fee: Number(d.fee ?? 0),
    ts: Number(d.timestamp ?? 0),
  }));
}

export async function reconstructClosedPnl(
  trade: {
    coin: string;
    type: string;
    entryTime: number;
    entryPrice: number;
    volContracts: number;
    notionalUsd: number;
    slPrice: number;
  },
): Promise<{
  pnlUsd: number;
  realizedR: number;
  feesUsd: number;
  openFeesUsd: number;
  closeFeesUsd: number;
  exitPrice: number;
} | null> {
  try {
    const sides = dealSidesFor(trade.type === "LONG" ? "LONG" : "SHORT");
    const all = await fetchRecentDeals(trade.coin, Math.max(0, trade.entryTime));
    const closeMatches = matchLiveDealVolume(all, {
      side: sides.close,
      entryTime: trade.entryTime,
      volContracts: trade.volContracts,
    });
    if (!closeMatches.length) return null;
    let pnl = 0;
    let closeFeesUsd = 0;
    let volPxVw = 0;
    let volSum = 0;
    for (const { deal, vol: take } of closeMatches) {
      const frac = deal.vol > 0 ? take / deal.vol : 1;
      pnl += deal.profit * frac;
      closeFeesUsd += deal.fee * frac;
      volPxVw += deal.price * take;
      volSum += take;
    }
    if (volSum <= 0) return null;
    const exitPrice = volPxVw / volSum;

    const openMatches = matchLiveDealVolume(all, {
      side: sides.open,
      entryTime: trade.entryTime,
      volContracts: trade.volContracts,
    });
    let openVol = 0;
    let openFeesUsd = 0;
    for (const { deal, vol: take } of openMatches) {
      const frac = deal.vol > 0 ? take / deal.vol : 1;
      openFeesUsd += deal.fee * frac;
      openVol += take;
    }
    const missingOpenVol = Math.max(0, trade.volContracts - openVol);
    if (missingOpenVol > 0) {
      const px = trade.entryPrice > 0 ? trade.entryPrice : exitPrice;
      openFeesUsd += missingOpenVol * px * LIVE_TAKER_FEE;
    }
    const feesUsd = openFeesUsd + closeFeesUsd;
    const slDist = Math.abs(trade.entryPrice - trade.slPrice);
    let riskUsd = 0;
    if (slDist > 0) {
      try {
        const meta = await contractMeta(trade.coin);
        riskUsd = volSum * meta.contractSize * slDist;
      } catch {
        riskUsd = 0;
      }
    }
    if (!(riskUsd > 0)) riskUsd = trade.notionalUsd * 0.02;
    const realizedR = riskUsd > 0 ? pnl / riskUsd : 0;
    return { pnlUsd: pnl, realizedR, feesUsd, openFeesUsd, closeFeesUsd, exitPrice };
  } catch {
    return null;
  }
}

export const backfillLivePnlFromDeals = internalAction({
  args: {},
  handler: async (ctx): Promise<{ scanned: number; patched: number; skipped: number; lines: string[] }> => {
    const trades: any[] = await ctx.runQuery(api.liveEngine.getLiveTradesRaw);
    const targets = trades.filter(
      (t: any) => t.status === "closed" && (t.pnlUsd === undefined || t.pnlUsd === null)
    );
    const lines: string[] = [];
    let patched = 0;
    let skipped = 0;
    for (const t of targets) {
      const closeSide = t.type === "LONG" ? 4 : 2;
      let rawDeals: Awaited<ReturnType<typeof fetchRecentDeals>> = [];
      try {
        rawDeals = await fetchRecentDeals(t.coin, Math.max(0, t.entryTime));
      } catch (e: any) {
        lines.push(`${t.coin}: deal fetch failed (${e?.message ?? "?"})`);
        skipped++;
        continue;
      }
      if (rawDeals.length === 0) {
        lines.push(
          `${t.coin}: no deals in window at all (entry ${new Date(t.entryTime).toISOString().slice(0, 16)} · side wanted ${closeSide})`
        );
        skipped++;
        continue;
      }
      const closeMatches = matchLiveDealVolume(rawDeals, {
        side: closeSide,
        entryTime: t.entryTime,
        volContracts: t.volContracts ?? 0,
      });
      if (!closeMatches.length) {
        const sides = [...new Set(rawDeals.map((d) => d.side))].sort().join(",");
        lines.push(
          `${t.coin}: ${rawDeals.length} fills but none belonged to this entry on side ${closeSide} (sides=[${sides}])`
        );
        skipped++;
        continue;
      }
      let pnl = 0;
      let fees = 0;
      let volPxVw = 0;
      let volSum = 0;
      for (const { deal, vol: take } of closeMatches) {
        const frac = deal.vol > 0 ? take / deal.vol : 1;
        pnl += deal.profit * frac;
        fees += deal.fee * frac;
        volPxVw += deal.price * take;
        volSum += take;
      }
      const openSide = dealSidesFor(t.type === "LONG" ? "LONG" : "SHORT").open;
      const openMatches = matchLiveDealVolume(rawDeals, {
        side: openSide,
        entryTime: t.entryTime,
        volContracts: t.volContracts ?? 0,
      });
      let openVol = 0;
      for (const { deal, vol: take } of openMatches) {
        const frac = deal.vol > 0 ? take / deal.vol : 1;
        fees += deal.fee * frac;
        openVol += take;
      }
      const missingOpenVol = Math.max(0, (t.volContracts ?? 0) - openVol);
      if (missingOpenVol > 0) {
        const px = t.entryPrice > 0 ? t.entryPrice : volPxVw / Math.max(volSum, Number.EPSILON);
        fees += missingOpenVol * px * LIVE_TAKER_FEE;
      }
      if (volSum <= 0) {
        lines.push(`${t.coin}: fill volume mismatch (${volSum} vs ${t.volContracts}) — skipped`);
        skipped++;
        continue;
      }
      const exitPrice = volPxVw / volSum;
      const slDist = Math.abs((t.entryPrice ?? 0) - (t.slPrice ?? 0));
      const notional = t.notionalUsd ?? volSum * exitPrice;
      const riskUsd = slDist > 0 ? notional * (slDist / (t.entryPrice || 1)) : notional * 0.02;
      const realizedR = riskUsd > 0 ? pnl / riskUsd : 0;
      await ctx.runMutation(api.liveEngine.patchLiveTradePnl, {
        id: t._id,
        exitPrice,
        pnlUsd: pnl,
        realizedR,
        feesUsd: fees,
      });
      patched++;
      lines.push(
        `${t.coin.padEnd(6)} ${t.type.padEnd(5)} pnl ${pnl >= 0 ? "+" : "−"}$${Math.abs(pnl).toFixed(2)}  R=${realizedR.toFixed(2)}  exit≈${exitPrice.toFixed(4)} (${volSum} contracts)`
      );
    }
    return { scanned: targets.length, patched, skipped, lines };
  },
});


/**
 * Exit-path metadata: legacy fallbacks kept so an open position can always be
 * closed. ENTRIES must use contractMetaFull and skip when `missing` is set.
 */
export async function contractMeta(coin: string): Promise<ContractMeta> {
  return (await contractMetaFull(coin)).meta;
}

async function fetchAssets(): Promise<{
  balanceUsd: number;
  walletBalanceUsd: number;
  currencies: string[];
}> {
  const data = (await privateRequest("GET", "/api/v1/private/account/assets")) ?? [];
  const rows: any[] = Array.isArray(data) ? data : [data];
  const usdt = rows.find(
    (r: any) => String(r?.currency ?? r?.coin ?? "").toUpperCase() === "USDT",
  );
  const num = (x: any) => (x == null || isNaN(Number(x)) ? 0 : Number(x));
  const equity = usdt ? num(usdt.equity) : 0;
  const avail = usdt ? num(usdt.availableBalance) : 0;
  const margin = usdt ? num(usdt.positionMargin) : 0;
  const wallet = equity > 0 ? equity : avail + margin;
  const balance = wallet > 0 ? wallet : avail + margin;
  const currencies = rows
    .map((r: any) => String(r?.currency ?? ""))
    .filter(Boolean)
    .slice(0, 30);
  return { balanceUsd: balance, walletBalanceUsd: wallet, currencies };
}

export async function fetchOpenPositions(): Promise<
  Map<string, { vol: number; avgPrice: number; positionId: string | number | null }>
> {
  const data = (await privateRequest("GET", "/api/v1/private/position/open_positions")) ?? [];
  const rows: any[] = Array.isArray(data) ? data : [data];
  const map = new Map<string, { vol: number; avgPrice: number; positionId: string | number | null }>();
  for (const r of rows) {
    const symbol = String(r?.symbol ?? "");
    if (!symbol) continue;
    const vol = Number(r?.holdVol ?? r?.vol ?? r?.volume ?? r?.positionVol ?? 0);
    if (!(vol > 0)) continue;
    const sideNum = Number(r?.side ?? r?.positionType ?? 0);
    const avgPrice = Number(
      r?.holdAvgPrice ?? r?.openAvgPrice ?? r?.holdAvgPriceFullyScale ?? r?.avgPrice ?? r?.averagePrice ?? 0,
    );
    const positionId = r?.positionId ?? r?.id ?? null;
    map.set(`${symbol}_${sideNum}`, { vol, avgPrice, positionId });
    if (sideNum !== 1 && sideNum !== 2) map.set(`${symbol}_0`, { vol, avgPrice, positionId });
  }
  return map;
}

export function stopOrderMatchesPosition(row: any, positionId: string | number | null | undefined): boolean {
  if (positionId == null) return true;
  return String(row?.positionId ?? "") === String(positionId);
}

export async function inspectOpenStopOrders(
  coin: string,
  positionId?: string | number | null,
): Promise<{ rows: any[]; ambiguous: boolean; error?: string }> {
  try {
    const data: any = await privateRequest("GET", "/api/v1/private/stoporder/list/orders", {
      symbol: toMexcSymbol(coin),
      is_finished: 0,
      page_num: 1,
      page_size: 100,
    });
    const all: any[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.resultList)
        ? data.resultList
        : [];
    return {
      rows: all.filter(
        (row) => Number(row?.state) === 1 && stopOrderMatchesPosition(row, positionId),
      ),
      ambiguous: false,
    };
  } catch (e: any) {
    return { rows: [], ambiguous: !isDefinitiveMexcError(e), error: e?.message ?? String(e) };
  }
}

export async function findOpenStopOrder(
  coin: string,
  positionId: string | number | null | undefined,
): Promise<any | null> {
  const inspected = await inspectOpenStopOrders(coin, positionId);
  return inspected.rows[0] ?? null;
}

export type LiveCloseSubmitResult = {
  sent: boolean;
  intentId?: string;
  orderId?: string;
  writeState: "recorded" | "already-closed" | "write-failed" | "not-claimed" | "submitted" | "pending";
  error?: string;
  ambiguous?: boolean;
  ledgerSubmitted: boolean;
};

async function settleCloseIntent(args: {
  ctx: any;
  trade: any;
  intentId: string;
  orderId?: string;
  reason: string;
  expectedExit: number;
  exitTime: number;
  fallbackPnl: number;
  fallbackR: number;
  fallbackFees: number;
}): Promise<LiveCloseSubmitResult> {
  const inspected = await inspectOrder(
    args.orderId,
    args.trade.coin,
    args.intentId,
    Number(args.trade.entryTime ?? Date.now()) - 60_000,
  );
  const order = inspected.order;
  const state = orderStateOf(order);
  if (state === 4 || state === 5) {
    await args.ctx.runMutation(api.liveEngine.markLiveCloseFailed, {
      id: args.trade._id,
      intentId: args.intentId,
      error: `MEXC close order ${state === 4 ? "cancelled" : "invalid"}`,
      definitive: true,
    }).catch(() => {});
    return {
      sent: true,
      intentId: args.intentId,
      orderId: args.orderId,
      writeState: "pending",
      error: "close order definitively rejected",
      ledgerSubmitted: true,
    };
  }

  let positions: Awaited<ReturnType<typeof fetchOpenPositions>> | null = null;
  let positionsOk = true;
  try {
    positions = await fetchOpenPositions();
  } catch {
    positionsOk = false;
  }
  const side: "LONG" | "SHORT" = args.trade.type === "LONG" ? "LONG" : "SHORT";
  const sym = toMexcSymbol(args.trade.coin);
  const position = positions ? matchPositionEntry(positions, sym, side === "LONG" ? 1 : 2) : null;
  const fill = orderFill(order);
  const requested = Number(args.trade.closeRequestedVol ?? args.trade.volContracts);
  const fullFill = !!fill && fill.vol + 1e-8 >= requested;
  const absentAfterSuccessfulFetch = positionsOk && !position;

  if (state === 3 && fill && (fullFill || absentAfterSuccessfulFetch)) {
    const recon = await reconstructClosedPnl({
      coin: args.trade.coin,
      type: args.trade.type,
      entryTime: args.trade.entryTime,
      entryPrice: args.trade.entryPrice,
      volContracts: requested,
      notionalUsd: args.trade.notionalUsd,
      slPrice: args.trade.slPrice,
    });
    const exitPrice = recon?.exitPrice ?? fill.price;
    const closeRatio = args.trade.volContracts > 0 ? Math.min(1, requested / args.trade.volContracts) : 1;
    const estimate = estimateExit({
      notionalUsd: (args.trade.notionalUsd ?? 0) * closeRatio,
      entryPrice: position?.avgPrice ?? args.trade.entryPrice,
      exitPrice,
      side,
      slPrice: args.trade.slPrice,
    });
    const writeState = await recordLiveCloseWrite(() =>
      args.ctx.runMutation(api.liveEngine.markLiveClosed, {
        id: args.trade._id,
        exitPrice,
        exitTime: args.exitTime,
        reason: args.reason,
        pnlUsd: recon?.pnlUsd ?? estimate.pnlUsd ?? args.fallbackPnl,
        realizedR: recon?.realizedR ?? estimate.realizedR ?? args.fallbackR,
        feesUsd: recon?.feesUsd ?? estimate.fees ?? args.fallbackFees,
        exitOrderId: args.orderId,
        closeIntentId: args.intentId,
      }),
    );
    return { sent: true, intentId: args.intentId, orderId: args.orderId, writeState, ledgerSubmitted: true };
  }

  if (absentAfterSuccessfulFetch && state !== 1 && state !== 2) {
    const recon = await reconstructClosedPnl({
      coin: args.trade.coin,
      type: args.trade.type,
      entryTime: args.trade.entryTime,
      entryPrice: args.trade.entryPrice,
      volContracts: requested,
      notionalUsd: args.trade.notionalUsd,
      slPrice: args.trade.slPrice,
    });
    if (recon) {
      const writeState = await recordLiveCloseWrite(() =>
        args.ctx.runMutation(api.liveEngine.markLiveClosed, {
          id: args.trade._id,
          exitPrice: recon.exitPrice,
          exitTime: args.exitTime,
          reason: args.reason,
          pnlUsd: recon.pnlUsd,
          realizedR: recon.realizedR,
          feesUsd: recon.feesUsd,
          exitOrderId: args.orderId,
          closeIntentId: args.intentId,
        }),
      );
      return { sent: true, intentId: args.intentId, orderId: args.orderId, writeState, ledgerSubmitted: true };
    }
  }

  return {
    sent: true,
    intentId: args.intentId,
    orderId: args.orderId,
    writeState: "submitted",
    error: inspected.ambiguous ? inspected.error : "close accepted; fill not confirmed yet",
    ambiguous: inspected.ambiguous,
    ledgerSubmitted: true,
  };
}

export async function reconcileLiveCloseIntents(ctx: any): Promise<{
  checked: number;
  settled: number;
  pending: number;
  failed: number;
  results: string[];
}> {
  const trades: any[] = await ctx.runQuery(api.liveEngine.getLiveOpenTrades);
  const active = trades.filter((t: any) =>
    ["pending", "submitted", "unknown", "settling"].includes(String(t.closeIntentStatus)),
  );
  const summary = { checked: active.length, settled: 0, pending: 0, failed: 0, results: [] as string[] };
  for (const trade of active) {
    const intentId = typeof trade.closeIntentId === "string" ? trade.closeIntentId.trim() : "";
    const requestedVol = Number(trade.closeRequestedVol);
    if (!intentId || !Number.isFinite(requestedVol) || !(requestedVol > 0)) {
      const detail = !intentId
        ? "active close record has no durable closeIntentId"
        : `active close record has invalid requested volume ${trade.closeRequestedVol}`;
      await ctx
        .runMutation(api.liveEngine.markLiveCloseUnresolved, { id: trade._id, error: detail })
        .catch(() => {});
      summary.pending++;
      summary.results.push(`${trade.coin}: close intent unresolved — ${detail}; retry fenced`);
      continue;
    }
    const result = await settleCloseIntent({
      ctx,
      trade,
      intentId,
      orderId: trade.exitOrderId,
      reason: trade.closeReason ?? "Close reconciliation",
      expectedExit: trade.closeExpectedPrice ?? trade.entryPrice,
      exitTime: trade.closeExpectedExitTime ?? Date.now(),
      fallbackPnl: trade.closePnlUsd ?? 0,
      fallbackR: trade.closeRealizedR ?? 0,
      fallbackFees: trade.closeFeesUsd ?? 0,
    });
    if (result.writeState === "recorded") summary.settled++;
    else if (result.writeState === "pending" && result.error?.includes("rejected")) summary.failed++;
    else summary.pending++;
    if (result.error) summary.results.push(`${trade.coin}: close intent ${result.writeState}${result.error ? ` — ${result.error}` : ""}`);
  }
  return summary;
}

export async function submitLiveMarketClose(args: {
  ctx: any;
  trade: any;
  symbol: string;
  side: "LONG" | "SHORT";
  closeVol: number;
  reason: string;
  expectedExit: number;
  exitTime: number;
  pnlUsd: number;
  realizedR: number;
  feesUsd: number;
}): Promise<LiveCloseSubmitResult> {
  const claim: any = await args.ctx.runMutation(api.liveEngine.claimLiveClose, {
    id: args.trade._id,
    reason: args.reason,
    requestedVol: args.closeVol,
    expectedPrice: args.expectedExit,
    exitTime: args.exitTime,
    pnlUsd: args.pnlUsd,
    realizedR: args.realizedR,
    feesUsd: args.feesUsd,
  });
  if (!claim?.claimed) {
    return {
      sent: false,
      intentId: claim?.intentId,
      writeState: "not-claimed",
      error: claim?.reason ?? "close-not-claimed",
      ledgerSubmitted: false,
    };
  }

  let closeRes: any;
  try {
    closeRes = await privateRequest("POST", "/api/v1/private/order/create", {
      symbol: args.symbol,
      price: 0,
      vol: args.closeVol,
      side: args.side === "LONG" ? 4 : 2,
      type: 5,
      openType: 1,
      externalOid: claim.intentId,
    });
  } catch (e: any) {
    const definitive = isDefinitiveMexcError(e);
    await args.ctx
      .runMutation(api.liveEngine.markLiveCloseFailed, {
        id: args.trade._id,
        intentId: claim.intentId,
        error: e?.message ?? String(e),
        definitive,
      })
      .catch(() => {});
    return {
      sent: false,
      intentId: claim.intentId,
      writeState: "not-claimed",
      error: e?.message ?? String(e),
      ambiguous: !definitive,
      ledgerSubmitted: false,
    };
  }

  const orderId = String(closeRes?.orderId ?? "") || undefined;
  let ledgerSubmitted = true;
  try {
    const ack: any = await args.ctx.runMutation(api.liveEngine.markLiveCloseSubmitted, {
      id: args.trade._id,
      intentId: claim.intentId,
      orderId,
    });
    ledgerSubmitted = ack?.ok === true;
  } catch {
    ledgerSubmitted = false;
  }

  if (!ledgerSubmitted) {
    return {
      sent: true,
      intentId: claim.intentId,
      orderId,
      writeState: "pending",
      error: "close order accepted but ledger acknowledgement is pending",
      ambiguous: true,
      ledgerSubmitted: false,
    };
  }

  const settled = await settleCloseIntent({
    ctx: args.ctx,
    trade: { ...args.trade, closeRequestedVol: args.closeVol },
    intentId: claim.intentId,
    orderId,
    reason: args.reason,
    expectedExit: args.expectedExit,
    exitTime: args.exitTime,
    fallbackPnl: args.pnlUsd,
    fallbackR: args.realizedR,
    fallbackFees: args.feesUsd,
  });
  return settled;
}


const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function roundPrice(px: number, unit: number): number {
  if (!(unit > 0)) return px;
  const f = Math.round(1 / unit);
  return Math.round(px * f) / f;
}

export async function attachBracket(args: {
  pair: string;
  positionId: string | number | null;
  vol: number;
  slPrice: number;
  tpPrice: number;
  priceUnit: number;
  intentId?: string;
}): Promise<{ ok: boolean; error?: string; ambiguous?: boolean; slPrice?: number; tpPrice?: number }> {
  if (!args.intentId) {
    return { ok: false, error: "bracket placement requires a durable intent claim", ambiguous: false };
  }
  if (args.positionId == null) {
    return { ok: false, error: "no positionId on position row", ambiguous: false };
  }
  const slPrice = roundPrice(args.slPrice, args.priceUnit);
  const tpPrice = roundPrice(args.tpPrice, args.priceUnit);
  const existing = await inspectOpenStopOrders(args.pair, args.positionId);
  if (existing.ambiguous) {
    return { ok: false, error: existing.error ?? "stop-order query unresolved", ambiguous: true };
  }
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    const existingSl = Number(row?.stopLossPrice ?? row?.stopLoss ?? row?.slPrice);
    const existingTp = Number(row?.takeProfitPrice ?? row?.takeProfit ?? row?.tpPrice);
    return {
      ok: true,
      slPrice: existingSl > 0 ? existingSl : slPrice,
      tpPrice: existingTp > 0 ? existingTp : tpPrice,
    };
  }
  try {
    await privateRequest("POST", "/api/v1/private/stoporder/place", {
      positionId: args.positionId,
      vol: args.vol,
      lossTrend: 1,
      profitTrend: 1,
      priceProtect: 0,
      stopLossPrice: slPrice,
      takeProfitPrice: tpPrice,
    });
    return { ok: true, slPrice, tpPrice };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message ?? String(e),
      ambiguous: !isDefinitiveMexcError(e),
    };
  }
}

/**
 * MOVE the exchange stop to a new level — R-LOCK STOP AMEND (2026-09-26).
 *
 * The ledger ratcheted `trailLockPrice`, but the exchange bracket stayed at the
 * ORIGINAL −1R stop, so a retracing winner was stopped at −1R with a banked rung
 * sitting unused in the ledger. This replaces the resting stop so the exchange
 * (sub-second trigger) owns each banked rung.
 *
 * MEXC has no amend endpoint for stop orders, so the operation is
 * CANCEL-THEN-PLACE at the new (TIGHTER) level, with a re-inspection between
 * the two steps:
 *   1. re-read the stop book; if the previous orderId is gone, the stop is
 *      ALREADY at/above our target or was consumed — re-adopt, no placement;
 *   2. cancel the old stop (idempotent: an already-filled/canceled order
 *      errors definitively and the re-inspection in step 3 decides);
 *   3. re-inspect; place the new stop ONLY when the book is verifiably empty
 *      for this position, so a half-executed amend can never leave TWO stops.
 * If the place fails ambiguously, the function reports it and the caller
 * retries on the next 5-minute pass — the worst case is the OLD stop staying
 * live one more cycle (the pre-fix behaviour), never a naked position.
 */
export async function replaceStopOrder(args: {
  pair: string;
  positionId: string | number | null;
  vol: number;
  oldSlPrice: number;
  newSlPrice: number;
  newTpPrice: number | null;
  priceUnit: number;
  intentId?: string;
}): Promise<{
  ok: boolean;
  error?: string;
  ambiguous?: boolean;
  slPrice?: number;
  tpPrice?: number;
  skipped?: "already-moved";
}> {
  if (args.positionId == null) {
    return { ok: false, error: "no positionId on position row" };
  }
  if (!(args.newSlPrice > 0)) {
    return { ok: false, error: "amend requires a positive new stop level" };
  }

  // 1. What is actually resting right now?
  const before = await inspectOpenStopOrders(args.pair, args.positionId);
  if (before.ambiguous) {
    return { ok: false, error: before.error ?? "stop-order query unresolved", ambiguous: true };
  }
  const current = before.rows[0];
  // MEXC's TP/SL order id lives in `id`; `orderId` is the LIMIT-order id and
  // is literally "0" on orders placed by position (all this path ever sees) —
  // preferring it made every cancel reject with 600 Parameter error
  // (live audit 2026-09-27: PUMP stop id 568200180, orderId "0").
  const currentOrderId = current?.id ?? current?.orderId;
  const currentTp =
    Number(current?.takeProfitPrice ?? current?.takeProfit ?? current?.tpPrice) || null;
  const currentSl = Number(current?.stopLossPrice ?? current?.stopLoss ?? current?.slPrice);
  if (!current || currentOrderId == null || !(currentSl > 0)) {
    // Nothing verifiable rests for this position. The caller only reaches the
    // amend on a HOLD sample (no breach, no exit), so an empty book here means
    // a previous amend died between cancel and place — the position may be
    // naked. The book is verifiably empty (not ambiguous), so placing the new
    // stop directly is the safe repair: at most it fails definitively and the
    // next pass retries. NEVER reached while a stop might still exist.
    try {
      const newSl = roundPrice(args.newSlPrice, args.priceUnit);
      await privateRequest("POST", "/api/v1/private/stoporder/place", {
        positionId: args.positionId,
        vol: args.vol,
        lossTrend: 1,
        profitTrend: 1,
        priceProtect: 0,
        stopLossPrice: newSl,
        ...(args.newTpPrice != null && args.newTpPrice > 0
          ? { takeProfitPrice: roundPrice(args.newTpPrice, args.priceUnit) }
          : {}),
      });
      return { ok: true, slPrice: newSl, tpPrice: args.newTpPrice ?? undefined };
    } catch (e: any) {
      return {
        ok: false,
        error: e?.message ?? String(e),
        ambiguous: !isDefinitiveMexcError(e),
      };
    }
  }
  // Already at/through the target? (another pass won the race, or the amend
  // landed earlier) — adopt, do not disturb the exchange again.
  const sideSign = args.newSlPrice >= args.oldSlPrice ? 1 : -1;
  const alreadyFavourable =
    sideSign > 0 ? currentSl >= args.newSlPrice : currentSl <= args.newSlPrice;
  if (alreadyFavourable) {
    return {
      ok: true,
      skipped: "already-moved",
      slPrice: currentSl,
      tpPrice: Number(current?.takeProfitPrice ?? current?.takeProfit ?? current?.tpPrice) || args.newTpPrice || undefined,
    };
  }

  const newSl = roundPrice(args.newSlPrice, args.priceUnit);

  // 2. Cancel the old stop. MEXC's stop-order cancel takes the RAW ARRAY
  // [{"stopPlanOrderId": id}] — verified against the live endpoint
  // 2026-09-27; the documented object wrapper {"orders": [...]} rejects
  // with 600 Parameter error, as does passing a wrong/zero id.
  try {
    await privateRequest("POST", "/api/v1/private/stoporder/cancel", [
      { stopPlanOrderId: currentOrderId },
    ] as any);
  } catch (e: any) {
    // Definitive "already filled/canceled" errors are FINE — re-inspect below
    // decides what actually rests. Ambiguous network failures stop here: we
    // do not know whether the stop is gone, so we must not place a second one.
    if (isDefinitiveMexcError(e)) {
      const recheck = await inspectOpenStopOrders(args.pair, args.positionId);
      if (recheck.ambiguous) return { ok: false, error: recheck.error, ambiguous: true };
      if (recheck.rows.length > 0) {
        return { ok: false, error: `cancel rejected: ${e?.message ?? e}` };
      }
    } else {
      return { ok: false, error: e?.message ?? String(e), ambiguous: true };
    }
  }

  // 3. Re-inspect: the book must be verifiably EMPTY for this position before
  //    a new stop is placed — the anti-double-stop guarantee.
  const after = await inspectOpenStopOrders(args.pair, args.positionId);
  if (after.ambiguous) {
    return { ok: false, error: after.error ?? "post-cancel stop-order query unresolved", ambiguous: true };
  }
  if (after.rows.length > 0) {
    // A stop still rests (cancel lost the race with a fill, or another order
    // appeared). Do NOT stack a second stop; report the resting level.
    const resting = after.rows[0];
    return {
      ok: true,
      skipped: "already-moved",
      slPrice: Number(resting?.stopLossPrice ?? resting?.stopLoss ?? resting?.slPrice),
      tpPrice: Number(resting?.takeProfitPrice ?? resting?.takeProfit ?? resting?.tpPrice) || undefined,
    };
  }
  // Carry the resting TP through the replace: a position TP/SL is ONE order on
  // MEXC, so re-placing the stop without its TP silently strips the model's
  // max-R backstop (the r-lock caller passes newTpPrice: null precisely to
  // KEEP the exchange TP).
  const tpToSend =
    args.newTpPrice != null && args.newTpPrice > 0 ? args.newTpPrice : currentTp;
  try {
    await privateRequest("POST", "/api/v1/private/stoporder/place", {
      positionId: args.positionId,
      vol: args.vol,
      lossTrend: 1,
      profitTrend: 1,
      priceProtect: 0,
      stopLossPrice: newSl,
      ...(tpToSend != null && tpToSend > 0
        ? { takeProfitPrice: roundPrice(tpToSend, args.priceUnit) }
        : {}),
    });
    return { ok: true, slPrice: newSl, tpPrice: tpToSend ?? undefined };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.message ?? String(e),
      ambiguous: !isDefinitiveMexcError(e),
    };
  }
}

async function findNewPosition(
  pair: string,
  sideNum: 1 | 2,
): Promise<{ vol: number; avgPrice: number; positionId: string | number | null } | null> {
  const sym = toMexcSymbol(pair);
  for (let i = 0; i < 8; i++) {
    const map = await fetchOpenPositions();
    const hit = matchPositionEntry(map, sym, sideNum);
    if (hit) return hit;
    if (i < 7) await sleep(300);
  }
  return null;
}

function entryGeometry(
  side: "LONG" | "SHORT",
  fillPrice: number,
  intent: any,
): { slPrice: number; tpPrice: number; riskPx: number } {
  const sideSign = side === "LONG" ? 1 : -1;
  const provisionalEntry = Number(intent?.entryPrice) || fillPrice;
  const provisionalSl = Number(intent?.slPrice);
  const provisionalTp = Number(intent?.tpPrice);
  const slDistance =
    Number.isFinite(provisionalSl) && provisionalSl > 0
      ? Math.abs(provisionalSl - provisionalEntry)
      : 0;
  const tpDistance =
    Number.isFinite(provisionalTp) && provisionalTp > 0
      ? Math.abs(provisionalTp - provisionalEntry)
      : slDistance;
  const maxR = Number(intent?.trailMaxR);
  const targetDistance =
    Number(intent?.trailStartR) > 0 && Number.isFinite(maxR) && maxR > 0
      ? slDistance * maxR
      : tpDistance;
  return {
    slPrice: fillPrice - sideSign * slDistance,
    tpPrice: fillPrice + sideSign * targetDistance,
    riskPx: slDistance,
  };
}

function orderFill(order: any): { price: number; vol: number; positionId?: string | number } | null {
  const price = Number(order?.dealAvgPrice ?? order?.avgPrice ?? order?.price);
  const vol = Number(order?.dealVol ?? order?.filledVol ?? order?.vol);
  if (!(price > 0) || !(vol > 0)) return null;
  const positionId = order?.positionId ?? undefined;
  return { price, vol, ...(positionId != null ? { positionId } : {}) };
}

export async function ensureLiveBracket(args: {
  ctx: any;
  trade: any;
  position: { vol: number; positionId: string | number | null; avgPrice: number };
}): Promise<{
  state: "attached" | "pending" | "failed" | "unmanaged";
  detail?: string;
  slPrice?: number;
  tpPrice?: number;
}> {
  const { ctx, trade, position } = args;
  if (trade.exchangeStop === true || trade.bracketIntentStatus === "attached") {
    return { state: "attached" };
  }
  if (position.positionId == null) {
    return { state: "unmanaged", detail: "positionId unavailable" };
  }

  const stops = await inspectOpenStopOrders(trade.coin, position.positionId);
  if (stops.ambiguous) {
    return { state: "pending", detail: `stop-order query unresolved: ${stops.error ?? "exchange error"}` };
  }
  const existing = stops.rows[0];
  let intentId = String(trade.bracketIntentId ?? "");
  if (existing) {
    if (!intentId) {
      const claim: any = await ctx.runMutation(api.liveEngine.claimLiveBracket, { id: trade._id });
      if (!claim?.claimed) return { state: "pending", detail: claim?.reason ?? "bracket claim pending" };
      intentId = claim.intentId;
    }
    const slPrice = Number(existing.stopLossPrice ?? existing.stopLoss ?? existing.slPrice);
    const tpPrice = Number(existing.takeProfitPrice ?? existing.takeProfit ?? existing.tpPrice);
    if (!(slPrice > 0) || !(tpPrice > 0)) {
      return { state: "pending", detail: "open stop order found without readable levels" };
    }
    const ack: any = await ctx.runMutation(api.liveEngine.markLiveBracketAttached, {
      id: trade._id,
      intentId,
      slPrice,
      tpPrice,
      positionId: position.positionId,
      // STOP-AMEND: record the adopted resting level; the mutation keeps the
      // frozen ruler (slPrice + riskPx) intact when riskPx is present.
      exchangeSlPrice: slPrice,
    });
    return ack?.ok
      ? { state: "attached", detail: "adopted existing exchange bracket", slPrice, tpPrice }
      : { state: "pending", detail: ack?.reason ?? "existing bracket ledger write pending" };
  }

  if (["pending", "submitted", "unknown"].includes(String(trade.bracketIntentStatus))) {
    // BOUNDED FENCE (2026-09-24). The stop-order book above was readable and
    // holds NO bracket for this position, so an unresolved claim that is old
    // enough that its request can no longer be in flight is protecting nothing —
    // it is keeping a real position without a stop. Expire it and fall through
    // to a fresh claim. A claim that is NOT yet stale still fences (its request
    // may yet land), and a bracket that DID land was adopted above, so this can
    // never duplicate a resting stop.
    const expired: any = await ctx.runMutation(api.liveEngine.expireLiveBracketIntent, {
      id: trade._id,
      intentId: String(trade.bracketIntentId ?? ""),
      staleMs: BRACKET_INTENT_STALE_MS,
    });
    if (!expired?.ok) {
      return {
        state: "pending",
        detail: `earlier bracket request not resolved (${expired?.reason ?? "fenced"})`,
      };
    }
  }

  const claim: any = await ctx.runMutation(api.liveEngine.claimLiveBracket, { id: trade._id });
  if (!claim?.claimed) return { state: "pending", detail: claim?.reason ?? "bracket claim pending" };
  intentId = claim.intentId;
  try {
    const meta = await contractMeta(trade.coin);
    const closeVol = position.vol > 0 ? Math.min(trade.volContracts, position.vol) : trade.volContracts;
    const attach = await attachBracket({
      pair: trade.coin,
      positionId: position.positionId,
      vol: closeVol,
      slPrice: trade.slPrice,
      tpPrice: trade.tpPrice,
      priceUnit: meta.priceUnit,
      intentId,
    });
    if (!attach.ok || attach.slPrice == null || attach.tpPrice == null) {
      await ctx.runMutation(api.liveEngine.markLiveBracketFailed, {
        id: trade._id,
        intentId,
        error: attach.error ?? "bracket placement failed",
        definitive: attach.ambiguous !== true,
      });
      return { state: attach.ambiguous ? "pending" : "failed", detail: attach.error };
    }
    const ack: any = await ctx.runMutation(api.liveEngine.markLiveBracketAttached, {
      id: trade._id,
      intentId,
      slPrice: attach.slPrice,
      tpPrice: attach.tpPrice,
      positionId: position.positionId,
      exchangeSlPrice: attach.slPrice,
    });
    return ack?.ok
      ? { state: "attached", slPrice: attach.slPrice, tpPrice: attach.tpPrice }
      : { state: "pending", detail: ack?.reason ?? "accepted bracket not acknowledged in ledger" };
  } catch (e: any) {
    const definitive = isDefinitiveMexcError(e);
    await ctx.runMutation(api.liveEngine.markLiveBracketFailed, {
      id: trade._id,
      intentId,
      error: e?.message ?? String(e),
      definitive,
    });
    return { state: definitive ? "failed" : "pending", detail: e?.message ?? String(e) };
  }
}

export async function reconcilePendingLiveEntries(ctx: any): Promise<{
  checked: number;
  opened: number;
  pending: number;
  failed: number;
  unmanaged: number;
  results: string[];
}> {
  const pending: any[] = await ctx.runQuery(api.liveEngine.getLivePendingEntries);
  const summary = { checked: pending.length, opened: 0, pending: 0, failed: 0, unmanaged: 0, results: [] as string[] };
  if (pending.length === 0) return summary;

  let positions: Awaited<ReturnType<typeof fetchOpenPositions>> | null = null;
  try {
    positions = await fetchOpenPositions();
  } catch (e: any) {
    summary.results.push(`entry reconciliation: open positions unavailable — ${e?.message ?? e}`);
  }

  for (const intent of pending) {
    const side: "LONG" | "SHORT" = intent.type === "LONG" ? "LONG" : "SHORT";
    const sideNum = side === "LONG" ? 1 : 2;
    const sym = toMexcSymbol(intent.coin);
    const pos = positions ? matchPositionEntry(positions, sym, sideNum) : null;
    const inspected = await inspectOrder(
      intent.orderId,
      intent.coin,
      String(intent.externalOid ?? intent.entryIntentId ?? ""),
      Number(intent.entryTime ?? Date.now()) - 60_000,
    );
    const order = inspected.order;
    const state = orderStateOf(order);
    const fill = orderFill(order);

    if (state === 4 || state === 5) {
      await ctx.runMutation(api.liveEngine.markLiveEntryIntentError, {
        id: intent._id,
        error: `MEXC order ${state === 4 ? "cancelled" : "invalid"}`,
        definitive: true,
      }).catch(() => {});
      summary.failed++;
      summary.results.push(`${intent.coin}: entry intent definitively ${state === 4 ? "cancelled" : "invalid"}`);
      continue;
    }

    if (state === 1 || state === 2) {
      if (intent.entryIntentStatus !== "submitted" || intent.orderId !== (order?.orderId ?? intent.orderId)) {
        await ctx.runMutation(api.liveEngine.markLiveEntrySubmitted, {
          id: intent._id,
          orderId: order?.orderId != null ? String(order.orderId) : undefined,
        }).catch(() => {});
      }
      summary.pending++;
      summary.results.push(`${intent.coin}: entry order still ${state === 1 ? "pending" : "unfilled"} — retry fenced`);
      continue;
    }

    if (state === 3 || pos || fill) {
      const fillPrice = pos?.avgPrice && pos.avgPrice > 0 ? pos.avgPrice : fill?.price;
      if (typeof fillPrice !== "number" || !Number.isFinite(fillPrice) || fillPrice <= 0) {
        summary.pending++;
        summary.results.push(`${intent.coin}: filled entry has no readable average price yet`);
        continue;
      }
      const geometry = entryGeometry(side, fillPrice, intent);
      const meta = await contractMeta(intent.coin).catch(() => null);
      const vol = pos?.vol && pos.vol > 0 ? pos.vol : fill?.vol ?? intent.volContracts;
      const notionalUsd = meta
        ? vol * meta.contractSize * fillPrice
        : intent.notionalUsd;
      const marginUsd = notionalUsd / Math.max(1, intent.leverage);
      const positionId = pos?.positionId ?? fill?.positionId;
      const rec: any = await ctx      .runMutation(api.liveEngine.recordLiveEntry, {
      intentId: intent._id,
        coin: intent.coin,
        type: side,
        entryTime: intent.entryTime,
        signalTime: intent.signalTime,
        signalPrice: intent.signalPrice,
        entryPrice: fillPrice,
        slPrice: roundPrice(geometry.slPrice, meta?.priceUnit ?? 0),
        tpPrice: roundPrice(geometry.tpPrice, meta?.priceUnit ?? 0),
        trailStartR: intent.trailStartR,
        trailStepR: intent.trailStepR,
        trailMaxR: intent.trailMaxR,
        riskPx: geometry.riskPx,
        rLockAnchorPrice: fillPrice, // frozen at the fill, never rewritten later
        volContracts: vol,
        notionalUsd,
        marginUsd,
        leverage: intent.leverage,
        orderId: order?.orderId != null ? String(order.orderId) : intent.orderId,
        externalOid: intent.externalOid,
        positionId,
        exchangeStop: false,
      });
      // EXECUTION RECORD (Stage 3, record-only, fail-open): intended vs fill,
      // liq level at entry, decision→order latency. Scheduled separately from
      // the trade write, so a logging failure cannot affect the entry.
      if (rec?.id) {
        await scheduleExecRecord(ctx, { kind: "entry", ref: { table: "liveTrades", id: String(rec.id) } });
      }
      if (!rec?.inserted && rec?.reason !== "already-open") {
        summary.pending++;
        summary.results.push(`${intent.coin}: filled entry could not be recorded (${rec?.reason ?? "unknown"})`);
        continue;
      }
      summary.opened++;
      if (pos && pos.positionId != null) {
        const bracket = await ensureLiveBracket({
          ctx,
          trade: {
            ...intent,
            ...rec,
            _id: intent._id,
            status: "open",
            slPrice: roundPrice(geometry.slPrice, meta?.priceUnit ?? 0),
            tpPrice: roundPrice(geometry.tpPrice, meta?.priceUnit ?? 0),
            volContracts: vol,
            bracketIntentStatus: intent.bracketIntentStatus,
            bracketIntentId: intent.bracketIntentId,
          },
          position: pos,
        });
        if (bracket.state === "unmanaged") summary.unmanaged++;
        if (bracket.state === "pending") summary.pending++;
        if (bracket.detail) summary.results.push(`${intent.coin}: bracket ${bracket.state}${bracket.detail ? ` — ${bracket.detail}` : ""}`);
      } else {
        summary.unmanaged++;
        summary.results.push(`${intent.coin}: filled but position is not visible; awaiting position/brackets`);
      }
      continue;
    }

    if (inspected.ambiguous || state == null) {
      await ctx.runMutation(api.liveEngine.markLiveEntryIntentError, {
        id: intent._id,
        error: inspected.error ?? "entry order not found; exchange result unresolved",
        definitive: false,
      }).catch(() => {});
      summary.pending++;
      summary.results.push(`${intent.coin}: entry intent unresolved — retry fenced pending exchange evidence`);
    }
  }
  return summary;
}

function sessionOf(ms: number): string {
  const h = new Date(ms).getUTCHours();
  if (h < 7) return "asia";
  if (h < 13) return "london";
  if (h < 17) return "ldn-ny";
  if (h < 22) return "ny";
  return "late";
}

function fmtUsd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}


export const probeLiveConnection = internalAction({
  args: {},
  handler: async (ctx) => {
    try {
      const account: any = await ctx.runMutation(internal.liveEngine.ensureLiveAccountInternal, {});
      if (!creds()) {
        await ctx.runMutation(api.liveEngine.setLiveMeta, {
          lastProbeAt: Date.now(),
          lastProbeOk: false,
          lastProbeDetail: "MEXC_API_KEY / MEXC_API_SECRET not configured on this deployment",
        });
        return {
          ok: false,
          configured: false,
          detail: "API keys missing — set MEXC_API_KEY and MEXC_API_SECRET, then Test connection again.",
        };
      }
      const [assets, positions] = await Promise.all([fetchAssets(), fetchOpenPositions()]);
        const openCount = new Set([...positions.keys()].map((k) => k.replace(/_\d+$/, ""))).size;
      const detail =
        `USDT balance ${fmtUsd(assets.balanceUsd)} · wallet ${fmtUsd(assets.walletBalanceUsd)} · ` +
        `${openCount} open position row(s) · assets: ${assets.currencies.slice(0, 8).join(", ") || "none"}`;
      await ctx.runMutation(api.liveEngine.setLiveMeta, {
        lastProbeAt: Date.now(),
        lastProbeOk: true,
        lastProbeDetail: detail,
        balanceUsd: assets.balanceUsd,
        walletBalanceUsd: assets.walletBalanceUsd,
      });
      return {
        ok: true,
        configured: true,
        balanceUsd: assets.balanceUsd,
        walletBalanceUsd: assets.walletBalanceUsd,
        positions: openCount,
        detail,
        account: { enabled: !!account.enabled, leverage: account.leverage, riskPct: account.riskPct },
      };
    } catch (e: any) {
      await ctx.runMutation(api.liveEngine.setLiveMeta, {
        lastProbeAt: Date.now(),
        lastProbeOk: false,
        lastProbeDetail: e?.message ?? "Unknown error",
      }).catch(() => {});
      return {
        ok: false,
        configured: !!creds(),
        detail: e?.message ?? "Unknown connection error",
      };
    }
  },
});


// PLUMBING-SKIP DECISION ROWS (2026-10-02, flaw 4c): skips that never reach
// an entry left no strategySignals row, so no lab could price what the
// cooldown, the session filter, the position cap, or sizing refusals cost.
// Post-signal skips log the full evaluated vector (entryPrice 0 = no fill,
// veto names the skip); the pre-signal cooldown goes through logEntryError
// as side SKIP. Best-effort: logging must never break a tick, and blocklist
// + bad-data skips are deliberately excluded (static config / separate
// failure class — see the comment at each skip).
async function logPlumbingSkip(
  ctx: any,
  input: {
    pair: string;
    side: string;
    entryPrice: number;
    longScore: number;
    shortScore: number;
    reasons: string[];
    blockers: string[];
    emaFast: number;
    emaSlow: number;
    imbalance: number;
    flowBias: number;
    fundingRate: number;
    spreadPct: number;
    atrPct: number;
    timestamp: number;
    veto: string;
  },
): Promise<void> {
  await ctx.runMutation(api.strategyEngine.logSignal, { ...input, entered: false }).catch(() => {});
}

async function processPairLive(
  ctx: any,
  pair: string,
  metrics: any,
  cfg: any,
  account: any,
  balanceUsd: number,
  now: number,
  openCoinSet: Set<string>,
  recentTimes: Map<string, number>,
  pendingSignals: Map<string, PendingSignal>, // chase-guard anchors (shared per tick)
  cap: { max: number; used: number; betaCap?: number; netBeta?: number },
  errors: {
    count: number;
    messages: string[];
    log: { time: number; pair: string; message: string }[];
  },
  advisorMap: Record<string, any> | null,
  advisor1hMap?: Record<string, any> | null,
  btcRegime?: BtcRegime,
  btcCloses?: readonly { openTime: number; close: number }[],
  /**
   * PAPER-fed session profitability snapshot (2026-10-20), shared by every
   * pair in the tick. `null`/`undefined` = gate off (fail open).
   */
  sessionBreaker?: {
    day: string;
    computedAt: number;
    stale: boolean;
    minTrades: number;
    minProfitR: number;
    blocked: SessionBreakerBucket[];
  } | null,
  /**
   * PAPER-fed per-coin record (2026-10-21), shared by every pair. A coin in the
   * `avoid` tier refuses LIVE entries while `coinPriorityBlockAvoid` is on;
   * ordering/veto both fail open on a missing snapshot.
   */
  coinPriority?: {
    buckets: { coin: string; trades: number; sumR: number; winRate: number | null; tier: string }[];
  } | null,
): Promise<{ pair: string; result: string; entered: boolean; pending?: boolean }> {
  try {
    // LIVE-UNIVERSE EXCLUSION (2026-10-25): a pair barred from this book (BTC)
    // is refused before ANY read — no klines fetch, no signal, no entry. The
    // scan list already filters it; this is the hard invariant at the one
    // function that can spend live money.
    if (!isLiveTradable(pair)) {
      return {
        pair,
        result: `${pair}: skip — excluded from the live book (measured, not traded here)`,
        entered: false,
      };
    }

    const lastTime = recentTimes.get(pair);
    if (lastTime && now - lastTime < COOLDOWN_MS) {
      const left = Math.round((COOLDOWN_MS - (now - lastTime)) / 60_000);
      // Pre-signal: no side was ever evaluated — SKIP row, not an error.
      await ctx.runMutation(api.strategyEngine.logEntryError, { pair, side: "SKIP", kind: "plumbing-skip", message: `cooldown (${left}m left)`, timestamp: now }).catch(() => {});
      return { pair, result: `${pair}: cooldown (${left}m left)`, entered: false };
    }

    if ((cfg.blocklist ?? []).includes(pair)) {
      return { pair, result: `${pair}: blocked — on config blocklist`, entered: false };
    }

    // COIN PRIORITY VETO (2026-10-21): the paper record says this coin is not
    // profitable, so LIVE refuses it while the block is armed. Checked HERE,
    // with the other free gates and BEFORE the klines fetch — the first version
    // sat after signal computation, so every refused coin still cost a 400-bar
    // fetch + score on every 15-minute tick. Side is unknown pre-signal, hence
    // the SKIP marker (same shape the cooldown uses).
    // Unproven coins (under the sample floor, or no record at all) fail OPEN:
    // the gate must not act on a three-trade sample, and a new pair could never
    // earn one if it were banned.
    const coinBlockEarly = coinPriorityBlock(
      coinPriority as any,
      pair,
      cfg.coinPriorityBlockAvoid !== false,
    );
    if (coinBlockEarly) {
      const veto = `coin priority: ${coinPriorityReason(coinBlockEarly)}`;
      await logPlumbingSkip(ctx, { pair, side: "SKIP", entryPrice: 0, longScore: 0, shortScore: 0, reasons: [], blockers: [], emaFast: 0, emaSlow: 0, imbalance: 0, flowBias: 0, fundingRate: 0, spreadPct: 0, atrPct: 0, timestamp: now, veto }).catch(() => {});
      return { pair, result: `${pair}: blocked — ${coinPriorityReason(coinBlockEarly)}`, entered: false };
    }

    // OPEN-POSITION LOCK, PRE-FETCH (2026-10-22, cron I/O): mirrors the paper
    // engine's 2026-09-09 fix. A coin already held cannot enter, but this test
    // used to run AFTER the 15m/5m klines, ticker-price and contract-meta reads,
    // so every held coin cost up to four MEXC calls per tick to be refused
    // (7 held on 2026-10-22 => ~670 requests/day; the cap is 10). Side is
    // unknown pre-signal, hence the SKIP marker — the same shape the cooldown
    // skip above uses. Trade-off, identical to paper's: the entered:false
    // signal-log row for a locked coin is no longer written.
    if (openCoinSet.has(pair)) {
      await ctx
        .runMutation(api.strategyEngine.logEntryError, {
          pair,
          side: "SKIP",
          kind: "plumbing-skip",
          message: "open live position (locked before fetch)",
          timestamp: now,
        })
        .catch(() => {});
      return { pair, result: `${pair}: skip — open live position`, entered: false };
    }

    const klines = await fetchKlines(pair, "15m", EMA_KLINE_BARS);
    if (!klines || klines.length < EMA_MIN_BARS) {
      return { pair, result: `${pair}: skip (candles ${klines?.length ?? 0}/${EMA_MIN_BARS})`, entered: false };
    }
    const integrity = validateKlines(klines, { intervalMs: 15 * 60_000, minBars: EMA_MIN_BARS, now });
    if (!integrity.ok) {
      return { pair, result: `${pair}: skip — bad candle data (${integrity.reason})`, entered: false };
    }
    const closes = klines.map((k: any) => k.close);

    const signalBarTime = resolveSignalBarTime(klines);
    if (signalBarTime == null) {
      return { pair, result: `${pair}: skip (no closed bar)`, entered: false };
    }
    const entrySession = sessionOf(signalBarTime);
    const signal = computeLayer2Signal(closes, metrics.imbalance, metrics.flowBias, resolveFundingRate(metrics.fundingRate, metrics.fundingValid), metrics.atrPct, computeAtrPct(klines, 14), metrics.candleRangePct, metrics.spreadPct, metrics.vol24h, cfg, { high: klines.map((k: any) => k.high), low: klines.map((k: any) => k.low) });
    if (!signal.side) {

      return {
        pair,
        result: `${pair}: no signal (L:${signal.longScore.toFixed(1)} S:${signal.shortScore.toFixed(1)})`,
        entered: false,
      };
    }

    const h4Shadow=await getH4ShadowCached(ctx,pair), shadowRsi7=rsi7FromCloses(closes), shadowPullback=extAtrApprox(signal.side,closes[closes.length-1]??0,signal.emaSlow,metrics.atrPct)<PULLBACK_EXT_ATR, shadow=evalShadowTags({h4:h4Shadow,rsi7:shadowRsi7,pullback:shadowPullback}), shadowFields:any={shadowTags:[...shadow.tags]}; if(shadow.h4RangePct!=null)shadowFields.shadowH4RangePct=shadow.h4RangePct; if(shadow.h4VolLog2!=null)shadowFields.shadowH4VolLog2=shadow.h4VolLog2; if(shadow.rsi7!=null)shadowFields.shadowRsi7=shadow.rsi7;
        try{shadowFields.shadowTags.push(...advisorShadowTags({metrics:advisorMap?.[pair],btcMetrics:advisorMap?.BTC,side:signal.side,longThreshold:cfg.advisorLongThreshold,shortThreshold:cfg.advisorShortThreshold,mode:(cfg as any).advisorMode??"both"}));}catch{};

    const h4GateBlock = h4GateBlocks({ h4: h4Shadow, extAtr: extAtrApprox(signal.side, closes[closes.length - 1] ?? 0, signal.emaSlow, metrics.atrPct), rsi7: shadowRsi7, side: signal.side, cfg: { h4VolClimaxBlock: cfg.h4VolClimaxBlock, h4PullbackBigBlock: cfg.h4PullbackBigBlock, h4PullbackDeadBlock: cfg.h4PullbackDeadBlock, rsiHeatMax: cfg.rsiHeatMax } });
    if (h4GateBlock) {

      return { pair, result: `${pair}: ${signal.side} blocked — ${h4GateBlock}`, entered: false };
    }
    if (signal.side === "LONG" && !cfg.allowLong) {
      return { pair, result: `${pair}: LONG disabled`, entered: false };
    }
    if (signal.side === "SHORT" && !cfg.allowShort) {
      return { pair, result: `${pair}: SHORT disabled`, entered: false };
    }
        // LTF 5M CONFLUENCE (2026-09-26, both books - src/lib/ltf5m.ts): fetch
    // ~40 closed 5m bars for the shadow tag and the LONG gate below.
    // Fails open on fetch failure or short history.
    let closes5m: number[] = [];
    try {
      const k5 = await fetchKlines(pair, "5m", 40);
      closes5m = k5.map((b: any) => b.close);
    } catch { closes5m = []; }
    const ltf5mTag = ltf5mShadowTag(closes5m);
    if (ltf5mTag) shadowFields.shadowTags.push(ltf5mTag);
    const ltf5mBlock = ltf5mGateBlocks({
      closes5m,
      side: signal.side,
      cfg: { ltf5mGateEnabled: cfg.ltf5mGateEnabled },
    });

    if (ltf5mBlock) return { pair, result: `${pair}: ${signal.side} blocked - ${ltf5mBlock}`, entered: false };
    const d1Shadow = await getD1ShadowCached(ctx, pair);
    const d1Tags = d1ShadowTags(d1Shadow, signal.side);
    shadowFields.shadowTags.push(...d1Tags.tags);
    if (d1Shadow) {
      shadowFields.d1UpWickPct = d1Shadow.upWickPct;
      shadowFields.d1R5Pct = d1Shadow.r5Pct;
      // Declared across recordLiveEntry + liveTrades since 2026-10-02; the
      // cast can go because shadowFields is untyped here.
      if (d1Shadow.dStochK != null) shadowFields.d1StochK = d1Shadow.dStochK;
    }
    const allowedSessions = signal.side === "LONG" ? cfg.longSessions : cfg.shortSessions;
    if (allowedSessions.length > 0 && !allowedSessions.includes(entrySession)) {
      await logPlumbingSkip(ctx, { pair, side: signal.side, entryPrice: 0, longScore: signal.longScore, shortScore: signal.shortScore, reasons: signal.reasons ?? [], blockers: signal.blockers ?? [], emaFast: signal.emaFast, emaSlow: signal.emaSlow, imbalance: metrics.imbalance, flowBias: metrics.flowBias, fundingRate: metrics.fundingRate, spreadPct: metrics.spreadPct, atrPct: metrics.atrPct, timestamp: now, veto: "plumbing: session blocked (live)" });
      return { pair, result: `${pair}: ${entrySession} session blocked`, entered: false };
    }

    // SESSION PROFITABILITY BREAKER (2026-10-20): PAPER measures, LIVE acts.
    // A (session, side) bucket whose paper record is not profitable refuses
    // live entries — and so does an UNPROVEN one (fewer than minTrades paper
    // closes, 2026-10-22): a thin sample is not a licence to spend live money,
    // and the veto line distinguishes the two cases. Gated on the SAME
    // `entrySession` the live trade would be tagged with, and checked before
    // the per-pair MEXC reads below. Fails OPEN only when the snapshot is
    // missing/disabled (sessionBreaker = null) — never on a present bucket.
    const sessionBlock = sessionBreakerBlock(sessionBreaker as any, entrySession, signal.side);
    if (sessionBlock) {
      await logPlumbingSkip(ctx, { pair, side: signal.side, entryPrice: 0, longScore: signal.longScore, shortScore: signal.shortScore, reasons: signal.reasons ?? [], blockers: signal.blockers ?? [], emaFast: signal.emaFast, emaSlow: signal.emaSlow, imbalance: metrics.imbalance, flowBias: metrics.flowBias, fundingRate: metrics.fundingRate, spreadPct: metrics.spreadPct, atrPct: metrics.atrPct, timestamp: now, veto: `session breaker: ${sessionBlock.session} ${sessionBlock.side} ${sessionBlock.sumR.toFixed(2)}R over ${sessionBlock.trades} trades` });
      return { pair, result: `${pair}: ${signal.side} blocked — ${sessionBreakerReason(sessionBlock)}`, entered: false };
    }

    if(cfg.advisorEnabled){const threshold=signal.side==="LONG"?cfg.advisorLongThreshold:cfg.advisorShortThreshold,veto=advisorVetoForMode(advisorMap?.[pair],advisorMap?.BTC,signal.side,threshold,(cfg as any).advisorMode??"both");if(veto.status==="veto"){return{pair,result:`${pair}: ${signal.side} blocked — HTF advisor veto (${veto.votes}/${threshold})`,entered:false};}}
    if((cfg as any).advisor1hEnabled){const threshold=signal.side==="LONG"?((cfg as any).advisor1hLongThreshold??cfg.advisorLongThreshold):((cfg as any).advisor1hShortThreshold??cfg.advisorShortThreshold),veto=advisorVetoForMode(advisor1hMap?.[pair],advisor1hMap?.BTC,signal.side,threshold,(cfg as any).advisor1hMode??(cfg as any).advisorMode??"both");if(veto.status==="veto"){return{pair,result:`${pair}: ${signal.side} blocked — 1H advisor veto (${veto.votes}/${threshold})`,entered:false};}}
    if(signal.side==="SHORT"&&cfg.shortFlowGate&&(metrics.flowBias??0)>=0){const f=typeof metrics.flowBias==="number"?metrics.flowBias.toFixed(2):String(metrics.flowBias??"?"),flowSilent=metrics.flowValid===false;return{pair,result:flowSilent?`${pair}: SHORT blocked — no flow reading`:`${pair}: SHORT blocked — no sell flow (${f})`,entered:false};}
    const htfGateOn=signal.side==="SHORT"?cfg.htfGateShort:cfg.htfGateLong, htfEma=signal.side==="SHORT"?cfg.htfShortEma:cfg.htfLongEma, htfTf=cfg.htfTf==="1h"?"1h":"4h";
    if(htfGateOn){const tfMs=htfTf==="1h"?60*60_000:4*60*60_000,expected=newestClosedBarOpen(tfMs,Date.now()),cached:any=await ctx.runQuery(api.htfCache.getHtf,{coin:pair,tf:htfTf,period:htfEma}).catch(()=>null);let htf:"up"|"down"|"flat"|undefined;if(cached&&cached.barOpenTime>=expected)htf=htfVerdictOf(cached);else{const raw=htfTf==="1h"?await fetchHtfTrend1hRaw(pair,htfEma):await fetchHtfTrend4hRaw(pair,htfEma);htf=raw?htfVerdictOf(raw):undefined;if(raw)await ctx.runMutation(api.htfCache.putHtf,{coin:pair,tf:htfTf,period:htfEma,barOpenTime:raw.barOpenTime,ema:raw.ema,close:raw.close}).catch(()=>{});}const label=htfTf==="1h"?"1H":"4H";if(signal.side==="SHORT"&&htf==="up")return{pair,result:`${pair}: SHORT blocked — last ${label} close ABOVE ${label} EMA ${htfEma} (HTF gate, price-vs-EMA)`,entered:false};if(signal.side==="LONG"&&htf==="down")return{pair,result:`${pair}: LONG blocked — last ${label} close BELOW ${label} EMA ${htfEma} (HTF gate, price-vs-EMA)`,entered:false};}
    if (!(balanceUsd > 0)) {
      return { pair, result: `${pair}: skip — no USDT balance`, entered: false };
    }
    if (btcRegime && btcRegimeBlocks(btcRegime.regime, signal.side)) {
      return { pair, result: `${pair}: ${signal.side} blocked — BTC regime ${btcRegime.regime}`, entered: false };
    }
    if ((cfg as any).btcRegimeDownBlock && btcRegime && btcRegimeDownBlocks(btcRegime.regime)) {
      return { pair, result: `${pair}: ${signal.side} blocked — BTC DOWN-BLOCK`, entered: false };
    }

    // LONG-SLOPE MINIMUM (2026-10-25, live copies paper). The paper engine has
    // enforced this since 09-16 while this path never read the knob — which made
    // the DOWN-BLOCK the only long blocker in live, so paper's +1% floor was
    // free there while live paid the whole long-side cost of a down tape. Same
    // rule, same fail-open contract: a missing regime verdict allows the trade.
    const longSlopeMin = (cfg as any).btcRegimeLongSlopeMin as number | undefined;
    if (longSlopeMin && longSlopeMin > 0 && btcRegime && signal.side === "LONG" && btcRegime.slopePct < longSlopeMin) {
      return {
        pair,
        result: `${pair}: LONG blocked — BTC 4h slope ${btcRegime.slopePct.toFixed(2)}% < +${longSlopeMin}% (long-slope minimum)`,
        entered: false,
      };
    }

    const entryPrice = await fetchTickerPrice(pair);
    if (!entryPrice || entryPrice <= 0) {
      return { pair, result: `${pair}: no price`, entered: false };
    }
    const contract = await contractMetaFull(pair);
    if (contract.missing.length) {
      return {
        pair,
        result: `${pair}: skip — exchange contract data missing (${contract.missing.join(", ")})`,
        entered: false,
      };
    }
    const meta = contract.meta;
    if (riskPctUnset(account.riskPct)) {
      return { pair, result: `${pair}: skip — risk per trade not set`, entered: false };
    }
    const guardReason = entryGuardBlock({
      spreadPct: metrics.spreadPct,
      maxSpreadPct: cfg.maxSpreadPct,
      signalPrice: closes[closes.length - 1],
      entryPrice,
      maxSlippageBps: cfg.maxEntrySlippageBps,
    });
    if (guardReason) {
      return { pair, result: `${pair}: ${signal.side} blocked — ${guardReason}`, entered: false };
    }

    const requestedLev = account.leverage ?? 50;
    const leverage = Math.min(requestedLev, meta.maxLeverage, maxSafeLeverage(cfg.stopLossPct));
    const leverageNote = leverage < requestedLev ? ` · leverage capped ${requestedLev}x→${leverage}x` : "";
    const size = computeOrderSize({
      side: signal.side as "LONG" | "SHORT",
      entryPrice,
      // 2% HARD CEILING (Phase 7): even a stale/hand-edited account row can
      // never size above MAX_RISK_PCT_PER_TRADE per trade — real money obeys
      // the same ceiling as paper, enforced at the sizing call itself.
      riskUsd: balanceUsd * (clampRiskPct(account.riskPct, LIVE_DEFAULT_RISK_PCT) / 100),
      stopLossPct: cfg.stopLossPct,
      takeProfitPct: cfg.takeProfitPct,
      shortTakeProfitPct: cfg.shortTakeProfitPct, // per-side SHORT TP (1.5R = 2.25% on live)
      leverage,
      balanceUsd,
      contractSize: meta.contractSize,
      volScale: meta.volScale,
      minVol: meta.minVol,
      maxVol: meta.maxVol,
    });
    if (!size.ok) {
      // Sizing refusals (e.g. dust-size account) are the recorded trace of
      // the residual class the missed-gates lab could not attribute — the
      // evaluated entryPrice is kept so the refusal is priceable.
      await logPlumbingSkip(ctx, { pair, side: signal.side, entryPrice, longScore: signal.longScore, shortScore: signal.shortScore, reasons: signal.reasons ?? [], blockers: signal.blockers ?? [], emaFast: signal.emaFast, emaSlow: signal.emaSlow, imbalance: metrics.imbalance, flowBias: metrics.flowBias, fundingRate: metrics.fundingRate, spreadPct: metrics.spreadPct, atrPct: metrics.atrPct, timestamp: now, veto: `plumbing: sizing refused (${size.reason.slice(0, 120)})` });
      return {
        pair,
        result: `${pair}: skip — ${size.reason} (balance ${fmtUsd(balanceUsd)}, risk ${account.riskPct}%)`,
        entered: false,
      };
    }
    let { slPrice, tpPrice, vol, notionalUsd, marginUsd } = size;

    const externalOid = `lv${signalBarTime}-${pair.toLowerCase()}`;
    const sideNum = signal.side === "LONG" ? 1 : 3;
    if (cfg.chaseGuardEnabled && cap.used >= cap.max) {
      mergePendingSignal(
        pendingSignals,
        pair,
        { side: signal.side, price: entryPrice, time: signalBarTime },
        cfg,
        now,
      );
      await logPlumbingSkip(ctx, { pair, side: signal.side, entryPrice, longScore: signal.longScore, shortScore: signal.shortScore, reasons: signal.reasons ?? [], blockers: signal.blockers ?? [], emaFast: signal.emaFast, emaSlow: signal.emaSlow, imbalance: metrics.imbalance, flowBias: metrics.flowBias, fundingRate: metrics.fundingRate, spreadPct: metrics.spreadPct, atrPct: metrics.atrPct, timestamp: now, veto: `plumbing: position cap (${cap.used}/${cap.max}, anchored)` });
      return {
        pair,
        result: `${pair}: skip — position cap reached (${cap.used}/${cap.max}) · pending ${signal.side} anchored @ ${entryPrice}`,
        entered: false,
      };
    }
    if (cap.used >= cap.max) {
      await logPlumbingSkip(ctx, { pair, side: signal.side, entryPrice, longScore: signal.longScore, shortScore: signal.shortScore, reasons: signal.reasons ?? [], blockers: signal.blockers ?? [], emaFast: signal.emaFast, emaSlow: signal.emaSlow, imbalance: metrics.imbalance, flowBias: metrics.flowBias, fundingRate: metrics.fundingRate, spreadPct: metrics.spreadPct, atrPct: metrics.atrPct, timestamp: now, veto: `plumbing: position cap (${cap.used}/${cap.max})` });
      return {
        pair,
        result: `${pair}: skip — position cap reached (${cap.used}/${cap.max}) · chase guard off`,
        entered: false,
      };
    }
    const netBeta = cap.netBeta ?? 0;
    const betaCap = cap.betaCap ?? 0;
    let entryBeta: number | undefined;
    if(betaCap>0){entryBeta=estimateBtcBeta(klines,btcCloses??[]);const nextBeta=netBeta+signedBeta(signal.side,entryBeta);if(betaCapBlocks({net:netBeta,side:signal.side,beta:entryBeta,cap:betaCap})){const next=nextBeta;await logPlumbingSkip(ctx,{pair,side:signal.side,entryPrice,longScore:signal.longScore,shortScore:signal.shortScore,reasons:signal.reasons??[],blockers:signal.blockers??[],emaFast:signal.emaFast,emaSlow:signal.emaSlow,imbalance:metrics.imbalance,flowBias:metrics.flowBias,fundingRate:metrics.fundingRate,spreadPct:metrics.spreadPct,atrPct:metrics.atrPct,timestamp:now,veto:`plumbing: beta cap ${netBeta.toFixed(2)}→${next.toFixed(2)} > ${betaCap}`});return{pair,result:`${pair}: ${signal.side} skipped — beta cap ${netBeta.toFixed(2)}→${next.toFixed(2)} > ${betaCap}`,entered:false};}}
    if(cfg.chaseGuardEnabled){const anchor=pendingSignals.get(pair),guard=evaluateChaseGuard(anchor,signal.side,entryPrice,now,cfg);if(!guard.allow){if(guard.reason==="stale")pendingSignals.delete(pair);const why=guard.reason==="stale"?`first ${signal.side} signal stale`:`price ${guard.driftPct?.toFixed(2)}% away (max ${cfg.maxSignalDriftPct}%)`;await logPlumbingSkip(ctx,{pair,side:signal.side,entryPrice,longScore:signal.longScore,shortScore:signal.shortScore,reasons:signal.reasons??[],blockers:signal.blockers??[],emaFast:signal.emaFast,emaSlow:signal.emaSlow,imbalance:metrics.imbalance,flowBias:metrics.flowBias,fundingRate:metrics.fundingRate,spreadPct:metrics.spreadPct,atrPct:metrics.atrPct,timestamp:now,veto:`plumbing: chase guard (${why.slice(0,120)})`});return{pair,result:`${pair}: ${signal.side} skipped — chase guard: ${why}`,entered:false};}}
    const intentLockOn = rLockEnabled({ startR: cfg.trailLockStartR });
    const intentLockMaxR = cfg.trailLockMaxR > 0 ? cfg.trailLockMaxR : 8;
    cap.used++;
    if (entryBeta != null) cap.netBeta = (cap.netBeta ?? 0) + signedBeta(signal.side, entryBeta);

    const intent: any = await ctx.runMutation(api.liveEngine.beginLiveEntry, {
      coin: pair,
      type: signal.side,
      entryTime: now,
      signalTime: signalBarTime,
      signalPrice: entryPrice,
      entryPrice,
      slPrice,
      tpPrice,
      trailStartR: intentLockOn ? cfg.trailLockStartR : undefined,
      trailStepR: intentLockOn ? cfg.trailLockStepR : undefined,
      trailMaxR: intentLockOn ? intentLockMaxR : undefined,
      riskPx: Math.abs(entryPrice - slPrice) || undefined,
      rLockAnchorPrice: entryPrice,
      volContracts: vol,
      notionalUsd,
      marginUsd,
      leverage,
      externalOid,
      session: entrySession,
    });
    if (!intent?.inserted) {
      cap.used--;
      if (entryBeta != null) cap.netBeta = (cap.netBeta ?? 0) - signedBeta(signal.side, entryBeta);
      return {
        pair,
        result: `${pair}: entry intent not created (${intent?.reason ?? "duplicate/unknown"})`,
        entered: false,
      };
    }
    const intentId = intent.id as any; // durable entry intent id (never re-derived)
    await ctx
      .runMutation(api.liveEngine.markLiveEntrySubmitting, { id: intentId })
      .catch(() => {});

    let order: any;
    try {
      // PLAIN market open — MEXC rejects stopLossPrice / takeProfitPrice on
      // a market order (5003 "The price of stop-limit order error"), so the
      // protective bracket is attached AFTER the fill via the dedicated
      // TP/SL-by-position endpoint (attachBracket below). Exchange-enforced
      // stops still land within ~1s of the fill.
      order = await privateRequest("POST", "/api/v1/private/order/create", {
        symbol: toMexcSymbol(pair),
        price: 0, // 0 = market price
        vol,
        leverage,
        side: sideNum,
        type: 5, // market
        openType: 1, // isolated
        externalOid,
      });
    } catch (e: any) {
      const definitive = isDefinitiveMexcError(e);
      await ctx
        .runMutation(api.liveEngine.markLiveEntryIntentError, {
          id: intentId,
          error: e?.message ?? String(e),
          definitive,
        })
        .catch(() => {});
      if (definitive) {
        cap.used--;
        if (entryBeta != null) cap.netBeta = (cap.netBeta ?? 0) - signedBeta(signal.side, entryBeta);
      }

      return {
        pair,
        result: definitive
          ? `${pair}: entry order rejected — ${e?.message ?? e}`
          : `${pair}: entry intent unresolved (${e?.message ?? e}); reconciliation will inspect MEXC before any retry`,
        entered: !definitive,
      };
    }
    const orderId = String(order?.orderId ?? "");
    await ctx
      .runMutation(api.liveEngine.markLiveEntrySubmitted, { id: intentId, orderId: orderId || undefined })
      .catch(() => {});

    let entryPx = entryPrice;
    let bracketSl = slPrice;
    let bracketTp = tpPrice;
    let exchangeStop = false;
    let bracketNote = "durable-open pending";
    let positionForBracket: { vol: number; avgPrice: number; positionId: string | number | null } | null = null;


    const lockOn = rLockEnabled({ startR: cfg.trailLockStartR });
    const lockMaxR = cfg.trailLockMaxR > 0 ? cfg.trailLockMaxR : 8;
    try {
      const pos = await findNewPosition(pair, signal.side === "LONG" ? 1 : 2);
      if (pos) {
        if (pos.avgPrice > 0) {
          entryPx = pos.avgPrice;
          // TP PARITY (2026-09-27): fixed target is side-aware like the paper book
          // and computeOrderSize — SHORT uses shortTakeProfitPct when set.
          const slPct=cfg.stopLossPct/100,tpPct=(signal.side==="SHORT"&&cfg.shortTakeProfitPct!=null?cfg.shortTakeProfitPct:cfg.takeProfitPct)/100; bracketSl=signal.side==="LONG"?entryPx*(1-slPct):entryPx*(1+slPct); bracketTp=lockOn?(signal.side==="LONG"?entryPx*(1+slPct*lockMaxR):entryPx*(1-slPct*lockMaxR)):(signal.side==="LONG"?entryPx*(1+tpPct):entryPx*(1-tpPct));
        }
        bracketSl = roundPrice(bracketSl, meta.priceUnit);
        bracketTp = roundPrice(bracketTp, meta.priceUnit);
        if (pos.vol > 0) {



          vol = pos.vol;
          notionalUsd = vol * meta.contractSize * entryPx;
          marginUsd = notionalUsd / leverage;
        }
        slPrice = bracketSl;
        tpPrice = bracketTp;
        // Exchange bracket placement is deliberately deferred until AFTER the
        // ledger row is durably open (2026-09-24 audit): a crash between the
        // fill and the stop order then leaves a reconcilable open row instead
        // of an untracked position. ensureLiveBracket runs below, and the
        // entry cron reconciles any bracket it could not place.
        positionForBracket = pos;
      } else {
        bracketNote = " · position not visible after fill — monitor-managed entry";
      }
    } catch (e: any) {
      bracketNote = ` · bracket attach error: ${e?.message ?? e}`;
    }

    // R-LOCK parity fix (2026-09-20 audit): when the lock is armed the
    // MONITOR-managed TP must sit at the lock's MAX target too — not just the
    // exchange bracket's. bracketTp already carries the max target, but it is
    // only populated inside the `pos && avgPrice > 0` branch above; if the
    // bracket attach FAILED (or the position was never visible) the row
    // previously stored computeOrderSize's FIXED takeProfitPct price, so
    // liveExitTick's monitor path would close an armed winner at 2R — the
    // exact early truncation the lock exists to remove, and a silent divergence
    // from the paper book (whose stored tpPrice is always the lock max target).
    // Anchor the fallback to entryPx so it matches the bracket's own anchor.
    const monitorTp = lockOn
      ? signal.side === "LONG"
        ? entryPx * (1 + (cfg.stopLossPct / 100) * lockMaxR)
        : entryPx * (1 - (cfg.stopLossPct / 100) * lockMaxR)
      : tpPrice;

    const rec = await ctx.runMutation(api.liveEngine.recordLiveEntry, {
      intentId,
      coin: pair,
      type: signal.side,
      entryTime: now,
      signalTime: signalBarTime,
      signalPrice: entryPrice,
      entryPrice: entryPx,
      slPrice: bracketSl,
      tpPrice: positionForBracket ? bracketTp : monitorTp,
      // R-lock policy this position closes under (2026-09-20). Left undefined
      // when the lock is off so the row keeps meaning "fixed TP".
      trailStartR: lockOn ? cfg.trailLockStartR : undefined,
      trailStepR: lockOn ? cfg.trailLockStepR : undefined,
      trailMaxR: lockOn ? lockMaxR : undefined,
      // Frozen R ruler (2026-09-21): 1R in price against the stop this row
      // actually carries. liveExitTick later refines entryPrice to the
      // exchange's average fill (refineLiveEntry); without this stamp that
      // refinement re-scaled R under the already-stored peak/lock levels, so
      // the trailing exit drifted from the ruler its rungs were set on.
      // 0 would mean a zero-distance stop — leave it undefined instead.
      riskPx: Math.abs(entryPx - bracketSl) || undefined,
      volContracts: vol,
      notionalUsd,
      marginUsd,
      leverage,
      orderId,
      externalOid,
      positionId: positionForBracket?.positionId ?? undefined,
      // Frozen R-lock anchor: stamped once, at the open transition, and never
      // rewritten by a later bracket retry or entry refinement.
      rLockAnchorPrice: entryPx,
      session: entrySession,
      exchangeStop,
      // Paper parity, entry side (2026-09-23): the score vector was previously
      // sent only to strategySignals, so the trade row itself could not answer
      // what the decision looked like.
      longScore: signal.longScore,
      shortScore: signal.shortScore,
      dayOfWeek: new Date(now).getUTCDay(),
      // Factor-exposure cap (2026-09-23): the beta this entry was admitted on
      // and the book's signed net beta after it — undefined while the cap is
      // off, since no beta is measured then.
      btcBetaAtEntry: entryBeta,
      netBtcBetaAtEntry: entryBeta != null ? +(cap.netBeta ?? 0).toFixed(4) : undefined,
      // H4 shadow tags (2026-09-23): record-only forward test, paper parity.
      ...shadowFields,
    });

    if (!rec.inserted) {
      // Defensive: exchange accepted but the ledger deduped (shouldn't happen
      // after the openCoinSet pre-check). Log and move on.
      return { pair, result: `${pair}: order ${orderId} placed but ledger deduped (${rec.reason})`, entered: true };
    }

    // Durable open first, exchange bracket second. ensureLiveBracket adopts an
    // already-resting bracket or places one under a durable claim, persists the
    // exact tick-rounded levels MEXC accepted, and never rewrites the frozen
    // ruler. Anything it leaves pending is retried by the entry cron and by the
    // five-minute recovery pass.
    if (positionForBracket) {
      try {
        const bracket = await ensureLiveBracket({
          ctx,
          trade: {
            _id: rec.id,
            coin: pair,
            slPrice,
            tpPrice,
            volContracts: vol,
            exchangeStop: false,
            bracketIntentStatus: undefined,
          },
          position: positionForBracket,
        });
        exchangeStop = bracket.state === "attached";
        bracketNote = exchangeStop
          ? " · bracket SL/TP attached on exchange"
          : ` · bracket ${bracket.state}${bracket.detail ? ` — ${bracket.detail}` : ""} — monitor fallback active`;
      } catch (e: any) {
        bracketNote = ` · bracket reconciliation error: ${e?.message ?? e}`;
      }
    }

    // PAPER PARITY (2026-09): the paper book stores buildTradeEnrichment
    // (regime, vol%, spread, funding, OI, BTC trend, HTF EMAs, imbalance,
    // pair-vs-BTC) and logs the signal to strategySignals on every entry.
    // Live now mirrors both — enrichment runs AFTER the order filled so its
    // latency can never delay a real entry, and both are best-effort: a
    // failure leaves the trade intact, only the analytics context missing.
    try {
      const [enrich, oiCtx] = await Promise.all([
        buildTradeEnrichment(ctx, pair, klines as any, signalBarTime),
        ctx
          .runQuery(api.marketData.getOiContext, { pair })
          .catch(() => null),
      ]);
      await ctx
        .runMutation(api.liveEngine.updateLiveEnrichment, { id: rec.id, enrichment: enrich })
        .catch(() => {});
    } catch { /* enrichment must never break an entry */ }
    try {
      await ctx.runMutation(api.strategyEngine.logSignal, {
        pair,
        side: signal.side,
        entryPrice,
        longScore: signal.longScore,
        shortScore: signal.shortScore,
        reasons: signal.reasons ?? [],
        blockers: signal.blockers ?? [],
        emaFast: signal.emaFast,
        emaSlow: signal.emaSlow,
        imbalance: metrics.imbalance,
        flowBias: metrics.flowBias,
        fundingRate: metrics.fundingRate,
        spreadPct: metrics.spreadPct,
        atrPct: metrics.atrPct,
        entered: true,
        timestamp: now,
        ...shadowFields,
      }).catch(() => {});
    } catch { /* signal log is best-effort */ }

    pendingSignals.delete(pair); // chase guard: this pair entered — anchor consumed
    recentTimes.set(pair, signalBarTime);
    return {
      pair,
      result:
        `${pair}: ENTERED ${signal.side} @ ${entryPx.toFixed(4)} ${fmtUsd(notionalUsd)} notional ` +
        `(${vol} contracts · SL ${bracketSl.toFixed(4)} · TP ${bracketTp.toFixed(4)} · ` +
        `${exchangeStop ? "bracket SL/TP attached on exchange" : "NO exchange bracket — 5-min monitor backstop"}` +
        `${bracketNote || ""}${leverageNote} · ` +
        `L:${signal.longScore.toFixed(1)} S:${signal.shortScore.toFixed(1)} · order ${orderId})`,
      entered: true,
    };
  } catch (e: any) {
    errors.count += 1;
    const msg = e?.message ?? String(e);
    if (errors.messages.length < 3) errors.messages.push(msg);
    errors.log.push({ time: now, pair, message: msg });
    // Durable trace (2026-09-27): the tick summary is overwritten every 15 min,
    // so a died-before-entry candidate previously left no record and book-
    // divergence audits had nothing to query. side="ERROR" keeps it out of
    // every LONG/SHORT filter. Fire-and-forget: a journal failure must not
    // mask the original error path.
    await ctx.runMutation(api.strategyEngine.logEntryError, { pair, message: msg, timestamp: now }).catch(() => {});
    return { pair, result: `${pair}: ERROR ${msg}`, entered: false };
  }
}

/**
 * CHASE GUARD dry run — used when the position cap blocks ALL entries. Each
 * candidate pair's signal is evaluated (klines only — the same I/O a normal
 * scan does) and the FIRST signal anchor is recorded so a later entry can't
 * chase a worse fill once a slot frees. Cheaper than the real scan: no HTF
 * fetch (re-run fully at entry time), no ticker/meta/sizing/order I/O. The
 * anchor price is the just-closed signal bar's close (processPairLive anchors
 * on the live ticker instead — sub-0.1% basis difference, immaterial at the
 * 0.5% default guard).
 */
async function recordPendingAnchor(
  ctx: any,
  pair: string,
  metrics: any,
  cfg: any,
  now: number,
  openCoinSet: Set<string>,
  recentTimes: Map<string, number>,
): Promise<{ result: string; pending: PendingSignal | null }> {
  // Chase guard OFF (2026-09-20): the dry scan exists only to feed the guard's
  // anchors, so when the guard is disabled this returns before ANY I/O — the
  // capped path can never pay for a klines sweep nothing reads.
  if (!cfg.chaseGuardEnabled) return { result: `${pair}: chase guard off`, pending: null };
  const lastTime = recentTimes.get(pair);
  if (lastTime && now - lastTime < COOLDOWN_MS) return { result: `${pair}: cooldown`, pending: null };
  if (openCoinSet.has(pair)) return { result: `${pair}: open position`, pending: null };
  const klines = await fetchKlines(pair, "15m", EMA_KLINE_BARS);
  if (!klines || klines.length < EMA_MIN_BARS) {
    return { result: `${pair}: no candles (${klines?.length ?? 0})`, pending: null };
  }
  const integrity = validateKlines(klines, { intervalMs: 15 * 60_000, minBars: EMA_MIN_BARS });
  if (!integrity.ok) {
    return { result: `${pair}: bad candle data (${integrity.reason})`, pending: null };
  }
  const closes = klines.map((k: any) => k.close);
  const signalBarTime = resolveSignalBarTime(klines);
  if (signalBarTime == null) return { result: `${pair}: no signal bar`, pending: null };
  const signal = computeLayer2Signal(
    closes,
    metrics.imbalance,
    metrics.flowBias,
    resolveFundingRate(metrics.fundingRate, metrics.fundingValid),
    metrics.atrPct,
    computeAtrPct(klines, 14),
    metrics.candleRangePct,
    metrics.spreadPct,
    metrics.vol24h,
    cfg,
    { high: klines.map((k: any) => k.high), low: klines.map((k: any) => k.low) },
  );
  if (!signal.side) {
    return {
      result: `${pair}: no signal (L:${signal.longScore.toFixed(1)} S:${signal.shortScore.toFixed(1)})${signal.stretchBlocked ? " · EMA-stretch veto" : ""}${signal.trendBlocked ? " · trend-gate veto" : ""}`,
      pending: null,
    };
  }
  if (signal.side === "LONG" && !cfg.allowLong) return { result: `${pair}: long disabled`, pending: null };
  if (signal.side === "SHORT" && !cfg.allowShort) return { result: `${pair}: short disabled`, pending: null };
  const allowedSessions = signal.side === "LONG" ? cfg.longSessions : cfg.shortSessions;
  const entrySession = sessionOf(signalBarTime);
  if (allowedSessions.length > 0 && !allowedSessions.includes(entrySession)) {
    return { result: `${pair}: ${signal.side} blocked — ${entrySession} session`, pending: null };
  }
  if ((cfg.blocklist ?? []).includes(pair)) return { result: `${pair}: blocklist`, pending: null };
  const price = closes[closes.length - 1] ?? 0;
  if (!(price > 0)) return { result: `${pair}: no price`, pending: null };
  return {
    result: `${pair}: pending ${signal.side} anchored @ ${price}`,
    pending: { side: signal.side, price, time: signalBarTime },
  };
}

// ── Entry tick (mirrors strategyTick, fires every 15 min via cron) ──

export const liveEntryTick = action({
  args: {},
  handler: async (ctx): Promise<{ status: string; scanned: number; entries: number; results: string[] }> => {
    // Heartbeat first (src/lib/heartbeat.ts): recorded before the stopped/no-creds
    // early returns, so a paused bot still shows the cron is alive.
    await ctx.runMutation(internal.heartbeat.record, { job: "live-entry" }).catch(() => {});

    const results: string[] = [];
    // Set when the breaker released this tick, so the summary below says so:
    // an auto re-arm is a live-money event and must not be silent.
    let breakerRearmNote: string | null = null;
    // EVERY terminal write of lastScanResult goes through this. The re-arm runs
    // before the scan, so any early return between it and the summary would
    // otherwise replace the release line with its own status — observed live
    // 2026-10-24 00:03Z: the book auto re-armed and the page read only
    // "SESSION BLOCKED", i.e. it looked like a book that was never disarmed.
    const scanNote = (text: string) => withRearmNote(text, breakerRearmNote);
    let entryCount = 0;
    // Pairs actually evaluated this tick (not rows in `results`, which also
    // carries diagnostic lines). See the summary note in the scan loop.
    let scannedPairs = 0;
    const account: any = await ctx.runMutation(internal.liveEngine.ensureLiveAccountInternal, {});
    const now = Date.now();
    if (!account.enabled) {
      // VISIBLE PAUSE (2026-10-21 audit): this branch used to write NOTHING, so
      // a stopped bot was indistinguishable from a dead tick — the Live page
      // kept rendering the last armed scan's summary (observed: "27 scanned"
      // frozen at 12:18 while every tick from 12:33 on was a healthy pause).
      await ctx
        .runMutation(api.liveEngine.setLiveMeta, {
          lastScanAt: now,
          lastScanResult: "BOT STOPPED — no entry scan (liveAccount.enabled = false)",
        })
        .catch(() => {});
      return { status: "paused", scanned: 0, entries: 0, results: ["live bot is stopped — no entry scan"] };
    }
    if (!creds()) {
      await ctx.runMutation(api.liveEngine.setLiveMeta, {
        lastScanAt: now,
        lastScanResult: "SKIPPED — MEXC_API_KEY / MEXC_API_SECRET not configured on this deployment",
      });

      return { status: "no-creds", scanned: 0, entries: 0, results: ["credentials missing"] };
    }

    const lease: any = await ctx.runMutation(api.liveEngine.acquireLiveTickLock, { leaseMs: TICK_LEASE_MS });
    if (!lease.locked) {

      return { status: "skip", scanned: 0, entries: 0, results: ["skip: another live tick in flight (lease held)"] };
    }

    try {
      // Shared config + Layer 1 metrics — same inputs as the paper engine.
      // LIVE config row (2026-09-08): paper and live now trade under separate
      // configs — the strategy console panel controls one book at a time, so
      // a session/switch edit can never leak across books.
      const configRecord: any = await ctx.runQuery(api.strategyEngine.getConfig, { book: "live" });
      const cfg: any = resolveConfig(configRecord);

      // One-time layer2 HTF-gate era stamp (idempotent; see
      // ensureLayer2GateMigration in strategyEngine.ts) — keeps the live row
      // on the measured 4h EMA75 read without a manual panel edit.
      for (const note of await ctx.runMutation(api.strategyEngine.ensureLayer2GateMigration, {})) {
        results.push(note);
      }

      // LIVE CIRCUIT BREAKER (2026-09-10, manual re-arm 2026-10-22): N
      // consecutive losses (default 6) DISARM live entries — every entry
      // signal is vetoed. Released by the operator (rearmLiveBreaker) or by
      // NEXT-SESSION evidence (2026-10-23, see shouldRearmOnSession); the
      // legacy cooldown only applies when the manual switch is off. Checked
      // BEFORE the metrics fetch so a paused bot skips the
      // whole scan (kline fetches included). Exit protection is unaffected —
      // liveExitTick is a separate cron and always runs. A new trip persists
      // pausedUntil/triggeredAt on the account doc so the cooldown survives
      // ticks; an expired cooldown re-arms unless FRESH post-trigger losses
      // re-trip it (see src/lib/live-breaker.ts for the state machine).
      if (cfg.liveBreakerEnabled) {
        // EXIT-ordered, not entry-ordered (2026-10-22): the streak must be
        // counted over the closes that happened LAST; the ledger list's
        // entry-ordered window can omit a slow position that just closed.
        const recentClosed: any[] = await ctx.runQuery(
          api.liveEngine.getLiveRecentClosedByExit,
          { limit: 20 },
        );
        // STREAK RESET (2026-10-24): the streak is derived from the ledger, so
        // the operator's reset line is applied here — every close that exited
        // before it is written off and the count restarts at 0 on what exits
        // after. The rows stay in the ledger and in every P&L total; only this
        // breaker stops counting them.
        const streakFloor = account.liveBreakerStreakResetAt ?? 0;
        const streakClosed =
          streakFloor > 0
            ? recentClosed.filter((t: any) => (t.exitTime ?? 0) > streakFloor)
            : recentClosed;
        const breaker = computeLiveBreakerState(
          cfg,
          streakClosed,
          {
            pausedUntil: account.liveBreakerPausedUntil,
            triggeredAt: account.liveBreakerTriggeredAt,
            disarmedAt: account.liveBreakerManualDisarmedAt,
          },
          now,
        );
        if (breaker.paused) {
          if (breaker.shouldTrip) {
            await ctx.runMutation(api.liveEngine.setLiveMeta, {
              liveBreakerPausedUntil: breaker.pausedUntil,
              liveBreakerTriggeredAt: breaker.triggeredAt,
              liveBreakerManualDisarmedAt: breaker.disarmedAt,
            }).catch(() => {});
            // DURABLE TRANSITION (2026-10-23): the state above is overwritten
            // in place and lastScanResult is replaced next tick, so without
            // this row the trip that froze the book leaves no reviewable trace.
            // Logging never blocks the freeze: the veto is already persisted.
            await ctx
              .runMutation(internal.liveEngine.recordLiveBreakerEvent, {
                at: now,
                kind: "trip",
                trigger: "loss-streak",
                reason: breaker.reason,
                lossStreak: breaker.lossStreak,
              })
              .catch(() => {});
          }

          // NEXT-SESSION RELEASE (2026-10-23): a manual-mode disarm is released
          // once a session AFTER the trip has CLOSED profitable on the paper
          // ledger. The evidence is the sensor's, never live's — a disarmed
          // book takes no entries, so its own P&L stops producing sessions and
          // a live-fed release would never fire. A failed read leaves the veto
          // in place: arming is the risky move, so it fails closed.
          // Kept so a RELEASE row can record WHICH session justified it: the
          // verdict is the whole point of the audit row, and re-deriving it
          // later would mean re-reading a ledger that has since moved on.
          let releaseEvidence: any = null;
          const release = breaker.shouldTrip
            ? { shouldRearm: false, reason: "trip registered this tick" }
            : await ctx
                .runQuery(internal.strategyEngine.readLiveBreakerSessionEvidence, {
                  tripAt: breaker.triggeredAt ?? breaker.disarmedAt ?? now,
                  now,
                  minCloses: cfg.sessionBreakerMinTrades,
                })
                .then((evidence) => {
                  releaseEvidence = evidence;
                  return shouldRearmOnSession(
                    cfg,
                    { disarmedAt: breaker.disarmedAt, triggeredAt: breaker.triggeredAt },
                    evidence,
                  );
                })
                .catch(() => ({
                  shouldRearm: false,
                  reason: "session evidence read failed — still disarmed",
                }));

          if (release.shouldRearm) {
            // The same clear rearmLiveBreaker() makes: triggeredAt = now marks
            // the streak that tripped it as pre-trigger history, so the losses
            // from before the disarm cannot re-trip the very next tick.
            await ctx.runMutation(api.liveEngine.setLiveMeta, {
              liveBreakerManualDisarmedAt: null,
              liveBreakerPausedUntil: null,
              liveBreakerTriggeredAt: now,
            }).catch(() => {});
            await ctx
              .runMutation(internal.liveEngine.recordLiveBreakerEvent, {
                at: now,
                kind: "release",
                trigger: "next-session",
                reason: release.reason,
                lossStreak: breaker.lossStreak,
                // The evidence that justified arming a live-money book.
                session: releaseEvidence?.label,
                sessionStart: releaseEvidence?.start,
                sessionEnd: releaseEvidence?.end,
                closes: releaseEvidence?.closes,
                netR: releaseEvidence?.netR,
                minCloses: releaseEvidence?.minCloses,
                disarmedForMs: breaker.disarmedAt != null ? now - breaker.disarmedAt : undefined,
              })
              .catch(() => {});
            breakerRearmNote = `CIRCUIT BREAKER auto re-armed: ${release.reason}`;
            results.push(breakerRearmNote);
          } else {
            const note = `CIRCUIT BREAKER — entries vetoed: ${breaker.reason} · ${release.reason}`;
            await ctx.runMutation(api.liveEngine.setLiveMeta, {
              lastScanAt: now,
              lastScanResult: note,
            }).catch(() => {});

            return { status: "breaker", scanned: 0, entries: 0, results: [note] };
          }
        }
      }

      // SESSION PROFITABILITY SNAPSHOT (2026-10-20): ONE read per tick, shared
      // by every pair. Armed by the LIVE row's `sessionBreakerEnabled`; the
      // buckets/thresholds come from the PAPER ledger (source = "paper").
      // Fail open on a read error — a performance filter must not black out
      // the book on a database hiccup.
      const sessionBreaker = cfg.sessionBreakerEnabled
        ? await ctx
            .runQuery(internal.strategyEngine.readSessionBreakerBlocked, { now })
            .catch(() => null)
        : null;

      // COIN PRIORITY (2026-10-21): ONE read per tick of the per-coin ranking
      // (14-day paper record, refreshed daily). It ORDERS the scan — it never
      // vetoes: profitable coins get the scarce position slots first, coins
      // with a negative record are scanned last and only get a slot when the
      // preferred pass left room. Fail open on a read error / disabled arm
      // switch: an unranked scan is the old behaviour.
      const coinPriority = cfg.coinPriorityEnabled
        ? await ctx
            .runQuery(internal.strategyEngine.readCoinPriority, { now })
            .catch(() => null)
        : null;

      const allMetrics: any[] = await ctx.runQuery(api.strategyEngine.getAllStrategyStates);
      const freshMetrics = orderByCoinPriority(
        allMetrics.filter((m: any) => now - m.fetchedAt < STALE_METRICS_MAX_AGE_MS),
        coinPriority,
      );

      // LIVE-UNIVERSE EXCLUSION (2026-10-25, user decision): BTC is measured by
      // this book, never traded by it — see LIVE_EXCLUDED_PAIRS in
      // tracked-pairs.ts. Filtered on the SCAN list, not on `freshMetrics`.
      // Enforced again in processPairLive, so a future caller cannot re-admit
      // the pair.
      const scanMetrics = freshMetrics.filter((m: any) => isLiveTradable(m.pair));
      if (scanMetrics.length !== freshMetrics.length) {
        const excluded = freshMetrics
          .filter((m: any) => !isLiveTradable(m.pair))
          .map((m: any) => m.pair);
        results.push(
          `live universe: ${excluded.join(", ")} excluded from entries (measured, not traded here)`,
        );
      }

      // VISIBLE DEGRADATION (audit fix 2026-09-11): all-stale metrics used to
      // mean a silent zero-pair scan reported as success. Surface it instead
      // of appearing to run normally while the marketData cron is down.
      if (freshMetrics.length === 0) {
        const note = scanNote(
          `LAYER 1 METRICS STALE — no pair metrics newer than ${STALE_METRICS_MAX_AGE_MS / 60_000} min; scan skipped (check the marketData cron)`,
        );
        await ctx
          .runMutation(api.liveEngine.setLiveMeta, { lastScanAt: now, lastScanResult: note })
          .catch(() => {});

        return { status: "stale-metrics", scanned: 0, entries: 0, results: [note] };
      }

      // WHOLE-TICK SESSION PRISON (2026-10-22, cron I/O — see sessionScanVerdict).
      // Every candidate is scored against the session of the bar that just
      // closed, and in a session where BOTH sides are impossible (blocked
      // bucket, disabled side, or an allowlist that excludes it) every one of
      // them is refused by that same test — after paying a 400-bar fetch.
      // Measured 2026-10-22: `london` blocked on both sides = 24 ticks/day x
      // ~36 kline fetches for zero entries. The tick returns here instead, and
      // says so in lastScanResult: a silent short-circuit is the failure mode a
      // previous audit called out (a stopped book looked like a stale one).
      // Fail-open: a missing snapshot or an unreadable session scans as before.
      //
      // TWO BARS, not one: the skip also has to hold for the PREVIOUS closed
      // bar's session. fetchKlines returns whole bars and validateKlines does
      // not reject a feed that is one bar behind, so a lagging pair can carry a
      // signal from the prior session's bucket — and a whole-tick skip must not
      // be able to swallow the one entry that would still have been allowed.
      // Costs two boundary ticks per blocked block, which is the right trade.
      const scanCfg = {
        allowLong: cfg.allowLong !== false,
        allowShort: cfg.allowShort !== false,
        longSessions: cfg.longSessions ?? [],
        shortSessions: cfg.shortSessions ?? [],
      };
      const newestBar = newestClosedBarOpen(15 * 60_000, now);
      const scanSession = sessionOf(newestBar);
      const sessionPrison = sessionScanVerdict(scanCfg, scanSession, sessionBreaker as any);
      const priorPrison = sessionScanVerdict(
        scanCfg,
        sessionOf(newestBar - 15 * 60_000),
        sessionBreaker as any,
      );
      if (sessionPrison.skip && priorPrison.skip) {
        const note = scanNote(`SESSION BLOCKED — no entry scan: ${sessionPrison.reason}`);
        await ctx
          .runMutation(api.liveEngine.setLiveMeta, { lastScanAt: now, lastScanResult: note })
          .catch(() => {});
        return { status: "session-blocked", scanned: 0, entries: 0, results: [note] };
      }

      // HTF advisor state: newest advisorTicks doc read ONCE per tick, then
      // indexed per pair inside processPairLive — zero extra MEXC calls per
      // pair. Same freshness gate as the paper engine: an old doc (missed
      // cron, stalled deployment) fails open so stale divergence flags can
      // never veto live entries.
      const advisorState: any = await ctx
        .runQuery(api.advisor.getAdvisorState, { interval: "4h" })
        .catch(() => null);
      const advisorMap: Record<string, any> | null =
        advisorState && now - advisorState.timestamp < ADVISOR_MAX_AGE_MS
          ? advisorState.metrics
          : null;
      // 1H advisor layer (2026-09-12): mirror of paper — same query, same
      // freshness gate, read only when the live config turns it on.
      const advisor1hState: any = (cfg as any).advisor1hEnabled
        ? await ctx.runQuery(api.advisor.getAdvisorState, { interval: "1h" }).catch(() => null)
        : null;
      const advisor1hMap: Record<string, any> | null =
        advisor1hState && now - advisor1hState.timestamp < ADVISOR_MAX_AGE_MS
          ? advisor1hState.metrics
          : null;
      // BTC regime verdict (layer2-v3): BTC's 4h series fetched ONCE per
      // tick, shared by every pair — zero extra per-entry MEXC calls.
      // Fail-open: undefined verdict leaves the gate inactive.
      let btcRegime: BtcRegime | undefined;
      if ((cfg as any).btcRegimeEnabled !== false) {
        // Bar-guarded cache (2026-09-16, cron I/O opt): shared with the
        // paper/proxy engines — same verdict, one fetch per 4h bar.
        btcRegime = await getBtcRegimeCached(ctx);
      }

      // FAIL OPEN (reverted 2026-09-11): mirror of the paper engine — a
      // missing/stale advisor doc must not blackout live entries. The earlier
      // fail-closed version returned status "advisor-stale" with scanned: 0,
      // so one missed 4H advisor run silently stopped the live book. Degrade
      // loudly (results + lastScanResult) and keep scanning with the veto
      // layer absent instead of halting the book.
      if (cfg.advisorEnabled && !advisorMap) {
        const note =
          "WARNING: HTF ADVISOR DATA MISSING/STALE — scanning WITHOUT the 4H veto layer (fix the advisor cron; entries are NOT blocked)";
        results.push(note);
        await ctx
          .runMutation(api.liveEngine.setLiveMeta, { lastScanAt: now, lastScanResult: note })
          .catch(() => {});
      }

      // DOWN-BLOCK SCAN SKIP (2026-10-28). btcRegimeDownBlocks refuses BOTH
      // sides for EVERY pair in a "down" regime, so with the block enabled this
      // tick cannot enter anything: the scan below would fetch ~33 fifteen-minute
      // series, run the whole gate chain on each, and refuse every one at the
      // same gate. Stop here instead - before the balance read and any price
      // fetch.
      //
      // NOTHING IS DELAYED: the verdict is the same bar-guarded cache the gate
      // reads (a few lines above), so scanning resumes on the first tick after a
      // new 4h bar prints a non-"down" slope - exactly when the gate itself
      // would allow an entry again. Fail-open like the gate: no verdict => no
      // skip. Durable-intent recovery already ran in the cron wrapper BEFORE
      // this tick, so an unresolved order is still settled. No record is lost
      // either: this path wrote none (the DOWN-BLOCK gate returns without
      // logPlumbingSkip, and the forward record reads PAPER).
      if (btcRegime && btcDownBlockSkipsScan(btcRegime, (cfg as any).btcRegimeDownBlock)) {
        const note = scanNote(
          `0 scanned · BTC DOWN-BLOCK active (regime down, slope ${btcRegime.slopePct.toFixed(2)}%) — both sides refused, scan skipped`,
        );
        await ctx
          .runMutation(api.liveEngine.setLiveMeta, { lastScanAt: now, lastScanResult: note })
          .catch(() => {});
        return { status: "down-block", scanned: 0, entries: 0, results: [note] };
      }

      // Live equity from the exchange (never trusted from a stored doc).
      let balanceUsd = 0;
      let walletUsd = 0;
      try {
        const assets = await fetchAssets();
        balanceUsd = assets.balanceUsd;
        walletUsd = assets.walletBalanceUsd;
      } catch (e: any) {
        await ctx.runMutation(api.liveEngine.setLiveMeta, {
          lastScanAt: now,
          lastScanResult: scanNote(`BALANCE FETCH FAILED — ${e?.message ?? e}`),
        });
        return { status: "error", scanned: 0, entries: 0, results: [String(e?.message ?? e)] };
      }

      // Open live positions + max-open-position cap. Exposure is counted on
      // EXCHANGE TRUTH: real open positions from MEXC (union with the ledger,
      // which can briefly lag a manual close on the exchange). The exchange
      // fetch is best-effort — on failure we fall back to ledger-only guards
      // and say so in the diagnostics. Cap is "3 for now — raise with funds".
      const openTrades: any[] = await ctx.runQuery(api.liveEngine.getLiveOpenTrades);
      const openCoinSet = new Set(openTrades.map((t: any) => t.coin));
      let exchangeCount = 0;
      let exchangeOk = false;
      try {
        const exchangePositions = await fetchOpenPositions();
        exchangeOk = true;
        const seenSyms = new Set<string>();
        for (const key of exchangePositions.keys()) {
          // Keys are `${coin}_USDT_${sideNum}` plus a `${coin}_USDT_0`
          // fallback per row — count each underlying symbol once.
          const sym = key.replace(/_\d+$/, "");
          if (seenSyms.has(sym)) continue;
          seenSyms.add(sym);
          exchangeCount++;
          // Exchange symbol -> internal coin id (alias-aware: PUMPFUN maps to PUMP)
          openCoinSet.add(fromMexcSymbol(sym));
        }
      } catch { /* ledger-only fallback below */ }

      // Per-pair cooldowns (1h since last live ENTRY — mirrors the paper
      // cooldowns doc). The persisted account.lastSignalTimes map is the ONLY
      // record that survives a close — open-trade rows vanish when the exit
      // tick closes them, so a map rebuilt from open trades alone lets a pair
      // re-enter minutes after a stop-loss. Seed from the persisted map first
      // (pruning entries older than the cooldown so the map self-trims), then
      // let still-open trades override with their fresher signal times. Built
      // BEFORE the cap check so the capped chase-guard dry scan can use it.
      const recentTimes = new Map<string, number>();
      if (account.lastSignalTimes) {
        for (const [coin, t] of Object.entries(account.lastSignalTimes)) {
          if (typeof t === "number" && now - t < COOLDOWN_MS) recentTimes.set(coin, t);
        }
      }
      for (const t of openTrades) {
        if (t.signalTime != null) recentTimes.set(t.coin, t.signalTime);
      }

      // CHASE GUARD (2026-09-07): seed per-pair first-signal anchors from the
      // persisted map, pruning anchors that went stale (older than
      // signalMaxAgeMin) or whose pair is now open. The map is shared across
      // the tick and persisted back at the end.
      // SESSION BOUNDARY (2026-10-23): an anchor belongs to the session that
      // produced it. Carrying one across a boundary made the new session's
      // first signal get judged against the previous session's price (drift or
      // staleness against a setup the new session never saw), so hydration
      // clears cross-session anchors and the pair re-scans clean.
      const pendingHydration = hydratePendingAnchors(
        account.pendingSignals as Record<string, PendingSignal> | undefined,
        { now, maxAgeMin: cfg.signalMaxAgeMin, isOpen: (coin) => openCoinSet.has(coin) },
      );
      const pendingSignals = pendingHydration.anchors;
      const pendingDrops = describePendingDrops(pendingHydration.dropped);

      // Rolling error log (2026-09-08): count + first-3 summary for the tick
      // diagnostics, plus a full per-failure log (time/pair/message) that
      // setLiveMeta persists — the counter alone was a blind record.
      const errors = {
        count: 0,
        messages: [] as string[],
        log: [] as { time: number; pair: string; message: string }[],
      };

      // Conservative pressure = whichever count is higher; entries only ever
      // ADD to it, so starting at the max of the two can't under-guard.
      const maxOpen = account.maxOpenPositions ?? LIVE_DEFAULT_MAX_OPEN_POSITIONS;
      // FACTOR-EXPOSURE CAP (2026-09-23): seed the net BTC-beta from the open
      // book (each position charged its recorded entry beta, falling back to
      // 1.0) and fetch BTC's 15m closes ONCE for the whole tick, so every
      // candidate's beta is a pure regression against bars already in memory.
      // When the cap is off this fetches nothing and measures nothing.
      const betaCap =
        typeof cfg.maxNetBtcBeta === "number" && cfg.maxNetBtcBeta > 0 ? cfg.maxNetBtcBeta : 0;
      let btcCloses: { openTime: number; close: number }[] = [];
      if (betaCap > 0) {
        btcCloses = await fetchKlines("BTC", "15m", EMA_KLINE_BARS)
          .then((ks) => ks.map((k) => ({ openTime: k.openTime, close: k.close })))
          .catch(() => []);
      }
      const cap = {
        max: maxOpen,
        used: Math.max(openTrades.length, exchangeCount),
        betaCap,
        netBeta: netBtcBeta(
          openTrades.map((t: any) => ({ side: t.type, beta: t.btcBetaAtEntry })),
        ),
      };

      if (cap.used >= cap.max) {
        const note = exchangeOk ? "" : " · exchange count unknown — ledger only";
        // CHASE GUARD dry scan: while capped, keep evaluating signals (klines
        // only — the same I/O a normal scan does) and record each candidate's
        // FIRST signal anchor so a later entry can't chase a worse fill.
        // Per-pair errors are caught and counted — one bad fetch must never
        // kill the tick (parity with the normal scan's processPairLive).
        const dry: string[] = [];
        for (let b = 0; b < scanMetrics.length; b += PARALLEL_BATCH_SIZE) {
          const batch = scanMetrics.slice(b, b + PARALLEL_BATCH_SIZE);
          const out = await Promise.all(
            batch.map(async (m: any) => {
              try {
                const r = await recordPendingAnchor(ctx, m.pair, m, cfg, now, openCoinSet, recentTimes);
                return { ...r, pair: m.pair };
              } catch (e: any) {
                errors.count += 1;
                const msg = e?.message ?? String(e);
                if (errors.messages.length < 3) errors.messages.push(msg);
                errors.log.push({ time: now, pair: m.pair, message: msg });
                return { result: `${m.pair}: ERROR ${msg}`, pending: null, pair: m.pair };
              }
            }),
          );
          for (const r of out) {
            dry.push(r.result);
            if (r.pending) mergePendingSignal(pendingSignals, r.pair, r.pending, cfg, now);

          }
        }
        await ctx.runMutation(api.liveEngine.setLiveMeta, {
          lastScanAt: now,
          lastScanResult:
            // The auto re-arm runs BEFORE the scan, so this early return must
            // carry it too: a disarmed book usually sits at the cap while its
            // pre-trip positions run down, which is exactly when a release
            // fires. A silent release there is indistinguishable from a book
            // that was never disarmed.
            (breakerRearmNote ? `${breakerRearmNote} · ` : "") +
            `POSITION CAP REACHED — ${cap.used} of ${cap.max} open · ${dry.length} candidates checked · ` +
            `${pendingSignals.size} pending signal anchor(s)${pendingDrops} · ${errors.count} error(s)${note}`,
          balanceUsd,
          walletBalanceUsd: walletUsd,
          pendingSignals: pendingSignals.size > 0 ? Object.fromEntries(pendingSignals) : undefined,
          totalEntryErrors: (account.totalEntryErrors ?? 0) + errors.count,
          entryErrors: errors.log.length ? errors.log : undefined,
        });
          return {
          status: "ok",
          scanned: dry.length,
          entries: 0,
          results: [...dry, `position cap reached (${cap.used}/${cap.max}) — no new entries this tick`],
        };
      }
      // TWO PASSES, not one ordered list. The first pass holds the coins the
      // monitor ranks profitable (plus every coin with no record yet — unknown
      // is not bad); the second holds the coins whose paper record is
      // negative. The second pass only starts if a slot is still free, so a
      // losing coin can never take the last slot from a profitable one in the
      // same tick. Within a pass the order is 14d net R, descending.
      const { preferred, rest } = splitByCoinPriority(scanMetrics, coinPriority);
      // When the losing tier is BLOCKED (the shipped default), scanning it is
      // pure waste: every coin in it is refused by the pre-signal veto, so the
      // pass would fetch klines only to be skipped. Say so in the diagnostics
      // instead of paying for it.
      const blockAvoid = cfg.coinPriorityBlockAvoid !== false;
      if (blockAvoid && rest.length > 0) {
        results.push(
          `coin priority: ${rest.length} losing-record pair(s) blocked this tick (${rest
            .map((m: any) => m.pair)
            .slice(0, 6)
            .join(", ")}${rest.length > 6 ? "…" : ""})`,
        );
      }
      const passes: { label: string; list: any[] }[] = blockAvoid
        ? [{ label: "priority", list: preferred }]
        : [
            { label: "priority", list: preferred },
            { label: "last", list: rest },
          ];
      for (const pass of passes) {
        if (pass.list.length === 0) continue;
        if (pass.label === "last" && cap.used >= cap.max) {
          results.push(
            `coin priority: ${pass.list.length} lower-ranked pair(s) skipped — position cap full (${cap.used}/${cap.max})`,
          );
          break;
        }
        for (let b = 0; b < pass.list.length; b += PARALLEL_BATCH_SIZE) {
          if (pass.label === "last" && cap.used >= cap.max) break;
          const batch = pass.list.slice(b, b + PARALLEL_BATCH_SIZE);

          // PER-PAIR ISOLATION (2026-10-21 audit): allSettled, not all. A single
          // throttled MEXC kline fetch used to reject the batch and kill the
          // whole action before setLiveMeta — one bad pair cost the entire
          // 15-minute entry slot silently (measured on the 12:33Z tick, after
          // the universe grew to 40 pairs).
          const settled = await Promise.allSettled(
            batch.map((m: any) =>
              processPairLive(
                ctx,
                m.pair,
                m,
                cfg,
                account,
                balanceUsd,
                now,
                openCoinSet,
                recentTimes,
                pendingSignals,
                cap,
                errors,
                advisorMap,
                advisor1hMap,
                btcRegime,
                btcCloses,
                sessionBreaker,
                coinPriority,
              ),
            ),
          );
          const out = settled.map((s: any, i: number) => {
            if (s.status === "fulfilled") return s.value;
            const msg = s.reason?.message ?? String(s.reason);
            errors.count += 1;
            if (errors.messages.length < 3) errors.messages.push(msg);
            errors.log.push({ time: now, pair: batch[i].pair, message: msg });
            return { pair: batch[i].pair, result: `${batch[i].pair}: ERROR ${msg}`, entered: false };
          });
          for (let i = 0; i < out.length; i++) {
            const r = out[i]!;
            results.push(r.result);
            if (r.entered) entryCount++;

          }
          // COUNT PAIRS, NOT ROWS (2026-10-21 audit): `results` also carries
          // diagnostic lines (coin-priority skip notes, cap notices), so its
          // length is not the coverage number. This is the number the summary
          // promises, and it must equal what was actually evaluated.
          scannedPairs += out.length;
        }
      }

      // Persist cooldown map + diagnostics in one patch.
      const lastSignalTimes: Record<string, number> = {};
      for (const [coin, t] of recentTimes) {
        if (t != null) lastSignalTimes[coin] = t;
      }
      const summary =
        (breakerRearmNote ? `${breakerRearmNote} · ` : "") +
        `${scannedPairs} scanned · ${entryCount} entered · ${errors.count} error(s)` +
        (errors.messages.length ? ` · ${errors.messages.join(" | ")}` : "") +
        ` · positions ${cap.used}/${cap.max}` +
        pendingDrops +
        (exchangeOk ? "" : " · exchange position count unknown — ledger-only cap");
      await ctx.runMutation(api.liveEngine.setLiveMeta, {
        lastScanAt: now,
        lastScanResult: summary,
        balanceUsd,
        walletBalanceUsd: walletUsd,
        lastSignalTimes: Object.keys(lastSignalTimes).length > 0 ? lastSignalTimes : undefined,
        pendingSignals: pendingSignals.size > 0 ? Object.fromEntries(pendingSignals) : undefined,
        totalEntryErrors: (account.totalEntryErrors ?? 0) + errors.count,
        entryErrors: errors.log.length ? errors.log : undefined,
      });
      return { status: "ok", scanned: scannedPairs, entries: entryCount, results };
    } catch (e: any) {
      // VISIBLE FAILURE (2026-10-21 audit): before this, an exception anywhere
      // before the summary write killed the whole 15-minute entry slot with no
      // trace at all — the heartbeat still showed a run, the account doc kept
      // the previous tick's summary, and no error row existed (measured on the
      // 12:33Z and 12:48Z ticks). Record the reason where the UI already reads
      // diagnostics, then rethrow so it still shows up in the deployment log.
      const msg = e?.message ?? String(e);
      await ctx
        .runMutation(api.liveEngine.setLiveMeta, {
          lastScanAt: now,
          // A re-arm followed by a crash still happened; say so here too,
          // otherwise the only trace is the account doc flipping to armed.
          lastScanResult:
            `TICK FAILED — ${msg.slice(0, 300)}` +
            (breakerRearmNote ? ` · ${breakerRearmNote}` : ""),
        })
        .catch(() => {});
      throw e;
    } finally {
      await ctx.runMutation(api.liveEngine.releaseLiveTickLock, {}).catch(() => {});
    }
  },
});

// ── Exit tick (mirrors resolveLayer2Exits; 15m bar-aligned :01/:16/:31/:46,
//    was 5 min until 2026-09-09 — ALWAYS runs, even when the bot is stopped,
//    so open positions stay protected) ──

// ── LEGACY, INTERNAL ONLY — do not call ──
// This is the pre-audit raw exit worker: it submits unfenced market closes and
// settles the ledger itself. It is superseded by
// liveReconcile.liveExitTickSafe (durable close intents, side-aware matching,
// market slippage) and is kept only as historical reference. It is declared
// through the internalAction alias above, so no client can reach it, and no
// cron or wrapper calls it.
export const liveExitTick = action({
  args: {},
  handler: async (ctx): Promise<{ status: string; checked: number; closed: number; results: string[] }> => {
    const results: string[] = [];
    let closedCount = 0;

    await ctx.runMutation(internal.liveEngine.ensureLiveAccountInternal, {});
    const openTrades: any[] = await ctx.runQuery(api.liveEngine.getLiveOpenTrades);
    const now = Date.now();
    if (openTrades.length === 0) {
      const account: any = await ctx.runQuery(api.liveEngine.getLiveAccount, {});
      if (account?.enabled) {
        await ctx.runMutation(api.liveEngine.setLiveMeta, { lastExitAt: now, lastExitResult: "no open positions" });
      }
      return { status: "ok", checked: 0, closed: 0, results: ["no open live positions"] };
    }
    if (!creds()) {
      const account: any = await ctx.runQuery(api.liveEngine.getLiveAccount, {});
      if (account?.enabled) {
        await ctx.runMutation(api.liveEngine.setLiveMeta, {
          lastExitAt: now,
          lastExitResult: `cannot manage ${openTrades.length} open position(s) — MEXC credentials missing`,
        });
      }
      return { status: "no-creds", checked: openTrades.length, closed: 0, results: ["credentials missing"] };
    }

    // Exchange truth: current open positions + snapshot balance.
    // positionsFetchOk is load-bearing: when the fetch FAILS the map stays
    // empty, and an empty map is indistinguishable from "no positions". Only a
    // SUCCESSFUL fetch may conclude a position is gone — a failed fetch must
    // leave every ledger row open or the bot would mark real positions closed
    // (and stop managing them) on a transient MEXC error.
    let positionsFetchOk = false;
    let positionMap = new Map<string, { vol: number; avgPrice: number }>();
    try {
      positionMap = await fetchOpenPositions();
      positionsFetchOk = true;
    } catch (e: any) {
      results.push(`open-positions fetch failed: ${e?.message ?? e}`);
    }
    let balanceUsd = 0;
    let walletUsd = 0;
    try {
      const assets = await fetchAssets();
      balanceUsd = assets.balanceUsd;
      walletUsd = assets.walletBalanceUsd;
    } catch { /* balance snapshot is best-effort */ }

    const pairs = [...new Set(openTrades.map((t: any) => t.coin))];
    const priceMap = new Map<string, number>();
    // I/O (2026-09-16): ONE batched universe request (fetchAllTickers, the
    // same unauthenticated /contract/ticker call the paper exit tick uses)
    // replaces the per-pair ticker fetch. Positions missing from the universe
    // response (non-crypto symbols like XAU/TESLA) fall back to the per-pair
    // fetch, so a batched-fetch failure can never strand a real position with
    // "no price".
    let liveTickerMap: Awaited<ReturnType<typeof fetchAllTickers>> | undefined;
    try {
      liveTickerMap = await fetchAllTickers();
    } catch {
      liveTickerMap = undefined; // per-pair fallback below
    }
    const missingLivePrice = liveTickerMap
      ? pairs.filter((pair) => !((liveTickerMap!.get(pair)?.last ?? 0) > 0))
      : pairs;
    await Promise.all(
      missingLivePrice.map(async (pair) => {
        try {
          const p = await fetchTickerPrice(pair);
          if (p && p > 0) priceMap.set(pair, p);
        } catch { /* keep going */ }
      }),
    );
    if (liveTickerMap) {
      for (const pair of pairs) {
        const last = liveTickerMap.get(pair)?.last;
        if (last && last > 0) priceMap.set(pair, last);
      }
    }

    for (const trade of openTrades) {
      const isLong = trade.type === "LONG";
      const sym = toMexcSymbol(trade.coin); // alias-aware (PUMP -> PUMPFUN_USDT)
      const posKey1 = `${sym}_${isLong ? 1 : 2}`;
      const posKey0 = `${sym}_0`;
      const pos = positionMap.get(posKey1) ?? positionMap.get(posKey0);
      const price = priceMap.get(trade.coin);
      // Prefer the exchange's average fill for PnL math once known.
      const bestEntry = pos && pos.avgPrice > 0 ? pos.avgPrice : trade.entryPrice;

      if (!pos) {
        if (!positionsFetchOk) {
          // Position status UNKNOWN — the exchange fetch failed this run.
          // Never fabricate a close on missing data: keep the ledger row open
          // (and managed) and retry on the next exit check.
          results.push(
            `${trade.coin}: holding (exchange positions fetch FAILED — not closed; will retry next exit check)`,
          );
          continue;
        }
        // Confirmed absent after a SUCCESSFUL fetch → closed somewhere. If this
        // row carried an exchange bracket and current price is past a level,
        // the bracket almost certainly fired it: label the close and record the
        // same ledger estimate the monitor path uses (exchange is still truth
        // for cash). Without breach evidence (manual close, liquidation,
        // price recovered) keep the generic reconciliation — no fabricated PnL.
        if (trade.exchangeStop && price && price > 0) {
          const tSl = trade.slPrice;
          const tTp = trade.tpPrice;
          let bracketTrigger: string | null = null;
          if (isLong) {
            if (price <= tSl) bracketTrigger = "Stop Loss";
            else if (tTp && price >= tTp) bracketTrigger = "Take Profit";
          } else {
            if (price >= tSl) bracketTrigger = "Stop Loss";
            else if (tTp && price <= tTp) bracketTrigger = "Take Profit";
          }
          if (bracketTrigger) {
            const expectedExit = expectedExitPrice({
              trigger: bracketTrigger as "Stop Loss" | "Take Profit",
              side: trade.type as "LONG" | "SHORT",
              slPrice: tSl,
              tpPrice: tTp,
            });
            const est = estimateExit({
              notionalUsd: trade.notionalUsd,
              entryPrice: trade.entryPrice ?? price,
              exitPrice: expectedExit,
              side: trade.type as "LONG" | "SHORT",
              slPrice: tSl,
            });
            await ctx.runMutation(api.liveEngine.markLiveClosed, {
              id: trade._id,
              exitPrice: expectedExit,
              exitTime: now,
              reason: bracketTrigger,
              pnlUsd: est.pnlUsd,
              realizedR: est.realizedR,
              feesUsd: est.fees,
            }).catch(() => {});
            closedCount++;
            results.push(
              `${trade.coin}: closed by exchange ${bracketTrigger} bracket @ ~${expectedExit.toFixed(4)} (est. ${est.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(est.pnlUsd).toFixed(2)} · verify on MEXC)`,
            );
            continue;
          }
        }
        // Position vanished with no bracket-breach evidence (manual close on
        // MEXC, exchange-side TP-SL, liquidation). Try to reconstruct REAL
        // pnl from the exchange's deal history before reconciling at $0.
        const recon = await reconstructClosedPnl({
          coin: trade.coin,
          type: trade.type,
          entryTime: trade.entryTime,
          entryPrice: trade.entryPrice,
          volContracts: trade.volContracts,
          notionalUsd: trade.notionalUsd,
          slPrice: trade.slPrice,
        });
        if (recon) {
          // NAME THE EXIT from the exchange's own fill against THIS row's
          // bracket (2026-09-22). The previous label - "Closed on exchange
          // (manual / TP-SL / liquidation)" - was a shrug that covered 47%
          // of the live book (34 of 72 exits) and identified none of them;
          // it is what hid six winners whose realizedR exceeded their own
          // recorded trailPeakR. The fill is the evidence, and a fill that
          // matches no bracket is reported as exactly that.
          const named = nameExitFromFill({
            fillPrice: recon.exitPrice,
            slPrice: trade.slPrice,
            tpPrice: trade.tpPrice,
            trailLockPrice: trade.trailLockPrice,
          });
          await ctx.runMutation(api.liveEngine.markLiveClosed, {
            id: trade._id,
            exitPrice: recon.exitPrice,
            exitTime: now,
            reason: named.name,
            pnlUsd: recon.pnlUsd,
            realizedR: recon.realizedR,
            feesUsd: recon.feesUsd,
          }).catch(() => {});
          closedCount++;
          results.push(
            `${trade.coin}: position not found on exchange — reconciled from deal history (pnl ${recon.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(recon.pnlUsd).toFixed(2)} @ ${recon.exitPrice.toFixed(4)})`,
          );
        } else {
          // No fill recoverable at all - say that, instead of guessing
          // between four causes. Row closes with no PnL, exactly as before.
          await ctx.runMutation(api.liveEngine.markLiveClosed, {
            id: trade._id,
            exitTime: now,
            reason: "Closed off-engine (no fill recovered)",
          }).catch(() => {});
          closedCount++;
          results.push(`${trade.coin}: position not found on exchange — ledger marked closed (verify on MEXC)`);
        }
        continue;
      }

      // Refine the stored entry with the exchange's average fill when known.
      if (pos.avgPrice > 0 && (!trade.entryPrice || Math.abs(pos.avgPrice - trade.entryPrice) / trade.entryPrice > 0.0005)) {
        await ctx.runMutation(api.liveEngine.refineLiveEntry, {
          id: trade._id,
          entryPrice: pos.avgPrice,
        }).catch(() => {});
      }

      if (!price || price <= 0) {
        results.push(`${trade.coin}: holding (no ticker — skipped SL/TP check)`);
        continue;
      }
      const slPrice = trade.slPrice;
      const tpPrice = trade.tpPrice;
      let trigger: string | null = null;
      if (isLong) {
        if (price <= slPrice) trigger = "Stop Loss";
        else if (tpPrice && price >= tpPrice) trigger = "Take Profit";
      } else {
        if (price >= slPrice) trigger = "Stop Loss";
        else if (tpPrice && price <= tpPrice) trigger = "Take Profit";
      }
      if (!trigger) {
        // Price recovered between the levels — clear any recorded bracket
        // breach so a later re-test restarts the backstop clock instead of
        // inheriting the old one.
        if (trade.exchangeStop && trade.bracketBreachSince != null) {
          await ctx.runMutation(api.liveEngine.setLiveBracketBreach, { id: trade._id }).catch(() => {});
        }
        results.push(`${trade.coin}: holding (${price.toFixed(4)} · SL ${slPrice.toFixed(4)} · TP ${tpPrice?.toFixed(4) ?? "—"})`);
        continue;
      }

      // Bracket rows: the exchange's own stop/TP order is the closer — never
      // race it with a second market close (one would fill, the other would
      // error against the now-empty position, and the open bracket side would
      // be canceled). The fill shows up as a missing position on the next
      // check and is reconciled above with its labeled close.
      let backstopNote: string | null = null;
      if (trade.exchangeStop) {
        const since = trade.bracketBreachSince;
        if (since != null && now - since >= BRACKET_BACKSTOP_MS) {
          // Dead-bracket backstop: a live exchange stop fills within ms of a
          // trade through the level, so a breach this old means the bracket
          // orders are gone (canceled on the exchange) — close at market
          // rather than let the position ride past its SL.
          backstopNote =
            `bracket backstop — exchange stop did not close ${trigger} within ${Math.round((now - since) / 60_000)} min`;
        } else {
          if (since == null) {
            await ctx.runMutation(api.liveEngine.setLiveBracketBreach, {
              id: trade._id,
              since: now,
            }).catch(() => {});
          }
          results.push(
            `${trade.coin}: ${trigger} level hit — exchange bracket is closing the position (ledger reconciles on the next check)`,
          );
          continue;
        }
      }

      // Place a real market close: close long = 4, close short = 2.
      const closeSide = isLong ? 4 : 2;
      const expectedExit = expectedExitPrice({
        trigger: trigger as "Stop Loss" | "Take Profit",
        side: trade.type as "LONG" | "SHORT",
        slPrice,
        tpPrice,
      });
      try {
        // Close min(our recorded size, actual position size) so a partial fill
        // or a manual downscale on the exchange can never oversize the close.
        const closeVol = pos.vol > 0 ? Math.min(trade.volContracts, pos.vol) : trade.volContracts;
        const closeRes: any = await privateRequest("POST", "/api/v1/private/order/create", {
          symbol: sym,
          price: 0, // market
          vol: closeVol,
          side: closeSide,
          type: 5,
          openType: 1,
        });
        const closeOrderId = String(closeRes?.orderId ?? "");

        // Ledger estimate — shared pure math (src/lib/live-math.ts), signed R
        // included. Scaled by the fraction actually closed when a partial or
        // downscaled position exists; exchange is truth for cash.
        const entryPx = bestEntry ?? price;
        const closeRatio = trade.volContracts > 0 ? Math.min(1, closeVol / trade.volContracts) : 1;
        const est = estimateExit({
          notionalUsd: trade.notionalUsd * closeRatio,
          entryPrice: entryPx,
          exitPrice: expectedExit,
          side: trade.type as "LONG" | "SHORT",
          slPrice: trade.slPrice,
        });

        await ctx.runMutation(api.liveEngine.markLiveClosed, {
          id: trade._id,
          exitPrice: expectedExit,
          exitTime: now,
          reason: trigger,
          pnlUsd: est.pnlUsd,
          realizedR: est.realizedR,
          feesUsd: est.fees,
          exitOrderId: closeOrderId,
        });
        closedCount++;
        results.push(
          `${trade.coin}: CLOSED ${trigger} @ ${expectedExit.toFixed(4)} (est. ${est.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(est.pnlUsd).toFixed(2)} · close order ${closeOrderId}` +
            (backstopNote ? ` · ${backstopNote}` : "") +
            ")",
        );
      } catch (e: any) {
        results.push(`${trade.coin}: ${trigger} close order FAILED — ${e?.message ?? e} (position still open)`);
      }
    }

    await ctx.runMutation(api.liveEngine.setLiveMeta, {
      lastExitAt: now,
      lastExitResult:
        `${results.length} checked · ${closedCount} closed` +
        (balanceUsd ? ` · balance ${fmtUsd(balanceUsd)}` : "") +
        (positionsFetchOk
          ? ""
          : " · ⚠ open-positions fetch failed — no positions closed (next check retries)"),
      balanceUsd,
      walletBalanceUsd: walletUsd,
    }).catch(() => {});
    return { status: "ok", checked: openTrades.length, closed: closedCount, results };
  },
});

// ── Manual close from the Live page ──

// ── LEGACY, INTERNAL ONLY — do not call ──
// Superseded by liveReconcile.manualCloseLiveTradeSafe (the authenticated
// wrapper the Live page uses). Same reason as liveExitTick above: unfenced raw
// order placement, internal-only, unreachable from the UI.
export const manualCloseLiveTrade = action({
  args: { id: v.id("liveTrades") },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const openTrades: any[] = await ctx.runQuery(api.liveEngine.getLiveOpenTrades);
    const trade = openTrades.find((t: any) => t._id === args.id);
    if (!trade) return { ok: false, reason: "trade not open" };
    if (!creds()) return { ok: false, reason: "MEXC credentials missing on deployment" };
    const isLong = trade.type === "LONG";
    const sym = toMexcSymbol(trade.coin); // alias-aware (PUMP -> PUMPFUN_USDT)
    try {
      // Actual exchange position FIRST — never submit more volume than the
      // exchange holds (mirrors the exit tick's min() guard): a partial fill
      // or a manual downscale must not produce an oversized close order. If a
      // successful fetch shows the position is already gone (manual close on
      // MEXC, TP/SL placed there, liquidation), reconcile the ledger instead
      // of erroring. If the fetch itself fails, nothing is touched.
      const positionMap = await fetchOpenPositions();
      const pos =
        positionMap.get(`${sym}_${isLong ? 1 : 2}`) ?? positionMap.get(`${sym}_0`);
      if (!pos) {
        // Position is gone. Name the exit from the exchange's deal history
        // instead of shrugging - same attribution rule as the exit tick.
        const recon = await reconstructClosedPnl({
          coin: trade.coin,
          type: trade.type,
          entryTime: trade.entryTime,
          entryPrice: trade.entryPrice,
          volContracts: trade.volContracts,
          notionalUsd: trade.notionalUsd,
          slPrice: trade.slPrice,
        });
        if (recon) {
          const named = nameExitFromFill({
            fillPrice: recon.exitPrice,
            slPrice: trade.slPrice,
            tpPrice: trade.tpPrice,
            trailLockPrice: trade.trailLockPrice,
          });
          await ctx.runMutation(api.liveEngine.markLiveClosed, {
            id: trade._id,
            exitPrice: recon.exitPrice,
            exitTime: Date.now(),
            reason: named.name,
            pnlUsd: recon.pnlUsd,
            realizedR: recon.realizedR,
            feesUsd: recon.feesUsd,
          }).catch(() => {});
          return {
            ok: true,
            reason:
              "Position already gone - " +
              named.name +
              ", reconciled from deal history (pnl " +
              (recon.pnlUsd >= 0 ? "+" : "-") +
              "$" +
              Math.abs(recon.pnlUsd).toFixed(2) +
              ").",
          };
        }
        await ctx.runMutation(api.liveEngine.markLiveClosed, {
          id: trade._id,
          exitTime: Date.now(),
          reason: "Closed off-engine (no fill recovered)",
        }).catch(() => {});
        return {
          ok: true,
          reason: "Position already gone on the exchange — ledger reconciled (no PnL recorded).",
        };
      }

      const price = await fetchTickerPrice(trade.coin);
      const closeVol = pos.vol > 0 ? Math.min(trade.volContracts, pos.vol) : trade.volContracts;
      const closeRes: any = await privateRequest("POST", "/api/v1/private/order/create", {
        symbol: sym,
        price: 0,
        vol: closeVol,
        side: isLong ? 4 : 2,
        type: 5,
        openType: 1,
      });
      const exitPx = price > 0 ? price : trade.entryPrice;
      const entryPx = pos.avgPrice > 0 ? pos.avgPrice : trade.entryPrice ?? exitPx;
      const closeRatio = trade.volContracts > 0 ? Math.min(1, closeVol / trade.volContracts) : 1;
      const est = estimateExit({
        notionalUsd: trade.notionalUsd * closeRatio,
        entryPrice: entryPx,
        exitPrice: exitPx,
        side: trade.type as "LONG" | "SHORT",
        slPrice: trade.slPrice,
      });
      await ctx.runMutation(api.liveEngine.markLiveClosed, {
        id: trade._id,
        exitPrice: exitPx,
        exitTime: Date.now(),
        reason: "Manual close",
        pnlUsd: est.pnlUsd,
        realizedR: est.realizedR,
        feesUsd: est.fees,
        exitOrderId: String(closeRes?.orderId ?? ""),
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: e?.message ?? String(e) };
    }
  },
});
