/**
 * ArchiveControls — "Download JSON / Prune" for a closed-trade book.
 *
 * Mounts in the header of the Closed-trades card on the paper workspace
 * (book "layer2") and the Live page (book "live").
 *
 *   - Download JSON: loops the server's keyset-paginated closed-history query
 *     (archive.getClosedArchivePage) until done, assembles a single JSON file
 *     client-side and saves it as <book>-closed-trades-YYYY-MM-DD.json. One
 *     on-demand read (~1 MB at ~750 rows) per click — the cheap export path —
 *     ready to hand to Claude for longer backtests.
 *   - Prune: deletes CLOSED detail rows whose exit is older than
 *     RETENTION_DAYS, after an explicit confirmation. Lifetime aggregate
 *     stats (Balance / Closed / Win rate / Realized PnL) are NOT touched —
 *     only per-trade detail rows older than the window leave the database.
 */
import { useState } from "react";
import { useAction, useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Download, Loader2, Trash2 } from "lucide-react";
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
import { pht } from "@/components/ui-kit";

export type ArchiveBook = "paper" | "live";

const RETENTION_DAYS = 30;

const BOOK_META: Record<ArchiveBook, { id: "layer2" | "live"; label: string }> = {
  paper: { id: "layer2", label: "Paper (layer2)" },
  live: { id: "live", label: "Live MEXC" },
};

export interface PruneResult {
  book: "layer2" | "live";
  cutoff: number;
  scanned: number;
  deleted: number;
  remainingClosed: number;
}

function dateStamp(ms: number) {
  const d = new Date(ms);
  const mm = `${d.getMonth() + 1}`.padStart(2, "0");
  const dd = `${d.getDate()}`.padStart(2, "0");
  return `${d.getFullYear()}-${mm}-${dd}`;
}

export function ArchiveControls({
  book,
  onPruned,
  compact = false,
}: {
  book: ArchiveBook;
  /** Called after a successful prune with the backend result (reset pagination etc.). */
  onPruned?: (result: PruneResult) => void;
  compact?: boolean;
}) {
  const convex = useConvex();
  const prune = useAction((api as any).archive.pruneClosedDetails);
  const meta = BOOK_META[book];
  const [busy, setBusy] = useState<"export" | "prune" | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const cutoffMs = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const download = async () => {
    setBusy("export");
    const rows: any[] = [];
    try {
      let cursor: string | null = null;
      for (let guard = 0; guard < 500; guard++) {
        const page: any = await (convex.query as any)(
          (api as any).archive.getClosedArchivePage,
          { book: meta.id, cursor, limit: 100 },
        );
        rows.push(...((page?.page as any[]) ?? []));
        if (page?.isDone || !page?.continueCursor) break;
        cursor = page.continueCursor;
      }
      if (rows.length === 0) {
        toast.info("Nothing to export yet", {
          description: `No closed ${meta.label} trades are stored.`,
        });
        return;
      }
      const payload = {
        exportedAt: Date.now(),
        book: meta.id,
        bookLabel: meta.label,
        note: "Per-trade detail rows currently stored in this book. All-time header stats (balance/closed/win rate/realized PnL) are lifetime aggregates and are not repeated per row — see the app header for those.",
        retentionDays: RETENTION_DAYS,
        tradeCount: rows.length,
        trades: rows,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const fileName = `${meta.id}-closed-trades-${dateStamp(Date.now())}.json`;
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast.success(`Exported ${rows.length} closed trades`, {
        description: `Saved ${rows.length} detail rows → ${fileName}`,
      });
    } catch (e: any) {
      toast.error("Export failed", {
        description: e?.message ?? "Could not assemble the trade export.",
      });
    } finally {
      setBusy(null);
    }
  };

  const confirmPrune = async () => {
    setBusy("prune");
    try {
      const result = (await prune({ book: meta.id, olderThanDays: RETENTION_DAYS })) as PruneResult;
      setConfirmOpen(false);
      if (result.deleted === 0) {
        toast.info("Nothing to prune", {
          description: `No ${meta.label} closed trades are older than ${RETENTION_DAYS} days.`,
        });
      } else {
        toast.success(`Pruned ${result.deleted} old detail rows`, {
          description: `${result.deleted} closed rows (closed before ${pht(result.cutoff)} PHT) were removed. All-time stats are unchanged.`,
        });
        onPruned?.(result);
      }
    } catch (e: any) {
      toast.error("Prune failed", {
        description: e?.message ?? "Could not delete old closed trades.",
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex items-center gap-1.5">
      <Button
        size="sm"
        variant="outline"
        className="h-7 border-white/60 bg-white/40 px-2.5 text-[11px] font-semibold text-slate-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] hover:bg-white/70"
        title="Download every stored closed trade as a JSON file (for offline / Claude backtesting)"
        disabled={busy !== null}
        onClick={download}
      >
        {busy === "export" ? <Loader2 className="size-3 animate-spin" /> : <Download className="size-3" />}
        {!compact && "Export JSON"}
      </Button>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogTrigger asChild>
          <Button
            size="sm"
            variant="outline"
            className="h-7 border-rose-200/70 bg-rose-50/50 px-2.5 text-[11px] font-semibold text-rose-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.6)] hover:bg-rose-100/80"
            title={`Delete closed ${meta.label} detail rows older than ${RETENTION_DAYS} days`}
            disabled={busy !== null}
          >
            {busy === "prune" ? <Loader2 className="size-3 animate-spin" /> : <Trash2 className="size-3" />}
            {!compact && "Prune"}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent className="border-white/60 bg-white/90 backdrop-blur-xl">
          <AlertDialogHeader>
            <AlertDialogTitle>Prune old closed {meta.label} trades?</AlertDialogTitle>
            <AlertDialogDescription>
              Deletes per-trade detail rows that closed before{" "}
              <span className="font-semibold text-slate-700">{pht(cutoffMs)} (PHT)</span>.
              <br />
              <br />
              Open positions are never touched, and your Balance / Closed / Win
              rate / Realized PnL (all-time stats) stay exactly as they are —
              only old detail rows leave the database. Export the JSON first if
              you want to keep this history for offline backtests in Claude.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-white/60 bg-white/60">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmPrune();
              }}
              className="bg-rose-600 text-white hover:bg-rose-700"
            >
              {busy === "prune" ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <Trash2 className="size-3" />
              )}
              Delete old details
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
