import {z} from 'zod';
import type {generateReviewCompletions} from './completions.ts';
import type {calculateDocumentReview} from './calculations.ts';
import {reviewCompletionSchema,reviewCompletionAnswerReceiptSchema} from './completions.ts';
import {documentReviewCalculationInputSchema} from './calculations.ts';

export const DOCUMENT_REVIEW_POLICY='document-review-product-v1' as const;
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const reviewTopicSchema=z.enum(['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']);
export const reviewDocumentSchema=z.object({
 case_id:z.string().min(1),document_id:z.string().min(1),version_id:z.string().min(1),file_sha256:sha,
 page_count:z.number().int().positive().nullable(),kind:z.enum(['payslip','attendance','contract','transfer','other']),
 label:z.string().min(1).max(200),period:z.object({from:z.iso.date(),to:z.iso.date()}).nullable(),
 accepted_reading_sha256:z.array(sha).min(1).max(32).optional(),
 reading_origin:z.enum(['provider_extraction','ai_document_review','identified_document_reading','source_inventory']),reading_sha256:sha,
}).strict();
export const reviewCheckSchema=z.object({
 check_id:z.string().min(1).max(160),topic:reviewTopicSchema,title:z.string().min(1).max(200),
 explanation:z.string().max(1500),calculation:z.unknown(),
}).strict();
export const documentReviewInputSchema=z.object({
 schema_version:z.literal(DOCUMENT_REVIEW_POLICY),case_id:z.string().min(1),
 period:z.object({from:z.iso.date(),to:z.iso.date()}).strict(),
 purchased_scope:z.object({order_id:z.string().min(1),receipt_sha256:sha,topics:z.array(reviewTopicSchema).min(1),
  origin:z.enum(['saved_order','legacy_paid_receipt'])}).strict(),
 coverage_gaps:z.array(z.object({check_id:z.string().min(1),topic:reviewTopicSchema,kind:z.enum(['missing_source','missing_fact','missing_rule','missing_applicability','ownership']),detail:z.string().min(1),next_step:z.string().min(1)}).strict()).max(100).default([]),
 documents:z.array(reviewDocumentSchema).min(1).max(64),checks:z.array(reviewCheckSchema).max(400),
 // The planner validates its own source-bound contract; it is included in the
 // immutable input hash rather than read from a mutable questionnaire later.
 completion_input:z.unknown(),
 answer_bindings:z.array(z.object({fact_key:z.string().min(1),check_id:z.string().min(1),operand_id:z.string().min(1)}).strict()).max(400).default([]),
 answer_history:z.array(z.object({request:reviewCompletionSchema,receipt:reviewCompletionAnswerReceiptSchema,
  original_checks:z.array(documentReviewCalculationInputSchema).max(100)}).strict()).max(100).default([]),
}).strict();
export type DocumentReviewInput=z.infer<typeof documentReviewInputSchema>;
export type ReviewDocument=z.infer<typeof reviewDocumentSchema>;
export type DocumentReviewCheckResult=Readonly<{
 check_id:string;topic:z.infer<typeof reviewTopicSchema>;title:string;explanation:string;
 dependency_sha256:string;calculation:ReturnType<typeof calculateDocumentReview>;
}>;
export type DocumentReviewResult=Readonly<{
 input:DocumentReviewInput;schema_version:typeof DOCUMENT_REVIEW_POLICY;case_id:string;analysis_run_id:string;input_sha256:string;
 period:DocumentReviewInput['period'];purchased_scope:DocumentReviewInput['purchased_scope'];documents:readonly ReviewDocument[];
 coverage_gaps:DocumentReviewInput['coverage_gaps'];checks:readonly DocumentReviewCheckResult[];completions:ReturnType<typeof generateReviewCompletions>;
 legal_debt_total:null;actual_transfer_proven:false;publication_authority:false;result_sha256:string;
}>;
