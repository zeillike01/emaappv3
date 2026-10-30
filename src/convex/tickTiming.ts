/**
 * TICK TIMING — measurement wrapper for the cron tick bodies.
 *
 * RECONSTRUCTED (2026-10-30). This module is imported by strategyEngine.ts,
 * cronWrappers.ts and rLockExit.ts, and is listed in _generated/api.d.ts, but
 * the file itself was never committed to the reference branch (verified: absent
 * from HEAD, from all 40 published branches, and from all 356 commits of the
 * reference branch). The contract below is therefore rebuilt from its three call
 * sites and from the duration recorder that already exists in ./heartbeat.ts —
 * it is NOT inherited verbatim. Flagged so the parity audit can see it.
 *
 * WHY IT WRAPS THE BODY INSTEAD OF MEASURING INSIDE IT (2026-10-28 note carried
 * from cronWrappers.ts): every tick handler has several early returns, so a
 * `const t0 = Date.now()` at the top and a stamp before each return is a
 * refactor away from silently reporting nothing. Riding the wrapper makes the
 * measurement structurally impossible to skip.
 *
 * WHAT IT MUST NOT DO:
 *   - change the tick's return value  → it returns the body's value untouched;
 *   - change the tick's failure mode   → it rethrows the body's error as-is;
 *   - be able to break a tick          → the duration write is best-effort and
 *     swallowed, exactly like every heartbeat call. Observability must never be
 *     able to take down an entry or exit pass.
 *
 * MEASUREMENT SEMANTICS: `startedAt` is taken before the body runs and the
 * duration is stamped in `finally`, so a throwing tick still reports how long it
 * took to fail. `recordDuration` is a no-op when the job has no heartbeat row
 * (see ./heartbeat.ts): a duration without a start time is not a heartbeat, and
 * this module deliberately does not insert one — `record` owns row creation.
 */
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";

export async function timedTick<T>(
  ctx: ActionCtx,
  job: string,
  body: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  try {
    return await body();
  } finally {
    const durationMs = Date.now() - startedAt;
    // Best-effort: never let the measurement decide the tick's outcome.
    await ctx
      .runMutation(internal.heartbeat.recordDuration, { job, durationMs })
      .catch(() => {});
  }
}
