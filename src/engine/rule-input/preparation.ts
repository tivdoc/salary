import { z } from "zod";
import {
  calculationValueSchema,
  type CalculationValue,
} from "../calculations/contracts.ts";
import {
  confidenceSchema,
  domainCodeSchema,
  isoTimestampSchema,
} from "../domain/primitives.ts";
import type { CanonicalFact } from "../facts/contracts.ts";
import { factPathSchema } from "../facts/fact-paths.ts";
import { sha256Schema } from "../legal-knowledge/contracts.ts";
import {
  canonicalSha256,
  canonicalStringify,
  deepFreeze,
} from "../rule-runtime/canonical.ts";
import {
  ruleInputPreparationResultSchema,
  ruleInputValueRefSchema,
  type RuleInputPreparationResult,
  type RuleInputValueRef,
} from "../wave2/contracts.ts";
import type { RegisteredRuleInputMappingRegistry, RuleInputMapping } from "./mapping-registry.ts";
import type { CanonicalRuleInputSnapshot } from "./snapshot.ts";

export const ruleInputRejectionCodeSchema = z.enum([
  "fact.missing",
  "fact.conflicted",
  "fact.unconfirmed",
  "fact.rejected",
  "fact.stale",
  "fact.timestamp_after_preparation",
  "fact.below_confidence_threshold",
  "transformation.unsupported",
  "transformation.failed",
]);

export const ruleInputRejectionSchema = z
  .object({
    code: ruleInputRejectionCodeSchema,
    input_id: domainCodeSchema,
    fact_path: factPathSchema,
    source_fact_id: z.string().nullable(),
    observed_status: z
      .enum(["confirmed", "candidate", "conflicted", "missing", "rejected", "needs_confirmation"])
      .nullable(),
    observed_confidence: confidenceSchema.nullable(),
    required_minimum_confidence: confidenceSchema,
    observed_created_at: isoTimestampSchema.nullable(),
    prepared_at: isoTimestampSchema,
    max_age_seconds: z.number().int().nonnegative(),
  })
  .strict()
  .readonly();

export const preparedRuleInputsSchema = z
  .object({
    result: ruleInputPreparationResultSchema,
    rejections: z.array(ruleInputRejectionSchema).readonly(),
    preparation_sha256: sha256Schema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.result.status === "ready" && value.rejections.length > 0) {
      context.addIssue({ code: "custom", message: "ready_preparation_has_structured_rejections" });
    }
    if (value.result.status === "rejected" && value.rejections.length === 0) {
      context.addIssue({ code: "custom", message: "rejected_preparation_requires_structured_rejections" });
    }
  })
  .readonly();

export type RuleInputRejectionCode = z.infer<typeof ruleInputRejectionCodeSchema>;
export type RuleInputRejection = z.infer<typeof ruleInputRejectionSchema>;
export type PreparedRuleInputs = z.infer<typeof preparedRuleInputsSchema>;

const TRANSFORMATION_HOURS_AMOUNT = "canonical.hours.amount@1.0.0";
const HOUR_FACT_PATHS = new Set([
  "work.regular_hours",
  "work.overtime_hours",
  "work.overtime_125_hours",
  "work.overtime_150_hours",
]);

function transformationKey(mapping: RuleInputMapping): string {
  return `${mapping.transformation.transformation_id}@${mapping.transformation.transformation_version}`;
}

function transformFactValue(fact: CanonicalFact, mapping: RuleInputMapping): CalculationValue | null {
  const key = transformationKey(mapping);
  if (key === TRANSFORMATION_HOURS_AMOUNT) {
    if (
      !HOUR_FACT_PATHS.has(fact.path) ||
      mapping.expected_output.kind !== "decimal" ||
      fact.value === null ||
      typeof fact.value !== "object" ||
      !("amount" in fact.value) ||
      !("unit" in fact.value) ||
      typeof fact.value.amount !== "string" ||
      fact.value.unit !== mapping.expected_output.unit
    ) {
      return null;
    }
    return calculationValueSchema.parse({
      kind: "decimal",
      value: fact.value.amount,
      unit: fact.value.unit,
    });
  }

  return null;
}

function isKnownTransformation(mapping: RuleInputMapping): boolean {
  return transformationKey(mapping) === TRANSFORMATION_HOURS_AMOUNT;
}

function issue(
  code: RuleInputRejectionCode,
  mapping: RuleInputMapping,
  fact: CanonicalFact | null,
  preparedAt: string,
): RuleInputRejection {
  return ruleInputRejectionSchema.parse({
    code,
    input_id: mapping.input_id,
    fact_path: mapping.fact_path,
    source_fact_id: fact?.fact_id ?? null,
    observed_status: fact?.status ?? null,
    observed_confidence: fact?.confidence ?? null,
    required_minimum_confidence: mapping.minimum_confidence,
    observed_created_at: fact?.created_at ?? null,
    prepared_at: preparedAt,
    max_age_seconds: mapping.max_age_seconds,
  });
}

function compareRejections(left: RuleInputRejection, right: RuleInputRejection): number {
  const leftKey = `${left.input_id}\u0000${left.code}\u0000${canonicalStringify(left)}`;
  const rightKey = `${right.input_id}\u0000${right.code}\u0000${canonicalStringify(right)}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function factAgeSeconds(factTimestamp: string, preparedAt: string): number {
  return (Date.parse(preparedAt) - Date.parse(factTimestamp)) / 1_000;
}

function confirmationCode(fact: CanonicalFact): RuleInputRejectionCode | null {
  switch (fact.status) {
    case "confirmed":
      return null;
    case "conflicted":
      return "fact.conflicted";
    case "missing":
      return "fact.missing";
    case "rejected":
      return "fact.rejected";
    case "candidate":
    case "needs_confirmation":
      return "fact.unconfirmed";
  }
}

function uniqueSortedCodes(rejections: readonly RuleInputRejection[]): readonly string[] {
  return [...new Set(rejections.map((entry) => entry.code))].sort();
}

function makeResult(
  registry: RegisteredRuleInputMappingRegistry,
  snapshot: CanonicalRuleInputSnapshot,
  preparedAt: string,
  values: readonly RuleInputValueRef[],
  rejections: readonly RuleInputRejection[],
): RuleInputPreparationResult {
  const rejectionCodes = uniqueSortedCodes(rejections);
  const seed = {
    preparation_version: "1.0.0",
    mapping_registry_id: registry.registry.registry_id,
    mapping_registry_version: registry.registry.registry_version,
    mapping_registry_sha256: registry.registry_sha256,
    input_snapshot: snapshot.reference,
    status: rejections.length === 0 ? "ready" : "rejected",
    values: rejections.length === 0 ? values : [],
    rejection_codes: rejectionCodes,
    prepared_at: preparedAt,
  };
  return ruleInputPreparationResultSchema.parse({
    preparation_id: `prep:${canonicalSha256(seed)}`,
    ...seed,
  });
}

/**
 * Strict deterministic preparation. If any required mapping cannot be
 * satisfied, the frozen preparation contract publishes zero partial values.
 */
export function prepareRuleInputs(
  snapshot: CanonicalRuleInputSnapshot,
  registry: RegisteredRuleInputMappingRegistry,
  preparedAt: string,
): PreparedRuleInputs {
  const normalizedPreparedAt = isoTimestampSchema.parse(preparedAt);
  const facts = new Map(
    snapshot.canonical_snapshot.facts.map((fact) => [fact.path, fact] as const),
  );
  const values: RuleInputValueRef[] = [];
  const rejections: RuleInputRejection[] = [];

  for (const mapping of registry.registry.mappings) {
    const fact = facts.get(mapping.fact_path) ?? null;
    if (fact === null) {
      rejections.push(issue("fact.missing", mapping, null, normalizedPreparedAt));
      continue;
    }

    const confirmationIssue = confirmationCode(fact);
    if (confirmationIssue !== null) {
      rejections.push(issue(confirmationIssue, mapping, fact, normalizedPreparedAt));
    }
    const ageSeconds = factAgeSeconds(fact.created_at, normalizedPreparedAt);
    if (ageSeconds < 0) {
      rejections.push(issue("fact.timestamp_after_preparation", mapping, fact, normalizedPreparedAt));
    } else if (ageSeconds > mapping.max_age_seconds) {
      rejections.push(issue("fact.stale", mapping, fact, normalizedPreparedAt));
    }
    if (fact.confidence < mapping.minimum_confidence) {
      rejections.push(issue("fact.below_confidence_threshold", mapping, fact, normalizedPreparedAt));
    }
    if (!isKnownTransformation(mapping)) {
      rejections.push(issue("transformation.unsupported", mapping, fact, normalizedPreparedAt));
    }

    if (rejections.some((entry) => entry.input_id === mapping.input_id)) {
      continue;
    }
    const transformed = transformFactValue(fact, mapping);
    if (transformed === null) {
      rejections.push(issue("transformation.failed", mapping, fact, normalizedPreparedAt));
      continue;
    }
    values.push(
      ruleInputValueRefSchema.parse({
        input_id: mapping.input_id,
        fact_path: fact.path,
        source_fact_id: fact.fact_id,
        value: transformed,
        provenance: fact.provenance,
        confidence: fact.confidence,
        confirmation_state: "confirmed",
        stale: false,
        snapshot: snapshot.reference,
        transformation: mapping.transformation,
      }),
    );
  }

  values.sort((left, right) => (left.input_id < right.input_id ? -1 : left.input_id > right.input_id ? 1 : 0));
  rejections.sort(compareRejections);
  const result = makeResult(registry, snapshot, normalizedPreparedAt, values, rejections);
  const preparationSha256 = canonicalSha256({ result, rejections });
  return deepFreeze(
    preparedRuleInputsSchema.parse({
      result,
      rejections,
      preparation_sha256: preparationSha256,
    }),
  );
}
