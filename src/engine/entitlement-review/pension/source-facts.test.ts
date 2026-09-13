import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {fixture} from '../compose.fixture.ts';
import {productFlowFixture,clause} from '../working-time/product-flow.fixture.ts';
import {pensionEntitlementInputSchema} from './contracts.ts';
import {pensionProductFacts,evaluatePensionCaseRecipe,pensionProductFactQuestions} from './product-facts.ts';
import {emptyPensionSourceFacts,PENSION_STATUTORY_FLOOR_POLICY} from './source-fact-contracts.ts';
import {attachPensionSourceFacts,assertPensionSourceFacts,pensionLiteralClause} from './source-facts.ts';
import {entitlementSourceReadingDependencies} from '../product-source-dependencies.ts';
const wage=(amount='5000.00',from='2026-06-01',to='2026-06-30')=>`השכר הקובע להפרשות פנסיוניות לתקופה ${from} עד ${to} הוא ${amount} ש״ח, והוא כולל את כל רכיבי השכר הקובעים לפנסיה`;
function sample(rows=[clause(wage(),'wage')]){
 const f=productFlowFixture(rows),old=fixture(),input=pensionEntitlementInputSchema.parse({...old.pension,case_id:f.document.case_id,applicability:[],product_facts:pensionProductFacts(),source_facts:emptyPensionSourceFacts(),calculation_policy:PENSION_STATUTORY_FLOOR_POLICY,
  source_manifest:old.pension.source_manifest.map(s=>({...s,case_id:f.document.case_id}))});
 const review=()=>{const r=f.review();return {...r,purchased_scope:{...r.purchased_scope,topics:['pension' as const]},documents:[...r.documents,...old.input.documents.map(d=>({...d,case_id:f.document.case_id}))]};};
 return {...f,input,review};
}
describe('pension ordinary identified source producer',()=>{
 it('aggregates the real pending observation and does not reopen unknown before a source correction resumes it',()=>{
  const f=sample();const packet=()=>{const review=f.review(),p=attachPensionSourceFacts(f.input,review).input;return {...review,entitlement_evidence:{schema_version:'entitlement-source-evidence-v1' as const,case_id:p.case_id,order_id:review.purchased_scope.order_id,receipt_sha256:review.purchased_scope.receipt_sha256,period:p.period,pension:p}};};
  expect(entitlementSourceReadingDependencies(packet())[0].observation_ids).toEqual([f.extraction.observations[0].observation_id]);
  f.answer('wage',{action:'unknown'});expect(entitlementSourceReadingDependencies(packet())).toEqual([]);
  f.answer('wage',{action:'correct',corrected_raw_value:wage(),basis:'Synthetic exact clause reading after prior unknown'});
  const current=packet();expect(entitlementSourceReadingDependencies(current)).toEqual([]);expect(pensionEntitlementInputSchema.parse(current.entitlement_evidence.pension).source_facts?.wage_basis.state).toBe('observed');
 });
 it('keeps provider confidence .94 as a candidate and selects only the exact existing observation',()=>{
  const f=sample(),before=canonicalSha256(f.extraction),r=attachPensionSourceFacts(f.input,f.review());
  expect(r.input.source_facts?.wage_basis.state).toBe('unknown');expect(r.input.applicability).toEqual([]);
  expect(r.reading_dependencies[0].observation_ids).toEqual([f.extraction.observations[0].observation_id]);expect(canonicalSha256(f.extraction)).toBe(before);
 });
 it('binds a read complete base clause to the existing exact operand and never invents a legal decision',()=>{
  const f=sample();f.identify();const r=attachPensionSourceFacts(f.input,f.review());
  expect(r.input.source_facts?.wage_basis).toMatchObject({state:'observed',value:{operand_sha256:canonicalSha256(f.input.pensionable_wage)}});
  expect(evaluatePensionCaseRecipe('pension.pensionable_wage',r.input,f.review()).allowed).toBe(true);expect(r.input.applicability).toEqual([]);
  expect(()=>assertPensionSourceFacts(r.input,f.review())).not.toThrow();expect(attachPensionSourceFacts(r.input,f.review())).toEqual(r);
 });
 it.each(['0.00','5000.00'])('can identify %s directly from a complete source clause without any payslip contribution',(amount)=>{
  const f=sample([clause(wage(amount),'wage')]);f.input.pensionable_wage=null;f.identify();const r=attachPensionSourceFacts(f.input,f.review());
  expect(r.input.pensionable_wage).toMatchObject({state:'observed',printed_value:amount,source:{reading:'identified_document_reading'}});expect(r.input.recorded).toEqual([]);
  expect(()=>assertPensionSourceFacts(r.input,f.review())).not.toThrow();
 });
 it('keeps a different printed base and marks its source classification conflict',()=>{
  const f=sample([clause(wage('5100.00'),'wage')]);f.identify();const r=attachPensionSourceFacts(f.input,f.review());
  expect(r.input.pensionable_wage?.printed_value).toBe('5000.00');expect(r.input.source_facts?.wage_basis.state).toBe('conflict');expect(evaluatePensionCaseRecipe('pension.pensionable_wage',r.input).reason).toBe('wage_source_conflict');
 });
 it('does not collapse duplicate clauses by matching amounts',()=>{
  const f=sample([clause(wage(),'first'),clause(wage(),'second')]);f.identify();expect(attachPensionSourceFacts(f.input,f.review()).input.source_facts?.wage_basis.state).toBe('conflict');
 });
 it('preserves unknown source history without reopening a answered observation',()=>{
  const f=sample();f.answer('wage',{action:'unknown'});const r=attachPensionSourceFacts(f.input,f.review());expect(r.input.source_facts?.wage_basis.state).toBe('unknown');expect(r.reading_dependencies).toEqual([]);
  expect(f.extraction.observations[0].original.raw_value).toBe(wage());
 });
 it('rebuilds corrected source and rejects the preceding proof',()=>{
  const f=sample();f.identify();const prior=attachPensionSourceFacts(f.input,f.review()).input;
  f.answer('wage',{action:'correct',corrected_raw_value:wage('5100.00'),basis:'Synthetic source correction'});
  expect(()=>assertPensionSourceFacts(prior,f.review())).toThrow('PENSION_SOURCE_FACT_REPLAY');expect(attachPensionSourceFacts(prior,f.review()).input.source_facts?.wage_basis.state).toBe('conflict');
 });
 it('uses only the exact mid-month interval and never prorates a full monthly figure',()=>{
  const f=sample([clause(wage(),'month'),clause(wage('1200.00','2026-06-15'),'interval')]);f.input.facts.employment_start.value='2025-12-15';f.identify();
  const r=attachPensionSourceFacts(f.input,f.review()).input;expect(r.eligible_interval_wage).toMatchObject({period:{from:'2026-06-15',to:'2026-06-30'},operand:{printed_value:'1200.00'}});
  expect(evaluatePensionCaseRecipe('pension.pensionable_wage',r,f.review()).allowed).toBe(true);expect(evaluatePensionCaseRecipe('pension.cap_interval',r).allowed).toBe(false);
  f.input.facts.employment_start.value='2025-12-16';expect(attachPensionSourceFacts(f.input,f.review()).input.eligible_interval_wage).toBeNull();
 });
 it('reads prior active coverage at the start independently from a declaration about prior insurance',()=>{
  const f=sample([clause('הביטוח בקרן הפנסיה היה פעיל ברציפות מתאריך 2025-01-01 עד 2026-05-31','coverage')]);f.input.facts.employment_start.value='2026-05-01';f.input.facts.prior_coverage_at_start.value=true;f.identify();
  const r=attachPensionSourceFacts(f.input,f.review()).input;expect(evaluatePensionCaseRecipe('pension.prior_coverage_evidence',r,f.review()).allowed).toBe(true);
  r.facts.prior_coverage_at_start.value=false;expect(evaluatePensionCaseRecipe('pension.prior_coverage_evidence',r).allowed).toBe(false);
 });
 it('retains exact contractual rates without deciding no better terms or splitting a combined payment',()=>{
  const f=sample([clause('לתקופה 2026-01-01 עד 2026-12-31 שיעורי ההפרשה לקרן הפנסיה הם: עובד 7%, מעסיק 7.5%, פיצויים 8.33%','terms')]);f.identify();const r=attachPensionSourceFacts(f.input,f.review()).input;
  expect(r.source_facts?.arrangement).toMatchObject({state:'observed',value:{employee_percent:'7',employer_percent:'7.5',severance_percent:'8.33'}});
  expect(evaluatePensionCaseRecipe('pension.pension_fund',r,f.review()).allowed).toBe(true);expect(evaluatePensionCaseRecipe('pension.no_better_arrangement',r).allowed).toBe(false);
  expect(pensionProductFactQuestions(r).some(q=>q.path==='product_facts.pension_product')).toBe(false);expect(r.recorded).toEqual([]);
 });
 it('rejects foreign cases, altered physical pins and a hand-authored observed proof',()=>{
  const f=sample();f.identify();const r=attachPensionSourceFacts(f.input,f.review()).input;
  expect(()=>attachPensionSourceFacts(r,{...f.review(),case_id:'foreign'})).toThrow('PENSION_SOURCE_FACT_SCOPE');
  expect(()=>attachPensionSourceFacts(r,{...f.review(),documents:f.review().documents.map(d=>d.document_id===f.document.document_id?{...d,reading_sha256:'0'.repeat(64)}:d)})).toThrow('PENSION_SOURCE_FACT_RECORD_BINDING');
  r.source_facts!.wage_basis.value!.operand_sha256='0'.repeat(64);expect(()=>assertPensionSourceFacts(r,f.review())).toThrow('PENSION_SOURCE_FACT_REPLAY');
 });
 it.each(['השכר המבוטח הוא 5000 ש״ח','אם יש ביטוח קודם יבוצעו הפרשות מהיום הראשון',wage()+' בכפוף להסדר אחר',wage('5000.00','2026-02-30')])('does not interpret unsupported or conditional text: %s',text=>expect(pensionLiteralClause(text)).toBeNull());
});
