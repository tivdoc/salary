import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {intake_factory} from '@/server/platform/persistence/postgres/intake';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {lockCurrentSource,sourceJobSchema,type SourceJob} from './source-dispatch';

export function savedCaseTenant(caseId:string){return `saved-case:${z.uuid().parse(caseId)}`;}
/** Caller installs a provisioned machine SID/JTI through runtime_context_install
 * in this SAME transaction. A GUC tenant string alone is never authority. This
 * admits a paid saved source for draft analysis, not live rule publication. */
export async function admitSavedSource(context:PostgresTransactionContext,candidate:SourceJob){
 const job=sourceJobSchema.parse(candidate),tenantId=savedCaseTenant(job.case_id);
 if(job.mode!=='draft')throw new Error('SAVED_LIVE_COMPOSITION_NOT_ENABLED');
 const authority=await context.client.query(statement('saved_worker_authority',
  "select private.runtime_verified_tenant() tenant_id, session_user::text principal",[]));
 if(authority.rows[0]?.tenant_id!==tenantId||authority.rows[0]?.principal!=='tivdoc_worker_runtime')throw new Error('SAVED_WORKER_SCOPE_FORBIDDEN');
 await lockCurrentSource(context,job);
 const selected=await context.client.query(statement('saved_worker_paid_source',
  `select v.created_at from private.case_input_versions v
   where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$3
   and exists(select 1 from private.product_orders o
    where o.case_id=v.case_id and o.state='paid' and o.refund_state<>'refunded'
    and exists(select 1 from jsonb_array_elements(v.input->'orders') pinned
     where pinned->>'id'=o.id::text and pinned->>'offer_sha256'=o.offer_sha256))`,
  [job.case_id,job.revision,job.input_sha256]));
 if(!selected.rows[0])throw new Error('SAVED_PAID_SOURCE_REQUIRED');
 const lifecycle=intake_factory(context,tenantId).case_lifecycle;
 const existing=await lifecycle.get(context,{tenant_id:tenantId,case_id:job.case_id});
 if(existing)return {tenantId,revision:existing.revision};
 const hash=canonicalSha256({schema_version:'saved-worker-admission-v1',job});
 const saved=await lifecycle.append(context,{tenant_id:tenantId,case_id:job.case_id,expected_revision:0,state_before:null,
  state_after:'awaiting_legal_review',event_kind:'saved_paid_source_admitted',command_sha256:hash,event_sha256:hash,
  previous_sha256:null,state_sha256:hash,occurred_at:new Date(String(selected.rows[0].created_at)).toISOString()});
 return {tenantId,revision:saved.revision};
}
