import 'server-only';
import {z} from 'zod';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {claimSavedDraftJob,recordSavedJobFailure} from './saved-job-runtime';
import {runSavedDraftJob,type SavedMonthCompletion} from './saved-job-runner';
import {sourceJobSchema} from './source-dispatch';
import {admitSavedSource} from './saved-admission';
import {readSavedOrders,purchasedMonths} from './saved-order-scope';
import type {SavedWorkerTransactions} from './saved-extraction-worker';
import {managedWorkerError} from './managed-worker-contract';

type Runner=Parameters<typeof runSavedDraftJob>[0];
/** Bound scope before claiming or spending provider work. The SQL enrollment
 * is a separate authorization gate; this adapter cannot authorize new cases. */
async function scope(context:PostgresTransactionContext,caseId:string){
 const result=await context.client.query(statement('managed_worker_scope',
  `select current_database() database,c.is_qa,h.revision,h.input_sha256,v.input,d.authority_dependency_sha256
   from public.cases c join private.case_input_heads h on h.case_id=c.id
   join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision
   left join private.case_analysis_dispatch d on d.case_id=h.case_id and d.revision=h.revision and d.mode='draft'
   where c.id=$1::uuid`,[caseId]));
 const row=result.rows[0];
 if(!row||row.database!=='tivdoc_release_replay_20260907'||row.is_qa!==true)throw Error('MANAGED_DEV_SCOPE_UNSUPPORTED');
 const job=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:caseId,revision:row.revision,input_sha256:row.input_sha256,mode:'draft',
  ...(row.authority_dependency_sha256==null?{}:{authority_dependency_sha256:row.authority_dependency_sha256})});
 await admitSavedSource(context,job);
 const orders=await readSavedOrders(context,job);
 if(orders.length===1&&orders[0].kind==='legacy_initial'){
  // Enrollment, current receipt, machine session and the shared spend ceiling
  // still apply. This is private draft processing in the isolated QA database.
  const months=purchasedMonths(orders[0]);
  if(months.length<1||months.length>12)throw Error('MANAGED_DEV_SCOPE_UNSUPPORTED');
  const source=z.object({documents:z.array(z.object({type:z.string(),month:z.string().nullable()})).max(24)}).parse(row.input);
  if(source.documents.some(d=>d.type==='payslip'&&(!d.month||!months.includes(d.month.slice(0,7)))))throw Error('MANAGED_DEV_SCOPE_UNSUPPORTED');
  return;
 }
 if(orders.length!==1||!['initial','full'].includes(orders[0].kind)||orders[0].from!=='2026-06-01'||orders[0].to!=='2026-06-01'
  ||orders[0].topics.length!==1||orders[0].topics[0]!=='minimum_wage')throw Error('MANAGED_DEV_SCOPE_UNSUPPORTED');
 if(orders[0].kind==='full'){
  const offer=await context.client.query(statement('managed_worker_full_ai_offer',
   `select o.id from private.product_orders o join private.order_entitlements e on e.order_id=o.id
    where o.id=$1::uuid and o.case_id=$2::uuid and o.offer_sha256=$3 and o.kind='full'
     and o.state='paid' and o.refund_state<>'refunded' and e.state='active'
     and o.offer->>'version'='tivdoc-order-offer-v2' and o.offer->>'service_kind'='ai_assisted'
     and o.offer->'human_review_required'='false'::jsonb`,[orders[0].id,caseId,orders[0].offer_sha256]));
  if(offer.rows.length!==1||offer.rows[0].id!==orders[0].id)throw Error('MANAGED_DEV_SCOPE_UNSUPPORTED');
 }
 const input=z.object({month:z.literal('2026-06'),documents:z.array(z.object({type:z.string(),month:z.string().nullable()}))}).parse(row.input);
 const payslips=input.documents.filter(d=>d.type==='payslip');
 if(payslips.length!==1||payslips.some(d=>d.month!==null&&!['2026-06','2026-06-01'].includes(d.month)))throw Error('MANAGED_DEV_SCOPE_UNSUPPORTED');
}

export async function runManagedDevCase(input:{caseId:string;workerId:string;transactions:SavedWorkerTransactions;
 storage:Runner['storage'];extractor:Runner['extractor'];documentEvidence?:Runner['documentEvidence'];providerEnabled:boolean;receiptOnly?:boolean;onMonth:SavedMonthCompletion;signal?:AbortSignal}){
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
  const deferred=result.deferredEvidence?.[0],lastError=deferred?managedWorkerError(new Error(deferred.code)):null;
  await input.transactions(context=>note(context,lastError));
  return {...(deferred?{deferredEvidence:result.deferredEvidence,lastError}:{}),caseId:input.caseId,state:'succeeded' as const,jobId:claim.jobId,manifestSha256:result.completion.sha256};
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
