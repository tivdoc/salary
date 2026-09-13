import {expect,it,vi} from 'vitest';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {createClient} from '@supabase/supabase-js';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentUploadSchema} from '@/lib/document-upload';
import type {UploadBatch,ReservedFile} from '../documents/upload';
import {offerSnapshot} from '../orders/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {postgresCaseAccessDb} from '../case-access/db';
import {encryptNotification,decryptNotification} from '../case-access/notification-outbox';
import {payloadDigest} from '../case-access/notifications';
import {DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from '../reports/document-field-confirmation';
import {OpenAiPayslipV2PassExtractor} from '@/server/engine/extraction/providers/openai/v2-adapter';
import {OPENAI_SOL_COMPARISON_PROFILE} from '@/server/engine/extraction/providers/openai/v2-request';
import type {SavedWorkerTransactions} from './saved-extraction-worker';
import {claimSavedDraftJob} from './saved-job-runtime';
import {runSavedDraftJob} from './saved-job-runner';
import {runAutomaticDevMonth} from './automatic-dev-flow';
import {completionNotificationRoundSchema,renderCompletionNotification,type CompletionNotificationRound} from './automatic-dev-completion-notifications';
import {completionAggregationFixture} from './completion-aggregation.fixture';
vi.mock('server-only',()=>({}));
const OWNER='dcc1e30f-d516-47dd-a9d8-5365bfcd8b9a',sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');

// A real saved worker creates source targets, canonical blocked analysis and
// terminal manifest. Only its extraction transport is injected. No findings,
// report bytes, analysis completion or notification provider event are seeded.
it.skipIf(process.env.TIVDOC_COMPLETION_AGGREGATION_DB_PROOF!=='1')('groups ordinary-worker questions and fences actual concurrent notification claims without sending',async()=>{
 if(process.env.NODE_ENV!=='test'||process.env.VERCEL||process.env.VERCEL_ENV)throw Error('AGGREGATION_PROOF_SCOPE');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile('../release-work/replay.env');
 const client=(key:string,role:string)=>{const u=new URL(env.get(key)!);expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.username).toBe(role+'.cpzrbidxftzqcfeqqusu');u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL','tivdoc_dev_migrator'),web=client('TIVDOC_WEB_POSTGRES_URL','tivdoc_web_runtime'),worker=client('TIVDOC_WORKER_POSTGRES_URL','tivdoc_worker_runtime'),peer=client('TIVDOC_WORKER_POSTGRES_URL','tivdoc_worker_runtime');
 const caseId=randomUUID(),orderId=randomUUID(),sid='completion-aggregation:'+randomUUID(),jti=randomUUID(),capability=randomBytes(32).toString('base64url'),capabilitySha=sha(capability),foreignCapability=randomBytes(32).toString('base64url');
 const directory=`output/release-completion/completion-aggregation/${caseId.slice(0,8)}`,privateControl=`../release-work/completion-aggregation-${caseId}.private.json`,secret=randomBytes(32).toString('base64');mkdirSync(directory,{recursive:true});
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),gitDirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()!=='';
 const fixture=await completionAggregationFixture(),checks:string[]=[],versions:ReservedFile[]=[],jobs:string[]=[],rounds:{roundId:string;questions:number}[]=[];let publicId='',providerCalls=0,activeTransactions=0,provisioned=false,stopped=false,failure:string|null=null;
 const keys=JSON.parse(readFileSync('../release-work/preview-secrets.json','utf8'));expect(keys.NEXT_PUBLIC_SUPABASE_URL).toBe('https://cpzrbidxftzqcfeqqusu.supabase.co');
 const bucket=createClient(keys.NEXT_PUBLIC_SUPABASE_URL,keys.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false,autoRefreshToken:false}}).storage.from('salary-documents');
 const db=(c:pg.Client)=>postgresCaseAccessDb({query:(sql,values)=>c.query(sql,values?[...values]:[])});
 const own=()=>writeFileSync(privateControl,JSON.stringify({caseId,publicId,orderId,sid,jti,capability,capabilitySha,foreignCapability,secret,versions,jobs,gitSha,fixtureSha256:fixture.sha256,directory,providerKind:'injected_test_provider',actualEmailsSent:0},null,2)+'\n',{mode:0o600});
 const transactions:SavedWorkerTransactions=async operation=>{await worker.query('begin');activeTransactions++;try{
  await worker.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'completion-aggregation-proof']);await worker.query("select set_config('tivdoc.engine_git_sha',$1,true)",[gitSha]);
  const result=await operation({transaction_id:randomUUID(),client:{async query(s){const r=await worker.query(s.text,[...s.values]);return {rows:r.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),row_count:r.rowCount??0};}}});await worker.query('commit');return result;
 }catch(error){await worker.query('rollback');throw error;}finally{activeTransactions--;}};
 const storage={async download(path:string){expect(versions.some(v=>v.path===path)).toBe(true);expect(activeTransactions).toBe(0);const result=await bucket.download(path);if(result.error||!result.data)throw Error('AGGREGATION_STORAGE_READ');return {data:result.data,error:null};}};
 vi.stubEnv('TIVDOC_SOL_SAVED_WORKER_PROOF','1');
 const extractor=new OpenAiPayslipV2PassExtractor({apiKey:'synthetic-no-network',model:'gpt-5.6-sol',timeoutMs:1000},{executionProfile:OPENAI_SOL_COMPARISON_PROFILE,recoveryExecution:'skip_package_budget',transport:{async parse(request){
  expect(activeTransactions).toBe(0);const part=request.input[0].content.find(p=>p.type==='input_file');if(!part||!('file_data'in part))throw Error('AGGREGATION_FIXTURE_SOURCE');expect(sha(Buffer.from(part.file_data.split(',')[1],'base64'))).toBe(fixture.sha256);providerCalls++;
  return {id:'injected-aggregation-'+randomUUID(),status:'completed',outputParsed:structuredClone(fixture.output),usage:null};
 }},log:()=>{}});
 const upload=async(replace?:ReservedFile)=>{
  const manifest=documentUploadSchema.parse({caseId,batchId:randomUUID(),checkPeriodMonth:'2026-06',files:[{clientId:randomUUID(),documentType:'payslip',name:'synthetic-notification-input.pdf',type:'application/pdf',size:fixture.bytes.length,sha256:fixture.sha256,periodMonth:'2026-06',...(replace?{replace:{documentId:replace.documentId,versionId:replace.versionId}}:{})}]});
  const batch=(await web.query('select public.case_documents_reserve($1,$2,$3) value',[caseId,manifest.batchId,manifest])).rows[0].value as UploadBatch;expect(batch.files).toHaveLength(1);const file=batch.files[0];expect(file.path.startsWith(`cases/${caseId}/versions/`)).toBe(true);versions.push(file);own();
  const signed=await bucket.createSignedUploadUrl(file.path,{upsert:false});if(signed.error||!signed.data)throw Error('AGGREGATION_STORAGE_SIGN');const upload=await bucket.uploadToSignedUrl(file.path,signed.data.token,fixture.bytes,{contentType:'application/pdf'});expect(upload.error).toBeNull();
  const bytes=await storage.download(file.path);expect(sha(Buffer.from(await bytes.data.arrayBuffer()))).toBe(fixture.sha256);await web.query('select public.case_documents_commit($1,$2,$3)',[caseId,manifest.batchId,{[file.versionId]:fixture.sha256}]);return file;
 };
 const run=async(receiptOnly=false)=>{
  const lease=await transactions(context=>claimSavedDraftJob(context,{caseId,workerId:'aggregation-proof-worker',leaseMs:300000}));if(lease.state!=='claimed')throw Error('AGGREGATION_EXPECTED_CLAIM');jobs.push(lease.jobId);own();
  const result=await runSavedDraftJob({...lease,workerId:'aggregation-proof-worker',transactions,storage,providerEnabled:!receiptOnly,...(receiptOnly?{receiptOnly:true}:{extractor}),onMonth:runAutomaticDevMonth,heartbeat:{intervalMs:10000,leaseMs:300000}});
  expect(result.completion.manifest.months).toHaveLength(1);return result;
 };
 const pending=async()=>completionNotificationRoundSchema.array().parse(await db(worker).rpc('case_notification_completion_pending',{target_capability:capability}));
 const enqueue=async(round:CompletionNotificationRound,c=worker,overrides:Readonly<Record<string,unknown>>={})=>{
  const message=renderCompletionNotification(round,'https://tivdoc-aggregation-synthetic.vercel.app'),delivery=payloadDigest(message);
  const result=await db(c).rpc<{value:string|null}>('case_notification_completion_enqueue',{target_capability:capability,target_round:round.round_id,target_delivery:delivery,target_payload:encryptNotification(message,delivery,secret),target_expires:new Date(Date.now()+5*3600000).toISOString(),expected_case:caseId,expected_identity:OWNER,expected_recipient:sha('email|tivdoc.com@gmail.com'),expected_request_set_sha256:round.request_set_sha256,expected_request_ids:round.questions.map(q=>q.request_id).sort(),...overrides});return result[0]?.value;
 };
 const claim=async(c:pg.Client,workerId:string)=>db(c).rpc<{delivery_id:string;encrypted_payload:unknown;fencing_token:number}>('case_notification_managed_claim',{target_capability:capability,target_worker:workerId});
 const dispatch=async(c:pg.Client,delivery:string,workerId:string,fence:number)=>db(c).rpc<{state:string}>('case_notification_managed_dispatch',{target_capability:capability,target_delivery:delivery,target_worker:workerId,target_fence:fence});
 try{
  await Promise.all([owner.connect(),web.connect(),worker.connect(),peer.connect()]);expect((await owner.query('select current_database() db,session_user role')).rows[0]).toEqual({db:'tivdoc_release_replay_20260907',role:'tivdoc_dev_migrator'});
  expect((await owner.query("select contact_hash from public.case_identities where id=$1 and channel='email'",[OWNER])).rows[0]?.contact_hash).toBe(sha('email|tivdoc.com@gmail.com'));
  await owner.query('begin');publicId=(await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic completion aggregation',$2,'0500000000',true,'under_review','verified',now(),'2026-06-01') returning public_id",[caseId,`aggregation-${caseId}@example.invalid`])).rows[0].public_id;
  await owner.query('select public.case_access_identity_link($1,$2)',[OWNER,caseId]);const {sha256:initialHash,...initialOffer}=offerSnapshot('initial');void initialHash;const offerBody={...initialOffer,version:'tivdoc-order-offer-v2',kind:'full',service_kind:'ai_assisted',human_review_required:false,synthetic_paid_test_scope:true};const offer={...offerBody,sha256:canonicalSha256(offerBody)};
  await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'full','2026-06-01','2026-06-01',$3,'ILS',$4,$5,array['minimum_wage'],$6,'paid',now())",[orderId,caseId,offer.amount_minor,offer,offer.sha256,offer.terms_version]);await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[orderId]);await owner.query("select private.capture_case_input($1,'synthetic_aggregation_paid_scope')",[caseId]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.aggregation.worker',$3,now()-interval '1 minute',now()+interval '3 hours',$4,now())",['saved-case:'+caseId,sid,jti,canonicalSha256({sid,jti})]);
  await owner.query("insert into private.managed_dev_worker_capabilities(capability_sha256,expires_at,notification_recipients) values($1,now()+interval '3 hours',$2),($3,now()+interval '3 hours',$4)",[capabilitySha,[sha('email|tivdoc.com@gmail.com')],sha(foreignCapability),[sha('email|foreign-aggregation@example.invalid')]]);
  await owner.query('insert into private.managed_dev_worker_cases(case_id,identity_id,session_sid,capability_sha256) values($1,$2,$3,$4)',[caseId,OWNER,sid,capabilitySha]);await owner.query('commit');provisioned=true;own();writeFileSync(directory+'/input.pdf',fixture.bytes);
  const first=await upload();expect(await pending()).toHaveLength(0);const initial=await run();
  expect(providerCalls).toBe(1);expect(initial.completion.manifest.months[0].analysis_run_id).toBeTruthy();
  const candidates=(await owner.query("select t.target#>>'{candidate,field}' field from private.document_field_targets t join public.case_requests q on q.id=t.request_id where t.case_id=$1 and q.answered_at is null order by 1",[caseId])).rows.map(r=>r.field);expect(candidates).toEqual(fixture.expectedFields);
  const [ready]=await pending();expect(ready.questions).toHaveLength(14);rounds.push({roundId:ready.round_id,questions:14});
  expect((await owner.query('select count(*)::int n from public.case_report_projections where case_id=$1',[caseId])).rows[0].n).toBe(0);
  checks.push('actual_uploaded_synthetic_source_injected_extraction_ordinary_blocked_analysis_and_terminal_manifest_generate_fourteen_current_requests');
  expect(await enqueue(ready,worker,{expected_case:randomUUID()})).toBeNull();expect(await enqueue(ready,worker,{expected_identity:randomUUID()})).toBeNull();expect(await enqueue(ready,worker,{expected_request_set_sha256:'0'.repeat(64)})).toBeNull();
  expect(await enqueue(ready,worker,{target_capability:foreignCapability})).toBeNull();
  await owner.query('update private.managed_dev_worker_capabilities set enabled=false where capability_sha256=$1',[capabilitySha]);await expect(pending()).rejects.toThrow('MANAGED_DEV_CAPABILITY_FORBIDDEN');await owner.query('update private.managed_dev_worker_capabilities set enabled=true where capability_sha256=$1',[capabilitySha]);
  const concurrent=await Promise.all([enqueue(ready,worker),enqueue(ready,peer)]);expect(concurrent[0]).toBeTruthy();expect(concurrent[0]).toBe(concurrent[1]);const delivery=concurrent[0]!;
  expect((await owner.query('select count(*)::int n from private.managed_dev_completion_rounds where case_id=$1',[caseId])).rows[0].n).toBe(1);expect((await owner.query('select count(*)::int n from private.case_notification_outbox where case_id=$1',[caseId])).rows[0].n).toBe(1);
  const w1=randomUUID(),w2=randomUUID(),claims=await Promise.all([claim(worker,w1),claim(peer,w2)]);expect(claims.flat()).toHaveLength(1);const winner=claims[0].length?{c:worker,id:w1,row:claims[0][0]}:{c:peer,id:w2,row:claims[1][0]};
  const rendered=decryptNotification(winner.row.encrypted_payload,delivery,secret);for(const q of ready.questions)expect(rendered.body).toContain(q.request_id);
  await winner.c.query('begin');expect(await dispatch(winner.c,delivery,winner.id,winner.row.fencing_token)).toEqual([{state:'ready'}]);await winner.c.query('rollback');
  checks.push('actual_two_worker_enqueue_race_has_one_envelope_and_concurrent_claims_have_one_lease_all_fourteen_links_foreign_and_revoked_scopes_refused');
  // A real identified answer arrives after claim but before provider dispatch.
  const question=(await owner.query("select request_id from private.document_field_targets where case_id=$1 and target#>>'{candidate,field}'='regular_hours'",[caseId])).rows[0].request_id;
  await web.query('select * from public.case_request_answer_identified($1,$2,$3,$4)',[question,caseId,OWNER,DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]]);
  expect(await dispatch(winner.c,delivery,winner.id,winner.row.fencing_token)).toEqual([{state:'cancelled'}]);expect(await pending()).toHaveLength(0);
  await run(true);expect(providerCalls).toBe(1);const [answered]=await pending();expect(answered.questions).toHaveLength(13);expect(answered.questions.some(q=>q.request_id===question)).toBe(false);expect(answered.round_id).not.toBe(ready.round_id);rounds.push({roundId:answered.round_id,questions:13});
  expect(await enqueue(ready)).toBeNull();const next=await enqueue(answered);expect(next).toBeTruthy();const nextWorker=randomUUID(),nextClaim=(await claim(worker,nextWorker))[0];expect(nextClaim.delivery_id).toBe(next);
  expect(await dispatch(worker,next!,nextWorker,nextClaim.fencing_token)).toEqual([{state:'ready'}]);
  // No network call follows this committed dispatch fence: simulate process
  // loss with unknown outcome. A fresh real connection cannot dispatch again.
  const restarted=client('TIVDOC_WORKER_POSTGRES_URL','tivdoc_worker_runtime');await restarted.connect();try{expect(await claim(restarted,randomUUID())).toHaveLength(0);expect(await dispatch(restarted,next!,nextWorker,nextClaim.fencing_token)).toEqual([{state:'held'}]);}finally{await restarted.end();}
  expect(await pending()).toHaveLength(0);checks.push('identified_answer_before_send_cancels_old_snapshot_cached_ordinary_rerun_excludes_answer_then_committed_unknown_dispatch_is_held_after_connection_restart');
  // Genuine new source version creates new request IDs and a new completed run.
  await upload(first);await run();expect(providerCalls).toBe(2);const [later]=await pending();expect(later.questions).toHaveLength(14);expect(later.questions.every(q=>!ready.questions.some(old=>old.request_id===q.request_id))).toBe(true);rounds.push({roundId:later.round_id,questions:14});
  const laterDelivery=await enqueue(later);expect(laterDelivery).toBeTruthy();expect(await enqueue(later,peer)).toBe(laterDelivery);
  const genericCandidates=(await owner.query("select count(*)::int n from private.case_notification_outbox o where o.case_id is distinct from $1 and o.state in ('queued','leased') and o.available_at<=now() and o.expires_at>now() and o.attempts<6",[caseId])).rows[0].n;
  if(genericCandidates!==0)throw Error('AGGREGATION_GENERIC_CLAIM_FOREIGN_WORK_PENDING');
  await worker.query('begin');try{expect((await worker.query('select delivery_id from public.case_notification_outbox_claim($1)',[randomUUID()])).rows).toHaveLength(0);}finally{await worker.query('rollback');}
  expect((await owner.query('select provider_message_id from private.case_notification_outbox where case_id=$1',[caseId])).rows.every(r=>r.provider_message_id===null)).toBe(true);
  expect((await owner.query('select count(*)::int n from public.case_report_projections where case_id=$1',[caseId])).rows[0].n).toBe(0);
  checks.push('actual_source_replacement_and_ordinary_run_create_later_new_action_group_generic_claim_cannot_bypass_no_provider_email_or_financial_projection');
  writeFileSync(directory+'/ready-round.json',JSON.stringify(later,null,2)+'\n');writeFileSync(directory+'/manifest.json',JSON.stringify(initial.completion,null,2)+'\n');
 }catch(error){failure=error instanceof Error?error.message:'unknown_failure';throw error;}finally{
  await Promise.allSettled([owner.query('rollback'),web.query('rollback'),worker.query('rollback'),peer.query('rollback')]);
  if(provisioned){
   await owner.query('begin');try{
    // The test uses a non-serving URL and never authorizes its encrypted body
    // for real delivery. Quarantine only unstarted fixture envelopes; keep
    // committed unknown dispatch history immutable for reconciliation.
    await owner.query("update private.case_notification_outbox o set state='dead_letter',encrypted_payload=null,last_error='synthetic_fixture_no_send',lease_owner=null,lease_expires_at=null where o.case_id=$1 and o.state in ('queued','leased') and o.provider_message_id is null and exists(select 1 from private.managed_dev_completion_rounds r where r.delivery_id=o.delivery_id and r.case_id=o.case_id and r.dispatch_started_at is null)",[caseId]);
    await owner.query('update private.managed_dev_worker_capabilities set enabled=false where capability_sha256=any($1)',[[capabilitySha,sha(foreignCapability)]]);await owner.query('update private.managed_dev_worker_cases set enabled=false,stopped_at=clock_timestamp() where case_id=$1 and capability_sha256=$2',[caseId,capabilitySha]);
    await owner.query("select set_config('tivdoc.tenant_id',$1,true)",['saved-case:'+caseId]);await owner.query('update public.product_identity_sessions set revoked_at=clock_timestamp() where tenant_id=$1 and sid=$2',['saved-case:'+caseId,sid]);await owner.query('commit');stopped=true;
   }catch(error){await owner.query('rollback');if(!failure)failure='AGGREGATION_CLEANUP_FAILED';throw error;}
  }
  await Promise.allSettled([owner.end(),web.end(),worker.end(),peer.end()]);vi.unstubAllEnvs();
  writeFileSync(directory+'/proof.json',JSON.stringify({at:new Date().toISOString(),state:failure?'FAIL':'PASS',error:failure,gitSha,gitDirty,caseId,publicId,schema:158,checks,rounds,sourceVersions:versions.map(v=>v.versionId),sourceSha256:fixture.sha256,injectedExtractionCalls:providerCalls,paidProviderCalls:0,emailProviderCalls:0,customerSessionSeeded:false,findingsSeeded:false,reportSeeded:false,realOcrProven:false,retainedForScopedBrowser:true,stopped,productionChanged:false},null,2)+'\n');own();
 }
},180000);
