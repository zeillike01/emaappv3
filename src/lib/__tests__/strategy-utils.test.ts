import { describe, it, expect } from "vitest";
import {
  resolveSignalBarTime,
  tryAcquireLease,
  duplicateRejection,
} from "../strategy-utils";

describe("resolveSignalBarTime", () => {
  it("returns the last closed bar's closeTime", () => {
    expect(resolveSignalBarTime([{ closeTime: 1000 }, { closeTime: 2000 }, { closeTime: 3000 }])).toBe(3000);
  });

  it("returns null for an empty array — no wall-clock fallback", () => {
    expect(resolveSignalBarTime([])).toBeNull();
  });

  it("returns null when the last bar has no valid closeTime", () => {
    expect(resolveSignalBarTime([{ closeTime: 0 }])).toBeNull();
    expect(resolveSignalBarTime([{ closeTime: undefined }])).toBeNull();
    expect(resolveSignalBarTime([{ closeTime: -5 }])).toBeNull();
    expect(resolveSignalBarTime([])).toBeNull();
  });
});

describe("tryAcquireLease", () => {
  const now = 1_000_000;
  const leaseMs = 25 * 60_000;

  it("acquires when no lease is set", () => {
    expect(tryAcquireLease(undefined, now, leaseMs)).toBe(now + leaseMs);
  });

  it("acquires when the previous lease has expired", () => {
    expect(tryAcquireLease(now - 1, now, leaseMs)).toBe(now + leaseMs);
  });

  it("returns null while a lease is in flight", () => {
    expect(tryAcquireLease(now + 10, now, leaseMs)).toBeNull();
  });

  it("a lease expiring exactly at now is stealable (boundary)", () => {
    expect(tryAcquireLease(now, now, leaseMs)).toBe(now + leaseMs);
  });
});

describe("duplicateRejection", () => {
  it("rejects a re-fired identical signal in any status", () => {
    expect(duplicateRejection(123, true, false)).toBe("duplicate-signal");
    expect(duplicateRejection(123, true, true)).toBe("duplicate-signal"); // precedence over open-position
  });

  it("rejects when an open position exists on the pair", () => {
    expect(duplicateRejection(123, false, true)).toBe("open-position");
  });

  it("rejects on open position even without a signalTime (legacy path)", () => {
    expect(duplicateRejection(undefined, false, true)).toBe("open-position");
  });

  it("allows the insert when nothing exists", () => {
    expect(duplicateRejection(123, false, false)).toBeNull();
    expect(duplicateRejection(undefined, false, false)).toBeNull();
  });
});