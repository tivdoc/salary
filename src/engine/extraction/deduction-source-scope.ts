import {z} from 'zod';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {RawCandidateField} from './contracts.ts';
import type {NormalizedPayslipExtraction} from './payslip.ts';

export const DEDUCTION_SOURCE_SCOPE_POLICY='payslip-retained-deduction-scope-v1' as const;
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const excludedCandidateSchema=z.object({candidate_id:z.uuid(),candidate_sha256:sha,page:z.number().int().min(1),
 classification:z.literal('mandatory_deduction_subtotal')}).strict();
const scopeShape={policy_version:z.literal(DEDUCTION_SOURCE_SCOPE_POLICY),original_extraction_sha256:sha,effective_extraction_sha256:sha,
 excluded_candidates:z.array(excludedCandidateSchema).min(1).max(300)};
export const deductionScopeDerivationSchema=z.object({schema_version:z.literal('payslip-source-semantic-derivation-v1'),...scopeShape,
 case_id:z.string().min(1),document_id:z.uuid(),version_id:z.uuid(),source_sha256:sha,reading_sha256:sha,checkpoint_result_sha256:sha,
 provider_calls:z.literal(0)}).strict().superRefine((value,ctx)=>{
 if(value.document_id!==value.version_id||new Set(value.excluded_candidates.map(c=>c.candidate_id)).size!==value.excluded_candidates.length
  ||value.original_extraction_sha256===value.effective_extraction_sha256)ctx.addIssue({code:'custom',message:'DEDUCTION_SCOPE_DERIVATION_INVALID'});
});
export type DeductionScopeDerivation=z.infer<typeof deductionScopeDerivationSchema>;

/** A bounded printed heading and its exact raw value establish scope. Neither
 * confirming/correcting a number nor an arithmetic fit changes that heading. */
export function isExplicitMandatorySubtotalCandidate(candidate:Pick<RawCandidateField,'field'|'raw_value'|'source'>):boolean {
 if(candidate.field!=='total_deductions')return false;
 const fragment=candidate.source.text_fragment,suffix=`: ${candidate.raw_value}`;
 if(!fragment?.endsWith(suffix))return false;
 const label=fragment.slice(0,-suffix.length).normalize('NFKC').replace(/["'״׳.]/gu,'').replace(/\s+/gu,' ').trim().toLowerCase();
 return /^(?:(?:סהכ )?ניכויי חובה(?:\s*[-־–]\s*מסים)?|mandatory deductions)$/u.test(label);
}

/** Only an effective view. The supplied machine observation is never edited
 * or reserialized into the saved provider checkpoint. */
export function deriveDeductionScope(original:NormalizedPayslipExtraction){
 if(original.customer_readings!==undefined||original.customer_row_readings!==undefined||original.customer_scope_readings!==undefined
  ||original.customer_source_transcriptions!==undefined||original.customer_source_structures!==undefined||original.source_reading_context!==undefined)
  throw Error('DEDUCTION_SCOPE_MACHINE_REQUIRED');
 const excluded=original.fields.filter(isExplicitMandatorySubtotalCandidate);
 if(!excluded.length)return {extraction:original,derivation:null};
 if(new Set(original.fields.map(c=>c.candidate_id)).size!==original.fields.length
  ||excluded.some(c=>c.source.document_id!==original.document_id||c.source.page<1||c.source.page>original.quality_metrics.page_count))
  throw Error('DEDUCTION_SCOPE_SOURCE_BINDING');
 const ids=new Set(excluded.map(c=>c.candidate_id)),extraction={...original,fields:original.fields.filter(c=>!ids.has(c.candidate_id))};
 return {extraction,derivation:{policy_version:DEDUCTION_SOURCE_SCOPE_POLICY,original_extraction_sha256:canonicalSha256(original),
  effective_extraction_sha256:canonicalSha256(extraction),excluded_candidates:excluded.map(c=>({candidate_id:c.candidate_id,
   candidate_sha256:canonicalSha256(c),page:c.source.page,classification:'mandatory_deduction_subtotal' as const}))}};
}

type DerivationInput=Readonly<{document:Readonly<{case_id:string;document_id:string;content_sha256:string}>;reading_sha256:string;
 checkpoint_result_sha256:string;checkpoint_result:unknown;original:NormalizedPayslipExtraction}>;
/** Called only after ordinary saved-source admission. Rebuild the semantic
 * receipt against the independently loaded immutable result, not a claimed
 * effective hash or a previously saved derivation supplied by a caller. */
export function createDeductionScopeDerivation(input:DerivationInput):DeductionScopeDerivation|null {
 const result=z.object({final_extraction:z.unknown()}).passthrough().parse(input.checkpoint_result);
 if(input.original.document_id!==input.document.document_id||canonicalSha256(result.final_extraction)!==canonicalSha256(input.original)
  ||canonicalSha256(input.checkpoint_result)!==input.checkpoint_result_sha256)throw Error('DEDUCTION_SCOPE_CHECKPOINT_BINDING');
 const {derivation}=deriveDeductionScope(input.original);if(!derivation)return null;
 return deductionScopeDerivationSchema.parse({schema_version:'payslip-source-semantic-derivation-v1',...derivation,
  case_id:input.document.case_id,document_id:input.document.document_id,version_id:input.document.document_id,
  source_sha256:input.document.content_sha256,reading_sha256:input.reading_sha256,checkpoint_result_sha256:input.checkpoint_result_sha256,provider_calls:0});
}
export function assertDeductionScopeDerivation(receipt:unknown,input:DerivationInput):DeductionScopeDerivation {
 const parsed=deductionScopeDerivationSchema.parse(receipt),expected=createDeductionScopeDerivation(input);
 if(!expected||canonicalSha256(parsed)!==canonicalSha256(expected))throw Error('DEDUCTION_SCOPE_DERIVATION_BINDING');
 return parsed;
}
