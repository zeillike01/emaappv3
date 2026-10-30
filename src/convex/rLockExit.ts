/**
 * R-LOCK EXIT PASS (2026-09-20) — cron front-end for both books.
 *
 * The R-lock's "close early on a breached rung" decision has to happen BEFORE
 * the book's own fixed SL/TP check, or the fixed TP would close the winner
 * first. That ordering is why these live here rather than inside
 * `resolveLayer2Exits` / `liveExitTick`, both of which sit deep inside files
 * far larger than the editing path can reach. No existing exit logic was
 * touched: each pass owns the rungs and leaves everything else to the tick it
 * already had, so if a pass fails the book still exits exactly as before.
 *
 * WHAT EACH PASS DOES
 *   1. advance the R-lock on every ARMED open trade (trailStartR > 0, stamped
 *      at entry — see strategyEngine / liveBrokerRuntime.processPairLive) from one
 *      fresh price;
 *   2. persist the peak/lock: a poll sees ONE price per run, so the running
 *      peak has to live on the row or the lock could never ratchet;
 *   3. close any trade whose locked rung was breached — AT MARKET, at the
 *      sampled price, not at the rung (see the note in each handler for why
 *      that distinction is deliberate and not a rounding detail).
 *
 * TWO CRONS, DELIBERATELY DIFFERENT
 *   - paper: `layer2-exit-tick` (5 min) calls `layer2ExitTick`, which runs the
 *     lock pass and then `resolveLayer2Exits`. Paper has NO exchange bracket,
 *     so this tick is its only exit path and the chaining keeps the SL/TP
 *     decision on the same run as the lock decision.
 *   - live: `live-rlock-tick` (5 min, :02/:07/… phase) calls `liveRLockTick`
 *     and NOTHING else. `live-exit` keeps its own 15-minute slot for brackets
 *     and settlement. Separating them removes a double-close window: the lock
 *     writes its close to the ledger inside its run and the two crons never
 *     share a slot, so the bracket tick can never re-read a just-closed
 *     position and fire a second close order for the same vol (which on a flat
 *     MEXC account would open an opposite position).
 *
 * SEMANTICS live in src/lib/r-lock.ts (shared, pure, unit-testable). The
 * DECISION rule is byte-for-byte the backtest engine's tpMode "rlock" — where
 * the edge was measured (fixed 2R = −0.062 R/trade out-of-sample, the lock =
 * +0.038 R/trade on the same 1,878 signals). Since 2026-09-22 that is
 * STRUCTURAL rather than asserted: src/lib/backtest.ts calls the same
 * `rLockBarStep`, so the harness that measured the edge and both passes below
 * are one implementation, with the equivalence pinned by
 * src/lib/__tests__/r-lock-engine-parity.test.ts (40,000 randomised bars, both
 * sides, state and exit rung). The FILL price is deliberately NOT the
 * backtest's: see the sampled-price note below.
 *
 * COST: one batched public ticker call per pass, plus ONE 5-minute kline call
 * per armed pair (see the bar-replay note below). Live additionally makes one
 * private open-positions call, because it must size its close from exchange
 * truth. The live pass also tracks un-bracketed rows with the lock disabled so
 * their original stops get the same bar fidelity; a run with neither a locked
 * nor monitor-managed row returns before any fetch.
 *
 * ── BAR REPLAY (2026-09-22 live-book audit) ─────────────────────────────────
 * The peak used to advance from ONE spot price per pass, which cannot see what
 * price did between passes. The live ledger shows the cost in its own data: on
 * 6 of 61 r-lock-era rows `realizedR > trailPeakR` — impossible if the tracker
 * had seen every price the exit saw (e.g. a SUI row recorded a 1.71R peak and
 * booked +3.16R). The lock therefore armed later, or never, relative to the
 * mechanic the backtest priced (fixed 2R −0.065 R/t vs the lock +0.026).
 *
 * Both passes now replay the trade's CLOSED 5-minute bars through the SAME pure
 * `rLockStep`, adverse-before-favourable per bar, from the trade's entry — so
 * live runs the mechanic that was measured instead of a sparser approximation
 * of it. `rLockReplayBars` is deterministic and idempotent, which is why this
 * needs no persisted cursor: re-replaying the whole trade every pass yields the
 * same state, and a pass that never ran self-heals on the next one.
 *
 * The replay is authoritative ONLY when the fetched bars actually span the
 * trade from entry. A short window must never be allowed to DISCARD an
 * accumulated peak, so when coverage fails the pass falls back to the persisted
 * state plus the spot sample — exactly the previous behaviour. The spot sample
 * is then still applied on top of a good replay, so the freshest price always
 * counts.
 */
"use node";

import { action, internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { timedTick } from "./tickTiming";
import { toMexcSymbol } from "../lib/tracked-pairs";
import { fetchAllTickers, fetchTickerPrice, fetchKlines } from "../lib/mexc/mexcFetchers";
import {
  rLockEnabled,
  rLockStep,
  rLockReplayBars,
  validateReplayCoverage,
  stopAmendDecision,
  type RLockBar,
} from "../lib/r-lock";
import {
  privateRequest,
  fetchOpenPositions,
  ensureLiveBracket,
  replaceStopOrder,
  contractMeta,
  BRACKET_BACKSTOP_MS,
  submitLiveMarketClose,
} from "./liveBroker";
import {
  estimateExit,
  expectedMarketExitPrice,
  matchPositionEntry,
} from "../lib/live-math";

const TAKER_FEE = 0.0006; // 0.06% taker — entry was market, and so is this exit
const EXIT_SLIP_BPS = 3; // matches resolveLayer2Exits' SL/stop-exit slippage
const BAR_MS_5M = 300_000;
const MAX_REPLAY_BARS = 1000; // MEXC's per-request cap; older trades fall back

/**
 * Fetch the 5-minute bars covering one trade from its entry, cached per pair
 * per pass so two positions on the same pair cost one request. A failed fetch
 * resolves to [] — callers then fall back to the spot sample rather than
 * fabricating a state.
 *
 * The cache is PER-PASS (created fresh inside each tick handler, audit
 * 2026-10-01): the old module-level Map was shared across concurrent action
 * invocations in one isolate, so a pass starting mid-run wiped (clear()) or
 * reused another pass's in-flight windows — same key, different `now`, i.e.
 * a shorter window than the second pass asked for. Coverage validation made
 * that fail-safe (fallback to spot) rather than wrong, but it cost refetches
 * and, at worst, a pass running the sparser spot behaviour the replay was
 * built to replace.
 */
function barsFor(
  cache: Map<string, Promise<RLockBar[]>>,
  coin: string,
  startTime: number,
  now: number,
): Promise<RLockBar[]> {
  const key = `${coin}|${startTime}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const need = Math.min(
    MAX_REPLAY_BARS,
    Math.max(12, Math.ceil((now - startTime) / BAR_MS_5M) + 4),
  );
  const p = fetchKlines(coin, "5m", need, now)
    .then((ks) =>
      ks.map((k) => ({
        openTime: k.openTime,
        closeTime: k.closeTime,
        high: k.high,
        low: k.low,
      })),
    )
    .catch(() => [] as RLockBar[]);
  cache.set(key, p);
  return p;
}

type LockResolution = {
  peakR: number;
  lockPrice: number;
  changed: boolean;
  exit: { reason: "Trail Lock" | "R-Lock Max"; rungPrice: number; lockR: number } | null;
  /**
   * First bar whose ADVERSE extreme breached the original stop (no lock exit on
   * that bar). Paper has no exchange bracket, so this is the only bar-accurate
   * evidence that the stop was hit — see the STOP FIDELITY note in r-lock.ts.
   * The same holds for LIVE rows without an exchange bracket (monitor-managed
   * entries, exchangeStop false — 2026-09-24 stop audit): both books now act on
   * this flag. Mutually exclusive with `exit`.
   */
  stopBreach: { atTime: number; price: number } | null;
  /** Newest closed bar incorporated by a validated replay, if any. */
  replayCursor: number;
  /** True when the fetched bars spanned the trade and the replay was used. */
  replayed: boolean;
  barsRead: number;
};

/**
 * Resolve one armed trade's lock state for this pass — the single place the two
 * books derive it, so paper and live can never drift on the mechanic.
 *
 * Order: replay closed bars from entry (authoritative when covered) → then the
 * spot sample for the freshest price → first exit wins.
 */
async function resolveLock(args: {
  side: "LONG" | "SHORT";
  entryPrice: number;
  slPrice: number;
  riskPx?: number | null;
  params: { startR: number; stepR: number; maxR: number };
  entryTime: number;
  replayCursor?: number | null;
  price: number;
  /** Timestamp attached if the fresh spot sample crosses the original stop. */
  sampleTime: number;
  getBars: () => Promise<RLockBar[]>;
  prev: { peakR: number; lockPrice: number };
}): Promise<LockResolution> {
  const prev = {
    peakR: Number(args.prev.peakR) || 0,
    lockPrice: Number(args.prev.lockPrice) || 0,
  };
  let peakR = prev.peakR;
  let lockPrice = prev.lockPrice;
  let exit: LockResolution["exit"] = null;
  let stopBreach: LockResolution["stopBreach"] = null;
  let replayed = false;
  let barsRead = 0;
  let replayCursor = Number(args.replayCursor) || 0;

  const bars = await args.getBars();
  // A short/gapped window must not replace a previously accumulated peak with
  // a lower one. Only a contiguous, closed-bar window is authoritative; when
  // it is not, the persisted state + fresh spot sample remains the fallback.
  const coverage = validateReplayCoverage({
    bars,
    entryTime: args.entryTime,
    now: args.sampleTime,
    cursor: args.replayCursor,
  });
  if (coverage.ok) {
    const r = rLockReplayBars({
      side: args.side,
      entryPrice: args.entryPrice,
      slPrice: args.slPrice,
      riskPx: args.riskPx,
      params: args.params,
      bars,
      sinceOpenTime: args.replayCursor ?? args.entryTime,
      state: args.replayCursor != null ? prev : undefined,
    });
    peakR = r.peakR;
    lockPrice = r.lockPrice;
    replayCursor = r.lastBarTime || coverage.lastBarTime;
    replayed = true;
    barsRead = r.barsRead;
    if (r.exit) {
      exit = { reason: r.exit.reason, rungPrice: r.exit.rungPrice, lockR: r.exit.lockR };
    } else if (r.stopBreach) {
      stopBreach = { atTime: r.stopBreach.atTime, price: r.stopBreach.price };
    }
  }

  if (!exit && !stopBreach) {
    const s = rLockStep({
      side: args.side,
      entryPrice: args.entryPrice,
      slPrice: args.slPrice,
      price: args.price,
      riskPx: args.riskPx,
      params: args.params,
      state: { peakR, lockPrice },
    });
    peakR = s.peakR;
    lockPrice = s.lockPrice;
    if (s.exit) {
      exit = { reason: s.exit.reason, rungPrice: s.exit.rungPrice, lockR: s.exit.lockR };
    } else if (s.stopBreached) {
      // A good historical replay does not make the CURRENT sample safe. The
      // old resolver discarded this flag after replay, so a live price that
      // crossed the original stop between closed bars still waited for the
      // 15-minute monitor. Surface the spot breach too.
      stopBreach = { atTime: args.sampleTime, price: args.price };
    }
  }

  return {
    peakR,
    lockPrice,
    changed: peakR !== prev.peakR || lockPrice !== prev.lockPrice,
    exit,
    stopBreach,
    replayCursor,
    replayed,
    barsRead,
  };
}

/** Batched price map with a per-pair fallback (same rule as both exit ticks). */
async function priceMapFor(pairs: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  let tickerMap: Awaited<ReturnType<typeof fetchAllTickers>> | undefined;
  try {
    tickerMap = await fetchAllTickers();
  } catch {
    tickerMap = undefined;
  }
  const missing = tickerMap
    ? pairs.filter((p) => !((tickerMap!.get(p)?.last ?? 0) > 0))
    : pairs;
  await Promise.all(
    missing.map(async (p) => {
      try {
        const px = await fetchTickerPrice(p);
        if (px && px > 0) map.set(p, px);
      } catch { /* keep going */ }
    }),
  );
  if (tickerMap) {
    for (const p of pairs) {
      const last = tickerMap.get(p)?.last;
      if (last && last > 0) map.set(p, last);
    }
  }
  return map;
}

/**
 * PAPER — advance the layer2 r-lock, then run the book's own exit tick.
 * Armed trades close here when a locked rung is breached; everything else is
 * left to resolveLayer2Exits exactly as before.
 */
export const layer2ExitTick = action({
  args: {},
  // Duration rides the wrapper so every early return is measured (2026-10-28;
  // see convex/tickTiming.ts). The body is unchanged.
  handler: async (ctx): Promise<{
    status: string;
    checked: number;
    closed: number;
    locked: number;
    peakAdvanced: number;
    results: string[];
  }> =>
    timedTick(ctx, "layer2-exit-tick", async () => {
    // Heartbeat first (src/lib/heartbeat.ts) — recorded before the no-armed-
    // trades early return, so an idle book still shows a live clock.
    await ctx.runMutation(internal.heartbeat.record, { job: "layer2-exit-tick" }).catch(() => {});

    const results: string[] = [];
    let closed = 0;
    let peakAdvanced = 0;

    const openTrades: any[] = await ctx
      .runQuery(api.paperTrading.getOpenLayer2Trades)
      .catch(() => []);
    // `armed` here means "this trade's CONFIG enables the lock" (trailStartR > 0),
    // not "the lock has ratcheted" — every entry since 2026-09-20 carries
    // trailStartR, so in practice it is all open trades. That matters beyond the
    // lock: these are the bars the stop-breach check reads (see STOP FIDELITY in
    // r-lock.ts), so a trade with the lock disabled falls back to the ticker
    // sample for its stop. That is the pre-lock-era behaviour, kept deliberately
    // — those 165 legacy rows ran under it. If the lock is ever switched off in
    // config, paper's stops revert to 5-minute sampling with it.
    const armed = openTrades.filter((t: any) => rLockEnabled({ startR: t.trailStartR }));
    if (armed.length === 0) {
      // Nothing locked — straight through to the normal exit handling.
      const base: any = await ctx.runAction(api.strategyEngine.resolveLayer2Exits, {});
      return {
        status: base?.status ?? "ok",
        checked: base?.checked ?? 0,
        closed: base?.closed ?? 0,
        locked: 0,
        peakAdvanced: 0,
        results: [...results, ...(base?.results ?? [])],
      };
    }

    const pairs = [...new Set(armed.map((t: any) => t.coin))];
    const priceMap = await priceMapFor(pairs);
    const now = Date.now();
    const barsCache = new Map<string, Promise<RLockBar[]>>();

    for (const trade of armed) {
      const price = priceMap.get(trade.coin);
      if (!price || price <= 0) {
        results.push(`${trade.coin}: r-lock skip (no price)`);
        continue;
      }
      const isLong = trade.type === "LONG";
      const params = {
        startR: Number(trade.trailStartR),
        stepR: Number(trade.trailStepR ?? 0),
        maxR: Number(trade.trailMaxR ?? 0),
      };
      const step = await resolveLock({
        side: isLong ? "LONG" : "SHORT",
        entryPrice: trade.entryPrice,
        slPrice: trade.slPrice,
        params,
        entryTime: trade.entryTime ?? now,
        replayCursor: trade.trailReplayCursor ?? null,
        price,
        sampleTime: now,
        getBars: () => barsFor(
          barsCache,
          trade.coin,
          trade.trailReplayCursor ?? trade.entryTime ?? now,
          now,
        ),
        prev: { peakR: trade.trailPeakR ?? 0, lockPrice: trade.trailLockPrice ?? 0 },
      });
      if (step.changed || step.replayCursor !== (trade.trailReplayCursor ?? 0)) {
        await ctx
          .runMutation(api.paperTrading.setTrailState, {
            tradeId: trade._id,
            peakR: step.peakR,
            lockPrice: step.lockPrice,
            replayCursor: step.replayCursor || undefined,
          })
          .then((ok: boolean) => {
            if (ok) peakAdvanced++;
            else results.push(`${trade.coin}: trail state write was not acknowledged`);
          })
          .catch((e: any) => {
            results.push(`${trade.coin}: trail state write FAILED — ${e?.message ?? e}`);
          });
      }
      if (!step.exit && !step.stopBreach) continue;

      // Two ways out of this branch, and they do NOT share a fill rule.
      //
      // RUNG BREACH: fill at the SAMPLED price, not at the rung. The rung
      // decided WHEN to exit; the fill is a market order at whatever price this
      // 5-minute tick sampled. The backtest books at the rung (it assumes a
      // resting order), but booking that here would flatter the book and,
      // worse, make paper disagree with what the live market order fills.
      //
      // STOP BREACH: the opposite rule applies, and this branch is the whole
      // point of the fix. The replay saw the bar's ADVERSE extreme cross
      // slPrice, which is where a resting stop order fills — and the SAMPLED
      // price is precisely the thing that missed it. So this books the stop
      // level plus the same stop-exit slippage `resolveLayer2Exits` uses for
      // its own SL fills, and stamps the BREACH BAR's closeTime (not `now`),
      // so the row's session/hour attribution matches when price actually
      // traded there rather than when the cron happened to notice.
      const stopOut = !step.exit;
      const slip = EXIT_SLIP_BPS / 10_000;
      const exitPrice = stopOut
        ? isLong
          ? trade.slPrice * (1 - slip)
          : trade.slPrice * (1 + slip)
        : isLong
          ? price * (1 - slip)
          : price * (1 + slip);
      const reason = stopOut ? "Stop Loss" : step.exit!.reason;
      const exitTime = stopOut ? step.stopBreach!.atTime : now;
      const risk = Math.abs(trade.entryPrice - trade.slPrice);
      const side = isLong ? 1 : -1;
      const notional = trade.entryPrice * trade.sizeCoin;
      const totalFees = notional * TAKER_FEE * 2; // market in, market out
      const grossPnl = (exitPrice - trade.entryPrice) * trade.sizeCoin * side;
      const pnlUsd = grossPnl - totalFees;
      const marginUsd = notional / (trade.leverage || 50);
      const pnlPercent = (pnlUsd / marginUsd) * 100;
      const move = side * (exitPrice - trade.entryPrice);
      const realizedR = risk > 0 ? move / risk : 0;
      const barsHeld = Math.round((exitTime - trade.entryTime) / 900_000);

      let closeOk = true;
      await ctx
        .runMutation(api.paperTrading.closeTrade, {
          id: trade._id,
          exitPrice,
          exitTime,
          reason,
          pnlUsd,
          pnlPercent,
          // The lock tracked the running peak all trade, so it IS the MFE —
          // no extra kline scan needed on this path.
          mfeR: step.peakR > 0 ? step.peakR : undefined,
          realizedR,
          barsHeld,
          totalFeesUsd: totalFees,
          durationBucket: barsHeld <= 4 ? "fast" : barsHeld <= 16 ? "medium" : "slow",
          mfeCaptureRatio: step.peakR > 0 ? +(realizedR / step.peakR).toFixed(4) : undefined,
          volAtEntry: trade.volPct ?? undefined,
        })
        .catch((e: any) => {
          // AUDIT FIX (2026-09-20): a failed close must NOT be counted as a
          // close nor logged as one. The row stays open and the chained
          // resolveLayer2Exits below owns it — the old code incremented
          // `closed` and printed a success line for a write that never landed,
          // so the tick summary could claim closes that did not happen.
          closeOk = false;
          results.push(`${trade.coin}: r-lock close FAILED — ${e?.message ?? e}`);
        });
      if (!closeOk) continue;
      closed++;
      results.push(
        stopOut
          ? `${trade.coin}: STOP — bar ${new Date(exitTime).toISOString().slice(11, 16)}Z ` +
            `traded ${step.stopBreach!.price.toFixed(6)} through sl ${trade.slPrice.toFixed(6)} ` +
            `(booked ${exitPrice.toFixed(6)} · ${realizedR.toFixed(2)}R)`
          : `${trade.coin}: ${reason} — rung ${step.exit!.lockR.toFixed(2)}R breached, filled at ` +
            `market ${exitPrice.toFixed(4)} (peak ${step.peakR.toFixed(2)}R · ` +
            `${realizedR.toFixed(2)}R realised)`,
      );
    }

    // The book's own tick still runs: stops, fixed TPs on un-armed trades, and
    // the shadow legs all keep their existing behaviour.
    const base: any = await ctx.runAction(api.strategyEngine.resolveLayer2Exits, {});
    return {
      status: base?.status ?? "ok",
      checked: base?.checked ?? 0,
      closed: closed + (base?.closed ?? 0),
      locked: armed.length,
      peakAdvanced,
      results: [...results, ...(base?.results ?? [])],
    };
    }),
});

/**
 * LIVE — advance the live r-lock only. Runs on its OWN 5-minute cron.
 *
 * WHY A SEPARATE CRON, ON A FASTER CADENCE THAN live-exit
 * The measured edge assumes an exit AT the rung. That is how the backtest
 * books it (within-bar, adverse-before-favourable), but this pass closes at
 * MARKET, so the fill is wherever price actually is when the tick runs — a
 * rung breached mid-move fills worse the longer the poll interval. live-exit
 * sits at 15 m (deliberately: its bracket work is exchange-side and cadence-
 * insensitive). The lock is NOT cadence-insensitive, so it gets 5 m of its own.
 *
 * Keeping it off live-exit also removes a double-close window entirely: at a
 * 5-minute offset there is no run in which this pass sends a close and the
 * bracket tick re-reads the same position a few hundred ms later. The two
 * crons never share a slot, and the close is written to the ledger inside this
 * run, so liveExitTick's open-trade query no longer sees the row when it fires.
 *
 * The exchange bracket's SL stays attached underneath as the crash floor, and
 * the entry TP was placed at the lock's MAX target (see liveBroker.
 * processPairLive) so the exchange can no longer close a winner at 2R ahead of
 * the ratchet. This pass is what banks the intermediate rungs.
 */
export const liveRLockTick = internalAction({
  args: {},
  // Same timing wrapper as layer2ExitTick above.
  handler: async (ctx): Promise<{
    status: string;
    checked: number;
    closed: number;
    locked: number;
    peakAdvanced: number;
    results: string[];
  }> =>
    timedTick(ctx, "live-rlock-tick", async () => {
    // Heartbeat first (src/lib/heartbeat.ts). This is the highest-value row on
    // the board: the exchange SL never moves, so a stalled ratchet means an
    // armed winner is silently still stopped at its original −1R.
    await ctx.runMutation(internal.heartbeat.record, { job: "live-rlock-tick" }).catch(() => {});

    const results: string[] = [];
    let closed = 0;
    let closedViaLock = 0;
    let peakAdvanced = 0;
    let pendingCloses = 0;
    let unmanaged = 0;
    let errors = 0;

    const openTrades: any[] = await ctx
      .runQuery(api.liveEngine.getLiveOpenTrades)
      .catch(() => []);
    const armed = openTrades.filter((t: any) => rLockEnabled({ startR: t.trailStartR }));
    const armedIds = new Set(armed.map((t: any) => t._id));
    // Every monitor-managed row needs 5-minute stop fidelity, even when its
    // config has the trailing lock disabled. Bracketed + un-locked rows still
    // need no bar work: MEXC owns their original stop.
    const tracked = openTrades.filter(
      (t: any) => armedIds.has(t._id) || t.exchangeStop !== true,
    );

    const now = Date.now();
    if (tracked.length === 0) {
      // Nothing to lock or monitor without a bracket — no price/private fetch.
      await ctx.runMutation(internal.liveEngine.setLiveMeta, {
        lastRLockAt: now,
        lastRLockResult: "R-LOCK idle — no armed or monitor-managed positions",
        lastRLockPending: 0,
        lastRLockUnmanaged: 0,
        lastRLockError: null,
      }).catch(() => {});
      return { status: "ok", checked: 0, closed: 0, locked: 0, peakAdvanced: 0, results };
    }

    const pairs = [...new Set(tracked.map((t: any) => t.coin))];
    const priceMap = await priceMapFor(pairs);
    const barsCache = new Map<string, Promise<RLockBar[]>>();

    // Exchange truth, so a partial fill or a manual downscale can never make us
    // oversize the close. A FAILED fetch leaves the map empty and we simply
    // skip the lock pass — never fabricate a close on missing data.
    const positionMap: Awaited<ReturnType<typeof fetchOpenPositions>> = new Map();
    try {
      for (const [k, v] of await fetchOpenPositions()) positionMap.set(k, v);
    } catch {
      errors += tracked.length;
      for (const t of tracked) results.push(`${t.coin}: r-lock/stop skip (positions fetch failed)`);
    }

    for (const trade of tracked) {
      const price = priceMap.get(trade.coin);
      if (!price || price <= 0) {
        results.push(`${trade.coin}: r-lock skip (no price)`);
        continue;
      }
      const isLong = trade.type === "LONG";
      const sym = toMexcSymbol(trade.coin);
      // Side-aware exact-key match (2026-09-24 stop audit): this row sizes the
      // close, so it must be THIS side's position — never the `${sym}_0`
      // shadow of a hedge-mode opposite row.
      const pos = matchPositionEntry(positionMap, sym, isLong ? 1 : 2);
      if (!pos) {
        // Position absent or unknown — leave it to liveExitTick, which owns
        // bracket reconciliation and the "position vanished" labelling.
        unmanaged++;
        results.push(`${trade.coin}: unmanaged by R-lock — exact-side position not visible`);
        continue;
      }
      const lockArmed = armedIds.has(trade._id);
      const params = {
        startR: lockArmed ? Number(trade.trailStartR) : 0,
        stepR: Number(trade.trailStepR ?? 0),
        maxR: Number(trade.trailMaxR ?? 0),
      };
      const step = await resolveLock({
        side: isLong ? "LONG" : "SHORT",
        entryPrice: trade.entryPrice ?? pos.avgPrice,
        slPrice: trade.slPrice,
        price,
        // Frozen ruler (2026-09-21): riskPx was stamped at entry, so
        // liveExitTick's exchange-fill refinement of entryPrice can never
        // re-scale the trailPeakR / trailLockPrice stored on this row. The
        // replay uses the same ruler, so the two agree by construction.
        riskPx: trade.riskPx,
        params,
        entryTime: trade.entryTime ?? now,
        replayCursor: trade.trailReplayCursor ?? null,
        sampleTime: now,
        getBars: () => barsFor(
          barsCache,
          trade.coin,
          trade.trailReplayCursor ?? trade.entryTime ?? now,
          now,
        ),
        prev: { peakR: trade.trailPeakR ?? 0, lockPrice: trade.trailLockPrice ?? 0 },
      });
      // ── STOP-AMEND (2026-09-26 live exit fix) ──────────────────────────
      // The ledger ratchet alone does not protect a retracing winner: the
      // exchange bracket stayed at the ORIGINAL −1R stop, so rungs banked in
      // the ledger were lost to the exchange's older trigger (paper's Trail
      // Lock wins became live Stop-Loss losses on identical signals). When
      // the rung sits past the resting exchange SL, MOVE the exchange stop to
      // it — cancel + replace, tighten-only via stopAmendDecision. Checked
      // EVERY pass (not only when the step changed): a completed amend is a
      // no-op (no favourable gap left), and a FAILED amend retries next pass
      // until the rung and the resting stop agree. The frozen ruler is
      // untouched: slPrice/riskPx keep their original meaning and
      // exchangeSlPrice records where the protective stop now rests.
      // GATED ON HOLD: a sample that is about to close (rung breach, stop
      // breach, max) skips the amend — the market close below must never race
      // a just-submitted stop replacement.
      const holdingThisPass = !step.exit && !step.stopBreach;
      let needStateWrite = step.changed || step.replayCursor !== (trade.trailReplayCursor ?? 0);
      let amendTried = false;
      let exchangeSlForLedger: number | undefined;
      if (trade.exchangeStop === true && lockArmed && holdingThisPass) {
        const decision = stopAmendDecision({
          side: isLong ? "LONG" : "SHORT",
          lockPrice: step.lockPrice,
          exchangeSlPrice: trade.exchangeSlPrice ?? trade.slPrice,
          entryPrice: trade.entryPrice,
          riskPx: trade.riskPx,
        });
        if (decision.amend) {
          amendTried = true;
          needStateWrite = true;
          try {
            const meta = await contractMeta(trade.coin);
            const closeVol = pos.vol > 0 ? Math.min(trade.volContracts, pos.vol) : trade.volContracts;
            const replaced = await replaceStopOrder({
              pair: trade.coin,
              positionId: pos.positionId,
              vol: closeVol,
              oldSlPrice: trade.exchangeSlPrice ?? trade.slPrice,
              newSlPrice: decision.amendPrice,
              // Carry the row's max-target TP explicitly — one MEXC order holds
              // SL+TP together, so a replace without it would drop the TP
              // backstop (replaceStopOrder also falls back to the resting TP).
              newTpPrice: Number(trade.tpPrice) > 0 ? Number(trade.tpPrice) : null,
              priceUnit: meta.priceUnit,
            });
            if (replaced.ok) {
              const resting = replaced.slPrice ?? decision.amendPrice;
              exchangeSlForLedger = resting;
              results.push(
                replaced.skipped
                  ? `${trade.coin}: stop amend ${replaced.skipped} (resting ${resting.toFixed(6)})`
                  : `${trade.coin}: exchange SL moved to rung ${decision.lockR.toFixed(2)}R @ ${resting.toFixed(6)}`,
              );
            } else {
              errors++;
              results.push(`${trade.coin}: stop amend failed — ${replaced.error ?? "unknown"} (retries next pass)`);
            }
          } catch (e: any) {
            errors++;
            results.push(`${trade.coin}: stop amend error — ${e?.message ?? e} (retries next pass)`);
          }
        }
      }
      if (needStateWrite) {
        await ctx
          .runMutation(internal.liveEngine.setLiveTrailState, {
            id: trade._id,
            peakR: step.peakR,
            lockPrice: step.lockPrice,
            replayCursor: step.replayCursor || undefined,
            ...(exchangeSlForLedger != null ? { exchangeSlPrice: exchangeSlForLedger, stopAmendedAt: Date.now() } : {}),
            ...(amendTried ? { amendAttempted: true } : {}),
          })
          .then((ok: boolean) => {
            if (ok) peakAdvanced++;
            else {
              errors++;
              results.push(`${trade.coin}: trail state write was not acknowledged`);
            }
          })
          .catch((e: any) => {
            errors++;
            results.push(`${trade.coin}: trail state write FAILED — ${e?.message ?? e}`);
          });
      }
      if (!step.exit && !step.stopBreach) {
        // The stop/lock decision is authoritative for this pass. Only when it
        // says "hold" may a missing exchange bracket be recovered. This keeps a
        // freshly-breached stop from creating a new bracket that could race the
        // market close below, and leaves the frozen R ruler untouched.
        if (!trade.exchangeStop) {
          try {
            const bracket = await ensureLiveBracket({ ctx, trade, position: pos });
            if (bracket.state === "attached") {
              trade.exchangeStop = true;
              results.push(
                `${trade.coin}: exchange SL/TP bracket recovered` +
                  (bracket.detail ? ` (${bracket.detail})` : ""),
              );
            } else {
              if (bracket.state === "pending") pendingCloses++;
              if (bracket.state === "unmanaged") unmanaged++;
              if (bracket.state === "failed") errors++;
              results.push(
                `${trade.coin}: bracket ${bracket.state}` +
                  (bracket.detail ? ` — ${bracket.detail}` : " — monitor fallback active"),
              );
            }
          } catch (e: any) {
            errors++;
            results.push(`${trade.coin}: bracket reconciliation error — ${e?.message ?? e}`);
          }
        }
        continue;
      }
      // ── STOP-BREACH CLOSE (2026-09-24 live stop audit) ─────────────────
      // A breached ORIGINAL stop on a row with NO exchange bracket
      // (exchangeStop false — bracket attach failed or the position was not
      // visible after fill) is the one live case with no resting stop at all.
      // Until now its only closer was liveExitTick's 15-minute SPOT sample, so
      // a wick through the stop that recovered between samples left the
      // position riding past its SL indefinitely — the exact hole the paper
      // book closed on 2026-09-22 with this same flag. Bracket rows get a
      // bounded 10-minute grace period, then this pass owns a demonstrably dead
      // bracket instead of waiting another 15–30 minutes for live-exit.
      const stopOut = !step.exit;
      let bracketBackstop = false;
      if (stopOut && trade.exchangeStop) {
        // Give MEXC its normal fill window, but use the BAR breach time rather
        // than the 15-minute monitor's first observation. This closes a dead
        // exchange stop after 10 minutes instead of silently waiting 15–30.
        const breachAt = trade.bracketBreachSince ?? step.stopBreach!.atTime;
        if (trade.bracketBreachSince == null) {
          await ctx
            .runMutation(internal.liveEngine.setLiveBracketBreach, {
              id: trade._id,
              since: breachAt,
            })
            .catch(() => {});
        }
        const ageMs = Math.max(0, now - breachAt);
        if (ageMs < BRACKET_BACKSTOP_MS) {
          pendingCloses++;
          results.push(
            `${trade.coin}: stop bracket breached ${Math.round(ageMs / 60_000)}m ago — ` +
              `waiting for exchange fill (backstop ${BRACKET_BACKSTOP_MS / 60_000}m)`,
          );
          continue;
        }
        bracketBackstop = true;
      }

      // Real market close: close long = 4, close short = 2.
      const closeVol = pos.vol > 0 ? Math.min(trade.volContracts, pos.vol) : trade.volContracts;
      if (!(closeVol > 0)) {
        unmanaged++;
        results.push(`${trade.coin}: r-lock unmanaged — no closeable volume`);
        continue;
      }
      const trigger = stopOut ? "Stop Loss" : step.exit!.reason;
      // Both paths submit a market close. The rung/stop decides WHY; the
      // sampled ticker plus adverse slippage is the conservative estimate of
      // WHERE that market order fills. Reconciliation replaces it with the
      // exchange fill when the close order settles.
      const expectedExit = expectedMarketExitPrice({
        side: isLong ? "LONG" : "SHORT",
        price,
      });
      const closeRatio =
        trade.volContracts > 0 ? Math.min(1, closeVol / trade.volContracts) : 1;
      const est = estimateExit({
        notionalUsd: (trade.notionalUsd ?? 0) * closeRatio,
        entryPrice: trade.entryPrice ?? pos.avgPrice,
        exitPrice: expectedExit,
        side: isLong ? "LONG" : "SHORT",
        slPrice: trade.slPrice,
      });
      const submitted = await submitLiveMarketClose({
        ctx,
        trade,
        symbol: sym,
        side: isLong ? "LONG" : "SHORT",
        closeVol,
        reason: trigger,
        expectedExit,
        exitTime: now,
        pnlUsd: est.pnlUsd,
        realizedR: est.realizedR,
        feesUsd: est.fees,
      });
      if (submitted.sent) closedViaLock++;
      if (submitted.writeState === "recorded") closed++;
      if (["submitted", "pending"].includes(submitted.writeState)) pendingCloses++;
      if (submitted.writeState === "not-claimed" && submitted.intentId) pendingCloses++;
      if (submitted.error) errors++;
      const writeNote =
        submitted.writeState === "write-failed"
          ? " · ⚠ close sent but ledger acknowledgement failed (reconciles next pass)"
          : submitted.writeState === "already-closed"
            ? " · row already closed by another pass"
            : submitted.writeState === "submitted" || submitted.writeState === "pending"
              ? " · close intent submitted; awaiting exchange fill/reconciliation"
              : submitted.error
                ? ` · ${submitted.error}`
                : "";
      results.push(
        stopOut
          ? `${trade.coin}: STOP — bar ${new Date(step.stopBreach!.atTime).toISOString().slice(11, 16)}Z ` +
            `traded ${step.stopBreach!.price.toFixed(6)} through sl ${trade.slPrice.toFixed(6)} ` +
            `(booked ${expectedExit.toFixed(6)} · ${est.realizedR.toFixed(2)}R · ` +
            `${bracketBackstop ? "dead exchange bracket — backstop close" : "no exchange bracket — closed at market"})${writeNote}`
          : `${trade.coin}: ${trigger} — rung ${step.exit!.lockR.toFixed(2)}R breached, market close @ ~${expectedExit.toFixed(4)} ` +
          `(peak ${step.peakR.toFixed(2)}R · est. ${est.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(est.pnlUsd).toFixed(2)} · verify on MEXC)${writeNote}`,
      );
    }

    // Lock/stop-only: liveExitTick is a SEPARATE cron (15 m, :03/:18/:33/:48)
    // and owns settlement. It is never called from here, so the two passes do
    // not deliberately overlap; the non-overlap cron phases remain the guard
    // against a second close while one pass is awaiting exchange settlement.
    if (closedViaLock > 0) {
      results.push(
        `${closedViaLock} lock/stop close(s) sent — bracket reconciliation runs on the next live-exit tick`,
      );
    }
    const firstError = results.find((line) => /error|failed|unresolved/i.test(line));
    await ctx.runMutation(internal.liveEngine.setLiveMeta, {
      lastRLockAt: now,
      lastRLockResult:
        `R-LOCK checked ${tracked.length} · locked ${armed.length} · closed ${closed} · ` +
        `pending ${pendingCloses} · unmanaged ${unmanaged} · errors ${errors}`,
      lastRLockPending: pendingCloses,
      lastRLockUnmanaged: unmanaged,
      lastRLockError: firstError ?? null,
    }).catch(() => {});
    return {
      status: "ok",
      checked: tracked.length,
      closed,
      locked: armed.length,
      peakAdvanced,
      results,
    };
    }),
});
