import {z} from 'zod';
import type {CanonicalFact} from '../../facts/contracts.ts';
import {employmentSnapshotSchema} from '../../facts/snapshot.ts';
import type {SourceCalculationTrace} from '../../calculations/source-trace.ts';
import {createTopicRuleInputSnapshot} from '../../rule-input/snapshot.ts';
import type {RuleInputSnapshot} from '../../wave1/contracts.ts';
import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import {humanDecisionEnvelopeSha256,humanDecisionPayloadSha256,humanDecisionSignatureSha256,payloadWithoutEmbeddedSignature,signedHumanDecisionEnvelopeSchema} from '../../legal-operations/human-trust.ts';
import {june2026CaseAssessmentSchema,JUNE_CASE_ASSESSOR_ROLE,JUNE_REGULAR_CASE_ASSESSMENT} from './contracts.ts';
import {assertJune2026RegularAuthority,type June2026RegularAuthority} from './authority.ts';
import type {June2026RegularAdmission} from './evidence.ts';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const body=z.object({schema_version:z.literal('june2026-regular-source-admission-v1'),
 verification:z.literal('signed_assessment_binding_only'),case_id:z.uuid(),analysis_run_id:z.uuid(),
 authority_sha256:sha,admission_sha256:sha,parent_facts_sha256:sha,effective_facts_sha256:sha,
 parent_rule_input_sha256:sha,effective_rule_input_sha256:sha,fact_id:z.uuid(),
 assessment:z.object({payload:june2026CaseAssessmentSchema,envelope:signedHumanDecisionEnvelopeSchema}).strict(),assessment_envelope_sha256:sha,
}).strict();
export const june2026RegularSourceAdmissionSchema=body.extend({binding_sha256:sha}).strict().superRefine((v,ctx)=>{
 const fail=()=>ctx.addIssue({code:'custom',message:'JUNE_REGULAR_SOURCE_ADMISSION_BINDING'});
 const {binding_sha256,...seed}=v,a=v.assessment.payload,e=v.assessment.envelope;
 if(canonicalSha256(seed)!==binding_sha256||a.case_id!==v.case_id||!a.hours_acceptance||v.parent_facts_sha256===v.effective_facts_sha256
  ||e.purpose!=='case_assessment'||e.payload_schema_version!==JUNE_REGULAR_CASE_ASSESSMENT||e.reviewer_role!==JUNE_CASE_ASSESSOR_ROLE
  ||e.reviewer_id!==a.reviewer_id||e.reviewer_role!==a.reviewer_role||e.issued_at!==a.issued_at
  ||humanDecisionPayloadSha256(payloadWithoutEmbeddedSignature(a))!==e.payload_sha256||humanDecisionEnvelopeSha256(e)!==v.assessment_envelope_sha256)fail();
 try{if(humanDecisionSignatureSha256(e.signature_base64)!==a.signature_sha256)fail();}catch{fail();}
});
export type June2026RegularSourceAdmission=z.infer<typeof june2026RegularSourceAdmissionSchema>;

/** This durable record checks exact signature/payload bytes, NOT cryptographic
 * trust. The authenticated loader verifies signatures/current trust; the DB
 * save/publication boundary binds this envelope to that current registry row. */
export function createJune2026RegularSourceAdmission(input:{authority:June2026RegularAuthority;admission:June2026RegularAdmission;trace:SourceCalculationTrace;parentRuleInput:RuleInputSnapshot}){
 assertJune2026RegularAuthority(input.authority);
 const {authority:a,admission:d,trace:t}=input;
 if(d.facts_snapshot_sha256===d.effective_facts_snapshot_sha256)return undefined;
 if(!d.execution_allowed||d.fact_admissions.length!==1||d.authority_sha256!==a.authority_sha256)throw Error('JUNE_REGULAR_SOURCE_ADMISSION_REQUIRED');
 const seed={schema_version:'june2026-regular-source-admission-v1' as const,verification:'signed_assessment_binding_only' as const,
  case_id:t.case_id,analysis_run_id:t.analysis_run_id,authority_sha256:a.authority_sha256,admission_sha256:d.resolution_sha256,
  parent_facts_sha256:d.facts_snapshot_sha256,effective_facts_sha256:d.effective_facts_snapshot_sha256,
  parent_rule_input_sha256:input.parentRuleInput.snapshot_sha256,effective_rule_input_sha256:t.rule_input_sha256,fact_id:d.fact_admissions[0].fact_id,
  assessment:{payload:a.assessment,envelope:a.assessment_envelope},assessment_envelope_sha256:a.assessment_envelope_sha256};
 return deepFreeze(june2026RegularSourceAdmissionSchema.parse({...seed,binding_sha256:canonicalSha256(seed)}));
}

export type June2026RegularParentScope=Readonly<{case_id:string;analysis_run_id:string;facts_snapshot_sha256:string;
 facts:readonly CanonicalFact[];rule_inputs:readonly RuleInputSnapshot[]}>;
export function assertJune2026RegularSourceAdmission(candidate:unknown,trace:SourceCalculationTrace,scope:June2026RegularParentScope,ruleInputSha256:string|null){
 const v=june2026RegularSourceAdmissionSchema.parse(candidate),a=v.assessment.payload;
 const parent=employmentSnapshotSchema.parse({...trace.facts_snapshot,facts:scope.facts});
 const old=parent.facts.find(f=>f.fact_id===v.fact_id),reference=old?.provenance[0],acceptance=a.hours_acceptance;
 if(v.case_id!==scope.case_id||v.analysis_run_id!==scope.analysis_run_id||trace.case_id!==scope.case_id||trace.analysis_run_id!==scope.analysis_run_id
  ||v.parent_facts_sha256!==scope.facts_snapshot_sha256||canonicalSha256(parent)!==v.parent_facts_sha256
  ||v.effective_facts_sha256!==trace.facts_snapshot_sha256||v.effective_rule_input_sha256!==trace.rule_input_sha256
  ||v.parent_rule_input_sha256!==ruleInputSha256||scope.rule_inputs.filter(r=>r.snapshot_sha256===v.parent_rule_input_sha256).length!==1
  ||createTopicRuleInputSnapshot(parent,'minimum_wage').snapshot_sha256!==v.parent_rule_input_sha256
  ||Date.parse(trace.calculated_at)<Date.parse(a.issued_at)||Date.parse(trace.calculated_at)>=Date.parse(a.expires_at)
  ||Date.parse(trace.calculated_at)>=Date.parse(v.assessment.envelope.expires_at)
  ||trace.rule_package.topic!=='minimum_wage'||!old||old.path!=='work.regular_hours'||old.status!=='needs_confirmation'||!old.value
  ||old.conflicting_fact_ids.length||old.provenance.length!==1||reference?.source_type!=='declared'||reference.source_reference.kind!=='case_request_answer'
  ||!acceptance||acceptance.request_id!==reference.source_reference.request_id||acceptance.answer_revision!==reference.source_reference.answer_revision
  ||acceptance.provenance_sha256!==canonicalSha256(old.provenance)||acceptance.value!==old.value.amount||old.value.unit!=='hours_per_month')
  throw Error('JUNE_REGULAR_SOURCE_PARENT_BINDING');
 const effective=employmentSnapshotSchema.parse({...parent,facts:parent.facts.map(f=>f.fact_id===old.fact_id?{...f,status:'confirmed'}:f)});
 if(canonicalSha256(effective)!==v.effective_facts_sha256||canonicalSha256(effective)!==canonicalSha256(trace.facts_snapshot))
  throw Error('JUNE_REGULAR_SOURCE_EFFECTIVE_BINDING');
 return v;
}
