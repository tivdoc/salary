import {z} from 'zod';
import {canonicalSha256, deepFreeze} from '../rule-runtime/canonical.ts';
import type {EmploymentSnapshot} from '../facts/snapshot.ts';
import type {June2026AssessmentPacket} from './assessment-packet.ts';
import {june2026WageEvidenceSchema} from './evidence.ts';
import {prepareJune2026MinimumWage} from './executor.ts';
import {createJune2026MinimumWageCandidate} from './candidate.ts';
import {JUNE2026_MINIMUM_WAGE_POLICY_SHA256} from './sources.ts';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
/** An engineering assessment is explicitly NOT a professional attestation.
 * Its authority is supplied by the private DEV registry, never by an answer.
 * Every assumption pins the exact declaration that was assessed. */
export const june2026TestAssessmentSchema=z.object({
 schema_version:z.literal('june2026-isolated-test-assessment-v1'),
 authority:z.literal('isolated_dev_test_assumptions'), human_approval:z.literal(false),
 assessment_id:z.uuid(), case_id:z.uuid(), order_id:z.uuid(),
 input_revision:z.number().int().positive(), input_sha256:sha,
 document_version_id:z.uuid(), document_sha256:sha,
 policy_sha256:sha, rule_sha256:sha, golden_cases_sha256:sha,
 issued_at:z.iso.datetime({offset:true}), expires_at:z.iso.datetime({offset:true}),
 source:z.string().min(1).max(500),
 decisions:z.array(z.object({field:z.string().min(1).max(100),
  decision_kind:z.enum(['applicability_assessment','component_classification','inventory_assessment']),
  target_sha256:sha, declaration_sha256:sha,
  value:z.union([z.boolean(),z.literal('general_private'),z.literal('base_salary')]),
  source:z.string().min(1).max(500), rationale:z.string().min(1).max(1000),
 }).strict()).max(8),
}).strict().superRefine((v,c)=>{
 if(new Set(v.decisions.map(d=>d.field)).size!==v.decisions.length||Date.parse(v.expires_at)<=Date.parse(v.issued_at))
  c.addIssue({code:'custom',message:'Invalid assessment interval or duplicate decision'});
});
export type June2026TestAssessment=z.infer<typeof june2026TestAssessmentSchema>;

/** Pure policy evaluation; callers MUST authenticate the registry record and
 * saved packet before calling. No client input can create registry authority. */
export function resolveJune2026Evidence(input:{packet:June2026AssessmentPacket;facts:EmploymentSnapshot;
 assessment:June2026TestAssessment|null;evaluatedAt:string;mode:'real'|'synthetic_test'}){
 const p=input.packet,{packet_sha256,...body}=p;
 if(canonicalSha256(body)!==packet_sha256||canonicalSha256(input.facts)!==p.facts_snapshot_sha256
  ||input.facts.case_id!==p.current.case_id||input.facts.analysis_run_id!==p.current.analysis_run_id)
  throw Error('JUNE_ADMISSION_SAVED_PACKET_BINDING');
 const now=z.iso.datetime({offset:true}).parse(input.evaluatedAt);
 const a=input.assessment?june2026TestAssessmentSchema.parse(input.assessment):null;
 const candidate=createJune2026MinimumWageCandidate(1);
 const policyMatches=a&&a.policy_sha256===JUNE2026_MINIMUM_WAGE_POLICY_SHA256&&a.policy_sha256===p.policy_sha256
  &&a.rule_sha256===candidate.rule.content_sha256&&a.golden_cases_sha256===candidate.goldenCases.content_sha256;
 const scopeMatches=a&&a.case_id===p.current.case_id&&a.order_id===p.current.order_id
  &&a.input_revision===p.current.input_revision&&a.input_sha256===p.current.input_sha256
  &&a.document_version_id===p.document.version_id&&a.document_sha256===p.document.sha256;
 const allowed=input.mode==='synthetic_test'&&a!==null&&policyMatches&&scopeMatches&&Date.parse(a.issued_at)<=Date.parse(now)&&Date.parse(now)<Date.parse(a.expires_at);
 const decisions=p.gates.map(g=>{
  const assessment=a?.decisions.find(d=>d.field===g.field);
  const expectedKind=g.field==='components.legal_classification'?'component_classification'
   :g.field==='wage_components_complete'?'inventory_assessment':'applicability_assessment';
  let state:string=g.state;
  if(g.state==='declared_unreviewed'){
   if(input.mode==='real'||!a)state='assessment_missing';
   else if(!scopeMatches||!policyMatches||Date.parse(a.issued_at)>Date.parse(now))state='stale';
   else if(Date.parse(now)>=Date.parse(a.expires_at))state='expired';
   else if(!assessment)state='assessment_missing';
   else if(assessment.decision_kind!==expectedKind||assessment.target_sha256!==g.current_target_sha256
    ||assessment.declaration_sha256!==g.observed_declaration?.declaration_sha256)state='stale';
   else {
    const declared=g.observed_declaration!.interpretation;
    // Text about sector/function needs the explicitly recorded assessment;
    // boolean or component disagreement must never be overwritten by it.
    if((declared.kind==='boolean_declaration'||declared.kind==='component_substance_declaration')&&declared.value!==assessment.value)state='conflicted';
    else state='test_assessment_admitted';
   }
  }
  return {field:g.field,state,decision_kind:expectedKind,customer_declaration:g.observed_declaration,
   assessment:assessment??null,authority:state==='test_assessment_admitted'?'isolated_dev_test_assumptions':null};
 });
 const evidence=structuredClone(p.evidence);
 for(const d of decisions){
  if(!allowed||d.state!=='test_assessment_admitted'||!d.assessment||!d.customer_declaration)continue;
  const assertion={status:'confirmed' as const,value:d.assessment.value,provenance:d.customer_declaration.provenance};
  if(d.field.startsWith('applicability.'))Reflect.set(evidence.applicability,d.field.slice(14),assertion);
  else if(d.field==='wage_components_complete')Reflect.set(evidence,'wage_components_complete',assertion);
  else for(const c of evidence.components){Reflect.set(c,'classification',d.assessment.value);Reflect.set(c,'classification_status','confirmed');}
 }
 const parsed=june2026WageEvidenceSchema.parse(evidence);
 const ready=allowed&&decisions.length===8&&decisions.every(d=>d.state==='test_assessment_admitted')&&p.factual_issues.length===0;
 const preflight=ready?prepareJune2026MinimumWage({facts:input.facts,evidence:parsed,calculatedAt:now}):p.preflight;
 if(!ready&&preflight.state==='candidate_calculated')throw Error('JUNE_ADMISSION_UNEXPECTED_CALCULATION');
 const seed={schema_version:'june2026-evidence-admission-v1',mode:input.mode,
  authority:ready?'isolated_dev_test_assumptions':'none',human_approval:false,legal_activation:false,customer_publication_allowed:false,
  packet_sha256,assessment_sha256:a?canonicalSha256(a):null,decisions,
  document_readings:input.facts.facts.map(f=>({fact_id:f.fact_id,path:f.path,status:f.status,provenance:f.provenance})),
  evidence:parsed,preflight,execution_allowed:ready&&preflight.state==='candidate_calculated'};
 return deepFreeze({...seed,resolution_sha256:canonicalSha256(seed)});
}
export type June2026EvidenceAdmission=ReturnType<typeof resolveJune2026Evidence>;
