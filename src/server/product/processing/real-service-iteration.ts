import 'server-only';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {assertVerifiedTransactionInput,type CanonicalVerifiedRuntimeIdentity} from '@/server/platform/composition/canonical-postgres';
import {getCompiledAiReleaseBuild} from './ai-release-build';
import type {RealServiceWorkerTarget} from './real-service-worker-host';
import type {SavedWorkerTransactions} from './saved-worker-contracts';
import {runRealAiServiceNotificationPass} from './real-service-notification-dispatch';
import {realServiceCandidateSchema,realServiceRunError,runRealServiceManagedCase,type RealServiceCandidate,type RealServiceManagedCaseInput} from './real-service-managed-case';

const hash=z.string().regex(/^[a-f0-9]{64}$/u),time=z.iso.datetime({offset:true}),opaque=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$/u);
export const realServiceCandidateBatchSchema=z.object({evaluated_at:time,expires_at:time,candidates:z.array(realServiceCandidateSchema).max(2)}).strict();
export const realServiceMachineBindingSchema=z.object({candidate_sha256:hash,identity:z.object({session_id:opaque,token_id:opaque,tenant_id:opaque,
 actor_id:opaque,reviewer_organization_id:z.null(),rotation_counter:z.number().int().nonnegative()}).strict(),issuer_sha256:hash,
 target_id:z.string().min(1).max(200),plan_sha256:hash,expires_at:time,binding_receipt_sha256:hash}).strict();
export type RealServiceMachineBinding=z.infer<typeof realServiceMachineBindingSchema>;
export type RealServiceHostConnectInput=Readonly<{caseId:string;identity:CanonicalVerifiedRuntimeIdentity;buildSha:string;buildManifestSha256:string;
 planSha256:string;target:RealServiceWorkerTarget;binding:RealServiceMachineBinding}>;
export type RealServiceIterationHost=Readonly<{transactions:SavedWorkerTransactions;close():Promise<void>}>;
type Notifications=Parameters<typeof runRealAiServiceNotificationPass>[0];
type HostExtraction=Readonly<{mode:'budgeted_provider';forHost(host:RealServiceIterationHost):Extract<RealServiceManagedCaseInput['extraction'],{mode:'budgeted_provider'}>}>;
export type RealServiceIterationInput=Readonly<{enabled:boolean;planSha256:string;buildSha:string;target:RealServiceWorkerTarget;maxCases?:number;signal?:AbortSignal;
 /** This controller authenticates its capability and actual DB target before
  * returning a bounded batch. No arbitrary caller-provided case list exists. */
 controller:{candidates(input:{target:RealServiceWorkerTarget;planSha256:string;buildManifestSha256:string;limit:number}):Promise<unknown>};
 /** Resolves an already provisioned SID/JTI from authenticated issuer evidence.
  * The adapter must prove receipt -> session binding, not hash untrusted JSON.
  * The iteration does not mint or renew credentials. */
 issuer:{resolveProvisionedMachine(candidate:RealServiceCandidate):Promise<unknown>};
 /** Must call the REAL host connector, including actual role/target/plan and
  * per-transaction identity validation; connection secrets stay in this port. */
 connectHost(input:RealServiceHostConnectInput):Promise<RealServiceIterationHost>;
 storage:RealServiceManagedCaseInput['storage'];extraction:RealServiceManagedCaseInput['extraction']|HostExtraction;admitClaim:RealServiceManagedCaseInput['admitClaim'];
 notifications?:Readonly<{origin:string;secret:string;provider:NonNullable<Notifications['provider']>;maxMessages?:number}>}>;
type CaseResult=Awaited<ReturnType<typeof runRealServiceManagedCase>>|{caseId:string;state:'unconfirmed';lastError:string};
type NotificationResult=Awaited<ReturnType<typeof runRealAiServiceNotificationPass>>|{state:'skipped'}|{state:'unconfirmed';lastError:'notification_pass_unconfirmed'};
export type RealServiceIterationItem={caseId:string;processing:CaseResult;notification:NotificationResult;host:'not_opened'|'closed'|'close_unconfirmed'};
const enabled=()=>process.env.TIVDOC_REAL_AI_SERVICE_ENABLED==='1';
const live=(expiresAt:string)=>Date.now()<Date.parse(expiresAt);

/** At most two cases sequentially. This is one bounded scheduler pass, not a
 * timer, candidate enumerator, issuer, spend allocator or notification grant.
 * Processing and delivery results remain separate; neither implies the other. */
export async function runRealServiceIteration(input:RealServiceIterationInput){
 const items:RealServiceIterationItem[]=[];
 if(!input.enabled||!enabled())return {worker:'real_service' as const,state:'disabled' as const,items};
 if(input.signal?.aborted)return {worker:'real_service' as const,state:'interrupted' as const,items};
 const planSha256=hash.parse(input.planSha256),buildSha=z.string().regex(/^[a-f0-9]{40}$/u).parse(input.buildSha),target=deepFreeze({...input.target}),
  buildManifestSha256=getCompiledAiReleaseBuild().manifest.sha256,maximum=z.number().int().min(1).max(2).parse(input.maxCases??2),signal=input.signal;
 const candidates=input.controller.candidates.bind(input.controller),resolveMachine=input.issuer.resolveProvisionedMachine.bind(input.issuer),connectHost=input.connectHost,
  storage=input.storage,admitClaim=input.admitClaim,extraction:RealServiceIterationInput['extraction']=input.extraction.mode==='saved_receipts_only'?{mode:'saved_receipts_only' as const}
   :'forHost' in input.extraction?{mode:'budgeted_provider' as const,forHost:input.extraction.forHost}
   :{mode:'budgeted_provider' as const,forClaim:input.extraction.forClaim};
 const notifications=input.notifications?Object.freeze({...input.notifications,maxMessages:z.number().int().min(1).max(2).parse(input.notifications.maxMessages??2)}):null;
 if(typeof admitClaim!=='function'||extraction.mode==='budgeted_provider'&&('forHost' in extraction?typeof extraction.forHost!=='function':typeof extraction.forClaim!=='function'))throw Error('REAL_SERVICE_RUN_BUDGET_REQUIRED');
 if(notifications&&!notifications.provider)throw Error('REAL_SERVICE_NOTIFICATION_PROVIDER_REQUIRED');
 const batch=deepFreeze(realServiceCandidateBatchSchema.parse(await candidates({target,planSha256,buildManifestSha256,limit:maximum})));
 if(batch.candidates.length>maximum||new Set(batch.candidates.map(c=>c.case_id)).size!==batch.candidates.length
  ||Date.parse(batch.evaluated_at)>=Date.parse(batch.expires_at)||!live(batch.expires_at)
  ||batch.candidates.some(c=>c.plan_sha256!==planSha256||Date.parse(c.expires_at)>Date.parse(batch.expires_at)))throw Error('REAL_SERVICE_CONTROLLER_SCOPE');
 let closeUnconfirmed=false;
 for(const candidate of batch.candidates){
  if(signal?.aborted||!enabled())break;
  const item:RealServiceIterationItem={caseId:candidate.case_id,processing:{caseId:candidate.case_id,state:'unconfirmed',lastError:'machine_binding_unconfirmed'},notification:{state:'skipped'},host:'not_opened'};
  let host:RealServiceIterationHost|undefined;
  try{
   if(!live(batch.expires_at)||!live(candidate.expires_at))throw Error('REAL_SERVICE_RUN_EXPIRED');
   const binding=deepFreeze(realServiceMachineBindingSchema.parse(await resolveMachine(candidate)));
   assertVerifiedTransactionInput({identity:binding.identity,runtime_role:'worker',case_id:candidate.case_id,correlation_id:'real-iteration:binding'});
   if(binding.candidate_sha256!==canonicalSha256(candidate)||binding.identity.tenant_id!==`saved-case:${candidate.case_id}`
    ||binding.issuer_sha256!==target.machine_issuer_sha256||binding.target_id!==target.target_id||binding.plan_sha256!==planSha256
    ||Date.parse(binding.expires_at)>Date.parse(candidate.expires_at)||!live(binding.expires_at))throw Error('REAL_SERVICE_MACHINE_BINDING');
   if(signal?.aborted||!enabled()){
    item.processing={caseId:candidate.case_id,state:signal?.aborted?'interrupted':'disabled'};break;
   }
   host=await connectHost({caseId:candidate.case_id,identity:binding.identity,buildSha,buildManifestSha256,planSha256,target,binding});
   if(signal?.aborted||!enabled()){
    item.processing={caseId:candidate.case_id,state:signal?.aborted?'interrupted':'disabled'};
   }else{
    try{
     // Construct provider adapters only against this authenticated case host.
     // Claim admission still validates the selected mode against stored policy.
     const scopedExtraction='forHost' in extraction?extraction.forHost(host):extraction;
     if(scopedExtraction.mode!==extraction.mode||scopedExtraction.mode==='budgeted_provider'&&typeof scopedExtraction.forClaim!=='function')throw Error('REAL_SERVICE_RUN_EXTRACTOR_REQUIRED');
     item.processing=await runRealServiceManagedCase({candidate,workerId:binding.identity.actor_id,transactions:host.transactions,storage,extraction:scopedExtraction,
     admitClaim,providerBudgetPolicySha256:target.provider_budget_policy_sha256,signal});
    }catch(error){item.processing={caseId:candidate.case_id,state:'unconfirmed',lastError:realServiceRunError(error)};}
    // Existing valid outbox work can be independent of an idle/busy/held job.
    // Its own dispatcher rechecks publication, recipient, consent and leases.
    if(notifications&&!signal?.aborted&&enabled()){
     try{item.notification=await runRealAiServiceNotificationPass({transactions:host.transactions,caseId:candidate.case_id,workerId:randomUUID(),...notifications,signal});}
     catch{item.notification={state:'unconfirmed',lastError:'notification_pass_unconfirmed'};}
    }
   }
  }catch(error){item.processing={caseId:candidate.case_id,state:'unconfirmed',lastError:error instanceof Error&&error.message==='REAL_SERVICE_MACHINE_BINDING'?'machine_binding_changed':realServiceRunError(error)};}
  finally{
   if(host)try{await host.close();item.host='closed';}catch{item.host='close_unconfirmed';closeUnconfirmed=true;}
   items.push(item);
  }
  // A failed close may retain resources; do not open another host in this pass.
  if(closeUnconfirmed)break;
 }
 return {worker:'real_service' as const,state:signal?.aborted?'interrupted' as const:!enabled()?'disabled' as const:closeUnconfirmed?'held' as const:'finished' as const,items};
}
