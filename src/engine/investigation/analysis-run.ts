import { z } from "zod";
import { isoTimestampSchema, uuidSchema, versionSchema } from "../domain/primitives";

export const analysisRunTypeSchema = z.enum(["initial_scan", "full_investigation", "shadow"]);
export const analysisRunStateSchema = z.enum([
  "queued",
  "running",
  "waiting_for_customer",
  "partial",
  "blocked",
  "completed",
  "failed",
]);

const terminalRunStates = new Set<z.infer<typeof analysisRunStateSchema>>(["blocked", "completed", "failed"]);

export const analysisRunSchema = z
  .object({
    analysis_run_id: uuidSchema,
    case_id: uuidSchema,
    parent_run_id: uuidSchema.nullable(),
    run_type: analysisRunTypeSchema,
    state: analysisRunStateSchema,
    engine_version: versionSchema,
    contract_version: versionSchema,
    created_at: isoTimestampSchema,
    started_at: isoTimestampSchema.nullable(),
    completed_at: isoTimestampSchema.nullable(),
    failure_code: z.string().trim().min(1).max(160).nullable(),
  })
  .strict()
  .superRefine((run, context) => {
    if (run.parent_run_id === run.analysis_run_id) {
      context.addIssue({ code: "custom", message: "A run cannot be its own parent", path: ["parent_run_id"] });
    }
    if (run.state !== "queued" && run.started_at === null) {
      context.addIssue({ code: "custom", message: "A non-queued run requires a start time", path: ["started_at"] });
    }
    if (run.state === "queued" && run.started_at !== null) {
      context.addIssue({ code: "custom", message: "A queued run cannot already have a start time", path: ["started_at"] });
    }
    if (terminalRunStates.has(run.state) !== (run.completed_at !== null)) {
      context.addIssue({
        code: "custom",
        message: "Exactly terminal runs carry a completion timestamp",
        path: ["completed_at"],
      });
    }
    if ((run.state === "failed") !== (run.failure_code !== null)) {
      context.addIssue({
        code: "custom",
        message: "A failure code is required only for failed runs",
        path: ["failure_code"],
      });
    }
    if (run.started_at !== null && run.started_at < run.created_at) {
      context.addIssue({ code: "custom", message: "A run cannot start before creation", path: ["started_at"] });
    }
    if (run.completed_at !== null && run.started_at !== null && run.completed_at < run.started_at) {
      context.addIssue({ code: "custom", message: "A run cannot complete before it starts", path: ["completed_at"] });
    }
  })
  .readonly();

export type AnalysisRun = z.infer<typeof analysisRunSchema>;
export type AnalysisRunType = z.infer<typeof analysisRunTypeSchema>;
export type AnalysisRunState = z.infer<typeof analysisRunStateSchema>;
