import 'server-only';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {createJune2026CollectionTarget,june2026CollectionQuestion,june2026CollectionTargetSchema,resolveJune2026CollectionAnswer,JUNE2026_COLLECTION_NAMESPACE,type June2026CollectionSelector} from '@/engine/minimum-wage-june2026/collection';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {admitSavedSource} from './saved-admission';
import {readSavedOrders} from './saved-order-scope';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import type {SourceJob} from './source-dispatch';

const scopeFields=['age_18_entire_month','sector','hours_rest_law_applies','no_better_minimum_wage_arrangement','no_adapted_minimum_wage','regular_hours_exclude_absence_overtime_rest'] as const;
/** Existing extraction transaction owns the source lock. These declarations
 * do not activate rules, confirm legal applicability or introduce a new queue. */
export async function openSavedJune2026Collection(context:PostgresTransactionContext,job:SourceJob,checkpoint:unknown){
 const header=z.object({case_id:z.uuid(),expected_month:z.string(),period_mismatch:z.boolean()}).parse(checkpoint);
 if(header.case_id!==job.case_id)throw Error('JUNE_COLLECTION_CASE_MISMATCH');
 if(header.expected_month!=='2026-06'||header.period_mismatch)return [];
 await admitSavedSource(context,job);
 const orders=await readSavedOrders(context,job);
 if(!orders.some(o=>o.from<='2026-06-01'&&o.to>='2026-06-01'&&o.topics.includes('minimum_wage')))return [];
 const saved=z.object({run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema})})}).parse(checkpoint);
 const selectors:June2026CollectionSelector[]=[...scopeFields.map(field=>({kind:'applicability' as const,field})),{kind:'earnings_completeness'},
  ...saved.run.result.final_extraction.additional_components.map(c=>({kind:'component' as const,componentId:c.component_id}))];
 // A missing/contradictory period stays in the existing document-reading flow.
 // Build the whole bounded inventory before inserting any question.
 let targets;
 try{targets=selectors.map(subject=>createJune2026CollectionTarget({checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,subject}));}
 catch(error){if(error instanceof Error&&error.message==='JUNE_COLLECTION_PERIOD_UNSUPPORTED')return [];throw error;}
 const opened:string[]=[];
 for(const target of targets){
  const question=june2026CollectionQuestion(target);
  const result=await context.client.query(statement('saved_june2026_request_open',
   'select private.june2026_collection_request_open($1::uuid,$2,$3,$4::jsonb,$5) id',[job.case_id,job.revision,job.input_sha256,JSON.stringify(target),question.question]));
  if(result.rows[0]?.id!==null)opened.push(z.uuid().parse(result.rows[0]?.id));
 }
 return opened;
}

const answerSchema=z.object({id:z.uuid(),case_id:z.uuid(),scope_month:z.string(),code:z.string(),answer:z.string(),answer_revision:z.number().int().positive(),
 answer_identity_id:z.uuid(),answer_created_at:z.string().datetime({offset:true}),june2026_target:june2026CollectionTargetSchema});
/** Journal entries and request targets are loaded by the scoped worker adapter,
 * then materialized as declarations for the same persisted review stage. */
export function materializeSavedJune2026Collection(input:{caseId:string;journal:unknown;targets:readonly unknown[];checkpoints:readonly unknown[];evaluatedAt:string}){
 const evaluatedAt=z.iso.datetime({offset:true}).parse(input.evaluatedAt);
 const answers=z.object({answers:z.array(z.record(z.string(),z.unknown())).default([])}).parse(input.journal).answers;
 const selected=answers.filter(a=>typeof a.code==='string'&&a.code.startsWith(JUNE2026_COLLECTION_NAMESPACE)).map(a=>answerSchema.parse(a));
 if(new Set(selected.map(a=>a.id)).size!==selected.length)throw Error('JUNE_COLLECTION_ANSWER_AMBIGUOUS');
 for(const answer of selected)if(answer.case_id!==input.caseId||answer.june2026_target.case_id!==input.caseId||answer.scope_month!==answer.june2026_target.month||answer.code!==JUNE2026_COLLECTION_NAMESPACE+answer.june2026_target.target_sha256)throw Error('JUNE_COLLECTION_CASE_OR_TARGET_MISMATCH');
 const rows=input.targets.map(row=>z.object({request_id:z.uuid(),target:june2026CollectionTargetSchema,expires_at:z.string().datetime({offset:true}),expired_at:z.string().datetime({offset:true}).nullable()}).parse(row));
 if(new Set(rows.map(r=>r.request_id)).size!==rows.length)throw Error('JUNE_COLLECTION_REQUEST_AMBIGUOUS');
 const resolutions=rows.map(row=>{
  const target=row.target;if(target.case_id!==input.caseId)throw Error('JUNE_COLLECTION_CASE_MISMATCH');
  const current=input.checkpoints.filter(value=>z.object({version_id:z.uuid()}).parse(value).version_id===target.version_id);
  if(current.length>1)throw Error('JUNE_COLLECTION_CHECKPOINT_AMBIGUOUS');
  const answer=selected.find(a=>a.id===row.request_id);
  if(answer&&canonicalSha256(answer.june2026_target)!==canonicalSha256(target))throw Error('JUNE_COLLECTION_JOURNAL_TARGET_MISMATCH');
  if(answer)return resolveJune2026CollectionAnswer({target,currentCheckpoint:current[0],policyVersion:SAVED_EXTRACTION_POLICY,caseId:input.caseId,month:'2026-06',requestId:row.request_id,
   answerRevision:answer.answer_revision,identityId:answer.answer_identity_id,answeredAt:answer.answer_created_at,answer:answer.answer});
  let isCurrent=false;
  try{isCurrent=createJune2026CollectionTarget({checkpoint:current[0],policyVersion:SAVED_EXTRACTION_POLICY,
   subject:target.subject.kind==='component'?{kind:'component',componentId:target.subject.component.component_id}:target.subject}).target_sha256===target.target_sha256;}catch{/* Missing/stale evidence remains unresolved. */}
  return {state:!isCurrent?'stale':row.expired_at!==null||Date.parse(row.expires_at)<=Date.parse(evaluatedAt)?'expired':'missing',request_id:row.request_id,target,expires_at:row.expires_at,legal_classification_status:'unreviewed',candidate_evidence_admitted:false} as const;
 });
 if(selected.some(a=>!rows.some(r=>r.request_id===a.id)))throw Error('JUNE_COLLECTION_JOURNAL_REQUEST_MISSING');
 return deepFreeze({schema_version:'saved-june2026-collection-evidence-v1',case_id:input.caseId,month:'2026-06',evaluated_at:evaluatedAt,resolutions,
  customer_declarations:resolutions.filter(r=>r.state==='declared').length,unknown:resolutions.filter(r=>r.state==='unknown').length,conflicted:resolutions.filter(r=>r.state==='conflicted').length,
  legal_confirmation:false,rule_activation:false});
}

export async function readSavedJune2026Collection(context:PostgresTransactionContext,job:SourceJob){
 const journal=await context.client.query(statement('saved_june2026_journal','select input,input_sha256,statement_timestamp() evaluated_at,encode(sha256(convert_to(input::text,\'UTF8\')),\'hex\') actual_sha256 from private.case_input_versions where case_id=$1::uuid and revision=$2',[job.case_id,job.revision]));
 if(journal.rows[0]?.input_sha256!==job.input_sha256||journal.rows[0]?.actual_sha256!==job.input_sha256)throw Error('JUNE_COLLECTION_INPUT_HASH_MISMATCH');
 const targets=await context.client.query(statement('saved_june2026_targets','select t.request_id,t.target,q.expires_at,q.expired_at from private.june2026_collection_targets t join public.case_requests q on q.id=t.request_id and q.case_id=t.case_id where t.case_id=$1::uuid order by t.target_sha256',[job.case_id]));
 const checkpoints=await context.client.query(statement('saved_june2026_checkpoints',
  `select c.result from private.case_extraction_checkpoints c join public.documents d on d.case_id=c.case_id and d.version_id=c.version_id
   where c.case_id=$1::uuid and c.revision=$2 and c.policy_version=$3 and c.result->>'expected_month'='2026-06'`,[job.case_id,job.revision,SAVED_EXTRACTION_POLICY]));
 return materializeSavedJune2026Collection({caseId:job.case_id,journal:journal.rows[0].input,targets:targets.rows,checkpoints:checkpoints.rows.map(r=>r.result),evaluatedAt:new Date(String(journal.rows[0].evaluated_at)).toISOString()});
}
