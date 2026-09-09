import 'server-only';
import {z} from 'zod';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {claimSavedDraftJob,recordSavedJobFailure} from './saved-job-runtime';
import {runSavedDraftJob,type SavedMonthCompletion} from './saved-job-runner';
import {sourceJobSchema} from './source-dispatch';
import {admitSavedSource} from './saved-admission';
import {readSavedOrders} from './saved-order-scope';
import type {SavedWorkerTransactions} from './saved-extraction-worker';
import {managedWorkerError} from './managed-worker-contract';

type Runner=Parameters<typeof runSavedDraftJob>[0];
/** Bound scope before claiming or spending provider work. The SQL enrollment
 * is a separate authorization gate; this adapter cannot authorize new cases. */
async function scope(context:PostgresTransactionContext,caseId:string){
 const result=await context.client.query(statement('managed_worker_scope',
  `select current_database() database,c.is_qa,h.revision,h.input_sha256,v.input
   from public.cases c join private.case_input_heads h on h.case_id=c.id
   join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision
   where c.id=$1::uuid`,[caseId]));
 const row=result.rows[0];
 if(!row||row.database!=='tivdoc_release_replay_20260907'||row.is_qa!==true)throw Error('MANAGED_DEV_SCOPE_UNSUPPORTED');
 const job=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:caseId,revision:row.revision,input_sha256:row.input_sha256,mode:'draft'});
 await admitSavedSource(context,job);
 const orders=await readSavedOrders(context,job);
 if(orders.length!==1||orders[0].kind!=='initial'||orders[0].from!=='2026-06-01'||orders[0].to!=='2026-06-01'
  ||orders[0].topics.length!==1||orders[0].topics[0]!=='minimum_wage')throw Error('MANAGED_DEV_SCOPE_UNSUPPORTED');
 const input=z.object({month:z.literal('2026-06'),documents:z.array(z.object({type:z.string(),month:z.string().nullable()}))}).parse(row.input);
 const payslips=input.documents.filter(d=>d.type==='payslip');
 if(payslips.length!==1||payslips.some(d=>d.month!==null&&!['2026-06','2026-06-01'].includes(d.month)))throw Error('MANAGED_DEV_SCOPE_UNSUPPORTED');
}

export async function runManagedDevCase(input:{caseId:string;workerId:string;transactions:SavedWorkerTransactions;
 storage:Runner['storage'];extractor:Runner['extractor'];providerEnabled:boolean;onMonth:SavedMonthCompletion;signal?:AbortSignal}){
 if(input.signal?.aborted)return {caseId:input.caseId,state:'interrupted' as const};
 const claim=await input.transactions(async context=>{
  await scope(context,input.caseId);
  const value=await claimSavedDraftJob(context,{caseId:input.caseId,workerId:input.workerId,leaseMs:180000});
  // The registry/session + shared daily budget check is atomic with the real
  // queue claim. Concurrent ticks cannot reserve extra attempts outside it.
  if(value.state==='claimed')await context.client.query(statement('managed_worker_admit_claim','select private.managed_dev_worker_admit_claim($1::uuid,$2,$3)',[input.caseId,value.jobId,value.fencingToken]));
  return value;
 });
 if(claim.state!=='claimed')return {caseId:input.caseId,...claim};
 const lease={caseId:input.caseId,workerId:input.workerId,jobId:claim.jobId,fencingToken:claim.fencingToken};
 const note=async(context:PostgresTransactionContext,error:string|null)=>{
  await context.client.query(statement('managed_worker_note','select private.managed_dev_worker_note($1::uuid,$2,$3,$4)',[input.caseId,claim.jobId,claim.fencingToken,error]));
 };
 try{
  // No timer outlives the existing runner, no external I/O in a transaction.
  const result=await runSavedDraftJob({...input,...lease,heartbeat:{intervalMs:10000,leaseMs:180000}});
  await input.transactions(context=>note(context,null));
  return {caseId:input.caseId,state:'succeeded' as const,jobId:claim.jobId,manifestSha256:result.completion.sha256};
 }catch(error){
  const safe=managedWorkerError(error);
  // If the lease was already reclaimed, this transition is refused. Its new
  // owner remains authoritative and the scheduler may simply read its state.
  try{
   const failure=await input.transactions(async context=>{
    const value=await recordSavedJobFailure(context,lease,error);
    if(value.state!=='succeeded')await note(context,safe);
    return value;
   });
   return {caseId:input.caseId,state:failure.state,jobId:claim.jobId,lastError:failure.state==='succeeded'?null:safe};
  }catch{return {caseId:input.caseId,state:'unconfirmed' as const,jobId:claim.jobId,lastError:safe};}
 }
}
