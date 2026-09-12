import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {nineTopicRuntimeSource} from '../ai-release-runtime/runtime.fixture.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import {parseReviewCompletionInput,type ReviewCompletion} from '../document-review/completions.ts';
import {applyDocumentReviewAnswer,runDocumentReview,replayDocumentReview} from '../document-review/service.ts';
import {composeEntitlementReview} from '../entitlement-review/compose.ts';
import {travelEntitlementInputSchema} from '../entitlement-review/travel/contracts.ts';
import {travelProductFacts,travelCaseConsumed,evaluateTravelCaseRecipe} from '../entitlement-review/travel/product-facts.ts';
import {assertEntitlementSourcePacket} from '../entitlement-review/source-admission.ts';
import {entitlementLegalDocuments} from '../entitlement-review/legal-documents.ts';
import {enableSharedPersonalFacts,SHARED_PERSONAL_FACTS_TRAVEL_POLICY} from '../entitlement-review/shared-product-facts.ts';
import {AI_RELEASE_DECISION_RECIPES} from './catalog.ts';
import {applyAiReleaseDecisionRecipes} from './apply.ts';
import type {AiReleaseDecisionMethod} from './contracts.ts';

const at='2026-09-12T12:00:00Z',identity='22222222-2222-4222-8222-222222222222';
const ids=['travel.general_coverage','travel.fare_basis','travel.ticket_options','travel.rounding'];
function method(id:string):AiReleaseDecisionMethod{const r=AI_RELEASE_DECISION_RECIPES.find(r=>r.decision_id===id)!;return {recipe_id:r.recipe_id,recipe_version:r.recipe_version,recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,
 interpretation_receipt_sha256:canonicalSha256({synthetic_method:id}),source_receipts:r.legal_sources.map(s=>({source_version_id:s.version_id,artifact_sha256:s.file_sha256,receipt_sha256:canonicalSha256({synthetic_source:s.version_id})})),issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'};}
function raw(){const i=nineTopicRuntimeSource(),t=travelEntitlementInputSchema.parse(i.entitlement_evidence!.travel),s={...t.discounted_daily_fare!.source,reading:'identified_document_reading' as const};
 t.product_facts=travelProductFacts();t.applicability=t.applicability.filter(d=>d.decision_id==='travel.no_better_arrangement');
 t.discounted_daily_fare!.source={...s,locator:'Synthetic tariff daily cell'};t.monthly_pass_cost!.source={...s,locator:'Synthetic tariff monthly cell'};
 const fact=<T>(value:T)=>({state:'observed' as const,value,source:s});
 t.fare_source_context={schema_version:'travel-fare-source-context-v1',route_reference:fact('Synthetic route A'),discount_profile:fact('standard_adult'),association:fact('same_route_tariff_group'),
  effective_period:fact({from:'2026-05-01',to:'2026-07-31'}),directions:fact('both'),ticket_inventory:fact('complete'),monthly_pass_availability:fact('available'),
  daily_fare_operand_sha256:canonicalSha256(t.discounted_daily_fare),monthly_pass_operand_sha256:canonicalSha256(t.monthly_pass_cost)};
 const manifestIds=new Set(t.source_manifest.map(s=>s.document_id));i.documents=i.documents.filter(d=>manifestIds.has(d.document_id));
 const c=parseReviewCompletionInput(i.completion_input);i.completion_input={...c,documents:c.documents.filter(d=>manifestIds.has(d.pin.document_id))};
 i.entitlement_evidence=enableSharedPersonalFacts({schema_version:'entitlement-source-evidence-v1',case_id:i.case_id,order_id:i.purchased_scope.order_id,receipt_sha256:i.purchased_scope.receipt_sha256,period:i.period,travel:t},SHARED_PERSONAL_FACTS_TRAVEL_POLICY);return i;
}
function request(i:DocumentReviewInput,key:string){const t=travelEntitlementInputSchema.parse(i.entitlement_evidence!.travel),pins=i.documents.filter(d=>t.source_manifest.some(m=>m.kind==='case_document'&&m.document_id===d.document_id)).map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256})),path='product_facts.'+key;
 const fk=`entitlement.travel.${canonicalSha256({period:i.period,pins,path,key:'personal.'+path}).slice(0,28)}`;
 const r=runDocumentReview(i,'synthetic.lookup').completions.customer_requests.find(q=>q.target.fact_key===fk);expect(r).toBeDefined();return r!;
}
function answer(i:DocumentReviewInput,r:ReviewCompletion,value:string|null,index:number,revision=1){return applyDocumentReviewAnswer(i,{request:r,actor:{case_id:i.case_id,identity_id:identity},answer:{request_id:`55555555-5555-4555-8555-${String(index).padStart(12,'0')}`,revision,answered_at:at,state:value===null?'unknown':'provided',value}}).input;}
function answered(i=raw()){let input=composeEntitlementReview(i);for(const [index,[key,value]]of [['employment_relationship','שכיר או שכירה'],['workplace_sector','המגזר הפרטי'],['personal_discount_profile','פרופיל מבוגר רגיל, ללא הנחה אישית']].entries())input=answer(input,request(input,key),value,index+1);return input;}
const apply=(source:DocumentReviewInput,selected=ids)=>applyAiReleaseDecisionRecipes({source,methods:selected.map(method),at});

describe('travel case decisions through ordinary typed answers and exact source cells',()=>{
 it.each([['190.00',1000],['200.00',0],['210.00',-1000]] as const)('computes expected 200 and signed comparison for recorded %s after actual factual completions', (recorded,difference)=>{
  const i=raw(),t=travelEntitlementInputSchema.parse(i.entitlement_evidence!.travel);t.recorded!.printed_value=recorded;i.entitlement_evidence!.travel=t;
  const s=answered(i),before=canonicalSha256(s.answer_history),a=apply(s),r=runDocumentReview(a.source,'synthetic.travel.normal');
  expect(a.receipts).toHaveLength(4);expect(a.unresolved).toEqual([]);expect(a.receipts.every(d=>d.human_attestation===null)).toBe(true);
  expect(r.checks.find(c=>c.check_id.endsWith('.expected'))?.calculation.expected).toMatchObject({minor_units:20000});
  expect(r.checks.find(c=>c.check_id.endsWith('.comparison'))?.calculation.difference).toMatchObject({minor_units:difference});
  expect(canonicalSha256(a.source.answer_history)).toBe(before);expect(a.source.answer_history).toHaveLength(3);expect(replayDocumentReview(r)).toEqual(r);
  const effective=travelEntitlementInputSchema.parse(a.source.entitlement_composition!.evidence.travel);expect(effective.product_facts!.workplace_sector).toMatchObject({state:'declared',value:'private'});
  for(const receipt of a.receipts.filter(r=>r.recipe_id.startsWith('ai-case.travel.')))expect(receipt.consumed).toEqual(travelCaseConsumed(effective,evaluateTravelCaseRecipe(receipt.decision_id,effective,a.source).consumed_paths));
 });
 it('keeps unknown and supported corrections in history and retires only the consumed decision',()=>{
  const s=answered(),a=apply(s),r=request(composeEntitlementReview(raw()),'personal_discount_profile'),unknown=answer(a.source,r,null,3,2);
  const effective=travelEntitlementInputSchema.parse(unknown.entitlement_composition!.evidence.travel);
  expect(effective.applicability.find(d=>d.decision_id==='travel.general_coverage')?.state).toBe('accepted');expect(effective.applicability.find(d=>d.decision_id==='travel.fare_basis')?.state).toBe('stale');
  expect(runDocumentReview(unknown,'unknown').checks.every(c=>c.calculation.state==='blocked')).toBe(true);expect(unknown.answer_history).toHaveLength(4);
  const correct=answer(unknown,r,'פרופיל מבוגר רגיל, ללא הנחה אישית',3,3);expect(correct.answer_history).toHaveLength(5);
  expect(travelEntitlementInputSchema.parse(correct.entitlement_composition!.evidence.travel).applicability.find(d=>d.decision_id==='travel.fare_basis')?.state).toBe('stale');
  expect(runDocumentReview(correct,'restore-exact').checks.every(c=>c.calculation.state==='blocked')).toBe(true);
 });
 it('does not turn missing source context, a partial ticket inventory or a declared fare into an admission',()=>{
  for(const kind of ['context','inventory','declared'] as const){const i=raw(),t=travelEntitlementInputSchema.parse(i.entitlement_evidence!.travel);
   if(kind==='context')delete t.fare_source_context;if(kind==='inventory')t.fare_source_context!.ticket_inventory.value='partial';if(kind==='declared'){t.discounted_daily_fare!.state='declared';t.fare_source_context!.daily_fare_operand_sha256=canonicalSha256(t.discounted_daily_fare);}
   i.entitlement_evidence!.travel=t;if(kind==='declared'){expect(()=>answered(i)).toThrow('DOCUMENT_REVIEW_DECLARED_SOURCE');continue;}
   const a=apply(answered(i));expect(a.receipts.some(r=>r.decision_id==='travel.ticket_options')).toBe(false);
   if(kind!=='inventory')expect(a.receipts.some(r=>r.decision_id==='travel.fare_basis')).toBe(false);
   expect(runDocumentReview(a.source,'missing').checks.every(c=>c.calculation.state==='blocked')).toBe(true);
  }
 });
 it('allows a source-proven zero branch without asking or consuming prices or personal discount',()=>{
  const i=raw(),t=travelEntitlementInputSchema.parse(i.entitlement_evidence!.travel);t.facts.needs_transport.value=false;t.discounted_daily_fare=null;t.monthly_pass_cost=null;t.monthly_pass={state:'unknown',value:null,source:null,basis:'ai_source_assessment'};delete t.fare_source_context;i.entitlement_evidence!.travel=t;
  let s=composeEntitlementReview(i);for(const [index,[key,value]]of [['employment_relationship','שכיר או שכירה'],['workplace_sector','המגזר הפרטי']].entries())s=answer(s,request(s,key),value,index+1);
  const a=apply(s,['travel.general_coverage']);expect(a.receipts).toHaveLength(1);expect(a.receipts[0].consumed.some(f=>/fare|pass|discount/u.test(f.path))).toBe(false);
  expect(runDocumentReview(a.source,'zero').checks.find(c=>c.check_id.endsWith('.expected'))?.calculation.expected).toMatchObject({minor_units:0});
 });
 it('preserves unsupported employment and explicit unknown decisions; missing arrangement remains independent',()=>{
  let s=answered();const r=request(composeEntitlementReview(raw()),'employment_relationship');s=answer(s,r,'עצמאי או עצמאית',1,2);expect(apply(s).unresolved).toContainEqual(expect.objectContaining({decision_id:'travel.general_coverage',reason:'unsupported_employment_scope'}));
  const i=raw(),t=travelEntitlementInputSchema.parse(i.entitlement_evidence!.travel);t.applicability=[];i.entitlement_evidence!.travel=t;const a=apply(answered(i));
  expect(a.receipts).toHaveLength(4);expect(runDocumentReview(a.source,'arrangement').checks.every(c=>c.calculation.state==='blocked')).toBe(true);
  const j=raw(),p=travelEntitlementInputSchema.parse(j.entitlement_evidence!.travel);p.applicability.push({decision_id:'travel.general_coverage',state:'unknown',basis:'ai_source_assessment',explanation:'Explicit unresolved source assessment',sources:[],valid_until:null});j.entitlement_evidence!.travel=p;
  expect(apply(answered(j)).unresolved).toContainEqual(expect.objectContaining({decision_id:'travel.general_coverage',reason:'existing_decision_preserved'}));
 });
 it('rejects cross-field answer reuse even for two boolean personal choices',()=>{
  const s=answered(),packet=structuredClone(s.entitlement_composition!.evidence),t=travelEntitlementInputSchema.parse(packet.travel);t.product_facts!.other_travel_terms_known={state:'declared',value:false,source:t.product_facts!.workplace_sector.source};packet.travel=t;
  expect(()=>assertEntitlementSourcePacket(s,packet,entitlementLegalDocuments(s.case_id,['travel']))).toThrow('ENTITLEMENT_PERSONAL_ANSWER_TARGET');
 });
 it('omits an unused arrangement question only while an independent source assessment is current',()=>{
  const i=composeEntitlementReview(raw());expect(runDocumentReview(i,'current').completions.customer_requests.some(q=>/הסדר נסיעות נוסף/u.test(q.target.question))).toBe(false);
  for(const invalid of ['unknown','expired','source'] as const){const s=raw(),t=travelEntitlementInputSchema.parse(s.entitlement_evidence!.travel),d=t.applicability[0];
   if(invalid==='unknown')d.state='unknown';if(invalid==='expired')d.valid_until=t.evaluated_at;if(invalid==='source')d.sources=[];s.entitlement_evidence!.travel=t;
   expect(runDocumentReview(composeEntitlementReview(s),'unresolved').completions.customer_requests.some(q=>/הסדר נסיעות נוסף/u.test(q.target.question))).toBe(true);
  }
 });
});
