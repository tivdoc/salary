import {expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {PDFDocument,StandardFonts} from 'pdf-lib';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema,type DocumentReviewResult} from '@/engine/document-review/contracts';
import {compareDocumentReviewDependencies,replayDocumentReview} from '@/engine/document-review/service';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {postgresCaseAccessDb} from '../case-access/db';
import {offerSnapshot} from '../orders/contracts';
import {answerCaseRequest,editCaseRequest,listCaseRequests} from '../reports/case-requests';
import {saveSavedDocumentReview} from './saved-document-review';
import {runSavedWorkerMonth} from './saved-worker';
import {claimSavedDraftJob} from './saved-job-runtime';
import {completeSavedDraftJob} from './saved-job-completion';
import {sourceJobSchema,type SourceJob} from './source-dispatch';

const sha=(bytes:string|Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const period={from:'2026-06-01',to:'2026-06-30'};
// Independent arithmetic, not an activated legal rule or a live OCR oracle.
const ORACLE={observedPensionRatio:{numerator:'3',denominator:'50'},rateMinor:5000,recordedMinor:40000,
 firstDeclaredHours:10,firstDifferenceMinor:10000,correctedHours:11,correctedDifferenceMinor:15000};
type Completed=Awaited<ReturnType<typeof runSavedWorkerMonth>>;

it.skipIf(process.env.TIVDOC_DOCUMENT_REVIEW_DB_PROOF!=='1')('persists ordinary source review, identified factual completions and dependent-only new analysis with actual DEV roles',async()=>{
 if(process.env.VERCEL||process.env.NODE_ENV!=='test')throw Error('DOCUMENT_REVIEW_DB_BOUNDARY');
 const gitSha=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const dirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);
  expect(u.pathname).toBe('/tivdoc_release_replay_20260907');expect(u.hostname).toBe('aws-0-eu-central-1.pooler.supabase.com');
  expect(u.username.endsWith('.cpzrbidxftzqcfeqqusu')).toBe(true);u.search='';
  return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),peer=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL'),webPeer=client('TIVDOC_WEB_POSTGRES_URL');
 let restarted:pg.Client|undefined;
 const caseId=randomUUID(),foreignCaseId=randomUUID(),documentId=randomUUID(),versionId=randomUUID(),orderId=randomUUID(),sid='document-review-proof:'+randomUUID(),jti=randomUUID(),tenant='saved-case:'+caseId;
 const directory='output/release-completion/document-review-db/'+caseId.slice(0,8),privateFile='../release-work/document-review-db-'+caseId+'.private.json';mkdirSync(directory,{recursive:true});
 const migration='20260911144617_document_review_identified_completions.sql';
 const checks:string[]=[],jobs:string[]=[],artifacts:Record<string,unknown>[]=[],answerHistory:Record<string,unknown>[]=[];
 let phase='connect',lastStatement='',identity='',foreignIdentity='',seeded=false,machineRevoked=false,failure:unknown=null,cleanupFailure:unknown=null,failBeforeOpen=false;
 const safeError=(e:unknown)=>({name:e instanceof Error?e.name:'unknown',code:typeof e==='object'&&e!==null&&'code'in e?String(e.code):null,
  message:e instanceof Error&&/^[A-Z0-9_:]+$/.test(e.message)?e.message:'SCOPED_DRIVER_OR_ASSERTION_ERROR',phase,lastStatement});
 const own=()=>writeFileSync(privateFile,JSON.stringify({caseId,foreignCaseId,documentId,versionId,orderId,identity,foreignIdentity,sid,jti,jobs,directory,
  scope:'New synthetic QA fixture only. No real customer, contact, payment, OCR or legal approval. Retain append-only case/history; revoke only this machine and cancel only these listed unfinished jobs.'},null,2)+'\n');own();
 const transactions=(db:pg.Client)=>async<T>(operation:(context:PostgresTransactionContext)=>Promise<T>)=>{
  await db.query('begin');
  try{await db.query('select * from private.runtime_context_install($1,$2,$3)',[sid,jti,'document-review-integration']);
   await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[gitSha]);
   const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(s){lastStatement=s.name;
    if(failBeforeOpen&&s.name==='review_request_open')throw Error('INJECTED_BEFORE_REVIEW_REQUEST');
    const result=await db.query(s.text,[...s.values]);return {rows:result.rows.map(row=>Object.fromEntries(Object.entries(row).map(([k,v])=>[k,v instanceof Date?v.toISOString():v]))),row_count:result.rowCount??0};}}};
   const value=await operation(context);await db.query('commit');return value;
  }catch(error){await db.query('rollback');throw error;}
 };
 const head=async()=>{const row=(await owner.query("select h.revision,h.input_sha256,d.authority_dependency_sha256 from private.case_input_heads h left join private.case_analysis_dispatch d on d.case_id=h.case_id and d.revision=h.revision and d.mode='draft' where h.case_id=$1",[caseId])).rows[0];
  return sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:caseId,revision:Number(row.revision),input_sha256:row.input_sha256,mode:'draft',...(row.authority_dependency_sha256?{authority_dependency_sha256:row.authority_dependency_sha256}:{})});};
 const claim=()=>transactions(worker)(async context=>{const value=await claimSavedDraftJob(context,{caseId,workerId:'document-review-proof',leaseMs:300000});
  if(value.state!=='claimed')throw Error('DOCUMENT_REVIEW_EXPECTED_CLAIM');jobs.push(value.jobId);own();
  const payload=(await worker.query('select payload from public.engine_durable_jobs where job_id=$1',[value.jobId])).rows[0].payload;
  return {job:sourceJobSchema.parse(payload),jobId:value.jobId,workerId:'document-review-proof',fencingToken:value.fencingToken};});
 const calculate=(job:SourceJob,db=worker)=>transactions(db)(context=>runSavedWorkerMonth({context,job,orderId,month:'2026-06'}));
 const finish=(lease:Awaited<ReturnType<typeof claim>>)=>transactions(worker)(context=>completeSavedDraftJob({context,...lease}));
 const counts=async()=>(await owner.query(`select
  (select count(*)::int from public.analysis_runs where tenant_id=$1) analyses,
  (select count(*)::int from private.document_review_request_targets where case_id=$2) targets,
  (select count(*)::int from private.case_extraction_invocations where case_id=$2) provider_invocations`,[tenant,caseId])).rows[0];
 const reviewOf=(run:Completed):DocumentReviewResult=>{if(!run.completed||!run.bundle?.document_review||!run.report)throw Error('DOCUMENT_REVIEW_RUN_REQUIRED');return replayDocumentReview(run.bundle.document_review);};
 const saveArtifacts=(label:string,run:Completed)=>{const review=reviewOf(run);const report=run.report!;
  expect(report.analysis_result_sha256).toBe(run.bundle!.result_sha256);
  for(const [extension,bytes,hash]of [['json',report.json,report.json_sha256],['html',report.html,report.html_sha256],['pdf',report.pdf,report.pdf_sha256]] as const){
   expect(sha(bytes)).toBe(hash);writeFileSync(`${directory}/${label}.${extension}`,bytes);
  }
  writeFileSync(`${directory}/${label}.review.json`,JSON.stringify(review,null,2)+'\n');
  artifacts.push({label,analysis_run_id:review.analysis_run_id,input_revision:run.command.case_revision,source_input_sha256:run.command.document_snapshot_id,
   result_sha256:run.bundle!.result_sha256,review_sha256:review.result_sha256,report_sha256:report.report_sha256,html_sha256:report.html_sha256,pdf_sha256:report.pdf_sha256});
  return review;
 };
 try{
  await Promise.all([owner.connect(),worker.connect(),peer.connect(),web.connect(),webPeer.connect()]);
  expect((await worker.query('select session_user principal,current_database() name')).rows[0]).toEqual({principal:'tivdoc_worker_runtime',name:'tivdoc_release_replay_20260907'});
  expect((await web.query('select session_user principal')).rows[0].principal).toBe('tivdoc_web_runtime');
  const pdf=await PDFDocument.create();pdf.setCreationDate(new Date('2026-06-30T00:00:00Z'));pdf.setModificationDate(new Date('2026-06-30T00:00:00Z'));
  const font=await pdf.embedFont(StandardFonts.Helvetica),page=pdf.addPage([595,842]);
  const lines=['SYNTHETIC ATTENDANCE AND ACCOUNTING REVIEW FIXTURE','June 2026 - no real employee or legal entitlement',
   'Recorded hourly rate: 50.00 ILS','Recorded paid amount: 400.00 ILS','Actual regular hours: NOT DOCUMENTED',
   'Recorded employee pension amount: 120.00 ILS','Recorded pension basis: 2000.00 ILS',
   'Pension rows are same-period arithmetic evidence only.','No proof of actual fund transfer is present.',
   'Customer declarations are separate from the original document.'];
  for(const [index,line]of lines.entries())page.drawText(line,{font,x:30,y:790-index*31,size:12});
  const bytes=await pdf.save(),sourceSha=sha(bytes);writeFileSync(directory+'/source.pdf',bytes);writeFileSync(directory+'/independent-oracle.json',JSON.stringify(ORACLE,null,2)+'\n');
  phase='provision-owned-synthetic-fixture';await owner.query('begin');
  for(const id of [caseId,foreignCaseId]){const email='document-review-'+id+'@example.invalid';
   await owner.query("insert into public.cases(id,first_name,email,phone,is_qa,status,payment_status,contact_verified_at,check_period_month) values($1,'Synthetic document review integration',$2,'0500000000',true,'under_review','verified',now(),'2026-06-01')",[id,email]);
   const actor=(await owner.query("select public.case_access_identity_upsert('email',$1,$2) id",[sha('email|'+email),email])).rows[0].id;
   await owner.query('select public.case_access_identity_link($1,$2)',[actor,id]);if(id===caseId)identity=actor;else foreignIdentity=actor;
  }
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'attendance','attendance',$4,'synthetic-source.pdf','application/pdf',$5,$6,'2026-06-01')",
   [documentId,caseId,versionId,`cases/${caseId}/versions/${versionId}.pdf`,bytes.length,sourceSha]);
  const offer=offerSnapshot('initial');await owner.query("insert into private.product_orders(id,case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version,state,verified_at) values($1,$2,'initial','2026-06-01','2026-06-01',$3,'ILS',$4,$5,array['working_time','pension'],$6,'paid',now())",[orderId,caseId,offer.amount_minor,offer,offer.sha256,offer.terms_version]);
  await owner.query("insert into private.order_entitlements(order_id,state) values($1,'active')",[orderId]);
  await owner.query("select private.capture_case_input($1,'synthetic_document_review_paid_scope')",[caseId]);
  await owner.query("insert into public.product_identity_sessions(tenant_id,sid,subject,current_jti,valid_after,expires_at,session_sha256,created_at) values($1,$2,'synthetic.document.review.worker',$3,now()-interval '1 minute',now()+interval '30 minutes',$4,now())",[tenant,sid,jti,canonicalSha256({sid,jti})]);
  await owner.query('commit');seeded=true;own();
  const firstLease=await claim(),pin={case_id:caseId,document_id:documentId,version_id:versionId,source_sha256:sourceSha},readingSha=canonicalSha256({sourceSha,lines,reading:'automated_known_synthetic_source_review'});
  const source={document_id:documentId,version_id:versionId,file_sha256:sourceSha,page:1,locator:'synthetic source table',label:'נתוני בדיקה סינתטיים',reading:'ai_document_review',reading_receipt_sha256:readingSha};
  const operand=(id:string,value:string|null,representation='money_ils',quantity_unit:string|null=null)=>({id,observation_id:'synthetic.'+id,state:value===null?'missing':'observed',printed_value:value,representation,quantity_unit,precision:'source_exact',source});
  const base={schema_version:'document-review-calculation-input-v1',case_id:caseId,run_id:'pending',period,evaluated_at:'2026-09-11T00:00:00Z',
   source_manifest:[{case_id:caseId,document_id:documentId,version_id:versionId,file_sha256:sourceSha,page_count:1,kind:'case_document'}],remittance_status:'missing'};
  const input=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period,
   purchased_scope:{order_id:orderId,receipt_sha256:offer.sha256,topics:['working_time','pension'],origin:'saved_order'},
   documents:[{case_id:caseId,document_id:documentId,version_id:versionId,file_sha256:sourceSha,page_count:1,kind:'attendance',label:'מסמך חשבון ונוכחות סינתטי',period,reading_origin:'ai_document_review',reading_sha256:readingSha}],
   checks:[{check_id:'pension.ratio',topic:'pension',title:'יחס ניכוי נצפה',explanation:'יחס חשבוני בין שני סכומים הרשומים לאותה תקופה; לא קביעת זכאות או הפקדה.',calculation:{...base,check_id:'pension.ratio',operands:[operand('contribution','120.00'),operand('base','2000.00')],operation:{kind:'observed_ratio',numerator_ref:'contribution',denominator_ref:'base',component_identity:'employee pension',same_period_and_base:true,basis:'Independent synthetic same-period oracle: 120/2000=0.06'}}},
    {check_id:'hours.product',topic:'working_time',title:'התאמת כמות ותשלום',explanation:'כפל הכמות בתעריף הרשום בלבד; אין קביעת זכאות משפטית.',calculation:{...base,check_id:'hours.product',operands:[operand('rate','50.00'),operand('hours',null,'decimal_quantity','hours'),operand('paid','400.00')],operation:{kind:'product',money_ref:'rate',factor_refs:['hours'],recorded_ref:'paid',rounding:'half_up',rounding_basis:'Independent accounting arithmetic; no legal wage rule'}}}],
   answer_bindings:[{fact_key:'hours.quantity',check_id:'hours.product',operand_id:'hours'}],
   completion_input:{case_id:caseId,period,documents:[{pin,kind:'attendance',period,review:'complete'}],evidence:[],needs:[{fact_key:'hours.quantity',kind:'factual',reason:'missing',required_evidence_kind:'customer_declaration',question:'כמה שעות עבודה בפועל היו בתקופה המסומנת?',answer_kind:'number',source_pins:[pin],dependent_check_ids:['hours.product'],general_question:false}]}});
  phase='save-curated-source';await transactions(worker)(context=>saveSavedDocumentReview(context,firstLease.job,input));
  checks.push('actual worker saves source-bound curated synthetic input through verified SID/JTI and the normal immutable source checkpoint; no OCR/checkpoint/finding/report result was seeded');
  phase='rollback-before-request';failBeforeOpen=true;
  try{await expect(calculate(firstLease.job)).rejects.toThrow('INJECTED_BEFORE_REVIEW_REQUEST');}finally{failBeforeOpen=false;}
  expect(await counts()).toEqual({analyses:0,targets:0,provider_invocations:0});checks.push('failure after calculation but before request save rolls back analysis/report/target atomically');
  phase='initial-analysis';const first=await calculate(firstLease.job),firstReview=saveArtifacts('initial',first);
  expect(firstReview.checks[0].calculation.observed_ratio).toEqual({kind:'rational',...ORACLE.observedPensionRatio,unit:'ratio'});expect(firstReview.checks[1].calculation.state).toBe('blocked');
  expect(first.stages).toHaveLength(7);expect(first.bundle!.known_subtotal).toBeNull();expect(firstReview.legal_debt_total).toBeNull();
  await finish(firstLease);const webDb=postgresCaseAccessDb(web),peerWebDb=postgresCaseAccessDb(webPeer);
  const requests=(await listCaseRequests(caseId,webDb,identity)).filter(r=>r.code.startsWith('document_review:'));expect(requests).toHaveLength(1);const request=requests[0];expect(request.source_current).toBe(true);
  checks.push('ordinary persisted analysis creates one source-bound factual question while the independent 6% ratio is available and missing hours remains blocked');
  phase='parallel-replay';const repeats=await Promise.all([calculate(firstLease.job),calculate(firstLease.job,peer)]);
  expect(repeats.every(r=>r.report?.report_sha256===first.report!.report_sha256)).toBe(true);expect(await counts()).toEqual({analyses:1,targets:1,provider_invocations:0});
  checks.push('parallel authenticated worker replay returns the same persisted report and does not duplicate the analysis or its question');
  phase='foreign-and-unidentified';await expect(answerCaseRequest({caseId,requestId:request.id,identityId:foreignIdentity,answer:'10'},webDb)).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  await expect(web.query('select * from public.case_request_answer($1,$2,$3)',[request.id,caseId,'10'])).rejects.toThrow('REVIEW_REQUEST_FORBIDDEN');
  await expect(web.query('select public.case_report_customer_snapshot($1,$2)',[caseId,foreignIdentity])).rejects.toThrow('REPORT_FORBIDDEN');
  checks.push('actual foreign identity and unidentified legacy answer RPC are refused; foreign report access is refused');
  phase='answer-and-new-source';await Promise.all([webDb,peerWebDb].map(db=>answerCaseRequest({caseId,requestId:request.id,identityId:identity,answer:'10'},db)));
  const answeredHead=await head();expect(answeredHead.revision).toBeGreaterThan(firstLease.job.revision);await answerCaseRequest({caseId,requestId:request.id,identityId:identity,answer:'10'},webDb);expect(await head()).toEqual(answeredHead);
  await expect(calculate(firstLease.job)).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
  const secondLease=await claim();expect(secondLease.jobId).not.toBe(firstLease.jobId);const second=await calculate(secondLease.job),secondReview=saveArtifacts('provided-ten-hours',second);await finish(secondLease);
  expect(secondReview.checks[1].calculation.difference).toEqual({kind:'money',currency:'ILS',minor_units:ORACLE.firstDifferenceMinor});
  expect(compareDocumentReviewDependencies(firstReview,secondReview)).toMatchObject({unchanged:['pension.ratio'],changed:['hours.product']});
  expect(secondReview.input.answer_history[0].receipt).toMatchObject({request_id:request.id,identity_id:identity,answer_revision:1,state:'provided',value:10});
  checks.push('concurrent identified answer plus retry writes one revision; existing queue creates new source job/run; only dependent hours arithmetic changes to a 100.00 ILS accounting difference');
  phase='unknown-correction';await editCaseRequest({caseId,requestId:request.id,identityId:identity,answer:'לא יודע',expectedRevision:1,kind:'correction'},webDb);
  const unknownLease=await claim(),unknown=await calculate(unknownLease.job),unknownReview=saveArtifacts('unknown-correction',unknown);await finish(unknownLease);
  expect(unknownReview.checks[1].calculation.state).toBe('blocked');expect(unknownReview.checks[1].calculation.difference).toBeNull();
  expect(unknownReview.checks[0].dependency_sha256).toBe(firstReview.checks[0].dependency_sha256);
  phase='provided-correction';await editCaseRequest({caseId,requestId:request.id,identityId:identity,answer:'11',expectedRevision:2,kind:'correction'},webDb);
  const thirdLease=await claim(),third=await calculate(thirdLease.job),thirdReview=saveArtifacts('corrected-eleven-hours',third);await finish(thirdLease);
  expect(thirdReview.checks[1].calculation.difference).toEqual({kind:'money',currency:'ILS',minor_units:ORACLE.correctedDifferenceMinor});
  expect(thirdReview.input.answer_history.map(h=>h.receipt.state)).toEqual(['provided','unknown','provided']);
  const history=(await owner.query('select revision,identity_id,answer_text from private.case_request_answer_versions where request_id=$1 order by revision',[request.id])).rows;
  expect(history.map(r=>r.answer_text)).toEqual(['10','לא יודע','11']);answerHistory.push(...history);
  expect((await owner.query('select answer_text from public.case_requests where id=$1',[request.id])).rows[0].answer_text).toBe('10');
  checks.push('append-only corrections preserve the first answer, unknown clears the dependent amount, and later provided hours produce a new 150.00 ILS accounting result without changing the independent ratio');
  phase='new-connection-restart';restarted=client('TIVDOC_WORKER_POSTGRES_URL');await restarted.connect();
  const restart=await calculate(thirdLease.job,restarted);expect(restart.report?.report_sha256).toBe(third.report!.report_sha256);
  expect(await counts()).toEqual({analyses:4,targets:1,provider_invocations:0});
  checks.push('a new authenticated worker connection replays the exact stored report; four historical runs, one question, zero provider invocations');
  phase='rollback-source-and-entitlement-fences';await owner.query('begin');
  await owner.query('update public.documents set version_id=$2,content_sha256=$3 where case_id=$1 and id=$4',[caseId,randomUUID(),'f'.repeat(64),documentId]);
  expect((await owner.query('select private.document_review_request_current($1,$2) value',[caseId,request.id])).rows[0].value).toBe(false);await owner.query('rollback');
  await owner.query('begin');await owner.query("update private.order_entitlements set state='suspended' where order_id=$1",[orderId]);
  expect((await owner.query('select private.document_review_request_current($1,$2) value',[caseId,request.id])).rows[0].value).toBe(false);await owner.query('rollback');
  expect((await listCaseRequests(caseId,webDb,identity)).find(r=>r.id===request.id)).toMatchObject({source_current:true,answer_revision:3,answer_text:'11'});
  checks.push('actual SQL currentness refuses a replaced source and suspended entitlement inside rolled-back owned-fixture mutations; historical report bytes are unchanged');
  const customer=(await web.query('select public.case_report_customer_snapshot($1,$2) value',[caseId,identity])).rows[0].value;expect(customer.reports).toEqual([]);
  expect((await owner.query('select count(*)::int n from public.case_notifications where case_id=$1',[caseId])).rows[0].n).toBe(0);
  checks.push('ordinary artifacts remain private drafts; no customer report publication or notification was created');
 }catch(error){failure=safeError(error);throw error;}
 finally{
  for(const db of [owner,worker,peer,web,webPeer,restarted].filter((c):c is pg.Client=>!!c))await db.query('rollback').catch(()=>{});
  try{if(seeded){await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[tenant]);
   if(jobs.length)await owner.query("update public.engine_durable_jobs set state='cancelled',cancellation_requested=true,lease_owner=null,lease_expires_at=null,revision=revision+1 where tenant_id=$1 and canonical_case_id=$2 and job_id=any($3::text[]) and state in ('queued','leased','running','retry_wait')",[tenant,caseId,jobs]);
   const revoked=await owner.query('update public.product_identity_sessions set revoked_at=coalesce(revoked_at,now()) where tenant_id=$1 and sid=$2 returning sid',[tenant,sid]);expect(revoked.rowCount).toBe(1);await owner.query('commit');machineRevoked=true;}}
  catch(error){cleanupFailure=safeError(error);await owner.query('rollback').catch(()=>{});}
  writeFileSync(directory+'/proof.json',JSON.stringify({verdict:failure===null&&cleanupFailure===null&&checks.length===10?'PASS':'FAIL',gitSha,dirty,database:'tivdoc_release_replay_20260907',schema:159,migration,migration_sha256:sha(readFileSync('supabase/migrations/'+migration)),caseId,checks,artifacts,answerHistory,
   fixture:'synthetic source metadata and local source bytes; curated automated known-fixture readings; real worker/web principals and provisioned synthetic identities',
   providerCalls:0,liveOcr:false,remoteStorageUploadReproved:false,browserVerified:false,customerSessionsCreated:false,customerPublication:false,notificationsSent:false,productionChanged:false,
   retainedOwnedQaCases:seeded?2:0,machineRevoked,failure,cleanupFailure},null,2)+'\n');own();
  await Promise.allSettled([owner,worker,peer,web,webPeer,restarted].filter((c):c is pg.Client=>!!c).map(c=>c.end()));
  if(cleanupFailure&&!failure)throw Error('DOCUMENT_REVIEW_PROOF_CLEANUP_FAILED');
 }
},240000);
