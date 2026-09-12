import {z} from 'zod';
import {canonicalSha256} from '../rule-runtime/canonical.ts';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict().refine(p=>p.from<=p.to,'ENTITLEMENT_PERIOD');
export const ENTITLEMENT_REVIEW_POLICY='source-bound-entitlement-review-v1' as const;
export const entitlementReviewTopicSchema=z.enum(['working_time','rest_day','pension']);

/** A source packet, not an executable rule or an authorization. Branch-specific
 * parsers validate the two payloads before selection; the saved source journal
 * independently pins the case, purchase, documents and immutable packet hash. */
export const entitlementEvidenceSchema=z.object({
 schema_version:z.literal('entitlement-source-evidence-v1'),case_id:z.string().min(1),
 order_id:z.string().min(1),receipt_sha256:hash,period,
 working_time:z.unknown().optional(),pension:z.unknown().optional(),
}).strict();
export type EntitlementEvidence=z.infer<typeof entitlementEvidenceSchema>;

export const entitlementSelectionSchema=z.object({
 topic:entitlementReviewTopicSchema,catalog_id:z.string().min(1),catalog_version:z.string().min(1),
 evidence_sha256:hash,source_policy_sha256:hash,
 status:z.enum(['selected_for_review','missing_facts','unsupported_period','unsupported_applicability']),
 rule_pins:z.array(z.object({rule_id:z.string().min(1),version:z.string().min(1),sha256:hash}).strict()).max(128),
 generated_check_ids:z.array(z.string().min(1)).max(128),generated_gap_ids:z.array(z.string().min(1)).max(128),
 publication_authority:z.literal(false),authority_status:z.literal('candidate_review_not_financial_authority'),
}).strict();
export const entitlementCompositionSchema=z.object({
 policy_version:z.literal(ENTITLEMENT_REVIEW_POLICY),source_evidence_sha256:hash,evidence:entitlementEvidenceSchema,
 selections:z.array(entitlementSelectionSchema).max(3),
 generated_fact_keys:z.array(z.string().min(1)).max(128),
 composition_sha256:hash,
}).strict().superRefine((value,ctx)=>{
 const {composition_sha256,...body}=value;
 if(canonicalSha256(body)!==composition_sha256)ctx.addIssue({code:'custom',message:'ENTITLEMENT_COMPOSITION_HASH'});
 if(new Set(value.selections.map(s=>s.topic)).size!==value.selections.length)ctx.addIssue({code:'custom',message:'ENTITLEMENT_DUPLICATE_TOPIC'});
});
export type EntitlementComposition=z.infer<typeof entitlementCompositionSchema>;
