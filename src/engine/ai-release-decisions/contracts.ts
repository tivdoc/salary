import {z} from 'zod';
import {documentReviewInputSchema} from '../document-review/contracts.ts';
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const aiReleaseDecisionMethodSchema=z.object({
 recipe_id:z.string().min(1),recipe_version:z.literal('1'),recipe_sha256:sha,source_policy_sha256:sha,
 interpretation_receipt_sha256:sha,
 source_receipts:z.array(z.object({receipt_sha256:sha,source_version_id:z.string().min(1),artifact_sha256:sha}).strict()).min(1).max(16),
 issued_at:z.iso.datetime(),expires_at:z.iso.datetime(),
}).strict();
export const AI_RELEASE_MAX_DECISION_METHODS=64;
export const aiReleaseDecisionInputSchema=z.object({source:documentReviewInputSchema,methods:z.array(aiReleaseDecisionMethodSchema).max(AI_RELEASE_MAX_DECISION_METHODS),at:z.iso.datetime()}).strict();
export type AiReleaseDecisionMethod=z.infer<typeof aiReleaseDecisionMethodSchema>;
export type AiReleaseDecisionInput=z.infer<typeof aiReleaseDecisionInputSchema>;
