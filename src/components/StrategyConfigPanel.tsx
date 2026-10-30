/**
 * Strategy Config Console — the single shared tuning surface for the Layer 2
 * engine (paper AND live read this same strategyConfig doc).
 *
 * What it edits (all fields the backend actually gates on):
 *   - EMA / scoring / risk / filter numbers → strategyEngine.updateConfig
 *   - LONG / SHORT master kill switches (allowLong / allowShort)
 *   - per-side entry-session allowlists (longSessions / shortSessions)
 *   - manual "run now" for Layer 1 (data) and Layer 2 (scan)
 */
import { useQuery, useMutation, useAction } from "convex/react";
import { createPortal } from "react-dom";
import { LAYER1_PAIRS } from "@/lib/tracked-pairs";
import { api } from "@/convex/_generated/api";
import { useState, useEffect, Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { GlassCard } from "@/components/GlassPanel";
import { cn } from "@/lib/utils";
import { Chip, pht } from "@/components/ui-kit";
import { gateReachabilityWarnings, resolveConfig, rLockConfigError } from "@/lib/layer2-signal";
import {
  RotateCcw,
  Save,
  Play,
  Loader2,
  ChevronDown,
  ChevronUp,
  Gauge,
  SlidersHorizontal,
  ShieldAlert,
  Filter,
  CircuitBoard,
  Radar,
} from "lucide-react";

// Entry-session taxonomy — the same 5 labels the bot stamps on every trade
// (sessionOf in strategyEngine.ts) and the Advanced Data Session Breakdown
// groups by. The filter allowlists these per side.
const SESSIONS = ["asia", "london", "ldn-ny", "ny", "late"] as const;
const SESSION_LABEL: Record<string, string> = {
  asia: "Asia",
  london: "London",
  "ldn-ny": "Ldn–NY",
  ny: "NY",
  late: "Late",
};

// SESSION PROFITABILITY BREAKER (2026-10-20) — read-only mirror of the paper
// bucket record, rendered inside the same card as the manual session filter
// because both answer one question: may the bot enter this session? The chips
// above are the operator's allowlist; this grid is the automatic gate that
// sits behind them. Thresholds come from the PAPER config row, the arm switch
// from the LIVE row (see resolveSessionBreakerConfig in the engine).
type BreakerBucketLike = {
  session: string;
  side: "LONG" | "SHORT";
  trades: number;
  wins: number;
  sumR: number;
  winRate: number | null;
  /** Under the sample floor: no verdict is possible, so live is refused too. */
  insufficient?: boolean;
  minTrades?: number;
  blocked: boolean;
};

type BreakerStateLike = {
  computedAt?: number;
  stale?: boolean;
  lookbackDays?: number;
  minTrades?: number;
  minProfitR?: number;
  buckets?: BreakerBucketLike[];
};

const fmtBucketR = (r: number) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`;

interface FieldDef {
  key: string;
  label: string;
  type: "number";
  min?: number;
  max?: number;
  step?: number;
  group: "EMA" | "Scoring" | "Risk" | "Filters" | "Breaker" | "Advisor";
  suffix?: string;
  // Optional numeric override: blank input is allowed and saves as null
  // (backend falls back to the shared value). Only for fields the engine
  // treats as nullable — e.g. shortTakeProfitPct.
  emptyIsNull?: boolean;
}

const GROUPS: Record<FieldDef["group"], { icon: typeof Gauge; blurb: string }> = {
  EMA: { icon: Gauge, blurb: "Fast/slow EMA cross on closed 15m candles" },
  Scoring: { icon: SlidersHorizontal, blurb: "Min score + conviction gap, and order-flow weights" },
  Risk: { icon: ShieldAlert, blurb: "SL / TP distance, the R-lock trailing exit, and the fee model" },
  Filters: { icon: Filter, blurb: "Liquidity & volatility gates that block entries" },
  Breaker: { icon: CircuitBoard, blurb: "Pause entries while recent results degrade (paper only)" },
  Advisor: { icon: Radar, blurb: "4H divergence & volume-exhaustion veto layer" },
};

const FIELDS: FieldDef[] = [
  // EMA
  { key: "emaFast", label: "Fast EMA", type: "number", min: 2, max: 50, step: 1, group: "EMA" },
  { key: "emaSlow", label: "Slow EMA", type: "number", min: 5, max: 100, step: 1, group: "EMA" },
  { key: "gapThreshold", label: "Gap threshold", type: "number", min: 0, max: 1, step: 0.01, group: "EMA", suffix: "%" },
  // Scoring
  { key: "minScore", label: "Min score", type: "number", min: 0, max: 100, step: 1, group: "Scoring" },
  { key: "minGap", label: "Min score gap", type: "number", min: 0, max: 50, step: 1, group: "Scoring" },
  { key: "bookWeight", label: "Book weight", type: "number", min: 0, max: 50, step: 1, group: "Scoring" },
  { key: "flowWeight", label: "Flow weight", type: "number", min: 0, max: 50, step: 1, group: "Scoring" },
  { key: "fundingWeight", label: "Funding weight", type: "number", min: 0, max: 20, step: 1, group: "Scoring" },
  { key: "fundingBonusThreshold", label: "Funding threshold", type: "number", min: 0, max: 0.01, step: 0.00001, group: "Scoring" },
  // Risk
  // Risk per trade (2026-09-10): % of book balance risked per entry. Paper
  // compounds (balance rolls with PnL); live has its own knob on the Live page.
  { key: "riskPct", label: "Risk per trade (max 2%)", type: "number", min: 0.1, max: 2, step: 0.1, group: "Risk", suffix: "%" },
  { key: "stopLossPct", label: "Stop loss", type: "number", min: 0.1, max: 10, step: 0.1, group: "Risk", suffix: "%" },
  { key: "takeProfitPct", label: "Take profit", type: "number", min: 0.1, max: 20, step: 0.1, group: "Risk", suffix: "%" },
  { key: "shortTakeProfitPct", label: "TP · short (blank = shared)", type: "number", min: 0.1, max: 20, step: 0.05, group: "Risk", suffix: "%", emptyIsNull: true },
  // R-lock trailing exit (2026-09-20) — BOTH books. Once the trade has run
  // `trailLockStartR` in profit the fixed TP above is replaced by a stepped
  // trailing lock: the exit ratchets up one `trailLockStepR` at a time and
  // a full exit sits at `trailLockMaxR`. Measured on the project's own
  // backtest engine (25 pairs, May 28 → Sep 13, 1,878 out-of-sample signals,
  // NET of fees): fixed 2R = −0.062 R/trade (−111.5R); lock from 1.5R with a
  // 0.25R step and 6R cap = +0.038 R/trade (+70.6R). The edge is the right
  // tail a fixed target cannot reach — 110 OOS exits above 2R under the lock,
  // structurally impossible under a 2R cap. Positive in-sample too (+0.139),
  // in all five OOS months, on both sides, and across a plateau of settings.
  // `trailLockStartR` = 0 turns the lock off (back to the fixed TP).
  { key: "trailLockStartR", label: "R-lock · start (0 = off)", type: "number", min: 0, max: 5, step: 0.25, group: "Risk", suffix: "R" },
  { key: "trailLockStepR", label: "R-lock · ratchet step", type: "number", min: 0.05, max: 1, step: 0.05, group: "Risk", suffix: "R" },
  { key: "trailLockMaxR", label: "R-lock · max target", type: "number", min: 1, max: 20, step: 0.5, group: "Risk", suffix: "R" },
  { key: "feePct", label: "Fees (round trip)", type: "number", min: 0, max: 1, step: 0.01, group: "Risk", suffix: "%" },
  // FACTOR-EXPOSURE CAP (2026-09-23, both books, SHIPS OFF). Caps the SIGNED
  // sum of open positions' estimated BTC beta — correlated exposure, which a
  // position count cannot express. Longs add, shorts subtract, so a hedged
  // book may carry more positions than a one-sided one at equal exposure.
  // 0 = off: the engines then measure no beta and fetch no BTC bars. The
  // count cap on the Live page bounds positions; this bounds the factor they
  // are all exposed to, which is what actually produced the book's drawdown.
  // Ships off until a threshold clears a promotion bar (src/lib/btc-beta.ts).
  { key: "maxNetBtcBeta", label: "Max net BTC beta (0 = off)", type: "number", min: 0, max: 20, step: 0.5, group: "Risk", suffix: "β" },
  // Filters
  { key: "spreadTight", label: "Spread tight", type: "number", min: 0, max: 0.5, step: 0.01, group: "Filters", suffix: "%" },
  { key: "spreadWide", label: "Spread wide block", type: "number", min: 0, max: 1, step: 0.01, group: "Filters", suffix: "%" },
  { key: "atrSpikeMult", label: "ATR spike blocker", type: "number", min: 1, max: 5, step: 0.1, group: "Filters", suffix: "×" },
  // H4 quality gate RSI ceiling (2026-09-23): side-aligned RSI(7) ≥ this
  // blocks BOTH sides (80 = lab default; 0 = off). The three boolean H4
  // gates live in their own switch section above.
  { key: "rsiHeatMax", label: "RSI heat ceiling (0 = off)", type: "number", min: 0, max: 95, step: 1, group: "Filters" },
  // HTF gate EMA periods — see the HTF 1H gate section for what each vetoes.
  { key: "htfShortEma", label: "HTF gate EMA · short", type: "number", min: 5, max: 200, step: 1, group: "Filters" },
  { key: "htfLongEma", label: "HTF gate EMA · long", type: "number", min: 5, max: 200, step: 1, group: "Filters" },
  // 4H choppiness gate (2026-09-22, ships OFF): ER lookback + floor. The
  // shared floor applies to both sides; the per-side fields override it
  // (blank = shared). The enable toggle lives in its own section below —
  // these numbers alone never arm the gate.
  { key: "chopGatePeriod", label: "Chop gate ER period (4H bars)", type: "number", min: 2, max: 50, step: 1, group: "Filters" },
  { key: "chopGateFloor", label: "Chop gate ER floor (shared)", type: "number", min: 0, max: 1, step: 0.05, group: "Filters" },
  { key: "chopGateFloorLong", label: "Chop floor · long (blank = shared)", type: "number", min: 0, max: 1, step: 0.05, group: "Filters", emptyIsNull: true },
  { key: "chopGateFloorShort", label: "Chop floor · short (blank = shared)", type: "number", min: 0, max: 1, step: 0.05, group: "Filters", emptyIsNull: true },
  // 15m VOLATILITY FLOOR (2026-09-27, ARMED on both books): block a side when
  // the decision bar's own ATR% is below the floor — the "dead tape" veto.
  // There is NO enable toggle: 0 in the shared field means off, and a per-side
  // field overrides the shared one (blank = inherit it, same as the chop gate).
  // Shipped state is longs-only 0.60, the point inside the measured plateau
  // (LONG 0.50–0.65 all positive; 0.75 collapses), NOT the nominal maximum.
  { key: "atrFloorPct", label: "Volatility floor · ATR% (0 = off)", type: "number", min: 0, max: 3, step: 0.05, group: "Filters", suffix: "%" },
  { key: "atrFloorPctLong", label: "ATR floor · long (blank = shared)", type: "number", min: 0, max: 3, step: 0.05, group: "Filters", suffix: "%", emptyIsNull: true },
  { key: "atrFloorPctShort", label: "ATR floor · short (blank = shared)", type: "number", min: 0, max: 3, step: 0.05, group: "Filters", suffix: "%", emptyIsNull: true },
  // Chase guard (2026-09-07, LIVE only): cap-delayed entries skip when price
  // drifted past maxSignalDriftPct from the pair's first signal, or that
  // signal is older than signalMaxAgeMin. Paper ignores both.
  { key: "maxSignalDriftPct", label: "Max signal drift · live", type: "number", min: 0.1, max: 5, step: 0.1, group: "Filters", suffix: "%" },
  { key: "signalMaxAgeMin", label: "Signal max age · live", type: "number", min: 5, max: 240, step: 5, group: "Filters", suffix: "min" },
  // EMA-stretch veto (2026-09-09, both books): 0 = off. Blocks a side when
  // price is more than this % from the fast EMA on the closed signal candle.
  { key: "maxEmaStretchPct", label: "Max EMA stretch (0 = off)", type: "number", min: 0, max: 5, step: 0.1, group: "Filters", suffix: "%" },
  // Circuit breaker (2026-09-08, paper only): WR20 floor is 0.30 = 30%.
  { key: "breakerMinWr", label: "Min win rate (20 closes)", type: "number", min: 0, max: 0.6, step: 0.01, group: "Breaker" },
  { key: "breakerMaxDailyLossPct", label: "Max daily loss (of balance)", type: "number", min: 0, max: 0.2, step: 0.01, group: "Breaker" },
  // COIN PRIORITY (2026-10-21): the 14-day per-coin record that orders the LIVE
  // scan (profitable coins first). These are the two knobs the ranking reads;
  // the daily refresh and the 14-day retention follow the lookback.
  { key: "coinPriorityLookbackDays", label: "Coin rank · lookback (days)", type: "number", min: 1, max: 90, step: 1, group: "Breaker", suffix: "d" },
  { key: "coinPriorityMinTrades", label: "Coin rank · min closes", type: "number", min: 1, max: 100, step: 1, group: "Breaker" },
  // HTF advisor (2026-09-08): confluence threshold + divergence/exhaustion
  // tuning. Shared threshold is the fallback; per-side overrides win when
  // set (SHORT=1 = any flagged short loses — replay-validated 0% WR).
  { key: "advisorVetoThreshold", label: "Veto threshold (shared)", type: "number", min: 1, max: 6, step: 1, group: "Advisor" },
  { key: "advisorLongThreshold", label: "Veto threshold · long", type: "number", min: 1, max: 6, step: 1, group: "Advisor" },
  { key: "advisorShortThreshold", label: "Veto threshold · short", type: "number", min: 1, max: 6, step: 1, group: "Advisor" },
  // 1H advisor per-side thresholds (2026-09-12): blank = shared value.
  // Backtest sweet spot L4/S2.5 — hourly flags fire ~3x more often than 4H.
  { key: "advisor1hLongThreshold", label: "1H veto threshold · long (blank = shared)", type: "number", min: 1, max: 8, step: 0.5, group: "Advisor", emptyIsNull: true },
  { key: "advisor1hShortThreshold", label: "1H veto threshold · short (blank = shared)", type: "number", min: 1, max: 8, step: 0.5, group: "Advisor", emptyIsNull: true },
  // Smart Volume MACD vote weight (2026-09-13, 4H advisor only): 0 = OFF
  // (shipped state). run-smartvol-advisor-lab.ts: strongest veto-family lift
  // measured (+0.040 net/t at weight 1, all four arms positive) but it FAILED
  // the pre-registered day-clustered null bar (t ≤ 1.2 < 2) — a random
  // same-day/same-side veto does as well. Weight > 0 arms the family; the 1H
  // layer stays off unless advisor1hSmartVolWeight is set via API.
  { key: "advisorSmartVolWeight", label: "SmartVol MACD vote weight · 4H (0 = off)", type: "number", min: 0, max: 3, step: 0.5, group: "Advisor" },
  // RSI-Div differential vote weight (2026-09-13, 4H advisor only): 0 = OFF
  // (shipped). run-rsidiv-lab.ts: trigger arms lost badly; advisor w=1 a
  // faint hint — operator A/B only. Weight > 0 arms it (Pine periods 5/14).
  { key: "advisorRsiDivWeight", label: "RSI-Div vote weight · 4H (0 = off)", type: "number", min: 0, max: 3, step: 0.5, group: "Advisor" },
  { key: "advisor1hMacdWeight", label: "1H MACD flag weight (blank = shared)", type: "number", min: 0.1, max: 3, step: 0.1, group: "Advisor", emptyIsNull: true },
  { key: "advisor1hStochRsiRsiPeriod", label: "1H StochRSI · RSI period (blank = shared)", type: "number", min: 2, max: 50, step: 1, group: "Advisor", emptyIsNull: true },
  { key: "advisor1hStochRsiStochPeriod", label: "1H StochRSI · stoch period (blank = shared)", type: "number", min: 2, max: 50, step: 1, group: "Advisor", emptyIsNull: true },
  { key: "advisor1hDivergenceAgeBars", label: "1H divergence age · bars (blank = shared)", type: "number", min: 1, max: 50, step: 1, group: "Advisor", emptyIsNull: true },
  { key: "advisorDivergenceAgeBars", label: "Divergence age (4H bars)", type: "number", min: 1, max: 24, step: 1, group: "Advisor" },
  { key: "advisorVwapExtremePct", label: "VWAP stretch %", type: "number", min: 0.5, max: 10, step: 0.5, group: "Advisor" },
  { key: "advisorRsiExtreme", label: "Oscillator extreme (StochRSI)", type: "number", min: 50, max: 95, step: 1, group: "Advisor" },
  // StochRSI (2026-09-11): replaces plain RSI(14) as the advisor's momentum
  // oscillator. (Legacy RSI path remains available via the
  // advisorStochRsiEnabled=false config flag — not shown here since the
  // panel only edits numeric fields.)
  { key: "advisorStochRsiRsiPeriod", label: "StochRSI · RSI period", type: "number", min: 5, max: 30, step: 1, group: "Advisor" },
  { key: "advisorStochRsiStochPeriod", label: "StochRSI · stoch period", type: "number", min: 5, max: 40, step: 1, group: "Advisor" },
  { key: "advisorStochRsiKSmooth", label: "StochRSI · %K smooth", type: "number", min: 1, max: 10, step: 1, group: "Advisor" },
  { key: "advisorStochRsiDSmooth", label: "StochRSI · %D smooth", type: "number", min: 1, max: 10, step: 1, group: "Advisor" },
  // Weighted-vote model (2026-09-08): strong tells (bullish divergence at
  // 4H bottoms + thin zones near 4H lows — the short veto was a pure winner
  // in the replay) cast this many votes; weak tells (RSI/OBV bearish div)
  // cast this many. Both = 1 restores the uniform model.
  { key: "advisorStrongWeight", label: "Strong signal weight", type: "number", min: 1, max: 4, step: 0.5, group: "Advisor" },
  { key: "advisorWeakWeight", label: "Weak signal weight", type: "number", min: 0.1, max: 1, step: 0.1, group: "Advisor" },
  // MACD vote family (2026-09-10): divergence + fresh hist flips on the 4H
  // filter TF. Default weight 1 = normal (lab: +$62.49 marginal); 0.5 never
  // crosses a threshold (dead weight); ≥2 fires too much on LONG.
  { key: "advisorMacdWeight", label: "MACD flag weight", type: "number", min: 0.1, max: 3, step: 0.5, group: "Advisor" },
  { key: "advisorMacdFast", label: "MACD fast EMA", type: "number", min: 2, max: 30, step: 1, group: "Advisor" },
  { key: "advisorMacdSlow", label: "MACD slow EMA", type: "number", min: 5, max: 60, step: 1, group: "Advisor" },
  { key: "advisorMacdSignal", label: "MACD signal EMA", type: "number", min: 2, max: 30, step: 1, group: "Advisor" },
];

/**
 * 4H ADVISOR — PER-FAMILY SWITCHES (2026-10-23).
 *
 * The advisor is one master knob today (`advisorEnabled`) over nine signal
 * families that all vote into the same per-side counter. This table gives each
 * family its own button, so an operator can disarm ONE tell without disarming
 * the layer — and reads the measured strength/weakness of each veto instead of
 * a single "vote pool" line.
 *
 * Contract (src/lib/htf-advisor.ts, advisorFamilyToggles):
 *   · unset = ON, so every row written before this table existed is unchanged;
 *   · a disabled family still COMPUTES its flags (the veto readout keeps
 *     showing them) but casts 0 votes and writes no reason string — so it can
 *     neither veto alone nor add collateral toward a confluence threshold;
 *   · the flag is shared by the 4H and the 1H tick (same detector, same row).
 *
 * `weightKey` = families whose arm condition is a WEIGHT (SmartVol / RSI-Div):
 * switching those on writes weight 1 when the stored weight is 0, switching
 * them off writes 0 — otherwise the boolean alone would be a no-op knob.
 */
const ADVISOR_FAMILIES = [
  {
    key: "advisorMomDivEnabled",
    label: "StochRSI div",
    w: "w 0.5 · 2",
    defaultOn: true,
    strong: "the only family that reads momentum directly; its BULLISH half is classed strong (2 votes) because every short it flagged at a 4H bottom lost — it can veto a short alone.",
    weak: "needs an R=2-confirmed pivot, so it reports ~2 bars late; its bearish half is classed weak (0.5) precisely because it fired at continuation points and blocked winners (WLD +6.3R, XRP +5.3R).",
  },
  {
    key: "advisorObvEnabled",
    label: "OBV div",
    w: "w 0.5 · 2",
    defaultOn: true,
    strong: "volume-confirmed divergence — the volume line refusing to make the new extreme is the best independent partner for CMF, and the bullish half is strong.",
    weak: "OBV is cumulative, so one thin-book wash print can bend the line for days; the bearish half is weak class and rarely decides a LONG veto on its own.",
  },
  {
    key: "advisorAdEnabled",
    label: "A/D div",
    w: "w 1 · 2",
    defaultOn: true,
    strong: "close-location weighted: separates 'sold into the close' from 'faded intraday' without needing a volume spike.",
    weak: "also cumulative, and it double-counts CMF's information (both are close-location × volume) — it mostly adds collateral, not independent evidence.",
  },
  {
    key: "advisorCmfEnabled",
    label: "CMF div",
    w: "w 1 · 2",
    defaultOn: true,
    strong: "bounded (−1..1) and windowed (20 bars), so stale prints cannot poison it; the cleanest 'pressure is flattening' read and half of the VWAP-exhaustion test.",
    weak: "weakest standalone divergence in the family (PEPE 67%, ADA 55%) — at weight 1 it only ever matters in confluence.",
  },
  {
    key: "advisorVwapEnabled",
    label: "VWAP stretch",
    w: "w 1",
    defaultOn: true,
    strong: "the only family that measures DISTANCE from value instead of a shape, so it needs no pivot confirmation and can fire on the exhaustion bar itself.",
    weak: "three conditions must agree (stretch > 3%, oscillator > 70, CMF sign) — rare on 4H; in a real trend the stretch stays stretched, so it can veto the strongest part of a run.",
  },
  {
    key: "advisorThinZoneEnabled",
    label: "Thin zone",
    w: "w 1 · 2",
    defaultOn: true,
    strong: "reads the volume profile directly — entries into a bucket nobody traded get unwound. The SHORT side is the measured pure winner (0 wins on 10 vetoed shorts): 2 votes, vetoes alone.",
    weak: "a 96-bar profile is slow to update and useless on recent listings; the LONG side is only a tell with confluence (20% WR at 2 votes, 38% as a single veto).",
  },
  {
    key: "advisorMacdEnabled",
    label: "MACD 6/14/10",
    w: "w 1",
    defaultOn: true,
    strong: "a second, slower momentum read plus fresh histogram flips the pivot-based flags cannot see — measured +$62.49 marginal on the shipped stack.",
    weak: "flips fire ~3x more often than divergences and live on the same bar scale as the entry TF, so many are noise around zero; one full-stack replay found this whole family net-negative on an entry family (deletes 583 trades worth +54R).",
  },
  {
    key: "advisorSmartVolEnabled",
    label: "SmartVol MACD",
    w: "w 0 · off",
    defaultOn: false,
    weightKey: "advisorSmartVolWeight",
    strong: "flow-weighted MACD: the strongest veto-family lift measured on this book (+0.036–0.052 net/t at w=1, all four arms positive) and it cuts max drawdown 66R → 55–57R.",
    weak: "failed the pre-registered day-clustered null bar (t ≤ 1.2) — a random same-day/same-side veto scores as well. It trims losing legacy-veto trades; it does not time better.",
  },
  {
    key: "advisorRsiDivEnabled",
    label: "RSI-Div",
    w: "w 0 · off",
    defaultOn: false,
    weightKey: "advisorRsiDivWeight",
    strong: "fast/slow RSI differential catches momentum rotting while price still holds — the shape the StochRSI pivot detector reports late.",
    weak: "trigger arms lost badly (−0.04..−0.06 net/t, 2× churn); the advisor arm is a faint hint with no dose-response and nulls ≈ 0.",
  },
] as const;

type AdvisorFamilyKey = (typeof ADVISOR_FAMILIES)[number]["key"];

export function StrategyConfigPanel() {
  // Per-book controls (2026-09-08): the panel edits ONE book at a time.
  // Defaults to Live — paper is the data-gathering book and stays untouched
  // unless the Paper tab is explicitly selected.
  const [book, setBook] = useState<"paper" | "live">("live");
  const config = useQuery(api.strategyEngine.getConfig, { book });
  // DEAD-KNOB REPORTING (2026-09-22 audit): the panel is the operator's tuning
  // surface, but a threshold that can never bind looks identical to a healthy
  // one. gateReachabilityWarnings reports knobs like minGap whose value sits
  // below the observed gate-quantity floor (2 vs floor ~2.03 over 5,054
  // setups) so "this dial does nothing" is visible instead of silent. Reports
  // only — it never mutates the config.
  const gateWarnings = config ? gateReachabilityWarnings(resolveConfig(config)) : [];
  const liveAccount = useQuery(api.liveEngine.getLiveAccount as any);
  const updateConfig = useMutation(api.strategyEngine.updateConfig);
  // Manual breaker re-arm (2026-10-22) — the ONLY way out of a disarmed book.
  const rearmLiveBreaker = useMutation(api.liveEngine.rearmLiveBreaker as any);
  const resetConfig = useMutation(api.strategyEngine.resetConfig);

  const [local, setLocal] = useState<Record<string, number | string>>({});
  const [allowLong, setAllowLong] = useState(true);
  const [allowShort, setAllowShort] = useState(true);
  const [fundingMode, setFundingMode] = useState<"bonus" | "strict">("bonus");
  // HTF 1H trend gates (paper + live shared) — price-vs-EMA rule (2026-09-11):
  // short gate vetoes SHORT when the last CLOSED 1h close is ABOVE the 1H gate
  // EMA; long gate vetoes LONG when it is BELOW the 1H gate EMA. Periods are
  // the htfShortEma/htfLongEma fields.
  const [htfGateShort, setHtfGateShort] = useState(true);
  const [htfGateLong, setHtfGateLong] = useState(false);
  // HTF gate timeframe (2026-09-13 swap): 4h deep-EMA read (default) vs 1h legacy.
  const [htfTf, setHtfTf] = useState<"1h" | "4h">("4h");
  // Editable copies of the gate periods (htfShortEma/htfLongEma in config).
  const [htfShortEma, setHtfShortEma] = useState(75);
  const [htfLongEma, setHtfLongEma] = useState(75);
  const [htfSaving, setHtfSaving] = useState(false);
  const [htfFlash, setHtfFlash] = useState<string | null>(null);
  // SHORT flow gate (2026-09-09, paper + live shared): SHORT requires
  // aggressive-seller confirmation (flowBias < 0) on the L1 snapshot.
  const [shortFlowGate, setShortFlowGate] = useState(true);
  const [flowSaving, setFlowSaving] = useState(false);
  const [flowFlash, setFlowFlash] = useState<string | null>(null);
  // H4 QUALITY GATES (2026-09-23, paper + live shared): the exhaustion +
  // volume-size lab filters, default-ON on both books. An explicit stored
  // false turns a block off; the journal's lab:shadowcheck prices each one.
  const [h4VolClimaxBlock, setH4VolClimaxBlock] = useState(true);
  const [h4PullbackBigBlock, setH4PullbackBigBlock] = useState(true);
  const [h4PullbackDeadBlock, setH4PullbackDeadBlock] = useState(true);
  const [h4GateSaving, setH4GateSaving] = useState(false);
  const [h4GateFlash, setH4GateFlash] = useState<string | null>(null);
  // Hard EMA trend gates (2026-09-10, paper + live shared): LONG requires
  // emaFast > emaSlow, SHORT requires emaFast < emaSlow (hard gates).
  const [longTrendGate, setLongTrendGate] = useState(true);
  const [shortTrendGate, setShortTrendGate] = useState(true);
  const [trendSaving, setTrendSaving] = useState(false);
  const [trendFlash, setTrendFlash] = useState<string | null>(null);
  // Circuit breaker (paper only, 2026-09-08): toggle + live trip state.
  const [breakerEnabled, setBreakerEnabled] = useState(true);
  const breakerState = useQuery(api.strategyEngine.getBreakerState);
  // LIVE circuit breaker (2026-09-10): loss-streak cooldown state comes from
  // the liveAccount doc the useQuery below already subscribes to.
  const [liveBreakerEnabled, setLiveBreakerEnabled] = useState(true);
  // CHASE GUARD (2026-09-07, live only) — master switch, ships OFF
  // (2026-09-20): the guard was making live fills worse, so it is parked until
  // re-measured. Off = no anchors recorded, nothing blocked, no capped dry scan.
  const [chaseGuardEnabled, setChaseGuardEnabled] = useState(false);
  const [chaseSaving, setChaseSaving] = useState(false);
  const [chaseFlash, setChaseFlash] = useState<string | null>(null);
  // 4H CHOPPINESS GATE (2026-09-22, ships OFF): ER floor gate that blocks
  // BOTH sides while the pair's own 4H tape is a sideways weave. The numbers
  // (period / floor) ride the shared FIELDS save path in the Filters group.
  const [chopGateEnabled, setChopGateEnabled] = useState(false);
  const liveBreaker = {
    enabled: liveBreakerEnabled,
    // MANUAL DISARM (2026-10-22): stamped by the entry tick after N
    // consecutive losses. While set, no entry is taken until Re-arm.
    disarmedAt: (liveAccount as any)?.liveBreakerManualDisarmedAt ?? null,
    pausedUntil: (liveAccount as any)?.liveBreakerPausedUntil ?? null,
    triggeredAt: (liveAccount as any)?.liveBreakerTriggeredAt ?? null,
  };
  // HTF advisor (2026-09-08): per-book toggle + latest 4H veto readout.
  const [advisorEnabled, setAdvisorEnabled] = useState(false);
  const [advisorMode, setAdvisorMode] = useState<"pair" | "btc" | "both">("both");
  const [advisorSaving, setAdvisorSaving] = useState(false);
  const [advisorFlash, setAdvisorFlash] = useState<string | null>(null);
  const advisorState = useQuery(api.advisor.getAdvisorState as any);
  // 1H advisor (2026-09-12): same detector on hourly bars, optional second
  // layer. Reads the interval="1h" advisor doc the hourly cron writes.
  const [advisor1hEnabled, setAdvisor1hEnabled] = useState(false);
  // Which verdicts gate the HOURLY layer. "" = unset = share the 4H mode
  // (advisor1hMode is an optional override, so blank is meaningful).
  const [advisor1hMode, setAdvisor1hMode] = useState<"pair" | "btc" | "both" | "">("");
  // Per-family switches (2026-10-23): keyed by config field, optimistic on
  // click. A missing key falls back to the family's defaultOn, so the panel
  // never renders "all off" while the config query is still loading.
  const [advisorFamily, setAdvisorFamily] = useState<Partial<Record<AdvisorFamilyKey, boolean>>>({});
  const advisor1hState = useQuery(api.advisor.getAdvisorState as any, { interval: "1h" });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState<string>("");
  // Manual session filter state (auto-saved on each toggle).
  const [longSessions, setLongSessions] = useState<string[]>([]);
  const [shortSessions, setShortSessions] = useState<string[]>([]);
  const [sessionSaving, setSessionSaving] = useState(false);
  const [sessionFlash, setSessionFlash] = useState<string | null>(null);
  // Session profitability breaker (paper-measured, live-enforced). The state
  // query is public and read-only; the arm switch is on the LIVE row, so it is
  // read separately — on the Live tab this is the same subscription as
  // `config`, on the Paper tab it is one extra tiny doc read.
  const sessionBreaker = useQuery(
    api.strategyEngine.getSessionBreakerState,
    {},
  ) as BreakerStateLike | undefined;
  const liveConfig = useQuery(api.strategyEngine.getConfig, { book: "live" }) as
    | { sessionBreakerEnabled?: boolean }
    | undefined;
  const gateArmed = liveConfig?.sessionBreakerEnabled !== false;
  // The card's copy reads the RESOLVED live threshold (not a hardcoded 6), so a
  // config change can never leave the breaker description claiming the wrong
  // number.
  const liveBreakerThreshold =
    ((liveConfig as any)?.liveBreakerMaxLossStreak as number | undefined) ?? 6;
  const liveBreakerManualReArm =
    (liveConfig as any)?.liveBreakerManualReArm !== false;
  // Next-session release (2026-10-23): read so the card's copy matches what the
  // entry tick will actually do — a disarm CAN end without a click.
  const liveBreakerRearmOnSession =
    (liveConfig as any)?.liveBreakerRearmOnSession !== false;
  const bucketFor = (session: string, side: "LONG" | "SHORT") =>
    sessionBreaker?.buckets?.find((b) => b.session === session && b.side === side);
  const [pendingConfirm, setPendingConfirm] = useState<{
    description: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const [runOutput, setRunOutput] = useState<string[]>([]);
  const [showOutput, setShowOutput] = useState(false);
  const [running, setRunning] = useState<"layer1" | "layer2" | "funding" | "compare" | "advisor" | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const runLayer1 = useAction(api.marketDataNode.marketDataTick);
  const runLayer2 = useAction(api.strategyEngine.strategyTick);
  const runAdvisor = useAction(api.advisor.advisorTick as any);
  const backfillFunding = useAction(api.paperTrading.backfillFundingRates as any);
  const compareFunding = useAction(api.paperTrading.compareFundingPolicies as any);

  // Sync server state without clobbering a numeric edit already in progress.
  // Convex refreshes this query after every mutation, including session toggles.
  useEffect(() => {
    if (!config || dirty || saving || sessionSaving) return;
    const vals: Record<string, number | string> = {};
    for (const f of FIELDS) {
      const v = (config as any)[f.key];
      // Optional-override fields display blank when unset (null) instead of 0
      // so the input reads as "no override".
      vals[f.key] = f.emptyIsNull ? (v ?? "") : (v ?? 0);
    }
    setLocal(vals);
    setAllowLong((config as any).allowLong !== false);
    setAllowShort((config as any).allowShort !== false);
    setFundingMode((config as any).fundingMode === "strict" ? "strict" : "bonus");
    setHtfGateShort((config as any).htfGateShort !== false);
    setHtfGateLong((config as any).htfGateLong === true);
    setHtfTf((config as any).htfTf === "1h" ? "1h" : "4h");
    setHtfShortEma((config as any).htfShortEma ?? 75);
    setHtfLongEma((config as any).htfLongEma ?? 75);
    setShortFlowGate((config as any).shortFlowGate !== false);
    setH4VolClimaxBlock((config as any).h4VolClimaxBlock !== false);
    setH4PullbackBigBlock((config as any).h4PullbackBigBlock !== false);
    setH4PullbackDeadBlock((config as any).h4PullbackDeadBlock !== false);
    setLongTrendGate((config as any).longTrendGate !== false);
    setShortTrendGate((config as any).shortTrendGate !== false);
    setBreakerEnabled((config as any).breakerEnabled !== false);
    setLiveBreakerEnabled((config as any).liveBreakerEnabled !== false);
    setChaseGuardEnabled((config as any).chaseGuardEnabled === true);
    setChopGateEnabled((config as any).chopGateEnabled === true);
    setAdvisorEnabled((config as any).advisorEnabled === true);
    setAdvisorMode((config as any).advisorMode ?? "both");
    setAdvisor1hEnabled((config as any).advisor1hEnabled === true);
    setAdvisor1hMode((config as any).advisor1hMode ?? "");
    // Unset = ON for the six detector families; the two weight-armed families
    // (SmartVol / RSI-Div) also need weight > 0 to cast anything, so their
    // button reflects the RESOLVED state rather than the raw boolean.
    setAdvisorFamily({
      advisorMomDivEnabled: (config as any).advisorMomDivEnabled !== false,
      advisorObvEnabled: (config as any).advisorObvEnabled !== false,
      advisorAdEnabled: (config as any).advisorAdEnabled !== false,
      advisorCmfEnabled: (config as any).advisorCmfEnabled !== false,
      advisorVwapEnabled: (config as any).advisorVwapEnabled !== false,
      advisorThinZoneEnabled: (config as any).advisorThinZoneEnabled !== false,
      advisorMacdEnabled: (config as any).advisorMacdEnabled !== false,
      advisorSmartVolEnabled:
        (config as any).advisorSmartVolEnabled === true &&
        Number((config as any).advisorSmartVolWeight ?? 0) > 0,
      advisorRsiDivEnabled:
        (config as any).advisorRsiDivEnabled !== false &&
        Number((config as any).advisorRsiDivWeight ?? 0) > 0,
    });
    // EMPTY array = unrestricted (default). Stored docs written before this
    // feature exist lack the fields, so fall back to [].
    setLongSessions((config as any).longSessions ?? []);
    setShortSessions((config as any).shortSessions ?? []);
  }, [config, dirty, saving]);

  // In-app confirmation when the live bot is armed. The old native
  // window.confirm is silently blocked in sandboxed preview iframes (it
  // returns false without ever rendering), so once the bot was armed every
  // config click — session chips, direction switches, HTF gates, Save —
  // became a dead no-op. This resolves through the portal dialog below.
  const askLiveConfirm = (description: string) =>
    new Promise<boolean>((resolve) => {
      // Paper edits can never affect live trading — no confirm needed.
      if (book !== "live" || !liveAccount?.enabled || typeof window === "undefined") {
        resolve(true);
        return;
      }
      setPendingConfirm({ description, resolve });
    });

  const toggleSession = async (side: "LONG" | "SHORT", s: string) => {
    if (!(await askLiveConfirm(`Changing the ${side} session filter — this affects which sessions the bot may enter.`))) return;
    const cur = side === "LONG" ? longSessions : shortSessions;
    const next = cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s];
    // Keep display order; empty array = unrestricted.
    const ordered = SESSIONS.filter((x) => next.includes(x));
    if (side === "LONG") setLongSessions(ordered);
    else setShortSessions(ordered);
    setSessionSaving(true);
    try {
      await updateConfig({ book, ...(side === "LONG" ? { longSessions: ordered } : { shortSessions: ordered }) } as any);
      setSessionFlash(`saved ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      if (side === "LONG") setLongSessions(cur);
      else setShortSessions(cur);
      setSessionFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setSessionSaving(false);
    }
  };

  const toggleSide = async (side: "LONG" | "SHORT") => {
    if (!(await askLiveConfirm(`Changing the ${side} direction switch — this affects whether the bot may enter ${side} at all.`))) return;
    const next = side === "LONG" ? !allowLong : !allowShort;
    if (side === "LONG") setAllowLong(next);
    else setAllowShort(next);
    setSessionSaving(true);
    try {
      await updateConfig({ book, ...(side === "LONG" ? { allowLong: next } : { allowShort: next }) } as any);
      setSessionFlash(
        `${side} ${next ? "allowed" : "blocked"} · ${new Date().toLocaleTimeString()}`,
      );
    } catch (e: any) {
      // revert optimistic state on failure and make the failure visible
      if (side === "LONG") setAllowLong(!next);
      else setAllowShort(!next);
      setSessionFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setSessionSaving(false);
    }
  };

  const toggleBreaker = async () => {
    const next = !breakerEnabled;
    setBreakerEnabled(next);
    setSessionSaving(true);
    try {
      await updateConfig({ book, breakerEnabled: next } as any);
      setSessionFlash(`circuit breaker ${next ? "on" : "off"} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setBreakerEnabled(!next);
      setSessionFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setSessionSaving(false);
    }
  };

  const toggleLiveBreaker = async () => {
    const next = !liveBreakerEnabled;
    setLiveBreakerEnabled(next);
    setSessionSaving(true);
    try {
      await updateConfig({ book, liveBreakerEnabled: next } as any);
      setSessionFlash(`live loss-streak breaker ${next ? "on" : "off"} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setLiveBreakerEnabled(!next);
      setSessionFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setSessionSaving(false);
    }
  };

  const rearmBreaker = async () => {
    setSessionSaving(true);
    try {
      await rearmLiveBreaker({} as any);
      setSessionFlash(`live breaker re-armed · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setSessionFlash(`re-arm failed: ${e?.message ?? "try again"}`);
    } finally {
      setSessionSaving(false);
    }
  };

  const toggleChaseGuard = async () => {
    const next = !chaseGuardEnabled;
    setChaseGuardEnabled(next);
    setChaseSaving(true);
    try {
      await updateConfig({ book, chaseGuardEnabled: next } as any);
      setChaseFlash(`chase guard ${next ? "on" : "off"} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setChaseGuardEnabled(!next);
      setChaseFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setChaseSaving(false);
    }
  };

  const toggleChopGate = async () => {
    if (!(await askLiveConfirm("Changing the 4H choppiness gate — when on, a sideways 4H tape (ER below the floor) blocks BOTH sides on this book."))) return;
    const next = !chopGateEnabled;
    setChopGateEnabled(next);
    setSessionSaving(true);
    try {
      await updateConfig({ book, chopGateEnabled: next } as any);
      setSessionFlash(`4H chop gate ${next ? "on" : "off"} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setChopGateEnabled(!next);
      setSessionFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setSessionSaving(false);
    }
  };

  const saveAdvisorMode = async (mode: "pair" | "btc" | "both") => {
    if (mode === advisorMode) return;
    const desc =
      mode === "pair"
        ? "gates entries on each pair's own 4H verdict"
        : mode === "btc"
          ? "gates ALL entries on BTC's 4H verdict alone"
          : "gates entries on BOTH the pair's own and BTC's 4H verdicts (either blocks)";
    if (!(await askLiveConfirm(`Switching advisor mode to ${mode.toUpperCase()} — ${desc}.`))) return;
    const prev = advisorMode;
    setAdvisorMode(mode);
    setAdvisorSaving(true);
    try {
      await updateConfig({ book, advisorMode: mode } as any);
      setAdvisorFlash(`mode: ${mode} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setAdvisorMode(prev);
      setAdvisorFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setAdvisorSaving(false);
    }
  };

  // 1H-only input mode (2026-09-12): the hourly layer's own pair/btc/both
  // override, independent of the 4H mode. Blank = share the 4H mode; saving
  // blank sends null, which the mutation turns into a cleared override.
  const saveAdvisor1hMode = async (mode: "pair" | "btc" | "both" | "") => {
    if (mode === advisor1hMode) return;
    const desc =
      mode === ""
        ? "follow the shared 4H advisor mode"
        : mode === "pair"
          ? "gate the hourly layer on each pair's own 1H verdict"
          : mode === "btc"
            ? "gate the hourly layer on BTC's 1H verdict alone"
            : "gate the hourly layer on BOTH the pair's and BTC's 1H verdicts (either blocks)";
    if (!(await askLiveConfirm(`1H advisor mode → ${mode === "" ? "SHARED" : mode.toUpperCase()} — ${desc}.`))) return;
    const prev = advisor1hMode;
    setAdvisor1hMode(mode);
    setAdvisorSaving(true);
    try {
      await updateConfig({ book, advisor1hMode: mode === "" ? null : mode } as any);
      setAdvisorFlash(`1H mode: ${mode === "" ? "shared" : mode} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setAdvisor1hMode(prev);
      setAdvisorFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setAdvisorSaving(false);
    }
  };

  const toggleAdvisor = async () => {
    if (!(await askLiveConfirm("Changing the HTF advisor — when on, its 4H divergence/exhaustion veto gates entries on this book."))) return;
    const next = !advisorEnabled;
    setAdvisorEnabled(next);
    setAdvisorSaving(true);
    try {
      await updateConfig({ book, advisorEnabled: next } as any);
      setAdvisorFlash(`${next ? "on" : "off"} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setAdvisorEnabled(!next);
      setAdvisorFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setAdvisorSaving(false);
    }
  };

  // 1H advisor toggle (2026-09-12): the SAME detector/weights as the 4H
  // layer, evaluated on hourly bars. Off by default until the cache backtest
  // validates it; when on it vetoes with the book's own thresholds.
  const toggleAdvisor1h = async () => {
    if (!(await askLiveConfirm("Changing the 1H advisor — when on, its hourly divergence/exhaustion veto also gates entries on this book (stacks with the 4H layer)."))) return;
    const next = !advisor1hEnabled;
    setAdvisor1hEnabled(next);
    setAdvisorSaving(true);
    try {
      await updateConfig({ book, advisor1hEnabled: next } as any);
      setAdvisorFlash(`1H ${next ? "on" : "off"} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setAdvisor1hEnabled(!next);
      setAdvisorFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setAdvisorSaving(false);
    }
  };

  // Per-family switch (2026-10-23). The confirmation names the family's
  // measured strength/weakness at the moment of the click — the point of the
  // split is to know WHAT you are disarming, not just that you disarmed it.
  const toggleAdvisorFamily = async (f: (typeof ADVISOR_FAMILIES)[number]) => {
    const current = advisorFamily[f.key] ?? f.defaultOn;
    const next = !current;
    const weightKey = (f as any).weightKey as string | undefined;
    if (
      !(await askLiveConfirm(
        `4H advisor family — ${f.label} → ${next ? "ON" : "OFF"}. ` +
          `${next ? `Strength: ${f.strong}` : `Weakness (why it may be worth off): ${f.weak}`}` +
          `\n\nThe 4H and 1H advisor ticks always read the PAPER book's config, so this switch only changes the votes when saved on the paper book.`,
      ))
    )
      return;
    setAdvisorFamily((prev) => ({ ...prev, [f.key]: next }));
    setAdvisorSaving(true);
    try {
      const patch: Record<string, any> = { [f.key]: next };
      // Weight-armed families: the boolean alone is a no-op knob, so arm them
      // at weight 1 and disarm at 0 (a custom weight above 0 is preserved).
      if (weightKey) {
        const cur = Number((local as any)[weightKey] ?? 0);
        patch[weightKey] = next ? (cur > 0 ? cur : 1) : 0;
      }
      await updateConfig({ book, ...patch } as any);
      setAdvisorFlash(`${f.label} ${next ? "on" : "off"} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setAdvisorFamily((prev) => ({ ...prev, [f.key]: current }));
      setAdvisorFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setAdvisorSaving(false);
    }
  };

  const handleRunAdvisor = async () => {
    setRunning("advisor");
    setRunOutput(["Running HTF advisor (4H divergence + volume-exhaustion scan for all tracked pairs)..."]);
    setShowOutput(true);
    try {
      const result = await runAdvisor({});
      setRunOutput([
        "HTF advisor complete:",
        `  Pairs: ${result.pairs} · with 4H data: ${result.withData}`,
        `  Vetoing LONG: ${result.vetoLong} · vetoing SHORT: ${result.vetoShort}`,
        "",
        ...result.results,
      ]);
    } catch (e: any) {
      setRunOutput([`HTF advisor error: ${e?.message ?? "request failed"}`]);
    } finally {
      setRunning(null);
    }
  };

  // 1H advisor manual scan (2026-09-12): the same action with interval=1h —
  // computes hourly verdicts for every tracked pair (skip guard: no-op if a
  // 1H scan ran within the last 30 min).
  const handleRunAdvisor1h = async () => {
    setRunning("advisor");
    setRunOutput(["Running 1H advisor (hourly divergence + volume-exhaustion scan for all tracked pairs)..."]);
    setShowOutput(true);
    try {
      const result = await runAdvisor({ interval: "1h" });
      setRunOutput([
        "1H advisor complete:",
        `  Pairs: ${result.pairs} · with 1H data: ${result.withData}`,
        `  Vetoing LONG: ${result.vetoLong} · vetoing SHORT: ${result.vetoShort}`,
        "",
        ...result.results,
      ]);
    } catch (e: any) {
      setRunOutput([`1H advisor error: ${e?.message ?? "request failed"}`]);
    } finally {
      setRunning(null);
    }
  };

  const toggleTrendGate = async (side: "LONG" | "SHORT") => {
    if (!(await askLiveConfirm(`Changing the ${side} trend gate — when on, ${side === "LONG" ? "longs" : "shorts"} require the fast EMA ${side === "LONG" ? "above" : "below"} the slow EMA on the signal bar (hard gate, no score compensation).`))) return;
    const next = side === "LONG" ? !longTrendGate : !shortTrendGate;
    if (side === "LONG") setLongTrendGate(next);
    else setShortTrendGate(next);
    setTrendSaving(true);
    try {
      await updateConfig({ book, ...(side === "LONG" ? { longTrendGate: next } : { shortTrendGate: next }) } as any);
      setTrendFlash(`${side === "LONG" ? "Long" : "Short"} gate ${next ? "on" : "off"} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      if (side === "LONG") setLongTrendGate(!next);
      else setShortTrendGate(!next);
      setTrendFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setTrendSaving(false);
    }
  };

  const toggleShortFlowGate = async () => {
    if (!(await askLiveConfirm("Changing the SHORT flow gate — when on, shorts require aggressive-seller flow confirmation (flowBias < 0)."))) return;
    const next = !shortFlowGate;
    setShortFlowGate(next);
    setFlowSaving(true);
    try {
      await updateConfig({ book, shortFlowGate: next } as any);
      setFlowFlash(`${next ? "on" : "off"} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setShortFlowGate(!next);
      setFlowFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setFlowSaving(false);
    }
  };

  // H4 quality gates (2026-09-23): one toggle per lab filter. Both books
  // share the same lab defaults; a flip writes the boolean to the book's row.
  const toggleH4Gate = async (key: "h4VolClimaxBlock" | "h4PullbackBigBlock" | "h4PullbackDeadBlock", cur: boolean, set: (v: boolean) => void) => {
    if (!(await askLiveConfirm("Changing an H4 quality gate — these block entries after extreme 4h bars / RSI heat (see the journal labs)."))) return;
    const next = !cur;
    set(next);
    setH4GateSaving(true);
    try {
      await updateConfig({ book, [key]: next } as any);
      setH4GateFlash(`${key} ${next ? "on" : "off"} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      set(!next);
      setH4GateFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setH4GateSaving(false);
    }
  };

  const toggleHtfGate = async (side: "SHORT" | "LONG") => {
    if (!(await askLiveConfirm(`Changing the ${side} HTF 1H trend gate — this affects ${side === "SHORT" ? "short" : "long"} entries.`))) return;
    const next = side === "SHORT" ? !htfGateShort : !htfGateLong;
    if (side === "SHORT") setHtfGateShort(next);
    else setHtfGateLong(next);
    setHtfSaving(true);
    try {
      await updateConfig({ book, ...(side === "SHORT" ? { htfGateShort: next } : { htfGateLong: next }) } as any);
      setHtfFlash(
        `${side === "SHORT" ? "Short" : "Long"} gate ${next ? "on" : "off"} · ${new Date().toLocaleTimeString()}`,
      );
    } catch (e: any) {
      if (side === "SHORT") setHtfGateShort(!next);
      else setHtfGateLong(!next);
      setHtfFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setHtfSaving(false);
    }
  };

  const toggleHtfTf = async () => {
    if (!(await askLiveConfirm(`Switching the HTF gate timeframe to ${htfTf === "4h" ? "1H (legacy 60-bar read)" : "4H (deep 240-bar EMA)"} — this changes which bars the trend gate reads.`))) return;
    const next: "1h" | "4h" = htfTf === "4h" ? "1h" : "4h";
    const prev = htfTf;
    setHtfTf(next);
    setHtfSaving(true);
    try {
      await updateConfig({ book, htfTf: next } as any);
      setHtfFlash(`HTF gate ${next.toUpperCase()} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setHtfTf(prev);
      setHtfFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setHtfSaving(false);
    }
  };

  const setHtfEmaPeriod = async (side: "SHORT" | "LONG", value: string) => {
    const parsed = Number(value);
    // Panel range matches the Filters group fields (5–200). Save only valid
    // values; empty/partial input waits for a complete number.
    if (!Number.isFinite(parsed) || parsed < 5 || parsed > 200) return;
    if (!(await askLiveConfirm(`Changing the ${side} HTF 1H gate EMA period to ${parsed}.`))) return;
    const key = side === "SHORT" ? "htfShortEma" : "htfLongEma";
    const prev = side === "SHORT" ? htfShortEma : htfLongEma;
    if (side === "SHORT") setHtfShortEma(parsed);
    else setHtfLongEma(parsed);
    setHtfSaving(true);
    try {
      await updateConfig({ book, [key]: parsed } as any);
      setHtfFlash(`${side === "SHORT" ? "Short" : "Long"} gate EMA ${parsed} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      if (side === "SHORT") setHtfShortEma(prev);
      else setHtfLongEma(prev);
      setHtfFlash(`save failed: ${e?.message ?? "try again"}`);
    } finally {
      setHtfSaving(false);
    }
  };

  const handleChange = (key: string, value: string) => {
    setLocal((prev) => ({ ...prev, [key]: value === "" ? "" : Number(value) }));
    setDirty(true);
    setSaveError(null);
  };

  const handleSave = async () => {
    const invalid = FIELDS.find((field) => {
      const value = local[field.key];
      // Optional-override fields may be blank (saves as null → shared value).
      if (field.emptyIsNull && (value === "" || value == null)) return false;
      return value === "" || value == null || !Number.isFinite(Number(value));
    });
    if (invalid) {
      setSaveError(`${invalid.label} needs a valid number before saving.`);
      return;
    }
    const lockError = rLockConfigError(
      local.trailLockStartR,
      local.trailLockMaxR,
      local.trailLockStepR,
    );
    if (lockError) {
      setSaveError(lockError);
      return;
    }
    if (!(await askLiveConfirm("Saving shared strategy changes — they can affect the next real entry."))) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Map blank optional fields to null so the engine falls back to the
      // shared value instead of storing an empty string.
      const payload: Record<string, number | string | null> = { ...local, book };
      for (const f of FIELDS) {
        if (f.emptyIsNull && (payload[f.key] === "" || payload[f.key] == null)) {
          payload[f.key] = null;
        }
      }
      await updateConfig(payload as any);
      setDirty(false);
      setLastSaved(new Date().toLocaleTimeString());
    } catch (e: any) {
      setSaveError(e?.message ?? "Unable to save strategy settings");
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (!(await askLiveConfirm("Resetting the shared strategy configuration — this can affect the next real entry."))) return;
    setSaveError(null);
    try {
      const result = await resetConfig({ book });
    if (result?.config) {
      const vals: Record<string, number | string> = {};
      for (const f of FIELDS) {
        const v = (result.config as any)[f.key];
        vals[f.key] = f.emptyIsNull ? (v ?? "") : (v ?? 0);
      }
      setLocal(vals);
      setAllowLong(result.config.allowLong !== false);
      setAllowShort(result.config.allowShort !== false);
      setFundingMode(result.config.fundingMode === "strict" ? "strict" : "bonus");
      setHtfGateShort(result.config.htfGateShort !== false);
      setHtfGateLong(result.config.htfGateLong === true);
      setHtfTf(result.config.htfTf === "1h" ? "1h" : "4h");
      setHtfShortEma(result.config.htfShortEma ?? 75);
      setHtfLongEma(result.config.htfLongEma ?? 75);
      setShortFlowGate(result.config.shortFlowGate !== false);
      setLongTrendGate(result.config.longTrendGate !== false);
      setShortTrendGate(result.config.shortTrendGate !== false);
      setBreakerEnabled(result.config.breakerEnabled !== false);
      setLiveBreakerEnabled(result.config.liveBreakerEnabled !== false);
      setChaseGuardEnabled(result.config.chaseGuardEnabled === true);
      setChopGateEnabled(result.config.chopGateEnabled === true);
      setAdvisorEnabled(result.config.advisorEnabled === true);
      setAdvisorMode(result.config.advisorMode ?? "both");
      setAdvisor1hMode(result.config.advisor1hMode ?? "");
      setLongSessions(result.config.longSessions ?? []);
      setShortSessions(result.config.shortSessions ?? []);
      setDirty(false);
      setLastSaved("reset");
      }
    } catch (e: any) {
      setSaveError(e?.message ?? "Unable to reset strategy settings");
    }
  };

  const handleRunLayer1 = async () => {
    setRunning("layer1");
    setRunOutput([`Running Layer 1 (market data for ${LAYER1_PAIRS.length} tracked pairs)...`]);
    setShowOutput(true);
    try {
      const result = await runLayer1({});
      setRunOutput([
        `Layer 1 complete:`,
        `  Status: ${result.status}`,
        `  Pairs fetched: ${result.pairs}`,
        `  Errors: ${result.errors}`,
      ]);
    } catch (e: any) {
      setRunOutput([`Layer 1 error: ${e.message}`]);
    } finally {
      setRunning(null);
    }
  };

  const handleRunLayer2 = async () => {
    setRunning("layer2");
    setRunOutput(["Running Layer 2 (strategy scan)..."]);
    setShowOutput(true);
    try {
      const result = await runLayer2({});
      const lines = [
        `Layer 2 complete:`,
        `  Scanned: ${result.scanned} pairs`,
        `  Signals: ${result.signals}`,
        `  Entries: ${result.entries}`,
        "",
        ...result.results,
      ];
      setRunOutput(lines);
    } catch (e: any) {
      setRunOutput([`Layer 2 error: ${e.message}`]);
    } finally {
      setRunning(null);
    }
  };

  const toggleFundingMode = async () => {
    if (!(await askLiveConfirm("Changing the funding policy — strict mode can block entries when funding disagrees."))) return;
    const next = fundingMode === "bonus" ? "strict" : "bonus";
    setFundingMode(next);
    try {
      await updateConfig({ book, fundingMode: next } as any);
      setSessionFlash(`funding ${next} · ${new Date().toLocaleTimeString()}`);
    } catch (e: any) {
      setFundingMode(fundingMode);
      setSessionFlash(`save failed: ${e?.message ?? "try again"}`);
    }
  };

  const handleBackfillFunding = async () => {
    setRunning("funding");
    setRunOutput(["Backfilling missing funding rates from MEXC history…"]);
    setShowOutput(true);
    try {
      const result = await backfillFunding({});
      setRunOutput([
        "Funding backfill complete:",
        `  Patched: ${result.patched}`,
        `  Unavailable: ${result.unavailable}`,
        `  Failed: ${result.failed}`,
        `  Missing at start: ${result.totalMissing}`,
      ]);
    } catch (e: any) {
      setRunOutput([`Funding backfill error: ${e?.message ?? "request failed"}`]);
    } finally {
      setRunning(null);
    }
  };

  const handleCompareFunding = async () => {
    setRunning("compare");
    setRunOutput(["Replaying realized trades under bonus and strict funding policies…"]);
    setShowOutput(true);
    try {
      const result = await compareFunding({});
      const baselineWr = result.baseline.trades > 0 ? (result.baseline.wins / result.baseline.trades) * 100 : 0;
      const strictWr = result.strict.trades > 0 ? (result.strict.wins / result.strict.trades) * 100 : 0;
      setRunOutput([
        "Funding policy comparison complete:",
        "  Safer bonus (baseline):",
        `    Trades: ${result.baseline.trades} · Win rate: ${baselineWr.toFixed(1)}% · PnL: $${result.baseline.pnlUsd.toFixed(2)}`,
        "  Strict agreement replay:",
        `    Trades: ${result.strict.trades} · Win rate: ${strictWr.toFixed(1)}% · PnL: $${result.strict.pnlUsd.toFixed(2)}`,
        `  Strict would block: ${result.strictBlocked}`,
        `  Missing funding: ${result.missingFunding}`,
        "  Note: this is a realized-trade policy replay, not a candle-level backtest of skipped signals.",
      ]);
    } catch (e: any) {
      setRunOutput([`Funding comparison error: ${e?.message ?? "request failed"}`]);
    } finally {
      setRunning(null);
    }
  };

  if (!config) {
    return (
      <GlassCard>
        <div className="animate-pulse py-6 text-center text-xs text-slate-400">
          Loading config…
        </div>
      </GlassCard>
    );
  }

  const groups = (Object.keys(GROUPS) as FieldDef["group"][]).filter((g) =>
    FIELDS.some((f) => f.group === g),
  );

  return (
    <GlassCard
      icon={<SlidersHorizontal className="size-4" />}
      title="Strategy Config"
      subtitle="Controls apply to one book at a time — paper gathers data, live trades"
      action={
        dirty ? (
          <Chip tone="amber">unsaved</Chip>
        ) : (
          <Chip tone="up">✓ saved{lastSaved ? ` ${lastSaved}` : ""}</Chip>
        )
      }
    >
      <div className="space-y-5">
        {book === "live" && liveAccount?.enabled && (
          <div className="flex items-start gap-2.5 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-3.5 text-xs font-medium text-rose-700 backdrop-blur-md shadow-xs">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-rose-600" />
            <span className="leading-relaxed"><strong className="font-bold">Live bot armed.</strong> Numeric adjustments & session toggles directly govern upcoming real order placements.</span>
          </div>
        )}
        <div className="rounded-2xl border border-white/60 bg-white/40 p-3 backdrop-blur-md">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Controls apply to</span>
            <div className="flex rounded-xl border border-white/70 bg-white/50 p-0.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9)]">
              {(["live", "paper"] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  onClick={() => {
                    setBook(b);
                    setDirty(false);
                    setSaving(false);
                    setSessionSaving(false);
                    setSaveError(null);
                    setSessionFlash(null);
                  }}
                  className={cn(
                    "rounded-[10px] px-3 py-1 text-[11px] font-bold tracking-tight transition-all",
                    book === b
                      ? b === "live"
                        ? "bg-gradient-to-r from-sky-500 to-indigo-600 text-white shadow-sm"
                        : "bg-slate-700 text-white shadow-sm"
                      : "text-slate-500 hover:text-slate-800",
                  )}
                >
                  {b === "live" ? "Live" : "Paper"}
                </button>
              ))}
            </div>
          </div>
          <p className={cn("mt-2 text-[11px] leading-relaxed", book === "live" ? "text-slate-500" : "text-amber-700")}>
            {book === "live"
              ? "Gates are shared — a threshold saved here applies to BOTH books, so paper keeps validating exactly what live trades. Only the session breaker and coin priority are per book."
              : "Paper is the data-gathering book: it trades every coin in every session, whatever the allowlists say, and measures the session breaker + coin ranking that live enforces. Gate thresholds are shared with live."}
          </p>
        </div>
        {/* Engine readout */}
        {/* MOBILE (2026-10-28): the SL/TP readout is one long mono string — on a
            phone it now wraps under the EMA label instead of overflowing. */}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-2xl border border-white/70 bg-white/50 px-4 py-2.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9)] text-xs text-slate-600 backdrop-blur-md">
          <span className="font-semibold text-slate-700">EMA {local.emaFast ?? "?"}/{local.emaSlow ?? "?"}</span>
          <span className="font-mono font-bold text-slate-900 tracking-tight">
            SL {local.stopLossPct ?? "?"}% · TP{" "}
            {Number(local.trailLockStartR ?? 0) > 0
              ? `R-lock ${local.trailLockStartR}R→max ${local.trailLockMaxR ?? "?"}R`
              : `${local.takeProfitPct ?? "?"}%`}
          </span>
        </div>

        {/* ── Direction kill switches ── */}
        <div className="grid grid-cols-2 gap-3">
          <SideSwitch
            side="LONG"
            on={allowLong}
            busy={sessionSaving}
            onToggle={() => toggleSide("LONG")}
          />
          <SideSwitch
            side="SHORT"
            on={allowShort}
            busy={sessionSaving}
            onToggle={() => toggleSide("SHORT")}
          />
        </div>

        {/* ── CHASE GUARD (live only) — shipped OFF 2026-09-20 ── */}
        <section className="rounded-2xl border border-white/60 bg-white/40 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-xl">
          <div className="mb-1.5 flex items-center justify-between">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Chase guard <span className="text-slate-300">· live only</span>
            </h4>
            {chaseSaving ? (
              <span className="text-[10px] text-slate-400">saving…</span>
            ) : chaseFlash ? (
              <span className={cn("text-[10px] font-medium", chaseFlash.startsWith("save failed") ? "text-rose-600" : "text-emerald-600")}>
                {chaseFlash}
              </span>
            ) : null}
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
            When the position cap delays an entry, the bot remembers the pair&apos;s FIRST signal and can refuse to enter
            later if price drifted past the max drift below — or if the setup went stale. It ships{" "}
            <strong className="font-semibold text-slate-500">OFF</strong> (2026-09-20): on the live book it blocked
            prompt entries and then let the pair in later at a worse price, so it is parked until re-measured. Off = no
            anchors, no blocking, no capped dry scan.
          </p>
            <GateRow
            title="Enable chase guard"
            blurb={
              chaseGuardEnabled
                ? "cap-delayed entries are drift + age checked"
                : "cap-delayed entries are allowed (guard off)"
            }
            on={chaseGuardEnabled}
            disabled={chaseSaving}
            onToggle={toggleChaseGuard}
          />
        </section>

        {/* ── 4H CHOPPINESS GATE (2026-09-22, ships OFF) ── */}
        <section className="rounded-2xl border border-white/60 bg-white/40 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-xl">
          <div className="mb-1.5 flex items-center justify-between">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              4H chop gate <span className="text-slate-300">· ER floor</span>
            </h4>
            {sessionSaving ? (
              <span className="text-[10px] text-slate-400">saving…</span>
            ) : sessionFlash ? (
              <span className={cn("text-[10px] font-medium", sessionFlash.startsWith("save failed") ? "text-rose-600" : "text-emerald-600")}>
                {sessionFlash}
              </span>
            ) : null}
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
            Blocks BOTH sides while the pair&apos;s own 4H tape is a sideways weave: efficiency ratio (net move ÷ path
            length) over the last {local.chopGatePeriod ?? "?"} closed 4H bars below {local.chopGateFloor ?? "?"}. Built
            for the INJ 4H weave around its filter EMA — a choppy 4H becomes a no-trade window instead of a stop-farm.
            Ships <strong className="font-semibold text-slate-500">OFF</strong>, and the 6-month A/B (backtest:chopgate,
            2026-09-22) is why: it did <strong className="font-semibold text-slate-500">not</strong> clear the promotion
            bar (Δ net/t +0.009, paired-day t 0.34, IS +0.030 → OOS −0.012). Stays parked, re-runnable, off by default.
          </p>
            <GateRow
            title="Enable 4H chop gate"
            blurb={
              chopGateEnabled
                ? `ER(${local.chopGatePeriod ?? "?"}) below the floor blocks entries on this book · long ${local.chopGateFloorLong ?? local.chopGateFloor ?? "?"} / short ${local.chopGateFloorShort ?? local.chopGateFloor ?? "?"}`
                : "entries allowed regardless of the 4H efficiency ratio"
            }
            on={chopGateEnabled}
            disabled={sessionSaving}
            onToggle={toggleChopGate}
          />
        </section>

        {/* ── HTF 1H trend gates ── */}
        <section className="rounded-2xl border border-white/60 bg-white/40 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-xl">
          <div className="mb-1.5 flex items-center justify-between">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">HTF gate</h4>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void toggleHtfTf()}
                disabled={htfSaving}
                className={cn(
                  "rounded-xl border px-2.5 py-1.5 text-[10px] font-bold transition-all disabled:opacity-50",
                  htfTf === "4h"
                    ? "border-sky-300/50 bg-sky-500/10 text-sky-700"
                    : "border-slate-300/50 bg-slate-500/10 text-slate-600",
                )}
              >
                {htfTf === "4h" ? "4H · deep EMA" : "1H · legacy"}
              </button>
              {htfSaving ? (
                <span className="text-[10px] text-slate-400">saving…</span>
              ) : htfFlash ? (
                <span className={cn("text-[10px] font-medium", htfFlash.startsWith("save failed") ? "text-rose-600" : "text-emerald-600")}>
                  {htfFlash}
                </span>
              ) : null}
            </div>
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
            Vetoes entries that trade against the coin's {htfTf === "4h" ? "4H" : "1H"} trend (EMA{` ${local.htfShortEma ?? "?"}`} short / EMA{` ${local.htfLongEma ?? "?"}`} long).{htfTf === "4h" ? " 4H read = deep 240-bar SMA-seeded EMA on the last closed 4h bar." : ""}
          </p>
          <div className="mb-3 space-y-2">
            <div className="flex items-center justify-between gap-2 rounded-xl border border-white/60 bg-white/30 px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-600">Short gate EMA</div>
                <div className="text-[10px] text-slate-400">{htfTf === "4h" ? "4H" : "1H"} trend period · 5–200</div>
              </div>
              <input
                type="number"
                min={5}
                max={200}
                step={1}
                defaultValue={htfShortEma}
                key={`htf-short-${book}-${htfShortEma}`}
                disabled={htfSaving}
                onBlur={(e) => {
                  const v = e.target.value;
                  if (Number(v) !== htfShortEma) void setHtfEmaPeriod("SHORT", v);
                }}
                className="w-16 rounded-lg border border-white/70 bg-white/50 px-2 py-1 text-right text-xs font-semibold text-slate-600 tabular-nums outline-none focus:ring-2 focus:ring-sky-300 disabled:opacity-50"
              />
            </div>
            <div className="flex items-center justify-between gap-2 rounded-xl border border-white/60 bg-white/30 px-3 py-2">
              <div className="min-w-0">
                <div className="text-xs font-semibold text-slate-600">Long gate EMA</div>
                <div className="text-[10px] text-slate-400">{htfTf === "4h" ? "4H" : "1H"} trend period · 5–200</div>
              </div>
              <input
                type="number"
                min={5}
                max={200}
                step={1}
                defaultValue={htfLongEma}
                key={`htf-long-${book}-${htfLongEma}`}
                disabled={htfSaving}
                onBlur={(e) => {
                  const v = e.target.value;
                  if (Number(v) !== htfLongEma) void setHtfEmaPeriod("LONG", v);
                }}
                className="w-16 rounded-lg border border-white/70 bg-white/50 px-2 py-1 text-right text-xs font-semibold text-slate-600 tabular-nums outline-none focus:ring-2 focus:ring-sky-300 disabled:opacity-50"
              />
            </div>
          </div>
          <div className="space-y-2">
            <GateRow
              title="Short gate"
              blurb={htfGateShort ? `blocks SHORT when the last ${htfTf} close is above the ${htfTf.toUpperCase()} gate EMA` : `shorts allowed regardless of the ${htfTf.toUpperCase()} gate EMA`}
              on={htfGateShort}
              disabled={htfSaving}
              onToggle={() => toggleHtfGate("SHORT")}
            />
            <GateRow
              title="Long gate (mirror)"
              blurb={htfGateLong ? `blocks LONG when the last ${htfTf} close is below the ${htfTf.toUpperCase()} gate EMA` : `longs allowed regardless of the ${htfTf.toUpperCase()} gate EMA`}
              on={htfGateLong}
              disabled={htfSaving}
              onToggle={() => toggleHtfGate("LONG")}
            />
          </div>
        </section>

        {/* ── HTF advisor (2026-09-08) ── */}
        <section className="rounded-2xl border border-white/60 bg-white/40 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-xl">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <Radar className="size-3.5 text-sky-600" />
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">HTF Advisor · 4H</h4>
              </div>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                {book === "paper"
                  ? "Vetoes paper entries when 4H structure says the move is exhausted: RSI/OBV/A-D/CMF divergence at 4H pivots, VWAP stretch, thin-volume zones (confluence threshold below)."
                  : "Paper enforces this today; the live engine reads the same gate after validation — this toggle stores the intent."}
                {" "}Data refreshes on the 4H bar close (6×/day, own cron).
              </p>
              {advisorState && (
                <p className={cn("mt-1 text-[11px]", advisorState.ageMs > 5 * 60 * 60 * 1000 ? "text-amber-600" : "text-slate-500")}>
                  {advisorState.ageMs > 5 * 60 * 60 * 1000
                    ? `Stale — last scan ${Math.round(advisorState.ageMs / 3600000)}h ago`
                    : `Last scan ${Math.max(1, Math.round(advisorState.ageMs / 60000))}m ago · ${advisorState.pairs} pairs`}
                  {advisorEnabled
                    ? ` · ${advisorState.vetoLong} vetoing LONG · ${advisorState.vetoShort} vetoing SHORT`
                    : " · computing (not enforced)"}
                </p>
              )}
              {!advisorState && (
                <p className="mt-1 text-[11px] text-amber-600">No advisor data yet — run the 4H scan below.</p>
              )}
              {advisorSaving ? (
                <span className="text-[10px] text-slate-400">saving…</span>
              ) : advisorFlash ? (
                <span className={cn("text-[10px] font-medium", advisorFlash.startsWith("save failed") ? "text-rose-600" : "text-emerald-600")}>
                  {advisorFlash}
                </span>
              ) : null}
            </div>
            <button
              type="button"
              onClick={toggleAdvisor}
              disabled={advisorSaving}
              className={cn(
                "shrink-0 rounded-xl border px-3 py-2 text-[10px] font-bold transition-all disabled:opacity-50",
                advisorEnabled
                  ? "border-sky-300/50 bg-sky-500/10 text-sky-700"
                  : "border-slate-300/50 bg-slate-500/10 text-slate-600",
              )}
            >
              {advisorEnabled ? "Enforced" : "Off"}
            </button>
          </div>
          {advisorEnabled && (
            <div className="mt-2.5">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Advisor input mode</p>
              <div className="grid grid-cols-3 gap-1.5">
                {([["pair", "Pair"], ["btc", "BTC"], ["both", "Both"]] as const).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => saveAdvisorMode(m)}
                    disabled={advisorSaving}
                    className={cn(
                      "rounded-lg border px-2 py-1.5 text-[10px] font-bold transition-all disabled:opacity-50",
                      advisorMode === m
                        ? "border-sky-300/60 bg-sky-500/15 text-sky-700"
                        : "border-slate-300/50 bg-white/40 text-slate-600 hover:border-slate-400",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                {advisorMode === "pair"
                  ? "Each pair's own 4H divergence/exhaustion veto (original behavior)."
                  : advisorMode === "btc"
                    ? "BTC's 4H verdict gates every entry — pure macro/regime layer."
                    : "Either veto blocks — recommended (replay: 58.5% WR · +579.7R vs +484.1R at the same 36.3R drawdown)."}
              </p>
              {advisor1hEnabled && (
                <div className="mt-2.5 rounded-xl border border-teal-200/50 bg-teal-50/25 p-2">
                  <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-teal-700">1H layer input mode</p>
                  <div className="grid grid-cols-4 gap-1.5">
                    {([["", "Shared"], ["pair", "Pair"], ["btc", "BTC"], ["both", "Both"]] as const).map(([m, label]) => (
                      <button
                        key={m || "shared"}
                        type="button"
                        onClick={() => saveAdvisor1hMode(m)}
                        disabled={advisorSaving}
                        className={cn(
                          "rounded-lg border px-2 py-1.5 text-[10px] font-bold transition-all disabled:opacity-50",
                          advisor1hMode === m
                            ? "border-teal-300/60 bg-teal-500/15 text-teal-700"
                            : "border-slate-300/50 bg-white/40 text-slate-600 hover:border-slate-400",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                    {advisor1hMode === "pair"
                      ? "Each pair's own 1H verdict — the weakest arm in the mode A/B (+2.8R marginal once the 4H layer already runs pair-only)."
                      : advisor1hMode === "btc"
                        ? "BTC's 1H verdict gates every entry. Best cell of the mode A/B when the 4H layer runs Pair: 641t · WR 46.8% · +203.5R · +74.3R marginal — BTC's 1H read alone blocked 61 shorts at 21.3% WR."
                        : advisor1hMode === "both"
                          ? "Either 1H verdict blocks. Mode A/B marginal: +29.0R with the 4H layer on Pair, +44.0R with it on Both (the shipped pairing)."
                          : null}
                  </p>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
                    {advisor1hMode === ""
                      ? "Shared = follow the 4H mode above. Set BTC to keep the per-pair arm on the 4H layer while the hourly layer runs macro-only."
                      : "Blank = share the 4H mode. Clears to Shared on save."}
                  </p>
                </div>
              )}
            </div>
          )}
          {/* PER-FAMILY SWITCHES (2026-10-23): rendered even when the layer is
              Off, so a family can be pre-configured before arming. */}
          <div className="mt-2.5 rounded-xl border border-white/60 bg-white/35 p-2">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Vote families</p>
              <span className="text-[9px] text-slate-400">
                {ADVISOR_FAMILIES.filter((f) => advisorFamily[f.key] ?? f.defaultOn).length}/{ADVISOR_FAMILIES.length} voting
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {ADVISOR_FAMILIES.map((f) => {
                const on = advisorFamily[f.key] ?? f.defaultOn;
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => toggleAdvisorFamily(f)}
                    disabled={advisorSaving}
                    title={`${on ? "ON" : "OFF"} · strength: + ${f.strong} · weakness: − ${f.weak}`}
                    className={cn(
                      "rounded-lg border px-2 py-1.5 text-left text-[10px] font-bold leading-tight transition-all disabled:opacity-50",
                      on
                        ? "border-sky-300/60 bg-sky-500/15 text-sky-700"
                        : "border-slate-300/50 bg-slate-500/10 text-slate-500",
                    )}
                  >
                    {f.label}
                    <span className="block text-[9px] font-normal opacity-70">{f.w}</span>
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-slate-400">
              Off = the family still computes its flags, but casts 0 votes and writes no reason text, so it can
              neither veto alone nor help reach a confluence threshold.
              {book === "paper"
                ? " The 4H and 1H ticks read the PAPER book's config, so this is the row that decides the votes."
                : " The 4H and 1H ticks read the PAPER book's config — a switch saved here is stored but does not change the votes."}
              {!advisorEnabled && " The layer itself is Off, so nothing vetoes yet."}
            </p>
            <details className="mt-1.5">
              <summary className="cursor-pointer text-[10px] font-medium text-slate-500">
                Strength &amp; weakness of each veto
              </summary>
              <ul className="mt-1 space-y-1">
                {ADVISOR_FAMILIES.map((f) => (
                  <li key={f.key} className="text-[9px] leading-snug text-slate-500">
                    <span className="font-semibold text-slate-600">{f.label}</span>{" "}
                    <span className="text-emerald-700">+ {f.strong}</span>{" "}
                    <span className="text-rose-700">− {f.weak}</span>
                  </li>
                ))}
              </ul>
            </details>
          </div>
          {advisorEnabled && advisorState && advisorState.vetoed.length > 0 && (
            <div className="mt-2.5 max-h-36 space-y-1.5 overflow-y-auto rounded-xl border border-white/50 bg-white/35 p-2">
              {advisorState.vetoed.slice(0, 10).map((v: any) => (
                <div key={v.pair} className="flex items-start gap-2 text-[10px] leading-snug">
                  <span className="mt-0.5 shrink-0 rounded-md border border-white/60 bg-white/60 px-1.5 py-0.5 font-mono font-bold text-slate-700">
                    {v.pair}
                  </span>
                  <span className="text-slate-600">
                    {v.longStatus === "veto" && (
                      <span className="font-bold text-rose-600">LONG ✕ ({Number(v.longVotes).toFixed(1)}v) </span>
                    )}
                    {v.shortStatus === "veto" && (
                      <span className="font-bold text-rose-600">SHORT ✕ ({Number(v.shortVotes).toFixed(1)}v) </span>
                    )}
                    {[...(v.longReasons ?? []), ...(v.shortReasons ?? [])].slice(0, 1).join(" · ")}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ── 1H advisor layer (2026-09-12) ── */}
          <div className="mt-3 border-t border-white/60 pt-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Radar className="size-3.5 text-teal-600" />
                  <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">1H Advisor · hourly</h4>
                </div>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                  The SAME detector/weights on 1H bars — a faster second opinion that stacks with the 4H layer (either veto blocks).
                  Has its own per-side thresholds and its own input mode (blank = shared with the 4H layer). Backtest (Sep 1–12 disk cache,
                  wired L3.5/S2.5): 457t · WR 47.5% · +44.0R marginal on top of the 4H book — and +74.3R when this layer runs BTC-only
                  while the 4H layer runs Pair. Off by default.
                </p>
                {advisor1hState && (
                  <p className={cn("mt-1 text-[11px]", advisor1hState.ageMs > 5 * 60 * 60 * 1000 ? "text-amber-600" : "text-slate-500")}>
                    {advisor1hState.ageMs > 5 * 60 * 60 * 1000
                      ? `Stale — last scan ${Math.round(advisor1hState.ageMs / 3600000)}h ago`
                      : `Last scan ${Math.max(1, Math.round(advisor1hState.ageMs / 60000))}m ago · ${advisor1hState.pairs} pairs`}
                    {advisor1hEnabled
                      ? ` · ${advisor1hState.vetoLong} vetoing LONG · ${advisor1hState.vetoShort} vetoing SHORT`
                      : " · computing (not enforced)"}
                  </p>
                )}
                {!advisor1hState && (
                  <p className="mt-1 text-[11px] text-amber-600">No 1H advisor data yet — run the 1H scan below.</p>
                )}
              </div>
              <button
                type="button"
                onClick={toggleAdvisor1h}
                disabled={advisorSaving}
                className={cn(
                  "shrink-0 rounded-xl border px-3 py-2 text-[10px] font-bold transition-all disabled:opacity-50",
                  advisor1hEnabled
                    ? "border-teal-300/50 bg-teal-500/10 text-teal-700"
                    : "border-slate-300/50 bg-slate-500/10 text-slate-600",
                )}
              >
                {advisor1hEnabled ? "Enforced" : "Off"}
              </button>
            </div>
            <button
              type="button"
              onClick={handleRunAdvisor1h}
              disabled={running !== null}
              className="mt-2 w-full rounded-lg border border-teal-200/60 bg-teal-50/40 py-1.5 text-[10px] font-bold text-teal-700 transition-all hover:bg-teal-100/60 disabled:opacity-50"
            >
              {running === "advisor" ? "Scanning 1H…" : "Run 1H scan now"}
            </button>
            {advisor1hEnabled && advisor1hState && advisor1hState.vetoed.length > 0 && (
              <div className="mt-2.5 max-h-28 space-y-1.5 overflow-y-auto rounded-xl border border-white/50 bg-white/35 p-2">
                {advisor1hState.vetoed.slice(0, 8).map((v: any) => (
                  <div key={v.pair} className="flex items-start gap-2 text-[10px] leading-snug">
                    <span className="mt-0.5 shrink-0 rounded-md border border-white/60 bg-white/60 px-1.5 py-0.5 font-mono font-bold text-slate-700">
                      {v.pair}
                    </span>
                    <span className="text-slate-600">
                      {v.longStatus === "veto" && (
                        <span className="font-bold text-rose-600">LONG ✕ ({Number(v.longVotes).toFixed(1)}v) </span>
                      )}
                      {v.shortStatus === "veto" && (
                        <span className="font-bold text-rose-600">SHORT ✕ ({Number(v.shortVotes).toFixed(1)}v) </span>
                      )}
                      {[...(v.longReasons ?? []), ...(v.shortReasons ?? [])].slice(0, 1).join(" · ")}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        {/* ── Hard EMA trend gates (2026-09-10) ── */}
        <section className="rounded-2xl border border-white/60 bg-white/40 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-xl">
          <div className="mb-1.5 flex items-center justify-between">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Trend gate</h4>
            {trendSaving ? (
              <span className="text-[10px] text-slate-400">saving…</span>
            ) : trendFlash ? (
              <span className={cn("text-[10px] font-medium", trendFlash.startsWith("save failed") ? "text-rose-600" : "text-emerald-600")}>
                {trendFlash}
              </span>
            ) : null}
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
            The just-closed 15m bar must agree with the entry side — a hard structural gate, not score compensation.
            LONG: EMA fast &gt; EMA slow. SHORT: EMA fast &lt; EMA slow. Sep 2-10 A/B replay (coin|entryTime join): the
            LONG gate removes 12 bad-trend longs at 16.7% WR (−$37.25), lifting the long book +$154.41 → +$191.66 · PF 1.23.
          </p>
          <div className="space-y-2">
            <GateRow
              title="Require rising EMAs for LONG"
              blurb={longTrendGate ? "longs need EMA fast > EMA slow (hard gate)" : "longs allowed against EMA structure (score only)"}
              on={longTrendGate}
              disabled={trendSaving}
              onToggle={() => toggleTrendGate("LONG")}
            />
            <GateRow
              title="Require falling EMAs for SHORT"
              blurb={shortTrendGate ? "shorts need EMA fast < EMA slow (hard gate)" : "shorts allowed against EMA structure (score only)"}
              on={shortTrendGate}
              disabled={trendSaving}
              onToggle={() => toggleTrendGate("SHORT")}
            />
          </div>
        </section>

        {/* ── SHORT flow gate (2026-09-09) ── */}
        <section className="rounded-2xl border border-white/60 bg-white/40 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-xl">
          <div className="mb-1.5 flex items-center justify-between">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">SHORT flow gate</h4>
            {flowSaving ? (
              <span className="text-[10px] text-slate-400">saving…</span>
            ) : flowFlash ? (
              <span className={cn("text-[10px] font-medium", flowFlash.startsWith("save failed") ? "text-rose-600" : "text-emerald-600")}>
                {flowFlash}
              </span>
            ) : null}
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
            SHORT entries require aggressive-seller confirmation on the L1 flow snapshot (flowBias &lt; 0) — the gate that
            turned the short side profitable in the Sep 2-8 replay (+6.1R · 45-46% WR vs 23% WR without flow confirmation).
            Threshold fixed at 0; a silent snapshot (flowBias = 0) blocks, since that bucket is the losing one. LONG untouched.
          </p>
          <GateRow
            title="Require sell flow for SHORT"
            blurb={shortFlowGate ? "shorts need flowBias < 0 (aggressive sellers hitting the book)" : "shorts allowed without flow confirmation"}
            on={shortFlowGate}
            disabled={flowSaving}
            onToggle={toggleShortFlowGate}
          />
        </section>

        {/* ── H4 QUALITY GATES (2026-09-23, paper + live) ── */}
        <section className="rounded-2xl border border-white/60 bg-white/40 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-xl">
          <div className="mb-1.5 flex items-center justify-between">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">H4 quality gates</h4>
            {h4GateSaving ? (
              <span className="text-[10px] text-slate-400">saving…</span>
            ) : h4GateFlash ? (
              <span className={cn("text-[10px] font-medium", h4GateFlash.startsWith("save failed") ? "text-rose-600" : "text-emerald-600")}>
                {h4GateFlash}
              </span>
            ) : null}
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
            Entry filters from the exhaustion + volume-size labs, measured on the 17-day L1 replay and re-tested over 3
            months (lab:gate3m). Climax and RSI-heat held; the two size gates reversed there but stay on per decision —
            the shadow-tag record (lab:shadowcheck) prices every bucket at journal time. Missing 4h/RSI readings never block.
          </p>
          <div className="space-y-2">
            <GateRow
              title="Block entries after a 4h volume climax"
              blurb={h4VolClimaxBlock ? "no entry while the last closed 4h bar traded ≥4× its 20-bar median (−0.39 R/t, 22.6% WR in the lab)" : "climax bars ignored"}
              on={h4VolClimaxBlock}
              disabled={h4GateSaving}
              onToggle={() => toggleH4Gate("h4VolClimaxBlock", h4VolClimaxBlock, setH4VolClimaxBlock)}
            />
            <GateRow
              title="Block pullback entries after a big 4h candle (≥4%)"
              blurb={h4PullbackBigBlock ? "pullback entries skipped when the last 4h candle ranged ≥4% (0.07 R/t, 38.4% WR in the lab)" : "big 4h candles ignored"}
              on={h4PullbackBigBlock}
              disabled={h4GateSaving}
              onToggle={() => toggleH4Gate("h4PullbackBigBlock", h4PullbackBigBlock, setH4PullbackBigBlock)}
            />
            <GateRow
              title="Block pullback entries after a dead 4h candle (<1%)"
              blurb={h4PullbackDeadBlock ? "pullback entries skipped when the last 4h candle ranged <1% (0.12 R/t in the lab)" : "dead 4h candles ignored"}
              on={h4PullbackDeadBlock}
              disabled={h4GateSaving}
              onToggle={() => toggleH4Gate("h4PullbackDeadBlock", h4PullbackDeadBlock, setH4PullbackDeadBlock)}
            />
          </div>
        </section>

        {/* ── Number groups ── */}
        {groups.map((group) => {
          const meta = GROUPS[group];
          const Icon = meta.icon;
          // Paper has funding OFF (parked 2026-09-08) — the bonus-mode
          // weight/threshold knobs are dead on that book, so hide them there.
          // The circuit breaker is paper-only, so its knobs never show on Live.
          // riskPct is also paper-only here: the LIVE engine sizes from the
          // liveAccount doc's riskPct (edited on the Live page), so a
          // strategyConfig value for the live book would be a dead knob.
          const fields = FIELDS.filter(
            (f) =>
              f.group === group &&
              !(book === "paper" && (f.key === "fundingWeight" || f.key === "fundingBonusThreshold")) &&
              !(book === "live" && group === "Breaker") &&
              !(book === "live" && f.key === "riskPct"),
          );
          return (
            <section key={group} className="rounded-2xl border border-white/60 bg-white/40 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-xl">
              <div className="mb-2.5 flex items-center gap-2">
                <Icon className="size-3.5 text-sky-600" />
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{group}</h4>
                <span className="ml-auto hidden truncate text-[10px] text-slate-400 sm:block">{meta.blurb}</span>
              </div>
              {group === "Scoring" && gateWarnings.length > 0 && (
                <div className="mb-2.5 space-y-1" data-testid="gate-warnings">
                  {gateWarnings.map((w) => (
                    <div
                      key={w}
                      className="flex items-start gap-1.5 rounded-lg border border-amber-300/70 bg-amber-50/70 px-2 py-1.5 text-[10px] leading-snug text-amber-800 backdrop-blur-md"
                    >
                      <span aria-hidden>⚠</span>
                      <span className="font-medium">{w}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 gap-2.5">
                {fields.map((field) => (
                  <div key={field.key} className="space-y-1">
                    <Label className="text-[10px] font-semibold text-slate-500">{field.label}</Label>
                    <div className="relative">
                      <Input
                        type="number"
                        value={local[field.key] ?? ""}
                        onChange={(e) => handleChange(field.key, e.target.value)}
                        min={field.min}
                        max={field.max}
                        step={field.step}
                        className="h-8.5 rounded-xl border border-white/60 bg-white/60 pr-6 font-mono text-xs font-semibold tabular-nums text-slate-800 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9)] backdrop-blur-md transition-all focus:border-sky-400 focus:bg-white/80"
                      />
                      {field.suffix && (
                        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-medium text-slate-400">
                          {field.suffix}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}

        {/* ── Funding policy ── */}
        <section className="rounded-2xl border border-white/60 bg-white/40 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-xl">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Funding policy</h4>
              <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                {book === "paper"
                  ? "Funding is disabled on paper while the strict-agreement test is parked — entries ignore funding entirely (no veto, no score). Re-enable via resolvePaperConfig in src/lib/layer2-signal.ts."
                  : "Bonus confirms aligned funding without vetoing otherwise valid live signals. Strict blocks funding disagreement."}
              </p>
            </div>
            {book === "paper" ? (
              <span className="shrink-0 rounded-xl border border-slate-300/50 bg-slate-500/10 px-3 py-2 text-[10px] font-bold text-slate-600">
                Disabled
              </span>
            ) : (
            <button
              type="button"
              onClick={toggleFundingMode}
              className={cn(
                "shrink-0 rounded-xl border px-3 py-2 text-[10px] font-bold transition-all",
                fundingMode === "bonus"
                  ? "border-sky-300/50 bg-sky-500/10 text-sky-700"
                  : "border-amber-300/50 bg-amber-500/10 text-amber-700",
              )}
            >
              {fundingMode === "bonus" ? "Bonus · safer" : "Strict · compare"}
            </button>
            )}
          </div>
        </section>

        {/* ── Circuit breaker (paper only, 2026-09-08) ── */}
        {book === "paper" && (
          <section className="rounded-2xl border border-white/60 bg-white/40 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Circuit breaker</h4>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                  Pauses new entries while the book degrades: rolling win rate over the last 20 closes below the
                  floor, or realized loss today beyond the daily cap. Re-arms automatically as closes enter the
                  window / at UTC midnight.
                </p>
                {breakerState?.paused ? (
                  <p className="mt-1 text-[11px] font-semibold text-rose-600">
                    Tripped — {breakerState.reasons.join(" · ")}
                  </p>
                ) : breakerState ? (
                  <p className="mt-1 text-[11px] text-slate-500">
                    Armed — WR20 {breakerState.wr20 === null ? "n/a" : `${Math.round(breakerState.wr20 * 100)}%`},
                    today {breakerState.dailyPnl >= 0 ? "+" : ""}
                    {breakerState.dailyPnl.toFixed(2)} (cap -${breakerState.maxDailyLossUsd.toFixed(2)})
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={toggleBreaker}
                className={cn(
                  "shrink-0 rounded-xl border px-3 py-2 text-[10px] font-bold transition-all",
                  breakerEnabled
                    ? "border-emerald-300/50 bg-emerald-500/10 text-emerald-700"
                    : "border-slate-300/50 bg-slate-500/10 text-slate-600",
                )}
              >
                {breakerEnabled ? "On" : "Off"}
              </button>
            </div>
          </section>
        )}

        {/* ── LIVE loss-streak circuit breaker (2026-09-10) ── */}
        {book === "live" && (
          <section className="rounded-2xl border border-white/60 bg-white/40 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-xl">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Loss-streak breaker · live</h4>
                <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                  After {liveBreakerThreshold} consecutive losses the live book is DISARMED: every entry
                  signal is vetoed.{" "}
                  {liveBreakerManualReArm
                    ? liveBreakerRearmOnSession
                      ? "Two things release it: the Re-arm button, or the first session after the trip closing profitable on the PAPER book (the trip's own session is written off)."
                      : "Only the Re-arm button releases it — not a timer, not a win, not a new day."
                    : "It resumes when its cooldown ends, unless a fresh post-trigger loss re-trips it."}{" "}
                  Exits and SL/TP protection always stay active.
                </p>
                {(() => {
                  const disarmedAt = liveBreaker.disarmedAt;
                  if (typeof disarmedAt === "number") {
                    return (
                      <p className="mt-1 text-[11px] font-semibold text-rose-600">
                        DISARMED — {liveBreakerThreshold} consecutive losses (tripped{" "}
                        {new Date(disarmedAt).toLocaleString()}). No entries until you re-arm
                        {liveBreakerManualReArm && liveBreakerRearmOnSession
                          ? ", or until a session after the trip closes profitable on paper"
                          : ""}
                        .
                      </p>
                    );
                  }
                  const until = liveBreaker.pausedUntil;
                  const active =
                    !liveBreakerManualReArm &&
                    typeof until === "number" &&
                    until > Date.now();
                  if (active) {
                    const mins = Math.ceil(((until as number) - Date.now()) / 60000);
                    const hrs = Math.floor(mins / 60), rem = mins % 60;
                    return (
                      <p className="mt-1 text-[11px] font-semibold text-rose-600">
                        Paused — entries resume in ~{hrs}h {rem}m (tripped {liveBreaker.triggeredAt ? new Date(liveBreaker.triggeredAt).toLocaleTimeString() : "—"})
                      </p>
                    );
                  }
                  return (
                    <p className="mt-1 text-[11px] text-slate-500">
                      {liveBreaker.triggeredAt ? `Last breaker event ${new Date(liveBreaker.triggeredAt).toLocaleString()} · ` : ""}Armed
                    </p>
                  );
                })()}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {typeof liveBreaker.disarmedAt === "number" && (
                  <button
                    type="button"
                    onClick={rearmBreaker}
                    disabled={sessionSaving}
                    className="rounded-xl border border-rose-300/60 bg-rose-500/15 px-3 py-2 text-[10px] font-bold text-rose-700 transition-all disabled:opacity-50"
                  >
                    Re-arm
                  </button>
                )}
                <button
                  type="button"
                  onClick={toggleLiveBreaker}
                  className={cn(
                    "rounded-xl border px-3 py-2 text-[10px] font-bold transition-all",
                    liveBreakerEnabled
                      ? "border-emerald-300/50 bg-emerald-500/10 text-emerald-700"
                      : "border-slate-300/50 bg-slate-500/10 text-slate-600",
                  )}
                >
                  {liveBreakerEnabled ? "On" : "Off"}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Manual session filter */}
        <section className="rounded-2xl border border-white/60 bg-white/40 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-xl">
          <div className="mb-1.5 flex items-center justify-between">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
              Sessions
            </h4>
            {sessionSaving ? (
              <span className="text-[10px] text-slate-400">saving…</span>
            ) : sessionFlash ? (
              <span className={cn("text-[10px] font-medium", sessionFlash.startsWith("save failed") ? "text-rose-600" : "text-emerald-600")}>
              {sessionFlash}
            </span>
            ) : null}
          </div>
          <p className="mb-3 text-[11px] leading-relaxed text-slate-400">
            Per-side allowlist of entry sessions (UTC hours) — nothing selected = unrestricted.
          </p>
          <div className="space-y-3">
            <SessionRow
              side="LONG"
              allowed={longSessions}
              onToggle={toggleSession}
              busy={sessionSaving}
              bucketFor={bucketFor}
              gateArmed={gateArmed}
            />
            <SessionRow
              side="SHORT"
              allowed={shortSessions}
              onToggle={toggleSession}
              busy={sessionSaving}
              bucketFor={bucketFor}
              gateArmed={gateArmed}
            />
          </div>
          <SessionBreakerGrid state={sessionBreaker} armed={gateArmed} />
        </section>

        {/* ── Save / reset ── */}
        {saveError && <p className="text-xs font-semibold text-rose-600" role="alert">{saveError}</p>}
        <div className="flex items-center gap-2.5 pt-1">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!dirty || saving}
            className="gap-1.5 rounded-xl border border-sky-400/40 bg-gradient-to-r from-sky-500 to-indigo-600 px-4 text-xs font-bold text-white shadow-[inset_0_1px_1px_rgba(255,255,255,0.35),0_6px_20px_-4px_rgba(14,165,233,0.35)] hover:from-sky-600 hover:to-indigo-700 transition-all"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? "Saving…" : "Save changes"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleReset}
            className="gap-1.5 rounded-xl border border-white/70 bg-white/45 px-3.5 text-xs font-semibold text-slate-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.8)] backdrop-blur-xl hover:bg-white/75 transition-all"
          >
            <RotateCcw className="h-3.5 w-3.5 text-slate-400" />
            Reset
          </Button>
        </div>

        {/* ── Run now console ── */}
        <section className="border-t border-white/40 pt-3">
          <h4 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-slate-500">Run now</h4>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleRunLayer1}
              disabled={running !== null}
              className="gap-1.5 border-sky-200/60 bg-sky-50/40 text-sky-700 hover:bg-sky-100/60"
            >
              {running === "layer1" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Layer 1 · data
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRunLayer2}
              disabled={running !== null}
              className="gap-1.5 border-violet-200/60 bg-violet-50/40 text-violet-700 hover:bg-violet-100/60"
            >
              {running === "layer2" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Layer 2 · paper scan
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleRunAdvisor}
              disabled={running !== null}
              className="gap-1.5 border-sky-200/60 bg-sky-50/40 text-sky-700 hover:bg-sky-100/60"
            >
              {running === "advisor" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Advisor · 4H scan
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleBackfillFunding}
              disabled={running !== null}
              className="gap-1.5 border-emerald-200/60 bg-emerald-50/40 text-emerald-700 hover:bg-emerald-100/60"
            >
              {running === "funding" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Funding · backfill
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleCompareFunding}
              disabled={running !== null}
              className="gap-1.5 border-amber-200/60 bg-amber-50/40 text-amber-700 hover:bg-amber-100/60"
            >
              {running === "compare" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              Funding · compare
            </Button>
            {runOutput.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setShowOutput(!showOutput)}
                className="gap-1 text-xs text-slate-400"
              >
                {showOutput ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
                Output
              </Button>
            )}
          </div>
          {showOutput && runOutput.length > 0 && (
            <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg border border-white/40 bg-white/35 p-3 font-mono text-[11px] leading-relaxed text-slate-600">
              {runOutput.join("\n")}
            </pre>
          )}
        </section>
      </div>
      {pendingConfirm &&
        createPortal(
          <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/45 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
            <div className="w-full max-w-sm rounded-2xl border border-white/60 bg-white p-5 shadow-2xl">
              <div className="flex items-center gap-2 text-rose-600">
                <ShieldAlert className="size-4 shrink-0" />
                <p className="text-xs font-bold uppercase tracking-wider">Live bot armed</p>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{pendingConfirm.description}</p>
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    pendingConfirm.resolve(false);
                    setPendingConfirm(null);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    pendingConfirm.resolve(true);
                    setPendingConfirm(null);
                  }}
                >
                  Continue
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </GlassCard>
  );
}

/* ── HTF 1H gate row ── */
function GateRow({
  title,
  blurb,
  on,
  disabled,
  onToggle,
}: {
  title: string;
  blurb: string;
  on: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2.5 rounded-xl border px-3.5 py-2.5 transition-all backdrop-blur-md",
        on
          ? "border-sky-300/50 bg-sky-500/10 shadow-[inset_0_1px_1px_rgba(255,255,255,0.8)]"
          : "border-white/50 bg-white/30",
      )}
    >
      <div>
        <p className="text-xs font-bold text-slate-800">{title}</p>
        <p className="text-[10px] font-medium text-slate-400">{blurb}</p>
      </div>
      <Switch checked={on} disabled={disabled} onCheckedChange={onToggle} aria-label={title} />
    </div>
  );
}

/* ── Side kill switch ── */
function SideSwitch({
  side,
  on,
  busy,
  onToggle,
}: {
  side: "LONG" | "SHORT";
  on: boolean;
  busy: boolean;
  onToggle: () => void;
}) {
  const long = side === "LONG";
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-2.5 rounded-2xl border p-3.5 transition-all backdrop-blur-md",
        on
          ? long
            ? "border-emerald-300/50 bg-emerald-500/10 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)]"
            : "border-rose-300/50 bg-rose-500/10 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)]"
          : "border-white/50 bg-white/30",
      )}
    >
      <div>
        <p className={cn("text-xs font-extrabold tracking-tight", long ? "text-emerald-700" : "text-rose-600")}>{side}</p>
        <p className="text-[10px] font-medium text-slate-400">{on ? "entries active" : "BLOCKED"}</p>
      </div>
      <Switch
        checked={on}
        disabled={busy}
        onCheckedChange={onToggle}
        aria-label={`Allow ${side} entries`}
      />
    </div>
  );
}

/* ── Session breaker grid: paper R per session × side ── */
function SessionBreakerGrid({
  state,
  armed,
}: {
  state: BreakerStateLike | undefined;
  armed: boolean;
}) {
  const buckets = state?.buckets ?? [];
  const minTrades = state?.minTrades ?? 10;
  const lookbackDays = state?.lookbackDays ?? 14;
  const minProfitR = state?.minProfitR ?? 0;
  const byKey = new Map<string, BreakerBucketLike>();
  for (const b of buckets) byKey.set(`${b.session}|${b.side}`, b);
  const closedCount = buckets.filter((b) => b.blocked).length;

  return (
    <div className="mt-3 border-t border-white/60 pt-3">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h5 className="text-[10px] font-bold uppercase tracking-wider text-slate-400">
          Profit gate
        </h5>
        <span className="flex items-center gap-1.5">
          {buckets.length > 0 && (
            <span className="text-[10px] font-mono text-slate-400">
              {closedCount}/{buckets.length} closed
            </span>
          )}
          <span
            className={cn(
              "rounded-md border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide",
              !state
                ? "border-slate-300/60 bg-slate-500/10 text-slate-400"
                : !armed
                  ? "border-slate-300/60 bg-slate-500/10 text-slate-500"
                  : state.stale
                    ? "border-amber-400/50 bg-amber-500/10 text-amber-700"
                    : "border-emerald-400/50 bg-emerald-500/10 text-emerald-700",
            )}
            title={
              !state
                ? "Waiting on the session-breaker snapshot"
                : !armed
                  ? "sessionBreakerEnabled is off on the LIVE row — the gate blocks nothing"
                  : state.stale
                    ? "No fresh snapshot; buckets recomputed on read"
                    : "Armed — the live entry path reads this snapshot"
            }
          >
            {!state ? "…" : !armed ? "off" : state.stale ? "recomputed" : "live"}
          </span>
        </span>
      </div>
      <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
        Paper R per session × side, last {lookbackDays}d.{" "}
        {armed
          ? `A bucket at or below ${minProfitR > 0 ? "+" : ""}${minProfitR}R refuses LIVE entries, and so does one under the ${minTrades}-close floor — live does not trade unproven sessions. Paper keeps trading both either way.`
          : "The gate is off, so no bucket is refused — the numbers are shown for reference."}
      </p>
      <div className="grid grid-cols-[2.4rem_repeat(5,minmax(0,1fr))] gap-1">
        <span />
        {SESSIONS.map((s) => (
          <span
            key={s}
            className="truncate text-center text-[9px] font-bold uppercase tracking-wide text-slate-400"
          >
            {SESSION_LABEL[s] ?? s}
          </span>
        ))}
        {(["LONG", "SHORT"] as const).map((side) => (
          <Fragment key={side}>
            <span
              className={cn(
                "self-center text-[9px] font-extrabold tracking-wide",
                side === "LONG" ? "text-emerald-600" : "text-rose-600",
              )}
            >
              {side}
            </span>
            {SESSIONS.map((s) => {
              const b = byKey.get(`${s}|${side}`);
              const thin = !!b && (b.insufficient ?? b.trades < minTrades);
              const closed = !!armed && !!b?.blocked;
              return (
                <div
                  key={s}
                  title={
                    !b
                      ? `${s} ${side}: no paper closes in the window — unproven, LIVE entries refused`
                      : closed && thin
                        ? `${s} ${side}: ${b.trades} paper close(s) < ${b.minTrades ?? minTrades} — too little evidence, LIVE entries refused`
                        : closed
                          ? `${s} ${side}: ${fmtBucketR(b.sumR)} over ${b.trades} closes — LIVE entries refused`
                          : thin
                            ? `${s} ${side}: ${b.trades} paper close(s) — under the sample floor, allowed only because the gate is off`
                            : `${s} ${side}: ${fmtBucketR(b.sumR)} over ${b.trades} closes — open`
                  }
                  className={cn(
                    "rounded-lg border px-0.5 py-1 text-center leading-tight",
                    !b
                      ? "border-white/50 bg-white/25"
                      : closed
                        ? "border-rose-400/60 bg-rose-500/10"
                        : thin
                          ? "border-white/60 bg-white/35"
                          : "border-emerald-400/50 bg-emerald-500/10",
                    !armed && "opacity-55",
                  )}
                >
                  <p
                    className={cn(
                      "text-[10px] font-extrabold tabular-nums",
                      !b
                        ? "text-slate-300"
                        : closed
                          ? "text-rose-700"
                          : thin
                            ? "text-slate-500"
                            : "text-emerald-700",
                    )}
                  >
                    {b ? fmtBucketR(b.sumR) : "—"}
                  </p>
                  <p className="text-[9px] font-medium text-slate-400">
                    {b ? `${b.trades}n` : "no data"}
                  </p>
                </div>
              );
            })}
          </Fragment>
        ))}
      </div>
      {state?.computedAt ? (
        <p className="mt-1.5 text-[9px] font-mono text-slate-400">
          snapshot {pht(state.computedAt)}
        </p>
      ) : null}
    </div>
  );
}

/* ── Session chips row ── */
function SessionRow({
  side,
  allowed,
  onToggle,
  busy,
  bucketFor,
  gateArmed,
}: {
  side: "LONG" | "SHORT";
  allowed: string[];
  onToggle: (side: "LONG" | "SHORT", s: string) => void;
  busy: boolean;
  bucketFor?: (session: string, side: "LONG" | "SHORT") => BreakerBucketLike | undefined;
  gateArmed?: boolean;
}) {
  const on = side === "LONG";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={cn("w-13 text-[11px] font-extrabold tracking-wide", on ? "text-emerald-600" : "text-rose-600")}>{side}</span>
      {SESSIONS.map((s) => {
        const active = allowed.includes(s);
        // A chip can read "allowed" while the profitability gate still refuses
        // the bucket — ring it so the two halves of this card agree.
        const bucket = bucketFor?.(s, side);
        const gateClosed = !!gateArmed && !!bucket?.blocked;
        return (
          <button
            key={s}
            type="button"
            disabled={busy}
            onClick={() => onToggle(side, s)}
            title={
              (active ? `${side} allowed in ${s} — click to block` : `${side} blocked in ${s} — click to allow`) +
              (gateClosed
                ? bucket!.insufficient || bucket!.trades < (bucket!.minTrades ?? 10)
                  ? ` · profit gate closed (only ${bucket!.trades} paper close(s) — unproven)`
                  : ` · profit gate closed (${fmtBucketR(bucket!.sumR)} over ${bucket!.trades} closes)`
                : "")
            }
            className={cn(
              "rounded-xl border px-2.5 py-1 text-[10px] font-bold tracking-tight transition-all duration-200 backdrop-blur-md disabled:opacity-50",
              active
                ? on
                  ? "border-emerald-500/40 bg-emerald-500/15 text-emerald-700 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9)]"
                  : "border-rose-500/40 bg-rose-500/15 text-rose-700 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9)]"
                : "border-white/60 bg-white/45 text-slate-500 hover:bg-white/70 hover:text-slate-800",
              gateClosed && "ring-1 ring-rose-400/70",
            )}
          >
            {SESSION_LABEL[s] ?? s}
            {gateClosed && <span aria-hidden className="ml-1 text-rose-600">·</span>}
          </button>
        );
      })}
      <span className="text-[10px] font-mono text-slate-400">
        {allowed.length === 0 ? "all" : `${allowed.length}/${SESSIONS.length}`}
      </span>
    </div>
  );
}
