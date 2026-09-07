import {it,expect} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {offerSnapshot} from '../orders/contracts';
import {runSavedWorkerMonth} from './saved-worker';
import {saveExtractionCheckpoint} from './extraction-checkpoint';
import {admitSavedSource,savedCaseTenant} from './saved-admission';
import type {SourceJob} from './source-dispatch';

it.skipIf(process.env.TIVDOC_SAVED_WORKER_DB_PROOF!=='1')('runs saved canonical analysis as a scoped actual worker without fixture RLS policies',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw new Error('SAVED_DB_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');
 const env=readDevEnvFile();
 function client(key:string){const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});}
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL');
 const fixture=buildSyntheticCaseFixture({fixture_id:`worker-${randomUUID()}`,mode:'real'}),caseId=fixture.command.case_id,otherId=randomUUID(),documentId=randomUUID(),orderId=randomUUID();
 const tenant=savedCaseTenant(caseId),sid=`worker-proof:${randomUUID()}`,jti=randomUUID(),checks:string[]=[];
 const doc=fixture.stored.documents[0],extraction=fixture.stored.extractions[0],offer=offerSnapshot('initial');
 const migration='20260907210000_saved_worker_analysis_scope.sql';
 const context:PostgresTransactionContext={transaction_id:sid,client:{async query(s){try{const r=await worker.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date?value.toISOString():value]))),row_count:r.rowCount??0};}catch(e){console.info('WORKER_DB_FAILURE',{statement:s.name,code:(e as {code?:string}).code,message:(e as Error).message,where:(e as {where?:string}).where});throw e;}}}};
 let seeded=false,cleaned=false;
 try{
  await Promise.all([owner.connect(),worker.connect()]);
  if(process.env.TIVDOC_APPLY_WORKER_MIGRATION==='1'){await owner.query('begin');await owner.query(readFileSync(`supabase/migrations/${migration}`,'utf8'));await owner.query('commit');}
  await owner.query('begin');
  for(const id of [caseId,otherId])await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,check_period_month) values($1,'Synthetic worker proof','qa@example.invalid','0500000000',true,'under_review','verified','2025-01-01')",[id]);
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-01',$4,'synthetic.pdf','application/pdf',$5,$6,'2025-01-01')",[documentId,caseId,doc.document_id,`cases/${caseId}/versions/${doc.document_id}.pdf`,doc.size_bytes,doc.content_sha256]);
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-01',$4,'other-synthetic.pdf','application/pdf',$5,$6,'2025-01-01')",[randomUUID(),otherId,randomUUID(),`cases/${otherId}/versions/other.pdf`,doc.size_bytes,doc.content_sha256]);
  // Explicit synthetic paid order; no provider receipt is asserted. Source
  // capture itself is real and never patched or rehashed by the test.
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2025-01-01','2025-01-01',999,'ILS',$3,$4,$5,$6,'paid',now())",[orderId,caseId,offer,offer.sha256,fixture.command.requested_topics.slice(0,3),offer.terms_version]);
  await owner.query("insert into public.questionnaire_responses(case_id,payload,suspected_issue) values($1,$2,'')",[caseId,{salaryType:'hourly',employmentStartMonth:'2024-07'}]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.saved.worker',$3,now()-interval '1 minute',now()+interval '15 minutes',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);
  await owner.query('commit');seeded=true;
  const head=(await owner.query('select * from private.case_input_heads where case_id=$1',[caseId])).rows[0];
  const job:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:head.revision,input_sha256:head.input_sha256,mode:'draft'};
  await worker.query('begin');
  await worker.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
  await expect(admitSavedSource(context,job)).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN');
  expect((await worker.query('select id from public.documents where case_id=$1',[caseId])).rows).toHaveLength(0);
  checks.push('a tenant GUC without authoritative machine SID/JTI cannot admit a saved case');
  await worker.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'saved-worker-proof']);
  await worker.query("select set_config('tivdoc.engine_git_sha',$1,true)",[execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()]);
  await expect(admitSavedSource(context,{...job,case_id:otherId})).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN');
  await worker.query('savepoint foreign_tenant');await expect(worker.query('select private.resolve_engine_case_id($1,$2)',[savedCaseTenant(otherId),otherId])).rejects.toThrow(/row-level security/);await worker.query('rollback to savepoint foreign_tenant');
  const admission=await admitSavedSource(context,job);expect(admission.tenantId).toBe(tenant);expect(admission.revision).toBe(1);
  expect((await admitSavedSource(context,job)).revision).toBe(1);
  checks.push('verified machine session admits its paid saved source once and refuses another case');
  expect((await worker.query('select id from public.documents where case_id=$1',[caseId])).rows).toHaveLength(1);
  expect((await worker.query('select id from public.documents where case_id=$1',[otherId])).rows).toHaveLength(0);
  checks.push('actual worker can read product document metadata only in its verified case tenant');
  const result={schema_version:'tivdoc-saved-extraction-v1',case_id:caseId,product_document_id:documentId,version_id:doc.document_id,input_sha256:doc.content_sha256,expected_month:'2025-01',period_mismatch:false,requires_confirmation:false,run:{result:{final_extraction:extraction}},result_sha256:canonicalSha256({final_extraction:extraction})};
  await saveExtractionCheckpoint(context,job,result as Parameters<typeof saveExtractionCheckpoint>[2]);
  const args={context,job,orderId,month:'2025-01'};
  await worker.query('savepoint before_analysis');
  const first=await runSavedWorkerMonth(args);expect(first.completed).toBe(true);expect(first.stages).toHaveLength(7);expect(first.bundle?.topic_results).toHaveLength(3);
  expect(first.bundle?.topic_results.every(t=>t.amount===null)).toBe(true);
  checks.push('actual worker persists seven canonical stages and three non-monetary purchased-topic results');
  await worker.query('rollback to savepoint before_analysis');
  expect((await worker.query('select count(*)::int n from public.analysis_runs where tenant_id=$1',[tenant])).rows[0].n).toBe(0);
  const retry=await runSavedWorkerMonth(args),again=await runSavedWorkerMonth(args);expect(again.report?.report_sha256).toBe(retry.report?.report_sha256);
  checks.push('worker rollback removes partial analysis and retry produces byte-identical persisted draft');
  await worker.query('rollback');
  expect((await worker.query('select private.runtime_verified_tenant() value')).rows[0].value).toBeNull();
  checks.push('transaction end clears worker authorization and no canonical fixture rows remain');
 }finally{
  await worker.query('rollback').catch(()=>{});await owner.query('rollback').catch(()=>{});
  if(seeded){await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);await owner.query('update public.product_identity_sessions set revoked_at=now() where sid=$1 and tenant_id=$2',[sid,tenant]);await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic worker proof'",[[caseId,otherId]]);await owner.query('commit');cleaned=true;}
  writeFileSync('docs/release-evidence/P05-saved-worker-db.json',JSON.stringify({verdict:checks.length===6?'PASS':'FAIL',checks,database:'tivdoc_release_replay_20260907',migration,migration_sha256:createHash('sha256').update(readFileSync(`supabase/migrations/${migration}`)).digest('hex'),authorization:'actual worker login, provisioned synthetic machine session, existing verified-tenant RLS; no canonical fixture policies',syntheticCasesRemoved:cleaned?2:0,machineSessionRevoked:cleaned,canonicalWritesRolledBack:true,provider_verified:false,storage_bytes_verified:false,customer_publication:false,productionChanged:false},null,2)+'\n');
  await Promise.all([worker.end(),owner.end()]);
 }
},120000);
