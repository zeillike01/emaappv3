/**
 * CRON WRAPPERS — entries that beat, then delegate (2026-09-21).
 *
 * Most jobs beat from inside their own handler (see src/lib/heartbeat.ts). A
 * wrapped job is different: the liveness stamp is a property of the CRON rather
 * than of any path through the tick it runs.
 *
 * `live-exit` is the only one, for a concrete reason. Its handler is a long
 * action with several early returns (bot stopped, creds absent, no open
 * positions) and the beat would sit inside it — one refactor away from being
 * skipped, at which point the panel would report a healthy clock for a cron
 * that is no longer doing its work. Wrapping keeps the stamp honest no matter
 * what the tick decides, and leaves the trading code untouched: the delegate is
 * the delegate is `liveReconcile.liveExitTickSafe`, the intent-fenced exit
 * worker (the legacy raw-close tick is internal and unreachable from here).
 *
 * WHY A SEPARATE MODULE: heartbeat.ts must not import `api` (it would close a
 * type cycle through liveBroker → internal → heartbeat that degrades inference
 * elsewhere in the project). This file is the payment for that: it imports both
 * `api` and `internal`, and the handler's return type is annotated explicitly so
 * the wrapper's own signature never depends on inference through that cycle.
 *
 * "use node" matches the delegate's runtime (liveBroker.ts) — a node action
 * calling a node action, no runtime hop.
 */
"use node";

import { v } from "convex/values";
import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { manualCloseAck } from "../lib/live-math";
import { timedTick } from "./tickTiming";

export const liveEntryCron = internalAction({
  args: {},
  // Duration rides the wrapper, not the body (2026-10-28): the handler has
  // several early returns and a later refactor must not be able to silently
  // stop the measurement. See convex/tickTiming.ts.
  handler: async (ctx): Promise<{ status: string; scanned: number; entries: number; results: string[] }> =>
    timedTick(ctx, "live-entry", async () => {
    // silent: this pass runs inline here — it must not stamp the dedicated
    // live-intent-reconcile heartbeat row (see liveReconcile.ts).
    //
    // FAILURE PATHS (2026-10-21 third pass). This is the ONLY step that runs
    // before the entry tick, and it reaches MEXC's private API — which had no
    // request timeout — so a throw here was the one way to lose a whole
    // 15-minute entry slot with nothing written anywhere: the tick never
    // started, so its own TICK FAILED trace never ran either, and the Live page
    // kept rendering the previous scan as if it were current.
    //   · throw  → we cannot prove no durable intent is unresolved, so entries
    //              stay deferred (opening a duplicate position is the worse
    //              error) but the deferral is now VISIBLE and says why.
    //   · pending → same deferral, also previously invisible.
    let recovery: { pending: number } | null = null;
    let recoveryError: string | null = null;
    try {
      recovery = (await ctx.runAction(internal.liveReconcile.reconcileLiveIntents, {
        silent: true,
      })) as { pending: number };
    } catch (e: any) {
      recoveryError = String(e?.message ?? e).slice(0, 300);
    }
    if (recoveryError != null) {
      const note = `ENTRY SCAN DEFERRED — intent reconciliation failed: ${recoveryError} (durable intents unverified, retried next fire)`;
      await ctx
        .runMutation(internal.liveEngine.setLiveMeta, { lastScanAt: Date.now(), lastScanResult: note })
        .catch(() => {});
      return { status: "reconcile-failed", scanned: 0, entries: 0, results: [note] };
    }
    if ((recovery?.pending ?? 0) > 0) {
      const note = `ENTRY SCAN DEFERRED — ${recovery!.pending} durable intent(s) unresolved (resolved by the 5-minute reconcile pass)`;
      await ctx
        .runMutation(internal.liveEngine.setLiveMeta, { lastScanAt: Date.now(), lastScanResult: note })
        .catch(() => {});
      return {
        status: "reconciliation-pending",
        scanned: 0,
        entries: 0,
        results: [note],
      };
    }
    const result = await ctx.runAction(internal.liveBrokerRuntime.liveEntryTick, {});
    // The tick only opens the ledger row; every exchange bracket is attached by
    // the fenced reconciler below (and retried by the 5-minute recovery pass).
    // Normal fills are durably open before this runs. Reconcile their exchange
    // brackets immediately rather than waiting for the next five-minute safety
    // pass; an absent position or ambiguous request remains fenced and retried.
    const brackets: { results: string[] } = await ctx.runAction(
      internal.liveReconcile.reconcileLiveBrackets,
      {},
    );
    return {
      ...result,
      results: [...result.results, ...(brackets.results ?? [])],
    };
    }),
});

/** live-exit: stamp liveness, then run the tick exactly as before. */
export const liveExitCron = internalAction({
  args: {},
  // Same timing wrapper as live-entry above.
  handler: async (ctx): Promise<{ status: string; checked: number; closed: number; results: string[] }> =>
    timedTick(ctx, "live-exit", async () => {
    // Never allowed to break the tick: a heartbeat is observability.
    await ctx.runMutation(internal.heartbeat.record, { job: "live-exit" }).catch(() => {});
    // Resolve accepted-but-unsettled closes before the exit worker can issue
    // another order for the same ledger row.
    await ctx.runAction(internal.liveReconcile.reconcileLiveIntents, { silent: true }).catch((e: any) => {
      console.warn(`[live-exit] intent reconciliation failed: ${e?.message ?? e}`);
    });
    const before: Array<{ _id: string }> = await ctx.runQuery(api.liveEngine.getLiveOpenTrades);
    // FAILURE TRACE (2026-10-21 second pass): this is the pass that manages real
    // stops. Every handled failure writes lastExitResult, but an UNEXPECTED throw
    // used to leave the previous tick's line on screen while the heartbeat still
    // showed a live cron — an unmanaged position that looks healthy. Stamp the
    // reason where the Live page reads it, then rethrow for the deployment log.
    let result: Awaited<ReturnType<typeof ctx.runAction<typeof internal.liveReconcile.liveExitTickSafe>>>;
    try {
      result = await ctx.runAction(internal.liveReconcile.liveExitTickSafe, {});
    } catch (e: any) {
      const msg = String(e?.message ?? e).slice(0, 300);
      await ctx
        .runMutation(internal.liveEngine.setLiveMeta, {
          lastExitAt: Date.now(),
          lastExitResult: `EXIT TICK FAILED — ${msg} (open positions not managed this pass)`,
        })
        .catch(() => {});
      throw e;
    }
    const after: Array<{ _id: string }> = await ctx.runQuery(api.liveEngine.getLiveOpenTrades);
    const afterIds = new Set(after.map((t) => t._id));
    const landed = before.filter((t) => !afterIds.has(t._id)).length;
    const results = [...result.results];
    if (landed !== result.closed) {
      results.push(
        `close count reconciled from ledger rows: action=${result.closed}, landed=${landed}`,
      );
    }
    return { ...result, closed: landed, results };
    }),
});

/**
 * Manual-close UI adapter. The underlying action performs the exchange call;
 * this final ledger read prevents a response/write race from telling the trader
 * the opposite of the row's actual state.
 */
export const manualCloseLiveTradeSafe = action({
  args: { id: v.id("liveTrades") },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required");
    await ctx.runMutation(api.liveEngine.assertLiveOwner, {});
    const result: { ok: boolean; reason?: string; accepted?: boolean } = await ctx.runAction(
      api.liveReconcile.manualCloseLiveTradeSafe,
      { id: args.id },
    );
    const open: Array<{ _id: string }> = await ctx.runQuery(api.liveEngine.getLiveOpenTrades);
    return manualCloseAck({
      reportedOk: result.ok,
      stillOpen: open.some((t) => t._id === args.id),
      accepted: result.accepted === true,
      reason: result.reason,
    });
  },
});
