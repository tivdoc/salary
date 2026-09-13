// Synthetic test observations only; no private source or provider claim.
import {immutableDocumentSchema} from '@/engine/domain/documents';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {rawDocumentEvidenceSchema} from '@/engine/extraction/document-evidence/contracts';
import {normalizeDocumentEvidence} from '@/engine/extraction/document-evidence/normalization';
import {createOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {savedDocumentEvidenceSchema} from '@/server/engine/extraction/saved-document-evidence';
export const evidenceUuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
export function evidenceReadingFixture(state:'present'|'conflict'|'unreadable'='present'){
 const document=immutableDocumentSchema.parse({document_id:evidenceUuid(2),case_id:evidenceUuid(1),document_type:'attendance',original_filename:'synthetic.png',mime_type:'image/png',
  size_bytes:100,content_sha256:'a'.repeat(64),storage_path:`cases/${evidenceUuid(1)}/documents/${evidenceUuid(2)}/original.png`,document_period:null,supersedes_document_id:null,created_at:'2026-07-01T00:00:00Z'});
 const base={block_id:'table',row_id:'row1',cell_id:'entry',semantic:'entry_time',value_kind:'clock_time',raw_value:'08:30',source_label:'כניסה',unit:null,
  page:1,locator:'row1.entry',text_fragment:'08:30',state,confidence:.94,warnings:[]};
 const raw=rawDocumentEvidenceSchema.parse({schema_version:'document-evidence-provider-v1',detected_document_type:'attendance',page_count:1,
  pages:[{page:1,coverage:'complete',missing_regions:[]}],observations:[base,{...base,cell_id:'period',semantic:'period_start',value_kind:'iso_date',raw_value:'2026-07-01',locator:'period'}],warnings:[]});
 const normalized=normalizeDocumentEvidence({raw,document,physicalPageCount:1});
 const receipt=createOpenAiProviderReceipt({schema_version:'tivdoc-openai-provider-receipt-v1',origin:'injected_test_provider',case_id:document.case_id,
  analysis_run_id:evidenceUuid(3),document_id:document.document_id,extraction_id:evidenceUuid(4),source_sha256:document.content_sha256,source_size_bytes:document.size_bytes,
  source_mime_type:document.mime_type,source_page_count:1,request_sha256:'b'.repeat(64),raw_extraction_sha256:canonicalSha256(raw),pass_kind:'first_pass',
  requested_model:'gpt-5.6-sol',actual_model:'gpt-5.6-sol',extractor_version:'document-evidence-v1',prompt_version:'document-evidence-v1-fp1',provider_response_id:'synthetic-response',
  provider_request_id:'synthetic-request',provider_attempted:true,status:'completed',error_code:null,http_status:null,duration_ms:1,token_usage:null,
  cost:{status:'not_returned_by_provider',amount_usd:null},created_at:'2026-07-01T00:00:00Z'});
 const result={schema_version:'document-evidence-provider-result-v1',status:'completed',raw,normalized,provider_output:raw,provider_receipt:receipt,physical_page_count:1};
 const checkpoint=savedDocumentEvidenceSchema.parse({schema_version:'tivdoc-saved-document-evidence-v1',case_id:document.case_id,product_document_id:evidenceUuid(5),
  version_id:document.document_id,input_sha256:document.content_sha256,policy_version:'saved-document-evidence-v1',requested_months:['2026-07'],dispatch_month:'2026-07',result_sha256:canonicalSha256(result),run:{result}});
 return {document,checkpoint,productDocumentId:evidenceUuid(5),month:'2026-07',observationId:normalized.observations[0].observation_id};
}
