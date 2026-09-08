import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {customerDocumentReadingSchema,type CustomerDocumentReading} from '@/engine/extraction/customer-reading';
import {documentFieldTargetSchema,resolveDocumentFieldReading} from '../reports/document-field-confirmation';
const answerSchema=z.object({id:z.uuid(),case_id:z.uuid(),scope_month:z.string(),code:z.string(),answer_kind:z.literal('choice'),answer:z.string(),
 answer_revision:z.number().int().positive(),answer_identity_id:z.uuid(),answer_created_at:z.string().datetime({offset:true}),field_target:documentFieldTargetSchema});

export function savedDocumentFieldReadings(input:{caseId:string;month:string;policyVersion:string;journal:unknown;checkpoint:unknown}):readonly CustomerDocumentReading[]{
 const {answers=[]}=z.object({answers:z.array(z.record(z.string(),z.unknown())).optional()}).parse(input.journal);
 const checkpoint=z.object({version_id:z.uuid(),run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema})})}).parse(input.checkpoint);
 if(checkpoint.run.result.final_extraction.customer_readings!==undefined)throw Error('SAVED_PROVIDER_CONFIRMATION_FORBIDDEN');
 const readings:CustomerDocumentReading[]=[],seen=new Set<string>();
 for(const value of answers){
  if(typeof value.code!=='string'||!value.code.startsWith('document_field:'))continue;
  const answer=answerSchema.parse(value);
  if(answer.case_id!==input.caseId||answer.field_target.case_id!==input.caseId)throw Error('REQUEST_FIELD_CASE_MISMATCH');
  if(seen.has(answer.id))throw Error('SAVED_REQUEST_ID_AMBIGUOUS');seen.add(answer.id);
  if(answer.code!==`document_field:${answer.field_target.target_sha256}`)throw Error('REQUEST_FIELD_TARGET_INVALID');
  if(answer.field_target.version_id!==checkpoint.version_id||answer.scope_month!==input.month)continue;
  const result=resolveDocumentFieldReading({target:answer.field_target,currentCheckpoint:input.checkpoint,policyVersion:input.policyVersion,
   caseId:input.caseId,month:input.month,requestId:answer.id,answerRevision:answer.answer_revision,identityId:answer.answer_identity_id,answeredAt:answer.answer_created_at,answer:answer.answer});
  if(result.state!=='confirmed_reading')continue;
  const target=result.reading.target;
  readings.push(customerDocumentReadingSchema.parse({actor_kind:'customer',case_id:input.caseId,document_id:target.version_id,candidate_id:target.candidate.candidate_id,
   source_sha256:target.source_sha256,normalized_extraction_sha256:canonicalSha256(checkpoint.run.result.final_extraction),candidate_sha256:canonicalSha256(target.candidate),
   extraction_result_sha256:target.extraction_result_sha256,target_sha256:target.target_sha256,month:target.month,
   request_id:answer.id,answer_revision:answer.answer_revision,identity_id:answer.answer_identity_id,confirmed_at:answer.answer_created_at}));
 }
 if(new Set(readings.map(r=>r.candidate_id)).size!==readings.length)throw Error('REQUEST_FIELD_READING_AMBIGUOUS');
 return readings;
}
