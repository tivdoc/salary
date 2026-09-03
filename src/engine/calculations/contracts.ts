import { z } from "zod";
import {
  decimalStringSchema,
  domainCodeSchema,
  isoDateSchema,
  isoTimestampSchema,
  moneySchema,
  uuidSchema,
  versionSchema,
} from "../domain/primitives.ts";
import { factPathSchema } from "../facts/fact-paths.ts";
import { ruleReferenceSchema } from "../rules/contracts.ts";

export const calculationValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("money"), value: moneySchema }).strict(),
  z
    .object({
      kind: z.literal("decimal"),
      value: decimalStringSchema,
      unit: domainCodeSchema,
    })
    .strict(),
  z.object({ kind: z.literal("integer"), value: z.number().int().safe() }).strict(),
  z.object({ kind: z.literal("date"), value: isoDateSchema }).strict(),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
  z.object({ kind: z.literal("text"), value: z.string().max(2_000) }).strict(),
]);

export const calculationInputSchema = z
  .object({
    input_id: domainCodeSchema,
    fact_id: uuidSchema,
    fact_path: factPathSchema,
    value: calculationValueSchema,
  })
  .strict();

export const calculationStepSchema = z
  .object({
    step_id: domainCodeSchema,
    operation: domainCodeSchema,
    input_refs: z.array(domainCodeSchema).min(1),
    result: calculationValueSchema,
    explanation: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const calculationTraceSchema = z
  .object({
    calculation_id: uuidSchema,
    formula_id: domainCodeSchema,
    formula_version: versionSchema,
    rule: ruleReferenceSchema,
    engine_version: versionSchema,
    inputs: z.array(calculationInputSchema).min(1),
    steps: z.array(calculationStepSchema).min(1),
    output: calculationValueSchema,
    calculated_at: isoTimestampSchema,
  })
  .strict()
  .superRefine((trace, context) => {
    const availableRefs = new Set(trace.inputs.map((input) => input.input_id));
    for (const [index, step] of trace.steps.entries()) {
      for (const inputRef of step.input_refs) {
        if (!availableRefs.has(inputRef)) {
          context.addIssue({
            code: "custom",
            message: `Calculation step references unavailable input ${inputRef}`,
            path: ["steps", index, "input_refs"],
          });
        }
      }
      availableRefs.add(step.step_id);
    }
  });

export type CalculationValue = Readonly<z.infer<typeof calculationValueSchema>>;
export type CalculationTrace = Readonly<z.infer<typeof calculationTraceSchema>>;
