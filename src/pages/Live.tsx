/**
 * Live Trading — /live (protected).
 *
 * The REAL Layer 2 auto-bot: same EMA Momentum + Order Flow engine as the
 * paper book (same scoring and Layer 1 metrics, separate live config row,
 * same 15m cadence) but entries/exits are real orders on the trader's MEXC
 * futures account. Fresh ledger — live history only ever starts when the bot
 * is armed from this page. Runs in parallel with paper (see /dashboard).
 *
 * Nothing here can move money while the bot is stopped: entries fire only
 * inside liveBroker.liveEntryTick when liveAccount.enabled = true AND the
 * MEXC_API_KEY / MEXC_API_SECRET env vars exist on the deployment. Exits keep
 * running while stopped so open positions stay managed to their SL/TP.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { GlassCard, GlassPanel } from "@/components/GlassPanel";
import { ArchiveControls } from "@/components/ArchiveControls";
import { InlineErrorBoundary } from "@/components/InlineErrorBoundary";
import { EngineHeartbeat } from "@/components/EngineHeartbeat";
import { LiveLedgerReset } from "@/components/LiveLedgerReset";
import { LiveAdvancedView, LivePerformanceCard } from "@/components/LiveAdvancedView";
import { WorkspaceHeader } from "@/components/WorkspaceHeader";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  ChevronDown,
  ExternalLink,
  Loader2,
  Play,
  Power,
  RefreshCw,
  ShieldCheck,
  Square,
  Wallet,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Chip,
  FrostHead,
  SidePill,
  Stat,
  Th,
  Td,
  dur,
  pht,
  signedUsd,
  usd,
} from "@/components/ui-kit";

// Display-only fallbacks mirroring liveEngine's built-in LIVE_DEFAULT_* seeds.
// Real values come from the account row first, then the user-saved
// liveDefaults doc; these only show in the brief moment before those load.
const UI_DEFAULT_LEVERAGE = 20;
const UI_DEFAULT_RISK_PCT = 1;
const UI_DEFAULT_MAX_OPEN = 3;
// Closed-trades table: 5 rows per page. The query below still returns one
// bounded recent slice (≤100 rows) per open page — the pager only decides how
// many of those stored rows are on screen at once.
const CLOSED_PAGE_SIZE = 5;

function StatTile({
  label,
  value,
  sub,
  tone = "flat",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "up" | "down" | "flat";
}) {
  return <Stat label={label} value={value} sub={sub} tone={tone} />;
}

export default function Live() {
  const accountQuery = useQuery(api.liveEngine.getLiveAccount as any);
  const openTradesQuery = useQuery(api.liveEngine.getLiveOpenTrades as any);
  const closedTradesQuery = useQuery(api.liveEngine.getLiveClosedTrades as any, { limit: 100 });
  const statsQuery = useQuery(api.liveEngine.getLiveClosedStats as any);
  // Honest ledger size for the reset card: getLiveClosedTrades is capped at 100
  // rows for the table, so its length is not what a wipe would delete.
  const ledgerCountsQuery = useQuery((api as any).reset.getLiveLedgerCounts, {});
  const account = accountQuery;
  const openTrades = openTradesQuery ?? [];
  const closedTrades = closedTradesQuery ?? [];
  const stats = statsQuery ?? null;
  const openTradesLoading = openTradesQuery === undefined;
  const closedTradesLoading = closedTradesQuery === undefined;
  const statsLoading = statsQuery === undefined;

  const ensure = useMutation(api.liveEngine.ensureLiveAccount as any);
  const setEnabled = useMutation(api.liveEngine.setLiveEnabled as any);
  const updateSettings = useMutation(api.liveEngine.updateLiveSettings as any);
  const saveDefaults = useMutation(api.liveEngine.setLiveDefaults as any);
  const defaultsQuery = useQuery(api.liveEngine.getLiveDefaults as any);
  const probe = useAction(api.liveBroker.probeLiveConnection as any);
  const closeManual = useAction(api.cronWrappers.manualCloseLiveTradeSafe as any);
  const defaults = defaultsQuery ?? null;

  const [probing, setProbing] = useState(false);
  const [arming, setArming] = useState(false);
  const [confirmStart, setConfirmStart] = useState(false);
  const [closing, setClosing] = useState<string | null>(null);
  // Risk inputs are UNCONTROLLED (defaultValue = current account value) behind
  // a dirty flag, so a field can be cleared and retyped freely — a controlled
  // fallback used to snap cleared fields back to the stored value, making the
  // Save button unreliable. `riskResetKey` remounts the inputs after a
  // successful save so placeholders reflect the new account values.
  const riskInputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [riskDirty, setRiskDirty] = useState(false);
  const [riskResetKey, setRiskResetKey] = useState(0);
  const [riskSaving, setRiskSaving] = useState(false);
  const [riskError, setRiskError] = useState<string | null>(null);
  const [alsoDefaults, setAlsoDefaults] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const [closedPage, setClosedPage] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const ensureStartedRef = useRef(false);

  const ready = account !== undefined && account !== null;
  const enabled = !!account?.enabled;
  const lev = account?.leverage ?? defaults?.leverage ?? UI_DEFAULT_LEVERAGE;
  const riskPct = account?.riskPct ?? defaults?.riskPct ?? UI_DEFAULT_RISK_PCT;
  const maxOpen = account?.maxOpenPositions ?? defaults?.maxOpenPositions ?? UI_DEFAULT_MAX_OPEN;

  // Ensure the liveAccount row exists once (idempotent) before the UI relies
  // on it — mutations never run from render.
  useEffect(() => {
    if (ready || ensureStartedRef.current) return;
    ensureStartedRef.current = true;
    void ensure({}).catch(() => {
      ensureStartedRef.current = false;
    });
  }, [ready, ensure]);
  const balanceUsd = account?.balanceUsd;
  const walletUsd = account?.walletBalanceUsd;
  const lastProbe = account?.lastProbeAt ? pht(account.lastProbeAt) : null;
  const lastScan = account?.lastScanAt ? pht(account.lastScanAt, false) : null;
  const lastExit = account?.lastExitAt ? pht(account.lastExitAt, false) : null;
  const lastRLock = account?.lastRLockAt ? pht(account.lastRLockAt, false) : null;
  const lastIntent = account?.lastIntentAt ? pht(account.lastIntentAt, false) : null;

  // Stats are aggregated across the entire live ledger; the table is only a
  // bounded recent slice. Use the aggregate count for win/loss math so the
  // headline never compares total wins with only the first 100 rows.
  const closed = stats?.closedCount ?? closedTrades.length;
  const pnl = stats?.totalPnl ?? 0;
  const fees = stats?.totalFees ?? 0;
  // No wins / win-rate locals here any more: they were only rendered by the
  // account strip, which now duplicates nothing — the performance card at the
  // top of the page owns the win rate (2026-10-28).
  const netStats = stats?.closedCount ?? closed;

  // Closed-trades pager. The page index is clamped on every render (rather
  // than in an effect) so a ledger that shrinks — a reset, a prune, or just a
  // page refresh mid-view — can never strand the table on an empty page.
  const closedPageCount = Math.max(1, Math.ceil(closedTrades.length / CLOSED_PAGE_SIZE));
  const closedPageIdx = Math.min(closedPage, closedPageCount - 1);
  const closedPageStart = closedPageIdx * CLOSED_PAGE_SIZE;
  const closedPageRows = closedTrades.slice(closedPageStart, closedPageStart + CLOSED_PAGE_SIZE);

  const handleStart = async () => {
    setConfirmStart(false);
    setArming(true);
    try {
      const res: any = await probe({});
      if (!res?.ok) {
        toast.error("Live bot not armed", { description: res?.detail ?? "Connection test failed." });
        return;
      }
      await setEnabled({ enabled: true });
      toast.success("Live bot ARMED", {
        description: "Same Layer 2 engine, real MEXC orders. First entry scan runs on the 15m cron.",
      });
    } catch (e: any) {
      const message = e?.message ?? "Unknown error";
      toast.error("Failed to arm", { description: message });
    } finally {
      setArming(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    try {
      await setEnabled({ enabled: false });
      toast("Live bot stopped", {
        description: "No new entries. Open positions are still managed to their SL/TP by the exit cron.",
      });
    } catch (e: any) {
      toast.error("Could not stop live bot", {
        description: e?.message ?? "The enable state was not changed.",
      });
    } finally {
      setStopping(false);
    }
  };

  const handleProbe = async () => {
    setProbing(true);
    try {
      const res: any = await probe({});
      if (res?.ok) {
        toast.success("MEXC connection OK", { description: res.detail });
      } else {
        toast.error("MEXC connection failed", { description: res?.detail ?? "See probe detail below." });
      }
    } catch (e: any) {
      toast.error("Probe error", { description: e?.message ?? "Unknown error" });
    } finally {
      setProbing(false);
    }
  };

  useEffect(() => {
    if (openTrades.length === 0) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [openTrades.length]);

  const saveRisk = async () => {
    const rawLev = riskInputs.current.lev?.value ?? "";
    const rawRisk = riskInputs.current.risk?.value ?? "";
    const rawMax = riskInputs.current.max?.value ?? "";
    const leverage = rawLev !== "" ? Number(rawLev) : undefined;
    const riskPctNum = rawRisk !== "" ? Number(rawRisk) : undefined;
    const maxPosNum = rawMax !== "" ? Number(rawMax) : undefined;
    if (leverage != null && (isNaN(leverage) || leverage < 1 || leverage > 125)) {
      toast.error("Leverage must be between 1 and 125");
      return;
    }
    if (riskPctNum != null && (isNaN(riskPctNum) || riskPctNum < 0.1 || riskPctNum > 2)) {
      toast.error("Risk % must be between 0.1 and 2 (2% hard ceiling)");
      return;
    }
    if (maxPosNum != null && (isNaN(maxPosNum) || !Number.isInteger(maxPosNum) || maxPosNum < 1 || maxPosNum > 20)) {
      toast.error("Max open positions must be a whole number between 1 and 20");
      return;
    }
    setRiskSaving(true);
    setRiskError(null);
    try {
      await updateSettings({ leverage, riskPct: riskPctNum, maxOpenPositions: maxPosNum });
      let defaultsSaved = false;
      if (alsoDefaults) {
        try {
          await saveDefaults({ leverage, riskPct: riskPctNum, maxOpenPositions: maxPosNum });
          defaultsSaved = true;
        } catch (e2: any) {
          toast.error("Account saved, but defaults save failed", {
            description: e2?.message ?? "The new-account defaults were not updated.",
          });
        }
      }
      setRiskDirty(false);
      setRiskResetKey((k) => k + 1);
      // Uncheck only when everything (including defaults) actually saved, so a
      // defaults failure can be retried without re-typing.
      if (!alsoDefaults || defaultsSaved) setAlsoDefaults(false);
      toast.success("Risk settings saved", {
        description:
          `Leverage ${leverage ?? lev}x · risk ${riskPctNum ?? riskPct}% per trade · max ${maxPosNum ?? maxOpen} open` +
          (defaultsSaved ? " · also saved as new-account defaults" : ""),
      });
    } catch (e: any) {
      const message = e?.message ?? "Unable to save risk settings";
      setRiskError(message);
      toast.error("Save failed", { description: message });
    } finally {
      setRiskSaving(false);
    }
  };

  const handleClose = async (id: string) => {
    setClosing(id);
    const res: any = await closeManual({ id }).catch((e: any) => ({ ok: false, reason: e?.message }));
    if (res?.ok) toast.success("Close order placed", { description: "The durable close intent will reconcile against the MEXC fill." });
    else toast.error("Close failed", { description: res?.reason ?? "Unknown error" });
    setClosing(null);
  };

  if (!ready) {
    // account row not created yet; useEffect ensures it above. Render a light
    // placeholder instead of flashing empty tables.
    return (
      <main className="flex min-h-screen items-center justify-center">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Loader2 className="size-4 animate-spin" /> Preparing live engine…
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen relative">
      {/* Background with fluid luminous liquid lighting */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="absolute -top-48 -right-28 size-[580px] rounded-full bg-gradient-to-br from-rose-400/20 via-orange-300/15 to-pink-300/10 blur-[100px]" />
        <div className="absolute top-1/4 -left-32 size-[480px] rounded-full bg-gradient-to-tr from-sky-400/18 via-indigo-300/12 to-cyan-200/10 blur-[100px]" />
        <div className="absolute bottom-10 right-1/4 size-[400px] rounded-full bg-gradient-to-tl from-emerald-400/15 via-teal-200/10 to-transparent blur-[90px]" />
      </div>

      <div className="relative z-10 mx-auto max-w-[1400px] px-4 py-6 sm:px-6 lg:px-8">
        <WorkspaceHeader
          accent="live"
          title="Live Trading"
          subtitle="Real USDT futures orders · same Layer 2 bot as paper · runs in parallel"
        />

        {/* ── Overall performance — deliberately OUTSIDE the "Advanced data"
             toggle so it is visible the moment /live opens. Fed by the one
             aggregate stats doc the header already reads, so it stays cheap. ── */}
        <LivePerformanceCard stats={stats as any} loading={statsLoading} />

        {/* ── Command strip: status + arm/stop ── */}
        <GlassPanel className="mb-4 p-4 sm:p-5">
          <div className="flex flex-col gap-3.5 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2.5">
              <span
                className={cn(
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-bold tracking-wide backdrop-blur-xl shadow-xs transition-all",
                  enabled
                    ? "border-rose-500/30 bg-rose-500/10 text-rose-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9)]"
                    : "border-slate-400/20 bg-slate-500/10 text-slate-500",
                )}
              >
                <span className={cn("size-2 rounded-full", enabled ? "animate-pulse bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.6)]" : "bg-slate-300")} />
                {enabled ? "ARMED — LIVE ORDERS ACTIVE" : "BOT STOPPED"}
              </span>
              {account?.lastProbeOk === true && (
                <Chip tone="up">
                  <ShieldCheck className="size-3.5" /> API connected
                </Chip>
              )}
              {account?.lastProbeOk === false && (
                <Chip tone="amber">
                  <AlertTriangle className="size-3.5" /> API needs attention
                </Chip>
              )}
              <Chip tone="neutral" className="font-mono text-[11px]">
                risk {riskPct}% · {lev}× · max {maxOpen} open
              </Chip>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-8.5 rounded-xl border border-white/70 bg-white/45 px-3 text-xs font-semibold text-slate-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9)] backdrop-blur-xl hover:bg-white/70 hover:text-slate-900 transition-all"
                onClick={handleProbe}
                disabled={probing || stopping}
              >
                {probing ? <Loader2 className="size-3.5 animate-spin mr-1.5" /> : <RefreshCw className="size-3.5 mr-1.5 text-slate-400" />}
                Test connection
              </Button>
              {!enabled ? (
                <Button
                  size="sm"
                  onClick={() => setConfirmStart(true)}
                  disabled={arming}
                  className="h-8.5 rounded-xl border border-rose-400/40 bg-gradient-to-r from-rose-500 to-orange-500 px-4 text-xs font-bold text-white shadow-[inset_0_1px_1px_rgba(255,255,255,0.35),0_6px_20px_-4px_rgba(244,63,94,0.35)] hover:from-rose-600 hover:to-orange-600 transition-all"
                >
                  {arming ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Play className="mr-1.5 size-3.5" />}
                  Start live bot
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleStop}
                  disabled={stopping}
                  className="h-8.5 rounded-xl border border-rose-300/60 bg-rose-50/70 px-4 text-xs font-bold text-rose-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9)] backdrop-blur-xl hover:bg-rose-100/80 transition-all"
                >
                  {stopping ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Square className="mr-1.5 size-3.5" />}
                  {stopping ? "Stopping…" : "Stop (keeps SL/TP running)"}
                </Button>
              )}
            </div>
          </div>
        </GlassPanel>

        {/* ── Connection detail ── */}
        <GlassPanel className="mb-4 p-3.5 sm:px-5">
          <div className="flex flex-col gap-2 text-xs text-slate-500 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex min-w-0 items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-sky-400/30 bg-sky-500/10 text-sky-600">
                <Wallet className="size-3.5" />
              </span>
              <p className="truncate font-medium">
                {account?.lastProbeDetail ? (
                  account.lastProbeDetail
                ) : (
                  <>
                    Not tested yet — credentials live in the project Keys tab as{" "}
                    <code className="rounded border border-white/60 bg-white/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-700">MEXC_API_KEY</code> and{" "}
                    <code className="rounded border border-white/60 bg-white/70 px-1.5 py-0.5 font-mono text-[10px] text-slate-700">MEXC_API_SECRET</code>
                  </>
                )}
              </p>
            </div>
            {lastProbe && <span className="shrink-0 text-slate-400 font-mono text-[11px]">probed {lastProbe}</span>}
          </div>
        </GlassPanel>

        {/* ── Account strip ──
             ONLY the values the performance card above does not carry. Wins /
             losses, win rate, realized PnL and the fetched row count used to sit
             here too — they printed the same numbers twice on one screen
             (2026-10-28). The record now lives in one place: the card at the top. ── */}
        <div className="mb-4 grid grid-cols-2 gap-2.5 lg:max-w-xl">
          <Stat
            label="Exchange equity"
            value={usd(balanceUsd)}
            tone={(balanceUsd ?? 0) > 0 ? "up" : "flat"}
            sub={walletUsd != null ? `wallet ${usd(walletUsd)}` : undefined}
            icon={<Wallet className="size-3.5 text-sky-500" />}
          />
          <Stat label="Open positions" value={`${openTrades.length} / ${maxOpen}`} sub={`cap ${maxOpen} concurrent`} />
        </div>

        {/* ── Risk settings ── */}
        <GlassCard
          title="Risk settings"
          subtitle="Applied to every NEW live entry — open positions keep their entry leverage and SL/TP"
          className="mb-4"
        >
          {enabled && (
            <div className="mb-3.5 flex items-start gap-2.5 rounded-2xl border border-amber-300/40 bg-amber-50/70 p-3.5 text-xs text-amber-800 backdrop-blur-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" />
              <span className="font-medium leading-relaxed">
                Live is armed. Changes apply to the next 15-minute entry scan; current positions keep their entry values.
              </span>
            </div>
          )}
          {riskError && (
            <p className="mb-2 text-xs font-semibold text-rose-600" role="alert">{riskError}</p>
          )}
          <div className="flex flex-wrap items-end gap-3.5">
            {[
              { key: "lev", label: "Leverage", min: 1, max: 125, step: 1, hint: "×" },
              { key: "risk", label: "Risk per trade % (max 2%)", min: 0.1, max: 2, step: 0.1, hint: "% of live equity at SL · hard ceiling 2%" },
              { key: "max", label: "Max open positions", min: 1, max: 20, step: 1, hint: "slots" },
            ].map((f) => {
              const current = f.key === "lev" ? lev : f.key === "risk" ? riskPct : maxOpen;
              return (
              <div key={f.key}>
                <label className="text-[10px] font-bold uppercase tracking-wider text-slate-400">{f.label}</label>
                <input
                  ref={(el) => {
                    riskInputs.current[f.key] = el;
                  }}
                  key={`${f.key}-${riskResetKey}-${current}`}
                  type="number"
                  defaultValue={String(current)}
                  min={f.min}
                  max={f.max}
                  step={f.step}
                  onChange={() => setRiskDirty(true)}
                  className="mt-1 block w-32 rounded-xl border border-white/60 bg-white/60 px-3 py-1.5 font-mono text-sm font-semibold tabular-nums text-slate-800 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9)] outline-none backdrop-blur-md transition-all focus:border-sky-400 focus:bg-white/80"
                />
                <p className="mt-1 text-[10px] text-slate-400">{f.hint}</p>
              </div>
              );
            })}
            <label
              className="mb-5 flex w-76 cursor-pointer select-none items-start gap-2.5 rounded-xl border border-white/50 bg-white/35 px-3 py-2 text-[11px] leading-snug text-slate-600 backdrop-blur-sm transition-all hover:bg-white/55"
              title="Also store these values as the seed for a fresh liveAccount row"
            >
              <input
                type="checkbox"
                checked={alsoDefaults}
                onChange={(e) => setAlsoDefaults(e.target.checked)}
                className="mt-0.5 size-3.5 shrink-0 rounded accent-sky-600"
              />
              Also save as defaults for new accounts (applies if reset)
            </label>
            <Button
              size="sm"
              variant="outline"
              className="mb-5 h-9 rounded-xl border border-white/70 bg-white/50 px-4 text-xs font-semibold text-slate-700 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9)] backdrop-blur-xl hover:bg-white/75 transition-all"
              disabled={riskSaving || !riskDirty}
              onClick={saveRisk}
            >
              {riskSaving ? "Saving…" : "Save"}
            </Button>
          </div>
          <p className="text-[11px] text-slate-400">
            {enabled
              ? `Live — changes apply on the next 15m entry scan. Open positions keep their entry leverage and SL/TP.`
              : `The bot is stopped — you can still set these now; they take effect when you arm it.`}
          </p>
          <p className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-white/40 pt-2.5 text-[11px] text-slate-400">
            <span className="font-semibold text-slate-500">New-account defaults:</span>
            {defaults ? (
              <span className="rounded-lg border border-white/60 bg-white/60 px-2 py-0.5 font-mono text-[11px] font-semibold text-slate-700">
                risk {defaults.riskPct}% · {defaults.leverage}× · max {defaults.maxOpenPositions} open
              </span>
            ) : (
              <span className="font-mono text-[11px]">
                risk {UI_DEFAULT_RISK_PCT}% · {UI_DEFAULT_LEVERAGE}× · max {UI_DEFAULT_MAX_OPEN} open
              </span>
            )}
          </p>
        </GlassCard>

        {/* ── Open positions ── */}
        <GlassCard
          icon={<ShieldCheck className="size-4" />}
          title={`Open positions (${openTrades.length})`}
          subtitle="Exit reconciliation runs on the 15-minute exchange/settlement cadence; the 5-minute R-lock pass handles trailing exits"
          className="mb-4"
        >
          {openTradesLoading ? (
            <p className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
              <Loader2 className="size-3.5 animate-spin" /> Loading open positions…
            </p>
          ) : openTrades.length === 0 ? (
            <p className="py-10 text-center text-xs text-slate-400">
              No open live positions. When armed, the engine places real orders the moment a signal qualifies.
            </p>
          ) : (
            <>
              <div className="space-y-2.5 md:hidden">
                {openTrades.map((t: any) => (
                  <div key={t._id} className="rounded-2xl border border-white/60 bg-white/45 p-4 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9),0_6px_20px_-6px_rgba(15,23,42,0.06)] backdrop-blur-xl">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-900">{t.coin}</span>
                          <SidePill side={t.type} />
                        </div>
                        <p className="mt-1 text-[11px] font-medium text-slate-400">{t.session ? `${t.session} · ` : ""}{dur(now - t.entryTime)} held</p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7.5 shrink-0 rounded-xl border border-rose-300/60 bg-rose-50/70 px-3 text-xs font-semibold text-rose-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.8)] backdrop-blur-md hover:bg-rose-100/90 transition-all"
                        disabled={closing === t._id}
                        onClick={() => handleClose(t._id)}
                      >
                        {closing === t._id ? <Loader2 className="size-3 animate-spin mr-1" /> : <Power className="size-3 mr-1" />}
                        Close
                      </Button>
                    </div>
                    <div className="mt-3.5 grid grid-cols-2 gap-2 text-xs">
                      <MobileValue label="Entry" value={t.entryPrice ? usd(t.entryPrice, 4) : "—"} />
                      <MobileValue label="Margin" value={usd(t.marginUsd)} />
                      <MobileValue label="Stop loss" value={usd(t.slPrice, 4)} tone="down" />
                      <MobileValue label="Take profit" value={usd(t.tpPrice, 4)} tone="up" />
                      <MobileValue label="Size" value={`${t.volContracts ?? "—"} contracts`} />
                      <MobileValue label="Leverage" value={`${t.leverage ?? "—"}x`} />
                    </div>
                    <div className="mt-3.5 flex items-center justify-between gap-2 border-t border-white/40 pt-2.5">
                      {t.exchangeStop === false || t.exchangeStop == null ? (
                        <Chip tone="amber">monitor-managed</Chip>
                      ) : (
                        <Chip tone="up">exchange stop</Chip>
                      )}
                      <span className="text-[10px] font-medium text-slate-400">SL/TP protection</span>
                    </div>
                  </div>
                ))}
              </div>
              <div className="hidden overflow-x-auto md:block rounded-2xl border border-white/60 bg-white/30 backdrop-blur-xl">
              <table className="w-full border-separate border-spacing-0">
                <FrostHead>
                  <Th>Coin</Th>
                  <Th>Side</Th>
                  <Th right>Entry est.</Th>
                  <Th right>SL</Th>
                  <Th right>TP</Th>
                  <Th>Protection</Th>
                  <Th right>Contracts</Th>
                  <Th right>Notional</Th>
                  <Th right>Margin</Th>
                  <Th right>Lev</Th>
                  <Th>Session</Th>
                  <Th>Held</Th>
                  <Th></Th>
                </FrostHead>
                <tbody>
                  {openTrades.map((t: any, i: number) => (
                    <tr key={t._id} className={cn(i % 2 === 1 && "bg-white/20", "transition-colors hover:bg-white/40")}>
                      <Td className="font-bold text-slate-900 tracking-tight">{t.coin}</Td>
                      <Td>
                        <SidePill side={t.type} />
                      </Td>
                      <Td right className="font-mono font-medium">{t.entryPrice ? usd(t.entryPrice, 4) : "—"}</Td>
                      <Td right className="font-mono font-semibold text-rose-600">{usd(t.slPrice, 4)}</Td>
                      <Td right className="font-mono font-semibold text-emerald-600">{usd(t.tpPrice, 4)}</Td>
                      <Td>
                        {t.exchangeStop === false || t.exchangeStop == null ? (
                          <Chip tone="amber" title="No exchange-side bracket — 5-minute stop/R-lock monitoring plus the 15-minute TP/settlement pass remain active">
                            monitor-managed
                          </Chip>
                        ) : (
                          <Chip tone="up" title="SL/TP attached on the exchange — closes instantly at level">
                            exchange stop
                          </Chip>
                        )}
                      </Td>
                      <Td right className="font-mono">{t.volContracts}</Td>
                      <Td right className="font-mono">{usd(t.notionalUsd)}</Td>
                      <Td right className="font-mono">{usd(t.marginUsd)}</Td>
                      <Td right className="font-mono font-semibold text-slate-700">{t.leverage}x</Td>
                      <Td>{t.session ? <Chip tone="brand">{t.session}</Chip> : "—"}</Td>
                      <Td className="text-[11px] font-mono text-slate-500">{dur(now - t.entryTime)}</Td>
                      <Td className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7.5 rounded-xl border border-rose-300/60 bg-rose-50/70 px-3 text-xs font-semibold text-rose-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.8)] backdrop-blur-md hover:bg-rose-100/90 transition-all"
                          disabled={closing === t._id}
                          onClick={() => handleClose(t._id)}
                        >
                          {closing === t._id ? <Loader2 className="size-3 animate-spin mr-1" /> : <Power className="size-3 mr-1" />}
                          Close
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </>
          )}
        </GlassCard>

        {/* ── Closed trades ── */}
        <GlassCard
          icon={<ArrowUpRight className="size-4" />}
          title={`Closed trades (${closedTrades.length}${netStats > closedTrades.length ? ` · ${netStats} all-time` : ""})`}
          subtitle={
            pnl !== 0
              ? `Realized PnL ${signedUsd(pnl)}${fees > 0 ? ` · est. fees ${signedUsd(fees)}` : ""}`
              : "Live ledger starts empty until the first real trade closes"
          }
          className="mb-4"
          action={
            <div className="flex flex-wrap items-center justify-end gap-2">
              {closedTrades.length > 0 && (
                <span className="text-[10px] text-slate-400">
                  {closedPageStart + 1}–{closedPageStart + closedPageRows.length} of {closedTrades.length}
                </span>
              )}
              <ArchiveControls book="live" />
            </div>
          }
        >
          {closedTradesLoading ? (
            <p className="flex items-center justify-center gap-2 py-10 text-xs text-slate-400">
              <Loader2 className="size-3.5 animate-spin" /> Loading closed history…
            </p>
          ) : closedTrades.length === 0 ? (
            <p className="py-10 text-center text-xs text-slate-400">
              No closed live trades yet. Nothing is migrated from paper — this book only records real fills from this page.
            </p>
          ) : (
            <>
              <div className="space-y-2 md:hidden">
                {closedPageRows.map((t: any) => {
                  const isWin = (t.pnlUsd ?? 0) > 0;
                  return (
                    <div key={t._id} className="rounded-xl border border-white/50 bg-white/35 p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-700">{t.coin}</span>
                          <SidePill side={t.type} />
                        </div>
                        <span className={cn("text-sm font-bold tabular-nums", isWin ? "text-emerald-600" : "text-red-500")}>
                          {t.pnlUsd != null ? signedUsd(t.pnlUsd) : "—"}
                        </span>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                        <MobileValue label="Entry" value={t.entryPrice ? usd(t.entryPrice, 4) : "—"} />
                        <MobileValue label="Exit" value={t.exitPrice ? usd(t.exitPrice, 4) : "—"} />
                        <MobileValue label="Result" value={t.reason ?? "—"} />
                        <MobileValue label="R multiple" value={t.realizedR != null ? `${t.realizedR >= 0 ? "+" : ""}${Number(t.realizedR).toFixed(1)}R` : "—"} tone={isWin ? "up" : "down"} />
                      </div>
                      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/40 pt-2 text-[10px] text-slate-400">
                        {t.session && <Chip tone="brand">{t.session}</Chip>}
                        <span>closed {pht(t.exitTime)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="hidden max-h-96 overflow-x-auto overflow-y-auto rounded-2xl border border-white/60 bg-white/30 backdrop-blur-xl md:block">
              <table className="w-full border-separate border-spacing-0">
                <FrostHead>
                  <Th>Coin</Th>
                  <Th>Side</Th>
                  <Th right>Entry</Th>
                  <Th right>Exit</Th>
                  <Th>Exit</Th>
                  <Th right>R</Th>
                  <Th right>PnL</Th>
                  <Th right>Fees</Th>
                  <Th>Session</Th>
                  <Th>Closed (PHT)</Th>
                </FrostHead>
                <tbody>
                  {closedPageRows.map((t: any, i: number) => {
                    const isWin = (t.pnlUsd ?? 0) > 0;
                    return (
                      <tr key={t._id} className={cn(i % 2 === 1 && "bg-white/20", "transition-colors hover:bg-white/40")}>
                        <Td className="font-bold text-slate-900">{t.coin}</Td>
                        <Td>
                          <SidePill side={t.type} />
                        </Td>
                        <Td right className="font-mono">{t.entryPrice ? usd(t.entryPrice, 4) : "—"}</Td>
                        <Td right className="font-mono">{t.exitPrice ? usd(t.exitPrice, 4) : "—"}</Td>
                        <Td>
                          <Chip
                            tone={
                              (t.reason ?? "").includes("Take Profit")
                                ? "up"
                                : (t.reason ?? "").includes("Stop Loss")
                                  ? "down"
                                  : "neutral"
                            }
                          >
                            {t.reason ?? "—"}
                          </Chip>
                        </Td>
                        <Td right className={cn("font-mono font-bold", isWin ? "text-emerald-600" : "text-rose-600")}>
                          {t.realizedR != null ? `${t.realizedR >= 0 ? "+" : ""}${t.realizedR.toFixed(1)}R` : "—"}
                        </Td>
                        <Td right className={cn("font-mono font-bold", isWin ? "text-emerald-600" : "text-rose-600")}>
                          {t.pnlUsd != null ? signedUsd(t.pnlUsd) : "n/a"}
                        </Td>
                        <Td right className="font-mono text-[11px] text-slate-400">{t.feesUsd ? usd(t.feesUsd) : "—"}</Td>
                        <Td>{t.session ? <Chip tone="brand">{t.session}</Chip> : "—"}</Td>
                        <Td className="font-mono text-[11px] text-slate-500">{pht(t.exitTime)}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              </div>
              {closedPageCount > 1 && (
                <div className="mt-3 flex items-center justify-center gap-1.5">
                  <PagerBtn onClick={() => setClosedPage(0)} disabled={closedPageIdx === 0} label="«" />
                  <PagerBtn
                    onClick={() => setClosedPage(Math.max(0, closedPageIdx - 1))}
                    disabled={closedPageIdx === 0}
                    label="‹ Prev"
                  />
                  <span className="px-2 text-[11px] font-medium text-slate-500 tabular-nums">
                    {closedPageIdx + 1} / {closedPageCount}
                  </span>
                  <PagerBtn
                    onClick={() => setClosedPage(Math.min(closedPageCount - 1, closedPageIdx + 1))}
                    disabled={closedPageIdx >= closedPageCount - 1}
                    label="Next ›"
                  />
                  <PagerBtn
                    onClick={() => setClosedPage(closedPageCount - 1)}
                    disabled={closedPageIdx >= closedPageCount - 1}
                    label="»"
                  />
                </div>
              )}
            </>
          )}
        </GlassCard>

        {/* ── Live book history: the guarded "delete all live history" control.
             Server-side guards are in reset.ts; the card only mirrors them. ── */}
        <LiveLedgerReset
          armed={enabled}
          openCount={openTrades.length}
          closedStored={ledgerCountsQuery?.closed}
          allTimeClosed={netStats}
        />

        {/* ── Live advanced data (on-demand — mounted only while expanded, so
             the whole-live-ledger read exists only when this panel is open) ── */}
        <GlassPanel className="mb-4 p-4">
          <div className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg border border-white/60 bg-violet-100/60 text-violet-500">
              <BarChart3 className="size-3.5" />
            </span>
            <p className="text-sm font-semibold tracking-tight text-slate-800">Advanced data (live)</p>
            <span className="ml-auto hidden sm:block text-[10px] text-slate-400">
              Session · per-pair · exit-reason analytics
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowAdvanced((v) => !v)}
              className="ml-auto h-8 rounded-full border-slate-200/60 bg-white/40 text-[11px] text-slate-600 backdrop-blur-sm sm:ml-2"
            >
              {showAdvanced ? "Hide" : "Show"}
              <ChevronDown className={cn("ml-1 size-3 transition-transform", showAdvanced && "rotate-180")} />
            </Button>
          </div>
          {showAdvanced ? (
            <div className="mt-4">
              <InlineErrorBoundary label="Live Advanced Data">
                <LiveAdvancedView />
              </InlineErrorBoundary>
            </div>
          ) : (
            <p className="mt-2 text-[10px] text-slate-400">
              Collapsed — no full-ledger read happens while this stays closed (keeps the live page's standing reads to
              open positions + the one aggregate stats doc). Expanding loads the whole live book on demand.
            </p>
          )}
        </GlassPanel>

        {/* ── Engine diagnostics ── */}
        <GlassPanel className="mb-4 p-4 sm:p-5">
          <div className="mb-3 flex items-center gap-2.5">
            <span className="flex size-7 items-center justify-center rounded-xl border border-white/70 bg-white/50 text-slate-500 shadow-xs">
              <RefreshCw className="size-3.5" />
            </span>
            <p className="text-sm font-bold tracking-tight text-slate-800">Engine diagnostics</p>
            <span className="ml-auto hidden gap-2 sm:flex">
              {lastScan && <Chip tone="neutral" className="font-mono text-[10px]">entry scan {lastScan}</Chip>}
              {lastExit && <Chip tone="neutral" className="font-mono text-[10px]">exit check {lastExit}</Chip>}
              {lastRLock && <Chip tone="neutral" className="font-mono text-[10px]">R-lock {lastRLock}</Chip>}
              {lastIntent && <Chip tone="neutral" className="font-mono text-[10px]">recovery {lastIntent}</Chip>}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-2xl border border-white/60 bg-white/45 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-md">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Last entry scan</p>
              <p className="mt-1 break-words font-mono text-xs font-medium text-slate-700 leading-relaxed">
                {account?.lastScanResult ?? "No scan yet — runs every 15 min while armed."}
              </p>
            </div>
            <div className="rounded-2xl border border-white/60 bg-white/45 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-md">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Last exit check</p>
              <p className="mt-1 break-words font-mono text-xs font-medium text-slate-700 leading-relaxed">
                {account?.lastExitResult ?? "No exit check yet — settlement runs on the 15-minute cadence; R-lock runs every 5 minutes."}
              </p>
            </div>
            <div className="rounded-2xl border border-white/60 bg-white/45 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-md">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Last R-lock / stop monitor</p>
              <p className="mt-1 break-words font-mono text-xs font-medium text-slate-700 leading-relaxed">
                {account?.lastRLockResult ?? "No R-lock pass yet — recovery runs every 5 minutes."}
              </p>
              {account?.lastRLockError && (
                <p className="mt-1 break-words font-mono text-[10px] text-rose-600">{account.lastRLockError}</p>
              )}
              {(account?.lastRLockPending || account?.lastRLockUnmanaged) ? (
                <p className="mt-1 font-mono text-[10px] text-amber-700">
                  pending {account?.lastRLockPending ?? 0} · unmanaged {account?.lastRLockUnmanaged ?? 0}
                </p>
              ) : null}
            </div>
            <div className="rounded-2xl border border-white/60 bg-white/45 p-3.5 shadow-[inset_0_1px_1px_rgba(255,255,255,0.85)] backdrop-blur-md">
              <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Last durable-intent recovery</p>
              <p className="mt-1 break-words font-mono text-xs font-medium text-slate-700 leading-relaxed">
                {account?.lastIntentResult ?? "No recovery pass yet — runs every 5 minutes."}
              </p>
              {(account?.lastIntentPending || account?.lastIntentFailed) ? (
                <p className="mt-1 font-mono text-[10px] text-amber-700">
                  pending {account?.lastIntentPending ?? 0} · failed {account?.lastIntentFailed ?? 0}
                </p>
              ) : null}
            </div>
          </div>

          {/* Cron liveness — every gate in this stack fails OPEN on missing
              data, so a stalled tick is invisible in the results above. */}
          <InlineErrorBoundary label="Engine heartbeat">
            <EngineHeartbeat />
          </InlineErrorBoundary>
        </GlassPanel>



        {/* ── Parity notes ── */}
        <GlassPanel className="p-4">
          <p className="mb-2 text-sm font-semibold tracking-tight text-slate-800">How this bot runs</p>
          <ul className="space-y-1.5 pl-4 text-[11px] leading-relaxed text-slate-500 list-disc">
            <li>
              <span className="font-medium text-slate-600">Same engine as paper Layer 2:</span> identical EMA Momentum +
              order-flow scoring and Layer 1 metrics, with a separate live strategyConfig row so Paper/Live controls
              cannot leak across books. Both use the same 15m closed-candle signal rules.
            </li>
            <li>
              <span className="font-medium text-slate-600">Protective stops live on the exchange:</span> the fill and its
              frozen SL/TP are written to the durable ledger first, then the fenced bracket reconciler attaches TP/SL by
              position. MEXC owns the close once that order is accepted; rows without an exchange bracket remain protected by
              the 5-minute stop/R-lock monitor and 15-minute settlement pass.
            </li>
            <li>
              <span className="font-medium text-slate-600">Fresh book:</span> no paper history is copied here. The live
              ledger starts empty when you arm it.
            </li>
            <li>
              <span className="font-medium text-slate-600">Runs in parallel with paper:</span> the paper bot keeps scanning
              on the Paper workspace while this one trades.
            </li>
            <li>
              <span className="font-medium text-slate-600">Exits:</span> the 5-minute R-lock pass owns trailing and
              monitor stops, the 15-minute settlement pass checks brackets/vanished positions, and the independent
              5-minute intent worker resolves accepted MEXC orders before any retry. Exchange fills replace ledger estimates.
            </li>
            <li>
              <span className="font-medium text-slate-600">Position cap:</span> never more than {maxOpen} concurrent live
              positions — counted on the exchange itself. Entry scans are skipped while the cap is full; raise it in Risk
              settings once more funds are in.
            </li>
            <li>
              <span className="font-medium text-slate-600">Safety:</span> nothing is placed unless you press Start live bot,
              the API keys exist, and an entry signal passes every filter. Stopping only pauses new entries.
            </li>
          </ul>
          <p className="mt-3 flex items-center gap-1.5 text-[10px] text-slate-400">
            <ExternalLink className="size-3" />
            Select Live in the strategy console to edit the live configuration; Paper edits remain isolated.
          </p>
        </GlassPanel>
      </div>

      {/* ── Arm confirmation ── */}
      <AlertDialog open={confirmStart} onOpenChange={setConfirmStart}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-rose-500" />
              Start the live bot with REAL money?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This places real orders on the MEXC futures account connected by your API keys. It is the same Layer 2
              strategy as paper trading — but trades are executed with your actual funds, sized at the risk settings above.
              Nothing is migrated in: the live ledger starts empty now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleStart}
              className="bg-gradient-to-r from-rose-500 to-orange-500 hover:from-rose-600 hover:to-orange-600"
            >
              Yes — arm the bot
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </main>
  );
}

function PagerBtn({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-white/50 bg-white/40 px-2.5 py-1 text-[11px] font-medium text-slate-500 backdrop-blur-sm transition-colors hover:bg-white/70 disabled:opacity-40"
    >
      {label}
    </button>
  );
}

function MobileValue({
  label,
  value,
  tone = "flat",
}: {
  label: string;
  value: ReactNode;
  tone?: "up" | "down" | "flat";
}) {
  return (
    <div className="min-w-0 rounded-lg border border-white/40 bg-white/30 px-2.5 py-2">
      <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p
        className={cn(
          "mt-0.5 truncate text-xs font-semibold tabular-nums",
          tone === "up" ? "text-emerald-600" : tone === "down" ? "text-rose-600" : "text-slate-600",
        )}
        title={typeof value === "string" ? value : undefined}
      >
        {value}
      </p>
    </div>
  );
}
