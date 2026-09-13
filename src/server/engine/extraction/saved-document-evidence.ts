import 'server-only';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {DOCUMENT_EVIDENCE_POLICY} from '@/engine/extraction/document-evidence/contracts';
import {assertDocumentEvidenceReplay} from '@/engine/extraction/document-evidence/normalization';

import {loadVerifiedUpload,type UploadExtractionDb,type UploadExtractionStorage} from './verified-upload-source';
import type {DocumentEvidenceExtractor} from './providers/openai/document-evidence-adapter';
import {savedDocumentEvidenceSchema,documentEvidenceProviderResultSchema} from './saved-document-evidence-contract';
export {savedDocumentEvidenceSchema,validateSavedDocumentEvidence} from './saved-document-evidence-contract';
import {parseOpenAiProviderReceipt} from './providers/openai/provider-receipt';

export async function extractSavedDocumentEvidence(input:{caseId:string;versionId:string;requestedMonths:readonly string[];
 analysisRunId:string;extractionId:string;createdAt:string;db:UploadExtractionDb;storage:UploadExtractionStorage;extractor:DocumentEvidenceExtractor}){
 const months=z.array(z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u)).min(1).max(12).parse(input.requestedMonths);
 if(new Set(months).size!==months.length)throw Error('DOCUMENT_EVIDENCE_DUPLICATE_MONTH');
 const loaded=await loadVerifiedUpload(input.caseId,input.versionId,input.db,input.storage);
 if(loaded.document.document_type!=='attendance'&&loaded.document.document_type!=='contract')throw Error('DOCUMENT_EVIDENCE_KIND');
 const result=documentEvidenceProviderResultSchema.parse(await input.extractor.extract({document:loaded.document,source:loaded.source,
  analysisRunId:input.analysisRunId,extractionId:input.extractionId,createdAt:input.createdAt}));
 if(result.status==='completed')assertDocumentEvidenceReplay({raw:result.raw,normalized:result.normalized,document:loaded.document,physicalPageCount:result.physical_page_count});
 const receipt=parseOpenAiProviderReceipt(result.provider_receipt);
 if(receipt.analysis_run_id!==input.analysisRunId||receipt.extraction_id!==input.extractionId||receipt.source_size_bytes!==loaded.document.size_bytes
  ||receipt.source_mime_type!==loaded.document.mime_type)throw Error('DOCUMENT_EVIDENCE_INVOCATION_SCOPE');
 return deepFreeze(savedDocumentEvidenceSchema.parse({schema_version:'tivdoc-saved-document-evidence-v1',case_id:input.caseId,
  product_document_id:loaded.productDocumentId,version_id:input.versionId,input_sha256:loaded.document.content_sha256,
  policy_version:DOCUMENT_EVIDENCE_POLICY,requested_months:[...months].sort(),dispatch_month:[...months].sort()[0],result_sha256:canonicalSha256(result),run:{result}}));
}
