/**
 * Layer2DataPanel — Advanced analytics view for Layer 2 closed trades.
 * Computes per-pair, per-session, per-side, and enrichment breakdowns
 * entirely client-side from Convex trade data.
 */
import { useMemo } from "react";
import { GlassCard } from "@/components/GlassPanel";
import { BtcRegimeCard } from "@/components/BtcRegimeCard";
import { summarizeBook } from "@/lib/book-summary";
import { cn } from "@/lib/utils";
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Clock,
  Target,
  Shield,
  Zap,
  Layers,
  Loader2,
} from "lucide-react";

function avg(vals: number[]) {
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
}
function sum(vals: number[]) {
  return vals.reduce((a, b) => a + b, 0);
}

/** `+$12.34` / `−$5.67` — the signed-USD shape the other cards use. */
const signedUsd = (v: number) =>
  `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;

/** Side PnL tint: green only when that side actually made money (flat is not a win). */
const sidePnlTone = (pnl: number, trades: number) =>
  trades === 0 ? "text-slate-400" : pnl > 0 ? "text-emerald-600" : "text-rose-600";

interface TradeRow {
  _id: string;
  coin: string;
  type: string;
  entryPrice: number;
  exitPrice: number;
  slPrice: number;
  tpPrice: number;
  pnlUsd: number;
  realizedR: number;
  reason: string;
  session: string;
  longScore: number;
  shortScore: number;
  mfeR: number;
  maeR: number;
  mfeCaptureRatio: number;
  barsHeld: number;
  entrySlippageBps: number;
  totalFeesUsd: number;
  fundingCostUsd: number;
  volPct: number;
  spreadPct: number;
  atrPctAtEntry: number;
  bidAskImbalance: number;
  fundingRate: number;
  leverage: number;
  volAtExit: number;
  volDelta: number;
  btcMoveDuringTrade: number;
  durationBucket: string;
  entryTime: number;
  dayOfWeek: number;
}

export function Layer2DataPanel({
  trades,
  loading = false,
  bookLabel = "Layer 2",
}: {
  trades: any[] | null;
  loading?: boolean;
  bookLabel?: string;
}) {
  // History is passed in from Layer2Panel's on-demand cache — this panel
  // no longer keeps its own full-book subscription (was a duplicate of the
  // panel's, re-reading 400+ rows on every trade change).
  // trades === null means "not loaded yet" — never render the empty state
  // for it, or a slow fetch looks exactly like wiped history.
  const closed = useMemo(() => {
    return (trades ?? []).filter(
      (t: any) => t.status === "closed" && t.pnlUsd != null,
    ) as TradeRow[];
  }, [trades]);

  const data = useMemo(() => {
    if (closed.length === 0) return null;

    // Shared book analytics (per-session/per-side/per-reason, totals) — one
    // source shared with the live panel so the two books can never drift. Win
    // definition is (pnlUsd ?? 0) > 0, matching bookStats/liveStats and the
    // mining export. The worst-cell / top-loser lists this aggregator also
    // returns are rendered by the live panel only.
    const agg = summarizeBook(closed as any);
    if (!agg) return null;
    const totalPnl = agg.totalPnl;
    const totalFees = sum(closed.map((t) => t.totalFeesUsd ?? 0));
    const totalFunding = sum(closed.map((t) => t.fundingCostUsd ?? 0));
    const grossWin = agg.grossWin;
    const grossLoss = agg.grossLoss;

    // Per-pair breakdown
    const pairMap = new Map<string, TradeRow[]>();
    for (const t of closed) {
      const arr = pairMap.get(t.coin) || [];
      arr.push(t);
      pairMap.set(t.coin, arr);
    }
    const perPair = [...pairMap.entries()]
      .map(([coin, ts]) => {
        const w = ts.filter((t) => (t.pnlUsd ?? 0) > 0).length;
        const pnl = sum(ts.map((t) => t.pnlUsd));
        return {
          coin,
          trades: ts.length,
          wins: w,
          losses: ts.length - w,
          winRate: ts.length ? (w / ts.length) * 100 : 0,
          pnl,
          avgR: avg(ts.map((t) => t.realizedR)),
          avgMfe: avg(ts.map((t) => t.mfeR ?? 0)),
          avgBars: avg(ts.map((t) => t.barsHeld ?? 0)),
          avgSpread: avg(ts.map((t) => t.spreadPct ?? 0)),
        };
      })
      .sort((a, b) => b.pnl - a.pnl);

    // Per-session / per-side / per-reason / session×direction / worst trades:
    // shared shapes from summarizeBook, adapted to this panel's JSX keys.
    const perSession = agg.perSession.map((s) => ({
      session: s.key,
      trades: s.trades,
      longs: s.longs,
      shorts: s.shorts,
      longPnl: s.longPnl,
      shortPnl: s.shortPnl,
      wins: s.wins,
      winRate: s.winRate,
      pnl: s.pnl,
      avgR: s.avgR,
    }));

    const longs = closed.filter((t) => t.type === "LONG");
    const shorts = closed.filter((t) => t.type === "SHORT");
    const sideStats = (
      side: TradeRow[],
      base: {
        trades: number;
        wins: number;
        winRate: number;
        pnl: number;
        avgR: number;
      },
    ) => ({
      ...base,
      count: base.trades,
      avgMfe: avg(side.map((t) => t.mfeR ?? 0)),
      avgMae: avg(side.map((t) => t.maeR ?? 0)),
    });

    const perReason = agg.perReason.map((r) => ({
      reason: r.key,
      count: r.trades,
      pnl: r.pnl,
      avgR: r.avgR,
      winRate: r.winRate,
    }));

    // Duration bucket breakdown
    const durMap = new Map<string, TradeRow[]>();
    for (const t of closed) {
      const d = t.durationBucket || "unknown";
      const arr = durMap.get(d) || [];
      arr.push(t);
      durMap.set(d, arr);
    }
    const perDuration = [...durMap.entries()].map(([bucket, ts]) => ({
      bucket,
      count: ts.length,
      pnl: sum(ts.map((t) => t.pnlUsd)),
      avgR: avg(ts.map((t) => t.realizedR)),
      winRate: ts.length
        ? (ts.filter((t) => (t.pnlUsd ?? 0) > 0).length / ts.length) * 100
        : 0,
    }));

    // MFE/MAE analysis
    const avgMfe = avg(closed.map((t) => t.mfeR ?? 0));
    const avgMae = avg(closed.map((t) => t.maeR ?? 0));
    const avgCapture = avg(closed.map((t) => t.mfeCaptureRatio ?? 0));
    const avgSlippage = avg(closed.map((t) => t.entrySlippageBps ?? 0));

    // Score correlation — does higher score = better results?
    const withScores = closed.filter(
      (t) =>
        typeof t.longScore === "number" || typeof t.shortScore === "number",
    );
    const highScore = withScores.filter(
      (t) =>
        Math.abs((t.type === "LONG" ? t.longScore : t.shortScore) ?? 0) > 20,
    );
    const lowScore = withScores.filter(
      (t) =>
        Math.abs((t.type === "LONG" ? t.longScore : t.shortScore) ?? 0) <= 20,
    );

    // Enrichment coverage
    const hasMfe = closed.filter((t) => t.mfeR != null && t.mfeR !== 0).length;
    const hasFees = closed.filter(
      (t) => t.totalFeesUsd != null && t.totalFeesUsd > 0,
    ).length;
    const hasFunding = closed.filter(
      (t) => t.fundingCostUsd != null && t.fundingCostUsd !== 0,
    ).length;
    const hasBtc = closed.filter(
      (t) => t.btcMoveDuringTrade != null && t.btcMoveDuringTrade !== 0,
    ).length;

    return {
      total: agg.total,
      winRate: agg.winRate,
      totalPnl,
      totalFees,
      totalFunding,
      grossWin,
      grossLoss,
      profitFactor: agg.profitFactor,
      avgR: agg.avgR,
      avgMfe,
      avgMae,
      avgCapture,
      avgSlippage,
      perPair,
      perSession,
      longs: sideStats(longs, agg.longs),
      shorts: sideStats(shorts, agg.shorts),
      perReason,
      perDuration,
      highScore: {
        count: highScore.length,
        winRate: highScore.length
          ? (highScore.filter((t) => (t.pnlUsd ?? 0) > 0).length /
              highScore.length) *
            100
          : 0,
        pnl: sum(highScore.map((t) => t.pnlUsd)),
        avgR: avg(highScore.map((t) => t.realizedR)),
      },
      lowScore: {
        count: lowScore.length,
        winRate: lowScore.length
          ? (lowScore.filter((t) => (t.pnlUsd ?? 0) > 0).length /
              lowScore.length) *
            100
          : 0,
        pnl: sum(lowScore.map((t) => t.pnlUsd)),
        avgR: avg(lowScore.map((t) => t.realizedR)),
      },
      enrichmentCoverage: {
        mfe: hasMfe,
        fees: hasFees,
        funding: hasFunding,
        btc: hasBtc,
        total: closed.length,
      },
    };
  }, [closed]);

  // History still loading (trades === null): show a spinner, NOT the empty
  // state — an empty-state here reads as "all records deleted".
  if (trades === null || loading) {
    return (
      <GlassCard className="p-6 text-center">
        <Loader2 className="size-6 text-slate-300 mx-auto mb-2 animate-spin" />
        <p className="text-xs text-slate-400">Loading {bookLabel} history…</p>
      </GlassCard>
    );
  }

  if (!data) {
    return (
      <GlassCard className="p-6 text-center">
        <Layers className="size-8 text-slate-300 mx-auto mb-2" />
        <p className="text-xs text-slate-400">
          No closed {bookLabel} trades to analyze yet.
        </p>
      </GlassCard>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Overall Summary ── */}
      <GlassCard className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <BarChart3 className="size-4 text-violet-500" />
          <p className="text-xs font-medium text-slate-600">
            Overall Performance
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-8">
          <Stat label="Trades" value={`${data.total}`} />
          <Stat
            label="Win Rate"
            value={`${data.winRate.toFixed(1)}%`}
            color={data.winRate >= 50 ? "green" : "red"}
          />
          <Stat
            label="Total PnL"
            value={`${data.totalPnl >= 0 ? "+" : "−"}$${Math.abs(data.totalPnl).toFixed(2)}`}
            color={data.totalPnl >= 0 ? "green" : "red"}
          />
          <Stat
            label="Profit Factor"
            value={
              data.profitFactor === Infinity
                ? "∞"
                : data.profitFactor.toFixed(2)
            }
            color={
              data.profitFactor >= 1.5
                ? "green"
                : data.profitFactor >= 1
                  ? "amber"
                  : "red"
            }
          />
          <Stat
            label="Avg R"
            value={`${data.avgR >= 0 ? "+" : ""}${data.avgR.toFixed(2)}`}
            color={data.avgR >= 0 ? "green" : "red"}
          />
          <Stat
            label="Total Fees"
            value={`$${data.totalFees.toFixed(2)}`}
            color="slate"
          />
          <Stat
            label="Funding Cost"
            value={`$${data.totalFunding.toFixed(2)}`}
            color="slate"
          />
          <Stat
            label="Net (fees)"
            value={`${data.totalPnl - data.totalFees - data.totalFunding >= 0 ? "+" : "−"}$${Math.abs(data.totalPnl - data.totalFees - data.totalFunding).toFixed(2)}`}
            color={
              data.totalPnl - data.totalFees - data.totalFunding >= 0
                ? "green"
                : "red"
            }
          />
        </div>
      </GlassCard>

      {/* ── BTC Regime & Behavior ── */}
      <BtcRegimeCard closedTrades={closed} />

      {/* ── MFE / MAE / Capture ── */}
      <GlassCard className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Target className="size-4 text-sky-500" />
          <p className="text-xs font-medium text-slate-600">
            Trade Quality (MFE / MAE / Capture)
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat
            label="Avg MFE"
            value={`${data.avgMfe.toFixed(2)}R`}
            color="green"
          />
          <Stat
            label="Avg MAE"
            value={`${data.avgMae.toFixed(2)}R`}
            color="red"
          />
          <Stat
            label="Avg Capture"
            value={`${(data.avgCapture * 100).toFixed(1)}%`}
            color={data.avgCapture >= 0.5 ? "green" : "amber"}
          />
          <Stat
            label="Avg Entry Slippage"
            value={`${data.avgSlippage.toFixed(1)} bps`}
            color="slate"
          />
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-emerald-50/50 border border-emerald-200/40 px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-600">
              Avg Win MFE
            </p>
            <p className="text-sm font-bold text-emerald-700">
              {avg(
                closed
                  .filter((t) => (t.pnlUsd ?? 0) > 0)
                  .map((t) => t.mfeR ?? 0),
              ).toFixed(2)}
              R
            </p>
          </div>
          <div className="rounded-lg bg-red-50/50 border border-red-200/40 px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-red-500">
              Avg Loss MAE
            </p>
            <p className="text-sm font-bold text-red-600">
              {avg(
                closed
                  .filter((t) => (t.pnlUsd ?? 0) <= 0)
                  .map((t) => t.maeR ?? 0),
              ).toFixed(2)}
              R
            </p>
          </div>
        </div>
      </GlassCard>

      {/* ── Long vs Short ── */}
      <GlassCard className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="size-4 text-amber-500" />
          <p className="text-xs font-medium text-slate-600">
            Long vs Short Breakdown
          </p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <SideCard label="LONG" stats={data.longs} color="emerald" />
          <SideCard label="SHORT" stats={data.shorts} color="rose" />
        </div>
      </GlassCard>

      {/* ── Score Correlation ── */}
      <>
        <GlassCard className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Shield className="size-4 text-indigo-500" />
            <p className="text-xs font-medium text-slate-600">
              Score Correlation
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-violet-50/50 border border-violet-200/40 px-3 py-2">
              <p className="text-[9px] text-violet-500 uppercase mb-1">
                High Score (&gt;20)
              </p>
              <p className="text-lg font-bold text-violet-700">
                {data.highScore.count} trades
              </p>
              <p className="text-[10px] text-violet-500">
                WR: {data.highScore.winRate.toFixed(0)}% · PnL:{" "}
                {data.highScore.pnl >= 0 ? "+" : ""}$
                {data.highScore.pnl.toFixed(2)} · Avg R:{" "}
                {data.highScore.avgR.toFixed(2)}
              </p>
            </div>
            <div className="rounded-lg bg-slate-50/50 border border-slate-200/40 px-3 py-2">
              <p className="text-[9px] text-slate-400 uppercase mb-1">
                Low Score (≤20)
              </p>
              <p className="text-lg font-bold text-slate-600">
                {data.lowScore.count} trades
              </p>
              <p className="text-[10px] text-slate-500">
                WR: {data.lowScore.winRate.toFixed(0)}% · PnL:{" "}
                {data.lowScore.pnl >= 0 ? "+" : ""}$
                {data.lowScore.pnl.toFixed(2)} · Avg R:{" "}
                {data.lowScore.avgR.toFixed(2)}
              </p>
            </div>
          </div>
        </GlassCard>
      </>

      {/* ── Session Performance ── */}
      <GlassCard className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="size-4 text-teal-500" />
          <p className="text-xs font-medium text-slate-600">
            Session Breakdown
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-[11px]">
            <thead>
              <tr className="text-slate-400 text-left border-b border-white/30">
                <th className="pb-1 pr-2">Session</th>
                <th className="pb-1 pr-2">Trades</th>
                <th className="pb-1 pr-2" title="long trades · realized long PnL">
                  Long
                </th>
                <th className="pb-1 pr-2" title="short trades · realized short PnL">
                  Short
                </th>
                <th className="pb-1 pr-2">Win Rate</th>
                <th className="pb-1 pr-2">PnL</th>
                <th className="pb-1">Avg R</th>
              </tr>
            </thead>
            <tbody>
              {data.perSession.map((s) => (
                <tr key={s.session} className="border-b border-white/20">
                  <td className="py-1 pr-2 font-medium text-slate-700 capitalize">
                    {s.session}
                  </td>
                  <td className="py-1 pr-2">{s.trades}</td>
                  <td className="py-1 pr-2 whitespace-nowrap">
                    <span className="text-slate-600">{s.longs}</span>
                    <span className={cn("ml-1 text-[10px] font-medium", sidePnlTone(s.longPnl, s.longs))}>
                      {s.longs > 0 ? signedUsd(s.longPnl) : "—"}
                    </span>
                  </td>
                  <td className="py-1 pr-2 whitespace-nowrap">
                    <span className="text-slate-600">{s.shorts}</span>
                    <span className={cn("ml-1 text-[10px] font-medium", sidePnlTone(s.shortPnl, s.shorts))}>
                      {s.shorts > 0 ? signedUsd(s.shortPnl) : "—"}
                    </span>
                  </td>
                  <td className="py-1 pr-2">
                    <span
                      className={cn(
                        "font-medium",
                        s.winRate >= 50 ? "text-emerald-600" : "text-red-500",
                      )}
                    >
                      {s.winRate.toFixed(0)}%
                    </span>
                  </td>
                  <td
                    className={cn(
                      "py-1 pr-2 font-medium",
                      s.pnl >= 0 ? "text-emerald-600" : "text-rose-600",
                    )}
                  >
                    {signedUsd(s.pnl)}
                  </td>
                  <td className="py-1">
                    <span
                      className={cn(
                        "font-medium",
                        s.avgR >= 0 ? "text-emerald-600" : "text-red-500",
                      )}
                    >
                      {s.avgR >= 0 ? "+" : ""}
                      {s.avgR.toFixed(2)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassCard>

      {/* ── Per-Pair Performance ── */}
      <GlassCard className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp className="size-4 text-emerald-500" />
          <p className="text-xs font-medium text-slate-600">
            Per-Pair Performance ({data.perPair.length} pairs)
          </p>
        </div>
        <div className="overflow-x-auto max-h-72 overflow-y-auto">
          <table className="w-full min-w-[720px] text-[11px]">
            <thead>
              <tr className="text-slate-400 text-left sticky top-0 bg-white/70 backdrop-blur border-b border-white/30">
                <th className="pb-1 pr-2">Pair</th>
                <th className="pb-1 pr-2">#</th>
                <th className="pb-1 pr-2">W/L</th>
                <th className="pb-1 pr-2">WR%</th>
                <th className="pb-1 pr-2">PnL</th>
                <th className="pb-1 pr-2">Avg R</th>
                <th className="pb-1 pr-2">Avg MFE</th>
                <th className="pb-1 pr-2">Avg Bars</th>
                <th className="pb-1">Avg Spread</th>
              </tr>
            </thead>
            <tbody>
              {data.perPair.map((p) => (
                <tr key={p.coin} className="border-b border-white/20">
                  <td className="py-1 pr-2 font-semibold text-slate-700">
                    {p.coin}
                  </td>
                  <td className="py-1 pr-2">{p.trades}</td>
                  <td className="py-1 pr-2">
                    <span className="text-emerald-600">{p.wins}</span>
                    <span className="text-slate-400">/</span>
                    <span className="text-red-500">{p.losses}</span>
                  </td>
                  <td className="py-1 pr-2">
                    <span
                      className={cn(
                        "font-medium",
                        p.winRate >= 50 ? "text-emerald-600" : "text-red-500",
                      )}
                    >
                      {p.winRate.toFixed(0)}%
                    </span>
                  </td>
                  <td
                    className={cn(
                      "py-1 pr-2 font-medium",
                      p.pnl >= 0 ? "text-emerald-600" : "text-red-500",
                    )}
                  >
                    {p.pnl >= 0 ? "+" : ""}${p.pnl.toFixed(2)}
                  </td>
                  <td className="py-1 pr-2">
                    <span
                      className={cn(
                        "font-medium",
                        p.avgR >= 0 ? "text-emerald-600" : "text-red-500",
                      )}
                    >
                      {p.avgR >= 0 ? "+" : ""}
                      {p.avgR.toFixed(2)}
                    </span>
                  </td>
                  <td className="py-1 pr-2 text-emerald-600">
                    {p.avgMfe.toFixed(1)}R
                  </td>
                  <td className="py-1 pr-2 text-slate-500">
                    {p.avgBars.toFixed(0)}b
                  </td>
                  <td className="py-1 text-slate-500">
                    {p.avgSpread.toFixed(3)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassCard>

      {/* ── Exit Reason ── */}
      <GlassCard className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <TrendingDown className="size-4 text-red-500" />
          <p className="text-xs font-medium text-slate-600">
            Exit Reason Breakdown
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {data.perReason.map((r) => (
            <div
              key={r.reason}
              className={cn(
                "rounded-lg border px-3 py-2",
                r.reason === "Take Profit" ||
                  r.reason === "Trail Lock" ||
                  r.reason === "R-Lock Max"
                  ? "bg-emerald-50/50 border-emerald-200/40"
                  : r.reason === "Stop Loss"
                    ? "bg-red-50/50 border-red-200/40"
                    : "bg-slate-50/50 border-slate-200/40",
              )}
            >
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {r.reason}
              </p>
              <p className="text-lg font-bold text-slate-700">{r.count}</p>
              <p className="text-[10px] text-slate-500">
                WR: {r.winRate.toFixed(0)}% · PnL: {r.pnl >= 0 ? "+" : ""}$
                {r.pnl.toFixed(2)} · Avg R: {r.avgR.toFixed(2)}
              </p>
            </div>
          ))}
        </div>
      </GlassCard>

      {/* ── Duration Buckets ── */}
      {data.perDuration.length > 0 && (
        <GlassCard className="p-4">
          <p className="text-xs font-medium text-slate-600 mb-2">
            Duration Distribution
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {data.perDuration.map((d) => (
              <div
                key={d.bucket}
                className="rounded-lg bg-white/40 border border-white/50 px-3 py-2"
              >
                <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  {d.bucket}
                </p>
                <p className="text-lg font-bold text-slate-700">
                  {d.count} trades
                </p>
                <p className="text-[10px] text-slate-500">
                  WR: {d.winRate.toFixed(0)}% · PnL: {d.pnl >= 0 ? "+" : ""}$
                  {d.pnl.toFixed(2)}
                </p>
              </div>
            ))}
          </div>
        </GlassCard>
      )}

      {/* ── Enrichment Coverage ── */}
      <GlassCard className="p-4">
        <p className="text-xs font-medium text-slate-600 mb-2">
          Enrichment Data Coverage
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <CoverageBar
            label="MFE/MAE"
            have={data.enrichmentCoverage.mfe}
            total={data.enrichmentCoverage.total}
          />
          <CoverageBar
            label="Fees"
            have={data.enrichmentCoverage.fees}
            total={data.enrichmentCoverage.total}
          />
          <CoverageBar
            label="Funding"
            have={data.enrichmentCoverage.funding}
            total={data.enrichmentCoverage.total}
          />
          <CoverageBar
            label="BTC Move"
            have={data.enrichmentCoverage.btc}
            total={data.enrichmentCoverage.total}
          />
        </div>
      </GlassCard>
    </div>
  );
}

// ── Helpers ──

function Stat({
  label,
  value,
  color = "default",
}: {
  label: string;
  value: string;
  color?: "green" | "red" | "amber" | "slate" | "default";
}) {
  const colorClass =
    color === "green"
      ? "text-emerald-600"
      : color === "red"
        ? "text-red-500"
        : color === "amber"
          ? "text-amber-600"
          : color === "slate"
            ? "text-slate-500"
            : "text-slate-700";
  return (
    <div className="rounded-lg bg-white/40 border border-white/50 px-2 py-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p className={cn("text-sm font-bold", colorClass)}>{value}</p>
    </div>
  );
}

function SideCard({
  label,
  stats,
  color,
}: {
  label: string;
  stats: {
    count: number;
    wins: number;
    winRate: number;
    pnl: number;
    avgR: number;
    avgMfe: number;
    avgMae: number;
  };
  color: "emerald" | "rose";
}) {
  const bg =
    color === "emerald"
      ? "bg-emerald-50/50 border-emerald-200/40"
      : "bg-rose-50/50 border-rose-200/40";
  const txt = color === "emerald" ? "text-emerald-700" : "text-rose-600";
  return (
    <div className={cn("rounded-lg border px-3 py-2", bg)}>
      <p className={cn("text-xs font-bold", txt)}>{label}</p>
      <p className="text-[10px] text-slate-500">
        {stats.count} trades · WR: {stats.winRate.toFixed(0)}%
      </p>
      <p
        className={cn(
          "text-sm font-bold",
          stats.pnl >= 0 ? "text-emerald-600" : "text-red-500",
        )}
      >
        {stats.pnl >= 0 ? "+" : ""}${stats.pnl.toFixed(2)} · Avg R:{" "}
        {stats.avgR.toFixed(2)}
      </p>
      <p className="text-[10px] text-slate-500">
        MFE: {stats.avgMfe.toFixed(1)}R · MAE: {stats.avgMae.toFixed(1)}R
      </p>
    </div>
  );
}

function CoverageBar({
  label,
  have,
  total,
}: {
  label: string;
  have: number;
  total: number;
}) {
  const pct = total > 0 ? (have / total) * 100 : 0;
  return (
    <div className="rounded-lg bg-white/40 border border-white/50 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </p>
      <p className="text-sm font-bold text-slate-700">
        {have}/{total}
      </p>
      <div className="mt-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            pct >= 80
              ? "bg-emerald-400"
              : pct >= 50
                ? "bg-amber-400"
                : "bg-red-400",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-[9px] text-slate-400 mt-0.5">{pct.toFixed(0)}%</p>
    </div>
  );
}
