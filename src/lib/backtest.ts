import type { Kline, Signal, Trade, BacktestResult } from "./types";
import { scanForSignals, scanReversalSignals, calculateEMA, calculateMACD, checkEma3mFilter, type FilterType, type HtfFilterOptions } from "./strategy";
import { scanDisplacementSignals, DISPLACEMENT_DEFAULTS } from "./displacement";
import { rsiSeries } from "./htf-advisor";
import { COSTS, clampRiskFrac } from "./costs";
import { rLockBarStep, rLockEnabled } from "./r-lock";
import { deferSignals, type DeferralConfig } from "./deferred-entry";

export interface BacktestConfig {
  pivotLookback: number;
  /** "structure" (default) = EMA break first, then HL/LH confirms.
   *  "reversal" = failed lower-low/higher-high first, then EMA break triggers
   *  (the trendline-breakout reversal pattern, left-only pivots). */
  variant?: "structure" | "reversal";
  /** SIGNAL CORE (2026-09-22).
   *  "momentum"     — the shipped core (scanForSignals / scanReversalSignals).
   *  "displacement" — the Market Structure Shift core: the same EMA-break +
   *                   HL/LH sequence, but the HL/LH must displace through the
   *                   prior opposite pivot by `kAtr` x ATR(14) before it
   *                   counts (src/lib/displacement.ts).
   *  ⚠ A displacement signal is stamped at its STRUCTURE-BREAK bar, which is
   *  already causal, so pair it with `confirmLag: false` — the default
   *  pivot-lag would charge the entry an extra `pivotLookback` bars the core
   *  has already waited out. */
  signalCore?: "momentum" | "displacement";
  /** displacement: minimum leg amplitude in ATR units (the one knob). */
  kAtr?: number;
  /** displacement: when the leg must have displaced — see
   *  DisplacementOptions.entryTiming. "break" waits for the close through the
   *  level; "confirm" requires it inside the HL's own confirmation window, which
   *  enters on the same bar the shipped core does. */
  displacementEntry?: "break" | "confirm";
  /** displacement: ATR period (default 14). */
  displacementAtrPeriod?: number;
  /** reversal: max bars between the failed pivot and the EMA break (default 12) */
  pivotMaxAge?: number;
  /** Right-side pivot bars (default = pivotLookback). 0 = left-only pivots,
   *  signal known at the pivot bar's own close — no confirmation delay. */
  pivotRightLookback?: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  filterType: FilterType;
  /** EMA period on 15m entry (default 50) */
  ema15m: number;
  leverage: number;
  startingCapital: number;
  /** Fraction of CURRENT equity risked per trade for the compounded equity curve (default 0.02 = 2%, the hard ceiling — see MAX_RISK_PCT_PER_TRADE) */
  riskPct?: number;
  /** Confirmation timeframe klines for EMA entry confirmation (optional) */
  klinesConfirm?: Kline[];
  /** EMA period on the confirmation timeframe (default 31) */
  confirmEma?: number;
  /** Exit mode: "fixed" = TP at takeProfitPercent (legacy 4R), "rlock" = ride to maxTargetR with stepped 0.5R trailing lock */
  tpMode?: "fixed" | "rlock";
  /** rlock: profit level (in R) where locking starts (default 3) */
  lockStartR?: number;
  /** rlock: full-exit level in R (default 8) */
  maxTargetR?: number;
  /** rlock: lock-step size in R (default 1 = lock jumps each whole-R level).
   *  Wider steps give winners more room; the lock trails at
   *  lockStartR + floor((peakR - lockStartR) / stepR) * stepR. */
  lockStepR?: number;
  /** Market-order entry slippage, % of price, applied adversely (default 0) */
  entrySlipPct?: number;
  /** Market-order exit slippage, % of price, applied adversely on SL/trail/max exits; TP is a limit fill so no slip (default 0) */
  exitSlipPct?: number;
  /** Funding cost, % of notional per full 8h window held, always adverse (default 0) */
  fundingPctPer8h?: number;
  /** OPT-IN deferred entry (2026-10-23, labs only). When set, a scanned signal
   *  that fires while price is stretched (VWAP distance + oscillator extreme)
   *  is PARKED instead of entered, and re-issued at the bar where the turn
   *  confirms (lower high + histogram peak fading, or cancelled on a guard
   *  break). Unset = the shipped engine, unchanged. The deferred trade's stop
   *  anchors to the parked extreme (Signal.deferral), so the comparison prices
   *  the same idea rather than a different risk. */
  entryDeferral?: DeferralConfig;
  /** "signal" (default) = confirmed pivots only; "hybrid" = also enter fresh-break candidates pre-confirmation */
  entryMode?: "signal" | "hybrid";
  /** hybrid: max bars between the EMA break and a candidate pivot to qualify for early entry (default 6) */
  earlyMaxBreakAge?: number;
  /** Delay confirmed-signal entries by pivotLookback bars — models real-time structure confirmability.
   *  The default engine enters at signal-bar+1 using full-history knowledge (optimistic); live entries
   *  can only happen after `pivotLookback` right-side bars exist. Enable for honest comparisons. */
  confirmLag?: boolean;
  /** Override the number of bars of confirmability delay (default: pivotLookback when confirmLag/hybrid) */
  confirmLagBars?: number;
  /** Anchor the stop to the structure level (HL/LH price ± stopLossPercent) instead of entry price.
   *  Survives confirmation lag: a late entry isn't stopped by a routine retest of the pivot. */
  slAnchorStructure?: boolean;
  /** "retest": after confirmation, rest a LIMIT order at the HL/LH level instead of market-chasing.
   *  Fills only on a pullback to the structure; expires unfilled after retestWindowBars. */
  entryStyle?: "market" | "retest";
  /** retest: bars a resting limit order stays active before expiring (default 16 = 4h) */
  retestWindowBars?: number;
  /** Volatility gate (2026-09-21): skip entries whose SIGNAL bar's Wilder ATR(14),
   *  as % of close, is below minAtrPct (dead tape — the stop is wider than any
   *  realistic move) or above maxAtrPct (vol spike — the 2026-09-18 paper bleed
   *  day entered at ~1.35% ATR vs the book's 0.93% median). 0 = side off.
   *  Percent-of-price thresholds are portable across a multi-pair universe;
   *  the proxy book's relative ATR-vs-SMA20 rule is NOT — different mechanism,
   *  same goal. NaN (pre-seed) fails closed. */
  minAtrPct?: number;
  maxAtrPct?: number;
  /** Per-pair cooldown (2026-09-21): after this position on this pair CLOSES,
   *  the next entry on the same pair is blocked until `cooldownMin` minutes
   *  have elapsed (wall-clock, from the close bar's closeTime). 0 = off.
   *  Tests the stop-out journal's "over-trading hostile pairs" finding: the
   *  books can chain repeated entries on the same pair in a declining move.
   *  cooldownOnlyAfterLoss=true arms the cooldown ONLY after a losing exit
   *  (the revenge-trading variant); false applies it after every close. */
  cooldownMin?: number;
  cooldownOnlyAfterLoss?: boolean;
  /** 15m RSI pullback gate (2026-09-21): block a side when Wilder RSI(period)
   *  on the SIGNAL bar sits outside [min, max]. `min` catches "broken tape"
   *  entries (RSI collapsed — the pullback resumed), `max` catches "blow-off"
   *  entries (RSI already extended — nothing left to harvest). Both bounds are
   *  side-specific, so a stretched-up LONG can never block a SHORT. 0 or
   *  undefined = that bound off. Fail CLOSED on NaN (pre-seed warm-up), same
   *  convention as the volatility gate. Reads the same Wilder recursion as the
   *  scoring engine's RSI term (src/lib/htf-advisor.ts `rsiSeries`). */
  rsiPeriod?: number;
  rsiLongMin?: number;
  rsiLongMax?: number;
  rsiShortMin?: number;
  rsiShortMax?: number;
  /** HTF EMA period on the PRIMARY filter series (default 75). Part of the
   *  2026-09-22 1H-migration lab: the spec's "4H EMA75" was hard-coded, so the
   *  filter's own period could never be questioned. Undefined = 75 = shipped. */
  htfEmaPeriod?: number;
  /** Optional SECOND HTF filter series (e.g. 12H bars aggregated from 4H).
   *  When supplied, BOTH series' EMA must allow the side — the AND-stack the
   *  live stack uses across its two advisor layers. Evaluated at the same
   *  causal point as the primary gate. Undefined = single-gate behaviour. */
  klinesHtf2?: Kline[];
  /** EMA period on the second HTF series (default 75). */
  htf2EmaPeriod?: number;
  /** Lab hook: return true to BLOCK a candidate entry. Called at decision time
   *  with the signal's side, its pivot-bar index and that bar's closeTime. Used
   *  to score the advisor's divergence vetoes INSIDE the audited book (they read
   *  StochRSI/OBV/A-D/CMF divergence the engine does not recompute), so the book
   *  is re-simulated with freed slots instead of post-hoc subtraction.
   *  Undefined = no-op; the default engine is byte-identical. */
  entryVeto?: (ctx: { side: "LONG" | "SHORT"; signalIndex: number; signalTime: number }) => boolean;
}

const DEFAULT_CONFIG: BacktestConfig = {
  pivotLookback: 5,
  stopLossPercent: 0.3,
  takeProfitPercent: 1.2,
  filterType: "ema",
  ema15m: 50,
  leverage: 50,
  startingCapital: 300,
  riskPct: 0.02,
  // ── CAUSALITY + COSTS (2026-09-11 red-team audit) ──────────────────────
  // A pivot low/high is only knowable `pivotLookback` bars after it prints
  // (detectPivots requires that many right-side bars). Entering on the bar
  // after the pivot bar was therefore ~4-5 bars (60-75 min) of look-ahead.
  // Confirmation lag is now the DEFAULT so results are achievable live; a
  // lab comparing against the old optimistic numbers must opt out explicitly
  // with `confirmLag: false`. Slippage/funding are no longer zero by default
  // (see src/lib/costs.ts) — a 50x run with free fills is not a backtest.
  confirmLag: true,
  entrySlipPct: COSTS.entrySlipPct,
  exitSlipPct: COSTS.exitSlipPct,
  fundingPctPer8h: COSTS.fundingPctPer8h,
};

/**
 * Run a backtest on historical data.
 * - Enters at the OPEN of the bar after the signal bar (realistic execution).
 * - Only one position open at a time (no overlapping trades).
 * - Open trades are force-closed at the last bar for statistics.
 * - Includes configurable fee estimate (taker fee).
 */
/**
 * Wilder ATR(14) as a % of each bar's close. TR[0] is NaN (needs the previous
 * close); the seed is the mean of TR[1..14] at index 14, then the (13·prev + TR)
 * /14 recursion — the SAME construction as the proxy book's `wilderAtr14`
 * (src/lib/proxy-signal.ts), converted to % of price so one threshold set means
 * the same thing across every pair. Exported for the lab + tests: an expected-
 * value check must use the same series the gate reads, not a re-derivation.
 */
export function atrPctSeries(bars: Kline[]): number[] {
  const atr = new Array<number>(bars.length).fill(NaN);
  if (bars.length <= 14) return atr;
  const tr = new Array<number>(bars.length).fill(NaN);
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].close;
    tr[i] = Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc));
  }
  let s = 0;
  for (let i = 1; i <= 14; i++) s += tr[i];
  atr[14] = s / 14;
  for (let i = 15; i < bars.length; i++) atr[i] = (atr[i - 1] * 13 + tr[i]) / 14;
  return bars.map((b, i) =>
    Number.isFinite(atr[i]) && b.close > 0 ? (atr[i] / b.close) * 100 : NaN,
  );
}

export function runBacktest(
  klines15m: Kline[],
  klines4h: Kline[],
  config: Partial<BacktestConfig> = {},
): BacktestResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  // 2% HARD CEILING (Phase 7, fraction space: 0.02 = 2%): labs share the
  // same ceiling as the engines — a backtest can never bless a size the
  // live book refuses to place. (Legacy default was 0.025 = 2.5%.)
  cfg.riskPct = clampRiskFrac(cfg.riskPct, 0.02);
  // Real MEXC futures fees come from the shared cost model (src/lib/costs.ts)
  // so every lab and both engines charge the same thing.
  const TAKER_FEE_PCT = COSTS.takerFeePct;
  const MAKER_FEE_PCT = COSTS.makerFeePct;
  // Higher-timeframe gate overrides (2026-09-22 1H-migration lab). When no
  // override is configured this is `undefined` and both scanners take their
  // pre-existing default path, so the shipped engine is untouched.
  const htfOpts: HtfFilterOptions | undefined =
    cfg.htfEmaPeriod !== undefined || cfg.klinesHtf2
      ? { emaPeriod: cfg.htfEmaPeriod, klines2: cfg.klinesHtf2, emaPeriod2: cfg.htf2EmaPeriod }
      : undefined;

  // Find signals
  const rawSignals =
    cfg.signalCore === "displacement"
      ? scanDisplacementSignals(klines15m, klines4h, {
          kAtr: cfg.kAtr ?? DISPLACEMENT_DEFAULTS.kAtr,
          atrPeriod: cfg.displacementAtrPeriod ?? DISPLACEMENT_DEFAULTS.atrPeriod,
          pivotLookback: cfg.pivotLookback,
          emaPeriod: cfg.ema15m,
          filterType: cfg.filterType,
          entryTiming: cfg.displacementEntry,
          htf: htfOpts,
        })
      : cfg.variant === "reversal"
        ? scanReversalSignals(klines15m, klines4h, cfg.pivotLookback, cfg.filterType, cfg.ema15m, cfg.pivotMaxAge ?? 12, htfOpts)
        : scanForSignals(klines15m, klines4h, cfg.pivotLookback, cfg.filterType, cfg.ema15m, cfg.pivotRightLookback, htfOpts);

  // DEFERRED ENTRY (opt-in): re-time the scanned signals BEFORE any gate reads
  // them. With `entryDeferral` unset this is the identical array, so no other
  // lab's numbers move.
  const signals = cfg.entryDeferral
    ? deferSignals(rawSignals, klines15m, cfg.entryDeferral).signals
    : rawSignals;

  /** Advisor / lab veto read — see BacktestConfig.entryVeto. No-op when unset. */
  function vetoBlocks(sig: Signal): boolean {
    if (!cfg.entryVeto) return false;
    return cfg.entryVeto({ side: sig.type, signalIndex: sig.index, signalTime: sig.time });
  }

  // ── Hybrid early-entry pre-pass ─────────────────────────────────
  // Candidate pivot: extreme vs prior `pivotLookback` bars while a break leg is active.
  // Fresh candidates (breakAge ≤ earlyMaxBreakAge) may be entered at the NEXT bar open,
  // before full LB5 confirmation — trading certainty for entry price.
  const hybrid = cfg.entryMode === "hybrid";
  const maxAge = cfg.earlyMaxBreakAge ?? 6;
  const lb = cfg.pivotLookback;
  const earlyTriggers = new Map<number, Signal>(); // actionIndex (enter at open of this bar) -> pseudo-signal
  const closes15m = klines15m.map((k) => k.close);
  const emaEarly = calculateEMA(closes15m, cfg.ema15m);
  const macd4hE = cfg.filterType === "macd" ? calculateMACD(klines4h.map((k) => k.close), 8, 17, 9) : null;
  // Primary HTF EMA honours cfg.htfEmaPeriod (default 75 = shipped).
  const ema4hE = cfg.filterType === "ema" ? calculateEMA(klines4h.map((k) => k.close), cfg.htfEmaPeriod ?? 75) : null;
  // Second HTF gate (EMA-only) for the hybrid path — the confirmed path gets
  // BOTH gates from the scanner, so this keeps the two paths consistent.
  const emaHtf2E = cfg.klinesHtf2 && cfg.filterType === "ema"
    ? calculateEMA(cfg.klinesHtf2.map((k) => k.close), cfg.htf2EmaPeriod ?? 75)
    : null;
  // Volatility gate series (2026-09-21): computed ONCE over the full 15m series;
  // value at index idx is the read ON bar idx. The gate is evaluated at the
  // SIGNAL bar (sig.index / earlyHit.index) — already closed by decision time,
  // so causality holds. Only built when a side is actually configured.
  const atrPct15m = cfg.minAtrPct || cfg.maxAtrPct ? atrPctSeries(klines15m) : null;

  function volGateAllows(idx: number): boolean {
    if (!atrPct15m) return true; // gate fully off → identical to the old engine
    const v = atrPct15m[idx];
    if (!Number.isFinite(v)) return false; // pre-seed warm-up: fail CLOSED
    if (cfg.minAtrPct && v < cfg.minAtrPct) return false;
    if (cfg.maxAtrPct && v > cfg.maxAtrPct) return false;
    return true;
  }

  // 15m RSI pullback gate (2026-09-21): built ONCE over the full close series
  // when any bound is configured; the read happens on the SIGNAL bar's index
  // (already closed at decision time, so causality holds).
  const rsiGateOn = !!(cfg.rsiLongMin || cfg.rsiLongMax || cfg.rsiShortMin || cfg.rsiShortMax);
  const rsi15m = rsiGateOn ? rsiSeries(closes15m, cfg.rsiPeriod ?? 14) : null;

  function rsiGateAllows(idx: number, type: "LONG" | "SHORT"): boolean {
    if (!rsi15m) return true; // gate fully off → identical to the old engine
    const v = rsi15m[idx];
    if (!Number.isFinite(v)) return false; // pre-seed warm-up: fail CLOSED
    if (type === "LONG") {
      if (cfg.rsiLongMin && v < cfg.rsiLongMin) return false;
      if (cfg.rsiLongMax && v > cfg.rsiLongMax) return false;
    } else {
      if (cfg.rsiShortMin && v < cfg.rsiShortMin) return false;
      if (cfg.rsiShortMax && v > cfg.rsiShortMax) return false;
    }
    return true;
  }

  function filterAllows(barOpenTime: number, type: "LONG" | "SHORT"): boolean {
    // Second (optional) HTF series must agree; AND-stack.
    if (cfg.klinesHtf2 && emaHtf2E) {
      let ok2 = false;
      for (let x = cfg.klinesHtf2.length - 1; x >= 0; x--) {
        if (cfg.klinesHtf2[x].closeTime > barOpenTime) continue;
        if (!isNaN(emaHtf2E[x])) {
          ok2 = type === "LONG" ? cfg.klinesHtf2[x].close > emaHtf2E[x] : cfg.klinesHtf2[x].close < emaHtf2E[x];
        }
        break;
      }
      if (!ok2) return false;
    }
    for (let x = klines4h.length - 1; x >= 0; x--) {
      if (klines4h[x].closeTime <= barOpenTime) {
        if (macd4hE) return type === "LONG" ? macd4hE.histogram[x] > 0 : macd4hE.histogram[x] < 0;
        if (ema4hE) return type === "LONG" ? klines4h[x].close > ema4hE[x] : klines4h[x].close < ema4hE[x];
        return true;
      }
    }
    return false;
  }

  if (hybrid) {
    let longActive = false, shortActive = false, longIdx = -1, shortIdx = -1;
    for (let j = lb; j < klines15m.length - 1; j++) {
      if (!longActive && closes15m[j - 1] < emaEarly[j - 1] && closes15m[j] > emaEarly[j]) { longActive = true; longIdx = j; }
      if (!shortActive && closes15m[j - 1] > emaEarly[j - 1] && closes15m[j] < emaEarly[j]) { shortActive = true; shortIdx = j; }
      if (longActive && closes15m[j] < emaEarly[j]) longActive = false;
      if (shortActive && closes15m[j] > emaEarly[j]) shortActive = false;
      if (!longActive && !shortActive) continue;
      const bar = klines15m[j];
      const range = bar.high - bar.low;
      if (range <= 0) continue;

      const tryCandidate = (type: "LONG" | "SHORT", breakIdx: number): boolean => {
        const dir = type === "LONG" ? "low" as const : "high" as const;
        for (let p = 1; p <= lb; p++) if ((dir === "low" ? klines15m[j - p].low >= bar.low : klines15m[j - p].high <= bar.high)) return false;
        const breakAge = j - breakIdx;
        if (breakAge > maxAge || breakAge < 0) return false;
        if (!filterAllows(bar.openTime, type)) return false;
        earlyTriggers.set(j + 1, {
          type, time: bar.closeTime, price: bar.close, index: j,
          ema50: emaEarly[j], ema75_4h: 0,
          reason: `EARLY ${type}: ${dir === "low" ? "HL" : "LH"} candidate @ $${(dir === "low" ? bar.low : bar.high).toFixed(4)}, breakAge=${breakAge}, awaiting LB${lb} confirmation`,
        });
        return true;
      };

      if (longActive && tryCandidate("LONG", longIdx)) longActive = false;
      else if (shortActive && tryCandidate("SHORT", shortIdx)) shortActive = false;
    }
  }

  // Confirmed-signal entries are delayed by `lb` bars under confirm-lag / hybrid baselines.
  // DEFAULT_CONFIG.confirmLag is true, so lag defaults to pivotLookback unless a
  // caller explicitly opts into the (non-causal) `confirmLag: false` fast path.
  const lag = cfg.confirmLag !== false || hybrid ? (cfg.confirmLagBars ?? lb) : 0;
  // Early entries consume their own structure's later confirmed signal
  const suppressed = new Set<string>();

  // ── Retest-limit state ──────────────────────────────────────────
  // After confirmation delay, rest a limit at the structure level; fill on pullback.
  let pending: { sig: Signal; expireIdx: number } | null = null;

  const trades: Trade[] = [];
  let positionOpen = false;
  // Per-pair cooldown state (cfg.cooldownMin > 0 only): the wall-clock time
  // before which the next entry on this pair is blocked, and whether the arm
  // applies the cooldown after every close or only after losers. Set in
  // closePosition (the exit anchor), read in both entry paths below.
  let cooldownUntil = 0;

  function cooldownBlocks(entryBarCloseTime: number): boolean {
    if (!cfg.cooldownMin || cfg.cooldownMin <= 0) return false; // gate fully off → identical to the old engine
    return entryBarCloseTime < cooldownUntil;
  }
  // R-lock trailing state (tpMode "rlock"), reset on each close
  let peakR = 0;
  let lockPrice = 0;
  // Lock parameters, resolved ONCE — they feed `rLockBarStep`, the shared rule
  // the live and paper books also run (src/lib/r-lock.ts).
  const lockStart = cfg.lockStartR ?? 3;
  const lockStep = cfg.lockStepR ?? 1;
  const lockMax = cfg.maxTargetR ?? 8;
  // `rLockEnabled` treats startR <= 0 as "lock disabled". The old inline branch
  // instead armed a lock at every whole step from peak 0R — so a startR of 0 now
  // means something different, and a silent difference is the one thing this
  // harness must never hand a lab. No config in the repo passes 0 (they all use
  // SHIPPED_LOCK.startR), so this fails loudly rather than moving quietly.
  if (cfg.tpMode === "rlock" && !rLockEnabled({ startR: lockStart })) {
    throw new Error(
      `tpMode "rlock" requires a positive lockStartR (got ${cfg.lockStartR}); ` +
        "startR <= 0 disables the lock (rLockEnabled) instead of arming it at every step.",
    );
  }
  // Per-position stop level / risk distance (differs from nominal when structure-anchored)
  let curSl = 0;
  let curRiskDist = 0;
  // Wall-clock (bar closeTime) of the bar the position was ACTUALLY filled on.
  // With confirmation lag the signal bar and the entry bar are different, so
  // recording the signal bar as the entry time mis-stated holding period,
  // funding accrual and trade ordering (2026-09-11 audit).
  let curEntryTime = 0;
  // Retest-limit entries are maker fills
  let curEntryMaker = false;

  function computeStop(sig: Signal): { sl: number; dist: number } {
    const nomDist = sig.price * (cfg.stopLossPercent / 100);
    // DEFERRED entry: the idea is void once price reclaims the parked extreme,
    // so the stop sits just beyond it. The 3x-nominal guard below still applies
    // (a deferred fill far from the extreme falls back to nominal risk instead
    // of pretending to a tiny stop).
    if (sig.deferral && sig.deferral.extreme > 0) {
      const sl = sig.type === "LONG"
        ? sig.deferral.extreme * (1 - cfg.stopLossPercent / 100)
        : sig.deferral.extreme * (1 + cfg.stopLossPercent / 100);
      const dist = Math.abs(sig.price - sl);
      if (dist <= nomDist * 3) return { sl, dist };
    }
    if ((cfg.slAnchorStructure || cfg.entryStyle === "retest") && sig.structurePrice && sig.structurePrice > 0) {
      const sl = sig.type === "LONG"
        ? sig.structurePrice * (1 - cfg.stopLossPercent / 100)
        : sig.structurePrice * (1 + cfg.stopLossPercent / 100);
      const dist = Math.abs(sig.price - sl);
      // Guard: if structure is unreasonably far (>3× nominal risk), fall back to nominal
      if (dist <= nomDist * 3) return { sl, dist };
    }
    return { sl: sig.type === "LONG" ? sig.price - nomDist : sig.price + nomDist, dist: nomDist };
  }
  let exitPrice: number | null = null;
  let exitTime: number | null = null;
  let exitReason = "";
  let currentSignal: Signal | null = null;

  function closePosition(price: number, time: number, reason: string) {
    if (!currentSignal) return;
    exitPrice = price;
    exitTime = time;
    exitReason = reason;

    // Market-order exits slip adversely (TP is a resting limit → fills at price)
    const slipped =
      reason === "Take Profit"
        ? price
        : currentSignal.type === "LONG"
          ? price * (1 - (cfg.exitSlipPct ?? 0) / 100)
          : price * (1 + (cfg.exitSlipPct ?? 0) / 100);

    const rawPnl =
      currentSignal.type === "LONG"
        ? ((slipped - currentSignal.price) / currentSignal.price) * 100
        : ((currentSignal.price - slipped) / currentSignal.price) * 100;

    // Funding: % of notional per full 8h window held (from the ACTUAL fill bar)
    const heldFrom = curEntryTime > 0 ? curEntryTime : currentSignal.time;
    const fundingPct = Math.floor((time - heldFrom) / (8 * 3600_000)) * (cfg.fundingPctPer8h ?? 0);

    // Subtract round-trip fees (exit fee depends on exit type) + funding, then apply leverage
    const exitFeePct = reason === "Take Profit" ? MAKER_FEE_PCT : TAKER_FEE_PCT;
    const entryFeePct = curEntryMaker ? MAKER_FEE_PCT : TAKER_FEE_PCT;
    const netPnlPct = rawPnl - (entryFeePct + exitFeePct) - fundingPct;
    const pnlPercent = netPnlPct * cfg.leverage;

    trades.push({
      entrySignal: currentSignal,
      entryPrice: currentSignal.price,
      entryTime: curEntryTime > 0 ? curEntryTime : currentSignal.time,
      exitPrice,
      exitTime,
      pnlPercent,
      status: "closed",
      reason: exitReason,
    });

    positionOpen = false;
    currentSignal = null;
    exitPrice = null;
    exitTime = null;
    exitReason = "";
    peakR = 0;
    lockPrice = 0;
    curSl = 0;
    curRiskDist = 0;
    curEntryTime = 0;
    curEntryMaker = false;
    // Cooldown anchor: the close time of the bar whose close triggered the exit.
    // With time-ordered bars this is the latest observed timestamp, so the next
    // entry (a later bar) is held off until cooldownUntil — no look-ahead.
    const lost = netPnlPct <= 0;
    if (cfg.cooldownMin && cfg.cooldownMin > 0 && (!cfg.cooldownOnlyAfterLoss || lost)) {
      cooldownUntil = time + cfg.cooldownMin * 60_000;
    }
  }

  for (let i = 1; i < klines15m.length; i++) {
    const bar = klines15m[i];

    // Check if a signal fired on the *previous* bar (i-1), delayed by confirm-lag
    const earlyHit = hybrid ? earlyTriggers.get(i - 1) : undefined;
    const sig = signals.find((s) => s.index === i - 1 - lag && !suppressed.has(`${s.index}|${s.type}`));
    const retestMode = cfg.entryStyle === "retest";

    // Manage a resting retest limit: fill on pullback to structure, or expire
    if (retestMode && !positionOpen && pending) {
      const p = pending.sig;
      const filled = p.type === "LONG" ? bar.low <= p.structurePrice! : bar.high >= p.structurePrice!;
      if (filled) {
        currentSignal = { ...p, price: p.structurePrice! }; // limit fills at price (maker)
        positionOpen = true;
        curEntryMaker = true;
        curEntryTime = bar.closeTime;
        ({ sl: curSl, dist: curRiskDist } = computeStop(currentSignal));
        pending = null;
      } else if (i > pending.expireIdx) {
        pending = null;
      }
    }

    if (!positionOpen && !retestMode && earlyHit && volGateAllows(earlyHit.index) && rsiGateAllows(earlyHit.index, earlyHit.type) && !vetoBlocks(earlyHit) && !cooldownBlocks(bar.closeTime)) {
      // (cooldownBlocks is a no-op here unless a hybrid arm configures a cooldown)
      // Enter at this bar's open (slipped adversely)
      const entryFill =
        earlyHit.type === "LONG"
          ? bar.open * (1 + (cfg.entrySlipPct ?? 0) / 100)
          : bar.open * (1 - (cfg.entrySlipPct ?? 0) / 100);
      currentSignal = { ...earlyHit, price: entryFill };
      positionOpen = true;
      curEntryTime = bar.closeTime;
      ({ sl: curSl, dist: curRiskDist } = computeStop(currentSignal));
      suppressed.add(`${earlyHit.index}|${earlyHit.type}`); // this pivot's own LB5 signal is consumed
    } else if (!positionOpen && !(retestMode && pending) && sig) {
      // ── Confirmation EMA filter ──────────────────
      if (cfg.klinesConfirm && cfg.klinesConfirm.length > 40) {
        const klinesConfirmUpTo = cfg.klinesConfirm.filter((k) => k.openTime <= sig.time);
        if (klinesConfirmUpTo.length >= 40) {
          const confirmCheck = checkEma3mFilter(klinesConfirmUpTo, sig.type, cfg.confirmEma ?? 31);
          if (!confirmCheck.confirmed) {
            continue; // EMA not broken yet — skip this signal
          }
        }
      }
      if (retestMode) {
        if (!sig.structurePrice || sig.structurePrice <= 0) continue; // no structure level to rest at
        if (!volGateAllows(sig.index)) continue; // gate at placement, not at a later fill
        if (!rsiGateAllows(sig.index, sig.type)) continue;
        if (vetoBlocks(sig)) continue;
        pending = { sig, expireIdx: i + (cfg.retestWindowBars ?? 16) };
        continue;
      }
      // ── Volatility gate (2026-09-21) ──
      // Evaluated on the SIGNAL bar's ATR% (already closed when this decision
      // runs — see atrPct15m above). Blocks the whole signal: entering later on
      // the same structure would change the trade the backtest measured.
      if (!volGateAllows(sig.index)) continue;
      // ── 15m RSI pullback gate (2026-09-21) ──
      // Same convention as the vol gate: evaluated on the signal bar's RSI
      // (closed when this decision runs). Blocks the signal outright.
      if (!rsiGateAllows(sig.index, sig.type)) continue;
      // ── Advisor / lab veto hook (2026-09-22) ──
      if (vetoBlocks(sig)) continue;
      // ── Per-pair cooldown (2026-09-21) ──
      // Evaluated on the ENTRY bar's wall clock (already closed — bars are
      // processed in order). Blocks the signal outright: a held-off signal is
      // not resurrected later, so the measured population is the gated one.
      if (cooldownBlocks(bar.closeTime)) continue;
      // Enter at this bar's open price (realistic execution), slipped adversely
      const entryFill =
        sig.type === "LONG"
          ? bar.open * (1 + (cfg.entrySlipPct ?? 0) / 100)
          : bar.open * (1 - (cfg.entrySlipPct ?? 0) / 100);
      currentSignal = { ...sig, price: entryFill };
      positionOpen = true;
      curEntryTime = bar.closeTime;
      ({ sl: curSl, dist: curRiskDist } = computeStop(currentSignal));
    }

    if (positionOpen && currentSignal) {
      const entryPrice = currentSignal.price;
      const rlock = cfg.tpMode === "rlock";
      const riskDist = curRiskDist > 0 ? curRiskDist : entryPrice * (cfg.stopLossPercent / 100);

      if (currentSignal.type === "LONG") {
        const slPrice = curSl > 0 ? curSl : entryPrice * (1 - cfg.stopLossPercent / 100);
        const tpPrice = entryPrice * (1 + cfg.takeProfitPercent / 100);
        const maxPrice = entryPrice + riskDist * (cfg.maxTargetR ?? 8);

        // Conservative within-bar ordering: adverse exits before favorable ones
        if (bar.low <= slPrice) {
          closePosition(slPrice, bar.closeTime, "Stop Loss");
          continue;
        }
        if (rlock) {
          // Trailing lock — via the SHARED per-bar rule (src/lib/r-lock.ts): the
          // same `rLockBarStep` the live (`liveRLockTick`) and paper
          // (`layer2ExitTick`) passes run. It used to be inline here WITH a
          // second copy in the books, and the two drifted: the books sampled one
          // spot price per 5-minute tick, so a bar that spiked and closed never
          // armed anything, and the live ledger records the cost in its own rows
          // (14 of 23 measurable rows under-recorded their peak; 6 booked more R
          // than their stored peak allowed — 2026-09-22 audit). One
          // implementation, so the harness that measured the edge and the books
          // that trade it cannot diverge again.
          //
          // Stop logic stays OUTSIDE (the engine closes at the stop; rLockStep
          // only stands down), and `riskDist` is passed as the frozen ruler so
          // the lock is measured from the same 1R this engine sized the trade on.
          const lock = rLockBarStep({
            side: "LONG",
            entryPrice,
            slPrice,
            riskPx: riskDist,
            params: { startR: lockStart, stepR: lockStep, maxR: lockMax },
            bar,
            state: { peakR, lockPrice },
          });
          peakR = lock.peakR;
          lockPrice = lock.lockPrice;
          if (lock.exit) {
            // Reason strings stay the harness's own — every lab, journal and
            // anchor counts "Max Target 8R", and rLockStep names it "R-Lock Max".
            closePosition(
              lock.exit.rungPrice,
              bar.closeTime,
              lock.exit.reason === "Trail Lock" ? "Trail Lock" : "Max Target 8R",
            );
          }
          continue;
        }
        // Check take profit (legacy fixed TP)
        if (bar.high >= tpPrice) {
          closePosition(tpPrice, bar.closeTime, "Take Profit");
          continue;
        }
      } else {
        // SHORT
        const slPrice = curSl > 0 ? curSl : entryPrice * (1 + cfg.stopLossPercent / 100);
        const tpPrice = entryPrice * (1 - cfg.takeProfitPercent / 100);
        const maxPrice = entryPrice - riskDist * (cfg.maxTargetR ?? 8);

        // Check stop loss
        if (bar.high >= slPrice) {
          closePosition(slPrice, bar.closeTime, "Stop Loss");
          continue;
        }
        if (rlock) {
          // SHORT mirror of the LONG branch above — same shared rule, adverse
          // side first (for a short that is the high).
          const lock = rLockBarStep({
            side: "SHORT",
            entryPrice,
            slPrice,
            riskPx: riskDist,
            params: { startR: lockStart, stepR: lockStep, maxR: lockMax },
            bar,
            state: { peakR, lockPrice },
          });
          peakR = lock.peakR;
          lockPrice = lock.lockPrice;
          if (lock.exit) {
            closePosition(
              lock.exit.rungPrice,
              bar.closeTime,
              lock.exit.reason === "Trail Lock" ? "Trail Lock" : "Max Target 8R",
            );
          }
          continue;
        }
        // Check take profit (legacy fixed TP)
        if (bar.low <= tpPrice) {
          closePosition(tpPrice, bar.closeTime, "Take Profit");
          continue;
        }
      }
    }
  }

  // Force-close any still-open trade at the last bar's close
  if (positionOpen && currentSignal) {
    const lastBar = klines15m[klines15m.length - 1];
    closePosition(lastBar.close, lastBar.closeTime, "End of data");
  }

  // ── Statistics ──────────────────────────────────────────────────
  const totalTrades = trades.length;
  const winners = trades.filter((t) => (t.pnlPercent ?? 0) > 0);
  const losers = trades.filter((t) => (t.pnlPercent ?? 0) <= 0);
  const winRate = totalTrades > 0 ? (winners.length / totalTrades) * 100 : 0;

  const avgPnl =
    totalTrades > 0
      ? trades.reduce((sum, t) => sum + (t.pnlPercent ?? 0), 0) / totalTrades
      : 0;

  const totalPnl = trades.reduce((sum, t) => sum + (t.pnlPercent ?? 0), 0);

  // Profit factor
  const grossProfit = winners.reduce((sum, t) => sum + (t.pnlPercent ?? 0), 0);
  const grossLoss = Math.abs(losers.reduce((sum, t) => sum + (t.pnlPercent ?? 0), 0));
  const profitFactor =
    grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Max drawdown — COMPOUNDED fixed-fractional equity curve.
  // Each trade risks riskPct of CURRENT equity; 1R = stopLoss × leverage in leveraged-pnl points.
  let equity = cfg.startingCapital;
  let peak = cfg.startingCapital;
  let maxDrawdown = 0;
  const equityCurve: number[] = [equity];
  const rPoints = Math.max(cfg.stopLossPercent * cfg.leverage, 1e-9); // leveraged % that equals 1R
  const riskPct = cfg.riskPct ?? 0.02; // clamped above to ≤ 0.02 (2% ceiling); fallback matches DEFAULT_CONFIG
  for (const t of trades) {
    const rMultiple = (t.pnlPercent ?? 0) / rPoints;
    equity += equity * riskPct * rMultiple;
    equityCurve.push(equity);
    if (equity <= 0) { equity = 0; break; } // wiped out
    peak = Math.max(peak, equity);
    const dd = ((peak - equity) / peak) * 100;
    maxDrawdown = Math.max(maxDrawdown, dd);
  }

  // Sharpe ratio — per-TRADE returns annualized by TRADES PER YEAR.
  // AUDIT FIX (2026-09-11): this used to be `* Math.sqrt(35040)` (15m bars per
  // year) on a per-trade return series — a ~187x inflation that made any
  // strategy look institutional. Annualize a per-trade series by trades/year.
  const returns = trades.map((t) => (t.pnlPercent ?? 0) / 100);
  const avgReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
  const stdDev =
    returns.length > 1
      ? Math.sqrt(
          returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) /
            (returns.length - 1),
        )
      : 0;
  const spanMs =
    klines15m.length > 0
      ? klines15m[klines15m.length - 1].closeTime - klines15m[0].openTime
      : 0;
  const spanYears = spanMs > 0 ? spanMs / (365 * 24 * 3600_000) : 0;
  const tradesPerYear = spanYears > 0 && trades.length > 0 ? trades.length / spanYears : 0;
  const sharpeRatio =
    stdDev > 0 && tradesPerYear > 0
      ? (avgReturn / stdDev) * Math.sqrt(tradesPerYear)
      : 0;

  // Compounded return of the fixed-fractional equity curve. This — not the
  // non-compounded sum of leveraged percents in `totalPnl` — is the headline
  // number; the runner prints both with explicit labels.
  const totalReturnPct =
    cfg.startingCapital > 0 ? ((equity - cfg.startingCapital) / cfg.startingCapital) * 100 : 0;

  return {
    trades,
    totalTrades,
    winRate,
    avgPnl,
    maxDrawdown,
    totalPnl,
    totalReturnPct,
    sharpeRatio,
    profitFactor,
    startDate: klines15m.length > 0 ? klines15m[0].openTime : 0,
    endDate: klines15m.length > 0 ? klines15m[klines15m.length - 1].closeTime : 0,
    startingCapital: cfg.startingCapital,
    finalEquity: equity,
    equityCurve,
  };
}
