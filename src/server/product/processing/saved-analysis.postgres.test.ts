import {it,expect} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createPostgresAnalysisRepositories} from '@/server/platform/persistence/postgres/analysis';
import {intake_factory} from '@/server/platform/persistence/postgres/intake';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {runSavedMonthAnalysis} from './saved-analysis';
import {saveExtractionCheckpoint} from './extraction-checkpoint';
import type {SourceJob} from './source-dispatch';

it.skipIf(process.env.TIVDOC_SAVED_SOURCE_DB_PROOF!=='1')('persists real canonical stages and rolls back interrupted saved-source analysis in isolated PostgreSQL',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw new Error('SAVED_DB_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');
 const env=readDevEnvFile();expect(env.get('TIVDOC_DEV_PROJECT_REF')).toBe('cpzrbidxftzqcfeqqusu');
 const url=new URL(env.get('TIVDOC_DEV_DATABASE_URL')!);url.pathname='/tivdoc_release_replay_20260907';
 expect(url.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);
 const db=new pg.Client({connectionString:url.toString(),connectionTimeoutMillis:15000});await db.connect();
 const checks:string[]=[];const tenant=`saved-proof-${randomUUID()}`;
 const fixture=buildSyntheticCaseFixture({fixture_id:tenant,mode:'real'}),caseId=fixture.command.case_id,documentId=randomUUID(),orderId=randomUUID();
 const doc=fixture.stored.documents[0],extraction=fixture.stored.extractions[0];
 const context:PostgresTransactionContext={transaction_id:tenant,client:{async query(s){
  try{const r=await db.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date?value.toISOString():value]))),row_count:r.rowCount??0};}
  catch(e){const failure=e as {code?:string;constraint?:string;table?:string};console.info('DB_PROOF_FAILURE',{statement:s.name,code:failure.code,constraint:failure.constraint,table:failure.table});throw e;}
 }}};
 try{
  await db.query('begin');
  await db.query("select set_config('tivdoc.engine_git_sha',$1,true),set_config('tivdoc.tenant_id',$2,true)",[execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),tenant]);
  // Owner-only, transaction-local fixture policies; rollback restores every
  // table's original FORCE RLS policies. Not a worker authorization proof.
  for(const table of ['documents','engine_case_identity','engine_case_state','engine_case_lifecycle_revisions','analysis_runs','engine_analysis_stage_versions','engine_legal_version_pins','engine_topic_result_versions','engine_calculation_trace_versions','engine_report_versions','case_findings']){
   const exists=(await db.query('select to_regclass($1) value',[`public.${table}`])).rows[0].value;
   if(exists)await db.query(`create policy saved_analysis_owner_proof on public.${table} for all to tivdoc_dev_migrator using(true) with check(true)`);
  }
  await db.query("insert into public.cases(id,first_name,email,phone,status,payment_status,check_period_month) values($1,'Synthetic saved analysis','synthetic@example.invalid','0500000000','under_review','verified','2025-01-01')",[caseId]);
  await db.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-01',$4,'synthetic.pdf','application/pdf',$5,$6,'2025-01-01')",[documentId,caseId,doc.document_id,`cases/${caseId}/versions/${doc.document_id}.pdf`,doc.size_bytes,doc.content_sha256]);
  const head=(await db.query('select * from private.case_input_heads where case_id=$1',[caseId])).rows[0];
  // Explicit synthetic paid-order scope; no provider payment is asserted.
  await db.query("update private.case_input_versions set input=jsonb_set(input,'{orders}',$3::jsonb) where case_id=$1 and revision=$2",[caseId,head.revision,JSON.stringify([{id:orderId,kind:'initial',from:'2025-01-01',to:'2025-01-31',topics:fixture.command.requested_topics}])]);
  const source=(await db.query("update private.case_input_versions set input_sha256=encode(sha256(convert_to(input::text,'UTF8')),'hex') where case_id=$1 and revision=$2 returning input_sha256",[caseId,head.revision])).rows[0];
  await db.query('update private.case_input_heads set input_sha256=$2 where case_id=$1',[caseId,source.input_sha256]);
  const job:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:head.revision,input_sha256:source.input_sha256,mode:'draft'};
  const result={schema_version:'tivdoc-saved-extraction-v1',case_id:caseId,product_document_id:documentId,version_id:doc.document_id,input_sha256:doc.content_sha256,
   expected_month:'2025-01',period_mismatch:false,requires_confirmation:false,run:{result:{final_extraction:extraction}},result_sha256:canonicalSha256({final_extraction:extraction})};
  await saveExtractionCheckpoint(context,job,result as Parameters<typeof saveExtractionCheckpoint>[2]);
  const hash=canonicalSha256({tenant});
  await intake_factory(context,tenant).case_lifecycle.append(context,{tenant_id:tenant,case_id:caseId,expected_revision:0,state_before:null,state_after:'awaiting_legal_review',event_kind:'synthetic_saved_input',command_sha256:hash,event_sha256:hash,previous_sha256:null,state_sha256:hash,occurred_at:'2025-02-01T00:00:00.000Z'});
  const args={context,analysis:createPostgresAnalysisRepositories(context,tenant),tenantId:tenant,job,orderId,month:'2025-01'};
  await db.query('savepoint before_analysis');
  const first=await runSavedMonthAnalysis(args);expect(first.completed).toBe(true);expect(first.stages).toHaveLength(7);
  expect((await db.query('select count(*)::int n from public.engine_topic_result_versions where tenant_id=$1',[tenant])).rows[0].n).toBe(7);
  checks.push('canonical service writes seven stages and seven non-monetary results through real PostgreSQL adapters');
  await db.query('rollback to savepoint before_analysis');
  expect((await db.query('select count(*)::int n from public.analysis_runs where tenant_id=$1',[tenant])).rows[0].n).toBe(0);
  expect((await db.query('select count(*)::int n from public.engine_report_versions where tenant_id=$1',[tenant])).rows[0].n).toBe(0);
  expect((await db.query('select count(*)::int n from public.documents where case_id=$1',[caseId])).rows[0].n).toBe(1);
  checks.push('rollback removes partial analysis/report while preserving source and extraction checkpoint');
  const retry=await runSavedMonthAnalysis(args),again=await runSavedMonthAnalysis(args);
  expect(retry.report?.report_sha256).toBe(first.report?.report_sha256);expect(again.report).toEqual(retry.report);
  expect((await db.query('select count(*)::int n from public.analysis_runs where tenant_id=$1',[tenant])).rows[0].n).toBe(1);
  checks.push('retry and replay retain exact report bytes without a duplicate analysis run');
  await db.query('update private.case_input_heads set revision=revision+1 where case_id=$1',[caseId]);
  await expect(runSavedMonthAnalysis(args)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
  checks.push('source revision changing before completion rejects old work');
  writeFileSync('docs/release-evidence/P05-saved-analysis-db.json',JSON.stringify({checks,database:'tivdoc_release_replay_20260907',fixture:'synthetic saved extraction and paid-order scope',authorization:'migrator fixture policies inside rolled-back transaction; not worker RLS proof',provider_verified:false,storage_bytes_verified:false,customer_publication:false,production:'untouched'},null,2)+'\n');
 }finally{await db.query('rollback').catch(()=>{});await db.end();}
},120000);
