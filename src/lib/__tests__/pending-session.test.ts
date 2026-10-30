import { describe, expect, it } from "vitest";
import { hydratePendingAnchors, describePendingDrops } from "../pending-session";
import type { PendingSignal } from "../layer2-signal";

const T = (iso: string) => Date.parse(iso);
const never = () => false;

const anchor = (side: "LONG" | "SHORT", price: number, iso: string): PendingSignal => ({
  side,
  price,
  time: T(iso),
});

describe("hydratePendingAnchors — session boundary", () => {
  it("keeps an anchor from the same session", () => {
    // 07:10 London, anchor 07:05 London
    const { anchors, dropped } = hydratePendingAnchors(
      { BTC: anchor("SHORT", 82_000, "2026-10-23T07:05:00Z") },
      { now: T("2026-10-23T07:10:00Z"), maxAgeMin: 120, isOpen: never },
    );
    expect([...anchors.keys()]).toEqual(["BTC"]);
    expect(dropped.session).toBe(0);
  });

  it("DROPS a fresh anchor that belongs to the previous session", () => {
    // The regression this exists for: 06:50 Asia signal, tick at 07:05 London.
    // Only 15 minutes old, so the age rule alone would have kept it.
    const { anchors, dropped } = hydratePendingAnchors(
      { BTC: anchor("SHORT", 81_500, "2026-10-23T06:50:00Z") },
      { now: T("2026-10-23T07:05:00Z"), maxAgeMin: 120, isOpen: never },
    );
    expect(anchors.size).toBe(0);
    expect(dropped.session).toBe(1);
    expect(dropped.aged).toBe(0);
  });

  it("drops the late→asia boundary too", () => {
    const { anchors, dropped } = hydratePendingAnchors(
      { ETH: anchor("LONG", 3_000, "2026-10-22T23:59:00Z") },
      { now: T("2026-10-23T00:01:00Z"), maxAgeMin: 120, isOpen: never },
    );
    expect(anchors.size).toBe(0);
    expect(dropped.session).toBe(1);
  });

  it("keeps anchors on both sides of midnight when both are the same session", () => {
    const { anchors } = hydratePendingAnchors(
      { ETH: anchor("LONG", 3_000, "2026-10-23T00:05:00Z") },
      { now: T("2026-10-23T00:40:00Z"), maxAgeMin: 120, isOpen: never },
    );
    expect(anchors.size).toBe(1);
  });

  it("still drops aged and open-pair anchors inside the same session", () => {
    const stored = {
      OLD: anchor("LONG", 10, "2026-10-23T07:00:00Z"), // 120 min old
      AGED: anchor("LONG", 10, "2026-10-23T07:10:00Z"),
      OPEN: anchor("SHORT", 10, "2026-10-23T08:00:00Z"),
      KEEP: anchor("SHORT", 10, "2026-10-23T08:55:00Z"),
    };
    const { anchors, dropped } = hydratePendingAnchors(stored, {
      now: T("2026-10-23T09:00:00Z"),
      maxAgeMin: 60,
      isOpen: (c) => c === "OPEN",
    });
    expect([...anchors.keys()]).toEqual(["KEEP"]);
    expect(dropped.aged).toBe(2); // OLD (120m) and AGED (110m), same session so not counted as session drops
    expect(dropped.open).toBe(1);
    expect(dropped.session).toBe(0);
  });

  it("keeps an anchor exactly at the age limit", () => {
    const { anchors } = hydratePendingAnchors(
      { X: anchor("LONG", 1, "2026-10-23T08:00:00Z") },
      { now: T("2026-10-23T09:00:00Z"), maxAgeMin: 60, isOpen: never },
    );
    expect(anchors.size).toBe(1);
  });

  it("drops malformed rows instead of trusting them", () => {
    const { anchors, dropped } = hydratePendingAnchors(
      {
        A: undefined as any,
        B: { side: "SIDEWAYS", price: 1, time: T("2026-10-23T08:00:00Z") } as any,
        C: { side: "LONG", price: Number.NaN, time: T("2026-10-23T08:00:00Z") } as any,
        D: { side: "LONG", price: 1 } as any,
        E: anchor("LONG", 1, "2026-10-23T08:30:00Z"),
      },
      { now: T("2026-10-23T08:45:00Z"), maxAgeMin: 120, isOpen: never },
    );
    expect([...anchors.keys()]).toEqual(["E"]);
    expect(dropped.invalid).toBe(4);
  });

  it("handles an empty or missing map", () => {
    for (const stored of [undefined, null, {}] as const) {
      const { anchors, dropped } = hydratePendingAnchors(stored as any, {
        now: T("2026-10-23T08:00:00Z"),
        maxAgeMin: 120,
        isOpen: never,
      });
      expect(anchors.size).toBe(0);
      expect(dropped).toEqual({ invalid: 0, session: 0, aged: 0, open: 0 });
    }
  });
});

describe("describePendingDrops", () => {
  it("says nothing when nothing was dropped", () => {
    expect(describePendingDrops({ invalid: 0, session: 0, aged: 0, open: 0 })).toBe("");
  });

  it("names the session drop first — it is the one the operator needs to see", () => {
    const s = describePendingDrops({ invalid: 1, session: 2, aged: 3, open: 4 });
    expect(s).toContain("2 cross-session anchor(s) cleared");
    expect(s.indexOf("cross-session")).toBeLessThan(s.indexOf("aged"));
  });
});
