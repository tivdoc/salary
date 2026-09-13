import 'server-only';
import {z} from 'zod';
import {deepFreeze} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {sourceJobSchema,type SourceJob} from './source-dispatch';
import {admitSavedSource,savedCaseTenant} from './saved-admission';
import {loadSavedRealAiServiceConfiguration} from './saved-real-ai-service-configuration';
import {readSavedOrders,purchasedMonths} from './saved-order-scope';
import {PURCHASE_TOPICS_VERSION} from '../orders/purchase-topics';
import {claimSavedDraftJob,recordSavedJobFailure} from './saved-job-runtime';
import {runSavedDraftJob} from './saved-job-runner';
import {completeRealAiServiceMonth} from './automatic-real-service';
import {managedWorkerError} from './managed-worker-contract';
import type {SavedWorkerTransactions} from './saved-worker-contracts';

const hash=z.string().regex(/^[a-f0-9]{64}$/u),time=z.iso.datetime({offset:true});
const opaque=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u);
export const realServiceCandidateSchema=z.object({case_id:z.uuid(),identity_id:z.uuid(),enrollment_id:z.uuid(),source_revision:z.number().int().positive(),
 source_sha256:hash,authority_dependency_sha256:hash,plan_sha256:hash,expires_at:time}).strict();
export type RealServiceCandidate=z.infer<typeof realServiceCandidateSchema>;
export const realServiceClaimAdmissionSchema=z.object({state:z.literal('admitted'),reservation_id:opaque,case_id:z.uuid(),job_id:opaque,
 fencing_token:z.number().int().positive(),source_sha256:hash,authority_dependency_sha256:hash,plan_sha256:hash,
 provider_budget_policy_sha256:hash,extraction_mode:z.enum(['saved_receipts_only','budgeted_provider']),expires_at:time}).strict();
export type RealServiceClaimAdmission=z.infer<typeof realServiceClaimAdmissionSchema>;
export type RealServiceClaimRequest=Readonly<{candidate:RealServiceCandidate;job:SourceJob;workerId:string;jobId:string;fencingToken:number;providerBudgetPolicySha256:string;extraction_mode:RealServiceClaimAdmission['extraction_mode']}>;
/** The implementation must reserve the actual shared budget using this SAME
 * transaction and fence, including explicit zero-spend policy authorization for
 * saved_receipts_only. A separate transaction or promise of later admission
 * cannot implement this port. A refusal must throw, rolling the claim back. */
export type RealServiceClaimAdmissionPort=(context:PostgresTransactionContext,input:RealServiceClaimRequest)=>Promise<unknown>;
type Runner=Parameters<typeof runSavedDraftJob>[0];
export type RealServiceBudgetedExtraction=Readonly<{mode:'saved_receipts_only'}|{mode:'budgeted_provider';
 /** The trusted provider adapter binds every call to this exact reservation,
  * rechecking its own expiry/spend ceiling. It must never create an unbudgeted
  * SDK or reinterpret an unknown provider outcome as available credit. */
 forClaim:(admission:RealServiceClaimAdmission)=>Promise<{extractor:NonNullable<Runner['extractor']>;
  documentEvidence?:{extractor:NonNullable<NonNullable<Runner['documentEvidence']>['extractor']>}}>}>;
export type RealServiceManagedCaseInput=Readonly<{candidate:RealServiceCandidate;workerId:string;transactions:SavedWorkerTransactions;
 storage:Runner['storage'];extraction:RealServiceBudgetedExtraction;admitClaim:RealServiceClaimAdmissionPort;providerBudgetPolicySha256:string;signal?:AbortSignal}>;

export function realServiceRunError(error:unknown):string{
 const code=error instanceof Error?error.message:'';
 const known:Readonly<Record<string,string>>={REAL_SERVICE_RUN_SCOPE:'real_scope_changed',REAL_SERVICE_RUN_EXPIRED:'real_scope_expired',
  REAL_SERVICE_RUN_ORDER_SCOPE:'real_purchase_scope_changed',REAL_SERVICE_RUN_CLAIM_ADMISSION:'claim_admission_changed',
  REAL_SERVICE_RUN_BUDGET_REQUIRED:'claim_budget_unconfigured',REAL_SERVICE_RUN_EXTRACTOR_REQUIRED:'budgeted_provider_unconfigured',
  REAL_SERVICE_BUDGET_EXHAUSTED:'provider_budget_exhausted',REAL_SERVICE_BUDGET_EXPIRED:'provider_budget_expired',
  REAL_SERVICE_WORKER_DISABLED:'real_service_disabled',REAL_SERVICE_WORKER_EXPIRED:'real_scope_expired',REAL_SERVICE_WORKER_REVOKED:'real_scope_revoked',
  REAL_SERVICE_WORKER_PLAN_SCOPE:'real_plan_changed',REAL_SERVICE_PROCESSING_ENROLLMENT_EXPIRED:'real_scope_expired',
  REAL_SERVICE_PROCESSING_CONFIGURATION_EXPIRED:'real_scope_expired',REAL_SERVICE_PROCESSING_EXPIRED:'real_scope_expired',
  REAL_SERVICE_PROCESSING_REVOKED:'real_scope_revoked',REAL_SERVICE_PROCESSING_SOURCE_SUPERSEDED:'source_superseded'};
 return known[code]??managedWorkerError(error);
}
function enabled(){return process.env.TIVDOC_REAL_AI_SERVICE_ENABLED==='1';}
function current(candidate:RealServiceCandidate,signal?:AbortSignal){
 if(signal?.aborted)throw Error('SAVED_JOB_INTERRUPTED');
 if(!enabled())throw Error('REAL_SERVICE_WORKER_DISABLED');
 if(Date.now()>=Date.parse(candidate.expires_at))throw Error('REAL_SERVICE_RUN_EXPIRED');
}

/** Scope is reconstructed before a queue mutation, under the installed REAL
 * host. A queued candidate is a selector, never processing authority. */
async function scope(context:PostgresTransactionContext,candidate:RealServiceCandidate){
 const rows=await context.client.query(statement('real_service_managed_scope',
  `select c.is_qa,h.revision,h.input_sha256,d.processing_profile,d.authority_dependency_sha256,
   session_user::text principal,private.runtime_verified_tenant() tenant_id
   from public.cases c join private.case_input_heads h on h.case_id=c.id
   join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
   join private.case_analysis_dispatch d on d.case_id=h.case_id and d.revision=h.revision and d.mode='draft'
   where c.id=$1::uuid and encode(sha256(convert_to(v.input::text,'UTF8')),'hex')=h.input_sha256`,[candidate.case_id]));
 if(rows.row_count!==1||rows.rows.length!==1)throw Error('REAL_SERVICE_RUN_SCOPE');const row=rows.rows[0];
 if(row.is_qa!==false||row.principal!=='tivdoc_worker_runtime'||row.tenant_id!==savedCaseTenant(candidate.case_id)
  ||row.revision!==candidate.source_revision||row.input_sha256!==candidate.source_sha256
  ||row.authority_dependency_sha256!==candidate.authority_dependency_sha256||row.processing_profile!=='qualified_ai_v1')throw Error('REAL_SERVICE_RUN_SCOPE');
 const job=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:candidate.case_id,revision:row.revision,input_sha256:row.input_sha256,
  authority_dependency_sha256:row.authority_dependency_sha256,processing_profile:row.processing_profile,mode:'draft'});
 await admitSavedSource(context,job);
 const profile=await loadSavedRealAiServiceConfiguration(context,job);
 if(profile.identity_id!==candidate.identity_id||profile.enrollment_id!==candidate.enrollment_id||profile.purpose!=='real_customer_service'||profile.namespace!=='real'||profile.is_qa!==false
  ||profile.dependency_sha256!==candidate.authority_dependency_sha256)throw Error('REAL_SERVICE_RUN_SCOPE');
 if(Date.parse(profile.live_evaluated_at)>=Date.parse(candidate.expires_at)||Date.parse(profile.expires_at)<Date.parse(candidate.expires_at))throw Error('REAL_SERVICE_RUN_EXPIRED');
 const orders=await readSavedOrders(context,job),months=[...new Set(orders.flatMap(purchasedMonths))];
 if(!orders.length||orders.length>12||!months.length||months.length>12
  ||orders.some(o=>o.kind==='legacy_initial'||o.purchase_topics_version!==PURCHASE_TOPICS_VERSION))throw Error('REAL_SERVICE_RUN_ORDER_SCOPE');
 // Current paid receipts, versioned purchase terms, and full-order AI service
 // semantics are checked against the actual records, not just journal labels.
 for(const order of orders){
  if(order.kind==='legacy_initial')throw Error('REAL_SERVICE_RUN_ORDER_SCOPE');
  const offer=await context.client.query(statement('real_service_managed_offer',
   `select o.id from private.product_orders o join private.order_entitlements e on e.order_id=o.id
    where o.id=$1::uuid and o.case_id=$2::uuid and o.offer_sha256=$3 and o.kind=$4
     and o.state='paid' and o.refund_state='none' and e.state='active' and o.terms_accepted_at is not null
     and o.offer->>'version'='tivdoc-order-offer-v3' and o.offer->>'purchase_topics_version'='tivdoc-purchase-topics-v2'
     and o.offer->'human_review_required'='false'::jsonb
     and (o.kind='initial' or o.offer->>'service_kind'='ai_assisted')`,[order.id,candidate.case_id,order.offer_sha256,order.kind]));
  if(offer.row_count!==1||offer.rows.length!==1||offer.rows[0].id!==order.id)throw Error('REAL_SERVICE_RUN_ORDER_SCOPE');
 }
 return job;
}

/** One current REAL case, using the existing durable job/fence/heartbeat.
 * Provider I/O begins only after atomic admission commits. This function never
 * issues a session, enrolls a case, selects a policy, or retries inside a run. */
export async function runRealServiceManagedCase(input:RealServiceManagedCaseInput){
 if(!enabled())return {caseId:input.candidate.case_id,state:'disabled' as const};
 if(input.signal?.aborted)return {caseId:input.candidate.case_id,state:'interrupted' as const};
 const candidate=deepFreeze(realServiceCandidateSchema.parse(input.candidate)),workerId=opaque.parse(input.workerId),transactions=input.transactions,
  storage=input.storage,signal=input.signal,policy=hash.parse(input.providerBudgetPolicySha256),admitClaim=input.admitClaim;
 const extraction=input.extraction?.mode==='saved_receipts_only'?{mode:'saved_receipts_only' as const}
  :input.extraction?.mode==='budgeted_provider'?{mode:'budgeted_provider' as const,forClaim:input.extraction.forClaim}:null;
 if(typeof admitClaim!=='function')throw Error('REAL_SERVICE_RUN_BUDGET_REQUIRED');
 if(!extraction||extraction.mode==='budgeted_provider'&&typeof extraction.forClaim!=='function')throw Error('REAL_SERVICE_RUN_EXTRACTOR_REQUIRED');
 current(candidate,signal);
 const claimed=await transactions(async context=>{
  const job=await scope(context,candidate);current(candidate,signal);
  const claim=await claimSavedDraftJob(context,{caseId:candidate.case_id,workerId,leaseMs:180000});
  if(claim.state!=='claimed')return {claim,admission:null};
  const admission=realServiceClaimAdmissionSchema.parse(await admitClaim(context,{candidate,job,workerId,jobId:claim.jobId,fencingToken:claim.fencingToken,providerBudgetPolicySha256:policy,extraction_mode:extraction.mode}));
  if(admission.case_id!==candidate.case_id||admission.job_id!==claim.jobId||admission.fencing_token!==claim.fencingToken
   ||admission.source_sha256!==candidate.source_sha256||admission.authority_dependency_sha256!==candidate.authority_dependency_sha256
   ||admission.plan_sha256!==candidate.plan_sha256||admission.provider_budget_policy_sha256!==policy||admission.extraction_mode!==extraction.mode
   ||Date.parse(admission.expires_at)>Date.parse(candidate.expires_at)||Date.now()>=Date.parse(admission.expires_at))throw Error('REAL_SERVICE_RUN_CLAIM_ADMISSION');
  current(candidate,signal);return {claim,admission:deepFreeze(admission)};
 });
 if(claimed.claim.state!=='claimed')return {caseId:candidate.case_id,...claimed.claim};
 const lease={caseId:candidate.case_id,workerId,jobId:claimed.claim.jobId,fencingToken:claimed.claim.fencingToken};
 try{
  current(candidate,signal);if(!claimed.admission)throw Error('REAL_SERVICE_RUN_CLAIM_ADMISSION');
  const reserved=extraction.mode==='budgeted_provider'?await extraction.forClaim(claimed.admission):null;
  if(extraction.mode==='budgeted_provider'&&(!reserved?.extractor||typeof reserved.extractor.extractPreparedPass!=='function'
   ||reserved.documentEvidence&&typeof reserved.documentEvidence.extractor?.extract!=='function'))throw Error('REAL_SERVICE_RUN_EXTRACTOR_REQUIRED');
  current(candidate,signal);if(Date.now()>=Date.parse(claimed.admission.expires_at))throw Error('REAL_SERVICE_BUDGET_EXPIRED');
  const result=await runSavedDraftJob({...lease,transactions,storage,signal,providerEnabled:extraction.mode==='budgeted_provider',receiptOnly:extraction.mode==='saved_receipts_only',
   extractor:reserved?.extractor,documentEvidence:reserved?.documentEvidence,heartbeat:{intervalMs:10000,leaseMs:180000},onMonth:completeRealAiServiceMonth});
  return {caseId:candidate.case_id,state:'succeeded' as const,jobId:lease.jobId,manifestSha256:result.completion.sha256,
   ...(result.deferredEvidence?.length?{deferredEvidence:result.deferredEvidence,lastError:realServiceRunError(Error(result.deferredEvidence[0].code))}:{})};
 }catch(error){
  const lastError=realServiceRunError(error);
  try{const failure=await transactions(context=>recordSavedJobFailure(context,lease,error));
   return {caseId:candidate.case_id,state:failure.state,jobId:lease.jobId,lastError:failure.state==='succeeded'?null:lastError};
  }catch{return {caseId:candidate.case_id,state:'unconfirmed' as const,jobId:lease.jobId,lastError};}
 }
}
