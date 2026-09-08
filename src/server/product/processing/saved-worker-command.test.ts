import {describe,it,expect,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {savedWorkerCommandConfig,runSavedWorkerCommand} from './saved-worker-command';
vi.mock('server-only',()=>({}));
function environment(){
 const caseId=randomUUID();return {TIVDOC_SAVED_DRAFT_WORKER_ENABLED:'true',TIVDOC_SAVED_WORKER_REPLAY_ONLY:'true',
  TIVDOC_SAVED_WORKER_CASE_ID:caseId,TIVDOC_SAVED_WORKER_IDENTITY:JSON.stringify({session_id:'machine:synthetic',token_id:'token:synthetic',tenant_id:`saved-case:${caseId}`,actor_id:'worker:synthetic',reviewer_organization_id:null,rotation_counter:0}),
  TIVDOC_SAVED_WORKER_DEV_TARGET:JSON.stringify({host:'db.example',port:5432,database:'tivdoc_release_replay_20260907',project_ref:'synthetic'}),
  TIVDOC_WORKER_POSTGRES_URL:'postgresql://tivdoc_worker_runtime.synthetic:private@db.example:5432/tivdoc_release_replay_20260907'};
}
describe('saved worker command boundaries',()=>{
 it('disabled is effect-free with no credentials or build identity',async()=>expect(await runSavedWorkerCommand({},'')).toEqual({worker:'saved_draft',state:'disabled'}));
 it('allows replay configuration without Storage or a provider',()=>expect(savedWorkerCommandConfig(environment(),'a'.repeat(40))).toMatchObject({enabled:true,replayOnly:true}));
 it.each(['NODE_ENV','VERCEL_ENV'])('refuses hosted activation through %s',name=>{
  for(const value of ['production',' Preview '])expect(()=>savedWorkerCommandConfig({...environment(),[name]:value},'a'.repeat(40))).toThrow('SAVED_HOST_CONFIGURATION_INVALID');
 });
 it.each(['TIVDOC_SAVED_WORKER_CASE_ID','TIVDOC_SAVED_WORKER_IDENTITY','TIVDOC_SAVED_WORKER_DEV_TARGET','TIVDOC_WORKER_POSTGRES_URL'])('refuses malformed %s without returning its value',name=>{
  expect(()=>savedWorkerCommandConfig({...environment(),[name]:'PRIVATE_INVALID_VALUE'},'a'.repeat(40))).toThrow(/^SAVED_HOST_CONFIGURATION_INVALID$/);
 });
 it('refuses a case/session mismatch and privileged DB login',()=>{
  const env=environment();expect(()=>savedWorkerCommandConfig({...env,TIVDOC_SAVED_WORKER_CASE_ID:randomUUID()},'a'.repeat(40))).toThrow('SAVED_HOST_CONFIGURATION_INVALID');
  expect(()=>savedWorkerCommandConfig({...env,TIVDOC_WORKER_POSTGRES_URL:env.TIVDOC_WORKER_POSTGRES_URL.replace('tivdoc_worker_runtime','postgres')},'a'.repeat(40))).toThrow('SAVED_HOST_CONFIGURATION_INVALID');
 });
 it('cannot activate provider work with the replay flag removed',()=>{
  expect(()=>savedWorkerCommandConfig({...environment(),TIVDOC_SAVED_WORKER_REPLAY_ONLY:'false'},'a'.repeat(40))).toThrow('SAVED_HOST_CONFIGURATION_INVALID');
 });
 it('pins Storage and the existing model policy before any connection',()=>{
  const env={...environment(),TIVDOC_SAVED_WORKER_REPLAY_ONLY:'false',TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED:'true',OPENAI_API_KEY:'synthetic-no-network',NEXT_PUBLIC_SUPABASE_URL:'https://synthetic.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-no-network'};
  expect(savedWorkerCommandConfig(env,'a'.repeat(40))).toMatchObject({enabled:true,replayOnly:false});
  for(const change of [{NEXT_PUBLIC_SUPABASE_URL:'https://other.supabase.co'},{OPENAI_EXTRACTION_MODEL:'unversioned-model-change'},{TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED:'false'}])expect(()=>savedWorkerCommandConfig({...env,...change},'a'.repeat(40))).toThrow('SAVED_HOST_CONFIGURATION_INVALID');
 });
 it('builds a real Node bundle; default invocation and both hosted environments remain closed',()=>{
  const env={PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,NODE_ENV:'test' as const};
  const build=spawnSync(process.execPath,['scripts/product-workers/build-saved-draft.mjs'],{encoding:'utf8',env,windowsHide:true});expect(build.status,build.stderr).toBe(0);
  const file='output/release-completion/saved-worker/worker.cjs',manifest=JSON.parse(readFileSync('output/release-completion/saved-worker/manifest.json','utf8'));
  expect(createHash('sha256').update(readFileSync(file)).digest('hex')).toBe(manifest.bundleSha256);expect(Object.keys(manifest.sourceHashes)).toContain('src/server/product/processing/saved-worker-host.ts');
  const disabled=spawnSync(process.execPath,[file],{encoding:'utf8',env,windowsHide:true});expect(disabled.status,disabled.stderr).toBe(0);expect(JSON.parse(disabled.stdout).state).toBe('disabled');
  for(const VERCEL_ENV of ['production','preview'])for(const entry of [file,'scripts/product-workers/saved-draft.mts','scripts/product-workers/build-saved-draft.mjs']){
   const result=spawnSync(process.execPath,['--experimental-strip-types',entry],{encoding:'utf8',env:{...env,VERCEL_ENV},windowsHide:true});expect(result.status,result.stderr).toBe(2);expect(result.stderr).toContain('PRODUCTION_ENVIRONMENT_REFUSED');
  }
  const invalid=spawnSync(process.execPath,[file],{encoding:'utf8',env:{...env,TIVDOC_SAVED_DRAFT_WORKER_ENABLED:'true'},windowsHide:true});expect(invalid.status).toBe(1);expect(JSON.parse(invalid.stderr).code).toBe(manifest.dirty?'SAVED_WORKER_CLEAN_BUILD_REQUIRED':'SAVED_HOST_CONFIGURATION_INVALID');
 },30000);
});
