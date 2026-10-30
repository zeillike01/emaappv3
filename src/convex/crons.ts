/**
 * Convex cron jobs.
 *
 * Intervals (re-optimized 2026-09-14 — the "staggered grid"):
 *   - layer1-market-data: 15 min at :00/:15/:30/:45 (was 5 min; cut 2026-09-22
 *     — every entry minute is exactly 3 min past a 15m boundary, so an entry
 *     reads the SAME doc at the SAME age in both grids and the :05/:10/… ticks
 *     were documents no entry ever read. See the CRON AUDIT note below)
 *   - advisor-htf: 4H bar-aligned :01 of 00/04/08/12/16/20 UTC (unchanged)
 *   - advisor-1h: hourly :02 — AFTER the 4H tick, BEFORE the entry cluster
 *   - ENTRY CLUSTER :03/:18/:33/:48 — layer2-strategy + proxy-entry +
 *     live-entry share the minute ON PURPOSE (same closed bar), but the
 *     whole cluster moved :01 → :03 so the 4H/1H advisor docs are always
 *     fresh at entry time. Previously the 4H advisor and the entries raced
 *     on :01: a boundary-hour scan could finish before the advisor wrote
 *     and gate on a 4-hour-old doc.
 *   - layer2-exit-tick: 5 min (UNCHANGED — it is the paper book's ONLY exit
 *     path, so cadence IS fill fidelity for its SL/TP; its per-pair ticker
 *     polling collapsed to ONE batched universe fetch per tick 2026-09-16,
 *     see resolveLayer2Exits)
 *   - proxy-exit-tick: 15m bar-aligned :08/:23/:38/:53 (was 5 min — pure
 *     waste: resolveProxyExit walks CLOSED bars, so the booked exit price,
 *     time, and MFE/MAE are identical at any check cadence; 8,640 → 2,880
 *     invocations/month for zero behavioral change)
 *   - live-exit: same :03 cluster as live-entry (bracket backstop)
 *   - scalper-tick: DISABLED (paused)
 *
 * Removed: meanrev, ravs, session-spike, volume-spike, fibonacci (2026-09)
 *
 * ── HTF CACHE (2026-09-16) — the biggest avoidable MEXC load ──
 * Both entry ticks re-fetched their HTF series per pair on EVERY 15m fire:
 * proxy's 4h EMA75 (240 bars) and layer2's 4h/1h gate (240/60 bars). The
 * verdict depends only on the newest CLOSED bar of that timeframe, so at 31
 * pairs × 96 ticks that was ~2,976 requests/day/book for values that change
 * 6×/day (4h) or 24×/day (1h) — ≈167K wasted requests/month across both
 * books (default 4h gates), and it scaled up 24% with the 2026-09-15/16
 * universe adds. convex/htfCache.ts now stores the fetched values keyed by
 * the bar they came from; engines use the entry while it is current for the
 * timeframe and otherwise fetch exactly as before. Bar-guarded, so worst
 * case = the old behavior; see the module header for the contract.
 *
 * ── BTC REGIME CACHE (2026-09-16) — the last big avoidable per-tick fetch ──
 * All THREE entry engines (layer2, proxy, live) classify BTC's macro regime
 * from the same 4h EMA75 slope, and each re-fetched 240×4h bars on EVERY 15m
 * tick: 3 books × 96 ticks = ~288 requests/day for a verdict that only changes
 * when a 4h bar closes (6×/day) — ~186 wasted, the largest remaining line
 * after the HTF cache below. convex/btcRegimeCache.ts now holds the verdict
 * for the newest CLOSED 4h bar; every engine reads it while that bar is
 * current and otherwise fetches exactly as before (bar-guarded, worst case =
 * old behavior). Same file also closed two smaller loops on the LIVE book:
 * its HTF gate now reads the same htfCache the paper/proxy books use (it was
 * still fetching the HTF series per pair per tick — ~2,976 requests/day while
 * the live bot is armed), and live-exit's per-position ticker fetch collapsed
 * to ONE batched universe request, mirroring resolveLayer2Exits.
 *
 * BTC REGIME LAG — FIXED 2026-09-16 (was: audit note, not changed).
 * btcRegimeFromKlines reads `kl.length - 2` because its contract is "the last
 * element is the forming bar". The three labs honour that (`slice(0, i + 2)`,
 * so their verdict for bar i uses bars <= i — the newest closed bar at that
 * moment). The LIVE path did not: it passed fetchKlines output, which already
 * drops the forming candle, so it classified the bar BEFORE the newest closed
 * one — a permanent 4h lag the labs never had. The wired blocked-cohort stats
 * therefore described a verdict the engine was not computing. Live now routes
 * through padFormingBar (btc-regime.ts), restoring agreement with the labs.
 * No lab re-run needed: the labs' indexing is unchanged, so their numbers
 * stand and the shipped gate now matches them.
 *
 * ── UNIVERSE (drives every per-pair cost) ──
 * 20 pairs → 25 (2026-09-11) → 31 (mid-Sep, while the six non-crypto perps
 * were listed) → 40 (2026-10-21 PUMP/VIRTUAL twins) → **34 (2026-10-26: six
 * laggards deleted — INJ, DOT, APT, TAO, DASH, WLD; see the header note in
 * tracked-pairs.ts for the evidence)**. The six non-crypto perps
 * were DELETED from the universe on 2026-09-26 (see tracked-pairs.ts), so no
 * cron fetches them. Every per-pair line below is quoted AT 31 PAIRS from the
 * 2026-09-22 audit — scale its per-pair terms by the current count /31 for
 * today's list (the batched ticker and fixed per-tick costs do not scale), or
 * re-derive before re-tuning cadences.
 *
 * NO REGISTRATION BELOW NAMES A COIN. Every per-pair job (layer1-market-data,
 * layer2-strategy, live-entry, the advisors, the down-block capture) iterates
 * `LAYER1_PAIRS` at runtime, so a pair is added or removed in exactly one
 * place and the crons follow with no edit here — including the per-coin list
 * the "Run now" buttons use. The 40-pair cost quotes below are therefore an
 * UPPER BOUND at today's 34 pairs.
 *
 * Free tier: 1M calls/month. Per-pair MEXC load is the number that actually
 * matters. At 31 pairs: L1 ≈ 31 × 3 + 1 batched ≈ 94 requests/tick — 27,072/
 * day at the old 5-min grid (≈ 812K/month, ~81% of quota), 9,024/day at the
 * 15-min grid (≈ 271K, ~27%). Proxy entries ≈ 31 × 96 kline fetches/day minus
 * the HTF saving above (it already skips pairs with an open position /
 * cooldown / blocklist BEFORE fetching, and returns before any fetch at all
 * when the book is disabled). Convex function calls are the cheaper meter:
 * the grid totals ~1,467 invocations/day ≈ 44K/month.
 *
 * I/O: exit tick slowed from 2 min → 5 min (2026-09) because re-reading
 * ~25 open trades every 2 min was ~650MB/month of Database I/O — the single
 * biggest line on the free-tier meter. 5-min checks still resolve exits on
 * the same 15m-bar logic.
 *
 * ── 2026-09-22 CRON AUDIT (all 13 jobs, heartbeats + registration checked) ──
 * Every registered cadence was verified against its own cronHeartbeats row and
 * every one matched exactly (layer1 533 runs/44.3h = 12.0/h; the three 15m
 * ticks 178/44.3h = 4.0/h; 1h advisor 45/44h; 4h advisor 11/40h). The grid was
 * NOT drifting — so the audit was about COST, not correctness.
 *
 * Ranked by MEXC calls/month (31 pairs, the meter that binds):
 *   1. layer1-market-data      94/tick × 288 = 27,072/day  ≈ 812K  ← ~81% of quota
 *   2. proxy-entry-tick        31/tick ×  96 =  2,976/day  ≈  89K
 *   3. proxy-exit-tick         (bar-walking) × 96           ≈  89K
 *   4. advisor-1h-tick         31/tick ×  24 =    744/day  ≈  22K
 *   5. advisor-htf-tick        31/tick ×   6 =    186/day  ≈   6K
 *   6. everything else         batched / none               ≈  small
 *
 * Changes made:
 *   - layer1-market-data 5m → 15m bar-aligned: −541K/month (the only cut with
 *     a non-marginal payoff; see the note at the registration).
 *
 * Examined and deliberately NOT changed:
 *   - proxy-entry/exit-tick while the proxy book is disabled: proxyTick returns
 *     "disabled" at account.enabled === false BEFORE any per-pair fetch, so a
 *     stopped book already costs ~3 DB ops per fire and no MEXC call.
 *   - live-entry / live-exit / live-rlock-tick while the live bot is disabled:
 *     all three early-return before any price or private-API call (live-rlock
 *     returns on `armed.length === 0`, which is every run with no open
 *     position). They keep firing so the dead-man's switch stays honest — a
 *     heartbeat that only ticks while a book is armed cannot tell you the grid
 *     is alive at the moment you re-arm it. Cost is one heartbeat write each.
 *   - layer2-exit-tick at 5 min: it polls the live ticker, so cadence IS fill
 *     fidelity for a market close on a breached rung. (The STOP path no longer
 *     depends on it — it is bar-detected as of the same date — but the rung
 *     fill and the fixed TP still do.)
 *   - the three daily cleanup crons: merging them into one 24h job would save 2
 *     invocations/day. Not worth the diff.
 *   - advisor-htf-tick at 6/day and advisor-1h-tick at 24/day: already the
 *     minimum for their bars, and advisorTick already no-ops when no book has
 *     advisor1hEnabled on.
 *
 * ── 2026-10-22 CRON TRIM (live book only, no cadence changed) ──
 * The cost model above is quoted at 31 pairs; the universe is 40 since
 * 2026-10-21, and the ranked list omits both entry books' per-pair 15m fetch.
 * Re-derived at 40 pairs (measured against the deployed grid, 2026-10-22):
 *   layer1-market-data  121/tick ×  96 = 11,616/day   ← 61% of the total
 *   layer2-strategy     ≤40/tick ×  96 = ≤3,840/day   (paper, the sensor; it already
 *                       skips open-position/cooldown pairs BEFORE the fetch — 21
 *                       of 40 pairs evaluated on 2026-10-22, so ~2.0K/day actual)
 *   live-entry           36/tick ×  96 =  3,456/day   (40 minus the coin-priority avoid tier)
 *   exits + advisors     batched       ≈ 1,100/day
 *   ≈ 18-20K requests/day ≈ 550-600K/month ≈ 55-60% of the 1M free tier.
 *
 * Two live-only cuts, both in the same shape as the disabled-book and
 * coin-priority pre-fetch vetoes — PROVE no candidate can pass, then don't pay:
 *   1. SESSION PRISON (liveBrokerRuntime.liveEntryTick, sessionScanVerdict):
 *      when BOTH sides are impossible in the session of the bar being scored
 *      (blocked bucket, disabled side, or an allowlist that excludes it), the
 *      tick returns before the scan instead of fetching ~36 klines to refuse
 *      all of them. Measured today: `london` blocked on both sides = 23 of 96
 *      ticks/day ≈ −830 klines/day. It also spares those ticks' private-API
 *      balance/position reads. Requires the PREVIOUS bar's session to be a
 *      prison too, so a one-bar-lagged feed can never lose an entry.
 *   2. OPEN-POSITION LOCK, PRE-FETCH (processPairLive): the lock sat after the
 *      15m/5m/price/meta reads, so every held coin cost up to 4 requests per
 *      tick to be refused (7 held today ≈ −510/day). Paper has done this since
 *      2026-09-09; live now matches. Trade-off is paper's: the entered:false
 *      signal-log row for a locked coin is no longer written.
 *   Total ≈ −1,340 requests/day ≈ −40K/month, ~7% of the live book's own load.
 * PAPER IS DELIBERATELY UNTOUCHED: it is the measuring instrument, and a
 * session it stops sampling is a session no gate can ever be re-validated on.
 *
 * Also corrected here: advisor-1h-tick fires 24×/day, but BOTH config rows
 * have advisor1hEnabled = false, so advisorTick returns before any kline fetch
 * (advisor.ts, the two-config guard). Its cost is 24 invocations and zero MEXC
 * — the note at that registration says "it is on", which stopped being true.
 *
 * ── CRON GATE ──
 * Paper + live engines run on THIS deployment, which must set CRONS_ENABLED=1.
 * Unset (the fresh-deployment default) means the grid is registered but inert. The gate registers crons ONLY where
 * CRONS_ENABLED == "1", so a stale deployment that happens to receive a push
 * can't run its own engine in parallel.
 */
import { cronJobs } from "convex/server";
import { api } from "./_generated/api";
import { internal } from "./_generated/api";

const CRONS_ENABLED = process.env.CRONS_ENABLED === "1";

const crons = cronJobs();

if (CRONS_ENABLED) {
  // ── TWO-LAYER STRATEGY ENGINE ──
  // Layer 1: Market Data Engine — fetches MEXC data, computes fast metrics
  // Layer 2: Strategy Engine — reads metrics, scores, qualifies signals
  //
  // Layer 1 at 15 min, BAR-ALIGNED to :00/:15/:30/:45 (was 5 min, 2026-09-22).
  //
  // WHY THE 5-MINUTE GRID WAS FREE TO CUT. The entry cluster sits at
  // :03/:18/:33/:48 — every one of those is EXACTLY 3 minutes past a 15m
  // boundary, which is also a 5m boundary. The strategy tick reads the NEWEST
  // layer1Ticks doc, so the doc it reads is the :00/:15/:30/:45 one in BOTH
  // grids, at the same 3-minute age. The :05/:10/:20/:25/:35/:40/:50/:55 ticks
  // therefore produced documents that NO ENTRY EVER READS — they fed only a
  // display-only field (since deleted), never a gate, score term or journal.
  //
  // The freshness guarantee is unchanged, not relaxed: ≤3-min-old snapshot at
  // every entry minute, in both grids. What DOES change is the margin against a
  // LATE entry tick — a tick starting N minutes late reads a doc N minutes
  // older, and on this grid it ages 3x faster. That is the whole trade-off, and
  // it is the reason this is the only cadence cut taken here.
  //
  // COST: 31 pairs × 3 requests (depth + trades + 1m klines) + 1 batched
  // universe request = 94 requests/tick. 288 → 96 ticks/day is 27,072 → 9,024
  // requests/day, i.e. ~812K → ~271K per month: a 541K/month cut against a 1M
  // free tier, from ~81% of the quota to ~27%.
  //
  crons.cron(
    "layer1-market-data",
    "0,15,30,45 * * * *",
    api.marketDataNode.marketDataTick,
    // `cron: true` = "this invocation came from the scheduler". These three
    // actions are also reachable from the panel's "Run now", and the heartbeat
    // only accepts the flag so a manual run can never stand in for a live cron
    // (see src/lib/heartbeat.ts).
    { cron: true },
  );

  // 2026-09-07 (Option A): the interval anchor drifted ~7 min past the 15m
  // candle grid, so live entries fired ~7 min after the signal bar closed
  // (paper was faster by luck of its own anchor). Bar-aligned unix cron: fire
  // a few minutes after each 15m close (:00/:15/:30/:45 UTC). 2026-09-14:
  // moved :01 → :03 so the 4H/1H advisor ticks (:01/:02) always finish
  // before the entry cluster — boundary-hour scans gated on a stale 4H doc
  // before the re-grid. The extra 2 min of bar age is inside every book's
  // signal-age and drift guards (0.5% max drift), and MEXC needs a few
  // seconds anyway — a scan at the exact close would read the PREVIOUS bar,
  // dedupe the signal, and skip until the next fire (15 min late).
  crons.cron(
    "layer2-strategy",
    "3,18,33,48 * * * *",
    api.strategyEngine.strategyTick,
    { cron: true },
  );

  // Layer 2 Exit Scanner — checks SL/TP for all open Layer 2 trades every 5 min
  // strategyTick enters; this exits. Prices now come from ONE batched universe
  // request (fetchAllTickers) instead of one per-pair ticker per open pair
  // (2026-09-16) — see resolveLayer2Exits for the fallback semantics. Separate cron so exits resolve faster.
  //
  // R-LOCK (2026-09-20): this now fires api.rLockExit.layer2ExitTick, which
  // advances the trailing lock on armed trades and then calls
  // resolveLayer2Exits itself — so the SL/TP logic below is unchanged, it just
  // runs AFTER the lock has had the chance to bank a rung. It must run first:
  // a fixed TP would otherwise close a winner the lock wants to keep alive.
  // Cadence unchanged at 5 min, which matters here (the ticker poll IS fill
  // fidelity for a market close on a breached rung).
  // PHASE (2026-09-27, user-requested book parity): moved from a deploy-anchored
  // interval to the SAME minute grid as live's r-lock pass (:02/:07/…) so both
  // books sample their locks in the same market minute. Removes the up-to-5-min
  // poll phase offset that made paper vs live exit times diverge on identical
  // trades (AVAX 09-27: paper 07:47 vs live 08:03). :02/:07 sits clear of the
  // :03/:18/:33/:48 entry slots and of live-rlock's own slot separation rules.
  crons.cron(
    "layer2-exit-tick",
    "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
    api.rLockExit.layer2ExitTick,
    {},
  );

  // ── SESSION PROFITABILITY BREAKER (2026-10-20) ──
  // TWICE DAILY at 00:20 and 12:20 UTC. The paper ledger is bucketed by
  // (session, side) and the snapshot is what the LIVE entry path reads; the
  // paper book itself is never blocked (it is the sensor that keeps producing
  // the evidence). :20 sits after the :15 Layer 1 tick and clear of the
  // :03/:18/:33/:48 entry cluster. A missed fire degrades to a per-tick
  // recompute in readSessionBreakerBlocked, never to a blind gate — which is
  // also why this is an action: the heartbeat recorder is an internal mutation
  // and the stamp must mean "the scheduler fired".
  crons.cron(
    "session-breaker-refresh",
    "20 0,12 * * *",
    internal.strategyEngine.sessionBreakerRefreshTick,
    { cron: true },
  );

  // ── COIN PRIORITY MONITOR (2026-10-21) ──
  // ONCE A DAY at 00:40 UTC, 20 min after the session snapshot so both read
  // the same freshly-pruned ledger. Recomputes the per-coin ranking the LIVE
  // entry scan orders by, persists the day's row (the monitor's history), and
  // deletes snapshot rows older than the 14-day lookback — the retention the
  // ranking's window promises. It also runs the ledger prune, so expired paper
  // closes leave daily even if the session refresh changes cadence later.
  crons.cron(
    "coin-priority-refresh",
    "40 0 * * *",
    internal.strategyEngine.coinPriorityRefreshTick,
    { cron: true },
  );

  // ── DOWN-BLOCK FORWARD TEST (2026-10-25) ──
  // RECORD ONLY. The BTC 4h DOWN-BLOCK refuses both sides in a down regime on
  // a historical cohort; these two jobs price that decision FORWARD so the
  // gate can be judged on setups it never saw.
  //   · capture :05/:20/:35/:50 — two minutes behind the :03 entry cluster, so
  //     the rows are already written. Zero MEXC calls. It reads ONE doc and
  //     returns while the BTC regime is not down (measured 2026-10-25: that is
  //     most of the day, and re-scanning the signal window on those ticks was
  //     ~64k doc reads/day for a window that cannot hold a print). In a down
  //     regime it does one bounded signal read plus one exact dedupe read, and
  //     skips the dedupe read at all when the tick printed no refusal. The
  //     FIRST print per (pair, side, 4h bucket) is the record; the 4h lookback
  //     only matters on the flip into a down regime, and a capture outage
  //     longer than that loses those prints — liveness is part of the record.
  //   · resolve :11 hourly — resolution walks CLOSED bars, so the outcome is
  //     identical at any cadence; due rows arrive in one burst per 4h bucket
  //     (~30 pairs) with none between, so hourly costs ~30 fetches around each
  //     boundary instead of parking a MEXC read on every entry tick.
  //     :11 is chosen because :08 belongs to proxy-exit and :03/:18/:33/:48 to
  //     the entry cluster: this job must never share a minute with a MEXC-heavy
  //     tick it would then compete with for rate-limit headroom.
  // Both jobs beat a heartbeat row (src/lib/heartbeat.ts) — capture through the
  // thin cron wrapper, because a mutation cannot record one itself. A stalled
  // capture and a quiet tape look identical on the card, so the dead-man's
  // switch is the only thing that tells them apart.
  // Nothing in the trading path reads the table (see convex/downBlockShadow.ts).
  // DISABLED (fresh deployment, 2026-10-30): the reference branch registers
  // these two jobs against internal.downBlockShadow.*, but that module was
  // never committed upstream (absent from HEAD, all 40 branches and all 356
  // commits of the reference branch). Convex validates cron targets at deploy
  // time, so leaving them registered fails the deployment outright.
  //
  // RECORD-ONLY, so disabling changes NO gate: the reference's own comment on
  // this block says "Nothing in the trading path reads the table".
  // Re-enable by restoring src/convex/downBlockShadow.ts from the author's
  // working copy.
  //
  // crons.cron("down-block-shadow-capture", "5,20,35,50 * * * *",
  //   internal.downBlockShadow.captureDownBlockCron, {});
  // crons.cron("down-block-shadow-resolve", "11 * * * *",
  //   internal.downBlockShadow.resolveDownBlockShadow, {});

  // ── HTF ADVISOR (2026-09-08) ──
  // 4H divergence / volume-exhaustion layer read by strategyTick. Bar-
  // ALIGNED to the 4H close (1 min after 00/04/08/12/16/20 UTC) — every
  // input is a CLOSED 4H bar, so running more often would recompute
  // identical results (an hourly cron re-fetched all 20 pairs 3x per bar
  // for nothing). 6 runs/day = 4x fewer MEXC fetches and doc writes vs the
  // original 60-min cadence. A 30-min dedupe guard in advisorTick also
  // makes the panel's manual "Run now" a zero-fetch no-op right after a
  // cron fire. The strategy tick reads the newest batched doc per run (zero
  // extra per-entry MEXC calls). Docs pruned to <48h on insert.
  crons.cron(
    "advisor-htf-tick",
    "1 0,4,8,12,16,20 * * *",
    api.advisor.advisorTick,
    { cron: true },
  );

  // ── 1H ADVISOR (2026-09-12) ──
  // The SAME detector on 1H bars (pass { interval: "1h" }): fires hourly at
  // :02 — after the 4H tick (:01, which it must never race for MEXC headroom
  // in the shared boundary hours) and BEFORE the :03 entry cluster, so
  // entries always read the CURRENT hour's verdict. Writes to the same
  // advisorTicks table with interval="1h"; getAdvisorState filters per
  // interval, and strategyTick/liveBroker only read the 1H doc when the
  // book's advisor1hEnabled is on. 30-min dedupe guard in advisorTick makes
  // a manual "Run now" right after the cron a no-op.
  crons.cron("advisor-1h-tick", "2 * * * *", api.advisor.advisorTick, {
    interval: "1h",
    cron: true,
  });

  // ── SHORT BOOK — DELETED 2026-10-29 ──
  // The short book is GONE: modules (src/lib/short-entry/, convex/shortEntry.ts,
  // shortTakerVolume.ts, shortTakerVolumeStore.ts), its tables, its panel, its
  // paperAccount queries and the four relay actions only it used. Its three
  // registrations (short-taker-volume, short-entry-4h, short-entry-15m) were
  // removed on 2026-10-22. Nothing below may reintroduce them; restoring the
  // book means restoring the files from git.

  // ── LIVE MEXC ENGINE (separate page/route, same Layer 2 auto-bot) ──
  // Entries mirror paper layer2-strategy (15m cadence, identical scoring
  // inputs, same :03 cluster — advisor docs fresh); exits mirror the entry
  // cadence. Both early-return cheaply when the live bot is stopped or creds
  // are absent — the tick body gates itself on liveAccount.enabled before
  // any private API call.
  // Durable MEXC intent recovery is independent of market cadence. It runs
  // every five minutes so a lost entry/close response is reconciled promptly;
  // the sensitive entry/exit/r-lock schedules below are unchanged.
  crons.cron(
    "live-intent-reconcile",
    "*/5 * * * *",
    internal.liveReconcile.reconcileLiveIntents,
    {},
  );

  //
  // DOWN-BLOCK SKIP (2026-10-28): in a "down" regime with the block on, no side
  // of no pair can enter, so the tick returns before the exchange balance read
  // and before the per-pair scan (liveBrokerRuntime.liveEntryTick). PAPER keeps
  // scanning on purpose — it is the sensor the block's forward record is cut
  // from (downBlockShadow reads the paper rejections).
  crons.cron(
    "live-entry",
    "3,18,33,48 * * * *",
    internal.cronWrappers.liveEntryCron,
    {},
  );
  // live-exit (2026-09-09): 5 min → 15m BAR-ALIGNED (same slot as entries,
  // moved to the :03 cluster on 2026-09-14). Safe because the SL/TP brackets
  // are attached ON the exchange — this tick is the backstop (bracket-failure
  // recovery + ledger settlement), not the primary protection, so checking at
  // each 15m close cuts its reads 3x (288 → 96/day) with zero additional
  // risk. Paper's layer2 exit tick stays at 5 min: it has NO exchange
  // bracket, so it is the primary exit path there.
  //
  // R-LOCK (2026-09-20): note this tick is NOT what banks the trailing rungs
  // — that is live-rlock-tick below, on a 5-minute cadence. This one keeps its
  // job unchanged: brackets, settlement, "position vanished" reconciliation.
  // Heartbeat (2026-09-21): registered through the wrapper rather than
  // the exit worker directly, so the liveness stamp is a property of
  // the CRON instead of a line inside a long handler with several early
  // returns. The wrapper calls the tick unchanged. See convex/heartbeat.ts.
  crons.cron(
    "live-exit",
    "3,18,33,48 * * * *",
    internal.cronWrappers.liveExitCron,
    {},
  );

  // ── LIVE R-LOCK (2026-09-20) ──
  // Advances the live book's stepped trailing exit and market-closes a
  // breached rung. Deliberately NOT folded into live-exit: the r-lock's edge
  // assumes an exit AT the rung, and since the close is a MARKET order the
  // fill gets worse the longer the poll interval — so it gets 5 min while the
  // bracket tick keeps its cheaper 15.
  //
  // The :02/:07/… phase is chosen so a lock run never lands on the
  // :03/:18/:33/:48 entry/exit slot. That matters: the lock writes its close
  // to the ledger inside the same run, so separating the slots guarantees the
  // bracket tick can never re-read a just-closed position and send a SECOND
  // close order for the same vol (which on a flat MEXC account would open an
  // opposite position). Zero overlap = no double-close window.
  //
  // Cheap when idle: a run with neither a lock-armed row nor an un-bracketed
  // monitor-managed row returns before any price/private-API call. The latter
  // is included so a failed bracket attach still receives bar-accurate SL
  // detection even when trailing-lock config is off.
  crons.cron(
    "live-rlock-tick",
    "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
    internal.rLockExit.liveRLockTick,
    {},
  );

  // ── LIVE SCHEDULED ARM — REMOVED 2026-10-28 ──
  // Its one-shot fired 2026-10-26 19:50Z and armed the book. The registration
  // is deleted rather than left to fire every Oct 26 and no-op; the dated
  // rationale lives in the journal, not in a live cron table.


  // ── LIVE CLOSE-ANALYTICS BACKFILL (2026-09-23) ──
  // Fills the paper-parity close-side fields on live rows that lack them
  // (excursion profile, MFE capture, duration, vol delta, cross-asset move).
  // "Missing any of those three" is the work queue, a few rows
  // per run, and it is idempotent with no cursor — a missed run simply resumes
  // next time. No-op once caught up. This is a RECORDING job: it changes no
  // gate, no threshold and no entry, and it never touches an open position.
  //
  // EVERY 6 HOURS, not hourly (2026-10-01; was hourly since 2026-09-23). This is a REPAIR path, not the
  // forward path: a trade that closes now gets its analytics inline in
  // markLiveClosed, so the only rows this job ever sees are ones whose inline
  // pass failed, plus the pre-parity backlog it has already drained. Its idle
  // cost is not zero even when the queue is empty — the queue lives in the
  // action (there is no index on "missing a reading"), so every fire reads the
  // newest 120 closed live rows to find nothing: 48 fires/day was ~5,800 doc
  // reads/day for a job with no work, at the same order as the paper exit
  // tick's entire read line. Nothing downstream gates on these fields and
  // nothing reads a repair's latency, so cutting 24 → 4 fires/day is free —
  // each idle fire reads the newest 120 closed rows to find nothing.
  //
  // NOT heartbeat-wrapped, deliberately — and the reason is the audit: this
  // job stalled silently for 3 hours while its cron fired on time (a queue
  // head it could never satisfy). A liveness stamp would have looked perfect.
  // Its honest health signal is the `filled/skipped/remaining` it returns.
  crons.interval(
    "live-close-analytics-backfill",
    { hours: 6 },
    internal.liveEngine.backfillLiveCloseAnalytics,
    {},
  );

  // ── DAILY DATA PRUNE ──
  // Convex has no TTL index, so history growth is bounded by an explicit
  // scheduled mutation: legacy layer1Ticks rows and other recurring tables
  // are cleaned up daily.
  crons.interval(
    "cleanup-layer1-ticks",
    { hours: 24 },
    internal.cleanup.pruneLayer1Ticks,
    {},
  );
  // Drain the legacy per-pair marketMetrics rows (no longer written after the
  // batched-tick switch) so the old table doesn't linger forever.
  crons.interval(
    "cleanup-market-metrics",
    { hours: 24 },
    internal.cleanup.pruneMarketMetrics,
    {},
  );
  // Cap the h4ShadowCache (shadow-tag forward test, 2026-09-23): ~192 rows/day,
  // 8-day retention ≈ 1.5k rows. Stale rows are never trusted (bar-guarded),
  // so pruning only reclaims space.
  crons.interval(
    "cleanup-h4-shadow-cache",
    { hours: 24 },
    internal.cleanup.pruneH4ShadowCache,
    {},
  );
  // Cap the strategySignals audit log. NOTE: logSignal only runs on ENTRY
  // (never for gate-blocked signals), so a quiet log means no entries — not
  // a stalled scanner. See the note on pruneStrategySignals for the details.
  crons.interval(
    "cleanup-strategy-signals",
    { hours: 24 },
    internal.cleanup.pruneStrategySignals,
    {},
  );
  // REJECTION RETENTION (2026-09-23): there is deliberately NO second prune
  // here. A 21-day `cleanup-strategy-rejections` job existed for one day and
  // never deleted a row — one table, one timestamp index, so the pass paged
  // the oldest 2,000 docs below its cutoff, which are entry/veto rows it must
  // not touch, and the reject rows it targeted stayed out of reach. Rejects now
  // ride the 60-day pass above. See the header note in cleanup.ts for the
  // measured inflow (~370/day) and why 60 days is the cheaper default anyway.

  // SCALPER — DISABLED
  // crons.interval(
  //   "mexc-scalper-tick",
  //   { minutes: 2 },
  //   api.book45.ScalperScan,
  //   {},
  // );
}

export default crons;
