/**
 * ui-kit — shared visual vocabulary for the trading workspace.
 *
 * Everything here stays inside the color/opacity set the index.css dark-mode
 * remap layer understands (bg-white/30-70 · border-white/40-50 · slate text ·
 * emerald / rose / sky / violet / amber accents) so both themes render the
 * same coherent look.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ── Formatters ─────────────────────────────────────────────── */

export const usd = (n: number | undefined | null, digits = 2) =>
  n == null || isNaN(n) ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: digits })}`;

export const px = (n: number | undefined | null, digits = 4) =>
  n == null || isNaN(n) ? "—" : n.toLocaleString("en-US", { maximumFractionDigits: digits });

export const signed = (n: number | undefined | null, digits = 2) => {
  if (n == null || isNaN(n)) return "—";
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: digits })}`;
};

export const signedUsd = (n: number | undefined | null, digits = 2) => {
  if (n == null || isNaN(n)) return "—";
  return `${n >= 0 ? "+" : "−"}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: digits })}`;
};

/** PHT (UTC+8) clock — every timestamp in the app renders in Manila time. */
export const pht = (ms: number | undefined | null, includeDate = true) => {
  if (!ms) return "—";
  return new Intl.DateTimeFormat("en-PH", {
    timeZone: "Asia/Manila",
    ...(includeDate ? { month: "short", day: "2-digit" } : {}),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ms));
};

export const dur = (ms: number | undefined | null) => {
  if (!(ms && ms > 0)) return "—";
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m` : `${s}s`;
};

/* ── Small primitives ───────────────────────────────────────── */

type Tone = "up" | "down" | "neutral" | "brand" | "violet" | "amber" | "warn";

const CHIP: Record<Tone, string> = {
  up: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20 shadow-emerald-500/5",
  down: "bg-rose-500/10 text-rose-600 border-rose-500/20 shadow-rose-500/5",
  neutral: "bg-slate-500/10 text-slate-600 border-slate-500/15 shadow-slate-500/5",
  brand: "bg-sky-500/10 text-sky-700 border-sky-500/20 shadow-sky-500/5",
  violet: "bg-violet-500/10 text-violet-700 border-violet-500/20 shadow-violet-500/5",
  amber: "bg-amber-500/10 text-amber-700 border-amber-500/20 shadow-amber-500/5",
  warn: "bg-rose-500/10 text-rose-600 border-rose-500/20 shadow-rose-500/5",
};

export function Chip({
  tone = "neutral",
  className,
  children,
  title,
}: {
  tone?: Tone;
  className?: string;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-[11px] font-semibold leading-relaxed tracking-tight backdrop-blur-md shadow-xs transition-colors",
        CHIP[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function SidePill({ side }: { side: string }) {
  if (side === "VETO") {
    // Batched veto-journal row (one per tick): amber "why blocked" tag.
    return (
      <span
        className={cn(
          "inline-flex w-14 justify-center items-center rounded-lg border px-1.5 py-0.5 text-[10px] font-bold tracking-wider backdrop-blur-md shadow-xs",
          "border-amber-500/30 bg-amber-500/10 text-amber-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]",
        )}
      >
        VETO
      </span>
    );
  }
  const long = side === "LONG";
  return (
    <span
      className={cn(
        "inline-flex w-14 justify-center items-center rounded-lg border px-1.5 py-0.5 text-[10px] font-bold tracking-wider backdrop-blur-md shadow-xs",
        long
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]"
          : "border-rose-500/30 bg-rose-500/10 text-rose-600 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)]",
      )}
    >
      {long ? "LONG" : "SHORT"}
    </span>
  );
}

/** Pulsing live-dot + label (bot running states). */
export function StatusPill({
  active,
  activeLabel,
  idleLabel,
  tone = "rose",
}: {
  active: boolean;
  activeLabel: string;
  idleLabel: string;
  tone?: "rose" | "emerald" | "brand";
}) {
  const dot =
    tone === "rose" ? "bg-rose-500" : tone === "emerald" ? "bg-emerald-500" : "bg-sky-500";
  const chip =
    tone === "rose"
      ? "bg-rose-100 text-rose-700"
      : tone === "emerald"
        ? "bg-emerald-100 text-emerald-700"
        : "bg-sky-100/60 text-sky-700";
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-bold", chip)}>
      <span className={cn("size-1.5 rounded-full", active ? cn(dot, "animate-pulse") : "bg-slate-300")} />
      {active ? activeLabel : idleLabel}
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone = "flat",
  icon,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "up" | "down" | "flat" | "brand";
  icon?: ReactNode;
  className?: string;
}) {
  const valueCls =
    tone === "up"
      ? "text-emerald-600"
      : tone === "down"
        ? "text-rose-600"
        : tone === "brand"
          ? "text-sky-600"
          : "text-slate-900";
  return (
    <div
      className={cn(
        "rounded-2xl border border-white/60 bg-white/45 p-3.5 backdrop-blur-xl",
        "shadow-[inset_0_1px_1px_rgba(255,255,255,0.85),0_6px_20px_-6px_rgba(15,23,42,0.06)]",
        "transition-all duration-200 hover:bg-white/55",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-1.5">
        <p className="truncate text-[10px] font-bold uppercase tracking-wider text-slate-400">{label}</p>
        {icon}
      </div>
      <p className={cn("mt-1 truncate font-mono text-xl font-bold tracking-tight tabular-nums leading-snug", valueCls)}>{value}</p>
      {sub && <p className="mt-1 truncate text-[11px] font-medium text-slate-400">{sub}</p>}
    </div>
  );
}

/** Thin horizontal meter (progress toward a level, win-rate, coverage…). */
export function Meter({
  pct,
  tone = "brand",
  className,
}: {
  pct: number;
  tone?: "up" | "down" | "brand";
  className?: string;
}) {
  const fill = tone === "up" ? "bg-emerald-400" : tone === "down" ? "bg-rose-400" : "bg-gradient-to-r from-sky-400 to-indigo-400";
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full bg-slate-100", className)}>
      <div className={cn("h-full rounded-full transition-all duration-500", fill)} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

/* ── Table helpers (kept as components so spacing stays consistent) ── */

export function Th({
  children,
  right,
  className,
}: {
  children?: ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <th
      className={cn(
        "whitespace-nowrap px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-slate-400",
        right ? "text-right" : "text-left",
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  right,
  className,
}: {
  children?: ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        "whitespace-nowrap px-2.5 py-2 text-xs text-slate-600",
        right && "text-right tabular-nums",
        className,
      )}
    >
      {children}
    </td>
  );
}

/** Frosted sticky header wrapper for scrollable tables. */
export function FrostHead({ children }: { children: ReactNode }) {
  return (
    <thead className="sticky top-0 z-10">
      <tr className="border-b border-white/70 bg-white/75 backdrop-blur-xl shadow-[inset_0_-1px_0_rgba(255,255,255,0.8),0_4px_16px_-4px_rgba(0,0,0,0.03)]">
        {children}
      </tr>
    </thead>
  );
}
