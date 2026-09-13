import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {attachDocumentReviewCoverage} from '@/engine/document-review/coverage';
import {attachNonPayslipInventory} from '@/engine/document-review/non-payslip';
import {attachAutomaticNonPayslipEvidence} from '@/engine/entitlement-review/automatic-nonpay';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {NodePostgresManagedClient} from '@/server/platform/persistence/postgres/runtime/node-pg-driver';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {seedSourceKindFixture,revokeSourceKindFixture} from './fixtures/source-kind-postgres';
import {sourceJobSchema,type SourceJob} from './source-dispatch';
import {savedLegacySourceIntake,legacySourceIntakeRequests} from './saved-legacy-source-intake';
import {SavedCaseSnapshot,SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import {saveExtractionCheckpoint} from './extraction-checkpoint';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {payslipMachineExtractionSha256} from '@/engine/extraction/reading-resolution';
import {documentSourceTranscriptionTarget,documentSourceTranscriptionQuestion} from '../reports/document-source-transcription';
import {readSavedOrders,savedOrderOrigin,savedOrderReceiptSha256} from './saved-order-scope';
import {attachSavedDocumentSourceTranscriptions,openSavedDocumentSourceTranscriptionRequests} from './saved-document-source-transcription';
import {claimSavedDraftJob} from './saved-job-runtime';
import {ensureSavedSourcePhysicalPages} from './saved-source-physical-pages';
vi.mock('server-only',()=>({}));

/** Opt-in, actual named PG statements and web/worker login roles. Only new
 * synthetic audit rows; no external storage/provider, migration, or reports. */
it.skipIf(process.env.TIVDOC_SOURCE_TRANSCRIPTION_DB_PROOF!=='1')('captures identified contract and missing grand-total readings with actual source-role fences',async()=>{
 if(process.env.VERCEL||process.env.VERCEL_ENV||process.env.NODE_ENV!=='test')throw Error('SOURCE_TRANSCRIPTION_DB_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);if(u.hostname!=='aws-0-eu-central-1.pooler.supabase.com'||u.pathname!=='/tivdoc_release_replay_20260907'||!u.username.endsWith('.cpzrbidxftzqcfeqqusu'))throw Error('EXACT_ISOLATED_DEV_REQUIRED');
  u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const runId=randomUUID(),head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),checks:string[]=[],names=new Set<string>(),cleanup:unknown[]=[];
 const workingTreeDirty=execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8',windowsHide:true}).trim().length>0;
 const sourceFiles=['src/server/product/processing/saved-source-physical-pages.ts','src/server/product/processing/saved-source-physical-pages.test.ts',
  'src/server/product/processing/saved-document-source-transcription.postgres.test.ts','src/server/product/processing/saved-admission.ts',
  'src/server/product/processing/saved-document-source-transcription.ts','src/engine/document-review/coverage.ts',
  'src/server/platform/persistence/postgres/runtime/node-pg-driver.ts',
  'supabase/migrations/20260914021000_contract_physical_effective_legacy_period.sql',
  'supabase/migrations/20260914023000_grand_total_source_transcription.sql',
  'supabase/migrations/20260914024000_grand_total_answer_validation.sql',
  'src/server/product/reports/document-source-transcription.ts','src/server/product/processing/saved-field-readings.ts',
  'src/engine/extraction/deduction-source-scope.ts'];
 const sourcePins=()=>sourceFiles.map(path=>({path,utf8_lf_sha256:createHash('sha256').update(readFileSync(path,'utf8').replace(/\r\n/g,'\n'),'utf8').digest('hex')}));
 const testedSourceFiles=sourcePins();
 const printed='SYNTHETIC ONLY - June 2026 contract. An award is discretionary; no fixed payment is promised.';
 let fixture:Awaited<ReturnType<typeof seedSourceKindFixture>>|undefined,primary:unknown,passed=false,revoked=false,lastStatement='';
 const physicalJobIds:string[]=[];
 let localSourceReads=0,physicalAdmissions=0,proofStage='connect';
 const stagedEvidence:Record<string,unknown>[]=[];
 const rawRowTypes:Record<string,Record<string,string>>={};
 async function tx<T>(db:pg.Client,fn:(context:PostgresTransactionContext)=>Promise<T>,commit=false){
  // Reuse the production named-query/Date normalization adapter. This fixture
  // owns raw Client lifetime; the adapter's release hook closes only its scope.
  const managed=new NodePostgresManagedClient({async query(q){const r=await db.query({name:q.name,text:q.text,values:[...q.values]});
   if(q.name==='intake_case_insert'||q.name==='intake_case_update')rawRowTypes[q.name]=Object.fromEntries(Object.entries(r.rows[0]??{}).map(([key,value])=>[key,value instanceof Date?'Date':value===null?'null':typeof value]));
   return {rowCount:r.rowCount,rows:r.rows};},release(){}},{query(){},release(){}});
  await db.query('begin');try{
   await db.query("set local lock_timeout='5s'");
   if(db===worker){await db.query('select * from private.runtime_context_install($1,$2,$3)',[fixture!.sid,fixture!.jti,`source-transcription-proof:${runId}`]);await db.query("select set_config('tivdoc.engine_git_sha',$1,true)",[head]);}
   const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(q){names.add(q.name);lastStatement=q.name;if(q.name==='source_contract_physical_pending')physicalAdmissions++;return managed.query(q);}}};
   const value=await fn(context);await db.query(commit?'commit':'rollback');return value;
  }catch(error){await db.query('rollback').catch(e=>cleanup.push(e));throw error;}finally{managed.release();}
 }
 const current=async():Promise<SourceJob>=>sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:fixture!.caseId,mode:'draft',...(await owner.query("select h.revision,h.input_sha256,d.processing_profile,d.authority_dependency_sha256 from private.case_input_heads h join private.case_analysis_dispatch d on d.case_id=h.case_id and d.revision=h.revision and d.mode='draft' where h.case_id=$1",[fixture!.caseId])).rows[0]});
 try{
  await Promise.all([owner.connect(),worker.connect(),web.connect()]);
  for(const [db,role] of [[owner,'tivdoc_dev_migrator'],[worker,'tivdoc_worker_runtime'],[web,'tivdoc_web_runtime']] as const)expect((await db.query('select current_database() database,session_user role')).rows[0]).toEqual({database:'tivdoc_release_replay_20260907',role});
  proofStage='seed_synthetic_fixture';fixture=await seedSourceKindFixture(owner,'contract',printed,7);const f=fixture;
  const purchaseReceiptSql='select scope::text scope_bytes,receipt_sha256 from private.legacy_paid_scope_admissions where payment_id=$1 and case_id=$2';
  const originalPurchaseReceipt=(await owner.query(purchaseReceiptSql,[f.paymentId,f.caseId])).rows[0];expect(originalPurchaseReceipt).toBeDefined();
  expect(f.scope.period_state).toBe('missing');expect(f.scope.periods).toEqual([]);
  // A contract period cannot establish an executable financial month. Keep the
  // original periods=[] receipt and identify a separate synthetic attendance
  // source through the same ordinary web route, without any extraction output.
  const attendanceId=randomUUID(),attendanceVersion=randomUUID(),attendancePdf=await PDFDocument.create();
  const attendanceLabel='SYNTHETIC ONLY - Attendance 2026-06-01 through 2026-06-30';attendancePdf.addPage().drawText(attendanceLabel,{size:9});
  const attendanceBytes=await attendancePdf.save(),attendanceHash=createHash('sha256').update(attendanceBytes).digest('hex');
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'attendance','attendance',$4,'SYNTHETIC-TRANSCRIPTION-ATTENDANCE.pdf','application/pdf',$5,$6,null)",
   [attendanceId,f.caseId,attendanceVersion,`cases/${f.caseId}/versions/${attendanceVersion}.pdf`,attendanceBytes.length,attendanceHash]);
  await tx(worker,async()=>worker.query('select private.document_physical_pages_record($1,$2,$3,$4,$5,$6,7)',[f.caseId,f.documentId,f.versionId,f.hash,f.size,'application/pdf']),true);
  await tx(worker,async()=>worker.query('select private.document_physical_pages_record($1,$2,$3,$4,$5,$6,1)',[f.caseId,attendanceId,attendanceVersion,attendanceHash,attendanceBytes.length,'application/pdf']),true);
  const first=await current(),period={from:'2026-06-01',to:'2026-06-30'};
  const openPeriod=async(versionId:string)=>tx(worker,async()=>{const c=(await worker.query('select private.legacy_source_intake_context($1,$2,$3) context',[f.caseId,first.revision,first.input_sha256])).rows[0].context;
   const q=legacySourceIntakeRequests(savedLegacySourceIntake(c)).find(r=>r.kind==='document_field'&&r.target.version_id===versionId);if(!q)throw Error('PERIOD_REQUEST_REQUIRED');
   return (await worker.query('select private.document_field_request_open($1,$2,$3,$4,$5) id',[f.caseId,first.revision,first.input_sha256,q.target,q.question.question])).rows[0].id as string;},true);
  const periodRequest=await openPeriod(f.versionId),attendanceRequest=await openPeriod(attendanceVersion);
  const identify=async(id:string,answer:string,identity=f.identityId)=>tx(web,async()=>web.query({name:'source_transcription_proof_identify',text:'select * from public.case_request_answer_identified($1,$2,$3,$4)',values:[id,f.caseId,identity,answer]}),true);
  const edit=async(id:string,answer:string,revision:number)=>tx(web,async()=>web.query({name:'source_transcription_proof_edit',text:"select public.case_request_edit($1,$2,$3,$4,$5,'correction')",values:[f.caseId,id,f.identityId,answer,revision]}),true);
  const paidPeriodEvidence=async()=>{
   const result=await owner.query(`select h.revision,jsonb_array_length(o->'periods') raw_period_count,
    private.legacy_source_period_evidence(h.case_id,o)->'periods' effective_periods,
    private.document_review_paid_scope_current(h.case_id,(o->>'id')::uuid,'legacy_paid_receipt',o->>'receipt_sha256',o->'topics',date '2026-06-01') paid_june_current
    from private.case_input_heads h join private.case_input_versions v on v.case_id=h.case_id and v.revision=h.revision and v.input_sha256=h.input_sha256
    cross join lateral jsonb_array_elements(v.input->'legacy_orders') o where h.case_id=$1`,[f.caseId]);
   expect(result.rows).toHaveLength(1);stagedEvidence.push({stage:proofStage,...result.rows[0]});return result.rows[0];
  };
  const noContractDiscovery=async()=>{
   const job=await current();
   // An actual scoped claim and RPC, rolled back together. There is no queued
   // execution and no retained lease from either negative admission probe.
   await tx(worker,async c=>{
    const denied=await claimSavedDraftJob(c,{caseId:f.caseId,workerId:'synthetic.saved.worker',leaseMs:300000});
    if(denied.state!=='claimed')throw Error('SOURCE_PHYSICAL_NEGATIVE_EXPECTED_CLAIM');
    const result=await worker.query({name:'source_transcription_physical_proof_pending',
     text:'select private.contract_transcription_physical_pages_pending($1::uuid,$2,$3,$4,$5,$6) value',
     values:[f.caseId,job.revision,job.input_sha256,denied.jobId,'synthetic.saved.worker',denied.fencingToken]});
    stagedEvidence.push({stage:proofStage,source_revision:job.revision,pending:result.rows[0].value});expect(result.rows[0].value).toEqual([]);
   });
  };
  const periodAnswer=JSON.stringify({v:1,action:'correct',value:{document_kind:'contract',period,page:3,source_label:'SYNTHETIC ONLY - June 2026 contract'}});await identify(periodRequest,periodAnswer);
  proofStage='contract_only_period_negative';
  expect(await paidPeriodEvidence()).toMatchObject({raw_period_count:0,effective_periods:[],paid_june_current:false});
  await noContractDiscovery();checks.push('contract-only identified period supplies no effective financial month or paid physical discovery; actual worker claim/RPC rolled back');
  const attendanceAnswer=JSON.stringify({v:1,action:'correct',value:{document_kind:'attendance',period,page:1,source_label:attendanceLabel}});
  await identify(attendanceRequest,attendanceAnswer);
  proofStage='identified_attendance_full_month';
  const financialPeriod=await paidPeriodEvidence();expect(financialPeriod).toMatchObject({raw_period_count:0,paid_june_current:true});
  expect(financialPeriod.effective_periods).toHaveLength(1);expect(financialPeriod.effective_periods[0]).toMatchObject({period,source_document_kind:'attendance'});
  expect(f.scope.periods).toEqual([]);
  checks.push('separate synthetic attendance source has an actual web full-month period answer; original purchase periods remain empty; contract alone supplies no financial month');
  async function replay(){const job=await current();return tx(worker,async c=>{
   const snapshot=await new SavedCaseSnapshot(c,job,'2026-06',undefined,undefined,true).read(),order=(await readSavedOrders(c,job))[0];
   const base=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:f.caseId,period,
    purchased_scope:{order_id:order.id,origin:savedOrderOrigin(order),receipt_sha256:savedOrderReceiptSha256(order),topics:[...order.topics]},
    documents:[{case_id:f.caseId,document_id:f.versionId,version_id:f.versionId,file_sha256:f.hash,page_count:7,kind:'contract',label:'Synthetic contract source',period:null,reading_origin:'source_inventory',reading_sha256:f.hash}],checks:[],coverage_gaps:[],
    completion_input:{case_id:f.caseId,period,documents:[],evidence:[],needs:[]}});
   // Ordinary coverage preserves the original empty-period purchase receipt;
   // the independently identified attendance month never rewrites that receipt.
   const covered=attachDocumentReviewCoverage(base,{schema_version:'document-review-purchase-period-v1',
    receipt_sha256:savedOrderReceiptSha256(order),state:'missing',periods:[]});
   const review=attachSavedDocumentSourceTranscriptions(attachNonPayslipInventory(covered,snapshot),snapshot);
   return {job,snapshot,review,composed:attachAutomaticNonPayslipEvidence(review,snapshot).input};
  });}
  proofStage='ordinary_transcription';const initial=await replay(),reviewBefore=canonicalSha256(initial.review);
  expect(initial.review.purchased_scope.purchase_period_evidence).toEqual({schema_version:'document-review-purchase-period-v1',
   receipt_sha256:f.scope.receipt_sha256,state:'missing',periods:[]});
  const opened=await tx(worker,c=>openSavedDocumentSourceTranscriptionRequests(c,initial.job,'2026-06',initial.review),true);
  expect(opened).toHaveLength(1);
  const requestId=opened[0].requestId;
  const targetReceiptSql='select target,target::text target_bytes from private.document_field_targets where request_id=$1';
  const originalTarget=(await owner.query(targetReceiptSql,[requestId])).rows[0],target=originalTarget.target;
  expect(await tx(worker,c=>openSavedDocumentSourceTranscriptionRequests(c,initial.job,'2026-06',initial.review))).toEqual(opened);
  expect((await owner.query(targetReceiptSql,[requestId])).rows[0]).toEqual(originalTarget);
  expect(canonicalSha256(initial.review)).toBe(reviewBefore);
  expect((await owner.query(purchaseReceiptSql,[f.paymentId,f.caseId])).rows[0]).toEqual(originalPurchaseReceipt);
  stagedEvidence.push({stage:proofStage,purchase_period_evidence_state:'missing',purchase_receipt_bytes_sha256:createHash('sha256').update(originalPurchaseReceipt.scope_bytes,'utf8').digest('hex'),
   target_bytes_sha256:createHash('sha256').update(originalTarget.target_bytes,'utf8').digest('hex'),review_unchanged_after_open_retry:true});
  expect(target).toMatchObject({schema_version:'document-evidence-source-transcription-v2',page:null,page_count:7});
  expect((await owner.query("select count(*)::integer n from private.document_field_targets where case_id=$1 and target->>'schema_version'='document-evidence-source-transcription-v2'",[f.caseId])).rows[0].n).toBe(1);
  expect(target.reading_dependencies).toHaveLength(1);expect(target.reading_dependencies[0].request_id).toBe(periodRequest);
  expect(target.reading_dependencies[0].answer_sha256).toBe(canonicalSha256(periodAnswer));
  const graft={...target,reading_dependencies:[]};delete graft.target_sha256;graft.target_sha256=canonicalSha256(graft);
  await expect(tx(worker,async()=>worker.query('select private.document_field_request_open($1,$2,$3,$4,$5)',[f.caseId,initial.job.revision,initial.job.input_sha256,graft,'Synthetic forged dependencies']))).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');
  const source=async(identity=f.identityId)=>tx(web,async()=> (await web.query('select public.case_request_document_source($1,$2,$3) value',[f.caseId,identity,requestId])).rows[0].value);
  expect(await source()).toMatchObject({version:f.versionId,sha256:f.hash,page:1});await expect(source(randomUUID())).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  const correct=JSON.stringify({schema_version:'document-evidence-source-answer-v2',action:'correct',value:{page:3,raw_value:printed,locator:'Synthetic complete first paragraph'}});
  await expect(identify(requestId,JSON.stringify({schema_version:'document-evidence-source-answer-v2',action:'correct',value:{page:8,raw_value:printed,locator:'Invalid physical page'}}))).rejects.toThrow('REQUEST_ANSWER_INVALID');
  await expect(identify(requestId,correct,randomUUID())).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');await identify(requestId,correct);
  const positive=await replay();expect(positive.snapshot.document_source_transcriptions).toHaveLength(1);expect(positive.snapshot.non_payslip_evidence?.find(e=>e.document.document_id===f.versionId)?.extraction).toBeNull();
  expect(positive.snapshot.document_source_transcriptions?.[0]).toMatchObject({identity_id:f.identityId,answer_revision:1,value:{page:3,text:printed},origin:'identified_document_transcription'});
  expect(positive.composed.entitlement_evidence?.obligations).toBeUndefined();expect(positive.composed.coverage_gaps.some(g=>g.check_id.startsWith('entitlement.transcribed.clause.')&&g.kind==='missing_rule')).toBe(true);
  const original=(await owner.query('select answer_text from private.case_request_answer_versions where request_id=$1 and revision=1',[requestId])).rows[0];
  await edit(requestId,JSON.stringify({schema_version:'document-evidence-source-answer-v2',action:'unknown'}),1);expect((await replay()).snapshot.document_source_transcriptions?.[0]).toMatchObject({state:'unknown',value:null});
  await edit(requestId,correct,2);expect((await replay()).snapshot.document_source_transcriptions?.[0].answer_revision).toBe(3);
  const currentStates=await tx(web,async()=> (await web.query('select * from public.case_request_field_states($1,$2)',[f.caseId,f.identityId])).rows);expect(currentStates.find(s=>s.request_id===requestId)?.source_current).toBe(true);
  checks.push('actual named worker queries open/retry; grafted dependencies and foreign web identities denied; web answer/edit become separate snapshot receipts; no contract checkpoint or obligation fabricated');
  const changedPeriod=JSON.stringify({v:1,action:'correct',value:{document_kind:'contract',period,page:3,source_label:'SYNTHETIC ONLY - June 2026 contract, reread'}});await edit(periodRequest,changedPeriod,1);
  const staleStates=await tx(web,async()=> (await web.query('select * from public.case_request_field_states($1,$2)',[f.caseId,f.identityId])).rows);expect(staleStates.find(s=>s.request_id===requestId)?.source_current).toBe(false);
  expect(await source()).toBeNull();await expect(edit(requestId,correct,3)).rejects.toThrow(/REQUEST_ANSWER_INVALID|REQUEST_FIELD_SOURCE_CHANGED/);
  const stale=await replay();expect(stale.snapshot.document_source_transcriptions??[]).toEqual([]);
  await expect(tx(worker,c=>new SavedCaseSnapshot(c,positive.job,'2026-06',undefined,undefined,true).read())).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
  expect((await owner.query('select answer_text from private.case_request_answer_versions where request_id=$1 and revision=1',[requestId])).rows[0]).toEqual(original);
  expect((await owner.query('select content_sha256 from public.documents where id=$1',[f.documentId])).rows[0].content_sha256).toBe(f.hash);
  expect((await owner.query('select count(*)::integer n from private.case_extraction_checkpoints where case_id=$1',[f.caseId])).rows[0].n).toBe(0);
  checks.push('new source-period answer stales field state/source URL/old edit/worker replay; original answer and source hash preserved; zero extraction checkpoints');
  // Exercise SQL211 as the actual authenticated worker, before any analysis
  // execution. A contract has one permitted slot. Preserve the existing version
  // using the same archive/CAS pattern as upload_commit, then replace only this
  // synthetic fixture's current version. This does not prove the upload flow.
  proofStage='replace_synthetic_contract_version';
  const physicalId=f.documentId,physicalVersion=randomUUID(),physicalPdf=await PDFDocument.create();
  for(let page=1;page<=4;page++)physicalPdf.addPage().drawText(`SYNTHETIC ONLY - physical contract page ${page}`,{size:9});
  const physicalBytes=await physicalPdf.save(),physicalHash=createHash('sha256').update(physicalBytes).digest('hex');
  const physicalPath=`cases/${f.caseId}/versions/${physicalVersion}.pdf`;
  await owner.query('begin');try{
   const prior=await owner.query("select d.id from public.documents d join public.cases c on c.id=d.case_id where d.id=$1 and d.case_id=$2 and d.version_id=$3 and d.content_sha256=$4 and d.document_type='contract' and d.slot='contract' and c.is_qa and c.first_name='Synthetic source kind SQL proof' for update of d",
    [physicalId,f.caseId,f.versionId,f.hash]);expect(prior.rowCount).toBe(1);
   const archived=await owner.query('insert into public.document_versions(version_id,document_id,case_id,storage_path,original_filename,mime_type,size,period_month) select version_id,id,case_id,storage_path,original_filename,mime_type,size,period_month from public.documents where id=$1 and case_id=$2 and version_id=$3 and content_sha256=$4 returning version_id',
    [physicalId,f.caseId,f.versionId,f.hash]);expect(archived.rows).toEqual([{version_id:f.versionId}]);
   const replaced=await owner.query("update public.documents set version_id=$5,storage_path=$6,original_filename='SYNTHETIC-PHYSICAL-CONTRACT.pdf',mime_type='application/pdf',size=$7,content_sha256=$8,period_month='2026-06-01',processing_status='uploaded',detected_type=null,classification_confidence=null,period_start=null,period_end=null where id=$1 and case_id=$2 and version_id=$3 and content_sha256=$4 returning version_id",
    [physicalId,f.caseId,f.versionId,f.hash,physicalVersion,physicalPath,physicalBytes.length,physicalHash]);expect(replaced.rows).toEqual([{version_id:physicalVersion}]);
   await owner.query('commit');
  }catch(error){await owner.query('rollback');throw error;}
  expect((await owner.query('select version_id,source_sha256,page_count from private.document_physical_page_receipts where case_id=$1 and document_id=$2',
   [f.caseId,physicalId])).rows).toEqual([{version_id:f.versionId,source_sha256:f.hash,page_count:7}]);
  stagedEvidence.push({stage:proofStage,document_id:physicalId,archived_version_id:f.versionId,current_version_id:physicalVersion,source_sha256:physicalHash});
  // Removing the only financial source reading must deny discovery even though
  // this current contract really has no physical receipt. Restore through the
  // ordinary identified edit route; retain both original and unknown answers.
  proofStage='absent_financial_period_negative';
  await edit(attendanceRequest,JSON.stringify({v:1,action:'unknown'}),1);
  expect(await paidPeriodEvidence()).toMatchObject({raw_period_count:0,effective_periods:[],paid_june_current:false});
  await noContractDiscovery();
  expect((await owner.query('select count(*)::integer n from private.document_physical_page_receipts where case_id=$1 and document_id=$2 and version_id=$3',
   [f.caseId,physicalId,physicalVersion])).rows[0].n).toBe(0);
  await edit(attendanceRequest,attendanceAnswer,2);
  proofStage='restored_attendance_full_month';
  const restored=await paidPeriodEvidence();expect(restored).toMatchObject({raw_period_count:0,paid_june_current:true});
  expect(restored.effective_periods).toHaveLength(1);expect(restored.effective_periods[0]).toMatchObject({period,source_document_kind:'attendance'});
  checks.push('unknown financial source period denies discovery of physically uninspected contract; restored authenticated attendance full month re-enables eligibility without altering original receipt');
  const physicalJob=await current(),workerId='synthetic.saved.worker';
  expect(physicalJob.processing_profile).toBe('qualified_ai_v1');
  const lease=await tx(worker,c=>claimSavedDraftJob(c,{caseId:f.caseId,workerId,leaseMs:300000}),true);
  if(lease.state!=='claimed')throw Error('SOURCE_PHYSICAL_PROOF_EXPECTED_CLAIM');physicalJobIds.push(lease.jobId);
  await expect(tx(worker,async()=>worker.query('select private.runtime_verified_actor()'))).rejects.toMatchObject({code:'42501'});
  const pending=(actor=workerId,fence=lease.fencingToken)=>tx(worker,async()=>worker.query({name:'source_transcription_physical_proof_pending',
   text:'select private.contract_transcription_physical_pages_pending($1::uuid,$2,$3,$4,$5,$6) value',
   values:[f.caseId,physicalJob.revision,physicalJob.input_sha256,lease.jobId,actor,fence]}));
  proofStage='exact_current_physical_pending';const actualPending=(await pending()).rows[0].value;
  stagedEvidence.push({stage:proofStage,source_revision:physicalJob.revision,job_id:lease.jobId,pending:actualPending});
  expect(actualPending).toEqual([{document_id:physicalId,version_id:physicalVersion,source_sha256:physicalHash,
   byte_size:physicalBytes.length,mime_type:'application/pdf',storage_path:physicalPath}]);
  await expect(pending('synthetic.foreign.worker')).rejects.toThrow('SOURCE_INTAKE_FORBIDDEN');
  await expect(pending(workerId,lease.fencingToken+1)).rejects.toThrow('SAVED_JOB_FENCE');
  proofStage='physical_facade';const beforeAdmissions=physicalAdmissions;
  expect(await ensureSavedSourcePhysicalPages({job:physicalJob,jobId:lease.jobId,workerId,fencingToken:lease.fencingToken,
   purpose:'contract_transcription',transactions:operation=>tx(worker,operation,true),storage:{async download(path){
    expect(path).toBe(physicalPath);localSourceReads++;return {data:new Blob([Uint8Array.from(physicalBytes)]),error:null};
   }}})).toEqual({recorded:1,unreadableVersions:[]});
  expect(physicalAdmissions-beforeAdmissions).toBe(3);expect(localSourceReads).toBe(1);
  expect((await owner.query('select page_count from private.document_physical_page_receipts where case_id=$1 and document_id=$2 and version_id=$3 and source_sha256=$4',
   [f.caseId,physicalId,physicalVersion,physicalHash])).rows).toEqual([{page_count:4}]);
  expect((await pending()).rows[0].value).toEqual([]);
  expect((await owner.query('select answer_text from private.case_request_answer_versions where request_id=$1 and revision=1',[requestId])).rows[0]).toEqual(original);
  expect((await owner.query('select version_id from public.document_versions where case_id=$1 and document_id=$2 and version_id=$3',[f.caseId,physicalId,f.versionId])).rows).toEqual([{version_id:f.versionId}]);
  expect((await owner.query(purchaseReceiptSql,[f.paymentId,f.caseId])).rows[0]).toEqual(originalPurchaseReceipt);
  expect(sourcePins()).toEqual(testedSourceFiles);
  checks.push('actual worker LOGIN cannot execute private actor helper (42501); SQL211 pending allows exact actor/job/fence and denies foreign actor/fence; physical facade rechecks scoped RPC before and after local synthetic PDF read and records four actual pages without provider or external Storage');
  // Separate synthetic payslip source; keep the original contract, attendance,
  // purchase receipt and all historical answers. No real extraction is edited.
  proofStage='grand_total_synthetic_source';
  const totalDocument=randomUUID(),totalVersion=randomUUID(),totalPdf=await PDFDocument.create();
  totalPdf.addPage().drawText('SYNTHETIC ONLY - June 2026. Mandatory deductions 120.00; Total deductions 160.00.',{size:9});
  const totalBytes=await totalPdf.save(),totalHash=createHash('sha256').update(totalBytes).digest('hex'),totalPath=`cases/${f.caseId}/versions/${totalVersion}.pdf`;
  await owner.query("insert into public.documents(id,case_id,version_id,document_type,slot,storage_path,original_filename,mime_type,size,content_sha256,period_month) values($1,$2,$3,'payslip','payslip-01',$4,'SYNTHETIC-GRAND-TOTAL.pdf','application/pdf',$5,$6,'2026-06-01')",
   [totalDocument,f.caseId,totalVersion,totalPath,totalBytes.length,totalHash]);
  await owner.query('select private.capture_case_input($1,$2)',[f.caseId,'synthetic_grand_total_physical_fixture']);
  const totalJob=await current(),totalLease=await tx(worker,c=>claimSavedDraftJob(c,{caseId:f.caseId,workerId,leaseMs:300000}),true);
  if(totalLease.state!=='claimed')throw Error('GRAND_TOTAL_EXPECTED_CLAIM');physicalJobIds.push(totalLease.jobId);
  const seed=buildSyntheticCaseFixture({fixture_id:`synthetic-grand-total-${runId}`,mode:'real'}).stored.extractions[0];
  const fieldSource={document_id:totalVersion,page:1},subtotalId=randomUUID();
  const machine=normalizedPayslipExtractionSchema.parse({...seed,document_id:totalVersion,quality_metrics:{...seed.quality_metrics,page_count:1},additional_components:[],
   fields:[{candidate_id:randomUUID(),field:'salary_period',raw_value:'June 2026',normalized_value:{year:2026,month:6,start_date:period.from,end_date:period.to},confidence:.99,
    source:{...fieldSource,text_fragment:'SYNTHETIC ONLY - June 2026'},extraction_method:'fixture',warning_flags:[]},
   {candidate_id:subtotalId,field:'total_deductions',raw_value:'120.00',normalized_value:{currency:'ILS',minor_units:12000},confidence:.94,
    source:{...fieldSource,text_fragment:'mandatory deductions: 120.00'},extraction_method:'fixture',warning_flags:[]}]});
  const totalResult={final_extraction:machine,first_pass:{normalized_extraction:structuredClone(machine)}};
  const totalCheckpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:f.caseId,product_document_id:totalDocument,version_id:totalVersion,input_sha256:totalHash,
   expected_month:'2026-06',period_mismatch:false,requires_confirmation:false,result_sha256:canonicalSha256(totalResult),run:{result:totalResult}} as Parameters<typeof saveExtractionCheckpoint>[2];
  const totalPending=()=>tx(worker,async()=> (await worker.query({name:'source_transcription_physical_proof_pending',
   text:'select private.contract_transcription_physical_pages_pending($1::uuid,$2,$3,$4,$5,$6) value',
   values:[f.caseId,totalJob.revision,totalJob.input_sha256,totalLease.jobId,workerId,totalLease.fencingToken]})).rows[0].value);
  // A genuine total in either pass must suppress physical discovery for this
  // purpose. This counterexample transaction rolls back its checkpoint.
  proofStage='grand_total_present_negative';
  await tx(worker,async c=>{
   const grand={...machine.fields[1],candidate_id:randomUUID(),source:{...fieldSource,text_fragment:'total deductions: 120.00'}};
   const result={...totalResult,first_pass:{normalized_extraction:{...machine,fields:[...machine.fields,grand]}}};
   await saveExtractionCheckpoint(c,totalJob,{...totalCheckpoint,result_sha256:canonicalSha256(result),run:{result}} as Parameters<typeof saveExtractionCheckpoint>[2]);
   expect((await worker.query('select private.contract_transcription_physical_pages_pending($1::uuid,$2,$3,$4,$5,$6) value',
    [f.caseId,totalJob.revision,totalJob.input_sha256,totalLease.jobId,workerId,totalLease.fencingToken])).rows[0].value).toEqual([]);
  });
  await tx(worker,c=>saveExtractionCheckpoint(c,totalJob,totalCheckpoint),true);
  const checkpointRowsSql='select revision,result::text result_bytes,result_sha256 from private.case_extraction_checkpoints where case_id=$1 and version_id=$2 order by revision';
  const originalTotalRows=(await owner.query(checkpointRowsSql,[f.caseId,totalVersion])).rows;
  expect(originalTotalRows).toHaveLength(1);
  expect(await totalPending()).toEqual([{document_id:totalDocument,version_id:totalVersion,source_sha256:totalHash,byte_size:totalBytes.length,mime_type:'application/pdf',storage_path:totalPath}]);
  proofStage='grand_total_physical_facade';const totalAdmissions=physicalAdmissions;
  expect(await ensureSavedSourcePhysicalPages({job:totalJob,jobId:totalLease.jobId,workerId,fencingToken:totalLease.fencingToken,
   purpose:'contract_transcription',transactions:operation=>tx(worker,operation,true),storage:{async download(path){
    expect(path).toBe(totalPath);localSourceReads++;return {data:new Blob([Uint8Array.from(totalBytes)]),error:null};
   }}})).toEqual({recorded:1,unreadableVersions:[]});
  expect(physicalAdmissions-totalAdmissions).toBe(3);expect(await totalPending()).toEqual([]);
  expect((await owner.query('select page_count from private.document_physical_page_receipts where case_id=$1 and document_id=$2 and version_id=$3 and source_sha256=$4',
   [f.caseId,totalDocument,totalVersion,totalHash])).rows).toEqual([{page_count:1}]);
  const totalTarget=documentSourceTranscriptionTarget({checkpoint:totalCheckpoint,policyVersion:SAVED_EXTRACTION_POLICY,subject:{kind:'grand_total',page:1}}),totalQuestion=documentSourceTranscriptionQuestion(totalTarget);
  const openTotal=async(job:SourceJob,target=totalTarget)=>tx(worker,async()=> (await worker.query({name:'source_transcription_grand_total_open',
   text:'select private.document_field_request_open($1::uuid,$2,$3,$4::jsonb,$5) id',
   values:[f.caseId,job.revision,job.input_sha256,JSON.stringify(target),totalQuestion.question]})).rows[0].id as string,true);
  proofStage='grand_total_ordinary_request';const totalRequest=await openTotal(totalJob);
  expect(await openTotal(totalJob)).toBe(totalRequest);
  const originalTotalTarget=(await owner.query(targetReceiptSql,[totalRequest])).rows[0];
  const {target_sha256:ignoredTargetHash,...foreignBody}={...totalTarget,source_sha256:'b'.repeat(64)};void ignoredTargetHash;
  await expect(openTotal(totalJob,{...foreignBody,target_sha256:canonicalSha256(foreignBody)})).rejects.toThrow('REQUEST_FIELD_SOURCE_CHANGED');
  const totalAnswer=JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:JSON.stringify({schema_version:'grand-total-source-value-v1',
   amount:'160.00',label:'total deductions',locator:'Synthetic one-page totals line'})});
  await expect(identify(totalRequest,totalAnswer,randomUUID())).rejects.toThrow('REQUEST_FIELD_FORBIDDEN');
  await expect(identify(totalRequest,JSON.stringify({schema_version:'document-field-answer-v2',action:'confirm'}))).rejects.toThrow('REQUEST_ANSWER_INVALID');
  await identify(totalRequest,JSON.stringify({schema_version:'document-field-answer-v2',action:'unknown'}));
  const replayTotal=async()=>{
   const job=await current();return tx(worker,async c=>{
    await saveExtractionCheckpoint(c,job,totalCheckpoint);
    return {job,snapshot:await new SavedCaseSnapshot(c,job,'2026-06').read()};
   },true);
  };
  const unknownTotal=await replayTotal();expect(unknownTotal.snapshot.extractions.find(e=>e.document_id===totalVersion)?.customer_source_transcriptions??[]).toEqual([]);
  await expect(tx(worker,c=>saveExtractionCheckpoint(c,totalJob,totalCheckpoint))).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
  await edit(totalRequest,totalAnswer,1);
  proofStage='grand_total_identified_correction';const correctedTotal=await replayTotal(),totalExtraction=correctedTotal.snapshot.extractions.find(e=>e.document_id===totalVersion)!;
  expect(totalExtraction.customer_source_transcriptions).toHaveLength(1);
  expect(totalExtraction.customer_source_transcriptions?.[0]).toMatchObject({request_id:totalRequest,answer_revision:2,identity_id:f.identityId,
   subject:{kind:'grand_total'},transcription:{normalized_value:{kind:'grand_total',amount:{currency:'ILS',minor_units:16000}}}});
  expect(totalExtraction.fields).toEqual(machine.fields);expect(payslipMachineExtractionSha256(totalExtraction)).toBe(canonicalSha256(machine));
  expect(await openTotal(correctedTotal.job)).toBe(totalRequest);
  expect((await replayTotal()).snapshot.extraction_snapshot_sha256).toBe(correctedTotal.snapshot.extraction_snapshot_sha256);
  expect((await owner.query(targetReceiptSql,[totalRequest])).rows[0]).toEqual(originalTotalTarget);
  expect((await owner.query(checkpointRowsSql,[f.caseId,totalVersion])).rows[0]).toEqual(originalTotalRows[0]);
  expect((await owner.query(purchaseReceiptSql,[f.paymentId,f.caseId])).rows[0]).toEqual(originalPurchaseReceipt);
  stagedEvidence.push({stage:proofStage,document_id:totalDocument,version_id:totalVersion,checkpoint_result_sha256:totalCheckpoint.result_sha256,
   request_id:totalRequest,physical_pages:1,original_machine_sha256:canonicalSha256(machine),identified_reading_count:1});
  proofStage='grand_total_replaced_version_negative';const replacementVersion=randomUUID();
  await owner.query('begin');try{
   expect((await owner.query("select d.id from public.documents d join public.cases c on c.id=d.case_id where d.id=$1 and d.case_id=$2 and d.version_id=$3 and d.content_sha256=$4 and d.slot='payslip-01' and c.is_qa and c.first_name='Synthetic source kind SQL proof' for update of d",
    [totalDocument,f.caseId,totalVersion,totalHash])).rowCount).toBe(1);
   await owner.query('insert into public.document_versions(version_id,document_id,case_id,storage_path,original_filename,mime_type,size,period_month) select version_id,id,case_id,storage_path,original_filename,mime_type,size,period_month from public.documents where id=$1 and case_id=$2 and version_id=$3 and content_sha256=$4',
    [totalDocument,f.caseId,totalVersion,totalHash]);
   expect((await owner.query("update public.documents set version_id=$5,storage_path=$6,processing_status='uploaded' where id=$1 and case_id=$2 and version_id=$3 and content_sha256=$4 returning version_id",
    [totalDocument,f.caseId,totalVersion,totalHash,replacementVersion,`cases/${f.caseId}/versions/${replacementVersion}.pdf`])).rows).toEqual([{version_id:replacementVersion}]);
   await owner.query('commit');
  }catch(error){await owner.query('rollback');throw error;}
  const replacedStates=await tx(web,async()=> (await web.query('select * from public.case_request_field_states($1,$2)',[f.caseId,f.identityId])).rows);
  expect(replacedStates.find(s=>s.request_id===totalRequest)?.source_current).toBe(false);
  expect((await tx(web,async()=>web.query('select public.case_request_document_source($1,$2,$3) value',[f.caseId,f.identityId,totalRequest]))).rows[0].value).toBeNull();
  await expect(edit(totalRequest,totalAnswer,2)).rejects.toThrow(/REQUEST_ANSWER_INVALID|REQUEST_FIELD_SOURCE_CHANGED/);
  expect((await owner.query(targetReceiptSql,[totalRequest])).rows[0]).toEqual(originalTotalTarget);
  expect((await owner.query(checkpointRowsSql,[f.caseId,totalVersion])).rows[0]).toEqual(originalTotalRows[0]);
  checks.push('217 actual worker finds missing-grand-total payslip despite completed contract discovery; first-pass true-total counterexample omitted; physical facade certifies actual one-page synthetic bytes; actual web unknown/correction creates one separate reading; retry/stale-head/foreign identity and source-hash guards hold; original subtotal/checkpoint/target/purchase receipt unchanged');
  checks.push('replacing synthetic payslip version through archive/CAS leaves original target/checkpoint intact and makes old web field state, source URL and correction unavailable');
  expect(sourcePins()).toEqual(testedSourceFiles);
  proofStage='complete';passed=true;
 }catch(error){primary=error;}finally{
  await Promise.allSettled([owner.query('rollback'),worker.query('rollback'),web.query('rollback')]);
  if(fixture&&physicalJobIds.length)try{
   await owner.query('begin');await owner.query("select set_config('tivdoc.tenant_id',$1,true)",[fixture.tenant]);
   await owner.query("update public.engine_durable_jobs set state='cancelled',cancellation_requested=true,lease_owner=null,lease_expires_at=null,revision=revision+1 where job_id=any($1::text[]) and tenant_id=$2 and canonical_case_id=$3 and state in ('queued','leased','running','retry_wait')",
    [physicalJobIds,fixture.tenant,fixture.caseId]);await owner.query('commit');
  }catch(error){cleanup.push(error);await owner.query('rollback').catch(e=>cleanup.push(e));}
  if(fixture)try{await revokeSourceKindFixture(owner,fixture);revoked=true;}catch(error){cleanup.push(error);}
  await Promise.allSettled([owner.end(),worker.end(),web.end()]);
  const describe=(e:unknown)=>e instanceof Error?{name:e.name,message:e.message.slice(0,1000)}:{message:String(e).slice(0,1000)};
  try{const dir='../release-work/source-transcription-postgres';mkdirSync(dir,{recursive:true});writeFileSync(`${dir}/${runId}.private.json`,JSON.stringify({schema_version:'source-transcription-postgres-proof-v1',result:passed&&revoked&&!cleanup.length?'passed':'failed',head,working_tree_dirty:workingTreeDirty,tested_source_files:testedSourceFiles,checks,statement_names:[...names].sort(),last_statement:lastStatement,raw_row_types:rawRowTypes,last_stage:proofStage,staged_evidence:stagedEvidence,
   primary_failure:primary===undefined?null:describe(primary),cleanup_failures:cleanup.map(describe),case_id:fixture?.caseId??null,revoked,provider_calls:0,storage_calls:0,local_source_reads:localSourceReads,physical_admissions:physicalAdmissions,
   retained_scope:'Fresh labeled synthetic legacy QA case, contract and payslip with archived versions, attendance source, physical receipts, identified source-period/text/grand-total answer versions and source journals; original empty-period purchase receipt retained. Synthetic normalized payslip checkpoints explicitly have no provider receipt. All claimed physical jobs cancelled; session and enrollment revoked. No real customer source, provider output, Findings or reports.',
   limitation:'Local synthetic PDF bytes and ordinary web/worker roles prove physical/source-transcription mechanics and currentness. No hosted Storage or provider request, legal applicability, REAL authority, calculation/report publication or payment-link proof.'},null,2)+'\n',{flag:'wx',mode:0o600});}catch(error){cleanup.push(error);}
 }
 if(primary!==undefined)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'SOURCE_TRANSCRIPTION_PROOF_CLEANUP_FAILED');
},180000);
