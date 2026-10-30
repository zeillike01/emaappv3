/**
 * SHADOW TAG REVIEW — the journal-time check for the record-only forward test.
 *
 * `bun run lab:shadowcheck` (read-only) audits how the candidate entry
 * filters (src/lib/h4-shadow.ts) WOULD have acted on
 * everything the books
 * have done since they were wired: for each tag, the entered trades that
 * carry it, their R, and what the book would have looked like with the tag's
 * deletion applied. Promotion bar (pre-committed): a tag arms only when its
 * deleted population shows day-paired kept-vs-deleted t ≥ 2.5, or its
 * deletion beats 95% of matched random deletions — and there are enough rows
 * (≥ 30 deleted) to say anything at all.
 *
 * Also prints coverage (how many decision rows carry shadow fields at all) so
 * a wiring failure can't masquerade as a null result: an all-zero audit with
 * 0% coverage means the tags aren't being written, not that they don't fire.
 *
 * Reads paperTrades + liveTrades via `convex data` (read-only); writes nothing.
 */

import { execSync } from "node:child_process";

type Trade = {
  coin: string;
  type: string;
  status: string;
  realizedR?: number;
  r?: number;
  exitTime?: number;
  entryTime: number;
  shadowTags?: string[];
  shadowH4RangePct?: number;
  shadowH4VolLog2?: number;
  shadowRsi7?: number;
};

const mean = (xs: number[]): number => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
const f2 = (x: number): string => (Number.isFinite(x) ? x.toFixed(2) : "  -  ");

function load(table: string): Trade[] {
  const out = execSync(`bunx convex data ${table} --limit 3000 --format jsonLines`, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Trade);
}

function dayPairedT(kept: Trade[], deleted: Trade[]): { t: number; blocks: number } {
  const byBlock = new Map<string, { a: number[]; b: number[] }>();
  const push = (t: Trade, key: "a" | "b"): void => {
    const day = new Date(t.exitTime ?? t.entryTime).toISOString().slice(0, 10);
    const rec = byBlock.get(day) ?? { a: [], b: [] };
    rec[key].push(rOf(t));
    byBlock.set(day, rec);
  };
  for (const t of kept) push(t, "a");
  for (const t of deleted) push(t, "b");
  const diffs: number[] = [];
  for (const rec of byBlock.values()) {
    if (rec.a.length > 0 && rec.b.length > 0) diffs.push(mean(rec.a) - mean(rec.b));
  }
  if (diffs.length < 2) return { t: NaN, blocks: diffs.length };
  const m = mean(diffs);
  const sd = Math.sqrt(diffs.reduce((a, d) => a + (d - m) * (d - m), 0) / (diffs.length - 1));
  const se = sd / Math.sqrt(diffs.length);
  return { t: se === 0 ? 0 : m / se, blocks: diffs.length };
}

const rOf = (t: Trade): number => (typeof t.realizedR === "number" ? t.realizedR : (t.r ?? NaN));

function main(): void {
  console.log("=".repeat(72));
  console.log("SHADOW TAG REVIEW — record-only forward test (lab:shadowcheck)");
  console.log("=".repeat(72));

  for (const table of ["paperTrades", "liveTrades"] as const) {
    let trades: Trade[] = [];
    try {
      trades = load(table);
    } catch (e) {
      console.log(`\n[${table}] load failed: ${(e as Error).message}`);
      continue;
    }
    const tagged = trades.filter((t) => Array.isArray(t.shadowTags));
    const closed = tagged.filter((t) => t.status === "closed" && Number.isFinite(rOf(t)));
    console.log(`\n── ${table}: ${trades.length} rows · ${tagged.length} carry shadow tags (${trades.length ? Math.round((tagged.length / trades.length) * 100) : 0}% coverage) · ${closed.length} closed & scored`);
    if (tagged.length === 0) continue;

    const allTags = new Map<string, number>();
    for (const t of tagged) for (const tag of t.shadowTags!) allTags.set(tag, (allTags.get(tag) ?? 0) + 1);
    console.log("  tag fire counts (all rows, entered or not):");
    for (const [tag, n] of [...allTags.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${tag.padEnd(26)} ${n}`);
    }

    if (closed.length === 0) {
      console.log("  no closed tagged trades yet — forward record still accumulating.");
      continue;
    }

    const baseNet = closed.reduce((a, t) => a + rOf(t), 0);
    console.log(`  closed tagged book: n=${closed.length} netR ${f2(baseNet)} R/t ${f2(mean(closed.map(rOf)))}`);

    for (const tag of [...allTags.keys()]) {
      const withTag = closed.filter((t) => t.shadowTags!.includes(tag));
      const without = closed.filter((t) => !t.shadowTags!.includes(tag));
      if (withTag.length === 0) continue;
      const delNet = withTag.reduce((a, t) => a + rOf(t), 0);
      const wr = (withTag.filter((t) => rOf(t) > 0).length / withTag.length) * 100;
      const dp = dayPairedT(without, withTag);
      console.log(
        `  ${tag.padEnd(26)} deleted n=${String(withTag.length).padStart(4)} netR ${f2(delNet).padStart(8)} R/t ${f2(mean(withTag.map(rOf)))} WR ${f2(wr)}%  | kept R/t ${f2(mean(without.map(rOf)))}  t ${f2(dp.t)} (${dp.blocks} blocks)`,
      );
    }
    console.log("  promotion bar: tag arms only at t ≥ 2.5 (or beats 95% of matched random deletion) with n ≥ 30 deleted.");
  }
  console.log("\n(read-only — no config touched, nothing armed)");
}

main();
