import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {travelFloorFixture,travelFloorReview} from './floor.fixture.ts';
import {travelEntitlementInputSchema} from './contracts.ts';
import {materializeTravelTariffSource,travelTariffTarget,validateTravelTariffAnswer,resolveTravelTariffReading,type TravelTariffDocument,type TravelTariffJournalEntry,type TravelTariffTarget} from './tariff-source.ts';
import {evaluateTravelCaseRecipe,travelCaseConsumed} from './product-facts.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../../ai-release-decisions/catalog.ts';
import {applyAiReleaseDecisionRecipes} from '../../ai-release-decisions/apply.ts';
import {runDocumentReview} from '../../document-review/service.ts';

const current:TravelTariffDocument={case_id:'11111111-1111-4111-8111-111111111111',document_id:'44444444-4444-4444-8444-444444444444',version_id:'55555555-5555-4555-8555-555555555555',file_sha256:'a'.repeat(64),page_count:2,month:'2026-06',evidence_purpose:'travel_tariff',document_type:'other',purpose_sha256:'9'.repeat(64)};
const group={page:1,locator:'Synthetic route tariff and ticket table'},identity='66666666-6666-4666-8666-666666666666';
const subjects:TravelTariffTarget['subject'][]=['context','daily_fare','ticket_inventory','monthly_pass_cost'];
function entry(subject:TravelTariffTarget['subject'],value?:unknown,revision=1):TravelTariffJournalEntry{
 const target=travelTariffTarget(current,group,subject),basis={page:1,locator:'Synthetic '+subject,text:'Synthetic explicitly printed tariff context, not a paid ticket receipt'};
 const initial={context:{route_reference:'Synthetic route A',discount_profile:'standard_adult',effective_period:{from:'2026-05-01',to:'2026-07-31'},directions:'both'},daily_fare:'12.00',ticket_inventory:{ticket_inventory:'complete',monthly_pass_availability:'available'},monthly_pass_cost:'200.00'};
 return {target,request_id:`77777777-7777-4777-8777-${String(subjects.indexOf(subject)+1).padStart(12,'0')}`,answer_revision:revision,identity_id:identity,answered_at:'2026-09-12T12:00:00Z',
  answer:validateTravelTariffAnswer(target,{schema_version:'document-field-answer-v3',action:'correct',structured_value:{kind:'travel_tariff',subject,value:value??initial[subject],basis}})};
}
function args(){const travel=travelFloorFixture();travel.discounted_daily_fare=null;travel.monthly_pass_cost=null;travel.monthly_pass={state:'missing',value:null,source:null,basis:'ai_source_assessment'};
 return {travel,current,group,journal:subjects.map(s=>entry(s))};}
function review(out:ReturnType<typeof materializeTravelTariffSource>){const input=travelFloorReview(out.travel);input.documents.push({case_id:current.case_id,document_id:current.document_id,version_id:current.version_id,file_sha256:current.file_sha256,page_count:current.page_count,kind:'other',label:'Synthetic tariff uploaded as other',period:input.period,
 reading_origin:'identified_document_reading',reading_sha256:out.accepted_reading_sha256[0],accepted_reading_sha256:[...out.accepted_reading_sha256]});return input;}

describe('ordinary current tariff transcription journal adapter',()=>{
 it('reconstructs four separate identified decisions, retaining the other document and exact source cells',()=>{
  const a=args(),before=canonicalSha256(a),out=materializeTravelTariffSource(a);
  expect(out.receipts).toHaveLength(4);expect(new Set(out.receipts.map(r=>r.receipt_sha256)).size).toBe(4);expect(out.dependencies.every(d=>d.answered)).toBe(true);
  expect(out.travel.discounted_daily_fare).toMatchObject({state:'observed',printed_value:'12.00'});expect(out.travel.monthly_pass_cost).toMatchObject({state:'observed',printed_value:'200.00'});
  expect(out.travel.fare_source_context?.schema_version).toBe('travel-fare-source-context-v2');expect(current.document_type).toBe('other');
  for(const id of ['travel.fare_basis','travel.ticket_options'])expect(evaluateTravelCaseRecipe(id,out.travel,review(out))).toMatchObject({allowed:true});
  expect(canonicalSha256(a)).toBe(before);expect(materializeTravelTariffSource(a)).toEqual(out);expect(out.conflicts).toEqual([]);
 });
 it('applies the four versioned recipes through the ordinary composer with exact receipts and signed output',()=>{
  const a=args();a.travel.applicability=a.travel.applicability.filter(d=>d.decision_id==='travel.rounding');const out=materializeTravelTariffSource(a),source=review(out);
  const recipes=AI_RELEASE_DECISION_RECIPES.filter(r=>r.recipe_id.startsWith('ai-case.travel.')&&r.recipe_id.endsWith('.floor-v2'));
  const methods=recipes.map(r=>({recipe_id:r.recipe_id,recipe_version:r.recipe_version,recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,interpretation_receipt_sha256:'f'.repeat(64),
   source_receipts:r.legal_sources.map(s=>({source_version_id:s.version_id,artifact_sha256:s.file_sha256,receipt_sha256:canonicalSha256({synthetic:s.version_id})})),issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'}));
  const applied=applyAiReleaseDecisionRecipes({source,methods,at:'2026-09-12T12:00:00Z'});expect(applied.receipts).toHaveLength(4);expect(applied.unresolved).toEqual([]);
  const result=runDocumentReview(applied.source,'synthetic.floor');expect(result.checks.find(c=>c.check_id==='synthetic.travel.comparison')?.calculation).toMatchObject({state:'calculated',expected:{minor_units:20000},difference:{minor_units:1000}});
  expect(applied.source.answer_history).toEqual(source.answer_history);expect(travelEntitlementInputSchema.parse(applied.source.entitlement_evidence!.travel).applicability.some(d=>d.decision_id==='travel.no_better_arrangement')).toBe(false);
 });
 it.each(['unknown','unreadable'] as const)('retains %s as one answered history decision and blocks that exact cell',action=>{
  const a=args(),old=a.journal[1];a.journal.push({...old,answer_revision:2,answer:{schema_version:'document-field-answer-v3',action}});const out=materializeTravelTariffSource(a);
  expect(out.travel.discounted_daily_fare).toMatchObject({state:action,printed_value:null});expect(out.dependencies.find(d=>d.target.subject==='daily_fare')).toMatchObject({state:action,answered:true});
  expect(out.history).toHaveLength(5);expect(out.history.filter(h=>h.current)).toHaveLength(4);expect(evaluateTravelCaseRecipe('travel.fare_basis',out.travel,review(out)).allowed).toBe(false);
 });
 it('preserves daily consumed hashes when only monthly cost is corrected and keeps every revision',()=>{
  const a=args(),first=materializeTravelTariffSource(a),paths=evaluateTravelCaseRecipe('travel.fare_basis',first.travel).consumed_paths;
  a.journal.push(entry('monthly_pass_cost','210.00',2));const next=materializeTravelTariffSource(a);
  expect(next.travel.monthly_pass_cost!.printed_value).toBe('210.00');expect(next.history).toHaveLength(5);expect(travelCaseConsumed(next.travel,paths)).toEqual(travelCaseConsumed(first.travel,paths));
  expect(evaluateTravelCaseRecipe('travel.ticket_options',next.travel,review(next)).allowed).toBe(true);
 });
 it('keeps no-commute zero independent of all fare receipts and emits no tariff requests',()=>{
  const a=args();a.travel.commute_days!.printed_value='0';a.journal=[];const out=materializeTravelTariffSource(a);
  expect(out.travel).toEqual(a.travel);expect(out.receipts).toEqual([]);expect(out.dependencies).toEqual([]);
 });
 it('does not infer unavailable tickets or complete inventory from a missing amount',()=>{
  const a=args();a.journal=a.journal.filter(e=>e.target.subject!=='monthly_pass_cost');let out=materializeTravelTariffSource(a);
  expect(out.travel.monthly_pass.value).toBe('available');expect(evaluateTravelCaseRecipe('travel.ticket_options',out.travel).allowed).toBe(false);
  a.journal=a.journal.filter(e=>e.target.subject!=='ticket_inventory');a.journal.push(entry('ticket_inventory',{ticket_inventory:'partial',monthly_pass_availability:'unavailable'}));out=materializeTravelTariffSource(a);
  expect(out.dependencies.some(d=>d.target.subject==='monthly_pass_cost')).toBe(false);expect(evaluateTravelCaseRecipe('travel.ticket_options',out.travel)).toMatchObject({allowed:false,reason:'complete_discounted_ticket_inventory_required'});
 });
 it('never overwrites an independent conflicting amount or adverse availability reading',()=>{
  const a=args();a.travel.discounted_daily_fare=travelFloorFixture().discounted_daily_fare;a.travel.discounted_daily_fare!.printed_value='99.00';a.travel.monthly_pass={...travelFloorFixture().monthly_pass,state:'unknown',value:null};
  const out=materializeTravelTariffSource(a);expect(out.travel.discounted_daily_fare).toMatchObject({state:'conflict',printed_value:null});expect(out.travel.monthly_pass).toEqual(a.travel.monthly_pass);
  expect(out.conflicts[0].path).toBe('discounted_daily_fare');expect(a.travel.discounted_daily_fare!.printed_value).toBe('99.00');
 });
 it('does not reuse an old version or purpose receipt after replacement, while preserving history',()=>{
  const a=args();a.current={...current,version_id:'88888888-8888-4888-8888-888888888888',file_sha256:'8'.repeat(64)};
  const out=materializeTravelTariffSource(a);expect(out.receipts).toEqual([]);expect(out.dependencies.every(d=>!d.answered)).toBe(true);expect(out.history.every(h=>!h.current)).toBe(true);
  expect(out.travel.discounted_daily_fare).toBeNull();expect(()=>resolveTravelTariffReading(a.current,a.journal[0])).toThrow('TRAVEL_TARIFF_CURRENT_SOURCE');
 });
 it('rejects foreign journals, same-revision tampering, wrong target/page, confirm and invalid money',()=>{
  const a=args();const foreign=structuredClone(a);foreign.current.case_id='99999999-9999-4999-8999-999999999999';expect(()=>materializeTravelTariffSource(foreign)).toThrow('TRAVEL_TARIFF_CASE_PERIOD');
  const conflict=args();conflict.journal.push(entry('daily_fare','13.00'));expect(()=>materializeTravelTariffSource(conflict)).toThrow('TRAVEL_TARIFF_REVISION_CONFLICT');
  const t=a.journal[1].target;expect(()=>validateTravelTariffAnswer(t,{schema_version:'document-field-answer-v3',action:'confirm'})).toThrow();
  expect(()=>entry('daily_fare','22.60 ימים')).toThrow();expect(()=>validateTravelTariffAnswer(t,a.journal[0].answer)).toThrow('TRAVEL_TARIFF_ANSWER_TARGET');
 });
});
