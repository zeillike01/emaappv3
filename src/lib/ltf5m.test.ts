import { describe, expect, test } from "vitest";
import {
  LTF5M_EMA_PERIOD,
  LTF5M_MIN_BARS,
  ltf5mAligned,
  ltf5mGateBlocks,
  ltf5mShadowTag,
} from "./ltf5m";

/** Rising closes: every close above the EMA of its predecessors. */
const rising = (n: number) => Array.from({ length: n }, (_, i) => 100 + i);
/** Falling closes. */
const falling = (n: number) => Array.from({ length: n }, (_, i) => 100 - i);
/** Flat closes: last == EMA → aligned (>= comparison). */
const flat = (n: number) => Array.from({ length: n }, () => 100);

describe("ltf5mAligned", () => {
  test("rising closes → aligned true", () => {
    expect(ltf5mAligned(rising(LTF5M_MIN_BARS))).toBe(true);
  });
  test("falling closes → aligned false", () => {
    expect(ltf5mAligned(falling(LTF5M_MIN_BARS))).toBe(false);
  });
  test("flat closes → aligned true (>= comparison)", () => {
    expect(ltf5mAligned(flat(LTF5M_MIN_BARS))).toBe(true);
  });
  test("below LTF5M_MIN_BARS → null (fail-open)", () => {
    expect(ltf5mAligned(rising(LTF5M_MIN_BARS - 1))).toBeNull();
    expect(ltf5mAligned([])).toBeNull();
  });
  test("non-finite or non-positive close → null (corrupt data)", () => {
    const bad = rising(LTF5M_MIN_BARS);
    bad[bad.length - 1] = NaN;
    expect(ltf5mAligned(bad)).toBeNull();
    const zero = rising(LTF5M_MIN_BARS);
    zero[0] = 0;
    expect(ltf5mAligned(zero)).toBeNull();
  });
});

describe("ltf5mGateBlocks", () => {
  const cfg = { ltf5mGateEnabled: true };
  test("blocks LONG when 5m structure rolled over", () => {
    const block = ltf5mGateBlocks({ closes5m: falling(LTF5M_MIN_BARS), side: "LONG", cfg });
    expect(block).toContain("5m confluence gate");
    expect(block).toContain(`EMA${LTF5M_EMA_PERIOD}`);
  });
  test("allows LONG when aligned", () => {
    expect(ltf5mGateBlocks({ closes5m: rising(LTF5M_MIN_BARS), side: "LONG", cfg })).toBeNull();
  });
  test("never blocks SHORT (untested side)", () => {
    expect(ltf5mGateBlocks({ closes5m: falling(LTF5M_MIN_BARS), side: "SHORT", cfg })).toBeNull();
  });
  test("fails OPEN on short/missing series", () => {
    expect(ltf5mGateBlocks({ closes5m: [], side: "LONG", cfg })).toBeNull();
    expect(ltf5mGateBlocks({ closes5m: rising(5), side: "LONG", cfg })).toBeNull();
  });
  test("disabled config never blocks", () => {
    expect(
      ltf5mGateBlocks({ closes5m: falling(LTF5M_MIN_BARS), side: "LONG", cfg: { ltf5mGateEnabled: false } }),
    ).toBeNull();
  });
});

describe("ltf5mShadowTag", () => {
  test("with → ltf5m-with", () => {
    expect(ltf5mShadowTag(rising(LTF5M_MIN_BARS))).toBe("ltf5m-with");
  });
  test("against → ltf5m-against", () => {
    expect(ltf5mShadowTag(falling(LTF5M_MIN_BARS))).toBe("ltf5m-against");
  });
  test("missing series → null", () => {
    expect(ltf5mShadowTag([])).toBeNull();
  });
});
