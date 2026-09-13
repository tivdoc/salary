import {expect,it,vi} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createDocumentTranscriptionTarget,documentTranscriptionQuestion,SALARY_TYPE_TRANSCRIPTION_ANSWERS} from '../reports/document-field-transcription';
import {postgresCaseAccessDb} from '../case-access/db';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {listCaseRequests,answerCaseRequest,editCaseRequest} from '../reports/case-requests';
import {openSavedTranscriptionRequests} from './saved-transcription-requests';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';
vi.mock('server-only',()=>({}));

/** Continues the retained, actually uploaded/live-OCR QA case. Only the two
 * necessary requests persist; all answer/entitlement/source perturbations roll
 * back. No customer session, OCR, report or finding is seeded. */
it.skipIf(process.env.TIVDOC_RETAINED_TRANSCRIPTION_DB_PROOF!=='1')('binds missing-field requests to the retained live source and protects answer/history boundaries',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('RETAINED_TRANSCRIPTION_DEV_ONLY');
 const caseId='87eb4418-7d9f-4b68-aa86-82be059295ac',version='2c9f4382-734a-42ba-9f17-ceb427acc836';
 const manifest=JSON.parse(readFileSync(`../release-work/dev-financial-live-owned-${caseId}.json`,'utf8'));
 const retained=manifest.cases.find((c:{id:string})=>c.id===caseId);expect(retained.identity).toBe('dcc1e30f-d516-47dd-a9d8-5365bfcd8b9a');expect(manifest.retained).toBe(true);
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const connection=(key:string)=>{const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:20000});};
 const owner=connection('TIVDOC_DEV_DATABASE_URL'),worker=connection('TIVDOC_WORKER_POSTGRES_URL'),web=connection('TIVDOC_WEB_POSTGRES_URL');
 const sid='retained.transcription:'+randomUUID(),jti=randomUUID(),tenant='saved-case:'+caseId,checks:string[]=[];
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 let enrolled=false,revoked=false,passed=false;
 const directory=`output/release-completion/dev-financial-live-flow/${caseId}/source-completions`;mkdirSync(directory,{recursive:true});
 const proof:Record<string,unknown>={caseId,version,gitSha,dirty:!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim(),schema:134,noProviderCalls:true,noSeededReport:true,noPersistedTestAnswers:true,productionChanged:false};
 const context:PostgresTransactionContext={transaction_id:sid,client:{async query(s){const r=await worker.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),row_count:r.rowCount??0};}}};
 const tx=async<T>(action:()=>Promise<T>)=>{await worker.query('begin');try{await worker.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'retained-transcription-proof']);const value=await action();await worker.query('commit');return value;}catch(e){await worker.query('rollback');throw e;}};
 const reject=async(db:pg.Client,sql:string,args:unknown[],code:string)=>{await db.query('savepoint rejected');await expect(db.query(sql,args)).rejects.toThrow(code);await db.query('rollback to savepoint rejected');};
 try{
  await Promise.all([owner.connect(),worker.connect(),web.connect()]);
  expect((await owner.query('select session_user principal,current_database() db')).rows[0]).toEqual({principal:'tivdoc_dev_migrator',db:'tivdoc_release_replay_20260907'});
  const head=async()=>{const h=(await owner.query('select revision,input_sha256 from private.case_input_heads where case_id=$1',[caseId])).rows[0];return {schema_version:'saved-case-work-v1',case_id:caseId,...h,mode:'draft'} as SourceJob;};
  const initial=await head();proof.head=initial;
  const row=(await owner.query("select c.result from private.case_extraction_checkpoints c join public.documents d on d.version_id=c.version_id and d.case_id=c.case_id where c.case_id=$1 and d.version_id=$2 and c.policy_version=$3 order by c.revision desc limit 1",[caseId,version,SAVED_EXTRACTION_POLICY])).rows[0];
  const checkpoint=row.result;expect(checkpoint).toEqual(JSON.parse(readFileSync(`output/release-completion/dev-financial-live-flow/${caseId}/missing-extraction.json`,'utf8')));
  const target=createDocumentTranscriptionTarget({checkpoint,policyVersion:SAVED_EXTRACTION_POLICY,subject:{kind:'salary_type'}}),question=documentTranscriptionQuestion(target);
  await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'retained.transcription.proof',$3,now()-interval '1 second',now()+interval '30 minutes',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);await owner.query('commit');enrolled=true;
  const openSql='select private.document_transcription_request_open($1,$2,$3,$4,$5) id';
  await worker.query('begin');await reject(worker,openSql,[caseId,initial.revision,initial.input_sha256,target,question.question],'TRANSCRIPTION_FORBIDDEN');await worker.query('rollback');
  const ids=await tx(async()=>{
   const ids=await openSavedTranscriptionRequests(context,initial,checkpoint);expect(ids).toHaveLength(2);expect(await openSavedTranscriptionRequests(context,initial,checkpoint)).toEqual(ids);
   await reject(worker,openSql,[caseId,initial.revision,initial.input_sha256,target,'שאלה הפוכה שאינה הקריאה המבוקשת'],'TRANSCRIPTION_TARGET_INVALID');
   await reject(worker,openSql,[randomUUID(),initial.revision,initial.input_sha256,target,question.question],'TRANSCRIPTION_FORBIDDEN');
   await reject(worker,openSql,[caseId,initial.revision+1,initial.input_sha256,target,question.question],'TRANSCRIPTION_SOURCE_CHANGED');
   return ids;
  });
  expect(await head()).toEqual(initial);checks.push('Scoped worker opens exactly two necessary requests once; unchanged input head; wrong actor/case/revision/question refused.');
  const store=postgresCaseAccessDb(web),rows=(await listCaseRequests(caseId,store,retained.identity)).filter(r=>ids.includes(r.id));
  expect(rows).toHaveLength(2);expect(rows.every(r=>r.source_current&&r.statement_month==='2026-06')).toBe(true);proof.requests=rows;
  const salary=rows.find(r=>r.field_crop==='salary_type')!;expect(salary.options).toEqual([...SALARY_TYPE_TRANSCRIPTION_ANSWERS]);
  const source=(await web.query('select public.case_request_document_source($1,$2,$3) source',[caseId,retained.identity,salary.id])).rows[0].source;
  expect(source).toMatchObject({version,sha256:checkpoint.input_sha256,page:1});
  await expect(web.query('select public.case_request_transcription_states($1,$2)',[caseId,randomUUID()])).rejects.toThrow('TRANSCRIPTION_FORBIDDEN');
  await expect(web.query('select public.case_request_document_source($1,$2,$3)',[caseId,randomUUID(),salary.id])).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  await web.query('begin');
  await reject(web,'select * from public.case_request_answer($1,$2,$3)',[salary.id,caseId,SALARY_TYPE_TRANSCRIPTION_ANSWERS[0]],'TRANSCRIPTION_FORBIDDEN');
  const answerInput={caseId,requestId:salary.id,identityId:retained.identity,answer:SALARY_TYPE_TRANSCRIPTION_ANSWERS[0]};
  expect((await answerCaseRequest(answerInput,store))?.id).toBe(salary.id);expect((await answerCaseRequest(answerInput,store))?.id).toBe(salary.id);
  expect(await editCaseRequest({...answerInput,answer:SALARY_TYPE_TRANSCRIPTION_ANSWERS[1],expectedRevision:1,kind:'correction'},store)).toBe(2);
  const versions=(await web.query('select * from public.case_request_revision_list($1)',[caseId])).rows.find(r=>r.request_id===salary.id);expect(versions.answer_revision).toBe(2);
  await web.query('rollback');
  expect(await head()).toEqual(initial);expect((await owner.query('select count(*)::int n from private.case_request_answer_versions where request_id=any($1::uuid[])',[ids])).rows[0].n).toBe(0);
  checks.push('Actual web RPC original/retry/correction works with identified actor and version ledger in rollback-only probe; foreign/unidentified reads and writes rejected; no test answer persisted.');
  await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
  await owner.query("update private.order_entitlements set state='revoked' where order_id=$1",[retained.orderId]);
  expect((await owner.query('select private.document_transcription_current($1,$2) current',[caseId,target])).rows[0].current).toBe(false);await owner.query('rollback');
  await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);await owner.query("update public.documents set period_month='2026-07-01' where id=$1",[checkpoint.product_document_id]);
  expect((await owner.query('select private.document_transcription_current($1,$2) current',[caseId,target])).rows[0].current).toBe(false);await owner.query('rollback');
  checks.push('Revoked purchased topic and changed source month each invalidate the target; rollback preserves paid fixture and source.');
  passed=true;
 }finally{
  await web.query('rollback').catch(()=>{});await worker.query('rollback').catch(()=>{});await owner.query('rollback').catch(()=>{});
  if(enrolled){await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);const result=await owner.query('update public.product_identity_sessions set revoked_at=clock_timestamp() where sid=$1 and tenant_id=$2 and revoked_at is null',[sid,tenant]);expect(result.rowCount).toBe(1);await owner.query('commit');revoked=true;}
  writeFileSync(directory+'/request-db-proof.json',JSON.stringify({...proof,checks,verdict:passed&&revoked?'PASS':'FAIL',machineRevoked:revoked,at:new Date().toISOString()},null,2)+'\n');
  await Promise.all([owner.end(),worker.end(),web.end()]);
 }
},90000);
