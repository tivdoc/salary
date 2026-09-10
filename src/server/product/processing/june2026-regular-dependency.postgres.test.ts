import {expect,it,vi} from 'vitest';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import pg from 'pg';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
vi.mock('server-only',()=>({}));

/** Real DEV schema/ACL/lock proof. Every governance mutation is rolled back. */
it.skipIf(process.env.TIVDOC_JUNE_REGULAR_DEPENDENCY_DB!=='1')('keeps authority dependency owner controlled, idempotent and deadlock safe',async()=>{
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},statement_timeout:10000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),peer=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL');
 const source=JSON.parse(readFileSync('../release-work/june-regular-live-absent-hours.private.json','utf8'));
 const checks:string[]=[];let failure:unknown=null;
 try{
  await Promise.all([owner.connect(),peer.connect(),worker.connect()]);
  const rights=(await owner.query("select has_column_privilege('tivdoc_worker_runtime','private.case_analysis_dispatch','authority_dependency_sha256','UPDATE') authority_write,has_column_privilege('tivdoc_worker_runtime','private.case_analysis_dispatch','job_id','UPDATE') pointer_write,has_function_privilege('tivdoc_worker_runtime','private.june2026_regular_dependency_refresh(uuid)','EXECUTE') refresh")).rows[0];
  expect(rights).toEqual({authority_write:false,pointer_write:true,refresh:false});
  await expect(worker.query('update private.case_analysis_dispatch set authority_dependency_sha256=$2 where case_id=$1',[source.caseId,'a'.repeat(64)])).rejects.toMatchObject({code:'42501'});
  await expect(worker.query('select private.june2026_regular_dependency_refresh($1)',[source.caseId])).rejects.toMatchObject({code:'42501'});
  checks.push('actual_worker_cannot_mint_dependency_or_call_owner_refresh');
  const current=async()=> (await owner.query("select h.revision,h.input_sha256,d.authority_dependency_sha256,d.job_id,d.dispatched_at from private.case_input_heads h join private.case_analysis_dispatch d on d.case_id=h.case_id and d.revision=h.revision and d.mode='draft' where h.case_id=$1",[source.caseId])).rows[0];
  const baseline=await current();
  const assessment=(await owner.query('select id,registry_key from private.june2026_regular_assessments where case_id=$1 and input_revision=$2',[source.caseId,baseline.revision])).rows[0];
  const jobsBefore=(await owner.query('select job_id,payload,state,terminal_effect_sha256 from public.engine_durable_jobs where canonical_case_id=$1 order by job_id',[source.caseId])).rows;
  await owner.query('begin');try{
   await owner.query('update private.june2026_regular_assessments set revoked_at=clock_timestamp() where id=$1',[assessment.id]);
   const changed=await current();expect(changed.revision).toBe(baseline.revision);expect(changed.input_sha256).toBe(baseline.input_sha256);
   expect(changed.authority_dependency_sha256).not.toBe(baseline.authority_dependency_sha256);expect(changed.job_id).toBeNull();expect(changed.dispatched_at).toBeNull();
   await owner.query('select private.june2026_regular_dependency_refresh($1)',[source.caseId]);expect(await current()).toEqual(changed);
   expect((await owner.query('select job_id,payload,state,terminal_effect_sha256 from public.engine_durable_jobs where canonical_case_id=$1 order by job_id',[source.caseId])).rows).toEqual(jobsBefore);
   checks.push('authority_change_clears_only_current_pointer_and_is_idempotent','source_revision_hash_and_historical_jobs_unchanged');
  }finally{await owner.query('rollback');}
  expect(await current()).toEqual(baseline);
  const registry=(await owner.query('select * from private.june2026_authority_registries where registry_key=$1 order by revision desc limit 1',[assessment.registry_key])).rows[0];
  const append=()=>peer.query('insert into private.june2026_authority_registries(registry_key,revision,namespace,payload,payload_sha256) values($1,$2,$3,$4,$5)',[registry.registry_key,registry.revision+1,registry.namespace,registry.payload,registry.payload_sha256]);
  await owner.query('begin');await owner.query('select id from public.cases where id=$1 for update',[source.caseId]);
  await peer.query('begin');try{await expect(append()).rejects.toMatchObject({code:'55P03'});}finally{await peer.query('rollback');await owner.query('rollback');}
  await peer.query('begin');try{await append();const updated=(await peer.query("select authority_dependency_sha256,job_id from private.case_analysis_dispatch where case_id=$1 and revision=$2 and mode='draft'",[source.caseId,baseline.revision])).rows[0];expect(updated.authority_dependency_sha256).not.toBe(baseline.authority_dependency_sha256);expect(updated.job_id).toBeNull();}finally{await peer.query('rollback');}
  expect(await current()).toEqual(baseline);checks.push('registry_case_lock_inversion_fails_fast_55P03_and_admin_retry_succeeds','all_authority_and_pointer_probes_rolled_back');
 }catch(error){failure=error;throw error;}finally{
  await Promise.allSettled([owner.query('rollback'),peer.query('rollback')]);await Promise.allSettled([owner.end(),peer.end(),worker.end()]);
  const migration='20260910182000_regular_authority_worker_dependency.sql';
  writeFileSync('output/release-completion/june-regular/dependency-db-'+Date.now()+'.json',JSON.stringify({at:new Date().toISOString(),gitSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingTreeClean:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()==='',state:failure?'FAIL':'PASS',error:failure instanceof Error?failure.message:null,migration,migrationSha256:createHash('sha256').update(readFileSync('supabase/migrations/'+migration)).digest('hex'),checks,providerCalls:0,productionChanged:false},null,2)+'\n',{flag:'wx'});
 }
},60000);
