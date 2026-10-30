/**
 * Layer2TradesView — the "Trades" surface of the Layer 2 workspace.
 *
 * I/O model (2026-09): this view never subscribes to the full layer2 book.
 *   - Header stats (Balance / Return / Closed / Win Rate) come from ONE
 *     precomputed `bookStats` doc, maintained server-side on every close.
 *   - The Closed Trades table is keyset-paginated server-side (5/page) via
 *     Convex's opaque cursors over (book, status, entryTime).
 *   - Open positions stay on the small index-scoped open-only query.
 *   - Open PnL is a 5-min action poll that only runs with open positions.
 * The full book is only ever fetched by the Advanced Data tab, which mounts
 * on demand.
 */
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { GlassCard } from "@/components/GlassPanel";
import { ArchiveControls } from "@/components/ArchiveControls";
import { MiningWindowCard } from "@/components/MiningWindowCard";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { LAYER1_PAIRS } from "@/lib/tracked-pairs";
import { sessionOf } from "@/lib/trade-context";
import { toast } from "sonner";
import {
  Chip,
  FrostHead,
  Meter,
  SidePill,
  Stat,
  Th,
  Td,
  dur,
  pht,
  signedUsd,
} from "@/components/ui-kit";
import { Activity, ArrowUpRight, Brain, Clock, ListOrdered, Loader2, Square, Zap } from "lucide-react";

const START_BALANCE = 150;
const PAGE_SIZE = 5;
// Freshness bar must clear the L1 tick's ACTUAL cadence (2026-09-27): the
// layer1 tick fires every 15 min (bar-aligned, measured 192 rows/48h), so an
// 8-minute threshold flagged "data stale" for ~half of every cycle on a
// healthy engine. 17 min = cadence + 2 min processing margin — still catches
// a genuinely stalled cron (flags by ~two missed ticks) without crying wolf
// between normal fires.
const FRESH_METRICS_MAX_AGE_MS = 17 * 60_000;

// Entry-session taxonomy — the SAME five labels the engine stamps on every
// trade (sessionOf in trade-context.ts) and the breaker/Advanced Data tables
// group by, so this chip can never disagree with the session a trade opening
// right now would be tagged with.
const SESSION_LABEL: Record<string, string> = {
  asia: "Asia",
  london: "London",
  "ldn-ny": "Ldn–NY",
  ny: "NY",
  late: "Late",
};

/** UTC HH:MM — the clock the session buckets are actually cut on. */
const utcClock = (ms: number) =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(ms));

const ageLabel = (at: number | undefined, now: number) => {
  if (!at) return "not seen";
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  return minutes < 1 ? "just now" : `${minutes}m ago`;
};

const price = (value: unknown, digits = 4) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0
    ? `$${n.toLocaleString("en-US", { maximumFractionDigits: digits })}`
    : "—";
};

const delayOf = (t: any) => {
  if (t.signalTime == null) return null;
  const ms = (t.confirmedAt ?? t.entryTime) - t.signalTime;
  if (ms <= 60_000) return "0m";
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
};

export function Layer2TradesView() {
  // Scoped by book (2026-09-26): getOpenLayer2Trades returns EVERY stats
  // book's open rows so the exit resolver can close them all, which would have
  // shown the A+ book's positions in layer2's Open Positions table.
  const openTradesQuery = useQuery((api as any).paperTrading.getOpenBookTrades, { book: "layer2" });
  const statsQuery = useQuery((api as any).paperTrading.getLayer2Stats);
  const signals = useQuery((api as any).strategyEngine.getRecentSignals, { limit: 20 });
  const strategyStates = useQuery((api as any).strategyEngine.getAllStrategyStates);
  const config = useQuery((api as any).strategyEngine.getConfig);
  // ensureLayer2Stats is a MUTATION (seeds the bookStats doc) — must be called
  // through useMutation, not useAction; the wrong hook makes the call fail
  // server-side whenever the stats doc is missing.
  const ensureStats = useMutation((api as any).paperTrading.ensureLayer2Stats);
  const getOpenPnl = useAction((api as any).paperTrading.getLayer2OpenPnl);
  const closeManual = useAction(api.paperTrading.closeTradeManual);
  // Account doc = the engine's single source of truth for balance (sizing
  // risks RISK_PCT × balance). Reading it here keeps the header consistent
  // with the engine AND reflects manual refills; falls back to the derived
  // START_BALANCE + realized PnL when the doc is still seeding.
  const accountQuery = useQuery((api as any).paperTrading.getLayer2Account);
  const refill = useMutation((api as any).paperTrading.refillPaperBalance);

  // Closed-trades list: one keyset-paginated subscription for the page the
  // user is on. `cursors[k]` = cursor that fetched page k (page 0 = null).
  const [pageIdx, setPageIdx] = useState(0);
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  // Page 0 has no cursor yet — pass `cursor: null` EXPLICITLY. The deployed
  // validator is v.union(v.string(), v.null()): it accepts null but rejects a
  // MISSING field with ArgumentValidationError, so omitting the arg made the
  // very first page fail and take the whole trades tab (open + closed) down.
  const pageCursor = cursors[pageIdx] ?? null;
  const pageRes = useQuery((api as any).paperTrading.getLayer2ClosedPage, {
    cursor: pageCursor,
    limit: PAGE_SIZE,
  });
  const pageRows: any[] = pageRes?.page ?? [];
  const pageDone = pageRes ? pageRes.isDone : false;
  const pageLoading = pageRes === undefined;

  const [livePnl, setLivePnl] = useState<any>(null);
  const [closing, setClosing] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refilling, setRefilling] = useState(false);
  const [refillFlash, setRefillFlash] = useState<string | null>(null);
  const ensuredRef = useRef(false);

  const openTrades = openTradesQuery ?? [];
  const stats = statsQuery ?? null;
  const openTradesLoading = openTradesQuery === undefined;
  const signalsLoading = signals === undefined;
  // undefined = first fetch in flight; null = doc missing (seeding) — neither
  // must ever be rendered as "0 closed trades / wiped history".
  const statsReady = statsQuery !== undefined;
  const closedCount = stats?.closedCount ?? 0;
  const wins = stats?.wins ?? 0;
  const totalPnl = stats?.realizedPnl ?? 0;
  const totalFees = stats?.totalFeesUsd ?? 0;
  const winRate = closedCount > 0 ? (wins / closedCount) * 100 : 0;
  const avgPnl = closedCount > 0 ? totalPnl / closedCount : 0;
  // Balance from the account doc (engine truth, includes refills); fall back
  // to the derived value only while the doc is seeding.
  const account = accountQuery ?? null;
  const deposits = (account as any)?.deposits ?? 0;
  const balance = account?.balance != null ? account.balance : START_BALANCE + totalPnl;
  // Return = PnL only — deposits (manual refills) never inflate it.
  const ret = ((balance - START_BALANCE - deposits) / START_BALANCE) * 100;

  const handleRefill = async () => {
    if (refilling) return;
    setRefilling(true);
    try {
      const r = await refill({});
      setRefillFlash(
        r?.ok
          ? `+$${Number(r.added ?? 0).toFixed(2)} → $${Number(r.balance ?? 0).toFixed(2)}`
          : "refill failed",
      );
    } catch (e: any) {
      setRefillFlash(`failed: ${e?.message ?? "try again"}`);
    } finally {
      setRefilling(false);
      window.setTimeout(() => setRefillFlash(null), 4000);
    }
  };

  // Seed the stats doc once (idempotent, cheap when present). Until a doc
  // exists the header shows "…" — never a fake zero.
  useEffect(() => {
    if (ensuredRef.current) return;
    if (statsQuery === null) {
      ensuredRef.current = true;
      void ensureStats({}).catch(() => {
        ensuredRef.current = false; // allow one retry on the next mount tick
      });
    }
  }, [statsQuery, ensureStats]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  // Poll live PnL every 5 min when there are open positions (aligned with the
  // bot's exit-tick cadence — positions only close on that 5-min cron).
  useEffect(() => {
    const hasOpen = openTrades.length > 0;
    if (!hasOpen) {
      setLivePnl(null);
      return;
    }
    let active = true;
    const poll = async () => {
      try {
        const data = await getOpenPnl({});
        if (active) setLivePnl(data);
      } catch {}
    };
    if (!document.hidden) void poll();
    const id = setInterval(() => {
      if (!document.hidden) void poll();
    }, 300_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [openTrades.length, getOpenPnl]);

  const pnlFor = (id: string) => livePnl?.positions?.find((p: any) => p.id === id);

  const pageCount = statsReady && closedCount > 0 ? Math.max(1, Math.ceil(closedCount / PAGE_SIZE)) : null;
  // Next is driven by the actual page cursor (isDone), not the lifetime stats
  // count — after a retention prune the stored book is shorter than the
  // all-time Closed counter, and the pager must simply stop at the data end.
  const canNext = pageRes ? !pageRes.isDone : false;
  const canPrev = pageIdx > 0;
  const rangeStart = pageIdx * PAGE_SIZE + 1;
  const rangeEnd = pageIdx * PAGE_SIZE + pageRows.length;

  const goNext = () => {
    if (!pageRes || pageRes.isDone || !pageRes.continueCursor) return;
    setCursors((c) => {
      const n = [...c];
      n[pageIdx + 1] = pageRes.continueCursor;
      return n;
    });
    setPageIdx((i) => i + 1);
  };

  // Never park on a done-but-empty page (e.g. after a prune shrank the stored
  // book): if we land there, step back to the last populated page.
  useEffect(() => {
    if (pageRes?.isDone && pageRows.length === 0 && pageIdx > 0) {
      setPageIdx((i) => Math.max(0, i - 1));
    }
  }, [pageRes, pageRows.length, pageIdx]);

  const unrealized = livePnl?.totalUnrealized ?? 0;
  const latestLayer1At = strategyStates?.reduce(
    (latest: number, state: any) => Math.max(latest, Number(state?.fetchedAt ?? 0)),
    0,
  ) || undefined;
  // Rows that never opened a trade are NOT signals for the "Latest signal"
  // health readout: the batched veto journal is tagged side="VETO", and the
  // numeric decision record (logRejections, 2026-09-23) carries a REAL side
  // with `entered: false`. Filtering on the side alone — the original test —
  // therefore counted rejected candidates as fresh signals, which is exactly
  // the reading this filter exists to prevent. Gate on `entered` instead: a
  // signal is a row that actually traded.
  const latestSignalAt = signals
    ?.filter((s: any) => s?.entered === true)
    .reduce(
      (latest: number, signal: any) => Math.max(latest, Number(signal?.timestamp ?? 0)),
      0,
    ) || undefined;
  const latestTradeAt = [...openTrades, ...pageRows].reduce(
    (latest: number, trade: any) =>
      Math.max(latest, Number(trade?.exitTime ?? trade?.entryTime ?? 0)),
    0,
  ) || undefined;
  const layer1Age = latestLayer1At ? now - latestLayer1At : null;
  const layer1Fresh = layer1Age != null && layer1Age <= FRESH_METRICS_MAX_AGE_MS;

  return (
    <div className="space-y-4">
      {/* ── Engine overview ── */}
      <GlassCard>
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-2xl border border-sky-400/30 bg-gradient-to-br from-sky-400/20 via-sky-500/10 to-indigo-500/20 text-sky-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9),0_6px_16px_-4px_rgba(14,165,233,0.2)]">
              <Brain className="size-5" />
            </span>
            <div>
              <p className="text-base font-extrabold tracking-tight text-slate-900">
                Layer 2 — EMA Momentum + Order Flow
              </p>
              <p className="text-xs font-medium text-slate-400">
                EMA {config?.emaFast ?? 5}/{config?.emaSlow ?? 20} · closed 15m candles · 1h pair cooldown ·{" "}
                {config?.stopLossPct ?? 1.5}% SL · {config?.takeProfitPct ?? 3}% TP · simulated book
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Chip
              tone="violet"
              title="Current UTC-hour session — the label the engine stamps on entries (asia 00–07Z · london 07–13Z · ldn-ny 13–17Z · ny 17–22Z · late 22–24Z)"
            >
              <Clock className="size-3" /> {SESSION_LABEL[sessionOf(now)] ?? sessionOf(now)} · {utcClock(now)}Z
            </Chip>
            <Chip tone="brand">
              <Activity className="size-3" /> cron every 15m
            </Chip>
            <Chip tone="neutral">paper only</Chip>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <Stat
            label="Balance"
            value={statsReady && stats ? `$${balance.toFixed(2)}` : "…"}
            tone={balance >= START_BALANCE ? "up" : "down"}
            sub={
              <span className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleRefill}
                  disabled={refilling}
                  className="rounded-md border border-sky-300/60 bg-sky-500/10 px-1.5 py-0.5 text-[10px] font-bold text-sky-700 transition-all hover:bg-sky-500/20 disabled:opacity-50"
                >
                  {refilling ? "Refilling…" : "↻ Refill $150"}
                </button>
                <span className={cn("font-medium", refillFlash ? (refillFlash.startsWith("failed") ? "text-rose-600" : "text-emerald-600") : "text-slate-400")}>
                  {refillFlash ?? (deposits > 0 ? `${deposits.toFixed(0)} deposited` : `from $${START_BALANCE} seed`)}
                </span>
              </span>
            }
          />
          <Stat
            label="Return"
            value={statsReady && stats ? `${ret >= 0 ? "+" : ""}${ret.toFixed(1)}%` : "…"}
            tone={ret >= 0 ? "up" : "down"}
          />
          <Stat label="Open" value={openTrades.length} />
          <Stat label="Closed" value={statsReady && stats ? closedCount : "…"} />
          <Stat
            label="Win rate"
            value={statsReady && stats && closedCount > 0 ? `${winRate.toFixed(0)}%` : "—"}
            tone={winRate >= 50 ? "up" : winRate > 0 ? "down" : "flat"}
            sub={`${wins} wins`}
          />
          <Stat
            label="Realized PnL"
            value={statsReady && stats ? signedUsd(totalPnl) : "…"}
            tone={totalPnl >= 0 ? "up" : "down"}
            sub={totalFees > 0 ? `fees ${signedUsd(totalFees)}` : avgPnl !== 0 ? `avg ${signedUsd(avgPnl)}/trade` : undefined}
          />
        </div>
      </GlassCard>

      {/* ── Mining window (data-collection state + guarded re-arm) ── */}
      <MiningWindowCard />

      {/* ── Operational freshness ── */}
      <GlassCard className="border-sky-200/50 bg-sky-50/20">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex items-start gap-2.5">
            <span className={cn(
              "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-xl",
              layer1Fresh ? "bg-emerald-100 text-emerald-600" : "bg-amber-100 text-amber-600",
            )}>
              <Activity className="size-4" />
            </span>
            <div>
              <p className="text-sm font-semibold text-slate-800">Paper engine health</p>
              <p className="mt-0.5 text-[11px] text-slate-400">
                This is a frontend freshness readout from existing Layer 1, signal, and ledger data — not a claim that a cron is currently running.
              </p>
            </div>
          </div>
          <Chip tone={layer1Fresh ? "up" : latestLayer1At ? "amber" : "neutral"}>
            <span className={cn("size-1.5 rounded-full", layer1Fresh ? "bg-emerald-500" : latestLayer1At ? "bg-amber-500" : "bg-slate-300")} />
            {latestLayer1At ? (layer1Fresh ? "data fresh" : "data stale") : "waiting for data"}
          </Chip>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <HealthItem label="Layer 1 metrics" value={latestLayer1At ? ageLabel(latestLayer1At, now) : "not seen"} detail={strategyStates ? `${strategyStates.length} pairs in latest tick` : "loading…"} />
          <HealthItem label="Latest signal" value={ageLabel(latestSignalAt, now)} detail={signals ? `${signals.length} recent events` : "loading…"} />
          <HealthItem label="Visible activity" value={ageLabel(latestTradeAt, now)} detail={`${openTrades.length} open · ${closedCount} closed`} />
          <HealthItem label="Entry cadence" value="15m" detail="closed-candle scans" />
        </div>
      </GlassCard>

      {/* ── Open positions ── */}
      <GlassCard
        icon={<Zap className="size-4" />}
        title={`Open positions (${openTrades.length})`}
        subtitle="Bot exits are checked every 5 min against each position's SL / TP"
        action={
          openTrades.length > 0 && unrealized !== 0 ? (
            <Chip tone={unrealized >= 0 ? "up" : "down"}>
              unrealized {signedUsd(unrealized)}
            </Chip>
          ) : undefined
        }
        className="overflow-hidden"
      >
        {openTradesLoading ? (
          <p className="flex items-center justify-center gap-2 py-8 text-xs text-slate-400">
            <Loader2 className="size-3.5 animate-spin" /> Loading open positions…
          </p>
        ) : openTrades.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-400">
            No open positions — the bot is scanning {LAYER1_PAIRS.length} pairs every 15 minutes.
          </p>
        ) : (
          <>
          <div className="hidden overflow-x-auto rounded-2xl border border-white/60 bg-white/30 backdrop-blur-xl md:block">
            <table className="w-full min-w-[1000px] border-separate border-spacing-0">
              <FrostHead>
                <Th>Coin</Th>
                <Th>Side</Th>
                <Th right>Entry</Th>
                <Th right>Mark</Th>
                <Th right>SL</Th>
                <Th right>TP</Th>
                <Th>Fired (PHT)</Th>
                <Th>Delay</Th>
                <Th>Hold</Th>
                <Th right>Unrl. PnL</Th>
                <Th></Th>
              </FrostHead>
              <tbody>
                {openTrades.map((t: any, i: number) => {
                  const live = pnlFor(t._id);
                  const holdMs = Math.max(0, now - t.entryTime);
                  const winning = live?.winning ?? false;
                  const pnlUsd = live?.pnlUsd ?? 0;
                  const progress = live?.progressPct ?? 0;
                  return (
                    <tr key={t._id} className={cn(i % 2 === 1 && "bg-white/20", "transition-colors hover:bg-white/40")}>
                    <Td className="font-bold text-slate-900 tracking-tight">{t.coin ?? "Unknown"}</Td>
                    <Td>
                      <SidePill side={t.type ?? "SHORT"} />
                      </Td>
                      <Td right className="font-mono tabular-nums font-medium">{price(t.entryPrice)}</Td>
                      <Td right className="font-mono tabular-nums font-medium">
                        {live?.currentPrice ? price(live.currentPrice) : "—"}
                      </Td>
                      <Td right className="font-mono tabular-nums font-semibold text-rose-600">
                        {price(t.slPrice, 6)}
                        {live && <div className="text-[9px] font-medium text-slate-400">{Number(live.distToSlPct).toFixed(2)}%</div>}
                      </Td>
                      <Td right className="font-mono tabular-nums font-semibold text-emerald-600">
                        {price(t.tpPrice, 6)}
                        {live && <div className="text-[9px] font-medium text-slate-400">{Number(live.distToTpPct).toFixed(2)}%</div>}
                      </Td>
                      <Td className="text-[11px] font-mono text-slate-500">{t.signalTime ? pht(t.signalTime) : "—"}</Td>
                      <Td>
                        {(() => {
                          const d = delayOf(t);
                          return d === null ? (
                            <span className="text-slate-300">—</span>
                          ) : (
                            <Chip tone={d === "0m" ? "up" : "amber"}>{d}</Chip>
                          );
                        })()}
                      </Td>
                      <Td className="text-[11px] font-mono text-slate-500">{dur(holdMs)}</Td>
                      <Td right>
                        {live ? (
                          <div className="flex flex-col items-end gap-1">
                            <span className={cn("font-mono text-xs font-bold tabular-nums", winning ? "text-emerald-600" : "text-rose-600")}>
                              {pnlUsd >= 0 ? "+" : "−"}${Math.abs(pnlUsd).toFixed(2)}
                            </span>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[9px] font-medium text-slate-400">→TP</span>
                              <Meter pct={progress} tone={winning ? "up" : "brand"} className="w-16" />
                            </div>
                          </div>
                        ) : (
                          "—"
                        )}
                      </Td>
                      <Td className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7.5 rounded-xl border border-rose-300/60 bg-rose-50/70 px-3 text-xs font-semibold text-rose-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.8)] backdrop-blur-md hover:bg-rose-100/90 transition-all"
                          disabled={closing === t._id}
                          onClick={async () => {
                            setClosing(t._id);
                            try {
                              await closeManual({ tradeId: t._id });
                              toast.success(`${t.coin} close requested`, {
                                description: "The paper ledger will update when the close is applied.",
                              });
                            } catch (e: any) {
                              toast.error("Paper close failed", {
                                description: e?.message ?? "Unable to close this position.",
                              });
                            } finally {
                              setClosing(null);
                            }
                          }}
                        >
                          {closing === t._id ? <Loader2 className="size-3 animate-spin mr-1" /> : <Square className="size-3 mr-1" />}
                          Close
                        </Button>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="space-y-2.5 md:hidden">
            {openTrades.map((t: any) => {
              const live = pnlFor(t._id);
              const pnlUsd = Number(live?.pnlUsd ?? 0);
              return (
                <div key={t._id} className="rounded-2xl border border-white/60 bg-white/45 p-4 shadow-[inset_0_1px_1px_rgba(255,255,255,0.9),0_6px_20px_-6px_rgba(15,23,42,0.06)] backdrop-blur-xl">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-slate-900 tracking-tight">{t.coin ?? "Unknown"}</span>
                      <SidePill side={t.type ?? "SHORT"} />
                    </div>
                    <span className={cn("font-mono text-sm font-bold tabular-nums", pnlUsd >= 0 ? "text-emerald-600" : "text-rose-600")}>
                      {live ? signedUsd(pnlUsd) : "—"}
                    </span>
                  </div>
                  <div className="mt-3.5 grid grid-cols-2 gap-2 text-xs">
                    <MobileValue label="Entry" value={price(t.entryPrice)} />
                    <MobileValue label="Mark" value={live?.currentPrice ? price(live.currentPrice) : "—"} />
                    <MobileValue label="Stop loss" value={price(t.slPrice, 6)} tone="down" />
                    <MobileValue label="Take profit" value={price(t.tpPrice, 6)} tone="up" />
                    <MobileValue label="Held" value={t.entryTime ? dur(Math.max(0, now - t.entryTime)) : "—"} />
                    <MobileValue label="Progress" value={live ? `${Number(live.progressPct ?? 0).toFixed(0)}% → TP` : "—"} />
                  </div>
                  <div className="mt-3.5 flex items-center justify-end border-t border-white/40 pt-2.5">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7.5 rounded-xl border border-rose-300/60 bg-rose-50/70 px-3 text-xs font-semibold text-rose-600 shadow-[inset_0_1px_1px_rgba(255,255,255,0.8)] backdrop-blur-md hover:bg-rose-100/90 transition-all"
                      disabled={closing === t._id}
                      onClick={async () => {
                        setClosing(t._id);
                        try {
                          await closeManual({ tradeId: t._id });
                          toast.success(`${t.coin ?? "Position"} close requested`);
                        } catch (e: any) {
                          toast.error("Paper close failed", { description: e?.message ?? "Unable to close this position." });
                        } finally {
                          setClosing(null);
                        }
                      }}
                    >
                      {closing === t._id ? <Loader2 className="size-3 animate-spin mr-1" /> : <Square className="size-3 mr-1" />}
                      Close
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          </>
        )}
      </GlassCard>

      {/* ── Closed trades (server-paginated) ── */}
      <GlassCard
        icon={<ListOrdered className="size-4" />}
        title={`Closed trades (${statsReady && stats ? closedCount : "…"})`}
        subtitle={totalPnl !== 0 ? `realized ${signedUsd(totalPnl)}${totalFees > 0 ? ` · est. fees ${signedUsd(totalFees)}` : ""}` : undefined}
        action={
          <div className="flex flex-wrap items-center justify-end gap-2">
            {(pageCount != null || pageRows.length > 0) && (
              <span className="text-[10px] text-slate-400">
                {pageRows.length > 0 ? `${rangeStart}–${rangeEnd}` : "—"} of {statsReady && stats ? closedCount : "…"}
              </span>
            )}
            <ArchiveControls
              book="paper"
              onPruned={() => {
                // Pruned rows are gone from the store — restart the pager so
                // the list reflects the retained window immediately.
                setPageIdx(0);
                setCursors([null]);
              }}
            />
          </div>
        }
      >
        {statsQuery === undefined || (pageLoading && pageRows.length === 0) ? (
          <p className="flex w-full items-center justify-center gap-2 py-10 text-xs text-slate-400">
            <Loader2 className="size-3.5 animate-spin" /> Loading closed history…
          </p>
        ) : pageRows.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-400">No closed trades yet.</p>
        ) : (
          <>
            <div className="hidden max-h-[28rem] overflow-x-auto overflow-y-auto rounded-xl border border-white/30 md:block">
              <table className="w-full min-w-[1080px] border-separate border-spacing-0">
                <FrostHead>
                  <Th>Coin</Th>
                  <Th>Side</Th>
                  <Th right>Entry</Th>
                  <Th right>Exit</Th>
                  <Th>Exit</Th>
                  <Th right>R</Th>
                  <Th right>PnL</Th>
                  <Th right>Fees</Th>
                  <Th right>MFE</Th>
                  <Th right>Bars</Th>
                  <Th>Score</Th>
                  <Th>Session</Th>
                  <Th>Closed (PHT)</Th>
                </FrostHead>
                <tbody>
                  {pageRows.map((t: any, i: number) => {
                    const r = Number(t.realizedR ?? 0);
                    const pnlUsd = Number(t.pnlUsd ?? 0);
                    const isWin = Number.isFinite(pnlUsd) && pnlUsd > 0;
                    return (
                      <tr key={t._id} className={cn(i % 2 === 1 && "bg-white/15", "transition-colors hover:bg-white/30")}>
                        <Td className="font-semibold text-slate-700">{t.coin}</Td>
                        <Td>
                          <SidePill side={t.type} />
                        </Td>
                        <Td right>{price(t.entryPrice)}</Td>
                        <Td right>{price(t.exitPrice)}</Td>
                        <Td>
                          <Chip
                            tone={
                              (t.reason ?? "").includes("Take Profit") ||
                              (t.reason ?? "").includes("Trail Lock") ||
                              (t.reason ?? "").includes("R-Lock Max")
                                ? "up"
                                : (t.reason ?? "").includes("Stop Loss")
                                  ? "down"
                                  : "neutral"
                            }
                          >
                            {t.reason ?? "—"}
                          </Chip>
                        </Td>
                        <Td right className={cn("font-semibold", isWin ? "text-emerald-600" : "text-red-500")}>
                          {r >= 0 ? "+" : ""}
                          {r.toFixed(1)}R
                        </Td>
                        <Td right className={cn("font-semibold", isWin ? "text-emerald-600" : "text-red-500")}>
                          {signedUsd(pnlUsd)}
                        </Td>
                        <Td right className="text-[11px] text-slate-500">
                          {t.totalFeesUsd != null ? `$${Number(t.totalFeesUsd).toFixed(2)}` : "—"}
                        </Td>
                        <Td right>
                          {t.mfeR != null ? <span className="text-emerald-600">{Number(t.mfeR).toFixed(1)}R</span> : "—"}
                        </Td>
                        <Td right className="text-[11px] text-slate-500">
                          {t.barsHeld != null ? `${t.barsHeld}b` : "—"}
                        </Td>
                        <Td className="text-[11px] text-slate-400">
                          {t.longScore != null && t.shortScore != null
                            ? `L:${Number(t.longScore).toFixed(0)} S:${Number(t.shortScore).toFixed(0)}`
                            : "—"}
                        </Td>
                        <Td>
                          {t.session ? <Chip tone="brand">{t.session}</Chip> : "—"}
                        </Td>
                        <Td className="text-[11px] text-slate-500">{t.exitTime ? pht(t.exitTime) : "—"}</Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="space-y-2 md:hidden">
              {pageRows.map((t: any) => {
                const pnlUsd = Number(t.pnlUsd ?? 0);
                const isWin = pnlUsd > 0;
                return (
                  <div key={t._id} className="rounded-xl border border-white/50 bg-white/35 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-slate-700">{t.coin ?? "Unknown"}</span>
                        <SidePill side={t.type ?? "SHORT"} />
                      </div>
                      <span className={cn("text-sm font-bold tabular-nums", isWin ? "text-emerald-600" : "text-rose-600")}>
                        {signedUsd(pnlUsd)}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <MobileValue label="Entry" value={price(t.entryPrice)} />
                      <MobileValue label="Exit" value={price(t.exitPrice)} />
                      <MobileValue label="Result" value={t.reason ?? "—"} />
                      <MobileValue label="R multiple" value={t.realizedR != null ? `${Number(t.realizedR) >= 0 ? "+" : ""}${Number(t.realizedR).toFixed(1)}R` : "—"} tone={isWin ? "up" : "down"} />
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-white/40 pt-2 text-[10px] text-slate-400">
                      {t.session && <Chip tone="brand">{t.session}</Chip>}
                      <span>closed {t.exitTime ? pht(t.exitTime) : "—"}</span>
                    </div>
                  </div>
                );
              })}
            </div>
            {(pageCount != null ? pageCount > 1 : pageRows.length >= PAGE_SIZE) && (
              <div className="mt-3 flex items-center justify-center gap-1.5">
                <PagerBtn onClick={() => setPageIdx(0)} disabled={!canPrev} label="«" />
                <PagerBtn onClick={() => setPageIdx((i) => Math.max(0, i - 1))} disabled={!canPrev} label="‹ Prev" />
                <span className="px-2 text-[11px] font-medium text-slate-500 tabular-nums">
                  {pageCount ? `${pageIdx + 1} / ${pageCount}` : `page ${pageIdx + 1}`}
                </span>
                <PagerBtn onClick={goNext} disabled={!canNext} label="Next ›" />
                <PagerBtn
                  onClick={() => pageCount && setPageIdx(Math.max(0, pageCount - 1))}
                  disabled={!pageCount || pageIdx >= pageCount - 1}
                  label="»"
                />
              </div>
            )}
          </>
        )}
      </GlassCard>

      {/* ── Recent signals ── */}
      <GlassCard
        icon={<Activity className="size-4" />}
        title={`Recent signals (${signalsLoading ? "…" : signals?.length ?? 0})`}
        subtitle="Every 15m strategy scan logs a row per qualified pair — entered vs blocked"
        action={<Chip tone="violet">L / S scores</Chip>}
      >
        {signalsLoading ? (
          <p className="flex items-center justify-center gap-2 py-8 text-xs text-slate-400">
            <Loader2 className="size-3.5 animate-spin" /> Loading signals…
          </p>
        ) : !signals || signals.length === 0 ? (
          <p className="py-8 text-center text-xs text-slate-400">
            No signals logged yet — first Layer 2 tick will populate this.
          </p>
        ) : (
          <div className="overflow-x-auto max-h-72 overflow-y-auto rounded-xl border border-white/30">
            <table className="w-full min-w-[640px] border-separate border-spacing-0">
              <FrostHead>
                <Th>Pair</Th>
                <Th>Side</Th>
                <Th right>Price</Th>
                <Th right>Long</Th>
                <Th right>Short</Th>
                <Th>Entered</Th>
                <Th>Signal (PHT)</Th>
                <Th>Context</Th>
              </FrostHead>
              <tbody>
                {signals.map((s: any, i: number) => (
                  <tr key={s._id} className={cn(i % 2 === 1 && "bg-white/15", "transition-colors hover:bg-white/30")}>
                    <Td className="font-semibold text-slate-700">{s.pair ?? "Unknown"}</Td>
                    <Td>{s.side ? <SidePill side={s.side} /> : "—"}</Td>
                    <Td right>{price(s.entryPrice)}</Td>
                    <Td right className="tabular-nums text-emerald-600">{Number(s.longScore).toFixed(0)}</Td>
                    <Td right className="tabular-nums text-red-500">{Number(s.shortScore).toFixed(0)}</Td>
                    <Td>
                      {s.entered ? (
                        <Chip tone="up">
                          <ArrowUpRight className="size-2.5" /> YES
                        </Chip>
                      ) : (
                        <Chip tone="neutral">NO</Chip>
                      )}
                    </Td>
                    <Td className="text-[11px] text-slate-500">{pht(s.timestamp)}</Td>
                    <Td className="max-w-[240px] truncate text-[11px] text-slate-400">
                      {s.side === "VETO"
                        ? (s.blockers ?? []).join(" | ") || "—"
                        : (s.reasons ?? []).length > 0
                          ? (s.reasons ?? []).join(", ")
                          : (s.blockers ?? []).length > 0
                            ? (s.blockers ?? []).join(", ")
                            : "—"}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </GlassCard>
    </div>
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

function HealthItem({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-xl border border-white/50 bg-white/35 px-3 py-2.5">
      <p className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{label}</p>
      <p className="mt-0.5 text-xs font-bold text-slate-700">{value}</p>
      <p className="mt-0.5 truncate text-[10px] text-slate-400">{detail}</p>
    </div>
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
