import 'server-only';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {june2026TestAssessmentSchema} from '@/engine/minimum-wage-june2026/evidence-admission';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';
import {savedMonthIdempotencyKey} from './saved-order-scope';

const issued=new WeakSet<object>();
export async function loadJune2026TestAuthority(context:PostgresTransactionContext,job:SourceJob,orderId:string){
 const rows=await context.client.query(statement('june_test_authority',
  'select private.june2026_test_assessment($1::uuid,$2::uuid,$3,$4) authority',[job.case_id,orderId,job.revision,job.input_sha256]));
 if(rows.rows.length!==1)throw Error('JUNE_TEST_AUTHORITY_ACK');
 if(rows.rows[0].authority===null)return null;
 const value=z.object({assessment:june2026TestAssessmentSchema,assessment_sha256:z.string(),evaluated_at:z.string()}).strict().parse(rows.rows[0].authority);
 if(canonicalSha256(value.assessment)!==value.assessment_sha256)throw Error('JUNE_TEST_AUTHORITY_HASH');
 const authority=deepFreeze({...value,evaluated_at:new Date(value.evaluated_at).toISOString()});issued.add(authority);return authority;
}
export type June2026TestAuthority=NonNullable<Awaited<ReturnType<typeof loadJune2026TestAuthority>>>;
export function assertJune2026TestAuthority(authority:June2026TestAuthority,job:SourceJob,orderId:string){
 if(!issued.has(authority)||authority.assessment.case_id!==job.case_id||authority.assessment.order_id!==orderId
  ||authority.assessment.input_revision!==job.revision||authority.assessment.input_sha256!==job.input_sha256)
  throw Error('JUNE_TEST_AUTHORITY_REQUIRED');
}
export function june2026TestIdempotencyKey(job:SourceJob,orderId:string,authority:June2026TestAuthority){
 assertJune2026TestAuthority(authority,job,orderId);
 return `june-test:${canonicalSha256({base:savedMonthIdempotencyKey(job,orderId,'2026-06'),assessment_sha256:authority.assessment_sha256,composition:'canonical-june-single-component-v1'})}`;
}
