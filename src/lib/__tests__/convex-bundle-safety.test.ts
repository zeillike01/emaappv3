/**
 * CONVEX BUNDLE SAFETY (2026-10-10).
 *
 * Convex bundles every module under `src/convex/` for a V8 isolate and resolves
 * their imports too. A Node built-in reached through the module graph fails the
 * bundle, and therefore the whole `convex deploy` — which is exactly how the
 * instrumentation layer broke two consecutive deploy runs:
 *
 *
 * `tsc` cannot see this (the imports typecheck fine) and neither can any pure
 * unit test: it only shows up in a deploy log. This test closes that gap by
 * walking the real import graph.
 *
 * `node:crypto` is allowed: Convex supports it, and `liveBrokerRuntime.ts` has
 * used it since before this layer existed (it deployed fine).
 */
import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..", "..");

/** Node built-ins a Convex isolate cannot provide. */
const FORBIDDEN = new Set([
  "fs", "path", "os", "child_process", "net", "tls", "http", "https", "zlib",
  "stream", "events", "worker_threads", "readline", "module", "vm", "tty",
  "perf_hooks", "buffer", "assert", "util", "url", "process", "dns", "cluster",
  "v8", "inspector", "repl", "async_hooks", "domain", "string_decoder",
  "timers", "querystring", "constants", "sys", "punycode", "trace_events",
]);

const IMPORT_RE = /^\s*(?:import|export)\b[^;\n]*?from\s+["']([^"']+)["']/gm;
const BARE_IMPORT_RE = /^\s*import\s+["']([^"']+)["']/gm;

function readImports(file: string): string[] {
  let src: string;
  try {
    src = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return [...src.matchAll(IMPORT_RE), ...src.matchAll(BARE_IMPORT_RE)].map((m) => m[1]!);
}

function resolveRelative(spec: string, from: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}.d.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(cand)) return cand;
  }
  return null;
}

/** Every forbidden built-in reachable from `entry`, with its import chain. */
function forbiddenReachable(entry: string): Array<{ spec: string; chain: string[] }> {
  const found: Array<{ spec: string; chain: string[] }> = [];
  const seen = new Set<string>();
  const walk = (file: string, chain: string[]) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of readImports(file)) {
      const bare = spec.startsWith("node:") ? spec.slice(5) : spec;
      const isBuiltin = FORBIDDEN.has(bare) || FORBIDDEN.has(bare.split("/")[0]!);
      if (spec.startsWith("node:") || isBuiltin) {
        if (FORBIDDEN.has(bare) || FORBIDDEN.has(bare.split("/")[0]!)) {
          found.push({ spec, chain: [...chain, file] });
        }
        continue;
      }
      if (spec.startsWith(".")) {
        const next = resolveRelative(spec, file);
        if (next) walk(next, [...chain, file]);
      }
    }
  };
  walk(entry, []);
  return found;
}

describe("nothing bundled into a Convex function may touch the filesystem", () => {
  const convexDir = path.join(ROOT, "src", "convex");
  const entries = fs
    .readdirSync(convexDir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .map((f) => path.join(convexDir, f));

  it("sees every Convex function module", () => {
    expect(entries.length).toBeGreaterThan(20);
  });

  it("no Convex module transitively imports a Node built-in", () => {
    const offenders: string[] = [];
    for (const entry of entries) {
      for (const hit of forbiddenReachable(entry)) {
        const chain = hit.chain
          .map((f) => path.relative(ROOT, f))
          .join(" -> ");
        offenders.push(`${path.relative(ROOT, entry)}\n      ${hit.spec}  via  ${chain}`);
      }
    }
    expect(
      offenders,
      offenders.length
        ? `These imports cannot be bundled for a Convex isolate and will fail \`convex deploy\`:\n\n  ${offenders.join("\n  ")}\n`
        : "",
    ).toEqual([]);
  });

  it("the shared report math is dependency-free (it is bundled into Convex)", () => {
    expect(readImports(path.join(ROOT, "src", "lib", "trade-analytics.ts"))).not.toContain("node:fs");
  });

  it("the guard itself would catch the original break", () => {
    // Sanity: the walker does flag a Node import reached through a relative hop.
    const probe = path.join(ROOT, "src", "lib", "__tests__", "tmp-bundle-probe.ts");
    const inner = path.join(ROOT, "src", "lib", "__tests__", "tmp-bundle-probe-inner.ts");
    fs.writeFileSync(probe, 'import { x } from "./tmp-bundle-probe-inner";\nexport const y = x;\n');
    fs.writeFileSync(inner, 'import fs from "node:fs";\nexport const x = fs;\n');
    try {
      const hits = forbiddenReachable(probe);
      expect(hits.map((h) => h.spec)).toContain("node:fs");
    } finally {
      fs.unlinkSync(probe);
      fs.unlinkSync(inner);
    }
  });
});

/**
 * The other half of the same failure mode: Convex validates schema, index and
 * cron definitions eagerly while bundling the deployment, so a bad definition
 * fails `convex deploy` and nowhere else. Importing them here forces that
 * validation in CI's test step instead of in the deploy log.
 */
describe("the Convex deployment definition constructs eagerly", () => {
  it("schema.ts evaluates and declares the core tables", async () => {
    const mod = await import("../../convex/schema");
    const names = Object.keys((mod.default as { tables: Record<string, unknown> }).tables);
    expect(names.length).toBeGreaterThan(30);
    for (const table of ["paperTrades", "paperAccount", "liveTrades"]) {
      expect(names, `missing table: ${table}`).toContain(table);
    }
  });

  it("crons.ts evaluates", async () => {
    await expect(import("../../convex/crons")).resolves.toBeTruthy();
  });

  it("keeps the DELETED short book out of every registry", async () => {
    // 2026-10-29: the short book was deleted (modules, tables, panel, account
    // queries). This test is the tripwire: if any piece is resurrected, its
    // `short` ledger rows would have no account, no stats doc and no prune —
    // a silent credit bug (see src/lib/books.ts).
    const previous = process.env.CRONS_ENABLED;
    process.env.CRONS_ENABLED = "1";
    vi.resetModules();
    try {
      const { default: crons } = await import("../../convex/crons");
      const registrations = JSON.parse((crons as any).export()) as Record<string, unknown>;
      for (const job of ["short-taker-volume", "short-entry-4h", "short-entry-15m"]) {
        expect(Object.keys(registrations), `still scheduled: ${job}`).not.toContain(job);
      }
      const books = await import("../books");
      expect("SHORT_ENTRY_BOOK" in books).toBe(false);
      expect(books.STATS_BOOKS).not.toContain("short");

      const schema = await import("../../convex/schema");
      const tables = Object.keys((schema.default as { tables: Record<string, unknown> }).tables);
      for (const gone of ["shortTakerVolume", "shortEntryState"]) {
        expect(tables, `table still declared: ${gone}`).not.toContain(gone);
      }

      const paper = await import("../../convex/paperTrading");
      for (const gone of ["getShortStats", "ensureShortStats", "getShortAccount", "ensureShortEntryAccount"]) {
        expect(paper, `paperTrading.${gone} still exists`).not.toHaveProperty(gone);
      }
      // The layer2 and live clocks must be untouched by the deletion.
      expect(registrations["layer2-strategy"]).toBeTruthy();
      expect(registrations["live-entry"]).toBeTruthy();
    } finally {
      if (previous === undefined) delete process.env.CRONS_ENABLED;
      else process.env.CRONS_ENABLED = previous;
      vi.resetModules();
    }
  });
});
