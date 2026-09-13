import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {z} from 'zod';
import {NodePostgresManagedClient} from '@/server/platform/persistence/postgres/runtime/node-pg-driver';
import {statement,type PostgresParameter} from '@/server/platform/persistence/postgres/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
vi.mock('server-only',()=>({}));

/** Opt-in ACTUAL login/SQL refusal proof only. It creates no authority/session,
 * payment, candidate, claim or source. Honest synthetic acquisition cannot pass
 * 198 REAL registration; this test explicitly preserves that integrity guard.
 * Positive budget/lease/concurrency tests remain separate and UNPROVEN here.
 * Root owns migration installation and explicit execution of this harness. */
it.skipIf(process.env.TIVDOC_REAL_PROVIDER_DB_REFUSAL_PROOF!=='1')('preserves honest acquisition and actual-role provider admission guards',async()=>{
 if(process.env.NODE_ENV!=='test'||process.env.VERCEL||process.env.VERCEL_ENV)throw Error('REAL_PROVIDER_DB_PROOF_BOUNDARY');
 // Match the existing private proof connector's ONE known credential file.
 // No environment search, provisioning or fallback to another database/role.
 const env=new Map(readFileSync('../release-work/replay.env','utf8').split(/\r?\n/).filter(line=>line&&!line.startsWith('#')&&line.includes('='))
  .map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)] as const));
 const target={host:'aws-0-eu-central-1.pooler.supabase.com',database:'tivdoc_release_replay_20260907',project:'cpzrbidxftzqcfeqqusu'};
 const entries=[['owner','TIVDOC_DEV_DATABASE_URL','tivdoc_dev_migrator'],['worker','TIVDOC_WORKER_POSTGRES_URL','tivdoc_worker_runtime'],
  ['identity','TIVDOC_IDENTITY_POSTGRES_URL','tivdoc_identity_runtime'],['web','TIVDOC_WEB_POSTGRES_URL','tivdoc_web_runtime'],
  ['operations','TIVDOC_OPERATIONS_POSTGRES_URL','tivdoc_operations_runtime']] as const;
 const clients=new Map<string,pg.Client>(),checks:{name:string;role:string;sqlstate?:string;exactRefusal?:string}[]=[],statements=new Set<string>(),cleanup:string[]=[],
  blockedRoles:{role:string;reason:'credential_absent'}[]=[],blockedChecks:{name:string;role:string}[]=[];
 const runId=randomUUID(),build=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
 const fixtureBytes=readFileSync('../release-work/real-service-admission/208-honest-refusal-fixtures.private.json');
 const fixture=z.object({schema_version:z.literal('real-provider-sql-refusal-fixtures-v1'),classification:z.string(),database:z.literal('tivdoc_release_replay_20260907'),
  configuration_candidates:z.array(z.object({label:z.string(),candidate:z.record(z.string(),z.unknown())}).strict()).length(2),positive_admission:z.string(),concurrency:z.string()}).strict().parse(JSON.parse(fixtureBytes.toString('utf8')));
 let passed=false,before:unknown=null,after:unknown=null;
 const signatures=['private.real_service_provider_context(uuid,text)','private.real_service_provider_request_reserve(uuid,uuid,text,text,text,text,integer,text)',
  'private.real_service_provider_receipt_record(uuid,jsonb)','private.real_service_candidates(text,text,text,jsonb,integer)',
  'private.real_service_claim_admit(jsonb,text,bigint,text,text,text,text)','private.real_service_machine_manage(text,uuid,uuid,text,uuid,uuid,text,text,bigint)'];
 const counts=async()=>{
  const r=await clients.get('owner')!.query(`select
   (select count(*)::integer from private.ai_release_configurations) configurations,
   (select count(*)::integer from private.real_service_activation_plans) plans,
   (select count(*)::integer from private.real_ai_service_enrollment_events) real_enrollments,
   (select count(*)::integer from private.real_service_machine_events) machine_events,
   (select count(*)::integer from public.product_identity_sessions) identity_sessions,
   (select count(*)::integer from private.real_service_budget_ledgers) budget_ledgers,
   (select count(*)::integer from private.real_service_claim_reservations) claims,
   (select count(*)::integer from private.real_service_provider_requests) provider_requests,
   (select count(*)::integer from private.real_service_provider_request_receipts) provider_receipts`);return r.rows[0];
 };
 async function denied(role:string,name:string,text:string,values:PostgresParameter[],expected:{sqlstate:string;domain?:string}){
  const db=clients.get(role);if(!db){blockedChecks.push({name,role});return;}let rawMatched=false;
  const managed=new NodePostgresManagedClient({async query(q){try{return await db.query({name:q.name,text:q.text,values:[...q.values]});}
   catch(error){const e=error as {code?:string;message?:string};rawMatched=e.code===expected.sqlstate&&(!expected.domain||e.message===expected.domain);throw error;}},release(){}},{query(){},release(){}});
  await db.query('begin');try{
   await db.query("set local lock_timeout='3s'");statements.add(name);
   await expect(managed.query(statement(name,text,values))).rejects.toMatchObject({code:'POSTGRES_STATEMENT_FAILED',sqlstate:expected.sqlstate});
   expect(rawMatched).toBe(true);checks.push({name,role,sqlstate:expected.sqlstate,...(expected.domain?{exactRefusal:expected.domain}:{})});
  }finally{await db.query('rollback');managed.release();}
 }
 try{
  for(const [label,key,role] of entries){
   const raw=env.get(key);if(!raw){blockedRoles.push({role:label,reason:'credential_absent'});continue;}const u=new URL(raw);
   if(u.hostname!==target.host||u.pathname!==`/${target.database}`||decodeURIComponent(u.username)!==`${role}.${target.project}`)throw Error('REAL_PROVIDER_EXACT_DEV_REQUIRED');
   u.search='';const db=new pg.Client({connectionString:u.href,ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:15000});
   clients.set(label,db);await db.connect();
   const principal=(await db.query('select session_user::text principal,current_database() database')).rows[0];expect(principal).toEqual({principal:role,database:target.database});checks.push({name:'actual_login',role});
  }
  const owner=clients.get('owner');if(!owner){blockedChecks.push({name:'schema_acl_integrity_and_baseline',role:'owner'});return;}
  for(const signature of signatures){const found=(await owner.query('select to_regprocedure($1)::text name',[signature])).rows[0].name;
   if(!found)throw Error('REAL_PROVIDER_PROOF_MIGRATION_REQUIRED');}
  before=await counts();
  const publicAcl=(await owner.query(`select p.oid::regprocedure::text signature,exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute
   from pg_proc p where p.oid=any(select to_regprocedure(x) from unnest($1::text[]) x)`,[signatures])).rows;
  expect(publicAcl).toHaveLength(signatures.length);expect(publicAcl.every(r=>r.public_execute===false)).toBe(true);checks.push({name:'public_execute_catalog_denied',role:'PUBLIC (ACL; not a LOGIN)'});
  for(const f of fixture.configuration_candidates)await denied('owner','real_provider_configuration_refusal','select private.real_ai_service_configuration_register($1::jsonb)',[JSON.stringify(f.candidate)],{sqlstate:'P0001',domain:'REAL_SERVICE_CONFIGURATION_SCOPE'});
  const unknown=sha('9'),caseId=randomUUID(),versionId=randomUUID(),reservationId=randomUUID(),plan=sha('8');
  expect((await owner.query('select exists(select 1 from private.real_ai_service_evidence_artifacts where sha256=$1) found',[unknown])).rows[0].found).toBe(false);
  await denied('owner','real_provider_missing_policy','select private.real_service_provider_policy($1)',[unknown],{sqlstate:'P0001',domain:'REAL_SERVICE_BUDGET_EVIDENCE_REQUIRED'});
  const calls=[['real_provider_context_refusal','select private.real_service_provider_context($1::uuid,$2)',[reservationId,build]],
   ['real_provider_reserve_refusal','select private.real_service_provider_request_reserve($1::uuid,$2::uuid,$3,$4,$5,$6,$7::integer,$8)',[reservationId,versionId,unknown,sha('7'),'input_tokens','gpt-5.6-sol',10000,build]],
   ['real_provider_receipt_refusal','select private.real_service_provider_receipt_record($1::uuid,$2::jsonb)',[randomUUID(),'{}']]] as const;
  for(const [name,text,values] of calls){
   await denied('worker',name,text,[...values],{sqlstate:'P0001',domain:'REAL_SERVICE_PROVIDER_CLAIM_SCOPE'});
   for(const role of ['identity','web','operations'])await denied(role,name,text,[...values],{sqlstate:'42501'});
  }
  const candidateTarget={database_name:target.database,target_id:'synthetic-proof-target',environment:'test',deployment_sha256:sha('5'),
   machine_issuer_sha256:sha('4'),provider_budget_policy_sha256:unknown};
  await denied('worker','real_provider_candidates_refusal','select private.real_service_candidates($1,$2,$3,$4::jsonb,$5::integer)',
   ['synthetic-unregistered-controller-capability-208',plan,build,JSON.stringify(candidateTarget),1],{sqlstate:'P0001',domain:'REAL_ACTIVATION_CONTROLLER_FORBIDDEN'});
  const candidate={case_id:caseId,identity_id:randomUUID(),enrollment_id:randomUUID(),source_revision:1,source_sha256:unknown,authority_dependency_sha256:sha('6'),plan_sha256:plan,expires_at:new Date(Date.now()+60000).toISOString()};
  await denied('worker','real_provider_claim_refusal','select private.real_service_claim_admit($1::jsonb,$2,$3::bigint,$4,$5,$6,$7)',
   [JSON.stringify(candidate),'synthetic-absent-job',1,'synthetic-uninstalled-worker',unknown,'budgeted_provider',build],{sqlstate:'P0001',domain:'REAL_SERVICE_WORKER_FORBIDDEN'});
  await denied('identity','real_provider_issuer_refusal','select private.real_service_machine_manage($1,$2::uuid,$3::uuid,$4,$5::uuid,$6::uuid,$7,$8,$9::bigint)',
   ['synthetic-unregistered-issuer-capability-208',caseId,candidate.identity_id,plan,candidate.enrollment_id,randomUUID(),'read',null,null],{sqlstate:'P0001',domain:'REAL_MACHINE_ISSUER_FORBIDDEN'});
  after=await counts();expect(after).toEqual(before);passed=true;
 }finally{
  for(const [label,db] of clients){try{await db.query('rollback');}catch{cleanup.push(`${label}:rollback`);}try{await db.end();}catch{cleanup.push(`${label}:close`);}}
  const directory='../release-work/real-service-admission';mkdirSync(directory,{recursive:true});
  const receipt={schema_version:'real-provider-sql-refusal-proof-v1',run_id:runId,tested_head:build,database:target.database,classification:'isolated synthetic denial/integrity proof; no REAL activation approval',
   fixture_sha256:createHash('sha256').update(fixtureBytes).digest('hex'),result:cleanup.length||!passed&&clients.has('owner')?'failed':blockedRoles.length?'blocked':passed?'passed':'failed',checks,blocked_roles:blockedRoles,blocked_checks:blockedChecks,statement_names:[...statements].sort(),baseline:before,after,
   positive_admission:'unproven: honest synthetic acquisition rejected by198',concurrency:'unproven: no authorized REAL claim fixture',provider_calls:0,authority_writes:0,cleanup_failures:cleanup};
  writeFileSync(`${directory}/208-refusal-${runId}.private.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 }
 expect(cleanup).toEqual([]);
},120000);
function sha(c:string){return c.repeat(64);}
