import {beforeEach,describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {sourceJobSchema,SOURCE_JOB_KIND} from './source-dispatch.ts';
import {legacySourceIntakeFixture} from './saved-legacy-source-intake.fixture.ts';
import {savedLegacySourceIntake} from './saved-legacy-source-intake.ts';
import {savedLegacyExecutionScope} from './saved-order-scope.ts';
import {runSavedDraftJob,SavedSourceIntakeRequired} from './saved-job-runner.ts';
import {admitSavedExtractionLease,recordSavedExtractionResult,type SavedWorkerTransactions} from './saved-extraction-worker.ts';
import {SavedCaseSnapshot} from './saved-snapshot.ts';
import {saveExtractionCheckpoint} from './extraction-checkpoint.ts';
import {savedSourceDocumentRoute,savedSourcePeriodEvidence} from './saved-source-intake-planning.ts';
const ports=vi.hoisted(()=>({admit:vi.fn(),physical:vi.fn(),extract:vi.fn(),month:vi.fn(),complete:vi.fn()}));
vi.mock('server-only',()=>({}));
vi.mock('./saved-admission.ts',()=>({savedCaseTenant:(id:string)=>`saved-case:${id}`,admitSavedSource:ports.admit}));
vi.mock('./saved-source-physical-pages.ts',()=>({ensureSavedSourcePhysicalPages:ports.physical}));
vi.mock('./saved-extraction-worker.ts',async original=>({...await original<typeof import('./saved-extraction-worker.ts')>(),runSavedWorkerExtraction:ports.extract}));
vi.mock('./saved-worker.ts',()=>({runSavedWorkerMonth:ports.month}));
vi.mock('./saved-document-evidence-worker.ts',()=>({runSavedWorkerDocumentEvidence:vi.fn()}));
vi.mock('./saved-job-completion.ts',()=>({completeSavedDraftJob:ports.complete}));
beforeEach(()=>{vi.resetAllMocks();ports.physical.mockResolvedValue({recorded:0,unreadableVersions:[]});ports.month.mockResolvedValue({});ports.complete.mockResolvedValue({manifest:{publication:'draft'}});});
function setup(){
 const f=legacySourceIntakeFixture();
 const journal={...structuredClone(f.journal),month:null as string|null,documents:[{...f.document,month:null as string|null}],orders:[] as {id:string;kind:string;from:string;to:string;topics:string[];offer_sha256:string}[]};
 const input={...f.input,journal};
 const job=sourceJobSchema.parse({schema_version:'saved-case-work-v1',case_id:f.caseId,revision:input.revision,input_sha256:input.inputSha256,mode:'draft',processing_profile:'qualified_ai_v1',authority_dependency_sha256:'f'.repeat(64)});
 const row={job_kind:SOURCE_JOB_KIND,payload:job,payload_sha256:canonicalSha256(job),tenant_id:`saved-case:${f.caseId}`,canonical_case_id:f.caseId,state:'running',lease_owner:'worker',fencing_token:1,lease_valid:true,cancellation_requested:false};
 const calls:PostgresStatement[]=[],opened:unknown[]=[];
 const base=buildSyntheticCaseFixture({fixture_id:'source-intake-worker',mode:'real'}).stored.extractions[0];
 const machine=normalizedPayslipExtractionSchema.parse({...base,document_id:f.document.version_id,fields:[{candidate_id:'88888888-8888-4888-8888-888888888888',field:'salary_period',raw_value:'June 2026',normalized_value:{year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'},confidence:.99,source:{document_id:f.document.version_id,page:1,text_fragment:'Synthetic June 2026'},extraction_method:'fixture',warning_flags:[]}],additional_components:[]});
 const run={result:{final_extraction:machine,first_pass:{normalized_extraction:machine}}};
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:f.caseId,product_document_id:f.document.id,version_id:f.document.version_id,input_sha256:f.document.sha256,expected_month:'2026-06',period_mismatch:false,requires_confirmation:false,result_sha256:canonicalSha256(run.result),run};
 const stored={id:f.document.id,case_id:f.caseId,version_id:f.document.version_id,document_type:'payslip',content_sha256:f.document.sha256,pinned_month:null,journal_month:null,expected_month:null,
  original_filename:'synthetic.pdf',mime_type:'application/pdf',size:200,storage_path:`cases/${f.caseId}/versions/${f.document.version_id}.pdf`,created_at:'2026-07-01T00:00:00Z',checkpoint_input_sha256:f.document.sha256,checkpoint_result_sha256:checkpoint.result_sha256,result:checkpoint};
 const state:{invocation:Record<string,unknown>|null;sourceExists:boolean;recorded:boolean;current:boolean}={invocation:null,sourceExists:true,recorded:false,current:true};
 const seal=()=>{input.journalSha256=canonicalSha256(journal);};seal();
 const context:PostgresTransactionContext={transaction_id:'synthetic-intake-worker',client:{async query(q){calls.push(q);let rows:Record<string,unknown>[]=[];
  switch(q.name){
   case 'saved_runner_read':case 'saved_runner_lock':case 'extraction_job_read':case 'extraction_job_lock':rows=[row];break;
   case 'saved_runner_journal':case 'saved_snapshot_journal':rows=[{input:journal,input_sha256:job.input_sha256,actual_sha256:job.input_sha256,created_at:'2026-09-12T12:10:00Z'}];break;
   case 'saved_runner_source_intake_context':case 'saved_legacy_source_intake_context':rows=[{context:input}];break;
   case 'saved_order_entitlements':rows=[{orders:journal.orders,current_orders:journal.orders,legacy_orders:journal.legacy_orders,current_legacy_orders:journal.legacy_orders}];break;
   case 'saved_runner_source_intake_open':opened.push(JSON.parse(String(q.values[3])));rows=[{id:'99999999-9999-4999-8999-999999999999'}];break;
   case 'saved_runner_source_upload_context':rows=[{contexts:[]}];break;
   case 'saved_runner_heartbeat':rows=[{job_id:'job'}];break;
   case 'source_case_lock':break;
   case 'source_revision_check':rows=[{revision:state.current?job.revision:job.revision+1,input_sha256:job.input_sha256,processing_profile:job.processing_profile,authority_dependency_sha256:job.authority_dependency_sha256}];break;
   case 'extraction_pinned_document':case 'saved_snapshot_document':rows=[stored];break;
   case 'checkpoint_source_match':break;
   case 'checkpoint_intake_source':rows=[{month:null,journal_month:null}];break;
   case 'checkpoint_insert':break;
   case 'checkpoint_read':rows=[{result:checkpoint,input_sha256:checkpoint.input_sha256,result_sha256:checkpoint.result_sha256}];break;
   case 'extraction_receipt_authority':rows=[{principal:'tivdoc_worker_runtime',tenant_id:`saved-case:${f.caseId}`}];break;
   case 'extraction_receipt_lock':rows=state.invocation?[state.invocation]:[];break;
   case 'extraction_receipt_source':rows=state.sourceExists?[{matched:1}]:[];break;
   case 'extraction_receipt_record':state.recorded=true;rows=[{invocation_id:q.values[0]}];break;
   default:throw Error('UNEXPECTED_SQL:'+q.name);
  }return {rows,row_count:rows.length};
 }}};
 const transactions:SavedWorkerTransactions=operation=>operation(context),lease={jobId:'job',workerId:'worker',fencingToken:1,versionId:f.document.version_id};
 const runInput={...lease,transactions,storage:{download:vi.fn()},providerEnabled:false,receiptOnly:true};
 return {f,input,journal,job,row,context,calls,opened,seal,runInput,lease,stored,machine,checkpoint,state};
}
async function held(f:ReturnType<typeof setup>){try{await runSavedDraftJob(f.runInput);}catch(error){if(error instanceof SavedSourceIntakeRequired)return error;throw error;}throw Error('Expected source intake hold');}
describe('ordinary source-intake worker routing',()=>{
 it('opens a monthless source reading before planning without OCR or successful completion',async()=>{
  const f=setup();f.journal.answers=[];f.seal();const result=await held(f);
  expect(result.detail.held).toEqual([{orderId:f.f.scope.id,month:null,code:'source_period_required'}]);expect(result.detail.analyzedMonths).toBe(0);
  expect(f.opened).toHaveLength(1);expect(f.opened[0]).toMatchObject({schema_version:'document-source-period-intake-v1',month:null});
  expect(ports.physical).toHaveBeenCalledOnce();expect(ports.extract).not.toHaveBeenCalled();expect(ports.month).not.toHaveBeenCalled();expect(ports.complete).not.toHaveBeenCalled();
  expect(f.calls.some(c=>c.name==='saved_order_entitlements')).toBe(false);
 });
 it('executes the original payslip with its authenticated full-month reading and preserves the original receipt',async()=>{
  const f=setup(),before=canonicalSha256(f.journal),result=await runSavedDraftJob(f.runInput);
  expect(result).toMatchObject({extractedVersions:1,analyzedMonths:1});expect(ports.extract).toHaveBeenCalledOnce();expect(ports.month.mock.calls[0][0]).toMatchObject({orderId:f.f.scope.id,month:'2026-06'});
  expect(f.journal.legacy_orders[0].period_state).toBe('missing');expect(f.journal.documents[0].month).toBeNull();expect(canonicalSha256(f.journal)).toBe(before);expect(f.opened).toEqual([]);
 });
 it.each(['unknown','unreadable'])('retains latest %s without retrying its question or dispatching',async action=>{
  const f=setup();f.journal.answers[0].answer=JSON.stringify({v:1,action});f.seal();await held(f);
  expect(f.opened).toEqual([]);expect(ports.extract).not.toHaveBeenCalled();expect(ports.complete).not.toHaveBeenCalled();
 });
 it('keeps a different identified document type as a precise software dependency, never payroll OCR',async()=>{
  const f=setup();f.journal.answers[0].answer=JSON.stringify({...f.f.answer,value:{...f.f.answer.value,document_kind:'attendance'}});f.seal();const result=await held(f);
  expect(result.detail.held).toContainEqual({orderId:f.f.scope.id,month:'2026-06',code:'source_kind_dispatch_required'});
  expect(result.detail.technicalDependencies).toContainEqual(expect.objectContaining({code:'source_kind_dispatch_required',stored_kind:'payslip',source_document_kind:'attendance'}));
  expect(ports.extract).not.toHaveBeenCalled();expect(ports.month).not.toHaveBeenCalled();expect(ports.complete).not.toHaveBeenCalled();
 });
 it('commits an independent ordinary month before holding a monthless original order',async()=>{
  const f=setup();f.journal.answers=[];f.journal.orders=[{id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',kind:'initial',from:'2026-07-01',to:'2026-07-01',topics:['minimum_wage'],offer_sha256:'a'.repeat(64)}];
  f.journal.documents.push({...f.journal.documents[0],id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',month:'2026-07'});
  f.input.currentDocuments.push({...f.journal.documents[1]});f.seal();const result=await held(f);
  expect(result.detail.analyzedMonths).toBe(1);expect(ports.extract.mock.calls.map(([i])=>i.versionId)).toEqual([f.journal.documents[1].version_id]);expect(ports.month.mock.calls[0][0]).toMatchObject({month:'2026-07'});expect(ports.complete).not.toHaveBeenCalled();
 });
 it('opens a newly added unclassified payslip after a different source established the month, without blocking that ready month',async()=>{
  const f=setup();f.journal.documents.push({...f.journal.documents[0],id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',version_id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc'});f.input.currentDocuments.push({...f.journal.documents[1]});f.seal();
  const result=await held(f);expect(result.detail.analyzedMonths).toBe(1);expect(ports.extract.mock.calls.map(([i])=>i.versionId)).toEqual([f.f.document.version_id]);
  expect(f.opened).toHaveLength(1);expect(f.opened[0]).toMatchObject({schema_version:'document-source-period-intake-v1',version_id:f.journal.documents[1].version_id});
  expect(result.detail.held).toContainEqual({orderId:f.f.scope.id,month:null,code:'source_period_required'});expect(ports.complete).not.toHaveBeenCalled();
 });
 it('opens the exact order-bound document request for empty source inventory without a fabricated month',async()=>{
  const f=setup();f.journal.documents=[];f.journal.answers=[];f.input.currentDocuments=[];f.seal();await held(f);
  expect(f.opened).toHaveLength(1);expect(f.opened[0]).toMatchObject({schema_version:'legacy-source-intake-document-v1',month:null,order_id:f.f.scope.id});expect(ports.month).not.toHaveBeenCalled();
 });
 it('holds unavailable physical page metadata without inventing page one or reopening a field',async()=>{
  const f=setup();f.journal.answers=[];f.input.currentDocuments=[{...f.f.document,page_count:null}];f.seal();const result=await held(f);
  expect(result.detail.technicalDependencies).toContainEqual(expect.objectContaining({code:'source_page_count_required',version_id:f.f.document.version_id}));expect(f.opened).toEqual([]);expect(ports.extract).not.toHaveBeenCalled();
 });
 it('rejects changed canonical current context before opening or extracting',async()=>{
  const f=setup();f.input.journalSha256='a'.repeat(64);await expect(runSavedDraftJob(f.runInput)).rejects.toThrow('SOURCE_INTAKE_CURRENT_HASH');expect(f.opened).toEqual([]);expect(ports.extract).not.toHaveBeenCalled();
 });
 it('does not lend a reading to a foreign source hash or select a month from a multi-month source',async()=>{
  const f=setup(),saved=savedLegacySourceIntake(structuredClone(f.input)),order=savedLegacyExecutionScope(f.f.scope,saved);if(!order)throw Error('fixture');
  expect(savedSourceDocumentRoute([order],{...f.journal.documents[0],sha256:'a'.repeat(64)},null)).toMatchObject({state:'held'});
  f.journal.answers[0].answer=JSON.stringify({...f.f.answer,value:{...f.f.answer.value,period:{from:'2026-06-01',to:'2026-07-31'}}});f.seal();const multi=savedLegacyExecutionScope(f.f.scope,savedLegacySourceIntake(structuredClone(f.input)));if(!multi)throw Error('fixture');
  expect(savedSourceDocumentRoute([multi],f.journal.documents[0],null)).toEqual({state:'held',code:'source_multi_month_dispatch_required'});
  const result=await held(f);expect(result.detail.held).toEqual(['2026-06','2026-07'].map(month=>({orderId:f.f.scope.id,month,code:'source_multi_month_dispatch_required'})));expect(f.opened).toEqual([]);
 });
 it('uses exact current period evidence in extraction admission, snapshot and checkpoint with original metadata intact',async()=>{
  const f=setup(),admitted=await admitSavedExtractionLease(f.context,f.lease);
  expect(admitted.month).toBe('2026-06');expect(admitted.sourcePeriodEvidence?.origin).toBe('customer_document_reading');expect(admitted.document.expected_month).toBeNull();
  const snapshot=await new SavedCaseSnapshot(f.context,f.job,'2026-06').read();expect(snapshot.documents).toHaveLength(1);expect(snapshot.documents[0].document_period).toBeNull();
  expect(snapshot.extractions[0].fields).toEqual(f.machine.fields);expect(snapshot.declared_fact_snapshot.facts).toEqual([]);
  await saveExtractionCheckpoint(f.context,f.job,f.checkpoint as Parameters<typeof saveExtractionCheckpoint>[2]);expect(f.calls.some(c=>c.name==='checkpoint_intake_source')).toBe(true);
  f.state.current=false;await expect(saveExtractionCheckpoint(f.context,f.job,f.checkpoint as Parameters<typeof saveExtractionCheckpoint>[2])).rejects.toThrow('ANALYSIS_INPUT_SUPERSEDED');
 });
 it('retains a late receipt from its immutable invocation proof while current corrections block a new checkpoint',async()=>{
  const f=setup(),saved=savedLegacySourceIntake(structuredClone(f.input)),order=savedLegacyExecutionScope(f.f.scope,saved);if(!order)throw Error('fixture');
  const proof=savedSourcePeriodEvidence([order],{caseId:f.f.caseId,documentId:f.f.document.id,versionId:f.f.document.version_id,sha256:f.f.document.sha256,month:'2026-06'});
  f.state.invocation={invocation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',case_id:f.f.caseId,version_id:f.f.document.version_id,expected_month:'2026-06',input_sha256:f.f.document.sha256,source_revision:2,result:null,source_period_evidence:proof};
  f.journal.answers[0].answer=JSON.stringify({v:1,action:'unknown'});f.seal();
  await recordSavedExtractionResult(f.context,String(f.state.invocation.invocation_id),f.checkpoint as Parameters<typeof recordSavedExtractionResult>[2]);expect(f.state.recorded).toBe(true);
  await expect(saveExtractionCheckpoint(f.context,f.job,f.checkpoint as Parameters<typeof saveExtractionCheckpoint>[2])).rejects.toThrow('SAVED_ORDER_SCOPE');
  expect(f.calls.find(c=>c.name==='extraction_receipt_source')?.values.at(-1)).toBe(true);
 });
 it('rejects altered or foreign invocation evidence even for a retained provider receipt',async()=>{
  const f=setup(),order=savedLegacyExecutionScope(f.f.scope,savedLegacySourceIntake(structuredClone(f.input)));if(!order?.source_period_evidence)throw Error('fixture');
  f.state.invocation={invocation_id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',case_id:f.f.caseId,version_id:f.f.document.version_id,expected_month:'2026-06',input_sha256:f.f.document.sha256,source_revision:2,result:null,source_period_evidence:{...order.source_period_evidence,evidence_sha256:'a'.repeat(64)}};
  await expect(recordSavedExtractionResult(f.context,String(f.state.invocation.invocation_id),f.checkpoint as Parameters<typeof recordSavedExtractionResult>[2])).rejects.toThrow('SAVED_EXTRACTION_PERIOD_EVIDENCE');expect(f.state.recorded).toBe(false);
 });
});
