#!/usr/bin/env bun
/**
 * CONFIG PREFLIGHT — run this before you deploy, and again before you arm live.
 *
 * WHY. A fork of this project is configured entirely through environment:
 * there is no deployment URL, API key or operator email baked into the source.
 * That is good for safety and bad for discoverability — a missing variable does
 * not fail at build time, it fails at the worst moment instead:
 *
 *   · no VITE_CONVEX_URL   → the UI throws on load
 *   · no OPERATOR_EMAILS   → every settings write is REFUSED (the gate fails closed)
 *   · no MEXC keypair      → the cron ticks run and place nothing
 *   · an empty kline cache → the 4h regime + advisor gates silently stop vetoing
 *
 * This turns those into one readable checklist. It never prints a secret value —
 * only whether the variable is present and well-formed.
 *
 *   bun run setup:check          # human-readable
 *   bun run setup:check --json   # machine-readable
 *
 * Exit 0 = safe to continue. Exit 1 = fix the FAIL lines first.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");

/** Deployment hosts that must never appear in a fork: the reference project. */
const FORBIDDEN = ["tacit-cow-15"];

type Status = "PASS" | "FAIL" | "WARN" | "TODO";
type Row = { status: Status; name: string; detail: string };
const rows: Row[] = [];
const add = (status: Status, name: string, detail: string) => rows.push({ status, name, detail });

/** Minimal .env parser: KEY=VALUE, # comments, no interpolation. */
function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url.slice(0, 40);
  }
}

const envLocal = readEnvFile(path.join(ROOT, ".env.local"));
const envExample = readEnvFile(path.join(ROOT, ".env.example"));
const pick = (key: string) => process.env[key] ?? envLocal[key] ?? "";

// ── 1. Repository hygiene ────────────────────────────────────────────────
const gitignorePath = path.join(ROOT, ".gitignore");
const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
const ignored = (p: string) =>
  new RegExp(`^\\s*${p.replace(/\./g, "\\.")}\\s*$`, "m").test(gitignore);
add(
  ignored(".env.local") && ignored(".env.deploy") ? "PASS" : "FAIL",
  ".gitignore",
  ignored(".env.local") && ignored(".env.deploy")
    ? ".env.local and .env.deploy ignored, so a key cannot be committed by accident"
    : "add .env.local / .env.deploy to .gitignore",
);

const filledExample = Object.entries(envExample).filter(([, v]) => v.length > 0);
add(
  filledExample.length === 0 ? "PASS" : "FAIL",
  ".env.example",
  filledExample.length === 0
    ? "ships names only, every value empty"
    : `has non-empty values: ${filledExample.map(([k]) => k).join(", ")}`,
);

// ── 2. Local client + CLI config ─────────────────────────────────────────
const convexUrl = pick("VITE_CONVEX_URL");
if (!convexUrl) {
  add("FAIL", "VITE_CONVEX_URL", "missing — the browser client cannot start without it");
} else if (FORBIDDEN.some((h) => convexUrl.includes(h))) {
  add("FAIL", "VITE_CONVEX_URL", `${hostOf(convexUrl)} is the REFERENCE deployment — create your own project`);
} else if (!/^https:\/\/[a-z0-9-]+\.convex\.cloud\/?$/i.test(convexUrl)) {
  add("FAIL", "VITE_CONVEX_URL", `not a Convex cloud URL (got ${hostOf(convexUrl)})`);
} else {
  add("PASS", "VITE_CONVEX_URL", hostOf(convexUrl));
}

const deployment = pick("CONVEX_DEPLOYMENT");
const deployKey = process.env.CONVEX_DEPLOY_KEY ?? "";
if (deployment) {
  add("PASS", "CONVEX_DEPLOYMENT", "set");
} else if (deployKey) {
  add("PASS", "CONVEX_DEPLOYMENT", "unset, but CONVEX_DEPLOY_KEY is present (headless deploy)");
} else {
  add(
    "FAIL",
    "CONVEX_DEPLOYMENT",
    "set it in .env.local, or export CONVEX_DEPLOY_KEY for headless deploys",
  );
}

// ── 3. Deployment-side variables (set with `npx convex env set`) ─────────
// These live on the deployment, not in this checkout, so preflight reports what
// still has to be set rather than pretending to verify it.
const deploymentVars: Array<[name: string, required: boolean, why: string]> = [
  ["OPERATOR_EMAILS", true, "gate for every trading write; unset = all writes refused"],
  ["MEXC_API_KEY", true, "futures API key (withdrawals must be DISABLED)"],
  ["MEXC_API_SECRET", true, "futures API secret"],
  ["SITE_URL", true, "public origin used by auth redirects"],
  ["FREEBUFF_EMAIL_API_KEY", false, "email OTP relay for sign-in"],
  ["CRONS_ENABLED", false, 'set to "1" only once the kline cache is seeded'],
  ["JWKS", false, "auth key material (generate per deployment)"],
  ["JWT_PRIVATE_KEY", false, "auth key material (generate per deployment)"],
];
for (const [name, required, why] of deploymentVars) {
  add("TODO", `env:${name}`, `npx convex env set ${name} <value> — ${why}${required ? " [required before deploy]" : " [optional]"}`);
}

// ── 4. Kline cache — gates read it; an empty cache disables some ──────────
const cacheDir = path.join(ROOT, "data", "klines");
const cacheFiles = fs.existsSync(cacheDir)
  ? fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json"))
  : [];
add(
  cacheFiles.length > 0 ? "PASS" : "WARN",
  "kline cache",
  cacheFiles.length > 0
    ? `${cacheFiles.length} file(s) under data/klines`
    : "empty — run `bun run cache:seed`; the 4h regime and advisor gates read cached bars",
);

// ── 5. Report ────────────────────────────────────────────────────────────
const failures = rows.filter((r) => r.status === "FAIL").length;
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ ok: failures === 0, rows }, null, 2));
} else {
  const width = Math.max(...rows.map((r) => r.name.length));
  console.log("\nconfig preflight\n" + "─".repeat(width + 44));
  for (const r of rows) console.log(`  ${r.status.padEnd(4)}  ${r.name.padEnd(width)}  ${r.detail}`);
  console.log("─".repeat(width + 44));
  if (failures > 0) {
    console.log(`\n${failures} blocking problem(s). Fix the FAIL lines, then re-run.\n`);
  } else {
    console.log(
      "\nLocal config OK. TODO lines are deployment-side variables — set them with\n" +
        "`npx convex env set`, and set OPERATOR_EMAILS + the email key BEFORE the first deploy.\n",
    );
  }
}
process.exit(failures === 0 ? 0 : 1);
