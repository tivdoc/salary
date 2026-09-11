import {loadJune2026TestAuthority,june2026TestIdempotencyKey} from "./saved-june2026-test-authority";
import {loadSavedJune2026RegularAuthority,june2026RegularIdempotencyKey,june2026RegularReviewIdempotencyKey} from './saved-june2026-regular-authority';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {decodeCommand} from '@/server/platform/persistence/postgres/analysis/validation';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {admitSavedSource,savedCaseTenant} from './saved-admission';
import {purchasedMonths,readSavedOrders,savedMonthIdempotencyKey,type SavedOrderScope} from './saved-order-scope';
import {SOURCE_JOB_KIND,sourceJobSchema,type SourceJob} from './source-dispatch';
import {resolveSavedDocumentReviewKey} from './document-review-key';

const sha=z.string().regex(/^[a-f0-9]{64}$/);
const jobRow=z.object({job_id:z.string(),tenant_id:z.string(),canonical_case_id:z.uuid(),job_kind:z.literal(SOURCE_JOB_KIND),
 payload:sourceJobSchema,payload_sha256:sha,state:z.string(),fencing_token:z.coerce.number().int().nonnegative(),
 lease_owner:z.string().nullable(),lease_valid:z.boolean(),cancellation_requested:z.boolean(),terminal_effect_sha256:sha.nullable()});
const receiptSchema=z.object({idempotency_key:z.string(),analysis_run_id:z.string(),command:z.unknown(),command_sha256:sha,
 result_sha256:sha,report_id:z.string(),report_revision:z.coerce.number().int().positive(),report_sha256:sha});
const EFFECT_KIND='saved_analysis_draft_ready_v1';
const manifestMonthSchema=z.object({order_id:z.uuid(),offer_sha256:sha,month:z.string().regex(/^\d{4}-\d{2}$/),
 analysis_run_id:z.string().min(1),result_sha256:sha,report_id:z.string().min(1),
 report_revision:z.number().int().positive(),report_sha256:sha}).strict();
const manifestSchema=z.object({schema_version:z.literal(EFFECT_KIND),job_id:z.string().min(1),source:sourceJobSchema,
 publication:z.literal('draft'),months:z.array(manifestMonthSchema).min(1)}).strict();

/** Historical success is only a read of an immutable receipt. It still requires
 * a real machine session, the same current source and paid scopes. Unlike new
 * work it cannot create admission events or depend on today's authority token. */
async function lockTerminalReplaySource(context:PostgresTransactionContext,job:SourceJob,tenant:string){
 if(job.mode!=='draft')throw new Error('SAVED_LIVE_COMPOSITION_NOT_ENABLED');
 const authority=await context.client.query(statement('saved_job_replay_authority',
  'select private.runtime_verified_tenant() tenant_id, session_user::text principal',[]));
 if(authority.rows.length!==1||authority.rows[0].tenant_id!==tenant||authority.rows[0].principal!=='tivdoc_worker_runtime')throw new Error('SAVED_WORKER_SCOPE_FORBIDDEN');
 const locked=await context.client.query(statement('saved_job_replay_case_lock',
  'select id from public.cases where id=$1::uuid for update',[job.case_id]));
 if(locked.rows.length!==1||locked.rows[0].id!==job.case_id)throw new Error('SAVED_JOB_SCOPE');
 const head=await context.client.query(statement('saved_job_replay_source_head',
  'select revision,input_sha256 from private.case_input_heads where case_id=$1::uuid',[job.case_id]));
 if(head.rows.length!==1||head.rows[0].revision!==job.revision||head.rows[0].input_sha256!==job.input_sha256)throw new Error('ANALYSIS_INPUT_SUPERSEDED');
}

async function replayTerminalManifest(context:PostgresTransactionContext,jobId:string,job:SourceJob,tenant:string,
 terminalHash:string|null,orders:SavedOrderScope[]){
 const existing=await context.client.query(statement('saved_job_manifest_replay',
  `select payload,payload_sha256 from public.engine_outbox_events where tenant_id=$1 and canonical_case_id=$2
   and outbox_id=$3 and logical_effect_id=$4 and effect_kind=$5`,[tenant,job.case_id,`saved-draft:${jobId}`,jobId,EFFECT_KIND]));
 if(existing.rows.length!==1||!terminalHash||existing.rows[0].payload_sha256!==terminalHash
  ||canonicalSha256(existing.rows[0].payload)!==terminalHash)throw new Error('SAVED_JOB_MANIFEST_MISMATCH');
 const parsed=manifestSchema.safeParse(existing.rows[0].payload);
 if(!parsed.success||canonicalSha256(parsed.data)!==terminalHash)throw new Error('SAVED_JOB_MANIFEST_MISMATCH');
 const manifest=parsed.data;
 if(manifest.job_id!==jobId||canonicalSha256(manifest.source)!==canonicalSha256(job))throw new Error('SAVED_JOB_MANIFEST_MISMATCH');
 const expected=orders.flatMap(order=>purchasedMonths(order).map(month=>({order,month})));
 if(manifest.months.length!==expected.length
  ||new Set(manifest.months.map(month=>month.analysis_run_id)).size!==expected.length)throw new Error('SAVED_JOB_MANIFEST_MISMATCH');
 for(const [index,{order,month}] of expected.entries()){
  const saved=manifest.months[index];
  if(saved.order_id!==order.id||saved.offer_sha256!==order.offer_sha256||saved.month!==month)throw new Error('SAVED_JOB_MANIFEST_MISMATCH');
 }
 // Select the historical run IDs, never keys derived from current approvals.
 // The joins bind each report to its immutable completed analysis bundle.
 const selected=await context.client.query(statement('saved_job_replay_month_receipts',
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
    and ar.canonical_analysis_run_id in(select jsonb_array_elements_text($3::jsonb))`,
  [tenant,job.case_id,JSON.stringify(manifest.months.map(month=>month.analysis_run_id))]));
 const receipts=selected.rows.map(row=>receiptSchema.parse(row));
 if(receipts.length!==expected.length||new Set(receipts.map(row=>row.analysis_run_id)).size!==expected.length
  ||new Set(receipts.map(row=>row.idempotency_key)).size!==expected.length)throw new Error('SAVED_JOB_MONTHS_INCOMPLETE');
 const byRun=new Map(receipts.map(row=>[row.analysis_run_id,row]));
 for(const [index,{order,month}] of expected.entries()){
  const saved=manifest.months[index],receipt=byRun.get(saved.analysis_run_id);
  if(!receipt)throw new Error('SAVED_JOB_MONTHS_INCOMPLETE');
  const command=decodeCommand(receipt.command);
  const end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
  if(canonicalSha256(command)!==receipt.command_sha256||command.case_id!==job.case_id
   ||command.idempotency_key!==receipt.idempotency_key||command.period.start_date!==`${month}-01`||command.period.end_date!==end
   ||canonicalSha256(command.requested_topics)!==canonicalSha256(order.topics)
   ||receipt.result_sha256!==saved.result_sha256||receipt.report_id!==saved.report_id
   ||receipt.report_revision!==saved.report_revision||receipt.report_sha256!==saved.report_sha256)throw new Error('SAVED_JOB_RECEIPT_SCOPE');
 }
 return {manifest,sha256:terminalHash,replayed:true};
}

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
 if(initial.job_id!==input.jobId||initial.tenant_id!==tenant||initial.canonical_case_id!==job.case_id||canonicalSha256(job)!==initial.payload_sha256)throw new Error('SAVED_JOB_SCOPE');
 if(initial.state==='succeeded')await lockTerminalReplaySource(context,job,tenant);
 else await admitSavedSource(context,job);
 const locked=await load(true);
 if(locked.job_id!==input.jobId||locked.payload_sha256!==initial.payload_sha256||canonicalSha256(locked.payload)!==initial.payload_sha256||locked.tenant_id!==tenant||locked.canonical_case_id!==job.case_id)throw new Error('SAVED_JOB_SCOPE');
 if(initial.state==='succeeded'&&locked.state!=='succeeded')throw new Error('SAVED_JOB_FENCE');
 if(locked.fencing_token!==input.fencingToken||locked.cancellation_requested)throw new Error('SAVED_JOB_FENCE');
 if(locked.state!=='succeeded'&&(locked.state!=='running'||locked.lease_owner!==input.workerId||!locked.lease_valid))throw new Error('SAVED_JOB_FENCE');
 const orders=await readSavedOrders(context,job);
 if(locked.state==='succeeded')return replayTerminalManifest(context,input.jobId,job,tenant,locked.terminal_effect_sha256,orders);
 const expected=[];
 for(const order of orders)for(const month of purchasedMonths(order)){
  const june=month==='2026-06'&&order.topics.length===1&&order.topics[0]==='minimum_wage';
  const authority=june?await loadJune2026TestAuthority(context,job,order.id):null;
  // Match the analysis composition exactly. A revoked/expired regular authority
  // selects its blocked review key, never a formerly authorized result.
  const regular=!authority&&june?await loadSavedJune2026RegularAuthority(context,job,order.id):null;
  const ready=regular?.state==='ready'?regular:null;
  const baseKey=authority?june2026TestIdempotencyKey(job,order.id,authority):ready?june2026RegularIdempotencyKey(job,order.id,ready)
   :june?june2026RegularReviewIdempotencyKey(job,order.id):savedMonthIdempotencyKey(job,order.id,month);
  const review=authority||ready?null:await resolveSavedDocumentReviewKey(context,job,order,month,baseKey);
  expected.push({order,month,key:review?.key??baseKey,reviewSha256:review?.reviewSha256,
   mode:authority?'synthetic_test':ready?.mode??'real'});
 }
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
 const months=expected.map(({order,month,key,mode,reviewSha256})=>{
  const receipt=byKey.get(key);if(!receipt)throw new Error('SAVED_JOB_MONTHS_INCOMPLETE');
  const command=decodeCommand(receipt.command);
  const end=new Date(Date.UTC(Number(month.slice(0,4)),Number(month.slice(5,7)),0)).toISOString().slice(0,10);
  if(canonicalSha256(command)!==receipt.command_sha256||command.case_id!==job.case_id||command.idempotency_key!==key
   ||command.period.start_date!==`${month}-01`||command.period.end_date!==end
   ||canonicalSha256(command.requested_topics)!==canonicalSha256(order.topics)||command.mode!==mode
   ||command.document_review_sha256!==reviewSha256)throw new Error('SAVED_JOB_RECEIPT_SCOPE');
  return {order_id:order.id,offer_sha256:order.offer_sha256,month,analysis_run_id:receipt.analysis_run_id,
   result_sha256:receipt.result_sha256,report_id:receipt.report_id,report_revision:receipt.report_revision,report_sha256:receipt.report_sha256};
 });
 const manifest={schema_version:EFFECT_KIND,job_id:input.jobId,source:job,publication:'draft',months} as const;
 const hash=canonicalSha256(manifest),outboxId=`saved-draft:${input.jobId}`;
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
