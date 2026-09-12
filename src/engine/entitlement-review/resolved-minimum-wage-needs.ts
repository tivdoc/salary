import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewOperand} from '../document-review/calculations.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import type {ReviewCompletionNeed} from '../document-review/completions.ts';
import {minimumWageEntitlementInputSchema} from './minimum-wage/contracts.ts';
import {resolveMinimumWageEntitlement} from './minimum-wage/resolve.ts';

/** Only call after source/answer/derived-fact replay. This identifies three
 * generated source needs; it does not approve a reading or legal decision. */
export function resolvedMinimumWageSourceNeeds(input:DocumentReviewInput,effective:unknown,checks:DocumentReviewInput['checks']):ReviewCompletionNeed[]{
 if(input.entitlement_evidence?.resolved_need_policy!=='minimum-wage-resolved-needs-v1'||!input.purchased_scope.topics.includes('minimum_wage'))return [];
 const parsed=minimumWageEntitlementInputSchema.safeParse(effective);if(!parsed.success)return [];
 const e=parsed.data;if(e.case_id!==input.case_id||canonicalSha256(e.period)!==canonicalSha256(input.period))return [];
 const resolved=resolveMinimumWageEntitlement(e),check=checks.find(c=>c.check_id===e.check_id&&c.topic==='minimum_wage');
 if(!check||!resolved.checks.some(c=>c.check_id===check.check_id))return [];
 const calculation=documentReviewCalculationInputSchema.parse(check.calculation);
 if(calculation.case_id!==input.case_id||canonicalSha256(calculation.period)!==canonicalSha256(input.period))return [];
 const pins=input.documents.filter(d=>e.source_manifest.some(m=>m.kind==='case_document'&&m.case_id===input.case_id&&m.document_id===d.document_id&&m.version_id===d.version_id&&m.file_sha256===d.file_sha256))
  .map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256}));
 if(!pins.length)return [];
 const selected=e.components.filter(c=>['base_salary','cost_of_living','fixed_work_supplement'].includes(c.classification.value??''));
 const operandBody=(o:DocumentReviewOperand)=>({observation_id:o.observation_id,state:o.state,printed_value:o.printed_value,representation:o.representation,quantity_unit:o.quantity_unit,source:o.source});
 if(!selected.length||selected.some(c=>c.amount.state!=='observed'||!['identified_document_reading','provider_extraction','ai_document_review'].includes(c.amount.source.reading)
  ||!pins.some(p=>p.document_id===c.amount.source.document_id&&p.version_id===c.amount.source.version_id&&p.source_sha256===c.amount.source.file_sha256)
  ||!calculation.operands.some(o=>canonicalSha256(operandBody(o))===canonicalSha256(operandBody(c.amount)))))return [];
 // Recreate the original catalog's missing-state descriptors, rather than
 // identify a request by its visible wording or duplicate the Hebrew text.
 const missingSource=structuredClone(e);
 missingSource.eligible_pay_inventory={state:'unknown',value:'unknown',source:e.eligible_pay_inventory.source};
 for(const c of missingSource.components)if(selected.some(s=>s.id===c.id))c.amount={...c.amount,state:'unknown'};
 return resolveMinimumWageEntitlement(missingSource).missing.filter(m=>m.input_path==='eligible_pay_inventory'||m.input_path==='components'
  ||selected.some(c=>m.input_path===`components.${e.components.indexOf(c)}.amount`&&m.fact_key===`mw.amount.${c.id}`)).map(m=>({
   fact_key:`entitlement.minimum_wage.${canonicalSha256({period:input.period,pins,path:m.input_path,key:m.fact_key}).slice(0,28)}`,
   kind:'factual',reason:m.state==='missing'?'missing':'unknown',question:m.question,answer_kind:'text',required_evidence_kind:'observed_reading',source_pins:pins,dependent_check_ids:[e.check_id],general_question:false,
  }));
}

export function matchesResolvedMinimumWageNeed(need:Pick<ReviewCompletionNeed,'fact_key'|'kind'|'question'|'answer_kind'|'required_evidence_kind'|'source_pins'>,resolved:ReviewCompletionNeed):boolean{
 return need.fact_key===resolved.fact_key&&need.kind===resolved.kind&&need.question===resolved.question&&need.answer_kind===resolved.answer_kind
  &&need.required_evidence_kind===resolved.required_evidence_kind&&canonicalSha256(need.source_pins)===canonicalSha256(resolved.source_pins);
}
