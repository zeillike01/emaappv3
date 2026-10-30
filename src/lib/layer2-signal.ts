/**
 * LAYER 2 — Shared strategy configuration + scoring (PURE module).
 *
 * Single source of truth for the EMA Momentum + Order Flow + Order Book
 * scoring used by BOTH engines:
 *   - paper book "layer2"  → convex/strategyEngine.ts (cron strategyTick)
 *   - LIVE MEXC book        → convex/liveBroker.ts    (cron liveEntryTick)
 *
 * Keeping this module pure (no Convex imports, no I/O) means the live engine
 * can import it from a "use node" action file, and any change to scoring or
 * defaults lands on paper + live together. The live book intentionally runs
 * the same SCORING here, but NOT the same stored config doc: since 2026-09-08
 * each book reads its own row (paper "ema-momentum", live "live"), so a panel
 * edit on one book cannot leak into the other. The one exception is the
 * blocklist, which getConfig unions across both rows at read time — policy
 * lists must not diverge per book (2026-09-22: they had diverged 2 vs 21 and
 * the paper book spent 57% of its entries on pairs live refuses).
 */

import { clampRiskPct } from "./costs";
import { volFloorBlocks } from "./vol-floor";
import { wilderRsi } from "./wilder-rsi";
import { stSeries } from "./luxphase2/supertrendRecovery";

// Re-exported so every existing importer keeps resolving it from here.
export { wilderRsi };

export interface StrategyConfig {
  emaFast: number;
  emaSlow: number;
  gapThreshold: number;
  minScore: number;
  minGap: number;
  stopLossPct: number;
  takeProfitPct: number;
  // Per-side SHORT take-profit (2026-09-09, backtest-validated): shorts win
  // more at 1.5R than 2R (54.5% WR +9.4R vs 48.5% +8.4R on the Sep 2-9
  // stream). null = fall back to takeProfitPct (the long leg always uses it).
  shortTakeProfitPct: number | null;
  // ── R-LOCK TRAILING EXIT (2026-09-20, both books) ──
  // Replaces the fixed TP with a stepped trailing lock once the trade has run
  // `trailLockStartR` in profit. See src/lib/r-lock.ts for the full rationale
  // and the out-of-sample numbers (25 pairs, 2026-05-28 → 09-13): a fixed 2R
  // target measured -0.062 R/trade, the lock +0.038 — the edge is the right
  // tail a fixed target structurally cannot reach.
  // `trailLockStartR <= 0` (or undefined after resolve) disables the lock and
  // restores the fixed TP for that book.
  trailLockStartR: number;
  trailLockStepR: number;
  trailLockMaxR: number;
  // Risk per trade as a percent of the book balance (2026-09-10): the paper
  // engine sizes positions as balance × riskPct/100, compounding with the
  // rolling account balance exactly like before — the constant is now a
  // per-book config knob (live has had its own UI-editable riskPct on the
  // liveAccount doc since launch; this brings paper to parity). 1 = 1%.
  riskPct: number;
  // ENTRY LIMITS (2026-10): null = gate off. No default: an unset limit is
  // logged as off, never silently set. Spread is the bid/ask spread at the
  // decision; slippage is |current price - signal close| in basis points.
  maxSpreadPct: number | null;
  maxEntrySlippageBps: number | null;
  spreadTight: number;
  spreadWide: number;
  atrSpikeMult: number;
  feePct: number;
  bookWeight: number;
  flowWeight: number;
  // Funding is a required agreement gate when the paper book uses strict mode.
  // The legacy mode/weight fields remain in the config shape so older live
  // rows still decode and can retain their bonus policy. "off" = funding is
  // ignored entirely (no veto, no score) — the paper resolver's current
  // setting after the strict-agreement test was parked on 2026-09-08.
  fundingWeight: number;
  fundingMode: "off" | "bonus" | "strict";
  fundingBonusThreshold: number;
  // Manual side kill switches (front-end panel toggles). When a side is
  // disabled the gate returns BEFORE any order is placed.
  allowLong: boolean;
  allowShort: boolean;
  // Manual SESSION filters (front-end panel, 2026-09): per-side allowlists of
  // entry sessions ("asia" | "london" | "ldn-ny" | "ny" | "late"). EMPTY =
  // unrestricted (default). Same labels as sessionOf().
  longSessions: string[];
  shortSessions: string[];
  blocklist: string[];
  // 1H HTF trend gates (2026-09-06, shared paper + live via this doc): veto
  // entries that trade against the coin's 1H trend — SHORT while the 1H EMA
  // reads "up", LONG while it reads "down" (the mirror). The EMA period is
  // per side. EMA-period sweep over the closed layer2 book (run-htf-gate-sweep.ts)
  // put the SHORT sweet spot at 15 (blocked bucket 20.5% WR / PF 0.45 → book
  // short PnL -$48 → +$37). The LONG mirror was measured too and FAILED: at
  // every period 5-100 the 1H-down longs were the most profitable long bucket
  // (WR ~58-64%, PF >= 1.74), so the mirror ships behind htfGateLong=false —
  // flipping it on loses money on that sample.
  htfShortEma: number;
  htfLongEma: number;
  htfGateShort: boolean;
  htfGateLong: boolean;
  // HTF gate timeframe (2026-09-13 swap, both books): "4h" reads the verdict
  // on 4h bars with a deep SMA-seeded EMA (fetchHtfTrend4h, 240-bar window —
  // bit-identical to run-layer2-htf-swap.ts); "1h" keeps the original ≤60-bar
  // 1h read. OPTIONAL — undefined/legacy rows RESOLVE TO "4h" (the analyzer's
  // measured default: the 4h deep-EMA read would have blocked the −9R cluster
  // bucket on the closed layer2 sample, kept book +8.1R vs −0.75R as-run).
  // Set both per-side periods to 75 for the analyzer's proposed config.
  htfTf?: "1h" | "4h";
  // ── BTC 4H REGIME GATE (layer2-v3/v4) ─────────────────────────────────
  // Read by BOTH entry engines (strategyEngine.processPair, liveBrokerRuntime
  // .processPairLive); the verdict itself is computed once per tick in
  // convex/btcRegimeCache.ts. `btcRegimeBlocks` blocks LONG in chop and SHORT
  // in up; `btcRegimeDownBlock` extends that to BOTH sides while the slope is
  // down (layer2-v4, run-layer2-grind-fix-lab); `btcRegimeLongSlopeMin` is the
  // long-quality floor (LONGs need slope >= this, 0 = off) — paper-only until
  // 2026-10-25, now read by both engines.
  //
  // 2026-10-25: these three were MISSING from resolveConfig below — it is an
  // explicit allowlist, so the stored row was silently discarded and the
  // down-block never fired on either book even though the
  // "layer2-v4-downblock" migration had stamped `btcRegimeDownBlock: true`.
  btcRegimeEnabled: boolean;
  btcRegimeDownBlock: boolean;
  btcRegimeLongSlopeMin: number;
  // ── 4H CHOPPINESS GATE (2026-09-22, both books, SHIPS OFF) ──
  // Blocks BOTH sides while the pair's own 4H Kaufman Efficiency Ratio
  // ER(period) — net move ÷ path length over the last `period` CLOSED 4h
  // bars — sits below `chopGateFloor` (optional per-side override). Pure
  // logic in src/lib/chop-gate.ts; measured by run-4h-chop-gate-lab.ts
  // (backtest:chopgate). Motivation: a choppy 4H (INJ read ER 0.14) weaves
  // around its filter EMA, flipping the HTF verdict while 15m HL/LH setups
  // inside the range get stopped out. SHIPS OFF — the gate earns its place
  // only if the 6-month A/B clears the promotion bar. Contracts: closed
  // candles only, fail-open (off / short history / fetch error = allow).
  // Enforced by the paper engine (strategyEngine); live is wired after the
  // lab validates it, like every other experiment shipped so far.
  chopGateEnabled: boolean;
  chopGatePeriod: number;              // ER lookback in closed 4H bars (10)
  chopGateFloor: number;               // shared ER floor, both sides (0.25)
  chopGateFloorLong: number | null;    // per-side override; null = shared
  chopGateFloorShort: number | null;   // per-side override; null = shared
  // ── 15m VOLATILITY FLOOR (2026-09-27, user decision) ──────────────────
  // Block a side when the decision bar's own ATR% is below the floor — the
  // "dead tape" veto. Same shape as the chop gate's per-side floor: a shared
  // `atrFloorPct` with optional per-side overrides (0/null = off; an override
  // of 0 means "fall back to shared", NOT "off"). ARMED on both books
  // 2026-09-27 for a forward test — see src/lib/vol-floor.ts for the
  // measurement, the honest "uncertified positive" state, and the fail-closed
  // convention. Measured on the 6-month anchor: LONG-only 0.60–0.65% removes a
  // losing long cohort (−56.2R over 693 trades) while every SHORT-side floor
  // removes trades that were making money (+16.2R), which is why the shipped
  // configuration is longs-only.
  atrFloorPct: number;                 // shared floor, 0 = off
  atrFloorPctLong: number | null;      // per-side override; null = shared
  atrFloorPctShort: number | null;     // per-side override; null = shared
  // CHASE GUARD (2026-09-07, LIVE only): when the live position cap delays an
  // entry, the bot remembers the FIRST signal per pair (price + bar time) and
  // refuses to enter later if price has drifted too far from that setup
  // (maxSignalDriftPct) or the setup has gone stale (signalMaxAgeMin). Paper
  // ignores these fields — it never queues pending signals.
  // KILL SWITCH (2026-09-20): `chaseGuardEnabled` gates the whole guard. It
  // ships OFF — the guard was observed making live fills WORSE (it blocked
  // prompt entries and then let the pair in later, at a worse price, once the
  // anchor aged out), so it is parked until it is re-measured. When off, no
  // anchors are recorded and nothing is blocked; the numeric knobs below are
  // ignored. Flip it back on from the config panel to re-enable.
  chaseGuardEnabled: boolean;
  maxSignalDriftPct: number;
  signalMaxAgeMin: number;
  // EMA-STRETCH VETO (2026-09-09, both books): blocks a side when price has
  // run more than maxEmaStretchPct away from the fast EMA on the closed
  // signal candle (0 = disabled). The "bot chased the breakout" guard —
  // measured on the paper ledger. Set to 1.5% (2026-09-09, user config:
  // loosened from 1.0% after the TP target was cut to 1:1.5R, so stretched
  // entries now reach a smaller TP more often).
  maxEmaStretchPct: number;
  // RSI WICK GUARD (2026-09-09, LONG side only): block a LONG when 15m
  // RSI(7) on the just-closed signal candle exceeds maxRsiLong — the bot
  // was entering blow-off wicks. Measured on the 303-trade paper ledger:
  // RSI7 > 78 longs = 36% WR, -$1.10/trade vs +$1.19 for the rest; the
  // SHORT mirror FAILED (blocked bucket was profitable), so this ships
  // long-only. 0 or rsiLongGuard=false disables.
  rsiLongGuard: boolean;
  maxRsiLong: number;
  // ── RSI PULLBACK TERM (2026-09-21, both books, default OFF) ──
  // A 15m Wilder RSI on the just-closed signal candle, read as "is this entry
  // a pullback inside an intact trend, or a blow-off / broken tape?" — the
  // WIDER cousin of the rsiLongGuard above, which is one long-only ceiling on
  // RSI(7). This term is per-side and has two modes (same shape as fundingMode):
  //   "off"   — ignored entirely (SHIPPED DEFAULT: the 6-month lab found no
  //             arm clearing the promotion bar — see run-rsi-gate-backtest.ts).
  //   "bonus" — +rsiPullbackWeight on the side whose trend state agrees.
  //   "veto"  — block a side whose RSI sits outside its own band (a LONG
  //             outside [longMin, longMax] = bought the blow-off or the drop).
  // A missing reading (too few closed bars) is treated as NO OPINION — fail
  // OPEN, exactly like the wick guard, never as a silent veto.
  rsiPullbackMode: "off" | "bonus" | "veto";
  rsiPullbackPeriod: number;
  rsiPullbackWeight: number;
  rsiPullbackLongMin: number;
  rsiPullbackLongMax: number;
  rsiPullbackShortMin: number;
  rsiPullbackShortMax: number;
  // CIRCUIT BREAKER (2026-09-08, paper only): pause new entries while the
  // book's recent results degrade — rolling WR over the last 20 closes below
  // breakerMinWr, or realized loss today exceeding breakerMaxDailyLossPct of
  // the balance. Pure logic lives in src/lib/circuit-breaker.ts and is
  // enforced only in strategyEngine.strategyTick; live ignores these fields.
  breakerEnabled: boolean;
  breakerMinWr: number;           // 0-1, default 0.30
  breakerMaxDailyLossPct: number; // 0-1, default 0.05
  // LIVE CIRCUIT BREAKER (2026-09-10, manual re-arm 2026-10-22): N
  // consecutive losses DISARM live entries until an operator re-arms
  // (liveBreakerManualReArm, default true). The legacy timed cooldown
  // (liveBreakerCooldownMin) only applies when the manual switch is off. Pure
  // logic in src/lib/live-breaker.ts; state persisted on the liveAccount doc
  // (liveBreakerManualDisarmedAt / liveBreakerPausedUntil /
  // liveBreakerTriggeredAt) so a disarm survives ticks and cannot re-arm on
  // its own stale streak.
  liveBreakerEnabled: boolean;
  liveBreakerMaxLossStreak: number;
  liveBreakerCooldownMin: number;
  liveBreakerManualReArm: boolean;
  // Next-session release (2026-10-23, default true): a manual-mode disarm is
  // also released once a session AFTER the trip closes profitable on the paper
  // ledger. Explicit false restores the pure latch (operator re-arm only).
  liveBreakerRearmOnSession: boolean;
  // SESSION PROFITABILITY BREAKER (2026-10-20): paper measures, LIVE enforces.
  // The paper ledger is bucketed by (session, side) over the lookback window;
  // a bucket with at least `sessionBreakerMinTrades` closes is closed to LIVE
  // entries while its realized R is <= `sessionBreakerMinProfitR` (0 = "must
  // be profitable"). Paper itself is never blocked — it is the sensor that
  // keeps producing the evidence a bucket needs to re-open. Thresholds live in
  // the PAPER row (the source), while `sessionBreakerEnabled` is read from the
  // LIVE row to arm/enforce the gate. `sessionBreakerSource` is deliberately
  // NOT a knob — it is the paper ledger by definition. Pure logic:
  // src/lib/session-breaker.ts.
  sessionBreakerEnabled: boolean;
  sessionBreakerLookbackDays: number;
  sessionBreakerMinTrades: number;
  sessionBreakerMinProfitR: number;
  // COIN PRIORITY (2026-10-21): the live book's scan ORDER. Coins whose paper
  // record over the window is profitable are scanned first, so a scarce
  // position slot goes to the pair that has been making money. NOT a veto —
  // a losing coin sorts last, it is not banned. Measured from the paper ledger
  // (daily snapshot, `coinProfitState`); see src/lib/coin-priority.ts.
  coinPriorityEnabled: boolean;
  coinPriorityLookbackDays: number;
  coinPriorityMinTrades: number;
  /**
   * When on (default), a coin in the `avoid` tier REFUSES live entries — the
   * operator's 2026-10-21 spec: "live book ... priority coins that have higher
   * win rate". Paper is never blocked by it (the sensor has to keep sampling
   * a losing coin to learn when it recovers).
   */
  coinPriorityBlockAvoid: boolean;
  // HTF ADVISOR (2026-09-08, default ON): 4H divergence + volume-
  // exhaustion veto layer IN FRONT of entries. Pure logic lives in
  // src/lib/htf-advisor.ts; a pair's 4H state is computed by the advisor
  // cron (convex/advisor.ts) into advisorTicks, and strategyTick vetoes a
  // side when the advisor's votes >= advisorVetoThreshold. Paper is the
  // validation bed; live is wired with the SAME veto layer (2026-09-08) —
  // both books default ENFORCED via getConfig in strategyEngine.ts, and a
  // stored row wins once the panel flips the toggle.
  advisorEnabled: boolean;
  // Advisor input mode (2026-09-09, replay-validated on the Sep 2-8
  // signal stream): "pair" gates on the traded pair's own 4H verdict,
  // "btc" gates on BTC's 4H verdict alone (macro regime layer), "both"
  // blocks on EITHER — the shipped default (804t · WR 58.5% · +579.7R vs
  // per-pair 484.1R at the SAME 36.3R drawdown).
  advisorMode: "pair" | "btc" | "both";
  advisorVetoThreshold: number;      // SHARED votes needed to veto (default 2 = confluence)
  // Per-side overrides (2026-09-08, replay-validated): the SHORT veto is a
  // pure winner (0% WR on every flagged short) and needs no confluence —
  // advisorShortThreshold 1 blocks shorts on any single flag. LONG keeps 2
  // (needs the exhaustion pair). Unset side = fall back to advisorVetoThreshold.
  advisorLongThreshold: number;
  advisorShortThreshold: number;
  advisorDivergenceAgeBars: number;  // 4H bars a confirmed divergence stays active (4 = 16h, wired 2026-09-12)
  advisorVwapExtremePct: number;     // % stretch above/below 4H VWAP that flags exhaustion (3)
  advisorRsiExtreme: number;         // RSI level counted as stretched (70)
  // Weighted-vote model (2026-09-08): strong tells (bullish divergence at
  // 4H bottoms + thin zones near 4H lows — the SHORT-blocking family) cast
  // advisorStrongWeight votes; weak tells (RSI/OBV bearish divergence) cast
  // advisorWeakWeight. Thin zones near 4H highs stay 1. Both = 1 restores
  // uniform voting.
  advisorStrongWeight: number;       // strong signal weight (default 2)
  advisorWeakWeight: number;         // weak signal weight (default 0.5)
  // MACD vote family (2026-09-10): MACD-line divergence + fresh histogram
  // sign flips on the 4H filter TF. NORMAL weight (1) by default — the
  // integration replay measured +$62.49 marginal for 6/14/10 at weight 1
  // (weight 0.5 never crosses a threshold; strong 2 nets less on LONG).
  // Pure logic in htf-advisor.ts (ADVISOR_MACD_DEFAULTS = 6/14/10).
  advisorMacdEnabled: boolean;
  advisorMacdWeight: number;         // per-flag vote weight (default 1, normal)
  advisorMacdFast: number;           // default 6
  advisorMacdSlow: number;           // default 14 (must stay > fast or family disables)
  advisorMacdSignal: number;         // default 10
  // Stochastic RSI (2026-09-11): the advisor's momentum oscillator —
  // divergence + VWAP-exhaustion read StochRSI %K instead of RSI(14).
  advisorStochRsiEnabled: boolean;
  advisorStochRsiRsiPeriod: number;  // default 14
  advisorStochRsiStochPeriod: number; // default 14
  advisorStochRsiKSmooth: number;    // default 3
  advisorStochRsiDSmooth: number;    // default 3
  advisorStochRsiUseD: boolean;      // true = %D feeds divergence/exhaustion
  // ── 1H ADVISOR LAYER (2026-09-12) ──
  // The SAME detector on 1H bars — an optional second veto layer that stacks
  // with the 4H one (default OFF). Every override below is OPTIONAL and
  // `undefined` is MEANINGFUL: unset = "share the 4H value", resolved at gate
  // time with `??`. These fields were missing from this interface AND from
  // resolveConfig, so both engines read `cfg.advisor1hEnabled` off a resolved
  // object that never carried it — the layer could not activate even with a
  // stored row. Keep them pass-through (no numeric coercion) in resolveConfig.
  advisor1hEnabled?: boolean;
  advisor1hLongThreshold?: number;       // unset = shared advisorLongThreshold
  advisor1hShortThreshold?: number;      // unset = shared advisorShortThreshold
  advisor1hMacdWeight?: number;          // unset = shared advisorMacdWeight
  advisor1hStochRsiRsiPeriod?: number;   // unset = shared advisorStochRsiRsiPeriod
  advisor1hStochRsiStochPeriod?: number; // unset = shared advisorStochRsiStochPeriod
  advisor1hDivergenceAgeBars?: number;   // unset = shared advisorDivergenceAgeBars
  // Which verdicts gate the HOURLY layer: "pair" | "btc" | "both".
  // unset = share advisorMode (so a book that never sets it keeps the
  // pre-2026-09-12 behaviour where one mode drove both layers). Needed
  // because the mode A/B's best cell runs the layers on DIFFERENT arms —
  // 4H=pair + 1H=btc = 641t · WR 46.8% · +203.5R (+74.3R over the pair-only
  // 4H book), vs +29.0R for 1H=both and +2.8R for 1H=pair in the same grid.
  advisor1hMode?: "pair" | "btc" | "both";
  // SHORT FLOW GATE (2026-09-09, paper + live, default ON): SHORT entries
  // require aggressive-seller confirmation on the L1 flow snapshot
  // (flowBias < 0). Backtested on real Sep 2-8 signals (7/30 + combo
  // advisor): shorts with no sell flow read 23% WR (the bleeders),
  // flow-confirmed shorts 45-46% WR (+6.1R) — total +588.8R with the
  // lowest drawdown of any measured config (31.1R). Threshold is fixed at
  // 0 — flowBias exactly 0 (silent 5s snapshot) blocks, because that
  // silent bucket is the losing one. LONG untouched.
  shortFlowGate: boolean;
  // HARD EMA TREND GATES (2026-09-10, paper + live, default ON): the
  // just-closed 15m bar must agree with the entry side — LONG needs
  // emaFast > emaSlow, SHORT needs emaFast < emaSlow (ties block). These are
  // structural vetoes, not score compensation. Long evidence (run-flow-ab-
  // replay.ts, coin|entryTime join, 204 closed longs Sep 2-10): 12 bad-
  // trend longs cleared minScore/minGap via book/flow terms and lost at
  // 16.7% WR (-$37.25); the gate lifts the long book +$154.41 → +$191.66,
  // PF 1.17 → 1.23 and trims the Sep 9 bleed -13.9R → -7.8R. SHORT mirror
  // added 2026-09-10 per user decision (same 15m EMA structure requirement,
  // short book A/B measured in the same harness). Every other candidate
  // gate from the flow-score restructure (flowBias>0, flowScore>=20, imb>0,
  // extension<=1ATR) measured profit-NEGATIVE and was rejected.
  longTrendGate: boolean;
  // ── SUPERTREND SCORE TERM (lab-only 2026-10-11, SHIPS OFF) ──
  // Optional score term from the audited LuxAlgo SuperTrend Recovery port
  // (src/lib/luxphase2/supertrendRecovery.ts): the chart-TF recovery trend
  // read on the same closed bars. "off" (default) skips the computation
  // entirely — production scoring is bit-identical with the default.
  // "bonus" credits the agreeing side +stWeight; "penalty" charges the
  // disagreeing side -stWeight; "symmetric" does both at half weight.
  // The 4H-bias leg is deliberately NOT part of this term: the join lab
  // (run-luxlayer2-join-lab) measured bias agreement as negative value on
  // both sides (Welch -4.80/-3.50), so only the chart trend ships here.
  stMode: "off" | "bonus" | "penalty" | "symmetric";
  stWeight: number;
  // ── EMA-TERM KILL SWITCH (lab-only 2026-10-11, default false) ──
  // Ablation flag for the tuning lab's deletion study. true skips the
  // hardcoded +16/-10 EMA cross-term (a zeros "ema" component is still
  // pushed so attribution shape is stable). Production default false.
  noEmaTerm: boolean;
  // ── SUPERTREND VETO (2026-10-11, SHIPS OFF) ──
  // SUPERTREND VETO (2026-10-11, SHIPS OFF) — three modes:
  //   "off"    inert (default everywhere until the A/B says otherwise).
  //   "shadow" MEASURE ONLY: a side taken against the SuperTrend chart trend
  //            is still taken, but the decision is tagged (stShadowHit +
  //            reason) so the forward read-out can price what enforcement
  //            would have done — zero effect on the book.
  //   "on"     ENFORCE: block the side (runs LAST, after the vol floor, so
  //            its blocks are strictly incremental over every existing veto).
  // Graduated from the join lab (ST-disagreement earns ~0R on 12% of taken
  // trades, both sides, halves-consistent) and the tuning replay (+0.012 R/t,
  // t=1.03 — below the ship bar, hence shadow-first). Requires the ohl read;
  // without it every mode is inert.
  stVeto: "off" | "shadow" | "on";
  shortTrendGate: boolean;
  // ── FACTOR-EXPOSURE CAP (2026-09-23, both books, SHIPS OFF) ──
  // Caps the SIGNED sum of per-position BTC-beta across open positions, i.e.
  // correlated exposure to the one factor the book actually concentrates in.
  // The count cap (`maxOpenPositions`, live only) bounds the wrong quantity:
  // measured on this book it cut max drawdown 21.7% against a volume-matched
  // random block's 27.9% median — worse than deleting the same number of
  // trades at random — because the damage was one correlated cluster, not
  // "too many positions". Longs add to the sum, shorts subtract, so a hedged
  // book may carry more positions than a one-sided one at equal exposure.
  // `<= 0` = OFF (the shipped default): the check short-circuits, nothing is
  // recorded and nothing is blocked. Beta is estimated per pair from the same
  // closed 15m bars the scan already fetched (src/lib/btc-beta.ts), falls back
  // to 1.0 when it cannot be fit, and is stamped on the row for audit.
  maxNetBtcBeta: number;
  /**
   * H4 QUALITY GATES (2026-09-23, exhaustion + volume-size labs,
   * src/lib/h4-shadow.ts h4GateBlocks): default-ON on BOTH books (user
   * decision "keep all the gates run for now, wire it in the live also").
   * Only an explicit stored `false` turns a block off. Missing 4h/RSI
   * readings fail open inside the gate itself.
   */
  h4VolClimaxBlock: boolean;
  h4PullbackBigBlock: boolean;
  h4PullbackDeadBlock: boolean;
  /** side-aligned RSI(7) ceiling, both sides; 0 = off. Lab default 80. */
  rsiHeatMax: number;
  /**
   * LTF 5M CONFLUENCE GATE (2026-09-26, both books): block LONG entries when
   * the last CLOSED 5m bar closed below its 5m EMA20 (minute-scale structure
   * rolled over before the 15m break). Lab evidence: run-ltf5m-92d-lab.ts —
   * 92-day window, n=762 longs, against-cohort −0.161 R/t; deletion lifts the
   * book +0.063 → +0.197 R/t at paired-day t=3.63 with split-half 2.42/2.69 —
   * the session's only candidate to clear every bar. Fails OPEN when the 5m
   * series is missing/short (ltf5mGateBlocks); LONG-only by design.
   */
  ltf5mGateEnabled: boolean;
}

/**
 * Union of two blocklists — sorted, de-duplicated.
 *
 * Used by the paper row's convergence to the live row's list
 * (ensureLayer2BlocklistParity, strategyEngine.ts). Per-book config rows are
 * right for strategy knobs (sessions, side switches, EMAs — that is why the
 * console edits one book at a time) and wrong for a SAFETY list: by 2026-09-19
 * the live row blocked 21 pairs while the paper row blocked 2, so the paper
 * book — the bed every gate is validated on — took 115 of its next 201 entries
 * (57%) on pairs the live book refuses to trade at all.
 *
 * The union is MONOTONE: it can only grow. Adding a pair to either list blocks
 * it on both, while REMOVING one takes an edit to both. A list that can shrink
 * from one side alone is how the divergence happened in the first place.
 */
export function blocklistUnion(
  a: readonly string[],
  b: readonly string[],
): string[] {
  return [...new Set([...a, ...b])].sort();
}

export const DEFAULT_CONFIG: StrategyConfig = {
  // EMA speed: 7/30 on both books per trader call (2026-09-09; the 5/20
  // migration was retired — stored row is source of truth). Fresh rows ship
  // 7/30 to match schema docs, labs, and production.
  emaFast: 7,
  emaSlow: 30,
  gapThreshold: 0.02,
  minScore: 8,
  // DEAD KNOB, DOCUMENTED 2026-09-22. `minGap` asks the winning side to beat
  // the losing side by at least this many points. It cannot: the hard trend
  // gate (longTrendGate/shortTrendGate, both ON) already forces the winner to
  // lead by 26 — the EMA term is +16 to the winner and -10 to the loser —
  // before any book/flow term is added, and every SHARED penalty cancels in
  // the difference. Measured over 5,054 L1-replayed setups (backtest:2sided):
  // margin floor 2.03, median ~35, max 113. At 2 the comparison has never once
  // decided a trade.
  //
  // Deliberately NOT raised: the same replay found the margin does not predict
  // R (day-paired t = +0.43, sign flipping between halves), so any value picked
  // to "make it bite" would be unvalidated tuning of exactly the kind that has
  // failed nine times. gateReachabilityWarnings() reports the deadness instead.
  minGap: 2,
  stopLossPct: 1.5,
  takeProfitPct: 3.0, // 2R (TP = 2 × SL); was 2.0 (1.33R), drifted to 4.0 (2.67R) in stored rows — reset to 2R 2026-09-08
  spreadTight: 0.04,
  spreadWide: 0.12,
  atrSpikeMult: 2.0,
  feePct: 0.06,
  // Sides enabled by default — existing deployments with no stored config
  // record behave exactly as before (no behavioral change until a toggle
  // is explicitly turned off from the panel).
  allowLong: true,
  allowShort: true,
  longSessions: [],
  shortSessions: [],
  bookWeight: 22,
  flowWeight: 22,
  // Live keeps the existing soft-bonus default. The paper resolver forces
  // "off" while the strict-agreement test is parked (see resolvePaperConfig).
  fundingWeight: 2,
  fundingMode: "bonus",
  fundingBonusThreshold: 0.00005,
  // ANALYTICS FINDING (2026-09-03, mistake taxonomy on 116 closed trades):
  // ARB + ENA are the BAD_ENTRY repeat offenders (9 + 4 of 21 BAD_ENTRY
  // classifications — MAE <= 3 bars, the taxonomy's "entry filter is wrong"
  // bucket). ARB is negative in both recent eras (-0.5R on 12 at TP=1.33R,
  // -1.06R on 4 in the live TP=2.0R era incl. 3 BAD_ENTRY) and only profits
  // in the old 0.3% SL era whose exit path was demonstrably broken (missed
  // hour-long TP windows). ENA is negative in both eras (-3.4R/8, -1.4R/6).
  // 2026-09-11: ARB re-added to the tradeable universe by user request and
  // dropped from the default blocklist to match the stored config then in use.
  // 2026-10-26 (user): the default AND both stored rows are EMPTY. ENA and the
  // six stale entries (NVDA, SPCX, TESLA, USOIL, XAG, XAU — dropped from the
  // universe on 2026-09-26) were purged first; the remaining 15 rows were then
  // cleared too, so the live book follows ONE filter instead of two: coin
  // priority ranks the scan (profitable tier only) and nothing is refused by
  // name. The evidence above stands as history — the list is config-driven and
  // currently empty.
  blocklist: [],
  // HTF gate period: the 2026-09-13 era-long surrogate sweep
  // (run-layer2-4h-ema-sweep.ts, Mar 1 → Sep 12, layer2's own signal core +
  // the paper book's exit brackets) fixed the period at EMA75 on the 4h
  // timeframe — tied-best net/t, best OOS half, mid-plateau of the 60–90
  // band. Timeframe default "4h" (htfTf undefined → "4h" at the read sites)
  // per the same-day swap analyzer + user request. Stored rows were stamped
  // 75/75 by the layer2-v2-4h-ema75 migration (ensureLayer2GateMutation in
  // strategyEngine.ts), so these defaults govern fresh rows only.
  htfShortEma: 75,
  htfLongEma: 75,
  htfGateShort: true,
  htfGateLong: false,
  // 4H choppiness gate (2026-09-22): ships OFF — unproven until
  // run-4h-chop-gate-lab.ts clears its promotion bar. ER(10) on closed 4h
  // bars, floor 0.25 (the proposal's default; INJ's chop tape reads 0.14),
  // both sides, no per-side override by default.
  chopGateEnabled: false,
  chopGatePeriod: 10,
  chopGateFloor: 0.25,
  chopGateFloorLong: null,
  chopGateFloorShort: null,
  // Volatility floor (2026-09-27): the SHARED knob defaults OFF so a config
  // row that never set it behaves exactly as before this feature existed; the
  // armed state lives in each book's own stored row (paper "ema-momentum" +
  // live "live" both carry atrFloorPctLong = 0.60). Deliberate: a default-on
  // gate would silently arm every book and every test that spreads defaults.
  atrFloorPct: 0,
  atrFloorPctLong: null,
  atrFloorPctShort: null,
  // Chase-guard defaults: skip cap-delayed entries whose price has moved more
  // than 0.5% away from the first signal, or whose first signal is older than
  // 120 minutes (8 x 15m candles). Backtested over 227 closed paper trades:
  // extending the anchor window from 30 → 120 min removes net-losing chases
  // (the 30-120 min anchor-age bucket is net-negative), with total blocked PnL
  // ≈ neutral. Live-only; paper has no anchors.
  //
  // DISABLED (2026-09-20): chaseGuardEnabled = false ships the guard OFF for
  // both books. The measured effect on the live book was negative — see the
  // kill-switch note on the interface field. The numeric defaults stay here so
  // re-enabling needs no further edits.
  chaseGuardEnabled: false,
  maxSignalDriftPct: 0.5,
  signalMaxAgeMin: 120,
  // EMA-stretch veto (2026-09-09): 1.5% chase cap vs the fast EMA on the
  // closed signal candle, both books (user config 2026-09-09, loosened from
  // 1.0% after TP dropped to 1:1.5R). 0 = off.
  maxEmaStretchPct: 1.5,
  rsiLongGuard: true,
  maxRsiLong: 78,
  // RSI pullback term (2026-09-21): SHIPS OFF. The 6-month gate grid
  // (run-rsi-gate-backtest.ts, parity-anchored) found no arm clearing the
  // promotion bar; the best LONG arms cut maxDD ~30R for +0.011 R/t at
  // paired-day t≈0.5. Defaults below are the grid's best-looking long band
  // and its short mirror, ready for a forward paper test — not an armed edge.
  rsiPullbackMode: "off",
  rsiPullbackPeriod: 14,
  rsiPullbackWeight: 4,
  rsiPullbackLongMin: 40,
  rsiPullbackLongMax: 75,
  rsiPullbackShortMin: 30,
  rsiPullbackShortMax: 60,
  // Circuit breaker defaults (paper-only enforcement): WR20 floor 30% (the
  // breakeven WR for the ~1R loss / ~2R win profile) and a 5%-of-balance
  // daily-loss cap. Both were breached hard during the Sep 7-8 chop.
  breakerEnabled: true,
  breakerMinWr: 0.3,
  breakerMaxDailyLossPct: 0.05,
  // Live breaker defaults (2026-10-22 user spec): 6 consecutive losses →
  // HARD DISARM (no entries at all) until the operator clicks Re-arm.
  // liveBreakerCooldownMin is the legacy timed pause, used only when
  // liveBreakerManualReArm is explicitly false.
  liveBreakerEnabled: true,
  liveBreakerMaxLossStreak: 6,
  liveBreakerCooldownMin: 720,
  liveBreakerManualReArm: true,
  // Release on next-session evidence (2026-10-23). The book is disarmed for
  // the remainder of the session that tripped it; the first session after that
  // one has to CLOSE before it is judged, and a profitable close (net R > 0
  // over >= sessionBreakerMinTrades paper closes) re-arms. A red session keeps
  // the veto and the following session is judged instead — never a timer.
  liveBreakerRearmOnSession: true,
  // Session profitability defaults (2026-10-20): 14-day lookback, judge a
  // bucket after 10 closes, require it to be strictly profitable (R > 0) for
  // live entries. Shipped ON; every threshold is exposed so the panel can
  // loosen it without a deploy.
  sessionBreakerEnabled: true,
  sessionBreakerLookbackDays: 14,
  sessionBreakerMinTrades: 10,
  sessionBreakerMinProfitR: 0,
  // Coin priority defaults (2026-10-21): same 14-day window and 10-close
  // evidence floor as the session breaker, so the two rankings cannot
  // disagree about what counts as a record. Shipped ON — ordering only.
  coinPriorityEnabled: true,
  coinPriorityLookbackDays: 14,
  coinPriorityMinTrades: 10,
  coinPriorityBlockAvoid: true,
  // HTF advisor defaults. DEMOTED 2026-10-06 (ADVISOR_REPRICE_JOURNAL §3):
  // the 6-month reprice deleted +104R of winners at paired-day t=−0.62, so
  // both books default TAG-ONLY via getConfig in strategyEngine.ts when the
  // stored row has never set the field — a config reset can never silently
  // re-arm the veto. The votes/thresholds below are unchanged: they still
  // shape the adv4h-* shadow tags. Explicit stored true re-arms (panel
  // opt-in). Threshold 2 = RSI + at least one volume line, or two
  // exhaustion tells — measured in run-divergence-lab.ts as the confluence
  // needed to beat 50/50 noise.
  advisorEnabled: false,
  advisorMode: "both",
  advisorVetoThreshold: 2,
  // Per-side thresholds: LONG = 2 (needs the exhaustion confluence), SHORT
  // = 1 (replay finding: every flagged short lost — no confluence needed).
  // resolveConfig keeps sides in sync with the shared knob when unset.
  advisorLongThreshold: 2,
  advisorShortThreshold: 1,
  // 4H divergence age (2026-09-12): 6 → 4. Swept in run-trio-advisor-lab.ts
  // against the ACTUAL stored stack (4H mode="both", 1H layer off) and better
  // in every window probed: Sep 1-12 +115.1R → +125.3R (+10.2R, maxDD 48.7 →
  // 50.1R), Aug 20-Sep 1 -103.3R → -61.1R (+42.2R), Aug 1-Sep 1 -140.3R →
  // -102.2R (+38.1R). Shortening the window drops stale divergences sooner, so
  // the 4H veto fires on present structure instead of a day-old signal.
  advisorDivergenceAgeBars: 4,
  advisorVwapExtremePct: 3,
  advisorRsiExtreme: 70,
  // Weighted votes (replay-validated, +$68.44 vs +$55.99 uniform): bullish
  // divergence + thin zones near 4H lows = 2 votes (veto alone — every
  // flagged short lost), RSI/OBV bearish divergence = 0.5 (two alone no
  // longer veto). Thin zones near 4H highs stay 1. Both 1 = old uniform.
  advisorStrongWeight: 2,
  advisorWeakWeight: 0.5,
  // MACD family: enabled, NORMAL weight (lab-validated for 6/14/10; see
  // AdvisorConfig in htf-advisor.ts for the bucket economics).
  advisorMacdEnabled: true,
  advisorMacdWeight: 1,
  advisorMacdFast: 6,
  advisorMacdSlow: 14,
  advisorMacdSignal: 10,
  advisorStochRsiEnabled: true,
  advisorStochRsiRsiPeriod: 14,
  advisorStochRsiStochPeriod: 14,
  advisorStochRsiKSmooth: 3,
  advisorStochRsiDSmooth: 3,
  advisorStochRsiUseD: true,
  // Short flow gate: ON by default on both books (see interface comment).
  shortFlowGate: true,
  // Hard EMA trend gates: ON by default (see interface comment) — both ship
  // enforced on both books via resolveConfig; stored rows can flip either.
  longTrendGate: true,
  stMode: "off",
  stWeight: 0,
  noEmaTerm: false,
  stVeto: "off",
  shortTrendGate: true,
  // BTC regime gate (2026-10-25): ENABLED by default (the engines already
  // treated `undefined !== false` as on); the DOWN-BLOCK is the measured
  // layer2-v4 variant, so it defaults OFF and only a stored `true` arms it —
  // which the ensureLayer2GateMigration stamp provides on both books.
  btcRegimeEnabled: true,
  btcRegimeDownBlock: false,
  btcRegimeLongSlopeMin: 0,
  shortTakeProfitPct: null, // null = shorts use takeProfitPct (2R); live set to 2.25 (1.5R) 2026-09-09
  // R-lock trailing exit (2026-09-20): start 1.5R, 0.25R ratchet, 8R full
  // exit (max target raised 6R → 8R on 2026-09-27 — the measured plateau
  // spans maxR 3-12R, so 8R stays inside the validated surface). Measured on
  // the project's backtest engine over the full kline cache
  // and positive in-sample, in all five out-of-sample months, on both sides,
  // and across the whole startR 1.0-2.0 / maxR 3-12 plateau — the flat
  // parameter surface is what separates this from the EMA30 entry gates,
  // which peaked at a single tuned threshold and died out-of-sample.
  trailLockStartR: 1.5,
  trailLockStepR: 0.25,
  trailLockMaxR: 8,
  riskPct: 1, // SEED for new accounts only. Entries skip when riskPct is unset (2026-10).
  maxSpreadPct: null,
  maxEntrySlippageBps: null,
  // Factor-exposure cap (2026-09-23): SHIPS OFF. The mechanism is the only
  // entry-side candidate this project has found that removes NO trades by
  // construction — it bounds correlated exposure instead of deleting setups.
  // It stays off until a set threshold clears a promotion bar; 0 = disabled.
  maxNetBtcBeta: 0,
  // H4 quality gates (2026-09-23): the lab-measured posture, default-ON.
  h4VolClimaxBlock: true,
  h4PullbackBigBlock: true,
  h4PullbackDeadBlock: true,
  rsiHeatMax: 80,
  // LTF 5m confluence gate (2026-09-26): wired ON for both books per the
  // user's call after the 92-day lab cleared every promotion bar. The gate
  // itself still fails open on missing 5m data.
  ltf5mGateEnabled: true,
};

/** Load a stored config record (any shape) with the shared defaults applied. */
export function rLockConfigError(startR: unknown, maxR: unknown, stepR: unknown = 0.25): string | undefined {
  const start = Number(startR);
  const max = Number(maxR);
  const step = Number(stepR);
  if (!Number.isFinite(start) || start <= 0) return undefined;
  if (!Number.isFinite(max) || max <= start) {
    return `R-lock max target (${maxR}) must be greater than start (${startR}) when the lock is enabled.`;
  }
  if (!Number.isFinite(step) || step <= 0) return "R-lock ratchet step must be a positive number.";
  return undefined;
}

export function resolveConfig(record: Record<string, any> | null | undefined): StrategyConfig {
  const c = record ?? {};
  return {
    emaFast: c.emaFast ?? DEFAULT_CONFIG.emaFast,
    emaSlow: c.emaSlow ?? DEFAULT_CONFIG.emaSlow,
    gapThreshold: c.gapThreshold ?? DEFAULT_CONFIG.gapThreshold,
    minScore: c.minScore ?? DEFAULT_CONFIG.minScore,
    minGap: c.minGap ?? DEFAULT_CONFIG.minGap,
    stopLossPct: c.stopLossPct ?? DEFAULT_CONFIG.stopLossPct,
    takeProfitPct: c.takeProfitPct ?? DEFAULT_CONFIG.takeProfitPct,
    spreadTight: c.spreadTight ?? DEFAULT_CONFIG.spreadTight,
    spreadWide: c.spreadWide ?? DEFAULT_CONFIG.spreadWide,
    atrSpikeMult: c.atrSpikeMult ?? DEFAULT_CONFIG.atrSpikeMult,
    feePct: c.feePct ?? DEFAULT_CONFIG.feePct,
    allowLong: c.allowLong ?? DEFAULT_CONFIG.allowLong,
    allowShort: c.allowShort ?? DEFAULT_CONFIG.allowShort,
    longSessions: c.longSessions ?? DEFAULT_CONFIG.longSessions,
    shortSessions: c.shortSessions ?? DEFAULT_CONFIG.shortSessions,
    bookWeight: c.bookWeight ?? DEFAULT_CONFIG.bookWeight,
    flowWeight: c.flowWeight ?? DEFAULT_CONFIG.flowWeight,
    fundingWeight: c.fundingWeight ?? DEFAULT_CONFIG.fundingWeight,
    // Preserve the configured live policy. Paper explicitly overrides this
    // through resolvePaperConfig below (currently forcing "off").
    fundingMode: c.fundingMode === "strict" || c.fundingMode === "off"
      ? c.fundingMode
      : DEFAULT_CONFIG.fundingMode,
    fundingBonusThreshold: c.fundingBonusThreshold ?? DEFAULT_CONFIG.fundingBonusThreshold,
    blocklist: c.blocklist ?? DEFAULT_CONFIG.blocklist,
    htfShortEma: c.htfShortEma ?? DEFAULT_CONFIG.htfShortEma,
    htfLongEma: c.htfLongEma ?? DEFAULT_CONFIG.htfLongEma,
    htfGateShort: c.htfGateShort ?? DEFAULT_CONFIG.htfGateShort,
    htfGateLong: c.htfGateLong ?? DEFAULT_CONFIG.htfGateLong,
    // Stored by ensureLayer2GateMigration ("4h") and by the panel; anything
    // unrecognised resolves to the measured default like everywhere else.
    htfTf: c.htfTf === "1h" ? "1h" : "4h",
    // BTC regime knobs (2026-10-25 fix — see the interface note): without
    // these three lines the allowlist dropped the stored values and both the
    // DOWN-BLOCK and the paper long-slope floor were dead code at runtime.
    btcRegimeEnabled: c.btcRegimeEnabled ?? DEFAULT_CONFIG.btcRegimeEnabled,
    btcRegimeDownBlock: c.btcRegimeDownBlock ?? DEFAULT_CONFIG.btcRegimeDownBlock,
    btcRegimeLongSlopeMin:
      c.btcRegimeLongSlopeMin ?? DEFAULT_CONFIG.btcRegimeLongSlopeMin,
    chopGateEnabled: c.chopGateEnabled ?? DEFAULT_CONFIG.chopGateEnabled,
    chopGatePeriod: c.chopGatePeriod ?? DEFAULT_CONFIG.chopGatePeriod,
    chopGateFloor: c.chopGateFloor ?? DEFAULT_CONFIG.chopGateFloor,
    chopGateFloorLong: c.chopGateFloorLong ?? DEFAULT_CONFIG.chopGateFloorLong,
    chopGateFloorShort: c.chopGateFloorShort ?? DEFAULT_CONFIG.chopGateFloorShort,
    atrFloorPct: c.atrFloorPct ?? DEFAULT_CONFIG.atrFloorPct,
    // null is a MEANINGFUL value here ("inherit the shared floor"), so it must
    // survive resolution — `?? default` on a stored null would have flipped the
    // per-side knob to the default and silently re-armed/disarmed a side.
    atrFloorPctLong: c.atrFloorPctLong === undefined ? DEFAULT_CONFIG.atrFloorPctLong : c.atrFloorPctLong,
    atrFloorPctShort: c.atrFloorPctShort === undefined ? DEFAULT_CONFIG.atrFloorPctShort : c.atrFloorPctShort,
    chaseGuardEnabled: c.chaseGuardEnabled ?? DEFAULT_CONFIG.chaseGuardEnabled,
    maxSignalDriftPct: c.maxSignalDriftPct ?? DEFAULT_CONFIG.maxSignalDriftPct,
    signalMaxAgeMin: c.signalMaxAgeMin ?? DEFAULT_CONFIG.signalMaxAgeMin,
    maxEmaStretchPct: c.maxEmaStretchPct ?? DEFAULT_CONFIG.maxEmaStretchPct,
    rsiLongGuard: c.rsiLongGuard ?? DEFAULT_CONFIG.rsiLongGuard,
    maxRsiLong: c.maxRsiLong ?? DEFAULT_CONFIG.maxRsiLong,
    // RSI pullback term (2026-09-21): mode is validated (an unknown stored
    // value falls back to "off", never to an armed state); the numbers pass
    // through so a stored band is honoured.
    rsiPullbackMode:
      c.rsiPullbackMode === "bonus" || c.rsiPullbackMode === "veto"
        ? c.rsiPullbackMode
        : DEFAULT_CONFIG.rsiPullbackMode,
    rsiPullbackPeriod: c.rsiPullbackPeriod ?? DEFAULT_CONFIG.rsiPullbackPeriod,
    rsiPullbackWeight: c.rsiPullbackWeight ?? DEFAULT_CONFIG.rsiPullbackWeight,
    rsiPullbackLongMin: c.rsiPullbackLongMin ?? DEFAULT_CONFIG.rsiPullbackLongMin,
    rsiPullbackLongMax: c.rsiPullbackLongMax ?? DEFAULT_CONFIG.rsiPullbackLongMax,
    rsiPullbackShortMin: c.rsiPullbackShortMin ?? DEFAULT_CONFIG.rsiPullbackShortMin,
    rsiPullbackShortMax: c.rsiPullbackShortMax ?? DEFAULT_CONFIG.rsiPullbackShortMax,
    breakerEnabled: c.breakerEnabled ?? DEFAULT_CONFIG.breakerEnabled,
    breakerMinWr: c.breakerMinWr ?? DEFAULT_CONFIG.breakerMinWr,
    breakerMaxDailyLossPct: c.breakerMaxDailyLossPct ?? DEFAULT_CONFIG.breakerMaxDailyLossPct,
    liveBreakerEnabled: c.liveBreakerEnabled ?? DEFAULT_CONFIG.liveBreakerEnabled,
    liveBreakerMaxLossStreak:
      c.liveBreakerMaxLossStreak ?? DEFAULT_CONFIG.liveBreakerMaxLossStreak,
    liveBreakerCooldownMin:
      c.liveBreakerCooldownMin ?? DEFAULT_CONFIG.liveBreakerCooldownMin,
    // Manual re-arm (2026-10-22): stored value wins; anything but an explicit
    // `false` resolves to the manual (disarm-until-re-armed) behaviour.
    liveBreakerManualReArm:
      c.liveBreakerManualReArm !== false,
    liveBreakerRearmOnSession:
      c.liveBreakerRearmOnSession !== false,
    // Session profitability breaker: numeric knobs pass through so an
    // operator can tune the window/sample/profit floor from the panel;
    // `enabled` resolves like every other switch (stored value wins).
    sessionBreakerEnabled:
      c.sessionBreakerEnabled ?? DEFAULT_CONFIG.sessionBreakerEnabled,
    sessionBreakerLookbackDays:
      c.sessionBreakerLookbackDays ?? DEFAULT_CONFIG.sessionBreakerLookbackDays,
    sessionBreakerMinTrades:
      c.sessionBreakerMinTrades ?? DEFAULT_CONFIG.sessionBreakerMinTrades,
    sessionBreakerMinProfitR:
      c.sessionBreakerMinProfitR ?? DEFAULT_CONFIG.sessionBreakerMinProfitR,
    // Coin priority: same pass-through shape as the session knobs.
    coinPriorityEnabled:
      c.coinPriorityEnabled ?? DEFAULT_CONFIG.coinPriorityEnabled,
    coinPriorityLookbackDays:
      c.coinPriorityLookbackDays ?? DEFAULT_CONFIG.coinPriorityLookbackDays,
    coinPriorityMinTrades:
      c.coinPriorityMinTrades ?? DEFAULT_CONFIG.coinPriorityMinTrades,
    coinPriorityBlockAvoid:
      c.coinPriorityBlockAvoid ?? DEFAULT_CONFIG.coinPriorityBlockAvoid,
    advisorEnabled: c.advisorEnabled ?? DEFAULT_CONFIG.advisorEnabled,
    advisorMode: c.advisorMode ?? DEFAULT_CONFIG.advisorMode,
    advisorVetoThreshold: c.advisorVetoThreshold ?? DEFAULT_CONFIG.advisorVetoThreshold,
    // Per-side thresholds: fall back to the RESOLVED shared threshold, so a
    // stored row that only ever set advisorVetoThreshold keeps both sides in
    // sync automatically.
    advisorLongThreshold:
      c.advisorLongThreshold ?? c.advisorVetoThreshold ?? DEFAULT_CONFIG.advisorVetoThreshold,
    advisorShortThreshold:
      c.advisorShortThreshold ?? c.advisorVetoThreshold ?? DEFAULT_CONFIG.advisorVetoThreshold,
    advisorDivergenceAgeBars: c.advisorDivergenceAgeBars ?? DEFAULT_CONFIG.advisorDivergenceAgeBars,
    advisorVwapExtremePct: c.advisorVwapExtremePct ?? DEFAULT_CONFIG.advisorVwapExtremePct,
    advisorRsiExtreme: c.advisorRsiExtreme ?? DEFAULT_CONFIG.advisorRsiExtreme,
    advisorStrongWeight: c.advisorStrongWeight ?? DEFAULT_CONFIG.advisorStrongWeight,
    advisorWeakWeight: c.advisorWeakWeight ?? DEFAULT_CONFIG.advisorWeakWeight,
    advisorMacdEnabled: c.advisorMacdEnabled ?? DEFAULT_CONFIG.advisorMacdEnabled,
    advisorMacdWeight: c.advisorMacdWeight ?? DEFAULT_CONFIG.advisorMacdWeight,
    advisorMacdFast: c.advisorMacdFast ?? DEFAULT_CONFIG.advisorMacdFast,
    advisorMacdSlow: c.advisorMacdSlow ?? DEFAULT_CONFIG.advisorMacdSlow,
    advisorMacdSignal: c.advisorMacdSignal ?? DEFAULT_CONFIG.advisorMacdSignal,
    advisorStochRsiEnabled: c.advisorStochRsiEnabled ?? DEFAULT_CONFIG.advisorStochRsiEnabled,
    advisorStochRsiRsiPeriod: c.advisorStochRsiRsiPeriod ?? DEFAULT_CONFIG.advisorStochRsiRsiPeriod,
    advisorStochRsiStochPeriod: c.advisorStochRsiStochPeriod ?? DEFAULT_CONFIG.advisorStochRsiStochPeriod,
    advisorStochRsiKSmooth: c.advisorStochRsiKSmooth ?? DEFAULT_CONFIG.advisorStochRsiKSmooth,
    advisorStochRsiDSmooth: c.advisorStochRsiDSmooth ?? DEFAULT_CONFIG.advisorStochRsiDSmooth,
    advisorStochRsiUseD: c.advisorStochRsiUseD ?? DEFAULT_CONFIG.advisorStochRsiUseD,
    // 1H advisor layer (2026-09-12): pass-through, `undefined` PRESERVED for
    // every override — unset means "blank = shared 4H value" at gate time.
    // Coercing these to numbers here would silently hard-code the shared
    // values and erase the "blank = shared" semantics the panel documents.
    advisor1hEnabled: c.advisor1hEnabled === true,
    advisor1hLongThreshold:
      typeof c.advisor1hLongThreshold === "number" ? c.advisor1hLongThreshold : undefined,
    advisor1hShortThreshold:
      typeof c.advisor1hShortThreshold === "number" ? c.advisor1hShortThreshold : undefined,
    advisor1hMacdWeight:
      typeof c.advisor1hMacdWeight === "number" ? c.advisor1hMacdWeight : undefined,
    advisor1hStochRsiRsiPeriod:
      typeof c.advisor1hStochRsiRsiPeriod === "number" ? c.advisor1hStochRsiRsiPeriod : undefined,
    advisor1hStochRsiStochPeriod:
      typeof c.advisor1hStochRsiStochPeriod === "number" ? c.advisor1hStochRsiStochPeriod : undefined,
    advisor1hDivergenceAgeBars:
      typeof c.advisor1hDivergenceAgeBars === "number" ? c.advisor1hDivergenceAgeBars : undefined,
    // Pass-through, `undefined` PRESERVED (unset = share advisorMode). A
    // fallback to DEFAULT_CONFIG.advisorMode here would silently pin the 1H
    // layer to "both" and make the panel's "shared" option a lie.
    advisor1hMode:
      c.advisor1hMode === "pair" || c.advisor1hMode === "btc" || c.advisor1hMode === "both"
        ? c.advisor1hMode
        : undefined,
    shortFlowGate: c.shortFlowGate ?? DEFAULT_CONFIG.shortFlowGate,
    longTrendGate: c.longTrendGate ?? DEFAULT_CONFIG.longTrendGate,
    stMode: c.stMode === "bonus" || c.stMode === "penalty" || c.stMode === "symmetric" ? c.stMode : DEFAULT_CONFIG.stMode,
    stWeight: c.stWeight ?? DEFAULT_CONFIG.stWeight,
    noEmaTerm: c.noEmaTerm ?? DEFAULT_CONFIG.noEmaTerm,
    stVeto: c.stVeto === "on" || c.stVeto === true ? "on" : c.stVeto === "shadow" ? "shadow" : DEFAULT_CONFIG.stVeto,
    shortTrendGate: c.shortTrendGate ?? DEFAULT_CONFIG.shortTrendGate,
    shortTakeProfitPct: c.shortTakeProfitPct ?? DEFAULT_CONFIG.shortTakeProfitPct,
    // R-lock (2026-09-20): numbers pass through with 0-preservation so a row
    // can disable the lock by storing 0 — `??` alone would resurrect the
    // default and the panel switch would silently do nothing.
    trailLockStartR:
      typeof c.trailLockStartR === "number" ? c.trailLockStartR : DEFAULT_CONFIG.trailLockStartR,
    trailLockStepR:
      typeof c.trailLockStepR === "number" && c.trailLockStepR > 0
        ? c.trailLockStepR
        : DEFAULT_CONFIG.trailLockStepR,
    trailLockMaxR:
      typeof c.trailLockMaxR === "number" && c.trailLockMaxR > 0
        ? c.trailLockMaxR
        : DEFAULT_CONFIG.trailLockMaxR,
    // A malformed stored row must never arm a lock whose max target is at or
    // below its start. Keep the lock off until the operator supplies a valid
    // ordered pair; the panel/backend reject the save with a precise reason.
    ...(rLockConfigError(c.trailLockStartR ?? DEFAULT_CONFIG.trailLockStartR, c.trailLockMaxR ?? DEFAULT_CONFIG.trailLockMaxR, c.trailLockStepR ?? DEFAULT_CONFIG.trailLockStepR)
      ? { trailLockStartR: 0 }
      : {}),
    // 2% HARD CEILING (Phase 7): a stored row can never smuggle a larger
    // size past the engines — see MAX_RISK_PCT_PER_TRADE in costs.ts.
    // No sizing-time default (2026-10): an unset riskPct stays NaN, and the
    // entry path skips the trade instead of sizing at 1%.
    riskPct: c.riskPct == null ? NaN : clampRiskPct(c.riskPct, NaN),
    maxSpreadPct: typeof c.maxSpreadPct === "number" ? c.maxSpreadPct : null,
    maxEntrySlippageBps: typeof c.maxEntrySlippageBps === "number" ? c.maxEntrySlippageBps : null,
    // Factor-exposure cap (2026-09-23): 0-preservation matters — `??` alone
    // would resurrect a non-zero default and the panel switch could never turn
    // the cap OFF again. Anything non-finite resolves to 0 (off).
    maxNetBtcBeta:
      typeof c.maxNetBtcBeta === "number" && Number.isFinite(c.maxNetBtcBeta)
        ? c.maxNetBtcBeta
        : DEFAULT_CONFIG.maxNetBtcBeta,
    // H4 QUALITY GATES (2026-09-23): default-ON (the lab-measured posture the
    // user keeps on both books) — only an EXPLICIT stored false turns a block
    // off. rsiHeatMax keeps 0-preservation (0 = off) with the lab default 80.
    // These MUST be mapped here: resolveConfig's literal otherwise strips the
    // fields and the engine's toggles become dead knobs (found by audit).
    h4VolClimaxBlock: c.h4VolClimaxBlock !== false,
    h4PullbackBigBlock: c.h4PullbackBigBlock !== false,
    h4PullbackDeadBlock: c.h4PullbackDeadBlock !== false,
    rsiHeatMax:
      typeof c.rsiHeatMax === "number" && Number.isFinite(c.rsiHeatMax)
        ? c.rsiHeatMax
        : DEFAULT_CONFIG.rsiHeatMax,
    // LTF 5m gate: default-ON (only an explicit stored false turns it off).
    ltf5mGateEnabled: c.ltf5mGateEnabled !== false,
  };
}

/**
 * Resolve the paper-book config. Funding is currently DISABLED ("off") for
 * the paper book: the sign-strict agreement test was parked on 2026-09-08
 * because prevailing positive funding vetoed LONGs on most of the universe,
 * structurally starving the long side. Flip this to "strict" (or "bonus")
 * to re-enable the funding test on paper; live keeps its own policy.
 */
export function resolvePaperConfig(record: Record<string, any> | null | undefined): StrategyConfig {
  return { ...resolveConfig(record), fundingMode: "off" };
}

/**
 * Convert a Layer 1 funding snapshot into an entry-safe value. A numeric zero
 * is a valid neutral funding rate only when the snapshot explicitly says the
 * fetch succeeded; missing validity fails closed instead of becoming neutral.
 */
export function resolveFundingRate(rate: unknown, valid: unknown): number | undefined {
  if (valid !== true || typeof rate !== "number" || !Number.isFinite(rate)) return undefined;
  return rate;
}

// ── GATE REACHABILITY (2026-09-22) ──────────────────────────────────────────
/** Lowest score margin observed over the 5,054-setup L1 replay (backtest:2sided). */
export const MIN_GAP_OBSERVED_FLOOR = 2.03;

/**
 * A threshold that can never be crossed is worse than no threshold: it reads
 * like a safety net while doing nothing, and it hides the fact that nobody ever
 * measured it. `minGap` is the live example — see the DEFAULT_CONFIG note.
 *
 * This REPORTS, it never auto-corrects. Raising `minGap` above the floor would
 * silently change which trades the book takes, and the margin it gates on is
 * not predictive (day-paired t = +0.43, sign-flipping between halves), so any
 * such value would be unvalidated tuning. Callers surface these to the operator.
 */
export function gateReachabilityWarnings(cfg: StrategyConfig): string[] {
  const warnings: string[] = [];
  if (cfg.minGap > 0 && cfg.minGap < MIN_GAP_OBSERVED_FLOOR) {
    warnings.push(
      `minGap ${cfg.minGap} is below the observed score-margin floor (${MIN_GAP_OBSERVED_FLOOR} over 5,054 setups) and can never bind — the requirement is a no-op.`,
    );
  }
  return warnings;
}

/**
 * 1H trend classification for the HTF gates — PRICE-VS-EMA rule (2026-09-11,
 * user spec): the last CLOSED 1h close vs EMA(period) over the most recent
 * <=60 closed 1h closes.
 *   "up"   = close ABOVE the EMA  → LONG allowed, SHORT vetoed
 *   "down" = close BELOW the EMA  → SHORT allowed, LONG vetoed
 *   "flat" = exactly equal        → both allowed
 * Returns undefined when there is not enough history (callers treat undefined
 * as "allow" — fail-open). This replaces the earlier EMA-slope rule
 * (EMA vs prior close): under slope semantics a sharp dip could leave the
 * slow EMA still rising (long allowed with price far under the EMA) and a
 * recovery bounce could still read "down" (long blocked above the EMA).
 * The price-vs-EMA rule matches the strategy's 4H-filter wording: "only
 * allow long entries if price is above the higher-TF EMA".
 *
 * EMA seeds on win[0], so periods approaching the 60-bar window carry seed
 * lag (fades as (1-k)^n); the EMA-30 convergence test pins <0.05% error.
 */
/** Raw HTF inputs: the EMA value and the newest close it is compared with.
 *  Split out so the bar-guarded cache (convex/htfCache.ts) can persist exactly
 *  what the verdict is derived from — one comparison, no chance of drift. */
export function htfTrendRawFromCloses(
  closes: number[],
  period: number,
): { ema: number; close: number } | undefined {
  const win = closes.length > 60 ? closes.slice(-60) : closes;
  if (win.length < 20) return undefined;
  const k = 2 / (period + 1);
  let value = win[0];
  for (let i = 1; i < win.length; i++) value = win[i] * k + value * (1 - k);
  const lastClose = win[win.length - 1];
  if (lastClose == null) return undefined;
  return { ema: value, close: lastClose };
}

export function htfTrendFromCloses(closes: number[], period: number): "up" | "down" | "flat" | undefined {
  const raw = htfTrendRawFromCloses(closes, period);
  if (!raw) return undefined;
  return raw.ema > raw.close ? "down" : raw.ema < raw.close ? "up" : "flat";
}

// ── EMA (kept local so this module is fully self-contained) ──

export function ema(data: number[], period: number): number[] {
  const result: number[] = [];
  const k = 2 / (period + 1);
  let prev = data[0];
  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      result.push(data[0]);
    } else {
      prev = data[i] * k + prev * (1 - k);
      result.push(prev);
    }
  }
  return result;
}

// ── Scoring ──

export interface SignalResult {
  side: "LONG" | "SHORT" | null;
  longScore: number;
  shortScore: number;
  reasons: string[];
  blockers: string[];
  emaFast: number;
  emaSlow: number;
  longFundingBlocked: boolean;
  shortFundingBlocked: boolean;
  stretchBlocked: boolean; // EMA-stretch CEILING veto fired (side forced to null)
  rsiLongBlocked: boolean; // RSI(7) wick-guard veto fired (long side only)
  rsiPullbackBlocked: boolean; // RSI pullback band veto fired (either side)
  trendBlocked: boolean;   // hard EMA trend gate fired (either side)
  atrFloorBlocked: boolean; // 15m ATR% volatility floor fired (either side)
  streakBlocked: boolean;  // chase-streak veto fired (either side, 2026-10-03)
  stVetoBlocked: boolean;  // SuperTrend-disagreement veto fired (2026-10-11, off by default)
  stShadowHit: boolean;   // shadow mode tagged a would-block (side still taken)
  // ── DECISION-RECORD BREAKDOWN (2026-10-10, record-only) ────────────────
  // The scoring pass already computes every component on its way to the two
  // totals; these fields hand that arithmetic to the candidate log so a report
  // can attribute a score to its parts WITHOUT re-deriving any rule. Purely
  // additive: nothing reads them to decide, and the totals above are unchanged.
  components: ScoreComponent[];
  detail: SignalDetail;
}

/** One score term, with the exact points it added to each side's total. */
export interface ScoreComponent {
  k:
    | "ema"      // EMA fast vs slow (+16 / -10 cross-term)
    | "gap"      // separation bonus (+6 to the agreeing side)
    | "book"     // order-book imbalance (imbalance x bookWeight)
    | "flow"     // trade-flow bias (flowBias x flowWeight)
    | "funding"  // funding bonus (bonus mode only; strict/off contribute 0)
    | "spread"   // spread quality (+4 tight / -14 wide to BOTH sides)
    | "atrSpike" // anti-chase spike penalty (-28 to both, when fired)
    | "volume"   // missing-volume penalty (-20 to both, when fired)
    | "rsiBand" // RSI pullback bonus (agreeing side only)
    | "st"; // SuperTrend chart-trend term (lab-only, off by default)
  /** Points added to the LONG total by this term. */
  long: number;
  /** Points added to the SHORT total by this term. */
  short: number;
  /** The underlying value (null = no reading). */
  v: number | null;
}

/** Numeric values behind the scoring pass's vetoes, for the candidate log. */
export interface SignalDetail {
  emaGapPct: number;
  longStretchPct: number;
  shortStretchPct: number;
  rsi7: number | null;
  rsiPullback: number | null;
  atrPct15m: number;
  /** Consecutive same-direction closes at decision (per side). */
  longStreak: number;
  shortStreak: number;
  /** The funding rate the scoring pass actually used (null = missing). */
  fundingRate: number | null;
}

/**
 * CHASE-STREAK VETO (2026-10-03, both books, HARDCODED — Mech-4 PASS).
 * Blocks a side when the just-closed signal bar extends a run of >= N
 * consecutive same-direction closes in the side's own direction: LONG after 4
 * straight higher closes (buying the top of the run), SHORT after 4 straight
 * lower closes. Deliberately NOT a config knob: the A/B plateau holds at
 * N=3/4/5 (day-paired t +2.18/+2.58/+3.11, same-sign time halves), so a tunable
 * threshold would invite the exact single-threshold overfit this project
 * rejects — the constant ships the validated middle. Measured on the 20-day L1
 * replay (mech4-anti-chase.ts): vetoed cohort 370 setups @ -0.080 R/t, WR
 * 34.3% on BOTH sides; the arm gains +147R net by deleting losers, not by
 * adding winners. Pure closed-candle read (no L1, no future) — see
 * ANTI_CHASE_JOURNAL.md. Equal closes break the run (a pause is not a chase).
 */
export const CHASE_STREAK_VETO_N = 4;

/** Consecutive same-direction closes ending at the decision bar. 0 when unknown. */
export function streakLength(closes: readonly number[], side: "LONG" | "SHORT" | null): number {
  if (side !== "LONG" && side !== "SHORT") return 0;
  let run = 0;
  for (let k = closes.length - 1; k >= 1; k--) {
    const c = closes[k]!;
    const p = closes[k - 1]!;
    if (side === "LONG" ? c > p : c < p) run++;
    else break;
  }
  return run;
}

export function streakVetoBlocks(closes: readonly number[], side: "LONG" | "SHORT" | null): boolean {
  return streakLength(closes, side) >= CHASE_STREAK_VETO_N;
}

export function computeLayer2Signal(
  closes: number[],
  imbalance: number,
  flowBias: number,
  fundingRate: number | null | undefined,
  atrPct: number,
  // ATR% of the DECISION TIMEFRAME (15m) — a DIFFERENT quantity from `atrPct`,
  // which is the Layer-1 tick's 1m read (marketData fetches 1m klines; the
  // stored value across all 30 pairs is 0.057–0.391, median 0.205, vs ~0.5–1.6
  // for the same pairs on 15m). Required on purpose: the volatility floor is
  // calibrated on 15m ATR% (src/lib/vol-floor.ts), and an earlier version of
  // this gate read `atrPct` — which silently placed a 0.60 floor ABOVE every
  // pair's reading and would have blacked out all longs. TypeScript now forces
  // every caller to state which ATR it means.
  atrPct15m: number,
  candleRangePct: number,
  spreadPct: number,
  vol24h: number,
  cfg: StrategyConfig,
  // Optional aligned chart-TF highs/lows (same length/order as closes) for
  // the lab-only SuperTrend term. Omitted by production callers; without it
  // the term pushes zeros and scoring is unchanged.
  ohl?: { high: number[]; low: number[] },
): SignalResult {
  let longScore = 0;
  let shortScore = 0;
  const reasons: string[] = [];
  const blockers: string[] = [];
  // DECISION-RECORD BREAKDOWN (2026-10-10): the exact per-term points that
  // built the two totals above. Record-only — every push mirrors an existing
  // score mutation on the line below it.
  const components: ScoreComponent[] = [];

  // 1. EMA Momentum — computed on 15m closes
  const emaFastArr = ema(closes, cfg.emaFast);
  const emaSlowArr = ema(closes, cfg.emaSlow);
  const emaFastVal = emaFastArr[emaFastArr.length - 1] ?? 0;
  const emaSlowVal = emaSlowArr[emaSlowArr.length - 1] ?? 0;

  if (cfg.noEmaTerm) {
    components.push({ k: "ema", long: 0, short: 0, v: emaFastVal - emaSlowVal });
  } else if (emaFastVal > emaSlowVal) {
    longScore += 16;
    shortScore -= 10;
    components.push({ k: "ema", long: 16, short: -10, v: emaFastVal - emaSlowVal });
    reasons.push(`EMA${cfg.emaFast} > EMA${cfg.emaSlow} (bullish momentum)`);
  } else if (emaFastVal < emaSlowVal) {
    shortScore += 16;
    longScore -= 10;
    components.push({ k: "ema", long: -10, short: 16, v: emaFastVal - emaSlowVal });
    reasons.push(`EMA${cfg.emaFast} < EMA${cfg.emaSlow} (bearish momentum)`);
  } else {
    components.push({ k: "ema", long: 0, short: 0, v: 0 });
  }

  // 1b. SuperTrend chart-trend term (lab-only, off by default — see config).
  // Computed on the SAME closed bars the scorer already sees (ohl must align
  // 1:1 with closes); the 400-bar production window satisfies the ST ready
  // gate internally. Always pushes exactly one "st" component (zeros when
  // inactive) so attribution shape never depends on the flag.
  // Hoisted for the stVeto gate below: the trend is MEASURED whenever the
  // read exists (record-only via the "st" component), APPLIED to the score
  // only under stMode/stWeight, and ENFORCED only under stVeto.
  let stTrendVeto: number | null = null;
  {
    const ohlOk =
      ohl != null &&
      Array.isArray(ohl.high) &&
      Array.isArray(ohl.low) &&
      ohl.high.length === closes.length &&
      ohl.low.length === closes.length &&
      closes.length > 30;
    let stTrend: number | null = null;
    if (ohlOk) {
      const st = stSeries({ t: [], o: [], h: ohl.high, l: ohl.low, c: closes });
      stTrend = st.trend[st.trend.length - 1] ?? null;
      stTrendVeto = stTrend;
    }
    const W = cfg.stWeight;
    let stLong = 0;
    let stShort = 0;
    if (stTrend !== null && W !== 0) {
      if (cfg.stMode === "bonus") {
        if (stTrend === 1) stLong = W;
        else if (stTrend === -1) stShort = W;
      } else if (cfg.stMode === "penalty") {
        if (stTrend === -1) stLong = -W;
        else if (stTrend === 1) stShort = -W;
      } else if (cfg.stMode === "symmetric") {
        if (stTrend === 1) { stLong = W / 2; stShort = -W / 2; }
        else if (stTrend === -1) { stLong = -W / 2; stShort = W / 2; }
      }
    }
    longScore += stLong;
    shortScore += stShort;
    components.push({ k: "st", long: stLong, short: stShort, v: stTrend });
    if (stLong !== 0 || stShort !== 0) {
      reasons.push(`SuperTrend chart trend ${stTrend === 1 ? "up" : "down"} (${cfg.stMode} ${W})`);
    }
  }

  // Strong separation
  const emaGapPct = emaSlowVal > 0 ? ((emaFastVal - emaSlowVal) / emaSlowVal) * 100 : 0;
  if (emaGapPct > cfg.gapThreshold) {
    longScore += 6;
    components.push({ k: "gap", long: 6, short: 0, v: emaGapPct });
    reasons.push(`Strong bullish EMA gap (${emaGapPct.toFixed(3)}%)`);
  } else if (emaGapPct < -cfg.gapThreshold) {
    shortScore += 6;
    components.push({ k: "gap", long: 0, short: 6, v: emaGapPct });
    reasons.push(`Strong bearish EMA gap (${emaGapPct.toFixed(3)}%)`);
  } else {
    components.push({ k: "gap", long: 0, short: 0, v: emaGapPct });
  }

  // 2. Order Book Imbalance (from Layer 1)
  const imbScore = imbalance * cfg.bookWeight;
  longScore += imbScore;
  shortScore -= imbScore;
  components.push({ k: "book", long: imbScore, short: -imbScore, v: imbalance });
  reasons.push(`Book imbalance: ${imbalance.toFixed(2)}`);

  // 3. Trade Flow Bias (from Layer 1)
  const flowScore = flowBias * cfg.flowWeight;
  longScore += flowScore;
  shortScore -= flowScore;
  components.push({ k: "flow", long: flowScore, short: -flowScore, v: flowBias });
  reasons.push(`Flow bias: ${flowBias.toFixed(2)}`);

  // 4. Funding (from Layer 1). Three policies:
  //    - "off"    (paper, current): ignored — no veto, no score bonus.
  //    - "strict": agreement required; a missing/invalid rate blocks BOTH
  //      sides because the Layer 1 fetcher uses 0 as its safe numeric
  //      fallback — callers must pass undefined when the fetch was not valid
  //      so neutral 0 is never confused with missing data.
  //    - "bonus"  (live): small aligned score bonus, no veto.
  let longFundingBlocked = false;
  let shortFundingBlocked = false;
  const rate =
    typeof fundingRate === "number" && Number.isFinite(fundingRate)
      ? fundingRate
      : undefined;
  if (cfg.fundingMode === "off") {
    // Funding parked (2026-09-08): ignored entirely — no veto, no bonus.
    components.push({ k: "funding", long: 0, short: 0, v: rate ?? null });
  } else if (cfg.fundingMode === "strict") {
    if (rate == null) {
      longFundingBlocked = true;
      shortFundingBlocked = true;
      blockers.push("Funding rate unavailable");
      reasons.push("No valid perpetual funding rate");
    } else if (rate > 0) {
      longFundingBlocked = true;
      reasons.push(`Funding veto for LONG (${rate.toFixed(5)})`);
    } else if (rate < 0) {
      shortFundingBlocked = true;
      reasons.push(`Funding veto for SHORT (${rate.toFixed(5)})`);
    } else {
      reasons.push("Funding is neutral (both sides allowed)");
    }
    components.push({ k: "funding", long: 0, short: 0, v: rate ?? null });
  } else if (rate != null && rate <= -cfg.fundingBonusThreshold) {
    longScore += cfg.fundingWeight;
    components.push({ k: "funding", long: cfg.fundingWeight, short: 0, v: rate });
    reasons.push(`Aligned LONG funding bonus (${rate.toFixed(5)})`);
  } else if (rate != null && rate >= cfg.fundingBonusThreshold) {
    shortScore += cfg.fundingWeight;
    components.push({ k: "funding", long: 0, short: cfg.fundingWeight, v: rate });
    reasons.push(`Aligned SHORT funding bonus (${rate.toFixed(5)})`);
  } else {
    components.push({ k: "funding", long: 0, short: 0, v: rate ?? null });
  }

  // 5. Spread Quality (from Layer 1)
  if (spreadPct < cfg.spreadTight) {
    longScore += 4;
    shortScore += 4;
    components.push({ k: "spread", long: 4, short: 4, v: spreadPct });
    reasons.push(`Tight spread (${spreadPct.toFixed(3)}%)`);
  } else if (spreadPct > cfg.spreadWide) {
    longScore -= 14;
    shortScore -= 14;
    components.push({ k: "spread", long: -14, short: -14, v: spreadPct });
    blockers.push("Spread is wide");
    reasons.push(`Wide spread (${spreadPct.toFixed(3)}%)`);
  } else {
    components.push({ k: "spread", long: 0, short: 0, v: spreadPct });
  }

  // 6. ATR Spike / Anti-FOMO (from Layer 1)
  if (atrPct > 0) {
    const spikeRatio = candleRangePct / atrPct;
    if (spikeRatio > cfg.atrSpikeMult) {
      longScore -= 28;
      shortScore -= 28;
      components.push({ k: "atrSpike", long: -28, short: -28, v: spikeRatio });
      blockers.push("Entry bar is an ATR spike — likely a chase");
      reasons.push(`ATR spike: candle ${candleRangePct.toFixed(2)}% vs ATR ${atrPct.toFixed(2)}% (ratio: ${spikeRatio.toFixed(1)}x)`);
    } else {
      components.push({ k: "atrSpike", long: 0, short: 0, v: spikeRatio });
    }
  } else {
    components.push({ k: "atrSpike", long: 0, short: 0, v: null });
  }

  // 7. Volume Check (from Layer 1)
  if (!vol24h || vol24h <= 0) {
    longScore -= 20;
    shortScore -= 20;
    components.push({ k: "volume", long: -20, short: -20, v: vol24h || null });
    blockers.push("Missing 24h volume");
    reasons.push("No valid 24h volume data");
  } else {
    components.push({ k: "volume", long: 0, short: 0, v: vol24h });
  }

  // 7b. EMA-stretch veto (2026-09-09): price vs the fast EMA on the just-
  // closed candle — the "bot chased the breakout" guard. Per-side: a
  // stretched-up LONG must never block the SHORT side (and vice versa), so
  // this is a side-specific veto like funding, not a shared blocker.
  const lastClose = closes[closes.length - 1] ?? 0;
  const longStretchPct =
    emaFastVal > 0 && lastClose > 0 ? ((lastClose - emaFastVal) / emaFastVal) * 100 : 0;
  const shortStretchPct =
    emaFastVal > 0 && lastClose > 0 ? ((emaFastVal - lastClose) / emaFastVal) * 100 : 0;
  const stretchEnabled = cfg.maxEmaStretchPct > 0;

  // RSI(7) wick guard (2026-09-09, LONG side only): WILDER-smoothed RSI over
  // the full closed-15m series, anchored to the last closed bar. Long-only
  // because the measured short-side mirror blocked profitable trades (see
  // config docs). (2026-09-10 audit: this was a simple 7-bar window mean
  // (Cutler-style) while BOTH validating backtests replayed Wilder smoothing
  // — the 78 threshold is calibrated to Wilder, so the engine now matches it
  // exactly. Same O(n) cost; the (6/7)^k seed decay makes the 400-bar series
  // indistinguishable from the backtests' 1000-bar replay.)
  let rsi7: number | null = null;
  if (closes.length >= 8) {
    let avgG = 0;
    let avgL = 0;
    for (let i = 1; i <= 7 && i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      if (ch >= 0) avgG += ch;
      else avgL -= ch;
    }
    avgG /= 7;
    avgL /= 7;
    for (let i = 8; i < closes.length; i++) {
      const ch = closes[i] - closes[i - 1];
      avgG = (avgG * 6 + Math.max(ch, 0)) / 7;
      avgL = (avgL * 6 + Math.max(-ch, 0)) / 7;
    }
    rsi7 = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
  }

  // 7c. RSI pullback term (2026-09-21). Read on the SAME closed candle as
  // every other term, so the reading is knowable at decision time. The bonus
  // is credited to the side the trend agrees with, which keeps the two bands
  // from paying for one RSI value at once when they overlap.
  const rsiPbPeriod = cfg.rsiPullbackPeriod > 1 ? cfg.rsiPullbackPeriod : 14;
  const rsiPb =
    cfg.rsiPullbackMode === "off" ? null : wilderRsi(closes, rsiPbPeriod);
  const longInBand =
    rsiPb != null && rsiPb >= cfg.rsiPullbackLongMin && rsiPb <= cfg.rsiPullbackLongMax;
  const shortInBand =
    rsiPb != null && rsiPb >= cfg.rsiPullbackShortMin && rsiPb <= cfg.rsiPullbackShortMax;
  if (cfg.rsiPullbackMode === "bonus" && cfg.rsiPullbackWeight !== 0 && rsiPb != null) {
    if (longInBand && emaFastVal > emaSlowVal) {
      longScore += cfg.rsiPullbackWeight;
      components.push({ k: "rsiBand", long: cfg.rsiPullbackWeight, short: 0, v: rsiPb });
      reasons.push(`RSI(${rsiPbPeriod}) ${rsiPb.toFixed(1)} in pullback band [${cfg.rsiPullbackLongMin}-${cfg.rsiPullbackLongMax}] (+${cfg.rsiPullbackWeight})`);
    }
    if (shortInBand && emaFastVal < emaSlowVal) {
      shortScore += cfg.rsiPullbackWeight;
      components.push({ k: "rsiBand", long: 0, short: cfg.rsiPullbackWeight, v: rsiPb });
      reasons.push(`RSI(${rsiPbPeriod}) ${rsiPb.toFixed(1)} in pullback band [${cfg.rsiPullbackShortMin}-${cfg.rsiPullbackShortMax}] (+${cfg.rsiPullbackWeight})`);
    }
  }

  // Determine side
  let side: "LONG" | "SHORT" | null = null;
  let stretchBlocked = false;
  let rsiLongBlocked = false;
  let rsiPullbackBlocked = false;
  let trendBlocked = false;
  let atrFloorBlocked = false;
  let streakBlocked = false;
  if (longScore >= cfg.minScore && longScore >= shortScore + cfg.minGap && blockers.length === 0 && !longFundingBlocked) {
    side = "LONG";
  } else if (shortScore >= cfg.minScore && shortScore >= longScore + cfg.minGap && blockers.length === 0 && !shortFundingBlocked) {
    side = "SHORT";
  }
  // HARD EMA TREND GATES (2026-09-10) run FIRST — they are the structural
  // veto the stretch/RSI guards assume (those fire on the symptom of a bad
  // entry, these on the cause). Ties block: LONG needs emaFast > emaSlow,
  // SHORT needs emaFast < emaSlow — both strict.
  if (side === "LONG" && cfg.longTrendGate && emaFastVal <= emaSlowVal) {
    reasons.push(`EMA${cfg.emaFast} <= EMA${cfg.emaSlow} — hard trend gate blocks LONG (no score compensation)`);
    side = null;
    trendBlocked = true;
  }
  // SHORT mirror (2026-09-10, user decision): SHORT requires emaFast <
  // emaSlow strictly — the same structural requirement as the long leg.
  if (side === "SHORT" && cfg.shortTrendGate && emaFastVal >= emaSlowVal) {
    reasons.push(`EMA${cfg.emaFast} >= EMA${cfg.emaSlow} — hard trend gate blocks SHORT (no score compensation)`);
    side = null;
    trendBlocked = true;
  }
  // CHASE-STREAK VETO (2026-10-03, Mech-4 PASS): runs AFTER the trend gates
  // (a counter-trend chase is already dead) and BEFORE stretch/RSI, so a
  // streak-chase reports its own cause rather than the distance symptom.
  if (side !== null && streakVetoBlocks(closes, side)) {
    reasons.push(
      side === "LONG"
        ? `${CHASE_STREAK_VETO_N} straight higher closes — chase-streak veto blocks LONG (buying the top of the run)`
        : `${CHASE_STREAK_VETO_N} straight lower closes — chase-streak veto blocks SHORT (selling the bottom of the run)`,
    );
    side = null;
    streakBlocked = true;
  }
  if (side === "LONG" && stretchEnabled && longStretchPct > cfg.maxEmaStretchPct) {
    reasons.push(`Price ${longStretchPct.toFixed(2)}% above EMA${cfg.emaFast} — over-extended (max ${cfg.maxEmaStretchPct}%)`);
    side = null;
    stretchBlocked = true;
  }
  // RSI guard runs AFTER the stretch veto so a stretched entry reports the
  // distance veto (primary cause) rather than the RSI symptom.
  if (side === "LONG" && cfg.rsiLongGuard && cfg.maxRsiLong > 0 && rsi7 != null && rsi7 > cfg.maxRsiLong) {
    reasons.push(`RSI(7) ${rsi7.toFixed(1)} > ${cfg.maxRsiLong} — blow-off wick, long blocked`);
    side = null;
    rsiLongBlocked = true;
  }
  // RSI pullback band veto (2026-09-21, mode="veto"): a side is blocked when
  // its own 15m RSI sits OUTSIDE its band. Applied after the stretch/wick
  // vetoes so the more specific cause is the one reported.
  if (cfg.rsiPullbackMode === "veto" && side === "LONG" && rsiPb != null && !longInBand) {
    reasons.push(`RSI(${rsiPbPeriod}) ${rsiPb.toFixed(1)} outside LONG pullback band [${cfg.rsiPullbackLongMin}-${cfg.rsiPullbackLongMax}] — entry blocked`);
    side = null;
    rsiPullbackBlocked = true;
  } else if (cfg.rsiPullbackMode === "veto" && side === "SHORT" && rsiPb != null && !shortInBand) {
    reasons.push(`RSI(${rsiPbPeriod}) ${rsiPb.toFixed(1)} outside SHORT pullback band [${cfg.rsiPullbackShortMin}-${cfg.rsiPullbackShortMax}] — entry blocked`);
    side = null;
    rsiPullbackBlocked = true;
  }
  if (side === "SHORT" && stretchEnabled && shortStretchPct > cfg.maxEmaStretchPct) {
    reasons.push(`Price ${shortStretchPct.toFixed(2)}% below EMA${cfg.emaFast} — over-extended (max ${cfg.maxEmaStretchPct}%)`);
    side = null;
    stretchBlocked = true;
  }
  // 15m VOLATILITY FLOOR (2026-09-27) runs LAST, after every setup-quality
  // veto, so a trade already rejected for a specific cause keeps reporting
  // that cause and this gate is only ever responsible for blocks nothing else
  // caught. Same placement rationale as the RSI pullback band above.
  if (side) {
    const vf = volFloorBlocks(atrPct15m, cfg, side);
    if (vf.blocked) {
      reasons.push(
        Number.isFinite(atrPct15m) && atrPct15m > 0
          ? `15m ATR ${atrPct15m.toFixed(2)}% below the ${vf.floor}% volatility floor — dead tape, ${side} blocked`
          : `15m ATR unreadable (${String(atrPct15m)}) with a ${vf.floor}% volatility floor armed — ${side} blocked (fail-closed)`,
      );
      side = null;
      atrFloorBlocked = true;
    }
  }
  // SUPERTREND VETO (ships OFF): runs after every other veto so a trade it
  // touches is one nothing else caught — the incrementality the A/B measures.
  let stVetoBlocked = false;
  let stShadowHit = false;
  if (side && cfg.stVeto !== "off" && stTrendVeto !== null) {
    const want = side === "LONG" ? 1 : -1;
    if (stTrendVeto !== want) {
      if (cfg.stVeto === "on") {
        reasons.push(
          `SuperTrend chart trend ${stTrendVeto === 1 ? "up" : "down"} opposes ${side} — ST-disagreement veto blocks entry`,
        );
        side = null;
        stVetoBlocked = true;
      } else {
        reasons.push(
          `SuperTrend chart trend ${stTrendVeto === 1 ? "up" : "down"} opposes ${side} — ST shadow tags (side still taken)`,
        );
        stShadowHit = true;
      }
    }
  }

  // DECISION-RECORD DETAIL (2026-10-10): the raw values behind the flags
  // above, captured where they were computed so the candidate log never has to
  // re-derive a rule. Record-only.
  const detail: SignalDetail = {
    emaGapPct,
    longStretchPct,
    shortStretchPct,
    rsi7,
    rsiPullback: rsiPb,
    atrPct15m,
    longStreak: streakLength(closes, "LONG"),
    shortStreak: streakLength(closes, "SHORT"),
    fundingRate: rate ?? null,
  };

  return {
    side,
    longScore,
    shortScore,
    reasons,
    blockers,
    emaFast: emaFastVal,
    emaSlow: emaSlowVal,
    longFundingBlocked,
    shortFundingBlocked,
    stretchBlocked,
    rsiLongBlocked,
    rsiPullbackBlocked,
    trendBlocked,
    atrFloorBlocked,
    streakBlocked,
    stVetoBlocked,
    stShadowHit,
    components,
    detail,
  };
}

// ── Chase guard (live-only, pure) ──
//
// Records the FIRST signal per pair while the live position cap blocks
// entries, so that when a slot frees the engine can refuse to chase a setup
// whose price has run away from the original signal. Anchor semantics:
//   - LONG  : price must not be MORE than maxSignalDriftPct ABOVE the anchor
//     (a pullback below the anchor is favorable and always allowed).
//   - SHORT : price must not be MORE than maxSignalDriftPct BELOW the anchor
//     (a bounce above the anchor is favorable and always allowed).
//   - Anchors older than signalMaxAgeMin are stale — drop them regardless of
//     price (the setup no longer exists even if price hasn't moved).
//   - A pending anchor whose side differs from the current signal is NOT a
//     guard (the pair flipped direction — the caller re-anchors on the new
//     side's first signal).

export interface PendingSignal {
  side: "LONG" | "SHORT";
  price: number; // first signal price (anchor)
  time: number;  // first signal bar close time (ms)
}

export interface ChaseGuardResult {
  allow: boolean;
  reason: "no-pending" | "ok" | "stale" | "drift";
  driftPct?: number; // adverse drift vs anchor, % (only when a pending existed)
  ageMin?: number;   // anchor age in minutes (only when a pending existed)
}

export function evaluateChaseGuard(
  pending: PendingSignal | null | undefined,
  side: "LONG" | "SHORT",
  currentPrice: number,
  now: number,
  cfg: StrategyConfig,
): ChaseGuardResult {
  if (!pending) return { allow: true, reason: "no-pending" };
  // Opposite-side anchor is stale by construction — the pair flipped. Let the
  // caller re-anchor on this side's first signal.
  if (pending.side !== side) return { allow: true, reason: "no-pending" };
  const ageMin = (now - pending.time) / 60_000;
  if (ageMin > cfg.signalMaxAgeMin) return { allow: false, reason: "stale", ageMin };
  if (!(currentPrice > 0) || !(pending.price > 0)) {
    return { allow: false, reason: "drift", driftPct: Number.POSITIVE_INFINITY, ageMin };
  }
  const driftPct =
    side === "LONG"
      ? ((currentPrice - pending.price) / pending.price) * 100 // adverse = price ran UP
      : ((pending.price - currentPrice) / pending.price) * 100; // adverse = price fell
  if (driftPct > cfg.maxSignalDriftPct) return { allow: false, reason: "drift", driftPct, ageMin };
  return { allow: true, reason: "ok", driftPct, ageMin };
}

/**
 * Re-anchor rule for the pending map: keep the FIRST signal of the current
 * side. Only replace when there is no anchor yet, the side flipped, or the
 * existing anchor is stale — a newer (worse) price must never move the
 * reference the guard compares against.
 */
export function mergePendingSignal(
  map: Map<string, PendingSignal>,
  coin: string,
  pending: PendingSignal,
  cfg: StrategyConfig,
  now: number,
): void {
  const cur = map.get(coin);
  if (!cur || cur.side !== pending.side || now - cur.time > cfg.signalMaxAgeMin * 60_000) {
    map.set(coin, pending);
  }
}
