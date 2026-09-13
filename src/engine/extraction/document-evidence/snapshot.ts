import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {immutableDocumentSchema} from '../../domain/documents.ts';
import {documentEvidenceSchema,documentEvidenceSha} from './contracts.ts';
import {documentEvidenceIdentifiedReadingSchema,parseDocumentEvidenceIdentifiedReading} from './reading.ts';

export const savedNonPayslipEvidenceSchema=z.object({document:immutableDocumentSchema,
 product_document_id:z.uuid(),checkpoint_result_sha256:documentEvidenceSha.nullable(),provider_receipt_sha256:documentEvidenceSha.nullable(),
 extraction:documentEvidenceSchema.nullable(),failure_code:z.string().min(1).nullable(),
 readings:z.array(documentEvidenceIdentifiedReadingSchema).max(600),
}).strict().superRefine((v,ctx)=>{
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(!['attendance','contract'].includes(v.document.document_type))fail('NON_PAYSLIP_KIND');
 if(v.extraction&&(v.extraction.case_id!==v.document.case_id||v.extraction.document_id!==v.document.document_id||v.extraction.source_sha256!==v.document.content_sha256||!v.checkpoint_result_sha256||!v.provider_receipt_sha256||v.failure_code))fail('NON_PAYSLIP_EXTRACTION_SCOPE');
 if(!v.extraction&&!v.failure_code)fail('NON_PAYSLIP_PENDING_REASON');
 if(new Set(v.readings.map(r=>r.target.observation.observation_id)).size!==v.readings.length)fail('NON_PAYSLIP_READING_DUPLICATE');
 for(const r of v.readings){
  try{parseDocumentEvidenceIdentifiedReading(r);}catch{fail('NON_PAYSLIP_READING_RECEIPT');}
  const t=r.target;
  if(!v.extraction||t.case_id!==v.document.case_id||t.product_document_id!==v.product_document_id||t.version_id!==v.document.document_id||t.source_sha256!==v.document.content_sha256||t.checkpoint_sha256!==v.checkpoint_result_sha256||t.normalized_sha256!==canonicalSha256(v.extraction)
   ||!v.extraction.observations.some(o=>canonicalSha256(o)===canonicalSha256(t.observation)))fail('NON_PAYSLIP_READING_SOURCE');
 }
});
export type SavedNonPayslipEvidence=z.infer<typeof savedNonPayslipEvidenceSchema>;
