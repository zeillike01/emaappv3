/**
 * DisplacementBoard — the Market Structure Shift rule, measured and live.
 *
 * TWO HALVES, deliberately:
 *   1. WHAT THE BACKTEST SAID. The rule was built and tested (2026-09-22) and it
 *      does NOT clear the promotion bar. Those numbers live in
 *      src/lib/displacement-results.ts, pasted from `bun run backtest:displacement`
 *      — the board renders the record rather than re-deriving anything.
 *   2. WHAT THE MARKET IS DOING. A read-only scan (convex/displacementScan) shows
 *      the exact state the rule describes, per pair: the EMA break, the HL/LH,
 *      the level the leg must close through, how far the leg has actually run in
 *      ATR, and the 4H verdict.
 *
 * The rule ships OFF: nothing in the engine imports it. The board exists so the
 * operator can watch structure with the rule's eyes, and so the negative result
 * stays visible instead of becoming folklore.
 */
import { useState } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { GlassCard, GlassPanel } from "@/components/GlassPanel";
import { Chip, FrostHead, SidePill, Stat, Td, Th, pht } from "@/components/ui-kit";
import { DISPLACEMENT_BACKTEST } from "@/lib/displacement-results";
import { DISPLACEMENT_DEFAULTS } from "@/lib/displacement";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import {
  Activity,
  Check,
  FlaskConical,
  Loader2,
  Minus,
  PlayCircle,
  Radar,
  ShieldX,
  Target,
  X,
} from "lucide-react";

type SideState = {
  side: "LONG" | "SHORT";
  breakActive: boolean;
  breakIndex: number;
  breakTime: number;
  structureFormed: boolean;
  structurePrice: number | null;
  structureIndex: number;
  breakLevel: number | null;
  broken: boolean;
  currentAtr: number | null;
  requiredAtr: number;
  displaced: boolean;
  htfAllowed: boolean;
  htfLabel: string;
  armed: boolean;
};

type BoardRow = {
  pair: string;
  error?: string;
  ema15m?: number | null;
  ema4h?: number | null;
  atr?: number | null;
  price15m?: number | null;
  price4h?: number | null;
  lastBarTime?: number;
  long?: SideState;
  short?: SideState;
  lastSignal?: {
    side: "LONG" | "SHORT";
    time: number;
    displacementAtr: number;
    barsToBreak: number;
  } | null;
};

const num = (n: number | null | undefined, d = 2) =>
  n == null || !Number.isFinite(n) ? "—" : n.toFixed(d);

/** A tiny state dot: satisfied / pending / not-applicable. */
function Dot({ state, title }: { state: "on" | "off" | "na"; title: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        state === "on" ? "bg-emerald-500 shadow-[0_0_0_2px_rgba(16,185,129,0.16)]" : state === "off" ? "bg-slate-300" : "bg-slate-200/70",
      )}
    />
  );
}

/** One side's structure state, compact enough for a table cell. */
function SideCell({
  s,
  kAtr,
}: {
  s: SideState | undefined;
  kAtr: number;
}) {
  if (!s) return <Td>—</Td>;
  const amp = s.currentAtr;
  const ampTone = amp == null ? "text-slate-400" : amp >= kAtr ? "text-emerald-600" : "text-slate-500";
  return (
    <Td>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2.5">
          <span className="flex items-center gap-1" title="15m close broke the entry EMA">
            <Dot state={s.breakActive ? "on" : "off"} title="EMA break active" />
            <span className={cn("text-[10px] font-semibold", s.breakActive ? "text-slate-700" : "text-slate-400")}>brk</span>
          </span>
          <span className="flex items-center gap-1" title="Higher Low (LONG) / Lower High (SHORT) confirmed">
            <Dot state={s.structureFormed ? "on" : "off"} title="Structure pivot confirmed" />
            <span className={cn("text-[10px] font-semibold", s.structureFormed ? "text-slate-700" : "text-slate-400")}>
              {s.side === "LONG" ? "HL" : "LH"}
            </span>
          </span>
          <span className="flex items-center gap-1" title="Leg closed through the prior opposite pivot">
            <Dot state={s.broken ? "on" : "off"} title="Structure break (close through the level)" />
            <span className={cn("text-[10px] font-semibold", s.broken ? "text-slate-700" : "text-slate-400")}>shift</span>
          </span>
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px] tabular-nums">
          <span className={cn("font-bold", ampTone)} title="Leg amplitude in ATR(14) vs the required k">
            {num(amp, 2)}×<span className="text-slate-400">/{kAtr}</span>
          </span>
          <span className="text-slate-400" title="The level the leg must close through">
            {s.structureFormed ? `lv ${num(s.breakLevel, 4)}` : "no level"}
          </span>
        </div>
      </div>
    </Td>
  );
}

export function DisplacementBoard() {
  const scanBoard = useAction((api as any).displacementScan.scanBoard);
  const [kAtr, setKAtr] = useState<number>(DISPLACEMENT_DEFAULTS.kAtr);
  const [rows, setRows] = useState<BoardRow[] | null>(null);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    try {
      const res = await scanBoard({ kAtr });
      setRows((res?.rows ?? []) as BoardRow[]);
      setScannedAt(res?.scannedAt ?? Date.now());
      toast.success(`Scanned ${res?.pairs ?? 0} pairs`);
    } catch (e: any) {
      toast.error(e?.message ?? "Displacement scan failed");
    } finally {
      setBusy(false);
    }
  }

  const armed = (rows ?? []).filter((r) => r.long?.armed || r.short?.armed);
  const broken = (rows ?? []).filter((r) => !r.error && (r.long?.broken || r.short?.broken));

  return (
    <div className="space-y-4">
      {/* ── The rule, stated once ── */}
      <GlassCard
        icon={<Target className="size-4" />}
        title="Displacement test — EMA 50 break + Market Structure Shift (15m), 4H filter"
        subtitle="One condition added at the point the Higher Low / Lower High is confirmed"
        action={
          <Chip tone="warn" title="Measured 2026-09-22 · did not clear the promotion bar">
            <ShieldX className="size-3" /> measured · not armed
          </Chip>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/[0.06] p-3.5 backdrop-blur-xl">
            <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-700">Long</p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              15m close breaks above the EMA 50 → a Higher Low forms → the leg off that HL must{" "}
              <span className="font-semibold text-slate-800">close above the most recent swing high</span> and span{" "}
              <span className="font-semibold text-slate-800">≥ k × ATR(14)</span>. 4H must be above its EMA 75.
            </p>
          </div>
          <div className="rounded-2xl border border-rose-500/20 bg-rose-500/[0.05] p-3.5 backdrop-blur-xl">
            <p className="text-[10px] font-bold uppercase tracking-wider text-rose-600">Short</p>
            <p className="mt-1.5 text-xs leading-relaxed text-slate-600">
              Mirror: close below the EMA 50 → a Lower High forms → the leg must{" "}
              <span className="font-semibold text-slate-800">close below the most recent swing low</span> and span{" "}
              <span className="font-semibold text-slate-800">≥ k × ATR(14)</span>. 4H must be below its EMA 75.
            </p>
          </div>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
          The EMA break, the HL/LH and the "no retest needed" rule are unchanged — the displacement is the only
          addition. Everything below is the measured record; nothing in the engine trades this core.
        </p>
      </GlassCard>

      {/* ── The verdict ── */}
      <GlassCard
        icon={<FlaskConical className="size-4" />}
        title="Backtest verdict"
        subtitle={`${DISPLACEMENT_BACKTEST.window} · ${DISPLACEMENT_BACKTEST.universe} · ${DISPLACEMENT_BACKTEST.exit}`}
        action={
          <Chip tone="warn">
            <X className="size-3" /> does not clear the bar
          </Chip>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Anchor (as shipped)" value={`${num(DISPLACEMENT_BACKTEST.anchor.netPerT, 3)} R/t`} sub={`${DISPLACEMENT_BACKTEST.anchor.trades.toLocaleString()} trades`} />
          <Stat label="PRIMARY · break, k = 1.0" value={`${num(DISPLACEMENT_BACKTEST.arms[0].netPerT, 3)} R/t`} tone="down" sub={`${DISPLACEMENT_BACKTEST.arms[0].trades.toLocaleString()} trades · Δ ${num(DISPLACEMENT_BACKTEST.arms[0].deltaNetPerT, 3)}`} />
          <Stat label="Paired-day t" value={num(DISPLACEMENT_BACKTEST.arms[0].t, 2)} tone="down" sub="promotion bar: |t| ≥ 2" />
          <Stat label="Target cohort deleted" value={`${num(DISPLACEMENT_BACKTEST.neverDisplacedShare, 1)}%`} sub="of anchor trades never displaced" />
        </div>

        <p className="mt-4 rounded-2xl border border-amber-500/25 bg-amber-500/[0.07] p-3.5 text-xs leading-relaxed text-slate-700">
          <span className="font-semibold">{DISPLACEMENT_BACKTEST.verdict.headline}</span>
        </p>

        <ul className="mt-3 space-y-1.5">
          {DISPLACEMENT_BACKTEST.verdict.detail.map((d, i) => (
            <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-slate-500">
              <span className="mt-1.5 size-1 shrink-0 rounded-full bg-slate-300" />
              <span>{d}</span>
            </li>
          ))}
        </ul>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          {/* Bands */}
          <div className="min-w-0">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              The anchor's own trades, by how far their setup displaced
            </p>
            <div className="overflow-x-auto rounded-2xl border border-white/60 bg-white/35 backdrop-blur-xl">
              <table className="w-full min-w-[420px]">
                <FrostHead>
                  <Th>Setup</Th>
                  <Th right>Trades</Th>
                  <Th right>Win</Th>
                  <Th right>Net R</Th>
                  <Th right>R / trade</Th>
                </FrostHead>
                <tbody>
                  {DISPLACEMENT_BACKTEST.bands.map((b) => {
                    const bad = b.netPerT < 0;
                    return (
                      <tr key={b.label} className="border-b border-white/40 last:border-0">
                        <Td className="font-medium text-slate-700">
                          <span className={cn(b.label === "never displaced" && "font-bold text-rose-600")}>{b.label}</span>
                        </Td>
                        <Td right>{b.trades.toLocaleString()}</Td>
                        <Td right>{num(b.winRate, 1)}%</Td>
                        <Td right className={bad ? "text-rose-600" : "text-emerald-600"}>{num(b.netR, 1)}</Td>
                        <Td right className={cn("font-semibold", bad ? "text-rose-600" : "text-emerald-600")}>
                          {num(b.netPerT, 3)}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[10px] leading-relaxed text-slate-400">
              The rule is pointed at exactly the losing cohort — and that is not enough, because the two entry
              timings pay for it differently (right).
            </p>
          </div>

          {/* Autopsy */}
          <div className="min-w-0">
            <p className="mb-2 text-[11px] font-bold uppercase tracking-wider text-slate-400">
              Why: selection vs entry price
            </p>
            <div className="space-y-2.5">
              {DISPLACEMENT_BACKTEST.autopsy.map((a) => (
                <GlassPanel key={a.label} className="p-3.5">
                  <p className="text-[11px] font-bold text-slate-700">{a.label}</p>
                  <div className="mt-2 space-y-1.5 font-mono text-[11px] tabular-nums">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">kept {a.kept.trades.toLocaleString()}t</span>
                      <span className="text-slate-400">
                        {num(a.kept.anchorNetPerT, 3)} → <span className={a.kept.armNetPerT >= 0 ? "text-emerald-600" : "text-rose-600"}>{num(a.kept.armNetPerT, 3)}</span>
                      </span>
                      <span className={cn("font-semibold", a.kept.timingCost < -0.05 ? "text-rose-600" : "text-emerald-600")}>
                        {a.kept.timingCost === 0 ? "no timing cost" : `${num(a.kept.timingCost, 3)} R/t`}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">dropped {a.dropped.trades.toLocaleString()}t</span>
                      <span className={a.dropped.anchorNetPerT >= 0 ? "text-emerald-600" : "text-rose-600"}>
                        anchor {num(a.dropped.anchorNetPerT, 3)} R/t
                      </span>
                      <span className="text-slate-400">selection</span>
                    </div>
                  </div>
                </GlassPanel>
              ))}
            </div>
          </div>
        </div>

        {/* All arms */}
        <details className="mt-5 group">
          <summary className="cursor-pointer list-none text-[11px] font-bold uppercase tracking-wider text-slate-400 hover:text-slate-600">
            All {DISPLACEMENT_BACKTEST.arms.length} measured arms
          </summary>
          <div className="mt-2 overflow-x-auto rounded-2xl border border-white/60 bg-white/35 backdrop-blur-xl">
            <table className="w-full min-w-[560px]">
              <FrostHead>
                <Th>Arm</Th>
                <Th right>Trades</Th>
                <Th right>Win</Th>
                <Th right>Net R</Th>
                <Th right>R / trade</Th>
                <Th right>Δ R / trade</Th>
                <Th right>t</Th>
              </FrostHead>
              <tbody>
                {DISPLACEMENT_BACKTEST.arms.map((a) => (
                  <tr key={a.label} className="border-b border-white/40 last:border-0">
                    <Td className="font-medium text-slate-700">{a.label}</Td>
                    <Td right>{a.trades.toLocaleString()}</Td>
                    <Td right>{num(a.winRate, 1)}%</Td>
                    <Td right>{num(a.netR, 1)}</Td>
                    <Td right className={a.netPerT >= 0 ? "text-emerald-600" : "text-rose-600"}>{num(a.netPerT, 3)}</Td>
                    <Td right className={a.deltaNetPerT >= 0 ? "text-emerald-600" : "text-rose-600"}>{num(a.deltaNetPerT, 3)}</Td>
                    <Td right>{num(a.t, 2)}</Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-[10px] text-slate-400">
            Recorded {DISPLACEMENT_BACKTEST.ranAt} from <code className="rounded bg-white/60 px-1">bun run backtest:displacement</code>.
            Re-run the lab and update <code className="rounded bg-white/60 px-1">src/lib/displacement-results.ts</code> together.
          </p>
        </details>
      </GlassCard>

      {/* ── Live board ── */}
      <GlassCard
        icon={<Radar className="size-4" />}
        title="Live structure board"
        subtitle="Read-only: the same pure readout the scanner and the lab use, on freshly fetched closed candles"
        action={
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              k (ATR)
              <Input
                type="number"
                step="0.25"
                min="0"
                value={kAtr}
                onChange={(e) => setKAtr(Math.max(0, Number(e.target.value) || 0))}
                className="h-8 w-16 rounded-xl border-white/70 bg-white/70 px-2 text-xs font-mono"
              />
            </label>
            <Button size="sm" onClick={run} disabled={busy} className="rounded-xl">
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <PlayCircle className="size-3.5" />}
              {busy ? "Scanning" : "Run scan"}
            </Button>
          </div>
        }
      >
        {rows === null ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-white/60 bg-white/30 py-10 text-center backdrop-blur-xl">
            <Activity className="size-5 text-slate-300" />
            <p className="text-xs font-medium text-slate-500">No scan yet</p>
            <p className="max-w-md text-[11px] text-slate-400">
              Runs one pass across the tracked universe and reports the state the rule describes for each side.
              Nothing is written to the database and no orders are involved.
            </p>
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-4">
              <Stat label="Pairs scanned" value={rows.length} sub={scannedAt ? pht(scannedAt) : ""} />
              <Stat label="Structure break" value={broken.length} sub="level closed through" tone={broken.length ? "brand" : "flat"} />
              <Stat
                label="Armed now"
                value={armed.length}
                tone={armed.length ? "up" : "flat"}
                sub={armed.length ? armed.map((r) => r.pair).join(", ") : "no side meets every rule"}
              />
              <Stat label="k required" value={`${kAtr} × ATR(14)`} sub="the one knob" />
            </div>

            <div className="mt-4 max-h-[560px] overflow-auto rounded-2xl border border-white/60 bg-white/35 backdrop-blur-xl">
              <table className="w-full min-w-[900px]">
                <FrostHead>
                  <Th>Pair</Th>
                  <Th right>15m · price / EMA 50</Th>
                  <Th right>4H · price / EMA 75</Th>
                  <Th>Long structure</Th>
                  <Th>Short structure</Th>
                  <Th>4H filter</Th>
                  <Th right>Signal</Th>
                </FrostHead>
                <tbody>
                  {rows.map((r) => {
                    const htfLong = r.long?.htfAllowed;
                    const htfShort = r.short?.htfAllowed;
                    return (
                      <tr key={r.pair} className="border-b border-white/40 last:border-0 hover:bg-white/40">
                        <Td className="font-semibold text-slate-800">
                          {r.pair}
                          {r.error && <span className="ml-2 text-[10px] font-normal text-rose-500">{r.error}</span>}
                        </Td>
                        <Td right className="font-mono">
                          {r.price15m != null && r.ema15m != null ? (
                            <span className={r.price15m > r.ema15m ? "text-emerald-600" : "text-rose-600"}>
                              {num(r.price15m, 4)} <span className="text-slate-400">/ {num(r.ema15m, 4)}</span>
                            </span>
                          ) : (
                            "—"
                          )}
                        </Td>
                        <Td right className="font-mono">
                          {r.price4h != null && r.ema4h != null ? (
                            <span className={r.price4h > r.ema4h ? "text-emerald-600" : "text-rose-600"}>
                              {num(r.price4h, 4)} <span className="text-slate-400">/ {num(r.ema4h, 4)}</span>
                            </span>
                          ) : (
                            "—"
                          )}
                        </Td>
                        <SideCell s={r.long} kAtr={kAtr} />
                        <SideCell s={r.short} kAtr={kAtr} />
                        <Td>
                          <div className="flex items-center gap-1.5">
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold",
                                htfLong
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600"
                                  : "border-slate-400/20 bg-slate-500/5 text-slate-400 line-through",
                              )}
                              title={r.long?.htfLabel}
                            >
                              {htfLong ? <Check className="size-2.5" /> : <Minus className="size-2.5" />}L
                            </span>
                            <span
                              className={cn(
                                "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold",
                                htfShort
                                  ? "border-rose-500/30 bg-rose-500/10 text-rose-600"
                                  : "border-slate-400/20 bg-slate-500/5 text-slate-400 line-through",
                              )}
                              title={r.short?.htfLabel}
                            >
                              {htfShort ? <Check className="size-2.5" /> : <Minus className="size-2.5" />}S
                            </span>
                          </div>
                        </Td>
                        <Td right>
                          {r.long?.armed || r.short?.armed ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="relative flex size-2">
                                <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                                <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                              </span>
                              <SidePill side={r.long?.armed ? "LONG" : "SHORT"} />
                            </span>
                          ) : r.lastSignal ? (
                            <span className="text-[10px] text-slate-400">
                              last {r.lastSignal.side === "LONG" ? "L" : "S"} {num(r.lastSignal.displacementAtr, 1)}×
                              <span className="text-slate-300"> · {pht(r.lastSignal.time, false)}</span>
                            </span>
                          ) : (
                            <span className="text-[10px] text-slate-300">none</span>
                          )}
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <p className="mt-3 text-[10px] leading-relaxed text-slate-400">
              15m EMA 50 and 4H EMA 75 read on the newest CLOSED candle of each series. "brk" = the 15m close broke
              through the entry EMA and has not crossed back. "HL/LH" = the structure pivot is confirmed (pivot ±
              {DISPLACEMENT_DEFAULTS.pivotLookback} bars). "shift" = the leg has closed through the prior opposite pivot.
              The ratio is the leg's amplitude in ATR({DISPLACEMENT_DEFAULTS.atrPeriod}) against k. "Armed" means every
              rule is satisfied on the last closed bar — it is a description of the setup, not a trade instruction,
              because this core is not armed in the engine.
            </p>
          </>
        )}
      </GlassCard>
    </div>
  );
}

export default DisplacementBoard;
