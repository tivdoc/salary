import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {PDFDocument} from 'pdf-lib';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {PostgresJobsOutboxAuditRepository} from '@/server/platform/persistence/postgres/runtime/jobs-outbox-audit';
import {OpenAiPayslipV2PassExtractor} from '@/server/engine/extraction/providers/openai/v2-adapter';
import type {OpenAiPayslipV2StructuredOutput} from '@/server/engine/extraction/providers/openai/v2-schema';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {offerSnapshot} from '../orders/contracts';
import {runSavedWorkerMonth} from './saved-worker';
import {admitSavedSource,savedCaseTenant} from './saved-admission';
import {dispatchCaseInput,type SourceJob} from './source-dispatch';
import {runSavedWorkerExtraction,recordSavedExtractionResult,type SavedWorkerTransactions} from './saved-extraction-worker';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_SAVED_EXTRACTION_DB_PROOF!=='1')('durably composes admitted worker, actual extraction adapter, concurrent receipt recovery and canonical draft',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw new Error('SAVED_DB_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts');const env=readDevEnvFile();
 function client(key:string){const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000});}
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),peer=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const fixture=buildSyntheticCaseFixture({fixture_id:`extraction-${randomUUID()}`,mode:'real'}),caseId=fixture.command.case_id,otherId=randomUUID(),documentId=randomUUID(),orderId=randomUUID();
 const tenant=savedCaseTenant(caseId),sid=`extraction-proof:${randomUUID()}`,jti=randomUUID(),checks:string[]=[];
 const pdf=await PDFDocument.create();pdf.addPage().drawText('Synthetic payslip January 2025');const bytes=await pdf.save();
 const doc={...fixture.stored.documents[0],size_bytes:bytes.length,content_sha256:createHash('sha256').update(bytes).digest('hex')},offer=offerSnapshot('initial');
 const migration='20260908013000_saved_extraction_invocations.sql',workerId='synthetic-extraction-worker';
 writeFileSync(`../release-work/saved-extraction-owned-${caseId}.json`,JSON.stringify({caseIds:[caseId,otherId],tenant,sid,scope:'Synthetic extraction proof; isolated DEV only'}));
 let seeded=false,cleaned=false,activeTransactions=0,passes=0,failCheckpoint=true,expireBeforeDispatch=false;
 const transactions=(db:pg.Client):SavedWorkerTransactions=>async operation=>{
  await db.query('begin');activeTransactions++;
  try{
   await db.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'saved-extraction-proof']);
   await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()]);
   const context:PostgresTransactionContext={transaction_id:`${sid}:${randomUUID()}`,client:{async query(s){
    if(s.name==='extraction_dispatch_once'&&expireBeforeDispatch){expireBeforeDispatch=false;await db.query("update public.engine_durable_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where job_id=$1",[jobId]);}
    if(s.name==='checkpoint_insert'&&failCheckpoint)throw new Error('INJECTED_CHECKPOINT_FAILURE');
    const r=await db.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),row_count:r.rowCount??0};
   }}};
   const result=await operation(context);await db.query('commit');return result;
  }catch(error){await db.query('rollback');throw error;}finally{activeTransactions--;}
 };
 let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
 const empty={rate_candidates:[],amount_candidates:[]};
 const output:OpenAiPayslipV2StructuredOutput={detected_document_type:'payslip',document_quality:'high',page_count:1,rotation_degrees:0,source_resolution_dpi:null,
  salary_type:{documented_value:null,documented_raw_value:null,documented_confidence:'low',documented_evidence:{page:1,region:'header',source_label:null},inferred_value:null,inferred_confidence:'low',inference_basis:[],warnings:[]},
  generic_fields:[{field:'salary_period',candidates:[{raw_value:'01/2025',confidence:'high',evidence:{page:1,region:'header',source_label:'Synthetic period'},warnings:[]}]}],
  payroll_rows:[],totals:{visible:false,gross_candidates:[],deductions_candidates:[],net_candidates:[]},pension:{visible:false,base_candidates:[],employee:empty,employer:empty,severance:empty},earnings_components_complete:false,warnings:[]};
 const extractor=new OpenAiPayslipV2PassExtractor({apiKey:'synthetic-no-network',model:'synthetic-injected-model',timeoutMs:1000},{transport:{async parse(){
  expect(activeTransactions).toBe(0);passes++;
  if(passes===1){started();await held;}
  return {id:`synthetic-response-${passes}`,status:'completed',outputParsed:output,usage:null};
 }},log:()=>{}});
 const storage={async download(path:string){expect(activeTransactions).toBe(0);expect(path).toBe(`cases/${caseId}/versions/${doc.document_id}.pdf`);return {data:new Blob([Buffer.from(bytes)]),error:null};}};
 let job:SourceJob,jobId='',fence=0;
 const enqueue=async()=>transactions(worker)(async context=>{
  const head=(await owner.query('select * from private.case_input_heads where case_id=$1',[caseId])).rows[0];
  job={schema_version:'saved-case-work-v1',case_id:caseId,revision:head.revision,input_sha256:head.input_sha256,mode:'draft'};
  await admitSavedSource(context,job);
  const dispatched=await dispatchCaseInput(context,{caseId,tenantId:tenant,mode:'draft',liveEnabled:false,nowMs:Date.now()});
  const queue=new PostgresJobsOutboxAuditRepository(context,tenant,caseId),claimed=(await queue.claim(workerId,Date.now(),240000))[0];
  expect(claimed.job_id).toBe(dispatched!.job_id);await queue.start(claimed.job_id,workerId,claimed.fencing_token,Date.now());jobId=claimed.job_id;fence=claimed.fencing_token;
 });
 const args=()=>({transactions:transactions(worker),storage,extractor,providerEnabled:true,jobId,workerId,fencingToken:fence,versionId:doc.document_id});
 try{
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect()]);
  if(process.env.TIVDOC_APPLY_EXTRACTION_INVOCATIONS==='1'){await owner.query('begin');await owner.query(readFileSync('supabase/migrations/'+migration,'utf8'));await owner.query('commit');}
  await owner.query('begin');
  for(const id of [caseId,otherId])await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,check_period_month) values($1,'Synthetic extraction proof','qa@example.invalid','0500000000',true,'under_review','verified','2025-01-01')",[id]);
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-01',$4,'synthetic.pdf','application/pdf',$5,$6,'2025-01-01')",[documentId,caseId,doc.document_id,`cases/${caseId}/versions/${doc.document_id}.pdf`,doc.size_bytes,doc.content_sha256]);
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-01',$4,'other-synthetic.pdf','application/pdf',$5,$6,'2025-01-01')",[randomUUID(),otherId,randomUUID(),`cases/${otherId}/versions/other.pdf`,doc.size_bytes,doc.content_sha256]);
  // Explicit synthetic paid order; no provider receipt is asserted. Source
  // capture itself is real and never patched or rehashed by the test.
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2025-01-01','2025-01-01',999,'ILS',$3,$4,$5,$6,'paid',now())",[orderId,caseId,offer,offer.sha256,fixture.command.requested_topics.slice(0,3),offer.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[orderId]);
  await owner.query("insert into public.questionnaire_responses(case_id,payload,suspected_issue) values($1,$2,'')",[caseId,{salaryType:'hourly',employmentStartMonth:'2024-07'}]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.saved.worker',$3,now()-interval '1 minute',now()+interval '15 minutes',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);
  await owner.query('commit');seeded=true;
  await enqueue();
  await expect(runSavedWorkerExtraction({...args(),workerId:'foreign-worker'})).rejects.toThrow('SAVED_JOB_FENCE');
  expect(passes).toBe(0);checks.push('actual paid-source and worker lease admission rejects another worker before provider dispatch');
  expireBeforeDispatch=true;await expect(runSavedWorkerExtraction(args())).rejects.toThrow('SAVED_JOB_FENCE');expect(passes).toBe(0);
  checks.push('lease expiry after admission is rejected by the atomic dispatch SQL before any external call');
  const running=runSavedWorkerExtraction(args());const outcome=running.then(value=>({value,error:null}),error=>({value:null,error}));await Promise.race([began,outcome.then(value=>{throw value.error??new Error('PROVIDER_DID_NOT_START');})]);
  await owner.query('begin');await owner.query('select id from public.cases where id=$1 for update nowait',[caseId]);await owner.query('rollback');
  await expect(runSavedWorkerExtraction({...args(),transactions:transactions(peer)})).rejects.toThrow('SAVED_EXTRACTION_OUTCOME_PENDING');
  expect(passes).toBe(1);release();expect((await outcome).error?.message).toBe('INJECTED_CHECKPOINT_FAILURE');
  checks.push('real adapter verifies PDF bytes outside DB locks; a concurrent independent worker cannot invoke the pending provider again');
  const counts=await transactions(worker)(async()=>({receipts:(await worker.query('select count(*)::int n from private.case_extraction_invocations where case_id=$1 and result is not null',[caseId])).rows[0].n,checkpoints:(await worker.query('select count(*)::int n from private.case_extraction_checkpoints where case_id=$1',[caseId])).rows[0].n}));
  expect(counts).toEqual({receipts:1,checkpoints:0});expect(passes).toBeGreaterThanOrEqual(1);expect(passes).toBeLessThanOrEqual(2);
  checks.push('provider receipt commits before injected checkpoint rollback; at most the existing two extraction passes execute');
  const before=passes;failCheckpoint=false;const recovered=await runSavedWorkerExtraction(args());expect(recovered.reused).toBe(true);expect(passes).toBe(before);
  const replay=await runSavedWorkerExtraction({...args(),transactions:transactions(peer)});expect(replay.result).toEqual(recovered.result);expect(passes).toBe(before);
  checks.push('retry through a second actual connection restores the checkpoint and returns the same immutable result without another provider pass');
  const invocation=(await transactions(worker)(async()=>worker.query('select * from private.case_extraction_invocations where case_id=$1',[caseId]))).rows[0];
  await transactions(worker)(context=>recordSavedExtractionResult(context,invocation.invocation_id,invocation.result));
  await expect(transactions(worker)(async()=>worker.query('update private.case_extraction_invocations set result=result where invocation_id=$1',[invocation.invocation_id]))).rejects.toThrow('SAVED_EXTRACTION_RECEIPT_IMMUTABLE');
  await expect(web.query('select * from private.case_extraction_invocations')).rejects.toThrow(/permission denied/);
  expect((await transactions(peer)(async()=>peer.query('select * from private.case_extraction_invocations where case_id=$1',[otherId]))).rows).toHaveLength(0);
  await expect(transactions(peer)(async()=>peer.query("insert into private.case_extraction_invocations(invocation_id,case_id,version_id,policy_version,expected_month,input_sha256,source_revision,job_id,fencing_token) values($1,$2,$3,'test','2025-01',$4,1,'foreign',1)",[randomUUID(),otherId,randomUUID(),'a'.repeat(64)]))).rejects.toThrow(/row-level security/);
  checks.push('receipt replay is read-only; DB trigger blocks rewrites, web role has no table access, and actual worker RLS refuses another case');
  const oldArgs=args();await owner.query("update public.questionnaire_responses set payload=payload||'{\"typicalHoursPerDay\":8}'::jsonb where case_id=$1",[caseId]);
  await expect(runSavedWorkerExtraction(oldArgs)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');await enqueue();
  const changed=await runSavedWorkerExtraction(args());expect(changed.reused).toBe(true);expect(changed.invocationId).toBeNull();expect(passes).toBe(before);
  checks.push('changed questionnaire rejects the old job; the new pinned source reuses exact same-file/month/policy evidence without OCR expense');
  await transactions(worker)(async context=>{
   await worker.query('savepoint before_analysis');const analysis=await runSavedWorkerMonth({context,job:job!,orderId,month:'2025-01'});
   expect(analysis.stages).toHaveLength(7);expect(analysis.bundle?.topic_results).toHaveLength(3);expect(analysis.bundle?.topic_results.every(t=>t.amount===null)).toBe(true);
   await worker.query('rollback to savepoint before_analysis');
  });
  checks.push('real extraction adapter checkpoint reaches all seven canonical draft stages for the three purchased topics; unconfirmed input never publishes amounts');
  expect((await owner.query('select status,payment_status from public.cases where id=$1',[caseId])).rows[0]).toEqual({status:'under_review',payment_status:'verified'});
  checks.push('case and payment state remain unchanged; no customer projection or external provider delivery is performed');
 }finally{
  release();await Promise.all([owner.query('rollback').catch(()=>{}),worker.query('rollback').catch(()=>{}),peer.query('rollback').catch(()=>{})]);
  if(seeded){
   await transactions(worker)(async()=>{await worker.query("update public.engine_durable_jobs set state='cancelled',cancellation_requested=true,lease_owner=null,lease_expires_at=null,revision=revision+1 where tenant_id=$1 and state in ('queued','leased','running','retry_wait')",[tenant]);});
   await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
   await owner.query('update public.product_identity_sessions set revoked_at=now() where sid=$1 and tenant_id=$2',[sid,tenant]);
   const removed=await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic extraction proof'",[[caseId,otherId]]);expect(removed.rowCount).toBe(2);await owner.query('commit');cleaned=true;
  }
  writeFileSync('docs/release-evidence/P05-saved-extraction-worker-db.json',JSON.stringify({verdict:checks.length===9?'PASS':'FAIL',checks,database:'tivdoc_release_replay_20260907',migration,migration_sha256:createHash('sha256').update(readFileSync('supabase/migrations/'+migration)).digest('hex'),authorization:'actual worker and peer logins with provisioned synthetic SID/JTI; no fixture RLS policies',syntheticCasesRemoved:cleaned?2:0,machineSessionRevoked:cleaned,syntheticCanonicalTenantRetained:tenant,retainedScope:'Canonical identity/lifecycle and cancelled job history intentionally retained; monthly analysis rolled back. Product cases, documents, invocations and checkpoints cascade-cleaned.',providerTransport:'injected deterministic structured responses; real adapter and PDF byte/hash checks, no network provider or hosted Storage',providerPasses:passes,customerPublication:false,productionChanged:false},null,2)+'\n');
  await Promise.all([owner.end(),worker.end(),peer.end(),web.end()]);
 }
},240000);
