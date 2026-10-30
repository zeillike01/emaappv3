/**
 * Pure entry guards for Layer 2 (live and paper share these).
 *
 * Rule: a value the exchange or the operator must supply is never invented on
 * the ENTRY path. Missing exchange fields are reported so the entry is skipped
 * with a logged reason. Exit paths keep their conservative values so an open
 * position can always be closed.
 */

export interface ContractMeta {
  contractSize: number;
  volScale: number; // decimal places for order volume
  minVol: number;
  maxVol: number;
  volUnit: number;
  priceUnit: number; // price tick (e.g. 0.01)
  maxLeverage: number;
}

export interface ContractParse {
  meta: ContractMeta;
  /** Field names the exchange did not supply, or supplied as non-positive. */
  missing: string[];
}

const positive = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Parse one MEXC contract/detail row. `meta` keeps the legacy fallback values
 * for exit paths; `missing` lists every field the entry path must refuse on.
 */
export function parseContractMeta(row: any): ContractParse {
  const missing: string[] = [];
  const need = (name: string, raw: unknown, fallback: number): number => {
    const v = positive(raw);
    if (v === null) missing.push(name);
    return v ?? fallback;
  };
  const rawScale = Number(row?.priceScale);
  const rawUnit = positive(row?.priceUnit);
  let priceUnit: number;
  if (rawUnit !== null) priceUnit = rawUnit;
  else if (Number.isFinite(rawScale)) priceUnit = Math.pow(10, -rawScale);
  else {
    missing.push("priceUnit");
    priceUnit = 0.01;
  }
  const volScaleRaw = Number(row?.volScale);
  let volScale: number;
  if (Number.isFinite(volScaleRaw) && volScaleRaw >= 0) volScale = Math.floor(volScaleRaw);
  else {
    missing.push("volScale");
    volScale = 0;
  }
  const meta: ContractMeta = {
    contractSize: need("contractSize", row?.contractSize ?? row?.contSize, 1),
    volScale,
    minVol: need("minVol", row?.minVol, 1),
    maxVol: need("maxVol", row?.maxVol, 10_000_000),
    volUnit: need("volUnit", row?.volUnit, 1),
    priceUnit,
    maxLeverage: need("maxLeverage", row?.maxLeverage, 125),
  };
  return { meta, missing };
}

/** Round a price to the exchange tick. A non-positive tick leaves the price unchanged. */
export function roundPriceToTick(px: number, unit: number): number {
  if (!(unit > 0)) return px;
  const f = Math.round(1 / unit);
  return Math.round(px * f) / f;
}

/** True when the risk percent is unset, so the entry must be skipped (no default size). */
export function riskPctUnset(riskPct: unknown): boolean {
  return !(typeof riskPct === "number" && Number.isFinite(riskPct) && riskPct > 0);
}

export interface EntryGuardInput {
  /** Current bid/ask spread in percent, or null when the book is unavailable. */
  spreadPct: number | null | undefined;
  /** Operator limit in percent. null/undefined = gate off (logged by the caller). */
  maxSpreadPct: number | null | undefined;
  /** Price the decision was made on (last closed bar close). */
  signalPrice: number;
  /** Current price the entry would fill at. */
  entryPrice: number;
  /** Operator limit in basis points. null/undefined = gate off. */
  maxSlippageBps: number | null | undefined;
}

/** Returns the block reason, or null when the entry may proceed. Fails closed when a set limit has no data. */
export function entryGuardBlock(input: EntryGuardInput): string | null {
  if (input.maxSpreadPct != null) {
    if (typeof input.spreadPct !== "number" || !Number.isFinite(input.spreadPct)) {
      return `spread unknown (limit ${input.maxSpreadPct}%)`;
    }
    if (input.spreadPct > input.maxSpreadPct) {
      return `spread ${input.spreadPct.toFixed(4)}% > max ${input.maxSpreadPct}%`;
    }
  }
  if (input.maxSlippageBps != null) {
    if (!(input.signalPrice > 0) || !(input.entryPrice > 0)) {
      return `slippage unknown (limit ${input.maxSlippageBps} bps)`;
    }
    const bps = (Math.abs(input.entryPrice - input.signalPrice) / input.signalPrice) * 10_000;
    if (bps > input.maxSlippageBps) {
      return `slippage ${bps.toFixed(2)} bps > max ${input.maxSlippageBps} bps`;
    }
  }
  return null;
}
