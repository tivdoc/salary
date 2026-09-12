import {describe,it,expect} from 'vitest';
import {calculateDocumentReview,replayDocumentReviewCalculation,documentReviewCalculationInputSchema,type DocumentReviewOperand} from '../../document-review/calculations.ts';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {travelEntitlementInputSchema,resolveTravelEntitlement,TRAVEL_APPLICABILITY,travelLegalSource,travelProductAnswerField,type TravelEntitlementInput} from './index.ts';
const sha='c'.repeat(64),source={document_id:'synthetic-travel-document',version_id:'synthetic.travel.v1',file_sha256:sha,page:1,locator:'Synthetic route and fare table',label:'Synthetic source; no transport provider payment',reading:'ai_document_review' as const,reading_receipt_sha256:sha};
function input():TravelEntitlementInput{
 const known=<T>(value:T)=>({state:'known',value,source,basis:'identified_document_reading'});
 const money=(id:string,printed_value:string):DocumentReviewOperand=>({id,observation_id:'synthetic.'+id,state:'observed',printed_value,representation:'money_ils',quantity_unit:null,precision:'printed_precision',source:{...source,locator:'Synthetic '+id}});
 return travelEntitlementInputSchema.parse({schema_version:'travel-entitlement-input-v1',catalog_id:'il.review.travel.general.2026',catalog_version:'1.0.0',case_id:'synthetic-travel-case',run_id:'synthetic-run',check_prefix:'synthetic.travel',period:{from:'2026-06-01',to:'2026-06-30'},evaluated_at:'2026-09-12T00:00:00Z',source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:sha,page_count:1,kind:'case_document',case_id:'synthetic-travel-case'}],
  facts:{needs_transport:known(true),employer_transport:known('none'),free_travel:known('none')},commute_days:{...money('days','20'),representation:'decimal_quantity',quantity_unit:'days'},discounted_daily_fare:money('fare','12.00'),monthly_pass:known('available'),monthly_pass_cost:money('pass','200.00'),recorded:money('recorded','190.00'),
  applicability:Object.keys(TRAVEL_APPLICABILITY).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Explicit synthetic source-specific interpretation; no human approval',sources:[travelLegalSource(1,decision_id)],valid_until:null})),remittance_status:'not_assessed'});
}
function result(i:TravelEntitlementInput){const r=resolveTravelEntitlement(i);return {review:r,results:r.checks.map(c=>calculateDocumentReview(c.calculation))};}
describe('source-bound travel entitlement through existing RuleSpec operations',()=>{
 it('uses Hebrew field-specific choices and decodes only the exact option without promoting unknown',()=>{
  const field=travelProductAnswerField('facts.employer_transport')!;expect(field.decode('לעבודה בלבד')).toBe('outbound');expect(field.decode('לא ידוע')).toBeNull();expect(()=>field.decode('outbound')).toThrow('TRAVEL_PRODUCT_ANSWER_VALUE');expect(travelProductAnswerField('applicability.travel.general_coverage')).toBeNull();
  const i=input();i.facts.employer_transport={...i.facts.employer_transport,state:'unknown',value:null};const gap=resolveTravelEntitlement(i).gaps.find(g=>g.dependency_id==='travel.employer_transport')!;expect(gap.options).toEqual(field.options);expect(gap.options).not.toContain('outbound');
 });
 it('selects the appropriate cheaper monthly ticket instead of paying the cap per day',()=>{
  const {results}=result(input());expect(results).toHaveLength(2);expect(results[0]).toMatchObject({state:'calculated',expected:{minor_units:20000}});expect(results[1]).toMatchObject({expected:{minor_units:20000},recorded:{minor_units:19000},difference:{minor_units:1000}});
  const day=results[0].input.operands.find(o=>o.id==='days')!;expect(day.quantity_unit).toBe('days');expect(results[0].execution?.trace.some(s=>s.operation==='divide')).toBe(true);
  for(const r of results){expect(r.claim).toBe('conditional_entitlement_candidate');expect(replayDocumentReviewCalculation(r)).toEqual(r);}
 });
 it.each([['8.00','500.00',16000],['40.00','1000.00',45200],['0.00','0.00',0]] as const)('honors actual discounted fare %s and ticket %s',(fare,pass,expected)=>{
  const i=input();i.discounted_daily_fare!.printed_value=fare;i.monthly_pass_cost!.printed_value=pass;expect(result(i).results[0].expected).toMatchObject({minor_units:expected});
 });
 it.each([['200.00',0],['210.00',-1000]] as const)('preserves signed difference for recorded %s without an automatic debt claim',(recorded,difference)=>{
  const i=input();i.recorded!.printed_value=recorded;expect(result(i).results[1].difference).toMatchObject({minor_units:difference});expect(result(i).review.rule_metadata.amount_is_not_cash_debt).toBe(true);
 });
 it('does not turn missing monthly-ticket availability into the daily fare branch',()=>{
  const i=input();i.monthly_pass={...i.monthly_pass,state:'unknown',value:null};i.monthly_pass_cost=null;const r=resolveTravelEntitlement(i);expect(r.checks).toEqual([]);expect(r.gaps).toEqual(expect.arrayContaining([expect.objectContaining({dependency_id:'travel.monthly_pass',state:'unknown'})]));
  i.monthly_pass={...i.monthly_pass,state:'known',value:'unavailable'};expect(result(i).results[0].expected).toMatchObject({minor_units:24000});
  i.monthly_pass.value='available';expect(resolveTravelEntitlement(i).gaps.some(g=>g.dependency_id==='travel.monthly_pass_cost')).toBe(true);
 });
 it.each(['missing','unknown','unreadable','conflict','stale','expired'] as const)('keeps %s fare evidence blocked instead of inserting the cap',state=>{
  const i=input();i.discounted_daily_fare={...i.discounted_daily_fare!,state,printed_value:null};const r=resolveTravelEntitlement(i);expect(r.checks).toEqual([]);expect(r.gaps.some(g=>g.dependency_id==='travel.discounted_daily_fare'&&g.state===state)).toBe(true);
 });
 it.each(['no_need','employer_both','free_both','no_uncovered_direction','no_commute_days'] as const)('derives zero only from the sourced %s branch, without irrelevant fare questions',branch=>{
  const i=input();i.discounted_daily_fare=null;i.monthly_pass={...i.monthly_pass,state:'unknown',value:null};i.monthly_pass_cost=null;
  if(branch==='no_need')i.facts.needs_transport.value=false;
  if(branch==='employer_both')i.facts.employer_transport.value='both';
  if(branch==='free_both')i.facts.free_travel.value='both';
  if(branch==='no_uncovered_direction'){i.facts.employer_transport.value='outbound';i.facts.free_travel.value='return';}
  if(branch==='no_commute_days')i.commute_days!.printed_value='0';
  const {review,results}=result(i);expect(review.branch).toBe(branch);expect(review.gaps).toEqual([]);expect(results[0]).toMatchObject({state:'calculated',expected:{minor_units:0}});
 });
 it('keeps one-direction shuttle interpretation unresolved until explicitly assessed, including scenario labeling',()=>{
  const i=input();i.facts.employer_transport.value='outbound';i.discounted_daily_fare!.printed_value='20.00';i.monthly_pass_cost!.printed_value='300.00';i.applicability=i.applicability.filter(d=>d.decision_id!=='travel.one_direction_treatment');
  expect(result(i).results[0].state).toBe('blocked');
  i.conditional_assumptions=[{decision_id:'travel.one_direction_treatment',explanation:'Synthetic test of remaining-route cost with half the daily cap; interpretation remains unresolved.'}];
  expect(result(i).results[0]).toMatchObject({state:'calculated',expected:{minor_units:22600},counterfactual_only:true,unresolved_conditions:[{decision:{state:'missing'}}]});
 });
 it('requires dated breakdown for mixed routes and keeps a known discounted free direction distinct from an employer shuttle',()=>{
  const i=input();i.facts.employer_transport.value='mixed';expect(resolveTravelEntitlement(i)).toMatchObject({checks:[],branch:'mixed_unsupported'});
  i.facts.employer_transport.value='none';i.facts.free_travel.value='outbound';i.discounted_daily_fare!.printed_value='15.00';i.monthly_pass_cost!.printed_value='400.00';expect(result(i).results[0].expected).toMatchObject({minor_units:30000});
 });
 it('traces factual route dependencies, excluding unused fare inputs from no-need checks',()=>{
  const i=input();i.facts.needs_transport.value=false;const before=resolveTravelEntitlement(i);i.discounted_daily_fare!.printed_value='99.00';const after=resolveTravelEntitlement(i);expect(before.input_sha256).not.toBe(after.input_sha256);expect(canonicalSha256(before.checks)).toBe(canonicalSha256(after.checks));
  const op=documentReviewCalculationInputSchema.parse(after.checks[0].calculation).operation;if(op.kind!=='candidate_rule')throw Error('synthetic candidate');
  expect(JSON.parse(op.decisions.find(d=>d.decision_id==='travel.factual_route_scope')!.explanation)).toMatchObject({values:{needs_transport:false},legal_applicability_approved:false});
 });
 it('keeps missing recorded travel separate from expected calculation',()=>{
  const i=input();i.recorded=null;const {review,results}=result(i);expect(results).toHaveLength(1);expect(results[0].state).toBe('calculated');expect(review.gaps).toEqual([expect.objectContaining({dependency_id:'travel.recorded',dependent_check_ids:['synthetic.travel.comparison']})]);
 });
 it('blocks expired/source-conflicted authority and rejects a foreign case source',()=>{
  const i=input();i.applicability[0].valid_until='2026-09-01T00:00:00Z';expect(result(i).results.every(r=>r.state==='blocked')).toBe(true);
  const j=input();j.applicability[0].basis='customer_declaration';expect(result(j).results.every(r=>r.state==='blocked')).toBe(true);
  const k=input();k.source_manifest[0].case_id='foreign';expect(()=>resolveTravelEntitlement(k)).toThrow('TRAVEL_CASE_SOURCE_BINDING');
 });
 it('does not silently cap an impossible count of commuting days to the month length',()=>{
  const i=input();i.commute_days!.printed_value='31';expect(resolveTravelEntitlement(i)).toMatchObject({checks:[],gaps:expect.arrayContaining([expect.objectContaining({dependency_id:'travel.commute_days',state:'conflict'})])});
 });
});
