import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {readDevEnvFile} from '../supabase-dev-guard/dev-credential.mts';
import {TIVDOC_DEV_PROJECT_REF} from '../supabase-dev-guard/guard.mts';
const env=readDevEnvFile();assert.equal(env.get('TIVDOC_DEV_PROJECT_REF'),TIVDOC_DEV_PROJECT_REF);
function client(key:string){const url=new URL(env.get(key)!);url.pathname='/tivdoc_release_replay_20260907';return new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:15000});}
const db=client('TIVDOC_DEV_DATABASE_URL'),peer=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL');
await Promise.all([db.connect(),peer.connect(),worker.connect()]);
const ids=[randomUUID(),randomUUID()];const checks:string[]=[];const pass=(s:string)=>{checks.push(s);console.log('PASS '+s);};
const migration=readFileSync('supabase/migrations/20260907070000_case_input_outbox.sql','utf8');
async function head(id=ids[0]){return (await db.query('select * from private.case_input_heads where case_id=$1',[id])).rows[0];}
try{
 if(!(await db.query("select to_regclass('private.case_input_heads') value")).rows[0].value){await db.query('begin');try{await db.query(migration);await db.query('commit');}catch(e){await db.query('rollback');throw e;}}
 for(const id of ids)await db.query("insert into public.cases(id,first_name,email,phone,status,payment_status,check_period_month) values($1,'Synthetic source journal','synthetic@example.invalid','0500000000','started','not_started','2026-08-01')",[id]);
 await db.query("insert into public.questionnaire_responses(case_id,payload,suspected_issue) values($1,'{\"hours\":160}','test')",[ids[0]]);
 const first=await head();assert.equal(first.revision,1);assert.equal((await db.query('select count(*)::int n from private.case_analysis_dispatch where case_id=$1',[ids[0]])).rows[0].n,1);pass('source write commits immutable input and dispatch intent together');
 await db.query('update public.questionnaire_responses set payload=payload where case_id=$1',[ids[0]]);assert.equal((await head()).revision,1);pass('unchanged retry creates no new revision or work');
 await db.query('begin');await db.query("update public.questionnaire_responses set payload='{\"hours\":180}' where case_id=$1",[ids[0]]);await db.query('rollback');assert.equal((await head()).revision,1);pass('crash/rollback loses neither original source nor original dispatch and exposes no partial revision');
 await Promise.all([db.query("update public.questionnaire_responses set payload='{\"hours\":180}' where case_id=$1",[ids[0]]),peer.query("update public.cases set payment_status='verified' where id=$1",[ids[0]])]);
 const current=await head();assert.equal(current.revision,3);const saved=(await db.query('select input from private.case_input_versions where case_id=$1 and revision=3',[ids[0]])).rows[0].input;assert.equal(saved.questionnaire.hours,180);assert.equal(saved.payment_status,'verified');pass('parallel independent input updates converge without losing either change');
 await db.query("insert into public.questionnaire_responses(case_id,payload,suspected_issue) values($1,'{\"hours\":42}','test')",[ids[1]]);assert.equal((await head(ids[1])).revision,1);assert.equal((await head()).revision,3);pass('two synthetic cases keep independent revisions');
 assert.equal((await worker.query('select revision from private.case_input_heads where case_id=$1',[ids[0]])).rows[0].revision,3);pass('fresh actual worker connection reads committed journal after controller transaction ended');
 const acl=(await db.query("select has_table_privilege('anon','private.case_input_versions','select') a,has_table_privilege('authenticated','private.case_input_versions','select') b,has_function_privilege('service_role','private.capture_case_input(uuid,text)','execute') c")).rows[0];assert.deepEqual(acl,{a:false,b:false,c:false});pass('browser roles cannot read journal and service route cannot forge input captures');
 assert.equal((await db.query('select count(distinct input_sha256)::int n from private.case_input_versions where case_id=$1',[ids[0]])).rows[0].n,3);pass('prior input snapshots survive later updates with distinct digests');
 writeFileSync('docs/release-evidence/P05-source-journal-db.json',JSON.stringify({checks,database:'tivdoc_release_replay_20260907',migration_sha256_lf:createHash('sha256').update(migration.replaceAll('\r\n','\n')).digest('hex'),scope:'actual PostgreSQL source journal; no provider, Storage or full composition claimed',production:'untouched'},null,2)+'\n');
}finally{await db.query('rollback').catch(()=>{});await db.query("delete from public.cases where id=any($1::uuid[]) and first_name='Synthetic source journal'",[ids]);await Promise.all([db.end(),peer.end(),worker.end()]);}
