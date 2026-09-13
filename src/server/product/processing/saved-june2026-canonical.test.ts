import {createHash,randomUUID} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {prepareJune2026AdmittedContext} from '@/engine/minimum-wage-june2026/admitted-context';
import {createAdmissionTestFixture,createTestAssessment,admissionTestNow} from '@/engine/minimum-wage-june2026/evidence-admission.test-fixtures';
import {June2026IsolatedTestCatalog} from '@/engine/minimum-wage-june2026/test-catalog';
import {createJune2026MinimumWageCandidate} from '@/engine/minimum-wage-june2026/candidate';
import {JUNE2026_MINIMUM_WAGE_POLICY} from '@/engine/minimum-wage-june2026/sources';
import type {AnalysisResultBundle} from '@/engine/wave3/contracts';
import type {PostgresStatement,PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {loadJune2026TestAuthority,type June2026TestAuthority} from './saved-june2026-test-authority';
import {SavedJune2026CanonicalRuntime,JUNE2026_CANONICAL_TEST_TEMPLATE} from './saved-june2026-canonical';
import type {SavedJune2026AdmittedContext} from './saved-june2026-admitted-context';
import type {SourceJob} from './source-dispatch';

vi.mock('server-only',()=>({}));

// Pure unit boundary: the transaction below returns an explicitly mocked
// registry row. No SQL executes and no real authority, OCR or publication is
// claimed. Arithmetic, source trace and report rendering are the actual code.
async function fixture(){
 const f=createAdmissionTestFixture(),context=prepareJune2026AdmittedContext(f.input),packet=f.packet(),assessment=createTestAssessment(packet);
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:f.facts.case_id,revision:context.current.input_revision,
  input_sha256:context.current.input_sha256,mode:'draft'};
 const row={assessment,assessment_sha256:canonicalSha256(assessment),evaluated_at:admissionTestNow};
 const query=vi.fn(async(sql:PostgresStatement)=>{
  expect(sql.name).toBe('june_test_authority');
  expect(sql.values).toEqual([job.case_id,assessment.order_id,job.revision,job.input_sha256]);
  return {rows:[{authority:row}],row_count:1};
 });
 const transaction:PostgresTransactionContext={client:{query},transaction_id:'explicit-mock-transaction'};
 const authority=await loadJune2026TestAuthority(transaction,job,assessment.order_id);
 if(!authority)throw Error('TEST_MOCK_AUTHORITY_REQUIRED');
 const runtime=new SavedJune2026CanonicalRuntime(authority,job,assessment.order_id);
 // The real saved loader is deliberately outside this unit test. Its tested
 // pure context/packet are used here, without inventing DB/provenance receipts.
 const loaded={state:'context_loaded',context,admission_assessment:packet,facts:f.facts} as unknown as SavedJune2026AdmittedContext;
 const selection=await new June2026IsolatedTestCatalog(assessment).resolve({mode:'synthetic_test',topic:'minimum_wage',target_date:'2026-06-30',as_of:'2026-09-10',
  sector:JUNE2026_MINIMUM_WAGE_POLICY.sector,population:JUNE2026_MINIMUM_WAGE_POLICY.population});
 const executionInput={selection,rule_input:context.rule_input,execution_id:randomUUID(),calculated_at:admissionTestNow};
 return {...f,context,packet,assessment,job,row,query,transaction,authority,runtime,loaded,selection,executionInput};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
type Execution=Awaited<ReturnType<SavedJune2026CanonicalRuntime['execute']>>;
function bundle(f:Fixture,execution:Execution|null):AnalysisResultBundle{
 const body:Omit<AnalysisResultBundle,'result_sha256'>={schema_version:'tivdoc-analysis-result-bundle-v0.6.0',
  analysis_run_id:f.facts.analysis_run_id,case_id:f.job.case_id,case_revision:f.job.revision,period:{start_date:'2026-06-01',end_date:'2026-06-30'},as_of:'2026-09-10',
  document_snapshot_sha256:f.checkpoint.input_sha256,extraction_snapshot_sha256:f.checkpoint.result_sha256,declared_fact_snapshot_sha256:canonicalSha256(f.collection),
  facts_snapshot_sha256:canonicalSha256(f.facts),facts:f.facts.facts,rule_inputs:[f.context.rule_input],catalog_sha256:f.selection.catalog_sha256,
  topic_results:[{topic:'minimum_wage',status:execution?'calculated':'blocked_missing_facts',blockers:execution?[]:['preflight:context_blocked'],
   rule_input_sha256:f.context.rule_input.snapshot_sha256,amount:execution?.amount??null,trace:execution?.trace??null,legal_readiness:f.selection.readiness}],
  known_subtotal:execution?.amount??null,coverage_complete:execution!==null};
 return {...body,result_sha256:canonicalSha256(body)};
}
function pdfLogicalText(bytes:Uint8Array){
 return [...Buffer.from(bytes).toString('latin1').matchAll(/\/ActualText <FEFF([0-9A-F]+)>/gu)]
  .map(match=>String.fromCharCode(...match[1].match(/.{4}/gu)!.map(hex=>parseInt(hex,16)))).join(' ').replace(/\s+/gu,' ');
}
const hashBytes=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');

describe('saved June2026 canonical runtime contract (mocked authority boundary)',()=>{
 it('rejects a plain or cloned approval-shaped object that never acquired the private loader brand',async()=>{
  const f=await fixture();
  expect(()=>new SavedJune2026CanonicalRuntime(f.row as June2026TestAuthority,f.job,f.assessment.order_id)).toThrow('JUNE_TEST_AUTHORITY_REQUIRED');
  expect(()=>new SavedJune2026CanonicalRuntime(structuredClone(f.authority),f.job,f.assessment.order_id)).toThrow('JUNE_TEST_AUTHORITY_REQUIRED');
  expect(()=>new SavedJune2026CanonicalRuntime(f.authority,{...f.job,case_id:randomUUID()},f.assessment.order_id)).toThrow('JUNE_TEST_AUTHORITY_REQUIRED');
  expect(()=>new SavedJune2026CanonicalRuntime(f.authority,f.job,randomUUID())).toThrow('JUNE_TEST_AUTHORITY_REQUIRED');
  expect(()=>new SavedJune2026CanonicalRuntime(f.authority,{...f.job,revision:f.job.revision+1},f.assessment.order_id)).toThrow('JUNE_TEST_AUTHORITY_REQUIRED');
 });

 it('rejects a corrupt registry row and treats no assessment as no authority',async()=>{
  const f=await fixture();
  const corrupt:PostgresTransactionContext={transaction_id:'explicit-corrupt-mock',client:{query:async()=>({rows:[{authority:{...f.row,assessment_sha256:'f'.repeat(64)}}],row_count:1})}};
  await expect(loadJune2026TestAuthority(corrupt,f.job,f.assessment.order_id)).rejects.toThrow('JUNE_TEST_AUTHORITY_HASH');
  const absent:PostgresTransactionContext={transaction_id:'explicit-absent-mock',client:{query:async()=>({rows:[{authority:null}],row_count:1})}};
  await expect(loadJune2026TestAuthority(absent,f.job,f.assessment.order_id)).resolves.toBeNull();
 });

 it('executes the actual unchanged rule and binds 24058, source and run to matching JSON/HTML/PDF bytes',async()=>{
  const f=await fixture();f.runtime.prepare(f.loaded);
  expect(f.runtime.blockers()).toBeNull();
  const execution=await f.runtime.execute(f.executionInput),candidate=createJune2026MinimumWageCandidate(1);
  expect(execution.amount).toEqual({currency:'ILS',minor_units:24058});
  expect(execution.trace.rule_package).toEqual(candidate.rule);
  expect(execution.trace.parameters).toEqual(candidate.parameters);
  expect(execution.trace.analysis_run_id).toBe(f.facts.analysis_run_id);
  expect(f.runtime.comparison).toMatchObject({schema_version:'tivdoc-source-monetary-comparison-v2',expected:{minor_units:354058},recorded:{minor_units:330000},signed_difference:{minor_units:24058}});
  const result=bundle(f,execution),report=await f.runtime.build(result);
  const json=JSON.parse(Buffer.from(report.json).toString('utf8')),html=Buffer.from(report.html).toString('utf8'),pdf=pdfLogicalText(report.pdf);
  expect(json).toMatchObject({schema_version:JUNE2026_CANONICAL_TEST_TEMPLATE,authority:'isolated_dev_test_assumptions',human_approval:false,legal_activation:false});
  expect(json.bundle).toEqual(result);expect(json.comparison).toEqual(f.runtime.comparison);expect(json.admission).toEqual(f.runtime.admission);
  for(const exact of ['3540.58 ILS','3300.00 ILS','240.58 ILS',f.facts.analysis_run_id,f.assessment.document_version_id,f.assessment.document_sha256,execution.trace.trace_sha256]){
   expect(html).toContain(exact);expect(pdf).toContain(exact);
  }
  expect(html).toContain('אין אישור מקצועי אנושי');expect(pdf).toContain('אין אישור מקצועי אנושי');
  expect(report.analysis_result_sha256).toBe(result.result_sha256);
  for(const [bytes,hash] of [[report.json,report.json_sha256],[report.html,report.html_sha256],[report.pdf,report.pdf_sha256],[report.manifest,report.manifest_sha256]] as const)
   expect(hashBytes(bytes)).toBe(hash);
  const manifest=JSON.parse(Buffer.from(report.manifest).toString('utf8'));
  expect(manifest).toMatchObject({analysis_run_id:f.facts.analysis_run_id,json_sha256:report.json_sha256,html_sha256:report.html_sha256,pdf_sha256:report.pdf_sha256});
  const retried=await f.runtime.execute(f.executionInput);expect(retried).toEqual(execution);
  expect(await f.runtime.build(result)).toEqual(report);
  expect(f.query).toHaveBeenCalledTimes(1);
 });

 it('refuses an altered rule input, real mode or changed selected rule before executing',async()=>{
  const f=await fixture();f.runtime.prepare(f.loaded);
  await expect(f.runtime.execute({...f.executionInput,rule_input:{...f.executionInput.rule_input,snapshot_sha256:'f'.repeat(64)}})).rejects.toThrow('JUNE_CANONICAL_EXECUTOR_DENIED');
  for(const selection of [{...f.selection,mode:'real' as const},{...f.selection,rule_spec_version:'99.0.0'},
   {...f.selection,rule_spec_id:'another.rule'},{...f.selection,catalog_id:'another.catalog'}])
   await expect(f.runtime.execute({...f.executionInput,selection})).rejects.toThrow('JUNE_CANONICAL_EXECUTOR_DENIED');
  expect(f.runtime.comparison).toBeNull();
 });

 it('refuses a report for a different run, case, facts hash or execution trace',async()=>{
  const f=await fixture();f.runtime.prepare(f.loaded);
  const execution=await f.runtime.execute(f.executionInput),result=bundle(f,execution);
  for(const changed of [{...result,analysis_run_id:randomUUID()},{...result,case_id:randomUUID()},{...result,facts_snapshot_sha256:'f'.repeat(64)}])
   await expect(f.runtime.build(changed)).rejects.toThrow('JUNE_CANONICAL_REPORT_RUN_BINDING');
  await expect(f.runtime.build({...result,topic_results:[{...result.topic_results[0],trace:null}]})).rejects.toThrow('JUNE_CANONICAL_REPORT_TRACE_BINDING');
 });

 it('renders an explicit blocked report for an unsupported context, bound to that exact run without fabricated amounts',async()=>{
  const f=await fixture();
  f.runtime.prepare({schema_version:'saved-june2026-factual-context-v1',state:'context_blocked',code:'legacy_source_page_count',
   case_id:f.job.case_id,analysis_run_id:f.facts.analysis_run_id,legal_activation:false,publication_allowed:false});
  expect(f.runtime.blockers()).toMatchObject({status:'blocked_missing_facts',blockers:['preflight:context_blocked']});
  await expect(f.runtime.execute(f.executionInput)).rejects.toThrow('JUNE_CANONICAL_EXECUTOR_DENIED');
  const result=bundle(f,null),report=await f.runtime.build(result),json=JSON.parse(Buffer.from(report.json).toString('utf8'));
  expect(json).toMatchObject({comparison:null,admission:{execution_allowed:false,human_approval:false,legal_activation:false,
   preflight:{state:'context_blocked',code:'legacy_source_page_count'}},bundle:{analysis_run_id:f.facts.analysis_run_id,known_subtotal:null}});
  const html=Buffer.from(report.html).toString('utf8'),pdf=pdfLogicalText(report.pdf);
  expect(html).toContain(f.facts.analysis_run_id);expect(pdf).toContain(f.facts.analysis_run_id);
  expect(html).toContain('לא חושב');expect(pdf).toContain('לא חושב');
  expect(html).not.toContain('240.58 ILS');expect(pdf).not.toContain('240.58 ILS');
  await expect(f.runtime.build({...result,analysis_run_id:randomUUID()})).rejects.toThrow('JUNE_CANONICAL_REPORT_RUN_BINDING');
 });
});
