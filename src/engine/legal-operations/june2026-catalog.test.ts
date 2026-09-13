import {describe,it,expect} from 'vitest';
import {June2026ReviewCatalog,JUNE2026_REVIEW_CATALOG_SHA256} from './june2026-catalog.ts';
import {LegalOperationsCatalog} from './catalog.ts';
import {JUNE2026_SOURCE_VERSION_IDS} from '../minimum-wage-june2026/admission.ts';
import {WAVE3_TOPICS} from '../wave3/contracts.ts';
import {CaseAnalysisService} from '../case-analysis/service.ts';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import {createIntegratedFullSystemHarness} from '../../server/engine/case-analysis/integrated-harness.ts';
import {SavedAnalysisDraftBuilder,SAVED_DRAFT_TEMPLATE} from '../../server/product/processing/saved-draft-report.ts';
import {buildSavedJune2026ReviewDiagnostic} from '../../server/product/processing/saved-minimum-wage-review.ts';

const scope={topic:'minimum_wage' as const,target_date:'2026-06-01',as_of:'2026-09-09',sector:'unverified',population:'unverified',mode:'real' as const};
describe('June2026 acquired sources in the saved canonical catalog',()=>{
 it('pins original source versions while retaining actual unsigned admission blockers',async()=>{
  const selected=await new June2026ReviewCatalog().resolve(scope);
  expect(selected.source_version_ids).toEqual(JUNE2026_SOURCE_VERSION_IDS);
  expect(selected.catalog_sha256).toBe(JUNE2026_REVIEW_CATALOG_SHA256);
  expect(selected.readiness.status).toBe('BLOCKED_NOT_READY');
  expect(selected.readiness.reason_codes).toContain('HUMAN_LEGAL_REVIEW_MISSING');
  expect(selected.readiness.usable_for_rules).toBe(false);
  expect(selected.rule_spec_id).toBeNull();expect(selected.parameter_version_ids).toEqual([]);
 });
 it.each([{target_date:'2026-05-31'},{target_date:'2026-07-01'},{as_of:'2026-09-08'},{mode:'synthetic_test' as const}])('preserves existing selection outside acquired temporal/mode scope: %j',async delta=>{
  const input={...scope,...delta};expect(await new June2026ReviewCatalog().resolve(input)).toEqual(await new LegalOperationsCatalog().resolve(input));
 });
 it('keeps all seven selections under one catalog hash without activating other topics',async()=>{
  const catalog=new June2026ReviewCatalog();
  const selected=await Promise.all(WAVE3_TOPICS.map(topic=>catalog.resolve({...scope,topic})));
  expect(new Set(selected.map(s=>s.catalog_sha256))).toEqual(new Set([JUNE2026_REVIEW_CATALOG_SHA256]));
  expect(selected.every(s=>s.rule_spec_id===null&&!s.readiness.usable_for_rules)).toBe(true);
 });
 it('persists the new source pins through the existing analysis stages and draft builder; never produces a finding',async()=>{
  const fixture=buildSyntheticCaseFixture({fixture_id:'june2026-source-pin-review',mode:'real'});
  const harness=createIntegratedFullSystemHarness([fixture.stored]);
  const service=new CaseAnalysisService({...harness,legalCatalog:new June2026ReviewCatalog(),
   reportRegistration:harness.review,reportBuilder:new SavedAnalysisDraftBuilder(),templateVersion:SAVED_DRAFT_TEMPLATE,reviewDiagnostics:buildSavedJune2026ReviewDiagnostic});
  const command={...fixture.command,period:{start_date:'2026-06-01',end_date:'2026-06-30'},as_of:'2026-09-09',requested_topics:['minimum_wage' as const],sector:'unverified',population:'unverified'};
  const bundle=await service.runCaseAnalysis(command);
  const run=await service.getCompletedRun(bundle.analysis_run_id);
  expect(run?.stages.find(s=>s.stage==='analysis_run')?.payload).toMatchObject({dependencies:{source_version_ids:[...JUNE2026_SOURCE_VERSION_IDS].sort(),catalog_sha256:JUNE2026_REVIEW_CATALOG_SHA256}});
  expect(bundle.topic_results[0].amount).toBeNull();expect(bundle.topic_results[0].trace).toBeNull();
  expect(harness.executor.counters.execute_calls).toBe(0);
  expect(run?.report).not.toBeNull();
  expect(JSON.parse(Buffer.from(run!.report!.json).toString()).publication).toBe('draft');
  expect(run?.stages.find(s=>s.stage==='review_pending')?.payload).toMatchObject({diagnostics:{analysis_run_id:bundle.analysis_run_id,
   candidate_calculation_performed:false,customer_requests_created:false,activation_allowed:false,
   required_applicability_assessments:expect.arrayContaining([{field:'age_18_entire_month',prompt:expect.any(String),status:'missing',value:null}]),
  }});
  expect(await service.runCaseAnalysis(command)).toEqual(bundle);
 });
});
