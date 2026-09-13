/** Explicit operator for one immutable, ingress-only DEV Preview. No provider
 * send/configuration, project settings mutation, production or tunnel action. */
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,openSync,closeSync,readFileSync,writeFileSync,renameSync,unlinkSync,realpathSync} from 'node:fs';
import {execFileSync,spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const INGRESS_PROJECT='prj_kmqJ74IuBrc5hI9J93RpcUkNMBW7';
export const INGRESS_TEAM='team_ATajnGzbAqDUrrrIoUlCzM4b';
const BRANCH='codex/tivdoc-release-completion';
const FILES=['.vercel/output/config.json','.vercel/output/functions/api/resend.func/.vc-config.json','.vercel/output/functions/api/resend.func/index.js'];
const hash=value=>createHash('sha256').update(typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value)).digest('hex');
const requireThat=(valid,code)=>{if(!valid)throw Error(code);};
const deploymentId=id=>typeof id==='string'&&/^dpl_[A-Za-z0-9]+$/u.test(id);
const origin=d=>{requireThat(/^salary-[a-z0-9]+-tivdoccom-5042s-projects\.vercel\.app$/u.test(d.url??''),'INGRESS_DEPLOYMENT_URL');return `https://${d.url}`;};
export function assertLocalIngressOperator(env){
 requireThat(!env.VERCEL&&!env.VERCEL_ENV&&env.NODE_ENV!=='production','INGRESS_LOCAL_OPERATOR_REQUIRED');
}
/** Actual Vercel SSO uses 302. A generic application redirect is not proof of
 * protection: require Vercel's SSO target, challenge and exact return URL. */
export function isProtectedPreviewResponse(response,requestedUrl){
 if([401,403].includes(response.status))return true;
 if(![302,307,308].includes(response.status))return false;
 try{
  const redirect=new URL(response.headers.get('location'));
  const returnTo=new URL(redirect.searchParams.get('url'));
  return redirect.origin==='https://vercel.com'&&redirect.pathname==='/sso-api'
   &&!redirect.username&&!redirect.password&&Boolean(redirect.searchParams.get('nonce'))
   &&!returnTo.username&&!returnTo.password&&returnTo.href===new URL(requestedUrl).href
   &&response.headers.getSetCookie().some(value=>value.startsWith('_vercel_sso_nonce='));
 }catch{return false;}
}
export function parseIngressOperatorConfig(value){
 requireThat(value&&value.schema_version==='dev-ingress-operator-v1','INGRESS_CONFIG_VERSION');
 requireThat(deploymentId(value.main_preview_id)&&/^[a-f0-9]{40}$/u.test(value.main_preview_commit??''),'INGRESS_MAIN_PREVIEW_PIN');
 requireThat(typeof value.vercel_cli_path==='string'&&path.isAbsolute(value.vercel_cli_path),'INGRESS_CLI_PATH');
 requireThat(typeof value.resend_webhook_secret==='string'&&/^whsec_[A-Za-z0-9+/=]+$/u.test(value.resend_webhook_secret),'INGRESS_SIGNING_SECRET_REQUIRED');
 requireThat(typeof value.expires_at==='string'&&Number.isFinite(Date.parse(value.expires_at)),'INGRESS_EXPIRY_REQUIRED');
 return {schema_version:value.schema_version,main_preview_id:value.main_preview_id,main_preview_commit:value.main_preview_commit,
  vercel_cli_path:value.vercel_cli_path,resend_webhook_secret:value.resend_webhook_secret,expires_at:value.expires_at};
}
function projectSnapshot(project){
 requireThat(project.id===INGRESS_PROJECT&&project.name==='salary'&&project.accountId===INGRESS_TEAM,'INGRESS_PROJECT_SCOPE');
 requireThat(deploymentId(project.targets?.production?.id),'INGRESS_EXISTING_PRODUCTION_BASELINE_REQUIRED');
 requireThat(project.ssoProtection?.deploymentType==='all_except_custom_domains','INGRESS_MAIN_PROTECTION_REQUIRED');
 requireThat(project.nodeVersion==='24.x','INGRESS_PROJECT_RUNTIME_CHANGED');
 const fields=['framework','buildCommand','devCommand','installCommand','outputDirectory','rootDirectory','nodeVersion',
  'serverlessFunctionRegion','sourceFilesOutsideRootDirectory','ssoProtection','passwordProtection','trustedIps'];
 return {production_id:project.targets.production.id,settings:Object.fromEntries(fields.map(k=>[k,project[k]??null]))};
}
function checkMain(deployment,config,snapshot){
 requireThat(deployment.id===config.main_preview_id&&deployment.projectId===INGRESS_PROJECT
  &&deployment.target!=='production'&&deployment.id!==snapshot.production_id&&deployment.readyState==='READY'
  &&deployment.meta?.githubCommitRef===BRANCH&&deployment.meta?.githubCommitSha===config.main_preview_commit,'INGRESS_MAIN_PREVIEW_SCOPE');
 return origin(deployment);
}
function checkIngress(deployment,state){
 requireThat(deployment.id===state.deployment?.id&&deployment.id!==state.main_preview.id
  &&deployment.id!==state.project_before.production_id&&deployment.projectId===INGRESS_PROJECT&&deployment.target!=='production'
  &&deployment.meta?.tivdocIngressOperation===state.operation_id&&deployment.meta?.sourceCommit===state.source_commit
  &&deployment.meta?.bundleSha256===state.bundle_sha256,'INGRESS_ARTIFACT_SCOPE');
 requireThat(origin(deployment)===state.deployment.origin,'INGRESS_ARTIFACT_ORIGIN_CHANGED');
}
function checkState(state,config){
 requireThat(state?.schema_version==='dev-ingress-state-v1'&&state.project_id===INGRESS_PROJECT&&state.team_id===INGRESS_TEAM
  &&state.main_preview?.id===config.main_preview_id&&state.main_preview?.commit===config.main_preview_commit
  &&state.expires_at===config.expires_at,'INGRESS_STATE_SCOPE');
}
export function redactedIngressStatus(state,extra={}){
 return {schema_version:'dev-ingress-status-v1',phase:state.phase,operation_id:state.operation_id,
  source_commit:state.source_commit,bundle_sha256:state.bundle_sha256,main_preview_id:state.main_preview.id,
  main_preview_commit:state.main_preview.commit,ingress_deployment_id:state.deployment?.id??null,
  ingress_origin:state.deployment?.origin??null,expires_at:state.expires_at,
  inherited_env_key_count:state.inherited_env_keys?.length??0,pending_mutation:state.pending_mutation?.label??null,
  last_boundary_probe:state.last_boundary_probe??null,boundary_probe_count:state.boundary_probe_history?.length??0,
  forwarding_probe:state.forwarding_probe??null,...extra};
}
function receiptEndpointMatches(receipt,id){
 try{const url=new URL(receipt.response.endpoint,'https://api.vercel.com');return receipt.response.method==='PATCH'
  &&url.origin==='https://api.vercel.com'&&url.pathname===`/aliases/${id}/protection-bypass`
  &&url.searchParams.get('teamId')===INGRESS_TEAM&&[...url.searchParams.keys()].length===1;}catch{return false;}
}
/** An already-absent share is different from a successful revocation. This
 * recovery trusts only our exact saved request/response pair, matches the
 * pending operation and verifies current protection without another mutation. */
export function validateAbsentShareRecovery(state,evidence){
 const label=state.pending_mutation?.label;
 const field=label==='revoke_forward_share'?'forward_share':label==='revoke_probe_share'?'probe_share':null;
 requireThat(field&&state.override_enabled===false&&state.deployment,'INGRESS_RECOVERY_PENDING_SCOPE');
 const id=field==='forward_share'?state.main_preview.id:state.deployment.id,share=state[field];
 const missing=evidence?.missing_share,override=evidence?.override_revoke;
 requireThat(missing&&override&&share?.deployment_id===id&&receiptEndpointMatches(missing,id),'INGRESS_RECOVERY_RECEIPT_SCOPE');
 requireThat(state.pending_mutation.path===`/aliases/${id}/protection-bypass`
  &&state.pending_mutation.body_sha256===hash(missing.request)
  &&JSON.stringify(missing.request)===JSON.stringify({revoke:{secret:share.secret,regenerate:false}}),'INGRESS_RECOVERY_REQUEST_MISMATCH');
 requireThat(missing.response.status===1&&missing.response.stderr?.trim()==='Error: The specified shareable link does not exist. (404)',
  'INGRESS_RECOVERY_NOT_EXPLICIT_ABSENCE');
 requireThat(receiptEndpointMatches(override,state.deployment.id)&&override.response.status===0
  &&JSON.stringify(override.request)===JSON.stringify({override:{scope:'alias-protection-override',action:'revoke'}}),'INGRESS_RECOVERY_OVERRIDE_RECEIPT');
 let result;try{result=JSON.parse(override.response.stdout);}catch{throw Error('INGRESS_RECOVERY_OVERRIDE_RESPONSE');}
 requireThat(result.protectionBypass&&typeof result.protectionBypass==='object'
  &&Object.values(result.protectionBypass).every(value=>value.scope!=='alias-protection-override'),'INGRESS_RECOVERY_OVERRIDE_NOT_ABSENT');
 const other=state[field==='forward_share'?'probe_share':'forward_share'];
 requireThat(!other||other.revoked_at||other.expired_at||other.absent_at,'INGRESS_RECOVERY_OTHER_SHARE_UNRESOLVED');
 return field;
}
/** All external effects are explicit ports so tests cannot accidentally deploy.
 * The CLI implementation below supplies the authenticated Vercel API port. */
export async function runIngressOperator(command,{config,artifact,api,transport=fetch,loadState,saveState,now=()=>Date.now(),newId=randomUUID,
 pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),recoveryEvidence}){
 requireThat(['deploy','status','enable','disable','reconcile-absent-share'].includes(command),'INGRESS_COMMAND_UNKNOWN');
 config=parseIngressOperatorConfig(config);
 let state=loadState();
 const endpoint=value=>`${value}${value.includes('?')?'&':'?'}teamId=${INGRESS_TEAM}`;
 const read=value=>api(endpoint(value),'GET');
 const save=()=>saveState(state);
 const currentProject=async()=>projectSnapshot(await read(`/v9/projects/${INGRESS_PROJECT}`));
 const unchanged=async()=>{const actual=await currentProject();requireThat(hash(actual)===hash(state.project_before),'INGRESS_PROJECT_SETTINGS_OR_PRODUCTION_CHANGED');return actual;};
 const mutate=async(value,body,label)=>{
  state.pending_mutation={label,at:new Date(now()).toISOString(),path:value,body_sha256:hash(body)};save();
  // A failed/uncertain request leaves its intent durable; deploy/enable never
  // blindly repeats a potentially successful mutation. Disable remains scoped.
  return api(endpoint(value),'PATCH',body);
 };
 const finished=()=>{delete state.pending_mutation;save();};
 const deadline=()=>{
  const seconds=Math.floor((Date.parse(config.expires_at)-now())/1000);
  requireThat(seconds>=120&&seconds<=14400,'INGRESS_EXPIRED_OR_UNBOUNDED');return seconds;
 };
 const createShare=async(id,field,ttl)=>{
  const started=now();const result=await mutate(`/aliases/${id}/protection-bypass`,{ttl},`create_${field}`);
  const candidates=Object.entries(result.protectionBypass??{}).filter(([key,value])=>
   /^[A-Za-z0-9_-]{20,128}$/u.test(key)&&value.scope==='shareable-link'
   &&value.createdAt>=started-2000&&value.createdAt<=now()+2000
   &&Number.isFinite(value.expires)&&value.expires*1000>now());
  requireThat(candidates.length===1,'INGRESS_SHARE_RESPONSE_AMBIGUOUS');
  const [secret,value]=candidates[0];
  state[field]={deployment_id:id,secret,expires_at:new Date(value.expires*1000).toISOString()};finished();
  requireThat(value.expires*1000<=Date.parse(config.expires_at),'INGRESS_SHARE_EXCEEDS_DEADLINE');
 };
 const revokeShare=async field=>{
  const share=state[field];if(!share||share.revoked_at||share.expired_at||share.absent_at)return;
  requireThat(share.deployment_id===(field==='forward_share'?state.main_preview.id:state.deployment?.id),'INGRESS_SHARE_SCOPE');
  if(Date.parse(share.expires_at)>now()){
   await mutate(`/aliases/${share.deployment_id}/protection-bypass`,{revoke:{secret:share.secret,regenerate:false}},`revoke_${field}`);
   share.revoked_at=new Date(now()).toISOString();
  }else{
   share.expired_at=new Date(now()).toISOString();
  }
  finished();
 };
 const probe=async(url,options={},timeout=15000)=>transport(url,{...options,redirect:'manual',signal:AbortSignal.timeout(timeout)});
 const forwardingProbe=async()=>{
  const result={checked_at:new Date(now()).toISOString(),available:false,exchange_status:null,
   redirect_is_pinned:false,scoped_cookie_present:false,target_method_status:null};
  if(!state.forward_share||state.forward_share.revoked_at||state.forward_share.expired_at||state.forward_share.absent_at
   ||Date.parse(state.forward_share.expires_at)<=now())return {...result,reason:'share_unavailable'};
  try{
   const access=new URL('/api/health',state.main_preview.origin);access.searchParams.set('_vercel_share',state.forward_share.secret);
   const exchange=await probe(access);result.exchange_status=exchange.status;
   const location=exchange.headers.get('location'),destination=location?new URL(location,state.main_preview.origin):null;
   result.redirect_is_pinned=destination?.origin===state.main_preview.origin&&destination.pathname==='/api/health'&&!destination.search;
   const cookie=exchange.headers.getSetCookie().map(value=>value.split(';',1)[0]).find(value=>value.startsWith('_vercel_jwt='));
   result.scoped_cookie_present=Boolean(cookie&&cookie.length<=16384);
   if(exchange.status!==307||!result.redirect_is_pinned||!result.scoped_cookie_present)return {...result,reason:'share_exchange_refused'};
   // GET cannot ingest an event. It proves the cookie reaches the existing
   // webhook route; it does not claim a receipt was persisted or delivered.
   const target=await probe(`${state.main_preview.origin}/api/notifications/resend`,{method:'GET',headers:{cookie}});
   result.target_method_status=target.status;result.available=target.status===405;
   return {...result,reason:result.available?'ready':'forward_route_unavailable'};
  }catch{return {...result,reason:'forward_transport_unavailable'};}
 };
 const publicChecks=async(timeout=15000)=>{
  const [get,unknown,unsigned,main]=await Promise.all([
   probe(`${state.deployment.origin}/api/resend`,{},timeout),probe(`${state.deployment.origin}/case/never-served`,{},timeout),
   probe(`${state.deployment.origin}/api/resend`,{method:'POST',body:'{}',headers:{'content-type':'application/json'}},timeout),
   probe(state.main_preview.origin,{},timeout),
  ]);
  return {ingress_get_status:get.status,ingress_unknown_path_status:unknown.status,unsigned_post_status:unsigned.status,
   ingress_get_protected:isProtectedPreviewResponse(get,`${state.deployment.origin}/api/resend`),
   ingress_unknown_path_protected:isProtectedPreviewResponse(unknown,`${state.deployment.origin}/case/never-served`),
   unsigned_post_protected:isProtectedPreviewResponse(unsigned,`${state.deployment.origin}/api/resend`),
   main_unauthenticated_status:main.status,main_protected:isProtectedPreviewResponse(main,state.main_preview.origin)};
 };
 const publicBoundaryReady=checks=>checks.ingress_get_status===405&&checks.ingress_unknown_path_status===404
  &&checks.unsigned_post_status===401&&checks.main_protected;
 const awaitingProtectionPropagation=checks=>checks.main_protected
  &&(checks.ingress_get_status===405||checks.ingress_get_protected)
  &&(checks.ingress_unknown_path_status===404||checks.ingress_unknown_path_protected)
  &&(checks.unsigned_post_status===401||checks.unsigned_post_protected);
 if(command==='deploy'){
  requireThat(!state,'INGRESS_STATE_EXISTS_USE_STATUS_OR_DISABLE');
  const ttl=deadline()-60;
  requireThat(artifact?.source_commit&&/^[a-f0-9]{40}$/u.test(artifact.source_commit)&&/^[a-f0-9]{64}$/u.test(artifact.bundle_sha256),'INGRESS_BUILD_REQUIRED');
  requireThat(JSON.stringify(artifact.files?.map(f=>f.file))===JSON.stringify(FILES),'INGRESS_ARTIFACT_FILE_SCOPE');
  const before=await currentProject(),main=await read(`/v13/deployments/${config.main_preview_id}`);
  const mainOrigin=checkMain(main,config,before);
  const [projectEnv,sharedEnv]=await Promise.all([read(`/v10/projects/${INGRESS_PROJECT}/env?decrypt=false`),read(`/v1/env?projectId=${INGRESS_PROJECT}`)]);
  requireThat(Array.isArray(projectEnv.envs)&&Array.isArray(sharedEnv.data)&&!sharedEnv.pagination?.next,'INGRESS_ENV_INVENTORY_INCOMPLETE');
  const keys=[...new Set([...projectEnv.envs,...sharedEnv.data].map(entry=>entry.key))].sort();
  requireThat(keys.every(key=>typeof key==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)),'INGRESS_ENV_INVENTORY_INVALID');
  state={schema_version:'dev-ingress-state-v1',project_id:INGRESS_PROJECT,team_id:INGRESS_TEAM,phase:'prepared',operation_id:newId(),
   main_preview:{id:config.main_preview_id,origin:mainOrigin,commit:config.main_preview_commit},project_before:before,
   source_commit:artifact.source_commit,bundle_sha256:artifact.bundle_sha256,expires_at:config.expires_at,inherited_env_keys:keys};save();
  await createShare(main.id,'forward_share',ttl);
  const env=Object.fromEntries(keys.map(key=>[key,'']));
  Object.assign(env,{RESEND_WEBHOOK_SECRET:config.resend_webhook_secret,TIVDOC_DEV_INGRESS_ENABLED:'true',
   TIVDOC_DEV_PREVIEW_SHARE_SECRET:state.forward_share.secret,TIVDOC_DEV_PREVIEW_ORIGIN:mainOrigin,
   TIVDOC_DEV_PREVIEW_SHARE_EXPIRES:state.forward_share.expires_at});
  const body={name:'salary',project:INGRESS_PROJECT,version:2,source:'cli',env,files:artifact.files,
   meta:{tivdocIngressOperation:state.operation_id,sourceCommit:state.source_commit,bundleSha256:state.bundle_sha256,purpose:'DEV ingress only'}};
  // Existing project already has a Production baseline. Like the Vercel CLI,
  // omit target for Preview; never send projectSettings, aliases or gitSource.
  state.pending_mutation={label:'create_ingress_preview',at:new Date(now()).toISOString(),body_sha256:hash(body)};save();
  const result=await api(endpoint('/v13/deployments?prebuilt=1'),'POST',body);
  requireThat(deploymentId(result.id),'INGRESS_DEPLOYMENT_ID_MISSING');
  state.deployment={id:result.id,origin:origin(result),reported_target:result.target??null};state.phase='deployed';finished();
  checkIngress(result,state);await unchanged();
  return redactedIngressStatus(state,{ready_state:result.readyState??null});
 }
 checkState(state,config);
 if(command==='reconcile-absent-share'){
  const field=validateAbsentShareRecovery(state,recoveryEvidence);
  await unchanged();checkIngress(await read(`/v13/deployments/${state.deployment.id}`),state);
  const url=`${state.deployment.origin}/api/resend`,response=await probe(url);
  requireThat(isProtectedPreviewResponse(response,url),'INGRESS_RECOVERY_NOT_PROTECTED');
  const at=new Date(now()).toISOString();
  (state.cleanup_reconciliations??=[]).push({at,previous_phase:state.phase,pending_label:state.pending_mutation.label,
   missing_share_receipt:recoveryEvidence.missing_share.filename,override_revoke_receipt:recoveryEvidence.override_revoke.filename,
   reason:'exact_saved_share_not_found_404',public_status:response.status,remote_mutations:0});
  state[field].absent_at=at;state[field].absence_reason='vercel_share_not_found_404';
  state[field].absence_receipt=recoveryEvidence.missing_share.filename;
  state.phase='disabled';state.disabled_at=at;finished();
  return redactedIngressStatus(state,{cleanup_reconciled:true,protected:true,public_status:response.status,remote_mutations:0});
 }
 if(command==='status'){
  const actual=await currentProject();
  const current=state.deployment?await read(`/v13/deployments/${state.deployment.id}`):null;
  if(current)checkIngress(current,state);
  return redactedIngressStatus(state,{ready_state:current?.readyState??null,project_unchanged:hash(actual)===hash(state.project_before),
   expired:Date.parse(state.expires_at)<=now(),forwarding_probe:await forwardingProbe()});
 }
 if(command==='disable'){
  // Recovery must still work after expiry and after a failed enable, but it
  // may revoke only resources whose immutable deployment identity is pinned.
  if(state.deployment){
   checkIngress(await read(`/v13/deployments/${state.deployment.id}`),state);
   await mutate(`/aliases/${state.deployment.id}/protection-bypass`,{override:{scope:'alias-protection-override',action:'revoke'}},'disable_ingress');
   state.override_enabled=false;finished();
  }
  await revokeShare('probe_share');await revokeShare('forward_share');
  state.phase='disabled';state.disabled_at=new Date(now()).toISOString();save();
  const actual=await currentProject();
  const response=state.deployment?await probe(`${state.deployment.origin}/api/resend`):null;
  return redactedIngressStatus(state,{project_unchanged:hash(actual)===hash(state.project_before),public_status:response?.status??null,
   protected:response?isProtectedPreviewResponse(response,`${state.deployment.origin}/api/resend`):null});
 }
 deadline();requireThat(!state.pending_mutation,'INGRESS_PENDING_MUTATION_REQUIRES_RECONCILIATION');
 requireThat(!state.forward_share?.revoked_at&&Date.parse(state.forward_share?.expires_at??'')>now(),'INGRESS_FORWARD_SHARE_UNAVAILABLE');
 requireThat(['deployed','enabled'].includes(state.phase),'INGRESS_ENABLE_STATE');
 const before=await unchanged();checkMain(await read(`/v13/deployments/${state.main_preview.id}`),config,before);
 const current=await read(`/v13/deployments/${state.deployment.id}`);checkIngress(current,state);
 requireThat(current.readyState==='READY','INGRESS_NOT_READY');
 state.forwarding_probe=await forwardingProbe();save();
 requireThat(state.forwarding_probe.available,'INGRESS_FORWARD_SHARE_EXCHANGE_FAILED');
 if(state.phase==='enabled')return redactedIngressStatus(state,await publicChecks());
 try{
  // Hobby permits one share link per account. Creating a separate ingress
  // probe share can invalidate the forwarding share embedded in its bundle.
  // Probe the narrow public boundary after the override, with rollback below.
  // Check the main application before opening anything and again afterward.
  requireThat(isProtectedPreviewResponse(await probe(state.main_preview.origin),state.main_preview.origin),'INGRESS_MAIN_NOT_PROTECTED');
  state.override_intent=true;save();
  await mutate(`/aliases/${state.deployment.id}/protection-bypass`,{override:{scope:'alias-protection-override',action:'create'}},'enable_ingress');
  state.override_enabled=true;finished();
  let checks;
  const propagationDeadline=now()+20000;
  for(let attempt=0;attempt<=10;attempt++){
   const remaining=Math.max(1,propagationDeadline-now());
   checks=await publicChecks(Math.min(15000,remaining));
   // Persist the safe tuple BEFORE asserting or rolling back. Failed earlier
   // attempts stay available even when a later attempt succeeds.
   (state.boundary_probe_history??=[]).push({at:new Date(now()).toISOString(),attempt,checks});
   state.last_boundary_probe=checks;save();
   if(publicBoundaryReady(checks))break;
   requireThat(awaitingProtectionPropagation(checks)&&attempt<10&&now()<propagationDeadline,'INGRESS_PUBLIC_BOUNDARY_PROBE_FAILED');
   await pause(Math.min(2000,propagationDeadline-now()));
  }
  requireThat(publicBoundaryReady(checks),'INGRESS_PUBLIC_BOUNDARY_PROBE_FAILED');
  await unchanged();await revokeShare('probe_share');
  state.forwarding_probe=await forwardingProbe();save();
  requireThat(state.forwarding_probe.available,'INGRESS_FORWARD_SHARE_EXCHANGE_FAILED');
  state.phase='enabled';state.enabled_at=new Date(now()).toISOString();state.boundary_checks=checks;save();
  return redactedIngressStatus(state,checks);
 }catch(error){
  // If an enable was even attempted, remove only our ingress exception. A
  // rollback failure remains explicit in the private state; never claim STOP.
  if(state.override_intent){
   try{await mutate(`/aliases/${state.deployment.id}/protection-bypass`,{override:{scope:'alias-protection-override',action:'revoke'}},'rollback_ingress');state.override_enabled=false;finished();}
   catch{state.phase='rollback_required';save();throw Error('INGRESS_ENABLE_ROLLBACK_UNCERTAIN');}
  }
  try{await revokeShare('probe_share');}catch{state.phase='share_revoke_required';save();throw Error('INGRESS_PROBE_SHARE_REVOKE_UNCERTAIN');}
  throw error;
 }
}

function artifactFromDisk(repo){
 const git=args=>execFileSync('git',args,{cwd:repo,encoding:'utf8',windowsHide:true}).trim();
 requireThat(git(['branch','--show-current'])===BRANCH&&!git(['status','--porcelain']),'INGRESS_CLEAN_RELEASE_BRANCH_REQUIRED');
 const base=path.join(repo,'output/release-completion/dev-resend-ingress');
 const manifest=JSON.parse(readFileSync(path.join(base,'build-manifest.json'),'utf8'));
 requireThat(manifest.source_commit===git(['rev-parse','HEAD']),'INGRESS_BUILD_HEAD_MISMATCH');
 for(const input of manifest.inputs)requireThat(hash(readFileSync(path.join(repo,input.path)))===input.sha256,'INGRESS_BUILD_INPUT_CHANGED');
 const files=FILES.map(file=>({file,data:readFileSync(path.join(base,'prebuilt',file),'utf8'),encoding:'utf-8'}));
 requireThat(hash(files[2].data)===manifest.output_sha256,'INGRESS_BUNDLE_CHANGED');
 const cfg=JSON.parse(files[0].data),fn=JSON.parse(files[1].data);
 requireThat(JSON.stringify(cfg)===JSON.stringify({version:3,routes:[{handle:'filesystem'},{src:'/.*',status:404}]}),'INGRESS_OUTPUT_ROUTE_SCOPE');
 requireThat(JSON.stringify(fn)===JSON.stringify({runtime:'nodejs24.x',handler:'index.js',launcherType:'Nodejs',maxDuration:30,shouldAddHelpers:false}),'INGRESS_FUNCTION_SCOPE');
 return {source_commit:manifest.source_commit,bundle_sha256:manifest.output_sha256,files};
}
async function main(){
 assertLocalIngressOperator(process.env); // Before reading private config.
 const [command,flag,configFile,...extra]=process.argv.slice(2);
 requireThat(flag==='--config'&&configFile&&(command==='reconcile-absent-share'
  ?extra.length===4&&extra[0]==='--receipt'&&extra[2]==='--override-receipt':extra.length===0),'USAGE_DEV_INGRESS_DEPLOY_COMMAND_CONFIG');
 const repo=realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'));
 const privateFile=realpathSync(path.resolve(configFile)),directory=path.dirname(privateFile);
 const relative=path.relative(repo,privateFile);
 requireThat(relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative),'INGRESS_CONFIG_MUST_BE_OUTSIDE_REPO');
 const config=parseIngressOperatorConfig(JSON.parse(readFileSync(privateFile,'utf8')));
 requireThat(existsSync(config.vercel_cli_path),'INGRESS_CLI_NOT_FOUND');
 const stateFile=`${privateFile}.state.private.json`,lockFile=`${privateFile}.lock`;
 const lock=openSync(lockFile,'wx');
 try{
  const readRecoveryReceipt=filename=>{
   const actual=realpathSync(path.resolve(filename));
   requireThat(path.dirname(actual)===directory&&/^dev-ingress-[a-f0-9-]+\.response\.private\.json$/u.test(path.basename(actual)),'INGRESS_RECOVERY_PRIVATE_RECEIPT_REQUIRED');
   return {filename:path.basename(actual),response:JSON.parse(readFileSync(actual,'utf8')),
    request:JSON.parse(readFileSync(actual.replace('.response.private.json','.request.private.json'),'utf8'))};
  };
  const recoveryEvidence=command==='reconcile-absent-share'
   ?{missing_share:readRecoveryReceipt(extra[1]),override_revoke:readRecoveryReceipt(extra[3])}:undefined;
  const saveState=state=>{const temp=`${stateFile}.tmp`;writeFileSync(temp,JSON.stringify(state,null,2),{mode:0o600});renameSync(temp,stateFile);};
  const api=async(endpoint,method='GET',body)=>{
   const args=[config.vercel_cli_path,'api',endpoint,'-X',method,'--raw'];
   const operation=randomUUID(),requestFile=path.join(directory,`dev-ingress-${operation}.request.private.json`);
   if(body){writeFileSync(requestFile,JSON.stringify(body),{mode:0o600});args.push('--input',requestFile);}
   const result=spawnSync(process.execPath,args,{cwd:repo,encoding:'utf8',windowsHide:true,maxBuffer:16*1024*1024,timeout:60000});
   // Mutation responses may contain a scoped share. Keep them private for
   // explicit reconciliation after interruption; never print their contents.
   if(body)writeFileSync(path.join(directory,`dev-ingress-${operation}.response.private.json`),JSON.stringify({endpoint,method,status:result.status,stdout:result.stdout??'',stderr:result.stderr??''}),{mode:0o600});
   requireThat(result.status===0,'INGRESS_VERCEL_REQUEST_FAILED');
   try{return JSON.parse(result.stdout);}catch{throw Error('INGRESS_VERCEL_RESPONSE_INVALID');}
  };
  const result=await runIngressOperator(command,{config,artifact:command==='deploy'?artifactFromDisk(repo):null,api,recoveryEvidence,
   loadState:()=>existsSync(stateFile)?JSON.parse(readFileSync(stateFile,'utf8')):null,saveState});
  mkdirSync(path.join(repo,'output/release-completion/dev-resend-ingress'),{recursive:true});
  writeFileSync(path.join(repo,'output/release-completion/dev-resend-ingress/operator-status.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
 }finally{closeSync(lock);unlinkSync(lockFile);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{
 console.error(JSON.stringify({state:'failed',code:error instanceof Error&&/^[A-Z][A-Z0-9_]+$/u.test(error.message)?error.message:'INGRESS_OPERATOR_FAILED'}));process.exitCode=1;
});
