import {expect,it,vi} from 'vitest';
import {randomUUID,randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,renameSync,existsSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {PDFDocument} from 'pdf-lib';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentUploadSchema,matchesDocumentSignature} from '@/lib/document-upload';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import type {UploadBatch,ReservedFile} from '../documents/upload';
import {offerSnapshot} from '../orders/contracts';
import {documentFieldTargetSchema,DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from '../reports/document-field-confirmation';
import {parseDevFinancialRun} from './dev-financial-contract';
import {managedWorkerStatusSchema} from './managed-worker-contract';
import {managedProofManifestSchema,managedProofPaths} from './managed-worker-proof-contract';
import {DEV_FINANCIAL_ORACLE,devFinancialInputFixture,fixtureSha} from './dev-financial-flow.fixture';
vi.mock('server-only',()=>({}));

// This harness NEVER imports/invokes extraction, claim, calculation, or worker
// runner functions. Actual externally scheduled Node processes own all of them.
it.skipIf(process.env.TIVDOC_MANAGED_DEV_DB_PROOF!=='1')('automatically processes saved QA uploads and answers through externally scheduled worker ticks',async()=>{
 if(process.env.VERCEL||process.env.VERCEL_ENV||process.env.NODE_ENV!=='test')throw Error('MANAGED_PROOF_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const url=new URL(env.get(key)!);expect(url.pathname).toBe('/tivdoc_release_replay_20260907');expect(url.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(url.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);url.search='';return new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),control=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const storageKeys=JSON.parse(readFileSync(process.env.TIVDOC_SAVED_STORAGE_CREDENTIALS_FILE??'','utf8'));expect(storageKeys.NEXT_PUBLIC_SUPABASE_URL).toBe('https://cpzrbidxftzqcfeqqusu.supabase.co');
 const remote=createClient(storageKeys.NEXT_PUBLIC_SUPABASE_URL,storageKeys.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}),bucket=remote.storage.from('salary-documents');
 const runId=randomUUID(),cases=[0,1].map(()=>({id:randomUUID(),orderId:randomUUID(),identity:'',publicId:'',session:randomBytes(16).toString('base64url'),sid:`managed-proof:${randomUUID()}`,jti:randomUUID()})),primary=cases[0];
 const capability=randomBytes(32).toString('base64url'),capabilitySha=fixtureSha(capability),inputs=await Promise.all([devFinancialInputFixture(false),devFinancialInputFixture(true)]);
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;
 const previewProof=process.env.TIVDOC_MANAGED_DEV_PREVIEW_PROOF==='1',crashProof=process.env.TIVDOC_MANAGED_DEV_CRASH_PROOF==='1',previewChecks:{name:string;passed:true}[][]=[],notificationChecks:unknown[]=[],crashChecks:unknown[]=[];
 const previewTargetPath='../../../../scripts/release-completion/'+'preview-target.mts';
 const notificationOrigin=previewProof?(await import(previewTargetPath)).currentPreviewTarget().origin:'https://tivdoc-synthetic.vercel.app';
 const privatePaths=managedProofPaths(runId),directory='output/release-completion/managed-worker-proof';mkdirSync(privatePaths.receipts!,{recursive:true});mkdirSync(directory,{recursive:true});
 const manifest=managedProofManifestSchema.parse({schema_version:'managed-dev-synthetic-proof-v1',enabled:false,run_id:runId,git_sha:gitSha,worker_url:env.get('TIVDOC_WORKER_POSTGRES_URL'),
  capability,storage_url:storageKeys.NEXT_PUBLIC_SUPABASE_URL,storage_key:storageKeys.SUPABASE_SERVICE_ROLE_KEY,case_ids:cases.map(c=>c.id),inputs:inputs.map(i=>({sha256:i.sha256,missing_hours:i.missingHours})),fault:null,
  notification_secret:randomBytes(32).toString('base64'),notification_origin:notificationOrigin,notification_hold:false,crash_after_claim_case:crashProof?primary.id:null});
 const paths:string[]=[],checks:string[]=[],runs:{runId:string;inputRevision:number;state:string}[]=[],confirmationChecks:unknown[]=[];
 let crashed:{caseId:string;pid:number;at:string;claim:{state:'claimed';jobId:string;fencingToken:number};gitSha:string}|null=null;
 let seeded=false,cleaned=false,storageCleaned=false,failure:string|null=null,cleanupFailure:string|null=null;
 const writeControl=()=>{writeFileSync(privatePaths.manifest+'.tmp',JSON.stringify(manifest,null,2)+'\n');renameSync(privatePaths.manifest+'.tmp',privatePaths.manifest);};
 const own=()=>writeFileSync(path.join(privatePaths.receipts!,'owned.json'),JSON.stringify({cases,paths,runId,capabilitySha,scope:'Fresh owned synthetic fixtures only; private sessions, never commit.'},null,2));
 const checked=(text:string)=>{checks.push(text);writeFileSync(path.join(privatePaths.receipts!,'progress.json'),JSON.stringify({runId,checks,at:new Date().toISOString()},null,2));};
 writeControl();own();for(const input of inputs)writeFileSync(path.join(directory,input.name),input.bytes);
 const tickSchema=z.object({schema_version:z.literal('managed-dev-synthetic-tick-v1'),runId:z.literal(runId),gitSha:z.literal(gitSha),pid:z.number().int(),providerKind:z.literal('injected_test_provider'),
  providerHashes:z.array(z.string()),faults:z.array(z.string()),items:z.array(z.object({caseId:z.string(),state:z.string()}).passthrough()),failure:z.string().nullable(),startedAt:z.string(),finishedAt:z.string(),
  notifications:z.object({providerKind:z.literal('injected_notification_test'),claimPaused:z.boolean(),recipientMismatchRefused:z.boolean(),accepted:z.array(z.object({payloadSha256:z.string(),recipientSha256:z.string(),template:z.string()})),queued:z.number(),attemptStates:z.array(z.string()),deliveryConfirmed:z.literal(false)})}).passthrough();
 const ticks=()=>readdirSync(privatePaths.receipts!).filter(f=>/^tick-.*\.json$/u.test(f)).map(file=>tickSchema.parse(JSON.parse(readFileSync(path.join(privatePaths.receipts!,file),'utf8'))));
 async function waitFor<T>(label:string,read:()=>Promise<T|null|false>,timeout=180000):Promise<T>{
  const until=Date.now()+timeout;while(Date.now()<until){const value=await read();if(value!==null&&value!==false)return value;await new Promise(resolve=>setTimeout(resolve,1000));}
  writeFileSync(path.join(privatePaths.receipts!,'timeout.json'),JSON.stringify({label,ticks:ticks()},null,2));throw Error(`MANAGED_PROOF_TIMEOUT:${label}`);
 }
 const status=async()=>{const rows=(await control.query('select * from private.managed_dev_worker_status($1)',[capability])).rows;return rows.map(row=>managedWorkerStatusSchema.parse(row)).find(row=>row.case_id===primary.id)!;};
 const head=async()=>(await owner.query('select revision,input_sha256 from private.case_input_heads where case_id=$1',[primary.id])).rows[0];
 const financial=async(state:'calculated'|'missing_input')=>{const current=await head();const row=(await owner.query('select * from private.dev_financial_runs where case_id=$1 and input_revision=$2 and input_sha256=$3',[primary.id,current.revision,current.input_sha256])).rows[0];return row&&row.payload.calculation.state===state?row:null;};
 const counts=async()=>(await owner.query('select (select count(*)::int from private.dev_financial_runs where case_id=$1) runs,(select count(*)::int from private.dev_financial_findings where case_id=$1) findings',[primary.id])).rows[0];
 const notifications=async(keys:string[])=>(await owner.query('select n.event_key,o.delivery_id,o.state,o.attempts,o.recipient_sha256,o.provider_message_id,o.encrypted_payload,o.last_error from private.managed_dev_notification_events n join private.case_notification_outbox o on o.delivery_id=n.delivery_id where n.case_id=$1 and n.event_key=any($2::text[]) order by n.event_key',[primary.id,keys])).rows;
 const customer=async(identity=primary.identity)=>(await web.query('select public.case_report_dev_financial($1,$2) value',[primary.id,identity])).rows[0].value as {payload:unknown;current:boolean}[];
 const sourceBytes=async(file:ReservedFile)=>{const downloaded=await bucket.download(file.path);if(downloaded.error||!downloaded.data)throw Error('MANAGED_PROOF_STORAGE');const bytes=new Uint8Array(await downloaded.data.arrayBuffer());expect(fixtureSha(bytes)).toBe(file.sha256);return bytes;};
 const upload=async(input:typeof inputs[number],replace?:ReservedFile)=>{
  const payload=documentUploadSchema.parse({caseId:primary.id,batchId:randomUUID(),checkPeriodMonth:'2026-06',files:[{clientId:randomUUID(),documentType:'payslip',name:input.name,type:'application/pdf',size:input.bytes.length,sha256:input.sha256,periodMonth:'2026-06',...(replace?{replace:{documentId:replace.documentId,versionId:replace.versionId}}:{})}]});
  const batch=(await web.query('select public.case_documents_reserve($1,$2,$3) value',[primary.id,payload.batchId,payload])).rows[0].value as UploadBatch;expect(batch.files).toHaveLength(1);const file=batch.files[0];expect(file.path).toBe(`cases/${primary.id}/versions/${file.versionId}.pdf`);paths.push(file.path);own();
  const signed=await bucket.createSignedUploadUrl(file.path,{upsert:false});if(signed.error||!signed.data)throw Error('MANAGED_PROOF_UPLOAD_SIGN');const uploaded=await bucket.uploadToSignedUrl(file.path,signed.data.token,input.bytes,{contentType:'application/pdf'});if(uploaded.error)throw Error('MANAGED_PROOF_UPLOAD_TRANSFER');
  const bytes=await sourceBytes(file);expect(bytes.length).toBe(input.bytes.length);expect(matchesDocumentSignature(bytes,'application/pdf')).toBe(true);
  await web.query('select public.case_documents_commit($1,$2,$3)',[primary.id,payload.batchId,{[file.versionId]:input.sha256}]);return file;
 };
 const confirm=async(file:ReservedFile,missingHours:boolean)=>{
  const expected:Record<string,unknown>={salary_type:'hourly',salary_period:{year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'},base_monthly_salary:{currency:'ILS',minor_units:330000},gross_salary:{currency:'ILS',minor_units:330000},net_salary:{currency:'ILS',minor_units:330000},hourly_rate:{currency:'ILS',minor_units:3300},...(!missingHours?{regular_hours:{amount:'100',unit:'hours_per_month'}}:{})};
  const targets=await waitFor('field_questions',async()=>{const result=(await owner.query("select t.request_id,t.target from private.document_field_targets t join public.case_requests q on q.id=t.request_id where t.case_id=$1 and t.target->>'version_id'=$2 and q.answered_at is null",[primary.id,file.versionId])).rows;return result.length===Object.keys(expected).length?result:null;},crashProof&&!missingHours?300000:180000);
  if(crashed&&!missingHours){const recovered=await status();expect(recovered.job_id).toBe(crashed.claim.jobId);expect(recovered.attempt_count).toBe(2);expect(Date.now()-Date.parse(crashed.at)).toBeGreaterThanOrEqual(175000);crashChecks.push({oldJobId:crashed.claim.jobId,oldFence:crashed.claim.fencingToken,crashedPid:crashed.pid,attempts:recovered.attempt_count,elapsedMs:Date.now()-Date.parse(crashed.at),clockModified:false});}
  for(const row of targets){const target=documentFieldTargetSchema.parse(row.target);expect(target.case_id).toBe(primary.id);expect(target.version_id).toBe(file.versionId);expect(target.source_sha256).toBe(file.sha256);expect(Object.hasOwn(expected,target.candidate.field)).toBe(true);expect(target.candidate.normalized_value).toEqual(expected[target.candidate.field]);}
  expect(targets.map(row=>documentFieldTargetSchema.parse(row.target).candidate.field).sort()).toEqual(Object.keys(expected).sort());
  const checkpoint=(await owner.query('select result,result_sha256 from private.case_extraction_checkpoints where case_id=$1 and version_id=$2 order by revision desc limit 1',[primary.id,file.versionId])).rows[0];
  for(const row of targets)expect(documentFieldTargetSchema.parse(row.target).extraction_result_sha256).toBe(checkpoint.result_sha256);
  const eventKeys=targets.map(row=>'request:'+row.request_id),generated=await waitFor('generated_field_notifications',async()=>{const rows=await notifications(eventKeys);return rows.length===targets.length&&rows.some(row=>row.state==='sent')&&rows.some(row=>row.state==='queued')?rows:null;});
  expect(generated.every(row=>row.recipient_sha256===fixtureSha(`email|managed-${primary.id}@example.invalid`))).toBe(true);
  const staleKeys=generated.filter(row=>row.state==='queued').map(row=>row.event_key);
  await web.query('begin');try{for(const target of targets)await web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[target.request_id,primary.id,primary.identity,DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]]);await web.query('commit');}catch(error){await web.query('rollback');throw error;}
  const cancelled=await waitFor('answered_field_notifications_scrubbed',async()=>{const rows=await notifications(staleKeys);return rows.every(row=>row.state==='dead_letter')?rows:null;});
  expect(cancelled.every(row=>row.attempts===0&&row.encrypted_payload===null&&row.last_error==='input_superseded')).toBe(true);
  notificationChecks.push({versionId:file.versionId,generatedFieldEvents:generated.length,providerAccepted:generated.filter(row=>row.state==='sent').length,staleIntentsScrubbed:cancelled.length,deliveryConfirmed:false});
  confirmationChecks.push({versionId:file.versionId,fields:Object.keys(expected),actor:'automated_known_synthetic_fixture_identity',humanReview:false,confidenceModified:false});
 };
 const artifacts=async(label:string,row:Record<string,unknown>)=>{
  const run=parseDevFinancialRun(row.payload),pdf=Buffer.from(row.pdf as Uint8Array),html=String(row.html);
  expect(fixtureSha(pdf)).toBe(row.pdf_sha256);expect(fixtureSha(html)).toBe(row.html_sha256);expect(html).toContain(run.run_id);expect((await PDFDocument.load(pdf)).getSubject()).toBe(run.run_id);
  if(run.calculation.state==='calculated'){expect(run.calculation).toMatchObject({expectedMinor:354000,recordedMinor:330000,gapMinor:24000});for(const value of ['3540.00','3300.00','240.00'])expect(html).toContain(value);}
  const pdfFile=path.join(directory,label+'.pdf');writeFileSync(pdfFile,pdf);writeFileSync(path.join(directory,label+'.html'),html);writeFileSync(path.join(directory,label+'.json'),JSON.stringify(run,null,2));
  const text=process.env.TIVDOC_PDFTOTEXT?execFileSync(process.env.TIVDOC_PDFTOTEXT,['-layout',pdfFile,'-'],{encoding:'utf8'}):execFileSync(process.env.TIVDOC_PDF_PYTHON??'python',['-c',"import sys,pdfplumber; p=pdfplumber.open(sys.argv[1]); sys.stdout.buffer.write(('\\n'.join(page.extract_text() or '' for page in p.pages)).encode('utf-8')); p.close()",pdfFile],{encoding:'utf8'});
  expect(text).toContain(run.run_id);if(run.calculation.state==='calculated')for(const value of ['3540.00','3300.00','240.00'])expect(text).toContain(value);
  runs.push({runId:run.run_id,inputRevision:run.input_revision,state:run.calculation.state});return run;
 };
 try{
  await Promise.all([owner.connect(),control.connect(),web.connect()]);expect((await owner.query('select session_user')).rows[0].session_user).toBe('tivdoc_dev_migrator');
  expect((await owner.query("select to_regprocedure('public.case_notification_managed_enqueue(text,text,text,jsonb,timestamptz,uuid,uuid,text)') is not null ready")).rows[0].ready).toBe(true);
  const bucketInfo=await remote.storage.getBucket('salary-documents');if(bucketInfo.error||bucketInfo.data.public)throw Error('MANAGED_PROOF_PRIVATE_BUCKET');
  await owner.query('begin');for(const c of cases){const email=`managed-${c.id}@example.invalid`;
   c.publicId=(await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic managed DEV worker',$2,'0500000000',true,'under_review','verified',now(),'2026-06-01') returning public_id",[c.id,email])).rows[0].public_id;
   c.identity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[fixtureSha('email|'+email),email])).rows[0].id;await owner.query('select public.case_access_identity_link($1,$2)',[c.identity,c.id]);await owner.query('select public.case_access_session_create($1,$2,14400)',[c.identity,fixtureSha('case-access-session|'+c.session)]);
   const offer=offerSnapshot('initial');await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2026-06-01','2026-06-01',$3,'ILS',$4,$5,array['minimum_wage'],$6,'paid',now())",[c.orderId,c.id,offer.amount_minor,offer,offer.sha256,offer.terms_version]);await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[c.orderId]);await owner.query("select private.capture_case_input($1,'synthetic_managed_paid_scope')",[c.id]);
   await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.managed.dev.worker',$3,now()-interval '1 minute',now()+interval '2 hours',$4,now())",[`saved-case:${c.id}`,c.sid,c.jti,canonicalSha256({sid:c.sid,jti:c.jti})]);
  }
  await owner.query("insert into private.managed_dev_worker_capabilities(capability_sha256,expires_at,daily_limit,total_limit,notification_recipients) values($1,clock_timestamp()+interval '2 hours',20,20,$2::text[])",[capabilitySha,cases.map(c=>fixtureSha(`email|managed-${c.id}@example.invalid`))]);
  for(const c of cases)await owner.query('insert into private.managed_dev_worker_cases(case_id,identity_id,session_sid,capability_sha256) values($1,$2,$3,$4)',[c.id,c.identity,c.sid,capabilitySha]);
  await owner.query('commit');seeded=true;own();manifest.enabled=true;writeControl();
  await waitFor('external_scheduler_alive',async()=>ticks().length>0?true:null,120000);
  expect(await counts()).toEqual({runs:0,findings:0});checked('an independently scheduled Node process reads the capability registry before any upload; harness invokes no worker or calculation');
  const first=await upload(inputs[0]);manifest.fault={version_id:first.versionId,limit:3};writeControl();
  if(crashProof){crashed=await waitFor('committed_claim_process_crash',async()=>{const file=path.join(privatePaths.receipts!,'committed-claim-crash.json');return existsSync(file)?z.object({caseId:z.literal(primary.id),pid:z.number().int(),at:z.iso.datetime(),gitSha:z.literal(gitSha),claim:z.object({state:z.literal('claimed'),jobId:z.string(),fencingToken:z.number().int()}).passthrough()}).parse(JSON.parse(readFileSync(file,'utf8'))):null;},120000);const row=await status();expect(row.job_id).toBe(crashed.claim.jobId);expect(row.attempt_count).toBe(1);expect(row.state).toBe('processing');}
  await confirm(first,false);
  const failed=await waitFor('terminal_failure_after_three_attempts',async()=>{const row=await status();return row.state==='failed'&&row.attempt_count===3?row:null;},300000);
  expect(failed.max_attempts).toBe(3);expect(failed.last_error).toBe('processing_failed');expect(await counts()).toEqual({runs:0,findings:0});await sourceBytes(first);
  expect(ticks().flatMap(t=>t.faults)).toHaveLength(3);checked('three injected pre-save failures reach durable terminal failure with bounded attempts; source and extraction remain available and no financial finding/report commits');
  await expect(web.query('select * from private.managed_dev_worker_retry($1,$2,$3,$4)',[capability,primary.id,failed.job_id,failed.job_revision])).rejects.toMatchObject({code:'42501'});
  await expect(control.query('select * from private.managed_dev_worker_retry($1,$2,$3,$4)',[randomBytes(32).toString('base64url'),primary.id,failed.job_id,failed.job_revision])).rejects.toThrow();
  manifest.notification_hold=true;writeControl();
  const retry=(await control.query('select * from private.managed_dev_worker_retry($1,$2,$3,$4)',[capability,primary.id,failed.job_id,failed.job_revision])).rows[0];
  const retried=(await control.query('select * from private.managed_dev_worker_retry($1,$2,$3,$4)',[capability,primary.id,failed.job_id,failed.job_revision])).rows[0];expect(retry.replayed).toBe(false);expect(retried).toEqual({...retry,replayed:true});
  const initial=await artifacts('initial-calculated',await waitFor('calculated_after_authorized_retry',()=>financial('calculated')));
  expect(initial.source.version_id).toBe(first.versionId);expect(initial.extraction_provider).toBe('injected_test_provider');expect(await counts()).toEqual({runs:1,findings:1});
  const originalEvent='engineering:'+initial.run_id,originalNotice=(await waitFor('generated_engineering_intent_held',async()=>{const rows=await notifications([originalEvent]);return rows.length===1&&rows[0].state==='queued'?rows:null;}))[0];expect(originalNotice.attempts).toBe(0);
  checked('one explicit capability-authorized retry and its replay preserve attempts/history and produce the independently expected 240 ILS engineering result through the scheduled runner');
  const invocationCount=(await owner.query('select count(*)::int n from private.case_extraction_invocations where case_id=$1',[primary.id])).rows[0].n;expect(invocationCount).toBe(1);
  const previousTicks=ticks().length;await waitFor('fresh_process_replay_idle',async()=>ticks().length>=previousTicks+2?true:null,120000);expect(new Set(ticks().map(t=>t.pid)).size).toBeGreaterThan(2);expect(await counts()).toEqual({runs:1,findings:1});
  checked('successive independent scheduler processes reuse durable state without duplicate findings, reports or provider invocations');
  await expect(customer(cases[1].identity)).rejects.toThrow('DEV_FINANCIAL_FORBIDDEN');await expect(web.query('select * from private.dev_financial_runs')).rejects.toMatchObject({code:'42501'});
  checked('foreign customer identity and direct web-role private-table access are refused');
  const second=await upload(inputs[1],first);expect(second.documentId).toBe(first.documentId);expect(second.versionId).not.toBe(first.versionId);await sourceBytes(first);expect((await customer()).every(row=>!row.current)).toBe(true);
  manifest.notification_hold=false;writeControl();
  checked('actual explicit replacement preserves old bytes/history and immediately makes the old report non-current before the next scheduled run');
  await confirm(second,true);
  const obsoleteNotice=(await waitFor('replaced_source_notification_refused',async()=>{const rows=await notifications([originalEvent]);return rows.length===1&&rows[0].state==='dead_letter'?rows:null;}))[0];
  expect(obsoleteNotice).toMatchObject({attempts:0,provider_message_id:null,encrypted_payload:null,last_error:'input_superseded'});
  expect(ticks().flatMap(t=>t.notifications.accepted).some(n=>n.payloadSha256===originalNotice.delivery_id)).toBe(false);
  notificationChecks.push({generatedEngineeringRun:initial.run_id,pausedBeforeClaim:true,replacedSourceIntentScrubbed:true,providerAttempted:false});
  const missing=await artifacts('missing-hours',await waitFor('focused_missing_hours',()=>financial('missing_input')));
  expect(missing.calculation).toEqual({state:'missing_input',fields:['work.regular_hours']});expect(missing.request_id).toBeTruthy();expect(missing.finding).toBeNull();
  const missingNotice=(await waitFor('generated_missing_hours_notification',async()=>{const rows=await notifications(['request:'+missing.request_id]);return rows.length===1&&rows[0].state==='sent'?rows:null;}))[0];expect(missingNotice.attempts).toBe(1);
  notificationChecks.push({generatedMissingRequest:missing.request_id,payloadSha256:missingNotice.delivery_id,providerAccepted:true,deliveryConfirmed:false});
  checked('scheduled extraction preserves truly missing hours and opens the focused month/source question after known fixture readings are answered');
  const answer=(identity=primary.identity,value='100')=>web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[missing.request_id,primary.id,identity,value]);
  await expect(answer(cases[1].identity)).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');await expect(answer(primary.identity,'010')).rejects.toThrow('REQUEST_ANSWER_INVALID');
  const preview=async(stage:'missing'|'completed',answered?:ReturnType<typeof parseDevFinancialRun>)=>{if(!previewProof)return;
   const hookPath='../../../../scripts/release-completion/'+'preview-dev-financial-flow.mts';
   const hook=await import(hookPath);if(typeof hook.verifyDevFinancialPreview!=='function')throw Error('MANAGED_PREVIEW_HOOK');
   const proof=await hook.verifyDevFinancialPreview({stage,cases,gitSha,directory,first,second,initial,missing,answered,automatic:true});
   previewChecks.push(z.array(z.object({name:z.string().min(1),passed:z.literal(true)})).min(1).parse(proof));
  };
  await preview('missing');
  await web.query('begin');try{await answer();await answer();await web.query('commit');}catch(error){await web.query('rollback');throw error;}
  expect((await owner.query('select count(*)::int n from private.case_request_answer_versions where request_id=$1',[missing.request_id])).rows[0].n).toBe(1);
  const answered=await artifacts('answered-calculated',await waitFor('calculated_after_answer',()=>financial('calculated')));expect(answered.run_id).not.toBe(missing.run_id);expect(answered.input_revision).toBeGreaterThan(missing.input_revision);
  expect(answered.reading).toMatchObject({request_id:missing.request_id,identity_id:primary.identity,answer_revision:1,answer:'100'});expect(await counts()).toEqual({runs:3,findings:2});
  const answerNotice=(await waitFor('generated_answered_report_notification',async()=>{const rows=await notifications(['engineering:'+answered.run_id]);return rows.length===1&&rows[0].state==='sent'?rows:null;}))[0];expect(answerNotice.attempts).toBe(1);expect(answerNotice.encrypted_payload).toBeNull();
  await waitFor('notification_process_receipt',async()=>ticks().some(t=>t.notifications.accepted.some(n=>n.payloadSha256===answerNotice.delivery_id))?true:null);
  expect(ticks().some(t=>t.notifications.recipientMismatchRefused)).toBe(true);
  notificationChecks.push({generatedEngineeringRun:answered.run_id,payloadSha256:answerNotice.delivery_id,providerAccepted:true,deliveryConfirmed:false,recipientSnapshotMismatchRefused:true});
  checked('identified answer and exact retry create one answer revision; a later scheduler tick creates the new run/report with the same 240 ILS result and preserves historical runs');
  const history=await customer();expect(history.filter(row=>row.current)).toHaveLength(1);expect(parseDevFinancialRun(history.find(row=>row.current)!.payload).run_id).toBe(answered.run_id);
  const customerArtifact=(await web.query('select public.case_report_dev_financial($1,$2,$3) value',[primary.id,primary.identity,answered.run_id])).rows[0].value[0];
  expect(customerArtifact.payload.run_id).toBe(answered.run_id);expect(fixtureSha(Buffer.from(customerArtifact.pdf_base64,'base64'))).toBe(customerArtifact.pdf_sha256);expect(fixtureSha(customerArtifact.html)).toBe(customerArtifact.html_sha256);
  await expect(web.query('select public.case_report_dev_financial($1,$2,$3)',[primary.id,cases[1].identity,answered.run_id])).rejects.toThrow('DEV_FINANCIAL_FORBIDDEN');
  checked('the identified customer RPC returns matching saved HTML/PDF bytes for the selected run and rejects a foreign reader of that run and its source reference');
  const receipts=ticks();expect(receipts.every(t=>t.failure===null)).toBe(true);const providerHashes=receipts.flatMap(t=>t.providerHashes);expect(new Set(providerHashes)).toEqual(new Set(inputs.map(i=>i.sha256)));expect(providerHashes.length).toBeLessThanOrEqual(4);
  expect((await owner.query('select count(*)::int n from private.case_extraction_invocations where case_id=$1',[primary.id])).rows[0].n).toBe(2);
  expect((await status()).state).toBe('complete');checked('HTML and extracted PDF text use the same current analysis and amounts; exactly two immutable source invocations cover both uploads without provider replay on answers/retries');
  const projections=(await owner.query('select p.report_document,m.parent_run_id from private.automatic_dev_canonical_reports m join public.case_report_projections p on p.id=m.projection_id where m.case_id=$1',[primary.id])).rows;
  expect(projections.length).toBeGreaterThan(0);expect(projections.every(row=>row.report_document.publication.state==='draft'&&row.report_document.findings.length===0)).toBe(true);
  expect((await owner.query('select status,payment_status from public.cases where id=$1',[primary.id])).rows[0]).toEqual({status:'under_review',payment_status:'verified'});
  checked('ordinary canonical report records are generated as drafts from actual parent runs; inactive legal gates, case status and synthetic payment state are preserved');
  await preview('completed',answered);
 }catch(error){failure=error instanceof Error?error.message:'MANAGED_PROOF_FAILED';throw error;}finally{
  manifest.enabled=false;writeControl();await Promise.all([owner,control,web].map(db=>db.query('rollback').catch(()=>{})));
  try{if(seeded){await owner.query('begin');await owner.query('update private.managed_dev_worker_cases set enabled=false,stopped_at=clock_timestamp() where capability_sha256=$1',[capabilitySha]);await owner.query('update private.managed_dev_worker_capabilities set enabled=false where capability_sha256=$1',[capabilitySha]);
   for(const c of cases){await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[`saved-case:${c.id}`]);await owner.query("update public.engine_durable_jobs set state='cancelled',cancellation_requested=true,lease_owner=null,lease_expires_at=null,revision=revision+1 where tenant_id=$1 and canonical_case_id=$2 and state in ('queued','leased','running','retry_wait')",[`saved-case:${c.id}`,c.id]);await owner.query('update public.product_identity_sessions set revoked_at=coalesce(revoked_at,now()) where sid=$1 and tenant_id=$2',[c.sid,`saved-case:${c.id}`]);}
   await owner.query('delete from private.managed_dev_notification_events where case_id=any($1::uuid[])',[cases.map(c=>c.id)]);
   for(const table of ['case_report_projections','case_report_qa','case_report_qa_log'])await owner.query(`create policy managed_proof_cleanup on public.${table} for delete to tivdoc_dev_migrator using(case_id=any(array['${cases[0].id}'::uuid,'${cases[1].id}'::uuid]))`);
   expect((await owner.query("delete from public.cases where id=any($1::uuid[]) and is_qa and first_name='Synthetic managed DEV worker'",[cases.map(c=>c.id)])).rowCount).toBe(2);expect((await owner.query('delete from public.case_identities where id=any($1::uuid[])',[cases.map(c=>c.identity)])).rowCount).toBe(2);
   for(const table of ['case_report_projections','case_report_qa','case_report_qa_log'])await owner.query(`drop policy managed_proof_cleanup on public.${table}`);await owner.query('commit');cleaned=true;
   for(const value of paths)expect(value.startsWith(`cases/${primary.id}/versions/`)).toBe(true);if(paths.length){const removed=await bucket.remove(paths);if(removed.error)throw Error('MANAGED_PROOF_STORAGE_CLEANUP');}const remains=await bucket.list(`cases/${primary.id}/versions`);if(remains.error||remains.data.length)throw Error('MANAGED_PROOF_STORAGE_REMAINS');storageCleaned=true;
  }}catch(error){cleanupFailure=error instanceof Error?error.message:'MANAGED_PROOF_CLEANUP_FAILED';await owner.query('rollback').catch(()=>{});throw error;}finally{
   const receipt={verdict:!failure&&!cleanupFailure&&cleaned&&storageCleaned&&checks.length===11&&notificationChecks.length===5&&(!previewProof||previewChecks.length===2)&&(!crashProof||crashChecks.length===1)?'PASS':'FAIL',gitSha,gitWorktreeDirty:dirty,schemaVersion:'127 / 20260909155945',runId,checks,runs,confirmationChecks,notificationChecks,
    tickReceipts:ticks(),failure,cleanupFailure,inputFixtures:inputs.map(i=>({name:i.name,sha256:i.sha256})),independentExpected:DEV_FINANCIAL_ORACLE,
    externallyScheduledProcessRequested:true,externallyScheduledProcess:ticks().length>0,processRestartProof:new Set(ticks().map(t=>t.pid)).size>2,previewProofRequested:previewProof,previewProof:previewProof&&previewChecks.length===2,previewChecks,
    abruptClaimCrashRequested:crashProof,expiredLeaseRecoveryProof:crashProof&&crashChecks.length===1,crashChecks,automaticNotificationProof:notificationChecks.length===5,notificationProvider:'injected_notification_test',actualEmailDelivery:false,
    browserIdentityProof:'Supplied synthetic case session cookies; no OTP login claim',liveOcrProof:false,providerKind:'injected_test_provider',ordinaryCanonicalPublication:'draft_only',humanApprovalsInvented:false,
    syntheticCasesRemoved:cleaned?2:0,identitiesRemoved:cleaned?2:0,machineSessionsRevoked:cleaned?2:0,storageObjectsRemoved:storageCleaned?paths.length:0,
    capabilityRevoked:cleaned,canonicalAndBudgetAuditRetained:true,productionChanged:false};
   writeFileSync('docs/release-evidence/DEV-managed-worker-db.json',JSON.stringify(receipt,null,2)+'\n');await Promise.all([owner.end(),control.end(),web.end()]);
  }
 }
},1200000);
