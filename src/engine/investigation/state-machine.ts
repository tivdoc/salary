import { z } from "zod";
import { isoTimestampSchema, uuidSchema } from "../domain/primitives";
import { analysisRunStateSchema } from "./analysis-run";

type AnalysisRunState = z.infer<typeof analysisRunStateSchema>;

export const analysisRunTransitions = {
  queued: ["running", "failed"],
  running: ["waiting_for_customer", "partial", "blocked", "completed", "failed"],
  waiting_for_customer: ["running", "blocked", "failed"],
  partial: ["running", "waiting_for_customer", "blocked", "completed", "failed"],
  blocked: [],
  completed: [],
  failed: [],
} as const satisfies Record<AnalysisRunState, readonly AnalysisRunState[]>;

export function isAnalysisRunTransitionAllowed(from: AnalysisRunState, to: AnalysisRunState) {
  return (analysisRunTransitions[from] as readonly AnalysisRunState[]).includes(to);
}

export const analysisRunTransitionSchema = z
  .object({
    analysis_run_id: uuidSchema,
    from: analysisRunStateSchema,
    to: analysisRunStateSchema,
    reason: z.string().trim().min(1).max(2_000),
    occurred_at: isoTimestampSchema,
  })
  .strict()
  .superRefine((transition, context) => {
    if (!isAnalysisRunTransitionAllowed(transition.from, transition.to)) {
      context.addIssue({
        code: "custom",
        message: `Transition ${transition.from} -> ${transition.to} is not allowed`,
        path: ["to"],
      });
    }
  });

export type AnalysisRunTransition = Readonly<z.infer<typeof analysisRunTransitionSchema>>;
