/**
 * RESILIENT BATCH WRITE (2026-10-02) — bisect a rejected batch so one
 * malformed row can never take a whole journal down with it, silently.
 *
 * Motivating incident: the decision-record write (`logRejections`) failed
 * silently from 2026-09-29 02:03 to 2026-10-02. An undeclared shadow field
 * (`d1StochK`) started riding the rows, Convex rejects the ENTIRE rows array
 * on the first bad row ("Object contains extra field ... that is not in the
 * validator"), and the call site swallowed the error with `.catch(() => {})`
 * — ~5-14 rows/tick vanished with no trace for 3+ days.
 *
 * Contract: a journal write may fail (it must never block a tick) but a
 * dropped row must be COUNTABLE and NAMED. Only validation-shaped failures
 * are bisected — those are per-row data bugs and each probe is a cheap,
 * side-effect-free argument check. Any other error (missing function after a
 * bad deploy, backend outage) is returned whole so a systemic outage cannot
 * multiply into 2N failed mutation calls per tick.
 */

export type BatchWriteResult<T> = {
  written: number;
  dropped: { row: T; error: string }[];
};

const VALIDATION_ERROR_RE =
  /ArgumentValidationError|extra field|does not match validator|missing required field/i;

/** The raw message, whether the throwable is an Error or not. */
export function rawErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A journaling gist, not a stack. Convex wraps thrown errors as
 * "[Request ID: ...] Server Error\nArgumentValidationError: ...\nPath: ...\n...",
 * so the first non-empty line alone is noise — pick the first line that
 * actually carries the failure words.
 */
export function writeErrorMessage(e: unknown): string {
  const msg = rawErrorMessage(e).trim();
  const lines = msg
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const meaningful = lines.find(
    (l) =>
      !/^\[Request ID:[^\]]*\]\s*Server Error$/i.test(l) &&
      !/^Server Error$/i.test(l) &&
      !/^\[CONVEX [MQ]\(/.test(l),
  );
  return (meaningful ?? lines[0] ?? msg).slice(0, 200);
}

export async function bisectBatchWrite<T>(
  rows: readonly T[],
  write: (batch: T[]) => Promise<unknown>,
): Promise<BatchWriteResult<T>> {
  const list = rows.slice();
  if (list.length === 0) return { written: 0, dropped: [] };
  try {
    await write(list);
    return { written: list.length, dropped: [] };
  } catch (e) {
    const error = writeErrorMessage(e);
    // Test the FULL message: Convex's "[Request ID: ...] Server Error" header
    // precedes the words that identify a validation failure.
    if (list.length === 1 || !VALIDATION_ERROR_RE.test(rawErrorMessage(e))) {
      return { written: 0, dropped: list.map((row) => ({ row, error })) };
    }
    // Isolate: bisect until each poisonous row stands alone. Sequential so the
    // probe order is deterministic and the backend sees one call at a time.
    const mid = Math.ceil(list.length / 2);
    const left = await bisectBatchWrite(list.slice(0, mid), write);
    const right = await bisectBatchWrite(list.slice(mid), write);
    return {
      written: left.written + right.written,
      dropped: [...left.dropped, ...right.dropped],
    };
  }
}
