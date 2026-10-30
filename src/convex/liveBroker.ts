/**
 * Public live-broker surface.
 *
 * Order placement, lifecycle writes, and scheduled workers live behind
 * `liveBrokerInternals` as internal actions. This module re-exports only plain
 * helpers used by the other internal reconciliation modules; those exports do
 * not create public Convex function endpoints. The sole public action is the
 * user-facing connection probe, which requires an authenticated live owner.
 */
"use node";

import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";

export {
  BRACKET_BACKSTOP_MS,
  privateRequest,
  ensureLiveBracket,
  fetchOpenPositions,
  reconcileLiveCloseIntents,
  reconcilePendingLiveEntries,
  reconstructClosedPnl,
  submitLiveMarketClose,
  replaceStopOrder,
  contractMeta,
} from "./liveBrokerRuntime";

/** Authenticated account-level connectivity check; never places an order. */
export const probeLiveConnection = action({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; configured?: boolean; detail: string }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Authentication required");
    await ctx.runMutation(api.liveEngine.assertLiveOwner, {});
    return await ctx.runAction(internal.liveBrokerRuntime.probeLiveConnection, {});
  },
});
