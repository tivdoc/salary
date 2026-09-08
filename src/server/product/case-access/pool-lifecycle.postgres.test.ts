import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';

it.skipIf(process.env.TIVDOC_POOL_DB_PROOF!=='1')('cold concurrent RPCs share a real TLS pool, drain idle TCP clients, then reconnect',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw new Error('POOL_DB_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');
 const env=readDevEnvFile(),url=new URL(env.get('TIVDOC_WEB_POSTGRES_URL')!);
 expect(url.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(url.port).toBe('5432');expect(url.pathname).toBe('/tivdoc_release_replay_20260907');expect(decodeURIComponent(url.username)).toBe('tivdoc_web_runtime.cpzrbidxftzqcfeqqusu');url.search='?sslmode=verify-full';
 vi.stubEnv('VERCEL_ENV','preview');vi.stubEnv('VERCEL_GIT_COMMIT_REF','codex/tivdoc-release-completion');vi.stubEnv('TIVDOC_PREVIEW_WEB_POSTGRES_URL',url.toString());vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL','https://cpzrbidxftzqcfeqqusu.supabase.co');
 const pools:pg.Pool[]=[],OriginalPool=pg.Pool,descriptor=Object.getOwnPropertyDescriptor(pg,'Pool')!;
 class ObservedPool extends OriginalPool {
  constructor(options:pg.PoolConfig){
   super({...options,application_name:`tivdoc_pool_proof_${randomUUID()}`});
   pools.push(this);
  }
 }
 Object.defineProperty(pg,'Pool',{...descriptor,value:ObservedPool});
 const checks:string[]=[];
 try{
  vi.resetModules();const {resolveCaseAccessDb}=await import('./db');
  const stores=await Promise.all(Array.from({length:8},()=>resolveCaseAccessDb()));expect(pools).toHaveLength(1);
  const caseId=randomUUID();const replies=await Promise.all(stores.map(s=>s!.rpc('case_documents_list',{target_case:caseId})));expect(replies).toEqual(Array.from({length:8},()=>[]));expect(pools[0].totalCount).toBeLessThanOrEqual(2);expect(pools[0].totalCount).toBeGreaterThan(0);checks.push('eight concurrent cold RPCs use one real verified-TLS web pool with at most two TCP clients');
  expect(pools[0].listenerCount('release')).toBeGreaterThan(0);await new Promise(resolve=>setTimeout(resolve,6000));expect(pools[0].totalCount).toBe(0);expect(pools[0].idleCount).toBe(0);expect(pools[0].waitingCount).toBe(0);checks.push('actual idle TCP clients drain without ending the reusable pool');
  expect(await (await resolveCaseAccessDb())!.rpc('case_documents_list',{target_case:caseId})).toEqual([]);expect(pools).toHaveLength(1);checks.push('the same pool reconnects for a fresh authorized RPC after idle release');
 }finally{
  await Promise.all(pools.map(p=>p.end()));Object.defineProperty(pg,'Pool',descriptor);vi.unstubAllEnvs();
  writeFileSync('docs/release-evidence/P01-product-pool-db.json',JSON.stringify({passed:checks.length===3,checks,poolsCreated:pools.length,remainingTcpClients:pools.reduce((n,p)=>n+p.totalCount,0),database:'tivdoc_release_replay_20260907',scope:'Read-only empty synthetic case UUID through actual server resolver/web-role RPC/TLS driver; constructor instrumentation counts actual pools. No case or identity created. Local idle drain, not proof of Vercel suspension.',productionChanged:false,secretsIncluded:false},null,2)+'\n');
 }
},30000);
