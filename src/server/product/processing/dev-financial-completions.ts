import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {canonicalFactSchema,type CanonicalFact} from '@/engine/facts/contracts';
import {employmentSnapshotSchema,type EmploymentSnapshot} from '@/engine/facts/snapshot';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {june2026CollectionTargetSchema,resolveJune2026CollectionAnswer,JUNE2026_COLLECTION_NAMESPACE} from '@/engine/minimum-wage-june2026/collection';
import {documentTranscriptionTargetSchema,documentTranscriptionReadingSchema,resolveDocumentTranscriptionReading} from '../reports/document-field-transcription';
import {assertDevFinancialCompletionSource} from './dev-financial-source';
import {savedAnalysisId} from './saved-draft-report';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const checkpointSchema=z.object({case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),input_sha256:sha,result_sha256:sha,
 expected_month:z.literal('2026-06'),period_mismatch:z.literal(false),
 run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema}).passthrough()}).passthrough()}).passthrough();
const actorSchema=z.object({request_id:z.uuid(),answer_revision:z.number().int().positive(),identity_id:z.uuid(),answered_at:z.iso.datetime({offset:true}),answer:z.string()});
const natureSchema=actorSchema.extend({target:june2026CollectionTargetSchema}).passthrough();
export const devFinancialSourceCompletionsSchema=z.object({schema_version:z.literal('dev-financial-source-completions-v1'),authority:z.literal('engineering_only'),
 case_id:z.uuid(),order_id:z.uuid(),extraction_policy_version:z.string().min(1).max(100),checkpoint:checkpointSchema,
 readings:z.array(documentTranscriptionReadingSchema).length(2),component_nature:natureSchema,snapshot_sha256:sha}).strict();
export type DevFinancialSourceCompletions=z.infer<typeof devFinancialSourceCompletionsSchema>;

/** Reconstruct every target and answer. SQL additionally binds this snapshot to
 * the actual current checkpoint and immutable identified-answer journal. */
export function parseDevFinancialSourceCompletions(candidate:unknown){
 const p=devFinancialSourceCompletionsSchema.parse(candidate),checkpoint=p.checkpoint;
 const {snapshot_sha256,...body}=p;
 if(canonicalSha256(body)!==snapshot_sha256||p.case_id!==checkpoint.case_id
  ||canonicalSha256(checkpoint.run.result)!==checkpoint.result_sha256)throw Error('DEV_COMPLETION_SNAPSHOT_BINDING');
 const salary=p.readings.filter(r=>r.target.subject.kind==='salary_type'),amount=p.readings.filter(r=>r.target.subject.kind==='component_amount');
 if(salary.length!==1||amount.length!==1||new Set(p.readings.map(r=>r.request_id)).size!==2)throw Error('DEV_COMPLETION_READING_AMBIGUOUS');
 for(const reading of p.readings){
  const resolved=resolveDocumentTranscriptionReading({target:reading.target,currentCheckpoint:checkpoint,policyVersion:p.extraction_policy_version,
   caseId:p.case_id,month:'2026-06',requestId:reading.request_id,answerRevision:reading.answer_revision,identityId:reading.identity_id,answeredAt:reading.answered_at,answer:reading.answer});
  if(resolved.state!=='confirmed_reading'||canonicalSha256(resolved.reading)!==canonicalSha256(reading))throw Error('DEV_COMPLETION_READING_BINDING');
 }
 const nature=p.component_nature;
 const resolved=resolveJune2026CollectionAnswer({target:nature.target,currentCheckpoint:checkpoint,policyVersion:p.extraction_policy_version,
  caseId:p.case_id,month:'2026-06',requestId:nature.request_id,answerRevision:nature.answer_revision,identityId:nature.identity_id,answeredAt:nature.answered_at,answer:nature.answer});
 if(resolved.state!=='declared'||resolved.declaration.interpretation.kind!=='component_substance_declaration'
  ||resolved.declaration.interpretation.value!=='base_salary'||canonicalSha256(resolved.declaration)!==canonicalSha256(nature)
  ||nature.target.subject.kind!=='component'||amount[0].target.subject.kind!=='component_amount'
  ||nature.target.subject.component.component_id!==amount[0].target.subject.component.component_id
  ||p.readings.some(r=>r.request_id===nature.request_id))throw Error('DEV_COMPLETION_NATURE_BINDING');
 assertDevFinancialCompletionSource(checkpoint.run.result.final_extraction,checkpoint.version_id,
  amount[0].target.subject.component.component_id,amount[0].normalized_value,salary[0].normalized_value);
 return deepFreeze(p);
}

const journalAnswerSchema=z.object({id:z.uuid(),case_id:z.uuid(),scope_month:z.literal('2026-06'),code:z.string(),answer:z.string(),
 answer_revision:z.number().int().positive(),answer_identity_id:z.uuid(),answer_created_at:z.iso.datetime({offset:true}),
 transcription_target:documentTranscriptionTargetSchema.optional(),june2026_target:june2026CollectionTargetSchema.optional()});
export type DevFinancialCompletionMissing='salary_type'|'component_amount'|'component_nature';
/** A new target/answer namespace cannot silently enter ordinary canonical
 * customer_readings. Only this explicitly engineering-only materializer uses it. */
export function materializeDevFinancialSourceCompletions(input:{caseId:string;orderId:string;checkpoint:unknown;journal:unknown;policyVersion:string}){
 const checkpoint=checkpointSchema.parse(input.checkpoint);
 if(checkpoint.case_id!==input.caseId)throw Error('DEV_COMPLETION_CASE_MISMATCH');
 z.uuid().parse(input.orderId);
 const answers=z.object({answers:z.array(z.record(z.string(),z.unknown())).default([])}).parse(input.journal).answers;
 const seen=new Set<string>(),readings:z.infer<typeof documentTranscriptionReadingSchema>[]=[],natures:z.infer<typeof natureSchema>[]=[];
 for(const raw of answers){
  if(typeof raw.code!=='string'||(!raw.code.startsWith('document_transcription:')&&!raw.code.startsWith(JUNE2026_COLLECTION_NAMESPACE)))continue;
  // Other purchased months remain outside this one-month engineering policy.
  if(raw.scope_month!=='2026-06')continue;
  const a=journalAnswerSchema.parse(raw);
  if(a.case_id!==input.caseId||seen.has(a.id))throw Error('DEV_COMPLETION_JOURNAL_BINDING');seen.add(a.id);
  const actor={currentCheckpoint:checkpoint,policyVersion:input.policyVersion,caseId:input.caseId,month:'2026-06',
   requestId:a.id,answerRevision:a.answer_revision,identityId:a.answer_identity_id,answeredAt:a.answer_created_at,answer:a.answer};
  if(a.code.startsWith('document_transcription:')){
   const target=documentTranscriptionTargetSchema.parse(a.transcription_target);
   if(target.case_id!==input.caseId||a.code!==`document_transcription:${target.target_sha256}`)throw Error('DEV_COMPLETION_JOURNAL_BINDING');
   const result=resolveDocumentTranscriptionReading({...actor,target});
   if(result.state==='confirmed_reading')readings.push(result.reading);
  }else{
   const target=june2026CollectionTargetSchema.parse(a.june2026_target);
   if(target.case_id!==input.caseId||a.code!==JUNE2026_COLLECTION_NAMESPACE+target.target_sha256)throw Error('DEV_COMPLETION_JOURNAL_BINDING');
   if(target.subject.kind!=='component')continue;
   const result=resolveJune2026CollectionAnswer({...actor,target});
   if(result.state==='declared'&&result.declaration.interpretation.kind==='component_substance_declaration'&&result.declaration.interpretation.value==='base_salary')natures.push(result.declaration);
  }
 }
 const salary=readings.filter(r=>r.target.subject.kind==='salary_type'),amount=readings.filter(r=>r.target.subject.kind==='component_amount');
 if(salary.length>1||amount.length>1||natures.length>1)throw Error('DEV_COMPLETION_READING_AMBIGUOUS');
 const missing:DevFinancialCompletionMissing[]=[];
 if(!salary.length)missing.push('salary_type');if(!amount.length)missing.push('component_amount');if(!natures.length)missing.push('component_nature');
 if(missing.length)return deepFreeze({state:'incomplete' as const,missing});
 const body={schema_version:'dev-financial-source-completions-v1' as const,authority:'engineering_only' as const,case_id:input.caseId,order_id:input.orderId,
  extraction_policy_version:input.policyVersion,checkpoint,readings:[salary[0],amount[0]],component_nature:natures[0]};
 return deepFreeze({state:'completed' as const,snapshot:parseDevFinancialSourceCompletions({...body,snapshot_sha256:canonicalSha256(body)})});
}

/** Explicit customer document readings supply only absent inputs in a distinct
 * engineering snapshot; source OCR, canonical facts and legal grades stay intact. */
export function devFinancialCompletionFacts(parent:EmploymentSnapshot,runId:string,candidate:DevFinancialSourceCompletions):EmploymentSnapshot{
 parent=employmentSnapshotSchema.parse(parent);
 const p=parseDevFinancialSourceCompletions(candidate);
 if(parent.case_id!==p.case_id)throw Error('DEV_COMPLETION_FACT_CASE');
 let facts=[...parent.facts];
 for(const reading of p.readings){
  const salary=reading.target.subject.kind==='salary_type';
  const path=salary?'compensation.salary_type':'compensation.base_monthly_salary';
  const originals=facts.filter(f=>f.path===path);
  if(originals.length>1||originals.some(f=>f.value!==null||f.status!=='missing'||f.conflicting_fact_ids.length))throw Error('DEV_FINANCIAL_NONMISSING_INPUT_OVERRIDE');
  const page=reading.target.subject.kind==='salary_type'?reading.target.subject.page:reading.target.subject.component.source.page;
  const provenance:CanonicalFact['provenance']=[{source_type:'documented',source_reference:{kind:'document',document_id:p.checkpoint.version_id,locator:{page}},read_by:salary?'person':'machine',verified:true},
   {source_type:'declared',source_reference:{kind:'case_request_answer',request_id:reading.request_id,answer_revision:reading.answer_revision}},
   ...(!salary?[{source_type:'declared' as const,source_reference:{kind:'case_request_answer' as const,request_id:p.component_nature.request_id,answer_revision:p.component_nature.answer_revision}}]:[])];
  const fact=canonicalFactSchema.parse({fact_id:savedAnalysisId('dev-source-completion-fact',canonicalSha256({runId,snapshot:p.snapshot_sha256,path})),case_id:parent.case_id,
   path,value:reading.normalized_value,status:'confirmed',confidence:1,provenance,conflicting_fact_ids:[],resolution:null,created_at:reading.answered_at});
  facts=[...facts.filter(f=>f.path!==path),fact];
 }
 return employmentSnapshotSchema.parse({...parent,snapshot_id:savedAnalysisId('dev-source-completion-facts',canonicalSha256({runId,parent:canonicalSha256(parent),completion:p.snapshot_sha256})),analysis_run_id:runId,facts});
}
