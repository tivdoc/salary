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
import {managedWorkerStatusSchema} from './managed-worker-contract';
import {managedProofManifestSchema,managedProofPaths} from './managed-worker-proof-contract';
import {DEV_FINANCIAL_ORACLE,devFinancialInputFixture,fixtureSha} from './dev-financial-flow.fixture';
vi.mock('server-only',()=>({}));

// The independent scheduler is the only caller of extraction, queue claiming,
// financial calculation and report generation. This harness supplies owned
// inputs/identified answers and observes durable effects; it seeds no result.
it.skipIf(process.env.TIVDOC_MANAGED_DEV_REPLACEMENT_PROOF!=='1')('replaces an uploaded source while its crashed worker still owns an unexpired lease',async()=>{
 if(process.env.VERCEL||process.env.VERCEL_ENV||process.env.NODE_ENV!=='test')throw Error('MANAGED_REPLACEMENT_BOUNDARY');
 const shared=managedProofPaths();
 if(existsSync(shared.manifest)&&managedProofManifestSchema.parse(JSON.parse(readFileSync(shared.manifest,'utf8'))).enabled)throw Error('MANAGED_REPLACEMENT_OTHER_PROOF_ACTIVE');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const url=new URL(env.get(key)!);expect(url.pathname).toBe('/tivdoc_release_replay_20260907');expect(url.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(url.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);url.search='';return new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),control=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const storageKeys=JSON.parse(readFileSync(process.env.TIVDOC_SAVED_STORAGE_CREDENTIALS_FILE??'','utf8'));
 expect(storageKeys.NEXT_PUBLIC_SUPABASE_URL).toBe('https://cpzrbidxftzqcfeqqusu.supabase.co');
 const remote=createClient(storageKeys.NEXT_PUBLIC_SUPABASE_URL,storageKeys.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}}),bucket=remote.storage.from('salary-documents');
 const runId=randomUUID(),c={id:randomUUID(),orderId:randomUUID(),identity:'',publicId:'',session:randomBytes(16).toString('base64url'),sid:`managed-replacement:${randomUUID()}`,jti:randomUUID()};
 const capability=randomBytes(32).toString('base64url'),capabilitySha=fixtureSha(capability),inputs=await Promise.all([devFinancialInputFixture(false),devFinancialInputFixture(true)]);
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;
 const workerUrl=new URL(env.get('TIVDOC_WORKER_POSTGRES_URL')!);expect(['','?sslmode=no-verify','?sslmode=verify-full']).toContain(workerUrl.search);workerUrl.search='?sslmode=verify-full';
 const privatePaths=managedProofPaths(runId),directory='output/release-completion/managed-worker-replacement-proof';
 mkdirSync(privatePaths.receipts!,{recursive:true});mkdirSync(directory,{recursive:true});
 const manifest=managedProofManifestSchema.parse({schema_version:'managed-dev-synthetic-proof-v1',enabled:false,run_id:runId,git_sha:gitSha,
  worker_url:workerUrl.toString(),capability,storage_url:storageKeys.NEXT_PUBLIC_SUPABASE_URL,storage_key:storageKeys.SUPABASE_SERVICE_ROLE_KEY,
  case_ids:[c.id],inputs:inputs.map(i=>({sha256:i.sha256,missing_hours:i.missingHours})),fault:null,notification_secret:randomBytes(32).toString('base64'),
  notification_origin:'https://tivdoc-synthetic.vercel.app',notification_hold:true,crash_after_claim_case:c.id});
 const paths:string[]=[],checks:string[]=[],confirmations:unknown[]=[],runs:unknown[]=[];
 let seeded=false,cleaned=false,storageCleaned=false,failure:string|null=null,cleanupFailure:string|null=null,crash:unknown=null,replacementTiming:unknown=null,schemaVersion:unknown=null;
 const writeControl=()=>{writeFileSync(privatePaths.manifest+'.tmp',JSON.stringify(manifest,null,2)+'\n');renameSync(privatePaths.manifest+'.tmp',privatePaths.manifest);};
 const own=()=>writeFileSync(path.join(privatePaths.receipts!,'owned.json'),JSON.stringify({case:c,paths,runId,capabilitySha,scope:'Fresh replacement-during-processing QA fixture only; private machine/customer sessions.'},null,2));
 const checked=(label:string)=>{checks.push(label);writeFileSync(path.join(privatePaths.receipts!,'replacement-progress.json'),JSON.stringify({runId,checks,at:new Date().toISOString()},null,2));};
 const tickSchema=z.object({schema_version:z.literal('managed-dev-synthetic-tick-v1'),runId:z.literal(runId),gitSha:z.literal(gitSha),pid:z.number().int(),
  providerKind:z.literal('injected_test_provider'),providerHashes:z.array(z.string()),failure:z.string().nullable(),startedAt:z.string(),finishedAt:z.string()}).passthrough();
 const ticks=()=>readdirSync(privatePaths.receipts!).filter(file=>/^tick-.*\.json$/u.test(file)).map(file=>tickSchema.parse(JSON.parse(readFileSync(path.join(privatePaths.receipts!,file),'utf8'))));
 async function waitFor<T>(label:string,read:()=>Promise<T|null|false>,timeout=180000):Promise<T>{
  const until=Date.now()+timeout;while(Date.now()<until){const value=await read();if(value!==null&&value!==false)return value;await new Promise(resolve=>setTimeout(resolve,1000));}
  writeFileSync(path.join(privatePaths.receipts!,'replacement-timeout.json'),JSON.stringify({label,ticks:ticks()},null,2));throw Error(`MANAGED_REPLACEMENT_TIMEOUT:${label}`);
 }
 const head=async()=>(await owner.query('select revision,input_sha256 from private.case_input_heads where case_id=$1',[c.id])).rows[0] as {revision:number;input_sha256:string};
 const status=async()=>{const rows=(await control.query('select * from private.managed_dev_worker_status($1)',[capability])).rows;return rows.map(row=>managedWorkerStatusSchema.parse(row)).find(row=>row.case_id===c.id)!;};
 const financial=async(state:string)=>{const current=await head();const row=(await owner.query('select * from private.dev_financial_runs where case_id=$1 and input_revision=$2 and input_sha256=$3',[c.id,current.revision,current.input_sha256])).rows[0];return row&&row.payload.calculation.state===state?row:null;};
 const counts=async()=>(await owner.query('select (select count(*)::int from private.dev_financial_runs where case_id=$1) runs,(select count(*)::int from private.dev_financial_findings where case_id=$1) findings',[c.id])).rows[0];
 const customer=async()=>(await web.query('select public.case_report_dev_financial($1,$2) value',[c.id,c.identity])).rows[0].value as {payload:{run_id:string;source:{version_id:string}};current:boolean}[];
 const sourceBytes=async(file:ReservedFile)=>{const data=await bucket.download(file.path);if(data.error||!data.data)throw Error('MANAGED_REPLACEMENT_STORAGE');const bytes=new Uint8Array(await data.data.arrayBuffer());expect(fixtureSha(bytes)).toBe(file.sha256);return bytes;};
 const upload=async(input:typeof inputs[number],replace?:ReservedFile)=>{
  const payload=documentUploadSchema.parse({caseId:c.id,batchId:randomUUID(),checkPeriodMonth:'2026-06',files:[{clientId:randomUUID(),documentType:'payslip',name:input.name,type:'application/pdf',size:input.bytes.length,sha256:input.sha256,periodMonth:'2026-06',...(replace?{replace:{documentId:replace.documentId,versionId:replace.versionId}}:{})}]});
  const batch=(await web.query('select public.case_documents_reserve($1,$2,$3) value',[c.id,payload.batchId,payload])).rows[0].value as UploadBatch;expect(batch.files).toHaveLength(1);
  const file=batch.files[0];expect(file.path).toBe(`cases/${c.id}/versions/${file.versionId}.pdf`);paths.push(file.path);own();
  const signed=await bucket.createSignedUploadUrl(file.path,{upsert:false});if(signed.error||!signed.data)throw Error('MANAGED_REPLACEMENT_UPLOAD_SIGN');
  const uploaded=await bucket.uploadToSignedUrl(file.path,signed.data.token,input.bytes,{contentType:'application/pdf'});if(uploaded.error)throw Error('MANAGED_REPLACEMENT_UPLOAD_TRANSFER');
  const bytes=await sourceBytes(file);expect(bytes.length).toBe(input.bytes.length);expect(matchesDocumentSignature(bytes,'application/pdf')).toBe(true);
  await web.query('select public.case_documents_commit($1,$2,$3)',[c.id,payload.batchId,{[file.versionId]:input.sha256}]);return file;
 };
 // No parser that recalculates a financial result is imported here. The oracle
 // below is literal, and both artifact formats must describe that saved run.
 const artifact=async(label:string,row:Record<string,unknown>)=>{
  const payload=z.object({run_id:z.uuid(),input_revision:z.number().int(),parent_run_id:z.uuid(),source:z.object({version_id:z.uuid(),source_sha256:z.string()}),
   extraction_provider:z.literal('injected_test_provider'),request_id:z.uuid().nullable(),reading:z.unknown(),finding:z.unknown(),calculation:z.discriminatedUnion('state',[
    z.object({state:z.literal('missing_input'),fields:z.array(z.string())}),z.object({state:z.literal('calculated'),expectedMinor:z.number().int(),recordedMinor:z.number().int(),gapMinor:z.number().int()}).passthrough(),
   ])}).passthrough().parse(row.payload);
  expect(canonicalSha256(row.payload)).toBe(row.payload_sha256);const pdf=Buffer.from(row.pdf as Uint8Array),html=String(row.html);
  expect(fixtureSha(pdf)).toBe(row.pdf_sha256);expect(fixtureSha(html)).toBe(row.html_sha256);expect(html).toContain(payload.run_id);expect((await PDFDocument.load(pdf)).getSubject()).toBe(payload.run_id);
  if(payload.calculation.state==='calculated'){expect(payload.calculation).toMatchObject({expectedMinor:354000,recordedMinor:330000,gapMinor:24000});for(const value of ['3540.00','3300.00','240.00'])expect(html).toContain(value);}
  writeFileSync(path.join(directory,label+'.pdf'),pdf);writeFileSync(path.join(directory,label+'.html'),html);writeFileSync(path.join(directory,label+'.json'),JSON.stringify(row.payload,null,2));
  runs.push({runId:payload.run_id,inputRevision:payload.input_revision,state:payload.calculation.state,sourceVersion:payload.source.version_id});return payload;
 };
 writeControl();own();for(const input of inputs)writeFileSync(path.join(directory,input.name),input.bytes);
 try{
  await Promise.all([owner.connect(),control.connect(),web.connect()]);expect((await owner.query('select session_user')).rows[0].session_user).toBe('tivdoc_dev_migrator');
  expect((await owner.query("select to_regprocedure('public.case_notification_managed_enqueue(text,text,text,jsonb,timestamptz,uuid,uuid,text)') is not null ready")).rows[0].ready).toBe(true);
  schemaVersion={requiredMigration:'20260909155945_automatic_dev_notification_snapshot.sql',runtimeEnqueueSignatureVerified:true};
  const bucketInfo=await remote.storage.getBucket('salary-documents');if(bucketInfo.error||bucketInfo.data.public)throw Error('MANAGED_REPLACEMENT_PRIVATE_BUCKET');
  await owner.query('begin');const email=`managed-${c.id}@example.invalid`;
  c.publicId=(await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic managed replacement',$2,'0500000000',true,'under_review','verified',now(),'2026-06-01') returning public_id",[c.id,email])).rows[0].public_id;
  c.identity=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[fixtureSha('email|'+email),email])).rows[0].id;
  await owner.query('select public.case_access_identity_link($1,$2)',[c.identity,c.id]);await owner.query('select public.case_access_session_create($1,$2,14400)',[c.identity,fixtureSha('case-access-session|'+c.session)]);
  const offer=offerSnapshot('initial');await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2026-06-01','2026-06-01',$3,'ILS',$4,$5,array['minimum_wage'],$6,'paid',now())",[c.orderId,c.id,offer.amount_minor,offer,offer.sha256,offer.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[c.orderId]);await owner.query("select private.capture_case_input($1,'synthetic_managed_replacement_scope')",[c.id]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.managed.dev.worker',$3,now()-interval '1 minute',now()+interval '2 hours',$4,now())",[`saved-case:${c.id}`,c.sid,c.jti,canonicalSha256({sid:c.sid,jti:c.jti})]);
  await owner.query("insert into private.managed_dev_worker_capabilities(capability_sha256,expires_at,daily_limit,total_limit,notification_recipients) values($1,clock_timestamp()+interval '2 hours',20,20,$2::text[])",[capabilitySha,[fixtureSha('email|'+email)]]);
  await owner.query('insert into private.managed_dev_worker_cases(case_id,identity_id,session_sid,capability_sha256) values($1,$2,$3,$4)',[c.id,c.identity,c.sid,capabilitySha]);
  await owner.query('commit');seeded=true;own();
  const first=await upload(inputs[0]),oldHead=await head();manifest.enabled=true;writeControl();
  const crashed=await waitFor('committed_claim_crash',async()=>{const file=path.join(privatePaths.receipts!,'committed-claim-crash.json');return existsSync(file)?z.object({caseId:z.literal(c.id),pid:z.number().int(),at:z.iso.datetime(),gitSha:z.literal(gitSha),claim:z.object({state:z.literal('claimed'),jobId:z.string(),fencingToken:z.number().int()}).passthrough()}).parse(JSON.parse(readFileSync(file,'utf8'))):null;},120000);crash=crashed;
  const oldLease=(await owner.query('select state,fencing_token,revision,lease_owner,lease_expires_at,clock_timestamp() observed_at,lease_expires_at>clock_timestamp() unexpired,payload from public.engine_durable_jobs where job_id=$1 and canonical_case_id=$2',[crashed.claim.jobId,c.id])).rows[0];
  expect(oldLease.state).toBe('running');expect(Number(oldLease.fencing_token)).toBe(crashed.claim.fencingToken);expect(oldLease.unexpired).toBe(true);expect(oldLease.payload.input_sha256).toBe(oldHead.input_sha256);expect((await status()).state).toBe('processing');expect(await counts()).toEqual({runs:0,findings:0});
  checked('the external process committed a real running claim and exited; the database still reports processing with an unexpired lease');
  const second=await upload(inputs[1],first),newHead=await head();
  const timing=(await owner.query('select clock_timestamp() observed_at,$1::timestamptz>clock_timestamp() old_lease_unexpired',[oldLease.lease_expires_at])).rows[0];expect(timing.old_lease_unexpired).toBe(true);
  replacementTiming={before:oldLease.observed_at,oldLeaseExpiresAt:oldLease.lease_expires_at,afterReplacement:timing.observed_at,oldLeaseUnexpiredAfterReplacement:true,clockModified:false};
  expect(second.documentId).toBe(first.documentId);expect(second.versionId).not.toBe(first.versionId);expect(newHead.revision).toBeGreaterThan(oldHead.revision);expect(newHead.input_sha256).not.toBe(oldHead.input_sha256);await sourceBytes(first);expect(await customer()).toEqual([]);
  checked('explicit replacement commits before the original lease expires, changes the current input, retains the logical document and preserves old object bytes');
  // Real SQL admission for the original machine and old source must refuse.
  // This invokes neither a worker nor a calculator and persists no artifact.
  await control.query('begin');try{await control.query('select * from private.runtime_context_install($1,$2,$3)',[c.sid,c.jti,'managed-replacement-stale-source']);
   await expect(control.query('select private.dev_financial_admit($1,$2,$3,$4)',[c.id,c.orderId,oldHead.revision,oldHead.input_sha256])).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
  }finally{await control.query('rollback');}
  await expect(control.query('select * from private.managed_dev_worker_retry($1,$2,$3,$4)',[capability,c.id,crashed.claim.jobId,oldLease.revision])).rejects.toThrow('MANAGED_DEV_RETRY_STALE');
  checked('the original verified machine cannot admit the superseded source and its old job cannot be retried through the capability API');
  const expected:Record<string,unknown>={salary_type:'hourly',salary_period:{year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'},base_monthly_salary:{currency:'ILS',minor_units:330000},gross_salary:{currency:'ILS',minor_units:330000},net_salary:{currency:'ILS',minor_units:330000},hourly_rate:{currency:'ILS',minor_units:3300}};
  const targets=await waitFor('replacement_six_field_questions',async()=>{const rows=(await owner.query("select t.request_id,t.target from private.document_field_targets t join public.case_requests q on q.id=t.request_id where t.case_id=$1 and t.target->>'version_id'=$2 and q.answered_at is null",[c.id,second.versionId])).rows;return rows.length===6?rows:null;},300000);
  const checkpoint=(await owner.query('select result_sha256 from private.case_extraction_checkpoints where case_id=$1 and version_id=$2 order by revision desc limit 1',[c.id,second.versionId])).rows[0];
  for(const row of targets){const target=documentFieldTargetSchema.parse(row.target);expect(target.case_id).toBe(c.id);expect(target.version_id).toBe(second.versionId);expect(target.source_sha256).toBe(second.sha256);expect(target.extraction_result_sha256).toBe(checkpoint.result_sha256);expect(Object.hasOwn(expected,target.candidate.field)).toBe(true);expect(target.candidate.normalized_value).toEqual(expected[target.candidate.field]);}
  expect(targets.map(row=>documentFieldTargetSchema.parse(row.target).candidate.field).sort()).toEqual(Object.keys(expected).sort());
  await web.query('begin');try{for(const target of targets)await web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[target.request_id,c.id,c.identity,DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]]);await web.query('commit');}catch(error){await web.query('rollback');throw error;}
  confirmations.push({sourceVersion:second.versionId,fields:Object.keys(expected),actor:'automated_known_synthetic_fixture_identity',humanReview:false,confidenceModified:false});
  checked('only six independently known fields of the replacement are confirmed through identified answer RPCs; absent hours are not invented');
  const missing=await artifact('replacement-missing-hours',await waitFor('replacement_missing_hours_run',()=>financial('missing_input')));expect(missing.source.version_id).toBe(second.versionId);expect(missing.calculation).toEqual({state:'missing_input',fields:['work.regular_hours']});expect(missing.finding).toBeNull();expect(missing.request_id).toBeTruthy();
  await web.query('begin');try{for(let retry=0;retry<2;retry++)await web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[missing.request_id,c.id,c.identity,'100']);await web.query('commit');}catch(error){await web.query('rollback');throw error;}
  const answered=await artifact('replacement-answered-calculated',await waitFor('replacement_answered_calculation',()=>financial('calculated')));expect(answered.source.version_id).toBe(second.versionId);expect(answered.source.source_sha256).toBe(second.sha256);expect(answered.run_id).not.toBe(missing.run_id);expect(answered.input_revision).toBeGreaterThan(missing.input_revision);
  expect(answered.reading).toMatchObject({request_id:missing.request_id,identity_id:c.identity,answer_revision:1,answer:'100'});expect((await owner.query('select count(*)::int n from private.case_request_answer_versions where request_id=$1',[missing.request_id])).rows[0].n).toBe(1);
  expect(await counts()).toEqual({runs:2,findings:1});checked('a focused missing-hours answer and its retry produce one new scheduler-generated 240 ILS run, preserving the missing-input history');
  const beforeIdle=ticks().length;
  await waitFor('original_lease_elapsed_and_later_external_ticks',async()=>{const expired=(await owner.query('select clock_timestamp()>$1::timestamptz expired',[oldLease.lease_expires_at])).rows[0].expired;return expired&&ticks().length>=beforeIdle+2?true:null;},240000);
  expect((await owner.query("select count(*)::int n from private.dev_financial_runs where case_id=$1 and payload#>>'{source,version_id}'=$2",[c.id,first.versionId])).rows[0].n).toBe(0);
  expect((await owner.query('select count(*)::int n from public.case_report_qa where case_id=$1 and published_at is not null',[c.id])).rows[0].n).toBe(0);
  expect((await owner.query('select count(*)::int n from public.engine_outbox_events where canonical_case_id=$1 and logical_effect_id=$2',[c.id,crashed.claim.jobId])).rows[0].n).toBe(0);
  expect((await owner.query('select state from public.engine_durable_jobs where job_id=$1',[crashed.claim.jobId])).rows[0].state).not.toBe('succeeded');
  expect(await counts()).toEqual({runs:2,findings:1});await sourceBytes(first);
  const history=await customer();expect(history.filter(row=>row.current)).toHaveLength(1);expect(history.find(row=>row.current)!.payload.run_id).toBe(answered.run_id);expect(history.every(row=>row.payload.source.version_id===second.versionId)).toBe(true);
  expect((await status()).state).toBe('complete');expect(new Set(ticks().map(t=>t.pid)).size).toBeGreaterThan(1);expect(ticks().every(t=>t.failure===null)).toBe(true);
  expect(ticks().flatMap(t=>t.providerHashes)).not.toContain(first.sha256);
  const projections=(await owner.query('select p.report_document from private.automatic_dev_canonical_reports m join public.case_report_projections p on p.id=m.projection_id where m.case_id=$1',[c.id])).rows;
  expect(projections.length).toBeGreaterThan(0);expect(projections.every(row=>row.report_document.publication.state==='draft'&&row.report_document.findings.length===0)).toBe(true);
  checked('after original lease expiry and later external processes, no old-source financial run or terminal publication appears; only the new run is current and old bytes remain accessible');
 }catch(error){failure=error instanceof Error?error.message:'MANAGED_REPLACEMENT_FAILED';throw error;}finally{
  manifest.enabled=false;writeControl();await Promise.all([owner,control,web].map(db=>db.query('rollback').catch(()=>{})));
  try{if(seeded){await owner.query('begin');await owner.query('update private.managed_dev_worker_cases set enabled=false,stopped_at=clock_timestamp() where case_id=$1 and capability_sha256=$2',[c.id,capabilitySha]);await owner.query('update private.managed_dev_worker_capabilities set enabled=false where capability_sha256=$1',[capabilitySha]);
   await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[`saved-case:${c.id}`]);await owner.query("update public.engine_durable_jobs set state='cancelled',cancellation_requested=true,lease_owner=null,lease_expires_at=null,revision=revision+1 where tenant_id=$1 and canonical_case_id=$2 and state in ('queued','leased','running','retry_wait')",[`saved-case:${c.id}`,c.id]);
   await owner.query('update public.product_identity_sessions set revoked_at=coalesce(revoked_at,now()) where sid=$1 and tenant_id=$2',[c.sid,`saved-case:${c.id}`]);await owner.query('delete from private.managed_dev_notification_events where case_id=$1',[c.id]);
   z.uuid().parse(c.id);for(const table of ['case_report_projections','case_report_qa','case_report_qa_log'])await owner.query(`create policy managed_replacement_cleanup on public.${table} for delete to tivdoc_dev_migrator using(case_id='${c.id}'::uuid)`);
   expect((await owner.query("delete from public.cases where id=$1 and is_qa and first_name='Synthetic managed replacement'",[c.id])).rowCount).toBe(1);expect((await owner.query('delete from public.case_identities where id=$1',[c.identity])).rowCount).toBe(1);
   for(const table of ['case_report_projections','case_report_qa','case_report_qa_log'])await owner.query(`drop policy managed_replacement_cleanup on public.${table}`);await owner.query('commit');cleaned=true;
   for(const value of paths)expect(value.startsWith(`cases/${c.id}/versions/`)).toBe(true);if(paths.length){const removed=await bucket.remove(paths);if(removed.error)throw Error('MANAGED_REPLACEMENT_STORAGE_CLEANUP');}
   const remaining=await bucket.list(`cases/${c.id}/versions`);if(remaining.error||remaining.data.length)throw Error('MANAGED_REPLACEMENT_STORAGE_REMAINS');storageCleaned=true;
  }}catch(error){cleanupFailure=error instanceof Error?error.message:'MANAGED_REPLACEMENT_CLEANUP_FAILED';await owner.query('rollback').catch(()=>{});throw error;}finally{
   mkdirSync('docs/release-evidence',{recursive:true});writeFileSync('docs/release-evidence/DEV-managed-worker-replacement-db.json',JSON.stringify({
    verdict:!failure&&!cleanupFailure&&cleaned&&storageCleaned&&checks.length===6?'PASS':'FAIL',gitSha,gitWorktreeDirty:dirty,schemaVersion,runId,checks,crash,replacementTiming,confirmations,runs,
    ticks:ticks(),failure,cleanupFailure,inputFixtures:inputs.map(i=>({name:i.name,sha256:i.sha256})),independentExpected:DEV_FINANCIAL_ORACLE,
    externallyScheduledProcess:ticks().length>0,replacementWhileLeaseUnexpired:replacementTiming!==null,ordinaryCanonicalPublication:'draft_only',providerKind:'injected_test_provider',
    liveOcrProof:false,providerInFlightInterruptionProof:false,scope:'Replacement after a real committed running claim, before extraction; no claim of cancelling an in-flight external OCR request.',
    actualEmailDelivery:false,browserProof:false,humanApprovalsInvented:false,syntheticCasesRemoved:cleaned?1:0,identitiesRemoved:cleaned?1:0,
    machineSessionsRevoked:cleaned?1:0,capabilityRevoked:cleaned,storageObjectsRemoved:storageCleaned?paths.length:0,canonicalAndBudgetAuditRetained:true,productionChanged:false,
   },null,2)+'\n');await Promise.all([owner.end(),control.end(),web.end()]);
  }
 }
},900000);
