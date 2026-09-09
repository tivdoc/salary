import {describe,it,expect,vi} from 'vitest';
import {managedWorkerConfig,managedWorkerControlConfig} from './managed-worker-config';
vi.mock('server-only',()=>({}));
function environment():Record<string,string|undefined>{return {
 NODE_ENV:'development',TIVDOC_MANAGED_DEV_WORKER_ENABLED:'true',TIVDOC_MANAGED_DEV_BUILD_SHA:'a'.repeat(40),TIVDOC_MANAGED_DEV_WORKER_CAPABILITY:'synthetic_capability_'.repeat(3),
 TIVDOC_WORKER_POSTGRES_URL:'postgresql://tivdoc_worker_runtime.cpzrbidxftzqcfeqqusu:synthetic-password@aws-0-eu-central-1.pooler.supabase.com:5432/tivdoc_release_replay_20260907?sslmode=verify-full',
 NEXT_PUBLIC_SUPABASE_URL:'https://cpzrbidxftzqcfeqqusu.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'synthetic-storage',OPENAI_API_KEY:'synthetic-key',TIVDOC_SAVED_EXTRACTION_PROVIDER_ENABLED:'true',
};}
describe('managed DEV host configuration',()=>{
 it('disabled configuration is effect-free without requiring credentials',()=>expect(managedWorkerConfig({})).toEqual({enabled:false}));
 it('accepts only the fixed worker DEV target and removes URL TLS overrides',()=>{
  const result=managedWorkerConfig(environment());expect(result.enabled).toBe(true);if(!result.enabled)throw Error();
  expect(result.connectionUrl).not.toContain('?');expect(result.target.database).toBe('tivdoc_release_replay_20260907');
 });
 it('permits the exact branch Preview production build but refuses Production deployment',()=>{
  const env={...environment(),NODE_ENV:'production',VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'codex/tivdoc-release-completion',VERCEL_GIT_COMMIT_SHA:'a'.repeat(40)};
  expect(managedWorkerConfig(env).enabled).toBe(true);
  expect(()=>managedWorkerConfig({...env,VERCEL_ENV:'production'})).toThrow('MANAGED_DEV_CONFIGURATION_INVALID');
 });
 it.each(['branch','database','role','host','port','tls','storage','capability','build','local-production','timeout'])(
  'refuses %s configuration without echoing a credential',mutation=>{
   const env=environment();
   if(mutation==='branch')Object.assign(env,{VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'main'});
   if(mutation==='database')env.TIVDOC_WORKER_POSTGRES_URL=env.TIVDOC_WORKER_POSTGRES_URL!.replace('tivdoc_release_replay_20260907','postgres');
   if(mutation==='role')env.TIVDOC_WORKER_POSTGRES_URL=env.TIVDOC_WORKER_POSTGRES_URL!.replace('tivdoc_worker_runtime','postgres');
   if(mutation==='host')env.TIVDOC_WORKER_POSTGRES_URL=env.TIVDOC_WORKER_POSTGRES_URL!.replace('aws-0-eu-central-1.pooler.supabase.com','example.com');
   if(mutation==='port')env.TIVDOC_WORKER_POSTGRES_URL=env.TIVDOC_WORKER_POSTGRES_URL!.replace(':5432/',':6543/');
   if(mutation==='tls')env.TIVDOC_WORKER_POSTGRES_URL=env.TIVDOC_WORKER_POSTGRES_URL!.replace('verify-full','no-verify');
   if(mutation==='storage')env.NEXT_PUBLIC_SUPABASE_URL='https://other.supabase.co';
   if(mutation==='capability')env.TIVDOC_MANAGED_DEV_WORKER_CAPABILITY='short';
   if(mutation==='build')env.TIVDOC_MANAGED_DEV_BUILD_SHA='unknown';
   if(mutation==='local-production')env.NODE_ENV='production';
   if(mutation==='timeout')env.OPENAI_EXTRACTION_TIMEOUT_MS='300000';
   expect(()=>managedWorkerConfig(env)).toThrow('MANAGED_DEV_CONFIGURATION_INVALID');
  });
 it('keeps status/retry available when the provider is unconfigured',()=>{
  const env=environment();delete env.OPENAI_API_KEY;delete env.SUPABASE_SERVICE_ROLE_KEY;
  expect(managedWorkerControlConfig(env).enabled).toBe(true);
  expect(()=>managedWorkerConfig(env)).toThrow('MANAGED_DEV_PROVIDER_UNCONFIGURED');
 });
});
