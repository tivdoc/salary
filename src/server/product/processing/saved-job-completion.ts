import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {decodeCommand} from '@/server/platform/persistence/postgres/analysis/validation';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {admitSavedSource,savedCaseTenant} from './saved-admission';
import {purchasedMonths,readSavedOrders,savedMonthIdempotencyKey} from './saved-order-scope';
import {SOURCE_JOB_KIND,sourceJobSchema} from './source-dispatch';

const sha=z.string().regex(/^[a-f0-9]{64}$/);
const jobRow=z.object({job_id:z.string(),tenant_id:z.string(),canonical_case_id:z.uuid(),job_kind:z.literal(SOURCE_JOB_KIND),
 payload:sourceJobSchema,payload_sha256:sha,state:z.string(),fencing_token:z.coerce.number().int().nonnegative(),
 lease_owner:z.string().nullable(),lease_valid:z.boolean(),cancellation_requested:z.boolean(),terminal_effect_sha256:sha.nullable()});
const receiptSchema=z.object({idempotency_key:z.string(),analysis_run_id:z.string(),command:z.unknown(),command_sha256:sha,
 result_sha256:sha,report_id:z.string(),report_revision:z.coerce.number().int().positive(),report_sha256:sha});
const EFFECT_KIND='saved_analysis_draft_ready_v1';

/** Draft completion only. The caller owns ONE transaction and must roll it back
 * on error. No provider, customer projection, entitlement grant or human approval.
 * Locks case before job, reads compact immutable receipts once, and atomically
 * records one outbox manifest with terminal success using the database clock. */
export async function completeSavedDraftJob(input:{context:PostgresTransactionContext;jobId:string;workerId:string;fencingToken:number}){
 const {context}=input;z.string().min(1).parse(input.jobId);z.string().min(1).parse(input.workerId);z.number().int().positive().parse(input.fencingToken);
 const load=async(lock:boolean)=>{
  const rows=await context.client.query(statement(lock?'saved_job_lock':'saved_job_read',
   `select job_id,tenant_id,canonical_case_id,job_kind,payload,payload_sha256,state,fencing_token,lease_owner,
    coalesce(lease_expires_at>clock_timestamp(),false) lease_valid,cancellation_requested,terminal_effect_sha256
    from public.engine_durable_jobs where job_id=$1${lock?' for update':''}`,[input.jobId]));
  if(rows.rows.length!==1)throw new Error('SAVED_JOB_SCOPE');return jobRow.parse(rows.rows[0]);
 };
 const initial=await load(false),job=initial.payload,tenant=savedCaseTenant(job.case_id);
 if(initial.tenant_id!==tenant||initial.canonical_case_id!==job.case_id||canonicalSha256(job)!==initial.payload_sha256)throw new Error('SAVED_JOB_SCOPE');
 await admitSavedSource(context,job);
 const locked=await load(true);
 if(locked.payload_sha256!==initial.payload_sha256||canonicalSha256(locked.payload)!==initial.payload_sha256||locked.tenant_id!==tenant||locked.canonical_case_id!==job.case_id)throw new Error('SAVED_JOB_SCOPE');
 if(locked.fencing_token!==input.fencingToken||locked.cancellation_requested)throw new Error('SAVED_JOB_FENCE');
 if(locked.state!=='succeeded'&&(locked.state!=='running'||locked.lease_owner!==input.workerId||!locked.lease_valid))throw new Error('SAVED_JOB_FENCE');
 const orders=await readSavedOrders(context,job);
 const expected=orders.flatMap(order=>purchasedMonths(order).map(month=>({order,month,key:savedMonthIdempotencyKey(job,order.id,month)})));
 const selected=await context.client.query(statement('saved_job_month_receipts',
  `select ar.idempotency_key,ar.canonical_analysis_run_id analysis_run_id,ar.command_payload command,ar.command_sha256,
   r.analysis_result_sha256 result_sha256,r.report_id,r.revision report_revision,r.report_sha256
   from public.analysis_runs ar join public.engine_report_versions r on r.analysis_run_id=ar.id
    and r.tenant_id=ar.tenant_id and r.canonical_case_id=ar.canonical_case_id
    and r.canonical_analysis_run_id=ar.canonical_analysis_run_id
    and r.analysis_result_sha256=ar.completion_payload->'bundle'->>'result_sha256'
    and r.report_sha256=ar.completion_payload->'report'->>'report_sha256'
    and r.report_id=ar.completion_payload->'report'->>'report_id'
    and r.revision=(ar.completion_payload->'report'->>'report_revision')::integer
   where ar.tenant_id=$1 and ar.canonical_case_id=$2 and ar.status='completed'
    and ar.idempotency_key in(select jsonb_array_elements_text($3::jsonb))`,
  [tenant,job.case_id,JSON.stringify(expected.map(e=>e.key))]));
 const receipts=selected.rows.map(row=>receiptSchema.parse(row));
 if(receipts.length!==expected.length||new Set(receipts.map(r=>r.idempotency_key)).size!==expected.length)throw new Error('SAVED_JOB_MONTHS_INCOMPLETE');
 const byKey=new Map(receipts.map(r=>[r.idempotency_key,r]));
 const months=expected.map(({order,month,key})=>{
  const receipt=byKey.get(key);if(!receipt)throw new Error('SAVED_JOB_MONTHS_INCOMPLETE');
  const command=decodeCommand(receipt.command);
  const end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
  if(canonicalSha256(command)!==receipt.command_sha256||command.case_id!==job.case_id||command.idempotency_key!==key
   ||command.period.start_date!==`${month}-01`||command.period.end_date!==end
   ||canonicalSha256(command.requested_topics)!==canonicalSha256(order.topics))throw new Error('SAVED_JOB_RECEIPT_SCOPE');
  return {order_id:order.id,offer_sha256:order.offer_sha256,month,analysis_run_id:receipt.analysis_run_id,
   result_sha256:receipt.result_sha256,report_id:receipt.report_id,report_revision:receipt.report_revision,report_sha256:receipt.report_sha256};
 });
 const manifest={schema_version:EFFECT_KIND,job_id:input.jobId,source:job,publication:'draft',months} as const;
 const hash=canonicalSha256(manifest),outboxId=`saved-draft:${input.jobId}`;
 if(locked.state==='succeeded'){
  const existing=await context.client.query(statement('saved_job_manifest_replay',
   `select payload,payload_sha256 from public.engine_outbox_events where tenant_id=$1 and canonical_case_id=$2
    and outbox_id=$3 and logical_effect_id=$4 and effect_kind=$5`,[tenant,job.case_id,outboxId,input.jobId,EFFECT_KIND]));
  if(locked.terminal_effect_sha256!==hash||existing.rows.length!==1||existing.rows[0].payload_sha256!==hash||canonicalSha256(existing.rows[0].payload)!==hash)throw new Error('SAVED_JOB_MANIFEST_MISMATCH');
  return {manifest,sha256:hash,replayed:true};
 }
 // A single SQL statement makes cancellation/expiry refusal effect-free, even
 // if a caller mistakenly catches that refusal without rolling back its work.
 const finished=await context.client.query(statement('saved_job_complete_atomic',
  `with finished as (
   update public.engine_durable_jobs set state='succeeded',revision=revision+1,terminal_effect_sha256=$5,
    lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp()
   where job_id=$1 and tenant_id=$2 and lease_owner=$3 and fencing_token=$4 and state='running'
    and not cancellation_requested and lease_expires_at>clock_timestamp() returning job_id
  ) insert into public.engine_outbox_events(outbox_id,tenant_id,canonical_case_id,logical_effect_id,effect_kind,payload,payload_sha256,state,fencing_token,created_at)
   select $6,$2,$7,job_id,$8,$9::jsonb,$5,'pending',0,clock_timestamp() from finished returning outbox_id`,
  [input.jobId,tenant,input.workerId,input.fencingToken,hash,outboxId,job.case_id,EFFECT_KIND,JSON.stringify(manifest)]));
 if(finished.row_count!==1)throw new Error('SAVED_JOB_FENCE');
 return {manifest,sha256:hash,replayed:false};
}
