import { describe, expect, it } from "vitest";
import type { EmploymentSnapshot } from "../facts/snapshot.ts";
import { canonicalSha256 } from "../rule-runtime/canonical.ts";
import {
  syntheticCanonicalSnapshot,
  syntheticRuleInputMappingRegistry,
} from "../analysis-orchestration/synthetic-fixtures.ts";
import {
  registerRuleInputMappingRegistry,
} from "./mapping-registry.ts";
import { prepareRuleInputs } from "./preparation.ts";
import { createCanonicalRuleInputSnapshot } from "./snapshot.ts";

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

function prepared(
  snapshot = syntheticCanonicalSnapshot,
  registry = syntheticRuleInputMappingRegistry,
  preparedAt = "2040-01-01T01:00:00.000Z",
) {
  return prepareRuleInputs(
    createCanonicalRuleInputSnapshot(snapshot),
    registerRuleInputMappingRegistry(registry),
    preparedAt,
  );
}

describe("canonical RuleInputSnapshot", () => {
  it("binds the canonical existing snapshot schema and ignores only collection order", () => {
    const first = createCanonicalRuleInputSnapshot(syntheticCanonicalSnapshot);
    const reordered = clone(syntheticCanonicalSnapshot);
    reordered.facts.reverse();
    reordered.facts[0].provenance.reverse();
    const second = createCanonicalRuleInputSnapshot(reordered);

    expect(first.reference).toEqual(second.reference);
    expect(first.reference.snapshot_version).toBe("canonical-facts:1.0.0");
    expect(first.reference.snapshot_sha256).toBe(canonicalSha256(first.canonical_snapshot));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.canonical_snapshot.facts)).toBe(true);
  });

  it("changes the snapshot hash for a value, provenance, status, or timestamp change", () => {
    const baseline = createCanonicalRuleInputSnapshot(syntheticCanonicalSnapshot).reference.snapshot_sha256;
    const mutations: EmploymentSnapshot[] = [];

    const value = clone(syntheticCanonicalSnapshot);
    const valueFact = value.facts.find((fact) => fact.path === "work.regular_hours");
    if (valueFact?.path === "work.regular_hours" && valueFact.value !== null) valueFact.value.amount = "2.676";
    mutations.push(value);

    const confidence = clone(syntheticCanonicalSnapshot);
    confidence.facts[0].confidence = 0.99;
    mutations.push(confidence);

    const timestamp = clone(syntheticCanonicalSnapshot);
    timestamp.facts[0].created_at = "2040-01-01T00:00:01.000Z";
    mutations.push(timestamp);

    for (const mutation of mutations) {
      expect(createCanonicalRuleInputSnapshot(mutation).reference.snapshot_sha256).not.toBe(baseline);
    }
  });
});

describe("versioned rule-input mapping and preparation", () => {
  it("canonicalizes registry order and rejects ambiguous mappings", () => {
    const first = registerRuleInputMappingRegistry(syntheticRuleInputMappingRegistry);
    const reordered = clone(syntheticRuleInputMappingRegistry);
    reordered.mappings.reverse();
    const second = registerRuleInputMappingRegistry(reordered);
    expect(first.registry_sha256).toBe(second.registry_sha256);
    expect(first.registry.mappings.map((mapping) => mapping.input_id)).toEqual([
      "signal.alpha",
      "signal.beta",
    ]);
    expect(Object.isFrozen(first.registry.mappings)).toBe(true);

    const duplicate = clone(syntheticRuleInputMappingRegistry);
    duplicate.mappings[1].input_id = duplicate.mappings[0].input_id;
    expect(() => registerRuleInputMappingRegistry(duplicate)).toThrow("mapping_input_id_duplicate");
  });

  it("preserves fact identity, value type, provenance, confidence, state, snapshot, and transformation", () => {
    const output = prepared();
    expect(output.result.status).toBe("ready");
    expect(output.result.rejection_codes).toEqual([]);
    expect(output.rejections).toEqual([]);
    expect(output.result.values).toHaveLength(2);
    const alpha = output.result.values.find((value) => value.input_id === "signal.alpha");
    expect(alpha).toMatchObject({
      fact_path: "work.regular_hours",
      source_fact_id: "44444444-4444-4444-8444-444444444444",
      value: { kind: "decimal", value: "2.675", unit: "hours_per_pay_period" },
      confidence: 1,
      confirmation_state: "confirmed",
      stale: false,
      transformation: {
        transformation_id: "canonical.hours.amount",
        transformation_version: "1.0.0",
      },
    });
    expect(alpha?.provenance).toEqual(
      syntheticCanonicalSnapshot.facts.find((fact) => fact.path === "work.regular_hours")?.provenance,
    );
    expect(alpha?.snapshot).toEqual(output.result.input_snapshot);
    expect(output.preparation_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(output)).toBe(true);
  });

  it.each([
    ["missing", "fact.missing"],
    ["candidate", "fact.unconfirmed"],
    ["needs_confirmation", "fact.unconfirmed"],
    ["rejected", "fact.rejected"],
    ["conflicted", "fact.conflicted"],
  ] as const)("fails closed for %s state with structured replay data", (status, code) => {
    const snapshot = clone(syntheticCanonicalSnapshot);
    const fact = snapshot.facts.find((entry) => entry.path === "work.regular_hours");
    if (fact?.path !== "work.regular_hours") throw new Error("fixture_fact_missing");
    fact.status = status;
    if (status === "missing") fact.value = null;
    if (status === "conflicted") {
      fact.value = null;
      fact.conflicting_fact_ids = [
        "88888888-8888-4888-8888-888888888888",
        "99999999-9999-4999-8999-999999999999",
      ];
    }

    const output = prepared(snapshot);
    expect(output.result.status).toBe("rejected");
    expect(output.result.values).toEqual([]);
    expect(output.result.rejection_codes).toContain(code);
    expect(output.rejections.find((entry) => entry.code === code)).toMatchObject({
      input_id: "signal.alpha",
      fact_path: "work.regular_hours",
      source_fact_id: "44444444-4444-4444-8444-444444444444",
      observed_status: status,
      prepared_at: "2040-01-01T01:00:00.000Z",
    });
  });

  it("fails closed when a required canonical fact path is absent", () => {
    const snapshot = clone(syntheticCanonicalSnapshot);
    snapshot.facts = snapshot.facts.filter((fact) => fact.path !== "work.regular_hours");
    const output = prepared(snapshot);
    expect(output.result.values).toEqual([]);
    expect(output.rejections).toContainEqual(
      expect.objectContaining({
        code: "fact.missing",
        input_id: "signal.alpha",
        source_fact_id: null,
        observed_status: null,
      }),
    );
  });

  it("reports stale, future, and below-threshold facts without publishing partial inputs", () => {
    const stale = prepared(syntheticCanonicalSnapshot, syntheticRuleInputMappingRegistry, "2040-01-01T03:00:01.000Z");
    expect(stale.result.rejection_codes).toContain("fact.stale");
    expect(stale.result.values).toEqual([]);

    const futureSnapshot = clone(syntheticCanonicalSnapshot);
    futureSnapshot.facts[0].created_at = "2040-01-01T02:00:00.000Z";
    const future = prepared(futureSnapshot);
    expect(future.result.rejection_codes).toContain("fact.timestamp_after_preparation");

    const lowSnapshot = clone(syntheticCanonicalSnapshot);
    lowSnapshot.facts[0].confidence = 0.5;
    const low = prepared(lowSnapshot);
    expect(low.result.rejection_codes).toContain("fact.below_confidence_threshold");
    expect(low.rejections.find((entry) => entry.code === "fact.below_confidence_threshold")).toMatchObject({
      observed_confidence: 0.5,
      required_minimum_confidence: 0.9,
    });
  });

  it("permits only registered versioned transformations", () => {
    const unsupported = clone(syntheticRuleInputMappingRegistry);
    unsupported.mappings[0].transformation = {
      transformation_id: "synthetic.guess",
      transformation_version: "1.0.0",
    };
    const unsupportedResult = prepared(syntheticCanonicalSnapshot, unsupported);
    expect(unsupportedResult.result.rejection_codes).toContain("transformation.unsupported");
    expect(unsupportedResult.result.values).toEqual([]);

    const incompatible = clone(syntheticRuleInputMappingRegistry);
    const mapping = incompatible.mappings.find((entry) => entry.input_id === "signal.alpha");
    if (mapping === undefined || mapping.expected_output.kind !== "decimal") throw new Error("fixture_mapping_missing");
    mapping.expected_output.unit = "synthetic.point";
    const incompatibleResult = prepared(syntheticCanonicalSnapshot, incompatible);
    expect(incompatibleResult.result.rejection_codes).toContain("transformation.failed");
    expect(incompatibleResult.result.values).toEqual([]);
  });
});
