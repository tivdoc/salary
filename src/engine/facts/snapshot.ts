import { z } from "zod";
import { isoTimestampSchema, uuidSchema, versionSchema } from "../domain/primitives";
import { canonicalFactSchema } from "./contracts";

export const employmentSnapshotSchema = z
  .object({
    snapshot_id: uuidSchema,
    case_id: uuidSchema,
    analysis_run_id: uuidSchema,
    schema_version: versionSchema,
    facts: z.array(canonicalFactSchema),
    created_at: isoTimestampSchema,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const factIds = new Set<string>();
    const factPaths = new Set<string>();

    for (const [index, fact] of snapshot.facts.entries()) {
      if (fact.case_id !== snapshot.case_id) {
        context.addIssue({
          code: "custom",
          message: "Every fact in a snapshot must belong to the snapshot case",
          path: ["facts", index, "case_id"],
        });
      }
      if (factIds.has(fact.fact_id)) {
        context.addIssue({
          code: "custom",
          message: "Fact IDs must be unique within a snapshot",
          path: ["facts", index, "fact_id"],
        });
      }
      if (factPaths.has(fact.path)) {
        context.addIssue({
          code: "custom",
          message: "A canonical snapshot may contain only one fact per path",
          path: ["facts", index, "path"],
        });
      }
      factIds.add(fact.fact_id);
      factPaths.add(fact.path);
    }
  })
  .readonly();

export type EmploymentSnapshot = z.infer<typeof employmentSnapshotSchema>;
