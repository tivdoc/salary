import {z} from 'zod';
import type {HumanTrustVerificationPort, SignedHumanDecisionEnvelope} from '../../legal-operations/human-trust.ts';
import type {ImportArtifactCommand} from '../../legal-operations/state-machine.ts';
import type {GoldenCaseSet} from '../../legal-operations/rulespec.ts';

export const JUNE_REGULAR_AUTHORITY_VERSION='june2026-regular-authority-v1' as const;
export const JUNE_REGULAR_CASE_ASSESSMENT='june2026-case-assessment-v1' as const;
export const JUNE_CASE_ASSESSOR_ROLE='human_case_assessment_reviewer' as const;
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const june2026CaseAssessmentSchema=z.object({
 schema_version:z.literal(JUNE_REGULAR_CASE_ASSESSMENT),assessment_id:z.uuid(),
 namespace:z.enum(['real','isolated_test']),case_id:z.uuid(),order_id:z.uuid(),
 input_revision:z.number().int().positive(),input_sha256:sha,month:z.literal('2026-06'),
 document_version_id:z.uuid(),document_sha256:sha,policy_sha256:sha,rule_sha256:sha,golden_cases_sha256:sha,
 reviewer_id:z.string().min(3),reviewer_role:z.literal(JUNE_CASE_ASSESSOR_ROLE),
 issued_at:z.iso.datetime({offset:true}),expires_at:z.iso.datetime({offset:true}),
 decisions:z.array(z.object({field:z.string().min(1).max(100),
  decision_kind:z.enum(['applicability_assessment','component_classification','inventory_assessment']),
  target_sha256:sha,declaration_sha256:sha,value:z.union([z.boolean(),z.literal('general_private'),z.literal('base_salary')]),
  rationale:z.string().min(10).max(2000),source:z.string().min(3).max(500),
 }).strict()).length(8),
 hours_acceptance:z.object({request_id:z.uuid(),answer_revision:z.number().int().positive(),provenance_sha256:sha,
  value:z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u),
  decision:z.literal('accept_identified_declared_regular_hours'),rationale:z.string().min(10).max(2000),
 }).strict().nullable(),
 signature_sha256:sha,
}).strict().superRefine((value,ctx)=>{
 if(Date.parse(value.expires_at)<=Date.parse(value.issued_at)||new Set(value.decisions.map(d=>d.field)).size!==8)
  ctx.addIssue({code:'custom',message:'JUNE_CASE_ASSESSMENT_INTERVAL_OR_DUPLICATE'});
});
export type June2026CaseAssessment=z.infer<typeof june2026CaseAssessmentSchema>;
export type June2026LegalEvent=Readonly<{
 kind:'source_review'|'parameter_attestation'|'semantic_approval'|'transition';
 payload:unknown;envelope:SignedHumanDecisionEnvelope|null;
}>;
/** The loader supplies the complete CURRENT governance histories, including
 * revocation/supersession events. A caller-selected historical head is not an
 * authority. The verifier must be backed by that same authenticated registry. */
export type June2026RegularAuthorityInput=Readonly<{
 mode:'real'|'synthetic_test';evaluatedAt:string;
 registry:Readonly<{namespace:'real'|'isolated_test';organization_id:string;organization_version:string;policy_version:string;registry_sha256:string}>;
 trust:HumanTrustVerificationPort;
 legal:Readonly<{artifacts:readonly Readonly<{import:ImportArtifactCommand;events:readonly June2026LegalEvent[]}>[];goldenCases:GoldenCaseSet}>;
 assessment:Readonly<{payload:unknown;envelope:SignedHumanDecisionEnvelope}>;
}>;
