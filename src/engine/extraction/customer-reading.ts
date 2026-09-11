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
