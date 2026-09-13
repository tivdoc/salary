import '../production-refusal.mjs';
import assert from 'node:assert/strict';import {readFileSync,writeFileSync} from 'node:fs';import {createHash,randomUUID} from 'node:crypto';import pg from 'pg';import {readDevEnvFile} from '../supabase-dev-guard/dev-credential.mts';
import {SUPABASE_ROOT_2021_CA} from '../../src/server/product/case-access/supabase-ca.ts';
const env=readDevEnvFile(),f=JSON.parse(readFileSync(process.env.TIVDOC_PREVIEW_CASE_FIXTURE_FILE??'', 'utf8'));
assert.equal(f.cases.length,2);
function client(key:string){const u=new URL(env.get(key)!);assert.equal(u.pathname,'/tivdoc_release_replay_20260907');assert.equal(u.hostname,'aws-0-eu-central-1.pooler.supabase.com');assert.ok(u.username.endsWith('.cpzrbidxftzqcfeqqusu'));u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA}});}
const db=client('TIVDOC_DEV_DATABASE_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');const migration='20260907190000_request_pause_trigger_authority.sql';const sql=readFileSync('supabase/migrations/'+migration,'utf8');const checks:string[]=[];
try{await db.connect();await web.connect();assert.equal((await db.query("select count(*)::int n from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic Preview upload'",[f.cases.map(c=>c.caseId)])).rows[0].n,2);await db.query('begin');await db.query(sql);await db.query('commit');
const privileges=(await db.query("select has_table_privilege('tivdoc_web_runtime','private.order_sla_pauses','UPDATE') direct_write,has_function_privilege('tivdoc_web_runtime','private.order_request_pause_close()','EXECUTE') direct_call")).rows[0];assert.equal(privileges.direct_write,false);assert.equal(privileges.direct_call,false);checks.push('web retains no direct order-pause UPDATE or trigger EXECUTE');
// Transactional synthetic probe: prepare order/pauses under the migrator, then
// switch to the actual web role for the request write. Roll back all fixture changes.
const a=f.cases[0],b=f.cases[1],orderA=randomUUID(),orderB=randomUUID();await db.query('begin');
try{
for(const [id,c] of [[orderA,a],[orderB,b]]){await db.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version) values($1,$2,'initial','2026-08-01','2026-08-01',999,'ILS','{}',$3,array['pension'],'synthetic-trigger-proof')",[id,c.caseId,'0'.repeat(64)]);await db.query("insert into private.order_sla(order_id,started_at,track,calendar,budget_ms) values($1,now(),'automatic','{}',1000)",[id]);}
const contract=b.requests.contract_missing,attendance=b.requests.attendance_missing;
for(const [o,r] of [[orderB,contract],[orderB,attendance],[orderA,contract]])await db.query('insert into private.order_sla_pauses(order_id,request_id) values($1,$2)',[o,r]);
await db.query('commit');await web.query('begin');await web.query("update public.case_requests set answered_at=now(),answer_text='Synthetic trigger proof' where id=$1 and case_id=$2",[contract,b.caseId]);
const rows=[];for(const c of [a,b]){const snapshot=(await web.query('select public.case_order_sla_snapshot($1,$2) value',[c.caseId,c.identity])).rows[0].value;rows.push(...snapshot.flatMap(s=>s.pauses));}
assert.ok(rows.find(r=>r.order_id===orderB&&r.request_id===contract).ended_at);checks.push('actual web role closes only the selected same-case request pause');
assert.equal(rows.find(r=>r.order_id===orderB&&r.request_id===attendance).ended_at,null);checks.push('unrelated request pause remains open');
assert.equal(rows.find(r=>r.order_id===orderA).ended_at,null);checks.push('even a malformed pre-existing foreign-order link cannot close another case pause');
}finally{await web.query('rollback');await db.query('rollback');await db.query('delete from private.product_orders where id=any($1::uuid[])',[[orderA,orderB]]);}
writeFileSync('docs/release-evidence/P13-request-pause-authority-db.json',JSON.stringify({migration,sha256:createHash('sha256').update(sql).digest('hex'),database:'tivdoc_release_replay_20260907',checks,synthetic:true,requestTransactionRolledBack:true,temporaryOrdersRemoved:true,productionChanged:false},null,2)+'\n');console.log({migration,checks});
}finally{await db.query('rollback').catch(()=>{});await Promise.all([db.end(),web.end()]);}
