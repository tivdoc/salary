import {expect,it,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema,type DocumentReviewInput} from '@/engine/document-review/contracts';
import type {DocumentReviewCalculationInput} from '@/engine/document-review/calculations';
import {replayDocumentReview} from '@/engine/document-review/service';
import {documentUploadSchema,type DocumentUpload} from '@/lib/document-upload';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {postgresCaseAccessDb,type CaseAccessDb} from '../case-access/db';
import {prepareUpload,completeUpload,type UploadBatch,type ReservedFile} from '../documents/upload';
import {reviewUploadReceiptSchema} from '../documents/review-fulfillment';
import {offerSnapshot} from '../orders/contracts';
import {listCaseRequests,documentRequestSatisfied} from '../reports/case-requests';
import {privateDocumentReviewReports,privateDocumentReviewArtifact} from '../reports/private-document-review';
import {saveSavedDocumentReview} from './saved-document-review';
import {runSavedWorkerMonth} from './saved-worker';
import {claimSavedDraftJob} from './saved-job-runtime';
import {completeSavedDraftJob} from './saved-job-completion';
import {sourceJobSchema,type SourceJob} from './source-dispatch';

const bridge=vi.hoisted(()=>({db:null as CaseAccessDb|null,admin:null as unknown}));
vi.mock('server-only',()=>({}));
vi.mock('../case-access/db',async original=>({...await original<typeof import('../case-access/db')>(),resolveCaseAccessDb:async()=>bridge.db}));
vi.mock('@/lib/supabase-admin',()=>({getSupabaseAdmin:()=>bridge.admin}));
const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const period={from:'2026-06-01',to:'2026-06-30'};
const ORACLE={period,grossMinor:330000,deductionsMinor:19800,netMinor:310200,differenceMinor:0,
 meaning:'Printed synthetic source arithmetic 3300.00 - 198.00 = 3102.00; no entitlement or actual fund transfer.'};

async function sourceFile(complete:boolean,revision:string){
 const pdf=await PDFDocument.create();pdf.setCreationDate(new Date('2026-06-30T00:00:00Z'));pdf.setModificationDate(new Date('2026-06-30T00:00:00Z'));
 const font=await pdf.embedFont(StandardFonts.Helvetica),page=pdf.addPage([595,842]);
 const lines=['SYNTHETIC PAYSLIP - SOURCE REVIEW TEST ONLY',`Source edition: ${revision}`,'Period: June 2026 (01/06/2026 - 30/06/2026)',
  'Gross salary: 3300.00 ILS','Total deductions: 198.00 ILS',complete?'Net salary: 3102.00 ILS':'Net salary: CROPPED / NOT VISIBLE',
  'Regular hours: NOT PRINTED - requires a separate declaration',complete?'END OF COMPLETE SINGLE PAGE SOURCE':'PARTIAL SOURCE - LOWER CONTENT NOT AVAILABLE',
  'No real employee, legal approval, provider OCR or fund transfer is claimed.'];
 for(const [i,line]of lines.entries())page.drawText(line,{font,size:11,x:28,y:795-i*31});
 const bytes=await pdf.save();return {bytes,sha256:sha(bytes),lines,complete,name:`synthetic-${revision}.pdf`};
}
type Source=Awaited<ReturnType<typeof sourceFile>>;
type Uploaded={source:Source;file:ReservedFile;batchId:string};

it.skipIf(process.env.TIVDOC_SAVED_REVIEW_UPLOAD_DB_PROOF!=='1')('fulfills only the requested source information through actual DEV upload, saved AI source review and ordinary same-run assessment',async()=>{
 if(process.env.NODE_ENV!=='test'||process.env.VERCEL)throw Error('REVIEW_UPLOAD_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const connection=(key:string)=>{const url=new URL(env.get(key)!);expect(url.pathname).toBe('/tivdoc_release_replay_20260907');
  expect(url.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(url.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);url.search='';
  return new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});};
 const owner=connection('TIVDOC_DEV_DATABASE_URL'),worker=connection('TIVDOC_WORKER_POSTGRES_URL'),peer=connection('TIVDOC_WORKER_POSTGRES_URL'),web=connection('TIVDOC_WEB_POSTGRES_URL');
 const storageConfig=JSON.parse(readFileSync(process.env.TIVDOC_SAVED_STORAGE_CREDENTIALS_FILE??'','utf8'));
 expect(storageConfig.NEXT_PUBLIC_SUPABASE_URL).toBe('https://cpzrbidxftzqcfeqqusu.supabase.co');
 const remote=createClient(storageConfig.NEXT_PUBLIC_SUPABASE_URL,storageConfig.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}),bucket=remote.storage.from('salary-documents');
 const caseId=randomUUID(),foreignCaseId=randomUUID(),orderId=randomUUID(),tenant='saved-case:'+caseId,sid='review-upload:'+randomUUID(),jti=randomUUID();
 const directory='output/release-completion/review-upload-db/'+caseId.slice(0,8),ownedFile='../release-work/review-upload-db-'+caseId+'.private.json';mkdirSync(directory,{recursive:true});
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;
 const sources=[await sourceFile(false,'initial'),await sourceFile(false,'second-partial'),await sourceFile(true,'complete')];
 sources.forEach(source=>writeFileSync(directory+'/'+source.name,source.bytes));writeFileSync(directory+'/independent-oracle.json',JSON.stringify(ORACLE,null,2)+'\n');
 const checks:string[]=[],uploads:Uploaded[]=[],jobs:string[]=[],artifacts:Record<string,unknown>[]=[],receipts:unknown[]=[];
 let identity='',foreignIdentity='',requestId='',phase='connect',statementName='',seeded=false,finished=false,machineRevoked=false;
 let failure:unknown=null,cleanupFailure:unknown=null,failBeforeAssessment=false,downloads=0;
 const safeError=(error:unknown)=>({phase,statementName,name:error instanceof Error?error.name:'unknown',
  code:typeof error==='object'&&error!==null&&'code'in error?String(error.code):null,
  message:error instanceof Error&&/^[A-Z0-9_:]+$/.test(error.message)?error.message:'SCOPED_PROOF_FAILURE'});
 const own=()=>writeFileSync(ownedFile,JSON.stringify({caseId,foreignCaseId,orderId,identity,foreignIdentity,sid,jti,requestId,jobs,
  paths:uploads.map(u=>u.file.path),directory,scope:'Owned synthetic QA only. Retain immutable sources/receipts/reports; cancel only listed unfinished jobs and revoke this machine. No provider or customer session.'},null,2)+'\n');own();
 const transactions=(db:pg.Client)=>async<T>(operation:(context:PostgresTransactionContext)=>Promise<T>)=>{
  await db.query('begin');try{await db.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'review-upload-proof']);
   await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[gitSha]);
   const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(s){statementName=s.name;
    if(failBeforeAssessment&&s.name==='review_upload_assess')throw Error('INJECTED_BEFORE_UPLOAD_ASSESSMENT');
    const r=await db.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),row_count:r.rowCount??0};}}};
   const result=await operation(context);await db.query('commit');return result;
  }catch(error){await db.query('rollback');throw error;}
 };
 const claim=()=>transactions(worker)(async context=>{const lease=await claimSavedDraftJob(context,{caseId,workerId:'review-upload-proof',leaseMs:300000});
  if(lease.state!=='claimed')throw Error('REVIEW_UPLOAD_EXPECTED_CLAIM');jobs.push(lease.jobId);own();
  const job=sourceJobSchema.parse((await worker.query('select payload from public.engine_durable_jobs where job_id=$1',[lease.jobId])).rows[0].payload);
  return {job,jobId:lease.jobId,workerId:'review-upload-proof',fencingToken:lease.fencingToken};});
 const calculate=(job:SourceJob,db=worker)=>transactions(db)(context=>runSavedWorkerMonth({context,job,orderId,month:'2026-06'}));
 const finish=(lease:Awaited<ReturnType<typeof claim>>)=>transactions(worker)(context=>completeSavedDraftJob({context,...lease}));
 const pin=(u:Uploaded)=>({case_id:caseId,document_id:u.file.documentId,version_id:u.file.versionId,source_sha256:u.source.sha256});
 const makeManifest=(source:Source,request=requestId,month='2026-06',targetCase=caseId):DocumentUpload=>documentUploadSchema.parse({caseId:targetCase,batchId:randomUUID(),checkPeriodMonth:'2026-06',
  ...(request?{requestId:request}:{}),files:[{clientId:randomUUID(),documentType:'payslip',name:source.name,type:'application/pdf',size:source.bytes.length,sha256:source.sha256,periodMonth:month}]});
 const upload=async(source:Source)=>{const manifest=makeManifest(source),signed=await prepareUpload(manifest);expect(signed.completed).toBe(false);expect(signed.uploads).toHaveLength(1);
  const batch=(await web.query('select public.case_documents_batch($1,$2) value',[caseId,manifest.batchId])).rows[0].value as UploadBatch;
  const file=batch.files[0];expect(file.path).toBe(`cases/${caseId}/versions/${file.versionId}.pdf`);
  const entry={source,file,batchId:manifest.batchId};uploads.push(entry);own();
  const signedUrl=signed.uploads[0].signedUrl;if(!signedUrl)throw Error('REVIEW_UPLOAD_SIGNED_URL_REQUIRED');
  const token=new URL(signedUrl).searchParams.get('token');if(!token)throw Error('REVIEW_UPLOAD_TOKEN_REQUIRED');
  const sent=await bucket.uploadToSignedUrl(file.path,token,source.bytes,{contentType:'application/pdf'});if(sent.error)throw Error('REVIEW_UPLOAD_STORAGE_TRANSFER');
  const snapshot=await completeUpload(caseId,manifest.batchId);expect(snapshot.documents.some(d=>d.id===file.documentId&&d.version_id===file.versionId)).toBe(true);
  if(requestId){const receipt=reviewUploadReceiptSchema.parse(snapshot.reviewReceipts?.find(r=>r.batch_id===manifest.batchId));
   expect(receipt).toMatchObject({case_id:caseId,request_id:requestId,state:'received_pending_review',files:[{document_id:file.documentId,version_id:file.versionId,source_sha256:source.sha256}]});receipts.push(receipt);
   expect((await listCaseRequests(caseId,bridge.db!,identity)).find(r=>r.id===requestId)).toMatchObject({answered_at:null,source_current:true,document_upload_state:{state:'received_pending_review',information_satisfied:false}});}
  const before=downloads;const repeated=await completeUpload(caseId,manifest.batchId);expect(repeated).toEqual(snapshot);expect(downloads).toBe(before);return entry;};
 const readingSha=(u:Uploaded)=>canonicalSha256({source_sha256:u.source.sha256,printed_lines:u.source.lines,origin:'automated_known_synthetic_ai_source_review',human_review:false});
 const reviewInput=(latest:Uploaded):DocumentReviewInput=>{
  const first=uploads[0],complete=latest.source.complete,source={document_id:latest.file.documentId,version_id:latest.file.versionId,file_sha256:latest.source.sha256,
   page:1,locator:'Synthetic June payroll totals rows 4–6',label:'Gross / deductions / net',reading:'ai_document_review' as const,reading_receipt_sha256:readingSha(latest)};
  const calculation:DocumentReviewCalculationInput={schema_version:'document-review-calculation-input-v1',case_id:caseId,run_id:'pending',check_id:'source.payroll.review',period,evaluated_at:'2026-09-11T18:00:00Z',
   source_manifest:[{case_id:caseId,document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'case_document'}],
   operands:[{id:'gross',observation_id:'printed.gross',printed_value:'3300.00'},{id:'deductions',observation_id:'printed.deductions',printed_value:'198.00'},{id:'net',observation_id:'printed.net',printed_value:complete?'3102.00':null}]
    .map(o=>({...o,state:o.printed_value===null?'missing' as const:'observed' as const,representation:'money_ils' as const,quantity_unit:null,precision:'source_exact' as const,source})),
   operation:{kind:'reconciliation',add_refs:['gross'],subtract_refs:['deductions'],recorded_ref:'net',inventory_complete:true,inventory_basis:'Exact three printed aggregate rows; no earnings-row completeness assertion.',disjoint_components:true,overlap_basis:'The deducted total is subtracted once from the gross total, and compared with the printed net.'},remittance_status:'not_assessed'};
  return documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period,purchased_scope:{order_id:orderId,receipt_sha256:offerSnapshot('initial').sha256,topics:['working_time','pension'],origin:'saved_order'},
   documents:uploads.map(u=>({case_id:caseId,document_id:u.file.documentId,version_id:u.file.versionId,file_sha256:u.source.sha256,page_count:1,kind:'payslip',label:u.source.name,period,reading_origin:'ai_document_review',reading_sha256:readingSha(u)})),
   checks:[{check_id:calculation.check_id,topic:'pension',title:'התאמת סכומי התלוש הסינתטי',explanation:'חשבון המקור בלבד: ברוטו פחות ניכויים מול נטו. אין קביעת זכאות או הפקדה.',calculation}],
   coverage_gaps:[{check_id:'hours.pending',topic:'working_time',kind:'missing_fact',detail:'שעות העבודה אינן רשומות במסמך הסינתטי.',next_step:'נדרשת הצהרה נפרדת על שעות העבודה.'}],
   completion_input:{case_id:caseId,period,documents:uploads.map(u=>({pin:pin(u),kind:'payslip',period,review:u.source.complete?'complete':'partial'})),
    evidence:complete?[{evidence_id:'synthetic.full-source.'+latest.file.versionId,case_id:caseId,fact_key:'payslip.full',period,origin:'document',state:'observed',source_reviewed:true,source_pins:[pin(latest)],
     value:JSON.stringify({origin:'automated_known_synthetic_ai_source_review',human_review:false,source_sha256:latest.source.sha256,page_count:1,all_printed_lines:latest.source.lines})}]:[],
    needs:[{fact_key:'payslip.full',kind:'document',document_kind:'payslip',reason:'unreadable',required_evidence_kind:'document',question:'נא לצרף את התלוש הסינתטי המלא ליוני, לרבות חלקו התחתון.',answer_kind:'document',source_pins:[pin(first)],dependent_check_ids:['source.payroll.review'],general_question:false},
     {fact_key:'hours.actual',kind:'factual',reason:'missing',required_evidence_kind:'customer_declaration',question:'כמה שעות עבודה בפועל היו בתקופה המסומנת?',answer_kind:'number',source_pins:[pin(first)],dependent_check_ids:['hours.pending'],general_question:false}]}});
 };
 const saveAndClaim=async(latest:Uploaded)=>{const old=await claim(),admitted=await transactions(worker)(context=>saveSavedDocumentReview(context,old.job,reviewInput(latest)));
  expect(admitted.changed).toBe(true);expect(admitted.source_job.revision).toBeGreaterThan(old.job.revision);
  await expect(calculate(old.job)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');const fresh=await claim();expect(fresh.job).toEqual(admitted.source_job);return fresh;};
 const saveArtifact=(label:string,run:Awaited<ReturnType<typeof calculate>>)=>{if(!run.completed||!run.bundle?.document_review||!run.report)throw Error('REVIEW_UPLOAD_REPORT_REQUIRED');
  const review=replayDocumentReview(run.bundle.document_review);expect(run.report.analysis_result_sha256).toBe(run.bundle.result_sha256);
  for(const [extension,bytes,hash]of [['json',run.report.json,run.report.json_sha256],['html',run.report.html,run.report.html_sha256],['pdf',run.report.pdf,run.report.pdf_sha256]] as const){expect(sha(bytes)).toBe(hash);writeFileSync(`${directory}/${label}.${extension}`,bytes);}
  writeFileSync(`${directory}/${label}.review.json`,JSON.stringify(review,null,2)+'\n');artifacts.push({label,analysis_run_id:review.analysis_run_id,report_id:run.report.report_id,input_revision:run.command.case_revision,review_sha256:review.result_sha256,pdf_sha256:run.report.pdf_sha256,html_sha256:run.report.html_sha256});return review;};
 const counts=async()=>(await owner.query(`select (select count(*)::int from public.analysis_runs where tenant_id=$1) analyses,
  (select count(*)::int from private.document_review_upload_assessments where case_id=$2) assessments,
  (select count(*)::int from private.case_extraction_invocations where case_id=$2) provider_invocations`,[tenant,caseId])).rows[0];
 try{
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect()]);
  expect((await worker.query('select session_user value')).rows[0].value).toBe('tivdoc_worker_runtime');expect((await web.query('select session_user value')).rows[0].value).toBe('tivdoc_web_runtime');
  const info=await remote.storage.getBucket('salary-documents');if(info.error||info.data.public)throw Error('REVIEW_UPLOAD_PRIVATE_BUCKET_REQUIRED');
  bridge.db=postgresCaseAccessDb(web);bridge.admin={storage:{from:(name:string)=>{expect(name).toBe('salary-documents');return {
   info:(path:string)=>bucket.info(path),createSignedUploadUrl:(path:string,options:{upsert:boolean})=>{expect(options.upsert).toBe(false);return bucket.createSignedUploadUrl(path,{upsert:false});},
   download:async(path:string)=>{expect(uploads.some(u=>u.file.path===path)).toBe(true);downloads++;return bucket.download(path);},
  };}}};
  phase='provision-owned-fixture';await owner.query('begin');
  for(const id of [caseId,foreignCaseId]){const email='review-upload-'+id+'@example.invalid';
   await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic source upload proof',$2,'0500000000',true,'under_review','verified',now(),'2026-06-01')",[id,email]);
   const actor=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[sha('email|'+email),email])).rows[0].id;
   await owner.query('select public.case_access_identity_link($1,$2)',[actor,id]);if(id===caseId)identity=actor;else foreignIdentity=actor;}
  const offer=offerSnapshot('initial');await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2026-06-01','2026-06-01',$3,'ILS',$4,$5,array['working_time','pension'],$6,'paid',now())",[orderId,caseId,offer.amount_minor,offer,offer.sha256,offer.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[orderId]);await owner.query("select private.capture_case_input($1,'synthetic_review_upload_paid_scope')",[caseId]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.review.upload.worker',$3,now()-interval '1 minute',now()+interval '30 minutes',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);
  await owner.query('commit');seeded=true;own();
  phase='initial-upload-and-ordinary-request';const first=await upload(sources[0]),firstLease=await saveAndClaim(first),initial=await calculate(firstLease.job);saveArtifact('initial-partial',initial);await finish(firstLease);
  const initialRequests=await listCaseRequests(caseId,bridge.db,identity);expect(initialRequests.filter(r=>r.code.startsWith('document_review:'))).toHaveLength(2);
  const documentRequest=initialRequests.find(r=>r.answer_kind==='document');if(!documentRequest)throw Error('REVIEW_UPLOAD_DOCUMENT_REQUEST_REQUIRED');requestId=documentRequest.id;own();
  expect(documentRequest).toMatchObject({answered_at:null,source_current:true,document_upload_state:{state:'requested',information_satisfied:false}});
  checks.push('real signed Storage upload and ordinary AI source-review analysis create a bound full-source request and a separate factual question; no finding/report was seeded');
  phase='wrong-scope-refusals';const beforeBatches=(await owner.query('select count(*)::int n from public.document_upload_batches where case_id=$1',[caseId])).rows[0].n;
  await expect(prepareUpload(makeManifest(sources[2],requestId,'2026-05'))).rejects.toThrow('UPLOAD_REQUEST_CONFLICT');
  await expect(prepareUpload(makeManifest(sources[2],requestId,'2026-06',foreignCaseId))).rejects.toThrow('UPLOAD_REQUEST_CONFLICT');
  expect((await owner.query('select count(*)::int n from public.document_upload_batches where case_id=$1',[caseId])).rows[0].n).toBe(beforeBatches);
  await expect(web.query('select * from public.case_request_review_upload_states($1,$2)',[caseId,foreignIdentity])).rejects.toThrow('REVIEW_REQUEST_FORBIDDEN');
  checks.push('wrong purchased month and foreign-case request cannot reserve an upload; foreign identity cannot read the request receipt state');
  phase='duplicate-upload';const duplicate=await upload(sources[0]);expect((receipts.at(-1) as {files:{duplicate_content:boolean}[]}).files[0].duplicate_content).toBe(true);
  const duplicateLease=await saveAndClaim(duplicate),duplicateRun=await calculate(duplicateLease.job);saveArtifact('duplicate-source',duplicateRun);await finish(duplicateLease);
  expect((await listCaseRequests(caseId,bridge.db,identity)).find(r=>r.id===requestId)).toMatchObject({answered_at:null,source_current:true,document_upload_state:{state:'insufficient',information_satisfied:false,reason:'duplicate_content'}});
  checks.push('the same bytes under a new immutable UUID remain insufficient; receipt does not answer or satisfy the request');
  phase='partial-upload';const partial=await upload(sources[1]),partialLease=await saveAndClaim(partial),partialRun=await calculate(partialLease.job);saveArtifact('second-partial-source',partialRun);await finish(partialLease);
  expect((await listCaseRequests(caseId,bridge.db,identity)).find(r=>r.id===requestId)).toMatchObject({answered_at:null,document_upload_state:{state:'insufficient',information_satisfied:false,reason:'target_specific_observation_required'}});
  checks.push('a different real uploaded but cropped source stays insufficient after a new saved analysis');
  phase='complete-upload-before-assessment';const complete=await upload(sources[2]),finalLease=await saveAndClaim(complete),before=await counts();
  failBeforeAssessment=true;try{await expect(calculate(finalLease.job)).rejects.toThrow('INJECTED_BEFORE_UPLOAD_ASSESSMENT');}finally{failBeforeAssessment=false;}
  expect(await counts()).toEqual(before);checks.push('failure immediately before persisted assessment rolls back the new analysis/report/assessment while the committed upload remains received');
  phase='positive-same-run-assessment';const final=await calculate(finalLease.job),review=saveArtifact('complete-source',final);await finish(finalLease);
  expect(review.checks[0].calculation.state).toBe('calculated');expect(review.checks[0].calculation.difference).toEqual({kind:'money',currency:'ILS',minor_units:0});
  const currentRequests=await listCaseRequests(caseId,bridge.db,identity),satisfied=currentRequests.find(r=>r.id===requestId)!;
  expect(satisfied).toMatchObject({answered_at:null,source_current:true,document_upload_state:{state:'satisfied',information_satisfied:true,analysis_run_id:review.analysis_run_id,reason:'target_specific_observed_source'}});
  expect(documentRequestSatisfied(satisfied)).toBe(true);expect(currentRequests.filter(r=>r.answer_kind!=='document'&&r.answered_at===null&&r.source_current!==false)).toHaveLength(1);
  const stored=(await owner.query('select assessment from private.document_review_upload_assessments where case_id=$1 and canonical_analysis_run_id=$2',[caseId,review.analysis_run_id])).rows;
  expect(stored).toHaveLength(1);expect(stored[0].assessment).toMatchObject({verified_source_pins:[pin(complete)],analysis_result_sha256:review.result_sha256,information_satisfied:true});
  checks.push('only the full-source document request becomes satisfied from target-specific AI source evidence and the same persisted report; missing hours remains open and no customer answer is fabricated');
  phase='parallel-and-restart-replay';const finalCounts=await counts();const repeats=await Promise.all([calculate(finalLease.job),calculate(finalLease.job,peer)]);
  expect(repeats.every(r=>r.report?.report_sha256===final.report!.report_sha256)).toBe(true);expect(await counts()).toEqual(finalCounts);
  await peer.end();const restarted=connection('TIVDOC_WORKER_POSTGRES_URL');try{await restarted.connect();expect((await calculate(finalLease.job,restarted)).report?.pdf_sha256).toBe(final.report!.pdf_sha256);}finally{await restarted.end();}
  expect(await counts()).toEqual(finalCounts);checks.push('parallel retry and a new authenticated connection replay identical report and assessment without duplicates; no detached process restart is claimed');
  phase='owner-history-and-source-fences';const current=await privateDocumentReviewArtifact(caseId,identity,final.report!.report_id,bridge.db);expect(current?.current).toBe(true);
  expect(current?.report.html).toEqual(final.report!.html);expect(current?.report.pdf).toEqual(final.report!.pdf);
  const old=await privateDocumentReviewArtifact(caseId,identity,initial.report!.report_id,bridge.db);expect(old?.current).toBe(false);expect(old?.report.pdf).toEqual(initial.report!.pdf);
  expect(await privateDocumentReviewReports(caseId,foreignIdentity,bridge.db)).toEqual([]);expect(await privateDocumentReviewArtifact(caseId,foreignIdentity,final.report!.report_id,bridge.db)).toBeNull();
  await owner.query('begin');try{await owner.query('update public.documents set version_id=$1,content_sha256=$2 where id=$3 and case_id=$4',[randomUUID(),'f'.repeat(64),complete.file.documentId,caseId]);
   expect((await owner.query('select private.document_review_upload_state($1,$2) value',[caseId,requestId])).rows[0].value.information_satisfied).toBe(false);}finally{await owner.query('rollback');}
  expect((await listCaseRequests(caseId,bridge.db,identity)).find(r=>r.id===requestId)?.document_upload_state?.information_satisfied).toBe(true);
  expect((await owner.query('select count(*)::int n from private.case_request_answer_versions a join public.case_requests q on q.id=a.request_id where q.case_id=$1',[caseId])).rows[0].n).toBe(0);
  expect((await owner.query('select count(*)::int n from public.case_notifications where case_id=$1',[caseId])).rows[0].n).toBe(0);expect((await counts()).provider_invocations).toBe(0);
  checks.push('owner sees exact current and historical private HTML/PDF; foreign access is refused; source replacement invalidates satisfaction in rollback; zero answer rows, provider calls or notifications');finished=true;
 }catch(error){failure=safeError(error);throw error;}
 finally{
  for(const db of [owner,worker,peer,web])await db.query('rollback').catch(()=>{});
  try{if(seeded){await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
   if(jobs.length)await owner.query("update public.engine_durable_jobs set state='cancelled',cancellation_requested=true,lease_owner=null,lease_expires_at=null,revision=revision+1 where tenant_id=$1 and canonical_case_id=$2 and job_id=any($3::text[]) and state in ('queued','leased','running','retry_wait')",[tenant,caseId,jobs]);
   const revoked=await owner.query('update public.product_identity_sessions set revoked_at=coalesce(revoked_at,now()) where tenant_id=$1 and sid=$2 returning sid',[tenant,sid]);expect(revoked.rowCount).toBe(1);await owner.query('commit');machineRevoked=true;}}
  catch(error){cleanupFailure=safeError(error);await owner.query('rollback').catch(()=>{});}
  writeFileSync(directory+'/proof.json',JSON.stringify({verdict:finished&&failure===null&&cleanupFailure===null?'PASS':'FAIL',gitSha,dirty,caseId,checks,artifacts,receipts,
   database:'tivdoc_release_replay_20260907',schemaTail:'20260911173500_scoped_financial_source_completion.sql',schemaTailSha256:sha(readFileSync('supabase/migrations/20260911173500_scoped_financial_source_completion.sql')),
   fixture:'Actual signed Storage uploads of synthetic PDFs; automated known-fixture AI source readings admitted through the verified ordinary worker. No result/assessment seeded.',
   liveOcr:false,automaticFinancialFourCellPolicyProved:false,sourceReviewPolicy:'explicit AI reviewed full source, distinct from live-only payslip.financial_source',
   providerCalls:0,customerSessionsCreated:false,browserVerified:false,notificationsSent:false,customerPublication:false,productionChanged:false,retainedOwnedQaCases:seeded?2:0,
   actualUploads:uploads.length,storageDownloads:downloads,machineRevoked,failure,cleanupFailure},null,2)+'\n');own();bridge.db=null;bridge.admin=null;
  await Promise.allSettled([owner,worker,peer,web].map(c=>c.end()));if(cleanupFailure&&!failure)throw Error('REVIEW_UPLOAD_PROOF_CLEANUP_FAILED');
 }
},300000);
