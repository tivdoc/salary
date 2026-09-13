import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readDevEnvFile} from '../supabase-dev-guard/dev-credential.mts';
import {TIVDOC_DEV_PROJECT_REF} from '../supabase-dev-guard/guard.mts';
const env=readDevEnvFile();assert.equal(env.get('TIVDOC_DEV_PROJECT_REF'),TIVDOC_DEV_PROJECT_REF);
function connect(key:string){const url=new URL(env.get(key)!);url.pathname='/tivdoc_release_replay_20260907';return new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:15000});}
const db=connect('TIVDOC_DEV_DATABASE_URL'),worker=connect('TIVDOC_WORKER_POSTGRES_URL'),web=connect('TIVDOC_WEB_POSTGRES_URL');await Promise.all([db.connect(),worker.connect(),web.connect()]);
const caseId=randomUUID(),other=randomUUID(),requestId=randomUUID(),choiceId=randomUUID();let fixtureIdentity:string|undefined;const checks:string[]=[];const pass=(s:string)=>{checks.push(s);console.log('PASS '+s);};
const now=Date.now(),opened=new Date(now-6*86400000),expires=new Date(now+4*86400000);
try{
 if(!(await db.query("select to_regprocedure('public.case_request_sweep(timestamptz,integer)') fn")).rows[0].fn){await db.query('begin');try{await db.query(readFileSync('supabase/migrations/20260907080000_request_lifecycle.sql','utf8'));await db.query('commit');}catch(e){await db.query('rollback');throw e;}}
 if(!(await db.query("select to_regprocedure('public.case_request_edit(uuid,uuid,uuid,text,integer,text)') fn")).rows[0].fn){await db.query('begin');try{await db.query(readFileSync('supabase/migrations/20260907083000_request_revisions.sql','utf8'));await db.query('commit');}catch(e){await db.query('rollback');throw e;}}
 if((await db.query("select indexdef from pg_indexes where schemaname='public' and indexname='case_requests_one_open_per_code'")).rows[0].indexdef.indexOf('expired_at')<0){await db.query('begin');try{await db.query(readFileSync('supabase/migrations/20260907084500_request_resume_guards.sql','utf8'));await db.query('commit');}catch(e){await db.query('rollback');throw e;}}
 for(const id of [caseId,other])await db.query("insert into public.cases(id,first_name,email,phone,status,payment_status,check_period_month) values($1,'Synthetic lifecycle','synthetic@example.invalid','0500000000','started','not_started','2026-08-01')",[id]);
 await db.query('begin');await db.query('create policy lifecycle_proof on public.case_requests for all to tivdoc_dev_migrator using(true) with check(true)');
 await db.query("insert into public.case_requests(id,case_id,code,question,answer_kind,blocking,opened_at,expires_at) values($1,$2,'regular_day_hours_unknown','Synthetic question','number',true,$3,$4)",[requestId,caseId,opened,expires]);
 await db.query("insert into public.case_requests(id,case_id,code,question,answer_kind,options,blocking,opened_at,expires_at) values($1,$2,'schedule_unknown','Synthetic choice','choice',array['5','6'],true,$3,$4)",[choiceId,caseId,opened,expires]);
 await db.query('drop policy lifecycle_proof on public.case_requests');await db.query('commit');
 await assert.rejects(web.query('select * from public.case_request_answer($1,$2,$3)',[requestId,caseId,'25']),/REQUEST_ANSWER_INVALID/);
 await assert.rejects(web.query('select * from public.case_request_answer($1,$2,$3)',[choiceId,caseId,'7']),/REQUEST_ANSWER_INVALID/);pass('actual server SQL refuses impossible hours and forged choice');
 assert.equal((await web.query('select * from public.case_request_answer($1,$2,$3)',[choiceId,other,'5'])).rowCount,0);pass('request cannot be answered through another case');
 const at48=new Date(opened.getTime()+48*3600000);await worker.query('select public.case_request_sweep($1,100)',[at48]);await worker.query('select public.case_request_sweep($1,100)',[at48]);
 assert.equal((await db.query("select count(*)::int n from private.case_request_events where case_id=$1 and kind='reminder_48h'",[caseId])).rows[0].n,2);pass('48-hour reminder persists once per request across repeated sweeps');
 await worker.query('select public.case_request_sweep($1,100)',[new Date(opened.getTime()+5*86400000)]);assert.equal((await db.query("select count(*)::int n from private.case_request_events where case_id=$1 and kind='reminder_5d'",[caseId])).rows[0].n,2);pass('five-day reminder is independently deduplicated');
 assert.equal((await web.query('select * from public.case_request_answer($1,$2,$3)',[choiceId,caseId,'5'])).rowCount,1);pass('valid answer commits and P05 captures the response');
 const identity=(await db.query("select public.case_access_identity_upsert('email',$1,'synthetic@example.invalid') id",[caseId.replaceAll('-','').repeat(2)])).rows[0].id;
 fixtureIdentity=identity;await db.query('select public.case_access_identity_link($1,$2)',[identity,caseId]);
 const beforeRevision=(await db.query('select revision from private.case_input_heads where case_id=$1',[caseId])).rows[0].revision;
 const savedDraftRevision=(await web.query('select * from public.case_request_revision_list($1)',[caseId])).rows.find(r=>r.request_id===choiceId).draft_revision;
 await web.query("select public.case_request_edit($1,$2,$3,'6',$4,'draft')",[caseId,choiceId,identity,savedDraftRevision]);
 assert.equal((await web.query('select * from public.case_request_revision_list($1)',[caseId])).rows.find(r=>r.request_id===choiceId).draft_text,'6');
 assert.equal((await db.query('select revision from private.case_input_heads where case_id=$1',[caseId])).rows[0].revision,beforeRevision);pass('draft survives a separate SQL read without changing analysis input');
 await web.query("select public.case_request_edit($1,$2,$3,'6',1,'correction')",[caseId,choiceId,identity]);
 assert.equal((await db.query('select answer_text from public.case_requests where id=$1',[choiceId])).rows[0].answer_text,'5');
 assert.equal((await web.query('select * from public.case_request_revision_list($1)',[caseId])).rows.find(r=>r.request_id===choiceId).latest_answer,'6');
 assert.equal((await db.query('select revision from private.case_input_heads where case_id=$1',[caseId])).rows[0].revision,beforeRevision+1);pass('correction preserves original, exposes latest and invalidates analysis once');
 await assert.rejects(web.query("select public.case_request_edit($1,$2,$3,'5',1,'correction')",[caseId,choiceId,identity]),/REQUEST_EDIT_CONFLICT/);pass('stale correction/retry cannot overwrite a newer answer');
 await assert.rejects(web.query("select public.case_request_edit($1,$2,$3,'5',0,'draft')",[other,choiceId,identity]),/REQUEST_FORBIDDEN/);pass('identity ownership is checked again at the edit SQL boundary');
 fixtureIdentity=identity;
 await worker.query('select public.case_request_sweep($1,100)',[expires]);assert.equal((await web.query('select * from public.case_request_answer($1,$2,$3)',[requestId,caseId,'8'])).rowCount,0);
 const states=(await db.query('select id,answered_at,expired_at from public.case_requests where case_id=$1',[caseId])).rows;
 assert.ok(states.find(r=>r.id===requestId).expired_at);assert.ok(states.find(r=>r.id===choiceId).answered_at);assert.equal(states.find(r=>r.id===choiceId).expired_at,null);pass('expiry and answer remain distinct terminal states; answered request is never expired');
 await assert.rejects(web.query('select public.case_request_sweep(now(),100)'),/permission denied/);pass('customer web runtime cannot run or time-shift the scheduler');
 writeFileSync('docs/release-evidence/P06-request-db.json',JSON.stringify({checks,database:'tivdoc_release_replay_20260907',provider_delivery:false,fixtures:'synthetic; cleaned',production:'untouched'},null,2)+'\n');
}finally{await db.query('rollback').catch(()=>{});await db.query('begin');try{await db.query('create policy lifecycle_proof on public.case_requests for all to tivdoc_dev_migrator using(true) with check(true)');await db.query("delete from public.cases where id=any($1::uuid[]) and first_name='Synthetic lifecycle'",[[caseId,other]]);if(fixtureIdentity)await db.query('delete from public.case_identities where id=$1',[fixtureIdentity]);await db.query('drop policy lifecycle_proof on public.case_requests');await db.query('commit');}catch(e){await db.query('rollback');throw e;}finally{await Promise.all([db.end(),worker.end(),web.end()]);}}
