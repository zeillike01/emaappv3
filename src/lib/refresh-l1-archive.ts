/**
 * `bun run cache:l1` — age the shared L1 snapshot archive forward.
 *
 * The replay labs read `data/lab/2sided-l1`, a paged dump of Convex's
 * `layer1Ticks`. That archive is the binding constraint on every entry lab:
 * klines go back a year, L1 snapshots only start 2026-09-05 (the day the
 * batched tick write landed), so "more days of archive" means running this
 * periodically and letting it accumulate.
 *
 * Runs the same loader the labs use — completed pages from disk, tail page
 * always re-fetched from the server — and prints the span it found versus the
 * span the cache held. One export call for the tail plus one per new page.
 */
import fs from "node:fs";

import { l1PageFile, L1_DIR, l1Span, lastCachedPage, loadL1Ticks, type L1Page } from "./l1-archive";

/** Span of what is already on disk, without touching the server. */
function spanOnDisk(): { t0: number; t1: number; days: number } {
  const first = l1PageFile(L1_DIR, 0);
  const last = l1PageFile(L1_DIR, lastCachedPage(L1_DIR));
  const row = (file: string, at: "first" | "last") => {
    const page = JSON.parse(fs.readFileSync(file, "utf8")) as L1Page;
    return at === "first" ? page.rows[0]![0] : page.rows[page.rows.length - 1]![0];
  };
  const t0 = row(first, "first");
  const t1 = row(last, "last");
  return { t0, t1, days: (t1 - t0) / 86_400_000 };
}

const before = spanOnDisk();
console.log(
  `on disk: ${new Date(before.t0).toISOString()} -> ${new Date(before.t1).toISOString()} (${before.days.toFixed(2)} d)`,
);

const ticks = loadL1Ticks(true);
const after = l1Span(ticks);
console.log(
  `archive: ${new Date(after.t0).toISOString()} -> ${new Date(after.t1).toISOString()} (${after.days.toFixed(2)} d)`,
);

const pairs = new Set<string>();
for (const [, rows] of ticks) for (const r of rows) pairs.add(r[0]);
console.log(`ticks ${ticks.length} · pairs ${pairs.size} · added ${(after.days - before.days).toFixed(2)} d`);
