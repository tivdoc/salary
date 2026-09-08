import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {PDFDocument} from 'pdf-lib';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {employmentSnapshotSchema} from '@/engine/facts/snapshot';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {PostgresJobsOutboxAuditRepository} from '@/server/platform/persistence/postgres/runtime/jobs-outbox-audit';
import {OpenAiPayslipV2PassExtractor} from '@/server/engine/extraction/providers/openai/v2-adapter';
import type {OpenAiPayslipV2StructuredOutput} from '@/server/engine/extraction/providers/openai/v2-schema';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {offerSnapshot} from '../orders/contracts';
import {legacyFullOfferFixture} from '../orders/fixtures/legacy-offer';
import {runSavedWorkerMonth} from './saved-worker';
import {runSavedDraftJob} from './saved-job-runner';
import {claimSavedDraftJob,recordSavedJobFailure,runSavedDraftOnce} from './saved-job-runtime';
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
 const storageProof=process.env.TIVDOC_SAVED_REAL_STORAGE_PROOF==='1',storageChecks:string[]=[];
 const runtimeProof=process.env.TIVDOC_SAVED_RUNTIME_DB_PROOF==='1'||storageProof,runtimeChecks:string[]=[];
 const runnerProof=process.env.TIVDOC_SAVED_RUNNER_DB_PROOF==='1'||runtimeProof,runnerChecks:string[]=[];
 const otherVersion=randomUUID(),otherTenant=savedCaseTenant(otherId),otherSid=`storage-proof:${randomUUID()}`,otherJti=randomUUID();
 const tenant=savedCaseTenant(caseId),sid=`extraction-proof:${randomUUID()}`,jti=randomUUID(),checks:string[]=[];
 const pdf=await PDFDocument.create();pdf.addPage().drawText('Synthetic payslip January 2025');const bytes=await pdf.save();
 const otherPdf=await PDFDocument.create();otherPdf.addPage().drawText('Second synthetic case January 2025');const otherBytes=await otherPdf.save();
 const doc={...fixture.stored.documents[0],size_bytes:bytes.length,content_sha256:createHash('sha256').update(bytes).digest('hex')},offer=offerSnapshot('initial');
 const migration='20260908013000_saved_extraction_invocations.sql',workerId='synthetic-extraction-worker';
 const physical=[{path:`cases/${caseId}/versions/${doc.document_id}.pdf`,bytes,sha:doc.content_sha256},{path:`cases/${otherId}/versions/${otherVersion}.pdf`,bytes:otherBytes,sha:createHash('sha256').update(otherBytes).digest('hex')}];
 const credentials=storageProof?JSON.parse(readFileSync(process.env.TIVDOC_SAVED_STORAGE_CREDENTIALS_FILE??'','utf8')) as Record<string,string>:null;
 if(credentials&&(credentials.NEXT_PUBLIC_SUPABASE_URL!=='https://cpzrbidxftzqcfeqqusu.supabase.co'||typeof credentials.SUPABASE_SERVICE_ROLE_KEY!=='string'))throw new Error('SAVED_STORAGE_PROOF_TARGET');
 const remote=credentials?createClient(credentials.NEXT_PUBLIC_SUPABASE_URL,credentials.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}):null;
 const bucket=remote?.storage.from('salary-documents');const uploaded:string[]=[];let storageCleaned=false,otherSessionCreated=false;
 writeFileSync(`../release-work/saved-extraction-owned-${caseId}.json`,JSON.stringify({caseIds:[caseId,otherId],tenant,sid,otherTenant,otherSid,physical:physical.map(({path,sha})=>({path,sha})),scope:'Synthetic extraction proof; isolated DEV only'}));
 let requestIdentity:string|undefined;
 let seeded=false,cleaned=false,activeTransactions=0,passes=0,failCheckpoint=true,expireBeforeDispatch=false;
 let heartbeatCount=0,expireAtHeartbeat=0,failFinalizer=false,failRuntimeJournal=false;
 let inFlight:Promise<unknown>|null=null;
 const transactions=(db:pg.Client,auth={sid,jti}):SavedWorkerTransactions=>async operation=>{
  await db.query('begin');activeTransactions++;
  try{
   await db.query('select * from private.runtime_context_install($1,$2,$3)',[auth.sid,auth.jti,'saved-extraction-proof']);
   await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()]);
   const context:PostgresTransactionContext={transaction_id:`${sid}:${randomUUID()}`,client:{async query(s){
    if(s.name==='extraction_dispatch_once'&&expireBeforeDispatch){expireBeforeDispatch=false;await db.query("update public.engine_durable_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where job_id=$1",[jobId]);}
    if(s.name==='saved_runner_journal'&&failRuntimeJournal)throw new Error('INJECTED_TRANSIENT_PRIVATE_PROVIDER_DETAIL');
    if(s.name==='checkpoint_insert'&&failCheckpoint)throw new Error('INJECTED_CHECKPOINT_FAILURE');
    if(s.name==='saved_runner_heartbeat'){heartbeatCount++;if(heartbeatCount===expireAtHeartbeat)await db.query("update public.engine_durable_jobs set lease_expires_at=clock_timestamp()-interval '1 second' where job_id=$1",[jobId]);}
    if(s.name==='saved_job_complete_atomic'&&failFinalizer){failFinalizer=false;throw new Error('INJECTED_FINALIZER_FAILURE');}
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
  if(!storageProof)expect(activeTransactions).toBe(0);
  else{await owner.query('begin');await owner.query('select id from public.cases where id=any($1::uuid[]) for update nowait',[[caseId,otherId]]);await owner.query('rollback');}
  passes++;
  if(passes===1){started();await held;}
  return {id:`synthetic-response-${passes}`,status:'completed',outputParsed:output,usage:null};
 }},log:()=>{}});
 const storage={async download(path:string){
  if(!bucket){expect(activeTransactions).toBe(0);expect(path).toBe(physical[0].path);return {data:new Blob([Buffer.from(bytes)]),error:null};}
  const expected=physical.find(p=>p.path===path);if(!expected)throw new Error('SAVED_STORAGE_PROOF_SCOPE');
  const downloaded=await bucket.download(path);if(downloaded.error||!downloaded.data)throw new Error('SAVED_STORAGE_PROOF_DOWNLOAD_FAILED');
  expect(createHash('sha256').update(Buffer.from(await downloaded.data.arrayBuffer())).digest('hex')).toBe(expected.sha);
  return {data:downloaded.data,error:null};
 }};
 let job:SourceJob,jobId='',fence=0;
 const enqueue=async()=>{
  if(runtimeProof){
   const input={caseId,workerId,leaseMs:60000};
   const claims=await Promise.all([transactions(worker)(c=>claimSavedDraftJob(c,input)),transactions(peer)(c=>claimSavedDraftJob(c,input))]);
   expect(claims.map(c=>c.state).sort()).toEqual(['busy','claimed']);
   const claimed=claims.find(c=>c.state==='claimed')!;if(claimed.state!=='claimed')throw new Error('NO_RUNTIME_CLAIM');
   jobId=claimed.jobId;fence=claimed.fencingToken;
   job=(await transactions(worker)(async()=>worker.query('select payload from public.engine_durable_jobs where job_id=$1',[jobId]))).rows[0].payload;
   if(!runtimeChecks.length)runtimeChecks.push('two real worker transactions atomically dispatch/claim one current paid source, while the peer observes busy without stealing it');
   return;
  }
  return transactions(worker)(async context=>{
  const head=(await owner.query('select * from private.case_input_heads where case_id=$1',[caseId])).rows[0];
  job={schema_version:'saved-case-work-v1',case_id:caseId,revision:head.revision,input_sha256:head.input_sha256,mode:'draft'};
  await admitSavedSource(context,job);
  const dispatched=await dispatchCaseInput(context,{caseId,tenantId:tenant,mode:'draft',liveEnabled:false,nowMs:Date.now()});
  const queue=new PostgresJobsOutboxAuditRepository(context,tenant,caseId),claimed=(await queue.claim(workerId,Date.now(),240000))[0];
  expect(claimed.job_id).toBe(dispatched!.job_id);await queue.start(claimed.job_id,workerId,claimed.fencing_token,Date.now());jobId=claimed.job_id;fence=claimed.fencing_token;
  });
 };
 const args=()=>({transactions:transactions(worker),storage,extractor,providerEnabled:true,jobId,workerId,fencingToken:fence,versionId:doc.document_id});
 try{
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect()]);
  if(process.env.TIVDOC_APPLY_EXTRACTION_INVOCATIONS==='1'){await owner.query('begin');await owner.query(readFileSync('supabase/migrations/'+migration,'utf8'));await owner.query('commit');}
  await owner.query('begin');
  for(const id of [caseId,otherId])await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,check_period_month) values($1,'Synthetic extraction proof','qa@example.invalid','0500000000',true,'under_review','verified','2025-01-01')",[id]);
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-01',$4,'synthetic.pdf','application/pdf',$5,$6,'2025-01-01')",[documentId,caseId,doc.document_id,`cases/${caseId}/versions/${doc.document_id}.pdf`,doc.size_bytes,doc.content_sha256]);
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-01',$4,'other-synthetic.pdf','application/pdf',$5,$6,'2025-01-01')",[randomUUID(),otherId,otherVersion,physical[1].path,otherBytes.length,physical[1].sha]);
  // Explicit synthetic paid order; no provider receipt is asserted. Source
  // capture itself is real and never patched or rehashed by the test.
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2025-01-01','2025-01-01',999,'ILS',$3,$4,$5,$6,'paid',now())",[orderId,caseId,offer,offer.sha256,fixture.command.requested_topics.slice(0,3),offer.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[orderId]);
  await owner.query("insert into public.questionnaire_responses(case_id,payload,suspected_issue) values($1,$2,'')",[caseId,{salaryType:'hourly',employmentStartMonth:'2024-07'}]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.saved.worker',$3,now()-interval '1 minute',now()+interval '15 minutes',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);
  await owner.query('commit');seeded=true;
  if(bucket&&remote){
   const info=await remote.storage.getBucket('salary-documents');if(info.error||info.data.public)throw new Error('SAVED_STORAGE_PROOF_PRIVATE_BUCKET_REQUIRED');
   for(const file of physical){const result=await bucket.upload(file.path,file.bytes,{contentType:'application/pdf',upsert:false,cacheControl:'0'});if(result.error)throw new Error('SAVED_STORAGE_PROOF_UPLOAD_FAILED');uploaded.push(file.path);await storage.download(file.path);}
   storageChecks.push('two distinct synthetic PDF objects are uploaded without upsert to the private isolated DEV bucket and downloaded with exact byte hashes');
  }
  await enqueue();
  if(storageProof){
   await expect(runSavedWorkerExtraction({...args(),versionId:otherVersion})).rejects.toThrow('SAVED_EXTRACTION_SOURCE_SCOPE');
   await expect(transactions(worker)(context=>claimSavedDraftJob(context,{caseId:otherId,workerId,leaseMs:60000}))).rejects.toThrow('SAVED_WORKER_SCOPE_FORBIDDEN');
   storageChecks.push('the first verified worker cannot admit the second real Storage document or claim its case');
  }
  await expect(runSavedWorkerExtraction({...args(),workerId:'foreign-worker'})).rejects.toThrow('SAVED_JOB_FENCE');
  expect(passes).toBe(0);checks.push('actual paid-source and worker lease admission rejects another worker before provider dispatch');
  expireBeforeDispatch=true;await expect(runSavedWorkerExtraction(args())).rejects.toThrow('SAVED_JOB_FENCE');expect(passes).toBe(0);
  checks.push('lease expiry after admission is rejected by the atomic dispatch SQL before any external call');
  const running=runnerProof?runSavedDraftJob({...args(),heartbeat:{intervalMs:1000,leaseMs:60000}}):runSavedWorkerExtraction(args());const outcome=running.then(value=>({value,error:null}),error=>({value:null,error}));inFlight=outcome;await Promise.race([began,outcome.then(value=>{throw value.error??new Error('PROVIDER_DID_NOT_START');})]);
  await owner.query('begin');await owner.query('select id from public.cases where id=$1 for update nowait',[caseId]);await owner.query('rollback');
  await expect(runSavedWorkerExtraction({...args(),transactions:transactions(peer)})).rejects.toThrow('SAVED_EXTRACTION_OUTCOME_PENDING');
  if(runnerProof){
   const expiry=async()=>transactions(peer)(async()=>new Date((await peer.query('select lease_expires_at from public.engine_durable_jobs where job_id=$1',[jobId])).rows[0].lease_expires_at).getTime());
   const beforePulse=await expiry();await new Promise(resolve=>setTimeout(resolve,1200));
   expect(heartbeatCount).toBeGreaterThanOrEqual(2);expect(await expiry()).toBeGreaterThan(beforePulse);
   runnerChecks.push('actual DB-clock heartbeat renews a running job while provider I/O is held outside case locks');
  }
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
  const oldArgs=args();await owner.query("update public.questionnaire_responses set payload=payload||'{\"worksFriday\":false}'::jsonb where case_id=$1",[caseId]);
  await expect(runSavedWorkerExtraction(oldArgs)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
  if(runnerProof){await expect(runSavedDraftJob(oldArgs)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');runnerChecks.push('whole-job consumer rejects a superseded source before additional extraction or analysis');}
  requestIdentity=(await owner.query("select public.case_access_identity_upsert('email',$1,'qa@example.invalid') id",[createHash('sha256').update(caseId).digest('hex')])).rows[0].id;
  await owner.query('select public.case_access_identity_link($1,$2)',[requestIdentity,caseId]);const requestId=randomUUID();
  await web.query("insert into public.case_requests(id,case_id,code,question,answer_kind,blocking,expires_at) values($1,$2,'regular_day_hours_unknown','כמה שעות נמשך יום העבודה הרגיל?','number',true,now()+interval '10 days')",[requestId,caseId]);
  await web.query("select * from public.case_request_answer($1,$2,'8')",[requestId,caseId]);
  await web.query("select public.case_request_edit($1,$2,$3,'9',1,'correction')",[caseId,requestId,requestIdentity]);
  await enqueue();
  const changed=await runSavedWorkerExtraction(args());expect(changed.reused).toBe(true);expect(changed.invocationId).toBeNull();expect(passes).toBe(before);
  checks.push('changed questionnaire rejects the old job; the new pinned source reuses exact same-file/month/policy evidence without OCR expense');
  await transactions(worker)(async context=>{
   await worker.query('savepoint before_analysis');const analysis=await runSavedWorkerMonth({context,job:job!,orderId,month:'2025-01'});
   expect(analysis.stages).toHaveLength(7);expect(analysis.bundle?.topic_results).toHaveLength(3);expect(analysis.bundle?.topic_results.every(t=>t.amount===null)).toBe(true);
   const stage=analysis.stages.find(s=>s.stage==='canonical_facts')?.payload as {facts:unknown};
   const declaredType=employmentSnapshotSchema.parse(stage.facts).facts.find(f=>f.path==='compensation.salary_type');
   expect(declaredType?.value).toBe('hourly');expect(declaredType?.status).toBe('needs_confirmation');expect(declaredType?.provenance.every(p=>p.source_type==='declared')).toBe(true);
   const correctedHours=employmentSnapshotSchema.parse(stage.facts).facts.find(f=>f.path==='work.typical_hours_per_day');
   expect(correctedHours?.value).toBe(9);expect(correctedHours?.status).toBe('needs_confirmation');
   expect(correctedHours?.provenance).toEqual([{source_type:'declared',source_reference:{kind:'case_request_answer',request_id:requestId,answer_revision:2}}]);
   await worker.query('rollback to savepoint before_analysis');
  });
  checks.push('real extraction adapter checkpoint reaches all seven canonical draft stages for the three purchased topics; missing OCR preserves unconfirmed questionnaire values and the actual corrected request revision without publishing amounts');
  if(runnerProof){
   const counts=()=>transactions(worker)(async()=>({
    analyses:(await worker.query("select count(*)::int n from public.analysis_runs where tenant_id=$1 and status='completed'",[tenant])).rows[0].n,
    manifests:(await worker.query("select count(*)::int n from public.engine_outbox_events where tenant_id=$1 and effect_kind='saved_analysis_draft_ready_v1'",[tenant])).rows[0].n,
   }));
   heartbeatCount=0;expireAtHeartbeat=2;
   await expect(runSavedDraftJob(args())).rejects.toThrow('SAVED_JOB_FENCE');
   expect(await counts()).toEqual({analyses:0,manifests:0});expireAtHeartbeat=0;
   runnerChecks.push('expiry after canonical analysis but before its transaction commits rolls back all monthly stages and creates no completion manifest');
   failFinalizer=true;await expect(runSavedDraftJob(args())).rejects.toThrow('INJECTED_FINALIZER_FAILURE');
   expect(await counts()).toEqual({analyses:1,manifests:0});expect(passes).toBe(before);
   runnerChecks.push('failure before finalizer SQL preserves the independently committed month and extraction, while job/outbox remain incomplete');
   const concurrent=await Promise.allSettled([runSavedDraftJob(args()),runSavedDraftJob({...args(),transactions:transactions(peer)})]);
   expect(concurrent.some(r=>r.status==='fulfilled')).toBe(true);
   for(const result of concurrent)if(result.status==='rejected')expect(result.reason.message).toMatch(/^SAVED_JOB_(FENCE|ALREADY_COMPLETED)$/);
   expect(await counts()).toEqual({analyses:1,manifests:1});expect(passes).toBe(before);
   runnerChecks.push('two independent actual worker connections race whole-job completion: one month, one immutable manifest, no repeated provider call');
   const replayed=await runSavedDraftJob({...args(),transactions:transactions(peer)});
   expect(replayed.completion.replayed).toBe(true);expect(replayed.analyzedMonths).toBe(0);expect(replayed.extractedVersions).toBe(0);
   expect(replayed.completion.manifest.months).toHaveLength(1);expect(replayed.completion.manifest.months[0].order_id).toBe(orderId);
   expect(replayed.completion.manifest.publication).toBe('draft');expect(await counts()).toEqual({analyses:1,manifests:1});
   runnerChecks.push('retry after committed success returns the same saved complete-scope manifest without heartbeat, OCR, monthly rewrite or customer publication');
   const extendedId=randomUUID(),extended=legacyFullOfferFixture();
   await owner.query('begin');
   await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'full','2025-01-01','2025-02-01',14900,'ILS',$3,$4,$5,$6,'awaiting_payment',null)",[extendedId,caseId,extended,extended.sha256,fixture.command.requested_topics,extended.terms_version]);
   await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[extendedId]);await owner.query("update private.product_orders set state='paid',verified_at=now() where id=$1",[extendedId]);await owner.query('commit');await enqueue();
   await expect(runSavedDraftJob(args())).rejects.toMatchObject({message:'SAVED_PURCHASED_MONTH_DOCUMENT_REQUIRED',months:['2025-02']});
   expect(await counts()).toEqual({analyses:3,manifests:1});expect(passes).toBe(before);
   const incomplete=(await transactions(worker)(async()=>worker.query('select state,terminal_effect_sha256 from public.engine_durable_jobs where job_id=$1',[jobId]))).rows[0];
   expect(incomplete.state).toBe('running');expect(incomplete.terminal_effect_sha256).toBeNull();
   runnerChecks.push('a later historical full order with a missing February document preserves both available January analyses but cannot acknowledge full scope or create a second manifest');
   if(runtimeProof){
    const held=await transactions(worker)(context=>recordSavedJobFailure(context,{caseId,workerId,jobId,fencingToken:fence},new Error('SAVED_PURCHASED_MONTH_DOCUMENT_REQUIRED')));
    expect(held).toMatchObject({state:'dead_letter',reason:'saved_documents_missing'});
    const heldAudit=(await transactions(worker)(async()=>worker.query("select reason_code from public.engine_platform_audit_events where tenant_id=$1 and resource_id=$2 order by case_sequence desc limit 1",[tenant,jobId]))).rows[0];
    expect(heldAudit.reason_code).toBe('saved_documents_missing');
    const once=()=>runSavedDraftOnce({...args(),caseId,enabled:true});
    expect(await once()).toMatchObject({state:'held',reason:'dead_letter'});
    runtimeChecks.push('missing purchased document becomes an atomic durable hold with a safe audit reason; repeat host iteration cannot silently mark the job complete');
    await owner.query("update public.questionnaire_responses set payload=payload||'{\"worksSaturday\":false}'::jsonb where case_id=$1",[caseId]);
    failRuntimeJournal=true;const first=await once();expect(first).toMatchObject({state:'retry_wait',reason:'saved_processing_retry'});
    if(!('jobId' in first)||typeof first.jobId!=='string')throw new Error('RUNTIME_JOB_ID_MISSING');const retryId=first.jobId;
    const retryState=async()=>transactions(worker)(async()=> (await worker.query('select state,attempt_count,fencing_token,available_at>clock_timestamp() delayed from public.engine_durable_jobs where job_id=$1',[retryId])).rows[0]);
    const attempt1=await retryState();expect(attempt1).toMatchObject({state:'retry_wait',attempt_count:1,delayed:true});
    runtimeChecks.push('injected processing failure commits retry_wait with DB-time backoff and no private provider text in the audit');
    expect(await once()).toMatchObject({state:'busy',jobId:retryId});expect((await retryState()).attempt_count).toBe(1);
    runtimeChecks.push('another host iteration before persisted availability cannot consume an extra attempt');
    const advance=()=>transactions(worker)(async()=>worker.query("update public.engine_durable_jobs set available_at=clock_timestamp()-interval '1 second' where job_id=$1",[retryId]));
    await advance();expect(await once()).toMatchObject({state:'retry_wait'});expect((await retryState()).attempt_count).toBe(2);
    await expect(transactions(peer)(context=>recordSavedJobFailure(context,{caseId,workerId,jobId:retryId,fencingToken:Number(attempt1.fencing_token)},new Error('stale')))).rejects.toThrow('SAVED_JOB_FENCE');
    runtimeChecks.push('a reclaimed retry advances the fence and refuses the previous worker failure receipt');
    await advance();expect(await once()).toMatchObject({state:'dead_letter',reason:'saved_attempts_exhausted'});
    expect(await retryState()).toMatchObject({state:'dead_letter',attempt_count:3});expect(await once()).toMatchObject({state:'held'});
    const reasons=(await transactions(worker)(async()=>worker.query("select reason_code from public.engine_platform_audit_events where tenant_id=$1 and resource_id=$2 and reason_code<>'saved_job_claimed' order by case_sequence",[tenant,retryId]))).rows.map(r=>r.reason_code);
    expect(reasons).toEqual(['saved_processing_retry','saved_processing_retry','saved_attempts_exhausted']);expect(passes).toBe(before);
    runtimeChecks.push('three bounded failed attempts end in a durable hold with exactly three safe failure audit events and no additional provider passes');
    failRuntimeJournal=false;
    if(storageProof){
     const secondOrder=randomUUID();await owner.query('begin');
     await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2025-01-01','2025-01-01',999,'ILS',$3,$4,$5,$6,'paid',now())",[secondOrder,otherId,offer,offer.sha256,fixture.command.requested_topics.slice(0,3),offer.terms_version]);
     await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[secondOrder]);
     await owner.query("insert into public.questionnaire_responses(case_id,payload,suspected_issue) values($1,$2,'')",[otherId,{salaryType:'monthly',employmentStartMonth:'2024-07'}]);
     await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.saved.storage.worker',$3,now()-interval '1 minute',now()+interval '15 minutes',$4,now())",[otherTenant,otherSid,otherJti,canonicalSha256({sid:otherSid,jti:otherJti})]);
     await owner.query('commit');otherSessionCreated=true;
     const secondTransactions=transactions(peer,{sid:otherSid,jti:otherJti});
     const result=await runSavedDraftOnce({transactions:secondTransactions,caseId:otherId,workerId:'second-storage-worker',enabled:true,providerEnabled:true,storage,extractor});
     expect(result.state).toBe('succeeded');if(result.state!=='succeeded')throw new Error('SECOND_STORAGE_CASE_NOT_COMPLETE');
     expect(result.result.completion.manifest.source.case_id).toBe(otherId);expect(result.result.completion.manifest.months[0].order_id).toBe(secondOrder);
     expect(result.result.completion.manifest.publication).toBe('draft');expect(passes).toBe(before+1);
     const repeat=await runSavedDraftOnce({transactions:secondTransactions,caseId:otherId,workerId:'second-storage-worker',enabled:true,providerEnabled:true,storage,extractor});
     expect(repeat.state).toBe('succeeded');expect(passes).toBe(before+1);
     const primaryRows=await secondTransactions(async()=>peer.query('select report_id from public.engine_report_versions where canonical_case_id=$1',[caseId]));expect(primaryRows.rows).toHaveLength(0);
     for(const file of physical)await storage.download(file.path);
     storageChecks.push('a second independently scoped case runs questionnaire, actual Storage bytes, durable extraction, canonical draft/report and final manifest; replay does not call the injected provider again and cannot read the first case report');
    }
   }
  }
  expect((await owner.query('select status,payment_status from public.cases where id=$1',[caseId])).rows[0]).toEqual({status:'under_review',payment_status:'verified'});
  checks.push('case and payment state remain unchanged; no customer projection or external provider delivery is performed');
 }finally{
  try{
  release();await inFlight;await Promise.all([owner.query('rollback').catch(()=>{}),worker.query('rollback').catch(()=>{}),peer.query('rollback').catch(()=>{})]);
  if(seeded){
   await transactions(worker)(async()=>{await worker.query("update public.engine_durable_jobs set state='cancelled',cancellation_requested=true,lease_owner=null,lease_expires_at=null,revision=revision+1 where tenant_id=$1 and state in ('queued','leased','running','retry_wait')",[tenant]);});
   if(otherSessionCreated)await transactions(peer,{sid:otherSid,jti:otherJti})(async()=>{await peer.query("update public.engine_durable_jobs set state='cancelled',cancellation_requested=true,lease_owner=null,lease_expires_at=null,revision=revision+1 where tenant_id=$1 and state in ('queued','leased','running','retry_wait')",[otherTenant]);});
   await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
   await owner.query('update public.product_identity_sessions set revoked_at=now() where sid=$1 and tenant_id=$2',[sid,tenant]);
   if(otherSessionCreated){await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[otherTenant]);await owner.query('update public.product_identity_sessions set revoked_at=now() where sid=$1 and tenant_id=$2',[otherSid,otherTenant]);}
   const removed=await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic extraction proof'",[[caseId,otherId]]);expect(removed.rowCount).toBe(2);if(requestIdentity)await owner.query('delete from public.case_identities where id=$1',[requestIdentity]);await owner.query('commit');cleaned=true;
  }
  if(bucket&&uploaded.length){
   if(!cleaned)throw new Error('SAVED_STORAGE_CLEANUP_REQUIRES_OWNED_CASE_REMOVAL');
   if(uploaded.some(path=>!physical.some(file=>file.path===path)))throw new Error('SAVED_STORAGE_CLEANUP_SCOPE');
   const removed=await bucket.remove(uploaded);if(removed.error)throw new Error('SAVED_STORAGE_CLEANUP_FAILED');
   for(const path of uploaded){const segments=path.split('/'),name=segments.pop()!;const listing=await bucket.list(segments.join('/'),{search:name});if(listing.error||listing.data.length)throw new Error('SAVED_STORAGE_CLEANUP_NOT_VERIFIED');}
   storageCleaned=true;storageChecks.push('only the two owned objects are removed after owned product cases/documents; exact prefix listings confirm absence and both scoped machine sessions are revoked');
  }
  writeFileSync(storageProof?'docs/release-evidence/P05-saved-job-storage-db.json':runtimeProof?'docs/release-evidence/P05-saved-job-runtime-db.json':runnerProof?'docs/release-evidence/P05-saved-job-runner-db.json':'docs/release-evidence/P05-saved-extraction-worker-db.json',JSON.stringify({verdict:checks.length===9&&(!runnerProof||runnerChecks.length===7)&&(!runtimeProof||runtimeChecks.length===6)&&(!storageProof||storageChecks.length===4)?'PASS':'FAIL',checks,runnerChecks,runtimeChecks,storageChecks,storageObjectsRemoved:storageCleaned?uploaded.length:0,storageInputHashes:storageProof?physical.map(p=>p.sha):[],otherMachineSessionRevoked:storageProof&&cleaned&&otherSessionCreated,secondSyntheticCanonicalTenantRetained:storageProof?otherTenant:null,runtime_sha256:runtimeProof?createHash('sha256').update(readFileSync('src/server/product/processing/saved-job-runtime.ts')).digest('hex'):null,runner_sha256:runnerProof?createHash('sha256').update(readFileSync('src/server/product/processing/saved-job-runner.ts')).digest('hex'):null,database:'tivdoc_release_replay_20260907',migration,migration_sha256:createHash('sha256').update(readFileSync('supabase/migrations/'+migration)).digest('hex'),tested_base_sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),worker_composition_sha256:createHash('sha256').update(readFileSync('src/server/product/processing/saved-extraction-worker.ts')).digest('hex'),canonical_service_sha256:createHash('sha256').update(readFileSync('src/engine/case-analysis/service.ts')).digest('hex'),authorization:'actual worker and peer logins with provisioned synthetic SID/JTI; no fixture RLS policies',syntheticCasesRemoved:cleaned?2:0,machineSessionRevoked:cleaned,requestIdentityRemoved:cleaned&&!!requestIdentity,additional_migration:'20260908073000_request_statement_scope.sql',syntheticCanonicalTenantRetained:tenant,retainedScope:runnerProof?'Synthetic canonical identity/lifecycle, job history, completed monthly analysis/report bytes and pending draft-ready outbox manifest retained as audit evidence. No customer publication. Product cases/documents/invocations/checkpoints cascade-cleaned.':'Canonical identity/lifecycle and cancelled job history intentionally retained; monthly analysis rolled back. Product cases, documents, invocations and checkpoints cascade-cleaned.',providerTransport:storageProof?'injected deterministic structured responses; actual private isolated DEV Storage PDF bytes/hash and adapter, no network OpenAI call':'injected deterministic structured responses; real adapter and PDF byte/hash checks, no network provider or hosted Storage',providerPasses:passes,customerPublication:false,productionChanged:false},null,2)+'\n');
  }finally{await Promise.all([owner.end(),worker.end(),peer.end(),web.end()]);}
 }
},240000);
