import { z } from 'zod';
import { canonicalSha256 } from '@/engine/rule-runtime/canonical';
import { statement, type PostgresTransactionContext } from '@/server/platform/persistence/postgres/contracts';
import { PostgresJobsOutboxAuditRepository } from '@/server/platform/persistence/postgres/runtime/jobs-outbox-audit';

export const SOURCE_JOB_KIND = 'saved_case_analysis_v1';
export const sourceJobSchema = z.object({
 schema_version: z.literal('saved-case-work-v1'), case_id: z.uuid(),
 revision: z.number().int().positive(), input_sha256: z.string().regex(/^[a-f0-9]{64}$/),
 mode: z.enum(['draft','shadow','live']),
}).strict();
export type SourceJob = z.infer<typeof sourceJobSchema>;
/** Must share the caller's canonical transaction, including tenant/session RLS
 * context. The queue insert and outbox acknowledgement either both commit or
 * both roll back. Never opens a second connection or calls an external API. */
export async function dispatchCaseInput(context:PostgresTransactionContext, input:{caseId:string;tenantId:string;mode:SourceJob['mode'];liveEnabled:boolean;nowMs:number}) {
 z.uuid().parse(input.caseId);
 if(input.mode==='live'&&!input.liveEnabled)throw new Error('LIVE_PROCESSING_DISABLED');
 const selected=await context.client.query(statement('source_dispatch_select',
  `select d.revision,v.input_sha256 from private.case_analysis_dispatch d
   join private.case_input_versions v using(case_id,revision)
   join private.case_input_heads h on h.case_id=d.case_id and h.revision=d.revision
   where d.case_id=$1::uuid and d.mode=$2 and d.job_id is null
   for update of d skip locked`,[input.caseId,input.mode]));
 if(selected.rows.length===0)return null;
 const row=selected.rows[0];
 const payload=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:input.caseId,revision:row.revision,input_sha256:row.input_sha256,mode:input.mode});
 const hash=canonicalSha256(payload);
 const queue=new PostgresJobsOutboxAuditRepository(context,input.tenantId,input.caseId);
 const job=await queue.enqueue({job_id:`saved_${hash}`,tenant_id:input.tenantId,case_id:input.caseId,
  job_kind:SOURCE_JOB_KIND,idempotency_key:hash,payload_sha256:hash,payload,
  pinned_version_sha256s:[payload.input_sha256],max_attempts:3,available_at_ms:input.nowMs});
 await context.client.query(statement('source_dispatch_ack',
  'update private.case_analysis_dispatch set job_id=$3,dispatched_at=to_timestamp($4/1000.0) where case_id=$1::uuid and revision=$2 and mode=$5 and job_id is null',
  [input.caseId,payload.revision,job.job_id,input.nowMs,input.mode]));
 return job;
}
/** Call in the SAME transaction as result + traces + projection + job success.
 * Case row serialization also prevents a source change during publication. */
export async function lockCurrentSource(context:PostgresTransactionContext, candidate:SourceJob){
 const job=sourceJobSchema.parse(candidate);
 await context.client.query(statement('source_case_lock','select id from public.cases where id=$1::uuid for update',[job.case_id]));
 const selected=await context.client.query(statement('source_revision_check','select revision,input_sha256 from private.case_input_heads where case_id=$1::uuid',[job.case_id]));
 const row=selected.rows[0];
 if(!row||row.revision!==job.revision||row.input_sha256!==job.input_sha256)throw new Error('ANALYSIS_INPUT_SUPERSEDED');
}
