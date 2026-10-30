/**
 * BtcRegimeCard — "BTC Regime & Behavior" for the Advanced Data tabs.
 *
 * I/O design: the LIVE BTC read (1H regime up/down/chop, price, 4H RSI, VWAP,
 * CMF, divergence flags, veto status) comes from the advisorTicks doc — the
 * advisor cron computes it once per 4H tick (one extra BTC 1H fetch every 4h),
 * so this card performs ZERO per-render fetching. The book-behavior table is
 * computed client-side from the closed trades the Advanced Data tab already
 * loads (their stored btcTrendAtEntry enrichment). Only new read: the tiny
 * getAdvisorState doc, which Convex caches across components.
 */
import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { GlassCard } from "@/components/GlassPanel";
import { BtcChart } from "@/components/BtcChart";
import { cn } from "@/lib/utils";
import { Bitcoin, Activity, LineChart } from "lucide-react";

function pct(n: number, digits = 1) {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(digits)}%`;
}

export function BtcRegimeCard({ closedTrades }: { closedTrades: any[] }) {
  const advisorState: any = useQuery((api as any).advisor.getAdvisorState);

  // Book behavior by BTC regime — pure client-side aggregation of the stored
  // btcTrendAtEntry enrichment (zero new I/O; the book is already loaded).
  const book = useMemo(() => {
    const withBtc = (closedTrades as any[]).filter((t) => t.btcTrendAtEntry);
    if (withBtc.length === 0) return null;
    const buckets: Record<string, { n: number; w: number; pnl: number; r: number }> = {};
    let shortsDown = { n: 0, w: 0, pnl: 0 };
    for (const t of withBtc) {
      const b = t.btcTrendAtEntry as string;
      const d = (buckets[b] ??= { n: 0, w: 0, pnl: 0, r: 0 });
      d.n++;
      const p = t.pnlUsd ?? 0;
      d.pnl += p;
      d.r += t.realizedR ?? 0;
      if (p > 0) d.w++;
      if (b === "down" && t.type === "SHORT") {
        shortsDown.n++;
        shortsDown.pnl += p;
        if (p > 0) shortsDown.w++;
      }
    }
    const rows = ["up", "down", "chop"].map((b) => {
      const d = buckets[b] ?? { n: 0, w: 0, pnl: 0, r: 0 };
      return {
        regime: b,
        n: d.n,
        winRate: d.n ? (d.w / d.n) * 100 : 0,
        pnl: d.pnl,
        avgR: d.n ? d.r / d.n : 0,
      };
    });
    return { total: withBtc.length, rows, shortsDown };
  }, [closedTrades]);

  const btc = advisorState?.metrics?.BTC;
  const regime = btc?.btcRegime as string | undefined;
  const bears = ["rsiBear", "obvBear", "adBear", "cmfBear"].filter((k) => btc?.[k]).length;
  const bulls = ["rsiBull", "obvBull", "adBull", "cmfBull"].filter((k) => btc?.[k]).length;
  const exhaust = ["vwapExhaustLong", "vwapExhaustShort", "thinZoneLong", "thinZoneShort"].filter(
    (k) => btc?.[k],
  ).length;
  // MACD family (2026-09-10): divergence + fresh hist flips — surfaced per
  // side so the readout matches what the veto math actually counted.
  const macdBear = ["macdBearDiv", "histXDown"].filter((k) => btc?.[k]).length;
  const macdBull = ["macdBullDiv", "histXUp"].filter((k) => btc?.[k]).length;

  const regimeColor =
    regime === "up"
      ? "bg-emerald-100 text-emerald-700 border-emerald-300/50"
      : regime === "down"
        ? "bg-rose-100 text-rose-700 border-rose-300/50"
        : "bg-amber-100 text-amber-700 border-amber-300/50";

  return (
    <GlassCard className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <Bitcoin className="size-4 text-orange-500" />
        <p className="text-xs font-medium text-slate-600">BTC Regime &amp; Behavior</p>
      </div>

      {/* ── Live BTC read (from the advisor's 4H tick — zero per-render I/O) ── */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className={cn("rounded-full border px-2.5 py-0.5 text-[11px] font-bold", regimeColor)}>
          {regime ? `1H ${regime.toUpperCase()}` : "1H …"}
        </span>
        {btc ? (
          <>
            <span className="font-mono text-[11px] text-slate-500">${(btc.price ?? 0).toFixed(2)}</span>
            <span className="text-[11px] text-slate-500">
              RSI {Math.round(btc.rsi)} · VWAP {pct(btc.vwapDistPct, 1)} · CMF {(btc.cmf ?? 0).toFixed(3)}
            </span>
            {typeof btc.btcChange1h === "number" && (
              <span className={cn("text-[11px] font-medium", btc.btcChange1h >= 0 ? "text-emerald-600" : "text-red-500")}>
                1h {pct(btc.btcChange1h, 2)}
              </span>
            )}
            <span className="text-[11px] text-slate-500">
              bearish {bears + macdBear} · bullish {bulls + macdBull} · exhaustion {exhaust}
            </span>
            {(macdBear > 0 || macdBull > 0) && (
              <span className="rounded-md border border-indigo-300/50 bg-indigo-100/70 px-1.5 py-0.5 text-[10px] font-bold text-indigo-700">
                MACD {macdBear > 0 ? "bear" : ""}{macdBear > 0 && macdBull > 0 ? "+" : ""}{macdBull > 0 ? "bull" : ""}
              </span>
            )}
            {btc.longStatus === "veto" && (
              <span className="rounded-md border border-rose-300/40 bg-rose-100/80 px-1.5 py-0.5 text-[10px] font-bold text-rose-700">
                LONG ✕ ({Number(btc.longVotes).toFixed(1)}v)
              </span>
            )}
            {btc.shortStatus === "veto" && (
              <span className="rounded-md border border-rose-300/40 bg-rose-100/80 px-1.5 py-0.5 text-[10px] font-bold text-rose-700">
                SHORT ✕ ({Number(btc.shortVotes).toFixed(1)}v)
              </span>
            )}
            {btc.longStatus !== "veto" && btc.shortStatus !== "veto" && (
              <span className="text-[10px] font-medium text-emerald-600">no veto flags</span>
            )}
          </>
        ) : (
          <span className="text-[11px] text-slate-400">no BTC read yet — awaiting the next advisor tick</span>
        )}
      </div>

      {/* ── BTC 1H line chart + advisor overlay (on-demand, 1 MEXC call/view) ── */}
      <div className="mb-3 rounded-xl border border-white/40 bg-white/30 p-2.5">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold text-slate-600">
          <LineChart className="size-3.5 text-orange-500" />
          BTC 1H · Advisor Overlay
        </div>
        <BtcChart />
      </div>

      {/* ── Book behavior by BTC regime (from stored trade enrichment) ── */}
      {book ? (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-white/30 text-left text-slate-400">
                  <th className="pb-1 pr-2">BTC regime at entry</th>
                  <th className="pb-1 pr-2">Trades</th>
                  <th className="pb-1 pr-2">Win Rate</th>
                  <th className="pb-1 pr-2">PnL</th>
                  <th className="pb-1">Avg R</th>
                </tr>
              </thead>
              <tbody>
                {book.rows.map((r) => (
                  <tr key={r.regime} className="border-b border-white/20">
                    <td className="py-1 pr-2 font-medium capitalize text-slate-700">{r.regime}</td>
                    <td className="py-1 pr-2">{r.n}</td>
                    <td className="py-1 pr-2">
                      <span className={cn("font-medium", r.winRate >= 50 ? "text-emerald-600" : "text-red-500")}>
                        {r.winRate.toFixed(0)}%
                      </span>
                    </td>
                    <td className={cn("py-1 pr-2 font-medium", r.pnl >= 0 ? "text-emerald-600" : "text-red-500")}>
                      {r.pnl >= 0 ? "+" : "−"}${Math.abs(r.pnl).toFixed(2)}
                    </td>
                    <td className="py-1">
                      <span className={cn("font-medium", r.avgR >= 0 ? "text-emerald-600" : "text-red-500")}>
                        {r.avgR >= 0 ? "+" : ""}
                        {r.avgR.toFixed(2)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {book.shortsDown.n > 0 && (
            <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-snug text-red-600">
              <Activity className="mt-0.5 size-3 shrink-0" />
              <span>
                Worst bucket: SHORT while BTC regime = down — <b>{book.shortsDown.n} trades</b> ·{" "}
                <b>{book.shortsDown.n ? ((book.shortsDown.w / book.shortsDown.n) * 100).toFixed(0) : 0}% WR</b> ·{" "}
                {book.shortsDown.pnl >= 0 ? "+" : "−"}${Math.abs(book.shortsDown.pnl).toFixed(2)}.
              </span>
            </p>
          )}
        </>
      ) : (
        <p className="text-[11px] text-slate-400">
          No stored BTC-regime enrichment yet — it fills in as trades close with btcTrendAtEntry.
        </p>
      )}

      <p className="mt-2 text-[9px] leading-relaxed text-slate-400">
        Live BTC read is computed once per advisor tick (every 4H) and read from the shared advisor doc — no
        per-render market data calls. Regime history comes from the stored per-trade enrichment. The chart fetches
        BTC 1H klines once per view (1 MEXC call) and overlays advisor readings from the stored 90-day history
        (backfilled once, kept current by the tick).
      </p>
    </GlassCard>
  );
}