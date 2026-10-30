/**
 * ENGINE HEARTBEAT — cron liveness recorder (2026-09-21).
 *
 * One internal mutation, called as the FIRST statement of every cron tick, and
 * one query for the panel. Thresholds and the job registry live in
 * src/lib/heartbeat.ts so the recorder, the panel and the tests share one list.
 *
 * WHY FIRST, AND WHY INTERNAL
 * First, because the switch is about the CLOCK: a tick that starts and then
 * throws still proves the cron fired, and its own error surface (lastScanResult
 * / lastExitResult / advisor doc age) already owns the diagnosis. Recording at
 * the end would conflate "died" with "errored".
 *
 * Internal, because nothing outside the deployment has any business writing a
 * timestamp that a monitoring surface trusts. `internal*` functions are not part
 * of the public API — a caller with the deployment URL cannot forge liveness.
 *
 * Callers MUST swallow failures (`.catch(() => {})`): a heartbeat is
 * observability, and observability must never be able to break a trading tick.
 *
 * NOTE ON IMPORTS: this module deliberately imports NOTHING from
 * `_generated/api`. Every tick file imports `internal`/`api`, so a heartbeat
 * module that imported `api` back closed a type cycle (heartbeat → liveBroker →
 * internal → heartbeat) that degraded inference in unrelated modules — tsc
 * started reporting an unsound `Set<unknown>` at a call site inside
 * strategyTick. Keeping this file dependency-free breaks the cycle. The one
 * cron that needs to beat AND delegate lives in ./cronWrappers.ts instead.
 */
import { internalMutation, query } from "./_generated/server";
import { v } from "convex/values";

/**
 * Upsert the job's row. Upsert rather than insert-per-run on purpose: the panel
 * only ever needs the latest stamp, and an append-only log would grow to ~1.2M
 * rows/month across the 5-minute jobs to answer a question that needs one doc
 * per job.
 */
export const record = internalMutation({
  // Deliberately no timestamp argument: the stamp has to mean "the scheduler
  // fired now", and a caller-supplied time is the one way to forge that.
  args: { job: v.string() },
  handler: async (ctx, args) => {
    const at = Date.now();
    const existing = await ctx.db
      .query("cronHeartbeats")
      .withIndex("by_job", (q) => q.eq("job", args.job))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { lastRunAt: at, runs: existing.runs + 1 });
      return existing._id;
    }
    return await ctx.db.insert("cronHeartbeats", { job: args.job, lastRunAt: at, runs: 1 });
  },
});

/**
 * Stamp how long the scan took, WITHOUT touching `runs` or `lastRunAt`.
 *
 * Called at the END of a tick, so it is deliberately not the recorder above:
 * `record` means "the cron started" and must stay monotonic at the top of the
 * handler (see this module's header). This is pure measurement — action compute
 * is billed on wall-clock, so a tick's own duration is the only honest
 * before/after for a cost change, and it must be visible somewhere a human
 * reads. Best-effort: callers swallow failures.
 *
 * No row (a job whose recorder has not run yet) is a no-op, not an insert — a
 * duration without a start time is not a heartbeat.
 */
export const recordDuration = internalMutation({
  args: { job: v.string(), durationMs: v.number() },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("cronHeartbeats")
      .withIndex("by_job", (q) => q.eq("job", args.job))
      .first();
    if (!existing) return null;
    const ms = Math.max(0, Math.round(args.durationMs));
    await ctx.db.patch(existing._id, { lastDurationMs: ms });
    return ms;
  },
});

/**
 * Every heartbeat row, newest first. The panel joins this against
 * HEARTBEAT_JOBS — a job with no row here means the tick has never run since
 * the table existed, which is reported as "never", not "ok".
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("cronHeartbeats").collect();
    return rows
      .map((r) => ({
        job: r.job,
        lastRunAt: r.lastRunAt,
        runs: r.runs,
        // null (not undefined) so the client renders "no reading" as a dash.
        lastDurationMs: r.lastDurationMs ?? null,
      }))
      .sort((a, b) => b.lastRunAt - a.lastRunAt);
  },
});
