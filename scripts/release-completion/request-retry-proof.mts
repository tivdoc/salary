import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {readDevEnvFile} from '../supabase-dev-guard/dev-credential.mts';
import {SUPABASE_ROOT_2021_CA} from '../../src/server/product/case-access/supabase-ca.ts';

const env=readDevEnvFile(),baseline=process.env.TIVDOC_REQUEST_RETRY_BASELINE==='1';
function client(key:string){const u=new URL(env.get(key)!);assert.equal(u.pathname,'/tivdoc_release_replay_20260907');assert.equal(u.hostname,'aws-0-eu-central-1.pooler.supabase.com');assert.ok(u.username.endsWith('.cpzrbidxftzqcfeqqusu'));u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});}
const owner=client('TIVDOC_DEV_DATABASE_URL'),a=client('TIVDOC_WEB_POSTGRES_URL'),b=client('TIVDOC_WEB_POSTGRES_URL');
const ids=[randomUUID(),randomUUID()],requestId=randomUUID(),checks:string[]=[];
const migration='20260908001500_request_retry_integrity.sql';let identity:string|undefined,cleaned=false,passed=false;
const edit=(db:pg.Client,answer:string,revision:number,kind='draft',caseId=ids[0])=>db.query('select public.case_request_edit($1,$2,$3,$4,$5,$6) value',[caseId,requestId,identity,answer,revision,kind]);
const list=async()=>(await a.query('select * from public.case_request_revision_list($1)',[ids[0]])).rows.find(r=>r.request_id===requestId);
const head=async()=>(await owner.query('select revision from private.case_input_heads where case_id=$1',[ids[0]])).rows[0].revision;
try{
 await Promise.all([owner.connect(),a.connect(),b.connect()]);
 if(process.env.TIVDOC_APPLY_REQUEST_RETRY_MIGRATION==='1'){
  assert.equal(baseline,false);await owner.query('begin');await owner.query(readFileSync('supabase/migrations/'+migration,'utf8'));await owner.query('commit');
 }
 await owner.query('begin');
 for(const id of ids)await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,check_period_month) values($1,'Synthetic request retry','qa@example.invalid','0500000000',true,'under_review','verified','2026-08-01')",[id]);
 identity=(await owner.query("select public.case_access_identity_upsert('email',$1,'qa@example.invalid') id",[createHash('sha256').update(ids[0]).digest('hex')])).rows[0].id;
 await owner.query('select public.case_access_identity_link($1,$2)',[identity,ids[0]]);await owner.query('commit');
 await a.query("insert into public.case_requests(id,case_id,code,question,answer_kind,blocking,expires_at) values($1,$2,'regular_day_hours_unknown','כמה שעות נמשך יום העבודה הרגיל?','number',true,now()+interval '10 days')",[requestId,ids[0]]);
 const answer=(db:pg.Client,value='8')=>db.query('select * from public.case_request_answer($1,$2,$3)',[requestId,ids[0],value]);
 if(baseline){
  assert.equal((await answer(a)).rowCount,1);assert.equal((await answer(b)).rowCount,0);
  checks.push('reproduced: the stored first answer is refused after its successful response is lost');
  assert.equal((await edit(a,'9',0)).rows[0].value,1);
  await edit(a,'10',1,'correction');assert.equal((await list()).draft_revision,0);
  assert.equal((await edit(b,'stale pre-answer draft',0)).rows[0].value,1);
  checks.push('reproduced: clearing a draft resets its version and permits stale pre-clear draft resurrection');
 }else{
  const firstDraft=await Promise.all([edit(a,'8',0),edit(b,'8',0)]);assert.deepEqual(firstDraft.map(r=>r.rows[0].value),[1,1]);
  assert.equal((await list()).draft_revision,1);assert.equal((await list()).draft_text,'8');
  checks.push('two independent web connections retry the same draft with one revision');
  const answers=await Promise.all([answer(a),answer(b)]);assert.deepEqual(answers.map(r=>r.rowCount),[1,1]);
  const answered=await list();assert.equal(answered.answer_revision,1);assert.equal(answered.draft_text,null);assert.equal(answered.draft_revision,2);
  const revision=await head();await answer(a);assert.equal(await head(),revision);
  checks.push('simultaneous initial answers and later retry return the original once without another source revision');
  await assert.rejects(edit(a,'old draft',0),/REQUEST_EDIT_CONFLICT/);
  await assert.rejects(edit(b,'old draft',1),/REQUEST_EDIT_CONFLICT/);
  assert.equal((await list()).draft_text,null);
  checks.push('clearing the submitted draft advances its persistent generation and refuses old forms');
  const corrections=await Promise.all([edit(a,'9',1,'correction'),edit(b,'9',1,'correction')]);
  assert.deepEqual(corrections.map(r=>r.rows[0].value),[2,2]);assert.equal(await head(),revision+1);
  assert.equal((await list()).latest_answer,'9');assert.equal((await list()).draft_revision,3);
  assert.equal((await a.query('select answer_text from public.case_requests where id=$1',[requestId])).rows[0].answer_text,'8');
  checks.push('concurrent exact correction retries preserve original history and invalidate analysis once');
  await edit(a,'10',3);await edit(b,'9',1,'correction');assert.equal((await list()).draft_text,'10');
  checks.push('a late correction receipt does not clear a newer unsent draft');
  await assert.rejects(edit(b,'11',1,'correction'),/REQUEST_EDIT_CONFLICT/);
  await assert.rejects(edit(b,'11',4,'draft',ids[1]),/REQUEST_FORBIDDEN/);
  await assert.rejects(a.query("select public.case_request_edit($1,$2,$3,'11',null,'correction')",[ids[0],requestId,identity]),/REQUEST_EDIT_INVALID/);
  await assert.rejects(a.query('select * from private.case_request_draft_heads'),/permission denied/);
  checks.push('conflicting retries, foreign case, null CAS and direct private generation access refuse');
  const races=await Promise.allSettled([edit(a,'11',4),edit(b,'12',4)]);
  assert.equal(races.filter(r=>r.status==='fulfilled').length,1);assert.equal(races.filter(r=>r.status==='rejected').length,1);
  assert.equal((await list()).draft_revision,5);
  checks.push('different simultaneous drafts have one winner and one conflict without silent overwrite');
  await answer(b);assert.equal((await list()).latest_answer,'9');assert.equal(await head(),revision+1);
  assert.deepEqual((await owner.query('select status,payment_status from public.cases where id=$1',[ids[0]])).rows[0],{status:'under_review',payment_status:'verified'});
  checks.push('original-answer replay cannot undo correction or change case/payment state');
 }
 passed=true;
}finally{
 await owner.query('rollback').catch(()=>{});
 await owner.query('begin');
 try{await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic request retry'",[ids]);if(identity)await owner.query('delete from public.case_identities where id=$1',[identity]);await owner.query('commit');cleaned=true;}catch(e){await owner.query('rollback');throw e;}
 finally{
  writeFileSync(`docs/release-evidence/P06-request-retry-${baseline?'baseline':'db'}.json`,JSON.stringify({verdict:passed?'PASS':'FAIL',checks,migration:baseline?null:migration,migration_sha256:baseline?null:createHash('sha256').update(readFileSync('supabase/migrations/'+migration)).digest('hex'),database:'tivdoc_release_replay_20260907',authorization:'two actual independent web logins; no fixture RLS policies',syntheticCasesRemoved:cleaned?2:0,identityRemoved:cleaned&&!!identity,browser_verified:false,provider_verified:false,productionChanged:false},null,2)+'\n');
  await Promise.all([owner.end(),a.end(),b.end()]);
 }
}
console.log({passed,checks,syntheticCasesRemoved:cleaned?2:0});
