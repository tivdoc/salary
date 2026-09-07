import 'server-only';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {SnapshotResolutionContext} from '@/engine/extraction/resolver';
import {loadVerifiedUpload,type UploadExtractionDb,type UploadExtractionStorage} from './verified-upload-source';
import {runOpenAiPayslipExtractionV21,createOpenAiPayslipV21ExtractorFromEnv} from './providers/openai/v21-adapter';
import type {OpenAiPayslipV2PassExtractor} from './providers/openai/v2-adapter';
/** Called by the durable worker with server-owned coordinates. Does not activate
 * legal parameters, publish a report, or replace unresolved facts. */
export async function extractSavedPayslip(input:{caseId:string;versionId:string;expectedMonth:string;context:SnapshotResolutionContext;db:UploadExtractionDb;storage:UploadExtractionStorage;extractor?:OpenAiPayslipV2PassExtractor}){
 if(input.context.case_id!==input.caseId||!/^\d{4}-(0[1-9]|1[0-2])$/.test(input.expectedMonth))throw new Error('EXTRACTION_SCOPE');
 const loaded=await loadVerifiedUpload(input.caseId,input.versionId,input.db,input.storage);
 if(loaded.document.document_type!=='payslip')throw new Error('EXTRACTION_DOCUMENT_TYPE');
 const run=await runOpenAiPayslipExtractionV21({request:{extraction_id:input.context.snapshot_id,analysis_run_id:input.context.analysis_run_id,case_id:input.caseId,document:loaded.document,requested_at:input.context.created_at},source:loaded.source,extractor:input.extractor??createOpenAiPayslipV21ExtractorFromEnv(),snapshot_context:input.context});
 const periods=run.result.final_extraction.fields.filter(f=>f.field==='salary_period'&&f.normalized_value!==null).map(f=>f.normalized_value as {year:number;month:number});
 const periodMismatch=periods.some(p=>`${p.year}-${String(p.month).padStart(2,'0')}`!==input.expectedMonth);
 return {schema_version:'tivdoc-saved-extraction-v1',case_id:input.caseId,product_document_id:loaded.productDocumentId,version_id:input.versionId,input_sha256:loaded.document.content_sha256,expected_month:input.expectedMonth,period_mismatch:periodMismatch,requires_confirmation:periodMismatch||periods.length===0||run.result.final_confidence_assessment.decisions.some(d=>d.applicable&&d.status!=='reliable'),result_sha256:canonicalSha256(run.result),run};
}
