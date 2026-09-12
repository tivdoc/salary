import "../production-refusal.mjs";
import {describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AI_CONTROL_SQL,AI_CONTROL_TARGET,aiControlPrivatePath,aiControlDatabaseOptions,aiControlCredentialUrl,assertLocalAiControl,
 parseAiControlArgs,parseAiControlRequest,runAiReleaseControl,safeAiControlError,loadAiControlHelpers} from './ai-release-control.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const CASE='11111111-1111-4111-8111-111111111111',CONFIG='22222222-2222-4222-8222-222222222222';
const at='2026-09-12T10:00:00Z',from='2026-09-12T09:00:00Z',to='2026-09-12T12:00:00Z';
const canon=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
const seal=body=>({...body,sha256:createHash('sha256').update(canon(body)).digest('hex')});
function fixture(){
 const config=seal({schema_version:'tivdoc-ai-release-configuration-v1',configuration_id:CONFIG,revision:1,build_manifest_sha256:'c'.repeat(64),
  policy:{namespace:'isolated_test',branches:[{}],issued_at:from,expires_at:to},registry:{issued_at:from,expires_at:to},
  source_receipts:[{status:'unknown'}],interpretation_receipts:[{status:'unknown',human_by_law:{state:'unresolved'}}]});
 const request={schema_version:'ai-release-control-request-v1',case_id:CASE,configuration_sha256:config.sha256,
  request_key:'synthetic-grant-001',issued_at:from,expires_at:to,reason:'Synthetic private reason; never display this text.'};
 const ctx={configs:[{configuration_id:CONFIG,revision:1,payload_sha256:config.sha256,payload:config}],events:[],qa:true,
  identity:{session_user:AI_CONTROL_TARGET.role,current_user:AI_CONTROL_TARGET.role,database:AI_CONTROL_TARGET.database,db_time:at},writes:[]};
 const query=vi.fn(async(sql,params=[])=>{
  if(sql===AI_CONTROL_SQL.identity)return {rows:[ctx.identity]};
  if(sql===AI_CONTROL_SQL.qa)return {rows:[{id:CASE,is_qa:ctx.qa}]};
  if(sql===AI_CONTROL_SQL.configs)return {rows:ctx.configs.filter(c=>c.payload_sha256===params[0]||(c.configuration_id===params[1]&&c.revision===params[2]))};
  if(sql===AI_CONTROL_SQL.configByHash)return {rows:ctx.configs.filter(c=>c.payload_sha256===params[0])};
  if(sql===AI_CONTROL_SQL.latest)return {rows:ctx.events.slice(-1)};
  if(sql===AI_CONTROL_SQL.prior)return {rows:ctx.events.filter(e=>e.idempotency_key===params[1])};
  if(sql.startsWith('select pg_advisory_xact_lock'))return {rows:[]};
  if(sql===AI_CONTROL_SQL.configInsert){ctx.writes.push(sql);const payload=JSON.parse(params[3]);ctx.configs.push({configuration_id:params[0],revision:params[1],payload_sha256:params[2],payload});return {rows:[]};}
  if(sql===AI_CONTROL_SQL.record){
   ctx.writes.push(sql);let existing=ctx.events.find(e=>e.idempotency_key===params[2]);const replayed=!!existing;
   if(!existing){existing={event_id:'33333333-3333-4333-8333-333333333333',case_id:params[0],configuration_sha256:params[1],
    idempotency_key:params[2],kind:params[3],issued_at:params[4],expires_at:params[5],reason:params[6],sequence:ctx.events.length+1,
    predecessor_id:ctx.events.at(-1)?.event_id??null,authority_dependency_sha256:'d'.repeat(64)};ctx.events.push(existing);}
   return {rows:[{receipt:{...existing,schema_version:'ai-release-enrollment-receipt-v1',request_key:existing.idempotency_key,replayed,current:ctx.events.at(-1)===existing}}]};
  }
  throw Error('UNEXPECTED_TEST_QUERY');
 });
 const ports={env:{NODE_ENV:'test'},readJson:vi.fn(async file=>structuredClone(file==='config'?config:request)),
  verifyConfiguration:vi.fn(async c=>c),inspect:vi.fn(async()=>({build_manifest_sha256:'c'.repeat(64)})),
  database:vi.fn(async(_file,apply,fn)=>{ctx.apply=apply;return fn({query});})};
 return {config,request,ctx,ports,query};
}
const args=(command,apply=false)=>[command,...(command.startsWith('config-')?['--configuration','config']:['--request','request']),
 '--credentials','credentials',...(apply?['--apply']:[])];
async function granted(f){return runAiReleaseControl(args('enroll',true),f.ports);}

describe('AI release owner operator',()=>{
 it('has strict commands, dry-run default and no ambiguous apply flags',()=>{
  expect(parseAiControlArgs(args('enroll')).apply).toBe(false);
  for(const bad of [[],['inspect','--apply'],['enroll','--request','x'],[...args('enroll'),'--apply','--apply'],[...args('enroll'),'--production'],['status','--case','not-uuid','--credentials','x']])expect(()=>parseAiControlArgs(bad)).toThrow();
 });
 it('refuses production and hosted environments before file or DB access',async()=>{
  for(const env of [{NODE_ENV:' Production '},{VERCEL_ENV:'preview'},{VERCEL:'1'}]){
   expect(()=>assertLocalAiControl(env)).toThrow('AI_CONTROL_LOCAL_DEV_ONLY');
   const f=fixture();await expect(runAiReleaseControl(args('enroll'),{...f.ports,env})).rejects.toThrow();expect(f.ports.readJson).not.toHaveBeenCalled();
  }
  for(const env of [{NODE_ENV:'production'},{NODE_ENV:'test',VERCEL_ENV:'preview'}]){
   const process=spawnSync(globalThis.process.execPath,['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON','--experimental-strip-types',
    'scripts/product-workers/ai-release-control.mjs','enroll'],{cwd:ROOT,env:{...globalThis.process.env,...env},encoding:'utf8'});
   expect(process.status).toBe(2);expect(process.stderr).toContain('PRODUCTION_ENVIRONMENT_REFUSED');
  }
 });
 it('pins database, role, host and TLS independently of URL sslmode',()=>{
  const url=`postgresql://${AI_CONTROL_TARGET.user}:synthetic@${AI_CONTROL_TARGET.host}:5432/${AI_CONTROL_TARGET.database}?sslmode=no-verify`;
  const options=aiControlDatabaseOptions(url,'synthetic-ca');expect(options.ssl).toEqual({rejectUnauthorized:true,ca:'synthetic-ca'});expect(new URL(options.connectionString).search).toBe('');
  expect(aiControlCredentialUrl(`# private file\r\nOTHER=ignored\r\nTIVDOC_DEV_DATABASE_URL=${url}\r\n`)).toBe(url);
  expect(()=>aiControlCredentialUrl(`TIVDOC_DEV_DATABASE_URL=${url}\nTIVDOC_DEV_DATABASE_URL=${url}`)).toThrow('AI_CONTROL_CREDENTIAL_FILE');
  for(const bad of [url.replace(AI_CONTROL_TARGET.database,'postgres'),url.replace(AI_CONTROL_TARGET.user,'postgres.other'),url.replace(AI_CONTROL_TARGET.host,'localhost'),url.replace(':5432',':9999'),'invalid'])expect(()=>aiControlDatabaseOptions(bad,'ca')).toThrow('AI_CONTROL_DATABASE_TARGET');
 });
 it('rejects wrong server identity and non-QA before any mutation',async()=>{
  for(const change of [f=>f.ctx.identity.database='postgres',f=>f.ctx.identity.current_user='postgres',f=>f.ctx.qa=false]){
   const f=fixture();change(f);await expect(runAiReleaseControl(args('enroll',true),f.ports)).rejects.toThrow();expect(f.ctx.writes).toEqual([]);
  }
 });
 it('requires fixed valid UTC windows and exact request fields',()=>{
  const {request}=fixture();expect(parseAiControlRequest(request)).toEqual(request);
  for(const change of [{expires_at:from},{expires_at:'2026-09-14T12:00:00Z'},{issued_at:'now'},{issued_at:'2026-02-30T09:00:00Z'},
   {issued_at:'2026-09-12T09:00:00+00:00'},{request_key:'x'},{reason:'short'},{case_facts:{hours:1}}])expect(()=>parseAiControlRequest({...request,...change})).toThrow();
 });
 it('validates locally without credentials and preserves unknown review states',async()=>{
  const f=fixture();const result=await runAiReleaseControl(['config-validate','--configuration','config'],f.ports);
  expect(f.ports.database).not.toHaveBeenCalled();expect(result.interpretation_states).toEqual({unknown:1});expect(result.human_law_states).toEqual({unresolved:1});expect(result.runtime_admission_evaluated).toBe(false);
 });
 it('does not insert config or enrollment in dry-run',async()=>{
  const f=fixture();f.ctx.configs=[];const result=await runAiReleaseControl(args('config-store'),f.ports);
  expect(result.operation).toBe('store_configuration');expect(result.applied).toBe(false);expect(f.ctx.apply).toBe(false);expect(f.ctx.writes).toEqual([]);
  const g=fixture();await runAiReleaseControl(args('enroll'),g.ports);expect(g.ctx.writes).toEqual([]);expect(g.ports.verifyConfiguration).toHaveBeenCalledOnce();
 });
 it('stores immutable config once and checks complete retry bytes',async()=>{
  const f=fixture();f.ctx.configs=[];
  const first=await runAiReleaseControl(args('config-store',true),f.ports);const second=await runAiReleaseControl(args('config-store',true),f.ports);
  expect(first.replayed).toBe(false);expect(second.replayed).toBe(true);expect(f.ctx.writes).toHaveLength(1);
  f.ctx.configs[0].payload=seal({...f.config,population:'tampered',sha256:undefined});
  await expect(runAiReleaseControl(args('config-store',true),f.ports)).rejects.toThrow();expect(f.ctx.writes).toHaveLength(1);
 });
 it('refuses stored ID/revision collision before an insert',async()=>{
  const f=fixture();const {sha256,...body}=f.config;void sha256;
  const changed=seal({...body,build_manifest_sha256:'a'.repeat(64)});f.ctx.configs=[{configuration_id:CONFIG,revision:1,payload_sha256:changed.sha256,payload:changed}];
  await expect(runAiReleaseControl(args('config-store',true),f.ports)).rejects.toThrow('AI_CONTROL_CONFIGURATION_RETRY_MISMATCH');expect(f.ctx.writes).toEqual([]);
 });
 it('passes only exact request parameters and redacts free text from receipt',async()=>{
  const f=fixture();const result=await granted(f);
  expect(f.query).toHaveBeenCalledWith(AI_CONTROL_SQL.record,[CASE,f.config.sha256,f.request.request_key,'granted',from,to,f.request.reason]);
  expect(result.enrollment.enrollment_state).toBe('within_window');expect(JSON.stringify(result)).not.toContain(f.request.reason);expect(JSON.stringify(result)).not.toContain(f.request.request_key);
  expect(result.enrollment.runtime_admission_evaluated).toBe(false);
 });
 it('replays expired historical grant without build refresh and never extends it',async()=>{
  const f=fixture();await granted(f);f.ctx.identity.db_time='2026-09-13T10:00:00Z';f.ports.verifyConfiguration.mockRejectedValue(Error('AI_BUILD_MANIFEST_DRIFT'));
  const result=await granted(f);expect(result.enrollment.replayed).toBe(true);expect(result.enrollment.enrollment_state).toBe('expired');expect(result.enrollment.expires_at).toBe(to);expect(f.ctx.events).toHaveLength(1);
 });
 it('rejects replay mismatch before the RPC',async()=>{
  const f=fixture();await granted(f);f.request.expires_at='2026-09-12T13:00:00Z';
  await expect(granted(f)).rejects.toThrow('AI_RELEASE_ENROLLMENT_RETRY_MISMATCH');expect(f.ctx.writes).toHaveLength(1);
 });
 it('revokes expired config even after build drift, then preserves superseded grant retry',async()=>{
  const f=fixture();await granted(f);f.ctx.identity.db_time='2026-09-13T10:00:00Z';f.ports.verifyConfiguration.mockRejectedValue(Error('AI_BUILD_MANIFEST_DRIFT'));
  f.request.request_key='synthetic-revoke-001';f.request.reason='Synthetic revocation reason.';
  const revoked=await runAiReleaseControl(args('revoke',true),f.ports);expect(revoked.enrollment.enrollment_state).toBe('revoked');
  f.request.request_key='synthetic-grant-001';f.request.reason='Synthetic private reason; never display this text.';
  // Separate IDs make the fixture model the append-only journal correctly.
  f.ctx.events[1].event_id='44444444-4444-4444-8444-444444444444';
  const replay=await granted(f);expect(replay.enrollment.current).toBe(false);expect(replay.enrollment.enrollment_state).toBe('superseded');expect(f.ctx.events).toHaveLength(2);
 });
 it('refuses a new expired grant, wrong revoke scope, and verifier failures',async()=>{
  const f=fixture();f.ctx.identity.db_time='2026-09-13T10:00:00Z';await expect(granted(f)).rejects.toThrow('AI_RELEASE_ENROLLMENT_VALIDITY');expect(f.ctx.writes).toEqual([]);
  const g=fixture();await expect(runAiReleaseControl(args('revoke',true),g.ports)).rejects.toThrow('AI_RELEASE_REVOKE_SCOPE');
  const h=fixture();h.ports.verifyConfiguration.mockRejectedValue(Error('AI_BUILD_MANIFEST_DRIFT'));await expect(granted(h)).rejects.toThrow('AI_BUILD_MANIFEST_DRIFT');expect(h.ctx.writes).toEqual([]);
 });
 it('reads status without current build or configuration approval',async()=>{
  const f=fixture();await granted(f);f.ports.verifyConfiguration.mockClear();
  const status=await runAiReleaseControl(['status','--case',CASE,'--credentials','credentials'],f.ports);
  expect(status.enrollment.current).toBe(true);expect(f.ports.verifyConfiguration).not.toHaveBeenCalled();expect(f.ctx.apply).toBe(false);
 });
 it('sanitizes arbitrary database and schema errors',()=>{
  expect(safeAiControlError(Error('password=synthetic-private-value'))).toBe('AI_CONTROL_FAILED');
  expect(safeAiControlError(Error('AI_RELEASE_REVOKE_SCOPE'))).toBe('AI_RELEASE_REVOKE_SCOPE');
 });
 it('bundles the existing verifier and compiled singleton without generating approvals',async()=>{
  const helpers=await loadAiControlHelpers();const compiled=helpers.getCompiledAiReleaseBuild();expect(compiled.trusted_generator_pins).toHaveLength(9);
  expect(()=>helpers.verifyAiReleaseConfiguration({},compiled)).toThrow();expect(()=>helpers.verifyAiReleaseConfiguration({},structuredClone(compiled))).toThrow('AI_RELEASE_UNTRUSTED_BUILD_EXPECTATION');
 });
 it('resolves symlinks, rejects checkout files, and requires ignored untracked private paths',()=>{
  const temp=mkdtempSync(path.join(tmpdir(),'tivdoc-private-unit-ai-control-'));
  try{
   const repo=path.join(temp,'repo'),privateDir=path.join(temp,'private');mkdirSync(repo);mkdirSync(privateDir);
   execFileSync('git',['init','--quiet',temp]);writeFileSync(path.join(temp,'.git','info','exclude'),'/private/\n/link/\n');
   const file=path.join(privateDir,'configuration.json');writeFileSync(file,'{}');expect(aiControlPrivatePath(file,repo)).toBe(file);
   writeFileSync(path.join(repo,'inside.json'),'{}');expect(()=>aiControlPrivatePath(path.join(repo,'inside.json'),repo)).toThrow('AI_CONTROL_PRIVATE_PATH_IN_CHECKOUT');
   const unignored=path.join(temp,'public.json');writeFileSync(unignored,'{}');expect(()=>aiControlPrivatePath(unignored,repo)).toThrow('AI_CONTROL_PRIVATE_PATH_NOT_IGNORED');
   symlinkSync(repo,path.join(temp,'link'),process.platform==='win32'?'junction':'dir');expect(()=>aiControlPrivatePath(path.join(temp,'link','inside.json'),repo)).toThrow('AI_CONTROL_PRIVATE_PATH_IN_CHECKOUT');
   execFileSync('git',['-C',temp,'add','-f','--','private/configuration.json']);expect(()=>aiControlPrivatePath(file,repo)).toThrow('AI_CONTROL_PRIVATE_PATH_NOT_IGNORED');
  }finally{
   const resolved=path.resolve(temp);if(path.dirname(resolved)!==path.resolve(tmpdir())||!path.basename(resolved).startsWith('tivdoc-private-unit-ai-control-'))throw Error('UNSAFE_TEST_CLEANUP');
   rmSync(resolved,{recursive:true,force:true});
  }
 });
});
