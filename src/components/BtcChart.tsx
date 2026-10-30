/**
 * BtcChart — BTC 1H line chart with the advisor overlay (Advanced Data).
 *
 * I/O design (the user's constraint): ONE on-demand action call per view.
 * getBtcChartData performs exactly ONE MEXC kline fetch (BTC 1H for the
 * selected window) and reads the btcAdvisorHistory table for the advisor
 * overlay (veto markers, divergence flags, RSI, votes) — that table was
 * backfilled once over ~90 days and is kept current by the advisor tick, so
 * the chart has zero recurring market I/O. Nothing runs while the tab is
 * closed; a manual Refresh re-fetches.
 *
 * Layers:
 *   Pane 0 — 1H close line, colored per-bar by the BTC regime (up/down/chop,
 *            the same EMA20-slope percentile math the mining data records),
 *            with markers where the 4H advisor vetoed LONG (▲/arrowDown) or
 *            SHORT (▼/arrowUp), plus small dots for non-veto divergence flags.
 *   Pane 1 — 4H RSI(14) line with 30/70 reference lines.
 *   Pane 2 — 4H advisor vote histogram: red bars = bearish (LONG-veto) votes,
 *            teal bars = bullish (SHORT-veto) votes.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  createChart,
  createSeriesMarkers,
  LineSeries,
  HistogramSeries,
  ColorType,
  LineStyle,
  CrosshairMode,
  type UTCTimestamp,
} from "lightweight-charts";
import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";

type Regime = "up" | "down" | "chop";
type AdvisorRow = {
  barTime: number;
  price: number;
  rsi: number;
  cmf: number;
  vwapDistPct: number;
  rsiBear: boolean; rsiBull: boolean;
  obvBear: boolean; obvBull: boolean;
  adBear: boolean; adBull: boolean;
  cmfBear: boolean; cmfBull: boolean;
  vwapExhaustLong: boolean; vwapExhaustShort: boolean;
  thinZoneLong: boolean; thinZoneShort: boolean;
  // MACD family (2026-09-10) — present on rows written after the MACD
  // integration; optional so pre-MACD history rows stay assignable.
  macdBearDiv?: boolean; macdBullDiv?: boolean;
  histXDown?: boolean; histXUp?: boolean;
  longStatus: string;
  longVotes: number;
  shortStatus: string;
  shortVotes: number;
};

const REGIME_COLOR: Record<Regime, string> = {
  up: "#10b981",
  down: "#f43f5e",
  chop: "#64748b",
};
const BEAR = "#e11d48";
const BULL = "#0d9488";

export function BtcChart() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [data, setData] = useState<{
    bars: { time: number; close: number; regime: Regime }[];
    advisor: AdvisorRow[];
    coverage: { count: number; firstBar: number; lastBar: number } | null;
  } | null>(null);
  const [days, setDays] = useState<7 | 30>(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fetchChart = useAction((api as any).advisor.getBtcChartData);

  // Guards against stale responses: a fast 7d fetch resolving after a slow
  // 30d one (or after the tab unmounted) must not overwrite newer state.
  const requestIdRef = useRef(0);

  const load = useCallback(
    async (d: number) => {
      const id = ++requestIdRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await fetchChart({ days: d });
        if (id !== requestIdRef.current) return;
        setData(res as any);
      } catch (e: any) {
        if (id !== requestIdRef.current) return;
        setError(e?.message ?? "failed to load chart data");
      } finally {
        if (id === requestIdRef.current) setLoading(false);
      }
    },
    [fetchChart],
  );

  // Fetch once on mount (the card only exists while Advanced Data is open).
  useEffect(() => {
    void load(days);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Invalidate any in-flight fetch when the tab closes (the card unmounts).
  useEffect(() => {
    return () => {
      requestIdRef.current++;
    };
  }, []);

  // (Re)build the chart whenever new data lands.
  useEffect(() => {
    const el = containerRef.current;
    if (!data || !el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#64748b",
        fontSize: 10,
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      },
      grid: {
        vertLines: { color: "rgba(148,163,184,0.12)" },
        horzLines: { color: "rgba(148,163,184,0.12)" },
      },
      rightPriceScale: { borderColor: "rgba(148,163,184,0.25)" },
      timeScale: {
        borderColor: "rgba(148,163,184,0.25)",
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: CrosshairMode.Normal },
    });

    // ── Pane 0: price line, per-bar regime color ──
    const priceSeries = chart.addSeries(LineSeries, {
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 3,
    });
    priceSeries.setData(
      data.bars.map((b) => ({
        time: b.time as UTCTimestamp,
        value: b.close,
        color: REGIME_COLOR[b.regime],
      })),
    );

    // Advisor markers: vetoes get big arrows, plain divergence flags get dots.
    const markers: any[] = [];
    for (const a of data.advisor) {
      const t = Math.floor(a.barTime / 1000) as UTCTimestamp;
      const bearish = a.rsiBear || a.obvBear || a.adBear || a.cmfBear || a.macdBearDiv || a.histXDown;
      const bullish = a.rsiBull || a.obvBull || a.adBull || a.cmfBull || a.macdBullDiv || a.histXUp;
      if (a.longStatus === "veto") {
        markers.push({
          time: t, position: "aboveBar", color: BEAR, shape: "arrowDown",
          text: `LONG ${Number(a.longVotes).toFixed(1)}v`, size: 0.8,
        });
      } else if (bearish) {
        markers.push({
          time: t, position: "aboveBar", color: "rgba(225,29,72,0.5)",
          shape: "circle", size: 0.5,
        });
      }
      if (a.shortStatus === "veto") {
        markers.push({
          time: t, position: "belowBar", color: BULL, shape: "arrowUp",
          text: `SHORT ${Number(a.shortVotes).toFixed(1)}v`, size: 0.8,
        });
      } else if (bullish) {
        markers.push({
          time: t, position: "belowBar", color: "rgba(13,148,136,0.5)",
          shape: "circle", size: 0.5,
        });
      }
    }
    createSeriesMarkers(priceSeries, markers);

    // ── Pane 1: 4H RSI with 30/70 guides ──
    chart.addPane();
    const rsiSeries = chart.addSeries(
      LineSeries,
      { color: "#6366f1", lineWidth: 1, priceLineVisible: false, lastValueVisible: true },
      1,
    );
    rsiSeries.setData(
      data.advisor.map((a) => ({
        time: Math.floor(a.barTime / 1000) as UTCTimestamp,
        value: a.rsi,
      })),
    );
    rsiSeries.createPriceLine({
      price: 70, color: "rgba(244,63,94,0.45)", lineWidth: 1,
      lineStyle: LineStyle.Dashed, title: "70", axisLabelVisible: false,
    });
    rsiSeries.createPriceLine({
      price: 30, color: "rgba(16,185,129,0.45)", lineWidth: 1,
      lineStyle: LineStyle.Dashed, title: "30", axisLabelVisible: false,
    });

    // ── Pane 2: advisor vote histogram (bearish red up, bullish teal down) ──
    chart.addPane();
    const votesSeries = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: { type: "price", precision: 1, minMove: 0.1 },
        priceLineVisible: false,
        lastValueVisible: false,
      },
      2,
    );
    votesSeries.setData(
      data.advisor.map((a) => {
        const long = a.longVotes > 0;
        const short = a.shortVotes > 0;
        return {
          time: Math.floor(a.barTime / 1000) as UTCTimestamp,
          value: long ? a.longVotes : short ? -a.shortVotes : 0,
          color: long
            ? "rgba(225,29,72,0.7)"
            : short
              ? "rgba(13,148,136,0.7)"
              : "rgba(148,163,184,0.15)",
        };
      }),
    );

    const panes = chart.panes();
    panes[1]?.setHeight(72);
    panes[2]?.setHeight(46);

    return () => {
      chart.remove();
    };
  }, [data]);

  const vetoCount = data?.advisor.reduce(
    (acc, a) => acc + (a.longStatus === "veto" ? 1 : 0) + (a.shortStatus === "veto" ? 1 : 0),
    0,
  );
  const coverageText = data?.coverage
    ? `${new Date(data.coverage.firstBar).toLocaleDateString()} → ${new Date(data.coverage.lastBar).toLocaleDateString()}`
    : null;

  return (
    <div className="mt-3">
      {/* Header row: range toggle + refresh + coverage */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          {([7, 30] as const).map((d) => (
            <button
              key={d}
              onClick={() => {
                setDays(d);
                void load(d);
              }}
              className={cn(
                "rounded-md border px-2 py-0.5 text-[10px] font-semibold transition-colors",
                days === d
                  ? "border-orange-400/60 bg-orange-100/80 text-orange-700"
                  : "border-white/40 bg-white/40 text-slate-500 hover:bg-white/70",
              )}
            >
              {d}d
            </button>
          ))}
          <button
            onClick={() => void load(days)}
            disabled={loading}
            className="ml-1 flex items-center gap-1 rounded-md border border-white/40 bg-white/40 px-2 py-0.5 text-[10px] font-semibold text-slate-500 transition-colors hover:bg-white/70 disabled:opacity-50"
          >
            <RefreshCw className={cn("size-3", loading && "animate-spin")} />
            Refresh
          </button>
        </div>
        {coverageText && (
          <span className="text-[9px] text-slate-400">
            advisor overlay {coverageText} · {data?.coverage?.count} 4H readings
            {vetoCount ? ` · ${vetoCount} veto bar${vetoCount > 1 ? "s" : ""}` : ""}
          </span>
        )}
      </div>

      {error ? (
        <p className="rounded-lg border border-rose-300/40 bg-rose-100/60 px-3 py-2 text-[11px] text-rose-700">
          {error}
        </p>
      ) : !data ? (
        <p className="rounded-lg border border-white/40 bg-white/40 px-3 py-6 text-center text-[11px] text-slate-400">
          {loading ? "Loading BTC 1H klines…" : "Chart ready when data loads."}
        </p>
      ) : (
        <div
          ref={containerRef}
          className="h-[340px] w-full overflow-hidden rounded-lg border border-white/30 bg-white/30"
        />
      )}

      {/* Legend */}
      {data && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-slate-400">
          <span className="flex items-center gap-1">
            <i className="inline-block size-2 rounded-full bg-emerald-500" /> 1H regime up
          </span>
          <span className="flex items-center gap-1">
            <i className="inline-block size-2 rounded-full bg-rose-500" /> down
          </span>
          <span className="flex items-center gap-1">
            <i className="inline-block size-2 rounded-full bg-slate-500" /> chop
          </span>
          <span className="flex items-center gap-1">
            <i className="inline-block size-0 border-x-[4px] border-t-[6px] border-x-transparent border-t-rose-600" />
            LONG veto (4H bearish)
          </span>
          <span className="flex items-center gap-1">
            <i className="inline-block size-0 border-x-[4px] border-b-[6px] border-x-transparent border-b-teal-600" />
            SHORT veto (4H bullish)
          </span>
          <span className="flex items-center gap-1">
            <i className="inline-block size-2 rounded-full bg-indigo-500" /> RSI (pane 2)
          </span>
          <span className="flex items-center gap-1">
            <i className="inline-block size-2 rounded-full bg-rose-700/70" /> votes (pane 3)
          </span>
        </div>
      )}
    </div>
  );
}