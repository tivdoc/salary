import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,openSync,closeSync,fsyncSync,unlinkSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {PDFDocument} from 'pdf-lib';
import {z} from 'zod';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentUploadSchema,matchesDocumentSignature} from '@/lib/document-upload';
import type {UploadBatch,ReservedFile} from '../documents/upload';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {offerSnapshot} from '../orders/contracts';
import {documentFieldTargetSchema,DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from '../reports/document-field-confirmation';
import {createLiveExtractionRuntime} from './live-extraction-runtime';
import {readSavedExtractionProvenance} from './live-extraction-provenance';
import {assertLiveExtractionBudgetModel,parseLiveExtractionBudgetLedger,preflightLiveExtractionRequest,
 reserveLiveExtractionPass,recordLiveExtractionPassReceipt,summarizeLiveExtractionBudget,LIVE_EXTRACTION_BUDGET_POLICY,LIVE_EXTRACTION_REVIEWED_RETRY,
 type LiveExtractionReviewedRetry} from './live-extraction-budget';
import type {OpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {claimSavedDraftJob} from './saved-job-runtime';
import {runSavedWorkerExtraction,type SavedWorkerTransactions} from './saved-extraction-worker';
import {runSavedDevFinancialMonth} from './dev-financial-analysis';
import {parseDevFinancialRun} from './dev-financial-contract';
import type {SourceJob} from './source-dispatch';
import {DEV_FINANCIAL_LIVE_ORACLE as DEV_FINANCIAL_ORACLE,createLiveFinancialInput,liveFinancialSha as fixtureSha} from './dev-financial-live-flow.fixture';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_DEV_FINANCIAL_LIVE_DB_PROOF!=='1')('computes DEV reports from stored synthetic files read by the actual SDK and identified literal confirmations',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('DEV_FINANCIAL_PROOF_BOUNDARY');
 const retain=process.env.TIVDOC_DEV_FINANCIAL_LIVE_RETAIN==='1';
 const retryRequested=process.env.TIVDOC_LIVE_APPROVED_ATTEMPT==='2';
 if(process.env.TIVDOC_LIVE_APPROVED_ATTEMPT!==undefined&&!retryRequested)throw Error('LIVE_BUDGET_RETRY_NOT_APPROVED');
 const ownerRecipientFile=process.env.TIVDOC_DEV_OWNER_RECIPIENT_FILE??'../release-work/dev-owner-recipient.json';
 const ownerEmail=retain?z.object({verifiedBy:z.literal('explicit owner authorization'),allowlist:z.tuple([z.email()])})
  .parse(JSON.parse(readFileSync(ownerRecipientFile,'utf8'))).allowlist[0].trim().toLowerCase():null;
 const runtime=createLiveExtractionRuntime();if(runtime.state!=='configured')throw Error(runtime.code);
 assertLiveExtractionBudgetModel(runtime.provider.model,new Date().toISOString());
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),peer=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');let restarted:pg.Client|undefined;
 const keys=JSON.parse(readFileSync(process.env.TIVDOC_SAVED_STORAGE_CREDENTIALS_FILE??'','utf8'));expect(keys.NEXT_PUBLIC_SUPABASE_URL).toBe('https://cpzrbidxftzqcfeqqusu.supabase.co');
 const remote=createClient(keys.NEXT_PUBLIC_SUPABASE_URL,keys.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}),bucket=remote.storage.from('salary-documents');
 const cases=[0,1].map(()=>({id:randomUUID(),orderId:randomUUID(),publicId:'',identity:'',identityCreated:false,sid:`dev-financial-live:${randomUUID()}`,jti:randomUUID()})),primary=cases[0],tenant=`saved-case:${primary.id}`;
 const inputs=await Promise.all([createLiveFinancialInput(false),createLiveFinancialInput(true)]),directory='output/release-completion/dev-financial-live-flow';
 mkdirSync(directory,{recursive:true});for(const input of inputs)writeFileSync(`${directory}/${input.name}`,input.bytes);writeFileSync(`${directory}/independent-oracle.json`,JSON.stringify(DEV_FINANCIAL_ORACLE,null,2)+'\n');
 const ownedFile=`../release-work/dev-financial-live-owned-${primary.id}.json`,checks:string[]=[],paths:string[]=[],providerHashes:string[]=[],runs:{runId:string;inputRevision:number;state:string}[]=[];
 const confirmationChecks:unknown[]=[],provenanceChecks:unknown[]=[],providerReceipts:OpenAiProviderReceipt[]=[];
 const ledgerPath='output/release-completion/live-provider-june2026/live-provider-budget-ledger.json',lockPath=`${ledgerPath}.lock`;
 let ledger=parseLiveExtractionBudgetLedger(JSON.parse(readFileSync(ledgerPath,'utf8')));
 if(ledger.model!==runtime.provider.model||ledger.reservations.length+4>LIVE_EXTRACTION_BUDGET_POLICY.maxPasses
  ||(ledger.reservations.length+4)*LIVE_EXTRACTION_BUDGET_POLICY.perPassReservedMicroUsd>LIVE_EXTRACTION_BUDGET_POLICY.maxReservedMicroUsd
  ||ledger.reservations.some(row=>inputs.some(input=>input.sha256===row.sourceSha256)
   &&(!retryRequested||row.reviewedRetry!==undefined||row.outcome==='reserved_unknown')))throw Error('LIVE_BUDGET_REPLAY_OR_CAPACITY');
 const ledgerBefore=summarizeLiveExtractionBudget(ledger);let budgetLock:number|undefined;
 const persistLedger=()=>{const handle=openSync(ledgerPath,'w');try{writeFileSync(handle,JSON.stringify(ledger,null,2)+'\n');fsyncSync(handle);}finally{closeSync(handle);}};
 const schemaEvidence:unknown[]=[],providerAttempts:{sourceSha256:string;passKind:string;receiptConfirmed:boolean}[]=[];
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;
 const reviewedRetry:LiveExtractionReviewedRetry|undefined=retryRequested?{version:LIVE_EXTRACTION_REVIEWED_RETRY.version,attemptRevision:2,
  reasonCode:LIVE_EXTRACTION_REVIEWED_RETRY.reasonCode,codeRevision:process.env.TIVDOC_LIVE_RETRY_CODE_REVISION??''}:undefined;
 if(reviewedRetry&&(reviewedRetry.codeRevision!==gitSha||dirty))throw Error('LIVE_BUDGET_RETRY_CODE_REVISION');
 let seeded=false,cleaned=false,storageCleaned=false,removedIdentities=0,removedCases=0,activeTransactions=0,failBeforeSave=false,completed=false,retained=false,phase='preflight',failure:unknown=null,cleanupFailure:unknown=null;
 const own=()=>writeFileSync(ownedFile,JSON.stringify({caseIds:cases.map(c=>c.id),identities:cases.map(c=>c.identity).filter(Boolean),cases,paths,retained,gitSha,directory,qaLabel:'Synthetic DEV live financial flow',scope:'Only these fresh QA cases and object paths in isolated DEV; machine credentials are private. Preserve existing identities. No customer session or OTP was created.'},null,2));
 own();
 const transactions=(db:pg.Client):SavedWorkerTransactions=>async operation=>{
  await db.query('begin');activeTransactions++;
  try{await db.query('select * from private.runtime_context_install($1,$2,$3)',[primary.sid,primary.jti,'dev-financial-live-proof']);await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[gitSha]);
   const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(s){if(s.name==='dev_financial_save'&&failBeforeSave)throw Error('TEST_FAIL_BEFORE_FINANCIAL_SAVE');const r=await db.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),row_count:r.rowCount??0};}}};
   const result=await operation(context);await db.query('commit');return result;
  }catch(error){await db.query('rollback');throw error;}finally{activeTransactions--;}
 };
 const storage={async download(path:string){expect(paths).toContain(path);expect(activeTransactions).toBe(0);const downloaded=await bucket.download(path);if(downloaded.error||!downloaded.data)throw Error('DEV_FINANCIAL_STORAGE_READ');const hash=fixtureSha(Buffer.from(await downloaded.data.arrayBuffer()));expect(inputs.some(input=>input.sha256===hash)).toBe(true);return {data:downloaded.data,error:null};}};
 const extractor=runtime.extractor,forward=extractor.extractPreparedPass.bind(extractor);
 extractor.extractPreparedPass=async input=>{
  expect(activeTransactions).toBe(0);
  const source=inputs.find(value=>value.sha256===input.request.document.content_sha256);
  if(!source||input.request.document.case_id!==primary.id||input.sourcePageCount!==1
   ||input.request.document.size_bytes!==source.bytes.length||input.prepared.original.mime_type!=='application/pdf')
   throw Error('LIVE_BUDGET_UNAPPROVED_SOURCE');
  const preflight=await preflightLiveExtractionRequest({model:runtime.provider.model,prepared:input.prepared,
   sourceSha256:source.sha256,kind:input.kind,requestedFields:input.requestedFields,now:new Date().toISOString()});
  ledger=reserveLiveExtractionPass({ledger,sourceSha256:source.sha256,requestSha256:preflight.requestSha256,passKind:input.kind,now:new Date().toISOString(),reviewedRetry});persistLedger();
  const attempt={sourceSha256:source.sha256,passKind:input.kind,receiptConfirmed:false};providerAttempts.push(attempt);providerHashes.push(source.sha256);
  writeFileSync(`${directory}/provider-attempts.json`,JSON.stringify(providerAttempts,null,2)+'\n');
  const pass=await forward(input);
  if(!pass.provider_receipt)throw Error('LIVE_BUDGET_RECEIPT_MISSING');
  ledger=recordLiveExtractionPassReceipt(ledger,pass.provider_receipt);persistLedger();
  providerReceipts.push(pass.provider_receipt);attempt.receiptConfirmed=pass.provider_receipt.provider_attempted;
  writeFileSync(`${directory}/provider-attempts.json`,JSON.stringify(providerAttempts,null,2)+'\n');return pass;
 };
 const inspectCheckpoint=(label:string,checkpoint:unknown,file:ReservedFile)=>{
  writeFileSync(`${directory}/${label}-extraction.json`,JSON.stringify(checkpoint,null,2)+'\n');
  const provenance=readSavedExtractionProvenance(checkpoint);
  expect(provenance.kind).toBe('openai_live');expect(provenance.providerAttempted).toBe(true);expect(provenance.allPassesSucceeded).toBe(true);
  for(const receipt of provenance.receipts){expect(receipt.case_id).toBe(primary.id);expect(receipt.document_id).toBe(file.versionId);
   expect(receipt.source_sha256).toBe(file.sha256);expect(receipt.source_page_count).toBe(1);expect(receipt.provider_response_id).toBeTruthy();
   expect(providerReceipts.some(value=>canonicalSha256(value)===canonicalSha256(receipt))).toBe(true);}
  provenanceChecks.push({label,versionId:file.versionId,...provenance});
 };
 const upload=async(input:typeof inputs[number],replace?:ReservedFile)=>{
  const manifest=documentUploadSchema.parse({caseId:primary.id,batchId:randomUUID(),checkPeriodMonth:'2026-06',files:[{clientId:randomUUID(),documentType:'payslip',name:input.name,type:'application/pdf',size:input.bytes.length,sha256:input.sha256,periodMonth:'2026-06',...(replace?{replace:{documentId:replace.documentId,versionId:replace.versionId}}:{})}]});
  const batch=(await web.query('select public.case_documents_reserve($1,$2,$3) value',[primary.id,manifest.batchId,manifest])).rows[0].value as UploadBatch;expect(batch.files).toHaveLength(1);const file=batch.files[0];
  expect(file.path).toBe(`cases/${primary.id}/versions/${file.versionId}.pdf`);paths.push(file.path);own();
  const signed=await bucket.createSignedUploadUrl(file.path,{upsert:false});if(signed.error||!signed.data)throw Error('DEV_FINANCIAL_UPLOAD_SIGN');
  const uploaded=await bucket.uploadToSignedUrl(file.path,signed.data.token,input.bytes,{contentType:'application/pdf'});if(uploaded.error)throw Error('DEV_FINANCIAL_UPLOAD_TRANSFER');
  const stored=await storage.download(file.path),bytes=new Uint8Array(await stored.data.arrayBuffer());expect(bytes.length).toBe(input.bytes.length);expect(stored.data.type.split(';')[0]).toBe('application/pdf');expect(matchesDocumentSignature(bytes,'application/pdf')).toBe(true);expect(fixtureSha(bytes)).toBe(input.sha256);
  await web.query('select public.case_documents_commit($1,$2,$3)',[primary.id,manifest.batchId,{[file.versionId]:input.sha256}]);
  expect((await owner.query('select content_sha256 from public.documents where id=$1 and case_id=$2',[file.documentId,primary.id])).rows[0].content_sha256).toBe(input.sha256);return file;
 };
 const claim=async()=>transactions(worker)(async context=>{const lease=await claimSavedDraftJob(context,{caseId:primary.id,workerId:'dev-financial-worker',leaseMs:300000});if(lease.state!=='claimed')throw Error('DEV_FINANCIAL_EXPECTED_CLAIM');const row=(await worker.query('select payload from public.engine_durable_jobs where job_id=$1',[lease.jobId])).rows[0];return {job:row.payload as SourceJob,jobId:lease.jobId,workerId:'dev-financial-worker',fencingToken:lease.fencingToken};});
 const extract=(lease:Awaited<ReturnType<typeof claim>>,file:ReservedFile)=>runSavedWorkerExtraction({...lease,versionId:file.versionId,transactions:transactions(worker),storage,extractor,providerEnabled:true});
 const confirmSourceFields=async(file:ReservedFile,checkpoint:unknown,missingHours:boolean)=>{
  // These are automated test actions by an identified synthetic actor. Each
  // actual generated target must match independent literal source truth first.
  // Never raise OCR confidence or insert canonical facts/answer-ledger rows.
  const expected:Record<string,unknown>={salary_type:'hourly',salary_period:{year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'},
   base_monthly_salary:{currency:'ILS',minor_units:330000},gross_salary:{currency:'ILS',minor_units:330000},net_salary:{currency:'ILS',minor_units:330000},hourly_rate:{currency:'ILS',minor_units:3300},
   ...(!missingHours?{regular_hours:{amount:'100',unit:'hours_per_month'}}:{})};
  const checkpointSha=z.object({result_sha256:z.string()}).parse(checkpoint).result_sha256;
  const requests=(await owner.query("select t.request_id,t.target from private.document_field_targets t join public.case_requests r on r.id=t.request_id and r.case_id=t.case_id where t.case_id=$1 and t.target->>'version_id'=$2 and r.answered_at is null order by t.target#>>'{candidate,field}'",[primary.id,file.versionId])).rows;
  const fields:string[]=[];
  writeFileSync(`${directory}/${missingHours?'missing':'clear'}-generated-confirmations.json`,JSON.stringify({targets:requests},null,2)+'\n');
  for(const request of requests){const target=documentFieldTargetSchema.parse(request.target);expect(target.case_id).toBe(primary.id);expect(target.version_id).toBe(file.versionId);expect(target.source_sha256).toBe(file.sha256);expect(target.extraction_result_sha256).toBe(checkpointSha);expect(Object.hasOwn(expected,target.candidate.field)).toBe(true);expect(target.candidate.normalized_value).toEqual(expected[target.candidate.field]);fields.push(target.candidate.field);}
  expect(fields.sort()).toEqual(Object.keys(expected).sort());
  const confirmKnownFixtureReading=(requestId:string)=>web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[requestId,primary.id,primary.identity,DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]]);
  for(const request of requests)await confirmKnownFixtureReading(request.request_id);
  const calls=providerHashes.length,lease=await claim(),reused=await extract(lease,file);expect(reused.reused).toBe(true);expect(providerHashes).toHaveLength(calls);expect(canonicalSha256(reused.result)).toBe(canonicalSha256(checkpoint));
  confirmationChecks.push({versionId:file.versionId,fields,actor:'automated_known_synthetic_fixture_identity',humanReview:false,ocrConfidenceModified:false,receiptReused:true});return lease;
 };
 const calculate=(job:SourceJob,db=worker)=>transactions(db)(context=>runSavedDevFinancialMonth({context,job,orderId:primary.orderId}));
 const counts=async()=>(await owner.query('select (select count(*)::int from private.dev_financial_runs where case_id=$1) runs,(select count(*)::int from private.dev_financial_findings where case_id=$1) findings',[primary.id])).rows[0];
 const customer=async(identity=primary.identity)=>(await web.query('select public.case_report_dev_financial($1,$2) value',[primary.id,identity])).rows[0].value as {payload:unknown;current:boolean}[];
 const recordArtifacts=async(label:string,result:Awaited<ReturnType<typeof calculate>>)=>{
  const run=parseDevFinancialRun(result.run);runs.push({runId:run.run_id,inputRevision:run.input_revision,state:run.calculation.state});
  expect(run.extraction_provider).toBe('openai_live');expect(run.extraction_provenance?.allPassesSucceeded).toBe(true);
  for(const receipt of run.extraction_provenance?.receipts??[])expect(providerReceipts.some(value=>canonicalSha256(value)===canonicalSha256(receipt))).toBe(true);
  writeFileSync(`${directory}/${label}.json`,JSON.stringify(run,null,2)+'\n');writeFileSync(`${directory}/${label}.html`,result.artifacts.html);writeFileSync(`${directory}/${label}.pdf`,result.artifacts.pdf);
  const actual=(await owner.query('select payload,html,pdf,html_sha256,pdf_sha256 from private.dev_financial_runs where id=$1',[run.run_id])).rows[0];expect(actual.payload).toEqual(run);expect(actual.html).toBe(result.artifacts.html);expect(actual.pdf.equals(Buffer.from(result.artifacts.pdf))).toBe(true);
  expect(actual.html_sha256).toBe(fixtureSha(actual.html));expect(actual.pdf_sha256).toBe(fixtureSha(actual.pdf));expect(actual.html).toContain(run.run_id);expect((await PDFDocument.load(actual.pdf)).getSubject()).toBe(run.run_id);
  const pdfPath=`${directory}/${label}.pdf`,pdftotext=process.env.TIVDOC_PDFTOTEXT;
  const extractedText=pdftotext?execFileSync(pdftotext,['-layout',pdfPath,'-'],{encoding:'utf8'})
   :execFileSync(process.env.TIVDOC_PDF_PYTHON??'python',['-c',"import sys,pdfplumber; p=pdfplumber.open(sys.argv[1]); sys.stdout.buffer.write(('\\n'.join(page.extract_text() or '' for page in p.pages)).encode('utf-8')); p.close()",pdfPath],{encoding:'utf8'});
  const pdfText=extractedText.replace(/[\u200e-\u202e\u2066-\u2069]/gu,'');writeFileSync(`${directory}/${label}.txt`,pdfText);
  expect(pdfText).toContain(run.run_id);if(run.calculation.state==='calculated')for(const text of ['3540.00','3300.00','240.00']){expect(actual.html).toContain(text);expect(pdfText).toContain(text);}
 };
 try{
  budgetLock=openSync(lockPath,'wx');
  // Re-read after obtaining the shared lock; another suite cannot silently spend
  // between the preflight and the first reservation.
  ledger=parseLiveExtractionBudgetLedger(JSON.parse(readFileSync(ledgerPath,'utf8')));
  if(ledger.reservations.length!==ledgerBefore.reservedPasses)throw Error('LIVE_BUDGET_CONCURRENT_CHANGE');
  phase='connect';
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect()]);const bucketInfo=await remote.storage.getBucket('salary-documents');if(bucketInfo.error||bucketInfo.data.public)throw Error('DEV_FINANCIAL_PRIVATE_BUCKET_REQUIRED');
  const signatures=(await owner.query("select p.oid::regprocedure::text signature,pg_get_functiondef(p.oid) definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname in ('dev_financial_admit','dev_financial_save','dev_financial_request_open') order by p.oid::regprocedure::text")).rows;
  expect(signatures.length).toBeGreaterThanOrEqual(3);for(const value of signatures)schemaEvidence.push({signature:value.signature,definitionSha256:fixtureSha(value.definition)});
  phase='bootstrap';await owner.query('begin');for(const c of cases){const email=c===primary&&ownerEmail?ownerEmail:`dev-live-financial-${c.id}@example.invalid`;
   c.publicId=(await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic DEV live financial flow',$2,'0500000000',true,'under_review','verified',now(),'2026-06-01') returning public_id",[c.id,email])).rows[0].public_id;
   const existing=(await owner.query("select id from public.case_identities where channel='email' and contact_hash=$1",[fixtureSha('email|'+email)])).rows[0];
   if(existing)c.identity=existing.id;else{c.identity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[fixtureSha('email|'+email),email])).rows[0].id;c.identityCreated=true;}
   await owner.query('select public.case_access_identity_link($1,$2)',[c.identity,c.id]);
   const offer=offerSnapshot('initial');await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2026-06-01','2026-06-01',$3,'ILS',$4,$5,array['minimum_wage'],$6,'paid',now())",[c.orderId,c.id,offer.amount_minor,offer,offer.sha256,offer.terms_version]);await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[c.orderId]);
   await owner.query("select private.capture_case_input($1,'synthetic_dev_financial_paid_scope')",[c.id]);await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.dev.financial.worker',$3,now()-interval '1 minute',now()+interval '30 minutes',$4,now())",[`saved-case:${c.id}`,c.sid,c.jti,canonicalSha256({sid:c.sid,jti:c.jti})]);
  }await owner.query('commit');seeded=true;own();
  phase='initial-upload-extract';const first=await upload(inputs[0]);const firstRawLease=await claim();const extractedFirst=await extract(firstRawLease,first);expect(providerHashes).toContain(inputs[0].sha256);
  inspectCheckpoint('initial',extractedFirst.result,first);
  checks.push('actual web reservation, non-upsert signed Storage transfer, byte validation and commit feed the actual durable V2 extraction adapter and saved receipt; provider response is from the actual SDK, with persisted response/model/request/source receipts');
  await expect(transactions(worker)(async()=>worker.query('select private.dev_financial_request_open($1,$2,$3,$4)',[primary.id,primary.orderId,firstRawLease.job.revision,firstRawLease.job.input_sha256]))).rejects.toThrow('DEV_FINANCIAL_HOURS_NOT_MISSING');
  checks.push('the actual SQL write boundary refuses a missing-hours question when the persisted extraction already contains regular hours');
  await expect(calculate(firstRawLease.job)).rejects.toThrow('DEV_FINANCIAL_CANONICAL_SCENARIO');expect(await counts()).toEqual({runs:0,findings:0});
  checks.push('raw V2 high-confidence candidates remain unconfirmed and cannot produce a financial run; the original canonical confirmation gate refuses them');
  phase='initial-confirmations';const firstLease=await confirmSourceFields(first,extractedFirst.result,false);
  failBeforeSave=true;try{await expect(calculate(firstLease.job)).rejects.toThrow('TEST_FAIL_BEFORE_FINANCIAL_SAVE');}finally{failBeforeSave=false;}expect(await counts()).toEqual({runs:0,findings:0});
  expect((await owner.query("select count(*)::int n from public.analysis_runs where tenant_id=$1 and status='completed'",[tenant])).rows[0].n).toBe(0);await storage.download(first.path);
  checks.push('failure immediately before financial save rolls back parent analysis, financial result and finding while the committed source and extraction receipt remain available');
  phase='initial-calculation';const initial=await calculate(firstLease.job);expect(initial.run.calculation).toMatchObject({state:'calculated',expectedMinor:DEV_FINANCIAL_ORACLE.expectedMinor,recordedMinor:DEV_FINANCIAL_ORACLE.baseMinor,gapMinor:DEV_FINANCIAL_ORACLE.gapMinor});expect(initial.run.finding?.analysis_run_id).toBe(initial.run.run_id);expect(initial.run.source.version_id).toBe(first.versionId);await recordArtifacts('initial-calculated',initial);
  checks.push('a hand-set independent 100-hour and 3300-ILS fixture produces 3540 ILS expected and 240 ILS difference from its actual canonical parent and exact saved document version; no finding or report was seeded');
  const beforeRetry=providerHashes.length;const retries=await Promise.all([calculate(firstLease.job),calculate(firstLease.job,peer)]);expect(retries.every(r=>r.receipt.replayed&&r.run.run_id===initial.run.run_id)).toBe(true);expect(await counts()).toEqual({runs:1,findings:1});expect(providerHashes).toHaveLength(beforeRetry);
  restarted=client('TIVDOC_WORKER_POSTGRES_URL');await restarted.connect();expect((await calculate(firstLease.job,restarted)).receipt.replayed).toBe(true);expect(await counts()).toEqual({runs:1,findings:1});
  checks.push('concurrent retries and a newly opened independent worker connection return the identical committed report without duplicate findings or another provider pass; this is connection restart, not process restart');
  await expect(customer(cases[1].identity)).rejects.toThrow('DEV_FINANCIAL_FORBIDDEN');await expect(worker.query('select public.case_report_dev_financial($1,$2)',[primary.id,primary.identity])).rejects.toMatchObject({code:'42501'});
  await expect(web.query('select * from private.dev_financial_runs')).rejects.toMatchObject({code:'42501'});await expect(calculate({...firstLease.job,case_id:cases[1].id})).rejects.toThrow('DEV_FINANCIAL_FORBIDDEN');
  checks.push('a foreign customer cannot obtain the report payload or its source reference; the worker cannot use the customer RPC, web cannot read private rows, and the case worker cannot analyze another case');
  phase='replacement';const second=await upload(inputs[1],first);expect(second.documentId).toBe(first.documentId);expect(second.versionId).not.toBe(first.versionId);await storage.download(first.path);
  await expect(calculate(firstLease.job)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');expect((await customer()).every(r=>r.current===false)).toBe(true);
  checks.push('explicit upload replacement preserves old bytes and history but immediately makes the old result non-current and refuses old-job publication');
  phase='missing-extraction';const missingRawLease=await claim();const extractedMissing=await extract(missingRawLease,second);inspectCheckpoint('missing',extractedMissing.result,second);
  const missingCheckpoint=z.object({run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema})})}).parse(extractedMissing.result);
  expect(missingCheckpoint.run.result.final_extraction.fields.some(f=>f.field==='regular_hours'&&f.normalized_value!==null)).toBe(false);
  phase='missing-confirmations';const missingLease=await confirmSourceFields(second,extractedMissing.result,true);
  const missing=await calculate(missingLease.job);expect(missing.run.calculation).toEqual({state:'missing_input',fields:['work.regular_hours']});expect(missing.run.finding).toBeNull();expect(missing.run.request_id).toBeTruthy();await recordArtifacts('missing-hours',missing);
  const missingRetries=await Promise.all([calculate(missingLease.job),calculate(missingLease.job,peer)]);
  expect(missingRetries.every(r=>r.receipt.replayed&&r.run.request_id===missing.run.request_id)).toBe(true);
  expect((await owner.query('select count(*)::int n from private.dev_financial_request_targets where case_id=$1',[primary.id])).rows[0].n).toBe(1);
  expect(await counts()).toEqual({runs:2,findings:1});checks.push('the second actual uploaded PDF has explicitly missing hours; the actual SDK extraction preserves absence, and analysis opens one focused identified-answer request with no monetary finding, including concurrent replay without duplicate questions');
  const requestId=missing.run.request_id!;const answer=(value:string,identity=primary.identity)=>web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[requestId,primary.id,identity,value]);
  await expect(answer('100',cases[1].identity)).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');for(const bad of ['0','183','1e2','010','01.5'])await expect(answer(bad)).rejects.toThrow('REQUEST_ANSWER_INVALID');
  phase='identified-missing-answer';
  await answer('100');await answer('100');expect((await owner.query('select count(*)::int n from private.case_request_answer_versions where request_id=$1',[requestId])).rows[0].n).toBe(1);
  await expect(web.query("select public.case_request_edit($1,$2,$3,'0',1,'correction')",[primary.id,requestId,primary.identity])).rejects.toThrow('REQUEST_ANSWER_INVALID');
  await expect(calculate(missingLease.job)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');const answerLease=await claim(),beforeAnswer=providerHashes.length;
  expect((await extract(answerLease,second)).reused).toBe(true);expect(providerHashes).toHaveLength(beforeAnswer);const answered=await calculate(answerLease.job);
  expect(answered.run.run_id).not.toBe(missing.run.run_id);expect(answered.run.input_revision).toBeGreaterThan(missing.run.input_revision);expect(answered.run.calculation).toMatchObject({state:'calculated',expectedMinor:354000,recordedMinor:330000,gapMinor:24000});expect(answered.run.reading).toMatchObject({identity_id:primary.identity,request_id:requestId,answer_revision:1,answer:'100'});await recordArtifacts('answered-calculated',answered);
  checks.push('an identified answer creates a new immutable input and analysis; retry keeps one answer revision, invalid correction is refused, and exact-source extraction is reused without another provider call');
  expect(await counts()).toEqual({runs:3,findings:2});const history=await customer();expect(history).toHaveLength(3);expect(history.filter(r=>r.current)).toHaveLength(1);expect(parseDevFinancialRun(history.find(r=>r.current)!.payload).run_id).toBe(answered.run.run_id);
  checks.push('all three historical runs remain readable to their owner, with only the answered current input designated current; stored HTML and extracted PDF text contain the same run IDs and amounts');
  expect((await owner.query('select status,payment_status from public.cases where id=$1',[primary.id])).rows[0]).toEqual({status:'under_review',payment_status:'verified'});
  checks.push('case/payment state and ordinary legal/publication gates remain unchanged; only engineering tables contain the generated financial findings');
  completed=true;phase='complete';
 }catch(error){
  failure={phase,errorKind:error instanceof Error?error.name:'unknown',code:error instanceof Error&&/^[A-Z][A-Z0-9_]+$/u.test(error.message)?error.message:null};
  throw Error('DEV_FINANCIAL_LIVE_PROOF_FAILED');
 }finally{
  extractor.extractPreparedPass=forward;
  await Promise.all([owner,worker,peer,web,...(restarted?[restarted]:[])].map(db=>db.query('rollback').catch(()=>{})));
  try{if(seeded){
   retained=retain&&completed&&!failure;const removable=retained?[cases[1]]:cases;
   await owner.query('begin');for(const c of cases){
    await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[`saved-case:${c.id}`]);
    await owner.query("update public.engine_durable_jobs set state='cancelled',cancellation_requested=true,lease_owner=null,lease_expires_at=null,revision=revision+1 where tenant_id=$1 and canonical_case_id=$2 and state in ('queued','leased','running','retry_wait')",[`saved-case:${c.id}`,c.id]);
    await owner.query('update public.product_identity_sessions set revoked_at=coalesce(revoked_at,now()) where tenant_id=$1 and sid=$2',[`saved-case:${c.id}`,c.sid]);
   }
   removedCases=(await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic DEV live financial flow'",[removable.map(c=>c.id)])).rowCount??0;expect(removedCases).toBe(removable.length);
   const createdIdentityIds=removable.filter(c=>c.identityCreated).map(c=>c.identity);
   removedIdentities=(await owner.query('delete from public.case_identities i where id=any($1::uuid[]) and not exists(select 1 from public.case_identity_cases l where l.identity_id=i.id)',[createdIdentityIds])).rowCount??0;
   expect(removedIdentities).toBe(createdIdentityIds.length);await owner.query('commit');cleaned=true;own();
   if(!retained){
    for(const path of paths)expect(path.startsWith(`cases/${primary.id}/versions/`)).toBe(true);
    if(paths.length){const removal=await bucket.remove(paths);if(removal.error)throw Error('DEV_FINANCIAL_STORAGE_CLEANUP');}
    const remaining=await bucket.list(`cases/${primary.id}/versions`);if(remaining.error||remaining.data.length)throw Error('DEV_FINANCIAL_STORAGE_REMAINS');storageCleaned=true;
   }
  }}catch(error){
   cleanupFailure={errorKind:error instanceof Error?error.name:'unknown',code:error instanceof Error&&/^[A-Z][A-Z0-9_]+$/u.test(error.message)?error.message:null};
   await owner.query('rollback').catch(()=>{});throw Error('DEV_FINANCIAL_LIVE_CLEANUP_FAILED');
  }finally{
   const verified=completed&&!failure&&!cleanupFailure&&cleaned&&(storageCleaned||retained)&&confirmationChecks.length===2&&provenanceChecks.length===2;
   writeFileSync(`${directory}/live-financial-db-proof.json`,JSON.stringify({verdict:verified?'PASS':'FAIL',checkedAt:new Date().toISOString(),gitSha,gitWorktreeDirty:dirty,
    schemaEvidence,checks,confirmationChecks,provenanceChecks,failure,cleanupFailure,runs,
    providerKind:'openai_live',providerInvocationEntered:providerAttempts.length,providerReceiptConfirmedCalls:providerAttempts.filter(v=>v.receiptConfirmed).length,
    providerCalled:providerAttempts.some(v=>v.receiptConfirmed)?true:providerAttempts.length?null:false,
    providerReceipts,distinctProviderInputs:[...new Set(providerHashes)],budgetBefore:ledgerBefore,budgetAfter:summarizeLiveExtractionBudget(ledger),reviewedRetry:reviewedRetry??null,
    independentExpected:DEV_FINANCIAL_ORACLE,syntheticCasesRemoved:removedCases,syntheticIdentitiesRemoved:removedIdentities,
    machineSessionsRevoked:cleaned?2:0,storageObjectsRemoved:storageCleaned?paths.length:0,
    sourceFiles:inputs.map(i=>({name:i.name,sha256:i.sha256})),canonicalAuditRetained:true,retainedForOwnerBrowser:retained,
    retainedCaseId:retained?primary.id:null,retainedPublicId:retained?primary.publicId:null,cleanupManifestPrivate:true,
    uploadProof:'Actual web-role reserve/commit and signed private Storage bytes; HTTP/browser upload is outside this proof',
    browserProof:false,customerSessionInjected:false,processRestartProof:false,connectionRestartProof:completed,
    liveSdkExtractionProof:provenanceChecks.length===2,liveFinancialFlowProof:verified,
    actualEmployeePayslipProof:false,humanLegalApproval:false,customerLegalAnalysisReady:false,productionChanged:false},null,2)+'\n');
   if(budgetLock!==undefined){closeSync(budgetLock);unlinkSync(lockPath);}
   await Promise.all([owner.end(),worker.end(),peer.end(),web.end(),...(restarted?[restarted.end()]:[])]);
  }
 }
},12*60*1000);
