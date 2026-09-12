import type {DocumentReviewOperand,DocumentReviewSource} from '../document-review/calculations.ts';
import {travelEntitlementInputSchema,TRAVEL_APPLICABILITY,travelLegalSource,type TravelEntitlementInput} from './travel/index.ts';
import {MINIMUM_WAGE_APPLICABILITY,type MinimumWageEntitlementInput,type MinimumWageMethod} from './minimum-wage/index.ts';
import {vacationEntitlementInputSchema,VACATION_APPLICABILITY,vacationLegalSource,type VacationEntitlementInput} from './vacation/index.ts';
export function travelFixture(){
const sha='c'.repeat(64),source={document_id:'synthetic-travel-document',version_id:'synthetic.travel.v1',file_sha256:sha,page:1,locator:'Synthetic route and fare table',label:'Synthetic source; no transport provider payment',reading:'ai_document_review' as const,reading_receipt_sha256:sha};
function build():TravelEntitlementInput{
 const known=<T>(value:T)=>({state:'known',value,source,basis:'identified_document_reading'});
 const money=(id:string,printed_value:string):DocumentReviewOperand=>({id,observation_id:'synthetic.'+id,state:'observed',printed_value,representation:'money_ils',quantity_unit:null,precision:'printed_precision',source:{...source,locator:'Synthetic '+id}});
 return travelEntitlementInputSchema.parse({schema_version:'travel-entitlement-input-v1',catalog_id:'il.review.travel.general.2026',catalog_version:'1.0.0',case_id:'synthetic-travel-case',run_id:'synthetic-run',check_prefix:'synthetic.travel',period:{from:'2026-06-01',to:'2026-06-30'},evaluated_at:'2026-09-12T00:00:00Z',source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:sha,page_count:1,kind:'case_document',case_id:'synthetic-travel-case'}],
  facts:{needs_transport:known(true),employer_transport:known('none'),free_travel:known('none')},commute_days:{...money('days','20'),representation:'decimal_quantity',quantity_unit:'days'},discounted_daily_fare:money('fare','12.00'),monthly_pass:known('available'),monthly_pass_cost:money('pass','200.00'),recorded:money('recorded','190.00'),
  applicability:Object.keys(TRAVEL_APPLICABILITY).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Explicit synthetic source-specific interpretation; no human approval',sources:[travelLegalSource(1,decision_id)],valid_until:null})),remittance_status:'not_assessed'});
}
return build();
}
export function minimumFixture(){
const source:DocumentReviewSource={document_id:'synthetic.payslip',version_id:'v1',file_sha256:'a'.repeat(64),page:1,locator:'Synthetic cells',label:'Synthetic payslip',reading:'ai_document_review',reading_receipt_sha256:'b'.repeat(64)};
const fact=<T>(value:T)=>({state:'observed' as const,value,source});
const amount=(id:string,value:string|null):DocumentReviewOperand=>({id,observation_id:'observation.'+id,state:value===null?'missing':'observed',printed_value:value,representation:'money_ils',quantity_unit:null,precision:'source_exact',source});
function build(method:MinimumWageMethod='published_hourly_182'):MinimumWageEntitlementInput{
 const period={from:'2026-06-01',to:'2026-06-30'};
 return {schema_version:'minimum-wage-entitlement-input-v1',catalog_version:'1.0.0',case_id:'synthetic.case',run_id:'synthetic.run',check_id:'minimum.synthetic',period,evaluated_at:'2026-09-12T00:00:00Z',
  source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'case_document',case_id:'synthetic.case'}],
  method:fact(method),population:fact('adult_general'),employment:fact(method==='full_monthly'?'full_monthly_42':'hourly_182'),
  ordinary_hours:{...amount('hours','100'),representation:'decimal_quantity',quantity_unit:'hours'},ordinary_hours_period:fact(period),monthly_coverage:fact('full_month_full_time'),eligible_pay_inventory:fact('complete'),
  components:[{id:'base',amount:amount('base','3300'),period:fact(period),classification:fact('base_salary')}],
  applicability:Object.entries(MINIMUM_WAGE_APPLICABILITY).map(([decision_id,explanation])=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic assessment only. '+explanation,sources:[source],valid_until:null}))};
}
return build();
}
export function vacationFixture(){
const source={document_id:'synthetic-document',version_id:'synthetic-version',file_sha256:'a'.repeat(64),page:1,locator:'Synthetic annual register; no actual customer',label:'Synthetic source',reading:'identified_document_reading' as const,reading_receipt_sha256:'b'.repeat(64)};
const known=<T>(value:T)=>({state:'known' as const,value,source,basis:'identified_document_reading' as const});
const number=(value:string,unit:'count'|'days'|'calendar_days'|null):DocumentReviewOperand=>({id:'synthetic.value',observation_id:`synthetic.${unit??'money'}`,state:'observed',printed_value:value,representation:unit===null?'money_ils':'integer',quantity_unit:unit,precision:'source_exact',source});
function build():VacationEntitlementInput{return vacationEntitlementInputSchema.parse({schema_version:'vacation-entitlement-input-v1',catalog_id:'il.review.vacation.general.2026',catalog_version:'1.0.0',
 case_id:'synthetic-case',run_id:'synthetic-run',check_prefix:'synthetic.vacation',period:{from:'2026-06-01',to:'2026-06-30'},calendar_year:2026,evaluated_at:'2026-09-12T08:00:00Z',
 source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'case_document',case_id:'synthetic-case'}],
 facts:{aged_21_or_more:known(true),under_60:known(true)},seniority_year:number('1','count'),
 annual_basis:{employment_start:known('2026-01-01'),employment_end:known('2026-06-30'),complete_year_evidence:known(true),covered_through:known('2026-06-30'),actual_workdays:number('100','days')},
 leave_pay:null,applicability:Object.keys(VACATION_APPLICABILITY).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic source-scoped AI assessment; not human attestation',sources:[vacationLegalSource('law',1,decision_id)],valid_until:null})),remittance_status:'missing'});}
return build();
}
