/**
 * CONVEX RUNTIME EGRESS (2026-10-17).
 *
 * MEXC's WAF answers every direct fetch from Convex's DEFAULT runtime with 403
 * HTML, while the Node runtime gets clean JSON from the same deployment (see
 * src/convex/marketRelay.ts). That asymmetry is invisible to `tsc` and to any
 * unit test: the code compiles, the call resolves, and the failure only shows
 * up as a silently-degraded field on a live trade — enrichment tags missing,
 * a manual entry refusing to price, a backfill reporting 0 patched.
 *
 * It bit the funding backfill, the live-close analytics backfill, the mining
 * enrichment backfill, the displacement board, the forward-klines proxy and
 * the whole paper entry/close enrichment path — all of them default-runtime
 * files reaching for MEXC directly.
 *
 * THE RULE THIS TEST ENFORCES: a Convex module that does NOT declare
 * `"use node"` may not (a) fetch a MEXC host itself, or (b) import an I/O
 * helper from lib/mexc/mexcFetchers. Reads must go through the Node relay
 * (`marketRelay` via `marketFetch`). Pure helpers — bar arithmetic, not I/O —
 * stay importable anywhere and are allowlisted below by name.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(__dirname, "..", "..", "..");
const CONVEX_DIR = path.join(ROOT, "src", "convex");

/**
 * Exports of lib/mexc/mexcFetchers that do NOT perform I/O. Adding a pure
 * helper to that file is safe; adding one here is the deliberate act of
 * declaring it pure, so a new I/O function can never be silently imported
 * into a default-runtime module.
 */
const PURE_FETCHER_EXPORTS = new Set([
  "fundingRateAtEntry", // matches a settlement to an entry timestamp
  "htfVerdictOf", // maps an already-fetched trend readout to up/down/flat
  "emaSmaSeeded", // seeded EMA/SMA over supplied closes
]);

const OPTIONAL_CHAINING_IMPORT_RE =
  /^[ \t]*(?:import|export)\b[\s\S]*?from\s+["']([^"']+)["']/gm;
const IMPORT_NAMES_RE = /\{([^}]*)\}/;
const NODE_DIRECTIVE_RE = /^[ \t]*["']use node["'];?[ \t]*$/m;
const FIRST_IMPORT_RE = /^[ \t]*(?:import|export)\b/m;

/** Every non-generated .ts module under src/convex. */
function convexModules(): string[] {
  return fs
    .readdirSync(CONVEX_DIR)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .map((f) => path.join(CONVEX_DIR, f));
}

/**
 * Convex decides the runtime per module: `"use node"` must come before any
 * import. A directive that appears later is not a directive — rLockExit.ts
 * sits after a long header comment, which is why position matters here and
 * not mere presence.
 */
function isNodeRuntime(src: string): boolean {
  const directive = src.match(NODE_DIRECTIVE_RE);
  if (!directive) return false;
  const firstImport = src.search(FIRST_IMPORT_RE);
  return firstImport === -1 || directive.index! < firstImport;
}

/**
 * Imported names per module specifier: specifier -> names ([] for
 * default/side-effect). `import type` statements are skipped: types are
 * erased at build time, so marketFetch's `typeof fetchDepth` shape aliases
 * are not an egress path.
 */
function importsOf(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const match of src.matchAll(OPTIONAL_CHAINING_IMPORT_RE)) {
    if (/^[ \t]*(?:import|export)\s+type\b/.test(match[0])) continue;
    const spec = match[1]!;
    const clause = match[0].replace(/\s+from\s+["'][^"']+["']/, "");
    const braces = clause.match(IMPORT_NAMES_RE);
    const names = braces
      ? braces[1]!
          .split(",")
          .map((n) => n.split(/\s+as\s+/)[0]!.trim())
          .filter(Boolean)
      : [];
    out.set(spec, [...(out.get(spec) ?? []), ...names]);
  }
  return out;
}

/** Lines that reach a MEXC host or a MEXC host constant, ignoring comments. */
function directMexcFetchLines(src: string): string[] {
  const hits: string[] = [];
  src.split("\n").forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) return;
    if (/contract\.mexc\.com/.test(trimmed)) hits.push(trimmed);
    else if (/\bfetch\s*\(/.test(trimmed) && /MEXC_[A-Z_]*(BASE|HOST|URL)/.test(trimmed)) {
      hits.push(trimmed);
    }
  });
  return hits;
}

/** I/O fetchers this module imports straight from lib/mexc/mexcFetchers. */
function directFetcherImports(src: string): string[] {
  const offenders: string[] = [];
  for (const [spec, names] of importsOf(src)) {
    if (!/mexcFetchers$/.test(spec)) continue;
    for (const name of names) {
      if (!PURE_FETCHER_EXPORTS.has(name)) offenders.push(`${name} from ${spec}`);
    }
  }
  return offenders;
}

describe("default-runtime Convex modules never call MEXC directly", () => {
  const modules = convexModules().map((file) => {
    const src = fs.readFileSync(file, "utf8");
    return { file, rel: path.relative(ROOT, file), src, node: isNodeRuntime(src) };
  });

  it("sees every Convex module", () => {
    expect(modules.length).toBeGreaterThan(20);
  });

  it("finds the Node-runtime modules it relies on", () => {
    const nodeModules = modules.filter((m) => m.node).map((m) => m.rel);
    for (const expected of [
      "src/convex/marketRelay.ts",
      "src/convex/priceRelay.ts",
      "src/convex/liveBrokerRuntime.ts",
      "src/convex/rLockExit.ts",
    ]) {
      expect(nodeModules, `expected Node runtime: ${expected}`).toContain(expected);
    }
  });

  it("the relay is the only default-runtime module allowed to build MEXC URLs", () => {
    // marketRelay.ts is the Node module that owns the direct MEXC calls; the
    // default-runtime modules below must be free of them.
    const offenders: string[] = [];
    for (const m of modules) {
      if (m.node) continue;
      const lines = directMexcFetchLines(m.src);
      const fetchers = directFetcherImports(m.src);
      if (lines.length || fetchers.length) {
        offenders.push(
          `${m.rel}\n      ${[...lines, ...fetchers].join("\n      ")}`,
        );
      }
    }
    expect(
      offenders,
      offenders.length
        ? `These default-runtime modules reach MEXC directly and will get 403 HTML.\n` +
            `Route them through marketFetch's relay helpers instead:\n\n  ${offenders.join("\n  ")}\n`
        : "",
    ).toEqual([]);
  });

  it("the detector would catch the original break", () => {
    const probe = [
      'const MEXC_FUTURES_BASE = "https://contract.mexc.com";',
      "async function go() {",
      "  const res = await fetch(`${MEXC_FUTURES_BASE}/api/v1/contract/ticker`);",
      "  return res.json();",
      "}",
    ].join("\n");
    expect(directMexcFetchLines(probe).length).toBeGreaterThan(0);
    expect(
      directFetcherImports('import { fetchKlines } from "../lib/mexc/mexcFetchers";'),
    ).toEqual(["fetchKlines from ../lib/mexc/mexcFetchers"]);
    expect(
      directFetcherImports('import { fundingRateAtEntry } from "../lib/mexc/mexcFetchers";'),
    ).toEqual([]);
    // Type-only imports are erased, so the relay's shape aliases are fine.
    expect(
      directFetcherImports('import type { fetchKlines } from "../lib/mexc/mexcFetchers";'),
    ).toEqual([]);
    // A directive after the imports is not a directive.
    expect(isNodeRuntime('import { x } from "y";\n"use node";\n')).toBe(false);
    expect(isNodeRuntime('"use node";\nimport { x } from "y";\n')).toBe(true);
  });

  it("the repaired paths keep their relay wiring", () => {
    const byRel = new Map(modules.map((m) => [m.rel, m]));
    const expectRelayImport = (rel: string, helper: string) => {
      const src = byRel.get(rel)!.src;
      expect(src, `${rel} should import ${helper} from ./marketFetch`).toContain(
        `import { ${helper} } from "./marketFetch"`,
      );
    };
    // The four 2026-10-17 repairs: funding history, live-close analytics,
    // mining enrichment and the displacement board.
    expectRelayImport("src/convex/mining.ts", "relayKlines");
    expectRelayImport("src/convex/displacementScan.ts", "relayKlines");
    expectRelayImport("src/convex/mexcForward.ts", "relayKlines");
    expect(byRel.get("src/convex/liveEngine.ts")!.src).toContain(
      "relayKlines",
    );
    expect(byRel.get("src/convex/paperTrading.ts")!.src).toContain(
      "relayFundingHistory",
    );
  });
});
