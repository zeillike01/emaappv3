/**
 * ENGINE HEARTBEAT — the dead-man's switch over the cron grid (2026-09-21).
 *
 * WHY THIS EXISTS
 * Every entry gate in this stack fails OPEN when its input is missing: a stale
 * advisor doc stops vetoing (`advisorVetoFor(null)` → `{status:"ok"}`), a
 * missing BTC read leaves the regime gate inactive, and the 4H EMA75 gate
 * treats "no data" as "no objection". That is the right call for a transient
 * blip and a silent strategy change for a stalled cron — and until now the
 * stall was undetectable: nothing in `src/convex/` recorded that a tick had
 * stopped firing. Convex cannot run an agent inside a function, so the only
 * honest check is a dead-man's switch: each tick writes "I ran" and this module
 * decides when the silence is too long.
 *
 * WHAT THE STAMP MEANS — READ THIS BEFORE WIRING A JOB
 * A stamp means THE CRON FIRED. Nothing else. In particular it does NOT mean
 * "this action ran": three of these actions are also wired to the panel's
 * "Run now" buttons (advisorTick, strategyTick, marketDataTick), and a stamp
 * from a manual run would light up the row while the scheduler is dead —
 * exactly inverting the readout at the moment someone is diagnosing a stall.
 * Those handlers therefore stamp only when the invocation carries the
 * cron-only flag, which only src/convex/crons.ts passes. If you wire a new job
 * that is reachable from the UI, gate its stamp the same way.
 *
 * WHAT IT IS NOT
 * Not a liveness probe of the process (the platform's own uptime is assumed),
 * and not an error tracker. A tick that starts and throws still counts as
 * alive — its own error surface (lastScanResult / lastExitResult / the advisor
 * doc's age) owns what went wrong; this owns whether the clock is still ticking.
 *
 * THE THRESHOLDS
 * `staleAfterMin` is deliberately a couple of cadences wide, not one: a single
 * missed fire can be scheduler jitter, two consecutive misses cannot. The one
 * number that is NOT arbitrary is the 4H advisor's 300 min — it is exactly
 * `ADVISOR_MAX_AGE_MS` (5 h) from liveBroker.ts, i.e. the moment the advisor
 * gate stops vetoing and quietly becomes a no-op. Warning and consequence are
 * aligned on purpose: "heartbeat stale" and "this gate is now permissive" are
 * the same instant, so the panel says one thing instead of two.
 *
 * PURE: no I/O, no clock, no imports — unit-testable, and safe to share
 * between the Convex recorder and the React panel.
 */

export type HeartbeatBook = "layer1" | "advisor" | "live" | "paper";

export type HeartbeatJob = {
  /** The `crons.cron(...)` job name in src/convex/crons.ts — also the DB key. */
  job: string;
  label: string;
  /** Which book's behaviour changes when this job goes quiet (shown as a tag). */
  book: HeartbeatBook;
  /** Nominal cadence in minutes (what the cron actually fires at). */
  everyMin: number;
  /** Silence beyond this many minutes is flagged stale. */
  staleAfterMin: number;
  /** What stops working when this job goes quiet. */
  consequence: string;
  /**
   * True when a stalled tick silently turns an entry gate PERMISSIVE (the
   * failure mode this module exists for), false when the failure is "a book
   * stops acting" — which is at least visible in the ledger. The panel only
   * claims "gates fail open" for the jobs where that is literally true, rather
   * than applying the same sentence to a trailing exit.
   */
  failOpen: boolean;
};

/**
 * Every cron that is a TICK. Keep in sync with src/convex/crons.ts — the panel
 * renders this list, so a job missing here is a cron nobody watches.
 *
 * Deliberately NOT listed: the three daily retention jobs
 * (cleanup-layer1-ticks / cleanup-market-metrics / cleanup-strategy-signals).
 * They are `internal.cleanup.*` mutations, and a mutation cannot call the
 * heartbeat recorder (only an action can call another function; it would have
 * to go through ctx.scheduler). Their failure mode is also the opposite of the
 * one this module exists for: a dead pruner grows tables, it does not silently
 * turn a trading gate off. Adding them would cost a scheduled write a day to
 * watch a job whose worst case is slow and visible.
 */
export const HEARTBEAT_JOBS: HeartbeatJob[] = [
  {
    job: "layer1-market-data",
    label: "Layer 1 market data",
    book: "layer1",
    // 15 min since 2026-09-22 (was 5). Every entry minute (:03/:18/:33/:48) is
    // exactly 3 min past a 15m boundary, so the snapshot an entry reads is the
    // same document at the same age as it was on the 5-minute grid — the extra
    // ticks produced docs no entry ever read. Keep this in step with the
    // registration in crons.ts or the dead-man's switch cries wolf.
    everyMin: 15,
    staleAfterMin: 25,
    consequence:
      "flow/spread/score inputs freeze; entries read a stale snapshot",
    // Stale inputs don't vanish — the gates keep evaluating old numbers, which
    // is the same silent pass-through by another route.
    failOpen: true,
  },
  {
    job: "layer2-strategy",
    label: "Layer 2 paper entries",
    book: "paper",
    everyMin: 15,
    staleAfterMin: 25,
    consequence: "the paper book stops opening positions",
    failOpen: false,
  },
  {
    job: "layer2-exit-tick",
    label: "Layer 2 paper exits + R-lock",
    book: "paper",
    everyMin: 5,
    staleAfterMin: 12,
    consequence: "paper SL/TP and the paper trailing lock stop advancing",
    failOpen: false,
  },
  {
    job: "advisor-htf-tick",
    label: "4H advisor",
    book: "advisor",
    everyMin: 240,
    // 300 min = ADVISOR_MAX_AGE_MS (5 h) in liveBroker: the exact point the 4H
    // veto layer silently goes permissive.
    staleAfterMin: 300,
    consequence: "the 4H veto layer goes quiet — entries pass ungated",
    failOpen: true,
  },
  {
    job: "advisor-1h-tick",
    label: "1H advisor",
    book: "advisor",
    everyMin: 60,
    staleAfterMin: 90,
    consequence: "the 1H veto layer goes quiet — entries pass ungated",
    failOpen: true,
  },
  // The proxy job entries were removed with the proxy book (2026-09-26). Their
  // heartbeat rows still sit in the table; left registered they would report as
  // permanently "stale" and cry wolf forever about a book that no longer exists.
  {
    job: "live-intent-reconcile",
    label: "Live intent recovery",
    book: "live",
    everyMin: 5,
    staleAfterMin: 12,
    consequence:
      "accepted entry/close orders stay unsettled and retries remain fenced",
    failOpen: false,
  },
  {
    job: "live-entry",
    label: "Live entries",
    book: "live",
    everyMin: 15,
    staleAfterMin: 25,
    consequence: "the live book stops opening positions",
    failOpen: false,
  },
  {
    job: "live-exit",
    label: "Live exit / bracket reconciliation",
    book: "live",
    everyMin: 15,
    staleAfterMin: 25,
    consequence: "brackets and vanished positions stop being reconciled",
    failOpen: false,
  },
  {
    job: "live-rlock-tick",
    label: "Live R-lock",
    book: "live",
    everyMin: 5,
    staleAfterMin: 12,
    // The exchange SL never moves, so a dead ratchet means a position that
    // ratcheted to +4R is still stopped at −1R. This is the one job where the
    // silence is actively holding open money.
    consequence:
      "trailing rungs stop advancing — winners give it all back to the SL",
    failOpen: false,
  },
  // SHORT BOOK (retired 2026-10-22): the three jobs that used to live here
  // (short-taker-volume, short-entry-4h, short-entry-15m) are deliberately
  // absent WITH their cron registrations. A heartbeat entry without a schedule
  // would report the retired book as permanently stale, which is a false
  // alarm — the panel should show no short-book tile at all.
  {
    job: "session-breaker-refresh",
    label: "Session profitability snapshot (paper → live)",
    book: "live",
    everyMin: 720,
    // 15h: two 12h fires plus jitter. On a miss the live entry path recomputes
    // the buckets from the paper ledger, so the gate is never blind — only
    // un-snapshotted. Warning is about the record, not a silent pass-through.
    staleAfterMin: 900,
    consequence:
      "the paper→live session snapshot stops refreshing; live entries fall back to a per-tick recompute",
    failOpen: false,
  },
  {
    job: "coin-priority-refresh",
    label: "Coin priority ranking (paper → live order)",
    book: "live",
    everyMin: 1440,
    // One daily fire plus 2h slack. On a miss the live entry path recomputes
    // the ranking from the paper ledger, so slots still go to the profitable
    // coins — only the persisted daily series gains a gap.
    staleAfterMin: 1560,
    consequence:
      "the daily per-coin ranking stops updating; live scans fall back to a per-tick recompute from the paper ledger",
    // NOT fail-open: a stale snapshot is never consumed as fresh — the reader
    // recomputes from the ledger, and an empty ranking only restores the old
    // unordered scan. No entry gate becomes more permissive.
    failOpen: false,
  },
  // DOWN-BLOCK FORWARD TEST (2026-10-25). Neither job can change a trade — the
  // record is read by one card and nothing else. They are registered anyway
  // because their failure is the quiet kind: a dead capture leaves a card that
  // says "no refusals recorded yet", and a dead resolver leaves "N open", and
  // both read as a calm tape rather than as a broken job. For a forward test the
  // silence IS the data loss, so it gets a clock.
  {
    job: "down-block-shadow-capture",
    label: "DOWN-BLOCK refusal capture",
    book: "paper",
    everyMin: 20,
    // 2.5 cadences: one missed fire is scheduler jitter, two is a stall.
    staleAfterMin: 50,
    consequence:
      "the DOWN-BLOCK forward test stops collecting refusals — the record silently loses the days it exists for",
    failOpen: false,
  },
  {
    job: "down-block-shadow-resolve",
    label: "DOWN-BLOCK forward settle",
    book: "paper",
    everyMin: 60,
    staleAfterMin: 150,
    consequence:
      "refused setups never get an outcome — the record fills up with open rows and answers nothing",
    failOpen: false,
  },
];

const BY_JOB = new Map(HEARTBEAT_JOBS.map((j) => [j.job, j]));


export function heartbeatJob(job: string): HeartbeatJob | undefined {
  return BY_JOB.get(job);
}

export type HeartbeatStatus = "never" | "ok" | "stale";

/** Stale ceiling for a job, in ms. Unknown jobs never go stale (fail quiet). */
export function heartbeatStaleMs(job: string): number {
  const meta = BY_JOB.get(job);
  return meta ? meta.staleAfterMin * 60_000 : Number.POSITIVE_INFINITY;
}

/**
 * Verdict for one job. `lastRunAt` undefined/0 means the tick has never been
 * seen — which is "never", not "stale": a job that has never fired is a
 * different (and usually older) problem than one that stopped, and it must
 * never be summarised as healthy (see the panel's header counts).
 */
export function heartbeatStatus(
  lastRunAt: number | undefined | null,
  job: string,
  now: number,
): HeartbeatStatus {
  if (!(Number(lastRunAt) > 0)) return "never";
  const age = now - Number(lastRunAt);
  // Clock skew / a future stamp reads as fresh rather than alarming.
  if (age < 0) return "ok";
  return age > heartbeatStaleMs(job) ? "stale" : "ok";
}

/**
 * "8.4s" · "1m 35s" — one decimal under a minute, whole seconds above it.
 *
 * This is a DURATION (how long a tick ran), not an age, so it is deliberately
 * not formatHeartbeatAge: "1.4s" is information about cost, while "1s" would
 * round the interesting part away. Missing/negative reads as a dash, never 0s.
 */
export function formatHeartbeatDuration(ms: number | undefined | null): string {
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) < 0) return "—";
  const totalSecs = Number(ms) / 1000;
  if (totalSecs < 60) return `${totalSecs.toFixed(1)}s`;
  const secs = Math.round(totalSecs);
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${String(rem).padStart(2, "0")}s`;
}

/** "45s" · "12m" · "3h 04m" · "2d 06h" — coarse on purpose (it's an age, not a clock). */
export function formatHeartbeatAge(ms: number | undefined | null): string {
  // Explicit null/undefined check, not a numeric comparison: Number(null) is 0,
  // so a `>= 0` guard would render a MISSING stamp as a healthy "0s".
  if (ms == null || !Number.isFinite(Number(ms)) || Number(ms) < 0) return "—";
  const secs = Math.floor(Number(ms) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 24)
    return rem === 0
      ? `${hours}h`
      : `${hours}h ${String(rem).padStart(2, "0")}m`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH === 0 ? `${days}d` : `${days}d ${String(remH).padStart(2, "0")}h`;
}
