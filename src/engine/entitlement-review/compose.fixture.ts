import {documentReviewInputSchema} from '../document-review/contracts.ts';
import {PENSION_APPLICABILITY,pensionEntitlementInputSchema,pensionLegalSource} from './pension/index.ts';
export const caseId='11111111-1111-4111-8111-111111111111';
export const actor={case_id:caseId,identity_id:'22222222-2222-4222-8222-222222222222'};
export function fixture(){
 const sha='a'.repeat(64),period={from:'2026-06-01',to:'2026-06-30'},source={document_id:'synthetic.entitlement.doc',version_id:'synthetic.entitlement.v1',file_sha256:sha,page:1,locator:'synthetic pension wage and factual record',label:'synthetic fixture',reading:'ai_document_review' as const,reading_receipt_sha256:sha};
 const known=<T>(value:T)=>({state:'known',value,source,basis:'ai_source_assessment'});
 const pension=pensionEntitlementInputSchema.parse({schema_version:'pension-entitlement-input-v1',catalog_id:'il.review.pension.general.2026',catalog_version:'1.0.0',case_id:caseId,run_id:'source.facts',check_prefix:'entitlement.pension',period,evaluated_at:'2026-09-12T00:00:00Z',
  source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:sha,page_count:1,kind:'case_document',case_id:caseId}],
  facts:{employment_start:known('2025-01-01'),employment_end:known('ongoing'),prior_coverage_at_start:known(false),continuous_employment:known(true),aged_21_or_more:known(true),under_60:known(true)},
  pensionable_wage:{id:'insured.wage',observation_id:'synthetic.wage',state:'observed',printed_value:'5000.00',representation:'money_ils',quantity_unit:null,precision:'printed_precision',source},eligible_interval_wage:null,
  applicability:Object.keys(PENSION_APPLICABILITY).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Isolated synthetic source assessment; no human signature or REAL activation',sources:[pensionLegalSource('order2011',4,decision_id)],valid_until:null})),recorded:[],remittance_status:'missing'});
 const input=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period,
  purchased_scope:{order_id:'synthetic.order',receipt_sha256:'f'.repeat(64),topics:['minimum_wage','working_time','rest_day','pension','travel','convalescence','vacation','bonuses','contract'],origin:'legacy_paid_receipt'},
  documents:[{case_id:caseId,document_id:source.document_id,version_id:source.version_id,file_sha256:sha,page_count:1,kind:'payslip',label:'Synthetic payslip, not a customer',period,reading_origin:'ai_document_review',reading_sha256:sha}],checks:[],coverage_gaps:[],
  completion_input:{case_id:caseId,period,documents:[{pin:{case_id:caseId,document_id:source.document_id,version_id:source.version_id,source_sha256:sha},kind:'payslip',period,review:'complete'}],needs:[],evidence:[]},
  entitlement_evidence:{schema_version:'entitlement-source-evidence-v1',case_id:caseId,order_id:'synthetic.order',receipt_sha256:'f'.repeat(64),period,pension}});
 return {input,pension};
}
