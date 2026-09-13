import {rawCandidateFieldSchema} from './contracts.ts';
import {z} from 'zod';
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
/** A scoped customer action against a saved cell. It attests to the reading,
 * not professional review, legal applicability or model calibration. */
export const customerDocumentReadingSchema=z.object({
 actor_kind:z.literal('customer'),case_id:z.uuid(),document_id:z.uuid(),candidate_id:z.uuid(),
 source_sha256:hash,normalized_extraction_sha256:hash,candidate_sha256:hash,extraction_result_sha256:hash,target_sha256:hash,
 month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),request_id:z.uuid(),answer_revision:z.number().int().positive(),
 identity_id:z.uuid(),confirmed_at:z.string().datetime({offset:true}),
 correction:z.object({schema_version:z.literal('document-field-correction-v1'),raw_value:z.string().trim().min(1).max(500),
  normalized_value:z.json(),verification_sha256:hash}).strict().optional(),
}).strict();
export type CustomerDocumentReading=Readonly<z.infer<typeof customerDocumentReadingSchema>>;

/** Row cells are not scalar payroll facts. Their explicit identity prevents an
 * unrelated quantity/rate from acquiring the meaning of regular hours/pay. */
export const rowReadingCellSchema=z.enum(['quantity','rate','amount','percentage']);
export type RowReadingCell=z.infer<typeof rowReadingCellSchema>;
export const customerDocumentRowCellReadingSchema=z.object({
 schema_version:z.literal('document-row-cell-reading-v1'),actor_kind:z.literal('customer'),
 case_id:z.uuid(),document_id:z.uuid(),component_id:z.uuid(),cell:rowReadingCellSchema,
 source_sha256:hash,normalized_extraction_sha256:hash,original_component_sha256:hash,extraction_result_sha256:hash,target_sha256:hash,
 month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),request_id:z.uuid(),answer_revision:z.number().int().positive(),
 identity_id:z.uuid(),confirmed_at:z.string().datetime({offset:true}),
 correction:z.object({schema_version:z.literal('document-row-cell-correction-v1'),raw_value:z.string().trim().min(1).max(500),
  normalized_value:z.json(),verification_sha256:hash}).strict().optional(),
}).strict();
export type CustomerDocumentRowCellReading=Readonly<z.infer<typeof customerDocumentRowCellReadingSchema>>;

/** Numeric reading of a retained scoped observation. Scope/fund/period labels
 * remain provider observations and are never approved by this receipt. */
export const customerDocumentScopeReadingSchema=z.object({
 schema_version:z.literal('document-source-scope-reading-v1'),actor_kind:z.literal('customer'),
 case_id:z.uuid(),document_id:z.uuid(),candidate_id:z.uuid(),source_sha256:hash,normalized_extraction_sha256:hash,
 original_observation_sha256:hash,extraction_result_sha256:hash,target_sha256:hash,
 month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),request_id:z.uuid(),answer_revision:z.number().int().positive(),
 identity_id:z.uuid(),confirmed_at:z.string().datetime({offset:true}),
 correction:z.object({schema_version:z.literal('document-source-scope-correction-v1'),raw_value:z.string().trim().min(1).max(500),
  normalized_value:z.json(),verification_sha256:hash}).strict().optional(),
}).strict();
export type CustomerDocumentScopeReading=Readonly<z.infer<typeof customerDocumentScopeReadingSchema>>;

export const unresolvedBalanceCandidateSchema=rawCandidateFieldSchema.safeExtend({field:z.enum(['vacation_balance','sick_balance']),normalized_value:z.null()});
/** Copied source text, not an inferred total or classification of a subtotal. */
export const grandTotalTranscriptionValueSchema=z.object({schema_version:z.literal('grand-total-source-value-v1'),
 amount:z.string().trim().min(1).max(50),label:z.string().trim().min(1).max(100),locator:z.string().trim().min(1).max(160)}).strict();
export const sourceTranscriptionSubjectSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('reported_work_hours'),page:z.number().int().min(1).max(100),meaning:z.literal('document_reported_total_hours')}).strict(),
 z.object({kind:z.literal('balance_unit'),original_candidate:unresolvedBalanceCandidateSchema,first_pass_extraction_sha256:hash}).strict(),
 z.object({kind:z.literal('grand_total'),page:z.literal(1),meaning:z.literal('document_total_deductions'),
  first_pass_extraction_sha256:hash}).strict(),
]);
export type SourceTranscriptionSubject=Readonly<z.infer<typeof sourceTranscriptionSubjectSchema>>;
/** Identified transcription of a source omission, separate from every provider
 * field. The independently loaded context must corroborate its retained source. */
export const customerSourceTranscriptionSchema=z.object({
 schema_version:z.literal('document-source-transcription-reading-v1'),actor_kind:z.literal('customer'),case_id:z.uuid(),document_id:z.uuid(),
 source_sha256:hash,normalized_extraction_sha256:hash,extraction_result_sha256:hash,target_sha256:hash,subject:sourceTranscriptionSubjectSchema,
 month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),request_id:z.uuid(),answer_revision:z.number().int().positive(),identity_id:z.uuid(),confirmed_at:z.string().datetime({offset:true}),
 transcription:z.object({raw_value:z.string().trim().min(1).max(500),normalized_value:z.json(),verification_sha256:hash}).strict(),
}).strict();
export type CustomerSourceTranscription=Readonly<z.infer<typeof customerSourceTranscriptionSchema>>;
export const sourceReadingContextSchema=z.object({checkpoint_result_sha256:hash,first_pass:z.record(z.string(),z.unknown())}).strict();

export {customerSourceStructureReadingSchema,type CustomerSourceStructureReading} from './source-structure.ts';
