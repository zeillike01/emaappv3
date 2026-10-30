import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Chip } from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import {
  HEARTBEAT_JOBS,
  formatHeartbeatAge,
  formatHeartbeatDuration,
  heartbeatStatus,
} from "@/lib/heartbeat";
import { Activity, AlertTriangle } from "lucide-react";

/**
 * ENGINE HEARTBEAT — "is the clock still ticking?", one row per cron.
 *
 * Every gate in this stack fails OPEN on missing input (a stale advisor doc
 * stops vetoing, a missing BTC read leaves the regime gate inactive, the 4H
 * EMA75 gate treats no-data as no-objection), so a stalled cron does not raise
 * an error anywhere — it just silently stops protecting the book. This is the
 * readout that makes that visible: the age of each tick's last START, and a
 * STALE badge once the silence is longer than the job's own cadence can explain.
 *
 * The job list, cadences and thresholds come from src/lib/heartbeat.ts, so this
 * component never has to know how a job is scheduled — it only decides how the
 * verdict looks. A job with no row yet reads "never", which is deliberately not
 * the same as "ok": a cron that has never fired is an older problem than one
 * that stopped.
 */
type HeartbeatRow = {
  job: string;
  lastRunAt: number;
  runs: number;
  /** Wall-clock of the last completed run; null/absent for jobs that don't stamp it. */
  lastDurationMs?: number | null;
};

export function EngineHeartbeat({ className }: { className?: string }) {
  const rows = useQuery(api.heartbeat.list) as HeartbeatRow[] | undefined;

  // Ages have to advance on their own: the query only re-renders when a
  // heartbeat is written, and the whole point is spotting the case where
  // nothing is written. 15s keeps the display honest without churn.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const byJob = new Map((rows ?? []).map((r) => [r.job, r]));
  const stale = HEARTBEAT_JOBS.filter(
    (j) => heartbeatStatus(byJob.get(j.job)?.lastRunAt, j.job, now) === "stale",
  );
  // "never" must be counted separately, not folded into the healthy side: a
  // job whose cron was never registered (or was silently dropped) reads as
  // "never" forever, and summarising that as "all jobs live" is the one way
  // this panel could lie in exactly the direction it exists to catch.
  const never = HEARTBEAT_JOBS.filter(
    (j) => heartbeatStatus(byJob.get(j.job)?.lastRunAt, j.job, now) === "never",
  );

  return (
    <div className={cn("mt-3", className)}>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">
          <Activity className="size-3" />
          Cron heartbeat
        </span>
        {rows === undefined ? (
          <Chip tone="neutral" className="font-mono text-[10px]">
            loading…
          </Chip>
        ) : stale.length > 0 ? (
          <Chip tone="warn" className="font-mono text-[10px]">
            {stale.length} of {HEARTBEAT_JOBS.length} stale
          </Chip>
        ) : never.length > 0 ? (
          <Chip tone="amber" className="font-mono text-[10px]">
            {never.length} never run
          </Chip>
        ) : (
          <Chip tone="up" className="font-mono text-[10px]">
            all {HEARTBEAT_JOBS.length} jobs live
          </Chip>
        )}
        <span className="ml-auto hidden text-[10px] text-slate-400 sm:block">
          Stamps land before each tick runs — a stalled cron keeps the book armed
        </span>
      </div>

      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {HEARTBEAT_JOBS.map((job) => {
          const row = byJob.get(job.job);
          const status = heartbeatStatus(row?.lastRunAt, job.job, now);
          const age = row ? formatHeartbeatAge(now - row.lastRunAt) : "—";
          return (
            <div
              key={job.job}
              title={
                `${job.job} · ${job.book} · every ${job.everyMin}m · flags after ${job.staleAfterMin}m` +
                (row ? ` · fired ${row.runs}×` : " · never stamped") +
                (row?.lastDurationMs != null
                  ? ` · last run took ${formatHeartbeatDuration(row.lastDurationMs)}`
                  : "") +
                `. If it goes quiet: ${job.consequence}`
              }
              className={cn(
                "flex items-center gap-2 rounded-xl border px-2.5 py-1.5 backdrop-blur-md transition-colors",
                status === "ok"
                  ? "border-white/60 bg-white/45"
                  : status === "stale"
                    ? // The warn palette from ui-kit's Chip, not a light rose SURFACE:
                      // index.css's dark remap covers bg-white/*, bg-rose-50/50 and
                      // rose-500/* translucent accents — bg-rose-50/60 is none of
                      // those, so it stayed a near-white pink box on the dark theme.
                      // The stale row is the one state that must be readable in both.
                      "border-rose-500/20 bg-rose-500/10"
                    : "border-white/50 bg-white/30",
              )}
            >
              <span
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  status === "ok"
                    ? "bg-emerald-500/80"
                    : status === "stale"
                      ? "bg-rose-500"
                      : "bg-slate-300",
                )}
              />
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-wide text-slate-400">
                {job.book}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-slate-600">
                {job.label}
              </span>
              {status === "stale" && <AlertTriangle className="size-3 shrink-0 text-rose-500" />}
              <span
                className={cn(
                  "shrink-0 font-mono text-[10px] tabular-nums",
                  status === "stale" ? "font-semibold text-rose-600" : "text-slate-400",
                )}
              >
                {status === "never" ? "never" : age}
                {/* Duration rides the same span so the row keeps its shape on a
                    phone: no extra column to squeeze the label for. */}
                {row?.lastDurationMs != null
                  ? ` · ${formatHeartbeatDuration(row.lastDurationMs)}`
                  : ""}
              </span>
            </div>
          );
        })}
      </div>

      {stale.length > 0 && (
        <ul className="mt-2 space-y-1 pl-4 text-[10px] leading-relaxed text-rose-600/90 list-disc">
          {stale.map((job) => (
            <li key={job.job}>
              <span className="font-semibold">{job.label}</span> — {job.consequence}.
              {/* Only claimed where it is literally true (registry's failOpen):
                  a stalled R-lock does not make any gate permissive, it stops
                  banking a winner. */}
              {job.failOpen
                ? " Gates that read its output fail open, so entries stay enabled with that protection off."
                : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
