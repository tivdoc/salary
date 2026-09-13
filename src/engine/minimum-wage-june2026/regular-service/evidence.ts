import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import {employmentSnapshotSchema,type EmploymentSnapshot} from '../../facts/snapshot.ts';
import type {June2026AssessmentPacket} from '../assessment-packet.ts';
import {june2026WageEvidenceSchema} from '../evidence.ts';
import {prepareJune2026MinimumWage} from '../executor.ts';
import {assertJune2026RegularAuthority,type June2026RegularAuthority} from './authority.ts';
import type {HoursConflictDeclaration} from '../../extraction/hours-conflict.ts';
import {assertJune2026HoursConflictAcceptance,deriveJune2026HoursConflictFacts} from './hours-conflict-admission.ts';

/** A signed case assessment admits exact identified declarations under the
 * pinned policy. It never rewrites their origin as a document or mutates facts. */
export function resolveJune2026RegularEvidence(input:{authority:June2026RegularAuthority;packet:June2026AssessmentPacket;facts:EmploymentSnapshot;hoursConflictDeclaration?:HoursConflictDeclaration}){
 assertJune2026RegularAuthority(input.authority);
 const {authority,packet:p}=input,a=authority.assessment,facts=employmentSnapshotSchema.parse(input.facts);
 const {packet_sha256,...packetBody}=p;
 if(canonicalSha256(packetBody)!==packet_sha256||canonicalSha256(facts)!==p.facts_snapshot_sha256
  ||facts.case_id!==p.current.case_id||facts.analysis_run_id!==p.current.analysis_run_id)throw Error('JUNE_REGULAR_CONTEXT_HASH');
 if(a.case_id!==p.current.case_id||a.order_id!==p.current.order_id||a.input_revision!==p.current.input_revision
  ||a.input_sha256!==p.current.input_sha256||a.document_version_id!==p.document.version_id||a.document_sha256!==p.document.sha256
  ||a.policy_sha256!==p.policy_sha256||p.current.month!=='2026-06')throw Error('JUNE_REGULAR_ASSESSMENT_CONTEXT');
 const blockers:string[]=[];
 const decisions=p.gates.map(g=>{
  const assessment=a.decisions.find(d=>d.field===g.field),declaration=g.observed_declaration;
  const expectedKind=g.field==='components.legal_classification'?'component_classification':g.field==='wage_components_complete'?'inventory_assessment':'applicability_assessment';
  let state:string=g.state;
  if(g.state==='declared_unreviewed'){
   if(!assessment)state='assessment_missing';
   else if(!declaration||assessment.target_sha256!==g.current_target_sha256||assessment.declaration_sha256!==declaration.declaration_sha256
    ||assessment.decision_kind!==expectedKind)state='stale';
   else if((declaration.interpretation.kind==='boolean_declaration'||declaration.interpretation.kind==='component_substance_declaration')
    &&assessment.value!==declaration.interpretation.value)state='conflicted';
   else state='assessed';
  }
  if(state!=='assessed')blockers.push(`${g.field}:${state}`);
  return {field:g.field,state,assessment:assessment??null,declaration};
 });
 if(decisions.length!==8||a.decisions.some(d=>!decisions.some(g=>g.field===d.field)))blockers.push('assessment_subject_set');
 const hours=facts.facts.find(f=>f.path==='work.regular_hours');
 const correction=input.hoursConflictDeclaration;
 let correctionFacts:EmploymentSnapshot|undefined;
 if(correction){
  assertJune2026HoursConflictAcceptance(correction,a);
  if(correction.target.extraction_result_sha256!==p.extraction_result_sha256||correction.target.product_document_id!==p.document.product_document_id
   ||correction.target.source_page_count!==p.document.page_count)throw Error('JUNE_REGULAR_HOURS_CONFLICT_CHECKPOINT');
  correctionFacts=deriveJune2026HoursConflictFacts(facts,correction);
 }
 const hoursDeclared=!!correction||hours?.provenance.some(e=>e.source_type==='declared');
 let hoursAccepted=false;
 if(correction)hoursAccepted=true;
 else if(hoursDeclared){
  // Canonical IDs/timestamps belong to the new analysis run. The signature
  // binds the immutable identified answer instead; the saved-context loader
  // separately proves this exact value/provenance came from its input journal.
  const acceptance=a.hours_acceptance,source=hours?.provenance[0];
  if(!hours||hours.path!=='work.regular_hours'||!['confirmed','needs_confirmation'].includes(hours.status)||hours.conflicting_fact_ids.length||!hours.value
   ||hours.provenance.length!==1||source?.source_type!=='declared'||source.source_reference.kind!=='case_request_answer'
   ||!acceptance||acceptance.request_id!==source.source_reference.request_id||acceptance.answer_revision!==source.source_reference.answer_revision
   ||acceptance.provenance_sha256!==canonicalSha256(hours.provenance)||acceptance.value!==hours.value.amount)
   blockers.push('work.regular_hours:identified_declaration_assessment_required');
  else hoursAccepted=true;
 }else if(a.hours_acceptance!==null)blockers.push('work.regular_hours:unexpected_declared_assessment');
 blockers.push(...p.factual_issues.filter(issue=>!(hoursAccepted&&issue.field==='work.regular_hours'
  &&(issue.reason==='declared_hours_assessment_required'||correction&&['confirmed_canonical_fact_required','conflicted_canonical_fact'].includes(issue.reason)))).map(issue=>`${issue.field}:${issue.reason}`));
 // This separately hashed admission snapshot is never written over the saved
 // canonical stage. Only the exact signed declared-hours fact changes status;
 // its value, confidence, evidence and original snapshot remain accessible.
 const effectiveFacts=correctionFacts??employmentSnapshotSchema.parse({...facts,facts:facts.facts.map(f=>hoursAccepted&&f.fact_id===hours?.fact_id?{...f,status:'confirmed'}:f)});
 const evidence={...structuredClone(p.evidence),facts_snapshot_sha256:canonicalSha256(effectiveFacts)};
 for(const d of decisions){
  if(d.state!=='assessed'||!d.assessment||!d.declaration)continue;
  const assertion={status:'confirmed' as const,value:d.assessment.value,provenance:d.declaration.provenance};
  if(d.field.startsWith('applicability.'))Reflect.set(evidence.applicability,d.field.slice(14),assertion);
  else if(d.field==='wage_components_complete')Reflect.set(evidence,'wage_components_complete',assertion);
  else for(const component of evidence.components){Reflect.set(component,'classification',d.assessment.value);Reflect.set(component,'classification_status','confirmed');}
 }
 if(evidence.components.length!==1)blockers.push('single_documented_component_required');
 const parsed=june2026WageEvidenceSchema.parse(evidence);
 const preflight=blockers.length?null:prepareJune2026MinimumWage({facts:effectiveFacts,evidence:parsed,calculatedAt:authority.evaluated_at});
 if(preflight?.state==='missing_input')blockers.push(...preflight.requests.map(r=>`${r.field}:${r.reason}`));
 if(preflight?.state==='out_of_scope')blockers.push(...preflight.blockers,...preflight.requests.map(r=>`${r.field}:${r.reason}`));
 const seed={schema_version:correction?'june2026-regular-evidence-admission-v2':'june2026-regular-evidence-admission-v1',authority_sha256:authority.authority_sha256,
  assessment_sha256:canonicalSha256(a),packet_sha256,mode:authority.mode,case_id:facts.case_id,analysis_run_id:facts.analysis_run_id,
  facts_snapshot_sha256:canonicalSha256(facts),effective_facts_snapshot_sha256:canonicalSha256(effectiveFacts),effective_facts:effectiveFacts,
  fact_admissions:hoursAccepted&&hours?[{fact_id:hours.fact_id,prior_fact_sha256:canonicalSha256(hours),effective_fact_sha256:canonicalSha256(effectiveFacts.facts.find(f=>f.fact_id===hours.fact_id)),
   assessment_envelope_sha256:authority.assessment_envelope_sha256,decision:'accept_identified_declared_regular_hours' as const,
   declared_answer:{request_id:a.hours_acceptance!.request_id,answer_revision:a.hours_acceptance!.answer_revision,provenance_sha256:a.hours_acceptance!.provenance_sha256},
   provenance:correction?.provenance??hours.provenance}]:[],
  ...(correction?{hours_conflict_declaration:correction}:{}),
  decisions,hours_origin:hoursDeclared?'identified_declared' as const:'documented' as const,
  evidence:parsed,preflight,blockers,execution_allowed:blockers.length===0&&preflight?.state==='candidate_calculated',
  real_legal_authority:authority.real_legal_authority,human_report_approval:false as const};
 return deepFreeze({...seed,resolution_sha256:canonicalSha256(seed)});
}
export type June2026RegularAdmission=ReturnType<typeof resolveJune2026RegularEvidence>;
