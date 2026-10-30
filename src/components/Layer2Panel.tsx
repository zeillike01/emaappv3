/**
 * Layer 2 Panel — EMA Momentum + Order Flow strategy (book="layer2").
 *
 * Tab orchestrator only. I/O contract (2026-09):
 *   - Trades tab → Layer2TradesView: header stats from the ONE precomputed
 *     `bookStats` doc + a keyset-paginated closed-trades list. Never touches
 *     the full book.
 *   - Advanced Data tab → Layer2AdvancedView: the ONLY full-book subscriber,
 *     mounted only while that tab is open.
 * Each tab is wrapped in an error boundary so a failure on one view can never
 * blank the other (or the whole dashboard).
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { BarChart3, ListOrdered } from "lucide-react";
import { Layer2TradesView } from "@/components/Layer2TradesView";
import { Layer2AdvancedView } from "@/components/Layer2AdvancedView";
import { InlineErrorBoundary } from "@/components/InlineErrorBoundary";

const TABS = [
  { key: "trades", label: "Trades", icon: ListOrdered },
  { key: "data", label: "Advanced Data", icon: BarChart3 },
] as const;

type TabKey = (typeof TABS)[number]["key"];

export function Layer2Panel() {
  const [view, setView] = useState<TabKey>("trades");

  return (
    <div className="space-y-4">
      {/* Segmented view switch with liquid glass pill styling */}
      <div className="flex w-fit items-center gap-1.5 rounded-2xl border border-white/70 bg-white/40 p-1 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9),0_6px_20px_-6px_rgba(15,23,42,0.06)] backdrop-blur-xl">
        {TABS.map(({ key, label, icon: Icon }) => {
          const active = view === key;
          return (
            <button
              key={key}
              onClick={() => setView(key)}
              className={cn(
                "flex items-center gap-2 rounded-xl px-4 py-2 text-xs font-semibold transition-all duration-200",
                active
                  ? "border border-white/80 bg-white/85 text-slate-900 shadow-[inset_0_1px_1px_rgba(255,255,255,1),0_2px_8px_-2px_rgba(15,23,42,0.08)]"
                  : "border border-transparent text-slate-500 hover:text-slate-800 hover:bg-white/30",
              )}
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          );
        })}
      </div>

      {view === "trades" && (
        <InlineErrorBoundary label="Trades">
          <Layer2TradesView />
        </InlineErrorBoundary>
      )}
      {view === "data" && (
        <InlineErrorBoundary label="Advanced Data">
          <Layer2AdvancedView />
        </InlineErrorBoundary>
      )}
    </div>
  );
}
