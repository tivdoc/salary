import 'server-only';
import path from 'node:path';
import {z} from 'zod';
import {createClient} from '@supabase/supabase-js';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {resendProvider} from '../case-access/resend-provider';
import {connectRealServiceController,admitRealServiceSavedReceiptsClaim,admitRealServiceBudgetedProviderClaim,realServiceControllerTargetSchema} from './real-service-controller';
import {createRealServiceBudgetedExtraction} from './real-service-budgeted-extractor';
import {realServiceMachineResponseSchema} from './real-service-machine-issuer';
import {connectRealServiceMachineMaintenance} from './real-service-machine-maintenance';
import {connectRealServiceWorker} from './real-service-worker-host';
import {realServiceCandidateBatchSchema,runRealServiceIteration,type RealServiceIterationHost} from './real-service-iteration';
import {realServiceRunError,type RealServiceCandidate} from './real-service-managed-case';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const origin=z.string().refine(value=>{try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==='/';}catch{return false;}});
export const realServiceRuntimeConfigurationSchema=z.object({schema_version:z.literal('real-service-runtime-v1'),plan_sha256:hash,
 build_sha:z.string().regex(/^[a-f0-9]{40}$/u),target:realServiceControllerTargetSchema,
 extraction_mode:z.enum(['saved_receipts_only','budgeted_provider']),storage_origin:origin,
 notifications:z.object({origin,from:z.string().min(3).max(200)}).strict().nullable()}).strict();
export type RealServiceRuntimeConfiguration=z.infer<typeof realServiceRuntimeConfigurationSchema>;
export type RealServiceRuntimeSecrets=Readonly<{workerConnectionUrl:string;issuerConnectionUrl:string;certificateAuthority:string;
 controllerCapability:string;storageKey:string;notificationApiKey?:string;notificationEncryptionKey?:string;providerApiKey?:string;providerArtifactDirectory?:string}>;

/** Concrete scheduler boundary: actual controller, existing issuer read, actual
 * per-case host, private Storage and separately configured notification provider.
 * The explicit maintenance phase may replace an expired machine only under the
 * current issuer grant. It does not enroll, register policy or replenish spend.
 * Provider extraction requires the separate switch and authenticated per-claim
 * policy; each actual SDK request reserves spend before dispatch. */
export async function runConfiguredRealServiceIteration(input:{configuration:RealServiceRuntimeConfiguration;secrets:RealServiceRuntimeSecrets;buildSha:string;signal?:AbortSignal}){
 if(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1')return {state:'disabled' as const,iteration:null,cleanup:[]};
 if(input.signal?.aborted)return {state:'interrupted' as const,iteration:null,cleanup:[]};
 const config=deepFreeze(realServiceRuntimeConfigurationSchema.parse(input.configuration)),secrets=Object.freeze({...input.secrets}),signal=input.signal;
 if(config.build_sha!==input.buildSha)throw Error('REAL_SERVICE_RUNTIME_BUILD_CHANGED');
 if(!secrets.storageKey)throw Error('REAL_SERVICE_RUNTIME_STORAGE_REQUIRED');
 if(config.notifications&&(!secrets.notificationApiKey||!secrets.notificationEncryptionKey))throw Error('REAL_SERVICE_RUNTIME_NOTIFICATION_REQUIRED');
 if(config.extraction_mode==='budgeted_provider'&&(process.env.TIVDOC_REAL_AI_PROVIDER_ENABLED!=='1'
  ||!secrets.providerApiKey?.trim()||!secrets.providerArtifactDirectory||!path.isAbsolute(secrets.providerArtifactDirectory)))throw Error('REAL_SERVICE_RUNTIME_PROVIDER_REQUIRED');
 let controller:Awaited<ReturnType<typeof connectRealServiceController>>|undefined,issuer:Awaited<ReturnType<typeof connectRealServiceMachineMaintenance>>|undefined;
 let iteration:Awaited<ReturnType<typeof runRealServiceIteration>>|null=null,error:string|null=null;
 let enrollments:Awaited<ReturnType<Awaited<ReturnType<typeof connectRealServiceController>>['enrollPaidSources']>>|{state:'unconfirmed';error:'real_enrollment_unconfirmed'}|null=null;
 const cleanup:Array<{resource:'issuer'|'controller';state:'closed'|'close_unconfirmed'}>=[];
 const machines:Array<{case_id:string;state:'active'|'unavailable';provenance_sha256?:string;expires_at?:string;reason?:string}>=[];
 function checkedMachine(candidate:RealServiceCandidate,value:unknown){
  const response=realServiceMachineResponseSchema.parse(value);
  if(response.state!=='active')throw Error('REAL_SERVICE_MACHINE_UNAVAILABLE');
  if(response.case_id!==candidate.case_id||response.identity_id!==candidate.identity_id||response.enrollment_id!==candidate.enrollment_id
   ||response.plan_sha256!==candidate.plan_sha256||response.issuer_sha256!==config.target.machine_issuer_sha256
   ||response.target_id!==config.target.target_id||response.database_name!==config.target.database||response.environment!==config.target.environment
   ||response.deployment_sha256!==config.target.deployment_sha256||response.identity.tenant_id!==`saved-case:${candidate.case_id}`
   ||Date.parse(response.valid_after)>Date.parse(response.evaluated_at)||Date.parse(response.expires_at)<=Date.now())throw Error('REAL_SERVICE_MACHINE_BINDING');
  return response;
 }
 try{
  controller=await connectRealServiceController({target:config.target,planSha256:config.plan_sha256,capability:secrets.controllerCapability,
   connectionUrl:secrets.workerConnectionUrl,certificateAuthority:secrets.certificateAuthority});
  // Paid-order/source changes are durable before this tick. Enrollment failure
  // does not prevent already enrolled cases from processing or delivering.
  enrollments=await controller.enrollPaidSources().catch(()=>({state:'unconfirmed' as const,error:'real_enrollment_unconfirmed' as const}));
  issuer=await connectRealServiceMachineMaintenance({target:{schema_version:'real-service-machine-issuer-target-v1',plan_sha256:config.plan_sha256,
   issuer_sha256:config.target.machine_issuer_sha256,target_id:config.target.target_id,database_name:config.target.database,
   environment:config.target.environment,deployment_sha256:config.target.deployment_sha256,host:config.target.host,port:config.target.port,
   login:config.target.login.replace(/^tivdoc_worker_runtime/u,'tivdoc_identity_runtime')},
   connectionUrl:secrets.issuerConnectionUrl,certificateAuthority:secrets.certificateAuthority});
  const machineIssuer=issuer,discovery=controller;
  const storage=createClient(config.storage_origin,secrets.storageKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}).storage.from('salary-documents');
  iteration=await runRealServiceIteration({enabled:true,planSha256:config.plan_sha256,buildSha:config.build_sha,target:config.target,maxCases:2,signal,
   controller:{async candidates(request){
    const batch=realServiceCandidateBatchSchema.parse(await discovery.candidates(request)),candidates:RealServiceCandidate[]=[];
    for(const selected of batch.candidates){
     if(signal?.aborted||process.env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1')break;
     if(Date.now()>=Date.parse(batch.expires_at)||Date.now()>=Date.parse(selected.expires_at))throw Error('REAL_SERVICE_RUN_EXPIRED');
     const selector={case_id:selected.case_id,identity_id:selected.identity_id,enrollment_id:selected.enrollment_id,plan_sha256:selected.plan_sha256};
     const response=realServiceMachineResponseSchema.parse(await machineIssuer.maintain(selector));
     if(response.state==='unavailable'){machines.push({case_id:selected.case_id,state:'unavailable',reason:response.reason});continue;}
     const proven=checkedMachine(selected,response),expires_at=new Date(Math.min(Date.parse(selected.expires_at),Date.parse(proven.expires_at))).toISOString();
     machines.push({case_id:selected.case_id,state:'active',provenance_sha256:proven.provenance_sha256,expires_at});
     // Narrow scope BEFORE candidate hashing and claim admission. This never
     // extends the controller, enrollment, plan or issuer's actual time window.
     candidates.push({...selected,expires_at});
    }
    return {...batch,candidates};
   }},
   issuer:{async resolveProvisionedMachine(candidate){
    const response=checkedMachine(candidate,await machineIssuer.read({case_id:candidate.case_id,identity_id:candidate.identity_id,
     enrollment_id:candidate.enrollment_id,plan_sha256:candidate.plan_sha256}));
    return {candidate_sha256:canonicalSha256(candidate),identity:response.identity,issuer_sha256:response.issuer_sha256,target_id:response.target_id,
     plan_sha256:response.plan_sha256,expires_at:new Date(Math.min(Date.parse(candidate.expires_at),Date.parse(response.expires_at))).toISOString(),
     binding_receipt_sha256:response.provenance_sha256};
   }},connectHost:request=>connectRealServiceWorker({caseId:request.caseId,identity:request.identity,buildSha:request.buildSha,
    buildManifestSha256:request.buildManifestSha256,planSha256:request.planSha256,target:request.target,
    connectionUrl:secrets.workerConnectionUrl,certificateAuthority:secrets.certificateAuthority}),
   storage,...(config.extraction_mode==='saved_receipts_only'?{extraction:{mode:'saved_receipts_only' as const},admitClaim:admitRealServiceSavedReceiptsClaim}
    :{extraction:{mode:'budgeted_provider' as const,forHost:(host:RealServiceIterationHost)=>createRealServiceBudgetedExtraction({
      transactions:host.transactions,apiKey:secrets.providerApiKey!,artifactDirectory:secrets.providerArtifactDirectory!,signal})},admitClaim:admitRealServiceBudgetedProviderClaim}),
   ...(config.notifications?{notifications:{origin:config.notifications.origin,secret:secrets.notificationEncryptionKey!,
    provider:resendProvider(secrets.notificationApiKey!,config.notifications.from),maxMessages:2}}:{})});
 }catch(caught){error=realServiceRunError(caught);}
 finally{
  // Preserve a primary failure even if either independent pool cannot close.
  for(const [resource,connection] of [['issuer',issuer],['controller',controller]] as const){
   if(!connection)continue;try{await connection.close();cleanup.push({resource,state:'closed'});}catch{cleanup.push({resource,state:'close_unconfirmed'});}
  }
 }
 return {state:error||cleanup.some(c=>c.state==='close_unconfirmed')?'unconfirmed' as const:iteration?.state??'unconfirmed' as const,iteration,error,cleanup,machines,enrollments};
}

/** CLI/scheduler callers supply only private process configuration and their
 * compiled Git identity. No request body can select a case, SID or budget. */
export async function runRealServiceRuntime(env:Readonly<Record<string,string|undefined>>,buildSha:string,signal?:AbortSignal){
 if(env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1'||process.env.TIVDOC_REAL_AI_SERVICE_ENABLED!=='1')return {state:'disabled' as const,iteration:null,cleanup:[]};
 if(signal?.aborted)return {state:'interrupted' as const,iteration:null,cleanup:[]};
 let configuration:RealServiceRuntimeConfiguration;
 try{configuration=realServiceRuntimeConfigurationSchema.parse(JSON.parse(env.TIVDOC_REAL_SERVICE_RUNTIME_CONFIG??''));}catch{throw Error('REAL_SERVICE_RUNTIME_CONFIGURATION');}
 if(configuration.extraction_mode==='budgeted_provider'&&env.TIVDOC_REAL_AI_PROVIDER_ENABLED!=='1')throw Error('REAL_SERVICE_RUNTIME_PROVIDER_REQUIRED');
 return runConfiguredRealServiceIteration({configuration,buildSha,signal,secrets:{workerConnectionUrl:env.TIVDOC_REAL_SERVICE_DATABASE_URL??'',
  issuerConnectionUrl:env.TIVDOC_REAL_SERVICE_ISSUER_DATABASE_URL??'',certificateAuthority:env.TIVDOC_REAL_SERVICE_DATABASE_CA??'',
  controllerCapability:env.TIVDOC_REAL_SERVICE_CONTROLLER_CAPABILITY??'',storageKey:env.TIVDOC_REAL_SERVICE_STORAGE_KEY??'',
  notificationApiKey:env.RESEND_API_KEY,notificationEncryptionKey:env.TIVDOC_NOTIFICATION_ENCRYPTION_KEY,
  providerApiKey:env.OPENAI_API_KEY,providerArtifactDirectory:env.TIVDOC_REAL_SERVICE_PROVIDER_ARTIFACT_DIRECTORY}});
}
