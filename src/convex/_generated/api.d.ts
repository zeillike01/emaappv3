/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as advisor from "../advisor.js";
import type * as archive from "../archive.js";
import type * as auth from "../auth.js";
import type * as auth_emailOtp from "../auth/emailOtp.js";
import type * as btcRegimeCache from "../btcRegimeCache.js";
import type * as cleanup from "../cleanup.js";
import type * as cronWrappers from "../cronWrappers.js";
import type * as crons from "../crons.js";
import type * as d1ShadowCache from "../d1ShadowCache.js";
import type * as displacementScan from "../displacementScan.js";
import type * as downBlockShadow from "../downBlockShadow.js";
import type * as executionRecord from "../executionRecord.js";
import type * as h4ShadowCache from "../h4ShadowCache.js";
import type * as heartbeat from "../heartbeat.js";
import type * as htfCache from "../htfCache.js";
import type * as http from "../http.js";
import type * as liveBroker from "../liveBroker.js";
import type * as liveBrokerRuntime from "../liveBrokerRuntime.js";
import type * as liveEngine from "../liveEngine.js";
import type * as liveReconcile from "../liveReconcile.js";
import type * as marketData from "../marketData.js";
import type * as marketDataNode from "../marketDataNode.js";
import type * as marketFetch from "../marketFetch.js";
import type * as marketRelay from "../marketRelay.js";
import type * as mexcForward from "../mexcForward.js";
import type * as mining from "../mining.js";
import type * as pairReview from "../pairReview.js";
import type * as paperTrading from "../paperTrading.js";
import type * as priceRelay from "../priceRelay.js";
import type * as rLockExit from "../rLockExit.js";
import type * as reset from "../reset.js";
import type * as strategyEngine from "../strategyEngine.js";
import type * as tickTiming from "../tickTiming.js";
import type * as users from "../users.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  advisor: typeof advisor;
  archive: typeof archive;
  auth: typeof auth;
  "auth/emailOtp": typeof auth_emailOtp;
  btcRegimeCache: typeof btcRegimeCache;
  cleanup: typeof cleanup;
  cronWrappers: typeof cronWrappers;
  crons: typeof crons;
  d1ShadowCache: typeof d1ShadowCache;
  displacementScan: typeof displacementScan;
  downBlockShadow: typeof downBlockShadow;
  executionRecord: typeof executionRecord;
  h4ShadowCache: typeof h4ShadowCache;
  heartbeat: typeof heartbeat;
  htfCache: typeof htfCache;
  http: typeof http;
  liveBroker: typeof liveBroker;
  liveBrokerRuntime: typeof liveBrokerRuntime;
  liveEngine: typeof liveEngine;
  liveReconcile: typeof liveReconcile;
  marketData: typeof marketData;
  marketDataNode: typeof marketDataNode;
  marketFetch: typeof marketFetch;
  marketRelay: typeof marketRelay;
  mexcForward: typeof mexcForward;
  mining: typeof mining;
  pairReview: typeof pairReview;
  paperTrading: typeof paperTrading;
  priceRelay: typeof priceRelay;
  rLockExit: typeof rLockExit;
  reset: typeof reset;
  strategyEngine: typeof strategyEngine;
  tickTiming: typeof tickTiming;
  users: typeof users;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
