import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {calculateDocumentReview,documentReviewCalculationInputSchema,replayDocumentReviewCalculation,type DocumentReviewSource,type DocumentReviewOperand} from '../../document-review/calculations.ts';
import {createJune2026MinimumWageCandidate} from '../../minimum-wage-june2026/candidate.ts';
import {resolveMinimumWageEntitlement,MINIMUM_WAGE_APPLICABILITY} from './resolve.ts';
import {MINIMUM_WAGE_SOURCE_REVIEW,MINIMUM_WAGE_CATALOG} from './source-policy.ts';
import type {MinimumWageEntitlementInput,MinimumWageMethod} from './contracts.ts';

const source:DocumentReviewSource={document_id:'synthetic.payslip',version_id:'v1',file_sha256:'a'.repeat(64),page:1,locator:'Synthetic cells',label:'Synthetic payslip',reading:'ai_document_review',reading_receipt_sha256:'b'.repeat(64)};
const fact=<T>(value:T)=>({state:'observed' as const,value,source});
const amount=(id:string,value:string|null):DocumentReviewOperand=>({id,observation_id:'observation.'+id,state:value===null?'missing':'observed',printed_value:value,representation:'money_ils',quantity_unit:null,precision:'source_exact',source});
function fixture(method:MinimumWageMethod='published_hourly_182'):MinimumWageEntitlementInput{
 const period={from:'2026-06-01',to:'2026-06-30'};
 return {schema_version:'minimum-wage-entitlement-input-v1',catalog_version:'1.0.0',case_id:'synthetic.case',run_id:'synthetic.run',check_id:'minimum.synthetic',period,evaluated_at:'2026-09-12T00:00:00Z',
  source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'case_document',case_id:'synthetic.case'}],
  method:fact(method),population:fact('adult_general'),employment:fact(method==='full_monthly'?'full_monthly_42':'hourly_182'),
  ordinary_hours:{...amount('hours','100'),representation:'decimal_quantity',quantity_unit:'hours'},ordinary_hours_period:fact(period),monthly_coverage:fact('full_month_full_time'),eligible_pay_inventory:fact('complete'),
  components:[{id:'base',amount:amount('base','3300'),period:fact(period),classification:fact('base_salary')}],
  applicability:Object.entries(MINIMUM_WAGE_APPLICABILITY).map(([decision_id,explanation])=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic assessment only. '+explanation,sources:[source],valid_until:null}))};
}
function run(i:MinimumWageEntitlementInput){const r=resolveMinimumWageEntitlement(i);if(!r.checks[0])throw Error('fixture expected check');return calculateDocumentReview(r.checks[0].calculation);}
describe('minimum wage: distinct versioned methods and independent oracles',()=>{
 it('keeps publishedhourly3540 vs exactmonthly/1823540.58 separate at100hours',()=>{
  const direct=run(fixture('published_hourly_182')),exact=run(fixture('monthly_exact_div182'));
  expect(direct).toMatchObject({state:'calculated',expected:{minor_units:354000},recorded:{minor_units:330000},difference:{minor_units:24000}});
  expect(exact).toMatchObject({state:'calculated',expected:{minor_units:354058},recorded:{minor_units:330000},difference:{minor_units:24058}});
  if(direct.state!=='calculated'||exact.state!=='calculated')return;
  expect(direct.input.operation.kind).toBe('candidate_rule');expect(direct.dependency_fingerprint).not.toBe(exact.dependency_fingerprint);expect(replayDocumentReviewCalculation(exact)).toEqual(exact);
 });
 it.each(['published_hourly_182','monthly_exact_div182','full_monthly'] as const)('%s produces zero and signed negative comparison without becoming authority',method=>{
  const i=fixture(method),expected=method==='published_hourly_182'?'3540':method==='monthly_exact_div182'?'3540.58':'6443.85';i.components[0].amount=amount('base',expected);
  expect(run(i)).toMatchObject({state:'calculated',difference:{minor_units:0},real_activation_allowed:false,human_attestation:null});
  i.components[0].amount=amount('base','7000');const r=run(i);expect(r.state).toBe('calculated');if(r.state==='calculated')expect(r.difference?.kind==='money'&&r.difference.minor_units<0).toBe(true);
 });
 it('monthly floor does not become182 timesroundedhourly and needs no inventedhourquantity',()=>{
  const i=fixture('full_monthly');i.ordinary_hours=null;i.ordinary_hours_period={state:'unknown',value:null,source};i.components[0].amount=amount('base','6400');
  expect(run(i)).toMatchObject({expected:{minor_units:644385},difference:{minor_units:4385}});
 });
 it('handles fractional source minutes with final rounding in each explicitmethod',()=>{
  const direct=fixture();direct.ordinary_hours={...direct.ordinary_hours!,representation:'hours_minutes',printed_value:'0:30'};direct.components[0].amount=amount('base','16');
  expect(run(direct)).toMatchObject({expected:{minor_units:1770},difference:{minor_units:170}});
  direct.method=fact('monthly_exact_div182');expect(run(direct)).toMatchObject({expected:{minor_units:1770},difference:{minor_units:170}});
 });
 it.each([['2026-05-01','2026-05-31'],['2026-06-01','2026-06-30'],['2026-07-01','2026-07-31']])('uses a new scopedcatalog for%s to%s', (from,to)=>{
  const i=fixture();i.period={from,to};i.ordinary_hours_period=fact(i.period);i.components[0].period=fact(i.period);expect(run(i)).toMatchObject({expected:{minor_units:354000}});
 });
 it('preserves the immutable old June package and records each newmethod name',()=>{
  const old=canonicalSha256(createJune2026MinimumWageCandidate(1));for(const method of ['published_hourly_182','monthly_exact_div182','full_monthly'] as const){
   const input=documentReviewCalculationInputSchema.parse(resolveMinimumWageEntitlement(fixture(method)).checks[0].calculation);if(input.operation.kind!=='candidate_rule')throw Error('candidate');
   expect(input.operation.rule.rule_spec_id).toContain(method);expect(input.operation.rule.effective_period).toEqual({from:'2026-05-01',to:'2026-07-31'});
  }expect(canonicalSha256(createJune2026MinimumWageCandidate(1))).toBe(old);
  expect(MINIMUM_WAGE_CATALOG.catalog_boundary).toBe('real_inactive');expect(MINIMUM_WAGE_SOURCE_REVIEW.operative_rounding_dispute_resolved).toBe(false);
 });
});
describe('minimum wage: source inventory, period and eligibility',()=>{
 it('sums eligiblebase+fixed supplement and excludes travelwithout inventingitsamount',()=>{
  const i=fixture();i.components.push({id:'supplement',amount:amount('supplement','100'),period:fact(i.period),classification:fact('fixed_work_supplement')},
   {id:'travel',amount:amount('travel',null),period:fact(i.period),classification:fact('expense_reimbursement')});
  expect(run(i)).toMatchObject({recorded:{minor_units:340000},difference:{minor_units:14000}});
  const before=resolveMinimumWageEntitlement(i).checks[0];i.components[2].amount=amount('travel','600');expect(resolveMinimumWageEntitlement(i).checks[0]).toEqual(before);
 });
 it('does not silently exclude an unknowncomponent or usepartialinventory',()=>{
  const i=fixture();i.components.push({id:'unclear',amount:amount('unclear','100'),period:fact(i.period),classification:{state:'unknown',value:'unknown',source}});
  expect(resolveMinimumWageEntitlement(i).checks).toEqual([]);i.components.pop();i.eligible_pay_inventory=fact('partial');expect(resolveMinimumWageEntitlement(i).checks).toEqual([]);
 });
 it('keeps missing wages/hours/periods blocked instead ofzero orwholepayroll substitution',()=>{
  const i=fixture();i.components[0].amount=amount('base',null);expect(resolveMinimumWageEntitlement(i).checks).toEqual([]);
  const hours=fixture();hours.ordinary_hours=null;expect(resolveMinimumWageEntitlement(hours).checks).toEqual([]);
  const period=fixture();period.components[0].period=fact({from:'2026-05-01',to:'2026-05-31'});const r=resolveMinimumWageEntitlement(period);expect(r.checks).toEqual([]);expect(r.missing.some(m=>m.state==='conflict')).toBe(true);
 });
 it('does not infer partialmonthlyproration, adultstatus or a method',()=>{
  const partial=fixture('full_monthly');partial.employment=fact('partial_monthly');expect(resolveMinimumWageEntitlement(partial).missing.some(m=>m.fact_key==='mw.partial_monthly')).toBe(true);expect(resolveMinimumWageEntitlement(partial).checks).toEqual([]);
  const minor=fixture();minor.population=fact('minor');expect(resolveMinimumWageEntitlement(minor).checks).toEqual([]);
  const method=fixture();method.method={state:'unknown',value:null,source};expect(resolveMinimumWageEntitlement(method).checks).toEqual([]);
 });
 it('missing182or42framework isinternalapplicability ratherthana customerchoiceoflaw',()=>{
  const i=fixture();i.employment={state:'missing',value:null,source:null};
  expect(resolveMinimumWageEntitlement(i).missing.find(m=>m.fact_key==='mw.employment')).toMatchObject({kind:'applicability',customer_declaration_allowed:false});
 });
 it('rejects repeated source observations evenifcomponentIDs differ',()=>{
  const i=fixture();i.components.push({...i.components[0],id:'duplicate'});expect(()=>resolveMinimumWageEntitlement(i)).toThrow('MINIMUM_WAGE_DUPLICATE_COMPONENT');
 });
 it.each(['conflict','stale','expired'] as const)('does not replace a%s sourceclassification withtheknownnumericamount',state=>{
  const i=fixture();i.components[0].classification={state,value:'base_salary',source};expect(resolveMinimumWageEntitlement(i).checks).toEqual([]);
 });
 it('rejects foreignsource, othermonths, crossmonth andmixedunits',()=>{
  const foreign=fixture();foreign.case_id='foreign';expect(()=>resolveMinimumWageEntitlement(foreign)).toThrow('MINIMUM_WAGE_SOURCE_BINDING');
  const april=fixture();april.period={from:'2026-04-01',to:'2026-04-30'};expect(()=>resolveMinimumWageEntitlement(april)).toThrow('MINIMUM_WAGE_RESEARCH_PERIOD');
  const partial=fixture();partial.period.to='2026-06-29';expect(()=>resolveMinimumWageEntitlement(partial)).toThrow('MINIMUM_WAGE_FULL_CALENDAR_SCOPE');
  const units=fixture();units.ordinary_hours={...units.ordinary_hours!,quantity_unit:'days'};expect(()=>resolveMinimumWageEntitlement(units)).toThrow('MINIMUM_WAGE_INPUT_UNIT');
 });
 it('missing/expired applicability remains blocked and customerdeclaration is notapproval',()=>{
  const i=fixture();i.applicability=[];expect(run(i)).toMatchObject({state:'blocked',expected:null});
  const expired=fixture();expired.applicability[0]={...expired.applicability[0],valid_until:'2026-09-12T03:00:00+03:00'};expect(run(expired)).toMatchObject({state:'blocked'});
  const declared=fixture();declared.applicability[0]={...declared.applicability[0],basis:'customer_declaration'};expect(()=>run(declared)).toThrow('MINIMUM_WAGE_DECLARATION_NOT_APPLICABILITY');
 });
 it('binding edits cannot change the recordedaggregate or preserve anoldreceipt hash',()=>{
  const r=run(fixture());if(r.state!=='calculated')throw Error('calculated');const edited=structuredClone(r);edited.input.operands.find(o=>o.id==='mw.input.0')!.printed_value='1';expect(()=>replayDocumentReviewCalculation(edited)).toThrow('DOCUMENT_REVIEW_REPLAY_MISMATCH');
 });
});
