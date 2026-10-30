/**
 * LiveLedgerReset — the Live page's "delete all live history" control.
 *
 * WHY IT IS NOT A BARE BUTTON: the live ledger is the only record of real
 * money, and the engine's exit passes reconcile against those rows. A wipe is
 * therefore gated THREE ways:
 *
 *   1. The bot must be STOPPED (liveAccount.enabled = false). Deleting the
 *      ledger while armed would make the engine forget what it entered.
 *   2. No liveTrades row may still be open. A stopped bot keeps managing open
 *      positions to their SL/TP; deleting their rows would orphan a real
 *      exchange position that nothing on this side is watching any more.
 *   3. The operator must type RESET in the dialog — same convention as the
 *      paper "Reset book" card (MiningWindowCard).
 *
 * Both server-side guards are enforced in reset.ts as well (the skip reason
 * comes back in `live.skipped`), so this card cannot bypass them by racing the
 * page state. The wipe ARCHIVES first: every liveTrades row and the liveStats
 * doc are written to liveLedgerArchive before deletion, so a mis-click stays
 * recoverable in the database.
 *
 * KEPT on reset: liveAccount itself (enablement, leverage, risk%, balance
 * snapshots), strategyConfig, paper books and the signal log. Zeroed on reset:
 * trade counters, per-pair signal state / cooldowns, last entry errors.
 */
import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { GlassCard } from "@/components/GlassPanel";
import { Button } from "@/components/ui/button";
import { Chip, pht } from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { AlertTriangle, Archive, Loader2, RotateCcw } from "lucide-react";
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

export function LiveLedgerReset({
  armed,
  openCount,
  closedStored,
  allTimeClosed,
}: {
  /** liveAccount.enabled — the bot must be stopped before anything is deleted. */
  armed: boolean;
  /** Open liveTrades rows right now — a real position still being managed. */
  openCount: number;
  /**
   * Closed rows currently stored (what a reset actually deletes), from the
   * server-side count — NOT from the Live page's 100-row table window.
   * `undefined` while that count is loading.
   */
  closedStored?: number;
  /** Lifetime closed counter from liveStats (survives only until the reset). */
  allTimeClosed?: number;
}) {
  const resetBook = useMutation((api as any).reset.resetBookData);
  const latest = useQuery((api as any).reset.getLatestLiveArchive, {});
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  const blocked = armed || openCount > 0;
  const blockedReason = armed
    ? "Stop the live bot first — deleting an armed book would make the engine forget what it entered."
    : openCount > 0
      ? `${openCount} open position${openCount === 1 ? "" : "s"} still managed — close or reconcile ${openCount === 1 ? "it" : "them"} first, or the exchange position is orphaned.`
      : null;

  const doReset = async () => {
    setBusy(true);
    try {
      const r: any = await resetBook({
        // Never touch the paper books from a live control.
        paper: false,
        live: true,
        includeSignalLog: false,
        reason: `live book reset from Live page ${new Date().toISOString().slice(0, 10)}`,
      });
      const live = r?.live;
      if (live?.skipped) {
        toast.warning("Live ledger NOT reset", { description: live.skipped });
      } else if (live?.archivedTrades > 0) {
        toast.success(`Live ledger archived and wiped — ${live.archivedTrades} trade(s)`, {
          description:
            "Every row is in liveLedgerArchive; settings, leverage and balance snapshots are untouched. The next entry starts a fresh window.",
        });
        setOpen(false);
      } else {
        toast.info("Live ledger wiped", {
          description: "It was already empty — counters and per-pair state were re-zeroed.",
        });
        setOpen(false);
      }
      setConfirmText("");
    } catch (e: any) {
      toast.error("Reset failed", { description: e?.message ?? "try again" });
    } finally {
      setBusy(false);
    }
  };

  const stat = (label: string, value: string) => (
    <div className="min-w-0 rounded-xl border border-white/50 bg-white/35 px-2.5 py-2">
      <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-0.5 truncate text-xs font-bold tabular-nums text-slate-700">{value}</p>
    </div>
  );

  return (
    <GlassCard
      icon={<Archive className="size-4" />}
      title="Live book history"
      subtitle="Archive and delete every live trade — the real-money ledger only, paper books are never touched"
      className="mb-4"
      action={
        <AlertDialog
          open={open}
          onOpenChange={(v) => {
            setOpen(v);
            if (!v) setConfirmText("");
          }}
        >
          <AlertDialogTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              disabled={blocked || busy}
              title={blockedReason ?? "Archive every live trade, then wipe the live book"}
              className={cn(
                "h-7.5 rounded-xl border px-3 text-xs font-semibold shadow-[inset_0_1px_1px_rgba(255,255,255,0.8)] backdrop-blur-md transition-all",
                blocked || busy
                  ? "cursor-not-allowed border-slate-200/60 bg-slate-100/60 text-slate-400"
                  : "border-rose-300/60 bg-rose-50/70 text-rose-600 hover:bg-rose-100/90",
              )}
            >
              <RotateCcw className="size-3 mr-1" /> Reset live book
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="max-w-md rounded-2xl border-white/60 bg-white/90 backdrop-blur-2xl">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-slate-900">
                Archive and delete all live history?
              </AlertDialogTitle>
              <AlertDialogDescription asChild>
                <div className="space-y-2 text-slate-600">
                  <span className="block">
                    All{" "}
                    <span className="font-semibold text-slate-800">
                      {closedStored == null ? "stored" : closedStored}
                    </span>{" "}
                    live trade{closedStored === 1 ? "" : "s"} and the live stats doc are archived to{" "}
                    <code className="rounded border border-white/60 bg-white/70 px-1 py-0.5 font-mono text-[10px]">
                      liveLedgerArchive
                    </code>{" "}
                    first, then deleted. Counters, cooldowns and per-pair signal state are zeroed, so the next entry
                    starts a fresh window.
                  </span>
                  <span className="block text-[11px] text-slate-500">
                    Your risk settings, leverage, equity snapshots, gates and the paper books stay exactly as they are.
                    This cannot be undone from the app — the archive is the only copy.
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
                {busy ? (
                  <Loader2 className="size-3.5 animate-spin mr-1.5" />
                ) : (
                  <RotateCcw className="size-3.5 mr-1.5" />
                )}
                {busy ? "Wiping…" : "Archive & wipe"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      }
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {stat("Open positions", String(openCount))}
        {stat("Closed stored", closedStored == null ? "…" : String(closedStored))}
        {stat("All-time closed", allTimeClosed != null ? String(allTimeClosed) : "—")}
        {stat(
          "Last reset",
          latest ? new Date(latest.purgedAt).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", month: "short", day: "numeric" }) : "none",
        )}
      </div>

      {blockedReason ? (
        <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-300/40 bg-amber-50/70 px-3 py-2 text-[11px] font-medium leading-relaxed text-amber-800">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
          {blockedReason}
        </p>
      ) : (
        <p className="mt-3 flex flex-wrap items-center gap-1.5 text-[11px] leading-relaxed text-slate-500">
          <Chip tone="neutral" className="text-[9px] font-bold uppercase tracking-wide">
            ready
          </Chip>
          Bot stopped with no open positions — the ledger can be archived and wiped.
        </p>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
        {latest ? (
          <>
            Prior ledger:{" "}
            <span className="font-semibold text-slate-600">{latest.tradeCount} trade(s)</span> archived{" "}
            {pht(latest.purgedAt)}
            {latest.reason ? ` — ${latest.reason}` : ""}.
          </>
        ) : (
          "No live reset yet — the current book is the original ledger."
        )}{" "}
        Resetting is the only way to clear live history; the paper books keep their own records.
      </p>
    </GlassCard>
  );
}
