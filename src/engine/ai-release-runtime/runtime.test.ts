import {describe,expect,it} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {fixture as pensionSource} from '../entitlement-review/compose.fixture.ts';
import {pensionEntitlementInputSchema} from '../entitlement-review/pension/contracts.ts';
import {obligationsEntitlementInputSchema} from '../entitlement-review/obligations/contracts.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import {prepareAiReleaseRuntime} from './generator-manifest.ts';
import {runAiReleaseRuntime,replayAiReleaseRuntime,assertAiReleaseRuntimeResult} from './runtime.ts';
import {AI_RELEASE_RUNTIME_FAMILIES,type AiReleaseRuntimeInput} from './contracts.ts';
import {runtimeFixture,nineTopicRuntimeSource,runtimeFixtureHash as h} from './runtime.fixture.ts';

const pension=()=>runtimeFixture(pensionSource().input);
const prepare=(i:AiReleaseRuntimeInput)=>prepareAiReleaseRuntime({source:i.source,analysis_run_id:i.analysis_run_id,trusted_generator_pins:i.trusted_generator_pins});
const reseal=(record:{sha256:string})=>{const {sha256,...body}=record;void sha256;record.sha256=canonicalSha256(body);};
const newAssessment=(i:AiReleaseRuntimeInput)=>{reseal(i.assessment_input.assessment);i.assessment_input.current.assessment_sha256=i.assessment_input.assessment.sha256;};

describe('ordinary compiled entitlement generators → qualified AI runtime',()=>{
 it('calculates all nine purchased families through the real composer and RuleSpec engine',()=>{
  const i=runtimeFixture(),before=canonicalSha256(i.source),r=runAiReleaseRuntime(i);
  expect(r.families.map(f=>f.topic).sort()).toEqual(AI_RELEASE_RUNTIME_FAMILIES.map(f=>f.topic).sort());
  expect(r.families.filter(f=>!f.checks.some(c=>c.state==='calculated')&&!f.nonmonetary_outcomes.some(o=>o.state!=='blocked')).map(f=>({topic:f.topic,blockers:f.blockers,checks:f.checks.map(c=>({id:c.check_id,blockers:c.blockers}))}))).toEqual([]);
  expect(r.findings.length).toBeGreaterThan(8);expect(r.checks.every(c=>c.analysis_run_id===i.analysis_run_id)).toBe(true);
  expect(r).toMatchObject({claim_kind:'qualified_ai_report',verified_debt:false,legal_debt_total:null,combined_amount:null,publication_performed:false,human_attestation:null});
  expect(canonicalSha256(i.source)).toBe(before);expect(r.review.publication_authority).toBe(false);
  expect(r.review.checks.every(c=>c.calculation.real_activation_allowed===false&&c.calculation.human_attestation===null)).toBe(true);
 });
 it('keeps source-derived expected amounts independent of missing transfers and recorded values',()=>{
  const r=runAiReleaseRuntime(pension());expect(r.findings.map(f=>f.expected)).toEqual([30000,32500,30000].map(minor_units=>({kind:'money',currency:'ILS',minor_units})));
  expect(r.findings.every(f=>f.outcome==='expected_only'&&f.recorded===null&&f.difference===null&&f.remittance_status==='missing')).toBe(true);
  expect(r.findings.every(f=>f.trace?.status==='succeeded'&&f.unit==='currency.ils')).toBe(true);
 });
 it('does not drop unsupported purchased topics or add unpurchased sick leave',()=>{
  const r=runAiReleaseRuntime(pension());expect(r.families).toHaveLength(9);expect(r.state).toBe('partial');
  expect(r.families.filter(f=>f.topic!=='pension').every(f=>f.state==='blocked'&&f.blockers.some(b=>b.code==='AI_RUNTIME_NO_SOURCE_SELECTION'))).toBe(true);
  expect(r.families.some(f=>String(f.topic)==='sick_leave')).toBe(false);
 });
 it('keeps annual vacation quota in calendar days and out of financial findings',()=>{
  const r=runAiReleaseRuntime(runtimeFixture()),quota=r.checks.filter(c=>c.topic==='vacation'&&c.state==='calculated');
  expect(quota.some(c=>c.unit==='calendar_days'&&c.outcome==='nonmonetary')).toBe(true);expect(r.findings.some(f=>f.topic==='vacation'&&f.unit==='calendar_days')).toBe(false);
 });
 it('recomputes expectations instead of trusting supplied current.generated values',()=>{
  const i=pension();i.assessment_input.current.expected_generated_rules![0].rule_sha256=h('untrusted expectation');
  expect(runAiReleaseRuntime(i).findings).toHaveLength(3);
 });
 it('rejects a forged assessment and forged supplied expectation together',()=>{
  const i=pension(),b=i.assessment_input.assessment.branches[0];b.rule_sha256=h('forged rule');
  i.assessment_input.current.expected_generated_rules![0].rule_sha256=b.rule_sha256;newAssessment(i);
  const r=runAiReleaseRuntime(i);expect(r.findings).toEqual([]);expect(r.admission.branches[0].blockers.map(b=>b.code)).toContain('AI_RELEASE_GENERATED_RULE_MISMATCH');
 });
 it('hashes actual case values independently even where the generated graph is unchanged',()=>{
  const i=pension(),before=prepare(i),e=pensionEntitlementInputSchema.parse(i.source.entitlement_evidence!.pension);
  e.pensionable_wage!.printed_value='5100.00';i.source.entitlement_evidence!.pension=e;const after=prepare(i);
  const a=before.families.find(f=>f.topic==='pension')!,b=after.families.find(f=>f.topic==='pension')!;
  expect(b.rule_manifest.checks[0].rule_sha256).toBe(a.rule_manifest.checks[0].rule_sha256);
  expect(b.rule_manifest.checks[0].case_facts_sha256).not.toBe(a.rule_manifest.checks[0].case_facts_sha256);
  expect(b.expected!.rule_sha256).not.toBe(a.expected!.rule_sha256);expect(runAiReleaseRuntime(i).findings).toEqual([]);
 });
 it('hashes actual applicability decisions rather than taking their claimed assessment state',()=>{
  const i=pension(),before=prepare(i),e=pensionEntitlementInputSchema.parse(i.source.entitlement_evidence!.pension);
  e.applicability[0].explanation+=' A new source-specific explanation.';i.source.entitlement_evidence!.pension=e;const after=prepare(i);
  expect(after.families.find(f=>f.topic==='pension')!.expected!.source_evidence_sha256).not.toBe(before.families.find(f=>f.topic==='pension')!.expected!.source_evidence_sha256);
  expect(runAiReleaseRuntime(i).findings).toEqual([]);
 });
 it('keeps an actually blocked calculation blocked even under admitted family policy',()=>{
  const source=pensionSource().input,e=pensionEntitlementInputSchema.parse(source.entitlement_evidence!.pension);
  e.pensionable_wage!.state='unknown';e.pensionable_wage!.printed_value=null;source.entitlement_evidence!.pension=e;
  const r=runAiReleaseRuntime(runtimeFixture(source));expect(r.admission.state).toBe('admitted');expect(r.checks.every(c=>c.state==='blocked'&&c.expected===null&&c.trace===null)).toBe(true);expect(r.findings).toEqual([]);
 });
 it('rechecks decision expiry at current time without rewriting the historical review receipt',()=>{
  const source=pensionSource().input,e=pensionEntitlementInputSchema.parse(source.entitlement_evidence!.pension);
  e.applicability[0].valid_until='2026-09-12T09:00:00Z';source.entitlement_evidence!.pension=e;
  const r=runAiReleaseRuntime(runtimeFixture(source));expect(r.review.checks.every(c=>c.calculation.state==='calculated')).toBe(true);
  expect(r.checks.every(c=>c.state==='blocked'&&c.blockers.some(b=>b.code==='AI_RUNTIME_CASE_DECISION_EXPIRED'))).toBe(true);
 });
 it('does not promote an explicitly counterfactual calculation to a financial finding',()=>{
  const source=pensionSource().input,e=pensionEntitlementInputSchema.parse(source.entitlement_evidence!.pension);
  const d=e.applicability.find(d=>d.decision_id==='pension.pensionable_wage')!;d.state='unknown';
  e.conditional_assumptions=[{decision_id:'pension.pensionable_wage',explanation:'Synthetic only: calculate if this basis applies.'}];source.entitlement_evidence!.pension=e;
  const r=runAiReleaseRuntime(runtimeFixture(source));expect(r.review.checks.some(c=>c.calculation.state==='calculated')).toBe(true);
  expect(r.findings).toEqual([]);expect(r.checks.every(c=>c.blockers.some(b=>b.code==='AI_RUNTIME_COUNTERFACTUAL_ONLY'))).toBe(true);
 });
 it.each(['case_id','order_id','order_receipt_sha256','facts_sha256'] as const)('rejects a changed current/assessment %s',field=>{
  const i=pension();i.assessment_input.current.scope[field]=field.endsWith('sha256')?h('foreign'):'foreign';
  if(field==='facts_sha256')expect(runAiReleaseRuntime(i).findings).toEqual([]);else expect(()=>runAiReleaseRuntime(i)).toThrow('AI_RUNTIME_CURRENT_SCOPE_MISMATCH');
 });
 it('rejects replaced physical source versions before runtime publication',()=>{
  const i=pension();i.assessment_input.current.source_pins[0].version_id='new-version';expect(()=>runAiReleaseRuntime(i)).toThrow('AI_RUNTIME_CURRENT_SOURCE_MISMATCH');
 });
 it('supports the established immutable-version document alias under exact version and SHA',()=>{
  const i=pension();const d=i.source.documents[0],p=i.assessment_input.current.source_pins[0];
  // A product ID in current pins may address a review document whose ID is its immutable version.
  p.document_id='actual-product-document';p.version_id=d.version_id;
  const candidate=JSON.stringify(i.source).replaceAll(d.document_id,d.version_id);i.source=JSON.parse(candidate);
  const refreshed=runtimeFixture(i.source);refreshed.assessment_input.current.source_pins[0].document_id=p.document_id;
  expect(runAiReleaseRuntime(refreshed).findings).toHaveLength(3);
 });
 it('rejects policy pinned to an unrelated compiled generator',()=>{
  const i=pension();i.trusted_generator_pins[0].generator.id='injected.generator';expect(()=>runAiReleaseRuntime(i)).toThrow('AI_RUNTIME_GENERATOR_FAMILY_MISMATCH');
 });
 it('does not infer the build digest from policy metadata',()=>{
  const i=pension();i.trusted_generator_pins.find(p=>p.family_id==='entitlement.pension')!.generator.code_sha256=h('different deployed code');expect(runAiReleaseRuntime(i).findings).toEqual([]);
 });
 it('does not promote a preexisting hand-authored candidate without generated ownership',()=>{
  const i=pension(),prepared=prepare(i);i.source.checks=[prepared.composed.checks[0]];i.source.documents=structuredClone(prepared.composed.documents);delete i.source.entitlement_evidence;
  const r=runAiReleaseRuntime(i);expect(r.review.checks).toHaveLength(1);expect(r.findings).toEqual([]);expect(r.supplemental_check_ids).toContain(i.source.checks[0].check_id);
 });
 it('rejects a post-composition edited rule or check on replay',()=>{
  const i=pension(),p=prepare(i);i.source=structuredClone(p.composed);i.source.checks[0].title='Unadmitted title';
  // Recomposition rebuilds catalog-owned fields from source; the injected title has no authority.
  expect(runAiReleaseRuntime(i).checks[0].title).not.toBe('Unadmitted title');
 });
 it.each([['450.00','difference_positive',5000],['500.00','difference_zero',0],['550.00','recorded_above_expected',-5000]] as const)('retains a signed %s recorded comparison', (paid,outcome,diff)=>{
  const source=nineTopicRuntimeSource(),o=obligationsEntitlementInputSchema.parse(source.entitlement_evidence!.obligations);
  o.obligations[0].recorded!.amount.printed_value=paid;source.entitlement_evidence!.obligations=o;
  const r=runAiReleaseRuntime(runtimeFixture(source)),comparison=r.checks.find(c=>c.topic==='bonuses'&&c.difference!==null)!;
  expect(comparison).toMatchObject({outcome,expected:{kind:'money',minor_units:50000},recorded:{minor_units:Number(paid)*100},difference:{minor_units:diff},verified_debt:false});
  expect(r.combined_amount).toBeNull();
 });
 it('preserves a known unmet obligation condition as a nonmonetary outcome, not a zero cell',()=>{
  const source=nineTopicRuntimeSource(),o=obligationsEntitlementInputSchema.parse(source.entitlement_evidence!.obligations);o.obligations[0].conditions[0].fact.value=false;source.entitlement_evidence!.obligations=o;
  const r=runAiReleaseRuntime(runtimeFixture(source));expect(r.nonmonetary_outcomes).toEqual(expect.arrayContaining([expect.objectContaining({topic:'bonuses',state:'condition_not_fulfilled',amount:null})]));
  expect(r.findings.some(f=>f.topic==='bonuses')).toBe(false);expect(r.findings.some(f=>f.topic==='contract')).toBe(true);
 });
 it('retains actual RuleSpec, fact/parameter bindings, source traces and no hidden precision',()=>{
  const i=pension(),r=runAiReleaseRuntime(i),first=r.checks[0],family=r.families.find(f=>f.topic==='pension')!;
  const original=documentReviewCalculationInputSchema.parse(r.review.checks[0].calculation.input);
  expect(family.rule_manifest.checks[0].case_facts_sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(family.parameter_manifest.checks[0].bindings.length).toBeGreaterThan(0);
  expect(first.source_operands).toEqual(original.operands);expect(first.candidate_receipt_sha256).toBe(canonicalSha256(r.review.checks[0].calculation));
 });
 it('replays the whole same-run artifact and refuses manufactured runtime receipts',()=>{
  const i=pension(),r=runAiReleaseRuntime(i);expect(replayAiReleaseRuntime(r,i)).toEqual(r);expect(()=>assertAiReleaseRuntimeResult(r)).not.toThrow();
  expect(()=>assertAiReleaseRuntimeResult(JSON.parse(JSON.stringify(r)))).toThrow('AI_RUNTIME_FACTORY_RESULT_REQUIRED');
  expect(()=>replayAiReleaseRuntime({...r,combined_amount:1},i)).toThrow('AI_RUNTIME_REPLAY_MISMATCH');
 });
});
