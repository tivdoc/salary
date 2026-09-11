import {randomUUID} from 'node:crypto';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {legalOperationsSha256} from '../../legal-operations/canonical.ts';
import {humanDecisionSignatureSha256,payloadWithoutEmbeddedSignature,type HumanTrustPurpose} from '../../legal-operations/human-trust.ts';
import {lifecycleCommandSchema,parameterAttestationSchema,semanticApprovalSchema,sourceReviewAttestationSchema} from '../../legal-operations/contracts.ts';
import {createJune2026MinimumWageCandidate} from '../candidate.ts';
import {JUNE2026_MINIMUM_WAGE_POLICY_SHA256,JUNE2026_MINIMUM_WAGE_SOURCES} from '../sources.ts';
import type {June2026AssessmentPacket} from '../assessment-packet.ts';
import type {EmploymentSnapshot} from '../../facts/snapshot.ts';
import {hoursConflictDeclarationSchema,type HoursConflictDeclaration} from '../../extraction/hours-conflict.ts';
import {createReviewerTrustPolicy,createTrustOrganization,createTrustedReviewer,InMemoryReviewerTrustStore} from '../../../server/platform/trust/reviewer-trust-store.ts';
import {generateEd25519TestKey,signHumanDecision,signKeyPossessionChallenge} from '../../../server/platform/trust/test-support.ts';
import type {SavedRegularTrustJournal} from '../../../server/product/processing/saved-regular-trust.ts';
import {june2026RegularArtifactImports} from './authority.ts';
import {JUNE_CASE_ASSESSOR_ROLE,JUNE_REGULAR_CASE_ASSESSMENT,june2026CaseAssessmentSchema,type June2026LegalEvent,type June2026RegularAuthorityInput} from './contracts.ts';

/** REAL Ed25519 signatures and proof of key possession, but exclusively an
 * isolated synthetic trust organization. These are not real human approvals.
 * The journal has only public keys, public challenges and signatures; signing
 * keys stay in this test-only closure and are never returned or serialized. */
export function createRegularServiceTrustFixture(now='2026-09-10T16:00:00.000Z'){
 const expires=new Date(Date.parse(now)+2*60*60*1000).toISOString(),organization='isolated.june.regular.test',admin='isolated.june.admin',root='isolated.june.root';
 const trust=new InMemoryReviewerTrustStore({root_admin_ids:[root],clock:()=>now});
 const journal:SavedRegularTrustJournal={schema_version:'june2026-trust-registry-journal-v1',root_admin_ids:[root],events:[]};
 const organizationRecord=createTrustOrganization({schema_version:'tivdoc-reviewer-trust-v0.10.0',organization_id:organization,organization_version:'1.0.0',
  valid_from:'2026-01-01T00:00:00.000Z',expires_at:'2027-01-01T00:00:00.000Z',policy_admin_ids:[admin]});
 trust.registerOrganization(organizationRecord,root);journal.events.push({kind:'organization',at:now,candidate:organizationRecord,actor:root});
 const sourceRoles=[['artifact_authenticity','human_artifact_reviewer'],['content_transcription_accuracy','human_content_reviewer'],
  ['effective_interval','human_effective_period_reviewer'],['sector_population_applicability','human_applicability_reviewer'],['authority_precedence','human_authority_reviewer']] as const;
 const definitions=[...sourceRoles.map(([key,role])=>({key,role,purpose:'source_review' as HumanTrustPurpose})),
  {key:'parameter1',role:'human_parameter_reviewer',purpose:'parameter_attestation' as HumanTrustPurpose},
  {key:'parameter2',role:'human_parameter_reviewer',purpose:'parameter_attestation' as HumanTrustPurpose},
  {key:'rule',role:'human_rule_reviewer',purpose:'rulespec_semantics' as HumanTrustPurpose},
  {key:'golden',role:'human_golden_case_reviewer',purpose:'golden_case_outputs' as HumanTrustPurpose},
  {key:'eligible',role:'human_authority_reviewer',purpose:'lifecycle_action' as HumanTrustPurpose},
  {key:'activation',role:'human_activation_approver',purpose:'lifecycle_action' as HumanTrustPurpose},
  {key:'case',role:JUNE_CASE_ASSESSOR_ROLE,purpose:'case_assessment' as HumanTrustPurpose}];
 const policy=createReviewerTrustPolicy({schema_version:'tivdoc-reviewer-trust-v0.10.0',organization_id:organization,organization_version:'1.0.0',policy_version:'1.0.0',
  effective_from:'2026-01-01T00:00:00.000Z',expires_at:'2027-01-01T00:00:00.000Z',max_envelope_ttl_seconds:7200,
  grants:[...new Set(definitions.map(d=>d.role))].map(role=>({reviewer_role:role,purposes:[...new Set(definitions.filter(d=>d.role===role).map(d=>d.purpose))]}))});
 trust.publishPolicy(policy,admin);journal.events.push({kind:'policy',at:now,candidate:policy,actor:admin});
 const reviewers=new Map(definitions.map(d=>{
  const id=`isolated.june.reviewer.${d.key}`,key=generateEd25519TestKey();
  const reviewer=createTrustedReviewer({schema_version:'tivdoc-reviewer-trust-v0.10.0',organization_id:organization,organization_version:'1.0.0',reviewer_id:id,
   reviewer_identity_version:'1.0.0',reviewer_roles:[d.role],valid_from:'2026-01-01T00:00:00.000Z',expires_at:'2027-01-01T00:00:00.000Z',
   identity_evidence_sha256:canonicalSha256({explicitly_synthetic_identity:id})});
  trust.registerReviewer(reviewer,admin);journal.events.push({kind:'reviewer',at:now,candidate:reviewer,actor:admin});
  const challenge=trust.issueKeyPossessionChallenge({challenge_id:`isolated.june.challenge.${d.key}`,reviewer_id:id,reviewer_identity_version:'1.0.0',
   key_id:`isolated.june.key.${d.key}`,public_key_spki_pem:key.public_key_spki_pem,valid_from:now,expires_at:'2027-01-01T00:00:00.000Z',replaces_key_id:null,actor_id:admin});
  journal.events.push({kind:'challenge',at:now,challenge,actor:admin});
  const proof=signKeyPossessionChallenge(challenge,key.private_key);trust.registerProvenKey({challenge,proof_signature_base64:proof});
  journal.events.push({kind:'key',at:now,challenge,proof_signature_base64:proof});
  return [d.key,{...d,id,key_id:challenge.key_id,key}];
 }));
 let sequence=0;
 const sign=(key:string,payload:Record<string,unknown>,signatureField='signature_sha256')=>{
  const r=reviewers.get(key);if(!r)throw Error('SYNTHETIC_REVIEWER_MISSING');
  const envelope=signHumanDecision({envelope_id:`isolated.june.envelope.${++sequence}`,organization_id:organization,organization_version:'1.0.0',policy_version:'1.0.0',
   reviewer_id:r.id,reviewer_identity_version:'1.0.0',reviewer_role:r.role,key_id:r.key_id,purpose:r.purpose,payload_schema_version:String(payload.schema_version),
   payload:payloadWithoutEmbeddedSignature(payload),issued_at:now,expires_at:expires,private_key:r.key.private_key});
  return {payload:{...payload,[signatureField]:humanDecisionSignatureSha256(envelope.signature_base64)},envelope};
 };
 const candidate=createJune2026MinimumWageCandidate(1),imports=june2026RegularArtifactImports(now);
 const artifacts=imports.map(imp=>{
  const events:June2026LegalEvent[]=[];
  const transition=(from:string,to:string,key:string|null)=>{
   const actor=key?reviewers.get(key)!:null;
   const payload=lifecycleCommandSchema.parse({schema_version:'tivdoc-legal-lifecycle-command-v0.6.0',command_id:`isolated.command.${imp.artifact_id}.${to}`,
    idempotency_key:`isolated.command.${imp.artifact_id}.${to}`,artifact_id:imp.artifact_id,artifact_version:imp.artifact_version,artifact_kind:imp.artifact_kind,
    expected_state:from,target_state:to,actor_id:actor?.id??'isolated.mechanical.transition',actor_role:actor?.role??'human_authority_reviewer',
    occurred_at:now,reason:'Synthetic registry mechanics; no real legal authority or human action is asserted.',bound_content_sha256:imp.content_sha256,
    bindings:imp.bindings,action_signature_sha256:null});
   events.push({kind:'transition',...(key?sign(key,payload,'action_signature_sha256'):{payload,envelope:null})});
  };
  if(imp.artifact_kind==='source'){
   const source=JUNE2026_MINIMUM_WAGE_SOURCES.find(s=>s.source_version_id===imp.artifact_id)!;
   for(const [kind] of sourceRoles){
    const r=reviewers.get(kind)!;
    const decision_payload=kind==='artifact_authenticity'?{kind,status:'verified',artifact_sha256s:[source.artifact_sha256]}:
     kind==='content_transcription_accuracy'?{kind,status:'verified',artifact_sha256s:[source.artifact_sha256],chunk_sha256s:[source.parsed_sha256]}:
     kind==='effective_interval'?{kind,status:'verified',intervals:[{from:'2026-06-01',to:'2026-06-30'}]}:
     kind==='sector_population_applicability'?{kind,status:'verified',sectors:['general_private'],populations:['adult_general']}:
     {kind,status:'verified',source_roles:[{source_version_id:source.source_version_id,authority_role:'primary_binding'}]};
    const signed=sign(kind,{schema_version:'tivdoc-source-review-attestation-v0.6.0',attestation_id:`isolated.source.${source.source_id}.${kind}`,
     packet_id:'isolated.june.source.packet',packet_sha256:canonicalSha256({synthetic_review_target:source}),source_version_ids:[source.source_version_id],
     decision_kind:kind,decision:'approved',reviewer_id:r.id,reviewer_role:r.role,decided_at:now,reason:'Explicitly isolated synthetic approval used to test signature and source binding mechanics.',
     decision_payload,bound_artifact_sha256s:[source.artifact_sha256],bound_citation_sha256:imp.bindings.citations_sha256,
     bound_interval_sha256:imp.bindings.interval_sha256,bound_scope_sha256:imp.bindings.scope_sha256});
    events.push({kind:'source_review',payload:sourceReviewAttestationSchema.parse(signed.payload),envelope:signed.envelope});
   }
   transition('needs_review','content_verified',null);transition('content_verified','applicability_verified',null);transition('applicability_verified','eligible','eligible');
  }else{
   transition('candidate','structurally_valid',null);transition('structurally_valid','awaiting_attestations',null);
   if(imp.artifact_kind==='parameter'){
    const p=candidate.parameters.find(p=>p.parameter_id===imp.artifact_id)!;
    for(const key of ['parameter1','parameter2']){
     const r=reviewers.get(key)!;const signed=sign(key,{schema_version:'tivdoc-parameter-attestation-v0.6.0',attestation_id:`isolated.${key}.${p.parameter_id}`,
      candidate_id:p.parameter_id,candidate_version:p.parameter_version,candidate_sha256:p.candidate_sha256,reviewer_id:r.id,reviewer_role:r.role,
      value:p.value,unit:p.unit,rounding_policy:p.rounding_policy,operative_source_version_ids:p.operative_source_version_ids,bindings_sha256:legalOperationsSha256(p.bindings),
      decision:'approved',attested_at:now});
     events.push({kind:'parameter_attestation',payload:parameterAttestationSchema.parse(signed.payload),envelope:signed.envelope});
    }
   }else for(const key of ['rule','golden']){
    const r=reviewers.get(key)!;const signed=sign(key,{schema_version:'tivdoc-legal-semantic-approval-v0.6.0',approval_id:`isolated.approval.${key}`,
     artifact_id:candidate.rule.rule_spec_id,artifact_version:candidate.rule.rule_spec_version,artifact_sha256:key==='rule'?candidate.rule.content_sha256:candidate.goldenCases.content_sha256,
     approval_kind:key==='rule'?'rule_semantics':'golden_case_outputs',reviewer_id:r.id,reviewer_role:r.role,decision:'approved',decided_at:now});
    events.push({kind:'semantic_approval',payload:semanticApprovalSchema.parse(signed.payload),envelope:signed.envelope});
   }
   transition('awaiting_attestations','approved',null);transition('approved','eligible','eligible');
  }
  transition('eligible','active','activation');return {import:imp,events};
 });
 const legal={artifacts,goldenCases:candidate.goldenCases};
 const registry={namespace:'isolated_test' as const,organization_id:organization,organization_version:'1.0.0',policy_version:'1.0.0',registry_sha256:canonicalSha256(journal)};
 const assessment=(packet:June2026AssessmentPacket,facts:EmploymentSnapshot,hoursConflictDeclaration?:HoursConflictDeclaration)=>{
  const correction=hoursConflictDeclaration?hoursConflictDeclarationSchema.parse(hoursConflictDeclaration):undefined;
  const r=reviewers.get('case')!,hours=facts.facts.find(f=>f.path==='work.regular_hours');
  const hoursDeclared=hours?.path==='work.regular_hours'&&hours.value&&hours.provenance.some(p=>p.source_type==='declared');
  const hoursSource=hours?.provenance[0];
  if(hoursDeclared&&(hours?.provenance.length!==1||hoursSource?.source_type!=='declared'||hoursSource.source_reference.kind!=='case_request_answer'))
   throw Error('SYNTHETIC_SINGLE_IDENTIFIED_HOURS_ANSWER_REQUIRED');
  const signed=sign('case',{schema_version:JUNE_REGULAR_CASE_ASSESSMENT,assessment_id:randomUUID(),namespace:'isolated_test',case_id:packet.current.case_id,
   order_id:packet.current.order_id,input_revision:packet.current.input_revision,input_sha256:packet.current.input_sha256,month:'2026-06',
   document_version_id:packet.document.version_id,document_sha256:packet.document.sha256,policy_sha256:JUNE2026_MINIMUM_WAGE_POLICY_SHA256,
   rule_sha256:candidate.rule.content_sha256,golden_cases_sha256:candidate.goldenCases.content_sha256,reviewer_id:r.id,reviewer_role:r.role,issued_at:now,expires_at:expires,
   decisions:packet.gates.map(g=>{if(!g.observed_declaration||!g.current_target_sha256)throw Error('SYNTHETIC_DECLARATION_REQUIRED');return {field:g.field,
    decision_kind:g.field==='components.legal_classification'?'component_classification':g.field==='wage_components_complete'?'inventory_assessment':'applicability_assessment',
    target_sha256:g.current_target_sha256,declaration_sha256:g.observed_declaration.declaration_sha256,
    value:g.field==='applicability.sector'?'general_private':g.field==='components.legal_classification'?'base_salary':true,
    rationale:'Explicit synthetic case assessment; this is not a real human review.',source:'Synthetic test registry and independently specified case fixture'};}),
   hours_acceptance:correction?{request_id:correction.request_id,answer_revision:correction.answer_revision,
    provenance_sha256:canonicalSha256(correction.provenance),value:correction.answer.hours,decision:'accept_identified_declared_regular_hours',
    rationale:`Synthetic assessment of a source conflict declaration only; basis: ${correction.answer.basis}`}:
    hoursDeclared&&hours?.path==='work.regular_hours'&&hours.value&&hoursSource?.source_type==='declared'&&hoursSource.source_reference.kind==='case_request_answer'?{
    request_id:hoursSource.source_reference.request_id,answer_revision:hoursSource.source_reference.answer_revision,
    provenance_sha256:canonicalSha256(hours.provenance),value:hours.value.amount,decision:'accept_identified_declared_regular_hours',
    rationale:'Only the exact identified synthetic customer answer is admitted as declared regular hours.'}:null});
  return {payload:june2026CaseAssessmentSchema.parse(signed.payload),envelope:signed.envelope};
 };
 const input=(packet:June2026AssessmentPacket,facts:EmploymentSnapshot,hoursConflictDeclaration?:HoursConflictDeclaration):June2026RegularAuthorityInput=>({mode:'synthetic_test',evaluatedAt:now,registry,trust,legal,assessment:assessment(packet,facts,hoursConflictDeclaration)});
 return {journal,registry,legal,trust,assessment,input,now,expires};
}
