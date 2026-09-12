import {entitlementDeclarationsSchema} from '../entitlement-review/declarations.ts';
import {savedNonPayslipEvidenceSchema} from '../extraction/document-evidence/snapshot.ts';
import {z} from 'zod';
import type {generateReviewCompletions} from './completions.ts';
import type {calculateDocumentReview} from './calculations.ts';
import {reviewCompletionSchema,reviewCompletionAnswerReceiptSchema,reviewSourcePinSchema} from './completions.ts';
import {documentReviewCalculationInputSchema} from './calculations.ts';
import {normalizedCandidateFieldSchema,type NormalizedPayslipExtraction} from '../extraction/payslip.ts';
import {customerSourceTranscriptionSchema} from '../extraction/customer-reading.ts';
import {entitlementEvidenceSchema,entitlementCompositionSchema} from '../entitlement-review/contracts.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';

export const DOCUMENT_REVIEW_POLICY='document-review-product-v1' as const;
export const DOCUMENT_REVIEW_COVERAGE_POLICY='document-review-coverage-v1' as const;
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const reviewTopicSchema=z.enum(['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave','rest_day','bonuses','contract']);
export const PAYSLIP_ROW_REVIEW_TOPICS:Readonly<Partial<Record<NormalizedPayslipExtraction['additional_components'][number]['semantic_kind'],z.infer<typeof reviewTopicSchema>>>>={
 base_salary:'minimum_wage',hourly_base:'minimum_wage',overtime_125:'working_time',overtime_150:'working_time',travel:'travel',convalescence:'convalescence',bonus:'bonuses'};
const reviewPeriodSchema=z.object({from:z.iso.date(),to:z.iso.date()}).strict().refine(p=>p.from<=p.to,'REVIEW_PERIOD');
export const reviewPurchasePeriodEvidenceSchema=z.object({schema_version:z.literal('document-review-purchase-period-v1'),
 receipt_sha256:sha,state:z.enum(['missing','recorded']),periods:z.array(reviewPeriodSchema).max(120),
}).strict().refine(p=>p.state==='missing'?p.periods.length===0:p.periods.length>0,'REVIEW_PURCHASE_PERIOD_STATE');
export const reviewPeriodProjectionSchema=z.object({schema_version:z.literal('document-review-period-projection-v2'),
 source_input_sha256:sha,source_period:reviewPeriodSchema,selected_period:reviewPeriodSchema,
 excluded_checks:z.array(z.object({check_id:z.string().min(1),topic:reviewTopicSchema,period:reviewPeriodSchema,
  calculation_sha256:sha,reason:z.enum(['outside_month','cross_month'])}).strict()).max(400),
 proration_performed:z.literal(false),projection_sha256:sha,
}).strict();
export const reviewSourceObservationInventorySchema=z.object({schema_version:z.literal('payslip-unresolved-fields-v1'),
 document_id:z.string().min(1),version_id:z.string().min(1),source_sha256:sha,reading_sha256:sha,
 checkpoint_result_sha256:sha,original_pass_sha256:sha,
 outside_purchased_topics:z.array(reviewTopicSchema).max(10).optional(),
 machine_extraction_sha256:sha.optional(),unit_readings:z.array(customerSourceTranscriptionSchema).max(48).optional(),
 observations:z.array(normalizedCandidateFieldSchema).min(1).max(48),
}).strict().refine(i=>i.observations.every(o=>(o.field==='vacation_balance'||o.field==='sick_balance')&&o.normalized_value===null),'REVIEW_UNRESOLVED_BALANCE_ONLY');
export const reviewDocumentSchema=z.object({
 case_id:z.string().min(1),document_id:z.string().min(1),version_id:z.string().min(1),file_sha256:sha,
 page_count:z.number().int().positive().nullable(),kind:z.enum(['payslip','attendance','contract','transfer','other']),
 label:z.string().min(1).max(200),period:z.object({from:z.iso.date(),to:z.iso.date()}).nullable(),
 accepted_reading_sha256:z.array(sha).min(1).max(32).optional(),
 reading_origin:z.enum(['provider_extraction','ai_document_review','identified_document_reading','source_inventory']),reading_sha256:sha,
}).strict();
export const reviewPrintedInventorySchema=z.object({schema_version:z.literal('printed-earnings-inventory-v1'),
 document_id:z.string().min(1),version_id:z.string().min(1),reading_sha256:sha,
 populated_component_ids:z.array(z.string().min(1)).min(1).max(48),
 unresolved_blank_component_ids:z.array(z.string().min(1)).max(48),
 excluded_deduction_component_ids:z.array(z.string().min(1)).max(48),
 inventory_complete:z.boolean(),disjoint_components:z.boolean(),
 payable_completeness_assessed:z.literal(false),
}).strict();
export const reviewCheckSchema=z.object({
 check_id:z.string().min(1).max(160),topic:reviewTopicSchema,title:z.string().min(1).max(200),
 explanation:z.string().max(1500),calculation:z.unknown(),printed_inventory:reviewPrintedInventorySchema.optional(),
}).strict();
export const documentReviewInputSchema=z.object({
 schema_version:z.literal(DOCUMENT_REVIEW_POLICY),case_id:z.string().min(1),
 period:z.object({from:z.iso.date(),to:z.iso.date()}).strict(),
 purchased_scope:z.object({order_id:z.string().min(1),receipt_sha256:sha,topics:z.array(reviewTopicSchema).min(1),
  origin:z.enum(['saved_order','legacy_paid_receipt']),purchase_period_evidence:reviewPurchasePeriodEvidenceSchema.optional()}).strict(),
 coverage_policy:z.literal(DOCUMENT_REVIEW_COVERAGE_POLICY).optional(),
 entitlement_evidence:entitlementEvidenceSchema.optional(),
 entitlement_declarations:entitlementDeclarationsSchema.optional(),
 non_payslip_evidence:z.array(savedNonPayslipEvidenceSchema).max(32).optional(),
 entitlement_composition:entitlementCompositionSchema.optional(),
 period_projection:reviewPeriodProjectionSchema.optional(),
 source_observation_inventory:z.array(reviewSourceObservationInventorySchema).max(64).optional(),
 coverage_gaps:z.array(z.object({check_id:z.string().min(1),topic:reviewTopicSchema,kind:z.enum(['missing_source','missing_fact','missing_rule','missing_applicability','ownership']),detail:z.string().min(1),next_step:z.string().min(1),source_pins:z.array(reviewSourcePinSchema).min(1).max(32).optional()}).strict()).max(100).default([]),
 documents:z.array(reviewDocumentSchema).min(1).max(64),checks:z.array(reviewCheckSchema).max(400),
 // The planner validates its own source-bound contract; it is included in the
 // immutable input hash rather than read from a mutable questionnaire later.
 completion_input:z.unknown(),
 answer_bindings:z.array(z.object({fact_key:z.string().min(1),check_id:z.string().min(1),operand_id:z.string().min(1)}).strict()).max(400).default([]),
 answer_history:z.array(z.object({request:reviewCompletionSchema,receipt:reviewCompletionAnswerReceiptSchema,
  original_checks:z.array(documentReviewCalculationInputSchema).max(100)}).strict()).max(100).default([]),
}).strict().superRefine((input,ctx)=>{
 for(const e of input.non_payslip_evidence??[])if(e.document.case_id!==input.case_id||!input.documents.some(d=>d.document_id===e.document.document_id&&d.version_id===e.document.document_id&&d.file_sha256===e.document.content_sha256))ctx.addIssue({code:'custom',message:'NON_PAYSLIP_REVIEW_BINDING'});
 if(input.entitlement_declarations&&(input.entitlement_declarations.facts.some(f=>f.case_id!==input.case_id)||canonicalSha256(input.entitlement_declarations.period)!==canonicalSha256(input.period)))ctx.addIssue({code:'custom',message:'ENTITLEMENT_DECLARATION_SCOPE'});
 if(input.entitlement_evidence&&(input.entitlement_evidence.case_id!==input.case_id
  ||input.entitlement_evidence.order_id!==input.purchased_scope.order_id
  ||input.entitlement_evidence.receipt_sha256!==input.purchased_scope.receipt_sha256
  ||canonicalSha256(input.entitlement_evidence.period)!==canonicalSha256(input.period)))
  ctx.addIssue({code:'custom',path:['entitlement_evidence'],message:'ENTITLEMENT_SOURCE_SCOPE'});
 if(input.entitlement_composition&&(!input.entitlement_evidence
  ||input.entitlement_composition.source_evidence_sha256!==canonicalSha256(input.entitlement_evidence)
  ||input.entitlement_composition.selections.some(s=>!input.purchased_scope.topics.includes(s.topic))))
  ctx.addIssue({code:'custom',path:['entitlement_composition'],message:'ENTITLEMENT_SELECTION_SCOPE'});
 if(input.purchased_scope.purchase_period_evidence?.receipt_sha256!==undefined
  &&input.purchased_scope.purchase_period_evidence.receipt_sha256!==input.purchased_scope.receipt_sha256)
  ctx.addIssue({code:'custom',path:['purchased_scope','purchase_period_evidence'],message:'REVIEW_PURCHASE_PERIOD_RECEIPT'});
 if(input.period_projection&&!input.coverage_policy)
  ctx.addIssue({code:'custom',path:['period_projection'],message:'REVIEW_PROJECTION_POLICY_REQUIRED'});
 for(const [index,inventory] of (input.source_observation_inventory??[]).entries()){
  const document=input.documents.find(d=>d.document_id===inventory.document_id&&d.version_id===inventory.version_id);
  if(inventory.outside_purchased_topics?.some(t=>input.purchased_scope.topics.includes(t)||!['vacation','sick_leave'].includes(t)))ctx.addIssue({code:'custom',path:['source_observation_inventory',index],message:'REVIEW_SOURCE_INVENTORY_SCOPE'});
  if(!input.coverage_policy||!document||document.file_sha256!==inventory.source_sha256||document.reading_sha256!==inventory.reading_sha256
   ||new Set(inventory.observations.map(o=>o.candidate_id)).size!==inventory.observations.length
   ||inventory.observations.some(o=>o.source.document_id!==document.document_id||o.source.page>(document.page_count??0)))
   ctx.addIssue({code:'custom',path:['source_observation_inventory',index],message:'REVIEW_SOURCE_INVENTORY_BINDING'});
 }
 for(const [index,gap] of input.coverage_gaps.entries())for(const pin of gap.source_pins??[]){
  if(pin.case_id!==input.case_id||!input.documents.some(d=>d.case_id===pin.case_id&&d.version_id===pin.version_id
   &&d.file_sha256===pin.source_sha256&&(d.document_id===pin.document_id||d.document_id===pin.version_id)))
   ctx.addIssue({code:'custom',path:['coverage_gaps',index,'source_pins'],message:'REVIEW_GAP_SOURCE_MISMATCH'});
 }
});
export type DocumentReviewInput=z.infer<typeof documentReviewInputSchema>;
export type ReviewDocument=z.infer<typeof reviewDocumentSchema>;
export type DocumentReviewCoverageInventory=Readonly<{
 schema_version:typeof DOCUMENT_REVIEW_COVERAGE_POLICY;review_period:DocumentReviewInput['period'];
 purchased_topics:DocumentReviewInput['purchased_scope']['topics'];
 purchase_period_evidence:z.infer<typeof reviewPurchasePeriodEvidenceSchema>|{state:'not_provided';periods:[]};
 source_periods:readonly {document_id:string;version_id:string;kind:ReviewDocument['kind'];period:ReviewDocument['period']}[];
 period_projection?:z.infer<typeof reviewPeriodProjectionSchema>;
 unresolved_source_observations:readonly {document_id:string;version_id:string;field:'vacation_balance'|'sick_balance';candidate_id:string;raw_value:string;unit:null;page:number}[];
 source_balance_observations:readonly {document_id:string;version_id:string;field:'vacation_balance'|'sick_balance';candidate_id:string;raw_value:string;unit:'days'|'hours'|null;page:number;reading_status:'unit_unresolved'|'identified_unit_reading';amount_verified:false;scope_status?:'outside_purchased_scope'}[];
 topics:readonly {topic:z.infer<typeof reviewTopicSchema>;calculated_check_ids:string[];blocked_check_ids:string[];
  excluded_check_ids:string[];gap_ids:string[];coverage:'partial'|'not_evaluated'}[];
 legal_coverage_complete:false;
}>;
export type DocumentReviewCheckResult=Readonly<{
 check_id:string;topic:z.infer<typeof reviewTopicSchema>;title:string;explanation:string;
 dependency_sha256:string;calculation:ReturnType<typeof calculateDocumentReview>;
 printed_inventory?:z.infer<typeof reviewPrintedInventorySchema>;
}>;
export type DocumentReviewResult=Readonly<{
 input:DocumentReviewInput;schema_version:typeof DOCUMENT_REVIEW_POLICY;case_id:string;analysis_run_id:string;input_sha256:string;
 period:DocumentReviewInput['period'];purchased_scope:DocumentReviewInput['purchased_scope'];documents:readonly ReviewDocument[];
 coverage_gaps:DocumentReviewInput['coverage_gaps'];checks:readonly DocumentReviewCheckResult[];completions:ReturnType<typeof generateReviewCompletions>;
 coverage_inventory?:DocumentReviewCoverageInventory;
 legal_debt_total:null;actual_transfer_proven:false;publication_authority:false;result_sha256:string;
}>;
