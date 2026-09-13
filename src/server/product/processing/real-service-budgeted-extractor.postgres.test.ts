import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
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

/** SQL216 companion to the existing actual-LOGIN refusal harness. Synthetic
 * selectors/notice terms are never registered as permission. No configuration,
 * decision, source, identity session, paid order, parent, child or outbox seed.
 * This deliberately cannot stand in for positive REAL service acceptance. */
it.skipIf(process.env.TIVDOC_REAL_NOTIFICATION_DB_REFUSAL_PROOF!=='1')('preserves actual-role notification policy registration and preparation refusal boundaries',async()=>{
 if(process.env.NODE_ENV!=='test'||process.env.VERCEL||process.env.VERCEL_ENV)throw Error('REAL_NOTIFICATION_DB_PROOF_BOUNDARY');
 const env=new Map(readFileSync('../release-work/replay.env','utf8').split(/\r?\n/).filter(line=>line&&!line.startsWith('#')&&line.includes('='))
  .map(line=>[line.slice(0,line.indexOf('=')),line.slice(line.indexOf('=')+1)] as const));
 const target={host:'aws-0-eu-central-1.pooler.supabase.com',database:'tivdoc_release_replay_20260907',project:'cpzrbidxftzqcfeqqusu'};
 const entries=[['owner','TIVDOC_DEV_DATABASE_URL','tivdoc_dev_migrator'],['worker','TIVDOC_WORKER_POSTGRES_URL','tivdoc_worker_runtime'],
  ['identity','TIVDOC_IDENTITY_POSTGRES_URL','tivdoc_identity_runtime'],['web','TIVDOC_WEB_POSTGRES_URL','tivdoc_web_runtime'],
  ['operations','TIVDOC_OPERATIONS_POSTGRES_URL','tivdoc_operations_runtime']] as const;
 const runtimeRoles=['worker','identity','web','operations'] as const,clients=new Map<string,pg.Client>();
 const checks:{name:string;role:string;sqlstate?:string;exactRefusal?:string}[]=[],cleanup:string[]=[],missingRoles:string[]=[],names=new Map<string,string>();
 const digest=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
 const git=(...args:string[])=>execFileSync('git',args,{encoding:'utf8',windowsHide:true}).trim();
 const runId=randomUUID(),head=git('rev-parse','HEAD'),dirty=git('status','--porcelain','--untracked-files=all').length>0;
 const testedPaths=['src/server/product/processing/real-service-budgeted-extractor.postgres.test.ts',
  'src/server/product/processing/real-service-notification-policy.ts','src/server/product/processing/real-service-notification-policy-registration.ts',
  'src/server/product/reports/real-ai-service-notification.ts','src/server/platform/persistence/postgres/runtime/node-pg-driver.ts'];
 const testedSources=testedPaths.map(file=>({path:file,sha256:digest(readFileSync(file,'utf8').replaceAll('\r\n','\n'))}));
 const signatures=[
  'private.real_ai_service_notification_policy_register(jsonb,text)',
  'private.real_ai_service_notification_policy_parent_check(uuid,uuid,text,boolean)',
  'private.real_ai_service_notification_policy_parent_prepare(uuid,uuid,uuid)',
  'private.real_ai_service_notification_parent_material(uuid,uuid,text,text)',
  'private.real_ai_service_notification_manual_parent_material_v1(uuid,uuid,text,text)',
  'private.real_ai_service_notification_prepare(uuid,uuid,uuid)',
 ];
 const caseId=randomUUID(),identityId=randomUUID(),reportId=randomUUID(),unknown=digest(`synthetic216:${runId}`);
 const now=Date.now(),body={schema_version:'tivdoc-real-service-notification-policy-v1',policy_id:randomUUID(),revision:1,state:'active',namespace:'real',
  purpose:'real_service_report_notifications',plan_sha256:unknown,service_decision_sha256:digest(`synthetic216:decision:${runId}`),
  template:'real-ai-report-ready-v1',origin:'https://synthetic.example.org',
  purchase_terms:[{version:'synthetic-notice216-v1',evidence_sha256:digest(`synthetic216:terms:${runId}`)}],
  evidence_sha256:digest(`synthetic216:policy:${runId}`),issued_at:new Date(now-1000).toISOString(),expires_at:new Date(now+60000).toISOString(),predecessor_policy_sha256:null};
 const candidate={...body,sha256:canonicalSha256(body)};
 let before:unknown=null,after:unknown=null,passed=false,stage='connect',primaryFailure:{name:string;code:string|null;sqlstate:string|null}|null=null;
 let definitions:unknown[]=[];
 const acl:unknown[]=[];
 const sanitized=(error:unknown)=>({name:error instanceof Error?error.name:'unknown',
  code:error instanceof Error&&/^[A-Z][A-Z0-9_]+$/u.test(error.message)?error.message:null,
  sqlstate:error!==null&&typeof error==='object'&&'sqlstate'in error&&typeof error.sqlstate==='string'&&/^[A-Z0-9]{5}$/u.test(error.sqlstate)?error.sqlstate
   :error!==null&&typeof error==='object'&&'code'in error&&typeof error.code==='string'&&/^[A-Z0-9]{5}$/u.test(error.code)?error.code:null});
 const counts=async()=>{
  const result=await clients.get('owner')!.query(`select
   (select count(*)::integer from private.real_ai_service_notification_policies) notification_policies,
   (select count(*)::integer from private.real_ai_service_notification_authorizations) notification_parents,
   (select count(*)::integer from private.real_ai_service_notification_grants) notification_grants,
   (select count(*)::integer from private.real_ai_service_notification_bindings) notification_bindings,
   (select count(*)::integer from private.case_notification_outbox) notification_outbox,
   (select count(*)::integer from private.real_ai_service_report_publications) publications,
   (select count(*)::integer from private.ai_release_configurations) configurations,
   (select count(*)::integer from private.real_ai_service_decisions) decisions,
   (select count(*)::integer from private.real_service_activation_plans) plans,
   (select count(*)::integer from private.real_ai_service_enrollment_events) real_enrollments,
   (select count(*)::integer from private.real_service_machine_events) machine_events,
   (select count(*)::integer from public.product_identity_sessions) identity_sessions,
   (select count(*)::integer from private.product_orders) orders,
   (select count(*)::integer from public.payments) payments,
   (select count(*)::integer from private.case_input_versions) source_versions`);
  return result.rows[0];
 };
 async function denied(role:string,name:string,text:string,values:PostgresParameter[],expected:{sqlstate:string;domain?:string}){
  const db=clients.get(role);if(!db)throw Error('REAL_NOTIFICATION_REQUIRED_LOGIN_ABSENT');
  if(names.has(name))expect(names.get(name)).toBe(text);else names.set(name,text);
  let matched=false,failed=false;
  const managed=new NodePostgresManagedClient({async query(q){try{return await db.query({name:q.name,text:q.text,values:[...q.values]});}
   catch(error){const e=sanitized(error);matched=e.sqlstate===expected.sqlstate&&(!expected.domain||e.code===expected.domain);throw error;}},release(){}},{query(){},release(){}});
  await db.query('begin');
  try{
   await db.query("set local lock_timeout='3s'");
   await expect(managed.query(statement(name,text,values))).rejects.toMatchObject({code:'POSTGRES_STATEMENT_FAILED',sqlstate:expected.sqlstate});
   expect(matched).toBe(true);checks.push({name,role,sqlstate:expected.sqlstate,...(expected.domain?{exactRefusal:expected.domain}:{})});
  }catch(error){failed=true;throw error;}
  finally{
   try{await db.query('rollback');}catch(error){cleanup.push(`${role}:${name}:rollback`);if(!failed)throw error;}
   finally{managed.release();}
  }
 }
 try{
  for(const [label,key,principal]of entries){
   const value=env.get(key);if(!value){missingRoles.push(label);continue;}const url=new URL(value);
   if(url.hostname!==target.host||url.pathname!==`/${target.database}`||decodeURIComponent(url.username)!==`${principal}.${target.project}`)
    throw Error('REAL_NOTIFICATION_EXACT_DEV_REQUIRED');
   url.search='';const db=new pg.Client({connectionString:url.href,ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:15000});
   clients.set(label,db);await db.connect();
   expect((await db.query('select session_user::text principal,current_database() database')).rows[0]).toEqual({principal,database:target.database});
   checks.push({name:'actual_login',role:label});
  }
  if(missingRoles.length)throw Error('REAL_NOTIFICATION_REQUIRED_LOGIN_ABSENT');
  const owner=clients.get('owner')!;stage='schema_and_acl';
  for(const signature of signatures)expect((await owner.query('select to_regprocedure($1)::text name',[signature])).rows[0].name).not.toBeNull();
  definitions=(await owner.query(`select p.oid::regprocedure::text signature,
   encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex') definition_sha256,p.prosecdef security_definer,
   exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute
   from pg_proc p where p.oid=any(select to_regprocedure(x) from unnest($1::text[]) x) order by 1`,[signatures])).rows;
  expect(definitions).toHaveLength(signatures.length);
  expect(definitions.every(row=>z.object({public_execute:z.literal(false)}).safeParse(row).success)).toBe(true);
  checks.push({name:'public_execute_catalog_denied',role:'PUBLIC (ACL; not a LOGIN)'});
  for(const [, ,principal]of entries){
   const rows=(await owner.query('select signature,has_function_privilege($1,signature,\'EXECUTE\') allowed from unnest($2::text[]) signature',[principal,signatures])).rows;
   for(const row of rows)expect(row.allowed).toBe(principal==='tivdoc_dev_migrator'||principal==='tivdoc_worker_runtime'&&row.signature==='private.real_ai_service_notification_prepare(uuid,uuid,uuid)');
   acl.push({principal,functions:rows});
  }
  before=await counts();
  expect((await owner.query('select exists(select 1 from private.real_service_activation_plans where payload_sha256=$1) plan_exists,exists(select 1 from public.cases where id=$2) case_exists',[unknown,caseId])).rows[0])
   .toEqual({plan_exists:false,case_exists:false});
  stage='registration_refusals';
  const register='select private.real_ai_service_notification_policy_register($1::jsonb,$2::text)';
  for(const role of runtimeRoles)await denied(role,'notification216_register',register,[JSON.stringify(candidate),null],{sqlstate:'42501'});
  await denied('owner','notification216_register',register,[JSON.stringify(candidate),null],{sqlstate:'P0001',domain:'REAL_NOTIFICATION_POLICY_PLAN'});
  await denied('owner','notification216_register',register,[JSON.stringify(candidate),unknown],{sqlstate:'P0001',domain:'REAL_NOTIFICATION_POLICY_PREDECESSOR'});
  const extra={...body,invented_consent:true};
  await denied('owner','notification216_register',register,[JSON.stringify({...extra,sha256:canonicalSha256(extra)}),null],{sqlstate:'P0001',domain:'REAL_NOTIFICATION_POLICY_INVALID'});
  await denied('owner','notification216_register',register,[JSON.stringify({...candidate,sha256:unknown}),null],{sqlstate:'P0001',domain:'REAL_NOTIFICATION_POLICY_INVALID'});
  stage='prepare_and_private_helper_refusals';
  await denied('worker','notification216_prepare','select private.real_ai_service_notification_prepare($1::uuid,$2::uuid,$3::uuid)',[caseId,identityId,reportId],
   {sqlstate:'P0001',domain:'REAL_SERVICE_WORKER_FORBIDDEN'});
  for(const role of ['identity','web','operations'])await denied(role,'notification216_prepare','select private.real_ai_service_notification_prepare($1::uuid,$2::uuid,$3::uuid)',[caseId,identityId,reportId],{sqlstate:'42501'});
  const privateCalls=[
   ['notification216_parent_check','select private.real_ai_service_notification_policy_parent_check($1::uuid,$2::uuid,$3,$4::boolean)',[caseId,identityId,unknown,true]],
   ['notification216_parent_prepare','select private.real_ai_service_notification_policy_parent_prepare($1::uuid,$2::uuid,$3::uuid)',[caseId,identityId,reportId]],
   ['notification216_parent_material','select private.real_ai_service_notification_parent_material($1::uuid,$2::uuid,$3,$4)',[caseId,identityId,unknown,null]],
   ['notification216_manual_material','select private.real_ai_service_notification_manual_parent_material_v1($1::uuid,$2::uuid,$3,$4)',[caseId,identityId,unknown,null]],
   ['notification216_policy_table','select payload from private.real_ai_service_notification_policies limit 1',[]],
  ] as const;
  for(const [name,text,values]of privateCalls)for(const role of runtimeRoles)await denied(role,name,text,[...values],{sqlstate:'42501'});
  stage='no_authorization_writes';after=await counts();expect(after).toEqual(before);
  checks.push({name:'authority_outbox_payment_and_source_counts_unchanged',role:'owner'});passed=true;
 }catch(error){primaryFailure=sanitized(error);throw error;}
 finally{
  for(const [label,db]of clients){try{await db.query('rollback');}catch{cleanup.push(`${label}:rollback`);}try{await db.end();}catch{cleanup.push(`${label}:close`);}}
  const directory='../release-work/real-service-admission';mkdirSync(directory,{recursive:true});
  const receipt={schema_version:'real-notification-policy-sql-refusal-proof-v1',run_id:runId,checked_at:new Date().toISOString(),tested_head:head,
   working_tree_dirty:dirty,tested_utf8_lf_sources:testedSources,database:target.database,stage,
   result:missingRoles.length?'blocked':passed&&!cleanup.length?'passed':'failed',primary_failure:primaryFailure,cleanup_failures:cleanup,missing_roles:missingRoles,
   classification:'isolated synthetic actual-LOGIN refusal/integrity proof only; no REAL activation, paid purchase, consent or notification acceptance',
   synthetic_terms_version:body.purchase_terms[0].version,synthetic_candidate_sha256:candidate.sha256,sql_definitions:definitions,acl,checks,
   named_statements:[...names].map(([name,text])=>({name,text_sha256:digest(text)})),baseline:before,after,
   positive_parent_derivation:'unproven: no legitimate reusable REAL configuration/decision/paid-report fixture',
   manual_child_retry_and_expiry:'unproven in PostgreSQL by this refusal harness',
   queued_revocation_contact_and_policy_successor:'unproven in PostgreSQL by this refusal harness',
   provider_calls:0,messages_sent:0,authority_writes:0,source_writes:0,policy_or_terms_approval:false};
  writeFileSync(`${directory}/216-refusal-${runId}.private.json`,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
 }
 expect(cleanup).toEqual([]);
},120000);
