/**
 * PENDING ANCHOR SESSION BOUNDARY (2026-10-23)
 *
 * The chase guard compares a candidate entry against the FIRST signal price it
 * saw for that pair, persisted on liveAccount.pendingSignals across ticks. The
 * anchor is only meaningful while the setup it belongs to is still live — and
 * the book's own definition of "still live" is the SESSION (trade-context.ts
 * sessionOf), which is what the session allowlists, the session breaker and
 * every per-session statistic in this repo are bucketed by.
 *
 * A tick that runs just after a boundary used to inherit the previous
 * session's anchors: a 06:50 Asia signal was still the reference at 07:05
 * London, so either the guard vetoed a genuine London setup for "drift" against
 * a price from another session, or it let the entry through with an anchor the
 * current session never produced. Both are wrong: the new session must be
 * judged on its own first signal.
 *
 * This helper is the one place that decides which stored anchors survive a
 * tick. It drops, in order:
 *   1. malformed rows (anything the validator could not have written),
 *   2. anchors whose signal time falls in a DIFFERENT session than `now`,
 *   3. anchors older than signalMaxAgeMin,
 *   4. anchors for pairs that now hold an open position.
 *
 * Pure (no Convex imports, no I/O) so the engine can call it from an action and
 * the boundary rules are unit-tested in src/lib/__tests__/pending-session.test.ts.
 */
import { sessionOf } from "./trade-context";
import type { PendingSignal } from "./layer2-signal";

export interface PendingDropCounts {
  invalid: number;
  session: number;
  aged: number;
  open: number;
}

export interface PendingHydration {
  anchors: Map<string, PendingSignal>;
  dropped: PendingDropCounts;
}

/**
 * Hydrate the persisted anchor map for one tick.
 *
 * `session` is checked BEFORE `aged` on purpose: an anchor one minute old but
 * on the other side of a session boundary is still a cross-session anchor, and
 * counting it as merely stale would hide exactly the carry-over this exists to
 * stop.
 */
export function hydratePendingAnchors(
  stored: Record<string, PendingSignal | undefined> | null | undefined,
  opts: { now: number; maxAgeMin: number; isOpen: (coin: string) => boolean },
): PendingHydration {
  const anchors = new Map<string, PendingSignal>();
  const dropped: PendingDropCounts = { invalid: 0, session: 0, aged: 0, open: 0 };
  if (!stored || typeof stored !== "object") return { anchors, dropped };

  const nowSession = sessionOf(opts.now);
  const maxAgeMs = Math.max(0, opts.maxAgeMin) * 60_000;

  for (const [coin, p] of Object.entries(stored)) {
    if (
      !p ||
      typeof p.side !== "string" ||
      (p.side !== "LONG" && p.side !== "SHORT") ||
      typeof p.price !== "number" ||
      !Number.isFinite(p.price) ||
      typeof p.time !== "number" ||
      !Number.isFinite(p.time)
    ) {
      dropped.invalid += 1;
      continue;
    }
    if (sessionOf(p.time) !== nowSession) {
      dropped.session += 1;
      continue;
    }
    if (opts.now - p.time > maxAgeMs) {
      dropped.aged += 1;
      continue;
    }
    if (opts.isOpen(coin)) {
      dropped.open += 1;
      continue;
    }
    anchors.set(coin, { side: p.side, price: p.price, time: p.time });
  }
  return { anchors, dropped };
}

/** One-line diagnostic for the tick summary — empty when nothing was dropped. */
export function describePendingDrops(dropped: PendingDropCounts): string {
  const parts: string[] = [];
  if (dropped.session) parts.push(`${dropped.session} cross-session anchor(s) cleared`);
  if (dropped.aged) parts.push(`${dropped.aged} aged`);
  if (dropped.open) parts.push(`${dropped.open} on an open pair`);
  if (dropped.invalid) parts.push(`${dropped.invalid} malformed`);
  return parts.length ? ` · pending: ${parts.join(", ")}` : "";
}
