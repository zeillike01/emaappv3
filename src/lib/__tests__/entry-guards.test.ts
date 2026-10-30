import { describe, expect, it } from "vitest";
import {
  entryGuardBlock,
  parseContractMeta,
  riskPctUnset,
  roundPriceToTick,
} from "../entry-guards";

const fullRow = {
  contractSize: 0.001,
  volScale: 0,
  minVol: 1,
  maxVol: 1_000_000,
  volUnit: 1,
  priceUnit: 0.01,
  maxLeverage: 125,
};

describe("parseContractMeta", () => {
  it("reports nothing missing for a complete exchange row", () => {
    const { meta, missing } = parseContractMeta(fullRow);
    expect(missing).toEqual([]);
    expect(meta.priceUnit).toBe(0.01);
    expect(meta.volScale).toBe(0);
  });

  it("reports each absent field instead of inventing it", () => {
    const { missing } = parseContractMeta({ contractSize: 0.001 });
    expect(missing).toEqual(expect.arrayContaining(["volScale", "minVol", "maxVol", "volUnit", "priceUnit", "maxLeverage"]));
    expect(missing).not.toContain("contractSize");
  });

  it("treats a zero or negative exchange value as missing", () => {
    const { missing } = parseContractMeta({ ...fullRow, minVol: 0, contractSize: -1 });
    expect(missing).toEqual(expect.arrayContaining(["minVol", "contractSize"]));
  });

  it("derives the tick from priceScale when priceUnit is absent", () => {
    const { meta, missing } = parseContractMeta({ ...fullRow, priceUnit: undefined, priceScale: 3 });
    expect(missing).not.toContain("priceUnit");
    expect(meta.priceUnit).toBeCloseTo(0.001);
  });

  it("keeps a zero volScale as a real value (zero decimals), not as missing", () => {
    const { missing } = parseContractMeta({ ...fullRow, volScale: 0 });
    expect(missing).not.toContain("volScale");
  });
});

describe("roundPriceToTick", () => {
  it("rounds a price onto the exchange tick", () => {
    expect(roundPriceToTick(100.004, 0.01)).toBeCloseTo(100.0);
    expect(roundPriceToTick(100.006, 0.01)).toBeCloseTo(100.01);
  });

  it("leaves the price unchanged for a non-positive tick", () => {
    expect(roundPriceToTick(100.123, 0)).toBe(100.123);
  });
});

describe("riskPctUnset", () => {
  it("is true for missing, zero, negative, or non-finite risk", () => {
    for (const v of [undefined, null, 0, -1, NaN, Infinity, "1"]) {
      expect(riskPctUnset(v)).toBe(true);
    }
  });

  it("is false for a positive finite risk", () => {
    expect(riskPctUnset(1)).toBe(false);
    expect(riskPctUnset(0.5)).toBe(false);
  });
});

describe("entryGuardBlock", () => {
  const base = { spreadPct: 0.02, signalPrice: 100, entryPrice: 100 };

  it("is off when both limits are unset, even with no spread data", () => {
    expect(entryGuardBlock({ ...base, spreadPct: null, maxSpreadPct: null, maxSlippageBps: null })).toBeNull();
    expect(entryGuardBlock({ ...base, spreadPct: undefined, maxSpreadPct: undefined, maxSlippageBps: undefined })).toBeNull();
  });

  it("blocks a spread above the limit and passes one at or below it", () => {
    expect(entryGuardBlock({ ...base, maxSpreadPct: 0.05, maxSlippageBps: null })).toBeNull();
    expect(entryGuardBlock({ ...base, spreadPct: 0.06, maxSpreadPct: 0.05, maxSlippageBps: null })).toMatch(/spread/);
  });

  it("fails closed when a spread limit is set but the spread is unknown", () => {
    expect(entryGuardBlock({ ...base, spreadPct: null, maxSpreadPct: 0.05, maxSlippageBps: null })).toMatch(/spread unknown/);
  });

  it("blocks slippage above the limit in basis points", () => {
    // 100 -> 100.5 is 50 bps
    expect(entryGuardBlock({ ...base, entryPrice: 100.5, maxSpreadPct: null, maxSlippageBps: 30 })).toMatch(/slippage 50/);
    expect(entryGuardBlock({ ...base, entryPrice: 100.2, maxSpreadPct: null, maxSlippageBps: 30 })).toBeNull();
  });

  it("fails closed when a slippage limit is set but a price is invalid", () => {
    expect(entryGuardBlock({ ...base, signalPrice: 0, maxSpreadPct: null, maxSlippageBps: 30 })).toMatch(/slippage unknown/);
  });
});
