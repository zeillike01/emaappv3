/**
 * MOCK-EXCHANGE INTEGRATION HARNESS — live entry → exchange bracket (2026-09-24).
 *
 * WHY THIS EXISTS
 * Every other test of the live book exercises PURE helpers. The pieces that
 * actually put a real stop order on MEXC — the signed request builder, the
 * order/position/stop-order response parsing, the side-aware position match, the
 * durable bracket claim, adopt-vs-place, and the ambiguous-outcome handling —
 * have never been run against an exchange that answers. This harness runs that
 * code FOR REAL (`liveBrokerRuntime.ts` is imported, not re-implemented), with
 * only two things faked:
 *
 *   1. `globalThis.fetch` — a scripted MEXC (`contract.mexc.com`) that returns
 *      realistic contract_v1 payloads and can inject the fault classes the
 *      broker distinguishes: a network cut / HTTP 5xx (AMBIGUOUS — the request
 *      may have landed) versus HTTP 4xx or `success:false` (DEFINITIVE).
 *   2. `ctx.runQuery` / `ctx.runMutation` — a small in-memory ledger whose
 *      handlers mirror the real `liveEngine` mutations' guards (intent gating,
 *      bracket claim fencing, "never re-stamp a frozen ruler"). Dispatch is by
 *      `getFunctionName(ref)`, so an unemulated call throws instead of being
 *      silently ignored.
 *
 * WHAT IT PROVES
 * The entry path opens the ledger row first and only then places the bracket;
 * a bracket is placed exactly once per position (no duplicates on repeat passes
 * or concurrent attempts); an already-resting bracket is adopted; an ambiguous
 * stop-order read never triggers a placement; and hedge-mode opposite-side rows
 * are never mistaken for this trade's position. It also proves the bracket fence
 * is BOUNDED: a claim that is fresh still blocks a retry, but one old enough that
 * its request can no longer be in flight — with the book readable and holding no
 * bracket — is expired so the position gets its stop instead of staying
 * unprotected forever.
 *
 * WHAT IT DOES NOT COVER (read before trusting it)
 * The ledger is a model. Bugs INSIDE the real `liveEngine` mutations or the
 * Convex schema will not be caught here — only the broker's call sequence and
 * payloads are under test. The close path (claim → submit → settle) is not
 * exercised yet, and no MEXC sandbox/live account is involved.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getFunctionName } from "convex/server";
import { toMexcSymbol } from "../tracked-pairs";
import { ensureLiveBracket, reconcilePendingLiveEntries } from "../../convex/liveBrokerRuntime";

// ── Faked MEXC contract_v1 ──────────────────────────────────────────────────

/** A one-shot injected failure for a `${METHOD} ${pathname}` route. */
type Fault =
  | "network"
  /** The request REACHED the exchange and applied, but the reply was cut. */
  | "network-but-applied"
  | number
  | { success: false; code: number; message: string };

type Recorded = {
  method: string;
  path: string;
  query: string;
  body: any;
  headers: Record<string, string>;
};

const jsonResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });

class MockMexc {
  positions: any[] = [];
  orders: any[] = [];
  stopOrders: any[] = [];
  calls: Recorded[] = [];
  private faults = new Map<string, Fault[]>();
  private originalFetch = globalThis.fetch;

  install(): this {
    globalThis.fetch = this.fetchImpl.bind(this) as any;
    return this;
  }

  restore(): void {
    globalThis.fetch = this.originalFetch;
  }

  /** Queue one-shot faults for a route, consumed in order. */
  fault(method: "GET" | "POST", path: string, ...list: Fault[]): this {
    this.faults.set(`${method} ${path}`, list);
    return this;
  }

  count(method: "GET" | "POST", pathFragment: string): number {
    return this.calls.filter((c) => c.method === method && c.path.includes(pathFragment)).length;
  }

  placeBodies(): any[] {
    return this.calls
      .filter((c) => c.method === "POST" && c.path === "/api/v1/private/stoporder/place")
      .map((c) => c.body);
  }

  private async fetchImpl(input: any, init: any = {}): Promise<Response> {
    const url = new URL(String(input));
    const method = String(init.method ?? "GET").toUpperCase() as "GET" | "POST";
    const body = init.body ? JSON.parse(String(init.body)) : null;
    this.calls.push({
      method,
      path: url.pathname,
      query: url.search,
      body,
      headers: (init.headers ?? {}) as Record<string, string>,
    });

    const queued = this.faults.get(`${method} ${url.pathname}`);
    if (queued?.length) {
      const fault = queued.shift()!;
      if (fault === "network") throw new TypeError("fetch failed (mock network cut)");
      if (fault === "network-but-applied") {
        this.route(method, url, body); // the exchange did the work...
        throw new TypeError("fetch failed after the request landed (mock cut reply)"); // ...the reply never arrived
      }
      if (typeof fault === "number") return jsonResponse({}, fault);
      return jsonResponse(fault);
    }
    return this.route(method, url, body);
  }

  private route(method: "GET" | "POST", url: URL, body: any): Response {
    const path = url.pathname;
    if (path === "/api/v1/contract/detail") {
      return jsonResponse({
        success: true,
        data: [
          {
            symbol: url.searchParams.get("symbol"),
            contractSize: 0.0001,
            volScale: 0,
            minVol: 1,
            maxVol: 1_000_000,
            volUnit: 1,
            maxLeverage: 100,
            priceUnit: 0.1,
          },
        ],
      });
    }
    if (path.startsWith("/api/v1/private/order/get/")) {
      const id = decodeURIComponent(path.slice("/api/v1/private/order/get/".length));
      return jsonResponse({
        success: true,
        data: this.orders.find((o) => String(o.orderId) === id) ?? null,
      });
    }
    if (path === "/api/v1/private/order/list/history_orders") {
      return jsonResponse({ success: true, data: this.orders });
    }
    if (path === "/api/v1/private/position/open_positions") {
      return jsonResponse({ success: true, data: this.positions });
    }
    if (path === "/api/v1/private/stoporder/list/orders") {
      return jsonResponse({ success: true, data: this.stopOrders });
    }
    if (method === "POST" && path === "/api/v1/private/stoporder/place") {
      // A real placement shows up in the very next list call — the harness keeps
      // that property so adopt-vs-place is exercised honestly.
      this.stopOrders.push({
        state: 1,
        positionId: body?.positionId,
        vol: body?.vol,
        stopLossPrice: body?.stopLossPrice,
        takeProfitPrice: body?.takeProfitPrice,
      });
      return jsonResponse({ success: true, data: { orderId: `stop-${this.stopOrders.length}` } });
    }
    if (method === "POST" && path === "/api/v1/private/order/create") {
      this.orders.push({ orderId: "111", state: 1, vol: body?.vol, externalOid: body?.externalOid });
      return jsonResponse({ success: true, data: { orderId: "111" } });
    }
    if (path === "/api/v1/private/account/assets") {
      return jsonResponse({
        success: true,
        data: [{ currency: "USDT", equity: 1000, availableBalance: 900 }],
      });
    }
    return jsonResponse({ success: true, data: [] });
  }
}

// ── Faked ledger (mirrors the liveEngine guards the broker depends on) ──────

const ACTIVE_ENTRY_INTENTS = new Set(["pending", "submitting", "submitted", "unknown"]);
const ACTIVE_BRACKET_INTENTS = new Set(["pending", "submitted", "unknown"]);

class MockLedger {
  rows = new Map<string, any>();
  trace: string[] = [];
  private seq = 1;

  constructor(...rows: any[]) {
    for (const row of rows) this.rows.set(row._id, row);
  }

  get(id: string): any {
    return this.rows.get(id);
  }

  nextIntentId(rowId: string): string {
    return `br-${rowId}-${this.seq++}`;
  }

  ctx(): { runQuery: any; runMutation: any } {
    const dispatch = async (ref: any, args: any = {}): Promise<any> => {
      const name = getFunctionName(ref);
      this.trace.push(name);
      const row = args?.id != null ? this.get(String(args.id)) : null;
      switch (name) {
        case "liveEngine:getLivePendingEntries":
          return [...this.rows.values()].filter(
            (r) =>
              r.status === "pending" &&
              !["failed", "cancelled"].includes(String(r.entryIntentStatus ?? "pending")),
          );
        case "liveEngine:getLiveOpenTrades":
          return [...this.rows.values()].filter((r) => r.status === "open");

        case "liveEngine:markLiveEntrySubmitting":
          if (!row || row.status !== "pending") return { ok: false, reason: "intent-not-active" };
          row.entryIntentStatus = "submitting";
          return { ok: true };

        case "liveEngine:markLiveEntrySubmitted":
          if (!row || row.status !== "pending") return { ok: false, reason: "intent-not-active" };
          row.entryIntentStatus = "submitted";
          if (args.orderId) row.orderId = args.orderId;
          return { ok: true };

        case "liveEngine:markLiveEntryIntentError":
          if (!row || row.status !== "pending") return { ok: false, reason: "not-pending" };
          row.entryIntentStatus = args.definitive ? "failed" : "unknown";
          row.entryLastError = args.error;
          if (args.definitive) row.status = "cancelled";
          return { ok: true };

        case "liveEngine:recordLiveEntry": {
          const intent =
            (args.intentId ? this.get(String(args.intentId)) : null) ??
            [...this.rows.values()].find(
              (r) =>
                (args.externalOid != null && r.externalOid === args.externalOid) ||
                (args.orderId != null && r.orderId === args.orderId) ||
                (r.coin === args.coin && r.type === args.type && r.entryTime === args.entryTime),
            );
          if (!intent) return { inserted: false, reason: "intent-not-found" };
          if (intent.status === "open") return { inserted: false, reason: "already-open", id: intent._id };
          if (
            intent.status !== "pending" ||
            !ACTIVE_ENTRY_INTENTS.has(String(intent.entryIntentStatus ?? "pending"))
          ) {
            return { inserted: false, reason: "intent-not-active" };
          }
          if (intent.coin !== args.coin || intent.type !== args.type) {
            return { inserted: false, reason: "intent-mismatch" };
          }
          Object.assign(intent, {
            status: "open",
            entryIntentStatus: "filled",
            entryTime: args.entryTime,
            signalTime: args.signalTime,
            signalPrice: args.signalPrice,
            entryPrice: args.entryPrice,
            slPrice: args.slPrice,
            tpPrice: args.tpPrice,
            trailStartR: args.trailStartR,
            trailStepR: args.trailStepR,
            trailMaxR: args.trailMaxR,
            // Only the first open transition may stamp the frozen ruler/anchor.
            ...(typeof args.riskPx === "number" && args.riskPx > 0 ? { riskPx: args.riskPx } : {}),
            ...(typeof args.rLockAnchorPrice === "number" && args.rLockAnchorPrice > 0
              ? { rLockAnchorPrice: args.rLockAnchorPrice }
              : {}),
            trailPeakR: 0,
            trailLockPrice: 0,
            volContracts: args.volContracts,
            notionalUsd: args.notionalUsd,
            marginUsd: args.marginUsd,
            leverage: args.leverage,
            orderId: args.orderId ?? intent.orderId,
            externalOid: args.externalOid ?? intent.externalOid,
            positionId: args.positionId ?? intent.positionId,
            exchangeStop: args.exchangeStop ?? intent.exchangeStop,
            ...(args.exchangeStop === true || intent.exchangeStop === true
              ? { bracketIntentStatus: "attached" }
              : {}),
          });
          return { inserted: true, id: intent._id };
        }

        case "liveEngine:claimLiveBracket": {
          if (!row || !["pending", "open"].includes(row.status)) {
            return { claimed: false, reason: "not-manageable" };
          }
          if (row.exchangeStop === true || row.bracketIntentStatus === "attached") {
            return { claimed: false, reason: "already-attached" };
          }
          if (ACTIVE_BRACKET_INTENTS.has(String(row.bracketIntentStatus))) {
            return { claimed: false, reason: "intent-pending", intentId: row.bracketIntentId };
          }
          const intentId = this.nextIntentId(row._id);
          row.bracketIntentStatus = "pending";
          row.bracketIntentId = intentId;
          row.bracketIntentAt = Date.now();
          return { claimed: true, intentId };
        }

        case "liveEngine:expireLiveBracketIntent": {
          if (!row || !["pending", "open"].includes(row.status)) {
            return { ok: false, reason: "not-manageable" };
          }
          if (row.exchangeStop === true || row.bracketIntentStatus === "attached") {
            return { ok: false, reason: "already-attached" };
          }
          if (String(row.bracketIntentId ?? "") !== args.intentId) {
            return { ok: false, reason: "intent-changed" };
          }
          if (!ACTIVE_BRACKET_INTENTS.has(String(row.bracketIntentStatus))) {
            return { ok: false, reason: "not-active" };
          }
          const claimedAt = Number(row.bracketIntentAt ?? 0) || Number(row.entryTime ?? 0);
          const ageMs = Date.now() - claimedAt;
          if (!(claimedAt > 0) || !(ageMs >= args.staleMs)) {
            return { ok: false, reason: "not-stale", ageMs };
          }
          row.bracketIntentStatus = "stale";
          row.bracketStaleAt = Date.now();
          row.bracketLastError = `bracket intent expired after ${Math.round(ageMs / 60_000)}m with no resting exchange stop; retrying under a fresh claim`;
          return { ok: true, ageMs };
        }

        case "liveEngine:markLiveBracketAttached": {
          if (!row || !["pending", "open"].includes(row.status)) {
            return { ok: false, reason: "not-manageable" };
          }
          if (row.exchangeStop === true) return { ok: true, alreadyAttached: true };
          if (row.bracketIntentId !== args.intentId) return { ok: false, reason: "intent-mismatch" };
          const sideSign = row.type === "LONG" ? 1 : -1;
          const anchor =
            args.rLockAnchorPrice ??
            row.rLockAnchorPrice ??
            (typeof row.riskPx === "number" && row.riskPx > 0
              ? args.slPrice + sideSign * row.riskPx
              : row.entryPrice);
          Object.assign(row, {
            exchangeStop: true,
            slPrice: args.slPrice,
            tpPrice: args.tpPrice,
            ...(row.positionId == null && args.positionId != null
              ? { positionId: args.positionId }
              : {}),
            bracketIntentStatus: "attached",
            ...(typeof row.riskPx !== "number" && args.riskPx != null ? { riskPx: args.riskPx } : {}),
            ...(row.rLockAnchorPrice == null && anchor != null
              ? { rLockAnchorPrice: anchor }
              : {}),
          });
          return { ok: true };
        }

        case "liveEngine:markLiveBracketFailed": {
          if (!row || row.bracketIntentId !== args.intentId) {
            return { ok: false, reason: "intent-mismatch" };
          }
          row.bracketIntentStatus = args.definitive ? "failed" : "unknown";
          row.bracketLastError = args.error;
          return { ok: true };
        }

        default:
          throw new Error(`mock ledger has no handler for ${name} (unexpected call path)`);
      }
    };
    return {
      runQuery: (ref: any, args: any = {}) => dispatch(ref, args),
      runMutation: (ref: any, args: any = {}) => dispatch(ref, args),
    };
  }
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const ENTRY = {
  entryTime: 1_700_000_000_000,
  signalPrice: 60000,
  entryPrice: 60000,
  slPrice: 59100,
  tpPrice: 65400,
  trailStartR: 1.5,
  trailStepR: 0.25,
  trailMaxR: 6,
  volContracts: 5,
  notionalUsd: 30,
  marginUsd: 3,
  leverage: 10,
  orderId: "111",
};

/** A durable, submitted-but-unsettled entry intent (the reclaimable state). */
function pendingIntent(coin: string, overrides: Record<string, unknown> = {}) {
  return {
    _id: `lt-${coin}`,
    coin,
    type: "LONG",
    status: "pending",
    entryIntentStatus: "submitted",
    externalOid: `lv${ENTRY.entryTime}-${coin.toLowerCase()}`,
    exchangeStop: false,
    ...ENTRY,
    ...overrides,
  };
}

const fillOrder = (positionId = 777) => ({
  orderId: "111",
  state: 3,
  dealAvgPrice: 60050,
  dealVol: 5,
  positionId,
  externalOid: `lv${ENTRY.entryTime}-btc`,
});

const positionRow = (symbol: string, side: number, positionId: number | null = 777) => ({
  symbol,
  side,
  holdVol: 5,
  holdAvgPrice: 60050,
  positionId,
});

// Frozen geometry implied by ENTRY at a 60050 fill (priceUnit 0.1):
// risk 900 (60000 → 59100), lock-max target 6R = 5400 → 60050 ± those.
const EXPECTED_SL = 59150;
const EXPECTED_TP = 65450;

let mexc: MockMexc;
let ledger: MockLedger;

beforeEach(() => {
  process.env.MEXC_API_KEY = "test-key";
  process.env.MEXC_API_SECRET = "test-secret";
  mexc = new MockMexc().install();
  ledger = new MockLedger();
});

afterEach(() => {
  mexc.restore();
});

describe("live entry → bracket against a mock MEXC", () => {
  it("opens the ledger row first, then places exactly one bracket from the frozen geometry", async () => {
    const intent = pendingIntent("BTC");
    ledger = new MockLedger(intent);
    mexc.orders = [fillOrder()];
    mexc.positions = [positionRow("BTC_USDT", 1)];

    const summary = await reconcilePendingLiveEntries(ledger.ctx());

    expect(summary).toMatchObject({ checked: 1, opened: 1, pending: 0, failed: 0, unmanaged: 0 });
    // Durable open BEFORE the stop order: the ledger write must precede the place.
    const open = ledger.trace.indexOf("liveEngine:recordLiveEntry");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(ledger.trace.indexOf("liveEngine:claimLiveBracket")).toBeGreaterThan(open);
    expect(ledger.trace.lastIndexOf("liveEngine:markLiveBracketAttached")).toBeGreaterThan(open);

    const row = ledger.get("lt-BTC");
    expect(row.status).toBe("open");
    expect(row.exchangeStop).toBe(true);
    expect(row.bracketIntentStatus).toBe("attached");
    expect(row.riskPx).toBe(900);
    expect(row.rLockAnchorPrice).toBe(60050);
    expect(row.slPrice).toBe(EXPECTED_SL);
    expect(row.tpPrice).toBe(EXPECTED_TP);

    const places = mexc.placeBodies();
    expect(places).toHaveLength(1);
    expect(places[0]).toMatchObject({
      positionId: 777,
      vol: 5,
      stopLossPrice: EXPECTED_SL,
      takeProfitPrice: EXPECTED_TP,
      lossTrend: 1,
      profitTrend: 1,
      priceProtect: 0,
    });
  });

  it("never places a second bracket on a repeat pass", async () => {
    const intent = pendingIntent("ETH", { _id: "lt-ETH" });
    ledger = new MockLedger(intent);
    mexc.orders = [{ ...fillOrder(), externalOid: `lv${ENTRY.entryTime}-eth` }];
    mexc.positions = [positionRow("ETH_USDT", 1)];

    await reconcilePendingLiveEntries(ledger.ctx());
    const first = mexc.count("POST", "/stoporder/place");
    await reconcilePendingLiveEntries(ledger.ctx());
    // The row is open now, so it is not in the pending set at all.
    expect(mexc.count("POST", "/stoporder/place")).toBe(first);
    expect(first).toBe(1);
  });

  it("adopts an already-resting exchange bracket instead of placing a duplicate", async () => {
    const intent = pendingIntent("SOL", { _id: "lt-SOL" });
    ledger = new MockLedger(intent);
    mexc.orders = [{ ...fillOrder(), externalOid: `lv${ENTRY.entryTime}-sol` }];
    mexc.positions = [positionRow("SOL_USDT", 1)];
    mexc.stopOrders = [
      { state: 1, positionId: 777, stopLossPrice: 59100, takeProfitPrice: 66000 },
    ];

    await reconcilePendingLiveEntries(ledger.ctx());

    expect(mexc.count("POST", "/stoporder/place")).toBe(0);
    const row = ledger.get("lt-SOL");
    expect(row.exchangeStop).toBe(true);
    expect(row.bracketIntentStatus).toBe("attached");
    // The adopted levels are the exchange's, not the ledger's request.
    expect(row.slPrice).toBe(59100);
    expect(row.tpPrice).toBe(66000);
  });

  it("does NOT place anything when the stop-order read is ambiguous, and retries cleanly later", async () => {
    const intent = pendingIntent("DOGE", { _id: "lt-DOGE" });
    ledger = new MockLedger(intent);
    mexc.orders = [{ ...fillOrder(), externalOid: `lv${ENTRY.entryTime}-doge` }];
    mexc.positions = [positionRow("DOGE_USDT", 1)];
    mexc.fault("GET", "/api/v1/private/stoporder/list/orders", "network");

    await reconcilePendingLiveEntries(ledger.ctx());
    // The ledger row is open, but nothing was placed on an unreadable book.
    expect(ledger.get("lt-DOGE").status).toBe("open");
    expect(mexc.count("POST", "/stoporder/place")).toBe(0);

    // Next pass, exchange healthy and no resting bracket → exactly one placement.
    const bracket = await ensureLiveBracket({
      ctx: ledger.ctx(),
      trade: { ...ledger.get("lt-DOGE") },
      position: { vol: 5, avgPrice: 60050, positionId: 777 },
    });
    expect(bracket.state).toBe("attached");
    expect(mexc.count("POST", "/stoporder/place")).toBe(1);
  });

  it("retries after a DEFINITIVE rejection (the request never landed)", async () => {
    const intent = pendingIntent("ADA", { _id: "lt-ADA" });
    ledger = new MockLedger(intent);
    mexc.orders = [{ ...fillOrder(), externalOid: `lv${ENTRY.entryTime}-ada` }];
    mexc.positions = [positionRow("ADA_USDT", 1)];
    mexc.fault("POST", "/api/v1/private/stoporder/place", {
      success: false,
      code: 4003,
      message: "insufficient position",
    });

    await reconcilePendingLiveEntries(ledger.ctx());
    expect(ledger.get("lt-ADA").bracketIntentStatus).toBe("failed");
    expect(ledger.get("lt-ADA").exchangeStop).toBe(false);

    const retry = await ensureLiveBracket({
      ctx: ledger.ctx(),
      trade: { ...ledger.get("lt-ADA") },
      position: { vol: 5, avgPrice: 60050, positionId: 777 },
    });
    expect(retry.state).toBe("attached");
    expect(mexc.count("POST", "/stoporder/place")).toBe(2);
  });

  it("recovers an AMBIGUOUS place: a FRESH claim still fences, an aged one expires", async () => {
    // Network cut on the placement: the request may or may not have landed, so
    // the ledger correctly refuses to place again while the claim could still be
    // resolved (a duplicate stop would be worse than a late one).
    const intent = pendingIntent("XRP", { _id: "lt-XRP" });
    ledger = new MockLedger(intent);
    mexc.orders = [{ ...fillOrder(), externalOid: `lv${ENTRY.entryTime}-xrp` }];
    mexc.positions = [positionRow("XRP_USDT", 1)];
    mexc.fault("POST", "/api/v1/private/stoporder/place", "network");

    await reconcilePendingLiveEntries(ledger.ctx());
    const row = ledger.get("lt-XRP");
    expect(row.bracketIntentStatus).toBe("unknown");
    expect(mexc.count("POST", "/stoporder/place")).toBe(1);

    // The exchange has no bracket for this position (the request did not land).
    expect(mexc.stopOrders).toHaveLength(0);

    // While the claim is fresh, later passes — cron, recovery, R-lock — still
    // short-circuit on it. That is the point of the fence.
    const fenced = await ensureLiveBracket({
      ctx: ledger.ctx(),
      trade: { ...row },
      position: { vol: 5, avgPrice: 60050, positionId: 777 },
    });
    expect(fenced.state).toBe("pending");
    expect(mexc.count("POST", "/stoporder/place")).toBe(1);
    expect(row.exchangeStop).toBe(false);

    // Once the claim is old enough that its request can no longer be in flight —
    // and with the book readable and holding no bracket — the fence expires and
    // the position finally gets its stop instead of staying monitor-only forever.
    row.bracketIntentAt = Date.now() - 30 * 60_000;
    const out = await ensureLiveBracket({
      ctx: ledger.ctx(),
      trade: { ...row },
      position: { vol: 5, avgPrice: 60050, positionId: 777 },
    });
    expect(out.state).toBe("attached");
    expect(mexc.count("POST", "/stoporder/place")).toBe(2);
    expect(ledger.get("lt-XRP").exchangeStop).toBe(true);
    expect(ledger.get("lt-XRP").bracketStaleAt).toBeGreaterThan(0);
  });

  it("recovers a crash between claim and place under the same bounded fence", async () => {
    const row = {
      ...pendingIntent("LINK", { _id: "lt-LINK" }),
      status: "open",
      entryIntentStatus: "filled",
      slPrice: EXPECTED_SL,
      tpPrice: EXPECTED_TP,
      riskPx: 900,
      rLockAnchorPrice: 60050,
      // Exactly the state a process death after claimLiveBracket leaves behind.
      bracketIntentStatus: "pending",
      bracketIntentId: "br-lt-LINK-crashed",
      bracketIntentAt: Date.now(),
    };
    ledger = new MockLedger(row);
    mexc.positions = [positionRow("LINK_USDT", 1)];

    // The claim is fresh, so the row stays fenced: the dead process's request
    // could still be in flight.
    const fenced = await ensureLiveBracket({
      ctx: ledger.ctx(),
      trade: { ...row },
      position: { vol: 5, avgPrice: 60050, positionId: 777 },
    });
    expect(fenced.state).toBe("pending");
    expect(mexc.count("POST", "/stoporder/place")).toBe(0);

    // Aged past the window with the book readable and no bracket on it → the
    // claim is expired and the unprotected position gets a stop.
    row.bracketIntentAt = Date.now() - 20 * 60_000;
    const out = await ensureLiveBracket({
      ctx: ledger.ctx(),
      trade: { ...row },
      position: { vol: 5, avgPrice: 60050, positionId: 777 },
    });
    expect(out.state).toBe("attached");
    expect(mexc.count("GET", "/stoporder/list/orders")).toBeGreaterThan(0);
    expect(mexc.count("POST", "/stoporder/place")).toBe(1);
    expect(ledger.get("lt-LINK").exchangeStop).toBe(true);
    expect(ledger.get("lt-LINK").bracketIntentStatus).toBe("attached");
  });

  it("self-heals: an ambiguous place that DID land is adopted on the next pass", async () => {
    const intent = pendingIntent("APT", { _id: "lt-APT" });
    ledger = new MockLedger(intent);
    mexc.orders = [{ ...fillOrder(), externalOid: `lv${ENTRY.entryTime}-apt` }];
    mexc.positions = [positionRow("APT_USDT", 1)];
    // The request reached MEXC and the stop exists, but the reply was cut. The
    // broker cannot tell the difference from a request that never arrived —
    // which is exactly why it must not retry blindly. Here the bracket IS there.
    mexc.fault("POST", "/api/v1/private/stoporder/place", "network-but-applied");

    await reconcilePendingLiveEntries(ledger.ctx());
    expect(ledger.get("lt-APT").bracketIntentStatus).toBe("unknown");
    expect(mexc.stopOrders).toHaveLength(1); // the request DID land

    // Adoption is checked BEFORE the fence, so the resting bracket is picked up.
    const out = await ensureLiveBracket({
      ctx: ledger.ctx(),
      trade: { ...ledger.get("lt-APT") },
      position: { vol: 5, avgPrice: 60050, positionId: 777 },
    });
    expect(out.state).toBe("attached");
    expect(ledger.get("lt-APT").exchangeStop).toBe(true);
    expect(ledger.get("lt-APT").slPrice).toBe(EXPECTED_SL);
  });

  it("KNOWN GAP: a row with no usable stop distance is placed with NULL stop levels", async () => {
    // beginLiveEntry always writes a validated stop, so this is not reachable
    // through the current creator — but a legacy/hand-edited pending row would
    // land here, and entryGeometry falls back to a ZERO risk distance, which
    // rounds into a stop exactly at the fill price.
    const row = {
      ...pendingIntent("TAO", {
        _id: "lt-TAO",
        slPrice: undefined,
        tpPrice: undefined,
        entryPrice: 60000,
        trailStartR: undefined,
        trailMaxR: undefined,
      }),
      status: "open",
      entryIntentStatus: "filled",
    };
    ledger = new MockLedger(row);
    mexc.positions = [positionRow("TAO_USDT", 1)];

    const out = await ensureLiveBracket({
      ctx: ledger.ctx(),
      trade: { ...row },
      position: { vol: 5, avgPrice: 60050, positionId: 777 },
    });

    // `roundPrice(undefined, 0.1)` is NaN, and NaN serializes to null on the
    // wire. The `attach.slPrice == null` guard does NOT catch NaN, so a lenient
    // acceptance is reported as a healthy bracket (state "attached") and the
    // ledger is stamped exchangeStop: true with NaN levels. A strict exchange
    // rejects it instead — and then every following pass retries the identical
    // unusable request forever.
    const placed = mexc.placeBodies();
    expect(placed).toHaveLength(1);
    expect(placed[0].stopLossPrice).toBeNull();
    expect(placed[0].takeProfitPrice).toBeNull();
    expect(out.state).toBe("attached");
    expect(Number.isFinite(ledger.get("lt-TAO").slPrice)).toBe(false);
  });

  it("never brackets the opposite side's hedge-mode row", async () => {
    const intent = pendingIntent("LTC", { _id: "lt-LTC" });
    ledger = new MockLedger(intent);
    mexc.orders = [{ ...fillOrder(), externalOid: `lv${ENTRY.entryTime}-ltc` }];
    // Only the SHORT side of this symbol is visible (hedge mode, other trade).
    mexc.positions = [positionRow("LTC_USDT", 2, 999)];

    const summary = await reconcilePendingLiveEntries(ledger.ctx());
    expect(mexc.count("POST", "/stoporder/place")).toBe(0);
    expect(summary.opened).toBe(1); // the fill still opens the ledger row
    expect(summary.unmanaged).toBe(1); // ... but nothing is bracketed
    expect(mexc.placeBodies()).toHaveLength(0);

    // Once the LONG side appears, the bracket is placed against THAT position.
    mexc.positions = [positionRow("LTC_USDT", 2, 999), positionRow("LTC_USDT", 1, 777)];
    const out = await ensureLiveBracket({
      ctx: ledger.ctx(),
      trade: { ...ledger.get("lt-LTC") },
      position: { vol: 5, avgPrice: 60050, positionId: 777 },
    });
    expect(out.state).toBe("attached");
    expect(mexc.placeBodies()[0]).toMatchObject({ positionId: 777 });
  });

  it("declines to place when the position has no id to attach to", async () => {
    const row = {
      ...pendingIntent("AVAX", { _id: "lt-AVAX" }),
      status: "open",
      entryIntentStatus: "filled",
      slPrice: EXPECTED_SL,
      tpPrice: EXPECTED_TP,
    };
    ledger = new MockLedger(row);

    const out = await ensureLiveBracket({
      ctx: ledger.ctx(),
      trade: { ...row },
      position: { vol: 5, avgPrice: 60050, positionId: null },
    });
    expect(out.state).toBe("unmanaged");
    expect(mexc.count("POST", "/stoporder/place")).toBe(0);
  });

  it("places exactly one bracket when two passes race on the same row", async () => {
    const row = {
      ...pendingIntent("DOT", { _id: "lt-DOT" }),
      status: "open",
      entryIntentStatus: "filled",
      slPrice: EXPECTED_SL,
      tpPrice: EXPECTED_TP,
      riskPx: 900,
      rLockAnchorPrice: 60050,
    };
    ledger = new MockLedger(row);
    mexc.positions = [positionRow("DOT_USDT", 1)];
    const position = { vol: 5, avgPrice: 60050, positionId: 777 };

    const [a, b] = await Promise.all([
      ensureLiveBracket({ ctx: ledger.ctx(), trade: { ...row }, position }),
      ensureLiveBracket({ ctx: ledger.ctx(), trade: { ...row }, position }),
    ]);

    expect(mexc.count("POST", "/stoporder/place")).toBe(1);
    expect([a.state, b.state].filter((s) => s === "attached")).toHaveLength(1);
    expect(ledger.get("lt-DOT").exchangeStop).toBe(true);
  });

  it("signs every exchange request with the required MEXC headers", async () => {
    const intent = pendingIntent("SEI", { _id: "lt-SEI" });
    ledger = new MockLedger(intent);
    mexc.orders = [{ ...fillOrder(), externalOid: `lv${ENTRY.entryTime}-sei` }];
    mexc.positions = [positionRow("SEI_USDT", 1)];

    await reconcilePendingLiveEntries(ledger.ctx());

    const privateCalls = mexc.calls.filter((c) => c.path.startsWith("/api/v1/private/"));
    expect(privateCalls.length).toBeGreaterThan(0);
    for (const call of privateCalls) {
      expect(call.headers.ApiKey).toBe("test-key");
      expect(call.headers.Signature).toMatch(/^[0-9a-f]{64}$/);
      expect(call.headers["Request-Time"]).toMatch(/^\d+$/);
      expect(call.headers["Recv-Window"]).toBe("30");
      expect(toMexcSymbol("SEI")).toBe("SEI_USDT");
    }
  });

  it("refuses to send an unfenced market close (the only close path is the fenced one)", async () => {
    const { privateRequest } = await import("../../convex/liveBrokerRuntime");
    await expect(
      privateRequest("POST", "/api/v1/private/order/create", {
        symbol: "BTC_USDT",
        price: 0,
        vol: 5,
        side: 4, // close long, no externalOid
      }),
    ).rejects.toThrow(/unfenced live close/i);
  });
});
