/**
 * BLOCKLIST PARITY (2026-09-22) — the paper book's config row has to enforce at
 * least what the live book's row blocks, or every measurement taken on paper is
 * taken on a different strategy than the one that trades.
 *
 * Measured, out-of-sample (src/lib/run-portfolio-gate-lab.ts): the live row
 * blocked 21 pairs and the paper row blocked 2, so paper spent 115 of its next
 * 201 entries on pairs live refuses. Blocked cohort WR 45.3% / +0.223 R vs kept
 * cohort 55.8% / +0.556 R; book maxDD 14.09R → 6.16R.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { blocklistUnion } from "../layer2-signal";

describe("blocklistUnion", () => {
  it("unions, de-duplicates and sorts", () => {
    expect(blocklistUnion(["SOL", "ADA"], ["ADA", "XRP"])).toEqual(["ADA", "SOL", "XRP"]);
    expect(blocklistUnion([], ["DOT"])).toEqual(["DOT"]);
    expect(blocklistUnion(["DOT"], [])).toEqual(["DOT"]);
    expect(blocklistUnion([], [])).toEqual([]);
  });

  it("is monotone: adding a pair to either side can only grow the list", () => {
    const base = blocklistUnion(["JASMY", "PONS"], []);
    const grewLeft = blocklistUnion(["JASMY", "PONS", "ONDO"], []);
    const grewRight = blocklistUnion(["JASMY", "PONS"], ["ONDO"]);
    expect(grewLeft).toEqual(grewRight); // symmetric — neither book is special
    for (const p of base) expect(grewLeft).toContain(p);
    expect(grewLeft.length).toBe(base.length + 1);
  });

  it("cannot shrink from one side alone — the exact failure mode", () => {
    // The live row blocks 21 pairs; the paper row blocks 2. If the paper row is
    // edited to drop one of its own pairs, the live pair still blocks it.
    const live = ["ADA", "ONDO", "XRP"];
    const paper = ["JASMY", "ADA"];
    const union = blocklistUnion(paper, live);
    expect(union).toContain("ADA"); // blocked by live, cannot be dropped by paper
    expect(union).toContain("JASMY"); // blocked by paper, kept
    expect(union).toEqual(["ADA", "JASMY", "ONDO", "XRP"]);
    // And it agrees with a single shared list, so the two books can never
    // disagree about a pair either list has ever carried.
    expect(blocklistUnion(union, live)).toEqual(union);
    expect(blocklistUnion(union, paper)).toEqual(union);
  });

  it("takes a full union without duplicating", () => {
    // 2026-10-26 (user): BOTH stored rows are now empty — coin priority is the
    // only live filter, so the exemption list is a pure mechanism with nothing
    // armed. The de-dup contract still has to hold at real size: the paper book
    // trades every tracked coin, so the very next coin that ranks losing is
    // what repopulates this list.
    const live = [
      "ADA", "ARB", "DOT", "JASMY", "LINK", "ONDO", "PENDLE", "PONS",
      "PYTH", "RENDER", "SEI", "WIF", "WLD", "XRP", "ZEC",
    ];
    const paper: string[] = [];
    const union = blocklistUnion(paper, live);
    expect(union).toEqual(live);
    expect(union.length).toBe(15);
    expect(new Set(union).size).toBe(union.length);
    // And an empty pair of rows resolves to "nothing blocked", not a default.
    expect(blocklistUnion([], [])).toEqual([]);
  });
});

describe("the paper config read enforces the live blocklist", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "convex", "strategyEngine.ts"), "utf8");

  it("merges the live row's list into the paper read", () => {
    expect(src).toContain("merged.blocklist = blocklistUnion(");
    expect(src).toContain('readConfigRow(ctx, "live")');
    // Paper only: the live book already owns its own list, and writing the live
    // row from a paper read would let the validation bed edit what trades.
    expect(src).toMatch(/if \(name !== "live"\) \{/);
  });

  it("has ONE mechanism — no migration writing the list behind the read", () => {
    // A second mechanism (a migration patching the paper row, a cron, a stamp)
    // is how the two lists drifted apart in the first place, and it would race
    // the tick. The union is resolved on read instead.
    expect(src).not.toContain("ensureLayer2BlocklistParity");
    expect(src).not.toContain("layer2-blocklist-parity");
    // It must not patch strategyConfig from the query path at all.
    const cfgStart = src.indexOf("export const getConfig = query({");
    const cfgEnd = src.indexOf("export const getBreakerState = query({");
    expect(cfgStart).toBeGreaterThan(-1);
    expect(cfgEnd).toBeGreaterThan(cfgStart);
    expect(src.slice(cfgStart, cfgEnd)).not.toContain("ctx.db.patch");
  });
});

describe("pairReview surfaces the divergence", () => {
  it("reports both books' lists, not just the paper row's", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "convex", "pairReview.ts"), "utf8");
    // The review DECIDES the blocklist; reporting one row hid a 2-vs-21 split.
    expect(src).toContain('withIndex("by_name", (q) => q.eq("name", "live"))');
    expect(src).toContain("blocklistDivergence");
    expect(src).toContain("liveBlocklist");
  });
});
