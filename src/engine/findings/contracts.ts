import { z } from "zod";
import { calculationTraceSchema } from "../calculations/contracts";
import {
  confidenceSchema,
  dateRangeSchema,
  domainCodeSchema,
  isoTimestampSchema,
  nonNegativeMoneySchema,
  uuidSchema,
} from "../domain/primitives";
import { evidenceReferenceSchema } from "../facts/contracts";
import { ruleReferenceSchema } from "../rules/contracts";

export const findingStatusSchema = z.enum([
  "candidate",
  "needs_confirmation",
  "verified",
  "rejected",
  "blocked",
]);

export const confidenceTierSchema = z.enum(["low", "medium", "high"]);

export const findingSchema = z
  .object({
    finding_id: uuidSchema,
    case_id: uuidSchema,
    analysis_run_id: uuidSchema,
    category: domainCodeSchema,
    status: findingStatusSchema,
    period: dateRangeSchema.nullable(),
    paid: nonNegativeMoneySchema.nullable(),
    expected: nonNegativeMoneySchema.nullable(),
    potential_gap: nonNegativeMoneySchema.nullable(),
    confidence: confidenceSchema,
    confidence_tier: confidenceTierSchema,
    fact_references: z.array(uuidSchema).min(1),
    evidence_references: z.array(evidenceReferenceSchema).min(1),
    rule: ruleReferenceSchema,
    calculation_trace: calculationTraceSchema.nullable(),
    requires_confirmation: z.boolean(),
    created_at: isoTimestampSchema,
  })
  .strict()
  .superRefine((finding, context) => {
    const moneyValues = [finding.paid, finding.expected, finding.potential_gap].filter(
      (money): money is NonNullable<typeof money> => money !== null,
    );
    const monetary = moneyValues.length > 0;
    if (new Set(moneyValues.map((money) => money.currency)).size > 1) {
      context.addIssue({
        code: "custom",
        message: "All monetary values in a finding must use the same currency",
        path: ["potential_gap"],
      });
    }

    if ((finding.expected !== null || finding.potential_gap !== null) && finding.calculation_trace === null) {
      context.addIssue({
        code: "custom",
        message: "Expected amounts and potential gaps require a deterministic calculation trace",
        path: ["calculation_trace"],
      });
    }

    if (
      finding.calculation_trace !== null &&
      (finding.calculation_trace.rule.rule_id !== finding.rule.rule_id ||
        finding.calculation_trace.rule.rule_version !== finding.rule.rule_version)
    ) {
      context.addIssue({
        code: "custom",
        message: "The calculation trace must use the finding's rule version",
        path: ["calculation_trace", "rule"],
      });
    }

    const hasDirectSupport = finding.evidence_references.some(
      (reference) => reference.source_type === "documented" || reference.source_type === "declared",
    );
    if (monetary && !hasDirectSupport) {
      if (
        finding.status !== "needs_confirmation" ||
        finding.confidence_tier !== "low" ||
        !finding.requires_confirmation
      ) {
        context.addIssue({
          code: "custom",
          message: "Inference-only monetary findings must remain low-confidence and require confirmation",
          path: ["evidence_references"],
        });
      }
    }

    if (finding.status === "verified" && finding.requires_confirmation) {
      context.addIssue({
        code: "custom",
        message: "A verified finding cannot still require confirmation",
        path: ["requires_confirmation"],
      });
    }
  });

export type Finding = Readonly<z.infer<typeof findingSchema>>;
