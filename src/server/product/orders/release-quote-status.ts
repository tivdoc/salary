import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u),hash=z.string().regex(/^[a-f0-9]{64}$/u);
export const releaseQuoteAvailabilitySchema=z.object({state:z.enum(['ready','needs_information','conditional_result','comparison_needs_review','coverage_unavailable','order_needs_review','quote_expired','below_upgrade_threshold','not_prepared']),
 period:z.object({from:month,to:month}).strict().refine(p=>p.from<=p.to).nullable()}).strict();
export type ReleaseQuoteAvailability=z.infer<typeof releaseQuoteAvailabilitySchema>;
const categories:Readonly<Record<string,ReleaseQuoteAvailability['state']>>={
 pricing_comparison_incomplete:'needs_information',pricing_recorded_comparison_missing:'needs_information',pricing_payment_allocation_missing:'needs_information',pricing_payment_source_incomplete:'needs_information',
 pricing_comparison_conditional:'conditional_result',pricing_comparison_alternatives:'comparison_needs_review',pricing_cross_topic_allocation_unavailable:'comparison_needs_review',pricing_payment_source_overlap:'comparison_needs_review',
 pricing_adapter_unsupported_topics:'coverage_unavailable',pricing_adapter_unsupported_rule_branch:'coverage_unavailable',pricing_adapter_unsupported_payment_expression:'coverage_unavailable',pricing_workday_outside_checked_month:'coverage_unavailable',initial_pricing_requires_exact_single_month:'coverage_unavailable',ORDER_COVERAGE_UNAVAILABLE:'coverage_unavailable',
 verified_initial_credit_unavailable:'order_needs_review',PRICE_QUOTE_CREDIT_UNAVAILABLE:'order_needs_review',PRICE_QUOTE_EXISTING_ORDER_REQUIRES_RECONCILIATION:'order_needs_review',
 PRICE_QUOTE_EXPIRED:'quote_expired',below_threshold:'below_upgrade_threshold',
};
const statusBody=z.object({schema_version:z.literal('release-quote-preparation-v1'),case_id:z.uuid(),identity_id:z.uuid(),initial_order_id:z.uuid(),initial_order_receipt_sha256:hash,
 source_revision:z.number().int().positive(),source_sha256:hash,analysis_run_id:z.string().min(1).max(160),period:z.object({from:month,to:month}).strict().refine(p=>p.from===p.to),
 reason:z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,119}$/u),availability:releaseQuoteAvailabilitySchema,
 quote_id:z.uuid().nullable(),order_id:z.uuid().nullable()}).strict();
export const releaseQuotePreparationStatusSchema=statusBody.extend({sha256:hash}).superRefine((s,ctx)=>{
 const {sha256,...body}=s;
 if(canonicalSha256(body)!==sha256||canonicalSha256(s.period)!==canonicalSha256(s.availability.period)
  ||s.availability.state!==(s.reason==='offer_saved'?'ready':categories[s.reason]??'not_prepared')
  ||(s.reason==='offer_saved'?s.quote_id===null||s.order_id===null:s.quote_id!==null||s.order_id!==null))ctx.addIssue({code:'custom',message:'RELEASE_QUOTE_STATUS_BINDING'});
});
export type ReleaseQuotePreparationStatus=z.infer<typeof releaseQuotePreparationStatusSchema>;
export function createReleaseQuotePreparationStatus(input:Omit<z.infer<typeof statusBody>,'schema_version'|'availability'>):ReleaseQuotePreparationStatus{
 const body=statusBody.parse({...input,schema_version:'release-quote-preparation-v1',availability:{state:input.reason==='offer_saved'?'ready':categories[input.reason]??'not_prepared',period:input.period}});
 return releaseQuotePreparationStatusSchema.parse({...body,sha256:canonicalSha256(body)});
}
