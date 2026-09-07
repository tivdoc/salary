import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {readDevEnvFile} from '../supabase-dev-guard/dev-credential.mts';
import {TIVDOC_DEV_PROJECT_REF} from '../supabase-dev-guard/guard.mts';
import {offerSnapshot} from '../../src/server/product/orders/contracts.ts';
const env=readDevEnvFile();assert.equal(env.get('TIVDOC_DEV_PROJECT_REF'),TIVDOC_DEV_PROJECT_REF);
function client(key:string){const url=new URL(env.get(key)!);url.pathname='/tivdoc_release_replay_20260907';return new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:15000});}
const db=client('TIVDOC_DEV_DATABASE_URL'),a=client('TIVDOC_WEB_POSTGRES_URL'),b=client('TIVDOC_WEB_POSTGRES_URL');
await Promise.all([db.connect(),a.connect(),b.connect()]);
const ids=[randomUUID(),randomUUID()],checks:string[]=[];const pass=(s:string)=>{checks.push(s);console.log('PASS '+s);};
const file=(size=100)=>({clientId:randomUUID(),documentType:'payslip',name:'synthetic.pdf',type:'application/pdf',size,sha256:'a'.repeat(64),periodMonth:'2026-08'});
const manifest=(caseId:string,count=1,size=100)=>({caseId,batchId:randomUUID(),files:Array.from({length:count},()=>file(size))});
async function reserve(connection:pg.Client,m:ReturnType<typeof manifest>){return (await connection.query('select public.case_documents_reserve($1,$2,$3) value',[m.caseId,m.batchId,m])).rows[0].value;}
async function snapshot(connection:pg.Client,id=ids[0]){return (await connection.query('select public.case_documents_snapshot($1) value',[id])).rows[0].value;}
async function commit(connection:pg.Client,batch:{case_id:string;id:string;files:{versionId:string;sha256:string}[]}){return (await connection.query('select public.case_documents_commit($1,$2,$3) value',[batch.case_id,batch.id,Object.fromEntries(batch.files.map(f=>[f.versionId,f.sha256]))])).rows[0].value;}
async function fill(from:number,to:number){await db.query(`insert into public.documents(case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month)
 select $1::uuid,v,'payslip','payslip-'||lpad(n::text,greatest(2,length(n::text)),'0'),'cases/'||($1::uuid)::text||'/versions/'||v||'.pdf','synthetic.pdf','application/pdf',100,repeat('a',64),'2026-08-01'
 from (select n,gen_random_uuid() v from generate_series($2::integer,$3::integer) n) s`,[ids[0],from,to]);}
let policy=false;
try{
 if(!(await db.query("select to_regprocedure('private.case_document_capacity(uuid)') value")).rows[0].value){
  await db.query('begin');try{await db.query(readFileSync('supabase/migrations/20260907150000_paid_document_capacity.sql','utf8'));await db.query('commit');}catch(e){await db.query('rollback');throw e;}
 }
 await db.query(`create policy capacity_fixture on public.documents for all to tivdoc_dev_migrator using(case_id in ('${ids[0]}','${ids[1]}')) with check(case_id in ('${ids[0]}','${ids[1]}'))`);policy=true;
 for(const id of ids)await db.query("insert into public.cases(id,first_name,email,phone,status,payment_status,check_period_month,contact_verified_at,is_qa) values($1,'Synthetic capacity','synthetic@example.invalid','0500000000','under_review','verified','2026-08-01',now(),true)",[id]);
 const original=await reserve(a,manifest(ids[0],12));await commit(a,original);
 await assert.rejects(()=>reserve(a,manifest(ids[0])),/UPLOAD_LIMIT/);pass('ordinary case still refuses a thirteenth payslip');
 const offer=offerSnapshot('full');const order=(await db.query("insert into private.product_orders(case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,'full','2017-01-01','2026-08-01',$2,'ILS',$3,$4,$5,$6,'paid',now()) returning id",[ids[0],offer.amount_minor,offer,offer.sha256,offer.topic_order,offer.terms_version])).rows[0].id;
 await db.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[order]);
 const view=await snapshot(a);assert.equal(view.capacity.maxPayslips,116);assert.equal(view.capacity.paidMonths[0],'2017-01');assert.equal((await snapshot(a,ids[1])).capacity.maxPayslips,12);
 pass('paid historical scope expands only its own case and returns its actual selectable months');
 await fill(13,99);
 const [one,two]=await Promise.all([reserve(a,manifest(ids[0])),reserve(b,manifest(ids[0]))]);
 assert.deepEqual([one.files[0].slot,two.files[0].slot].sort(),['payslip-100','payslip-101']);
 await Promise.all([commit(a,one),commit(b,two)]);
 const reopened=await snapshot(a);assert.equal(reopened.documents.length,101);
 for(const old of original.files)assert.equal(reopened.documents.find((d:{id:string})=>d.id===old.documentId).version_id,old.versionId);
 pass('parallel uploads allocate slots 100 and 101 without truncation or changing earlier versions');
 await assert.rejects(()=>reserve(a,manifest(ids[0],3,10485760)),/UPLOAD_BATCH_LIMIT/);pass('server keeps the 25 MB per-batch bound despite larger whole-case capacity');
 await fill(102,115);
 const race=await Promise.allSettled([reserve(a,manifest(ids[0])),reserve(b,manifest(ids[0]))]);
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1);assert.equal(race.filter(r=>r.status==='rejected'&&/UPLOAD_LIMIT/.test(String(r.reason))).length,1);
 pass('concurrent reservations count toward the same paid capacity; only one wins the last slot');
 const last=race.find(r=>r.status==='fulfilled');if(last?.status!=='fulfilled')throw new Error('last slot missing');
 await db.query("update private.order_entitlements set state='suspended' where order_id=$1",[order]);
 await assert.rejects(()=>commit(a,last.value),/UPLOAD_LIMIT/);
 assert.equal((await snapshot(a)).documents.length,115);pass('entitlement change is rechecked at completion and a failed commit preserves all prior documents');
 const acl=(await db.query("select has_function_privilege('anon','private.case_document_capacity(uuid)','execute') a,has_function_privilege('authenticated','private.case_document_capacity(uuid)','execute') b")).rows[0];assert.deepEqual(acl,{a:false,b:false});
 pass('browser database roles cannot call the capacity helper');
 writeFileSync('docs/release-evidence/P09-document-capacity-db.json',JSON.stringify({checks,database:'tivdoc_release_replay_20260907',runtime_roles:'two actual web credentials',fixtures:'synthetic QA metadata and seeded paid entitlement; no provider charge or Storage bytes',production:'untouched'},null,2)+'\n');
}finally{
 await db.query('rollback').catch(()=>{});
 await db.query("delete from public.cases where id=any($1::uuid[]) and first_name='Synthetic capacity'",[ids]);
 if(policy)await db.query('drop policy capacity_fixture on public.documents');
 await Promise.all([db.end(),a.end(),b.end()]);
}
