/**
 * R-LOCK TRAILING EXIT — decision-rule parity tests.
 *
 * rLockStep is the pure decision rule both exit passes (paper layer2ExitTick +
 * live liveRLockTick) run against a fresh price sample, and it is the ONLY
 * thing standing between a running winner and a fixed-target truncation. The
 * module doc claims the rule is "byte-for-byte the backtest engine's tpMode
 * 'rlock'"; these tests pin that ordering explicitly, so a reorder that would
 * silently change what the real-money book books fails here first.
 *
 * Ordering pinned (matches src/lib/backtest.ts rlock branch):
 *   0. original stop breached on this sample → stand down (the book owns it);
 *   1. the STORED lock is checked against the current price BEFORE any ratchet;
 *   2. then the max-target full exit;
 *   3. only then the peak advances and the lock ratchets (one-way only).
 */
import { describe, it, expect } from "vitest";
import {
  rLockEnabled,
  rLockStep,
  rLockReplayBars,
  lockRFromPrice,
  type RLockParams,
  type RLockBar,
} from "../r-lock";

// LONG: entry 100, stop 98.5 → risk = 1.5 (a 1.5% stop on a 100 entry).
const LONG = { side: "LONG" as const, entryPrice: 100, slPrice: 98.5 };
// SHORT mirror: entry 100, stop 101.5 → risk = 1.5.
const SHORT = { side: "SHORT" as const, entryPrice: 100, slPrice: 101.5 };
// step 1 keeps the arithmetic legible (the shipped default is 0.25).
const P: RLockParams = { startR: 1.5, stepR: 1, maxR: 6 };

const priceAtR = (side: "LONG" | "SHORT", r: number) =>
  side === "LONG" ? 100 + 1.5 * r : 100 - 1.5 * r;

describe("rLockEnabled", () => {
  it("is on only for a finite startR > 0", () => {
    expect(rLockEnabled({ startR: 1.5 })).toBe(true);
    expect(rLockEnabled({ startR: 0 })).toBe(false);
    expect(rLockEnabled({ startR: -1 })).toBe(false);
    expect(rLockEnabled({})).toBe(false);
    expect(rLockEnabled(null)).toBe(false);
    expect(rLockEnabled(undefined)).toBe(false);
  });
});

describe("rLockStep — armed / idle", () => {
  it("does nothing while the lock is disabled (startR <= 0)", () => {
    const out = rLockStep({ ...LONG, price: 110, params: { startR: 0, stepR: 1, maxR: 6 } });
    expect(out).toEqual({
      peakR: 0,
      lockPrice: 0,
      lockR: 0,
      changed: false,
      exit: null,
      stopBreached: false,
    });
  });

  it("fails closed on a zero risk distance or a non-positive price", () => {
    expect(
      rLockStep({ side: "LONG", entryPrice: 100, slPrice: 100, price: 105, params: P }).exit,
    ).toBeNull();
    expect(rLockStep({ ...LONG, price: 0, params: P }).exit).toBeNull();
  });

  it("does not ratchet until the peak reaches startR", () => {
    const out = rLockStep({ ...LONG, price: priceAtR("LONG", 1.0), params: P });
    expect(out.lockPrice).toBe(0);
    expect(out.lockR).toBe(0);
    expect(out.peakR).toBeCloseTo(1.0, 6);
    expect(out.changed).toBe(true); // the peak moved even though the lock did not
    expect(out.exit).toBeNull();
  });
});

describe("rLockStep — ratchet (one-way)", () => {
  it("LONG: locks to the whole step once past startR", () => {
    // peak 3.2R → lock = 1.5 + floor(1.7/1)*1 = 2.5R → 103.75
    const out = rLockStep({ ...LONG, price: priceAtR("LONG", 3.2), params: P });
    expect(out.peakR).toBeCloseTo(3.2, 6);
    expect(out.lockR).toBeCloseTo(2.5, 6);
    expect(out.lockPrice).toBeCloseTo(103.75, 6);
    expect(out.exit).toBeNull();
  });

  it("SHORT: locks BELOW entry (a mirrored price) once past startR", () => {
    const out = rLockStep({ ...SHORT, price: priceAtR("SHORT", 3.2), params: P });
    expect(out.lockR).toBeCloseTo(2.5, 6);
    expect(out.lockPrice).toBeCloseTo(96.25, 6);
  });

  it("never walks the lock back down when price retraces but stays off the rung", () => {
    // Prior rung 2.5R (103.75); a sample at 2.6R is below the rung price so it
    // must NOT move the lock, nor trigger an exit.
    const out = rLockStep({
      ...LONG,
      price: priceAtR("LONG", 2.6),
      params: P,
      state: { peakR: 3.2, lockPrice: 103.75 },
    });
    expect(out.lockPrice).toBeCloseTo(103.75, 6);
    expect(out.exit).toBeNull();
  });

  it("SHORT: a fresh farther price advances the lock in the trade's favour", () => {
    const out = rLockStep({
      ...SHORT,
      price: priceAtR("SHORT", 4),
      params: P,
      state: { peakR: 3.2, lockPrice: 96.25 },
    });
    // peak 4R → lock = 1.5 + floor(2.5) = 3.5R → 94.75
    expect(out.lockPrice).toBeCloseTo(94.75, 6);
  });
});

describe("rLockStep — exit ordering (stop before lock before max)", () => {
  it("stands down when the ORIGINAL stop is breached, even if the rung also is", () => {
    const out = rLockStep({
      ...LONG,
      price: 98, // below the 98.5 stop AND below the 103.75 rung
      params: P,
      state: { peakR: 3.2, lockPrice: 103.75 },
    });
    expect(out.exit).toBeNull();
    expect(out.changed).toBe(false);
    expect(out.lockPrice).toBeCloseTo(103.75, 6); // untouched — the book closes it
  });

  it("LONG: exits on the STORED rung (checked before any ratchet from this sample)", () => {
    const out = rLockStep({
      ...LONG,
      price: priceAtR("LONG", 2.4), // 103.6 ≤ 103.75 rung
      params: P,
      state: { peakR: 3.2, lockPrice: 103.75 },
    });
    expect(out.exit).toEqual({
      reason: "Trail Lock",
      rungPrice: 103.75,
      lockR: 2.5,
    });
    expect(out.changed).toBe(false);
  });

  it("SHORT: exits on the stored rung when price trades back up to it", () => {
    const out = rLockStep({
      ...SHORT,
      price: 96.3, // ≥ 96.25 rung
      params: P,
      state: { peakR: 3.2, lockPrice: 96.25 },
    });
    expect(out.exit?.reason).toBe("Trail Lock");
    expect(out.exit?.rungPrice).toBeCloseTo(96.25, 6);
  });

  it("takes the max-target full exit once curR reaches maxR", () => {
    const out = rLockStep({ ...LONG, price: priceAtR("LONG", 6), params: P });
    expect(out.exit).toEqual({ reason: "R-Lock Max", rungPrice: 109, lockR: 6 });
    expect(out.peakR).toBeCloseTo(6, 6);
  });

  it("prefers the max target over a stale rung when a gap blows past both", () => {
    const out = rLockStep({
      ...LONG,
      price: priceAtR("LONG", 7),
      params: P,
      state: { peakR: 3.2, lockPrice: 103.75 },
    });
    expect(out.exit?.reason).toBe("R-Lock Max");
    expect(out.exit?.lockR).toBe(6);
  });

  it("reports no exit and no change on a quiet sample", () => {
    // price 104 (2.667R) sits ABOVE the 103.75 rung and does not exceed the
    // prior peak of 3.2R, so nothing moves and nothing closes.
    const out = rLockStep({
      ...LONG,
      price: 104,
      params: P,
      state: { peakR: 3.2, lockPrice: 103.75 },
    });
    expect(out).toEqual({
      peakR: 3.2,
      lockPrice: 103.75,
      lockR: 2.5, // the rung is still reported; only the FILL/store was unchanged
      changed: false,
      exit: null,
      stopBreached: false,
    });
  });
});

describe("lockRFromPrice", () => {
  it("inverts a LONG lock price back to R", () => {
    expect(lockRFromPrice({ ...LONG, lockPrice: 103.75 })).toBeCloseTo(2.5, 6);
  });
  it("inverts a SHORT lock price back to R", () => {
    expect(lockRFromPrice({ ...SHORT, lockPrice: 96.25 })).toBeCloseTo(2.5, 6);
  });
  it("returns 0 for an unlocked (0) lock price or a zero risk", () => {
    expect(lockRFromPrice({ ...LONG, lockPrice: 0 })).toBe(0);
    expect(lockRFromPrice({ side: "LONG", entryPrice: 100, slPrice: 100, lockPrice: 105 })).toBe(0);
  });
});

/**
 * FROZEN RULER (2026-09-21) — riskPx.
 *
 * The live book refines entryPrice to the exchange's average fill after the
 * fact (liveExitTick → refineLiveEntry) while a trailPeakR / trailLockPrice is
 * already stored on the row. Without riskPx every later tick re-derived R from
 * the refined price, so the stored rungs were measured on a ruler that had
 * moved. These tests pin that a stamped riskPx wins over the entry, for both
 * sides, and that omitting it keeps the old arithmetic exactly.
 */
describe("rLockStep — frozen ruler (riskPx)", () => {
  it("measures R from the stamped ruler, not from the (refined) entry", () => {
    // 100 → 98.5 is 1R. The book then reports an entry of 100.05 (a 0.05%
    // fill refinement). With the ruler frozen at 1.5, a price 1R above the
    // ORIGINAL entry stays exactly +1.0R — the refinement cannot move it.
    const out = rLockStep({ ...LONG, entryPrice: 100.05, riskPx: 1.5, price: 101.5, params: P });
    expect(out.peakR).toBeCloseTo(1.0, 9);

    // Same sample WITHOUT the stamp: the ruler is now |100.05 − 98.5| = 1.55,
    // so the identical price reads a different R. This is the drift.
    const unstamped = rLockStep({ ...LONG, entryPrice: 100.05, price: 101.5, params: P });
    expect(unstamped.peakR).not.toBeCloseTo(out.peakR, 4);
  });

  it("re-anchors a SHORT from the stop side too (slPrice − riskPx)", () => {
    // SHORT: entry 100, stop 101.5. A refined entry of 99.95 must not shift R.
    const out = rLockStep({ ...SHORT, entryPrice: 99.95, riskPx: 1.5, price: 98.5, params: P });
    expect(out.peakR).toBeCloseTo(1.0, 9);
  });

  it("ratchets the same lock price the frozen ruler implies", () => {
    // Peak 3.2R on the frozen ruler → the 1-step rung from 1.5 is 2.5R, i.e.
    // 100 + 1.5 × 2.5 regardless of what entryPrice currently says.
    const out = rLockStep({
      ...LONG,
      entryPrice: 100.06,
      riskPx: 1.5,
      price: priceAtR("LONG", 3.2),
      params: P,
    });
    expect(out.lockR).toBe(2.5);
    expect(out.lockPrice).toBeCloseTo(103.75, 9);
  });

  it("ignores a non-positive or non-finite stamp (falls back to the entry stop)", () => {
    const base = rLockStep({ ...LONG, price: priceAtR("LONG", 3.2), params: P });
    for (const bad of [0, -1.5, NaN, undefined, null]) {
      const out = rLockStep({ ...LONG, riskPx: bad as any, price: priceAtR("LONG", 3.2), params: P });
      expect(out).toEqual(base);
    }
  });

  it("still stands down when the frozen ruler's stop is breached", () => {
    const out = rLockStep({ ...LONG, riskPx: 1.5, price: 98.4, params: P });
    expect(out.exit).toBeNull();
    expect(out).toEqual({
      peakR: 0,
      lockPrice: 0,
      lockR: 0,
      changed: false,
      exit: null,
      stopBreached: true, // stands down, but SAYS SO — see STOP FIDELITY
    });
  });
});

// ── Bar replay (2026-09-22 audit) ──────────────────────────────────────────
//
// These pin the property the 5-minute spot sample could not deliver: a bar that
// SPIKES and CLOSES does arm the lock. That is the difference between the mechanic
// the backtest priced and the one the live book was actually running.
describe("rLockReplayBars", () => {
  const bar = (i: number, low: number, high: number): RLockBar => ({
    openTime: i * 300_000,
    closeTime: i * 300_000 + 299_000,
    low,
    high,
  });
  /** Bars at 5-minute offsets starting at openTime 0. */
  const replay = (bars: RLockBar[], side: "LONG" | "SHORT" = "LONG", since = 0) =>
    rLockReplayBars({
      ...(side === "LONG" ? LONG : SHORT),
      params: P,
      bars,
      sinceOpenTime: since,
    });

  it("arms the lock from a SPIKE the spot sampler would have missed", () => {
    // A single bar pokes to +2.0R then closes back near entry. A 5-minute
    // ticker sample lands outside it and never sees the peak; the bar does.
    const out = replay([bar(1, 98.0, priceAtR("LONG", 2.0))]);
    expect(out.peakR).toBeCloseTo(2, 6);
    expect(out.exit).toBeNull();
    expect(out.lockPrice).toBeGreaterThan(0);
    expect(out.barsRead).toBe(1);
  });

  it("does NOT exit on the bar that arms the lock (adverse is checked first)", () => {
    // This bar's low is far below the 1.5R rung AND its high arms the lock. The
    // ordering is the whole point: the low is tested while the lock is still 0,
    // so one bar can never arm and breach its own rung.
    //
    // Note the low (97.0) is ALSO through the 98.5 stop, so the replay reports a
    // stop breach alongside the arm — the two are independent facts, and the
    // paper book books the stop. That is the documented rule, not a regression:
    // a bar that hit both books −1R rather than the rung.
    const out = replay([bar(1, 97.0, priceAtR("LONG", 3.0))]);
    expect(out.exit).toBeNull();
    expect(out.peakR).toBeCloseTo(3, 6);
    expect(out.stopBreach).not.toBeNull();
  });

  it("exits on a LATER bar that trades back through the armed rung", () => {
    const out = replay([
      // peak 3.0R with step 1 → rung = 1.5 + floor(1.5/1)*1 = 2.5R
      bar(1, 99.5, priceAtR("LONG", 3.0)),
      bar(2, priceAtR("LONG", 2.5), priceAtR("LONG", 3.2)), // low touches the 2.5R rung → exit
    ]);
    expect(out.exit).not.toBeNull();
    expect(out.exit!.reason).toBe("Trail Lock");
    expect(out.exit!.lockR).toBeCloseTo(2.5, 6);
    expect(out.exit!.atTime).toBe(bar(2, 0, 0).closeTime);
  });

  it("is deterministic and idempotent — the same bars always replay to the same state", () => {
    const bars = [bar(1, 99.0, priceAtR("LONG", 1.2)), bar(2, 99.8, priceAtR("LONG", 2.4))];
    const a = replay(bars);
    const b = replay(bars);
    expect(a).toEqual(b);
    expect(a.exit).toBeNull();
    // Re-replaying a SUBSET later in the sequence must not change the state
    // (which is why the full-from-entry replay needs no persisted cursor).
    expect(replay(bars.slice(0, 2)).peakR).toBeCloseTo(a.peakR, 10);
  });

  it("ignores bars that opened before the trade did", () => {
    const out = replay([bar(1, 96.0, priceAtR("LONG", 5.0)), bar(5, 99.0, 101.0)], "LONG", 4 * 300_000);
    expect(out.barsRead).toBe(1);
    expect(out.peakR).toBeCloseTo((101 - 100) / 1.5, 6);
  });

  it("mirrors for SHORT (adverse high first, favourable low)", () => {
    const out = replay([bar(1, priceAtR("SHORT", 3.0), 101.5)], "SHORT");
    expect(out.exit).toBeNull();
    expect(out.peakR).toBeCloseTo(3, 6);

    const later = replay([bar(1, priceAtR("SHORT", 3.0), 101.0), bar(2, priceAtR("SHORT", 2.4), priceAtR("SHORT", 3.1))], "SHORT");
    expect(later.exit?.reason).toBe("Trail Lock");
  });

  it("takes the max-target exit when a bar reaches maxR", () => {
    const out = replay([bar(1, 99.0, priceAtR("LONG", 6.5))]);
    expect(out.exit?.reason).toBe("R-Lock Max");
  });

  it("leaves the state untouched with no qualifying bars", () => {
    const out = replay([], "LONG");
    expect(out).toEqual({
      peakR: 0,
      lockPrice: 0,
      changed: false,
      exit: null,
      stopBreach: null,
      lastBarTime: 0,
      barsRead: 0,
    });
  });
});

// ── STOP FIDELITY (2026-09-22) ──────────────────────────────────────────────
//
// The replay has always computed `bar.low <= slPrice` and then thrown the
// answer away, which left the PAPER book the only one without a bar-accurate
// stop: its stop is one price from the batched ticker, sampled every 5 minutes,
// so a wick that touches the stop and recovers inside that window is invisible
// while the live book's resting exchange bracket fills it. These pin the fact
// that the replay now REPORTS the breach, using the trade that exposed it.
describe("stop-breach reporting", () => {
  const bar = (i: number, low: number, high: number): RLockBar => ({
    openTime: i * 300_000,
    closeTime: i * 300_000 + 299_000,
    low,
    high,
  });
  const replay = (bars: RLockBar[], side: "LONG" | "SHORT" = "LONG") =>
    rLockReplayBars({
      ...(side === "LONG" ? LONG : SHORT),
      params: P,
      bars,
      sinceOpenTime: 0,
    });

  it("reports a wick that trades through the stop and closes back above it", () => {
    // DOGE, 2026-09-21 23:33 — the row that exposed this. Entry 0.09984, stop
    // 0.0983424; the bar wicked to 0.09791 (below the stop) and CLOSED 0.09950
    // (above it). The live book's bracket filled the wick at −1.02R; paper's
    // 5-minute ticker sample never saw it and rode the next rally to +3.13R.
    const wick = bar(1, 0.09791, 0.09950);
    const out = rLockReplayBars({
      side: "LONG",
      entryPrice: 0.09984,
      slPrice: 0.0983424,
      params: P,
      bars: [wick],
      sinceOpenTime: 0,
    });
    expect(out.exit).toBeNull();
    expect(out.stopBreach).not.toBeNull();
    expect(out.stopBreach!.price).toBeCloseTo(0.09791, 10);
    expect(out.stopBreach!.atTime).toBe(wick.closeTime);
  });

  it("reports nothing while every bar holds above the stop", () => {
    const out = replay([bar(1, 99.0, 101.0), bar(2, 98.6, 101.5)]);
    expect(out.stopBreach).toBeNull();
    expect(out.exit).toBeNull();
    expect(out.barsRead).toBe(2);
  });

  it("ENDS the replay at the breach bar — later bars cannot ratchet the peak", () => {
    // The trade is over at the stop. A later rally must not raise the peak of a
    // position that no longer exists (that is the exact optimism being removed).
    const out = replay([
      bar(1, 97.0, 99.5), // wick through the 98.5 stop
      bar(2, 100.0, priceAtR("LONG", 5.0)), // a rally the dead trade must not bank
    ]);
    expect(out.stopBreach).not.toBeNull();
    expect(out.barsRead).toBe(1);
    expect(out.peakR).toBeCloseTo(0, 10);
  });

  it("breach and lock exit are mutually exclusive", () => {
    // Unarmed: a bar that wicks through the stop has only the stop to report.
    const spent = replay([bar(1, 98.0, priceAtR("LONG", 3.0)), bar(2, 98.0, 99.0)]);
    expect(spent.stopBreach).not.toBeNull();
    expect(spent.exit).toBeNull();

    // Armed at the 2.5R rung (103.75), and the NEXT bar's favourable extreme is
    // still at/below that rung while its adverse extreme breaches the stop. The
    // rung is then the FIRST level hit on the way down, so the trail owns the
    // bar and no breach is reported — the pre-existing, rung-favouring residual
    // the lab counts rather than silently reprices.
    const armed = replay([
      bar(1, 99.5, priceAtR("LONG", 3.0)),
      bar(2, 97.0, 103.0),
    ]);
    expect(armed.exit?.reason).toBe("Trail Lock");
    expect(armed.stopBreach).toBeNull();
  });

  it("books the STOP when one bar spans both ways past an armed rung", () => {
    // The ambiguous bar: low 97 is below the 98.5 stop AND high 104.8 is above
    // the armed 103.75 rung — so the intrabar order is unknown. The adverse
    // extreme is evaluated first and the favourable one cannot breach a rung it
    // is above, so this resolves to −1R. That matches the harness rule ("the
    // backtest tests bar.low <= slPrice before it tests the lock, precisely so a
    // bar that hit BOTH books −1R rather than the rung").
    const out = replay([
      bar(1, 99.5, priceAtR("LONG", 3.0)),
      bar(2, 97.0, priceAtR("LONG", 3.2)),
    ]);
    expect(out.exit).toBeNull();
    expect(out.stopBreach).not.toBeNull();
  });

  it("mirrors for SHORT (the adverse extreme is the HIGH)", () => {
    const out = replay([bar(1, 100.0, 102.0)], "SHORT");
    expect(out.exit).toBeNull();
    expect(out.stopBreach).not.toBeNull();
    expect(out.stopBreach!.price).toBeCloseTo(102.0, 10); // the high, not the low
  });

  it("does not report a breach on a bar that exited on its rung", () => {
    const out = replay([
      bar(1, 99.5, priceAtR("LONG", 3.0)),
      bar(2, priceAtR("LONG", 2.5), priceAtR("LONG", 3.1)), // rung, stop never touched
    ]);
    expect(out.exit).not.toBeNull();
    expect(out.stopBreach).toBeNull();
  });

  it("rLockStep flags the breach on the DISABLED-lock return too", () => {
    // A trade with the lock switched off still has a stop, and the caller that
    // books it must still be able to see the breach.
    const out = rLockStep({ ...LONG, price: 98.0, params: { startR: 0, stepR: 1, maxR: 6 } });
    expect(out.exit).toBeNull();
    expect(out.stopBreached).toBe(true);
  });

  it("ignores a non-positive price when deciding a breach", () => {
    const out = rLockStep({ ...LONG, price: 0, params: P });
    expect(out.stopBreached).toBe(false);
  });
});
