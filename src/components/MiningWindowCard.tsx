/**
 * MiningWindowCard — "how much clean data do we have?" readout for the fresh
 * post-reset paper book, plus the guarded re-arm action.
 *
 * Everything here answers one question: is the current window big enough to
 * mine yet? It reads ONE window query + the latest archive doc (both cheap),
 * so it can stay mounted on the Trades tab.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { GlassCard } from "@/components/GlassPanel";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { Database, Loader2, RotateCcw } from "lucide-react";

export function MiningWindowCard() {
  const w = useQuery((api as any).mining.miningWindow, {});
  const latest = useQuery((api as any).reset.getLatestPaperArchive, {});
  const resetBook = useMutation((api as any).reset.resetBookData);
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const ready = w !== undefined;
  const total = w?.trades ?? 0;
  // Rough sample-quality meter: <40 rows is anecdote territory, 40-120 is
  // mineable for coarse buckets, 120+ supports the session/side cross-tabs.
  const sampleTone = total >= 120 ? "up" : total >= 40 ? "amber" : "flat";
  const sampleLabel = total >= 120 ? "mineable" : total >= 40 ? "coarse buckets" : "collecting";

  const doReset = async () => {
    setBusy(true);
    try {
      const r: any = await resetBook({
        paper: true,
        live: true,
        includeSignalLog: false,
        // Scope the paper clear to THIS card's book. Without it the reset also
        // wiped every other paper book — the proxy book included — which is an
        // independent forward record this button has no business deleting.
        paperBook: "layer2",
        reason: `gate re-arm from UI ${new Date().toISOString().slice(0, 10)}`,
      });
      toast.success("Book reset — ledger archived first", {
        description: r?.paper
          ? `${r.paper.archivedTrades} trades archived as ${r.paper.batchId} (${r.paper.archiveParts} part${r.paper.archiveParts === 1 ? "" : "s"}) · cooldowns cleared: ${r.paper.cooldownsCleared}`
          : "Paper ledger cleared; awaiting new gates.",
      });
      if (r?.live?.skipped) {
        toast.warning("Live ledger NOT reset", { description: r.live.skipped });
      }
      setConfirmText("");
    } catch (e: any) {
      toast.error("Reset failed", { description: e?.message ?? "try again" });
    } finally {
      setBusy(false);
    }
  };

  const stat = (label: string, value: ReactNode, tone?: "up" | "amber" | "flat") => (
    <div className="min-w-0 rounded-xl border border-white/50 bg-white/35 px-2.5 py-2">
      <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p
        className={cn(
          "mt-0.5 truncate text-xs font-bold tabular-nums",
          tone === "up" ? "text-emerald-600" : tone === "amber" ? "text-amber-600" : "text-slate-700",
        )}
      >
        {value}
      </p>
    </div>
  );

  return (
    <GlassCard
      icon={<Database className="size-4" />}
      title="Mining window"
      subtitle="Clean post-reset data collection — every row taken under the current gates"
      action={
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-7.5 rounded-xl border border-rose-300/60 bg-rose-50/70 px-3 text-xs font-semibold text-rose-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.8)] backdrop-blur-md hover:bg-rose-100/90 transition-all"
            >
              <RotateCcw className="size-3 mr-1" /> Reset book
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="max-w-md rounded-2xl border-white/60 bg-white/90 backdrop-blur-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-slate-900">Archive and reset the book?</AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-slate-600">
                  <span className="block">
                    This archives every paper + live trade to the ledger archive, then wipes the
                    active books and re-baselines the paper balance. The current window's
                    analysis history moves to the archive.
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    Type <span className="font-bold">RESET</span> to confirm.
                  </span>
                </div>
              </AlertDialogDescription>
            </AlertDialogHeader>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
              placeholder="RESET"
              className="w-full rounded-xl border border-white/70 bg-white/60 px-3 py-2 text-sm font-bold tracking-widest text-slate-800 outline-none placeholder:font-normal placeholder:tracking-normal placeholder:text-slate-400 focus:border-rose-300 focus:bg-white/80"
            />
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={confirmText !== "RESET" || busy}
                onClick={(e) => {
                  e.preventDefault();
                  void doReset();
                }}
                className="bg-rose-600 text-white hover:bg-rose-700"
              >
                {busy ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <RotateCcw className="size-3.5 mr-1.5" />}
                {busy ? "Resetting…" : "Archive & reset"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
    >
      {!ready ? (
        <p className="flex items-center justify-center gap-2 py-6 text-xs text-slate-400">
          <Loader2 className="size-3.5 animate-spin" /> Loading window state…
        </p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {stat("Window", w?.windowStart ? `${Number(w.daysElapsed).toFixed(1)}d` : "—")}
            {stat("Trades", String(total))}
            {stat("Closed", String(w?.closed ?? 0))}
            {stat("Pace", w?.tradesPerDay != null ? `${Number(w.tradesPerDay).toFixed(1)}/day` : "—")}
            {stat("Sample", sampleLabel, sampleTone as "up" | "amber" | "flat")}
            {stat(
              "Last reset",
              latest
                ? new Date(latest.purgedAt).toLocaleDateString("en-PH", {
                    timeZone: "Asia/Manila",
                    month: "short",
                    day: "numeric",
                  })
                : "none",
            )}
          </div>
          <p className="mt-3 text-[11px] leading-relaxed text-slate-500">
            {latest ? (
              <>
                Prior ledger: <span className="font-semibold text-slate-700">{latest.tradeCount} trades</span> archived{" "}
                {new Date(latest.purgedAt).toLocaleString("en-PH", {
                  timeZone: "Asia/Manila",
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
                {latest.reason ? ` — ${latest.reason}` : ""}. Every trade in the current book was taken under the current gate set.
              </>
            ) : (
              "No archive yet — the current book is the original ledger."
            )}{" "}
            Coverage: delay timeline {w?.coverage?.signalTime ?? 0}/{total} · excursion order{" "}
            {w?.coverage?.excursionOrder ?? 0}/{w?.closed ?? 0} · entry context {w?.coverage?.entryContext ?? 0}/{total}.
          </p>
        </>
      )}
    </GlassCard>
  );
}
