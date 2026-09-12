import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewInputSchema} from '../../document-review/contracts.ts';
import {vacationFixture} from '../product-branch.fixture.ts';
import {vacationEntitlementInputSchema} from './contracts.ts';
import {evaluateVacationCaseRecipe,vacationCaseSourceEvidenceSchema,validateVacationCaseMethod,type VacationCaseContext,type VacationCaseSourceEvidence} from './product-decisions.ts';

function fixture(){
 const input=vacationFixture();input.applicability=[];
 const source=input.seniority_year!.source;
 const review=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:input.case_id,period:input.period,
  purchased_scope:{order_id:'synthetic-order',receipt_sha256:'c'.repeat(64),topics:['vacation'],origin:'legacy_paid_receipt'},
  documents:[{...input.source_manifest[0],kind:'other',label:'Synthetic annual register',period:input.period,reading_sha256:source.reading_receipt_sha256,reading_origin:'identified_document_reading'}],checks:[],completion_input:{},answer_history:[],answer_bindings:[],coverage_gaps:[]});
 const entries:VacationCaseSourceEvidence['entries']=[
  {kind:'seniority',state:'identified',source,reference_year:2026,continuity:'same_employer_or_workplace',operand_sha256:canonicalSha256(input.seniority_year)},
  {kind:'annual_workdays',state:'identified',source,coverage:{from:'2026-01-01',to:'2026-06-30'},inventory:'complete_classified_workdays',operand_sha256:canonicalSha256(input.annual_basis!.actual_workdays)},
 ];
 const evidence=vacationCaseSourceEvidenceSchema.parse({schema_version:'vacation-case-source-evidence-v1',case_id:input.case_id,period:input.period,entries});
 const context:VacationCaseContext={review,evidence,authenticated_evidence_sha256s:entries.map(e=>canonicalSha256(e))};
 return {input,context};
}
function admit(context:VacationCaseContext){context.authenticated_evidence_sha256s=context.evidence.entries.map(e=>canonicalSha256(e));}
function payFixture(){const f=fixture(),source=f.input.seniority_year!.source;
 const wage={...f.input.seniority_year!,id:'synthetic.wage',observation_id:'synthetic.wage',representation:'money_ils' as const,quantity_unit:null,printed_value:'9000.00'};
 f.input.leave_pay={mode:'hourly_quarter',leave_period:{from:'2026-06-01',to:'2026-06-05'},quarter_period:{from:'2026-03-01',to:'2026-05-31'},wage,recorded:{...wage,id:'synthetic.recorded',observation_id:'synthetic.recorded',printed_value:'0'},leave_calendar_days:{...f.input.seniority_year!,id:'synthetic.leave.days',quantity_unit:'calendar_days',printed_value:'5'}};
 f.context.evidence.entries.push({kind:'calendar_days',state:'identified',source,coverage:f.input.leave_pay.leave_period,exclusions:'section5_and_weekly_rest_accounted',operand_sha256:canonicalSha256(f.input.leave_pay.leave_calendar_days)},
  {kind:'quarter_selection',state:'identified',source,coverage:f.input.leave_pay.quarter_period,selection:'preceding_quarter_all_months_full',fullest_quarter_inventory:'not_needed'},
  {kind:'recorded_allocation',state:'identified',source,coverage:f.input.leave_pay.leave_period,allocation:'exclusive_same_leave_days',operand_sha256:canonicalSha256(f.input.leave_pay.recorded)});
 admit(f.context);return f;
}
const evaluate=(id:string,f:ReturnType<typeof fixture>)=>evaluateVacationCaseRecipe('vacation.'+id,f.input,f.context);
describe('source-bound vacation case readiness without automatic legal acceptance',()=>{
 it('supports exact seniority and completed annual inventory while preserving original input and decisions',()=>{
  const f=fixture(),before=canonicalSha256(f);expect(evaluate('seniority_basis',f).allowed).toBe(true);expect(evaluate('annual_workdays',f)).toMatchObject({allowed:true,dependent_check_ids:['synthetic.vacation.annual.prorated']});expect(canonicalSha256(f)).toBe(before);expect(f.input.applicability).toEqual([]);
 });
 it.each(['general_section3','no_better_arrangement','pay_wage_basis','pay_applicability'])('does not pretend the existing scalar packet proves %s',id=>expect(evaluate(id,fixture()).allowed).toBe(false));
 it('requires an authenticated classification instead of same-page numeric inference',()=>{
  const f=fixture();expect(evaluateVacationCaseRecipe('vacation.seniority_basis',f.input).reason).toBe('authenticated_source_classification_required');f.context.authenticated_evidence_sha256s=[];expect(()=>evaluate('seniority_basis',f)).toThrow('EVIDENCE_NOT_ADMITTED');
 });
 it.each(['missing','unknown','conflict','stale','expired','unreadable'] as const)('preserves %s classification independently',state=>{
  const f=fixture();f.context.evidence.entries[0].state=state;admit(f.context);expect(evaluate('seniority_basis',f).reason).toBe('seniority:'+state);expect(evaluate('annual_workdays',f).allowed).toBe(true);
 });
 it('rejects duplicate, foreign case, file hash and stale document readings',()=>{
  const duplicate=fixture();duplicate.context.evidence.entries.push(duplicate.context.evidence.entries[0]);expect(()=>evaluate('seniority_basis',duplicate)).toThrow('DUPLICATE');
  const foreign=fixture();foreign.context.evidence.case_id='foreign';expect(()=>evaluate('seniority_basis',foreign)).toThrow('SCOPE');
  const hash=fixture();hash.context.evidence.entries[0].source={...hash.context.evidence.entries[0].source!,file_sha256:'d'.repeat(64)};admit(hash.context);expect(()=>evaluate('seniority_basis',hash)).toThrow('SOURCE_BINDING');
  const stale=fixture();stale.context.review.documents[0].reading_sha256='e'.repeat(64);expect(()=>evaluate('seniority_basis',stale)).toThrow('CURRENT_SOURCE');
 });
 it('rejects retained classification after operand correction',()=>{const f=fixture();f.input.seniority_year!.printed_value='2';expect(()=>evaluate('seniority_basis',f)).toThrow('OPERAND_BINDING');});
 it('does not promote customer salary or classification declarations',()=>{
  const f=fixture(),source={...f.input.seniority_year!.source,reading:'customer_declaration' as const};f.input.source_manifest[0].kind='customer_answer';f.input.seniority_year!.source=source;f.context.evidence.entries[0].source=source;admit(f.context);expect(evaluate('seniority_basis',f).reason).toBe('seniority:identified_source_required');
 });
 it('does not finalize ongoing 2026 or trust an asserted future completion date',()=>{
  const f=fixture();f.input.annual_basis!.employment_end.value='ongoing';expect(evaluate('annual_workdays',f).reason).toBe('annual_inventory:incomplete_or_future');f.input.annual_basis!.covered_through.value='2026-12-31';expect(evaluate('annual_workdays',f).allowed).toBe(false);
 });
 it('blocks contradictory dates, false completeness and unclassified inventory',()=>{
  const f=fixture();f.input.annual_basis!.employment_end.value='2025-12-01';expect(evaluate('annual_workdays',f).reason).toBe('annual_employment:conflict');
  const g=fixture();g.input.annual_basis!.complete_year_evidence.value=false;expect(evaluate('annual_workdays',g).reason).toBe('annual_inventory:incomplete');
  const h=fixture(),e=h.context.evidence.entries[1];if(e.kind!=='annual_workdays')throw Error('fixture');e.inventory='partial_or_unclassified';admit(h.context);expect(evaluate('annual_workdays',h).reason).toBe('annual_workdays:classification_incomplete');
 });
 it('allows explicit zero annual workdays but never missing as zero, and checks count bounds',()=>{
  const f=fixture(),e=f.context.evidence.entries[1];if(e.kind!=='annual_workdays')throw Error('fixture');f.input.annual_basis!.actual_workdays!.printed_value='0';e.operand_sha256=canonicalSha256(f.input.annual_basis!.actual_workdays);admit(f.context);expect(evaluate('annual_workdays',f).allowed).toBe(true);
  f.input.annual_basis!.actual_workdays!.state='unknown';expect(evaluate('annual_workdays',f).reason).toBe('operand:unknown');
  f.input.annual_basis!.actual_workdays!.state='observed';f.input.annual_basis!.actual_workdays!.printed_value='200';expect(evaluate('annual_workdays',f).reason).toBe('annual_workdays:bounds');
 });
 it('supports identified calendar days, quarter and recorded zero without requiring annual data',()=>{
  const f=payFixture();f.input.annual_basis=null;f.input.seniority_year=null;for(const id of ['pay_calendar_days','pay_quarter_selection','pay_recorded_allocation'])expect(evaluate(id,f).allowed).toBe(true);expect(evaluate('pay_recorded_allocation',f).dependent_check_ids).toEqual(['synthetic.vacation.pay.comparison']);
 });
 it('keeps independent quarter selection fingerprint stable when the recorded payment changes',()=>{
  const f=payFixture(),before=evaluate('pay_quarter_selection',f).consumed_sha256;f.input.leave_pay!.recorded!.printed_value='50';expect(evaluate('pay_quarter_selection',f).consumed_sha256).toBe(before);expect(()=>evaluate('pay_recorded_allocation',f)).toThrow('OPERAND_BINDING');
 });
 it('requires complete alternative quarter inventory and exact chronological selection',()=>{
  const f=payFixture(),e=f.context.evidence.entries.find(e=>e.kind==='quarter_selection')!;if(e.kind!=='quarter_selection'||f.input.leave_pay!.mode!=='hourly_quarter')throw Error('fixture');
  e.selection='employee_selected_fullest_quarter';e.fullest_quarter_inventory='incomplete';admit(f.context);expect(evaluate('pay_quarter_selection',f).reason).toBe('quarter_selection:fullest_inventory_required');e.fullest_quarter_inventory='complete_prior_twelve_months';admit(f.context);expect(evaluate('pay_quarter_selection',f).allowed).toBe(true);
  f.input.leave_pay!.quarter_period={from:'2026-04-01',to:'2026-06-30'};e.coverage=f.input.leave_pay!.quarter_period;admit(f.context);expect(evaluate('pay_quarter_selection',f).reason).toBe('quarter_selection:period_mismatch');
 });
 it('rejects workday-to-calendar-day relabelling and mismatched leave allocation',()=>{
  const f=payFixture();if(f.input.leave_pay!.mode!=='hourly_quarter')throw Error('fixture');f.input.leave_pay!.leave_calendar_days!.quantity_unit='days';expect(evaluate('pay_calendar_days',f).reason).toBe('operand:unit_mismatch');
  const g=payFixture(),e=g.context.evidence.entries.find(e=>e.kind==='recorded_allocation')!;if(e.kind!=='recorded_allocation')throw Error('fixture');e.coverage={from:'2026-06-02',to:'2026-06-05'};admit(g.context);expect(evaluate('pay_recorded_allocation',g).reason).toBe('recorded_allocation:period_mismatch');
 });
 it('requires an explicit monthly counterfactual wage period, never converts a full monthly salary',()=>{
  const f=payFixture(),p=f.input.leave_pay!;f.input=vacationEntitlementInputSchema.parse({...f.input,leave_pay:{mode:'monthly_maintained_wage',leave_period:p.leave_period,wage:p.wage,recorded:p.recorded}});
  f.context.evidence.entries.push({kind:'monthly_period',state:'identified',source:p.wage!.source,coverage:p.leave_period,basis:'identified_wage_if_worked_same_leave_period',operand_sha256:canonicalSha256(p.wage)});admit(f.context);expect(evaluate('pay_monthly_period',f).allowed).toBe(true);expect(evaluate('pay_wage_basis',f).allowed).toBe(false);
 });
 it('rejects outside support and fabricated method even with valid source classifications',()=>{
  const f=fixture();f.input.period={from:'2026-08-01',to:'2026-08-31'};expect(evaluate('seniority_basis',f).reason).toBe('unsupported_payroll_month');
  const g=fixture();expect(()=>validateVacationCaseMethod({recipe_id:'ai-case.vacation.seniority_basis',recipe_version:'1',recipe_sha256:'a'.repeat(64),source_policy_sha256:'b'.repeat(64),interpretation_receipt_sha256:'c'.repeat(64),source_receipts:[{receipt_sha256:'d'.repeat(64),source_version_id:'synthetic-law',artifact_sha256:'e'.repeat(64)}],issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'},'2026-09-12T01:00:00Z',g.input,g.context)).toThrow('METHOD_BINDING');
 });
});
