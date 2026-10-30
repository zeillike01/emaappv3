/**
 * LiveAdvancedView — on-demand deep analytics for the REAL (live) ledger,
 * mounted on the /live page ONLY while its "Advanced data" section is
 * expanded (see Live.tsx). It subscribes to the whole live book via
 * getLiveTradesRaw — exactly the paper Advanced Data tab's discipline: no
 * standing full-book subscription, the read exists only while this view is
 * open, and closed-trade detail rows are pruned monthly.
 *
 * Mirrors the paper analytics that live rows can actually support. Live
 * trades DO store: session / regime / volPct / spread / funding / OI /
 * imbalance entry enrichment, realizedR, feesUsd, reason, exit times. They
 * do NOT yet store the excursion suite (mfeR / maeR / durationBucket /
 * volAtExit / capture) or per-trade longScore/shortScore — so those cards
 * are deliberately absent here (a footer notes what stays paper-only) rather
 * than rendered as zero-filled cards.
 */
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { GlassCard } from "@/components/GlassPanel";
import { BtcRegimeCard } from "@/components/BtcRegimeCard";
import { summarizeBook } from "@/lib/book-summary";
import { cn } from "@/lib/utils";
import {
  ArrowUpRight,
  BarChart3,
  Clock,
  Flame,
  Loader2,
  TrendingDown,
  TrendingUp,
  Zap,
} from "lucide-react";

const phtOf = (ms: number) =>
  new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));

function sum(vals: number[]) {
  return vals.reduce((a, b) => a + b, 0);
}

/** `+$12.34` / `−$5.67` — the signed-USD shape the other cards use. */
const signedUsd = (v: number) =>
  `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;

/** Side PnL tint: green only when that side actually made money (flat is not a win). */
const sidePnlTone = (pnl: number, trades: number) =>
  trades === 0 ? "text-slate-400" : pnl > 0 ? "text-emerald-600" : "text-rose-600";

export function LiveAdvancedView() {
  const rows = useQuery((api as any).liveEngine.getLiveTradesRaw);
  const loading = rows === undefined;
  // Hoisted to component scope so the BTC regime card can reuse the same
  // closed set without a second filter pass.
  const closed = ((rows ?? []) as any[]).filter(
    (r) => r.status === "closed" && r.pnlUsd != null,
  );

  const data = useMemo(() => {
    // One shared aggregator with the paper panel — the two books can never
    // drift on session × direction / worst-cell / per-pair math. Fees are
    // summed locally (live rows carry `feesUsd`; paper carries totalFeesUsd).
    const agg = summarizeBook(closed as any);
    if (!agg) return null;

    const totalPnl = agg.totalPnl;
    const totalFees = sum(closed.map((t) => t.feesUsd ?? 0));
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

    // Session × direction (worst first) + worst cells + top losers come
    // straight from the shared aggregator.
    const perSessionDirection = agg.perSessionDirection;
    const worstSessionDir = agg.worstCells;

    const perReason = agg.perReason.map((r) => ({
      reason: r.key,
      count: r.trades,
      winRate: r.winRate,
      pnl: r.pnl,
      avgR: r.avgR,
    }));
    const perPair = agg.perPair.map((p) => ({
      coin: p.key,
      trades: p.trades,
      wins: p.wins,
      winRate: p.winRate,
      pnl: p.pnl,
      avgR: p.avgR,
    }));

    return {
      total: agg.total,
      winRate: agg.winRate,
      totalPnl,
      totalFees,
      net: totalPnl - totalFees,
      profitFactor: agg.profitFactor,
      avgR: agg.avgR,
      perSession,
      perSessionDirection,
      worstSessionDir,
      longs: { ...agg.longs, count: agg.longs.trades },
      shorts: { ...agg.shorts, count: agg.shorts.trades },
      perReason,
      perPair,
      worstTrades: agg.worstTrades as any[],
    };
  }, [closed]);

  if (loading) {
    return (
      <GlassCard className="p-6 text-center">
        <Loader2 className="size-6 text-slate-300 mx-auto mb-2 animate-spin" />
        <p className="text-xs text-slate-400">Loading live history…</p>
      </GlassCard>
    );
  }

  if (!data) {
    return (
      <GlassCard className="p-6 text-center">
        <BarChart3 className="size-8 text-slate-300 mx-auto mb-2" />
        <p className="text-xs text-slate-400">
          No closed live trades to analyze yet — this book fills as the armed bot's real trades close.
        </p>
      </GlassCard>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── BTC Regime & Behavior ── */}
      <BtcRegimeCard closedTrades={closed} />

      {/* ── Session Breakdown ── */}
      <GlassCard className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Clock className="size-4 text-teal-500" />
          <p className="text-xs font-medium text-slate-600">Session Breakdown</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[11px]">
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
                  <td className="py-1 pr-2 font-medium text-slate-700 capitalize">{s.session}</td>
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
                    <span className={cn("font-medium", s.winRate >= 50 ? "text-emerald-600" : "text-red-500")}>
                      {s.winRate.toFixed(0)}%
                    </span>
                  </td>
                  <td className={cn("py-1 pr-2 font-medium", s.pnl >= 0 ? "text-emerald-600" : "text-red-500")}>
                    {s.pnl >= 0 ? "+" : "−"}${Math.abs(s.pnl).toFixed(2)}
                  </td>
                  <td className="py-1">
                    <span className={cn("font-medium", s.avgR >= 0 ? "text-emerald-600" : "text-red-500")}>
                      {s.avgR >= 0 ? "+" : ""}{s.avgR.toFixed(2)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassCard>

      {/* ── Worst Session × Direction ── */}
      <GlassCard className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Flame className="size-4 text-red-500" />
          <p className="text-xs font-medium text-slate-600">Worst Performer — Session × Direction</p>
        </div>
        {data.worstSessionDir.length > 0 ? (
          <>
            <p className="text-[11px] text-slate-500 mb-2">
              The cells below lose money — every other session × side cell is net positive. Worst first.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-[11px]">
                <thead>
                  <tr className="text-slate-400 text-left border-b border-white/30">
                    <th className="pb-1 pr-2">Session</th>
                    <th className="pb-1 pr-2">Side</th>
                    <th className="pb-1 pr-2">Trades</th>
                    <th className="pb-1 pr-2">Win Rate</th>
                    <th className="pb-1 pr-2">PnL</th>
                    <th className="pb-1">Avg R</th>
                  </tr>
                </thead>
                <tbody>
                  {data.worstSessionDir.map((c, i) => (
                    <tr key={c.session + c.side} className={"border-b border-white/20" + (i === 0 ? " bg-red-50/60" : "")}>
                      <td className="py-1 pr-2 font-medium text-slate-700 capitalize">{c.session}</td>
                      <td className="py-1 pr-2">
                        <span
                          className={cn(
                            "rounded px-1.5 py-0.5 text-[10px] font-bold",
                            c.side === "LONG" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700",
                          )}
                        >
                          {c.side}
                        </span>
                      </td>
                      <td className="py-1 pr-2">{c.trades}</td>
                      <td className="py-1 pr-2 font-medium text-red-500">{c.winRate.toFixed(0)}%</td>
                      <td className="py-1 pr-2 font-bold text-red-600">−${Math.abs(c.pnl).toFixed(2)}</td>
                      <td className="py-1 font-medium text-red-500">{c.avgR.toFixed(2)}R</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : (
          <p className="text-[11px] text-emerald-600">
            No session × side cell is net-negative — the weakest cell is{" "}
            <span className="font-semibold capitalize">
              {data.perSessionDirection[0]?.session} {data.perSessionDirection[0]?.side}
            </span>{" "}
            at {data.perSessionDirection[0]?.pnl >= 0 ? "+" : "−"}
            ${Math.abs(data.perSessionDirection[0]?.pnl ?? 0).toFixed(2)}.
          </p>
        )}
      </GlassCard>

      {/* ── Worst Trades ── */}
      <GlassCard className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <TrendingDown className="size-4 text-rose-500" />
          <p className="text-xs font-medium text-slate-600">Worst Trades — Top {data.worstTrades.length} Losers</p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-[11px]">
            <thead>
              <tr className="text-slate-400 text-left border-b border-white/30">
                <th className="pb-1 pr-2">Coin</th>
                <th className="pb-1 pr-2">Side</th>
                <th className="pb-1 pr-2">Session</th>
                <th className="pb-1 pr-2">R</th>
                <th className="pb-1 pr-2">PnL</th>
                <th className="pb-1 pr-2">Entry (PHT)</th>
                <th className="pb-1">Exit</th>
              </tr>
            </thead>
            <tbody>
              {data.worstTrades.map((t) => (
                <tr key={String(t._id)} className="border-b border-white/20">
                  <td className="py-1 pr-2 font-semibold text-slate-700">{t.coin}</td>
                  <td className="py-1 pr-2">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-bold",
                        t.type === "LONG" ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700",
                      )}
                    >
                      {t.type}
                    </span>
                  </td>
                  <td className="py-1 pr-2 text-slate-500 capitalize">{t.session || "?"}</td>
                  <td className="py-1 pr-2 font-medium text-red-500">{(t.realizedR ?? 0).toFixed(2)}R</td>
                  <td className="py-1 pr-2 font-bold text-red-600">−${Math.abs(t.pnlUsd).toFixed(2)}</td>
                  <td className="py-1 pr-2 text-slate-500">{phtOf(t.entryTime)}</td>
                  <td className="py-1 text-slate-500">{t.reason || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </GlassCard>

      {/* ── Long vs Short ── */}
      <GlassCard className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <Zap className="size-4 text-amber-500" />
          <p className="text-xs font-medium text-slate-600">Long vs Short</p>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <SideCard label="LONG" stats={data.longs} color="emerald" />
          <SideCard label="SHORT" stats={data.shorts} color="rose" />
        </div>
      </GlassCard>

      {/* ── Per-Pair ── */}
      <GlassCard className="p-4">
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp className="size-4 text-emerald-500" />
          <p className="text-xs font-medium text-slate-600">Per-Pair Performance ({data.perPair.length} pairs)</p>
        </div>
        <div className="overflow-x-auto max-h-64 overflow-y-auto">
          <table className="w-full min-w-[560px] text-[11px]">
            <thead>
              <tr className="text-slate-400 text-left sticky top-0 bg-white/70 backdrop-blur border-b border-white/30">
                <th className="pb-1 pr-2">Pair</th>
                <th className="pb-1 pr-2">#</th>
                <th className="pb-1 pr-2">W/L</th>
                <th className="pb-1 pr-2">WR%</th>
                <th className="pb-1 pr-2">PnL</th>
                <th className="pb-1">Avg R</th>
              </tr>
            </thead>
            <tbody>
              {data.perPair.map((p) => (
                <tr key={p.coin} className="border-b border-white/20">
                  <td className="py-1 pr-2 font-semibold text-slate-700">{p.coin}</td>
                  <td className="py-1 pr-2">{p.trades}</td>
                  <td className="py-1 pr-2">
                    <span className="text-emerald-600">{p.wins}</span>
                    <span className="text-slate-400">/</span>
                    <span className="text-red-500">{p.trades - p.wins}</span>
                  </td>
                  <td className={cn("py-1 pr-2 font-medium", p.winRate >= 50 ? "text-emerald-600" : "text-red-500")}>
                    {p.winRate.toFixed(0)}%
                  </td>
                  <td className={cn("py-1 pr-2 font-medium", p.pnl >= 0 ? "text-emerald-600" : "text-red-500")}>
                    {p.pnl >= 0 ? "+" : "−"}${Math.abs(p.pnl).toFixed(2)}
                  </td>
                  <td className="py-1">
                    <span className={cn("font-medium", p.avgR >= 0 ? "text-emerald-600" : "text-red-500")}>
                      {p.avgR >= 0 ? "+" : ""}{p.avgR.toFixed(2)}
                    </span>
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
          <ArrowUpRight className="size-4 text-red-500" />
          <p className="text-xs font-medium text-slate-600">Exit Reason Breakdown</p>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {data.perReason.map((r) => (
            <div
              key={r.reason}
              className={cn(
                "rounded-lg border px-3 py-2",
                r.reason === "Take Profit" ||
                r.reason === "Exchange TP/SL" ||
                r.reason === "Trail Lock" ||
                r.reason === "R-Lock Max"
                  ? "bg-emerald-50/50 border-emerald-200/40"
                  : r.reason === "Stop Loss"
                  ? "bg-red-50/50 border-red-200/40"
                  : "bg-slate-50/50 border-slate-200/40",
              )}
            >
              <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">{r.reason}</p>
              <p className="text-lg font-bold text-slate-700">{r.count}</p>
              <p className="text-[10px] text-slate-500">
                WR: {r.winRate.toFixed(0)}% · PnL: {r.pnl >= 0 ? "+" : "−"}${Math.abs(r.pnl).toFixed(2)}
              </p>
            </div>
          ))}
        </div>
      </GlassCard>

      <p className="px-1 text-[10px] leading-relaxed text-slate-400">
        Paper-only analytics (not yet recorded on live rows): MFE/MAE excursion, duration buckets, volume expansion,
        score correlation, slippage and funding-cost detail. Live entries DO store the full entry context (session,
        regime, volPct, spread, funding, OI, imbalance) — the parity gap is the close-side excursion replay, which paper
        computes from klines at exit.
      </p>
    </div>
  );
}

/**
 * The live book's "Overall Performance" summary, mounted OUTSIDE
 * LiveAdvancedView (2026-10-28) so /live shows it on load instead of hiding it
 * behind the "Advanced data" toggle.
 *
 * Fed by the aggregate `getLiveClosedStats` doc — the same one the page header
 * already subscribes to — so making it permanently visible does NOT turn on the
 * whole-ledger read that the collapsed section exists to avoid.
 *
 * The paper card's eighth tile (Funding Cost) is absent on purpose: live rows
 * only carry `fundingCostUsd` when the close-side analytics backfill has filled
 * it, and the aggregate doc does not accumulate it, so the tile would silently
 * understate the cost.
 */
export interface LivePerformanceStats {
  closedCount: number;
  wins: number;
  losses: number;
  totalPnl: number;
  totalFees: number;
  avgR: number;
  winRate: number;
  /** Sum of winning USD (profit factor's numerator), null on a pre-2026-10-28 doc. */
  grossWin: number | null;
  /** Sum of losing USD as a POSITIVE number (profit factor's denominator). */
  grossLoss: number | null;
}

type StatTone = "green" | "red" | "amber" | "slate" | "default";

export function LivePerformanceCard({
  stats,
  loading = false,
}: {
  stats: LivePerformanceStats | null | undefined;
  loading?: boolean;
}) {
  const pending = loading || stats == null;
  const s: LivePerformanceStats = stats ?? {
    closedCount: 0,
    wins: 0,
    losses: 0,
    totalPnl: 0,
    totalFees: 0,
    avgR: 0,
    winRate: 0,
    grossWin: 0,
    grossLoss: 0,
  };
  // Absent gross legs (a backend that predates the fields) must read "—",
  // never a silent ∞ from a zero denominator: missing ≠ no losses.
  const grossWin = s.grossWin;
  const grossLoss = s.grossLoss;
  const profitFactor =
    grossWin == null || grossLoss == null
      ? null
      : grossLoss > 0
        ? grossWin / grossLoss
        : s.wins > 0
          ? Infinity
          : null;
  const net = s.totalPnl - s.totalFees;
  const shown = (v: string) => (pending ? "…" : v);
  const tone = (ok: boolean, good: StatTone = "green", bad: StatTone = "red"): StatTone =>
    pending ? "default" : ok ? good : bad;
  const pfTone: StatTone =
    pending || profitFactor == null
      ? "default"
      : profitFactor >= 1.5
        ? "green"
        : profitFactor >= 1
          ? "amber"
          : "red";

  return (
    <GlassCard className="mb-4 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <BarChart3 className="size-4 text-violet-500" />
        <p className="text-xs font-medium text-slate-600">Overall Performance (live)</p>
        <span className="ml-auto text-[10px] text-slate-400">
          {pending ? "loading…" : `${s.closedCount} closed · all-time ledger`}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-7">
        <Stat label="Trades" value={shown(String(s.closedCount))} />
        <Stat
          label="Win Rate"
          value={shown(`${s.winRate.toFixed(1)}%`)}
          color={tone(s.winRate >= 50)}
        />
        <Stat
          label="Realized PnL"
          value={shown(`${s.totalPnl >= 0 ? "+" : "−"}$${Math.abs(s.totalPnl).toFixed(2)}`)}
          color={tone(s.totalPnl >= 0)}
        />
        <Stat
          label="Profit Factor"
          value={shown(
            profitFactor == null ? "—" : profitFactor === Infinity ? "∞" : profitFactor.toFixed(2),
          )}
          color={pfTone}
        />
        <Stat
          label="Avg R"
          value={shown(`${s.avgR >= 0 ? "+" : ""}${s.avgR.toFixed(2)}`)}
          color={tone(s.avgR >= 0)}
        />
        <Stat label="Est. Fees" value={shown(`$${s.totalFees.toFixed(2)}`)} color="slate" />
        <Stat
          label="Net (fees)"
          value={shown(`${net >= 0 ? "+" : "−"}$${Math.abs(net).toFixed(2)}`)}
          color={tone(net >= 0)}
        />
      </div>
      <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
        Net subtracts the estimated exchange fees only. Funding cost is not folded in: live closes record it only when
        the close-side analytics backfill has filled it, so including it here would understate the cost.
      </p>
    </GlassCard>
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
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
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
  stats: { count: number; wins: number; winRate: number; pnl: number; avgR: number };
  color: "emerald" | "rose";
}) {
  const bg = color === "emerald" ? "bg-emerald-50/50 border-emerald-200/40" : "bg-rose-50/50 border-rose-200/40";
  const txt = color === "emerald" ? "text-emerald-700" : "text-rose-600";
  return (
    <div className={cn("rounded-lg border px-3 py-2", bg)}>
      <p className={cn("text-xs font-bold", txt)}>{label}</p>
      <p className="text-[10px] text-slate-500">
        {stats.count} trades · WR: {stats.winRate.toFixed(0)}%
      </p>
      <p className={cn("text-sm font-bold", stats.pnl >= 0 ? "text-emerald-600" : "text-red-500")}>
        {stats.pnl >= 0 ? "+" : "−"}${Math.abs(stats.pnl).toFixed(2)} · Avg R: {stats.avgR.toFixed(2)}
      </p>
    </div>
  );
}
