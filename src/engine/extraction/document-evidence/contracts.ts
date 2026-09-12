import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';

export const DOCUMENT_EVIDENCE_POLICY='saved-document-evidence-v1' as const;
export const DOCUMENT_EVIDENCE_NORMALIZATION='document-evidence-normalization-v2' as const;
export const documentEvidenceNormalizationPolicy=z.enum(['document-evidence-normalization-v1',DOCUMENT_EVIDENCE_NORMALIZATION]);
export const documentEvidenceSha=z.string().regex(/^[a-f0-9]{64}$/u);
export const documentEvidenceKind=z.enum(['attendance','contract','unknown']);
export const documentEvidenceSemantic=z.enum([
 'period_start','period_end','employment_start','employment_end','effective_from','effective_to',
 'row_date','entry_time','exit_time','break_duration','reported_duration','regular_duration','overtime_duration',
 'paid_duration','absence_quantity','balance','quantity','amount','rate','percentage',
 'clause_text','condition_text','annex_reference','source_label','other',
]);
export const documentEvidenceValueKind=z.enum(['iso_date','clock_time','duration_hhmm','decimal','money','percentage','text']);
export const rawDocumentObservationSchema=z.object({
 block_id:z.string().min(1).max(80),row_id:z.string().max(80).nullable(),cell_id:z.string().min(1).max(80),
 semantic:documentEvidenceSemantic,value_kind:documentEvidenceValueKind,
 raw_value:z.string().max(6000).nullable(),source_label:z.string().max(300),
 unit:z.enum(['hours','days','count','ILS','percent','unknown']).nullable(),
 page:z.number().int().min(1).max(12),locator:z.string().min(1).max(400),
 text_fragment:z.string().max(6000),
 state:z.enum(['present','missing','unreadable','conflict']),confidence:z.number().min(0).max(1),
 warnings:z.array(z.string().min(1).max(100)).max(12),
}).strict();
export const rawDocumentEvidenceSchema=z.object({
 schema_version:z.literal('document-evidence-provider-v1'),detected_document_type:documentEvidenceKind,
 page_count:z.number().int().min(1).max(12),
 pages:z.array(z.object({page:z.number().int().min(1).max(12),coverage:z.enum(['complete','partial','unreadable']),
  missing_regions:z.array(z.string().min(1).max(200)).max(16)}).strict()).min(1).max(12),
 observations:z.array(rawDocumentObservationSchema).max(600),warnings:z.array(z.string().min(1).max(100)).max(32),
}).strict();
export const documentEvidenceValueSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('iso_date'),value:z.iso.date()}).strict(),
 z.object({kind:z.literal('clock_time'),value:z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)}).strict(),
 z.object({kind:z.literal('duration_hhmm'),value:z.string().regex(/^\d{1,5}:[0-5]\d$/u),unit:z.literal('hours')}).strict(),
 z.object({kind:z.literal('decimal'),value:z.string().regex(/^-?\d+(?:\.\d+)?$/u),unit:z.enum(['hours','days','count','unknown'])}).strict(),
 z.object({kind:z.literal('money'),minor_units:z.number().int().safe(),currency:z.literal('ILS')}).strict(),
 z.object({kind:z.literal('percentage'),value:z.string().regex(/^-?\d+(?:\.\d+)?$/u),unit:z.literal('percent')}).strict(),
 z.object({kind:z.literal('text'),value:z.string().min(1).max(6000)}).strict(),
]);
export const normalizedDocumentObservationSchema=z.object({
 observation_id:documentEvidenceSha,original:rawDocumentObservationSchema,original_sha256:documentEvidenceSha,
 normalized_value:documentEvidenceValueSchema.nullable(),
 state:z.enum(['candidate','missing','unreadable','conflict','invalid']),
 issues:z.array(z.string().min(1).max(100)).max(16),
}).strict();
export const documentEvidenceSchema=z.object({
 schema_version:z.literal('normalized-document-evidence-v1'),normalization_policy:documentEvidenceNormalizationPolicy,
 case_id:z.uuid(),document_id:z.uuid(),source_sha256:documentEvidenceSha,
 declared_document_type:z.enum(['attendance','contract']),detected_document_type:documentEvidenceKind,
 physical_page_count:z.number().int().min(1).max(12),raw_sha256:documentEvidenceSha,
 observations:z.array(normalizedDocumentObservationSchema).max(600),
 pages:rawDocumentEvidenceSchema.shape.pages,warnings:z.array(z.string()).max(64),
}).strict().superRefine((value,ctx)=>{
 if(new Set(value.observations.map(o=>o.observation_id)).size!==value.observations.length)ctx.addIssue({code:'custom',message:'DOCUMENT_EVIDENCE_DUPLICATE_ID'});
 for(const observation of value.observations){
  if(canonicalSha256(observation.original)!==observation.original_sha256)ctx.addIssue({code:'custom',message:'DOCUMENT_EVIDENCE_ORIGINAL_HASH'});
  if(observation.original.page>value.physical_page_count)ctx.addIssue({code:'custom',message:'DOCUMENT_EVIDENCE_PAGE'});
 }
});
export type RawDocumentEvidence=z.infer<typeof rawDocumentEvidenceSchema>;
export type RawDocumentObservation=z.infer<typeof rawDocumentObservationSchema>;
export type NormalizedDocumentEvidence=z.infer<typeof documentEvidenceSchema>;
export type DocumentEvidenceValue=z.infer<typeof documentEvidenceValueSchema>;
