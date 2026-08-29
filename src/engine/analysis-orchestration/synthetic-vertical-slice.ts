import { z } from "zod";
import { domainCodeSchema, isoTimestampSchema, versionSchema } from "../domain/primitives.ts";
import type { EmploymentSnapshot } from "../facts/snapshot.ts";
import { sha256Schema } from "../legal-knowledge/contracts.ts";
import type { RuleInputMappingRegistry } from "../rule-input/mapping-registry.ts";
import { registerRuleInputMappingRegistry } from "../rule-input/mapping-registry.ts";
import { prepareRuleInputs, preparedRuleInputsSchema } from "../rule-input/preparation.ts";
import { createCanonicalRuleInputSnapshot } from "../rule-input/snapshot.ts";
import {
  canonicalSha256,
  canonicalStringify,
  deepFreeze,
} from "../rule-runtime/canonical.ts";
import {
  runtimeExecutionPolicySchema,
  syntheticCalculationTraceSchema,
  syntheticRuleDefinitionSchema,
  type RuntimeExecutionInput,
  type RuntimeExecutionPolicy,
  type RuntimeFactInput,
  type SyntheticRuleDefinition,
} from "../rule-runtime/contracts.ts";
import { SyntheticRuleRegistry } from "../rule-runtime/registry.ts";
import { DeterministicSyntheticRuleRuntime } from "../rule-runtime/runtime.ts";
import { ruleExecutionResultSchema, ruleInputSnapshotSchema } from "../wave1/contracts.ts";

export const syntheticReadinessCodeSchema = z.enum([
  "preparation.rejected",
  "readiness.registry_hash_mismatch",
  "readiness.snapshot_mismatch",
  "readiness.rule_input_missing",
  "readiness.rule_input_unexpected",
  "readiness.rule_input_contract_mismatch",
  "readiness.prepared_input_missing",
  "readiness.prepared_input_unexpected",
  "readiness.prepared_value_mismatch",
  "readiness.confidence_precision_unsupported",
  "readiness.legal_evidence_forbidden",
]);

export const syntheticInputReadinessSchema = z
  .object({
    gate_version: versionSchema,
    status: z.enum(["ready", "rejected"]),
    rejection_codes: z.array(z.union([syntheticReadinessCodeSchema, domainCodeSchema])).readonly(),
    usable_by_synthetic_runtime: z.boolean(),
    checked_sha256: sha256Schema,
  })
  .strict()
  .superRefine((gate, context) => {
    if (gate.status === "ready" && (gate.rejection_codes.length > 0 || !gate.usable_by_synthetic_runtime)) {
      context.addIssue({ code: "custom", message: "ready_gate_requires_no_rejections" });
    }
    if (gate.status === "rejected" && (gate.rejection_codes.length === 0 || gate.usable_by_synthetic_runtime)) {
      context.addIssue({ code: "custom", message: "rejected_gate_requires_reasons" });
    }
  })
  .readonly();

export const internalSyntheticEvaluationRecordSchema = z
  .object({
    record_kind: z.literal("internal_synthetic_evaluation"),
    record_id: z.string().regex(/^internal-eval:[a-f0-9]{64}$/),
    record_version: versionSchema,
    request_id: domainCodeSchema,
    rule_id: domainCodeSchema,
    rule_version: versionSchema,
    rule_content_sha256: sha256Schema,
    execution_policy_version: versionSchema,
    status: z.enum(["succeeded", "rejected"]),
    classification: z
      .object({
        is_finding: z.literal(false),
        is_eligibility_decision: z.literal(false),
        is_customer_report: z.literal(false),
        external_persistence: z.literal("not_permitted"),
      })
      .strict(),
    input_snapshot: ruleInputSnapshotSchema,
    mapping_registry_id: domainCodeSchema,
    mapping_registry_version: versionSchema,
    mapping_registry_sha256: sha256Schema,
    preparation_id: z.string().min(3).max(160),
    preparation_sha256: sha256Schema,
    readiness: syntheticInputReadinessSchema,
    runtime_result: ruleExecutionResultSchema.nullable(),
    trace_sha256: sha256Schema.nullable(),
    generated_at: isoTimestampSchema,
  })
  .strict()
  .superRefine((record, context) => {
    if (record.readiness.status === "rejected" && record.runtime_result !== null) {
      context.addIssue({ code: "custom", message: "rejected_readiness_must_not_invoke_runtime" });
    }
    if (record.status === "succeeded") {
      if (record.runtime_result?.status !== "succeeded" || record.trace_sha256 === null) {
        context.addIssue({ code: "custom", message: "successful_internal_record_requires_runtime_trace" });
      }
    } else if (record.trace_sha256 !== null) {
      context.addIssue({ code: "custom", message: "rejected_internal_record_must_not_expose_trace" });
    }
  })
  .readonly();

export const syntheticVerticalSliceResultSchema = z
  .object({
    preparation: preparedRuleInputsSchema,
    readiness: syntheticInputReadinessSchema,
    record: internalSyntheticEvaluationRecordSchema,
    record_sha256: sha256Schema,
    canonical_record_bytes: z.string().min(2),
    trace: syntheticCalculationTraceSchema.nullable(),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.record.status === "succeeded" && result.trace === null) {
      context.addIssue({ code: "custom", message: "successful_slice_requires_internal_trace" });
    }
    if (result.record.status === "rejected" && result.trace !== null) {
      context.addIssue({ code: "custom", message: "rejected_slice_must_not_expose_partial_trace" });
    }
    if (canonicalSha256(result.record) !== result.record_sha256) {
      context.addIssue({ code: "custom", message: "internal_record_hash_mismatch" });
    }
    if (canonicalStringify(result.record) !== result.canonical_record_bytes) {
      context.addIssue({ code: "custom", message: "internal_record_bytes_mismatch" });
    }
  })
  .readonly();

export type SyntheticInputReadiness = z.infer<typeof syntheticInputReadinessSchema>;
export type InternalSyntheticEvaluationRecord = z.infer<
  typeof internalSyntheticEvaluationRecordSchema
>;
export type SyntheticVerticalSliceResult = z.infer<typeof syntheticVerticalSliceResultSchema>;

export interface SyntheticVerticalSliceRequest {
  readonly request_id: string;
  readonly employment_snapshot: EmploymentSnapshot;
  readonly mapping_registry: RuleInputMappingRegistry;
  readonly rule: SyntheticRuleDefinition;
  readonly execution_policy: RuntimeExecutionPolicy;
  readonly prepared_at: string;
  readonly requested_at: string;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function confidenceBasisPoints(confidence: number): number | null {
  const scaled = confidence * 10_000;
  return Number.isInteger(scaled) ? scaled : null;
}

function uniqueSorted(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}

function evaluateReadiness(
  preparation: z.infer<typeof preparedRuleInputsSchema>,
  registry: ReturnType<typeof registerRuleInputMappingRegistry>,
  rule: SyntheticRuleDefinition,
): SyntheticInputReadiness {
  const codes: string[] = [];
  if (preparation.result.status === "rejected") {
    codes.push("preparation.rejected", ...preparation.result.rejection_codes);
  }
  if (preparation.result.mapping_registry_sha256 !== registry.registry_sha256) {
    codes.push("readiness.registry_hash_mismatch");
  }
  if (
    preparation.result.input_snapshot.snapshot_sha256.length !== 64 ||
    preparation.result.values.some(
      (value) => value.snapshot.snapshot_sha256 !== preparation.result.input_snapshot.snapshot_sha256,
    )
  ) {
    codes.push("readiness.snapshot_mismatch");
  }
  if (rule.required_legal_evidence.length > 0) {
    codes.push("readiness.legal_evidence_forbidden");
  }

  const mappings = new Map(registry.registry.mappings.map((mapping) => [mapping.input_id, mapping]));
  const requirements = new Map(rule.inputs.map((input) => [input.input_id, input]));
  const values = new Map(preparation.result.values.map((value) => [value.input_id, value]));

  for (const requirement of rule.inputs) {
    const mapping = mappings.get(requirement.input_id);
    if (mapping === undefined) {
      codes.push("readiness.rule_input_missing");
      continue;
    }
    const expected = mapping.expected_output;
    if (
      mapping.runtime_fact_path !== requirement.fact_path ||
      expected.kind !== requirement.value_kind ||
      (expected.kind === "decimal" &&
        (expected.unit !== requirement.unit || requirement.currency !== null)) ||
      (expected.kind === "money" &&
        (expected.currency !== requirement.currency || requirement.unit !== null))
    ) {
      codes.push("readiness.rule_input_contract_mismatch");
    }
    const value = values.get(requirement.input_id);
    if (preparation.result.status === "ready" && value === undefined) {
      codes.push("readiness.prepared_input_missing");
    } else if (value !== undefined) {
      if (
        value.value.kind !== requirement.value_kind ||
        (value.value.kind === "decimal" && value.value.unit !== requirement.unit) ||
        (value.value.kind === "money" && value.value.value.currency !== requirement.currency)
      ) {
        codes.push("readiness.prepared_value_mismatch");
      }
      if (confidenceBasisPoints(value.confidence) === null) {
        codes.push("readiness.confidence_precision_unsupported");
      }
    }
  }
  for (const mapping of registry.registry.mappings) {
    if (!requirements.has(mapping.input_id)) codes.push("readiness.rule_input_unexpected");
  }
  for (const value of preparation.result.values) {
    if (!requirements.has(value.input_id)) codes.push("readiness.prepared_input_unexpected");
  }

  const rejectionCodes = uniqueSorted(codes);
  const seed = {
    gate_version: "1.0.0",
    status: rejectionCodes.length === 0 ? "ready" : "rejected",
    rejection_codes: rejectionCodes,
    usable_by_synthetic_runtime: rejectionCodes.length === 0,
    preparation_sha256: preparation.preparation_sha256,
    rule_sha256: canonicalSha256(rule),
  };
  return deepFreeze(
    syntheticInputReadinessSchema.parse({
      gate_version: seed.gate_version,
      status: seed.status,
      rejection_codes: seed.rejection_codes,
      usable_by_synthetic_runtime: seed.usable_by_synthetic_runtime,
      checked_sha256: canonicalSha256(seed),
    }),
  );
}

function runtimeFacts(
  preparation: z.infer<typeof preparedRuleInputsSchema>,
  registry: ReturnType<typeof registerRuleInputMappingRegistry>,
): readonly RuntimeFactInput[] {
  const mappings = new Map(registry.registry.mappings.map((mapping) => [mapping.input_id, mapping]));
  return preparation.result.values.map((value) => {
    const mapping = mappings.get(value.input_id);
    if (mapping === undefined) throw new TypeError("prepared_mapping_missing");
    const confidence = confidenceBasisPoints(value.confidence);
    if (confidence === null) throw new TypeError("confidence_precision_unsupported");
    return {
      input_id: value.input_id,
      fact_id: value.source_fact_id,
      fact_path: mapping.runtime_fact_path,
      status: "confirmed",
      confidence_basis_points: confidence,
      value: value.value,
      provenance: [...value.provenance]
        .map((reference) => {
          const referenceSha256 = canonicalSha256(reference);
          return {
            provenance_id: `prov:${referenceSha256}`,
            kind: "synthetic_fixture" as const,
            reference_sha256: referenceSha256,
          };
        })
        .sort((left, right) => compareStrings(left.provenance_id, right.provenance_id)),
      snapshot: value.snapshot,
    };
  });
}

function buildInternalRecord(
  request: SyntheticVerticalSliceRequest,
  preparation: z.infer<typeof preparedRuleInputsSchema>,
  readiness: SyntheticInputReadiness,
  registry: ReturnType<typeof registerRuleInputMappingRegistry>,
  runtimeResult: z.infer<typeof ruleExecutionResultSchema> | null,
  traceSha256: string | null,
): InternalSyntheticEvaluationRecord {
  const seed = {
    record_kind: "internal_synthetic_evaluation" as const,
    record_version: "1.0.0",
    request_id: request.request_id,
    rule_id: request.rule.rule_id,
    rule_version: request.rule.rule_version,
    rule_content_sha256: canonicalSha256(request.rule),
    execution_policy_version: request.execution_policy.policy_version,
    status: runtimeResult?.status === "succeeded" ? "succeeded" : "rejected",
    classification: {
      is_finding: false,
      is_eligibility_decision: false,
      is_customer_report: false,
      external_persistence: "not_permitted" as const,
    },
    input_snapshot: preparation.result.input_snapshot,
    mapping_registry_id: registry.registry.registry_id,
    mapping_registry_version: registry.registry.registry_version,
    mapping_registry_sha256: registry.registry_sha256,
    preparation_id: preparation.result.preparation_id,
    preparation_sha256: preparation.preparation_sha256,
    readiness,
    runtime_result: runtimeResult,
    trace_sha256: traceSha256,
    generated_at: request.requested_at,
  };
  return deepFreeze(
    internalSyntheticEvaluationRecordSchema.parse({
      record_id: `internal-eval:${canonicalSha256(seed)}`,
      ...seed,
    }),
  );
}

/**
 * Internal-only synthetic flow. This module exposes no persistence adapter and
 * no Finding/report/eligibility contract.
 */
export function runSyntheticVerticalSlice(
  candidate: SyntheticVerticalSliceRequest,
): SyntheticVerticalSliceResult {
  const request = {
    ...candidate,
    rule: syntheticRuleDefinitionSchema.parse(candidate.rule),
    execution_policy: runtimeExecutionPolicySchema.parse(candidate.execution_policy),
    prepared_at: isoTimestampSchema.parse(candidate.prepared_at),
    requested_at: isoTimestampSchema.parse(candidate.requested_at),
  };
  const snapshot = createCanonicalRuleInputSnapshot(request.employment_snapshot);
  const registry = registerRuleInputMappingRegistry(request.mapping_registry);
  const preparation = prepareRuleInputs(snapshot, registry, request.prepared_at);
  const readiness = evaluateReadiness(preparation, registry, request.rule);

  let runtimeResult: z.infer<typeof ruleExecutionResultSchema> | null = null;
  let trace: z.infer<typeof syntheticCalculationTraceSchema> | null = null;
  if (readiness.status === "ready") {
    const execution: RuntimeExecutionInput = {
      request: {
        request_id: request.request_id,
        rule_id: request.rule.rule_id,
        rule_version: request.rule.rule_version,
        input_snapshot: snapshot.reference,
        legal_evidence: [],
        requested_at: request.requested_at,
        execution_policy_version: request.execution_policy.policy_version,
      },
      facts: runtimeFacts(preparation, registry),
    };
    const runtime = new DeterministicSyntheticRuleRuntime(
      new SyntheticRuleRegistry([request.rule]),
      request.execution_policy,
    );
    const envelope = runtime.execute(execution);
    runtimeResult = envelope.result;
    trace = envelope.trace;
  }

  const traceSha256 = trace === null ? null : canonicalSha256(trace);
  const record = buildInternalRecord(
    request,
    preparation,
    readiness,
    registry,
    runtimeResult,
    traceSha256,
  );
  const canonicalRecordBytes = canonicalStringify(record);
  return deepFreeze(
    syntheticVerticalSliceResultSchema.parse({
      preparation,
      readiness,
      record,
      record_sha256: canonicalSha256(record),
      canonical_record_bytes: canonicalRecordBytes,
      trace,
    }),
  );
}
