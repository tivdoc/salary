import {expect,it,vi} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
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
import {OpenAiPayslipV2PassExtractor} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {claimSavedDraftJob} from './saved-job-runtime';
import {runSavedWorkerExtraction,type SavedWorkerTransactions} from './saved-extraction-worker';
import {runSavedDevFinancialMonth} from './dev-financial-analysis';
import {parseDevFinancialRun} from './dev-financial-contract';
import type {SourceJob} from './source-dispatch';
import {DEV_FINANCIAL_ORACLE,devFinancialInputFixture,fixtureSha} from './dev-financial-flow.fixture';
vi.mock('server-only',()=>({}));

it.skipIf(process.env.TIVDOC_DEV_FINANCIAL_DB_PROOF!=='1')('computes engineering reports from actual uploaded immutable inputs, extraction receipts and identified answers',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('DEV_FINANCIAL_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),peer=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');let restarted:pg.Client|undefined;
 const keys=JSON.parse(readFileSync(process.env.TIVDOC_SAVED_STORAGE_CREDENTIALS_FILE??'','utf8'));expect(keys.NEXT_PUBLIC_SUPABASE_URL).toBe('https://cpzrbidxftzqcfeqqusu.supabase.co');
 const remote=createClient(keys.NEXT_PUBLIC_SUPABASE_URL,keys.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}),bucket=remote.storage.from('salary-documents');
 const cases=[0,1].map(()=>({id:randomUUID(),orderId:randomUUID(),publicId:'',identity:'',session:randomBytes(16).toString('base64url'),sid:`dev-financial:${randomUUID()}`,jti:randomUUID()})),primary=cases[0],tenant=`saved-case:${primary.id}`;
 const inputs=await Promise.all([devFinancialInputFixture(false),devFinancialInputFixture(true)]),directory='output/release-completion/dev-financial-flow';
 mkdirSync(directory,{recursive:true});for(const input of inputs)writeFileSync(`${directory}/${input.name}`,input.bytes);writeFileSync(`${directory}/independent-oracle.json`,JSON.stringify(DEV_FINANCIAL_ORACLE,null,2)+'\n');
 const ownedFile=`../release-work/dev-financial-owned-${primary.id}.json`,checks:string[]=[],paths:string[]=[],providerHashes:string[]=[],runs:{runId:string;inputRevision:number;state:string}[]=[];
 const processProof=process.env.TIVDOC_DEV_FINANCIAL_PROCESS_PROOF==='1',previewProof=process.env.TIVDOC_DEV_FINANCIAL_PREVIEW_PROOF==='1';
 const processChecks:unknown[]=[],previewChecks:unknown[]=[],confirmationChecks:unknown[]=[];
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;
 let seeded=false,cleaned=false,storageCleaned=false,removedIdentities=0,activeTransactions=0,failBeforeSave=false,failure:string|null=null,cleanupFailure:string|null=null;
 const own=()=>writeFileSync(ownedFile,JSON.stringify({caseIds:cases.map(c=>c.id),identities:cases.map(c=>c.identity).filter(Boolean),cases,paths,scope:'Fresh owned QA fixtures in isolated DEV only; contains private synthetic sessions, never commit this file.'},null,2));
 own();
 const transactions=(db:pg.Client):SavedWorkerTransactions=>async operation=>{
  await db.query('begin');activeTransactions++;
  try{await db.query('select * from private.runtime_context_install($1,$2,$3)',[primary.sid,primary.jti,'dev-financial-proof']);await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[gitSha]);
   const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(s){if(s.name==='dev_financial_save'&&failBeforeSave)throw Error('INJECTED_BEFORE_FINANCIAL_SAVE');const r=await db.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),row_count:r.rowCount??0};}}};
   const result=await operation(context);await db.query('commit');return result;
  }catch(error){await db.query('rollback');throw error;}finally{activeTransactions--;}
 };
 const storage={async download(path:string){expect(paths).toContain(path);expect(activeTransactions).toBe(0);const downloaded=await bucket.download(path);if(downloaded.error||!downloaded.data)throw Error('DEV_FINANCIAL_STORAGE_READ');const hash=fixtureSha(Buffer.from(await downloaded.data.arrayBuffer()));expect(inputs.some(input=>input.sha256===hash)).toBe(true);return {data:downloaded.data,error:null};}};
 const extractor=new OpenAiPayslipV2PassExtractor({apiKey:'synthetic-never-network',model:'synthetic-dev-financial-injected',timeoutMs:1000},{transport:{async parse(request){
  expect(activeTransactions).toBe(0);const original=request.input[0].content.find(part=>part.type==='input_file');if(!original||!('file_data'in original))throw Error('DEV_FINANCIAL_PROVIDER_INPUT');
  const hash=fixtureSha(Buffer.from(original.file_data.split(',')[1],'base64')),input=inputs.find(item=>item.sha256===hash);if(!input)throw Error('DEV_FINANCIAL_PROVIDER_SOURCE');providerHashes.push(hash);
  return {id:`synthetic-financial-${providerHashes.length}`,status:'completed',outputParsed:structuredClone(input.output),usage:null};
 }},log:()=>{}});
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
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect()]);const bucketInfo=await remote.storage.getBucket('salary-documents');if(bucketInfo.error||bucketInfo.data.public)throw Error('DEV_FINANCIAL_PRIVATE_BUCKET_REQUIRED');
  await owner.query('begin');for(const c of cases){const email=`dev-financial-${c.id}@example.invalid`;
   c.publicId=(await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic DEV financial flow',$2,'0500000000',true,'under_review','verified',now(),'2026-06-01') returning public_id",[c.id,email])).rows[0].public_id;
   c.identity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[fixtureSha('email|'+email),email])).rows[0].id;await owner.query('select public.case_access_identity_link($1,$2)',[c.identity,c.id]);await owner.query('select public.case_access_session_create($1,$2,14400)',[c.identity,fixtureSha('case-access-session|'+c.session)]);
   const offer=offerSnapshot('initial');await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2026-06-01','2026-06-01',$3,'ILS',$4,$5,array['minimum_wage'],$6,'paid',now())",[c.orderId,c.id,offer.amount_minor,offer,offer.sha256,offer.terms_version]);await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[c.orderId]);
   await owner.query("select private.capture_case_input($1,'synthetic_dev_financial_paid_scope')",[c.id]);await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.dev.financial.worker',$3,now()-interval '1 minute',now()+interval '30 minutes',$4,now())",[`saved-case:${c.id}`,c.sid,c.jti,canonicalSha256({sid:c.sid,jti:c.jti})]);
  }await owner.query('commit');seeded=true;own();
  const first=await upload(inputs[0]);const firstRawLease=await claim();const extractedFirst=await extract(firstRawLease,first);expect(providerHashes).toContain(inputs[0].sha256);
  writeFileSync(`${directory}/initial-extraction.json`,JSON.stringify(extractedFirst.result,null,2)+'\n');
  checks.push('actual web reservation, non-upsert signed Storage transfer, byte validation and commit feed the actual durable V2 extraction adapter and saved receipt; provider output is explicitly injected');
  await expect(transactions(worker)(async()=>worker.query('select private.dev_financial_request_open($1,$2,$3,$4)',[primary.id,primary.orderId,firstRawLease.job.revision,firstRawLease.job.input_sha256]))).rejects.toThrow('DEV_FINANCIAL_HOURS_NOT_MISSING');
  checks.push('the actual SQL write boundary refuses a missing-hours question when the persisted extraction already contains regular hours');
  await expect(calculate(firstRawLease.job)).rejects.toThrow('DEV_FINANCIAL_CANONICAL_SCENARIO');expect(await counts()).toEqual({runs:0,findings:0});
  checks.push('raw V2 high-confidence candidates remain unconfirmed and cannot produce a financial run; the original canonical confirmation gate refuses them');
  const firstLease=await confirmSourceFields(first,extractedFirst.result,false);
  failBeforeSave=true;try{await expect(calculate(firstLease.job)).rejects.toThrow('INJECTED_BEFORE_FINANCIAL_SAVE');}finally{failBeforeSave=false;}expect(await counts()).toEqual({runs:0,findings:0});
  expect((await owner.query("select count(*)::int n from public.analysis_runs where tenant_id=$1 and status='completed'",[tenant])).rows[0].n).toBe(0);await storage.download(first.path);
  checks.push('failure immediately before financial save rolls back parent analysis, financial result and finding while the committed source and extraction receipt remain available');
  const initial=await calculate(firstLease.job);expect(initial.run.calculation).toMatchObject({state:'calculated',expectedMinor:DEV_FINANCIAL_ORACLE.expectedMinor,recordedMinor:DEV_FINANCIAL_ORACLE.baseMinor,gapMinor:DEV_FINANCIAL_ORACLE.gapMinor});expect(initial.run.finding?.analysis_run_id).toBe(initial.run.run_id);expect(initial.run.source.version_id).toBe(first.versionId);await recordArtifacts('initial-calculated',initial);
  checks.push('a hand-set independent 100-hour and 3300-ILS fixture produces 3540 ILS expected and 240 ILS difference from its actual canonical parent and exact saved document version; no finding or report was seeded');
  const beforeRetry=providerHashes.length;const retries=await Promise.all([calculate(firstLease.job),calculate(firstLease.job,peer)]);expect(retries.every(r=>r.receipt.replayed&&r.run.run_id===initial.run.run_id)).toBe(true);expect(await counts()).toEqual({runs:1,findings:1});expect(providerHashes).toHaveLength(beforeRetry);
  restarted=client('TIVDOC_WORKER_POSTGRES_URL');await restarted.connect();expect((await calculate(firstLease.job,restarted)).receipt.replayed).toBe(true);expect(await counts()).toEqual({runs:1,findings:1});
  checks.push('concurrent retries and a newly opened independent worker connection return the identical committed report without duplicate findings or another provider pass; this is connection restart, not process restart');
  if(processProof){
   const processInput=`../release-work/dev-financial-process-${primary.id}.json`,bundle=`${directory}/restart-proof.cjs`;
   writeFileSync(processInput,JSON.stringify({job:firstLease.job,orderId:primary.orderId,sid:primary.sid,jti:primary.jti,workerUrl:env.get('TIVDOC_WORKER_POSTGRES_URL'),gitSha,runId:initial.run.run_id,runSha256:canonicalSha256(initial.run)}));
   const {build}=await import('esbuild');await build({entryPoints:['src/server/product/processing/dev-financial-flow.restart-proof.mts'],outfile:bundle,bundle:true,platform:'node',format:'cjs',target:'node22',packages:'external',logLevel:'silent',plugins:[{name:'proof-server-only',setup(api){api.onResolve({filter:/^server-only$/},()=>({path:'server-only',namespace:'proof-marker'}));api.onLoad({filter:/.*/,namespace:'proof-marker'},()=>({contents:'export {};',loader:'js'}));}}]});
   const receipt=JSON.parse(execFileSync(process.execPath,[bundle],{encoding:'utf8',timeout:45000,maxBuffer:8192,env:{...process.env,TIVDOC_DEV_FINANCIAL_PROCESS_INPUT:processInput}}));
   expect(receipt).toEqual({state:'replayed',runId:initial.run.run_id,runSha256:canonicalSha256(initial.run),htmlSha256:initial.artifacts.htmlSha256,pdfSha256:initial.artifacts.pdfSha256});expect(await counts()).toEqual({runs:1,findings:1});expect(providerHashes).toHaveLength(beforeRetry);
   processChecks.push({receipt,bundleSha256:fixtureSha(readFileSync(bundle)),scope:'New Node process with independent DB connection; same saved report and no provider/Storage port'});
  }
  await expect(customer(cases[1].identity)).rejects.toThrow('DEV_FINANCIAL_FORBIDDEN');await expect(worker.query('select public.case_report_dev_financial($1,$2)',[primary.id,primary.identity])).rejects.toMatchObject({code:'42501'});
  await expect(web.query('select * from private.dev_financial_runs')).rejects.toMatchObject({code:'42501'});await expect(calculate({...firstLease.job,case_id:cases[1].id})).rejects.toThrow('DEV_FINANCIAL_FORBIDDEN');
  checks.push('a foreign customer cannot obtain the report payload or its source reference; the worker cannot use the customer RPC, web cannot read private rows, and the case worker cannot analyze another case');
  const second=await upload(inputs[1],first);expect(second.documentId).toBe(first.documentId);expect(second.versionId).not.toBe(first.versionId);await storage.download(first.path);
  await expect(calculate(firstLease.job)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');expect((await customer()).every(r=>r.current===false)).toBe(true);
  checks.push('explicit upload replacement preserves old bytes and history but immediately makes the old result non-current and refuses old-job publication');
  const missingRawLease=await claim();const extractedMissing=await extract(missingRawLease,second);
  const missingCheckpoint=z.object({run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema})})}).parse(extractedMissing.result);
  expect(missingCheckpoint.run.result.final_extraction.fields.some(f=>f.field==='regular_hours'&&f.normalized_value!==null)).toBe(false);
  const missingLease=await confirmSourceFields(second,extractedMissing.result,true);
  const missing=await calculate(missingLease.job);expect(missing.run.calculation).toEqual({state:'missing_input',fields:['work.regular_hours']});expect(missing.run.finding).toBeNull();expect(missing.run.request_id).toBeTruthy();await recordArtifacts('missing-hours',missing);
  const missingRetries=await Promise.all([calculate(missingLease.job),calculate(missingLease.job,peer)]);
  expect(missingRetries.every(r=>r.receipt.replayed&&r.run.request_id===missing.run.request_id)).toBe(true);
  expect((await owner.query('select count(*)::int n from private.dev_financial_request_targets where case_id=$1',[primary.id])).rows[0].n).toBe(1);
  expect(await counts()).toEqual({runs:2,findings:1});checks.push('the second actual uploaded PDF has explicitly missing hours; the injected adapter preserves absence, and analysis opens one focused identified-answer request with no monetary finding, including concurrent replay without duplicate questions');
  const requestId=missing.run.request_id!;const answer=(value:string,identity=primary.identity)=>web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[requestId,primary.id,identity,value]);
  await expect(answer('100',cases[1].identity)).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');for(const bad of ['0','183','1e2','010','01.5'])await expect(answer(bad)).rejects.toThrow('REQUEST_ANSWER_INVALID');
  const preview=async(stage:'missing'|'completed',answered?:Awaited<ReturnType<typeof calculate>>)=>{if(!previewProof)return;
   const hookPath='../../../../scripts/release-completion/'+'preview-dev-financial-flow.mts';
   const hook=await import(hookPath);if(typeof hook.verifyDevFinancialPreview!=='function')throw Error('DEV_FINANCIAL_PREVIEW_HOOK');
   const proof=await hook.verifyDevFinancialPreview({stage,cases,gitSha,directory,first,second,initial:initial.run,missing:missing.run,answered:answered?.run});
   previewChecks.push(z.array(z.object({name:z.string().min(1),passed:z.literal(true)})).min(1).parse(proof));
  };
  await preview('missing');
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
  await preview('completed',answered);
 }catch(error){failure=error instanceof Error?error.message:'DEV_FINANCIAL_PROOF_FAILED';throw error;}finally{
  await Promise.all([owner,worker,peer,web,...(restarted?[restarted]:[])].map(db=>db.query('rollback').catch(()=>{})));
  try{if(seeded){await owner.query('begin');for(const c of cases){await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[`saved-case:${c.id}`]);await owner.query("update public.engine_durable_jobs set state='cancelled',cancellation_requested=true,lease_owner=null,lease_expires_at=null,revision=revision+1 where tenant_id=$1 and canonical_case_id=$2 and state in ('queued','leased','running','retry_wait')",[`saved-case:${c.id}`,c.id]);await owner.query('update public.product_identity_sessions set revoked_at=coalesce(revoked_at,now()) where tenant_id=$1 and sid=$2',[`saved-case:${c.id}`,c.sid]);}
   expect((await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic DEV financial flow'",[cases.map(c=>c.id)])).rowCount).toBe(2);removedIdentities=(await owner.query('delete from public.case_identities where id=any($1::uuid[])',[cases.map(c=>c.identity)])).rowCount??0;expect(removedIdentities).toBe(2);await owner.query('commit');cleaned=true;
   for(const path of paths)expect(path.startsWith(`cases/${primary.id}/versions/`)).toBe(true);if(paths.length){const removal=await bucket.remove(paths);if(removal.error)throw Error('DEV_FINANCIAL_STORAGE_CLEANUP');}const remaining=await bucket.list(`cases/${primary.id}/versions`);if(remaining.error||remaining.data.length)throw Error('DEV_FINANCIAL_STORAGE_REMAINS');storageCleaned=true;
  }}catch(error){cleanupFailure=error instanceof Error?error.message:'DEV_FINANCIAL_CLEANUP_FAILED';await owner.query('rollback').catch(()=>{});throw error;}finally{
   writeFileSync('docs/release-evidence/DEV-financial-flow-db.json',JSON.stringify({verdict:!failure&&!cleanupFailure&&cleaned&&storageCleaned&&checks.length===12&&confirmationChecks.length===2&&(!processProof||processChecks.length===1)&&(!previewProof||previewChecks.length===2)?'PASS':'FAIL',gitSha,gitWorktreeDirty:dirty,migration:'20260909043527_dev_financial_analysis_flow.sql',migrationSha256:fixtureSha(readFileSync('supabase/migrations/20260909043527_dev_financial_analysis_flow.sql')),schemaTail:'20260909050400_document_metadata_readings.sql',schemaTailSha256:fixtureSha(readFileSync('supabase/migrations/20260909050400_document_metadata_readings.sql')),schemaMigrationCount:124,checks,confirmationChecks,processChecks,previewChecks,failure,cleanupFailure,runs,providerKind:'injected V2 transport; no network OCR',providerPasses:providerHashes.length,distinctProviderInputs:[...new Set(providerHashes)],independentExpected:DEV_FINANCIAL_ORACLE,syntheticCasesRemoved:cleaned?2:0,syntheticIdentitiesRemoved:removedIdentities,machineSessionsRevoked:cleaned?2:0,storageObjectsRemoved:storageCleaned?paths.length:0,sourceFiles:inputs.map(i=>({name:i.name,sha256:i.sha256})),canonicalAuditRetained:true,uploadProof:'Actual web-role reserve/commit and signed private Storage bytes; no browser HTTP upload route in this proof',browserProofRequested:previewProof,processRestartProofRequested:processProof,browserProof:previewProof&&previewChecks.length===2,processRestartProof:processProof&&processChecks.length===1,liveOcrProof:false,productionChanged:false},null,2)+'\n');
   await Promise.all([owner.end(),worker.end(),peer.end(),web.end(),...(restarted?[restarted.end()]:[])]);
  }
 }
},240000);
