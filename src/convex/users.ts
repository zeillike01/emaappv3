import { query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";

/** Current signed-in user (frontend auth hook depends on this). */
export const currentUser = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return {
      subject: identity.subject,
      name: identity.name ?? null,
      email: identity.email ?? null,
      image: identity.pictureUrl ?? null,
    };
  },
});

/**
 * OPERATOR GATE (2026-10-30).
 *
 * WHY THIS EXISTS. Every state-changing mutation used to be reachable by
 * anyone who knew the deployment URL. Two weaker checks were tried and both
 * failed:
 *   - "is signed in" gates nothing, because `Anonymous` is an enabled sign-in
 *     provider (src/convex/auth.ts): a visitor mints a session with one call
 *     and the old `requireLiveOwner` waved them through;
 *   - "has a verified email" gates nothing either: anyone can complete the OTP
 *     flow at an address they control.
 * The only check that means anything is membership of a list the owner
 * controls, supplied by the deployment environment.
 *
 * FAIL CLOSED. With OPERATOR_EMAILS unset, every guarded write is refused.
 * A missing env var must never silently reopen a real-money book.
 *
 * SCOPE. This guards WRITES. Queries stay public so the dashboard renders for
 * a signed-out visitor; nothing here protects the read surface.
 */
export function operatorEmails(
  raw: string | undefined = process.env.OPERATOR_EMAILS,
): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
}

export async function requireOperator(ctx: MutationCtx | QueryCtx) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Sign in before changing trading settings");
  const email = (identity.email ?? "").trim().toLowerCase();
  if (!email) {
    throw new Error(
      "Guest sessions are read-only — sign in with your operator email to change trading settings",
    );
  }
  const allowed = operatorEmails();
  if (allowed.length === 0) {
    throw new Error(
      "Writes are disabled: OPERATOR_EMAILS is not set on this deployment (comma-separated operator emails)",
    );
  }
  if (!allowed.includes(email)) {
    throw new Error(`${email} is not an operator on this deployment`);
  }
  return { subject: identity.subject, email };
}
