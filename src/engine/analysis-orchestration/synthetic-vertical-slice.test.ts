import { afterEach, describe, expect, it } from "vitest";
import type { EmploymentSnapshot } from "../facts/snapshot.ts";
import type { RuleInputMappingRegistry } from "../rule-input/mapping-registry.ts";
import type { SyntheticVerticalSliceRequest } from "./synthetic-vertical-slice.ts";
import {
  successfulSyntheticVerticalRequest,
  syntheticCanonicalSnapshot,
  syntheticRuleInputMappingRegistry,
} from "./synthetic-fixtures.ts";
import { runSyntheticVerticalSlice } from "./synthetic-vertical-slice.ts";

const originalTimezone = process.env.TZ;
const originalLanguage = process.env.LANG;

afterEach(() => {
  process.env.TZ = originalTimezone;
  process.env.LANG = originalLanguage;
});

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function clone<T>(value: T): Mutable<T> {
  return JSON.parse(JSON.stringify(value)) as Mutable<T>;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
    );
  }
  return value;
}

function reorderedRequest(): SyntheticVerticalSliceRequest {
  const snapshot = reverseObjectKeys(clone(syntheticCanonicalSnapshot)) as EmploymentSnapshot;
  snapshot.facts.reverse();
  const mapping = reverseObjectKeys(
    clone(syntheticRuleInputMappingRegistry),
  ) as Mutable<RuleInputMappingRegistry>;
  mapping.mappings.reverse();
  const request = reverseObjectKeys(clone(successfulSyntheticVerticalRequest)) as SyntheticVerticalSliceRequest;
  return { ...request, employment_snapshot: snapshot, mapping_registry: mapping };
}

describe("internal synthetic vertical slice", () => {
  it("runs Canonical Snapshot through preparation, readiness, and the existing runtime", () => {
    const output = runSyntheticVerticalSlice(successfulSyntheticVerticalRequest);
    expect(output.preparation.result.status).toBe("ready");
    expect(output.readiness).toMatchObject({
      gate_version: "1.0.0",
      status: "ready",
      rejection_codes: [],
      usable_by_synthetic_runtime: true,
    });
    expect(output.record).toMatchObject({
      record_kind: "internal_synthetic_evaluation",
      record_version: "1.0.0",
      status: "succeeded",
      classification: {
        is_finding: false,
        is_eligibility_decision: false,
        is_customer_report: false,
        external_persistence: "not_permitted",
      },
    });
    expect(output.trace?.output).toEqual({
      kind: "decimal",
      value: "2.68",
      unit: "synthetic.point",
    });
    expect(output.record.trace_sha256).toBe(output.record.runtime_result?.output_hash);
    expect(output.preparation.result.input_snapshot.snapshot_sha256).toBe(
      "6c75faa9e8b6a94d9acbb4e2f7b017c623bae9296f16d2fd81c2d38b695f26fa",
    );
    expect(output.preparation.result.mapping_registry_sha256).toBe(
      "d136be74dbe11574626922a6f4ae3de01d2373861ff2eb9e96c4329e81e51a4f",
    );
    expect(output.preparation.preparation_sha256).toBe(
      "0bf931cd2d8c69d0d4e59a22cc77a4185e22a4fd1e9a726f75b3dc9464f610ee",
    );
    expect(output.readiness.checked_sha256).toBe(
      "7332c9f0e267835b79846ae9cd29784c5a05fdf4bd57ec3373423dd6399c374d",
    );
    expect(output.record.trace_sha256).toBe(
      "8e30aa9b54840ba1f72a7b732038e72e205ca3edd675444c72cef1547854f4f4",
    );
    expect(output.record_sha256).toBe(
      "b7721337962f74d8bcdf638b03ce0259e73c1b2dcaab749b71b4d2a7bdb155ee",
    );
    expect(Buffer.byteLength(output.canonical_record_bytes, "utf8")).toBe(1_804);
    expect(output.canonical_record_bytes).not.toContain("undefined");
    expect(Object.isFrozen(output.record)).toBe(true);
  });

  it("replays byte-identically across timezone, locale, key order, fact order, and mapping order", () => {
    process.env.TZ = "Pacific/Honolulu";
    process.env.LANG = "tr_TR.UTF-8";
    const first = runSyntheticVerticalSlice(successfulSyntheticVerticalRequest);

    process.env.TZ = "Asia/Tokyo";
    process.env.LANG = "de_DE.UTF-8";
    const second = runSyntheticVerticalSlice(reorderedRequest());

    expect(second.preparation.result.input_snapshot).toEqual(first.preparation.result.input_snapshot);
    expect(second.preparation.preparation_sha256).toBe(first.preparation.preparation_sha256);
    expect(second.readiness.checked_sha256).toBe(first.readiness.checked_sha256);
    expect(second.record_sha256).toBe(first.record_sha256);
    expect(second.canonical_record_bytes).toBe(first.canonical_record_bytes);
    expect(second.trace).toEqual(first.trace);
  });

  it("stops before runtime and publishes no partial inputs or trace when preparation rejects", () => {
    const request = clone(successfulSyntheticVerticalRequest);
    request.employment_snapshot.facts = request.employment_snapshot.facts.filter(
      (fact) => fact.path !== "work.regular_hours",
    );
    const output = runSyntheticVerticalSlice(request);
    expect(output.preparation.result.status).toBe("rejected");
    expect(output.preparation.result.values).toEqual([]);
    expect(output.readiness.status).toBe("rejected");
    expect(output.record.status).toBe("rejected");
    expect(output.record.runtime_result).toBeNull();
    expect(output.record.trace_sha256).toBeNull();
    expect(output.trace).toBeNull();
  });

  it("stops at readiness when the mapping and synthetic rule contracts differ", () => {
    const request = clone(successfulSyntheticVerticalRequest);
    request.rule.inputs[0].fact_path = "synthetic.signal.changed";
    const output = runSyntheticVerticalSlice(request);
    expect(output.preparation.result.status).toBe("ready");
    expect(output.readiness.rejection_codes).toContain("readiness.rule_input_contract_mismatch");
    expect(output.record.runtime_result).toBeNull();
    expect(output.trace).toBeNull();
  });

  it("retains an internal rejection but no trace when the existing runtime rejects", () => {
    const request = clone(successfulSyntheticVerticalRequest);
    request.execution_policy.minimum_confidence_basis_points = 9_500;
    const alpha = request.employment_snapshot.facts.find((fact) => fact.path === "work.regular_hours");
    if (alpha === undefined) throw new Error("fixture_fact_missing");
    alpha.confidence = 0.9;
    request.mapping_registry.mappings.forEach((mapping) => {
      mapping.minimum_confidence = 0.8;
    });
    const output = runSyntheticVerticalSlice(request);
    expect(output.preparation.result.status).toBe("ready");
    expect(output.readiness.status).toBe("ready");
    expect(output.record.status).toBe("rejected");
    expect(output.record.runtime_result?.rejection_codes).toContain("FACT_LOW_CONFIDENCE");
    expect(output.record.trace_sha256).toBeNull();
    expect(output.trace).toBeNull();
  });

  it("rejects non-basis-point confidence instead of rounding or guessing", () => {
    const request = clone(successfulSyntheticVerticalRequest);
    const alpha = request.employment_snapshot.facts.find((fact) => fact.path === "work.regular_hours");
    if (alpha === undefined) throw new Error("fixture_fact_missing");
    alpha.confidence = 0.90001;
    const output = runSyntheticVerticalSlice(request);
    expect(output.preparation.result.status).toBe("ready");
    expect(output.readiness.rejection_codes).toContain("readiness.confidence_precision_unsupported");
    expect(output.record.runtime_result).toBeNull();
  });
});
