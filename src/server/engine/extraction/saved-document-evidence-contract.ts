// Pure saved-source contract and replay guards. No SDK, storage or network imports.
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {DOCUMENT_EVIDENCE_POLICY,documentEvidenceSha,documentEvidenceSchema,rawDocumentEvidenceSchema} from '@/engine/extraction/document-evidence/contracts';
import {assertDocumentEvidenceReplay} from '@/engine/extraction/document-evidence/normalization';
import {immutableDocumentSchema,type ImmutableDocument} from '@/engine/domain/documents';
import {parseOpenAiProviderReceipt} from './providers/openai/provider-receipt';
import {OPENAI_DOCUMENT_EVIDENCE_PROMPT_VERSION} from './providers/openai/document-evidence-prompt';
export const documentEvidenceProviderResultSchema=z.object({
 schema_version:z.literal('document-evidence-provider-result-v1'),status:z.enum(['completed','failed']),
 raw:rawDocumentEvidenceSchema.nullable(),normalized:documentEvidenceSchema.nullable(),
 provider_output:z.json().nullable(),provider_receipt:z.unknown(),
 physical_page_count:z.number().int().min(1).max(12),
}).strict().superRefine((r,ctx)=>{
 if((r.status==='completed')!==(r.raw!==null&&r.normalized!==null))ctx.addIssue({code:'custom',message:'DOCUMENT_EVIDENCE_RESULT_STATE'});
 const receipt=parseOpenAiProviderReceipt(r.provider_receipt);
 if(receipt.status!==r.status||receipt.raw_extraction_sha256!==canonicalSha256(r.provider_output)||receipt.source_page_count!==r.physical_page_count
  ||receipt.prompt_version!==OPENAI_DOCUMENT_EVIDENCE_PROMPT_VERSION||receipt.extractor_version!=='document-evidence-v1')ctx.addIssue({code:'custom',message:'DOCUMENT_EVIDENCE_PROVIDER_BINDING'});
 if(r.raw&&(canonicalSha256(r.raw)!==canonicalSha256(r.provider_output)||r.normalized?.raw_sha256!==canonicalSha256(r.raw)))ctx.addIssue({code:'custom',message:'DOCUMENT_EVIDENCE_RAW_BINDING'});
});
export const savedDocumentEvidenceSchema=z.object({schema_version:z.literal('tivdoc-saved-document-evidence-v1'),
 case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),input_sha256:documentEvidenceSha,
 policy_version:z.literal(DOCUMENT_EVIDENCE_POLICY),requested_months:z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u)).min(1).max(12),
 dispatch_month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),
 result_sha256:documentEvidenceSha,run:z.object({result:documentEvidenceProviderResultSchema}).strict(),
}).strict().superRefine((r,ctx)=>{
 if(canonicalSha256(r.run.result)!==r.result_sha256||new Set(r.requested_months).size!==r.requested_months.length)ctx.addIssue({code:'custom',message:'DOCUMENT_EVIDENCE_CHECKPOINT_HASH'});
 if(r.dispatch_month!==[...r.requested_months].sort()[0]||canonicalSha256(r.requested_months)!==canonicalSha256([...r.requested_months].sort()))ctx.addIssue({code:'custom',message:'DOCUMENT_EVIDENCE_DISPATCH_MONTH'});
 const receipt=parseOpenAiProviderReceipt(r.run.result.provider_receipt);
 if(receipt.case_id!==r.case_id||receipt.document_id!==r.version_id||receipt.source_sha256!==r.input_sha256)ctx.addIssue({code:'custom',message:'DOCUMENT_EVIDENCE_CHECKPOINT_SCOPE'});
 const n=r.run.result.normalized;
 if(n&&(n.case_id!==r.case_id||n.document_id!==r.version_id||n.source_sha256!==r.input_sha256))ctx.addIssue({code:'custom',message:'DOCUMENT_EVIDENCE_NORMALIZED_SCOPE'});
});
/** Use on every saved read, with document metadata obtained from the exact
 * current source journal. A caller-supplied matching SHA alone is insufficient. */
export function validateSavedDocumentEvidence(input:{checkpoint:unknown;document:ImmutableDocument;productDocumentId:string;requiredMonths:readonly string[]}){
 const checkpoint=savedDocumentEvidenceSchema.parse(input.checkpoint),document=immutableDocumentSchema.parse(input.document);
 if(checkpoint.case_id!==document.case_id||checkpoint.version_id!==document.document_id||checkpoint.product_document_id!==input.productDocumentId
  ||checkpoint.input_sha256!==document.content_sha256||input.requiredMonths.some(m=>!checkpoint.requested_months.includes(m)))throw Error('DOCUMENT_EVIDENCE_CHECKPOINT_CURRENT_SCOPE');
 const result=checkpoint.run.result,receipt=parseOpenAiProviderReceipt(result.provider_receipt);
 if(receipt.source_size_bytes!==document.size_bytes||receipt.source_mime_type!==document.mime_type)throw Error('DOCUMENT_EVIDENCE_CHECKPOINT_SOURCE_BYTES');
 if(result.status==='completed')assertDocumentEvidenceReplay({raw:result.raw,normalized:result.normalized,document,physicalPageCount:result.physical_page_count});
 return deepFreeze(checkpoint);
}
