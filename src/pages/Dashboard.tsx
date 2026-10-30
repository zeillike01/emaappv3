import { useState } from "react";
import { WorkspaceHeader } from "@/components/WorkspaceHeader";
import { PaperTradingPanel } from "@/components/PaperTradingPanel";
import { DisplacementBoard } from "@/components/DisplacementBoard";
import { StrategyConfigPanel } from "@/components/StrategyConfigPanel";
import { InlineErrorBoundary } from "@/components/InlineErrorBoundary";
import { cn } from "@/lib/utils";
import { Brain, Target } from "lucide-react";

/**
 * Dashboard — the paper workspace ("/dashboard", protected).
 *
 * WORKSPACE SURFACES, switched by the segmented control:
 *   - "layer2" — the EMA-momentum + order-flow book (layer2-v1): the shipped
 *     signal, tuned by the shared strategyConfig that the live broker also
 *     reads (right rail);
 *   - "displacement" — a structure diagnostic board, not an engine;
 *
 * All simulated orders on real MEXC futures prices — nothing touches real
 * funds. Layout: the selected book's surface on the left, the shared strategy
 * console (layer2/live config + kill switches + run-now) on the right.
 */
const BOOKS = [
  {
    key: "layer2",
    label: "Layer 2",
    hint: "EMA momentum + flow",
    icon: Brain,
  },
  {
    key: "displacement",
    label: "Structure",
    hint: "Displacement test",
    icon: Target,
  },
] as const;

type BookKey = (typeof BOOKS)[number]["key"];

export default function Dashboard() {
  const [book, setBook] = useState<BookKey>("layer2");

  return (
    <main className="min-h-screen relative">
      {/* Luminous backdrop with fluid liquid lighting */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-48 -right-28 size-[580px] rounded-full bg-gradient-to-br from-sky-400/20 via-cyan-300/15 to-indigo-300/10 blur-[100px]" />
        <div className="absolute top-1/4 -left-32 size-[480px] rounded-full bg-gradient-to-tr from-indigo-400/18 via-blue-300/12 to-teal-200/10 blur-[100px]" />
        <div className="absolute bottom-10 right-1/4 size-[400px] rounded-full bg-gradient-to-tl from-emerald-400/15 via-sky-200/10 to-transparent blur-[90px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
        <WorkspaceHeader
          accent="paper"
          title="Paper Workspace"
          subtitle="Independent simulated strategy books on live MEXC futures prices — no exchange orders"
        />

        {/* Book switcher — both books run side by side on the backend; this only
            picks which record is on screen. */}
        {/* MOBILE (2026-10-28): three buttons carrying icon + label + hint ran
            wider than a phone and pushed the page sideways. The hints hide below
            `sm` and the strip scrolls instead of the page. */}
        <div className="mb-4 flex max-w-full w-fit items-center gap-1.5 overflow-x-auto rounded-2xl border border-white/70 bg-white/40 p-1 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9),0_6px_20px_-6px_rgba(15,23,42,0.06)] backdrop-blur-xl">
          {BOOKS.map(({ key, label, hint, icon: Icon }) => {
            const active = book === key;
            return (
              <button
                key={key}
                onClick={() => setBook(key)}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-left transition-all duration-200 sm:px-4",
                  active
                    ? "border border-white/80 bg-white/85 shadow-[inset_0_1px_1px_rgba(255,255,255,1),0_2px_8px_-2px_rgba(15,23,42,0.08)]"
                    : "border border-transparent hover:bg-white/30",
                )}
              >
                <Icon
                  className={cn(
                    "size-3.5",
                    active ? "text-sky-600" : "text-slate-400",
                  )}
                />
                <span className="flex flex-col">
                  <span
                    className={cn(
                      "text-xs font-semibold",
                      active ? "text-slate-900" : "text-slate-500",
                    )}
                  >
                    {label}
                  </span>
                  <span className="hidden text-[10px] font-medium text-slate-400 sm:block">
                    {hint}
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        {book === "displacement" ? (
          /* The diagnostics surface gets the full stage — the layer2 config
             rail would be noise on it, and it is not wired into an engine. */
          <InlineErrorBoundary label="Displacement board">
            <DisplacementBoard />
          </InlineErrorBoundary>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
              {/* Trading surface for the selected book */}
              <div className="min-w-0">
                <InlineErrorBoundary label="Layer 2 book">
                  <PaperTradingPanel />
                </InlineErrorBoundary>
              </div>

              {/* Strategy console (right rail) — the shared layer2/live config */}
              <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
                <StrategyConfigPanel />
              </aside>
            </div>

          </>
        )}
      </div>
    </main>
  );
}
