import { describe, it, expect } from "vitest";
import { layer1MetricsValidator } from "../../convex/marketData";
import schema from "../../convex/schema";

/**
 * Guard for the 2026-09-16 P0: a pair-metric field was added to the
 * Layer-1 tick WRITER (marketDataTick → recordLayer1Tick args) but not to the
 * mutation's validator. Convex validators throw on undeclared fields, so every
 * batched tick write failed and the whole Layer-1 table went stale (all pairs
 * at once). These tests pin three things together:
 *
 *   1. The shared `layer1MetricsValidator` (what recordLayer1Tick accepts)
 *   2. What the tick writer actually sends (computeMetricsForPair → metricsMap)
 *   3. The `layer1Ticks` schema validator (what the DB will store)
 *
 * Contract: writer ⊆ validator = schema. Adding a field anywhere but the
 * shared validator now fails a test instead of every 5-min cron tick.
 * Introspects the Convex validator objects directly (VObject.fields /
 * isOptional are public API of convex::values) so no DB round-trip is needed.
 */

// ── Cached validator introspection (module-load work, shared by all tests) ──

// recordLayer1Tick's per-pair metrics validator (the shared const).
const mutationFields = (layer1MetricsValidator as any).fields as Record<
  string,
  { kind: string; isOptional?: string }
>;

// The layer1Ticks schema's per-pair metrics validator:
// schema.tables.layer1Ticks.validator.fields.metrics (VRecord).value (VObject).fields
const schemaFields = ((schema as any).tables.layer1Ticks.validator.fields.metrics
  .value as any).fields as Record<string, { kind: string; isOptional?: string }>;

// Exactly what the tick writer maps into metricsMap per pair
// (marketData.computeMetricsForPair → marketDataTick). Keep in sync with that
// object — a key here without a validator above is the P0 shape.
const writerSends = [
  "spreadPct",
  "imbalance",
  "flowBias",
  "flowValid",
  "fundingRate",
  "fundingValid",
  "atrPct",
  "candleRangePct",
  "vol24h",
  "oi",
] as const;

// ── Tests ──

describe("recordLayer1Tick validator", () => {
  it("declares every core numeric field the tick writer sends", () => {
    const core = [
      "spreadPct",
      "imbalance",
      "flowBias",
      "fundingRate",
      "atrPct",
      "candleRangePct",
      "vol24h",
    ];
    for (const f of core) {
      expect(mutationFields[f], `missing required field: ${f}`).toBeDefined();
      // v.number() reports kind "float64" (Convex numbers are IEEE-754 doubles)
      expect(mutationFields[f].kind).toBe("float64");
      expect(mutationFields[f].isOptional).toBe("required");
    }
  });

  it("accepts the optional fields the writer may add (flowValid, fundingValid, oi)", () => {
    for (const f of ["flowValid", "fundingValid", "oi"]) {
      expect(mutationFields[f], `missing optional field: ${f}`).toBeDefined();
      expect(mutationFields[f].isOptional, `${f} must be v.optional`).toBe("optional");
    }
  });

  it("rejects nothing the writer sends: every writer field has a validator entry", () => {
    const missing = writerSends.filter((f) => mutationFields[f] === undefined);
    // This is the exact P0 shape: a writer field with no validator entry makes
    // Convex throw "Object contains extra property" on EVERY tick write.
    expect(missing, `writer fields missing from recordLayer1Tick validator: ${missing.join(", ")}`).toEqual([]);
  });

  it("mutation validator and layer1Ticks schema declare the same metrics fields", () => {
    expect(Object.keys(mutationFields).sort()).toEqual(Object.keys(schemaFields).sort());
  });

  it("schema marks the same fields optional as the mutation validator", () => {
    for (const f of Object.keys(mutationFields)) {
      expect(schemaFields[f]?.isOptional, `${f} optionality must match schema`).toBe(
        mutationFields[f].isOptional,
      );
    }
  });

  it("keeps the full field contract visible in test output (snapshot)", () => {
    // On any intentional change to the tick shape, update this list AND the
    // validator AND the schema AND computeMetricsForPair together.
    expect(Object.keys(mutationFields).sort()).toEqual(
      [...writerSends].sort(),
    );
  });
});
