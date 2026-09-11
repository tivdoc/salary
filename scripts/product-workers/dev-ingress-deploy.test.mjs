import {describe,expect,it,vi} from 'vitest';
import path from 'node:path';
import {assertLocalIngressOperator,INGRESS_PROJECT,INGRESS_TEAM,isProtectedPreviewResponse,runIngressOperator} from './dev-ingress-deploy.mjs';

const NOW=Date.parse('2026-09-11T06:40:00Z');
function vercelSsoResponse(requestedUrl){
 const url=new URL('/sso-api','https://vercel.com');url.searchParams.set('url',new URL(requestedUrl).href);url.searchParams.set('nonce','synthetic-nonce');
 return new Response(null,{status:302,headers:{location:url.href,'set-cookie':'_vercel_sso_nonce=synthetic-only; Secure; HttpOnly'}});
}
function fixture(){
 const config={schema_version:'dev-ingress-operator-v1',vercel_cli_path:path.resolve('synthetic-cli.js'),main_preview_id:'dpl_mainSynthetic',
  main_preview_commit:'a'.repeat(40),resend_webhook_secret:`whsec_${Buffer.alloc(32,7).toString('base64')}`,expires_at:new Date(NOW+3600000).toISOString()};
 const project={id:INGRESS_PROJECT,name:'salary',accountId:INGRESS_TEAM,targets:{production:{id:'dpl_productionSynthetic'}},nodeVersion:'24.x',
  framework:'nextjs',ssoProtection:{deploymentType:'all_except_custom_domains'}};
 const main={id:config.main_preview_id,url:'salary-mainsynthetic-tivdoccom-5042s-projects.vercel.app',projectId:INGRESS_PROJECT,target:null,readyState:'READY',
  meta:{githubCommitRef:'codex/tivdoc-release-completion',githubCommitSha:config.main_preview_commit}};
 const artifact={source_commit:'b'.repeat(40),bundle_sha256:'c'.repeat(64),files:[
  '.vercel/output/config.json','.vercel/output/functions/api/resend.func/.vc-config.json','.vercel/output/functions/api/resend.func/index.js',
 ].map(file=>({file,data:'synthetic artifact bytes',encoding:'utf-8'}))};
 const ctx={state:null,project,main,ingress:null,override:false,protectedGetStatus:405,sharedNext:null,shareSequence:0,clock:NOW,vercelSso:false,propagationUntil:0};
 const api=vi.fn(async(endpoint,method='GET',body)=>{
  const url=new URL(endpoint,'https://api.vercel.com');expect(url.searchParams.get('teamId')).toBe(INGRESS_TEAM);
  if(method==='GET'){
   if(url.pathname===`/v9/projects/${INGRESS_PROJECT}`)return structuredClone(project);
   if(url.pathname===`/v13/deployments/${main.id}`)return structuredClone(main);
   if(url.pathname===`/v13/deployments/${ctx.ingress?.id}`)return structuredClone(ctx.ingress);
   if(url.pathname.endsWith('/env')&&url.pathname.startsWith('/v10/'))return {envs:[{key:'OPENAI_API_KEY',value:'synthetic-never-copy'},
    {key:'RESEND_API_KEY',value:'synthetic-never-copy'},{key:'NEXT_PUBLIC_SUPABASE_URL',value:'synthetic-never-copy'},{key:'RESEND_WEBHOOK_SECRET',value:'old-signing-value'}]};
   if(url.pathname==='/v1/env')return {data:[{key:'SHARED_APPLICATION_PASSWORD',value:'synthetic-never-copy'}],pagination:{next:ctx.sharedNext}};
  }
  if(method==='PATCH'&&url.pathname.endsWith('/protection-bypass')){
   if(body.override){ctx.override=body.override.action==='create';return {};}
   if(body.revoke)return {};
   ctx.shareSequence++;
   return {protectionBypass:{[`synthetic-share-value-${ctx.shareSequence}`]:{scope:'shareable-link',createdAt:ctx.clock,expires:Math.floor(ctx.clock/1000)+body.ttl}}};
  }
  if(method==='POST'&&url.pathname==='/v13/deployments'){
   expect(url.searchParams.get('prebuilt')).toBe('1');
   ctx.ingress={id:'dpl_ingressSynthetic',projectId:INGRESS_PROJECT,url:'salary-ingresssynthetic-tivdoccom-5042s-projects.vercel.app',
    target:null,readyState:'READY',meta:body.meta};return structuredClone(ctx.ingress);
  }
  throw Error('UNEXPECTED_SYNTHETIC_API_CALL');
 });
 const transport=vi.fn(async(input,options={})=>{
  const url=new URL(input);
  if(url.host===main.url)return ctx.vercelSso?vercelSsoResponse(url):new Response(null,{status:401});
  expect(url.host).toBe(ctx.ingress.url);
  if(url.searchParams.has('_vercel_share'))return new Response(null,{status:307,headers:{location:`https://${url.host}/api/resend`,'set-cookie':'_vercel_jwt=synthetic-only; Secure; HttpOnly'}});
  if(new Headers(options.headers).has('cookie'))return new Response(null,{status:ctx.protectedGetStatus});
  if(!ctx.override||ctx.clock<ctx.propagationUntil)return ctx.vercelSso?vercelSsoResponse(url):new Response(null,{status:401});
  if(url.pathname!=='/api/resend')return new Response(null,{status:404});
  return new Response(null,{status:options.method==='POST'?401:405});
 });
 const deps={config,artifact,api,transport,now:()=>ctx.clock,pause:vi.fn(async ms=>{ctx.clock+=ms;}),newId:()=> 'synthetic-operation-only',
  loadState:()=>structuredClone(ctx.state),saveState:state=>{ctx.state=structuredClone(state);}};
 return {ctx,deps,run:command=>runIngressOperator(command,deps)};
}
describe('DEV ingress operator, synthetic API/transport only; no real deployment proof',()=>{
 it('recognizes the observed Vercel SSO302 only with its exact Preview return URL and challenge',()=>{
  const origin='https://salary-synthetic-tivdoccom-5042s-projects.vercel.app';
  expect(isProtectedPreviewResponse(vercelSsoResponse(origin),origin)).toBe(true);
  expect(isProtectedPreviewResponse(vercelSsoResponse('https://foreign.example'),origin)).toBe(false);
  expect(isProtectedPreviewResponse(vercelSsoResponse(`${origin}/other`),origin)).toBe(false);
  const foreign=vercelSsoResponse(origin);foreign.headers.set('location','https://attacker.example/sso-api');
  expect(isProtectedPreviewResponse(foreign,origin)).toBe(false);
  const ordinary=new Response(null,{status:302,headers:{location:`${origin}/login`}});
  expect(isProtectedPreviewResponse(ordinary,origin)).toBe(false);
  const withoutChallenge=vercelSsoResponse(origin);withoutChallenge.headers.delete('set-cookie');
  expect(isProtectedPreviewResponse(withoutChallenge,origin)).toBe(false);
 });
 it('refuses a remote or Production process before any private config is read',()=>{
  for(const env of [{VERCEL:'1'},{VERCEL_ENV:'preview'},{VERCEL_ENV:'production'},{NODE_ENV:'production'}])expect(()=>assertLocalIngressOperator(env)).toThrow('INGRESS_LOCAL_OPERATOR_REQUIRED');
  expect(()=>assertLocalIngressOperator({NODE_ENV:'test'})).not.toThrow();
 });
 it('creates only a Preview request on the existing project with every inherited value blanked',async()=>{
  const f=fixture(),result=await f.run('deploy');
  const post=f.deps.api.mock.calls.find(([,method])=>method==='POST'),body=post[2];
  expect(body).not.toHaveProperty('target');expect(body).not.toHaveProperty('projectSettings');expect(body).not.toHaveProperty('gitMetadata');
  expect(body).not.toHaveProperty('gitSource');expect(body).not.toHaveProperty('alias');
  expect(body.env).toMatchObject({OPENAI_API_KEY:'',RESEND_API_KEY:'',NEXT_PUBLIC_SUPABASE_URL:'',SHARED_APPLICATION_PASSWORD:'',
   RESEND_WEBHOOK_SECRET:f.deps.config.resend_webhook_secret,TIVDOC_DEV_PREVIEW_ORIGIN:`https://${f.ctx.main.url}`});
  expect(JSON.stringify(body)).not.toContain('synthetic-never-copy');expect(JSON.stringify(body)).not.toContain('old-signing-value');
  expect(result.phase).toBe('deployed');expect(result.ingress_deployment_id).toBe('dpl_ingressSynthetic');
  expect(JSON.stringify(result)).not.toContain('synthetic-share-value');expect(JSON.stringify(result)).not.toContain('whsec_');
  expect(f.ctx.override).toBe(false);expect(f.deps.transport).not.toHaveBeenCalled();
 });
 it.each(['production','other_project','wrong_branch','wrong_sha','not_ready','empty_project'])('refuses unsafe main/project scope before any mutation: %s',async kind=>{
  const f=fixture();
  if(kind==='production')f.ctx.main.target='production';
  if(kind==='other_project')f.ctx.main.projectId='prj_foreign';
  if(kind==='wrong_branch')f.ctx.main.meta.githubCommitRef='main';
  if(kind==='wrong_sha')f.ctx.main.meta.githubCommitSha='f'.repeat(40);
  if(kind==='not_ready')f.ctx.main.readyState='BUILDING';
  if(kind==='empty_project')f.ctx.project.targets={};
  await expect(f.run('deploy')).rejects.toThrow();expect(f.deps.api.mock.calls.every(([,method])=>method==='GET')).toBe(true);
 });
 it('refuses an incomplete inherited-env inventory and artifact route/file additions',async()=>{
  const f=fixture();f.ctx.sharedNext='another-page';await expect(f.run('deploy')).rejects.toThrow('INGRESS_ENV_INVENTORY_INCOMPLETE');
  expect(f.ctx.state).toBeNull();
  const other=fixture();other.deps.artifact.files.push({file:'.vercel/output/static/index.html',data:'app'});
  await expect(other.run('deploy')).rejects.toThrow('INGRESS_ARTIFACT_FILE_SCOPE');expect(other.deps.api).not.toHaveBeenCalled();
 });
 it('preserves an existing deployment receipt instead of blindly creating another deployment on retry',async()=>{
  const f=fixture();await f.run('deploy');await expect(f.run('deploy')).rejects.toThrow('INGRESS_STATE_EXISTS_USE_STATUS_OR_DISABLE');
  expect(f.deps.api.mock.calls.filter(([,method])=>method==='POST')).toHaveLength(1);
  const status=await f.run('status');expect(status.project_unchanged).toBe(true);expect(status.ready_state).toBe('READY');
 });
 it('opens only the pinned ingress after a protected credential-scope probe, then revokes its temporary probe share',async()=>{
  const f=fixture();await f.run('deploy');const result=await f.run('enable');
  expect(result).toMatchObject({phase:'enabled',ingress_get_status:405,ingress_unknown_path_status:404,unsigned_post_status:401,main_unauthenticated_status:401});
  const overrides=f.deps.api.mock.calls.filter(([,method,body])=>method==='PATCH'&&body.override);
  expect(overrides).toHaveLength(1);expect(overrides[0][0]).toContain('/aliases/dpl_ingressSynthetic/protection-bypass');
  expect(overrides[0][2]).toEqual({override:{scope:'alias-protection-override',action:'create'}});
  expect(f.ctx.state.probe_share.revoked_at).toBeDefined();expect(f.ctx.state.forward_share.revoked_at).toBeUndefined();
  expect(f.deps.api.mock.calls.some(([endpoint])=>endpoint.includes('/v1/projects/')&&endpoint.includes('protection-bypass'))).toBe(false);
 });
 it('refuses inherited runtime credentials without adding an exception, retaining a bounded forward share',async()=>{
  const f=fixture();await f.run('deploy');f.ctx.protectedGetStatus=503;
  await expect(f.run('enable')).rejects.toThrow('INGRESS_RUNTIME_SCOPE_PROBE_FAILED');
  expect(f.deps.api.mock.calls.filter(([,method,body])=>method==='PATCH'&&body.override?.action==='create')).toHaveLength(0);
  expect(f.ctx.state.probe_share.revoked_at).toBeDefined();expect(f.ctx.override).toBe(false);
 });
 it('rejects changed Production/settings and mismatched artifact metadata before enabling',async()=>{
  const f=fixture();await f.run('deploy');f.ctx.project.framework=null;
  await expect(f.run('enable')).rejects.toThrow('INGRESS_PROJECT_SETTINGS_OR_PRODUCTION_CHANGED');
  const g=fixture();await g.run('deploy');g.ctx.ingress.meta.bundleSha256='d'.repeat(64);
  await expect(g.run('enable')).rejects.toThrow('INGRESS_ARTIFACT_SCOPE');
 });
 it('rolls back only its ingress exception if the public boundary fails',async()=>{
  const f=fixture();await f.run('deploy');const normal=f.deps.transport;
  f.deps.transport=async(input,options)=>new URL(input).pathname==='/case/never-served'?new Response(null,{status:200}):normal(input,options);
  await expect(f.run('enable')).rejects.toThrow('INGRESS_PUBLIC_BOUNDARY_PROBE_FAILED');
  const overrides=f.deps.api.mock.calls.filter(([,method,body])=>method==='PATCH'&&body.override);
  expect(overrides.map(([, ,body])=>body.override.action)).toEqual(['create','revoke']);
  expect(overrides.every(([endpoint])=>endpoint.includes('/aliases/dpl_ingressSynthetic/'))).toBe(true);expect(f.ctx.override).toBe(false);
  expect(f.ctx.state.last_boundary_probe.ingress_unknown_path_status).toBe(200);
  expect(f.ctx.state.boundary_probe_history).toHaveLength(1);expect(f.deps.pause).not.toHaveBeenCalled();
 });
 it('waits only for recognized protection propagation after one override, preserving every failed probe',async()=>{
  const f=fixture();f.ctx.vercelSso=true;f.ctx.propagationUntil=NOW+4000;await f.run('deploy');
  expect(await f.run('enable')).toMatchObject({phase:'enabled',main_protected:true});
  expect(f.ctx.state.boundary_probe_history.map(x=>x.checks.ingress_get_status)).toEqual([302,302,405]);
  expect(f.deps.api.mock.calls.filter(([,method,body])=>method==='PATCH'&&body.override?.action==='create')).toHaveLength(1);
  expect(f.deps.pause).toHaveBeenCalledTimes(2);
 });
 it('rolls back after the 20-second propagation bound with the last protected tuple preserved',async()=>{
  const f=fixture();f.ctx.vercelSso=true;f.ctx.propagationUntil=NOW+60000;await f.run('deploy');
  await expect(f.run('enable')).rejects.toThrow('INGRESS_PUBLIC_BOUNDARY_PROBE_FAILED');
  expect(f.ctx.clock-NOW).toBe(20000);expect(f.ctx.state.last_boundary_probe).toMatchObject({ingress_get_status:302,main_protected:true});
  expect(f.ctx.state.boundary_probe_history).toHaveLength(11);expect(f.ctx.override).toBe(false);
  expect(f.deps.api.mock.calls.filter(([,method,body])=>method==='PATCH'&&body.override?.action==='create')).toHaveLength(1);
 });
 it('supports disable after expiry without extending or regenerating any share',async()=>{
  const f=fixture();await f.run('deploy');await f.run('enable');f.ctx.clock=NOW+7200000;
  await expect(f.run('enable')).rejects.toThrow('INGRESS_EXPIRED_OR_UNBOUNDED');
  const result=await f.run('disable');expect(result).toMatchObject({phase:'disabled',protected:true,project_unchanged:true,public_status:401});
  expect(f.ctx.state.forward_share.expired_at).toBeDefined();expect(f.ctx.state.forward_share.revoked_at).toBeUndefined();
  const calls=f.deps.api.mock.calls.filter(([,method,body])=>method==='PATCH'&&body.revoke);
  expect(calls.every(([, ,body])=>body.revoke.regenerate===false)).toBe(true);
 });
 it('enables and observes STOP with the real Vercel302 response shape while leaving the main Preview protected',async()=>{
  const f=fixture();f.ctx.vercelSso=true;await f.run('deploy');
  expect(await f.run('enable')).toMatchObject({phase:'enabled',main_unauthenticated_status:302,main_protected:true});
  expect(await f.run('disable')).toMatchObject({phase:'disabled',protected:true,public_status:302});
 });
 it('leaves a durable mutation intent on a lost response, and refuses blind replay',async()=>{
  const f=fixture(),normal=f.deps.api;
  f.deps.api=vi.fn(async(endpoint,method,body)=>{if(method==='POST')throw Error('synthetic lost response');return normal(endpoint,method,body);});
  await expect(f.run('deploy')).rejects.toThrow('synthetic lost response');
  expect(f.ctx.state.pending_mutation.label).toBe('create_ingress_preview');
  await expect(f.run('deploy')).rejects.toThrow('INGRESS_STATE_EXISTS_USE_STATUS_OR_DISABLE');
  expect(f.deps.api.mock.calls.filter(([,method])=>method==='POST')).toHaveLength(1);
 });
});
