import { describe, expect, it } from "vitest";
import { bisectBatchWrite, writeErrorMessage } from "../resilient-batch-write";

type Row = { id: string; poison?: boolean };

const poison = (id: string): Row => ({ id, poison: true });
const clean = (id: string): Row => ({ id });

/** Stub writer: throws the validator error when any row in the batch is poisoned. */
function recordingWriter() {
  const calls: Row[][] = [];
  const write = async (batch: Row[]) => {
    calls.push([...batch]);
    if (batch.some((r) => r.poison)) {
      throw new Error(
        "ArgumentValidationError: Object contains extra field `d1StochK` that is not in the validator.",
      );
    }
  };
  return { calls, write };
}

describe("bisectBatchWrite", () => {
  it("writes a clean batch in a single call", async () => {
    const { calls, write } = recordingWriter();
    const rows = [clean("a"), clean("b"), clean("c")];
    const out = await bisectBatchWrite(rows, write);
    expect(out).toEqual({ written: 3, dropped: [] });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(rows);
  });

  it("isolates one poisoned row and lands every clean row (the incident shape)", async () => {
    const { calls, write } = recordingWriter();
    const rows = ["a", "b", "c", "d", "e", "f", "g", "h"].map(clean);
    const bad = poison("bad");
    rows.splice(3, 0, bad);
    const out = await bisectBatchWrite(rows, write);
    expect(out.written).toBe(8);
    expect(out.dropped).toHaveLength(1);
    expect(out.dropped[0]!.row).toEqual(bad);
    expect(out.dropped[0]!.error).toMatch(/extra field/);
    // Every clean row reached the writer through some successful batch.
    const landed = calls
      .filter((b) => !b.some((r) => r.poison))
      .flat()
      .map((r) => r.id);
    expect(landed.sort()).toEqual(rows.filter((r) => !r.poison).map((r) => r.id).sort());
    // The poison was never part of a successful call.
    expect(calls.some((b) => b.some((r) => r.poison))).toBe(true);
    expect(landed).not.toContain("bad");
  });

  it("does not bisect non-validation failures (a systemic outage stays one call)", async () => {
    const calls: Row[][] = [];
    const write = async (batch: Row[]) => {
      calls.push([...batch]);
      throw new Error("Could not find public function `strategyEngine:logRejections`");
    };
    const rows = [clean("a"), clean("b"), clean("c")];
    const out = await bisectBatchWrite(rows, write);
    expect(calls).toHaveLength(1);
    expect(out.written).toBe(0);
    expect(out.dropped).toHaveLength(3);
    expect(out.dropped[0]!.error).toMatch(/Could not find public function/);
  });

  it("reports every row when the whole batch is poisoned", async () => {
    const { write } = recordingWriter();
    const out = await bisectBatchWrite([poison("x"), poison("y")], write);
    expect(out.written).toBe(0);
    expect(out.dropped.map((d) => d.row.id).sort()).toEqual(["x", "y"]);
  });

  it("is a no-op for an empty batch", async () => {
    const { calls, write } = recordingWriter();
    const out = await bisectBatchWrite([], write);
    expect(out).toEqual({ written: 0, dropped: [] });
    expect(calls).toHaveLength(0);
  });
});

describe("writeErrorMessage", () => {
  it("skips Convex's Request-ID header and keeps the actual error line", () => {
    const e = new Error(
      "[Request ID: ab9c76c10a4dca87] Server Error\nArgumentValidationError: Object contains extra field `d1StochK` that is not in the validator.\nPath: .rows[0]\nObject: {...}\nValidator: v.object({...})",
    );
    expect(writeErrorMessage(e)).toBe(
      "ArgumentValidationError: Object contains extra field `d1StochK` that is not in the validator.",
    );
  });

  it("keeps the first meaningful line when already clean", () => {
    const e = new Error("\nArgumentValidationError: Object contains extra field `x`.\nPath: .rows[0]");
    expect(writeErrorMessage(e)).toBe("ArgumentValidationError: Object contains extra field `x`.");
  });

  it("accepts non-Error throwables", () => {
    expect(writeErrorMessage("boom")).toBe("boom");
  });
});
