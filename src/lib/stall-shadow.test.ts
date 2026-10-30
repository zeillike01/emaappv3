import { describe, expect, it } from "vitest";

import {
  STALL_ATR_FLOOR,
  STALL_TAG_CONJ,
  STALL_TAG_LOW_ATR,
  stallShadowTags,
} from "./stall-shadow";

describe("stallShadowTags", () => {
  it("tags the Rule B conjunction on LONG only", () => {
    expect(
      stallShadowTags({ side: "LONG", htfTrend1h: "down", btcTrendAtEntry: "up", atrPctAtEntry: 1.2 }),
    ).toEqual([STALL_TAG_CONJ]);
    // SHORT never carries the conjunction, even aligned.
    expect(
      stallShadowTags({ side: "SHORT", htfTrend1h: "down", btcTrendAtEntry: "up", atrPctAtEntry: 1.2 }),
    ).toEqual([]);
  });

  it("does not fire the conjunction on partial alignment", () => {
    const base = { side: "LONG" as const, atrPctAtEntry: 1.2 };
    expect(stallShadowTags({ ...base, htfTrend1h: "up", btcTrendAtEntry: "up" })).toEqual([]);
    expect(stallShadowTags({ ...base, htfTrend1h: "down", btcTrendAtEntry: "chop" })).toEqual([]);
    expect(stallShadowTags({ ...base, htfTrend1h: "flat", btcTrendAtEntry: "up" })).toEqual([]);
    expect(stallShadowTags({ ...base, htfTrend1h: "down", btcTrendAtEntry: "down" })).toEqual([]);
  });

  it("tags stall tape on both sides below the floor, not at it", () => {
    for (const side of ["LONG", "SHORT"] as const) {
      expect(
        stallShadowTags({ side, htfTrend1h: "up", btcTrendAtEntry: "chop", atrPctAtEntry: STALL_ATR_FLOOR - 0.01 }),
      ).toEqual([STALL_TAG_LOW_ATR]);
      expect(
        stallShadowTags({ side, htfTrend1h: "up", btcTrendAtEntry: "chop", atrPctAtEntry: STALL_ATR_FLOOR }),
      ).toEqual([]);
    }
  });

  it("Rule F union carries both tags when both fire", () => {
    expect(
      stallShadowTags({ side: "LONG", htfTrend1h: "down", btcTrendAtEntry: "up", atrPctAtEntry: 0.1 }),
    ).toEqual([STALL_TAG_CONJ, STALL_TAG_LOW_ATR]);
  });

  it("fails open on missing readings — never infers a stall", () => {
    expect(
      stallShadowTags({ side: "LONG", htfTrend1h: undefined, btcTrendAtEntry: "up", atrPctAtEntry: 1.0 }),
    ).toEqual([]);
    expect(
      stallShadowTags({ side: "LONG", htfTrend1h: "down", btcTrendAtEntry: null, atrPctAtEntry: 1.0 }),
    ).toEqual([]);
    expect(
      stallShadowTags({ side: "LONG", htfTrend1h: "down", btcTrendAtEntry: "up", atrPctAtEntry: undefined }),
    ).toEqual([STALL_TAG_CONJ]);
    expect(
      stallShadowTags({ side: "LONG", htfTrend1h: "down", btcTrendAtEntry: "up", atrPctAtEntry: NaN }),
    ).toEqual([STALL_TAG_CONJ]);
    expect(stallShadowTags({ side: "SHORT", htfTrend1h: undefined, btcTrendAtEntry: undefined, atrPctAtEntry: undefined })).toEqual(
      [],
    );
  });
});
