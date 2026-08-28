import { z } from "zod";
import {
  agentNameSchema,
  confidenceSchema,
  dateRangeSchema,
  domainCodeSchema,
  isoDateSchema,
  isoTimestampSchema,
  nonNegativeDecimalStringSchema,
  nonNegativeMoneySchema,
  uuidSchema,
} from "../domain/primitives";
import { factPathSchema } from "./fact-paths";

export const factSourceTypeSchema = z.enum(["documented", "declared", "derived", "inferred"]);
export const factStatusSchema = z.enum([
  "confirmed",
  "candidate",
  "conflicted",
  "missing",
  "rejected",
  "needs_confirmation",
]);

const documentLocatorSchema = z
  .object({
    page: z.number().int().positive().optional(),
    text_span: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export const evidenceReferenceSchema = z.discriminatedUnion("source_type", [
  z
    .object({
      source_type: z.literal("documented"),
      source_reference: z
        .object({
          kind: z.literal("document"),
          document_id: uuidSchema,
          locator: documentLocatorSchema.optional(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      source_type: z.literal("declared"),
      source_reference: z.discriminatedUnion("kind", [
        z
          .object({
            kind: z.literal("conversation_message"),
            conversation_id: uuidSchema,
            message_id: uuidSchema,
          })
          .strict(),
        z
          .object({
            kind: z.literal("questionnaire_response"),
            response_id: uuidSchema,
          })
          .strict(),
      ]),
    })
    .strict(),
  z
    .object({
      source_type: z.literal("derived"),
      source_reference: z
        .object({
          kind: z.literal("fact_derivation"),
          derivation_id: domainCodeSchema,
          fact_ids: z.array(uuidSchema).min(1),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      source_type: z.literal("inferred"),
      source_reference: z
        .object({
          kind: z.literal("agent_output"),
          analysis_run_id: uuidSchema,
          agent: agentNameSchema,
          output_id: uuidSchema,
        })
        .strict(),
    })
    .strict(),
]);

export const conflictResolutionSchema = z
  .object({
    method: z.enum(["human_confirmation", "deterministic_precedence"]),
    resolved_by: z.string().trim().min(1).max(160),
    selected_fact_ids: z.array(uuidSchema).min(1),
    rationale: z.string().trim().min(1).max(2_000),
    resolved_at: isoTimestampSchema,
  })
  .strict();

const hoursValueSchema = z
  .object({
    amount: nonNegativeDecimalStringSchema,
    unit: z.enum(["hours_per_day", "hours_per_week", "hours_per_month", "hours_per_pay_period"]),
  })
  .strict();

const workdaysValueSchema = z
  .object({
    days: z
      .array(z.enum(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]))
      .min(1)
      .refine((days) => new Set(days).size === days.length, "Workdays must be unique"),
  })
  .strict();

const pensionContributionSchema = z
  .object({
    amount: nonNegativeMoneySchema.nullable(),
    rate_basis_points: z.number().int().min(0).max(10_000).nullable(),
  })
  .strict()
  .refine(({ amount, rate_basis_points }) => amount !== null || rate_basis_points !== null, {
    message: "A contribution needs an amount or a basis-point rate",
  });

const pensionContributionsValueSchema = z
  .object({
    employee: pensionContributionSchema.nullable(),
    employer: pensionContributionSchema.nullable(),
    period: dateRangeSchema,
  })
  .strict()
  .refine(({ employee, employer }) => employee !== null || employer !== null, {
    message: "At least one pension contribution side is required",
  });

const documentPeriodValueSchema = z
  .object({
    document_id: uuidSchema,
    period: dateRangeSchema,
  })
  .strict();

const factEnvelopeShape = {
  fact_id: uuidSchema,
  case_id: uuidSchema,
  status: factStatusSchema,
  provenance: z.array(evidenceReferenceSchema).min(1),
  confidence: confidenceSchema,
  conflicting_fact_ids: z.array(uuidSchema),
  resolution: conflictResolutionSchema.nullable(),
  created_at: isoTimestampSchema,
} as const;

function factVariant<TPath extends z.infer<typeof factPathSchema>, TValue extends z.ZodType>(
  path: TPath,
  value: TValue,
) {
  return z
    .object({
      ...factEnvelopeShape,
      path: z.literal(path),
      value: value.nullable(),
    })
    .strict();
}

const canonicalFactUnionSchema = z.discriminatedUnion("path", [
  factVariant("employment.start_date", isoDateSchema),
  factVariant("employment.end_date", isoDateSchema),
  factVariant("compensation.salary_type", z.enum(["monthly", "hourly", "mixed"])),
  factVariant("compensation.base_monthly_salary", nonNegativeMoneySchema),
  factVariant("compensation.hourly_rate", nonNegativeMoneySchema),
  factVariant("work.regular_hours", hoursValueSchema),
  factVariant("work.overtime_hours", hoursValueSchema),
  factVariant("work.workdays", workdaysValueSchema),
  factVariant(
    "work.breaks",
    z.object({ minutes_per_shift: z.number().int().min(0).max(1_440) }).strict(),
  ),
  factVariant("pension.base_salary", nonNegativeMoneySchema),
  factVariant("pension.contributions", pensionContributionsValueSchema),
  factVariant("travel.reimbursement", nonNegativeMoneySchema),
  factVariant("convalescence.payment", nonNegativeMoneySchema),
  factVariant("documents.period", documentPeriodValueSchema),
]);

export const canonicalFactSchema = canonicalFactUnionSchema.superRefine((fact, context) => {
  const conflictIds = new Set(fact.conflicting_fact_ids);
  if (conflictIds.has(fact.fact_id)) {
    context.addIssue({
      code: "custom",
      message: "A fact cannot conflict with itself",
      path: ["conflicting_fact_ids"],
    });
  }
  if (conflictIds.size !== fact.conflicting_fact_ids.length) {
    context.addIssue({
      code: "custom",
      message: "Conflicting fact references must be unique",
      path: ["conflicting_fact_ids"],
    });
  }

  if (fact.status === "missing") {
    if (fact.value !== null) {
      context.addIssue({ code: "custom", message: "A missing fact cannot have a value", path: ["value"] });
    }
  } else if (fact.status === "conflicted") {
    if (fact.value !== null) {
      context.addIssue({ code: "custom", message: "A conflicted fact has no canonical value", path: ["value"] });
    }
    if (fact.conflicting_fact_ids.length < 2) {
      context.addIssue({
        code: "custom",
        message: "A conflicted fact must identify at least two conflicting assertions",
        path: ["conflicting_fact_ids"],
      });
    }
    if (fact.resolution !== null) {
      context.addIssue({
        code: "custom",
        message: "A conflicted fact remains unresolved until its status changes explicitly",
        path: ["resolution"],
      });
    }
  } else if (fact.value === null) {
    context.addIssue({ code: "custom", message: "Only missing or conflicted facts may have no value", path: ["value"] });
  }

  if (fact.resolution !== null) {
    if (fact.status !== "confirmed" && fact.status !== "rejected") {
      context.addIssue({
        code: "custom",
        message: "Conflict resolution is only valid on a confirmed or rejected fact",
        path: ["resolution"],
      });
    }
    if (fact.conflicting_fact_ids.length < 2) {
      context.addIssue({
        code: "custom",
        message: "Conflict resolution must retain the conflicting fact references",
        path: ["conflicting_fact_ids"],
      });
    }
    const selectedIds = new Set(fact.resolution.selected_fact_ids);
    if (
      fact.resolution.selected_fact_ids.some((id) => !conflictIds.has(id)) ||
      selectedIds.size !== fact.resolution.selected_fact_ids.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Resolved facts must select unique IDs from the recorded conflict",
        path: ["resolution", "selected_fact_ids"],
      });
    }
  } else if (fact.status === "confirmed" && fact.conflicting_fact_ids.length > 0) {
    context.addIssue({
      code: "custom",
      message: "A conflicting fact cannot become confirmed without explicit resolution metadata",
      path: ["resolution"],
    });
  }
});

export type FactSourceType = z.infer<typeof factSourceTypeSchema>;
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type CanonicalFact = Readonly<z.infer<typeof canonicalFactSchema>>;
