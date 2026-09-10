import {expect,it,vi} from 'vitest';
import {randomUUID,createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {employmentSnapshotSchema} from '@/engine/facts/snapshot';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {june2026CollectionTargetSchema,JUNE2026_COMPONENT_DECLARATIONS,JUNE2026_DECLARATION_OPTIONS} from '@/engine/minimum-wage-june2026/collection';
import {createRegularServiceTrustFixture} from '@/engine/minimum-wage-june2026/regular-service/regular-service.test-fixtures';
import type {June2026AssessmentPacket} from '@/engine/minimum-wage-june2026/assessment-packet';
import {documentUploadSchema} from '@/lib/document-upload';
import type {UploadBatch,ReservedFile} from '../documents/upload';
import {offerSnapshot} from '../orders/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {documentFieldTargetSchema,DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from '../reports/document-field-confirmation';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {decodeReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {claimSavedDraftJob,recordSavedJobFailure} from './saved-job-runtime';
import {runSavedWorkerExtraction,type SavedWorkerTransactions} from './saved-extraction-worker';
import {runSavedWorkerMonth} from './saved-worker';
import {runSavedDraftJob} from './saved-job-runner';
import {runAutomaticDevMonth} from './automatic-dev-flow';
import {runManagedDevCase} from './managed-worker-case';
import type {SourceJob} from './source-dispatch';
import {createSolBudgetedExtractor} from './sol-budgeted-extractor';
import {createSolSingleBaseSource} from './live-extraction-sol-comparison-fixtures';
vi.mock('server-only',()=>({}));
const OWNER='dcc1e30f-d516-47dd-a9d8-5365bfcd8b9a';
const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
function actualPdfText(bytes:Uint8Array){
 let previousY:string|null=null,text='';
 for(const match of Buffer.from(bytes).toString('latin1').matchAll(/\/ActualText <FEFF([0-9A-F]+)>[^\r\n]*?1 0 0 1 [-\d.]+ ([-\d.]+) Tm/gu)){
  if(previousY!==null&&previousY!==match[2])text+=' ';
  text+=String.fromCharCode(...match[1].match(/.{4}/gu)!.map(hex=>parseInt(hex,16)));previousY=match[2];
 }
 return text.replace(/\s+/gu,' ');
}

/** One actual source per invocation. A retained case can be resumed without a
 * second OCR charge; the normal immutable invocation/checkpoint owns reuse.
 * Only payment and isolated signing identities are synthetic. No result seed. */
it.skipIf(process.env.TIVDOC_JUNE_REGULAR_LIVE!=='1')('runs a real Hebrew source through saved canonical analysis and ordinary AI publication',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('REGULAR_LIVE_DEV_ONLY');
 const kind=z.enum(['clear','absent-hours','conflicting-hours']).parse(process.env.TIVDOC_JUNE_REGULAR_SOURCE);
 const attempt=process.env.TIVDOC_JUNE_REGULAR_PROMPT_FIX;
 if(attempt!==undefined&&(attempt!=='r5'||kind!=='clear'))throw Error('REGULAR_PROMPT_FIX_SCOPE');
 const source=createSolSingleBaseSource(kind),gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 expect(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()).toBe('');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},statement_timeout:30000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),peer=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const keys=z.object({NEXT_PUBLIC_SUPABASE_URL:z.literal('https://cpzrbidxftzqcfeqqusu.supabase.co'),SUPABASE_SERVICE_ROLE_KEY:z.string()}).parse(JSON.parse(readFileSync(process.env.TIVDOC_SAVED_STORAGE_CREDENTIALS_FILE!,'utf8')));
 const bucket=createClient(keys.NEXT_PUBLIC_SUPABASE_URL,keys.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from('salary-documents');
 const privatePath=`../release-work/june-regular-live-${kind}${attempt?'-'+attempt:''}.private.json`;
 const resumed=existsSync(privatePath)&&process.env.TIVDOC_JUNE_REGULAR_RESUME==='1';
 if(existsSync(privatePath)&&!resumed)throw Error('REGULAR_RETAINED_CASE_REQUIRES_EXPLICIT_RESUME');
 const prior=resumed?JSON.parse(readFileSync(privatePath,'utf8')):null;
 const replacePreflight=process.env.TIVDOC_JUNE_REGULAR_REPLACE_PREFLIGHT==='1';
 if(replacePreflight&&(!resumed||attempt!=='r5'||kind!=='clear'||prior?.priorVersions?.length))throw Error('REGULAR_REPLACE_PREFLIGHT_SCOPE');
 const priorVersions:ReservedFile[]=[...(prior?.priorVersions??[])];
 const caseId=prior?.caseId??randomUUID(),orderId=prior?.orderId??randomUUID(),sid='regular-live:'+randomUUID(),jti=randomUUID(),tenant='saved-case:'+caseId;
 let publicId=prior?.publicId??'',file:ReservedFile|null=prior?.file??null,phase='connect',failure:unknown=null,machine=false;
 let heldLease:{caseId:string;workerId:string;jobId:string;fencingToken:number}|null=null;
 const directory=`output/release-completion/june-regular/${kind}${attempt?'-'+attempt:''}-${caseId.slice(0,8)}`;mkdirSync(directory,{recursive:true});
 const checks:string[]=[],runs:Record<string,unknown>[]=[],answers:unknown[]=[];
 const own=()=>writeFileSync(privatePath,JSON.stringify({caseId,orderId,publicId,file,priorVersions,sid,jti,gitSha,sourceSha256:source.sha256,kind,directory},null,2)+'\n');
 const providerKey=z.object({OPENAI_API_KEY:z.string()}).parse(JSON.parse(readFileSync('../release-work/live-provider-worker-private.json','utf8')));
 const bounded=createSolBudgetedExtractor({apiKey:providerKey.OPENAI_API_KEY,ledgerPath:'output/release-completion/live-provider-sol-comparison/package-budget-ledger.json',
  artifactDirectory:directory+'/provider',codeRevision:gitSha,allowedSources:[{sha256:source.sha256,sizeBytes:source.sizeBytes,mimeType:source.mimeType}],maxGenerations:1,
  retainedDiagnosticPath:'output/release-completion/live-provider-sol-comparison/complex-c5051f3-4ec7efe8-8962-4308-aad9-abddf1cb22f6/he-clear-structured.json',
  ...(attempt?{reviewedRetry:{sourceSha256:source.sha256,priorReceiptSha256:JSON.parse(readFileSync('output/release-completion/june-regular/clear-6d31d6ee/checkpoint.json','utf8')).run.provider_receipts[0].receipt_sha256,reason:'header-observation-classification-r5' as const}}:{})});
 const transact=(db:pg.Client):SavedWorkerTransactions=>async op=>{await db.query('begin');try{
  await db.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'regular-live']);await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[gitSha]);
  const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(s){const r=await db.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),row_count:r.rowCount??0};}}};
  const result=await op(context);await db.query('commit');return result;
 }catch(e){await db.query('rollback');throw e;}};
 const head=async():Promise<SourceJob>=>{const h=(await owner.query("select h.revision,h.input_sha256,d.authority_dependency_sha256 from private.case_input_heads h left join private.case_analysis_dispatch d on d.case_id=h.case_id and d.revision=h.revision and d.mode='draft' where h.case_id=$1",[caseId])).rows[0];return {schema_version:'saved-case-work-v1',case_id:caseId,revision:Number(h.revision),input_sha256:h.input_sha256,mode:'draft',...(h.authority_dependency_sha256?{authority_dependency_sha256:h.authority_dependency_sha256}:{})};};
 const claim=()=>transact(worker)(async c=>{const lease=await claimSavedDraftJob(c,{caseId,workerId:'regular-live',leaseMs:300000});if(lease.state!=='claimed')throw Error('REGULAR_LIVE_CLAIM');heldLease={caseId,workerId:'regular-live',jobId:lease.jobId,fencingToken:lease.fencingToken};return {...lease,workerId:'regular-live'};});
 const extract=async()=>{const lease=await claim();return runSavedWorkerExtraction({...lease,versionId:file!.versionId,transactions:transact(worker),extractor:bounded.extractor,providerEnabled:true,
  storage:{async download(p){expect(p).toBe(file!.path);const r=await bucket.download(p);if(r.error||!r.data)throw Error('REGULAR_SOURCE_STORAGE');expect(sha(Buffer.from(await r.data.arrayBuffer()))).toBe(source.sha256);return {data:r.data,error:null};}}});};
 const calculate=(job:SourceJob,db=worker)=>transact(db)(context=>runSavedWorkerMonth({context,job,orderId,month:'2026-06'}));
 const exportRun=async(label:string,run:Awaited<ReturnType<typeof calculate>>)=>{
  if(!run.report)throw Error('REGULAR_REPORT_MISSING');const report=run.report;
  for(const [ext,bytes]of Object.entries({json:report.json,html:report.html,pdf:report.pdf,manifest:report.manifest}))writeFileSync(`${directory}/${label}.${ext}`,bytes);
  const body=JSON.parse(Buffer.from(report.json).toString('utf8'));expect(body.namespace).toBe('isolated_test');expect(body.execution.comparison.signed_difference.minor_units).toBe(24058);
  expect(body.execution.finding.schema_version).toBe('tivdoc-source-finding-v2');expect(body.bundle.analysis_run_id).toBe(run.analysis_run_id);
  for(const value of [run.analysis_run_id,file!.versionId,'3540.58 ILS','3300.00 ILS','240.58 ILS']){
   expect(Buffer.from(report.html).toString('utf8')).toContain(value);expect(actualPdfText(report.pdf)).toContain(value);
  }
  const result=(await web.query('select public.june2026_regular_report_artifact($1,$2,$3) value',[caseId,OWNER,report.report_id])).rows[0].value;
  expect(result.current).toBe(true);const stored=decodeReport(result.completion.report);expect(sha(stored.pdf)).toBe(report.pdf_sha256);expect(sha(stored.html)).toBe(report.html_sha256);
  await expect(web.query('select public.june2026_regular_report_artifact($1,$2,$3) value',[caseId,randomUUID(),report.report_id])).rejects.toThrow('REGULAR_REPORT_FORBIDDEN');
  const sourceRef=(await web.query('select public.case_report_source($1,$2,$3,$4) value',[caseId,OWNER,report.report_id,file!.versionId])).rows[0].value;
  expect(sourceRef).toMatchObject({path:file!.path,sha256:source.sha256,size:source.sizeBytes});
  await expect(web.query('select public.case_report_source($1,$2,$3,$4) value',[caseId,randomUUID(),report.report_id,file!.versionId])).rejects.toThrow();
  checks.push('ordinary_published_source_bound_and_foreign_source_denied');
  runs.push({label,runId:run.analysis_run_id,projectionId:report.report_id,pdfSha256:report.pdf_sha256,htmlSha256:report.html_sha256,revision:body.execution.input_revision,sourceSha256:source.sha256,
   hoursOrigin:body.execution.admission.hours_origin,expectedMinor:354058,recordedMinor:330000,gapMinor:24058});return body;
 };
 try{
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect()]);
  if(!resumed){
   await owner.query('begin');publicId=(await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic live canonical Hebrew',$2,'0500000000',true,'under_review','verified',now(),'2026-06-01') returning public_id",[caseId,`regular-${caseId}@example.invalid`])).rows[0].public_id;
   await owner.query('select public.case_access_identity_link($1,$2)',[OWNER,caseId]);
   const {sha256:initialHash,...initial}=offerSnapshot('initial');void initialHash;
   const offerBody={...initial,version:'tivdoc-order-offer-v2',kind:'full',service_kind:'ai_assisted',human_review_required:false,synthetic_paid_test_scope:true};
   const offer={...offerBody,sha256:canonicalSha256(offerBody)};
   await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'full','2026-06-01','2026-06-01',$3,'ILS',$4,$5,array['minimum_wage'],$6,'paid',now())",[orderId,caseId,offer.amount_minor,offer,offer.sha256,offer.terms_version]);
   await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[orderId]);await owner.query("select private.capture_case_input($1,'synthetic_paid_full_scope')",[caseId]);await owner.query('commit');own();
  }
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.regular.live.worker',$3,now()-interval '1 minute',now()+interval '2 hours',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);machine=true;own();
  phase='upload';if(!file||replacePreflight){
   const replaced=replacePreflight?file:null;
   const manifest=documentUploadSchema.parse({caseId,batchId:randomUUID(),checkPeriodMonth:'2026-06',files:[{clientId:randomUUID(),documentType:'payslip',name:source.name,type:source.mimeType,size:source.sizeBytes,sha256:source.sha256,periodMonth:'2026-06',...(replaced?{replace:{documentId:replaced.documentId,versionId:replaced.versionId}}:{})}]});
   const batch=(await web.query('select public.case_documents_reserve($1,$2,$3) value',[caseId,manifest.batchId,manifest])).rows[0].value as UploadBatch;file=batch.files[0];own();
   const signed=await bucket.createSignedUploadUrl(file.path,{upsert:false});if(signed.error||!signed.data)throw Error('REGULAR_UPLOAD_SIGN');
   const sent=await bucket.uploadToSignedUrl(file.path,signed.data.token,source.bytes,{contentType:source.mimeType});if(sent.error)throw Error('REGULAR_UPLOAD_TRANSFER');
   await web.query('select public.case_documents_commit($1,$2,$3)',[caseId,manifest.batchId,{[file.versionId]:source.sha256}]);
   if(replaced){priorVersions.push(replaced);own();checks.push('explicit_document_replacement_preserved_prior_invocation');}
  }
  phase='actual-live-extraction';const extracted=await extract();writeFileSync(directory+'/checkpoint.json',JSON.stringify(extracted.result,null,2)+'\n');
  const cp=z.object({result_sha256:z.string(),run:z.object({result:z.object({final_extraction:normalizedPayslipExtractionSchema})})}).parse(extracted.result),fields=cp.run.result.final_extraction.fields;
  const rawHours=fields.filter(f=>f.field==='regular_hours').map(f=>f.normalized_value);writeFileSync(directory+'/input.pdf',source.bytes);writeFileSync(directory+'/independent-oracle.json',JSON.stringify(source.oracle,null,2)+'\n');
  const currentJob=await head(),existingSigned=(await owner.query('select id from private.june2026_regular_assessments where case_id=$1 and order_id=$2 and input_revision=$3 and input_sha256=$4',[caseId,orderId,currentJob.revision,currentJob.input_sha256])).rows;
  if(resumed&&existingSigned.length){
   phase='resume-signed-canonical-execution';expect(extracted.reused).toBe(true);
   const run=await calculate(currentJob);await exportRun('report-resume-'+gitSha.slice(0,7),run);
   const resultCount=(await owner.query('select count(*)::int n from private.june2026_regular_results where case_id=$1',[caseId])).rows[0].n;
   const retried=await Promise.all([calculate(currentJob,worker),calculate(currentJob,peer)]);
   for(const r of retried)expect(r.report?.report_sha256).toBe(run.report?.report_sha256);
   expect((await owner.query('select count(*)::int n from private.june2026_regular_results where case_id=$1',[caseId])).rows[0].n).toBe(resultCount);
   checks.push('resumed_existing_live_checkpoint_without_provider_call','live_provider_to_canonical_finding_and_published_report','parallel_retry_same_report_no_duplicates');
   if(process.env.TIVDOC_JUNE_REGULAR_MANAGED_PROOF==='1'){
    phase='managed-callback-and-terminal-completion';expect(heldLease).not.toBeNull();
    const managedInput={...heldLease!,transactions:transact(worker),providerEnabled:true,extractor:bounded.extractor,onMonth:runAutomaticDevMonth,
     storage:{async download(p:string){expect(p).toBe(file!.path);const r=await bucket.download(p);if(r.error||!r.data)throw Error('REGULAR_SOURCE_STORAGE');return {data:r.data,error:null};}}};
    const completed=await runSavedDraftJob(managedInput);
    expect(completed.completion.manifest.months).toHaveLength(1);
    expect(completed.completion.manifest.months[0].analysis_run_id).toBe(run.analysis_run_id);
    expect(completed.analyzedMonths).toBe(1);
    const restarted=await runSavedDraftJob(managedInput);
    expect(restarted.completion.replayed).toBe(true);expect(restarted.analyzedMonths).toBe(0);
    expect(restarted.completion.sha256).toBe(completed.completion.sha256);
    expect((await owner.query('select count(*)::int n from private.june2026_regular_results where case_id=$1',[caseId])).rows[0].n).toBe(resultCount);
    writeFileSync(directory+'/managed-completion-'+gitSha.slice(0,7)+'.json',JSON.stringify({completed,restarted},null,2)+'\n',{flag:'wx'});
    checks.push('managed_callback_same_regular_run_and_current_publication','durable_job_terminal_success','restart_exact_terminal_manifest_no_duplicate_publication');
    if(process.env.TIVDOC_JUNE_REGULAR_DEPENDENCY_PROOF==='1'){
     phase='authority-change-wakes-existing-queue';const originalHead=await head();
     const assessmentId=(await owner.query('select id from private.june2026_regular_assessments where case_id=$1 and order_id=$2 and input_revision=$3',[caseId,orderId,originalHead.revision])).rows[0].id;
     let restored=false;const capabilityToken=randomUUID()+randomUUID(),capability=sha(capabilityToken);
     await owner.query("insert into private.managed_dev_worker_capabilities(capability_sha256,expires_at,daily_limit,total_limit) values($1,now()+interval '1 hour',6,6)",[capability]);
     const priorEnrollment=(await owner.query('select identity_id,enabled from private.managed_dev_worker_cases where case_id=$1',[caseId])).rows[0];
     if(priorEnrollment)expect(priorEnrollment).toEqual({identity_id:OWNER,enabled:false});
     await owner.query('insert into private.managed_dev_worker_cases(case_id,identity_id,session_sid,capability_sha256) values($1,$2,$3,$4) on conflict(case_id) do update set session_sid=excluded.session_sid,capability_sha256=excluded.capability_sha256,enabled=true,stopped_at=null',[caseId,OWNER,sid,capability]);
     try{
      // Toggle only this retained synthetic authority. Existing signatures and
      // findings are not edited; no new human approval is asserted.
      await owner.query('update private.june2026_regular_assessments set revoked_at=clock_timestamp() where id=$1',[assessmentId]);
      const revokedHead=await head();expect(revokedHead.revision).toBe(originalHead.revision);expect(revokedHead.input_sha256).toBe(originalHead.input_sha256);
      expect(revokedHead.authority_dependency_sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect((await peer.query('select case_id from private.managed_dev_worker_candidates($1,2)',[capabilityToken])).rows.map(r=>r.case_id)).toEqual([caseId]);
      const managedBlocked=await runManagedDevCase({...managedInput,caseId,workerId:'synthetic.regular.live.worker'});expect(managedBlocked.state).toBe('succeeded');
      const blockedJob=(await owner.query("select job_id,fencing_token from public.engine_durable_jobs where job_id=$1",['jobId' in managedBlocked?managedBlocked.jobId:null])).rows[0];
      const blockedLease={jobId:blockedJob.job_id,fencingToken:Number(blockedJob.fencing_token)};expect(blockedLease.jobId).not.toBe(managedInput.jobId);
      const blockedInput={...managedInput,...blockedLease,workerId:'synthetic.regular.live.worker'},blockedCompletion=await runSavedDraftJob(blockedInput);
      const blockedParent=await calculate(await head());expect(blockedParent.command.mode).toBe('real');expect(blockedParent.bundle?.topic_results[0].amount).toBeNull();
      const oldReplay=await runSavedDraftJob(managedInput);expect(oldReplay.completion.sha256).toBe(completed.completion.sha256);
      await owner.query('update private.june2026_regular_assessments set revoked_at=null where id=$1',[assessmentId]);restored=true;
      const restoredHead=await head();expect(restoredHead.revision).toBe(originalHead.revision);expect(restoredHead.input_sha256).toBe(originalHead.input_sha256);
      expect(restoredHead.authority_dependency_sha256).not.toBe(revokedHead.authority_dependency_sha256);
      expect((await peer.query('select case_id from private.managed_dev_worker_candidates($1,2)',[capabilityToken])).rows.map(r=>r.case_id)).toEqual([caseId]);
      const managedActive=await runManagedDevCase({...managedInput,caseId,workerId:'synthetic.regular.live.worker'});expect(managedActive.state).toBe('succeeded');
      const activeJob=(await owner.query("select job_id,fencing_token from public.engine_durable_jobs where job_id=$1",['jobId' in managedActive?managedActive.jobId:null])).rows[0];
      const activeLease={jobId:activeJob.job_id,fencingToken:Number(activeJob.fencing_token)};expect(activeLease.jobId).not.toBe(blockedLease.jobId);
      const activeInput={...managedInput,...activeLease,workerId:'synthetic.regular.live.worker'},activeCompletion=await runSavedDraftJob(activeInput);
      const activeParent=await calculate(restoredHead);await exportRun('dependency-current',activeParent);
      expect(activeParent.analysis_run_id).not.toBe(run.analysis_run_id);
      const activeRestart=await runSavedDraftJob(activeInput);expect(activeRestart.completion.sha256).toBe(activeCompletion.completion.sha256);
      expect((await runSavedDraftJob(blockedInput)).completion.sha256).toBe(blockedCompletion.completion.sha256);
      expect((await runSavedDraftJob(managedInput)).completion.sha256).toBe(completed.completion.sha256);
      writeFileSync(directory+'/authority-dependency-'+gitSha.slice(0,7)+'.json',JSON.stringify({originalHead,revokedHead,restoredHead,managedBlocked,managedActive,blockedCompletion,activeCompletion,activeRestart,priorManifestSha:completed.completion.sha256,providerCalls:0},null,2)+'\n',{flag:'wx'});
      checks.push('revocation_wakes_one_distinct_existing_queue_job_and_REAL_remains_blocked','restored_signed_test_authority_wakes_new_canonical_run_without_source_edit','old_terminal_manifests_replay_unchanged_after_dependency_change');
     }finally{if(!restored)await owner.query('update private.june2026_regular_assessments set revoked_at=null where id=$1',[assessmentId]);
      await owner.query('update private.managed_dev_worker_cases set enabled=false,stopped_at=now() where case_id=$1 and capability_sha256=$2',[caseId,capability]);
      await owner.query('update private.managed_dev_worker_capabilities set enabled=false where capability_sha256=$1',[capability]);}
    }
   }
   return;
  }
  const initialRun=await calculate(await head());expect(initialRun.command.mode).toBe('real');expect(initialRun.bundle?.topic_results[0].amount).toBeNull();checks.push('REAL_without_authority_blocked');
  if(kind==='conflicting-hours'){
   const facts=z.object({facts:employmentSnapshotSchema}).parse(initialRun.stages.find(s=>s.stage==='canonical_facts')!.payload).facts;
   const hours=facts.facts.find(f=>f.path==='work.regular_hours');expect(hours?.status).not.toBe('confirmed');expect(rawHours.length===0||rawHours.length>1||hours?.value===null).toBe(true);
   checks.push('conflicting_hours_not_verified');return;
  }
  const expected:Record<string,unknown>={salary_type:'hourly',salary_period:{year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'},base_monthly_salary:{currency:'ILS',minor_units:330000},gross_salary:{currency:'ILS',minor_units:330000},net_salary:{currency:'ILS',minor_units:330000},...(kind==='clear'?{regular_hours:{amount:'100',unit:'hours_per_month'},hourly_rate:{currency:'ILS',minor_units:3300}}:{})};
  writeFileSync(directory+'/critical-field-comparison.json',JSON.stringify({sourceSha256:source.sha256,checkpointResultSha256:cp.result_sha256,
   fields:Object.entries(expected).map(([name,value])=>({field:name,expected:value,actual:fields.filter(f=>f.field===name).map(f=>({value:f.normalized_value,confidence:f.confidence})),passed:fields.some(f=>f.field===name)&&fields.filter(f=>f.field===name).every(f=>canonicalSha256(f.normalized_value)===canonicalSha256(value))})),
   scope:'Critical fields for one-base-component June minimum-wage calculation; this is not whole-payslip accuracy or pension validation.',
   allNormalizedFields:fields,components:cp.run.result.final_extraction.additional_components},null,2)+'\n');
  for(const [name,value]of Object.entries(expected)){const candidates=fields.filter(f=>f.field===name);expect(candidates.length).toBeGreaterThan(0);expect(candidates.every(f=>canonicalSha256(f.normalized_value)===canonicalSha256(value))).toBe(true);}
  expect(cp.run.result.final_extraction.additional_components).toHaveLength(1);
  expect(cp.run.result.final_extraction.additional_components[0]).toMatchObject({semantic_kind:'hourly_base',amount:{currency:'ILS',minor_units:330000}});
  if(kind==='absent-hours')expect(rawHours).toEqual([]);
  phase='identified-completions';const readingRows=(await owner.query("select t.request_id,t.target from private.document_field_targets t join public.case_requests r on r.id=t.request_id where t.case_id=$1 and t.target->>'version_id'=$2 and r.answered_at is null",[caseId,file.versionId])).rows;
  for(const r of readingRows){const t=documentFieldTargetSchema.parse(r.target);if(!Object.hasOwn(expected,t.candidate.field))continue;expect(t.candidate.normalized_value).toEqual(expected[t.candidate.field]);
   await web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[r.request_id,caseId,OWNER,DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]]);answers.push({kind:'document_reading',requestId:r.request_id,field:t.candidate.field,value:t.candidate.normalized_value});}
  const collection=(await owner.query("select t.request_id,t.target from private.june2026_collection_targets t join public.case_requests r on r.id=t.request_id where t.case_id=$1 and t.target->>'version_id'=$2 and r.answered_at is null",[caseId,file.versionId])).rows;
  for(const r of collection){const t=june2026CollectionTargetSchema.parse(r.target),s=t.subject;let answer:string;
   if(s.kind==='component')answer=JUNE2026_COMPONENT_DECLARATIONS.base_salary;
   else if(s.kind==='earnings_completeness')answer=JUNE2026_DECLARATION_OPTIONS[0];
   else answer=s.field==='sector'?'Synthetic office clerk in a general private business':s.field==='hours_rest_law_applies'?'Synthetic supervised adult hourly clerk, not management':s.field.startsWith('no_')?JUNE2026_DECLARATION_OPTIONS[1]:JUNE2026_DECLARATION_OPTIONS[0];
   await web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[r.request_id,caseId,OWNER,answer]);answers.push({kind:'case_declaration',requestId:r.request_id,subject:s,answer});}
  if(kind==='absent-hours'){
   const hours=(await owner.query('select request_id from private.june2026_hours_targets where case_id=$1 and version_id=$2',[caseId,file.versionId])).rows;expect(hours).toHaveLength(1);
   const before=await head();await web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[hours[0].request_id,caseId,OWNER,'100']);expect((await head()).revision).toBeGreaterThan(before.revision);
   answers.push({kind:'identified_declared_hours',requestId:hours[0].request_id,answer:'100',source:'synthetic independent work records, absent from PDF'});
  }
  const refreshed=await extract();expect(refreshed.reused).toBe(true);expect(canonicalSha256(refreshed.result)).toBe(canonicalSha256(extracted.result));
  const job=await head(),blocked=await calculate(job),review=z.object({diagnostics:z.object({factual_context:z.object({admission_assessment:z.unknown(),facts:employmentSnapshotSchema})})}).parse(blocked.stages.find(s=>s.stage==='review_pending')!.payload).diagnostics.factual_context;
  const packet=review.admission_assessment as June2026AssessmentPacket;
  writeFileSync(directory+'/assessment-context.json',JSON.stringify({packet,facts:review.facts,blockedRunId:blocked.analysis_run_id,initialRunId:initialRun.analysis_run_id,answers},null,2)+'\n');
  phase='isolated-signed-authority';const fixture=createRegularServiceTrustFixture(new Date().toISOString()),assessment=fixture.assessment(packet,review.facts);
  const {registry_sha256:fixtureHash,...registryIdentity}=fixture.registry;void fixtureHash;
  const registry={registry:registryIdentity,trust_journal:fixture.journal,legal:fixture.legal},registryKey='isolated.regular.'+caseId;
  const retainedAuthority=(await owner.query('select a.payload assessment,r.payload registry from private.june2026_regular_assessments a join private.june2026_authority_registries r on r.registry_key=a.registry_key where a.case_id=$1 and a.order_id=$2 and a.input_revision=$3 and a.input_sha256=$4 order by r.revision desc limit 1',[caseId,orderId,job.revision,job.input_sha256])).rows[0];
  if(!retainedAuthority){
   await owner.query('begin');try{
    await owner.query('insert into private.june2026_authority_registries(registry_key,revision,namespace,payload,payload_sha256) values($1,1,\'isolated_test\',$2,$3)',[registryKey,registry,canonicalSha256(registry)]);
    await owner.query('insert into private.june2026_regular_assessments(id,case_id,order_id,input_revision,input_sha256,registry_key,payload,payload_sha256) values($1,$2,$3,$4,$5,$6,$7,$8)',[assessment.payload.assessment_id,caseId,orderId,job.revision,job.input_sha256,registryKey,assessment,canonicalSha256(assessment)]);
    await owner.query('commit');
   }catch(e){await owner.query('rollback');throw e;}
   writeFileSync(directory+'/isolated-authority.json',JSON.stringify({registry,assessment},null,2)+'\n',{flag:'wx'});
  }
  phase='canonical-execution-and-publication';const run=await calculate(job);const body=await exportRun('report',run);checks.push('live_provider_to_canonical_finding_and_published_report');
  if(kind==='absent-hours'){expect(body.execution.admission.hours_origin).toBe('identified_declared');expect(run.analysis_run_id).not.toBe(initialRun.analysis_run_id);checks.push('absent_cell_identified_answer_new_run');}
  phase='parallel-retry';const before=(await owner.query('select count(*)::int n from private.june2026_regular_results where case_id=$1',[caseId])).rows[0].n;
  const retried=await Promise.all([calculate(job,worker),calculate(job,peer)]);for(const r of retried)expect(r.report?.report_sha256).toBe(run.report?.report_sha256);
  expect((await owner.query('select count(*)::int n from private.june2026_regular_results where case_id=$1',[caseId])).rows[0].n).toBe(before);checks.push('parallel_retry_same_report_no_duplicates');
 }catch(e){failure=e;throw e;}finally{
  bounded.close();
  if(machine&&heldLease){try{await transact(worker)(c=>recordSavedJobFailure(c,heldLease!,new Error('SAVED_JOB_INTERRUPTED')));checks.push('owned_job_lease_released_with_fence');}catch{checks.push('owned_job_lease_already_superseded_or_expired');}}
  if(machine){await owner.query('begin');try{await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);await owner.query('update public.product_identity_sessions set revoked_at=now() where tenant_id=$1 and sid=$2',[tenant,sid]);await owner.query('commit');}catch{await owner.query('rollback');}}
  own();writeFileSync(`${directory}/proof-${gitSha.slice(0,7)}-${Date.now()}.json`,JSON.stringify({gitSha,caseId,publicId,orderId,kind,phase,state:failure?'FAIL':'PASS',error:failure instanceof Error?failure.message:null,
   checks,runs,answers,sourceSha256:source.sha256,budget:bounded.summary(),payment:'synthetic_paid_full_offer_no_payment_provider',authority:'isolated_test_only',humanApproval:false,productionChanged:false},null,2)+'\n',{flag:'wx'});
  await Promise.allSettled([owner.end(),worker.end(),peer.end(),web.end()]);
 }
},300000);
