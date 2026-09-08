import {describe,expect,it} from 'vitest';
import {sourceTraceFixture} from '@/engine/calculations/source-trace.fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {AnalysisResultBundle,TopicAnalysisResult} from '@/engine/wave3/contracts';
import {buildCanonicalReport} from '@/server/reports/deterministic-report-builder';
import {PostgresTraceFindingRepository} from './traces';
import {decodeBundle} from './validation';
import type {PostgresStatement,PostgresTransactionContext} from '../contracts';

function fixture(){
 const {trace}=sourceTraceFixture();
 const result:TopicAnalysisResult={topic:'minimum_wage',status:'blocked_legal_readiness',blockers:['ARITHMETIC_ONLY'],amount:null,trace,rule_input_sha256:trace.rule_input_sha256,legal_readiness:null};
 const seed={schema_version:'tivdoc-analysis-result-bundle-v0.6.0' as const,case_id:trace.case_id,analysis_run_id:trace.analysis_run_id,case_revision:1,period:{start_date:'2040-01-01',end_date:'2040-01-31'},as_of:'2040-02-01',
  document_snapshot_sha256:'d'.repeat(64),extraction_snapshot_sha256:'e'.repeat(64),declared_fact_snapshot_sha256:'f'.repeat(64),
  facts_snapshot_sha256:trace.facts_snapshot_sha256,facts:trace.facts_snapshot.facts,rule_inputs:[{snapshot_id:'synthetic.input',snapshot_version:'1.0.0',snapshot_sha256:trace.rule_input_sha256}],catalog_sha256:trace.catalog_sha256,
  topic_results:[result],known_subtotal:null,coverage_complete:false};
 const bundle:AnalysisResultBundle={...seed,result_sha256:canonicalSha256(seed)};
 return {trace,result,bundle};
}
const rehash=(value:AnalysisResultBundle)=>{const {result_sha256,...seed}=value;void result_sha256;return {...seed,result_sha256:canonicalSha256(seed)};};
function recording(defect?:'missing_stage'|'changed_stage'|'different_saved_facts'|'missing_run'){
 const queries:PostgresStatement[]=[],{trace,bundle}=fixture();
 const payloads=[['canonical_facts',{facts:trace.facts_snapshot,facts_snapshot_sha256:trace.facts_snapshot_sha256}],['rule_inputs',{rule_inputs:bundle.rule_inputs}],['analysis_run',{dependencies:{catalog_sha256:bundle.catalog_sha256,facts_snapshot_sha256:bundle.facts_snapshot_sha256}}]] as const;
 const stages=payloads.map(([stage,payload])=>({stage,payload,payload_sha256:canonicalSha256(payload)}));
 if(defect==='missing_stage')stages.pop();
 if(defect==='changed_stage')stages[0].payload_sha256='b'.repeat(64);
 if(defect==='different_saved_facts'){
  const payload={facts:{...trace.facts_snapshot,facts:[]},facts_snapshot_sha256:trace.facts_snapshot_sha256};
  stages[0]={stage:'canonical_facts',payload,payload_sha256:canonicalSha256(payload)};
 }
 const context:PostgresTransactionContext={transaction_id:'synthetic.trace.transaction',client:{async query(query){queries.push(query);
  if(query.name==='analysis_trace_source_stages')return {rows:stages,row_count:stages.length};
  if(query.name==='analysis_trace_insert'&&defect!=='missing_run')return {rows:[{trace_sha256:query.values[6]}],row_count:1};
  return {rows:[],row_count:0};
 }}};return {queries,repository:new PostgresTraceFindingRepository(context,'synthetic.trace.tenant')};
}

describe('saved analysis source trace boundary',()=>{
 it('decodes and replays exact saved operands without inventing a customer finding',()=>{
  const {bundle}=fixture();expect(decodeBundle(JSON.stringify(bundle),['minimum_wage'])).toEqual(bundle);
  expect(bundle.known_subtotal).toBeNull();expect(bundle.topic_results[0].amount).toBeNull();
 });
 it.each(['case','run','snapshot','facts','catalog','input','missing_input','duplicate_input','topic','amount'] as const)('rejects a self-consistent trace spliced into another %s even after bundle rehash',defect=>{
  const b={...structuredClone(fixture().bundle)};
  if(defect==='case')b.case_id='77777777-7777-4777-8777-777777777777';
  if(defect==='run')b.analysis_run_id='88888888-8888-4888-8888-888888888888';
  if(defect==='snapshot')b.facts_snapshot_sha256='b'.repeat(64);
  if(defect==='facts')b.facts=[];
  if(defect==='catalog')b.catalog_sha256='b'.repeat(64);
  if(defect==='input')b.topic_results=[{...b.topic_results[0],rule_input_sha256:'b'.repeat(64)}];
  if(defect==='missing_input')b.rule_inputs=[];
  if(defect==='duplicate_input')b.rule_inputs=[...b.rule_inputs,...b.rule_inputs];
  if(defect==='topic')b.topic_results=[{...b.topic_results[0],topic:'pension'}];
  if(defect==='amount')b.topic_results=[{...b.topic_results[0],amount:{currency:'XTS',minor_units:999}}];
  expect(()=>decodeBundle(rehash(b),[defect==='topic'?'pension':'minimum_wage'])).toThrow('ANALYSIS_ROW_MALFORMED');
 });
 it('requires explicit enclosing pins for a direct repository write and validates before SQL',async()=>{
  const {bundle,result}=fixture(),{repository,queries}=recording();
  const input={case_id:bundle.case_id,analysis_run_id:bundle.analysis_run_id,expected_topics:['minimum_wage'] as const,topic_results:[result]};
  await expect(repository.persistTraces(input)).rejects.toThrow('ANALYSIS_ROW_MALFORMED');
  await expect(repository.persistTraces({...input,source_scope:{...bundle,case_id:'another.case'}})).rejects.toThrow('ANALYSIS_ROW_MALFORMED');
  expect(queries).toHaveLength(0);
  await repository.persistTraces({...input,source_scope:bundle});expect(queries).toHaveLength(2);
  expect(JSON.parse(String(queries[1].values[5]))).toEqual(result.trace);
  expect(queries[1].values.slice(0,3)).toEqual(['synthetic.trace.tenant',bundle.analysis_run_id,bundle.case_id]);
 });
 it.each(['missing_stage','changed_stage','different_saved_facts','missing_run'] as const)('refuses %s from actual persistence instead of trusting caller pins',async defect=>{
  const {bundle,result}=fixture(),{repository,queries}=recording(defect);
  await expect(repository.persistTraces({case_id:bundle.case_id,analysis_run_id:bundle.analysis_run_id,expected_topics:['minimum_wage'],topic_results:[result],source_scope:bundle})).rejects.toThrow(defect==='missing_run'?'IMMUTABLE_COMPLETED_RUN_MISMATCH':'STAGE_HASH_MISMATCH');
  if(defect!=='missing_run')expect(queries.map(q=>q.name)).toEqual(['analysis_trace_source_stages']);
 });
 it('does not let arithmetic provenance enter customer report artifacts or enable findings',()=>{
  const {bundle}=fixture(),{repository}=recording();
  expect(()=>buildCanonicalReport(bundle,'synthetic.trace.report')).toThrow('ARITHMETIC_PROVENANCE_NOT_PUBLISHABLE');
  expect(()=>repository.persistFindingDisabled(bundle)).toThrow('FINDINGS_DISABLED');
 });
});
