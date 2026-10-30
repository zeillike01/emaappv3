/**
 * MEXC REQUEST PACER (2026-10-21) — one gate in front of every MEXC read.
 *
 * WHY. The documented limits are per endpoint (futures: kline 20/2s, ticker
 * 10/2s, depth 10/2s, contract detail 10/2s); the real ceiling measured on
 * 2026-10-21 is an AGGREGATE burst budget: 40 pairs × one 15m kline at the
 * tick's 6-way concurrency (≈40 req/s, 130ms latency) drew `510 Requests are
 * too frequent` on 14 of 40, while the same 40 requests spaced to ~11.5/s all
 * succeeded. Per-endpoint budgets were never the binding constraint — the
 * burst was. With per-pair isolation a refusal no longer kills the tick, but
 * it still costs that pair the whole 15-minute slot, which is exactly the
 * "every coin, no delays" property the book is supposed to have.
 *
 * WHAT. A tiny governor: at most MAX_INFLIGHT requests in flight, and
 * dispatches spaced at least MIN_GAP_MS apart (≈8 req/s). Requests queue
 * instead of failing: a 109-request worst-case live tick costs ~17s against a
 * 15-minute slot, i.e. no trading delay at all.
 *
 * SCOPE — AND THE TRAP (2026-10-21 second-pass audit). The gate lives in memory,
 * so it binds only the work of ONE action execution. That is exactly right for
 * a tick that fetches in-process (`fetchKlines` → `pacedFetch`: the live entry
 * and exit ticks), and it is exactly WRONG for a tick that fans out through
 * `ctx.runAction` — each relay call is a separate execution with its OWN gate,
 * so 40 relay actions run 40 concurrent requests and the burst returns. Those
 * callers must gate the fan-out itself: `convex/marketFetch.ts` runs every
 * relay through `createGate()` for this reason. Two gates never coordinate, so
 * paired crons (paper :03, live :03) still add their rates together.
 *
 * Configurable so tests can use small numbers; the exported defaults are what
 * production uses.
 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Hard ceiling on ONE request. A slot is held until the underlying fetch
 * settles, so a connection that never answers would keep that slot forever —
 * and because the gate is per runtime instance, four stalls would wedge every
 * later market-data read in it. 20s is ~6× the slowest observed kline call
 * (3.1s for 400 bars) and still ends inside the tick's slot.
 */
const REQUEST_TIMEOUT_MS = 20_000;

/** A concurrency+spacing gate around ANY async task. */
export type Gate = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * Build a gate: at most `maxInflight` tasks in flight, dispatches spaced at
 * least `minGapMs` apart. The check-and-reserve is synchronous (no await
 * between read and write), so two callers can never take the same slot in one
 * turn of the event loop, and `finally` releases the slot even when the task
 * throws.
 */
export function createGate(maxInflight = 4, minGapMs = 125): Gate {
  let inflight = 0;
  let nextSlot = 0;

  return async function gate<T>(task: () => Promise<T>): Promise<T> {
    for (;;) {
      const now = Date.now();
      if (inflight < maxInflight && nextSlot <= now) {
        inflight++;
        nextSlot = Math.max(now, nextSlot) + minGapMs;
        break;
      }
      await sleep(Math.max(5, Math.min(50, nextSlot - now)));
    }
    try {
      return await task();
    } finally {
      inflight--;
    }
  };
}

export interface Pacer {
  /** Paced fetch: queues for a dispatch slot, then issues the request. */
  fetch(url: string, init?: RequestInit): Promise<Response>;
  /** Requests dispatched through this pacer (diagnostics/tests). */
  readonly dispatched: number;
}

export function createPacer(
  maxInflight = 4,
  minGapMs = 125,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Pacer {
  const gate = createGate(maxInflight, minGapMs);
  let dispatched = 0;

  return {
    fetch(url: string, init?: RequestInit): Promise<Response> {
      return gate(async () => {
        // The timeout starts when the request actually leaves, not while it
        // waits in the queue — otherwise a long queue would spend the budget.
        // A caller that already owns a signal keeps it.
        const signal =
          init?.signal ?? (timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined);
        dispatched++;
        return await fetch(url, signal ? { ...init, signal } : init);
      });
    },
    get dispatched() {
      return dispatched;
    },
  };
}

/**
 * Default gate for contract.mexc.com (futures) and api.mexc.com (spot).
 *
 * 8 req/s sustained with 4 in flight. One shared gate is deliberate: the
 * measured refusals came from the SUM of concurrent endpoints, not from any
 * one endpoint exceeding its own documented rate.
 */
export const mexcPacer = createPacer();
export const pacedFetch = mexcPacer.fetch.bind(mexcPacer);
