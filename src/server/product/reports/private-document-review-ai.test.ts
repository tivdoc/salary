import {beforeAll,beforeEach,describe,it,expect,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {runtimeFixture} from '@/engine/ai-release-runtime/runtime.fixture';
import type {AiReleaseRuntimeInput} from '@/engine/ai-release-runtime/contracts';
import {prepareAiReleaseRuntime} from '@/engine/ai-release-runtime/generator-manifest';
import {fixture as pensionFixture} from '@/engine/entitlement-review/compose.fixture';
import {createCaseAnalysisAiRelease} from '@/engine/case-analysis/contracts';
import {WAVE3_TOPICS,type AnalysisResultBundle} from '@/engine/wave3/contracts';
import type {CaseAccessDb} from '../case-access/db';
import {privateDocumentReviewReports,privateDocumentReviewArtifact} from './private-document-review';

const ports=vi.hoisted(()=>({verify:vi.fn(),build:{synthetic:'compiled singleton'}}));
vi.mock('server-only',()=>({}));
vi.mock('../processing/ai-release-build',()=>({getCompiledAiReleaseBuild:()=>ports.build}));
vi.mock('../processing/ai-release-configuration',()=>({verifyAiReleaseConfiguration:ports.verify}));
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const h=(s:string)=>canonicalSha256({synthetic_reader:s});
const identity=id(1),reportId=id(2),runId=id(3);
const byteHash=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function report(bundle:AnalysisResultBundle){
 const presentation={schema_version:'document-review-presentation-v1',report_id:reportId,analysis_run_id:bundle.analysis_run_id,
  analysis_result_sha256:bundle.result_sha256,report_revision:bundle.case_revision};
 const json=Buffer.from(JSON.stringify(presentation)),html=Buffer.from('<p>synthetic reader boundary</p>'),pdf=Buffer.from('synthetic PDF bytes; rendering is not under test'),manifest=Buffer.from('{}');
 const binding={report_id:reportId,report_revision:bundle.case_revision,analysis_result_sha256:bundle.result_sha256,
  json_sha256:byteHash(json),html_sha256:byteHash(html),pdf_sha256:byteHash(pdf),manifest_sha256:byteHash(manifest)};
 return {...binding,json_base64:json.toString('base64'),html_base64:html.toString('base64'),pdf_base64:pdf.toString('base64'),manifest_base64:manifest.toString('base64'),report_sha256:canonicalSha256(binding)};
}
function resealBundle(bundle:AnalysisResultBundle){const {result_sha256,...body}=bundle;void result_sha256;return {...body,result_sha256:canonicalSha256(body)};}
function fixture(candidate?:AiReleaseRuntimeInput){
 const input=candidate??runtimeFixture(pensionFixture().input);input.analysis_run_id=runId;
 // The production loader always supplies the canonical ISO anchor.
 input.assessment_input.current.evaluated_at=new Date(input.assessment_input.current.evaluated_at).toISOString();
 const scope=input.assessment_input.current.scope,revision=7,envelope=createCaseAnalysisAiRelease(input,{engine_case_revision:revision,
  source_journal:{case_id:scope.case_id,input_revision:scope.input_revision,input_sha256:scope.input_sha256}});
 const bundle=resealBundle({schema_version:'tivdoc-analysis-result-bundle-v0.6.0',analysis_run_id:runId,case_id:scope.case_id,case_revision:revision,
  period:{start_date:scope.period.from,end_date:scope.period.to},as_of:'2026-09-12',document_snapshot_sha256:h('documents'),extraction_snapshot_sha256:h('extractions'),
  declared_fact_snapshot_sha256:h('declarations'),facts_snapshot_sha256:scope.facts_sha256,facts:[],rule_inputs:[],catalog_sha256:h('catalog'),
  topic_results:WAVE3_TOPICS.map(topic=>({topic,status:'blocked_missing_facts',blockers:['synthetic_missing'],rule_input_sha256:null,amount:null,trace:null,legal_readiness:null})),
  known_subtotal:null,coverage_complete:false,document_review:envelope.result.review,ai_release:envelope,result_sha256:h('unsealed')});
 const a=input.assessment_input,configuration={schema_version:'tivdoc-ai-release-configuration-v1',configuration_id:id(4),revision:1,population:scope.population,
  build_manifest_sha256:h('build'),policy:a.policy,registry:a.registry,source_receipts:a.source_receipts,interpretation_receipts:a.interpretation_receipts,test_receipts:a.test_receipts,sha256:h('configuration')};
 const context={state:'configured' as const,configuration,configuration_sha256:configuration.sha256,enrollment_id:id(5),dependency_sha256:scope.authority_dependency_sha256,
  evaluated_at:'2026-09-12T10:30:00Z',expires_at:'2026-09-13T00:00:00Z',source_created_at:a.current.evaluated_at,is_qa:true as const,environment:'development' as const};
 const summary={report_id:reportId,analysis_run_id:runId,period:scope.period,report_revision:revision,current:true,created_at:'2026-09-12T10:00:00Z',purchased_topics:['pension']};
 return {input,bundle,configuration,context,summary};
}
function reseal(value:{sha256:string}){const {sha256,...body}=value;void sha256;value.sha256=canonicalSha256(body);}
function relink(input:AiReleaseRuntimeInput){
 const a=input.assessment_input,sourceHashes=new Map<string,string>(),interpretations=new Map<string,string>(),tests=new Map<string,string>();
 for(const r of a.source_receipts){const old=r.sha256;reseal(r);sourceHashes.set(old,r.sha256);}
 const sources=(values:string[])=>values.map(s=>sourceHashes.get(s)??s);
 for(const r of a.interpretation_receipts){const old=r.sha256;r.source_receipt_sha256s=sources(r.source_receipt_sha256s);
  r.human_by_law.source_receipt_sha256s=sources(r.human_by_law.source_receipt_sha256s);reseal(r);interpretations.set(old,r.sha256);}
 for(const r of a.test_receipts){const old=r.sha256;r.source_receipt_sha256s=sources(r.source_receipt_sha256s);
  r.interpretation_receipt_sha256=interpretations.get(r.interpretation_receipt_sha256)??r.interpretation_receipt_sha256;reseal(r);tests.set(old,r.sha256);}
 for(const b of a.policy.branches){b.source_receipt_sha256s=sources(b.source_receipt_sha256s);
  b.interpretation_receipt_sha256=interpretations.get(b.interpretation_receipt_sha256)??b.interpretation_receipt_sha256;
  b.test_receipt_sha256s=b.test_receipt_sha256s.map(s=>tests.get(s)??s);}
 reseal(a.policy);a.registry.policy_sha256=a.policy.sha256;reseal(a.registry);
 a.assessment.policy_sha256=a.policy.sha256;a.assessment.registry_sha256=a.registry.sha256;reseal(a.assessment);
 a.current.policy_sha256=a.policy.sha256;a.current.registry_sha256=a.registry.sha256;a.current.assessment_sha256=a.assessment.sha256;
}
let base:ReturnType<typeof fixture>;
beforeAll(()=>{base=fixture();});
beforeEach(()=>{
 ports.verify.mockReset();ports.verify.mockImplementation((configuration,build)=>{
  expect(build).toBe(ports.build);
  // Configuration/build verification has its own exact-hash suite. This seam
  // simulates only a successful trusted loader, never a provider or DB grant.
  return {configuration,trusted_generator_pins:base.input.trusted_generator_pins};
 });
});
function db(value:unknown):CaseAccessDb{return {provider:'fake',rpc:vi.fn(async()=>[{value}]) as CaseAccessDb['rpc']};}
function artifact(value:unknown){return privateDocumentReviewArtifact(base.bundle.case_id,identity,reportId,db(value));}
describe('protected AI report reader authority',()=>{
 it('strips server context from summaries and checks the compiled configuration singleton',async()=>{
  const result=await privateDocumentReviewReports(base.bundle.case_id,identity,db([{...base.summary,ai_context:base.context}]));
  expect(result).toEqual([base.summary]);expect(ports.verify).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain('configuration');expect(result[0]).not.toHaveProperty('ai_context');
 });
 it.each(['absent','revoked','expired','build','clock'] as const)('does not advertise a current report after %s authority loss',async reason=>{
  let context:unknown=base.context;
  if(reason==='absent')context={state:'absent'};
  if(reason==='revoked'||reason==='expired')context={state:'unavailable',reason,dependency_sha256:base.context.dependency_sha256};
  if(reason==='build')ports.verify.mockImplementation(()=>{throw Error('AI_CONFIGURATION_BUILD_MISMATCH');});
  if(reason==='clock')context={...base.context,evaluated_at:'2026-09-13T00:00:00Z'};
  const result=await privateDocumentReviewReports(base.bundle.case_id,identity,db([{...base.summary,ai_context:context}]));
  expect(result[0].current).toBe(false);expect(result[0]).not.toHaveProperty('ai_context');
  expect(result[0].unavailable_reason).toBe(reason==='expired'||reason==='revoked'?reason:'authority_unavailable');
 });
 it('preserves both missing and null historical context without requiring AI configuration',async()=>{
  expect(await privateDocumentReviewReports(base.bundle.case_id,identity,db([base.summary,{...base.summary,ai_context:null}]))).toEqual([base.summary,base.summary]);
  expect(ports.verify).not.toHaveBeenCalled();
 });
 it('keeps SQL stale state false even with valid authority',async()=>{
  const result=await privateDocumentReviewReports(base.bundle.case_id,identity,db([{...base.summary,current:false,ai_context:base.context}]));
  expect(result[0].current).toBe(false);
  expect(result[0].unavailable_reason).toBe('source_or_analysis_changed');
 });
 it('retains a false historical row byte shape and prioritizes explicit expiry over SQL stale state',async()=>{
  const old={...base.summary,current:false};
  expect(await privateDocumentReviewReports(base.bundle.case_id,identity,db([{...old,ai_context:null}]))).toEqual([old]);
  const result=await privateDocumentReviewReports(base.bundle.case_id,identity,db([{...old,ai_context:{state:'unavailable',reason:'expired',dependency_sha256:base.context.dependency_sha256}}]));
  expect(result[0]).toEqual({...old,unavailable_reason:'expired'});
  expect(JSON.stringify(result)).not.toContain(base.context.dependency_sha256);
 });
 // Includes full-family fixture preparation and protected replay; not a five-second performance contract.
 it('keeps an independent partial pension report current when an unconsumed family source expires',async()=>{
  const input=runtimeFixture(),a=input.assessment_input;
  const prepared=prepareAiReleaseRuntime({source:input.source,analysis_run_id:input.analysis_run_id,trusted_generator_pins:input.trusted_generator_pins});
  const pensionSources=new Set(prepared.review.checks.filter(c=>c.topic==='pension').flatMap(c=>c.calculation.input.source_manifest.filter(m=>m.kind==='legal_source').map(m=>m.version_id)));
  const used=a.source_receipts.filter(r=>pensionSources.has(r.source_version_id)).map(r=>r.sha256);
  expect(used.length).toBeGreaterThan(0);
  const policy=a.policy.branches.find(b=>b.topic==='pension')!;
  policy.source_receipt_sha256s=used;
  const interpretation=a.interpretation_receipts.find(r=>r.sha256===policy.interpretation_receipt_sha256)!;
  interpretation.source_receipt_sha256s=used;interpretation.human_by_law.source_receipt_sha256s=used;
  for(const test of a.test_receipts.filter(r=>policy.test_receipt_sha256s.includes(r.sha256)))test.source_receipt_sha256s=used;
  const unused=a.source_receipts.find(r=>!pensionSources.has(r.source_version_id))!;
  expect(unused).toBeDefined();unused.expires_at='2026-09-12T10:15:00Z';
  a.assessment.branches=a.assessment.branches.filter(b=>b.branch_id===policy.branch_id);
  relink(input);const f=fixture(input);
  ports.verify.mockImplementation(configuration=>({configuration,trusted_generator_pins:f.input.trusted_generator_pins}));
  expect(f.bundle.ai_release!.result.state).toBe('partial');
  expect(f.bundle.ai_release!.result.admission.state).toBe('admitted');
  const summaries=await privateDocumentReviewReports(f.bundle.case_id,identity,db([{...f.summary,ai_context:f.context}]));
  expect(summaries[0].current).toBe(true);
  const result=await privateDocumentReviewArtifact(f.bundle.case_id,identity,reportId,db({current:true,ai_context:f.context,completion:{bundle:f.bundle,report:report(f.bundle)}}));
  expect(result?.current).toBe(true);expect(result?.bundle.ai_release?.result.checks.some(c=>c.topic==='pension'&&c.state==='calculated')).toBe(true);
 },15_000);
 it('ignores a live revocation of an unused reviewer while preserving actual admission checks',async()=>{
  const input=structuredClone(base.input),registry=input.assessment_input.registry;
  const unused={...registry.reviewers[0],actor_id:'unused-synthetic-reviewer'};
  registry.reviewers.push(unused);registry.revocations.push({target_sha256:canonicalSha256(unused),effective_at:'2026-09-12T10:15:00Z',reason_code:'unused_reviewer_withdrawn'});
  relink(input);const f=fixture(input);
  const summaries=await privateDocumentReviewReports(f.bundle.case_id,identity,db([{...f.summary,ai_context:f.context}]));
  expect(summaries[0].current).toBe(true);
  const result=await privateDocumentReviewArtifact(f.bundle.case_id,identity,reportId,db({current:true,ai_context:f.context,completion:{bundle:f.bundle,report:report(f.bundle)}}));
  expect(result?.current).toBe(true);expect(result?.bundle.ai_release?.result.state).toBe('partial');
 });
 it('replays a valid protected AI artifact and never returns the RPC context',async()=>{
  const result=await artifact({current:true,ai_context:base.context,completion:{bundle:base.bundle,report:report(base.bundle)}});
  expect(result?.current).toBe(true);expect(result?.bundle.result_sha256).toBe(base.bundle.result_sha256);expect(result).not.toHaveProperty('ai_context');
 });
 it.each(['null','unavailable','mismatch','build'] as const)('returns a valid artifact as historical after %s authority change',async reason=>{
  let context:unknown=base.context;
  if(reason==='null')context=null;
  if(reason==='unavailable')context={state:'unavailable',reason:'revoked',dependency_sha256:base.context.dependency_sha256};
  if(reason==='mismatch')context={...base.context,dependency_sha256:h('changed dependency')};
  if(reason==='build')ports.verify.mockImplementation(()=>{throw Error('AI_CONFIGURATION_BUILD_MISMATCH');});
  const result=await artifact({current:true,ai_context:context,completion:{bundle:base.bundle,report:report(base.bundle)}});
  expect(result?.current).toBe(false);expect(result?.bundle.result_sha256).toBe(base.bundle.result_sha256);
 });
 it('rejects malformed AI and foreign bundle bindings even when current is already false',async()=>{
  const malformed=resealBundle({...base.bundle,ai_release:{...base.bundle.ai_release!,sha256:h('tampered')}});
  await expect(artifact({current:false,ai_context:null,completion:{bundle:malformed,report:report(malformed)}})).rejects.toThrow();
  const foreign=resealBundle({...base.bundle,case_id:id(8)});
  await expect(artifact({current:false,ai_context:base.context,completion:{bundle:foreign,report:report(foreign)}})).rejects.toThrow();
 });
 it('keeps a legacy artifact unchanged with SQL null context',async()=>{
  const {ai_release,...body}=base.bundle;void ai_release;const legacy=resealBundle(body);
  const result=await artifact({current:true,ai_context:null,completion:{bundle:legacy,report:report(legacy)}});
  expect(result?.current).toBe(true);expect(result?.bundle).not.toHaveProperty('ai_release');expect(ports.verify).not.toHaveBeenCalled();
 });
 it('does not turn an RPC outage or malformed context into a successful empty list',async()=>{
  const broken:CaseAccessDb={provider:'fake',rpc:async()=>{throw Error('DATABASE_UNAVAILABLE');}};
  await expect(privateDocumentReviewReports(base.bundle.case_id,identity,broken)).rejects.toThrow('DATABASE_UNAVAILABLE');
  await expect(privateDocumentReviewReports(base.bundle.case_id,identity,db([{...base.summary,ai_context:{state:'configured'}}]))).rejects.toThrow();
 });
});
