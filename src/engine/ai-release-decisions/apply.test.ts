import {describe,expect,it} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {nineTopicRuntimeSource} from '../ai-release-runtime/runtime.fixture.ts';
import {pensionEntitlementInputSchema} from '../entitlement-review/pension/contracts.ts';
import {travelEntitlementInputSchema} from '../entitlement-review/travel/contracts.ts';
import {vacationEntitlementInputSchema} from '../entitlement-review/vacation/contracts.ts';
import {minimumWageEntitlementInputSchema} from '../entitlement-review/minimum-wage/contracts.ts';
import {workingTimeEntitlementInputSchema} from '../entitlement-review/working-time/contracts.ts';
import {convalescenceEntitlementInputSchema} from '../entitlement-review/convalescence/contracts.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import {runDocumentReview} from '../document-review/service.ts';
import {composeEntitlementReview} from '../entitlement-review/compose.ts';
import {parseReviewCompletionInput} from '../document-review/completions.ts';
import {WORKING_TIME_APPLICABILITY} from '../entitlement-review/working-time/resolve.ts';
import {AI_RELEASE_DECISION_RECIPES} from './catalog.ts';
import {applyAiReleaseDecisionRecipes} from './apply.ts';
import type {AiReleaseDecisionMethod} from './contracts.ts';

const at='2026-09-12T10:00:00Z',h=(s:string)=>canonicalSha256({synthetic:s});
function source(){
 const source=nineTopicRuntimeSource(),e=source.entitlement_evidence!;
 for(const [key,schema] of Object.entries({pension:pensionEntitlementInputSchema,travel:travelEntitlementInputSchema,vacation:vacationEntitlementInputSchema,
  minimum_wage:minimumWageEntitlementInputSchema,convalescence:convalescenceEntitlementInputSchema})){
  const keyValue=key as 'pension'|'travel'|'vacation'|'minimum_wage'|'convalescence';const b=schema.parse(e[keyValue]);b.applicability=[];e[keyValue]=b;
 }
 const weeks=Array.isArray(e.working_time)?e.working_time:[];e.working_time=weeks.map(w=>({...workingTimeEntitlementInputSchema.parse(w),applicability:[]}));
 return source;
}
function method(id:string):AiReleaseDecisionMethod{
 const r=AI_RELEASE_DECISION_RECIPES.find(r=>r.decision_id===id)!;
 return {recipe_id:r.recipe_id,recipe_version:'1',recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,
  interpretation_receipt_sha256:h('isolated synthetic interpretation'),source_receipts:r.legal_sources.map(s=>({receipt_sha256:h(s.version_id),source_version_id:s.version_id,artifact_sha256:s.file_sha256})),
  issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};
}
const apply=(methods:AiReleaseDecisionMethod[],s=source())=>applyAiReleaseDecisionRecipes({source:s,methods,at});

describe('pinned deterministic method decisions, not blanket legal acceptance',()=>{
 it('retains one shared applicability need with all seven daily dependents when every decision is missing',()=>{
  const composed=composeEntitlementReview(source()),needs=parseReviewCompletionInput(composed.completion_input).needs;
  const coverage=needs.filter(n=>n.question===WORKING_TIME_APPLICABILITY['wt.coverage']);
  expect(coverage).toHaveLength(1);expect(coverage[0].dependent_check_ids).toHaveLength(7);
  expect(new Set(coverage[0].dependent_check_ids).size).toBe(7);expect(coverage[0].kind).toBe('legal');
  expect(composed.checks.filter(c=>c.topic==='working_time'||c.topic==='rest_day')).toHaveLength(7);
 });
 it('preserves original bytes and reference when no method descriptors are supplied',()=>{
  const s=source(),before=canonicalSha256(s),r=apply([],s);expect(r.source).toBe(s);expect(canonicalSha256(s)).toBe(before);expect(r.receipts).toEqual([]);
 });
 it('issues only explicit method decisions while all independent case applicability remains blocked',()=>{
  const s=source(),before=canonicalSha256(s),r=apply(AI_RELEASE_DECISION_RECIPES.map(c=>method(c.decision_id)),s);
  expect(r.receipts.length).toBeGreaterThanOrEqual(9);expect(r.receipts.every(p=>p.decision.state==='accepted'&&p.decision.basis==='ai_source_assessment'&&p.human_attestation===null)).toBe(true);
  expect(r.receipts.some(p=>p.decision_id==='pension.general_coverage'||p.decision_id==='pension.pensionable_wage'||p.decision_id==='wt.worked_time.day.0')).toBe(false);
  const review=runDocumentReview(r.source,'synthetic-method-run');
  expect(review.checks.filter(c=>c.topic==='pension').every(c=>c.calculation.state==='blocked')).toBe(true);
  expect(canonicalSha256(s)).toBe(before);expect(r.source.purchased_scope).toEqual(s.purchased_scope);
  expect(r.receipts.every(p=>p.consumed.every(c=>c.value_sha256.length===64))).toBe(true);
 });
 it.each(['recipe_sha256','source_policy_sha256'] as const)('rejects a mismatched %s without changing the source',field=>{
  const m=method('pension.rounding');m[field]=h('foreign');const s=source(),r=apply([m],s);expect(r.source).toBe(s);expect(r.receipts).toEqual([]);expect(r.unresolved[0].reason).toBe('method_pin_mismatch');
 });
 it('requires each exact source version and artifact even if a receipt SHA is present',()=>{
  const m=method('wt.rest_additive');m.source_receipts[1].artifact_sha256=h('foreign');const r=apply([m]);expect(r.receipts).toEqual([]);expect(r.unresolved[0].reason).toBe('legal_source_receipt_mismatch');
 });
 it.each([{issued_at:'2026-09-13T00:00:00Z'},{expires_at:at}])('does not issue a method outside its valid interval',change=>{
  const r=apply([{...method('pension.rounding'),...change}]);expect(r.receipts).toEqual([]);expect(r.unresolved[0].reason).toBe('method_not_current');
 });
 it.each(['unknown','conflict','stale','expired','accepted'] as const)('preserves an existing %s decision, including deliberate unknown answers',state=>{
  const s=source(),p=pensionEntitlementInputSchema.parse(s.entitlement_evidence!.pension),law=AI_RELEASE_DECISION_RECIPES[0].legal_sources[0];
  const original={decision_id:'pension.rounding',state,basis:'ai_source_assessment' as const,explanation:'Synthetic existing decision must remain.',sources:[law],valid_until:null};
  p.applicability=[original];s.entitlement_evidence!.pension=p;const r=apply([method('pension.rounding')],s);
  expect(r.source).toBe(s);expect(pensionEntitlementInputSchema.parse(r.source.entitlement_evidence!.pension).applicability).toEqual([original]);
  expect(r.unresolved[0].reason).toBe('existing_decision_preserved');
 });
 it('can fill an explicit missing method decision but never replaces its factual values',()=>{
  const s=source(),p=pensionEntitlementInputSchema.parse(s.entitlement_evidence!.pension);p.applicability=[{decision_id:'pension.rounding',state:'missing',basis:'ai_source_assessment',explanation:'Synthetic missing method.',sources:[],valid_until:null}];s.entitlement_evidence!.pension=p;
  const r=apply([method('pension.rounding')],s),updated=pensionEntitlementInputSchema.parse(r.source.entitlement_evidence!.pension);
  expect(updated.applicability).toHaveLength(1);expect(updated.applicability[0].state).toBe('accepted');expect(updated.pensionable_wage).toEqual(p.pensionable_wage);expect(updated.recorded).toEqual(p.recorded);
 });
 it('does not manufacture a vacation pay method when only annual quota facts exist',()=>{
  const s=source(),v=vacationEntitlementInputSchema.parse(s.entitlement_evidence!.vacation);v.leave_pay=null;s.entitlement_evidence!.vacation=v;
  expect(apply([method('vacation.pay_rounding')],s).receipts).toEqual([]);
 });
 it('accepts the hourly leave method only with explicit wage, days and quarter branch',()=>{
  const s=source(),v=vacationEntitlementInputSchema.parse(s.entitlement_evidence!.vacation),p=pensionEntitlementInputSchema.parse(s.entitlement_evidence!.pension);
  const citation=v.seniority_year!.source;
  v.leave_pay={mode:'hourly_quarter',leave_period:{from:'2026-06-01',to:'2026-06-03'},quarter_period:{from:'2026-03-01',to:'2026-05-31'},
   wage:{...p.pensionable_wage!,id:'quarter.wage',source:citation},leave_calendar_days:{...v.seniority_year!,id:'leave.days',printed_value:'3',quantity_unit:'calendar_days'},recorded:null};
  s.entitlement_evidence!.vacation=v;const r=apply([method('vacation.pay_rounding')],s);expect(r.receipts).toHaveLength(1);
  expect(r.source.coverage_gaps.some(g=>g.kind==='missing_applicability')).toBe(true);
 });
 it('does not choose a minimum-wage method for an incompatible employment arrangement',()=>{
  const s=source(),m=minimumWageEntitlementInputSchema.parse(s.entitlement_evidence!.minimum_wage);m.employment.value='partial_monthly';s.entitlement_evidence!.minimum_wage=m;
  expect(apply([method('mw.method'),method('mw.rounding')],s).receipts).toEqual([]);
 });
 it('requires a complete ordered weekly inventory and never infers omitted zero days',()=>{
  const s=source(),raw=s.entitlement_evidence!.working_time;if(!Array.isArray(raw))throw Error('TEST_WEEK_REQUIRED');
  const w=workingTimeEntitlementInputSchema.parse(raw[0]);w.workdays.pop();w.week_inventory.value='partial';s.entitlement_evidence!.working_time=[w];
  const r=apply([method('wt.weekly_aggregation'),method('wt.rounding')],s);expect(r.receipts.map(r=>r.decision_id)).toEqual(['wt.rounding']);
 });
 it('does not confuse an unknown rest window or holiday with statutory weekly-rest pricing',()=>{
  const s=source(),raw=s.entitlement_evidence!.working_time;if(!Array.isArray(raw))throw Error('TEST_WEEK_REQUIRED');
  const w=workingTimeEntitlementInputSchema.parse(raw[0]);w.workdays[0].kind.value='holiday';s.entitlement_evidence!.working_time=[w];expect(apply([method('wt.rest_additive')],s).receipts).toEqual([]);
 });
 it('does not assign a 2026 convalescence rate merely because the payslip month is in 2026',()=>{
  const s=source(),c=convalescenceEntitlementInputSchema.parse(s.entitlement_evidence!.convalescence);c.benefit_year={...c.benefit_year,state:'unknown',value:null};s.entitlement_evidence!.convalescence=c;
  expect(apply([method('cv.rate_2026'),method('cv.rounding')],s).receipts).toEqual([]);
 });
 it('rejects foreign source pins through the existing source admission path',()=>{
  const s=source(),p=pensionEntitlementInputSchema.parse(s.entitlement_evidence!.pension);p.pensionable_wage!.source.file_sha256=h('foreign');s.entitlement_evidence!.pension=p;
  expect(()=>apply([method('pension.rounding')],s)).toThrow('ENTITLEMENT_READING_SOURCE_BINDING');
 });
 it('refuses competing method descriptors and unsupported contract decisions',()=>{
  const m=method('pension.rounding'),r=apply([m,{...m,interpretation_receipt_sha256:h('different')}]);expect(r.receipts).toEqual([]);
  expect(apply([{...m,recipe_id:'ai-method.obligation.rounding'}]).unresolved[0].reason).toBe('recipe_not_supported');
 });
 it('binds receipts to exact changed values and independently replayable composed decisions',()=>{
  const s=source(),a=apply([method('pension.rounding')],s),p=pensionEntitlementInputSchema.parse(s.entitlement_evidence!.pension);p.pensionable_wage!.printed_value='5100.00';s.entitlement_evidence!.pension=p;
  const b=apply([method('pension.rounding')],s);expect(a.receipts[0].sha256).not.toBe(b.receipts[0].sha256);
  expect(a.receipts[0].consumed.find(p=>p.path.endsWith('.pensionable_wage'))?.value_sha256).not.toBe(b.receipts[0].consumed.find(p=>p.path.endsWith('.pensionable_wage'))?.value_sha256);
  const calc=documentReviewCalculationInputSchema.parse(b.source.checks.find(c=>c.topic==='pension')!.calculation);
  expect(calc.operation.kind).toBe('candidate_rule');if(calc.operation.kind==='candidate_rule')expect(calc.operation.decisions.some(d=>d.decision_id==='pension.rounding'&&d.state==='accepted')).toBe(true);
  expect(apply([method('pension.rounding')],s)).toEqual(b);
  expect(()=>apply([method('pension.rounding')],b.source)).toThrow('AI_DECISION_REBUILD_BASE_REQUIRED');
 });
});
