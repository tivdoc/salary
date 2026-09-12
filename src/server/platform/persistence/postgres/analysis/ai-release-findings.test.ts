import {beforeAll,describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {runtimeFixture} from '@/engine/ai-release-runtime/runtime.fixture';
import {prepareAiReleaseRuntime} from '@/engine/ai-release-runtime/generator-manifest';
import {fixture as sourceFixture} from '@/engine/entitlement-review/compose.fixture';
import {composeEntitlementReview} from '@/engine/entitlement-review/compose';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {CaseAnalysisService,type CaseAnalysisAiReleaseContext} from '@/engine/case-analysis/service';
import type {PersistedCaseAnalysisRun,StoredCaseInputSnapshot} from '@/engine/case-analysis/contracts';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {FixedClock,FixtureReportBuilder} from '@/engine/case-analysis/fixture-ports';
import {createIntegratedFullSystemHarness} from '@/server/engine/case-analysis/integrated-harness';
import type {PostgresQueryResult,PostgresStatement} from '../contracts';
import {createPostgresAnalysisRepositories} from './index';

// The fixtures go through the ordinary service and fixed AI runtime. The
// transport is a recording unit fake, not a database or authorization proof.
async function ordinaryRun(ai:boolean){
 const source=composeEntitlementReview(documentReviewInputSchema.parse(JSON.parse(JSON.stringify(sourceFixture().input)
  .replaceAll('synthetic.entitlement.doc','44444444-4444-4444-8444-444444444444'))));
 const base=buildSyntheticCaseFixture({fixture_id:'ai-findings-persistence',mode:'real'}),empty=canonicalSha256([]);
 const stored:StoredCaseInputSnapshot={...base.stored,documents:[],extractions:[],document_snapshot_sha256:empty,extraction_snapshot_sha256:empty,
  declared_fact_snapshot:{...base.stored.declared_fact_snapshot,facts:[],snapshot_sha256:empty},document_review_input:source,
  source_journal:{case_id:source.case_id,input_revision:79,input_sha256:canonicalSha256({synthetic:'source head'})}};
 const command={...base.command,case_id:source.case_id,case_revision:11,document_snapshot_sha256:empty,extraction_snapshot_sha256:empty,
  declared_fact_snapshot_sha256:empty,period:{start_date:source.period.from,end_date:source.period.to},population:'general_private_adult_21_59',
  as_of:'2026-09-12',document_review_sha256:canonicalSha256(source)};
 const h=createIntegratedFullSystemHarness([stored]);
 const issue=async(context:CaseAnalysisAiReleaseContext)=>{
  const value=runtimeFixture(source);value.analysis_run_id=context.analysis_run_id;
  value.assessment_input.current.scope={...value.assessment_input.current.scope,facts_sha256:context.facts_snapshot_sha256,
   input_revision:79,input_sha256:stored.source_journal!.input_sha256,population:command.population};
  value.assessment_input.assessment.scope=value.assessment_input.current.scope;
  const prepared=prepareAiReleaseRuntime({source,analysis_run_id:value.analysis_run_id,trusted_generator_pins:value.trusted_generator_pins});
  value.assessment_input.current.expected_generated_rules=structuredClone(prepared.expected_generated_rules);
  for(const branch of value.assessment_input.assessment.branches){
   const expected=prepared.expected_generated_rules.find(r=>r.branch_id===branch.branch_id)!;
   branch.rule_sha256=expected.rule_sha256;branch.parameter_set_sha256=expected.parameter_set_sha256;
   branch.generated_from={generator:expected.generator,source_evidence_sha256:expected.source_evidence_sha256};
  }
  const {sha256,...body}=value.assessment_input.assessment;void sha256;
  value.assessment_input.assessment.sha256=canonicalSha256(body);value.assessment_input.current.assessment_sha256=value.assessment_input.assessment.sha256;
  return {assessment_input:value.assessment_input,trusted_generator_pins:value.trusted_generator_pins};
 };
 const service=new CaseAnalysisService({...h,clock:new FixedClock('2026-09-12T10:00:00Z'),reportBuilder:new FixtureReportBuilder(h.hashes,h.ids),
  reportRegistration:h.review,templateVersion:'synthetic-ai-findings-v1',...(ai?{prepareAiRelease:issue}:{})});
 const bundle=await service.runCaseAnalysis(command),run=await service.getCompletedRun(bundle.analysis_run_id);
 if(!run?.bundle||!run.report||!run.dependencies)throw Error('SYNTHETIC_COMPLETED_RUN_REQUIRED');
 return {...run,bundle:run.bundle,report:run.report,dependencies:run.dependencies};
}
type Fixture=Awaited<ReturnType<typeof ordinaryRun>>;
let ai:Fixture,legacy:Fixture;
beforeAll(async()=>{ai=await ordinaryRun(true);legacy=await ordinaryRun(false);});
type Row=Record<string,unknown>;
const rows=(value:readonly Row[]):PostgresQueryResult=>({rows:value,row_count:value.length});
function recording(f:Fixture=ai,mutate?:(rows:Row[])=>void,reply?:(normal:Row)=>PostgresQueryResult){
 const statements:PostgresStatement[]=[],manifest=canonicalSha256(f.bundle.ai_release?.result.findings??[]);
 const stages=f.stages.filter(s=>['input_snapshot','canonical_facts','analysis_run','topic_results'].includes(s.stage))
  .map(stage=>({...structuredClone(stage),command_payload:f.command,command_sha256:f.command_sha256,case_revision:String(f.command.case_revision)}));
 const mutable:Row[]=stages;mutate?.(mutable);
 const repositories=createPostgresAnalysisRepositories({transaction_id:'synthetic.finding.transaction',client:{query:async q=>{
  statements.push(q);
  if(q.name==='analysis_ai_finding_stages')return rows(mutable);
  if(q.name==='analysis_ai_findings_record'){
   const normal={result:{finding_count:f.bundle.ai_release?.result.findings.length??0,manifest_sha256:manifest}};
   return reply?reply(normal):rows([normal]);
  }
  if(q.name==='analysis_run_complete')return rows([{canonical_analysis_run_id:f.analysis_run_id}]);
  throw Error('UNEXPECTED_SQL:'+q.name);
 }}},'synthetic.finding.tenant');
 return {repositories,repository:repositories.traceFindings,statements};
}
function alterStage(values:Row[],name:string,change:(body:Row)=>void){
 const row=values.find(r=>r.stage===name)!;
 if(typeof row.payload!=='object'||row.payload===null||Array.isArray(row.payload))throw Error('FIXTURE_STAGE');
 const payload:Row={...row.payload};change(payload);row.payload=payload;row.payload_sha256=canonicalSha256(payload);
}

describe('qualified AI findings use the persisted source and private RPC',()=>{
 it('passes only run/bundle/envelope pins after independently replaying three monetary findings',async()=>{
  const r=recording();await r.repository.persistAiReleaseFindings({bundle:ai.bundle});
  expect(ai.bundle.ai_release?.result.findings).toHaveLength(3);
  expect(ai.bundle.ai_release?.result.findings.map(f=>f.expected)).toEqual([
   {kind:'money',currency:'ILS',minor_units:30000},{kind:'money',currency:'ILS',minor_units:32500},{kind:'money',currency:'ILS',minor_units:30000}]);
  expect(r.statements.map(q=>q.name)).toEqual(['analysis_ai_finding_stages','analysis_ai_findings_record']);
  expect(r.statements[0].values).toEqual(['synthetic.finding.tenant',ai.analysis_run_id,ai.command.case_id]);
  expect(r.statements[0].text).toContain('ecs.tenant_id=$1');
  expect(r.statements[1].values).toEqual([ai.analysis_run_id,ai.bundle.result_sha256,ai.bundle.ai_release?.sha256]);
  expect(r.statements[1].text).toContain('private.ai_release_findings_record');
  expect(ai.bundle.ai_release?.result.findings.every(f=>f.verified_debt===false&&f.actual_transfer_proven===false)).toBe(true);
 });
 it('retains the disabled legacy boundary without any SQL',async()=>{
  const r=recording(legacy);await expect(r.repository.persistAiReleaseFindings({bundle:legacy.bundle})).rejects.toThrow('FINDINGS_DISABLED');
  expect(()=>r.repository.persistFindingDisabled(ai.bundle)).toThrow('FINDINGS_DISABLED');expect(r.statements).toHaveLength(0);
 });
 it('rejects a forged envelope before reading or writing',async()=>{
  const r=recording(),envelope=ai.bundle.ai_release!;
  const {result_sha256,...body}=ai.bundle;void result_sha256;
  const changed={...body,ai_release:{...envelope,sha256:'0'.repeat(64)}};
  await expect(r.repository.persistAiReleaseFindings({bundle:{...changed,result_sha256:canonicalSha256(changed)}})).rejects.toThrow();
  expect(r.statements).toHaveLength(0);
 });
 it.each(['missing','duplicate','hash','command','revision','journal','source','facts','dependencies','bundle'] as const)('refuses saved %s mismatch before the RPC',async defect=>{
  const r=recording(ai,values=>{
   if(defect==='missing')values.pop();
   if(defect==='duplicate')values[3]={...values[0]};
   if(defect==='hash')values[0].payload_sha256='0'.repeat(64);
   if(defect==='command')values[0].command_sha256='0'.repeat(64);
   if(defect==='revision')values[0].case_revision='79'; // Journal 79 must not replace engine 11.
   if(defect==='journal')alterStage(values,'input_snapshot',p=>{p.source_journal={case_id:ai.command.case_id,input_revision:80,input_sha256:'a'.repeat(64)};});
   if(defect==='source')alterStage(values,'input_snapshot',p=>{p.document_review_input={case_id:'foreign'};});
   if(defect==='facts')alterStage(values,'canonical_facts',p=>{p.facts={facts:[]};});
   if(defect==='dependencies')alterStage(values,'analysis_run',p=>{p.dependencies={...ai.dependencies,code_version:'case-analysis@0.6.7'};});
   if(defect==='bundle')alterStage(values,'topic_results',p=>{p.bundle=legacy.bundle;});
  });
  await expect(r.repository.persistAiReleaseFindings({bundle:ai.bundle})).rejects.toThrow('STAGE_HASH_MISMATCH');
  expect(r.statements.map(q=>q.name)).toEqual(['analysis_ai_finding_stages']);
 });
 it.each(['missing','hash','count','extra'] as const)('refuses an inconsistent immutable RPC receipt: %s',async defect=>{
  const r=recording(ai,undefined,normal=>{
   if(defect==='missing')return rows([]);
   const receipt=normal.result as Row;
   return rows([{result:{...receipt,...(defect==='hash'?{manifest_sha256:'0'.repeat(64)}:defect==='count'?{finding_count:4}:{extra:'untrusted'})}}]);
  });
  await expect(r.repository.persistAiReleaseFindings({bundle:ai.bundle})).rejects.toThrow();
  expect(r.statements).toHaveLength(2);
 });
 it('retries with precisely the same immutable manifest, without regenerating a finding payload',async()=>{
  const r=recording();await r.repository.persistAiReleaseFindings({bundle:ai.bundle});await r.repository.persistAiReleaseFindings({bundle:ai.bundle});
  const writes=r.statements.filter(q=>q.name==='analysis_ai_findings_record');expect(writes).toHaveLength(2);expect(writes[0]).toEqual(writes[1]);
 });
 it.each([true,false])('complete chooses AI persistence only for an envelope (AI=%s)',async enabled=>{
  const f=enabled?ai:legacy,r=recording(f),deps=r.repositories;
  const pending:PersistedCaseAnalysisRun={...f,completed:false,bundle:null,report:null,dependencies:null};
  vi.spyOn(deps.caseAnalysis,'getByRunId').mockResolvedValueOnce(pending).mockResolvedValue(f);
  vi.spyOn(deps.legalPins,'persist').mockResolvedValue();vi.spyOn(deps.topicResults,'persistScoped').mockResolvedValue();
  vi.spyOn(deps.traceFindings,'persistTraces').mockResolvedValue();vi.spyOn(deps.reports,'persistReport').mockResolvedValue();
  const qualified=vi.spyOn(deps.traceFindings,'persistAiReleaseFindings').mockResolvedValue();
  const disabled=vi.spyOn(deps.traceFindings,'assertFindingsDisabled').mockResolvedValue();
  const input={analysis_run_id:f.analysis_run_id,selections:f.selections,dependencies:f.dependencies,bundle:f.bundle,report:f.report};
  expect(await deps.caseAnalysis.complete(input)).toEqual(f);
  expect(qualified).toHaveBeenCalledTimes(enabled?1:0);expect(disabled).toHaveBeenCalledTimes(enabled?0:1);
  // A terminal retry has no insertion RPC or extra persistence at all.
  expect(await deps.caseAnalysis.complete(input)).toEqual(f);expect(qualified).toHaveBeenCalledTimes(enabled?1:0);
 });
});
