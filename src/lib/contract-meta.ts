/**
 * MEXC contract-detail fetch, shared by the live broker and the paper engine.
 * Parsing lives in ./entry-guards (pure, tested). This module only does I/O.
 */
import { parseContractMeta, type ContractParse } from "./entry-guards";
import { toMexcSymbol } from "./tracked-pairs";
import { pacedFetch } from "./mexc/rate-gate";

export const MEXC_CONTRACT_HOST = "https://contract.mexc.com";
const META_TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { parsed: ContractParse; at: number }>();

export async function contractMetaFull(coin: string): Promise<ContractParse> {
  const cached = cache.get(coin);
  if (cached && Date.now() - cached.at < META_TTL_MS) return cached.parsed;
  // Paced with every other MEXC read (2026-10-21): this endpoint used to bypass
  // fetchJsonRetry entirely, so it was invisible to both the backoff and the
  // shared pacing — a signal-qualified coin could spend its burst budget here.
  const res = await pacedFetch(`${MEXC_CONTRACT_HOST}/api/v1/contract/detail?symbol=${toMexcSymbol(coin)}`);
  if (!res.ok) throw new Error(`contract detail HTTP ${res.status}`);
  const json: any = await res.json();
  const row = Array.isArray(json?.data) ? json.data[0] : json?.data;
  const parsed = parseContractMeta(row);
  cache.set(coin, { parsed, at: Date.now() });
  return parsed;
}
