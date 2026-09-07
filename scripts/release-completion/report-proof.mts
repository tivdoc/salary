import '../production-refusal.mjs';
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import pg from 'pg';
import {readDevEnvFile} from '../supabase-dev-guard/dev-credential.mts';
import {TIVDOC_DEV_PROJECT_REF} from '../supabase-dev-guard/guard.mts';
import {S04_HIGH_CERTAINTY,ALL_AWAITING_VERIFICATION} from '../../src/server/product/reports/case-report-projection.fixtures.ts';
const env=readDevEnvFile();assert.equal(env.get('TIVDOC_DEV_PROJECT_REF'),TIVDOC_DEV_PROJECT_REF);
const url=new URL(env.get('TIVDOC_DEV_DATABASE_URL')!);url.pathname='/tivdoc_release_replay_20260907';
const db=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:15000});await db.connect();
const webUrl=new URL(env.get('TIVDOC_WEB_POSTGRES_URL')!);webUrl.pathname='/tivdoc_release_replay_20260907';
const web=new pg.Client({connectionString:webUrl.toString(),connectionTimeoutMillis:15000});await web.connect();
let fixtureIds:string[]=[];let fixtureIdentity:string|undefined;
const migration=readFileSync('supabase/migrations/20260907053658_release_report_contract.sql','utf8');
let passed=0;const check=(name:string)=>{passed++;console.log(`PASS ${name}`);};
try{
 const exists=(await db.query("select to_regprocedure('public.case_report_customer_snapshot(uuid,uuid)') fn")).rows[0].fn;
 if(!exists){await db.query('begin');try{await db.query(migration);await db.query('commit');}catch(error){await db.query('rollback');throw error;}}
 await db.query('alter table public.case_report_projections drop constraint report_document_v2_shape');
 await db.query("alter table public.case_report_projections add constraint report_document_v2_shape check(report_document is null or coalesce((report_document->>'schema_version'='tivdoc-report-document-v2' and report_document->>'case_id'=case_id::text and report_document->>'id'=id::text),false))");
 await db.query('begin');
 const caseId=randomUUID(),other=randomUUID(),identity=randomUUID(),projectionId=randomUUID();fixtureIds=[caseId,other];
 await db.query("insert into public.cases(id,first_name,email,phone,status,payment_status,check_period_month) values($1,'Synthetic report','synthetic@example.invalid','0500000000','under_review','verified','2025-02-01'),($2,'Synthetic report','synthetic@example.invalid','0500000000','under_review','verified','2024-03-01')",[caseId,other]);
 const created=(await db.query("select public.case_access_identity_upsert('email',$1,'synthetic-report@example.invalid') id",[createHash("sha256").update(identity).digest("hex")])).rows[0].id;
 fixtureIdentity=created;
 await db.query('select public.case_access_identity_link($1,$2)',[created,caseId]);
 const publicId=(await db.query('select public_id from public.cases where id=$1',[caseId])).rows[0].public_id;
 await db.query('create policy release_proof_writer on public.case_report_projections for all to tivdoc_dev_migrator using(true) with check(true)');
 await db.query('create policy release_proof_qa_writer on public.case_report_qa for all to tivdoc_dev_migrator using(true) with check(true)');
 const projection={...S04_HIGH_CERTAINTY,case_public_id:publicId,check_period_month:'2025-02',months_covered:['2025-02']};
 await db.query("insert into public.case_report_projections(id,case_id,schema_version,report_kind,check_period_month,projection,projection_sha256,legal_basis,generated_at) values($1,$2,$3,'initial','2025-02-01',$4,$5,$6,now())",[projectionId,caseId,projection.schema_version,projection,'0'.repeat(64),projection.legal_basis]);
 await db.query("insert into public.case_report_qa(case_id,projection_id,report_kind,document_track,state,operator_identity,decided_at,published_at) values($1,$2,'initial','automatic','published','system:synthetic-proof',now(),now())",[caseId,projectionId]);
 await db.query('drop policy release_proof_writer on public.case_report_projections');
 await db.query('drop policy release_proof_qa_writer on public.case_report_qa');
 await db.query('commit');
 const result=(await web.query('select public.case_report_customer_snapshot($1,$2) result',[caseId,created])).rows[0].result;
 assert.equal(result.reports.length,1);assert.equal(result.checkPeriodMonth,'2025-02');assert.equal(result.reports[0].projection.case_public_id,publicId);check('web runtime reads only the identity-owned actual published case and month');
 await assert.rejects(web.query('select public.case_report_customer_snapshot($1,$2)',[other,created]),/REPORT_FORBIDDEN/);check('foreign identity/case snapshot is refused');
 await db.query('begin');
 await db.query('create policy release_proof_writer on public.case_report_projections for all to tivdoc_dev_migrator using(true) with check(true)');
 await db.query('create policy release_proof_qa_writer on public.case_report_qa for all to tivdoc_dev_migrator using(true) with check(true)');
 const invalid={...projection,topics:projection.topics.map(t=>t.gate==='checked'?{...t,basis_complete:false}:t)};
 assert.equal((await db.query('select public.case_report_contract_valid($1) valid',[invalid])).rows[0].valid,false);check('actual SQL guard refuses an incomplete initial amount');
 await db.query('savepoint empty_report');
 await db.query('update public.case_report_projections set projection=$1 where id=$2',[{...ALL_AWAITING_VERIFICATION,case_public_id:publicId},projectionId]);
 await assert.rejects(db.query("update public.case_report_qa set state='published' where projection_id=$1",[projectionId]),/REPORT_NO_CHECKED_TOPICS/);await db.query('rollback to savepoint empty_report');check('SQL refuses publication when zero topics were checked');
 const acl=(await db.query("select has_function_privilege('anon','public.case_report_customer_snapshot(uuid,uuid)','execute') anon,has_function_privilege('authenticated','public.case_report_customer_snapshot(uuid,uuid)','execute') authenticated")).rows[0];assert.equal(acl.anon,false);assert.equal(acl.authenticated,false);check('browser roles cannot call the customer report RPC');
 await db.query('rollback');
 writeFileSync('docs/release-evidence/P02-report-db.json',JSON.stringify({passed,database:'tivdoc_release_replay_20260907',migration_sha256_lf:createHash('sha256').update(migration.replaceAll('\r\n','\n')).digest('hex'),fixtures:'synthetic rows removed; seed-only migrator policies rolled back; runtime privileges unchanged',production:'untouched'},null,2)+'\n');
}finally{
 await db.query('rollback').catch(()=>{});
 await db.query('begin');
 try {
  await db.query('create policy release_proof_writer on public.case_report_projections for all to tivdoc_dev_migrator using(true) with check(true)');
  await db.query('create policy release_proof_qa_writer on public.case_report_qa for all to tivdoc_dev_migrator using(true) with check(true)');
  await db.query('delete from public.cases where id=any($1::uuid[]) and first_name=$2',[fixtureIds,'Synthetic report']);
  if(fixtureIdentity)await db.query('delete from public.case_identities where id=$1',[fixtureIdentity]);
  await db.query('drop policy release_proof_writer on public.case_report_projections');
  await db.query('drop policy release_proof_qa_writer on public.case_report_qa');
  await db.query('commit');
 }catch(error){await db.query('rollback');throw error;}
 finally{await db.end();await web.end();}
}

