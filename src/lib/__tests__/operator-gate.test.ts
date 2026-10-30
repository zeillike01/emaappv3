import { afterEach, describe, expect, it, vi } from "vitest";
import { operatorEmails, requireOperator } from "../../convex/users";

/** Minimal stand-in for a Convex ctx: only `auth` is read by the gate. */
const ctxWith = (identity: unknown) =>
  ({ auth: { getUserIdentity: async () => identity } }) as never;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("operatorEmails", () => {
  it("splits, trims, lowercases and drops empties", () => {
    expect(operatorEmails(" A@X.com , b@y.com,, ")).toEqual(["a@x.com", "b@y.com"]);
  });

  it("is empty when the variable is unset or blank", () => {
    expect(operatorEmails(undefined)).toEqual([]);
    expect(operatorEmails("   ")).toEqual([]);
  });
});

describe("requireOperator", () => {
  it("refuses a signed-out caller", async () => {
    await expect(requireOperator(ctxWith(null))).rejects.toThrow(/Sign in/);
  });

  it("refuses a guest (anonymous) session — the whole point of the gate", async () => {
    const guest = { subject: "user|anon-1", email: undefined };
    await expect(requireOperator(ctxWith(guest))).rejects.toThrow(
      /Guest sessions are read-only/,
    );
  });

  it("refuses a verified email that is not on the allowlist", async () => {
    vi.stubEnv("OPERATOR_EMAILS", "owner@example.com");
    const stranger = { subject: "user|2", email: "stranger@example.com" };
    await expect(requireOperator(ctxWith(stranger))).rejects.toThrow(
      /is not an operator/,
    );
  });

  it("fails closed when the allowlist is unset", async () => {
    vi.stubEnv("OPERATOR_EMAILS", "");
    const owner = { subject: "user|3", email: "owner@example.com" };
    await expect(requireOperator(ctxWith(owner))).rejects.toThrow(
      /OPERATOR_EMAILS is not set/,
    );
  });

  it("admits an allowlisted email, case-insensitively", async () => {
    vi.stubEnv("OPERATOR_EMAILS", "Owner@Example.com");
    const owner = { subject: "user|4", email: "OWNER@example.com" };
    await expect(requireOperator(ctxWith(owner))).resolves.toEqual({
      subject: "user|4",
      email: "owner@example.com",
    });
  });
});
