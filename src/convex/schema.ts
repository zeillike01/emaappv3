import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // Paper trading account (MEXC live data, simulated funds — single shared record)
    paperAccount: defineTable({
      name: v.string(), // "main"
      balance: v.number(), // realized balance, starts at 300
      startBalance: v.number(), // 300
      enabled: v.boolean(), // scan loop on/off
      pairs: v.optional(v.array(v.string())),
      lastSignalTimes: v.optional(v.record(v.string(), v.number())),
      cooldownUntil: v.optional(v.record(v.string(), v.number())),
      // Short mean-reversion's BTC bull filter is stable for a closed 4h bar;
      // cache its decision on this book's account to avoid re-fetching 240 bars every 15m.
      shortMrBtcRegimeBarClose: v.optional(v.number()),
      shortMrBtcExtremeBull: v.optional(v.boolean()),
      // Last completed 15m candle whose RSI exit check ran, keyed by coin.
      shortMrRsiBarClose: v.optional(v.record(v.string(), v.number())),
      shortMrRsiValue: v.optional(v.record(v.string(), v.number())),
      shortMrDailyPnlDay: v.optional(v.string()),
      shortMrDailyRealizedPnl: v.optional(v.number()),
      // Short book only: concurrent-position cap (1..10, default 3).
      shortMrMaxOpenPositions: v.optional(v.number()),
      lastScanTime: v.optional(v.number()),
      lastScanResult: v.optional(v.string()),
      totalScans: v.optional(v.number()),
      lastScanBarClose: v.optional(v.number()), // closeTime of newest 15m bar the main scan has processed (bar-gated scanning)
      scansToday: v.optional(v.number()), // usage meter: scans since scansDate (UTC day)
      scansDate: v.optional(v.string()), // usage meter: "2026-08-26" style day key
      fastScanUntil: v.optional(v.number()), // scan every tick while a signal awaits confirmation
      pendingSignals: v.optional(v.record(v.string(), v.number())), // pair → signal time awaiting 3m EMA 31 break
      pendingDirections: v.optional(v.record(v.string(), v.string())), // pair → LONG/SHORT direction of pending signal
      scanLockUntil: v.optional(v.number()), // prevents overlapping scans (cron tick + manual button)
      enabledSince: v.optional(v.number()), // when the current run started (ms epoch)
      totalEnabledMs: v.optional(v.number()), // accumulated bot runtime across all runs
      firstEnabledAt: v.optional(v.number()), // very first time the bot was started
      strategyVersion: v.optional(v.string()), // "reversal-v1" = new config active
      // RSI wick-guard (2026-09-09, longs only): block LONG when 15m RSI(7)
      // on the signal candle exceeds maxRsiLong. See layer2-signal.ts.
      rsiLongGuard: v.optional(v.boolean()),
      maxRsiLong: v.optional(v.number()),
      // Refill tracking (2026-09-09): cumulative manual deposits + last
      // refill time, so stats can separate PnL from injected capital.
      deposits: v.optional(v.number()),
      lastRefillAt: v.optional(v.number()),
      // ── SESSION WINDOW CARRY (2026-10-21) ─────────────────────────────────
      // The realized result of the layer2 closes that have aged OUT of the
      // 14-day measurement window and been pruned from the ledger
      // (strategyEngine.pruneSessionWindow).
      //
      // WHY. The balance is PATCHED incrementally on every close, so deleting
      // a row does not move it — but every path that RE-DERIVES the balance
      // from the ledger (paperTrading.restoreLayer2Balance,
      // mining.reconcileBalances) would subtract the pruned P&L and make the
      // book look like it lost everything. The carry is added back on those
      // paths, so pruning shrinks the ledger without moving the book. The
      // same carry keeps the lifetime `bookStats` counters all-time when the
      // stats doc is rebuilt from what is left.
      archivedRealizedPnlUsd: v.optional(v.number()),
      archivedTrades: v.optional(v.number()),
      archivedWins: v.optional(v.number()),
      archivedFeesUsd: v.optional(v.number()),
      archivedR: v.optional(v.number()),
      // Newest close time that has been moved into the carry — the edge of
      // the pruned band.
      archivedUntil: v.optional(v.number()),
    }).index("by_name", ["name"]),

    // Paper trades (simulated — no orders ever placed)
    // NOTE: the live MEXC tables (liveAccount/liveTrades) and the main book
    // were removed 2026-09; their rows were purged via mining.purgeRemovedBooks.
    paperTrades: defineTable({
      coin: v.string(),
      type: v.string(), // "LONG" | "SHORT"
      // Decision-time momentum scores (2026-09-26: declared properly). These
      // have been written on every entry since the scores existed, but were
      // never declared here — so they persisted untyped and every read needed
      // a structural cast. `src/lib/a-plus-filter.ts` selects on shortScore, so
      // the field this book is built on is now part of the type it lives on.
      longScore: v.optional(v.number()),
      shortScore: v.optional(v.number()),
      entryPrice: v.number(),
      slPrice: v.number(),
      tpPrice: v.number(),
      sizeCoin: v.number(),
      leverage: v.number(),
      // R-lock trailing exit (2026-09-20). The three parameters are stamped on
      // the trade at entry (config changes are entry-scoped, exactly like
      // takeProfitPct) so the exit tick never needs a config read and a trade
      // always closes under the policy it was opened with. `trailStartR`
      // undefined/<= 0 = no lock (fixed TP, previous behaviour).
      trailStartR: v.optional(v.number()), // R multiple where locking starts
      trailStepR: v.optional(v.number()), // ratchet step in R
      trailMaxR: v.optional(v.number()), // full-exit level in R
      trailPeakR: v.optional(v.number()), // best R multiple reached since entry
      trailLockPrice: v.optional(v.number()), // current locked exit price (0 = not locked yet)
      // Newest closed 5m bar incorporated by the paper R-lock replay.
      trailReplayCursor: v.optional(v.number()),
      // ATTRIBUTION INVARIANT (2026-09-22): set at close when realizedR exceeds
      // trailPeakR, which is arithmetically impossible for any legitimate exit
      // path (peak+lock are written in one atomic running-max patch). Six live
      // winners carried this signature (+15.40R = 74% of the book's net) and
      // went unnoticed for three audits because the row read as a normal win.
      // The numbers are NOT altered — this only makes the impossibility visible
      // at the moment it happens. See detectAttributionAnomaly in live-math.ts.
      attributionAnomaly: v.optional(v.string()),
      status: v.string(), // "open" | "closed"
      entryTime: v.number(),
      // Signal timeline (delay audit):
      //   signalTime  = 15m break-bar close (when the reversal signal fired)
      //   entryTime   = close of the 15m bar whose price we entered at
      //   confirmedAt = wall-clock ms when the bot actually placed the trade
      //   delay       = confirmedAt - signalTime (0 if confirmed on first scan)
      signalTime: v.optional(v.number()),
      signalPrice: v.optional(v.number()), // price at signal time (for slippage calc)
      confirmedAt: v.optional(v.number()),
      variant: v.optional(v.string()), // e.g. "reversal-v1" | "sweep-v1"
      book: v.optional(v.string()), // "layer2" — the EMA momentum strategy book
      exitPrice: v.optional(v.number()),
      exitTime: v.optional(v.number()),
      pnlUsd: v.optional(v.number()),
      pnlPercent: v.optional(v.number()),
      reason: v.optional(v.string()), // "Take Profit" | "Stop Loss"
      // ── Regime/context tags for live-data tuning (captured at entry) ──
      session: v.optional(v.string()), // "asia" | "london" | "ldn-ny" | "ny" | "late"
      regime: v.optional(v.string()), // "trend-up" | "trend-down" | "chop" (4H EMA50 slope)
      volPct: v.optional(v.number()), // 15m ATR(14) as % of price at signal
      spreadPct: v.optional(v.number()), // MEXC bid/ask spread % at entry fill
      // Excursion profile at close (retrace tuning data):
      mfeR: v.optional(v.number()), // max favorable excursion in R (best R reached)
      maeR: v.optional(v.number()), // max adverse excursion in R (worst pullback)
      // ── Shadow leg (alternative EXIT policy, tracked on this same row) ──
      // The live book runs one fixed bracket. A shadow leg replays a different
      // exit policy over the SAME entry so the two can be compared without a
      // second engine, a second cron, or a second row: the existing 5-minute
      // exit tick already has the price in hand when it checks the real SL/TP.
      //
      // `shadowOpen` is the ONLY indexed field and it is DELETED once the leg
      // resolves, so `by_book_shadowOpen` contains exactly the pending set that
      // survives its real trade's close (the shadow's first target sits beyond
      // the real TP, so a leg legitimately outlives the position it shadows).
      // Convex omits docs lacking an indexed field, which is what makes the
      // index double as the "pending" filter. See lib/shadow-book.ts.
      shadowOpen: v.optional(v.number()), // 1 while pending; removed on resolution
      shadowTp1At: v.optional(v.number()), // ms the first target filled
      shadowBankedR: v.optional(v.number()), // R banked by the scaled-out portion
      shadowResolvedAt: v.optional(v.number()),
      shadowExitReason: v.optional(v.string()), // see ShadowExitReason
      shadowR: v.optional(v.number()), // final total R for the policy
      // ── Tier 1 enrichment (logged at entry for mining) ──
      volRatioAtEntry: v.optional(v.number()), // volume spike magnitude (bar vol / 20-SMA)
      atrPctAtEntry: v.optional(v.number()), // ATR(14) as % of price at entry (raw volatility)
      adx14_1h: v.optional(v.number()), // Wilder's ADX(14) on 1H at entry (trend strength)
      btcTrendAtEntry: v.optional(v.string()), // "up" | "down" | "chop" — BTC 1h EMA slope
      btcChange1h: v.optional(v.number()), // BTC 1h % change at entry time
      btcSlopeRaw: v.optional(v.number()), // raw EMA20 slope (for re-deriving percentile buckets)
      dayOfWeek: v.optional(v.number()), // 0=Sun … 6=Sat (UTC)
      // ── Tier 1 enrichment (logged at close) ──
      realizedR: v.optional(v.number()), // actual R-multiple at exit
      barsHeld: v.optional(v.number()), // 15m bars held before exit
      // ── Tier 1b: execution quality (logged at close) ──
      entrySlippageBps: v.optional(v.number()), // entry price vs signal price in bps
      timeToMfe: v.optional(v.number()), // bars to reach peak favorable excursion
      timeToMae: v.optional(v.number()), // bars to reach peak adverse excursion
      totalFeesUsd: v.optional(v.number()), // total trading fees in USD
      fundingCostUsd: v.optional(v.number()), // funding cost paid in USD
      // ── Tier 2: multi-timeframe confluence (logged at entry) ──
      htfEma20_4h: v.optional(v.number()), // 4H EMA20 value at entry
      htfEma50_4h: v.optional(v.number()), // 4H EMA50 value at entry
      htfTrend1h: v.optional(v.string()), // "up" | "down" | "flat" — 1H EMA slope
      htfVol4h: v.optional(v.number()), // 4H volume at entry bar
      htfVol4hAvg: v.optional(v.number()), // 4H 20-bar volume average
      distToSwingSr: v.optional(v.number()), // distance % to nearest swing S/R level
      // ── Tier 3: market microstructure (logged at entry) ──
      fundingRate: v.optional(v.number()), // perpetual funding rate at entry
      // Decision-time short mean-reversion indicators (only this variant writes them).
      shortMrRsi7: v.optional(v.number()),
      shortMrRsi14: v.optional(v.number()),
      shortMrUpperBand: v.optional(v.number()),
      shortMrMiddleBand: v.optional(v.number()),
      shortMrVolumeRatio: v.optional(v.number()),
      // OI (2026-09-09): openInterestDelta = true % change vs the Layer-1
      // tick ~4h ago (from the tick OI series); oiAtEntry = raw holdVol.
      openInterestDelta: v.optional(v.number()),
      oiAtEntry: v.optional(v.number()),
      bidAskImbalance: v.optional(v.number()), // bid volume / (bid+ask) ratio 0-1
      liquidationProx: v.optional(v.number()), // distance % to nearest liquidation cluster
      // ── Tier 4: portfolio risk (logged at entry) ──
      consecutiveStreak: v.optional(v.number()), // +N = N consecutive wins, -N = N losses
      drawdownPct: v.optional(v.number()), // current drawdown % from equity peak
      portfolioHeat: v.optional(v.number()), // concurrent open positions at entry
      rollingWr20: v.optional(v.number()), // win rate over last 20 closed trades
      // ── Tier 5: strategy-agnostic analytics (logged at close) ──
      durationBucket: v.optional(v.string()), // "fast" (<4 bars) | "medium" (4-16) | "slow" (>16)
      volAtEntry: v.optional(v.number()), // ATR(14) at entry as % of price
      volAtExit: v.optional(v.number()), // ATR(14) at exit as % of price
      volDelta: v.optional(v.number()), // volAtExit - volAtEntry (expansion > 0)
      mfeCaptureRatio: v.optional(v.number()), // realizedR / mfeR (how much of the move captured)
      // ── Tier 6: cross-asset signals (logged at close) ──
      btcMoveDuringTrade: v.optional(v.number()), // BTC % change from entry to exit
      ethMoveDuringTrade: v.optional(v.number()), // ETH % change from entry to exit
      pairVsBtc1h: v.optional(v.number()), // pair return vs BTC return over 1H at entry
      // ── Factor-exposure cap (2026-09-23) ──
      // The pair's estimated BTC beta at this entry (OLS of its 15m returns on
      // BTC's over the same closed bars; 1.0 when it could not be fit) and the
      // book's SIGNED net beta after admitting it. Recorded whenever the scan
      // measured them — even while the cap is off — so the rule's path is
      // auditable and a lab can price it on the recorded book.
      btcBetaAtEntry: v.optional(v.number()),
      netBtcBetaAtEntry: v.optional(v.number()),
      // ── H4 SHADOW TAGS (2026-09-23, record-only forward test) ──
      // Which candidate filters WOULD have fired at entry (see
      // src/lib/h4-shadow.ts). Nothing reads them to block or score; a lab
      // prices each tag's forward record at journal time (lab:shadowcheck).
      shadowTags: v.optional(v.array(v.string())),
      shadowH4RangePct: v.optional(v.number()), // null = no 4h reading (fail-open)
      shadowH4VolLog2: v.optional(v.number()),
      shadowRsi7: v.optional(v.number()),
      // D1 shadow tags v3 (2026-09-26, record-only): daily wick % + 5d return.
      d1UpWickPct: v.optional(v.number()),
      d1R5Pct: v.optional(v.number()),
      // Daily StochRSI %K (2026-10-02): declared everywhere the d1 shadow tags
      // ride — its absence here cost the decision record 3 days (see the
      // logRejections note in strategyEngine.ts).
      d1StochK: v.optional(v.number()),
      // ── Execution record (2026-10-10, Stage 3 — RECORD-ONLY) ────────────
      // Intended vs filled price, liq level at entry, decision→order latency,
      // rejects/partial fills, stop TRIGGER vs stop FILL, and the exit facts
      // in R (realizedR measured from the ACTUAL fill, never an assumed -1).
      // Written by convex/executionRecord.ts through the scheduler, fail-open.
      // Shape + flags: src/lib/execution-record.ts.
      exec: v.optional(v.any()),
    })
      .index("by_status", ["status"])
      .index("by_book", ["book"])
      .index("by_book_status", ["book", "status"])
      .index("by_book_entryTime", ["book", "entryTime"]) // recency-bounded history reads (cooldown seed + prune)
      .index("by_book_status_entryTime", ["book", "status", "entryTime"]) // closed-list keyset paging (desc)
      // Audit fix 2026-09-11: "last N closes" and "everything closed today"
      // must order/range on EXIT time, not entry time. The previous breaker
      // read the last 20 by entryTime, so a busy day (>20 closes) hid losses
      // from the daily-loss cap and long-held losers looked out of window.
      .index("by_book_status_exitTime", ["book", "status", "exitTime"])
      // Pending shadow legs (see the shadowOpen schema note). `status` is
      // part of the key so the exit tick can ask for ONLY the legs that
      // outlived their position: an OPEN trade is already in the tick's own
      // open-trades read, and re-fetching it here duplicated ~19 KB of
      // enrichment payload every 5 min (≈5.4 MB/day) for data in hand.
      .index("by_book_shadowOpen", ["book", "shadowOpen", "status"])
      .index("by_book_status_coin", ["book", "status", "coin"]) // O(1) open-duplicate check
      // Idempotency-key dedupe (2026-09): (book, coin, signalTime) is the
      // natural key of one strategy signal — the close of the 15m bar the
      // signal was computed on. insertTrade looks this up across ALL statuses
      // so a re-fired identical signal (overlapping tick or manual re-run)
      // can never open a second trade. Not a uniqueness constraint — Convex indexes
      // cannot enforce uniqueness, so the dedupe is a guarded check inside
      // the single entry mutation (see paperTrading.insertTrade).
      .index("by_book_coin_signalTime", ["book", "coin", "signalTime"]),

    // ── LAYER 1: Market Data Metrics (real-time computed by marketData cron) ──
    // Only fields the strategy engine reads are persisted (trimmed 2026-09:
    // dropped lastPrice/bestBid/bestAsk/depths/5s-volumes/klineCount — they
    // were ~25% of every doc read+write and never consumed downstream).
    marketMetrics: defineTable({
      pair: v.string(), // "SOL", "ETH", etc.
      spreadPct: v.number(), // (ask - bid) / mid * 100
      imbalance: v.number(), // (bid - ask) / (bid + ask) → -1 to +1
      flowBias: v.number(), // (buy - sell) / (buy + sell) → -1 to +1
      fundingRate: v.number(), // perpetual funding rate
      fundingValid: v.optional(v.boolean()), // true only when MEXC returned a valid rate
      atrPct: v.number(), // ATR(14) as % of price on 1m candles
      candleRangePct: v.number(), // current candle range as % of price
      vol24h: v.number(), // 24h quote volume
      fetchedAt: v.number(), // wall-clock ms when this snapshot was built
    }).index("by_pair", ["pair"]),

    // ── Layer 1 batched tick (I/O optimization, 2026-09) ──
    // One document per 5-min tick holding ALL pairs' metrics, replacing 20
    // per-pair marketMetrics upserts per tick. layer2 reads the newest tick
    // and indexes into .metrics[pair]. Old marketMetrics rows stay readable
    // during the transition and are pruned daily.
    layer1Ticks: defineTable({
      timestamp: v.number(), // wall-clock ms of the tick
      metrics: v.record(
        v.string(),
        v.object({
          spreadPct: v.number(),
          imbalance: v.number(),
          flowBias: v.number(),
          // SILENCE vs BALANCE (2026-09-22): false = the 5s flow window caught
          // no trades, so flowBias is the 0 default, NOT a measurement. 68.5%
          // of archived readings were an exact 0, and the short-flow gate was
          // treating that missing data as "no sell-flow confirmation".
          flowValid: v.optional(v.boolean()),
          fundingRate: v.number(),
          fundingValid: v.optional(v.boolean()),
          atrPct: v.number(),
          candleRangePct: v.number(),
          vol24h: v.number(),
          // Open interest snapshot (MEXC holdVol, contracts) from ONE
          // full-universe ticker fetch per tick — the per-pair OI series
          // entries use for their 4h delta. Optional: only present when the
          // universe fetch succeeded.
          oi: v.optional(v.number()),
        }),
      ),
    }).index("by_timestamp", ["timestamp"]),

    // ── Layer 1 slow-variable cache (I/O optimization, 2026-09) ──
    // EXACTLY ONE document. Funding rates change ~every 8h and contract sizes
    // almost never, yet marketDataTick used to re-fetch both for all 20 pairs
    // every 5 min (~5.7k wasted MEXC calls/day — 17% of Layer 1's network
    // meter). The tick reads this one doc once per run, only re-fetches pairs
    // whose entry is stale (8h funding / 24h contract), then patches the maps
    // in a single write. The doc also carries scanLockUntil — the Layer 1
    // run-guard lease (mirrors strategyEngine.acquireStrategyTickLock, so a
    // slow tick can't self-overlap and double-fetch everything).
    layer1Cache: defineTable({
      // DEPRECATED (2026-09-16, Database I/O audit): the run-guard lease now
      // lives in the `layer1Lock` table. This field is kept optional ONLY so
      // pre-split documents still validate — nothing reads or writes it.
      // It used to share this document, which meant every acquire/release had
      // to load the whole ~26 KB depth-ladder map just to read one number.
      scanLockUntil: v.optional(v.number()),
      funding: v.optional(
        v.record(
          v.string(),
          v.object({
            rate: v.number(),
            fetchedAt: v.number(),
            // Cache format version lets endpoint changes invalidate each pair
            // independently, without treating legitimate zero rates as bad.
            version: v.optional(v.number()),
          }),
        ),
      ),
      contractSize: v.optional(
        v.record(
          v.string(),
          v.object({ size: v.number(), fetchedAt: v.number() }),
        ),
      ),
    }),

    // ── Layer 1 run-guard lease (2026-09-16, Database I/O audit) ──
    // The lease was a field on the layer1Cache singleton, so acquire/release
    // each loaded that entire document (~26 KB, mostly the 31-pair depth
    // ladder) twice per 5-min tick to read and clear ONE number — two of the
    // deployment's top-6 Database I/O consumers, ~450 MB/month together, from
    // functions whose only work is a `first()` read. It now lives alone.
    layer1Lock: defineTable({
      lockedUntil: v.number(), // lease expiry (ms epoch); 0 = free
    }),

    // ── COMPACT OI SERIES (2026-09-16, Database I/O audit) ──
    // One small doc per Layer-1 tick carrying ONLY per-pair open interest
    // (~0.6 KB vs ~6 KB for a full layer1Ticks doc), written inside
    // recordLayer1Tick so it costs zero extra mutations. The 4h-OI delta an
    // entry records used to page the whole 4h window of `layer1Ticks` (48 docs
    // ≈ 290 KB per entry) to read a single number out of each; it now reads
    // the same window at roughly a tenth of the bytes. Semantics are
    // IDENTICAL — same timestamps, same values, same window rules. `oi` is
    // still recorded on layer1Ticks for lab replay; this is a read-side copy.
    oiTicks: defineTable({
      timestamp: v.number(),
      oi: v.record(v.string(), v.number()),
    }).index("by_timestamp", ["timestamp"]),

    // ── HTF (1h/4h) EMA cache — bar-guarded (2026-09-16, cron I/O opt) ──
    // Both books' HTF trend gate depends ONLY on the newest CLOSED HTF bar,
    // yet each engine re-fetched the whole series per pair on every 15m tick
    // (2,976 requests/day/book for 4h values that change 6×/day). Engines read
    // this cache while `barOpenTime` is current for the timeframe and fall
    // back to the fetch (previous behavior) otherwise. One doc per coin; see
    // convex/htfCache.ts for the contract and the worst-case guarantee.
    htfCache: defineTable({
      coin: v.string(),
      tf: v.string(), // "1h" | "4h"
      period: v.number(), // EMA period the stored values were computed with
      barOpenTime: v.number(), // newest CLOSED HTF bar the values came from
      ema: v.number(),
      close: v.number(),
      fetchedAt: v.number(),
    }).index("by_coin", ["coin"]),

    // ── BTC 4h regime verdict cache — bar-guarded (2026-09-16, cron I/O opt) ──
    // The layer2 / proxy / live entry gates all classify BTC's macro regime
    // from the SAME 4h EMA75 slope, and each engine re-fetched 240×4h bars on
    // every 15m tick to do it: 3 books × 96 ticks = ~288 requests/day for a
    // verdict that only changes when a 4h bar closes (6×/day) — ~186 wasted
    // requests/day, the largest remaining avoidable MEXC line after the
    // htfCache. EXACTLY ONE document holds the verdict for the newest CLOSED
    // 4h bar; engines read it while the bar is current and otherwise fetch
    // exactly as before (worst case = the old behavior, never a changed
    // verdict — the value comes from the same shared btcRegimeFromKlines).
    btcRegimeCache: defineTable({
      barOpenTime: v.number(), // newest CLOSED 4h bar at fetch time (cache-validity key)
      ema: v.number(), // BTC 4h EMA75 at that bar
      slopePct: v.number(), // EMA75 slope over 18 bars (%)
      regime: v.string(), // "up" | "down" | "chop"
      // FINE-TUNE AXES (2026-10-28, record-only): computed once per closed 4h bar
      // here, then copied onto every downBlockShadow row. Depth separated the
      // refused cohort far more than the slope's level in the 10-28 replay.
      runBars: v.optional(v.number()), // consecutive closed 4h bars in this label
      slopeDeltaPct: v.optional(v.number()), // slope[t] − slope[t−1], percentage points
      // REGIME RUN LOG (2026-10-28, record-only): the last few 4h labels as runs,
      // so the down-block card can show park/resume as a sequence instead of one
      // current state. Bounded (≤ 8 runs) and rewritten only when the verdict is
      // refetched — same doc, no index, no extra read on the card path.
      recentRuns: v.optional(
        v.array(
          v.object({
            regime: v.string(),
            startedAt: v.number(),
            bars: v.number(),
            slopePct: v.number(),
          }),
        ),
      ),
      fetchedAt: v.number(),
    }),

    // ── H4 SHADOW CACHE (2026-09-23) ──
    // Per-pair shadow numbers of the newest CLOSED 4h bar (range %, volume
    // log2 vs prior-20 median), feeding the record-only forward-test tags in
    // src/lib/h4-shadow.ts. Bar-guarded like btcRegimeCache: at most one 4h
    // fetch per pair per 4h bar, shared by BOTH books. Pruned at 8 days.
    h4ShadowCache: defineTable({
      pair: v.string(),
      barOpenTime: v.number(), // newest CLOSED 4h bar at fetch time (validity key)
      rangePct: v.number(), // bar range as % of its close
      volLog2: v.number(), // log2(volume / prior-20 median)
      fetchedAt: v.number(),
    })
      .index("by_pair", ["pair"])
      .index("by_fetched", ["fetchedAt"]),

    // ── D1 SHADOW CACHE v3 (2026-09-26) ──
    // Per-pair daily readings for the two surviving family-sweep tags
    // (src/lib/d1-shadow.ts): the last closed daily bar's upper-wick % and
    // the 5-day return. Bar-guarded: ≤1 fetch per pair per UTC day (~30
    // rows/day), shared by BOTH books. Record-only — nothing gates on these.
    // Pruned at 8 days.
    d1ShadowCache: defineTable({
      pair: v.string(),
      barOpenTime: v.number(), // newest CLOSED 1d bar (validity key)
      upWickPct: v.number(), // upper wick as % of the bar's range
      r5Pct: v.number(), // 5-day return of the daily closes
      highSweep: v.boolean(), // day exceeded prior 20d high, closed back below
      lowReclaim: v.boolean(), // day pierced prior 20d low, closed back above
      dStochK: v.optional(v.number()), // daily StochRSI %K (14/14/3/3), 2026-09-28
      fetchedAt: v.number(),
    })
      .index("by_pair", ["pair"])
      .index("by_fetched", ["fetchedAt"]),

    // ── Layer 2 cooldown tracker (I/O optimization, 2026-09) ──
    // Exactly ONE document in this table. Per-pair last-signal time lives in
    // a single record<string, ...> field, so the 15-min strategy tick reads
    // one doc instead of re-scanning the whole layer2 trade history.
    cooldowns: defineTable({
      data: v.record(
        v.string(),
        v.object({
          lastSignalTime: v.number(),
          lastSide: v.string(),
        }),
      ),
    }),

    // ── Layer 2: precomputed book summary (I/O optimization, 2026-09) ──
    // ONE doc per book holding aggregate stats of its CLOSED trades. The
    // trades tab reads this single doc instead of subscribing to the whole
    // book (239+ rows) — recomputed server-side whenever a layer2 trade
    // closes. Deep analytics still reads full history on demand (Advanced
    // Data tab), so this table never needs to be large.
    bookStats: defineTable({
      book: v.string(), // "layer2"
      closedCount: v.number(),
      wins: v.number(),
      realizedPnl: v.number(), // sum of closed pnlUsd
      totalFeesUsd: v.number(),
      updatedAt: v.number(),
    }).index("by_book", ["book"]),

    // SESSION PROFITABILITY SNAPSHOT (2026-10-20). One row per UTC day,
    // refreshed by the `session-breaker-refresh` cron (00:20 + 12:20 UTC) and
    // read by the LIVE entry path (with an on-tick recompute fallback when the
    // newest row is missing/older than the cadence, so a deploy never has to
    // wait for midnight). Buckets are the evidence; the gate only reads
    // `blocked`, which covers BOTH refusals: an unproven bucket
    // (trades < minTrades, `insufficient`) and a measured loss
    // (sumR <= minProfitR). Paper entries do NOT read this table — paper is
    // the sensor and stays open.
    // Pure math: src/lib/session-breaker.ts.
    sessionBreakerState: defineTable({
      day: v.string(), // YYYY-MM-DD (UTC)
      computedAt: v.number(),
      lookbackDays: v.number(),
      minTrades: v.number(),
      minProfitR: v.number(),
      source: v.string(), // "paper"
      buckets: v.array(
        v.object({
          session: v.string(),
          side: v.string(),
          trades: v.number(),
          wins: v.number(),
          sumR: v.number(),
          winRate: v.union(v.number(), v.null()),
          // Optional because rows written before 2026-10-22 carry neither.
          insufficient: v.optional(v.boolean()), // trades < minTrades
          minTrades: v.optional(v.number()),
          blocked: v.boolean(),
        }),
      ),
    }).index("by_day", ["day"]),

    // COIN-PRIORITY MONITOR (2026-10-21). One row per UTC day: the paper
    // book's per-coin record over the lookback window, written by the daily
    // `coin-priority-refresh` cron and read by the LIVE entry tick to order
    // its scan. Daily rows are the monitor's history — every fire also
    // deletes rows older than the lookback, so the table holds at most 14
    // days of snapshots. `tier` is priority | neutral | avoid.
    coinProfitState: defineTable({
      day: v.string(), // YYYY-MM-DD (UTC)
      computedAt: v.number(),
      lookbackDays: v.number(),
      minTrades: v.number(),
      source: v.string(), // "paper"
      buckets: v.array(
        v.object({
          coin: v.string(),
          trades: v.number(),
          wins: v.number(),
          sumR: v.number(),
          winRate: v.union(v.number(), v.null()),
          tier: v.string(),
        }),
      ),
    }).index("by_day", ["day"]),

    // ── Layer 2: Configurable Strategy Parameters ──
    strategyConfig: defineTable({
      name: v.string(), // "ema-momentum" (single record)
      // EMA settings
      emaFast: v.number(), // fast EMA period (default 7)
      emaSlow: v.number(), // slow EMA period (default 30)
      gapThreshold: v.number(), // EMA gap % to trigger bonus (default 0.02)
      // Scoring thresholds
      minScore: v.number(), // minimum score to qualify (default 8 for EMA-only)
      minGap: v.number(), // minimum gap between LONG and SHORT scores (default 2)
      // Risk management
      stopLossPct: v.number(), // stop loss % (default 1.5)
      takeProfitPct: v.number(), // take profit % (default 2.0)
      // Filters
      spreadTight: v.number(), // spread % below which = tight (default 0.04)
      spreadWide: v.number(), // spread % above which = wide blocker (default 0.12)
      atrSpikeMult: v.number(), // candle range / ATR threshold for spike blocker (default 2.0)
      feePct: v.number(), // total fee % per trade (default 0.06)
      // Side kill switches — manual front-end control. When false the engine
      // never ENTERS that side (open positions of that side still resolve
      // normally through the exit cron). Missing on legacy rows = allowed.
      allowLong: v.optional(v.boolean()),
      allowShort: v.optional(v.boolean()),
      // Book weight bonuses (added when Layer 1 data available)
      bookWeight: v.number(), // max order book imbalance score (default 22)
      flowWeight: v.number(), // max trade flow bias score (default 22)
      fundingWeight: v.number(), // max funding rate score (default 2)
      fundingMode: v.optional(v.string()), // "bonus" (live default), "strict", or "off" (paper, 2026-09-08)
      fundingBonusThreshold: v.optional(v.number()), // meaningful rate threshold, decimal
      // Circuit breaker (paper only, 2026-09-08): pause entries on low
      // rolling WR (breakerMinWr over last 20 closes) or heavy daily loss
      // (breakerMaxDailyLossPct of balance). Defaults merged in resolveConfig.
      breakerEnabled: v.optional(v.boolean()),
      breakerMinWr: v.optional(v.number()),
      breakerMaxDailyLossPct: v.optional(v.number()),
      // LIVE circuit breaker (2026-09-10, manual re-arm 2026-10-22): N
      // consecutive losses (default 6) DISARM live entries until an operator
      // re-arms. State persisted on the liveAccount doc (see
      // liveAccount.liveBreakerManualDisarmedAt). liveBreakerManualReArm
      // false falls back to the legacy timed cooldown.
      liveBreakerEnabled: v.optional(v.boolean()),
      liveBreakerMaxLossStreak: v.optional(v.number()),
      liveBreakerCooldownMin: v.optional(v.number()),
      liveBreakerManualReArm: v.optional(v.boolean()),
      liveBreakerRearmOnSession: v.optional(v.boolean()),
      // SESSION PROFITABILITY BREAKER (2026-10-20): PAPER measures, LIVE acts.
      // The paper ledger is bucketed by (session, side); a bucket with at
      // least sessionBreakerMinTrades closes is closed to LIVE entries while
      // its realized R is <= sessionBreakerMinProfitR (0 = must be
      // profitable). Paper is never blocked. Thresholds are read from the
      // paper row; `sessionBreakerEnabled` is read from the LIVE row to arm
      // the gate. Snapshot: `sessionBreakerState`; veto:
      // liveBrokerRuntime.processPairLive. `sessionBreakerSource` is stored for
      // audit only — the source is the paper ledger by definition.
      sessionBreakerEnabled: v.optional(v.boolean()),
      sessionBreakerLookbackDays: v.optional(v.number()),
      sessionBreakerMinTrades: v.optional(v.number()),
      sessionBreakerMinProfitR: v.optional(v.number()),
      sessionBreakerSource: v.optional(v.string()),
      // COIN PRIORITY (2026-10-21): orders the LIVE scan by each coin's
      // paper record over the window (profitable first). Snapshot table:
      // `coinProfitState`; ordering: liveBrokerRuntime.liveEntryTick. It is
      // an ORDER, not a gate — no entry is refused by this rank.
      coinPriorityEnabled: v.optional(v.boolean()),
      coinPriorityLookbackDays: v.optional(v.number()),
      coinPriorityMinTrades: v.optional(v.number()),
      coinPriorityBlockAvoid: v.optional(v.boolean()),
      // HTF advisor (2026-09-08): 4H divergence/exhaustion veto layer.
      // advisorEnabled defaults ON for paper (see getConfig), OFF for live.
      advisorEnabled: v.optional(v.boolean()),
      // Advisor input mode (2026-09-09): "pair" | "btc" | "both" — which
      // 4H verdicts gate entries. Defaults to "both" via DEFAULT_CONFIG.
      advisorMode: v.optional(
        v.union(v.literal("pair"), v.literal("btc"), v.literal("both")),
      ),
      advisorVetoThreshold: v.optional(v.number()),
      // Per-side overrides (2026-09-08): SHORT=1 blocks shorts on any single
      // flag (every flagged short lost in the replay); LONG stays 2. Unset =
      // fall back to advisorVetoThreshold.
      advisorLongThreshold: v.optional(v.number()),
      advisorShortThreshold: v.optional(v.number()),
      // 4H divergence age in 4H bars (how recent a confirmed divergence must
      // be to vote). WIRED to 4 on 2026-09-12 (was 6): A/B'd in
      // run-trio-advisor-lab.ts against this exact stored stack (4H
      // mode="both", 1H layer off) and better in all three windows —
      // Sep 1-12 +115.1R → +125.3R, Aug 20-Sep 1 -103.3R → -61.1R,
      // Aug 1-Sep 1 -140.3R → -102.2R. The shorter window retires stale
      // divergences sooner, so the veto tracks present structure.
      advisorDivergenceAgeBars: v.optional(v.number()),
      advisorVwapExtremePct: v.optional(v.number()),
      advisorRsiExtreme: v.optional(v.number()),
      // Stochastic RSI (2026-09-11): replaces plain RSI(14) as the advisor's
      // momentum oscillator. Kill switch + classic 14/14/3/3 params.
      advisorStochRsiEnabled: v.optional(v.boolean()),
      // 1H advisor (2026-09-12): a SECOND run of the same detector on 1H
      // bars, vetoing alongside the 4H layer when true. Same weights,
      // same thresholds (the detector is timeframe-agnostic). Default
      // UNSET (= off) until the Sep-1→now cache backtest validates it.
      advisor1hEnabled: v.optional(v.boolean()),
      // 1H advisor per-side thresholds (2026-09-12): unset = fall back to
      // the shared advisor thresholds. MACD sweep (Sep 1-12, disk cache):
      // sweet spot L3.5/S2.5 — vote quantization makes L3.25-3.5 / S2.25-2.75
      // land on the identical book, L4/S2.5 over-vetoes (~3R worse).
      advisor1hLongThreshold: v.optional(v.number()),
      advisor1hShortThreshold: v.optional(v.number()),
      // 1H-only MACD flag weight (2026-09-12): unset = share advisorMacdWeight.
      // Swept 13 param sets x 3 weights: shipped 6/14/10 params already optimal,
      // but the hourly layer's sweet spot is weight 0.5 (+26.0R marginal vs
      // +22.8R at the shared w1) — hourly MACD flags fire ~3x more often.
      advisor1hMacdWeight: v.optional(v.number()),
      // Smart Volume MACD vote family (2026-09-13, run-smartvol-advisor-lab.ts):
      // the strongest veto-family result measured on this book — weight 1 lifts
      // all four arms (e.g. NEW/FIXED +0.020 → +0.059 net/t, DD 66→62R) — but
      // it FAILED the pre-registered day-clustered null bar (t +0.5 to +1.2 < 2;
      // a random same-day/same-side pick vetoes as well), so it ships OFF until
      // the forward record confirms. 4H advisor only: the advisor tick's 1H
      // branch reads advisor1hSmartVolWeight, never this shared value.
      advisorSmartVolEnabled: v.optional(v.boolean()),
      advisorSmartVolWeight: v.optional(v.number()),
      advisorSmartVolFast: v.optional(v.number()),
      advisorSmartVolSlow: v.optional(v.number()),
      advisorSmartVolSignal: v.optional(v.number()),
      // 1H layer isolation for the same family: unset = OFF on the hourly
      // layer (the lab's tested scope). A number here would arm it on 1H too.
      advisor1hSmartVolWeight: v.optional(v.number()),
      // RSI-Div differential family (2026-09-13, run-rsidiv-lab.ts): the user's
      // Pine "RSI Divergence" (rsiFast − rsiSlow) as a 4H advisor vote family.
      // Trigger arms lost badly (−0.04..−0.06 net/t, 2× churn); advisor w=1
      // showed a faint all-exit-positive hint but no dose-response and nulls ~0
      // — ships OFF, operator-reachable like smartVol.
      advisorRsiDivEnabled: v.optional(v.boolean()),
      advisorRsiDivWeight: v.optional(v.number()),
      advisorRsiDivFast: v.optional(v.number()),
      advisorRsiDivSlow: v.optional(v.number()),
      // Source of the differential (2026-09-13): one of ADVISOR_RSIDIV_SOURCES
      // ("close" | "open" | "high" | "low" | "hl2" | "hlc3" | "ohlc4" |
      // "ema30" | "sma30" | "vwap" | "macd" | "volume" | "atr"). Unset =
      // "close" — the only source the first lab measured; the source sweep
      // (run-rsi-div-lab.ts) decides whether any other source promotes.
      advisorRsiDivSource: v.optional(v.string()),
      advisor1hRsiDivWeight: v.optional(v.number()),
      // 1H-only StochRSI periods (2026-09-12): unset = share the advisor-
      // StochRsi* fields. Sweep (15 settings, disk cache, audited method):
      // sweet spot 8/8/3/3 %D — +37.5R 1H marginal vs +26.0R at the shipped
      // 14/14/3/3 %D, and the ranking held at a second exit geometry.
      // K/D smoothing + %K/%D read intentionally stay shared (the winner
      // uses the shared 3/3 %D).
      advisor1hStochRsiRsiPeriod: v.optional(v.number()),
      advisor1hStochRsiStochPeriod: v.optional(v.number()),
      // 1H-only divergence age (2026-09-12): unset = share
      // advisorDivergenceAgeBars. Gates ALL divergence flags (how recent a
      // divergence must be to vote). WIRED to 12 (the sweep's earlier 8 was
      // beaten by 12 both in-sample — +81.4R vs +74.3R 1H marginal, 4H pinned
      // to the pair arm — and out of sample on Aug 20-Sep 1: +47.8R vs
      // +39.7R). Written into both config rows; blank still means "share".
      advisor1hDivergenceAgeBars: v.optional(v.number()),
      // 1H-only advisor INPUT MODE (2026-09-12): which verdicts gate the
      // hourly layer — "pair" | "btc" | "both". UNSET = share advisorMode
      // (the pre-fix behaviour, so nothing changes for books that never set
      // it). Added because the mode A/B's best cell needs the two layers on
      // DIFFERENT modes (4H=pair + 1H=btc → 641t · WR 46.8% · +203.5R, +74.3R
      // over the pair-only 4H book), which the single shared advisorMode
      // knob could not express. The gate resolves it as
      // `advisor1hMode ?? advisorMode ?? "both"`.
      advisor1hMode: v.optional(
        v.union(v.literal("pair"), v.literal("btc"), v.literal("both")),
      ),
      advisorStochRsiRsiPeriod: v.optional(v.number()),
      advisorStochRsiStochPeriod: v.optional(v.number()),
      advisorStochRsiKSmooth: v.optional(v.number()),
      advisorStochRsiDSmooth: v.optional(v.number()),
      advisorStochRsiUseD: v.optional(v.boolean()),
      // LAYER2 books (2026-09-13, layer2-v2-4h-ema75): which HTF-gate era the
      // paper/live rows were stamped for. The one-time migration in
      // strategyTick writes htfShortEma/htfLongEma = 75, htfTf = "4h", and
      // re-arms both gate switches when the variant differs.
      layer2Variant: v.optional(v.string()),
      // BTC regime side gate: block LONG while
      // BTC's 4h EMA75 slope is chop, SHORT while it is up (±0.5% over 18
      // closed bars). Raw row flag, `!== false` fail-safe default ON.
      btcRegimeEnabled: v.optional(v.boolean()),
      // DOWN-BLOCK (2026-09-14, layer2-v4, layer2 rows only): also block
      // BOTH sides while regime is "down" (grind-fix lab cohort −137.2R).
      btcRegimeDownBlock: v.optional(v.boolean()),
      // 4H CHOPPINESS GATE (2026-09-22, layer2 paper + live rows, SHIPS OFF):
      // block BOTH sides while the pair's own 4H Kaufman Efficiency Ratio
      // ER(period) < floor (optional per-side override). Pure math in
      // src/lib/chop-gate.ts; the 6-month A/B is run-4h-chop-gate-lab.ts
      // (backtest:chopgate). Enforced by strategyEngine (paper) only until
      // the lab validates it — live ignores the flag, like other experiments.
      // Defaults live in layer2-signal DEFAULT_CONFIG (enabled=false).
      chopGateEnabled: v.optional(v.boolean()),
      chopGatePeriod: v.optional(v.number()),
      chopGateFloor: v.optional(v.number()),
      // Nullable: explicit null = "no per-side override" (falls back to the
      // shared floor), same pattern as shortTakeProfitPct.
      chopGateFloorLong: v.optional(v.union(v.null(), v.number())),
      chopGateFloorShort: v.optional(v.union(v.null(), v.number())),
      // 15m VOLATILITY FLOOR (2026-09-27, armed on both books): block a side
      // when the decision bar's own ATR% is below the floor. Shared knob plus
      // per-side overrides, the chop-gate pattern (nullable = "inherit the
      // shared floor"). Shipped config is longs-only 0.60; see src/lib/vol-floor.ts.
      atrFloorPct: v.optional(v.number()),
      atrFloorPctLong: v.optional(v.union(v.null(), v.number())),
      atrFloorPctShort: v.optional(v.union(v.null(), v.number())),
      // Weighted-vote model (2026-09-08): strong tells (thin zones, bullish
      // divergence) weigh advisorStrongWeight; weak tells (RSI/OBV bearish
      // divergence) weigh advisorWeakWeight. Both = 1 = uniform.
      advisorStrongWeight: v.optional(v.number()),
      advisorWeakWeight: v.optional(v.number()),
      // PER-FAMILY ADVISOR SWITCHES (2026-10-23, one panel button each).
      // Unset = ON, so rows written before these knobs existed keep the exact
      // shipped detector. A disabled family computes its flags (the panel still
      // displays them) but casts 0 votes and writes no reason string, so it can
      // neither veto alone nor contribute toward a confluence threshold. Read
      // by advisorConfigFrom(), which both advisor ticks and the engines share.
      advisorMomDivEnabled: v.optional(v.boolean()),   // StochRSI/RSI divergence
      advisorObvEnabled: v.optional(v.boolean()),      // OBV divergence
      advisorAdEnabled: v.optional(v.boolean()),       // A/D-line divergence
      advisorCmfEnabled: v.optional(v.boolean()),      // CMF divergence
      advisorVwapEnabled: v.optional(v.boolean()),     // VWAP-stretch exhaustion
      advisorThinZoneEnabled: v.optional(v.boolean()), // thin-volume-zone exhaustion
      // Metadata
      updatedAt: v.number(), // last update timestamp
      updatedBy: v.optional(v.string()), // who updated it
    }).index("by_name", ["name"]),
    // ────────────────────────────────────────────────────────────────────────
    // ── LIVE TRADING (separate page/route, 2026-09) ──
    // The same Layer 2 auto-bot as paper book="layer2", but placing REAL
    // orders on the trader's MEXC futures account. Fresh ledger — nothing is
    // migrated from paper. Enabled/stopped from the Live page button; runs in
    // parallel with paper. Real trades only happen when BOTH the account is
    // enabled AND the MEXC_API_KEY / MEXC_API_SECRET env vars exist on the
    // Convex deployment (checked inside the node actions in liveBroker.ts).
    // ────────────────────────────────────────────────────────────────────────

    // Live bot account — EXACTLY ONE document (name="live"). Mirrors the
    // paperAccount shape that strategyTick uses so the two engines behave
    // identically (lease-guarded scans, per-pair signal cooldown, last-scan
    // diagnostics). Real balance is always read from the exchange on each
    // tick and snapshotted here for the UI.
    liveAccount: defineTable({
      name: v.string(), // "live"
      // INERT legacy fields (2026-09-25): the single-user ownership lock was
      // removed, so nothing reads or writes these. Existing rows keep their
      // stored values; new rows leave them undefined.
      ownerSubject: v.optional(v.string()),
      ownerKey: v.optional(v.string()),
      enabled: v.boolean(), // button on/off (start/stop)
      leverage: v.number(), // exchange leverage on new entries (default 50, editable in UI)
      riskPct: v.number(), // % of live USDT equity risked per trade (default 1 — or the saved liveDefaults doc; editable in Risk settings)
      maxOpenPositions: v.optional(v.number()), // LIVE ONLY: concurrent live-position cap (default 10 — raised in Risk settings when more funds land). The paper book has NO cap by design: it is the data-gathering sensor, so every qualified signal it can take is taken.
      scanLockUntil: v.optional(v.number()), // run-guard lease expiry (ms) — mirrors acquireStrategyTickLock
      // LIVE circuit breaker persisted state (2026-09-10): when a loss-streak
      // trip fires, the engine writes these so the cooldown survives ticks.
      // pausedUntil in the past + no fresh post-trigger losses = re-armed.
      liveBreakerPausedUntil: v.optional(v.number()),
      liveBreakerTriggeredAt: v.optional(v.number()),
      // MANUAL DISARM (2026-10-22): stamped when the breaker trips in its
      // default manual mode. While present, EVERY live entry is vetoed — no
      // cooldown, no calendar reset. Only rearmLiveBreaker() clears it (and
      // stamps liveBreakerTriggeredAt = now so the old streak cannot re-trip).
      liveBreakerManualDisarmedAt: v.optional(v.number()),
      // STREAK RESET (2026-10-24): the loss streak is DERIVED from the ledger
      // (computeLiveLossStreak), never stored — so no counter can be zeroed.
      // This stamp is the operator's reset line: every close that exited
      // before it is excluded from the streak, and anything that exits after
      // it counts from 0 again. The closed rows themselves are untouched, so
      // the audit trail still shows the losses that were written off.
      liveBreakerStreakResetAt: v.optional(v.number()),
      enabledSince: v.optional(v.number()),
      firstEnabledAt: v.optional(v.number()),
      totalEnabledMs: v.optional(v.number()),
      // Exchange snapshot (fetched by the node actions; surfaced in the UI)
      balanceUsd: v.optional(v.number()), // USDT wallet+position equity snapshot
      walletBalanceUsd: v.optional(v.number()),
      lastProbeAt: v.optional(v.number()),
      lastProbeOk: v.optional(v.boolean()),
      lastProbeDetail: v.optional(v.string()),
      // Per-pair last ENTERED signal time (1h cooldown, mirrors cooldowns table)
      lastSignalTimes: v.optional(v.record(v.string(), v.number())),
      // CHASE GUARD (2026-09-07): first-signal anchors (price + bar time) per
      // pair recorded while the position cap blocked entries. Consumed (and
      // cleared) when a slot frees: if price has drifted beyond
      // maxSignalDriftPct or the anchor is older than signalMaxAgeMin, the
      // entry is skipped instead of chasing.
      pendingSignals: v.optional(
        v.record(
          v.string(),
          v.object({
            side: v.string(), // "LONG" | "SHORT"
            price: v.number(),
            time: v.number(),
          }),
        ),
      ),
      // Diagnostics from the latest engine runs
      lastScanAt: v.optional(v.number()),
      lastScanResult: v.optional(v.string()),
      lastExitAt: v.optional(v.number()),
      lastExitResult: v.optional(v.string()),
      // R-lock is a separate safety pass. Keep its outcome separate from the
      // 15m settlement pass so a green live-exit heartbeat cannot hide an
      // unmanaged position or a failed trail-state write.
      lastRLockAt: v.optional(v.number()),
      lastRLockResult: v.optional(v.string()),
      lastRLockPending: v.optional(v.number()),
      lastRLockUnmanaged: v.optional(v.number()),
      lastRLockError: v.optional(v.string()),
      // Durable MEXC order recovery is independent of market-sensitive cron
      // cadences. Keep its last outcome separate from entry/exit summaries.
      lastIntentAt: v.optional(v.number()),
      lastIntentResult: v.optional(v.string()),
      lastIntentPending: v.optional(v.number()),
      lastIntentFailed: v.optional(v.number()),
      totalEntries: v.optional(v.number()),
      totalCloses: v.optional(v.number()),
      totalEntryErrors: v.optional(v.number()),
      // Rolling entry-error log (2026-09-08): last ~10 per-pair failures with
      // pair + wall-clock time + message. The counter alone was blind — the
      // messages used to live only in lastScanResult (overwritten every tick),
      // so a rejection was undiagnosable after the fact. Kept inside the
      // account doc so the tick's single setLiveMeta patch persists both.
      entryErrors: v.optional(
        v.array(
          v.object({
            time: v.number(),
            pair: v.string(),
            message: v.string(),
          }),
        ),
      ),
    }).index("by_name", ["name"]),

    // Live closed-book summary (I/O optimization — mirrors bookStats for
    // paper). The /live header stats (Closed / Win Rate / Realized PnL) used
    // to be computed from a live subscription collecting up to 500 closed
    // liveTrades rows — re-run on EVERY live write once history grows, the
    // same whole-book pattern that blew paper's Database I/O meter (fixed
    // there via bookStats). ONE doc, patched inside markLiveClosed.
    liveStats: defineTable({
      closedCount: v.number(),
      wins: v.number(),
      totalPnl: v.number(),
      totalFeesUsd: v.number(),
      realizedRSum: v.number(),
      // GROSS PnL LEGS (2026-10-28) — profit factor is sum(wins) / sum(losses)
      // in USD; `totalPnl` alone cannot recover the ratio. Optional so a doc
      // written before this shipped still reads: the next close rebuilds it
      // via recomputeLiveStats (markLiveClosed detects the missing fields).
      grossWinUsd: v.optional(v.number()),
      grossLossUsd: v.optional(v.number()),
      updatedAt: v.number(),
    }),

    // Live bot defaults — EXACTLY ONE optional doc (name="live"). Seeds a
    // FRESH liveAccount row (leverage / riskPct / maxOpenPositions) whenever
    // one is created (account reset, brand-new deployment). Edited from the
    // /live Risk settings card ("Also save as defaults"). When no doc exists,
    // creation falls back to the built-in constants in liveEngine
    // (LIVE_DEFAULT_*: risk 1% / 50x / max 3 open).
    liveDefaults: defineTable({
      name: v.string(), // "live"
      leverage: v.number(),
      riskPct: v.number(),
      maxOpenPositions: v.number(),
      updatedAt: v.number(), // when the defaults were last saved
    }).index("by_name", ["name"]),

    // Live trades — REAL positions mirrored for the UI. Book never mixes with
    // paperTrades: the user wanted a brand-new live ledger, so history starts
    // empty the first time the bot is armed.
    liveTrades: defineTable({
      coin: v.string(),
      type: v.string(), // "LONG" | "SHORT"
      status: v.string(), // "pending" | "open" | "closed" | "cancelled"
      entryTime: v.number(), // wall-clock ms when the entry intent was created
      signalTime: v.optional(v.number()), // deterministic idempotency key: closed 15m bar the signal fired on
      signalPrice: v.optional(v.number()),
      entryPrice: v.optional(v.number()), // price the order was sized against (ticker at signal)
      slPrice: v.number(),
      tpPrice: v.number(),
      volContracts: v.number(), // quantity submitted (MEXC contracts)
      notionalUsd: v.number(),
      marginUsd: v.number(),
      leverage: v.number(),
      orderId: v.optional(v.string()), // exchange order id on success
      externalOid: v.optional(v.string()), // idempotency external id sent with the order
      positionId: v.optional(v.union(v.string(), v.number())),
      // Entry lifecycle: a row is inserted BEFORE the exchange order. A
      // pending/unknown intent is never safe to retry blindly; reconciliation
      // resolves it from the order, position, or deal history first.
      entryIntentStatus: v.optional(v.string()), // pending | submitting | submitted | unknown | filled | failed
      entryIntentId: v.optional(v.string()),
      entrySubmittedAt: v.optional(v.number()),
      entryLastError: v.optional(v.string()),
      // R-lock trailing exit (2026-09-20) — same semantics as paperTrades.
      // The exchange SL stays attached as the crash floor; the lock is
      // enforced bot-side on its own 5-min tick (see r-lock.ts).
      trailStartR: v.optional(v.number()),
      trailStepR: v.optional(v.number()),
      trailMaxR: v.optional(v.number()),
      trailPeakR: v.optional(v.number()),
      trailLockPrice: v.optional(v.number()),
      // ATTRIBUTION INVARIANT (2026-09-22): see the paperTrades field of the
      // same name. Set at close when realizedR exceeds trailPeakR — impossible
      // for any legitimate exit path. Recorded, never corrected.
      attributionAnomaly: v.optional(v.string()),
      // FROZEN R RULER (2026-09-21): 1R in price, captured at entry as
      // |entryPx − SL|. liveExitTick refines entryPrice with the exchange's
      // average fill once the position becomes visible, and rLockStep derived
      // R from |entryPrice − slPrice| on EVERY tick — so a refinement re-scaled
      // the ruler under a trailPeakR/trailLockPrice that had been stored on the
      // old one. The lock now reads both its divisor and its anchor from
      // (slPrice, riskPx, side), so R is fixed for the life of the trade and
      // the refinement only affects reported entry price. Absent on rows opened
      // before this field — those fall back to the live calculation.
      riskPx: v.optional(v.number()),
      // Immutable R-lock origin. Unlike entryPrice (which may be refined to the
      // exchange average fill), this anchor and riskPx are never changed by a
      // later bracket retry.
      rLockAnchorPrice: v.optional(v.number()),
      // Newest closed 5m bar incorporated into the incremental replay. Missing
      // means the next pass must prove full entry-to-now coverage before using
      // replay state.
      trailReplayCursor: v.optional(v.number()),
      // Bracket lifecycle. A pending/unknown attachment is reconciled from the
      // exchange's open stop orders rather than submitted a second time.
      bracketIntentStatus: v.optional(v.string()), // pending | submitted | attached | unknown | failed | stale
      bracketIntentId: v.optional(v.string()),
      // BOUNDED FENCE (2026-09-24). bracketIntentAt is when the current claim was
      // taken; expireLiveBracketIntent measures staleness from it, so a cut reply
      // or a process death after the claim can no longer fence a retry forever.
      // bracketStaleAt records when that claim was expired, which is the audit
      // trail for the retry that follows it. Both are re-stamped by
      // markLiveBracketFailed, so an ambiguous outcome observed late still gets a
      // full unresolved window from the moment it was observed.
      bracketIntentAt: v.optional(v.number()),
      bracketStaleAt: v.optional(v.number()),
      bracketLastError: v.optional(v.string()),
      bracketAttachedAt: v.optional(v.number()),
      // R-LOCK STOP AMEND (2026-09-26): the exchange SL is MOVED to each
      // ratcheted rung (cancel + replace, tighten-only). exchangeSlPrice is
      // the level the ledger believes is resting at the exchange right now —
      // slPrice keeps the ORIGINAL frozen ruler (riskPx is measured from it).
      // stopAmendAttempts/stopAmends track the amend lifecycle for audit.
      exchangeSlPrice: v.optional(v.number()),
      stopAmendedAt: v.optional(v.number()),
      stopAmendAttempts: v.optional(v.number()),
      // Close side (filled server-side by liveExitTick / manual close)
      exitPrice: v.optional(v.number()),
      exitTime: v.optional(v.number()),
      exitOrderId: v.optional(v.string()),
      reason: v.optional(v.string()), // "Stop Loss" | "Take Profit" | "Exchange TP/SL" | "Manual close"
      // Durable close intent. The exchange call is made only after claimClose
      // wins an atomic mutation; accepted-but-unsettled orders remain here and
      // are reconciled by orderId/externalOid before any retry.
      closeIntentStatus: v.optional(v.string()), // pending | submitted | unknown | settled | failed
      closeIntentId: v.optional(v.string()),
      closeRequestedAt: v.optional(v.number()),
      closeRequestedVol: v.optional(v.number()),
      closeReason: v.optional(v.string()),
      closeExpectedPrice: v.optional(v.number()),
      closeExpectedExitTime: v.optional(v.number()),
      closePnlUsd: v.optional(v.number()),
      closeRealizedR: v.optional(v.number()),
      closeFeesUsd: v.optional(v.number()),
      closeAttempts: v.optional(v.number()),
      closeLastError: v.optional(v.string()),
      pnlUsd: v.optional(v.number()),
      realizedR: v.optional(v.number()),
      feesUsd: v.optional(v.number()),
      session: v.optional(v.string()), // asia | london | ldn-ny | ny | late (same labels as paper)
      // Entry enrichment — SAME public-data context paper stores per trade
      // (buildTradeEnrichment), attached AFTER the order fills so enrichment
      // latency never delays a real entry. Lets the Claude backtest compare
      // real vs paper fills on identical market-state inputs.
      regime: v.optional(v.string()),
      volPct: v.optional(v.number()),
      atrPctAtEntry: v.optional(v.number()), // ATR(14) as % of price at entry (raw volatility)
      spreadPct: v.optional(v.number()),
      btcTrendAtEntry: v.optional(v.string()),
      btcChange1h: v.optional(v.number()),
      htfEma20_4h: v.optional(v.number()),
      htfEma50_4h: v.optional(v.number()),
      htfTrend1h: v.optional(v.string()),
      htfVol4h: v.optional(v.number()),
      htfVol4hAvg: v.optional(v.number()),
      distToSwingSr: v.optional(v.number()),
      fundingRate: v.optional(v.number()),
      // OI (2026-09-09): openInterestDelta = true % change vs the Layer-1
      // tick ~4h ago; oiAtEntry = raw holdVol snapshot (contracts).
      openInterestDelta: v.optional(v.number()),
      oiAtEntry: v.optional(v.number()),
      bidAskImbalance: v.optional(v.number()),
      pairVsBtc1h: v.optional(v.number()),
      entryError: v.optional(v.string()), // set when the exchange rejected the order
      // Exchange-side protective bracket (2026-09): stopLossPrice +
      // takeProfitPrice attached to the OPEN order so the exchange enforces
      // the stop instantly — the 5-min monitor can't be outrun by a gap. When
      // false/missing the trade is monitor-managed (previous behavior) and
      // the exit tick is its closer.
      exchangeStop: v.optional(v.boolean()),
      // Dead-bracket backstop (2026-09): when a bracketed row's level is
      // breached but the exchange stop has not closed it, this records the
      // first breach time. The exit tick market-closes once the breach
      // persists past BRACKET_BACKSTOP_MS (the exchange stop is presumed
      // canceled), instead of letting the position ride past its SL forever.
      // Cleared when price recovers between the levels.
      bracketBreachSince: v.optional(v.number()),
      // ── PAPER PARITY, ANALYTICAL FIELDS (2026-09-23) ─────────────────────
      // The live book carried only the ENTRY half of paper's context: every
      // finding this project has measured (churn, excursion, capture, scores)
      // lived on paperTrades and could never be confirmed on the independent
      // real-money book, because these fields did not exist here at all.
      // All optional and best-effort — a missing reading stays missing, never
      // becomes zero. Semantics are identical to the paperTrades field of the
      // same name (shared helpers live in src/lib/trade-analytics.ts).
      // Decision vector at entry (was logged only to strategySignals).
      longScore: v.optional(v.number()),
      shortScore: v.optional(v.number()),
      dayOfWeek: v.optional(v.number()), // 0=Sun … 6=Sat (UTC)
      // Excursion profile at close (retrace / give-back tuning data).
      mfeR: v.optional(v.number()),
      maeR: v.optional(v.number()),
      timeToMfe: v.optional(v.number()),
      timeToMae: v.optional(v.number()),
      mfeCaptureRatio: v.optional(v.number()),
      barsHeld: v.optional(v.number()),
      durationBucket: v.optional(v.string()), // "fast" | "medium" | "slow"
      entrySlippageBps: v.optional(v.number()),
      // Volatility + cross-asset context at close.
      volAtEntry: v.optional(v.number()),
      volAtExit: v.optional(v.number()),
      volDelta: v.optional(v.number()),
      btcMoveDuringTrade: v.optional(v.number()),
      ethMoveDuringTrade: v.optional(v.number()),
      // Paper parity (2026-09-23): participation into the entry bar — the
      // breakout bar's volume against the 20-bar SMA before it — and the
      // modelled funding cost of the hold. Both are derivable from data the
      // close-side backfill already fetches (k15 + notionalUsd), so live was
      // recording neither only because nothing computed them.
      volRatioAtEntry: v.optional(v.number()),
      fundingCostUsd: v.optional(v.number()),
      totalFeesUsd: v.optional(v.number()), // mirror of feesUsd, paper's name
      // Factor-exposure cap (2026-09-23) — see the paperTrades fields.
      btcBetaAtEntry: v.optional(v.number()),
      netBtcBetaAtEntry: v.optional(v.number()),
      // ── H4 SHADOW TAGS (2026-09-23, record-only forward test) ──
      // Same contract as paperTrades: which candidate filters WOULD have
      // fired at entry. Data, not rules — no gate reads these.
      shadowTags: v.optional(v.array(v.string())),
      shadowH4RangePct: v.optional(v.number()),
      shadowH4VolLog2: v.optional(v.number()),
      shadowRsi7: v.optional(v.number()),
      // D1 shadow tags v3 (2026-09-26, record-only): daily wick % + 5d return.
      d1UpWickPct: v.optional(v.number()),
      d1R5Pct: v.optional(v.number()),
      // Daily StochRSI %K (2026-10-02): declared everywhere the d1 shadow tags
      // ride — its absence here cost the decision record 3 days (see the
      // logRejections note in strategyEngine.ts).
      d1StochK: v.optional(v.number()),
      // ── Execution record (2026-10-10, Stage 3 — RECORD-ONLY) ────────────
      // Same shape as paperTrades.exec: intended vs fill, liq level at entry,
      // decision→order latency, rejects/partials, stop trigger vs fill, and
      // realized R from the ACTUAL fill. Fail-open writer: executionRecord.ts.
      exec: v.optional(v.any()),
    })
      .index("by_status", ["status"])
      .index("by_status_entryTime", ["status", "entryTime"]) // closed list (desc)
      // CLOSES BY EXIT TIME (2026-10-22): the loss-streak breaker must read the
      // closes that happened LAST, not the rows whose entries are newest. A
      // position entered 20 entries ago but closed today is invisible to an
      // entry-ordered window — and it can be the close that completes a streak.
      .index("by_status_exitTime", ["status", "exitTime"])
      .index("by_coin_signalTime", ["coin", "signalTime"]), // entry dedupe key (same rule as paper)

    // ── Layer 2: Signal Log (every signal for audit trail) ──
    strategySignals: defineTable({
      pair: v.string(),
      side: v.string(), // "LONG" | "SHORT"
      entryPrice: v.number(),
      longScore: v.number(),
      shortScore: v.number(),
      reasons: v.array(v.string()),
      blockers: v.array(v.string()),
      emaFast: v.number(),
      emaSlow: v.number(),
      imbalance: v.number(),
      flowBias: v.number(),
      fundingRate: v.number(),
      spreadPct: v.number(),
      atrPct: v.number(),
      entered: v.boolean(), // whether a trade was actually opened
      timestamp: v.number(),
      // ── DECISION RECORD (2026-09-23) ────────────────────────────────────
      // Optional so every existing row stays valid. Set only on REJECTION
      // rows: a candidate the scan evaluated and did not take, written with
      // the same numeric vector as an entry row (entered: false).
      //
      // Why: before this the SCAN reduced each pair to a string before any
      // gate ran, so logVeto could only store zeros and every numeric input
      // of a rejected setup was destroyed. The only complete decision record
      // was therefore the trades we actually took — which is why every
      // candidate feature in this repo is confined to in-sample analysis, and
      // why 5+ entry filters have been judged on reconstructed proxies.
      signalBarClose: v.optional(v.number()), // closeTime of the signal 15m bar
      veto: v.optional(v.string()), // the gate that fired, in its own words
      // ── H4 SHADOW TAGS (2026-09-23, record-only forward test) ──
      // Written on entry AND rejection rows so the tags price against the
      // full decision surface (the trades we took AND the ones the gates
      // refused — see DECISION RECORD above).
      shadowTags: v.optional(v.array(v.string())),
      shadowH4RangePct: v.optional(v.number()),
      shadowH4VolLog2: v.optional(v.number()),
      shadowRsi7: v.optional(v.number()),
      // D1 shadow tags v3 (2026-09-26, record-only): daily wick % + 5d return.
      d1UpWickPct: v.optional(v.number()),
      d1R5Pct: v.optional(v.number()),
      // Daily StochRSI %K (2026-10-02): see the logRejections note — its
      // absence in the write surfaces killed the decision record for 3 days.
      d1StochK: v.optional(v.number()),
    }).index("by_timestamp", ["timestamp"]),

    // ── DOWN-BLOCK FORWARD TEST (2026-10-25) ──
    // One row per (pair, side, 4h bucket) that the BTC 4h DOWN-BLOCK refused —
    // the FIRST print in the bucket, which is the setup a trader could have
    // taken. Written by a capture cron from the strategySignals log (that log
    // stores entryPrice = 0 on rejection rows, so the price is recovered from
    // the klines at settle time), then settled once by a resolver cron against
    // the pre-registered bracket in lib/down-block-forward.ts (1.5% stop, 1R
    // target, 16-bar window, first touch, stop wins ties). RECORD ONLY: no
    // gate, threshold or entry reads this table.
    downBlockShadow: defineTable({
      key: v.string(), // `${pair}:${side}:${4hBucket}` — the dedupe key
      pair: v.string(),
      side: v.string(), // "LONG" | "SHORT"
      signalBarClose: v.number(), // closeTime of the 15m signal bar
      decisionAt: v.number(), // tick timestamp that printed the veto
      resolveAt: v.number(), // signalBarClose + 4h — earliest settle attempt
      status: v.string(), // "open" | "settled"
      shortScore: v.number(),
      longScore: v.number(),
      flowBias: v.number(),
      rsi7: v.optional(v.number()),
      btcSlopePct: v.optional(v.number()), // the 4h EMA75 slope at decision
      // FINE-TUNE AXES (2026-10-28, record-only). Copied from the regime cache at
      // capture, so the cut is fixed when the refusal happens and cannot drift
      // with a later re-read of the BTC series. Absent on rows captured before
      // this date; the card's cut table starts where they begin.
      btcRegimeRunBars: v.optional(v.number()), // bars into the down run (1 = flip bar)
      btcSlopeDeltaPct: v.optional(v.number()), // slope change vs the prior bar
      // ANTI-CHASE SPLIT (2026-10-26, record-only): the two readings that
      // separated winning from losing refused SHORTs in the 10-25 block.
      // Absent on rows captured before this date, which is why the split's
      // cohorts start later than the record itself (see down-block-forward.ts).
      emaSpreadPct: v.optional(v.number()), // (emaFast − emaSlow) / emaSlow × 100
      h4RangePct: v.optional(v.number()), // last closed 4h bar's range, % of price
      veto: v.string(), // the engine's own sentence
      entryPx: v.optional(v.number()), // signal-bar close, filled at settle
      result: v.optional(v.string()), // "stop" | "target" | "time" | "unresolved"
      r: v.optional(v.number()), // signed risk units at the 1.5% stop
      mfePct: v.optional(v.number()),
      maePct: v.optional(v.number()),
      markPct: v.optional(v.number()),
      settlePx: v.optional(v.number()),
      barsUsed: v.optional(v.number()),
      settledAt: v.optional(v.number()),
      attempts: v.number(), // settle attempts; 6 unreadable rows are closed as unresolved
    })
      .index("by_key", ["key"])
      .index("by_decisionAt", ["decisionAt"])
      .index("by_status_resolveAt", ["status", "resolveAt"]),

    // ── PROXY SIGNAL MONITOR (2026-09-14) ──
    // One row per (pair, side, 15m signal bar) the proxy scanner evaluated,
    // with the full verdict chain: which gate passed it, which one vetoed it
    // and the gate's own words. Written by proxyTick only; read by the Signal
    // Monitor panel; pruned to 48h on every scan so the table stays bounded.
    proxyScanDiagnostics: defineTable({
      pair: v.string(),
      side: v.string(), // "LONG" | "SHORT"
      signalBarClose: v.number(), // closeTime of the signal 15m bar
      histPrev: v.number(),
      histCur: v.number(),
      status: v.string(), // "ENTERED" | "BLOCKED" | "STALE" | "DEDUPE" | "SKIP"
      vetoStage: v.optional(v.string()), // advisor4h | advisor1h | tightAtr | ema75 | btcRegime | allowSide | session
      vetoReason: v.optional(v.string()), // the gate's own words
      gateChecks: v.optional(
        v.array(
          v.object({
            gate: v.string(),
            result: v.string(), // "pass" | "veto" | "off"
            detail: v.optional(v.string()),
          }),
        ),
      ),
      scannedAt: v.number(),
    })
      .index("by_scannedAt", ["scannedAt"])
      .index("by_signal", ["pair", "side", "signalBarClose"]),

    // ── HTF ADVISOR (2026-09-08) ──
    // One batched doc per advisor run (mirrors layer1Ticks): the 4H
    // divergence / volume-exhaustion verdict for every tracked pair,
    // computed by convex/advisor.ts from fresh MEXC 4H klines. strategyTick
    // reads the newest doc ONCE per run and vetoes sides whose advisor votes
    // >= advisorVetoThreshold. The UI reads the same doc for the Advisor
    // panel readout. Rows are pruned on insert (keep <48h), like layer1Ticks.
    advisorTicks: defineTable({
      timestamp: v.number(), // wall-clock ms of the advisor run
      interval: v.optional(v.string()), // "4h" | "1h" (unset = legacy 4h row)
      metrics: v.record(
        v.string(),
        v.object({
          price: v.number(), // last CLOSED 4H close
          barTime: v.number(), // closeTime of that bar
          rsi: v.number(),
          stochD: v.optional(v.number()), // StochRSI %D when the stoch path is on
          stochK: v.optional(v.number()), // StochRSI %K
          cmf: v.number(),
          vwapDistPct: v.number(),
          rsiBear: v.boolean(),
          rsiBull: v.boolean(),
          obvBear: v.boolean(),
          obvBull: v.boolean(),
          adBear: v.boolean(),
          adBull: v.boolean(),
          cmfBear: v.boolean(),
          cmfBull: v.boolean(),
          vwapExhaustLong: v.boolean(),
          vwapExhaustShort: v.boolean(),
          thinZoneLong: v.boolean(),
          thinZoneShort: v.boolean(),
          longStatus: v.string(), // "veto" | "ok"
          longVotes: v.number(),
          shortStatus: v.string(),
          shortVotes: v.number(),
          longReasons: v.array(v.string()),
          shortReasons: v.array(v.string()),
          // BTC-only regime read (2026-09-08): 1H EMA20-slope percentile
          // classification (up/down/chop) + 1h % change, computed once per
          // advisor tick from a single extra BTC 1H fetch. Filled only on the
          // BTC row; other pairs leave these unset. The frontend reads this
          // for the Advanced Data BTC behavior card — no per-render I/O.
          btcRegime: v.optional(v.string()),
          btcChange1h: v.optional(v.number()),
        }),
      ),
    })
      .index("by_timestamp", ["timestamp"])
      // 2026-09-16 (Database I/O audit): the #1 I/O consumer was
      // getAdvisorState, which served a per-interval verdict by scanning
      // `by_timestamp` newest-first and filtering `interval` in JS — reading
      // up to 4 large (multi-pair) docs to find the 1 matching row, on every
      // entry tick of all three books plus the UI subscriptions. The compound
      // index makes "newest doc of MY interval" a single-document read.
      // `interval` is written explicitly on every insert (recordAdvisorTick
      // defaults it to "4h"), so no live row is missing from this index; the
      // reader keeps a scan fallback for pre-2026-09-12 legacy rows only.
      .index("by_interval_timestamp", ["interval", "timestamp"]),

    // ── BTC ADVISOR HISTORY (2026-09-08) ──
    // Per-4H-bar advisor readings for BTC ONLY — the charting data behind the
    // Advanced Data BTC line chart. Backfilled ONCE (90 days of 4H bars,
    // replaying the exact evaluateAdvisor detector over each closed bar), then
    // kept current by the advisor tick (one row per 4H close, upserted and
    // pruned past 90 days). The chart path never writes: getBtcChartData
    // fetches BTC 1H klines on demand (1 MEXC call per view) and reads this
    // table for the advisor overlay — zero recurring market I/O.
    btcAdvisorHistory: defineTable({
      barTime: v.number(), // 4H bar closeTime — the bar this reading is for
      price: v.number(),
      rsi: v.number(),
      cmf: v.number(),
      vwapDistPct: v.number(),
      rsiBear: v.boolean(),
      rsiBull: v.boolean(),
      obvBear: v.boolean(),
      obvBull: v.boolean(),
      adBear: v.boolean(),
      adBull: v.boolean(),
      cmfBear: v.boolean(),
      cmfBull: v.boolean(),
      vwapExhaustLong: v.boolean(),
      vwapExhaustShort: v.boolean(),
      thinZoneLong: v.boolean(),
      thinZoneShort: v.boolean(),
      longStatus: v.string(), // "veto" | "ok"
      longVotes: v.number(),
      shortStatus: v.string(),
      shortVotes: v.number(),
      longReasons: v.array(v.string()),
      shortReasons: v.array(v.string()),
    }).index("by_barTime", ["barTime"]),

    // ── AUDIT FIX (2026-09-11): ledger archive before destructive purge ──
    // purgeLiveLedger used to DELETE the entire real-money ledger with no
    // copy anywhere. One mis-click destroyed the only record of what the bot
    // actually did. Every purge now writes the full ledger (plus the stats
    // doc) into ONE archive row first, so history is recoverable.
    liveLedgerArchive: defineTable({
      purgedAt: v.number(),
      reason: v.optional(v.string()),
      tradeCount: v.number(),
      trades: v.array(v.any()), // raw liveTrades rows as they were
      stats: v.optional(v.any()), // liveStats doc at purge time
    }).index("by_purgedAt", ["purgedAt"]),

    // ── KLINE ARCHIVE (2026-09-12) ──
    // Server-side kline dataset for backtests: one row per bar, kept current
    // by the kline-sync cron (15m bar-aligned) and backfillable to
    // KLINE_SYNC_START_MS via klines.startKlineBackfill. Labs never re-fetch
    // MEXC history — the pull CLI (cache:pull) dumps this table into
    // data/klines/ in the local-cache columnar format. Permanent by design:
    // NOT pruned by cleanup.ts (unlike layer1Ticks/signals).
    klineBars: defineTable({
      pair: v.string(), // "SOL", "BTC", … (tracked-pairs keys)
      interval: v.string(), // "15m" | "1h" | "4h"
      openTime: v.number(), // bar open, ms epoch — the bar's identity
      open: v.number(),
      high: v.number(),
      low: v.number(),
      close: v.number(),
      volume: v.number(),
      closeTime: v.number(), // openTime + interval (closed bars only, always)
    }).index("by_pair_interval_time", ["pair", "interval", "openTime"]),

    // Sync bookkeeping — EXACTLY ONE doc (name="main"). Drives the Mining
    // Window readout (phase, newest bar age) without any aggregate scan of
    // klineBars (380k+ rows — aggregating per render was never an option).
    klineSyncState: defineTable({
      name: v.string(), // "main"
      phase: v.optional(v.string()), // "idle" | "backfill"
      backfillDone: v.optional(v.number()), // pairs fully synced so far
      backfillTotal: v.optional(v.number()),
      lastTailRunAt: v.optional(v.number()),
      lastTailInserted: v.optional(v.number()),
      lastTailError: v.optional(v.string()),
      perIntervalNewest: v.optional(v.record(v.string(), v.number())), // interval → newest openTime
    }).index("by_name", ["name"]),

    // ── PAPER LEDGER ARCHIVE (2026-09-12) — the paper twin of the doc above,
    // added when the paper book was reset to open a clean data-collection
    // window under new gates. Same audit rule as live: archive BEFORE delete,
    // so the reset is recoverable and the previous configuration's record is
    // not destroyed.
    // CHUNKED, unlike the live archive: a paper book runs to hundreds of rows
    // (405 at the 2026-09-12 reset), and one document holding the whole ledger
    // can approach Convex's per-document size limit. Parts share a batchId so
    // the original ledger reassembles by (batchId, part).
    paperLedgerArchive: defineTable({
      purgedAt: v.number(),
      batchId: v.string(), // groups the parts of one reset
      part: v.number(), // 0-based part index
      partCount: v.number(), // total parts in this reset
      reason: v.optional(v.string()),
      book: v.string(), // "layer2" | "all"
      tradeCount: v.number(), // rows in the WHOLE reset, not this part
      trades: v.array(v.any()), // the raw paperTrades rows of this part
      stats: v.optional(v.any()), // bookStats docs at reset time (part 0 only)
    }).index("by_purgedAt", ["purgedAt"]),

    // ── ENGINE HEARTBEAT (2026-09-21) — dead-man's switch over the cron grid.
    // One row per registered cron, upserted at the TOP of each tick, so the
    // panel can tell "this job stopped firing" from "this job ran and had
    // nothing to do". Every entry gate in the stack fails OPEN on missing
    // input; this is what makes a stalled gate visible instead of silent.
    // See src/lib/heartbeat.ts for the thresholds and the reasoning.
    // ── LIVE BREAKER EVENT LOG (2026-10-23) — durable record of every TRIP and
    // RELEASE of the loss-streak breaker. The breaker's state lives on the
    // liveAccount doc (overwritten in place) and the human-readable line lives
    // in lastScanResult (a single string, replaced on the next tick), so
    // without this table a release could not be reviewed once trading resumed.
    // Only TRANSITIONS are recorded — never the per-tick veto — so the table
    // grows by a few rows a month and needs no pruning.
    liveBreakerEvents: defineTable({
      at: v.number(), // when the transition was written, ms epoch
      kind: v.string(), // "trip" | "release"
      trigger: v.string(), // "loss-streak" | "next-session"
      reason: v.string(), // the exact line the operator sees in the scan summary
      lossStreak: v.number(), // consecutive losses at the moment of the event
      // Session evidence — release rows only: which session was judged, what it
      // closed at, and how long the book had been disarmed.
      session: v.optional(v.string()),
      sessionStart: v.optional(v.number()),
      sessionEnd: v.optional(v.number()),
      closes: v.optional(v.number()),
      netR: v.optional(v.number()),
      minCloses: v.optional(v.number()),
      disarmedForMs: v.optional(v.number()),
    }).index("by_at", ["at"]),

    cronHeartbeats: defineTable({
      job: v.string(), // the crons.cron(...) job name
      lastRunAt: v.number(), // when that tick last STARTED, ms epoch
      runs: v.number(), // total starts seen since the table was created
      // Wall-clock of the most recent COMPLETED run, for the jobs that stamp
      // it (2026-10-28: initially the Layer 1 tick). Optional on purpose: a job
      // that does not report one, and every row written before this field
      // existed, simply has no duration — never a 0 that reads as "instant".
      lastDurationMs: v.optional(v.number()),
    }).index("by_job", ["job"]),
  },
  {
    schemaValidation: false,
  },
);

export default schema;
