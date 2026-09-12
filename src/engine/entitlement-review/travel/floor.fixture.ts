import {travelEntitlementInputSchema,type TravelEntitlementInput} from './contracts.ts';
import {TRAVEL_APPLICABILITY,TRAVEL_FLOOR_APPLICABILITY} from './index.ts';
import {TRAVEL_GENERAL_ORDER_FLOOR_POLICY,travelFloorLegalSource} from './floor-policy.ts';
import {travelLegalSource} from './sources.ts';
import {travelProductFacts} from './product-facts.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../../document-review/contracts.ts';
import type {DocumentReviewOperand} from '../../document-review/calculations.ts';
export const travelFixtureCase='11111111-1111-4111-8111-111111111111';
export const travelFixtureSource={document_id:'22222222-2222-4222-8222-222222222222',version_id:'33333333-3333-4333-8333-333333333333',file_sha256:'c'.repeat(64),page:1,locator:'Synthetic monthly attendance/payroll source',label:'Synthetic data only',reading:'identified_document_reading' as const,reading_receipt_sha256:'b'.repeat(64)};
export function travelFloorFixture(floor=true):TravelEntitlementInput{
 const source=travelFixtureSource,known=(value:unknown)=>({state:'known',value,source,basis:'identified_document_reading'}),observed=(value:unknown)=>({state:'observed',value,source});
 const money=(id:string,printed_value:string):DocumentReviewOperand=>({id,observation_id:'synthetic.'+id,state:'observed',printed_value,representation:'money_ils',quantity_unit:null,precision:'printed_precision',source:{...source,locator:'Synthetic '+id}});
 return travelEntitlementInputSchema.parse({schema_version:'travel-entitlement-input-v1',catalog_id:'il.review.travel.general.2026',catalog_version:'1.0.0',...(floor?{calculation_policy:TRAVEL_GENERAL_ORDER_FLOOR_POLICY}:{}),
  case_id:travelFixtureCase,run_id:'synthetic.travel.run',check_prefix:'synthetic.travel',period:{from:'2026-06-01',to:'2026-06-30'},evaluated_at:'2026-09-12T12:00:00Z',
  source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'case_document',case_id:travelFixtureCase}],
  facts:{needs_transport:known(true),employer_transport:known('none'),free_travel:known('none')},commute_days:{...money('days','20'),representation:'decimal_quantity',quantity_unit:'days'},discounted_daily_fare:money('fare','12.00'),monthly_pass:known('available'),monthly_pass_cost:money('pass','200.00'),recorded:money('recorded','190.00'),
  product_facts:{...travelProductFacts(),employment_relationship:observed('employee'),workplace_sector:observed('private'),personal_discount_profile:observed('standard_adult')},
  applicability:Object.keys(floor?TRAVEL_FLOOR_APPLICABILITY:TRAVEL_APPLICABILITY).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic explicitly scoped method assessment, not a live or human attestation',sources:[decision_id==='travel.general_order_floor'?travelFloorLegalSource('Synthetic §30 interpretation'):travelLegalSource(1,decision_id)],valid_until:null})),remittance_status:'not_assessed'});
}
export function travelFloorReview(travel:TravelEntitlementInput):DocumentReviewInput{return documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:travel.case_id,period:travel.period,
 purchased_scope:{order_id:'synthetic-order',receipt_sha256:'d'.repeat(64),origin:'saved_order',topics:['travel']},documents:[{case_id:travel.case_id,document_id:travelFixtureSource.document_id,version_id:travelFixtureSource.version_id,file_sha256:travelFixtureSource.file_sha256,label:travelFixtureSource.label,reading_sha256:travelFixtureSource.reading_receipt_sha256,page_count:1,kind:'other',period:travel.period,reading_origin:'identified_document_reading'}],
 checks:[],completion_input:{case_id:travel.case_id,period:travel.period,documents:[],needs:[],evidence:[]},answer_history:[],answer_bindings:[],coverage_gaps:[],entitlement_evidence:{schema_version:'entitlement-source-evidence-v1',case_id:travel.case_id,period:travel.period,order_id:'synthetic-order',receipt_sha256:'d'.repeat(64),travel}});}
