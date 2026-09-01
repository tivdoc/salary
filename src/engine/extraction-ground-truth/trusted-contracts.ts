import { z } from "zod";
import type { GroundTruthManifest } from "../wave2/contracts.ts";
import { isoTimestampSchema } from "../domain/primitives.ts";
import { canonicalSha256, deepFreeze } from "../rule-runtime/canonical.ts";
import { humanTrustIdSchema } from "../legal-operations/human-trust.ts";
import { legalOperationsIdSchema, legalOperationsSha256Schema } from "../legal-operations/contracts.ts";
import { validateGroundTruthManifest } from "./validation.ts";

export const TRUSTED_GT_SCHEMA = "tivdoc-trusted-ground-truth-v0.10.0" as const;

export const groundTruthVisualEligibilitySchema = z.object({
  schema_version: z.literal(TRUSTED_GT_SCHEMA),
  eligibility_id: legalOperationsIdSchema,
  document_sha256: legalOperationsSha256Schema,
  catalog_boundary: z.enum(["synthetic_test_only", "real_inactive"]),
  visual_review: z.enum(["completed_eligible", "not_eligible"]),
  license_gate: z.enum(["authorized_for_private_evaluation", "not_authorized"]),
  pii_gate: z.enum(["private_handling_controls_verified", "controls_not_verified"]),
  decision: z.enum(["eligible", "rejected"]),
  reviewer_id: humanTrustIdSchema,
  reviewer_role: z.literal("human_ground_truth_eligibility_reviewer"),
  decided_at: isoTimestampSchema,
  reason_code: z.string().regex(/^[A-Z][A-Z0-9_]{2,99}$/),
  signature_sha256: legalOperationsSha256Schema,
}).strict().superRefine((decision, context) => {
  const allGatesPass = decision.visual_review === "completed_eligible" && decision.license_gate === "authorized_for_private_evaluation" && decision.pii_gate === "private_handling_controls_verified";
  if ((decision.decision === "eligible") !== allGatesPass) context.addIssue({ code: "custom", message: "ground_truth_visual_license_pii_gate_mismatch" });
}).readonly();

export type GroundTruthVisualEligibility = z.infer<typeof groundTruthVisualEligibilitySchema>;

export type TrustedGroundTruthEvent = Readonly<{
  schema_version: typeof TRUSTED_GT_SCHEMA;
  sequence: number;
  event_id: string;
  event_kind: "visual_eligibility_recorded" | "annotation_1_signed" | "annotation_2_signed" | "disagreement_recorded" | "adjudication_signed" | "ground_truth_locked";
  manifest_id: string | null;
  revision: number | null;
  document_sha256: string;
  actor_id: string;
  manifest_sha256: string | null;
  envelope_sha256: string | null;
  prior_event_sha256: string | null;
  event_sha256: string;
}>;

export type GroundTruthAction = "annotation_1" | "annotation_2" | "human_adjudication" | "lock";

export function trustedGroundTruthActionPayload(action: GroundTruthAction, prior: GroundTruthManifest | null, next: GroundTruthManifest) {
  const validatedNext = validateGroundTruthManifest(next);
  const payload = {
    schema_version: TRUSTED_GT_SCHEMA,
    action,
    manifest_id: validatedNext.manifest_id,
    revision: validatedNext.revision,
    document_sha256: validatedNext.document_sha256,
    prior_manifest_sha256: prior === null ? null : canonicalSha256(validateGroundTruthManifest(prior)),
    resulting_manifest_sha256: canonicalSha256(validatedNext),
  } as const;
  return deepFreeze(payload);
}
