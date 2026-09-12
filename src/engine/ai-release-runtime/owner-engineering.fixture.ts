import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {fixture as pensionSource} from '../entitlement-review/compose.fixture.ts';
import {runtimeFixture} from './runtime.fixture.ts';
import {ownerEngineeringRuntimeInputSchema,type OwnerEngineeringRuntimeInput} from './owner-engineering.ts';
import type {OwnerEngineeringAssessmentInput} from '../ai-release/contracts.ts';
export function resealEngineeringFixture(record:{sha256:string}){const {sha256,...body}=record;void sha256;record.sha256=canonicalSha256(body);}
/** Synthetic test issuance only, never a persisted configuration or approval. */
export function repinEngineeringFixture(f:OwnerEngineeringAssessmentInput){
 f.source_receipts.forEach(resealEngineeringFixture);
 for(const r of f.interpretation_receipts){r.source_receipt_sha256s=f.source_receipts.map(s=>s.sha256);r.human_by_law.source_receipt_sha256s=[...r.source_receipt_sha256s];resealEngineeringFixture(r);}
 for(const r of f.test_receipts){r.source_receipt_sha256s=f.source_receipts.map(s=>s.sha256);r.interpretation_receipt_sha256=f.interpretation_receipts.find(i=>i.branch_id===r.branch_id)!.sha256;resealEngineeringFixture(r);}
 for(const b of f.policy.branches){b.source_receipt_sha256s=f.source_receipts.map(s=>s.sha256);b.interpretation_receipt_sha256=f.interpretation_receipts.find(i=>i.branch_id===b.branch_id)!.sha256;b.test_receipt_sha256s=f.test_receipts.filter(t=>t.branch_id===b.branch_id).map(t=>t.sha256);}
 resealEngineeringFixture(f.policy);f.registry.policy_sha256=f.policy.sha256;resealEngineeringFixture(f.registry);
 f.assessment.policy_sha256=f.policy.sha256;f.assessment.registry_sha256=f.registry.sha256;resealEngineeringFixture(f.assessment);
 f.current.policy_sha256=f.policy.sha256;f.current.registry_sha256=f.registry.sha256;f.current.assessment_sha256=f.assessment.sha256;
}
export function ownerEngineeringFixture(source=pensionSource().input):OwnerEngineeringRuntimeInput{
 const legacy=runtimeFixture(source),f=legacy.assessment_input;
 const owner_scope={case_id:source.case_id,identity_id:'22222222-2222-4222-8222-222222222222',enrollment_id:'33333333-3333-4333-8333-333333333333'};
 const policy={...f.policy,schema_version:'tivdoc-owner-engineering-policy-v1',purpose:'owner_engineering_review',claim_kind:'owner_engineering_review',owner_scope};
 resealEngineeringFixture(policy);f.registry.policy_sha256=policy.sha256;resealEngineeringFixture(f.registry);
 f.assessment.policy_sha256=policy.sha256;f.assessment.registry_sha256=f.registry.sha256;resealEngineeringFixture(f.assessment);
 const result=ownerEngineeringRuntimeInputSchema.parse({...legacy,assessment_input:{...f,policy,current:{...f.current,owner_scope,
  policy_sha256:policy.sha256,registry_sha256:f.registry.sha256,assessment_sha256:f.assessment.sha256}}});
 for(const r of result.assessment_input.interpretation_receipts){r.human_by_law.state='unresolved';r.human_by_law.explanation='Synthetic unresolved legal requirement; engineering permission is not a resolution.';}
 repinEngineeringFixture(result.assessment_input);return result;
}
