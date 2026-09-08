import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {admitSavedSource,savedCaseTenant} from './saved-admission';
import {SOURCE_JOB_KIND,sourceJobSchema} from './source-dispatch';
import {readSavedOrders,purchasedMonths} from './saved-order-scope';
import {runSavedWorkerExtraction,type SavedWorkerTransactions} from './saved-extraction-worker';
import {runSavedWorkerMonth} from './saved-worker';
import {completeSavedDraftJob} from './saved-job-completion';

type Lease={jobId:string;workerId:string;fencingToken:number};
type ExtractionInput=Parameters<typeof runSavedWorkerExtraction>[0];
export class SavedJobMissingDocuments extends Error {
 constructor(readonly months:readonly string[]){super('SAVED_PURCHASED_MONTH_DOCUMENT_REQUIRED');}
}
const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const storedMonth=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(?:-01)?$/u).transform(s=>s.slice(0,7));
const journalSchema=z.object({case_id:z.uuid(),month,documents:z.array(z.object({
 id:z.uuid(),version_id:z.uuid(),type:z.string(),month:storedMonth.nullable(),
}))});

/** This is a consumer of an already claimed/running saved-source job. Machine
 * provisioning and queue claiming stay with the host. It never grants itself a
 * tenant or claims a different kind of job. Case/source locks precede job locks. */
async function admit(context:PostgresTransactionContext,input:Lease){
 const read=async(lock:boolean)=>(await context.client.query(statement(lock?'saved_runner_lock':'saved_runner_read',
  `select job_kind,payload,payload_sha256,tenant_id,canonical_case_id,state,lease_owner,fencing_token,
   coalesce(lease_expires_at>clock_timestamp(),false) lease_valid,cancellation_requested
   from public.engine_durable_jobs where job_id=$1${lock?' for update':''}`,[input.jobId]))).rows[0];
 const initial=await read(false);if(!initial)throw new Error('SAVED_JOB_SCOPE');
 const job=sourceJobSchema.parse(initial.payload),tenant=savedCaseTenant(job.case_id);
 if(initial.job_kind!==SOURCE_JOB_KIND||initial.tenant_id!==tenant||initial.canonical_case_id!==job.case_id
  ||canonicalSha256(job)!==initial.payload_sha256)throw new Error('SAVED_JOB_SCOPE');
 await admitSavedSource(context,job);
 const locked=await read(true);
 if(!locked||locked.payload_sha256!==initial.payload_sha256||canonicalSha256(locked.payload)!==initial.payload_sha256
  ||locked.tenant_id!==tenant||locked.canonical_case_id!==job.case_id||locked.job_kind!==SOURCE_JOB_KIND)throw new Error('SAVED_JOB_SCOPE');
 if(Number(locked.fencing_token)!==input.fencingToken||locked.cancellation_requested!==false
  ||(locked.state!=='succeeded'&&(locked.state!=='running'||locked.lease_owner!==input.workerId||locked.lease_valid!==true)))throw new Error('SAVED_JOB_FENCE');
 return {job,completed:locked.state==='succeeded'};
}

async function plan(context:PostgresTransactionContext,input:Lease){
 const admitted=await admit(context,input);
 if(admitted.completed)return {...admitted,months:[],versions:[],missingMonths:[]};
 const orders=await readSavedOrders(context,admitted.job);
 const months=orders.flatMap(order=>purchasedMonths(order).map(month=>({orderId:order.id,month})));
 const result=await context.client.query(statement('saved_runner_journal',
  `select input,encode(sha256(convert_to(input::text,'UTF8')),'hex') actual_sha256
   from private.case_input_versions where case_id=$1::uuid and revision=$2 and input_sha256=$3`,
  [admitted.job.case_id,admitted.job.revision,admitted.job.input_sha256]));
 const row=result.rows[0];
 if(!row||row.actual_sha256!==admitted.job.input_sha256)throw new Error('SAVED_INPUT_HASH_MISMATCH');
 const journal=journalSchema.parse(row.input);
 if(journal.case_id!==admitted.job.case_id)throw new Error('SAVED_INPUT_CASE_MISMATCH');
 if(new Set(journal.documents.map(d=>d.version_id)).size!==journal.documents.length)throw new Error('SAVED_VERSION_DUPLICATE');
 const covered=new Set(months.map(m=>m.month));
 const documents=journal.documents.filter(d=>d.type==='payslip'&&covered.has(d.month??journal.month));
 const missingMonths=[...new Set(months.filter(m=>!documents.some(d=>(d.month??journal.month)===m.month)).map(m=>m.month))].sort();
 return {...admitted,months:months.filter(m=>!missingMonths.includes(m.month)),missingMonths,versions:documents.map(d=>d.version_id).sort()};
}

/** Database time is the authority. A delayed pulse cannot resurrect an expired,
 * cancelled or reclaimed job. This mutation takes only the job lock, and never
 * calls into a case lock afterwards. The host timer only decides when to ask. */
async function renew(context:PostgresTransactionContext,input:Lease,leaseMs:number){
 const result=await context.client.query(statement('saved_runner_heartbeat',
  `update public.engine_durable_jobs set lease_expires_at=clock_timestamp()+$4*interval '1 millisecond',
   updated_at=clock_timestamp(),revision=revision+1
   where job_id=$1 and lease_owner=$2 and fencing_token=$3 and state='running'
    and job_kind=$5 and not cancellation_requested and lease_expires_at>clock_timestamp()
   returning job_id`,[input.jobId,input.workerId,input.fencingToken,leaseMs,SOURCE_JOB_KIND]));
 if(result.row_count!==1)throw new Error('SAVED_JOB_FENCE');
}

/** Persist each extraction receipt and each monthly analysis independently,
 * then atomically acknowledge the complete purchased scope through the existing
 * finalizer. A crash reuses those receipts; no partial scope is called complete.
 * Unknown provider outcomes retain their existing reconciliation hold.
 *
 * Transactions MUST install the real scoped machine session each time. Calls
 * are serialized even if the host supplies a single DB connection. Heartbeats
 * may run during provider I/O, but extraction never holds its own DB transaction
 * across that I/O. A lost heartbeat still lets a known late response be saved;
 * subsequent admission prevents stale checkpoints, analysis or completion.
 */
export async function runSavedDraftJob(input:Lease&{
 transactions:SavedWorkerTransactions;storage:ExtractionInput['storage'];
 providerEnabled:boolean;extractor?:ExtractionInput['extractor'];signal?:AbortSignal;
 heartbeat?:{intervalMs:number;leaseMs:number};
}){
 z.string().min(1).parse(input.jobId);z.string().min(1).parse(input.workerId);z.number().int().positive().parse(input.fencingToken);
 const timing=input.heartbeat??{intervalMs:10000,leaseMs:60000};
 z.number().int().min(1000).max(60000).parse(timing.intervalMs);
 z.number().int().min(10000).max(300000).parse(timing.leaseMs);
 if(timing.intervalMs*3>timing.leaseMs)throw new Error('SAVED_HEARTBEAT_INTERVAL');
 let tail:Promise<unknown>=Promise.resolve();
 const transactions:SavedWorkerTransactions=operation=>{
  const run=tail.then(()=>input.transactions(operation));
  tail=run.then(()=>undefined,()=>undefined);return run;
 };
 let stopped=false,failure:{error:unknown}|null=null,timer:ReturnType<typeof setTimeout>|undefined,pulse:Promise<void>=Promise.resolve();
 const healthy=()=>{if(failure)throw failure.error;if(input.signal?.aborted)throw new Error('SAVED_JOB_INTERRUPTED');};
 const schedule=()=>{timer=setTimeout(()=>{
  pulse=transactions(context=>renew(context,input,timing.leaseMs)).then(()=>{if(!stopped)schedule();},error=>{failure={error};});
 },timing.intervalMs);};
 const stop=async()=>{stopped=true;if(timer)clearTimeout(timer);await pulse;};
 try{
  healthy();const saved=await transactions(context=>plan(context,input));
  if(saved.completed)return {completion:await transactions(context=>completeSavedDraftJob({...input,context})),extractedVersions:0,analyzedMonths:0};
  await transactions(context=>renew(context,input,timing.leaseMs));schedule();
  for(const versionId of saved.versions){
   healthy();await runSavedWorkerExtraction({...input,transactions,versionId});healthy();
  }
  for(const scope of saved.months){
   healthy();await transactions(async context=>{
    const current=await admit(context,input);
    if(current.completed)throw new Error('SAVED_JOB_ALREADY_COMPLETED');
    await runSavedWorkerMonth({context,job:current.job,...scope});
    // A long analysis must not commit after cancellation/expiry that occurred
    // while calculating. The same transaction rolls its stages back on refusal.
    await renew(context,input,timing.leaseMs);
   });healthy();
  }
  // Stop and drain the pulse before terminal success; no timer can race a
  // successful finalizer and turn its cleared lease into a spurious failure.
  await stop();healthy();
  // Available months remain committed and reusable. Missing months are neither
  // extrapolated nor dropped from the purchased scope's completion obligation.
  if(saved.missingMonths.length)throw new SavedJobMissingDocuments(saved.missingMonths);
  await transactions(context=>renew(context,input,timing.leaseMs));
  const completion=await transactions(context=>completeSavedDraftJob({...input,context}));
  return {completion,extractedVersions:saved.versions.length,analyzedMonths:saved.months.length};
 }finally{await stop();}
}
