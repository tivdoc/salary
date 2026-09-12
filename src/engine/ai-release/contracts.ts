import {z} from 'zod';
import {canonicalSha256} from '../rule-runtime/canonical.ts';

export const AI_RELEASE_POLICY_VERSION='tivdoc-ai-release-policy-v1' as const;
export const AI_RELEASE_TOPICS=['working_time','rest_day','pension','travel','convalescence','vacation','minimum_wage','bonuses','contract'] as const;
const hash=z.string().regex(/^[a-f0-9]{64}$/u),id=z.string().min(1).max(200);
const time=z.iso.datetime({offset:true});
const namespace=z.enum(['real','isolated_test']);
const environment=z.enum(['development','preview','production','test']);
const uniqueStrings=z.array(id).max(256).refine(v=>new Set(v).size===v.length,'AI_RELEASE_DUPLICATE_ID');
const hashes=z.array(hash).max(256).refine(v=>new Set(v).size===v.length,'AI_RELEASE_DUPLICATE_HASH');
export const aiReleasePeriodSchema=z.object({from:z.iso.date(),to:z.iso.date()}).strict().refine(v=>v.from<=v.to,'AI_RELEASE_PERIOD');
const validity={issued_at:time,expires_at:time};
function checkHash(value:{sha256:string},ctx:z.RefinementCtx){
 const {sha256,...body}=value;
 if(canonicalSha256(body)!==sha256)ctx.addIssue({code:'custom',message:'AI_RELEASE_CONTENT_HASH'});
}
export const aiReleaseSourcePinSchema=z.object({case_id:id,document_id:id,version_id:id,source_sha256:hash}).strict();
export const aiReleaseScopeSchema=z.object({case_id:id,order_id:id,order_origin:z.enum(['saved_order','legacy_paid_receipt']),
 order_receipt_sha256:hash,input_revision:z.number().int().positive(),input_sha256:hash,period:aiReleasePeriodSchema,
 facts_sha256:hash,population:id,authority_dependency_sha256:hash,
}).strict();

const origins=z.enum(['identified_document_reading','accepted_provider_reading','customer_declaration','derived']);
export const aiReleaseGeneratorSchema=z.object({id,version:id,code_sha256:hash}).strict();
const exactRule={rule_sha256:hash,parameter_set_sha256:hash};
const generatedRule={generator:aiReleaseGeneratorSchema};
const branchPolicyBody=z.object({branch_id:id,topic:z.enum(AI_RELEASE_TOPICS),period:aiReleasePeriodSchema,
 populations:uniqueStrings.refine(v=>v.length>0),
 source_receipt_sha256s:hashes.refine(v=>v.length>0),interpretation_receipt_sha256:hash,
 test_receipt_sha256s:hashes.refine(v=>v.length>0),required_test_categories:uniqueStrings.refine(v=>v.length>0),
 required_fact_keys:uniqueStrings,document_reading_fact_keys:uniqueStrings,required_decision_ids:uniqueStrings,
}).strict();
export const aiReleaseBranchPolicySchema=z.union([branchPolicyBody.extend(exactRule),branchPolicyBody.extend(generatedRule)]).superRefine((v,ctx)=>{
 if(v.document_reading_fact_keys.some(k=>!v.required_fact_keys.includes(k)))ctx.addIssue({code:'custom',message:'AI_RELEASE_READING_REQUIREMENT_SCOPE'});
});

/** Immutable product decision. Source/interpretation/test digests are an
 * allowlist, not flags supplied by an assessment author. Historical human
 * policies and their signatures are deliberately outside this schema. */
export const aiReleasePolicySchema=z.object({schema_version:z.literal(AI_RELEASE_POLICY_VERSION),policy_id:id,version:id,
 namespace,allowed_environments:z.array(environment).min(1).max(4).refine(v=>new Set(v).size===v.length),
 product_decision_sha256:hash,review_method_version:id,minimum_review_confidence:z.number().min(0).max(1),
 accepted_provider_reading_policy_sha256s:hashes.optional(),
 claim_kind:z.literal('qualified_ai_report'),human_attestation:z.null(),...validity,
 branches:z.array(aiReleaseBranchPolicySchema).min(1).max(128),sha256:hash,
}).strict().superRefine(checkHash).superRefine((v,ctx)=>{
 if(new Set(v.branches.map(b=>b.branch_id)).size!==v.branches.length)ctx.addIssue({code:'custom',message:'AI_RELEASE_DUPLICATE_BRANCH'});
 if(v.branches.some(b=>b.period.from<'2026-05-01'||b.period.to>'2026-07-31'))ctx.addIssue({code:'custom',message:'AI_RELEASE_FROZEN_PERIOD'});
});
export const aiReleaseReviewerSchema=z.object({actor_kind:z.literal('ai_reviewer'),actor_id:id,actor_version:id,
 model_reference:id,review_method_version:id,...validity}).strict();
export const aiReleaseRegistrySchema=z.object({schema_version:z.literal('tivdoc-ai-release-registry-v1'),registry_id:id,
 revision:z.number().int().positive(),namespace,policy_sha256:hash,...validity,
 reviewers:z.array(aiReleaseReviewerSchema).min(1).max(32),
 revocations:z.array(z.object({target_sha256:hash,effective_at:time,reason_code:id}).strict()).max(1024),
 sha256:hash,
}).strict().superRefine(checkHash).superRefine((v,ctx)=>{
 if(new Set(v.reviewers.map(r=>`${r.actor_id}:${r.actor_version}`)).size!==v.reviewers.length)ctx.addIssue({code:'custom',message:'AI_RELEASE_DUPLICATE_REVIEWER'});
});

const review={reviewer_id:id,reviewer_version:id,review_method_version:id,confidence:z.number().min(0).max(1),
 confidence_explanation:z.string().min(1).max(1500),...validity};
export const aiReleaseSourceReceiptSchema=z.object({schema_version:z.literal('tivdoc-ai-source-review-v1'),receipt_id:id,
 source_version_id:id,artifact_sha256:hash,transcription_sha256:hash,
 acquisition:z.enum(['official_acquisition','primary_copy','synthetic_fixture']),source_url:z.url(),
 locators:z.array(z.object({page:z.number().int().positive(),provision:id,excerpt_sha256:hash}).strict()).min(1).max(128),
 verification_evidence_sha256:hash,amendment_inventory_sha256:hash,authority_analysis_sha256:hash,
 valid_period:z.object({from:z.iso.date(),to:z.iso.date().nullable()}).strict().refine(v=>v.to===null||v.from<=v.to),
 available_from:time,populations:uniqueStrings.refine(v=>v.length>0),topics:z.array(z.enum(AI_RELEASE_TOPICS)).min(1).max(9),
 status:z.enum(['accepted','missing','unknown','conflict']),...review,sha256:hash,
}).strict().superRefine(checkHash);

const interpretationReceiptBody=z.object({schema_version:z.literal('tivdoc-ai-interpretation-review-v1'),
 receipt_id:id,branch_id:id,source_receipt_sha256s:hashes.refine(v=>v.length>0),
 period:aiReleasePeriodSchema,populations:uniqueStrings.refine(v=>v.length>0),
 method_sha256:hash,reasoning:z.string().min(1).max(5000),limitations:z.array(z.string().min(1).max(1000)).max(32),
 human_by_law:z.object({state:z.enum(['required','not_required_for_supported_branch','unresolved']),
  basis_sha256:hash,source_receipt_sha256s:hashes.refine(v=>v.length>0),explanation:z.string().min(1).max(2000)}).strict(),
 status:z.enum(['accepted','missing','unknown','conflict']),...review,sha256:hash,
}).strict();
export const aiReleaseInterpretationReceiptSchema=z.union([interpretationReceiptBody.extend(exactRule),interpretationReceiptBody.extend(generatedRule)]).superRefine(checkHash);

/** Tests verify a pinned method; they never identify a customer or assert that
 * real-world facts were observed. Synthetic oracle inputs remain legitimate
 * test evidence even for a real policy. */
const testReceiptBody=z.object({schema_version:z.literal('tivdoc-ai-rule-tests-v1'),receipt_id:id,
 branch_id:id,source_receipt_sha256s:hashes.refine(v=>v.length>0),
 interpretation_receipt_sha256:hash,code_sha256:hash,test_definition_sha256:hash,independent_oracle_sha256:hash,
 results_sha256:hash,categories:uniqueStrings.refine(v=>v.length>0),passed:z.number().int().nonnegative(),failed:z.number().int().nonnegative(),
 outcome:z.enum(['passed','failed','incomplete']),...validity,sha256:hash,
}).strict();
export const aiReleaseTestReceiptSchema=z.union([testReceiptBody.extend(exactRule),testReceiptBody.extend(generatedRule)]).superRefine(checkHash);

const state=z.enum(['known','missing','unknown','conflict','stale','expired','unreadable']);
export const aiReleaseFactSchema=z.object({fact_key:id,state,origin:origins,value_sha256:hash.nullable(),
 source_pins:z.array(aiReleaseSourcePinSchema).max(32),reading_receipt_sha256:hash.nullable(),derivation_sha256:hash.nullable(),
 reading_policy_sha256:hash.optional(),validation_receipt_sha256:hash.optional(),
}).strict();
export const aiReleaseCaseDecisionSchema=z.object({decision_id:id,state:z.enum(['accepted','missing','unknown','conflict','stale','expired']),
 basis:z.literal('ai_source_assessment'),evidence_sha256:hash,source_pins:z.array(aiReleaseSourcePinSchema).max(32),
 explanation:z.string().min(1).max(2000),...validity,
}).strict();
export const aiReleaseBranchAssessmentSchema=z.object({branch_id:id,rule_sha256:hash,parameter_set_sha256:hash,
 generated_from:z.object({generator:aiReleaseGeneratorSchema,source_evidence_sha256:hash}).strict().optional(),
 facts:z.array(aiReleaseFactSchema).max(128),decisions:z.array(aiReleaseCaseDecisionSchema).max(64),
}).strict().superRefine((v,ctx)=>{
 if(new Set(v.facts.map(f=>f.fact_key)).size!==v.facts.length||new Set(v.decisions.map(d=>d.decision_id)).size!==v.decisions.length)
  ctx.addIssue({code:'custom',message:'AI_RELEASE_DUPLICATE_CASE_DEPENDENCY'});
});
export const aiReleaseAssessmentSchema=z.object({schema_version:z.literal('tivdoc-ai-case-assessment-v1'),assessment_id:id,
 policy_sha256:hash,registry_sha256:hash,actor_kind:z.literal('ai_reviewer'),reviewer_id:id,reviewer_version:id,
 scope:aiReleaseScopeSchema,...validity,branches:z.array(aiReleaseBranchAssessmentSchema).min(1).max(128),sha256:hash,
}).strict().superRefine(checkHash).superRefine((v,ctx)=>{
 if(new Set(v.branches.map(b=>b.branch_id)).size!==v.branches.length)ctx.addIssue({code:'custom',message:'AI_RELEASE_DUPLICATE_BRANCH'});
});

/** Server-owned expectations, never copied from an incoming assessment. The
 * pure evaluator checks equality; only a scoped loader can establish that
 * these pins really are the current database head. */
export const aiReleaseCurrentContextSchema=z.object({evaluated_at:time,environment,namespace,is_qa:z.boolean(),
 policy_sha256:hash,registry_sha256:hash,registry_revision:z.number().int().positive(),assessment_sha256:hash,
 scope:aiReleaseScopeSchema,source_pins:z.array(aiReleaseSourcePinSchema).max(256),
 expected_generated_rules:z.array(z.object({branch_id:id,generator:aiReleaseGeneratorSchema,source_evidence_sha256:hash,
  rule_sha256:hash,parameter_set_sha256:hash}).strict()).max(128).optional(),
}).strict().superRefine((v,ctx)=>{
 if(new Set(v.source_pins.map(p=>canonicalSha256(p))).size!==v.source_pins.length)ctx.addIssue({code:'custom',message:'AI_RELEASE_DUPLICATE_SOURCE_PIN'});
 if(v.expected_generated_rules&&new Set(v.expected_generated_rules.map(r=>r.branch_id)).size!==v.expected_generated_rules.length)
  ctx.addIssue({code:'custom',message:'AI_RELEASE_DUPLICATE_GENERATED_RULE'});
});
export const aiReleaseAssessmentInputSchema=z.object({policy:aiReleasePolicySchema,registry:aiReleaseRegistrySchema,
 source_receipts:z.array(aiReleaseSourceReceiptSchema).max(256),interpretation_receipts:z.array(aiReleaseInterpretationReceiptSchema).max(128),
 test_receipts:z.array(aiReleaseTestReceiptSchema).max(256),assessment:aiReleaseAssessmentSchema,current:aiReleaseCurrentContextSchema,
}).strict();

export type AiReleasePolicy=z.infer<typeof aiReleasePolicySchema>;
export type AiReleaseRegistry=z.infer<typeof aiReleaseRegistrySchema>;
export type AiReleaseSourceReceipt=z.infer<typeof aiReleaseSourceReceiptSchema>;
export type AiReleaseInterpretationReceipt=z.infer<typeof aiReleaseInterpretationReceiptSchema>;
export type AiReleaseTestReceipt=z.infer<typeof aiReleaseTestReceiptSchema>;
export type AiReleaseAssessment=z.infer<typeof aiReleaseAssessmentSchema>;
export type AiReleaseCurrentContext=z.infer<typeof aiReleaseCurrentContextSchema>;
export type AiReleaseAssessmentInput=z.infer<typeof aiReleaseAssessmentInputSchema>;
export type AiReleaseBranchPolicy=z.infer<typeof aiReleaseBranchPolicySchema>;
export type AiReleaseSourcePin=z.infer<typeof aiReleaseSourcePinSchema>;
