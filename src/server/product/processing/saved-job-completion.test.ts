import {beforeEach,describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {completeSavedDraftJob} from './saved-job-completion';
import {admitSavedSource} from './saved-admission';
import {purchasedMonths,savedMonthIdempotencyKey,readSavedOrders,type SavedOrderScope} from './saved-order-scope';
import {june2026RegularReviewIdempotencyKey} from './saved-june2026-regular-authority';
import {SOURCE_JOB_KIND,type SourceJob} from './source-dispatch';
import {documentReviewIdempotencyKey,savedAiReleaseBaseKey} from './document-review-key';
import {loadSavedAiReleaseConfiguration,type SavedAiReleaseConfiguration} from './saved-ai-release-configuration';
import {aiReleaseConfigurationSchema} from './ai-release-configuration';
import {createCaseAnalysisAiRelease,CASE_ANALYSIS_AI_RELEASE_CODE_VERSION} from '@/engine/case-analysis/contracts';
import {runtimeFixture} from '@/engine/ai-release-runtime/runtime.fixture';
import {AI_RELEASE_RUNTIME_FAMILIES} from '@/engine/ai-release-runtime/contracts';
import {fixture as pensionSourceFixture} from '@/engine/entitlement-review/compose.fixture';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {FixtureReportBuilder} from '@/engine/case-analysis/fixture-ports';
import {bytesSha256,encodeReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {AI_RELEASE_REPORT_TEMPLATE} from '../reports/ai-release-report';
import type {AnalysisResultBundle} from '@/engine/wave3/contracts';

const reviewPorts=vi.hoisted(()=>({sha256:'e'.repeat(64)}));
vi.mock('./document-review-key',async importOriginal=>{
 const original=await importOriginal<typeof import('./document-review-key')>();
 return {...original,resolveSavedDocumentReviewKey:vi.fn(async(_context:PostgresTransactionContext,_job:SourceJob,_order:SavedOrderScope,_month:string,baseKey:string)=>({
  key:original.documentReviewIdempotencyKey(baseKey,reviewPorts.sha256),reviewSha256:reviewPorts.sha256,
 }))};
});
vi.mock('./saved-ai-release-configuration',()=>({loadSavedAiReleaseConfiguration:vi.fn(async()=>null)}));
beforeEach(()=>{reviewPorts.sha256='e'.repeat(64);vi.mocked(loadSavedAiReleaseConfiguration).mockReset().mockResolvedValue(null);});

// Authority/case locking is independently exercised with the actual worker DB
// role. These tests isolate receipt completeness and terminal write behavior.
vi.mock('./saved-admission',()=>({savedCaseTenant:(id:string)=>`saved-case:${id}`,admitSavedSource:vi.fn(async()=>({revision:1}))}));
function setup(){
 const fixture=buildSyntheticCaseFixture({fixture_id:'draft-finalizer',mode:'real'}),caseId=fixture.command.case_id;
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:caseId,revision:1,input_sha256:'a'.repeat(64),mode:'draft'};
 const order:SavedOrderScope={id:'11111111-1111-4111-8111-111111111111',kind:'full',from:'2025-01-01',to:'2025-02-01',topics:[...fixture.command.requested_topics],offer_sha256:'b'.repeat(64)};
 const row={job_id:'saved-test',tenant_id:`saved-case:${caseId}`,canonical_case_id:caseId,job_kind:SOURCE_JOB_KIND,payload:job,
  payload_sha256:canonicalSha256(job),state:'running',fencing_token:2,lease_owner:'worker',lease_valid:true,cancellation_requested:false,terminal_effect_sha256:null as string|null};
 const receipts=purchasedMonths(order).map(month=>{
  const key=documentReviewIdempotencyKey(savedMonthIdempotencyKey(job,order.id,month),reviewPorts.sha256),end=month==='2025-01'?'31':'28';
  const command={...fixture.command,idempotency_key:key,document_review_sha256:reviewPorts.sha256,period:{start_date:`${month}-01`,end_date:`${month}-${end}`}};
  return {idempotency_key:key,analysis_run_id:`run-${month}`,command,command_sha256:canonicalSha256(command),result_sha256:'c'.repeat(64),report_id:`report-${month}`,report_revision:1,report_sha256:'d'.repeat(64)};
 });
 const responses:Record<string,Record<string,unknown>[]>={saved_job_read:[row],saved_job_lock:[row],saved_order_entitlements:[{orders:[order],current_orders:[order]}],saved_job_month_receipts:receipts,saved_job_complete_atomic:[{outbox_id:'saved-draft:saved-test'}]};
 responses.saved_job_replay_authority=[{tenant_id:row.tenant_id,principal:'tivdoc_worker_runtime'}];
 responses.saved_job_replay_case_lock=[{id:caseId}];
 responses.saved_job_replay_source_head=[{revision:job.revision,input_sha256:job.input_sha256}];
 responses.saved_job_replay_month_receipts=receipts;
 const calls:PostgresStatement[]=[];
 const context:PostgresTransactionContext={transaction_id:'unit-only',client:{async query(s){calls.push(s);const rows=responses[s.name];if(!rows)throw new Error(`UNEXPECTED_SQL:${s.name}`);return {rows,row_count:rows.length};}}};
 const input={context,jobId:row.job_id,workerId:'worker',fencingToken:2};
 return {input,job,order,row,receipts,responses,calls};
}
describe('saved draft job exact purchased completion',()=>{
 it.each(['missing','expired'] as const)('completes only the regular blocked-review receipt when authority is %s',async(state)=>{
  const s=setup();s.order.from='2026-06-01';s.order.to='2026-06-01';s.order.topics=['minimum_wage'];
  const key=documentReviewIdempotencyKey(june2026RegularReviewIdempotencyKey(s.job,s.order.id),reviewPorts.sha256);
  const command={...s.receipts[0].command,idempotency_key:key,requested_topics:['minimum_wage'],period:{start_date:'2026-06-01',end_date:'2026-06-30'}};
  s.responses.saved_job_month_receipts=[{...s.receipts[0],idempotency_key:key,command,command_sha256:canonicalSha256(command)}];
  s.responses.june_test_authority=[{authority:null}];
  s.responses.june_regular_authority=[{authority:state==='missing'?null:{state:'blocked',reason:'assessment_expired'}}];
  const result=await completeSavedDraftJob(s.input);expect(result.manifest.months).toHaveLength(1);
  expect(JSON.parse(String(s.calls.find(c=>c.name==='saved_job_month_receipts')!.values[2]))).toEqual([key]);
  // An old authorized receipt is not a substitute for the current blocked run.
  s.responses.saved_job_month_receipts[0].idempotency_key='june-regular:'+ 'f'.repeat(64);
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_MONTHS_INCOMPLETE');
 });
 it('refuses a synthetic command substituted for a REAL blocked-review receipt',async()=>{
  const s=setup();s.receipts[0].command.mode='synthetic_test';s.receipts[0].command_sha256=canonicalSha256(s.receipts[0].command);
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_RECEIPT_SCOPE');
  expect(s.calls.some(c=>c.name==='saved_job_complete_atomic')).toBe(false);
 });

 it('refuses a prior completed review after its saved input changes without changing the source job',async()=>{
  const s=setup(),oldKeys=s.receipts.map(r=>r.idempotency_key);
  reviewPorts.sha256='f'.repeat(64);
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_MONTHS_INCOMPLETE');
  const requested=JSON.parse(String(s.calls.find(c=>c.name==='saved_job_month_receipts')!.values[2]));
  expect(requested).not.toEqual(oldKeys);expect(s.calls.some(c=>c.name==='saved_job_complete_atomic')).toBe(false);
 });
 it('requires the exact current review pin in the command even when its command hash is valid',async()=>{
  const s=setup();s.receipts[0].command.document_review_sha256='f'.repeat(64);s.receipts[0].command_sha256=canonicalSha256(s.receipts[0].command);
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_RECEIPT_SCOPE');
  expect(s.calls.some(c=>c.name==='saved_job_complete_atomic')).toBe(false);
 });
 it('does not finalize a new nonterminal job using a pre-review legacy key',async()=>{
  const s=setup();s.receipts[0].idempotency_key=savedMonthIdempotencyKey(s.job,s.order.id,'2025-01');
  s.receipts[0].command.idempotency_key=s.receipts[0].idempotency_key;s.receipts[0].command_sha256=canonicalSha256(s.receipts[0].command);
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_MONTHS_INCOMPLETE');
  expect(s.calls.some(c=>c.name==='saved_job_complete_atomic')).toBe(false);
 });
 it('binds both months, distinct order scopes and their durable receipts to one draft manifest',async()=>{
  const s=setup(),result=await completeSavedDraftJob(s.input);
  expect(result.manifest.months.map(m=>m.month)).toEqual(['2025-01','2025-02']);
  expect(result.manifest.publication).toBe('draft');expect(result.sha256).toBe(canonicalSha256(result.manifest));
  const write=s.calls.filter(c=>c.name==='saved_job_complete_atomic');expect(write).toHaveLength(1);
  expect(write[0].text).toContain('clock_timestamp()');expect(write[0].text).toContain('not cancellation_requested');
 });
 it.each(['missing','duplicate','wrong month','wrong topics','wrong command hash'] as const)('refuses %s receipt before any terminal write',async(defect)=>{
  const s=setup();
  if(defect==='missing')s.receipts.pop();
  if(defect==='duplicate')s.receipts[1]=s.receipts[0];
  if(defect==='wrong month')s.receipts[1].command.period.start_date='2025-01-01';
  if(defect==='wrong topics')s.receipts[1].command.requested_topics=s.receipts[1].command.requested_topics.slice(0,3);
  if(defect==='wrong command hash')s.receipts[1].command_sha256='e'.repeat(64);
  if(defect==='wrong month'||defect==='wrong topics')s.receipts[1].command_sha256=canonicalSha256(s.receipts[1].command);
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow(/SAVED_JOB_(MONTHS_INCOMPLETE|RECEIPT_SCOPE)/);
  expect(s.calls.some(c=>c.name==='saved_job_complete_atomic')).toBe(false);
 });
 it.each(['stale fence','expired','cancelled','other worker'] as const)('rejects %s before receipt work',async(defect)=>{
  const s=setup();if(defect==='stale fence')s.row.fencing_token=3;if(defect==='expired')s.row.lease_valid=false;
  if(defect==='cancelled')s.row.cancellation_requested=true;if(defect==='other worker')s.row.lease_owner='another';
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_FENCE');
  expect(s.calls.some(c=>c.name==='saved_job_month_receipts')).toBe(false);
 });
 it('refuses a lease expiring at the atomic write without a separate outbox insertion',async()=>{
  const s=setup();s.responses.saved_job_complete_atomic=[];
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_FENCE');
  expect(s.calls.filter(c=>c.name==='saved_job_complete_atomic')).toHaveLength(1);
  expect(s.calls.some(c=>c.name==='outbox_enqueue')).toBe(false);
 });
 it('replays only the exact persisted manifest and detects a mismatched outbox',async()=>{
  const s=setup(),first=await completeSavedDraftJob(s.input);s.row.state='succeeded';s.row.terminal_effect_sha256=first.sha256;
  s.responses.saved_job_manifest_replay=[{payload:first.manifest,payload_sha256:first.sha256}];s.calls.length=0;
  expect((await completeSavedDraftJob(s.input)).replayed).toBe(true);
  expect(s.calls.some(c=>c.name==='saved_job_complete_atomic')).toBe(false);
  s.responses.saved_job_manifest_replay[0].payload={...first.manifest,publication:'published'};
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_MANIFEST_MISMATCH');
 });
 it('requires the chosen order entitlement even when another paid order remains',async()=>{
  const s=setup();s.responses.saved_order_entitlements[0].current_orders=[{...s.order,id:'22222222-2222-4222-8222-222222222222'}];
  await expect(readSavedOrders(s.input.context,s.job,s.order.id)).rejects.toThrow('SAVED_ORDER_ENTITLEMENT_REQUIRED');
 });
 it.each(['tenant','case','hash'] as const)('refuses a job whose %s is not bound to its source',async(defect)=>{
  const s=setup();if(defect==='tenant')s.row.tenant_id='saved-case:foreign';
  if(defect==='case')s.row.canonical_case_id='22222222-2222-4222-8222-222222222222';
  if(defect==='hash')s.row.payload_sha256='e'.repeat(64);
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_SCOPE');
  expect(s.calls.some(c=>c.name==='saved_job_lock')).toBe(false);
 });
 it('preserves overlapping purchases as distinct keys and refuses duplicate journal orders',async()=>{
  const s=setup(),other={...s.order,id:'22222222-2222-4222-8222-222222222222'};
  expect(savedMonthIdempotencyKey(s.job,s.order.id,'2025-01')).not.toBe(savedMonthIdempotencyKey(s.job,other.id,'2025-01'));
  s.responses.saved_order_entitlements[0].orders=[s.order,s.order];
  await expect(readSavedOrders(s.input.context,s.job)).rejects.toThrow('SAVED_ORDER_SCOPE');
 });
 it('expands December boundaries and 600 months exactly, rejecting an oversized paid scope',()=>{
  const s=setup();expect(purchasedMonths({...s.order,from:'2024-12-01',to:'2025-02-01'})).toEqual(['2024-12','2025-01','2025-02']);
  expect(purchasedMonths({...s.order,from:'1976-01-01',to:'2025-12-01'})).toHaveLength(600);
  expect(()=>purchasedMonths({...s.order,from:'1975-12-01',to:'2025-12-01'})).toThrow('ORDER_PERIOD_REQUIRES_OPERATIONS');
 });
});

describe('saved AI release completion and present-use replay',()=>{
 async function aiSetup(){
  const s=setup(),raw=pensionSourceFixture().input;
  const source=documentReviewInputSchema.parse(JSON.parse(JSON.stringify(raw).replaceAll(raw.case_id,s.job.case_id)));
  source.purchased_scope={...source.purchased_scope,order_id:s.order.id,origin:'saved_order',receipt_sha256:s.order.offer_sha256,topics:['pension']};
  if(source.entitlement_evidence){source.entitlement_evidence.order_id=s.order.id;source.entitlement_evidence.receipt_sha256=s.order.offer_sha256;}
  s.order.from='2026-06-01';s.order.to='2026-06-01';s.order.topics=['pension'];
  s.job.processing_profile='qualified_ai_v1';s.job.authority_dependency_sha256='1'.repeat(64);s.row.payload_sha256=canonicalSha256(s.job);
  const runtime=runtimeFixture(source);runtime.analysis_run_id='ai-finalizer-run';
  const scope={...runtime.assessment_input.current.scope,input_revision:s.job.revision,input_sha256:s.job.input_sha256,authority_dependency_sha256:s.job.authority_dependency_sha256};
  runtime.assessment_input.current.scope=scope;runtime.assessment_input.assessment.scope=scope;
  const {sha256:oldSha,...assessmentBody}=runtime.assessment_input.assessment;void oldSha;
  runtime.assessment_input.assessment.sha256=canonicalSha256(assessmentBody);runtime.assessment_input.current.assessment_sha256=runtime.assessment_input.assessment.sha256;
  const {policy,registry,source_receipts,interpretation_receipts,test_receipts}=runtime.assessment_input;
  const configBody={schema_version:'tivdoc-ai-release-configuration-v1',configuration_id:'33333333-3333-4333-8333-333333333333',revision:1,population:scope.population,
   build_manifest_sha256:'4'.repeat(64),policy,registry,source_receipts,interpretation_receipts,test_receipts};
  const trusted_generator_pins=AI_RELEASE_RUNTIME_FAMILIES.map(f=>{
   const pin=runtime.trusted_generator_pins.find(p=>p.family_id===f.family_id);
   if(!pin||pin.generator.id!==f.generator_id||pin.generator.version!==f.generator_version)throw Error('SYNTHETIC_GENERATOR_PIN_MISMATCH');
   return {family_id:f.family_id,generator:{id:f.generator_id,version:f.generator_version,code_sha256:pin.generator.code_sha256}};
  });
  const profile:SavedAiReleaseConfiguration={configuration:aiReleaseConfigurationSchema.parse({...configBody,sha256:canonicalSha256(configBody)}),trusted_generator_pins,
   enrollment_id:'55555555-5555-4555-8555-555555555555',dependency_sha256:s.job.authority_dependency_sha256,profile_sha256:'6'.repeat(64),
   evaluated_at:runtime.assessment_input.current.evaluated_at,live_evaluated_at:runtime.assessment_input.current.evaluated_at,expires_at:policy.expires_at,environment:'development',is_qa:true};
  vi.mocked(loadSavedAiReleaseConfiguration).mockResolvedValue(profile);
  reviewPorts.sha256=canonicalSha256(source);
  const key=documentReviewIdempotencyKey(savedAiReleaseBaseKey(s.job,s.order.id,'2026-06',profile),reviewPorts.sha256);
  const command={...s.receipts[0].command,case_id:s.job.case_id,idempotency_key:key,document_review_sha256:reviewPorts.sha256,population:scope.population,
   requested_topics:['pension'] as const,period:{start_date:'2026-06-01',end_date:'2026-06-30'}};
  const envelope=createCaseAnalysisAiRelease(runtime,{engine_case_revision:command.case_revision,source_journal:{case_id:s.job.case_id,input_revision:s.job.revision,input_sha256:s.job.input_sha256}});
  const body:Omit<AnalysisResultBundle,'result_sha256'>={schema_version:'tivdoc-analysis-result-bundle-v0.6.0',analysis_run_id:runtime.analysis_run_id,case_id:s.job.case_id,
   case_revision:command.case_revision,period:command.period,as_of:command.as_of,document_snapshot_sha256:command.document_snapshot_sha256,
   extraction_snapshot_sha256:command.extraction_snapshot_sha256,declared_fact_snapshot_sha256:command.declared_fact_snapshot_sha256,facts_snapshot_sha256:scope.facts_sha256,
   facts:[],rule_inputs:[],catalog_sha256:'7'.repeat(64),topic_results:[{topic:'pension',status:'blocked_legal_readiness',blockers:['synthetic outer catalog'],rule_input_sha256:null,amount:null,trace:null,legal_readiness:null}],
   known_subtotal:null,coverage_complete:false,document_review:envelope.result.review,ai_release:envelope};
  const bundle={...body,result_sha256:canonicalSha256(body)};
  const report=await new FixtureReportBuilder({hashCanonical:canonicalSha256,hashBytes:bytesSha256},{derive:(_kind,hash)=>`report-${hash}`}).build(bundle);
  const completion={bundle,report:encodeReport(report),dependencies:{code_version:CASE_ANALYSIS_AI_RELEASE_CODE_VERSION,template_version:AI_RELEASE_REPORT_TEMPLATE}};
  const receipt={idempotency_key:key,analysis_run_id:runtime.analysis_run_id,command,command_sha256:canonicalSha256(command),result_sha256:bundle.result_sha256,
   report_id:report.report_id,report_revision:report.report_revision,report_sha256:report.report_sha256,completion};
  s.responses.saved_job_month_receipts=[receipt];s.responses.saved_job_replay_month_receipts=[receipt];
  return {...s,profile,receipt,envelope};
 }
 it('finishes a source-bound AI result using the same profile key and never selects June authority',async()=>{
  const s=await aiSetup(),first=await completeSavedDraftJob(s.input);
  expect(first.manifest.months).toHaveLength(1);expect(first.manifest.months[0].analysis_run_id).toBe(s.receipt.analysis_run_id);
  expect(s.calls.some(c=>c.name.startsWith('june_'))).toBe(false);expect(vi.mocked(loadSavedAiReleaseConfiguration)).toHaveBeenCalledTimes(2);
  s.row.state='succeeded';s.row.terminal_effect_sha256=first.sha256;s.responses.saved_job_manifest_replay=[{payload:first.manifest,payload_sha256:first.sha256}];s.calls.length=0;
  const replay=await completeSavedDraftJob(s.input);expect(replay).toEqual({...first,replayed:true});
  expect(s.calls.some(c=>c.name==='saved_job_complete_atomic'||c.name==='saved_job_month_receipts')).toBe(false);
 });
 it('never acknowledges a cached AI receipt with a different current profile',async()=>{
  const s=await aiSetup();vi.mocked(loadSavedAiReleaseConfiguration).mockResolvedValueOnce(s.profile).mockResolvedValueOnce({...s.profile,profile_sha256:'9'.repeat(64)});
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('AI_RELEASE_CONFIGURATION_CHANGED');expect(s.calls.some(c=>c.name==='saved_job_complete_atomic')).toBe(false);
 });
 it.each(['expired','revoked','absent','disabled'] as const)('does not replay a terminal AI result whose profile is %s',async(kind)=>{
  const s=await aiSetup(),first=await completeSavedDraftJob(s.input);s.row.state='succeeded';s.row.terminal_effect_sha256=first.sha256;
  s.responses.saved_job_manifest_replay=[{payload:first.manifest,payload_sha256:first.sha256}];s.calls.length=0;
  if(kind==='expired')vi.mocked(loadSavedAiReleaseConfiguration).mockResolvedValue({...s.profile,live_evaluated_at:'2026-09-14T00:00:00Z'});
  if(kind==='absent')vi.mocked(loadSavedAiReleaseConfiguration).mockResolvedValue(null);
  if(kind==='revoked'||kind==='disabled')vi.mocked(loadSavedAiReleaseConfiguration).mockRejectedValue(Error(`AI_RELEASE_${kind.toUpperCase()}`));
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow(/AI_RELEASE|SAVED_JOB_AI/);
  expect(s.calls.some(c=>c.name==='saved_job_complete_atomic'||c.name==='saved_job_month_receipts')).toBe(false);
 });
 it.each(['envelope absent','wrong order','wrong source','wrong report bytes'] as const)('rejects AI %s before terminal mutation',async(kind)=>{
  const s=await aiSetup();
  if(kind==='envelope absent')Reflect.deleteProperty(s.receipt.completion.bundle,'ai_release');
  if(kind==='wrong order')s.order.offer_sha256='9'.repeat(64);
  if(kind==='wrong source')s.job.input_sha256='9'.repeat(64);
  if(kind==='wrong report bytes')s.receipt.completion.report={...s.receipt.completion.report,pdf_base64:Buffer.from('changed').toString('base64')};
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow();expect(s.calls.some(c=>c.name==='saved_job_complete_atomic')).toBe(false);
 });
});

describe('saved terminal receipt replay across authority dependency changes',()=>{
 async function terminal(){
  const s=setup();
  s.job.authority_dependency_sha256='1'.repeat(64);s.row.payload_sha256=canonicalSha256(s.job);
  s.order.from='2026-06-01';s.order.to='2026-06-01';s.order.topics=['minimum_wage'];
  const key=documentReviewIdempotencyKey(june2026RegularReviewIdempotencyKey(s.job,s.order.id),reviewPorts.sha256);
  const command={...s.receipts[0].command,idempotency_key:key,requested_topics:['minimum_wage'],period:{start_date:'2026-06-01',end_date:'2026-06-30'}};
  const receipt={...s.receipts[0],idempotency_key:key,command,command_sha256:canonicalSha256(command)};
  s.responses.saved_job_month_receipts=[receipt];s.responses.saved_job_replay_month_receipts=[receipt];
  s.responses.june_test_authority=[{authority:null}];s.responses.june_regular_authority=[{authority:null}];
  const first=await completeSavedDraftJob(s.input);
  s.row.state='succeeded';s.row.terminal_effect_sha256=first.sha256;s.row.lease_valid=false;
  s.responses.saved_job_manifest_replay=[{payload:structuredClone(first.manifest),payload_sha256:first.sha256}];
  // Any current authority lookup is an unexpected SQL call on replay. A new
  // token may select a different run, but it cannot rewrite this old receipt.
  delete s.responses.june_test_authority;delete s.responses.june_regular_authority;
  delete s.responses.saved_job_month_receipts;delete s.responses.saved_job_complete_atomic;
  s.calls.length=0;vi.mocked(admitSavedSource).mockClear();
  return {...s,first,receipt};
 }
 it('returns the original bytes without fresh authority, admission, analysis or terminal writes',async()=>{
  const s=await terminal();
  const result=await completeSavedDraftJob(s.input);
  expect(result).toEqual({...s.first,replayed:true});
  expect(JSON.stringify(result.manifest)).toBe(JSON.stringify(s.first.manifest));
  expect(result.manifest.source.authority_dependency_sha256).toBe('1'.repeat(64));
  expect(admitSavedSource).not.toHaveBeenCalled();
  expect(s.calls.map(call=>call.name)).toEqual(['saved_job_read','saved_job_replay_authority','saved_job_replay_case_lock',
   'saved_job_replay_source_head','saved_job_lock','saved_order_entitlements','saved_job_manifest_replay','saved_job_replay_month_receipts']);
  const read=s.calls.find(call=>call.name==='saved_job_replay_month_receipts')!;
  expect(JSON.parse(String(read.values[2]))).toEqual([s.receipt.analysis_run_id]);
  expect(read.text).toContain("ar.status='completed'");expect(read.text).toContain('r.analysis_result_sha256=');
  expect(s.calls.find(call=>call.name==='saved_job_replay_source_head')!.text).not.toContain('authority_dependency');
 });
 it.each(['foreign tenant','wrong principal','missing authority','missing case','new revision','new source','revoked entitlement','stale fence','cancelled','no longer terminal'] as const)
 ('rejects %s before returning a historical receipt',async(defect)=>{
  const s=await terminal();
  if(defect==='foreign tenant')s.responses.saved_job_replay_authority[0].tenant_id='saved-case:foreign';
  if(defect==='wrong principal')s.responses.saved_job_replay_authority[0].principal='tivdoc_web_runtime';
  if(defect==='missing authority')s.responses.saved_job_replay_authority=[];
  if(defect==='missing case')s.responses.saved_job_replay_case_lock=[];
  if(defect==='new revision')s.responses.saved_job_replay_source_head[0].revision=2;
  if(defect==='new source')s.responses.saved_job_replay_source_head[0].input_sha256='f'.repeat(64);
  if(defect==='revoked entitlement')s.responses.saved_order_entitlements[0].current_orders=[];
  if(defect==='stale fence')s.row.fencing_token++;
  if(defect==='cancelled')s.row.cancellation_requested=true;
  if(defect==='no longer terminal')s.responses.saved_job_lock=[{...s.row,state:'running'}];
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow(/SAVED_(WORKER_SCOPE_FORBIDDEN|JOB_SCOPE|ORDER_ENTITLEMENT_REQUIRED|JOB_FENCE)|ANALYSIS_INPUT_SUPERSEDED/);
  expect(admitSavedSource).not.toHaveBeenCalled();
  expect(s.calls.some(call=>call.name==='saved_job_replay_month_receipts')).toBe(false);
 });
 it.each(['job','dependency','offer','month','duplicate run','unexpected member'] as const)('rejects a rehashed manifest with altered %s bindings',async(defect)=>{
  const s=await terminal(),manifest={...structuredClone(s.first.manifest),months:s.first.manifest.months.map(month=>({...month}))};
  if(defect==='job')manifest.job_id='other-job';
  if(defect==='dependency')manifest.source.authority_dependency_sha256='2'.repeat(64);
  if(defect==='offer')manifest.months[0].offer_sha256='f'.repeat(64);
  if(defect==='month')manifest.months[0].month='2026-05';
  if(defect==='duplicate run')manifest.months.push(manifest.months[0]);
  const candidate=defect==='unexpected member'?{...manifest,approval:'current'}:manifest;
  const hash=canonicalSha256(candidate);s.row.terminal_effect_sha256=hash;
  s.responses.saved_job_manifest_replay=[{payload:candidate,payload_sha256:hash}];
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('SAVED_JOB_MANIFEST_MISMATCH');
 });
 it.each(['missing','duplicate','foreign run','result','report','report revision','report hash','command case','command hash','command topics'] as const)
 ('rejects changed historical %s receipts',async(defect)=>{
  const s=await terminal();
  if(defect==='missing')s.responses.saved_job_replay_month_receipts=[];
  if(defect==='duplicate')s.responses.saved_job_replay_month_receipts.push(s.receipt);
  if(defect==='foreign run')s.receipt.analysis_run_id='foreign-run';
  if(defect==='result')s.receipt.result_sha256='f'.repeat(64);
  if(defect==='report')s.receipt.report_id='foreign-report';
  if(defect==='report revision')s.receipt.report_revision++;
  if(defect==='report hash')s.receipt.report_sha256='f'.repeat(64);
  if(defect==='command case')s.receipt.command.case_id='22222222-2222-4222-8222-222222222222';
  if(defect==='command topics')s.receipt.command.requested_topics=['vacation'];
  if(defect.startsWith('command'))s.receipt.command_sha256=defect==='command hash'?'f'.repeat(64):canonicalSha256(s.receipt.command);
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow(/SAVED_JOB_(MONTHS_INCOMPLETE|RECEIPT_SCOPE)/);
 });
 it('does not bypass the authority-dependency fence for nonterminal work',async()=>{
  const s=setup();vi.mocked(admitSavedSource).mockRejectedValueOnce(new Error('ANALYSIS_AUTHORITY_SUPERSEDED'));
  await expect(completeSavedDraftJob(s.input)).rejects.toThrow('ANALYSIS_AUTHORITY_SUPERSEDED');
  expect(s.calls.map(call=>call.name)).toEqual(['saved_job_read']);
 });
});
