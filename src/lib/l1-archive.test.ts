/**
 * Regression tests for the shared L1 archive loader's stale-tail fence.
 *
 * The bug these pin (measured 2026-09-25): a cached page that reached the
 * archive head carries `nextStart: null`. The old loader trusted every cached
 * page, so once a page held that null the walk stopped there on every later
 * run — labs kept replaying the same 17.0-day window while Convex held 20.6
 * days, with no error. A completed page may still be trusted from disk; the
 * LAST cached page must always be asked of the server again.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  l1PageFile,
  l1Span,
  lastCachedPage,
  loadL1Ticks,
  type L1Page,
  type L1Tick,
} from "./l1-archive";

const PAIR_ROW = (pair: string) =>
  [pair, 0.1, 0, 0.01, 0.005, 0.004, 1_000_000, 0.0001, 1] as L1Tick[1][number];
const tick = (t: number, pair = "BTC"): L1Tick => [t, [PAIR_ROW(pair)]];
const page = (rows: L1Tick[], nextStart: number | null): L1Page => ({
  rows,
  count: rows.length,
  nextStart,
});

const dirs: string[] = [];
function tmpArchive(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l1-archive-"));
  dirs.push(dir);
  return dir;
}
function writePage(dir: string, i: number, payload: L1Page): void {
  fs.writeFileSync(l1PageFile(dir, i), JSON.stringify(payload));
}
function readPage(dir: string, i: number): L1Page {
  return JSON.parse(fs.readFileSync(l1PageFile(dir, i), "utf8")) as L1Page;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("loadL1Ticks — stale-tail fence", () => {
  it("re-fetches the tail page and appends pages that appeared behind it", () => {
    const dir = tmpArchive();
    // Completed page (trusted from disk) and the page that once held the head.
    writePage(dir, 0, page([tick(1_000)], 1_001));
    writePage(dir, 1, page([tick(1_001)], null));

    const calls: number[] = [];
    const fetchPage = (startMs: number): L1Page => {
      calls.push(startMs);
      return startMs === 1_001
        ? page([tick(1_001), tick(1_500)], 1_501) // the archive grew behind the null
        : page([tick(1_501)], null);
    };

    const ticks = loadL1Ticks(false, { dir, fetchPage });

    expect(ticks.map((t) => t[0])).toEqual([1_000, 1_001, 1_500, 1_501]);
    // Page 0 came from disk; the tail was re-asked, and the new page followed.
    expect(calls).toEqual([1_001, 1_501]);
    // The refreshed tail is persisted so the next run starts from the new head.
    expect(readPage(dir, 1).count).toBe(2);
    expect(readPage(dir, 1).nextStart).toBe(1_501);
    expect(readPage(dir, 2).rows).toHaveLength(1);
  });

  it("stops at the tail when the server confirms the head", () => {
    const dir = tmpArchive();
    writePage(dir, 0, page([tick(1_000)], 1_001));
    writePage(dir, 1, page([tick(1_001)], null));

    const calls: number[] = [];
    const ticks = loadL1Ticks(false, {
      dir,
      fetchPage: (startMs) => {
        calls.push(startMs);
        return page([tick(1_001)], null);
      },
    });

    expect(ticks.map((t) => t[0])).toEqual([1_000, 1_001]);
    expect(calls).toEqual([1_001]);
  });

  it("does not duplicate a tick a grown page repeats from the page after it", () => {
    const dir = tmpArchive();
    writePage(dir, 0, page([tick(1_000)], 1_001));
    writePage(dir, 1, page([tick(1_001)], 1_500));

    const ticks = loadL1Ticks(false, {
      dir,
      fetchPage: (startMs) => (startMs === 1_001 ? page([tick(1_001), tick(1_500)], null) : page([], null)),
    });

    expect(ticks.map((t) => t[0])).toEqual([1_000, 1_001, 1_500]);
  });

  it("rebuilds every page from the server when the cache is bypassed", () => {
    const dir = tmpArchive();
    writePage(dir, 0, page([tick(1_000)], 1_001));
    writePage(dir, 1, page([tick(1_001)], null));

    const calls: number[] = [];
    const ticks = loadL1Ticks(false, {
      dir,
      noCache: true,
      fetchPage: (startMs) => {
        calls.push(startMs);
        return startMs === 0 ? page([tick(2_000)], 2_001) : page([tick(2_001)], null);
      },
    });

    expect(calls).toEqual([0, 2_001]);
    expect(ticks.map((t) => t[0])).toEqual([2_000, 2_001]);
    expect(readPage(dir, 0).rows[0]![0]).toBe(2_000);
  });

  it("keeps rows the server has already pruned by trusting completed pages", () => {
    const dir = tmpArchive();
    // Page 0 is older than the server's 60-day retention: it must survive.
    writePage(dir, 0, page([tick(500)], 501));
    writePage(dir, 1, page([tick(501)], null));

    const ticks = loadL1Ticks(false, { dir, fetchPage: () => page([tick(501)], null) });
    expect(ticks.map((t) => t[0])).toEqual([500, 501]);
  });

  it("warns when the archive head is stale", () => {
    const dir = tmpArchive();
    writePage(dir, 0, page([tick(0)], null));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    loadL1Ticks(true, { dir, fetchPage: () => page([tick(0)], null), now: 48 * 3_600_000 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("archive head");

    warn.mockClear();
    loadL1Ticks(true, { dir, fetchPage: () => page([tick(0)], null), now: 3_600_000 });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("l1-archive helpers", () => {
  it("finds the last contiguous page", () => {
    const dir = tmpArchive();
    expect(lastCachedPage(dir)).toBe(-1);
    writePage(dir, 0, page([tick(1)], null));
    expect(lastCachedPage(dir)).toBe(0);
    writePage(dir, 1, page([tick(2)], null));
    expect(lastCachedPage(dir)).toBe(1);
    writePage(dir, 3, page([tick(4)], null)); // gap at 2 stops the scan
    expect(lastCachedPage(dir)).toBe(1);
  });

  it("reports the span in days", () => {
    expect(l1Span([]).days).toBe(0);
    expect(l1Span([tick(0), tick(86_400_000)]).days).toBe(1);
  });
});
