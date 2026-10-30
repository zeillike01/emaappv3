/**
 * ENGINE HEARTBEAT — registry + verdict tests.
 *
 * The heartbeat is the only thing in this project that notices a cron which has
 * STOPPED, and every entry gate in the stack fails open when its input is
 * missing — so a threshold that is too tight pages nothing, and one that is too
 * loose hides a stalled gate behind a green dot. These tests pin the two
 * decisions that actually matter: when silence is stale, and the difference
 * between "never ran" and "ran recently".
 */
import { describe, it, expect } from "vitest";
import {
  HEARTBEAT_JOBS,
  formatHeartbeatAge,
  heartbeatJob,
  heartbeatStaleMs,
  heartbeatStatus,
} from "../heartbeat";

describe("HEARTBEAT_JOBS registry", () => {
  it("keys every job by a unique id (the DB key)", () => {
    const ids = HEARTBEAT_JOBS.map((j) => j.job);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
  });

  it("gives every job a label, a book, a positive cadence and a consequence", () => {
    // "proxy" dropped with the proxy book (2026-09-26).
    const books = ["layer1", "advisor", "live", "paper"];
    for (const job of HEARTBEAT_JOBS) {
      expect(job.label.length, job.job).toBeGreaterThan(0);
      expect(job.everyMin, job.job).toBeGreaterThan(0);
      expect(job.consequence.length, job.job).toBeGreaterThan(10);
      expect(books, job.job).toContain(job.book);
      expect(typeof job.failOpen, job.job).toBe("boolean");
    }
  });

  it("claims fail-open only for the jobs that gate entries", () => {
    // The panel renders "gates that read its output fail open" for these jobs
    // and nothing for the rest. Pinned so the sentence cannot silently spread to
    // a job where it is false (a stalled R-lock stops banking a winner; it does
    // not make any gate permissive).
    const failOpen = HEARTBEAT_JOBS.filter((j) => j.failOpen).map((j) => j.job);
    expect(failOpen.sort()).toEqual(["advisor-1h-tick", "advisor-htf-tick", "layer1-market-data"]);
  });

  it("flags only after MORE than one cadence — a single miss is jitter", () => {
    for (const job of HEARTBEAT_JOBS) {
      expect(job.staleAfterMin, job.job).toBeGreaterThan(job.everyMin);
    }
  });

  it("no longer tracks the retired short book", () => {
    // 2026-10-22: the short book's three clocks were unregistered with the
    // book. A leftover heartbeat entry would render it as a permanently stale
    // job — a warning about something that is supposed to be silent.
    for (const job of ["short-taker-volume", "short-entry-4h", "short-entry-15m"]) {
      expect(heartbeatJob(job), job).toBeUndefined();
    }
  });

  it("puts the 4H advisor stale line exactly at the 5h advisor-freshness window", () => {
    // ADVISOR_MAX_AGE_MS = 5h in liveBroker.ts: past it the 4H veto layer stops
    // vetoing. The warning and the consequence must be the same instant, or the
    // panel would show a green dot while the gate is already permissive.
    const fourHour = heartbeatJob("advisor-htf-tick");
    expect(fourHour?.staleAfterMin).toBe(300);
  });

  it("looks up a job by name, and returns nothing for an unknown one", () => {
    expect(heartbeatJob("live-rlock-tick")?.label).toMatch(/R-lock/i);
    expect(heartbeatJob("nope")).toBeUndefined();
  });
});

describe("heartbeatStaleMs", () => {
  it("converts the job's minutes to ms", () => {
    expect(heartbeatStaleMs("live-rlock-tick")).toBe(12 * 60_000);
    expect(heartbeatStaleMs("layer2-strategy")).toBe(25 * 60_000);
  });

  it("never goes stale for a job it does not know (fail quiet, not fail loud)", () => {
    expect(heartbeatStaleMs("some-future-cron")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("heartbeatStatus", () => {
  const now = 1_700_000_000_000;

  it("reports a missing or zero stamp as never — not as ok", () => {
    for (const bad of [undefined, null, 0, NaN]) {
      expect(heartbeatStatus(bad as any, "live-rlock-tick", now)).toBe("never");
    }
  });

  it("is ok up to and including the stale ceiling, stale past it", () => {
    const ceiling = heartbeatStaleMs("live-rlock-tick"); // 12 min
    expect(heartbeatStatus(now - 60_000, "live-rlock-tick", now)).toBe("ok");
    expect(heartbeatStatus(now - ceiling, "live-rlock-tick", now)).toBe("ok");
    expect(heartbeatStatus(now - ceiling - 1, "live-rlock-tick", now)).toBe("stale");
  });

  it("treats a 5-hour-old 4H advisor stamp as stale (the gate is already permissive)", () => {
    expect(heartbeatStatus(now - 4.9 * 3_600_000, "advisor-htf-tick", now)).toBe("ok");
    expect(heartbeatStatus(now - 5.1 * 3_600_000, "advisor-htf-tick", now)).toBe("stale");
  });

  it("reads a future stamp (clock skew) as ok rather than alarming", () => {
    expect(heartbeatStatus(now + 60_000, "layer1-market-data", now)).toBe("ok");
  });
});

describe("formatHeartbeatAge", () => {
  it("scales s → m → h → d", () => {
    expect(formatHeartbeatAge(5_000)).toBe("5s");
    expect(formatHeartbeatAge(59_000)).toBe("59s");
    expect(formatHeartbeatAge(60_000)).toBe("1m");
    expect(formatHeartbeatAge(59 * 60_000)).toBe("59m");
    expect(formatHeartbeatAge(60 * 60_000)).toBe("1h");
    expect(formatHeartbeatAge(63 * 60_000)).toBe("1h 03m");
    expect(formatHeartbeatAge(24 * 3_600_000)).toBe("1d");
    expect(formatHeartbeatAge(30 * 3_600_000)).toBe("1d 06h");
  });

  it("renders an unknown age as a dash, not as 0s", () => {
    expect(formatHeartbeatAge(undefined)).toBe("—");
    expect(formatHeartbeatAge(null)).toBe("—");
    expect(formatHeartbeatAge(NaN)).toBe("—");
    expect(formatHeartbeatAge(-1)).toBe("—");
  });
});
