import 'server-only';
import {z} from 'zod';
import {canonicalFactSchema,type CanonicalFact} from '@/engine/facts/contracts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {savedAnalysisId} from './saved-draft-report';
import type {SourceJob} from './source-dispatch';

const sourceSchema=z.object({version_id:z.uuid(),checkpoint_sha256:z.string(),request_id:z.uuid().nullable(),input:z.object({answers:z.array(z.record(z.string(),z.unknown())).default([])})});
/** SQL admits the current paid source and the immutable identified-answer
 * target. An absent cell stays absent in OCR; its answer is a declaration. */
export async function savedHoursDeclarations(context:PostgresTransactionContext,job:SourceJob,orderId:string):Promise<readonly CanonicalFact[]>{
 const result=await context.client.query(statement('saved_hours_declaration_source',
  'select private.june2026_hours_admit($1::uuid,$2::uuid,$3,$4) source',[job.case_id,orderId,job.revision,job.input_sha256]));
 const source=sourceSchema.parse(result.rows[0]?.source);
 if(!source.request_id)return [];
 const rows=source.input.answers.filter(a=>a.id===source.request_id);
 if(rows.length>1)throw Error('SAVED_HOURS_ANSWER_AMBIGUOUS');
 if(!rows.length)return [];
 const a=z.object({id:z.uuid(),case_id:z.uuid(),scope_month:z.literal('2026-06'),answer_kind:z.literal('number'),
  code:z.string().regex(/^june2026_regular_hours:[a-f0-9]{64}$/u),answer:z.string().regex(/^(0|[1-9][0-9]{0,2})(?:\.[0-9]{1,4})?$/u)
   .refine(s=>Number(s)>0&&Number(s)<=182),answer_revision:z.number().int().positive(),answer_identity_id:z.uuid(),answer_created_at:z.iso.datetime({offset:true})}).parse(rows[0]);
 if(a.case_id!==job.case_id)throw Error('SAVED_HOURS_ANSWER_CASE');
 return [canonicalFactSchema.parse({fact_id:savedAnalysisId('saved-regular-hours-declaration',canonicalSha256({case:job.case_id,
  revision:job.revision,input:job.input_sha256,version:source.version_id,checkpoint:source.checkpoint_sha256,request:a.id,answer_revision:a.answer_revision})),
  case_id:job.case_id,path:'work.regular_hours',value:{amount:a.answer,unit:'hours_per_month'},status:'needs_confirmation',confidence:1,
  provenance:[{source_type:'declared',source_reference:{kind:'case_request_answer',request_id:a.id,answer_revision:a.answer_revision}}],
  conflicting_fact_ids:[],resolution:null,created_at:a.answer_created_at})];
}
