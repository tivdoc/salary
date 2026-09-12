import {describe,it,expect,vi,beforeEach} from 'vitest';
vi.mock('server-only',()=>({}));
vi.mock('./source-dispatch',()=>({lockCurrentSource:vi.fn(async()=>{})}));
const scope=vi.hoisted(()=>({topics:['travel'],months:['2026-06']}));
vi.mock('./saved-order-scope',()=>({readSavedOrders:vi.fn(async()=>[scope]),purchasedMonths:()=>scope.months}));
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {travelFloorFixture,travelFloorReview,travelFixtureCase} from '@/engine/entitlement-review/travel/floor.fixture';
import {travelEntitlementInputSchema} from '@/engine/entitlement-review/travel/contracts';
import {resolveTravelEntitlement} from '@/engine/entitlement-review/travel/index';
import {calculateDocumentReview} from '@/engine/document-review/calculations';
import {applyDocumentReviewAnswer,runDocumentReview} from '@/engine/document-review/service';
import {parseReviewCompletionInput,generateReviewCompletions} from '@/engine/document-review/completions';
import {composeEntitlementReview,assertEntitlementComposition} from '@/engine/entitlement-review/compose';
import {travelProductFacts,TRAVEL_JOURNEY_FACTS_POLICY} from '@/engine/entitlement-review/travel/product-facts';
import {travelJourneyFactKey} from '@/engine/entitlement-review/travel/journey-facts';
import {enableSharedPersonalFacts,SHARED_PERSONAL_FACTS_EXPANDED_POLICY} from '@/engine/entitlement-review/shared-product-facts';
import {applyAiReleaseDecisionRecipes} from '@/engine/ai-release-decisions/apply';
import {AI_RELEASE_DECISION_RECIPES} from '@/engine/ai-release-decisions/catalog';
import {documentTravelTariffTarget,documentTravelTariffSourceSchema} from '../reports/document-travel-tariff';
import {savedTravelTariffPurposeSchema,savedTravelTariffReadings,attachSavedTravelTariffReadings,projectSavedTravelTariffCompletions,readSavedTravelTariffReadings,openSavedTravelTariffRequests} from './saved-travel-tariff-readings';
import {assessReviewUpload,buildReviewUploadReceipt,type ReviewUploadScope} from '../documents/review-fulfillment';
import type {PostgresTransactionContext,PostgresStatement} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch';

const uuid=(n:number)=>`99999999-9999-4999-8999-${String(n).padStart(12,'0')}`;
function purpose(overrides:Record<string,unknown>={}){
 const body={schema_version:'document-source-purpose-v1',purpose_id:uuid(1),case_id:travelFixtureCase,document_id:uuid(2),version_id:uuid(3),file_sha256:'a'.repeat(64),
  document_type:'other',evidence_purpose:'travel_tariff',month:'2026-06',page_count:2,group:{page:1,locator:'Synthetic route and tickets'},identity_id:uuid(4),recorded_at:'2026-09-12T12:00:00Z',...overrides};
 return savedTravelTariffPurposeSchema.parse({...body,purpose_sha256:canonicalSha256(body)});
}
function fixture(){
 const p=purpose(),pin={id:p.document_id,version_id:p.version_id,sha256:p.file_sha256,type:p.document_type};
 const source=documentTravelTariffSourceSchema.parse({document:{case_id:p.case_id,document_id:p.document_id,version_id:p.version_id,file_sha256:p.file_sha256,
  month:p.month,page_count:p.page_count,document_type:p.document_type,evidence_purpose:p.evidence_purpose,purpose_sha256:p.purpose_sha256},group:p.group});
 const travel=travelFloorFixture(false);travel.discounted_daily_fare=null;travel.monthly_pass_cost=null;
 travel.monthly_pass={state:'missing',value:null,source:null,basis:'ai_source_assessment'};
 const review=travelFloorReview(travel),subjects=['context','daily_fare','ticket_inventory','monthly_pass_cost'] as const;
 const values={context:{route_reference:'Synthetic route A',discount_profile:'standard_adult',effective_period:{from:'2026-05-01',to:'2026-07-31'},directions:'both'},
  daily_fare:'12.00',ticket_inventory:{ticket_inventory:'complete',monthly_pass_availability:'available'},monthly_pass_cost:'200.00'};
 const answer=(subject:typeof subjects[number],action:'correct'|'unknown'|'unreadable'='correct',revision=1)=>{
  const target=documentTravelTariffTarget({source,subject});
  return {id:uuid(10+subjects.indexOf(subject)),case_id:p.case_id,scope_month:p.month,code:`document_field:${target.target_sha256}`,answer_kind:'choice',
   answer:JSON.stringify(action==='correct'?{schema_version:'document-field-answer-v3',action,structured_value:{kind:'travel_tariff',subject,value:values[subject],
    basis:{page:1,locator:'Synthetic printed '+subject,text:'Synthetic explicit source transcription, not a legal approval'}}}:{schema_version:'document-field-answer-v3',action}),
   answer_revision:revision,answer_identity_id:uuid(4),answer_created_at:'2026-09-12T12:00:00Z',field_target:target};
 };
 const journal={case_id:p.case_id,documents:[pin],source_purposes:[p],answers:subjects.map(s=>answer(s))};
 const load=()=>savedTravelTariffReadings({caseId:p.case_id,month:p.month,journal,currentDocuments:[pin]});
 return {p,pin,source,travel,review,journal,answer,load};
}
function transaction(f=fixture()){
 const job:SourceJob={schema_version:'saved-case-work-v1',case_id:f.p.case_id,revision:17,input_sha256:'c'.repeat(64),mode:'draft'};
 const opened:unknown[]=[],queries:string[]=[];let badHash=false;
 const context:PostgresTransactionContext={transaction_id:'synthetic-tariff',client:{async query(q:PostgresStatement){
  queries.push(q.name);
  if(q.name==='saved_travel_tariff_journal')return {row_count:1,rows:[{input:f.journal,input_sha256:job.input_sha256,actual_sha256:badHash?'f'.repeat(64):job.input_sha256,current_documents:[f.pin]}]};
  if(q.name==='saved_travel_tariff_open'){opened.push(JSON.parse(String(q.values[3])));return {row_count:1,rows:[{id:uuid(100+opened.length)}]};}
  throw Error('UNEXPECTED_QUERY:'+q.name);
 }}};
 return {f,job,context,opened,queries,tamper(){badHash=true;}};
}
beforeEach(()=>{scope.topics=['travel'];scope.months=['2026-06'];vi.clearAllMocks();});
describe('saved tariff purpose → authenticated journal → ordinary travel operands',()=>{
 it('replays four exact source readings without OCR and registers only their reconstructed receipt hashes',()=>{
  const f=fixture(),before=canonicalSha256(f.journal),loaded=f.load(),out=attachSavedTravelTariffReadings(f.review,loaded);
  const t=travelEntitlementInputSchema.parse(out.input.entitlement_evidence!.travel),doc=out.input.documents.find(d=>d.version_id===f.p.version_id)!;
  expect(t).toMatchObject({calculation_policy:'travel-general-order-floor-v2',discounted_daily_fare:{printed_value:'12.00'},monthly_pass_cost:{printed_value:'200.00'}});
  expect(doc.accepted_reading_sha256).toHaveLength(4);expect(new Set(doc.accepted_reading_sha256).size).toBe(4);
  expect(doc.accepted_reading_sha256).toContain(t.discounted_daily_fare!.source.reading_receipt_sha256);
  expect(out.dependencies.every(d=>d.answered)).toBe(true);expect(out.history.every(h=>h.current)).toBe(true);
  expect(t.applicability).toEqual(f.travel.applicability);expect(canonicalSha256(f.journal)).toBe(before);expect(f.review.documents).toHaveLength(1);
 });
 it('passes the reconstructed amounts through the existing candidate RuleSpec executor',()=>{
  const f=fixture();f.travel.calculation_policy='travel-general-order-floor-v2';f.travel.applicability=travelFloorFixture().applicability;
  const out=attachSavedTravelTariffReadings(travelFloorReview(f.travel),f.load()),resolved=resolveTravelEntitlement(out.input.entitlement_evidence!.travel);
  const comparison=resolved.checks.find(c=>c.check_id.endsWith('.comparison'));if(!comparison)throw Error('TEST_COMPARISON_REQUIRED');
  expect(calculateDocumentReview(comparison.calculation)).toMatchObject({state:'calculated',expected:{minor_units:20000},recorded:{minor_units:19000},difference:{minor_units:1000},real_activation_allowed:false});
 });
 it('lets ordinary source admission and versioned case recipes consume the reconstructed receipts without approving them in the loader',()=>{
  const f=fixture();f.travel.applicability=f.travel.applicability.filter(d=>d.decision_id==='travel.rounding');
  const loaded=attachSavedTravelTariffReadings(travelFloorReview(f.travel),f.load());
  const methods=AI_RELEASE_DECISION_RECIPES.filter(r=>r.recipe_id.startsWith('ai-case.travel.')&&r.recipe_id.endsWith('.floor-v2')).map(r=>({
   recipe_id:r.recipe_id,recipe_version:r.recipe_version,recipe_sha256:r.recipe_sha256,source_policy_sha256:r.source_policy_sha256,
   interpretation_receipt_sha256:'f'.repeat(64),source_receipts:r.legal_sources.map(s=>({source_version_id:s.version_id,artifact_sha256:s.file_sha256,receipt_sha256:canonicalSha256({synthetic:s.version_id})})),
   issued_at:'2026-09-12T00:00:00Z',expires_at:'2026-09-13T00:00:00Z'}));
  const applied=applyAiReleaseDecisionRecipes({source:loaded.input,methods,at:'2026-09-12T12:00:00Z'});
  expect(applied.receipts).toHaveLength(4);expect(applied.unresolved).toEqual([]);
  expect(runDocumentReview(applied.source,'synthetic.saved.tariff').checks.find(c=>c.check_id==='synthetic.travel.comparison')?.calculation)
   .toMatchObject({state:'calculated',expected:{minor_units:20000},difference:{minor_units:1000}});
  expect(travelEntitlementInputSchema.parse(loaded.input.entitlement_evidence!.travel).applicability).toEqual(f.travel.applicability);
 });
 it.each(['unknown','unreadable'] as const)('uses latest %s answer and does not reopen it or borrow its former numeric receipt',action=>{
  const f=fixture(),previous=attachSavedTravelTariffReadings(f.review,f.load());
  f.journal.answers=f.journal.answers.map(a=>a.id===f.answer('daily_fare').id?f.answer('daily_fare',action,2):a);
  const out=attachSavedTravelTariffReadings(f.review,f.load()),t=travelEntitlementInputSchema.parse(out.input.entitlement_evidence!.travel);
  expect(t.discounted_daily_fare).toMatchObject({state:action,printed_value:null});expect(out.dependencies.find(d=>d.target.subject==='daily_fare')).toMatchObject({answered:true,state:action});
  const old=travelEntitlementInputSchema.parse(previous.input.entitlement_evidence!.travel).discounted_daily_fare!.source.reading_receipt_sha256;
  expect(out.input.documents.find(d=>d.version_id===f.p.version_id)?.accepted_reading_sha256).not.toContain(old);
 });
 it('keeps old version answers historical after replacement and never authorizes new bytes with the old purpose',()=>{
  const f=fixture();f.journal.documents=[{...f.pin,version_id:uuid(30),sha256:'d'.repeat(64)}];
  const saved=savedTravelTariffReadings({caseId:f.p.case_id,month:'2026-06',journal:f.journal,currentDocuments:f.journal.documents});
  expect(saved.records).toEqual([]);expect(saved.history).toHaveLength(4);expect(saved.history.every(h=>!h.current)).toBe(true);
  expect(attachSavedTravelTariffReadings(f.review,saved).input).toBe(f.review);
 });
 it('rejects foreign answer identity scope, invalid purpose bytes and current source changes',()=>{
  const foreign=fixture();foreign.journal.answers[0].case_id=uuid(80);expect(()=>foreign.load()).toThrow('REQUEST_FIELD_CASE_MISMATCH');
  const hash=fixture();hash.journal.source_purposes[0].group.locator='Changed';expect(()=>hash.load()).toThrow('SAVED_TARIFF_PURPOSE_HASH');
  const source=fixture();expect(()=>savedTravelTariffReadings({caseId:source.p.case_id,month:'2026-06',journal:source.journal,currentDocuments:[{...source.pin,sha256:'f'.repeat(64)}]})).toThrow('SAVED_TARIFF_CURRENT_SOURCE');
 });
 it('rejects duplicate answer rows and duplicate current requests for the same subject',()=>{
  const f=fixture();f.journal.answers.push(f.journal.answers[0]);expect(()=>f.load()).toThrow('SAVED_REQUEST_ID_AMBIGUOUS');
  const g=fixture();g.journal.answers.push({...g.journal.answers[0],id:uuid(71)});expect(()=>attachSavedTravelTariffReadings(g.review,g.load())).toThrow('TRAVEL_TARIFF_MULTIPLE_ACTIVE_REQUESTS');
 });
 it('does not borrow a purchased-month reading for a different month',()=>{
  const f=fixture(),loaded=savedTravelTariffReadings({caseId:f.p.case_id,month:'2026-07',journal:f.journal,currentDocuments:[f.pin]});
  expect(loaded.records).toEqual([]);expect(loaded.history.every(h=>!h.current)).toBe(true);
 });
 it('preserves independent existing fare observations as a conflict rather than silently correcting them',()=>{
  const f=fixture(),existing=travelFloorFixture();existing.discounted_daily_fare!.printed_value='15.00';
  const out=attachSavedTravelTariffReadings(travelFloorReview(existing),f.load());
  expect(travelEntitlementInputSchema.parse(out.input.entitlement_evidence!.travel).discounted_daily_fare).toMatchObject({state:'conflict',printed_value:null});
 });
 it('keeps a multiple-purpose association gap explicit without selecting whichever amount would calculate',()=>{
  const f=fixture(),second=purpose({purpose_id:uuid(41),document_id:uuid(42),version_id:uuid(43)}),pin={id:second.document_id,version_id:second.version_id,sha256:second.file_sha256,type:'other' as const};
  f.journal.source_purposes.push(second);f.journal.documents.push(pin);
  const loaded=savedTravelTariffReadings({caseId:f.p.case_id,month:'2026-06',journal:f.journal,currentDocuments:[f.pin,pin]}),out=attachSavedTravelTariffReadings(f.review,loaded);
  expect(out.dependencies).toEqual([]);expect(out.input.coverage_gaps).toEqual(expect.arrayContaining([expect.objectContaining({kind:'missing_fact',topic:'travel'})]));
  expect(travelEntitlementInputSchema.parse(out.input.entitlement_evidence!.travel).discounted_daily_fare).toBeNull();
 });
 it('preserves absent-purpose historical input bytes',()=>{
  const f=fixture();f.journal.source_purposes=[];expect(attachSavedTravelTariffReadings(f.review,f.load()).input).toBe(f.review);
 });
});
describe('same-run tariff source completion projection',()=>{
 const planner=(input:Parameters<typeof projectSavedTravelTariffCompletions>[0])=>parseReviewCompletionInput(input.completion_input);
 const tariffNeeds=(input:Parameters<typeof planner>[0])=>planner(input).needs.filter(n=>n.fact_key==='travel.tariff_source');
 const tariffEvidence=(input:Parameters<typeof planner>[0])=>planner(input).evidence.filter(e=>e.fact_key==='travel.tariff_source');
 function current(f=fixture()){
  f.travel.calculation_policy='travel-general-order-floor-v2';
  const input=travelFloorReview(f.travel);input.purchased_scope.order_id=uuid(150);input.entitlement_evidence!.order_id=uuid(150);
  if(f.travel.product_facts?.schema_version===TRAVEL_JOURNEY_FACTS_POLICY)input.entitlement_evidence=enableSharedPersonalFacts(input.entitlement_evidence!,SHARED_PERSONAL_FACTS_EXPANDED_POLICY);
  input.completion_input={...parseReviewCompletionInput(input.completion_input),documents:input.documents.map(d=>({
   pin:{case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256},kind:d.kind,period:d.period,review:'partial'}))};
  return composeEntitlementReview(attachSavedTravelTariffReadings(input,f.load()).input);
 }
 it('creates one exact upload target only for required travel without a current purpose, with stable retry and raw bytes',()=>{
  const f=fixture();f.journal.source_purposes=[];const input=current(f),before=canonicalSha256(input),out=projectSavedTravelTariffCompletions(input,f.load());
  expect(tariffNeeds(out)).toHaveLength(1);expect(tariffNeeds(out)[0]).toMatchObject({document_kind:'other',answer_kind:'document',required_evidence_kind:'document',
   source_pins:[],dependent_check_ids:['synthetic.travel.expected','synthetic.travel.comparison']});
  expect(runDocumentReview(out,'synthetic.source-needed').completions.customer_requests.filter(r=>r.target.fact_key==='travel.tariff_source')).toHaveLength(1);
  expect(projectSavedTravelTariffCompletions(out,f.load())).toEqual(out);expect(canonicalSha256(input)).toBe(before);
  expect(out.entitlement_evidence).toEqual(input.entitlement_evidence);expect(out.answer_history).toEqual(input.answer_history);assertEntitlementComposition(out);
 });
 it('records received context information while prices remain missing, satisfying the exact upload receipt only',()=>{
  const f=fixture(),absent=fixture();absent.journal.source_purposes=[];
  const initial=projectSavedTravelTariffCompletions(current(absent),absent.load());
  const request=generateReviewCompletions(planner(initial)).customer_requests.find(r=>r.target.fact_key==='travel.tariff_source')!;
  f.journal.answers=[f.answer('context')];const input=current(f),out=projectSavedTravelTariffCompletions(input,f.load());
  expect(tariffNeeds(out)).toEqual([]);expect(tariffEvidence(out)).toHaveLength(1);expect(tariffEvidence(out)[0]).toMatchObject({origin:'document',state:'observed',source_reviewed:true});
  expect(JSON.parse(String(tariffEvidence(out)[0].value))).toMatchObject({subject:'context',value:{route_reference:'Synthetic route A'}});
  expect(travelEntitlementInputSchema.parse(out.entitlement_composition!.evidence.travel).discounted_daily_fare).toBeNull();
  const uploadScope:ReviewUploadScope={request_id:uuid(151),request,order_id:uuid(150),order_origin:'saved_order',order_receipt_sha256:out.purchased_scope.receipt_sha256};
  const pin={case_id:f.p.case_id,document_id:f.p.document_id,version_id:f.p.version_id,source_sha256:f.p.file_sha256};
  const receipt=buildReviewUploadReceipt({scope:uploadScope,case_id:f.p.case_id,batch_id:uuid(152),received_at:'2026-09-12T12:00:00Z',existing_source_hashes:[],
   files:[{document_id:pin.document_id,version_id:pin.version_id,source_sha256:pin.source_sha256,document_kind:'other',period_month:null,duplicate_content:false,tariff_source:f.source}]});
  expect(assessReviewUpload({scope:uploadScope,receipt,review:runDocumentReview(out,'synthetic.context-only'),current_source_pins:[pin]})).toMatchObject({state:'satisfied',information_satisfied:true});
  expect(projectSavedTravelTariffCompletions(out,f.load())).toEqual(out);expect(out.answer_history).toEqual(input.answer_history);
 });
 it.each(['unknown','unreadable'] as const)('retains %s context history without a new upload or false observed information',action=>{
  const f=fixture();f.journal.answers=[f.answer('context',action,2)];const input=current(f),out=projectSavedTravelTariffCompletions(input,f.load());
  expect(tariffNeeds(out)).toEqual([]);expect(tariffEvidence(out)).toEqual([expect.objectContaining({state:'unknown',value:null})]);
  expect(f.load().history).toEqual([expect.objectContaining({answer_revision:2,current:true})]);
  expect(out.entitlement_evidence).toEqual(input.entitlement_evidence);assertEntitlementComposition(out);
 });
 it('does not confuse an uploaded but unread context with information or request its file again',()=>{
  const f=fixture();f.journal.answers=[];const out=projectSavedTravelTariffCompletions(current(f),f.load());
  expect(tariffNeeds(out)).toEqual([]);expect(tariffEvidence(out)).toEqual([]);
  expect(out.coverage_gaps.some(g=>g.topic==='travel')).toBe(true);
 });
 it.each(['route','profile','period','directions'] as const)('keeps an identified but mismatched %s context conflicted',change=>{
  const f=fixture(),a=f.answer('context'),answer=JSON.parse(a.answer);
  if(change==='route')f.travel.product_facts!.route_reference={...f.travel.product_facts!.personal_discount_profile,value:'Different declared route'};
  else if(change==='profile')answer.structured_value.value.discount_profile='special_discount';
  else if(change==='period')answer.structured_value.value.effective_period={from:'2026-07-01',to:'2026-07-31'};
  else answer.structured_value.value.directions='outbound';
  a.answer=JSON.stringify(answer);f.journal.answers=[a];
  const out=projectSavedTravelTariffCompletions(current(f),f.load());expect(tariffNeeds(out)).toEqual([]);
  expect(tariffEvidence(out)).toEqual([expect.objectContaining({state:'conflicted',value:null})]);
 });
 it('does not borrow a foreign/currently replaced source or a caller-mutated effective context',()=>{
  const f=fixture(),input=current(f),foreign=fixture();foreign.journal.source_purposes=[purpose({month:'2026-07'})];
  const other=savedTravelTariffReadings({caseId:f.p.case_id,month:'2026-07',journal:foreign.journal,currentDocuments:[foreign.pin]});
  expect(()=>projectSavedTravelTariffCompletions(input,other)).toThrow('SAVED_TARIFF_COMPLETION_SCOPE');
  const changed=structuredClone(input),t=travelEntitlementInputSchema.parse(changed.entitlement_composition!.evidence.travel);
  t.fare_source_context!.route_reference.value='Caller replacement';changed.entitlement_composition!.evidence.travel=t;
  const {composition_sha256,...forgedBody}=changed.entitlement_composition!;void composition_sha256;
  changed.entitlement_composition!.composition_sha256=canonicalSha256(forgedBody);
  expect(()=>projectSavedTravelTariffCompletions(changed,f.load())).toThrow('ENTITLEMENT_COMPOSITION_REPLAY');
  const replaced=fixture();replaced.journal.documents=[{...replaced.pin,version_id:uuid(170),sha256:'d'.repeat(64)}];
  const saved=savedTravelTariffReadings({caseId:f.p.case_id,month:'2026-06',journal:replaced.journal,currentDocuments:replaced.journal.documents});
  const fresh=current({...replaced,load:()=>saved});expect(tariffEvidence(projectSavedTravelTariffCompletions(fresh,saved))).toEqual([]);
  expect(tariffNeeds(projectSavedTravelTariffCompletions(fresh,saved))).toHaveLength(1);expect(saved.history.every(h=>!h.current)).toBe(true);
 });
 it('uses authenticated arrival answers after composition and keeps zero/unknown distinct',async()=>{
  const f=fixture();f.journal.answers=[];f.journal.source_purposes=[];f.travel.commute_days=null;
  f.travel.product_facts={...travelProductFacts(TRAVEL_JOURNEY_FACTS_POLICY),employment_relationship:f.travel.product_facts!.employment_relationship,
   workplace_sector:f.travel.product_facts!.workplace_sector,personal_discount_profile:f.travel.product_facts!.personal_discount_profile};
  const initial=current(f),travel=travelEntitlementInputSchema.parse(initial.entitlement_composition!.evidence.travel);
  const request=runDocumentReview(initial,'synthetic.journey-before').completions.customer_requests.find(r=>r.target.fact_key===travelJourneyFactKey(initial,travel));
  if(!request)throw Error('TEST_JOURNEY_REQUEST');
  const answer=(input:typeof initial,value:string|null,revision:number)=>applyDocumentReviewAnswer(input,{request,actor:{case_id:input.case_id,identity_id:uuid(4)},
   answer:{request_id:uuid(180),revision,answered_at:'2026-09-12T12:00:00Z',state:value===null?'unknown':'provided',value}}).input;
  expect(tariffNeeds(projectSavedTravelTariffCompletions(initial,f.load()))).toEqual([]);
  const required=answer(initial,'20',1);expect(tariffNeeds(projectSavedTravelTariffCompletions(required,f.load()))).toHaveLength(1);
  expect(travelEntitlementInputSchema.parse(required.entitlement_evidence!.travel).commute_days).toBeNull();
  const zero=answer(required,'0',2);expect(tariffNeeds(projectSavedTravelTariffCompletions(zero,f.load()))).toEqual([]);
  const unknown=answer(zero,null,3);expect(tariffNeeds(projectSavedTravelTariffCompletions(unknown,f.load()))).toEqual([]);expect(unknown.answer_history).toHaveLength(3);
  const tx=transaction(f);expect(await openSavedTravelTariffRequests(tx.context,tx.job,'2026-06',zero)).toEqual([]);expect(tx.queries).not.toContain('saved_travel_tariff_journal');
 });
 it('leaves unmarked historical input and unpaid travel untouched',()=>{
  const f=fixture();expect(projectSavedTravelTariffCompletions(f.review,f.load())).toBe(f.review);
  const input=current(f);input.purchased_scope.topics=['pension'];expect(projectSavedTravelTariffCompletions(input,f.load())).toBe(input);
 });
});
describe('current saved request opening without a provider checkpoint',()=>{
 it('opens only three initial subject dependencies; monthly price waits for identified availability',async()=>{
  const t=transaction();t.f.journal.answers=[];
  const opened=await openSavedTravelTariffRequests(t.context,t.job,'2026-06',t.f.review);
  expect(opened.map(o=>o.subject)).toEqual(['context','daily_fare','ticket_inventory']);
  expect(t.opened).toHaveLength(3);expect(t.queries.every(q=>!q.includes('checkpoint'))).toBe(true);
  expect(t.opened[0]).toMatchObject({schema_version:'document-travel-tariff-transcription-v1',purpose_sha256:t.f.p.purpose_sha256,version_id:t.f.p.version_id});
 });
 it('opens only the now-required monthly cost and does not reopen answered unknown subjects',async()=>{
  const t=transaction();t.f.journal.answers=t.f.journal.answers.filter(a=>a.id!==t.f.answer('monthly_pass_cost').id).map(a=>a.id===t.f.answer('daily_fare').id?t.f.answer('daily_fare','unknown'):a);
  expect((await openSavedTravelTariffRequests(t.context,t.job,'2026-06',t.f.review)).map(o=>o.subject)).toEqual(['monthly_pass_cost']);
 });
 it('opens no tariff question for a source-supported no-transport case or an unpaid scope',async()=>{
  const t=transaction();t.f.journal.answers=[];const travel=travelEntitlementInputSchema.parse(t.f.review.entitlement_evidence!.travel);travel.facts.needs_transport.value=false;
  expect(await openSavedTravelTariffRequests(t.context,t.job,'2026-06',travelFloorReview(travel))).toEqual([]);
  scope.topics=['pension'];expect(await openSavedTravelTariffRequests(t.context,t.job,'2026-06',t.f.review)).toEqual([]);expect(t.opened).toEqual([]);
 });
 it('rejects changed immutable journal bytes before any target is opened',async()=>{
  const t=transaction();t.tamper();await expect(readSavedTravelTariffReadings(t.context,t.job,'2026-06')).rejects.toThrow('SAVED_INPUT_HASH_MISMATCH');expect(t.opened).toEqual([]);
 });
});
