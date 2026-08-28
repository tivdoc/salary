import { z } from "zod";
import {
  domainCodeSchema,
  isoDateSchema,
  isoTimestampSchema,
  versionSchema,
} from "../domain/primitives";
import { factPathSchema } from "../facts/fact-paths";

export const ruleReferenceSchema = z
  .object({
    rule_id: domainCodeSchema,
    rule_version: versionSchema,
  })
  .strict();

/** Metadata only. Actual legal tests and formulas are deliberately out of scope. */
export const ruleCatalogEntrySchema = z
  .object({
    ...ruleReferenceSchema.shape,
    title: z.string().trim().min(1).max(300),
    jurisdiction: z.literal("IL"),
    status: z.enum(["draft", "approved", "retired"]),
    valid_from: isoDateSchema,
    valid_through: isoDateSchema.nullable(),
    required_fact_paths: z.array(factPathSchema),
    formula_ids: z.array(domainCodeSchema),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    published_at: isoTimestampSchema.nullable(),
  })
  .strict()
  .superRefine((rule, context) => {
    if (rule.valid_through !== null && rule.valid_through < rule.valid_from) {
      context.addIssue({
        code: "custom",
        message: "A rule cannot end before it becomes valid",
        path: ["valid_through"],
      });
    }
    if (rule.status === "approved" && rule.published_at === null) {
      context.addIssue({
        code: "custom",
        message: "Approved rules require a publication timestamp",
        path: ["published_at"],
      });
    }
  });

export type RuleReference = Readonly<z.infer<typeof ruleReferenceSchema>>;
export type RuleCatalogEntry = Readonly<z.infer<typeof ruleCatalogEntrySchema>>;
