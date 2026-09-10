import {expect,it,vi} from 'vitest';
import pg from 'pg';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {runSavedDevFinancialMonth} from './dev-financial-analysis';
import type {SourceJob} from './source-dispatch';
vi.mock('server-only',()=>({}));

/** Real current journal/checkpoint and the actual financial writer, all inside
 * a rollback. Browser answers must already exist. No fixture answer, source,
 * finding, report, customer session or provider response is seeded here. */
it.skipIf(process.env.TIVDOC_RETAINED_SOURCE_REPORT_PROOF!=='1')('validates the retained live source with SQL-null journal siblings before automatic processing',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('RETAINED_SOURCE_DEV_ONLY');
 const control=JSON.parse(readFileSync('../release-work/retained-managed-control.private.json','utf8'));
 expect(control.caseId).toBe('87eb4418-7d9f-4b68-aa86-82be059295ac');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');
 const u=new URL(readDevEnvFile().get('TIVDOC_WORKER_POSTGRES_URL')!);
 expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.username).toBe('tivdoc_worker_runtime.cpzrbidxftzqcfeqqusu');u.search='';
 const db=new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();let passed=false;
 const receipt:Record<string,unknown>={at:new Date().toISOString(),gitSha,dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),caseId:control.caseId,schema:135,rollbackOnly:true,providerCalls:0,seededAnswers:false};
 try{
  await db.connect();await db.query('begin');await db.query('select * from private.runtime_context_install($1,$2,$3)',[control.sid,control.jti,'retained-source-report-preflight']);await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[gitSha]);
  const head=(await db.query('select revision,input_sha256 from private.case_input_heads where case_id=$1',[control.caseId])).rows[0];
  const order=(await db.query("select id from private.product_orders where case_id=$1 and state='paid'",[control.caseId])).rows;expect(order).toHaveLength(1);
  const job:SourceJob={schema_version:'saved-case-work-v1',case_id:control.caseId,...head,mode:'draft'};
  const context:PostgresTransactionContext={transaction_id:control.sid,client:{async query(s){const r=await db.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),row_count:r.rowCount??0};}}};
  const result=await runSavedDevFinancialMonth({context,job,orderId:order[0].id});
  expect(result.run.schema_version).toBe('tivdoc-dev-financial-run-v2');expect(result.run.source.version_id).toBe(control.version);
  expect(result.run.extraction_provider).toBe('openai_live');
  expect(['missing_input','calculated']).toContain(result.run.calculation.state);
  if(result.run.calculation.state==='missing_input')expect(result.run.calculation.fields).toEqual(['work.regular_hours']);
  receipt.inputRevision=head.revision;receipt.runId=result.run.run_id;receipt.calculation=result.run.calculation;receipt.requestId=result.run.request_id;receipt.save=result.receipt;passed=true;
 }catch(error){receipt.error=error instanceof Error?error.message:'UNKNOWN';throw error;}
 finally{await db.query('rollback').catch(()=>{});await db.end();writeFileSync('../release-work/retained-source-report-preflight.json',JSON.stringify({...receipt,verdict:passed?'PASS':'FAIL'},null,2)+'\n');}
},90000);
