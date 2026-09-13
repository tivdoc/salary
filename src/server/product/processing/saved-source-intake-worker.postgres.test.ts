import {expect,it,vi} from 'vitest';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,writeFileSync} from 'node:fs';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {PostgresJobsOutboxAuditRepository} from '@/server/platform/persistence/postgres/runtime/jobs-outbox-audit';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {seedSourceKindFixture,revokeSourceKindFixture} from './fixtures/source-kind-postgres';
import {savedLegacySourceIntake,legacySourceIntakeRequests} from './saved-legacy-source-intake';
import {admitSavedSource} from './saved-admission';
import {admitSavedExtractionLease} from './saved-extraction-worker';
import {dispatchCaseInput,sourceJobSchema,type SourceJob} from './source-dispatch';
import {saveExtractionCheckpoint} from './extraction-checkpoint';
import {SavedCaseSnapshot} from './saved-snapshot';
vi.mock('server-only',()=>({}));

// Explicit isolated-DEV integration test. Only server-only is mocked; every
// production statement runs against the actual login role. No migrations,
// provider, hosted Storage, analysis, scheduler or historical receipt rewrite.
it.skipIf(process.env.TIVDOC_SOURCE_KIND_DB_PROOF!=='1')('routes authenticated corrected payslip kinds with real worker/web roles',async()=>{
 if(process.env.VERCEL||process.env.VERCEL_ENV||process.env.NODE_ENV!=='test')throw Error('SOURCE_KIND_DB_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');
 const env=readDevEnvFile(),sha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
 const client=(key:string)=>{
  const url=new URL(env.get(key)!);
  if(url.pathname!=='/tivdoc_release_replay_20260907'||url.hostname!=='aws-0-eu-central-1.pooler.supabase.com'||!url.username.endsWith('.cpzrbidxftzqcfeqqusu'))throw Error('SOURCE_KIND_EXACT_DEV_REQUIRED');
  url.search='';return new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});
 };
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 type Fixture=Awaited<ReturnType<typeof seedSourceKindFixture>>;
 const fixtures:Fixture[]=[],checks:string[]=[],revoked:string[]=[],statementNames=new Set<string>();
 const runId=randomUUID();let passed=false,primaryFailure:unknown,lastStatement:string|null=null;
 const cleanupFailures:{stage:string;case_id?:string;error:unknown}[]=[];
 const failure=(error:unknown)=>({name:error instanceof Error?error.name:'UnknownError',
  message:String(error instanceof Error?error.message:error).slice(0,1000),
  code:error&&typeof error==='object'&&'code'in error?String(error.code):null});
 async function transaction<T>(db:pg.Client,operation:(context:PostgresTransactionContext)=>Promise<T>,f?:Fixture,commit=false){
  await db.query('begin');
  try{
   await db.query("set local lock_timeout='5s'");
   if(f){await db.query('select * from private.runtime_context_install($1,$2,$3)',[f.sid,f.jti,`source-kind-proof:${runId}`]);await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[sha]);}
   const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(s){
    // Match NodePostgresClientAdapter: pg enforces one SQL text per prepared
    // name for the entire connection, including later transactions/fixtures.
    lastStatement=s.name;statementNames.add(s.name);const result=await db.query({name:s.name,text:s.text,values:[...s.values]});
    return {rows:result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,value instanceof Date?value.toISOString():value]))),row_count:result.rowCount??0};
   }}};
   const result=await operation(context);await db.query(commit?'commit':'rollback');return result;
  }catch(error){await db.query('rollback').catch(rollbackError=>{cleanupFailures.push({stage:'transaction_rollback',error:rollbackError});});throw error;}
 }
 async function currentJob(f:Fixture):Promise<SourceJob>{
  const row=(await owner.query("select h.revision,h.input_sha256,d.processing_profile,d.authority_dependency_sha256 from private.case_input_heads h join private.case_analysis_dispatch d on d.case_id=h.case_id and d.revision=h.revision and d.mode='draft' where h.case_id=$1",[f.caseId])).rows[0];
  return sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:f.caseId,mode:'draft',...row});
 }
 async function lease(context:PostgresTransactionContext,f:Fixture,job:SourceJob){
  await admitSavedSource(context,job);
  const dispatched=await dispatchCaseInput(context,{caseId:f.caseId,tenantId:f.tenant,mode:'draft',liveEnabled:false,nowMs:Date.now()});
  expect(dispatched).not.toBeNull();
  const queue=new PostgresJobsOutboxAuditRepository(context,f.tenant,f.caseId),workerId=`synthetic-kind:${runId}`;
  const claimed=(await queue.claim(workerId,Date.now(),120000))[0];
  expect(claimed.job_id).toBe(dispatched!.job_id);
  await queue.start(claimed.job_id,workerId,claimed.fencing_token,Date.now());
  return {jobId:claimed.job_id,workerId,fencingToken:claimed.fencing_token,versionId:f.versionId};
 }
 const immutable=async(f:Fixture,revision:number)=>(await owner.query(`select jsonb_build_object(
  'documents',(select jsonb_agg(to_jsonb(d)) from public.documents d where d.case_id=$1),
  'versions',(select jsonb_agg(to_jsonb(d)) from public.document_versions d where d.case_id=$1),
  'receipts',(select jsonb_agg(to_jsonb(s)) from private.legacy_paid_scope_admissions s where s.case_id=$1),
  'original_journals',(select jsonb_agg(to_jsonb(v) order by v.revision) from private.case_input_versions v where v.case_id=$1 and v.revision<=$2),
  'original_answers',(select jsonb_agg(to_jsonb(a) order by a.request_id) from private.case_request_answer_versions a join public.case_requests r on r.id=a.request_id where r.case_id=$1 and a.revision=1),
  'case_month',(select check_period_month from public.cases where id=$1)) state`,[f.caseId,revision])).rows[0].state;
 try{
  await Promise.all([owner.connect(),worker.connect(),web.connect()]);
  for(const [db,role] of [[owner,'tivdoc_dev_migrator'],[worker,'tivdoc_worker_runtime'],[web,'tivdoc_web_runtime']] as const){
   expect((await db.query('select current_database() database,session_user principal')).rows[0]).toEqual({database:'tivdoc_release_replay_20260907',principal:role});
  }
  for(const kind of ['attendance','contract'] as const){
   const f=await seedSourceKindFixture(owner,kind);fixtures.push(f);
   // Record the locally generated one-page PDF through the protected port.
   await transaction(worker,async()=>{await worker.query('select private.document_physical_pages_record($1,$2,$3,$4,$5,$6,1)',[f.caseId,f.documentId,f.versionId,f.hash,f.size,'application/pdf']);},f,true);
   const initial=await currentJob(f);
   const requestId=await transaction(worker,async()=>{
    const raw=(await worker.query('select private.legacy_source_intake_context($1,$2,$3) context',[f.caseId,initial.revision,initial.input_sha256])).rows[0].context;
    const requests=legacySourceIntakeRequests(savedLegacySourceIntake(raw));expect(requests).toHaveLength(1);
    const request=requests[0];expect(request.kind).toBe('document_field');
    return (await worker.query('select private.document_field_request_open($1,$2,$3,$4,$5) id',[f.caseId,initial.revision,initial.input_sha256,request.target,request.question.question])).rows[0].id as string;
   },f,true);
   const answer={v:1,action:'correct',value:{document_kind:'payslip',period:{from:'2026-06-01',to:'2026-06-30'},page:1,source_label:'SYNTHETIC ONLY - June 2026 payslip'}};
   await expect(transaction(web,async()=>web.query('select public.case_request_answer_identified($1,$2,$3,$4)',[requestId,f.caseId,randomUUID(),JSON.stringify(answer)]))).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
   await transaction(web,async()=>{expect((await web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[requestId,f.caseId,f.identityId,JSON.stringify(answer)])).rowCount).toBe(1);},undefined,true);
   const job=await currentJob(f),original=await immutable(f,job.revision);
   expect(job.processing_profile).toBe('qualified_ai_v1');expect(job.revision).toBeGreaterThan(initial.revision);
   const machine=normalizedPayslipExtractionSchema.parse({...buildSyntheticCaseFixture({fixture_id:`source-kind-${runId}-${kind}`,mode:'real'}).stored.extractions[0],document_id:f.versionId,
    fields:[{candidate_id:randomUUID(),field:'salary_period',raw_value:'June 2026',normalized_value:{year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'},confidence:.99,
     source:{document_id:f.versionId,page:1,text_fragment:'SYNTHETIC ONLY - June 2026 payslip'},extraction_method:'fixture',warning_flags:[]}],additional_components:[]});
   const result={final_extraction:machine,first_pass:{normalized_extraction:machine}};
   // Deliberately synthetic normalized checkpoint; no provider receipt claim.
   const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:f.caseId,product_document_id:f.documentId,version_id:f.versionId,input_sha256:f.hash,expected_month:'2026-06',period_mismatch:false,requires_confirmation:false,result_sha256:canonicalSha256(result),run:{result}} as Parameters<typeof saveExtractionCheckpoint>[2];
   await transaction(worker,async context=>{
    const input=await lease(context,f,job);
    await expect(admitSavedExtractionLease(context,{...input,workerId:'foreign-worker'})).rejects.toThrow('SAVED_JOB_FENCE');
    await expect(admitSavedExtractionLease(context,{...input,versionId:randomUUID()})).rejects.toThrow('SAVED_EXTRACTION_SOURCE_SCOPE');
    const admitted=await admitSavedExtractionLease(context,input);
    expect(admitted.document).toMatchObject({id:f.documentId,version_id:f.versionId,content_sha256:f.hash,document_type:'payslip',stored_document_type:kind});
    expect(admitted.month).toBe('2026-06');expect(admitted.sourcePeriodEvidence?.origin).toBe('customer_document_reading');
    await saveExtractionCheckpoint(context,job,checkpoint);await saveExtractionCheckpoint(context,job,checkpoint);
    const snapshot=await new SavedCaseSnapshot(context,job,'2026-06').read();
    expect(snapshot.documents).toHaveLength(1);expect(snapshot.documents[0]).toMatchObject({document_id:f.versionId,document_type:'payslip',document_period:null});
    expect(snapshot.extractions).toHaveLength(1);expect(snapshot.extractions[0].fields).toEqual(machine.fields);
    expect(snapshot.non_payslip_evidence??[]).toEqual([]);
    expect((await worker.query('select count(*)::integer n from private.case_extraction_checkpoints where case_id=$1 and revision=$2',[f.caseId,job.revision])).rows[0].n).toBe(1);
   },f);
   checks.push(`${kind}: identified web answer; actual worker admission/checkpoint retry/snapshot; foreign identity/worker/version denied; exactly one payslip and zero duplicate non-payslip evidence`);
   // Real append-only correction creates a new head. The original reading and
   // original upload/receipt remain byte-for-byte unchanged.
   const corrected={...answer,value:{...answer.value,document_kind:'attendance'}};
   await transaction(web,async()=>{expect((await web.query("select public.case_request_edit($1,$2,$3,$4,1,'correction') revision",[f.caseId,requestId,f.identityId,JSON.stringify(corrected)])).rows[0].revision).toBe(2);},undefined,true);
   await expect(transaction(worker,context=>saveExtractionCheckpoint(context,job,checkpoint),f)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
   const correctedJob=await currentJob(f);expect(correctedJob.revision).toBeGreaterThan(job.revision);
   await transaction(worker,async context=>{
    const input=await lease(context,f,correctedJob);
    await expect(admitSavedExtractionLease(context,input)).rejects.toThrow('SAVED_EXTRACTION_SOURCE_INTAKE_REQUIRED');
    await expect(saveExtractionCheckpoint(context,correctedJob,checkpoint)).rejects.toThrow(/EXTRACTION_CHECKPOINT_SOURCE_MISMATCH|SAVED_EXTRACTION_PERIOD_EVIDENCE/);
    await expect(new SavedCaseSnapshot(context,correctedJob,'2026-06').read()).rejects.toThrow('SAVED_PAYSLIP_REQUIRED');
   },f);
   expect(await immutable(f,job.revision)).toEqual(original);
   expect((await owner.query('select count(*)::integer n from private.case_extraction_checkpoints where case_id=$1',[f.caseId])).rows[0].n).toBe(0);
   checks.push(`${kind}: current attendance correction blocks payroll; stale head blocks checkpoint; original source/version/receipt/first answer unchanged; worker test writes rolled back`);
  }
  passed=true;
 }catch(error){primaryFailure=error;}
 finally{
  await Promise.allSettled([owner.query('rollback'),worker.query('rollback'),web.query('rollback')]);
  for(const f of fixtures){try{await revokeSourceKindFixture(owner,f);revoked.push(f.caseId);}catch(error){cleanupFailures.push({stage:'fixture_revoke',case_id:f.caseId,error});}}
  try{
   await Promise.allSettled([owner.end(),worker.end(),web.end()]);
   const directory='../release-work/source-kind-postgres';mkdirSync(directory,{recursive:true});
   writeFileSync(`${directory}/${runId}.private.json`,JSON.stringify({schema_version:'source-kind-postgres-proof-v1',result:passed&&cleanupFailures.length===0&&revoked.length===fixtures.length?'passed':'failed',tested_head:sha,
    primary_failure:primaryFailure===undefined?null:{...failure(primaryFailure),last_statement:lastStatement},cleanup_failures:cleanupFailures.map(item=>({...item,error:failure(item.error)})),
    database:'tivdoc_release_replay_20260907',checks,statement_names:[...statementNames].sort(),provider_calls:0,storage_calls:0,analysis_runs:0,
    fixture_configuration:'SQL dispatch profile metadata only; not validated executable/legal configuration',
    retained_scope:'Synthetic QA cases, local-PDF upload metadata/hash, physical page receipts, legacy fixture receipt/snapshot, identified answer history, source journals and fixture enrollment/session history. Per-case revoked flags and cleanup_failures report revocation outcome. Worker lifecycle/job/checkpoint writes rolled back. No real cases or prior evidence receipts modified.',
    retained:fixtures.map(f=>({case_id:f.caseId,stored_kind:f.kind,version_id:f.versionId,receipt_sha256:f.scope.receipt_sha256,source_sha256:f.hash,revoked:revoked.includes(f.caseId)}))},null,2)+'\n',{flag:'wx',mode:0o600});
  }catch(error){cleanupFailures.push({stage:'receipt_write',error});}
 }
 if(primaryFailure!==undefined)throw primaryFailure;
 if(cleanupFailures.length)throw new AggregateError(cleanupFailures.map(item=>item.error),'SOURCE_KIND_PROOF_CLEANUP_FAILED');
},180000);
