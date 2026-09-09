import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {payslipExtractionV21ResultSchema} from '@/engine/extraction/v21';
import {employmentSnapshotSchema} from '@/engine/facts/snapshot';
import {parseOpenAiProviderReceipt,type OpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const checkpointSchema=z.object({schema_version:z.literal('tivdoc-saved-extraction-v1'),case_id:z.uuid(),version_id:z.uuid(),
 input_sha256:hash,result_sha256:hash,run:z.object({result:payslipExtractionV21ResultSchema,
  snapshot:employmentSnapshotSchema.nullable().optional(),provider_receipts:z.array(z.unknown()).max(2).optional()})});
export type SavedExtractionProvenance=Readonly<{
 kind:OpenAiProviderReceipt['origin']|'unproven_legacy';providerAttempted:boolean;allPassesSucceeded:boolean;
 checkpointResultSha256:string;receipts:readonly OpenAiProviderReceipt[];
}>;

/** Reads server-recorded provenance, never a caller flag or a model-name
 * convention. Receipt hashes bind exact source and raw pass output; durable
 * checkpoint authorization/immutability remains the storage boundary's job. */
export function readSavedExtractionProvenance(input:unknown):SavedExtractionProvenance{
 const checkpoint=checkpointSchema.parse(input),result=checkpoint.run.result;
 if(canonicalSha256(result)!==checkpoint.result_sha256||result.final_extraction.document_id!==checkpoint.version_id)
  throw Error('LIVE_EXTRACTION_CHECKPOINT_BINDING');
 if(checkpoint.run.provider_receipts===undefined)return deepFreeze({kind:'unproven_legacy',providerAttempted:false,
  allPassesSucceeded:false,checkpointResultSha256:checkpoint.result_sha256,receipts:[]});
 const receipts=checkpoint.run.provider_receipts.map(parseOpenAiProviderReceipt);
 const passes=[result.first_pass,...result.recovery_passes];
 if(receipts.length!==passes.length||new Set(receipts.map(r=>r.origin)).size!==1
  ||new Set(receipts.map(r=>r.extraction_id)).size!==receipts.length
  ||new Set(receipts.map(r=>r.analysis_run_id)).size!==1
  ||new Set(receipts.map(r=>`${r.source_size_bytes}|${r.source_mime_type}`)).size!==1
  ||new Set(receipts.flatMap(r=>r.source_page_count===undefined?[]:[r.source_page_count])).size>1)throw Error('LIVE_EXTRACTION_PASS_BINDING');
 for(let index=0;index<passes.length;index++){
  const pass=passes[index],receipt=receipts[index],raw=pass.raw_extraction;
  const expectedModel=raw.status==='failed'?receipt.requested_model:receipt.actual_model??receipt.requested_model;
  if(receipt.case_id!==checkpoint.case_id||receipt.document_id!==checkpoint.version_id
   ||receipt.source_sha256!==checkpoint.input_sha256||receipt.extraction_id!==pass.pass_id||raw.extraction_id!==pass.pass_id
   ||raw.document_id!==checkpoint.version_id||receipt.pass_kind!==pass.kind||receipt.prompt_version!==pass.prompt_version
   ||receipt.raw_extraction_sha256!==canonicalSha256(raw)||raw.provider.provider_id!=='openai'
   ||raw.provider.extractor_version!==receipt.extractor_version||raw.provider.model_version!==expectedModel
   ||receipt.duration_ms!==raw.operation.duration_ms||receipt.created_at!==raw.extracted_at
   ||receipt.status!==(raw.status==='failed'?'failed':'completed')||receipt.error_code!==raw.error_code
   ||(raw.status!=='failed'&&(receipt.provider_response_id!==raw.operation.provider_response_id
     ||canonicalSha256(receipt.token_usage)!==canonicalSha256(raw.operation.token_usage)))
   ||(checkpoint.run.snapshot&&(checkpoint.run.snapshot.case_id!==checkpoint.case_id
     ||receipt.analysis_run_id!==checkpoint.run.snapshot.analysis_run_id)))throw Error('LIVE_EXTRACTION_RECEIPT_BINDING');
  if(receipt.source_page_count!==undefined&&raw.status!=='failed'
   &&(raw.quality_metrics.page_count!==receipt.source_page_count
     ||[...raw.fields,...raw.additional_components,...(raw.aggregate_total_observations??[]).flatMap(value=>[value.row,value.total_candidate])]
      .some(value=>value.source.page>receipt.source_page_count!)))
    throw Error('LIVE_EXTRACTION_SOURCE_PAGE_BINDING');
 }
 return deepFreeze({kind:receipts[0].origin,providerAttempted:receipts.some(r=>r.provider_attempted),
  allPassesSucceeded:receipts.every(r=>r.status==='completed'),checkpointResultSha256:checkpoint.result_sha256,receipts});
}
