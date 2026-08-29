import { z } from "zod";
import {
  calculationStepSchema,
  calculationTraceSchema,
  calculationValueSchema,
} from "../calculations/contracts.ts";
import {
  domainCodeSchema,
  versionSchema,
} from "../domain/primitives.ts";
import { sha256Schema } from "../legal-knowledge/contracts.ts";
import { ruleReferenceSchema } from "../rules/contracts.ts";
import {
  legalEvidenceRefSchema,
  ruleExecutionRequestSchema,
  ruleExecutionResultSchema,
  ruleInputSnapshotSchema,
} from "../wave1/contracts.ts";

const stableIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$/);
const syntheticFactPathSchema = z
  .string()
  .regex(/^synthetic\.[a-z0-9]+(?:[._:-][a-z0-9]+)*$/)
  .max(160);

export const runtimeFactStatusSchema = z.enum([
  "confirmed",
  "missing",
  "conflicted",
  "unconfirmed",
]);

export const runtimeFactProvenanceSchema = z
  .object({
    provenance_id: stableIdSchema,
    kind: z.literal("synthetic_fixture"),
    reference_sha256: sha256Schema,
  })
  .strict()
  .readonly();

export const runtimeFactInputSchema = z
  .object({
    input_id: domainCodeSchema,
    fact_id: stableIdSchema,
    fact_path: syntheticFactPathSchema,
    status: runtimeFactStatusSchema,
    confidence_basis_points: z.number().int().min(0).max(10_000),
    value: calculationValueSchema.nullable(),
    provenance: z.array(runtimeFactProvenanceSchema).min(1).readonly(),
    snapshot: ruleInputSnapshotSchema,
  })
  .strict()
  .superRefine((fact, context) => {
    if ((fact.status === "missing" || fact.status === "conflicted") && fact.value !== null) {
      context.addIssue({ code: "custom", message: "unusable_fact_must_not_carry_canonical_value" });
    }
    if ((fact.status === "confirmed" || fact.status === "unconfirmed") && fact.value === null) {
      context.addIssue({ code: "custom", message: "available_fact_requires_value" });
    }
  })
  .readonly();

export const roundingModeSchema = z.enum(["half_even", "half_up", "toward_zero"]);

const inputRequirementSchema = z
  .object({
    input_id: domainCodeSchema,
    fact_path: syntheticFactPathSchema,
    value_kind: z.enum(["decimal", "money"]),
    unit: domainCodeSchema.nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.value_kind === "decimal" && (input.unit === null || input.currency !== null)) {
      context.addIssue({ code: "custom", message: "decimal_input_requires_unit_only" });
    }
    if (input.value_kind === "money" && (input.currency === null || input.unit !== null)) {
      context.addIssue({ code: "custom", message: "money_input_requires_currency_only" });
    }
  })
  .readonly();

const binaryStepShape = {
  step_id: domainCodeSchema,
  left_ref: domainCodeSchema,
  right_ref: domainCodeSchema,
} as const;

export const runtimeOperationSchema = z.discriminatedUnion("operation", [
  z
    .object({
      ...binaryStepShape,
      operation: z.literal("decimal.add"),
      result_unit: domainCodeSchema,
    })
    .strict(),
  z
    .object({
      ...binaryStepShape,
      operation: z.literal("decimal.multiply"),
      result_unit: domainCodeSchema,
    })
    .strict(),
  z.object({ ...binaryStepShape, operation: z.literal("money.add") }).strict(),
  z
    .object({
      step_id: domainCodeSchema,
      operation: z.literal("decimal.round"),
      input_ref: domainCodeSchema,
      scale: z.number().int().min(0).max(18),
      mode: roundingModeSchema,
      result_unit: domainCodeSchema,
    })
    .strict(),
]);

const legalEvidenceRequirementSchema = z
  .object({
    source_id: stableIdSchema,
    source_version_id: z.string().min(3).max(240),
  })
  .strict()
  .readonly();

export const syntheticRuleDefinitionSchema = z
  .object({
    runtime_kind: z.literal("synthetic_only"),
    ...ruleReferenceSchema.shape,
    formula_id: domainCodeSchema,
    formula_version: versionSchema,
    inputs: z.array(inputRequirementSchema).min(1).readonly(),
    operations: z.array(runtimeOperationSchema).min(1).readonly(),
    output_ref: domainCodeSchema,
    required_legal_evidence: z.array(legalEvidenceRequirementSchema).readonly(),
  })
  .strict()
  .readonly();

export const runtimeExecutionPolicySchema = z
  .object({
    policy_version: versionSchema,
    minimum_confidence_basis_points: z.number().int().min(0).max(10_000),
    max_inputs: z.number().int().positive().max(1_000),
    max_steps: z.number().int().positive().max(10_000),
    max_decimal_digits: z.number().int().positive().max(10_000),
  })
  .strict()
  .readonly();

export const runtimeExecutionInputSchema = z
  .object({
    request: ruleExecutionRequestSchema,
    facts: z.array(runtimeFactInputSchema).readonly(),
  })
  .strict()
  .readonly();

export const runtimeTraceInputSchema = z
  .object({
    input_id: domainCodeSchema,
    fact_id: stableIdSchema,
    fact_path: syntheticFactPathSchema,
    value: calculationValueSchema,
    provenance: z.array(runtimeFactProvenanceSchema).min(1).readonly(),
    snapshot: ruleInputSnapshotSchema,
  })
  .strict()
  .readonly();

export const decimalRoundingTraceSchema = z
  .object({
    mode: roundingModeSchema,
    from_scale: z.number().int().nonnegative(),
    to_scale: z.number().int().nonnegative(),
    input: z.string(),
    output: z.string(),
    discarded_digits: z.string().regex(/^\d*$/),
    tie: z.boolean(),
    incremented: z.boolean(),
  })
  .strict()
  .readonly();

export const runtimeTraceStepSchema = calculationStepSchema
  .extend({
    formula_expression: z.string().min(1).max(500),
    rounding: decimalRoundingTraceSchema.nullable(),
  })
  .strict()
  .readonly();

/**
 * A synthetic specialization of the existing Calculation Trace contract.
 * Its inputs deliberately use synthetic paths instead of employment paths.
 */
export const syntheticCalculationTraceSchema = z
  .object({
    ...calculationTraceSchema.shape,
    runtime_kind: z.literal("synthetic_only"),
    calculation_id: stableIdSchema,
    inputs: z.array(runtimeTraceInputSchema).min(1).readonly(),
    steps: z.array(runtimeTraceStepSchema).min(1).readonly(),
    legal_evidence: z.array(legalEvidenceRefSchema).readonly(),
    rule_content_sha256: sha256Schema,
    execution_policy_version: versionSchema,
  })
  .strict()
  .superRefine((trace, context) => {
    const availableRefs = new Set(trace.inputs.map((input) => input.input_id));
    for (const [index, step] of trace.steps.entries()) {
      for (const inputRef of step.input_refs) {
        if (!availableRefs.has(inputRef)) {
          context.addIssue({
            code: "custom",
            message: `Synthetic calculation step references unavailable input ${inputRef}`,
            path: ["steps", index, "input_refs"],
          });
        }
      }
      availableRefs.add(step.step_id);
    }
  })
  .readonly();

export const runtimeExecutionEnvelopeSchema = z
  .object({
    result: ruleExecutionResultSchema,
    trace: syntheticCalculationTraceSchema.nullable(),
  })
  .strict()
  .superRefine((envelope, context) => {
    if (envelope.result.status === "succeeded" && envelope.trace === null) {
      context.addIssue({ code: "custom", message: "successful_execution_requires_trace" });
    }
    if (envelope.result.status !== "succeeded" && envelope.trace !== null) {
      context.addIssue({ code: "custom", message: "failed_execution_must_not_expose_partial_trace" });
    }
  })
  .readonly();

export type RuntimeFactInput = z.infer<typeof runtimeFactInputSchema>;
export type RuntimeOperation = z.infer<typeof runtimeOperationSchema>;
export type SyntheticRuleDefinition = z.infer<typeof syntheticRuleDefinitionSchema>;
export type RuntimeExecutionPolicy = z.infer<typeof runtimeExecutionPolicySchema>;
export type RuntimeExecutionInput = z.infer<typeof runtimeExecutionInputSchema>;
export type SyntheticCalculationTrace = z.infer<typeof syntheticCalculationTraceSchema>;
export type RuntimeExecutionEnvelope = z.infer<typeof runtimeExecutionEnvelopeSchema>;
