import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {PostgresJobsOutboxAuditRepository} from '@/server/platform/persistence/postgres/runtime/jobs-outbox-audit';
import {admitSavedSource,savedCaseTenant} from './saved-admission';
import {dispatchCaseInput,SOURCE_JOB_KIND,sourceJobSchema} from './source-dispatch';
import {readSavedOrders} from './saved-order-scope';
import {runSavedDraftJob} from './saved-job-runner';

type Worker={caseId:string;workerId:string};
type Lease=Worker&{jobId:string;fencingToken:number};
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const jobRow=z.object({job_id:z.string(),tenant_id:z.string(),canonical_case_id:z.uuid(),job_kind:z.literal(SOURCE_JOB_KIND),
 payload:sourceJobSchema,payload_sha256:hash,state:z.enum(['queued','leased','running','retry_wait','succeeded','cancelled','dead_letter']),
 revision:z.coerce.number().int().positive(),fencing_token:z.coerce.number().int().nonnegative(),
 attempt_count:z.coerce.number().int().nonnegative(),max_attempts:z.coerce.number().int().positive(),
 lease_owner:z.string().nullable(),lease_valid:z.boolean(),due:z.boolean(),cancellation_requested:z.boolean()});

async function authorize(context:PostgresTransactionContext,input:Worker){
 z.string().min(1).max(160).parse(input.workerId);const tenant=savedCaseTenant(input.caseId);
 const result=await context.client.query(statement('saved_runtime_authority',
  'select session_user::text principal,private.runtime_verified_tenant() tenant_id',[]));
 if(result.rows[0]?.principal!=='tivdoc_worker_runtime'||result.rows[0]?.tenant_id!==tenant)throw new Error('SAVED_WORKER_SCOPE_FORBIDDEN');
 return tenant;
}
async function lockJob(context:PostgresTransactionContext,input:Worker,jobId:string){
 const result=await context.client.query(statement('saved_runtime_job_lock',
  `select *,coalesce(lease_expires_at>clock_timestamp(),false) lease_valid,available_at<=clock_timestamp() due
   from public.engine_durable_jobs where job_id=$1 and tenant_id=$2 and canonical_case_id=$3 for update`,
  [jobId,savedCaseTenant(input.caseId),input.caseId]));
 if(result.rows.length!==1)throw new Error('SAVED_JOB_SCOPE');const job=jobRow.parse(result.rows[0]);
 if(job.payload.case_id!==input.caseId||job.payload.mode!=='draft'||canonicalSha256(job.payload)!==job.payload_sha256)throw new Error('SAVED_JOB_SCOPE');
 return job;
}
async function audit(context:PostgresTransactionContext,input:Worker,job:z.infer<typeof jobRow>,reason:string){
 const now=await context.client.query(statement('saved_runtime_audit_time','select clock_timestamp()::text now',[]));
 await new PostgresJobsOutboxAuditRepository(context,savedCaseTenant(input.caseId),input.caseId).append({
  actor_id:input.workerId,action:'saved_job_transition',resource_id:job.job_id,resource_revision:job.revision,
  resource_sha256:job.payload_sha256,reason,occurred_at:new Date(String(now.rows[0].now)).toISOString(),
 });
}

/** Only the current source of this verified case is dispatched/claimed. No
 * tenant-wide claim can pick an unrelated or superseded job. Caller commits
 * dispatch, claim and audit together. All lease eligibility uses DB time. */
export async function claimSavedDraftJob(context:PostgresTransactionContext,input:Worker&{leaseMs:number}){
 z.number().int().min(10000).max(300000).parse(input.leaseMs);const tenant=await authorize(context,input);
 const heads=await context.client.query(statement('saved_runtime_head',
  'select revision,input_sha256 from private.case_input_heads where case_id=$1::uuid',[input.caseId]));
 if(!heads.rows[0])return {state:'idle' as const,reason:'no_saved_source'};
 const source=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:input.caseId,...heads.rows[0],mode:'draft'});
 await admitSavedSource(context,source);await readSavedOrders(context,source);
 const now=await context.client.query(statement('saved_runtime_clock',"select floor(extract(epoch from clock_timestamp())*1000)::bigint now_ms",[]));
 await dispatchCaseInput(context,{caseId:input.caseId,tenantId:tenant,mode:'draft',liveEnabled:false,nowMs:z.coerce.number().int().safe().parse(now.rows[0]?.now_ms)});
 const dispatch=await context.client.query(statement('saved_runtime_dispatch',
  "select job_id from private.case_analysis_dispatch where case_id=$1::uuid and revision=$2 and mode='draft'",[input.caseId,source.revision]));
 const id=dispatch.rows[0]?.job_id;if(typeof id!=='string')return {state:'idle' as const,reason:'no_draft_dispatch'};
 const job=await lockJob(context,input,id);
 if(canonicalSha256(job.payload)!==canonicalSha256(source))throw new Error('SAVED_JOB_SCOPE');
 if(job.state==='succeeded')return {state:'succeeded' as const,jobId:id,fencingToken:job.fencing_token};
 if(job.cancellation_requested||job.state==='cancelled'||job.state==='dead_letter')return {state:'held' as const,jobId:id,reason:job.state==='dead_letter'?'dead_letter':'cancelled'};
 if((job.state==='running'||job.state==='leased')?job.lease_valid:!job.due)return {state:'busy' as const,jobId:id};
 if(job.attempt_count>=job.max_attempts){
  await context.client.query(statement('saved_runtime_exhausted',
   "update public.engine_durable_jobs set state='dead_letter',revision=revision+1,lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp() where job_id=$1",[id]));
  await audit(context,input,{...job,revision:job.revision+1},'saved_attempts_exhausted');
  return {state:'held' as const,jobId:id,reason:'attempts_exhausted'};
 }
 const result=await context.client.query(statement('saved_runtime_claim',
  `update public.engine_durable_jobs set state='running',revision=revision+1,attempt_count=attempt_count+1,
   lease_owner=$2,lease_expires_at=clock_timestamp()+$3*interval '1 millisecond',fencing_token=fencing_token+1,updated_at=clock_timestamp()
   where job_id=$1 and not cancellation_requested and attempt_count<max_attempts
    and ((state in ('queued','retry_wait') and available_at<=clock_timestamp())
     or (state in ('leased','running') and lease_expires_at<=clock_timestamp())) returning fencing_token`,[id,input.workerId,input.leaseMs]));
 if(result.row_count!==1)throw new Error('SAVED_JOB_FENCE');
 const fencingToken=z.coerce.number().int().positive().parse(result.rows[0].fencing_token);
 await audit(context,input,{...job,revision:job.revision+1},job.state==='running'||job.state==='leased'?'saved_expired_lease_reclaimed':'saved_job_claimed');
 return {state:'claimed' as const,jobId:id,fencingToken};
}

/** Safe codes only: provider errors, document text, tokens and customer fields
 * never enter audit reasons. A hold is not provider failure or customer success. */
export function savedJobFailure(error:unknown){
 const code=error instanceof Error?error.message:'';
 if(code==='ANALYSIS_INPUT_SUPERSEDED')return {state:'cancelled' as const,reason:'saved_source_superseded'};
 if(code==='SAVED_JOB_INTERRUPTED')return {state:'retry_wait' as const,reason:'saved_worker_interrupted'};
 const holds:Readonly<Record<string,string>>={SAVED_PURCHASED_MONTH_DOCUMENT_REQUIRED:'saved_documents_missing',
  SAVED_EXTRACTION_OUTCOME_PENDING:'saved_provider_outcome_unknown',SAVED_EXTRACTION_PERIOD_MISMATCH:'saved_period_confirmation_required',
  SAVED_EXTRACTION_PROVIDER_DISABLED:'saved_provider_disabled',SAVED_EXTRACTION_PROVIDER_UNCONFIGURED:'saved_provider_unconfigured',
  SAVED_ORDER_ENTITLEMENT_REQUIRED:'saved_entitlement_unavailable',SAVED_PAID_SOURCE_REQUIRED:'saved_payment_unavailable'};
 return holds[code]?{state:'dead_letter' as const,reason:holds[code]}:{state:'retry_wait' as const,reason:'saved_processing_retry'};
}

/** Persist failure and audit atomically. No stale lease can clear a newer
 * worker or overwrite terminal success. Repeated failure receipts are read-only. */
export async function recordSavedJobFailure(context:PostgresTransactionContext,input:Lease,error:unknown){
 await authorize(context,input);
 await context.client.query(statement('saved_runtime_failure_case_lock','select id from public.cases where id=$1::uuid for update',[input.caseId]));
 const job=await lockJob(context,input,input.jobId);
 if(job.fencing_token!==input.fencingToken)throw new Error('SAVED_JOB_FENCE');
 if(job.state==='succeeded'||job.state==='retry_wait'||job.state==='dead_letter'||job.state==='cancelled')return {state:job.state,replayed:true};
 if(job.state!=='running'||job.lease_owner!==input.workerId||!job.lease_valid)throw new Error('SAVED_JOB_FENCE');
 const failure=job.cancellation_requested?{state:'cancelled' as const,reason:'saved_cancellation_requested'}:savedJobFailure(error);
 const state=failure.state==='retry_wait'&&job.attempt_count>=job.max_attempts?'dead_letter':failure.state;
 const reason=state==='dead_letter'&&failure.state==='retry_wait'?'saved_attempts_exhausted':failure.reason;
 const delay=30000*2**Math.max(0,Math.min(job.attempt_count-1,2));
 const result=await context.client.query(statement('saved_runtime_failure',
  `update public.engine_durable_jobs set state=$4,revision=revision+1,available_at=clock_timestamp()+$5*interval '1 millisecond',
   lease_owner=null,lease_expires_at=null,updated_at=clock_timestamp()
   where job_id=$1 and lease_owner=$2 and fencing_token=$3 and state='running' and lease_expires_at>clock_timestamp() returning job_id`,
  [input.jobId,input.workerId,input.fencingToken,state,delay]));
 if(result.row_count!==1)throw new Error('SAVED_JOB_FENCE');
 await audit(context,input,{...job,revision:job.revision+1},reason);
 return {state,reason,replayed:false};
}

/** One bounded host iteration for one provisioned case. Disabled configuration
 * is effect-free. There is no public HTTP endpoint, global tenant enumerator,
 * session minting or autonomous publication here. The host can schedule this
 * iteration using its real session-installing transaction adapter. */
export async function runSavedDraftOnce(input:Omit<Parameters<typeof runSavedDraftJob>[0],'jobId'|'fencingToken'>&{caseId:string;enabled:boolean}){
 if(!input.enabled||!input.providerEnabled)return {state:'disabled' as const};
 const claim=await input.transactions(context=>claimSavedDraftJob(context,{...input,leaseMs:input.heartbeat?.leaseMs??60000}));
 if(claim.state!=='claimed'&&claim.state!=='succeeded')return claim;
 const lease={...input,jobId:claim.jobId,fencingToken:claim.fencingToken};
 try{return {state:'succeeded' as const,result:await runSavedDraftJob(lease)};}
 catch(error){
  const failure=await input.transactions(context=>recordSavedJobFailure(context,lease,error));
  if(failure.state==='succeeded')return {state:'succeeded' as const,result:await runSavedDraftJob(lease)};
  const state=z.enum(['retry_wait','dead_letter','cancelled']).parse(failure.state);
  return {...failure,state,jobId:claim.jobId};
 }
}
