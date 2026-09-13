import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {createOpaqueToken,hashSession} from '../case-access/crypto';
import {postgresCaseAccessDb} from '../case-access/db';
import {customerSavedReleaseQuote} from './service';
vi.mock('server-only',()=>({}));

/** Actual LOGIN/TLS pool and production RPC/service adapters. This fixture
 * creates only two empty synthetic cases, identities and short-lived sessions.
 * It grants no REAL activation, price, analysis, payment or report authority. */
it.skipIf(process.env.TIVDOC_RELEASE_QUOTE_STATUS_DB_PROOF!=='1')('binds saved quote discovery to each presented session on a reused real web connection',async()=>{
 if(process.env.VERCEL||process.env.VERCEL_ENV||process.env.NODE_ENV!=='test')throw Error('RELEASE_QUOTE_STATUS_DB_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const options=(key:string,role:string)=>{
  const u=new URL(env.get(key)!);
  if(u.hostname!=='aws-0-eu-central-1.pooler.supabase.com'||u.pathname!=='/tivdoc_release_replay_20260907'
   ||decodeURIComponent(u.username)!==`${role}.cpzrbidxftzqcfeqqusu`)throw Error('EXACT_ISOLATED_DEV_REQUIRED');
  u.search='';return {connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000};
 };
 const owner=new pg.Client(options('TIVDOC_DEV_DATABASE_URL','tivdoc_dev_migrator'));
 const web=new pg.Pool({...options('TIVDOC_WEB_POSTGRES_URL','tivdoc_web_runtime'),max:1,min:0,idleTimeoutMillis:30000});
 const runId=randomUUID(),caseId=randomUUID(),qaCaseId=randomUUID(),ids=[caseId,qaCaseId],identities:string[]=[];
 const marker=`Synthetic quote status auth only ${runId}`,sessions={active:createOpaqueToken(),expired:createOpaqueToken(),revoked:createOpaqueToken(),foreign:createOpaqueToken()};
 const hashes=Object.values(sessions).map(hashSession),checks:string[]=[],cleanupFailures:string[]=[];
 const privateDirectory='../release-work/release-quote-status';mkdirSync(privateDirectory,{recursive:true});
 const receiptPath=`${privateDirectory}/${runId}.private.json`,head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
 const proposalPath='../release-work/real-service-admission/213-release-quote-preparation-status.private.sql';
 const proposalSha=createHash('sha256').update(readFileSync(proposalPath)).digest('hex');
 if(proposalSha!=='ff49fe18666d04bc25fddaadb70a8287d710143308f95e73eecffb2133740b41')throw Error('RELEASE_QUOTE_STATUS_PROPOSAL_CHANGED');
 let seeded=false,cleaned=false,revoked=false,passed=false,primary:unknown,backend:number|undefined;
 web.on('error',()=>cleanupFailures.push('web_pool_idle_failure'));
 const db=postgresCaseAccessDb(web);
 const lookup=(selectedCase=caseId,selectedIdentity=identities[0],token=sessions.active)=>customerSavedReleaseQuote({caseId:selectedCase,identityId:selectedIdentity,sessionToken:token},db);
 const empty={quote:null,order:null,availability:{state:'not_prepared',period:null}};
 const connectionScope=async()=>{
  const r=(await web.query("select current_database() database,session_user role,pg_backend_pid() pid,nullif(current_setting('tivdoc.real_service_case',true),'') case_scope,nullif(current_setting('tivdoc.real_service_session_hash',true),'') session_scope")).rows[0];
  expect(r).toMatchObject({database:'tivdoc_release_replay_20260907',role:'tivdoc_web_runtime',case_scope:null,session_scope:null});
  if(backend===undefined)backend=r.pid;else expect(r.pid).toBe(backend);
 };
 const untouched=async()=>{
  const result=(await owner.query(`select
   (select count(*)::int from private.product_orders where case_id=any($1::uuid[])) orders,
   (select count(*)::int from public.payments where case_id=any($1::uuid[])) payments,
   (select count(*)::int from private.order_price_quotes where case_id=any($1::uuid[])) quotes,
   (select count(*)::int from private.real_ai_service_enrollment_events where case_id=any($1::uuid[])) real_enrollments,
   (select count(*)::int from private.ai_release_enrollment_events where case_id=any($1::uuid[])) qa_enrollments,
   (select count(*)::int from private.real_ai_service_report_publications where case_id=any($1::uuid[])) publications,
   (select count(*)::int from private.case_input_heads where case_id=any($1::uuid[])) source_heads`,[ids])).rows[0];
  expect(result).toEqual({orders:0,payments:0,quotes:0,real_enrollments:0,qa_enrollments:0,publications:0,source_heads:0});return result;
 };
 try{
  await owner.connect();expect((await owner.query('select current_database() database,session_user role')).rows[0]).toEqual({database:'tivdoc_release_replay_20260907',role:'tivdoc_dev_migrator'});
  expect((await owner.query("select to_regprocedure('public.case_order_saved_release_quote(uuid,uuid,text)') is not null present")).rows[0].present).toBe(true);
  await connectionScope();
  await owner.query('begin');try{
   for(const [index,id] of ids.entries())await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at) values($1,$2,$3,'0500000000',$4,'started','not_started',clock_timestamp())",
    [id,marker,`quote-auth-${id}@example.invalid`,index===1]);
   for(let i=0;i<2;i++){
    const contact=`quote-identity-${runId}-${i}@example.invalid`,identity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[createHash('sha256').update('email|'+contact).digest('hex'),contact])).rows[0].id as string;
    identities.push(identity);
   }
   for(const id of ids)await owner.query('select public.case_access_identity_link($1,$2)',[identities[0],id]);
   for(const [kind,token] of Object.entries(sessions))await owner.query('select public.case_access_session_create($1,$2,$3)',[kind==='foreign'?identities[1]:identities[0],hashSession(token),kind==='expired'?-60:600]);
   await owner.query('select public.case_access_session_revoke($1)',[hashSession(sessions.revoked)]);
   await owner.query('commit');seeded=true;
  }catch(error){await owner.query('rollback');throw error;}
  await untouched();
  expect(await lookup()).toEqual(empty);await connectionScope();
  expect(await lookup()).toEqual(empty);await connectionScope();
  checks.push('authenticated empty non-QA case returns not_prepared on repeated actual pooled service/RPC calls; no quote or activation created');
  await expect(lookup(randomUUID())).rejects.toThrow('REAL_SERVICE_SESSION_FORBIDDEN');await connectionScope();
  await expect(lookup(caseId,identities[1])).rejects.toThrow('ORDER_FORBIDDEN');await connectionScope();
  await expect(lookup(caseId,identities[0],sessions.foreign)).rejects.toThrow('REAL_SERVICE_SESSION_FORBIDDEN');await connectionScope();
  checks.push('unowned nonexistent case UUID, wrong identity parameter, and valid session for an unlinked identity are denied');
  await expect(lookup(caseId,identities[0],sessions.expired)).rejects.toThrow('REAL_SERVICE_SESSION_FORBIDDEN');await connectionScope();
  await expect(lookup(caseId,identities[0],sessions.revoked)).rejects.toThrow('REAL_SERVICE_SESSION_FORBIDDEN');await connectionScope();
  checks.push('durably expired and revoked sessions are refused on the same physical web connection');
  await expect(lookup(qaCaseId)).rejects.toThrow('REAL_SERVICE_SESSION_FORBIDDEN');await connectionScope();
  expect((await owner.query('select is_qa from public.cases where id=$1',[qaCaseId])).rows[0].is_qa).toBe(true);
  checks.push('linked QA case is refused and remains QA; reading cannot convert it into REAL');
  await expect(owner.query('select public.case_order_saved_release_quote($1,$2,$3)',[caseId,identities[0],hashSession(sessions.active)])).rejects.toThrow('REAL_SERVICE_SESSION_FORBIDDEN');
  expect(await lookup()).toEqual(empty);await connectionScope();
  await owner.query('select public.case_access_session_revoke($1)',[hashSession(sessions.active)]);
  await expect(lookup()).rejects.toThrow('REAL_SERVICE_SESSION_FORBIDDEN');await connectionScope();
  checks.push('non-web LOGIN refused; a previously successful web session loses access immediately after durable revocation');
  await untouched();passed=true;
 }catch(error){primary=error;}
 finally{
  if(seeded){
   try{
    await owner.query('begin');
    for(const hash of hashes)await owner.query('select public.case_access_session_revoke($1)',[hash]);
    expect((await owner.query('select count(*)::int n from public.case_access_sessions where session_hash=any($1::text[]) and revoked_at is null',[hashes])).rows[0].n).toBe(0);
    await owner.query('commit');revoked=true;
   }catch(error){await owner.query('rollback').catch(()=>{});cleanupFailures.push(error instanceof Error?error.message:'session_cleanup_failed');}
   if(revoked)try{
    await untouched();await owner.query('begin');
    const rows=await owner.query('select id from public.cases where id=any($1::uuid[]) and first_name=$2 for update',[ids,marker]);expect(rows.rowCount).toBe(2);
    await owner.query('delete from public.cases where id=any($1::uuid[]) and first_name=$2',[ids,marker]);
    await owner.query('delete from public.case_identities where id=any($1::uuid[])',[identities]);
    expect((await owner.query('select count(*)::int n from public.cases where id=any($1::uuid[])',[ids])).rows[0].n).toBe(0);
    await owner.query('commit');cleaned=true;
   }catch(error){await owner.query('rollback').catch(()=>{});cleanupFailures.push(error instanceof Error?error.message:'fixture_cleanup_failed');}
  }
  for(const result of await Promise.allSettled([owner.end(),web.end()]))if(result.status==='rejected')cleanupFailures.push('connection_close_failed');
  writeFileSync(receiptPath,JSON.stringify({schema_version:'release-quote-status-db-proof-v1',run_id:runId,git_sha:head,proposal_sha256:proposalSha,
   passed:passed&&cleaned&&cleanupFailures.length===0,checks,primary_failure:primary instanceof Error?primary.message:primary?'proof_failed':null,cleanup_failures:cleanupFailures,
   database:'tivdoc_release_replay_20260907',actual_web_pool_max:1,reused_backend:backend!==undefined,synthetic_case_ids:ids,
   synthetic_sessions_revoked:revoked,synthetic_cases_and_identities_removed:cleaned,
   scope:'Actual LOGIN, verified TLS, reused pg.Pool, production quote reader and RPC adapter. Synthetic empty authorization fixtures only. Positive empty state and denials; no positive REAL price, customer activation, monetary calculation, source, report, provider, fee or message proof.',
   production_changed:false,secrets_included:false},null,2)+'\n');
 }
 if(primary)throw primary;
 if(cleanupFailures.length||!cleaned)throw Error('RELEASE_QUOTE_STATUS_CLEANUP_UNCONFIRMED');
},60000);
