import { z } from "zod";
import { domainCodeSchema, uuidSchema } from "../domain/primitives";
import { factPathSchema } from "../facts/fact-paths";
import { ruleReferenceSchema } from "../rules/contracts";

export const hypothesisStatusSchema = z.enum([
  "open",
  "ready_for_analysis",
  "needs_information",
  "confirmed",
  "rejected",
  "not_applicable",
  "blocked",
]);

export const investigationPrioritySchema = z.enum(["low", "medium", "high", "critical"]);

export const investigationHypothesisSchema = z
  .object({
    hypothesis_id: uuidSchema,
    case_id: uuidSchema,
    analysis_run_id: uuidSchema,
    category: domainCodeSchema,
    status: hypothesisStatusSchema,
    priority: investigationPrioritySchema,
    reason: z.string().trim().min(1).max(4_000),
    supporting_fact_ids: z.array(uuidSchema),
    conflicting_fact_ids: z.array(uuidSchema),
    required_fact_paths: z.array(factPathSchema),
    proposed_rules: z.array(ruleReferenceSchema),
  })
  .strict()
  .superRefine((hypothesis, context) => {
    if (hypothesis.status === "ready_for_analysis" && hypothesis.required_fact_paths.length > 0) {
      context.addIssue({
        code: "custom",
        message: "A hypothesis with missing required facts is not ready for analysis",
        path: ["required_fact_paths"],
      });
    }
  });

export const requestedFactSchema = z
  .object({
    fact_path: factPathSchema,
    priority: investigationPrioritySchema,
    reason: z.string().trim().min(1).max(2_000),
    expected_to_materially_change_analysis: z.boolean(),
    status: z.enum(["outstanding", "satisfied", "unavailable"]),
  })
  .strict();

const terminalHypothesisStatuses = new Set<z.infer<typeof hypothesisStatusSchema>>([
  "confirmed",
  "rejected",
  "not_applicable",
  "blocked",
]);

export function canInvestigationStop(
  hypotheses: readonly z.infer<typeof investigationHypothesisSchema>[],
  requestedFacts: readonly z.infer<typeof requestedFactSchema>[],
) {
  const everyHypothesisTerminal =
    hypotheses.length > 0 && hypotheses.every((hypothesis) => terminalHypothesisStatuses.has(hypothesis.status));
  const materialRequestRemains = requestedFacts.some(
    (request) =>
      request.status === "outstanding" &&
      request.expected_to_materially_change_analysis &&
      (request.priority === "high" || request.priority === "critical"),
  );
  return everyHypothesisTerminal && !materialRequestRemains;
}

export type InvestigationHypothesis = Readonly<z.infer<typeof investigationHypothesisSchema>>;
export type RequestedFact = Readonly<z.infer<typeof requestedFactSchema>>;
