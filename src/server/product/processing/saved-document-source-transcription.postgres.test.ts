import {it,expect,vi} from 'vitest';
import pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {PDFDocument} from 'pdf-lib';
import {mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {attachNonPayslipInventory} from '@/engine/document-review/non-payslip';
import {attachAutomaticNonPayslipEvidence} from '@/engine/entitlement-review/automatic-nonpay';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {NodePostgresManagedClient} from '@/server/platform/persistence/postgres/runtime/node-pg-driver';
import {SUPABASE_ROOT_2021_CA} from '../case-access/supabase-ca';
import {seedSourceKindFixture,revokeSourceKindFixture} from './fixtures/source-kind-postgres';
import {sourceJobSchema,type SourceJob} from './source-dispatch';
import {savedLegacySourceIntake,legacySourceIntakeRequests} from './saved-legacy-source-intake';
import {SavedCaseSnapshot} from './saved-snapshot';
import {readSavedOrders,savedOrderOrigin,savedOrderReceiptSha256} from './saved-order-scope';
import {attachSavedDocumentSourceTranscriptions,openSavedDocumentSourceTranscriptionRequests} from './saved-document-source-transcription';
vi.mock('server-only',()=>({}));

/** Opt-in, actual named PG statements and web/worker login roles. Only new
 * synthetic audit rows; no external storage/provider, migration, or reports. */
it.skipIf(process.env.TIVDOC_SOURCE_TRANSCRIPTION_DB_PROOF!=='1')('captures an ordinary identified contract transcription without any OCR checkpoint',async()=>{
 if(process.env.VERCEL||process.env.VERCEL_ENV||process.env.NODE_ENV!=='test')throw Error('SOURCE_TRANSCRIPTION_DB_BOUNDARY');
 const {readDevEnvFile}=await import('../../../../scripts/supabase-dev-guard/dev-credential.mts'),env=readDevEnvFile();
 const client=(key:string)=>{const u=new URL(env.get(key)!);if(u.hostname!=='aws-0-eu-central-1.pooler.supabase.com'||u.pathname!=='/tivdoc_release_replay_20260907'||!u.username.endsWith('.cpzrbidxftzqcfeqqusu'))throw Error('EXACT_ISOLATED_DEV_REQUIRED');
  u.search='';return new pg.Client({connectionString:u.toString(),ssl:{rejectUnauthorized:true,ca:SUPABASE_ROOT_2021_CA},connectionTimeoutMillis:15000,statement_timeout:30000});};
 const owner=client('TIVDOC_DEV_DATABASE_URL'),worker=client('TIVDOC_WORKER_POSTGRES_URL'),web=client('TIVDOC_WEB_POSTGRES_URL');
 const runId=randomUUID(),head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),checks:string[]=[],names=new Set<string>(),cleanup:unknown[]=[];
 const printed='SYNTHETIC ONLY - June 2026 contract. An award is discretionary; no fixed payment is promised.';
 let fixture:Awaited<ReturnType<typeof seedSourceKindFixture>>|undefined,primary:unknown,passed=false,revoked=false,lastStatement='';
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
   const context:PostgresTransactionContext={transaction_id:randomUUID(),client:{async query(q){names.add(q.name);lastStatement=q.name;return managed.query(q);}}};
   const value=await fn(context);await db.query(commit?'commit':'rollback');return value;
  }catch(error){await db.query('rollback').catch(e=>cleanup.push(e));throw error;}finally{managed.release();}
 }
 const current=async():Promise<SourceJob>=>sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:fixture!.caseId,mode:'draft',...(await owner.query("select h.revision,h.input_sha256,d.processing_profile,d.authority_dependency_sha256 from private.case_input_heads h join private.case_analysis_dispatch d on d.case_id=h.case_id and d.revision=h.revision and d.mode='draft' where h.case_id=$1",[fixture!.caseId])).rows[0]});
 try{
  await Promise.all([owner.connect(),worker.connect(),web.connect()]);
  for(const [db,role] of [[owner,'tivdoc_dev_migrator'],[worker,'tivdoc_worker_runtime'],[web,'tivdoc_web_runtime']] as const)expect((await db.query('select current_database() database,session_user role')).rows[0]).toEqual({database:'tivdoc_release_replay_20260907',role});
  fixture=await seedSourceKindFixture(owner,'contract',printed,7);const f=fixture;
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
  const periodAnswer=JSON.stringify({v:1,action:'correct',value:{document_kind:'contract',period,page:3,source_label:'SYNTHETIC ONLY - June 2026 contract'}});await identify(periodRequest,periodAnswer);
  await identify(attendanceRequest,JSON.stringify({v:1,action:'correct',value:{document_kind:'attendance',period,page:1,source_label:attendanceLabel}}));
  expect(f.scope.periods).toEqual([]);
  checks.push('separate synthetic attendance source has an actual web full-month period answer; original purchase periods remain empty; contract alone supplies no financial month');
  async function replay(){const job=await current();return tx(worker,async c=>{
   const snapshot=await new SavedCaseSnapshot(c,job,'2026-06',undefined,undefined,true).read(),order=(await readSavedOrders(c,job))[0];
   const base=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:f.caseId,period,
    purchased_scope:{order_id:order.id,origin:savedOrderOrigin(order),receipt_sha256:savedOrderReceiptSha256(order),topics:[...order.topics]},
    documents:[{case_id:f.caseId,document_id:f.versionId,version_id:f.versionId,file_sha256:f.hash,page_count:7,kind:'contract',label:'Synthetic contract source',period:null,reading_origin:'source_inventory',reading_sha256:f.hash}],checks:[],coverage_gaps:[],
    completion_input:{case_id:f.caseId,period,documents:[],evidence:[],needs:[]}});
   const review=attachSavedDocumentSourceTranscriptions(attachNonPayslipInventory(base,snapshot),snapshot);
   return {job,snapshot,review,composed:attachAutomaticNonPayslipEvidence(review,snapshot).input};
  });}
  const initial=await replay(),opened=await tx(worker,c=>openSavedDocumentSourceTranscriptionRequests(c,initial.job,'2026-06',initial.review),true);
  expect(opened).toHaveLength(1);expect(await tx(worker,c=>openSavedDocumentSourceTranscriptionRequests(c,initial.job,'2026-06',initial.review))).toEqual(opened);
  const requestId=opened[0].requestId;
  const target=(await owner.query('select target from private.document_field_targets where request_id=$1',[requestId])).rows[0].target;
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
  checks.push('new source-period answer stales field state/source URL/old edit/worker replay; original answer and source hash preserved; zero extraction checkpoints');passed=true;
 }catch(error){primary=error;}finally{
  await Promise.allSettled([owner.query('rollback'),worker.query('rollback'),web.query('rollback')]);
  if(fixture)try{await revokeSourceKindFixture(owner,fixture);revoked=true;}catch(error){cleanup.push(error);}
  await Promise.allSettled([owner.end(),worker.end(),web.end()]);
  const describe=(e:unknown)=>e instanceof Error?{name:e.name,message:e.message.slice(0,1000)}:{message:String(e).slice(0,1000)};
  try{const dir='../release-work/source-transcription-postgres';mkdirSync(dir,{recursive:true});writeFileSync(`${dir}/${runId}.private.json`,JSON.stringify({schema_version:'source-transcription-postgres-proof-v1',result:passed&&revoked&&!cleanup.length?'passed':'failed',head,checks,statement_names:[...names].sort(),last_statement:lastStatement,raw_row_types:rawRowTypes,
   primary_failure:primary===undefined?null:describe(primary),cleanup_failures:cleanup.map(describe),case_id:fixture?.caseId??null,revoked,provider_calls:0,storage_calls:0,
   retained_scope:'Only fresh labeled synthetic legacy QA case/contract and attendance sources/physical receipts/source-period and text-answer versions/input journals; original empty-period purchase receipt retained; session and enrollment revoked. No real source, provider output, extraction checkpoint, Findings or reports.',
   limitation:'Synthetic local PDF and ordinary web identified answers prove source transcription/currentness only. Unsupported clause wording correctly remains a rule gap; no legal applicability or payment-link proof.'},null,2)+'\n',{flag:'wx',mode:0o600});}catch(error){cleanup.push(error);}
 }
 if(primary!==undefined)throw primary;if(cleanup.length)throw new AggregateError(cleanup,'SOURCE_TRANSCRIPTION_PROOF_CLEANUP_FAILED');
},180000);
