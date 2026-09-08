import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {savedDeclaredFacts} from './saved-request-facts';
import {listCaseRequests} from '../reports/case-requests';
import {postgresCaseAccessDb} from '../case-access/db';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_REQUEST_SOURCE_DB_PROOF!=='1')('pins actual original/corrected answers to their statement month and canonical source reference',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw new Error('REQUEST_SOURCE_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');const env=readDevEnvFile();
 function client(key:string){const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});}
 const owner=client('TIVDOC_DEV_DATABASE_URL'),web=client('TIVDOC_WEB_POSTGRES_URL'),ids=[randomUUID(),randomUUID()],requestId=randomUUID(),historicId=randomUUID();
 const migration='20260908073000_request_statement_scope.sql',apply=process.env.TIVDOC_APPLY_REQUEST_SCOPE==='1',checks:string[]=[];
 let identity:string|undefined,cleaned=false,passed=false;
 const journal=async()=>(await owner.query('select v.* from private.case_input_versions v join private.case_input_heads h using(case_id,revision) where v.case_id=$1',[ids[0]])).rows[0];
 const facts=(row:Awaited<ReturnType<typeof journal>>,month='2025-01')=>savedDeclaredFacts({caseId:ids[0],revision:row.revision,inputSha256:row.input_sha256,month,journal:row.input,createdAt:new Date(row.created_at).toISOString()});
 try{
  await Promise.all([owner.connect(),web.connect()]);await owner.query('begin');
  for(const id of ids)await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,check_period_month) values($1,'Synthetic request source','qa@example.invalid','0500000000',true,'under_review','verified','2025-01-01')",[id]);
  identity=(await owner.query("select public.case_access_identity_upsert('email',$1,'qa@example.invalid') id",[createHash('sha256').update(ids[0]).digest('hex')])).rows[0].id;
  await owner.query('select public.case_access_identity_link($1,$2)',[identity,ids[0]]);await owner.query('commit');
  if(apply){
   await web.query("insert into public.case_requests(id,case_id,code,question,answer_kind,blocking,expires_at) values($1,$2,'fact.missing','שאלה סינתטית היסטורית','text',true,now()+interval '10 days')",[historicId,ids[0]]);
   await web.query("select * from public.case_request_answer($1,$2,'historical synthetic answer')",[historicId,ids[0]]);const before=await journal();
   await owner.query('begin');await owner.query(readFileSync('supabase/migrations/'+migration,'utf8'));await owner.query('commit');
   expect((await web.query('select statement_month from public.case_requests where id=$1',[historicId])).rows[0].statement_month).toBeNull();
   expect((await journal()).input_sha256).toBe(before.input_sha256);expect((await journal()).input).toEqual(before.input);
   checks.push('forward migration leaves a real pre-migration question scope unknown and original journal bytes unchanged');
  }
  await web.query("insert into public.case_requests(id,case_id,code,question,answer_kind,blocking,expires_at,statement_month) values($1,$2,'regular_day_hours_unknown','כמה שעות נמשך יום העבודה הרגיל?','number',true,now()+interval '10 days','1999-01')",[requestId,ids[0]]);
  expect((await listCaseRequests(ids[0],postgresCaseAccessDb(web))).find(r=>r.id===requestId)?.statement_month).toBe('2025-01');
  await expect(web.query("update public.case_requests set statement_month='2025-02' where id=$1",[requestId])).rejects.toThrow('REQUEST_STATEMENT_SCOPE_IMMUTABLE');
  checks.push('server pins current checked month rather than caller-supplied scope; list mapper returns month precision and later scope mutation refuses');
  await web.query("select * from public.case_request_answer($1,$2,'8')",[requestId,ids[0]]);const original=await journal(),first=facts(original)[0];
  expect(first.value).toBe(8);expect(first.status).toBe('needs_confirmation');expect(first.provenance).toEqual([{source_type:'declared',source_reference:{kind:'case_request_answer',request_id:requestId,answer_revision:1}}]);
  checks.push('actual original answer reaches the immutable journal as a typed unconfirmed fact with request ID and revision 1');
  await web.query("select public.case_request_edit($1,$2,$3,'9',1,'correction')",[ids[0],requestId,identity]);const corrected=await journal(),second=facts(corrected)[0];
  expect(corrected.revision).toBeGreaterThan(original.revision);expect(second.value).toBe(9);expect(second.fact_id).not.toBe(first.fact_id);
  expect(second.provenance).toEqual([{source_type:'declared',source_reference:{kind:'case_request_answer',request_id:requestId,answer_revision:2}}]);
  expect((await owner.query('select input_sha256 from private.case_input_versions where case_id=$1 and revision=$2',[ids[0],original.revision])).rows[0].input_sha256).toBe(original.input_sha256);
  await web.query("select public.case_request_edit($1,$2,$3,'9',1,'correction')",[ids[0],requestId,identity]);expect((await journal()).input_sha256).toBe(corrected.input_sha256);
  checks.push('correction creates a distinct source/fact version while original history and exact retry bytes remain unchanged');
  await owner.query("update public.cases set check_period_month='2025-02-01' where id=$1",[ids[0]]);const moved=await journal();
  expect(facts(moved,'2025-02')).toEqual([]);expect(facts(moved,'2025-01')[0].value).toBe(9);
  expect((await listCaseRequests(ids[0],postgresCaseAccessDb(web))).find(r=>r.id===requestId)?.statement_month).toBe('2025-01');
  checks.push('changing the case month never relabels or extrapolates the saved January answer into February');
  await owner.query("update public.cases set check_period_month='2025-01-01' where id=$1",[ids[0]]);
  await owner.query("insert into public.questionnaire_responses(case_id,payload,suspected_issue) values($1,'{\"typicalHoursPerDay\":8}'::jsonb,'')",[ids[0]]);
  const conflict=facts(await journal())[0];expect(conflict.status).toBe('conflicted');expect(conflict.value).toBeNull();expect(conflict.provenance).toHaveLength(2);
  await owner.query("update public.questionnaire_responses set payload='{\"typicalHoursPerDay\":9}'::jsonb where case_id=$1",[ids[0]]);
  const agreement=facts(await journal())[0];expect(agreement.status).toBe('needs_confirmation');expect(agreement.value).toBe(9);expect(agreement.provenance).toHaveLength(2);
  checks.push('questionnaire disagreement remains a sourced conflict; agreement retains both references without confirmation');
  await expect(web.query("select public.case_request_edit($1,$2,$3,'10',2,'correction')",[ids[1],requestId,identity])).rejects.toThrow('REQUEST_FORBIDDEN');
  expect((await owner.query('select status,payment_status from public.cases where id=$1',[ids[0]])).rows[0]).toEqual({status:'under_review',payment_status:'verified'});
  checks.push('foreign case correction refuses and answers do not alter case/payment status');passed=true;
 }finally{
  await owner.query('rollback').catch(()=>{});await owner.query('begin');
  try{await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic request source'",[ids]);if(identity)await owner.query('delete from public.case_identities where id=$1',[identity]);await owner.query('commit');cleaned=true;}catch(error){await owner.query('rollback');throw error;}
  finally{
   writeFileSync('docs/release-evidence/P06-request-source-db.json',JSON.stringify({verdict:passed?'PASS':'FAIL',checks,migration,migration_sha256:createHash('sha256').update(readFileSync('supabase/migrations/'+migration)).digest('hex'),applied_in_this_run:apply,database:'tivdoc_release_replay_20260907',syntheticCasesRemoved:cleaned?2:0,identityRemoved:cleaned&&!!identity,proof:'actual web RPCs and immutable journal plus typed canonical adapter; canonical stage persistence and hosted UI are separate checks',productionChanged:false},null,2)+'\n');
   await Promise.all([owner.end(),web.end()]);
  }
 }
},120000);
