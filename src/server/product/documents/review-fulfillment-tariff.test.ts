import {describe,it,expect} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {generateReviewCompletions,parseReviewCompletionInput} from '@/engine/document-review/completions';
import {applyDocumentReviewAnswer,runDocumentReview} from '@/engine/document-review/service';
import {composeEntitlementReview} from '@/engine/entitlement-review/compose';
import {enableSharedPersonalFacts,SHARED_PERSONAL_FACTS_EXPANDED_POLICY} from '@/engine/entitlement-review/shared-product-facts';
import {travelProductFacts,TRAVEL_JOURNEY_FACTS_POLICY} from '@/engine/entitlement-review/travel/product-facts';
import {travelJourneyFactKey} from '@/engine/entitlement-review/travel/journey-facts';
import {travelFloorFixture,travelFloorReview,travelFixtureCase} from '@/engine/entitlement-review/travel/floor.fixture';
import {materializeTravelTariffSource,travelTariffTarget,type TravelTariffJournalEntry} from '@/engine/entitlement-review/travel/tariff-source';
import {travelEntitlementInputSchema} from '@/engine/entitlement-review/travel/contracts';
import {documentTravelTariffSourceSchema} from '../reports/document-travel-tariff';
import {assessReviewUpload,buildReviewUploadReceipt,reviewUploadReceiptSchema,supportedReviewUpload,type ReviewUploadScope} from './review-fulfillment';

const uuid=(n:number)=>`90000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(action:'correct'|'unknown'|'unreadable'='correct'){
 const source=documentTravelTariffSourceSchema.parse({document:{case_id:travelFixtureCase,document_id:uuid(1),version_id:uuid(2),file_sha256:'a'.repeat(64),
  page_count:3,month:'2026-06',document_type:'other',evidence_purpose:'travel_tariff',purpose_sha256:'b'.repeat(64)},group:{page:2,locator:'Synthetic tariff table'}});
 const travel=travelFloorFixture();travel.discounted_daily_fare=null;travel.monthly_pass_cost=null;
 travel.monthly_pass={state:'missing',value:null,source:null,basis:'identified_document_reading'};
 const entry:TravelTariffJournalEntry={target:travelTariffTarget(source.document,source.group,'context'),request_id:uuid(3),answer_revision:1,identity_id:uuid(4),answered_at:'2026-09-12T00:00:00Z',
  answer:action==='correct'?{schema_version:'document-field-answer-v3',action,structured_value:{kind:'travel_tariff',subject:'context',
   value:{route_reference:'Synthetic route A',discount_profile:'standard_adult',directions:'both',effective_period:{from:'2026-05-01',to:'2026-07-31'}},
   basis:{page:2,locator:'Synthetic tariff context',text:'Synthetic route A; standard adult; both directions; May–July'}}}:{schema_version:'document-field-answer-v3',action}};
 const out=materializeTravelTariffSource({travel,current:source.document,group:source.group,journal:[entry]}),input=travelFloorReview(out.travel);
 input.purchased_scope.order_id=uuid(5);input.entitlement_evidence!.order_id=uuid(5);
 const pin={case_id:travelFixtureCase,document_id:source.document.document_id,version_id:source.document.version_id,source_sha256:source.document.file_sha256};
 input.documents.push({case_id:pin.case_id,document_id:pin.document_id,version_id:pin.version_id,file_sha256:pin.source_sha256,page_count:3,kind:'other',label:'Synthetic tariff PDF',
  period:null,reading_origin:'identified_document_reading',reading_sha256:canonicalSha256(out.receipts),accepted_reading_sha256:[...out.accepted_reading_sha256]});
 const request=generateReviewCompletions({case_id:travelFixtureCase,period:travel.period,documents:[],evidence:[],needs:[{
  fact_key:'travel.tariff_source',kind:'document',document_kind:'other',required_evidence_kind:'document',reason:'missing',answer_kind:'document',
  question:'נא לצרף מקור תעריף למסלול ולחודש הנבדקים.',source_pins:[],dependent_check_ids:['synthetic.travel.expected'],general_question:false}]}).customer_requests[0];
 const scope:ReviewUploadScope={request_id:uuid(6),request,order_id:uuid(5),order_origin:'saved_order',order_receipt_sha256:input.purchased_scope.receipt_sha256};
 const planner=parseReviewCompletionInput(input.completion_input);
 for(const document of input.documents.filter(d=>d.version_id!==pin.version_id))planner.documents.push({
  pin:{case_id:document.case_id,document_id:document.document_id,version_id:document.version_id,source_sha256:document.file_sha256},
  kind:document.kind,period:document.period,review:'partial'});
 planner.documents.push({pin,kind:'other',period:null,review:'partial'});
 planner.evidence.push({evidence_id:'synthetic.tariff.context',case_id:travelFixtureCase,fact_key:'travel.tariff_source',period:travel.period,
  origin:'document',state:action==='correct'?'observed':'unknown',value:action==='correct'?'Synthetic route A':null,source_reviewed:action==='correct',source_pins:[pin]});
 input.completion_input=planner;
 const file={document_id:pin.document_id,version_id:pin.version_id,source_sha256:pin.source_sha256,document_kind:'other' as const,period_month:null,duplicate_content:false,tariff_source:source};
 const receive={scope,case_id:travelFixtureCase,batch_id:uuid(7),received_at:'2026-09-12T00:00:00Z',files:[file],existing_source_hashes:[] as string[]};
 const assess=()=>assessReviewUpload({scope,receipt:buildReviewUploadReceipt(receive),review:runDocumentReview(composeEntitlementReview(input),'synthetic.tariff-upload'),current_source_pins:[pin]});
 return {source,input,pin,scope,receive,file,assess};
}

describe('versioned tariff review-upload information receipt',()=>{
 it('records one exact purpose-bound PDF without approving its readings or the travel calculation',()=>{
  const f=fixture(),r=buildReviewUploadReceipt(f.receive);
  expect(r).toMatchObject({schema_version:'document-review-upload-receipt-v2',fact_key:'travel.tariff_source',state:'received_pending_review',files:[f.file]});
  expect(r).not.toHaveProperty('information_satisfied');expect(r).not.toHaveProperty('legal_applicability_approved');
  expect(buildReviewUploadReceipt(f.receive)).toEqual(r);
  expect(()=>reviewUploadReceiptSchema.parse({...r,receipt_sha256:'f'.repeat(64)})).toThrow();
 });
 it.each(['fact','kind','evidence','month','span'] as const)('does not permit arbitrary other uploads through a %s change',change=>{
  const f=fixture(),t=f.scope.request.target;
  expect(supportedReviewUpload({...t,...(change==='fact'?{fact_key:'arbitrary.other'}:change==='kind'?{kind:'factual' as const}:
   change==='evidence'?{required_evidence_kind:'observed_reading' as const}:change==='month'?{period:{from:'2026-08-01',to:'2026-08-31'}}:{period:{from:'2026-05-01',to:'2026-06-30'}})})).toBe(false);
 });
 it.each(['case_id','document_id','version_id','file_sha256','month'] as const)('rejects a mismatched purpose %s even after rehashing the receipt',key=>{
  const f=fixture(),r=buildReviewUploadReceipt(f.receive);
  if(r.schema_version!=='document-review-upload-receipt-v2')throw Error('TEST_V2_REQUIRED');
  const document={...r.files[0].tariff_source.document,[key]:key==='file_sha256'?'c'.repeat(64):key==='month'?'2026-07':uuid(50)};
  const body={...r,files:[{...r.files[0],tariff_source:{...r.files[0].tariff_source,document}}]};
  const {receipt_sha256,...unsigned}=body;void receipt_sha256;
  expect(()=>reviewUploadReceiptSchema.parse({...unsigned,receipt_sha256:canonicalSha256(unsigned)})).toThrow();
 });
 it('rejects an ambiguous pair of tariff PDFs and marks duplicate bytes as insufficient',()=>{
  const f=fixture();expect(()=>buildReviewUploadReceipt({...f.receive,files:[f.file,f.file]})).toThrow();
  f.receive.existing_source_hashes=[f.pin.source_sha256];expect(f.assess()).toMatchObject({state:'insufficient',reason:'duplicate_content'});
 });
 it('satisfies only source information after the exact context reading while fare and ticket amounts remain missing',()=>{
  const f=fixture(),travel=travelEntitlementInputSchema.parse(f.input.entitlement_evidence!.travel);
  expect(travel.discounted_daily_fare).toBeNull();expect(travel.monthly_pass_cost).toBeNull();
  expect(f.assess()).toMatchObject({state:'satisfied',information_satisfied:true,customer_declaration_is_source:false,verified_source_pins:[f.pin]});
 });
 it.each(['unknown','unreadable'] as const)('does not treat an %s context as satisfied source information',action=>{
  expect(fixture(action).assess()).toMatchObject({state:'insufficient',information_satisfied:false});
 });
 it.each(['missing_evidence','declaration','wrong_fact','wrong_pin'] as const)('preserves the missing source for %s',change=>{
  const f=fixture(),planner=parseReviewCompletionInput(f.input.completion_input),original=planner.evidence[0];
  const evidence=change==='missing_evidence'?[]:[{...original,...(change==='declaration'?{origin:'answer' as const,state:'declared' as const}:
   change==='wrong_fact'?{fact_key:'unrelated.fact'}:{source_pins:[{...f.pin,version_id:uuid(90)}]})}];f.input.completion_input={...planner,evidence};
  if(change==='wrong_pin')expect(()=>f.assess()).toThrow('REVIEW_COMPLETION_SOURCE_STALE');
  else expect(f.assess()).toMatchObject({state:'insufficient',information_satisfied:false});
 });
 it('keeps a replaced file stale even when its context and original report were valid',()=>{
  const f=fixture();expect(assessReviewUpload({scope:f.scope,receipt:buildReviewUploadReceipt(f.receive),review:runDocumentReview(composeEntitlementReview(f.input),'synthetic.old-tariff'),
   current_source_pins:[{...f.pin,version_id:uuid(91)}]})).toMatchObject({state:'stale',reason:'submitted_source_replaced'});
 });
 it('uses replayed commute facts while retaining raw missing evidence and identified tariff context separately',()=>{
  const f=fixture(),travel=travelEntitlementInputSchema.parse(f.input.entitlement_evidence!.travel);
  travel.commute_days=null;
  travel.product_facts={...travelProductFacts(TRAVEL_JOURNEY_FACTS_POLICY),...travel.product_facts,schema_version:TRAVEL_JOURNEY_FACTS_POLICY,
   actual_commute_days:{state:'missing',value:null,source:null}};
  f.input.entitlement_evidence=enableSharedPersonalFacts({...f.input.entitlement_evidence!,travel},SHARED_PERSONAL_FACTS_EXPANDED_POLICY);
  const rawHash=canonicalSha256(f.input.entitlement_evidence),before=composeEntitlementReview(f.input);
  const request=runDocumentReview(before,'synthetic.tariff.route-before').completions.customer_requests.find(r=>r.target.fact_key===travelJourneyFactKey(before,travel));
  if(!request)throw Error('TEST_COMMUTE_REQUEST_REQUIRED');
  const next=applyDocumentReviewAnswer(before,{request,actor:{case_id:f.input.case_id,identity_id:uuid(60)},answer:{request_id:uuid(61),revision:1,
   answered_at:'2026-09-12T12:00:00Z',state:'provided',value:'20'}}).input;
  expect(canonicalSha256(next.entitlement_evidence)).toBe(rawHash);
  expect(travelEntitlementInputSchema.parse(next.entitlement_evidence!.travel).commute_days).toBeNull();
  const effective=travelEntitlementInputSchema.parse(next.entitlement_composition!.evidence.travel);
  expect(effective.commute_days).toMatchObject({state:'declared',printed_value:'20',source:{reading:'customer_declaration'}});
  expect(effective.fare_source_context?.route_reference.source?.reading).toBe('identified_document_reading');
  const review=runDocumentReview(next,'synthetic.tariff.route-after');
  expect(assessReviewUpload({scope:f.scope,receipt:buildReviewUploadReceipt(f.receive),review,current_source_pins:[f.pin]}))
   .toMatchObject({state:'satisfied',information_satisfied:true,customer_declaration_is_source:false});
  const {composition_sha256,...composition}=review.input.entitlement_composition!;void composition_sha256;
  const changed={...composition,evidence:{...composition.evidence,travel:{...effective,commute_days:{...effective.commute_days!,printed_value:'19'}}}};
  const forged={...review,input:{...review.input,entitlement_composition:{...changed,composition_sha256:canonicalSha256(changed)}}};
  expect(()=>assessReviewUpload({scope:f.scope,receipt:buildReviewUploadReceipt(f.receive),review:forged,current_source_pins:[f.pin]})).toThrow('ENTITLEMENT_COMPOSITION_REPLAY');
 });
 it.each(['purpose','group'] as const)('does not satisfy a resealed %s receipt using another identified context',change=>{
  const f=fixture(),original=buildReviewUploadReceipt(f.receive);if(original.schema_version!=='document-review-upload-receipt-v2')throw Error('TEST_V2_REQUIRED');
  const {receipt_sha256,...body}=original;void receipt_sha256;
  const tariff_source=change==='purpose'?{...f.source,document:{...f.source.document,purpose_sha256:'e'.repeat(64)}}:
   {...f.source,group:{...f.source.group,locator:'Another synthetic group'}};
  const changed={...body,files:[{...original.files[0],tariff_source}]},receipt=reviewUploadReceiptSchema.parse({...changed,receipt_sha256:canonicalSha256(changed)});
  expect(assessReviewUpload({scope:f.scope,receipt,review:runDocumentReview(composeEntitlementReview(f.input),'synthetic.wrong-purpose'),current_source_pins:[f.pin]}))
   .toMatchObject({state:'insufficient',reason:'tariff_source_context_not_verified'});
 });
});
