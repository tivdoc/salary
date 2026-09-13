import {randomUUID} from 'node:crypto';
import {beforeAll,describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {createSourceCalculationTrace} from '@/engine/calculations/source-trace';
import {createAdmissionTestFixture} from '@/engine/minimum-wage-june2026/evidence-admission.test-fixtures';
import {createRegularServiceTrustFixture} from '@/engine/minimum-wage-june2026/regular-service/regular-service.test-fixtures';
import {createJune2026RegularAuthority} from '@/engine/minimum-wage-june2026/regular-service/authority';
import {June2026RegularCatalog} from '@/engine/minimum-wage-june2026/regular-service/catalog';
import {June2026RegularExecutor} from '@/engine/minimum-wage-june2026/regular-service/executor';
import type {June2026RegularSourceAdmission} from '@/engine/minimum-wage-june2026/regular-service/source-admission';
import {JUNE2026_COMPONENT_DECLARATIONS,JUNE2026_DECLARATION_OPTIONS} from '@/engine/minimum-wage-june2026/collection';
import type {AnalysisResultBundle,TopicAnalysisResult} from '@/engine/wave3/contracts';
import type {PostgresStatement,PostgresTransactionContext} from '../contracts';
import {PostgresTraceFindingRepository} from './traces';
import {decodeBundle} from './validation';
vi.mock('server-only',()=>({}));

async function fixture(){
 const f=createAdmissionTestFixture(false),hours=f.facts.facts.find(f=>f.path==='work.regular_hours')!;
 hours.status='needs_confirmation';hours.confidence=0.8;
 hours.provenance=[{source_type:'declared',source_reference:{kind:'case_request_answer',request_id:randomUUID(),answer_revision:1}}];
 f.extraction.fields=f.extraction.fields.filter(f=>f.field!=='regular_hours');f.repin();
 const yes=JUNE2026_DECLARATION_OPTIONS[0],no=JUNE2026_DECLARATION_OPTIONS[1];
 f.addAnswer({kind:'applicability',field:'age_18_entire_month'},yes);f.addAnswer({kind:'applicability',field:'sector'},'Synthetic ordinary office');
 f.addAnswer({kind:'applicability',field:'hours_rest_law_applies'},'Synthetic supervised hourly employee');
 f.addAnswer({kind:'applicability',field:'no_better_minimum_wage_arrangement'},no);f.addAnswer({kind:'applicability',field:'no_adapted_minimum_wage'},no);
 f.addAnswer({kind:'applicability',field:'regular_hours_exclude_absence_overtime_rest'},yes);f.addAnswer({kind:'earnings_completeness'},yes);
 f.addAnswer({kind:'component',componentId:f.component.component_id},JUNE2026_COMPONENT_DECLARATIONS.base_salary);
 const packet=f.packet(),keys=createRegularServiceTrustFixture(),input=keys.input(packet,f.facts),admitted=createJune2026RegularAuthority(input);
 if(admitted.state!=='ready')throw Error(admitted.blockers.join(','));const authority=admitted.authority;
 const selection=await new June2026RegularCatalog(authority).resolve({mode:'synthetic_test',topic:'minimum_wage',target_date:'2026-06-30',as_of:'2026-09-10',sector:'general_private',population:'adult_general'});
 const executor=new June2026RegularExecutor({authority,packet,facts:f.facts});
 const output=await executor.execute({selection,rule_input:packet.rule_input,execution_id:randomUUID(),calculated_at:keys.now});
 const result:TopicAnalysisResult={topic:'minimum_wage',status:'calculated',blockers:[],amount:output.amount,trace:output.trace,
  rule_input_sha256:packet.rule_input.snapshot_sha256,legal_readiness:selection.readiness,source_admission:output.source_admission};
 const seed:Omit<AnalysisResultBundle,'result_sha256'>={schema_version:'tivdoc-analysis-result-bundle-v0.6.0',case_id:f.facts.case_id,analysis_run_id:f.facts.analysis_run_id,
  case_revision:3,period:{start_date:'2026-06-01',end_date:'2026-06-30'},as_of:'2026-09-10',document_snapshot_sha256:f.checkpoint.input_sha256,
  extraction_snapshot_sha256:f.checkpoint.result_sha256,declared_fact_snapshot_sha256:canonicalSha256(f.collection),facts_snapshot_sha256:canonicalSha256(f.facts),
  facts:f.facts.facts,rule_inputs:[packet.rule_input],catalog_sha256:selection.catalog_sha256,topic_results:[result],known_subtotal:output.amount,coverage_complete:true};
 return {f,input,executor,result,trace:executor.result!.trace,proof:output.source_admission!,bundle:{...seed,result_sha256:canonicalSha256(seed)}};
}
let saved:Awaited<ReturnType<typeof fixture>>;
beforeAll(async()=>{saved=await fixture();});
const rehash=(bundle:AnalysisResultBundle)=>{const {result_sha256,...seed}=bundle;void result_sha256;return {...seed,result_sha256:canonicalSha256(seed)};};
const pin=(proof:June2026RegularSourceAdmission)=>{const {binding_sha256,...seed}=proof;void binding_sha256;return {...seed,binding_sha256:canonicalSha256(seed)};};
const withResult=(result:TopicAnalysisResult)=>rehash({...saved.bundle,topic_results:[result]});

describe('versioned persisted declared-hours admission',()=>{
 it('retains parent facts, independently calculated 24058 and signed assessment bytes through JSON replay',()=>{
  const decoded=decodeBundle(JSON.stringify(saved.bundle),['minimum_wage']);
  expect(decoded).toEqual(saved.bundle);expect(decoded.known_subtotal?.minor_units).toBe(24058);
  expect(decoded.facts.find(f=>f.path==='work.regular_hours')?.status).toBe('needs_confirmation');
  expect(saved.trace.facts_snapshot.facts.find(f=>f.path==='work.regular_hours')?.status).toBe('confirmed');
  expect(saved.trace.facts_snapshot_sha256).not.toBe(decoded.facts_snapshot_sha256);
  expect(saved.proof.assessment).toEqual(saved.input.assessment);expect(saved.proof.verification).toBe('signed_assessment_binding_only');
 });
 it('refuses effective facts without the new contract and preserves the original v1 equality guard',()=>{
  const {source_admission,...legacyShape}=saved.result;void source_admission;
  expect(()=>decodeBundle(withResult(legacyShape),['minimum_wage'])).toThrow('ANALYSIS_ROW_MALFORMED');
 });
 it.each(['case','run','parent','effective','parent_input','signature','answer','admission_version'] as const)('refuses %s tampering even after outer bundle/proof hashes are refreshed',defect=>{
  const proof={...structuredClone(saved.proof)};
  if(defect==='case')proof.case_id=randomUUID();if(defect==='run')proof.analysis_run_id=randomUUID();
  if(defect==='parent')proof.parent_facts_sha256='a'.repeat(64);if(defect==='effective')proof.effective_facts_sha256='a'.repeat(64);
  if(defect==='parent_input')proof.parent_rule_input_sha256='a'.repeat(64);
  if(defect==='signature')proof.assessment={...proof.assessment,envelope:{...proof.assessment.envelope,signature_base64:Buffer.alloc(64,2).toString('base64')}};
  if(defect==='answer')proof.assessment.payload.hours_acceptance!.answer_revision++;
  const candidate=defect==='admission_version'?{...pin(proof),schema_version:'unversioned'}:pin(proof);
  const bundle=rehash({...saved.bundle,topic_results:[{...saved.result,source_admission:candidate as June2026RegularSourceAdmission}]});
  expect(()=>decodeBundle(bundle,['minimum_wage'])).toThrow('ANALYSIS_ROW_MALFORMED');
 });
 it('rejects an independently replayable trace that additionally changes another fact',()=>{
  const facts=structuredClone(saved.trace.facts_snapshot);facts.facts.find(f=>f.path==='compensation.gross_salary')!.confidence=0.5;
  const trace=createSourceCalculationTrace({calculationId:saved.trace.calculation_id,caseId:saved.trace.case_id,analysisRunId:saved.trace.analysis_run_id,
   calculatedAt:saved.trace.calculated_at,catalogSha256:saved.trace.catalog_sha256,facts,rule:saved.trace.rule_package,parameters:saved.trace.parameters,
   bindings:saved.trace.inputs.map(i=>({input_id:i.input_id,source:i.source}))});
  const proof=pin({...saved.proof,effective_facts_sha256:trace.facts_snapshot_sha256,effective_rule_input_sha256:trace.rule_input_sha256});
  expect(()=>decodeBundle(withResult({...saved.result,trace,source_admission:proof}),['minimum_wage'])).toThrow('ANALYSIS_ROW_MALFORMED');
 });
});

function repository(defect?:'missing_admission_stage'|'changed_assessment'|'unbound_proof'){
 const execution=saved.executor.result!,admission=execution.admission;
 const diagnostics={schema_version:'saved-june2026-regular-diagnostics-v1',namespace:saved.proof.assessment.payload.namespace,
  authority_sha256:saved.proof.authority_sha256,assessment_sha256:canonicalSha256(saved.input.assessment),admission,execution};
 const records:{stage:string;payload:unknown;payload_sha256:string}[]=[
  {stage:'canonical_facts',payload:{facts:saved.f.facts,facts_snapshot_sha256:saved.bundle.facts_snapshot_sha256},payload_sha256:''},
  {stage:'rule_inputs',payload:{rule_inputs:saved.bundle.rule_inputs},payload_sha256:''},
  {stage:'analysis_run',payload:{dependencies:{facts_snapshot_sha256:saved.bundle.facts_snapshot_sha256,catalog_sha256:saved.bundle.catalog_sha256}},payload_sha256:''},
  {stage:'review_pending',payload:{diagnostics},payload_sha256:''},
 ];
 if(defect==='missing_admission_stage')records.pop();
 if(defect==='changed_assessment')diagnostics.assessment_sha256='b'.repeat(64);
 if(defect==='unbound_proof')records[3].payload={diagnostics:{...diagnostics,execution:{...execution,source_admission:null}}};
 for(const row of records)row.payload_sha256=canonicalSha256(row.payload);
 const queries:PostgresStatement[]=[];
 const context:PostgresTransactionContext={transaction_id:'synthetic.regular.admission',client:{async query(q){queries.push(q);
  if(q.name==='analysis_trace_admitted_source_stages')return {rows:records,row_count:records.length};
  if(q.name==='analysis_trace_insert')return {rows:[{trace_sha256:q.values[6]}],row_count:1};return {rows:[],row_count:0};
 }}};
 return {queries,repo:new PostgresTraceFindingRepository(context,'synthetic.regular.tenant')};
}
it('persists only after binding effective trace to the saved canonical and verified-runtime stages',async()=>{
 const {repo,queries}=repository();await repo.persistTraces({case_id:saved.bundle.case_id,analysis_run_id:saved.bundle.analysis_run_id,
  topic_results:[saved.result],expected_topics:['minimum_wage'],source_scope:saved.bundle});
 expect(queries.map(q=>q.name)).toEqual(['analysis_trace_admitted_source_stages','analysis_trace_insert']);
 expect(queries[0].text).toContain("'review_pending'");
});
it.each(['missing_admission_stage','changed_assessment','unbound_proof'] as const)('refuses %s before trace insert',async defect=>{
 const {repo,queries}=repository(defect);await expect(repo.persistTraces({case_id:saved.bundle.case_id,analysis_run_id:saved.bundle.analysis_run_id,
  topic_results:[saved.result],expected_topics:['minimum_wage'],source_scope:saved.bundle})).rejects.toThrow('STAGE_HASH_MISMATCH');
 expect(queries.map(q=>q.name)).toEqual(['analysis_trace_admitted_source_stages']);
});
