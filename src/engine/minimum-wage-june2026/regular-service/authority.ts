import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '../../rule-runtime/canonical.ts';
import {legalOperationsSha256} from '../../legal-operations/canonical.ts';
import {AppendOnlyLegalOperationsStore,type ImportArtifactCommand} from '../../legal-operations/state-machine.ts';
import {lifecycleCommandSchema,parameterAttestationSchema,semanticApprovalSchema,signedLifecycleActionSchema,sourceReviewAttestationSchema} from '../../legal-operations/contracts.ts';
import {assertVerifiedHumanBinding,payloadWithoutEmbeddedSignature,type HumanTrustPurpose,type VerifiedHumanDecision} from '../../legal-operations/human-trust.ts';
import {createJune2026MinimumWageCandidate} from '../candidate.ts';
import {JUNE2026_MINIMUM_WAGE_SOURCES,JUNE2026_MINIMUM_WAGE_POLICY_SHA256,JUNE2026_SOURCE_SET_SHA256} from '../sources.ts';
import {JUNE_CASE_ASSESSOR_ROLE,JUNE_REGULAR_AUTHORITY_VERSION,june2026CaseAssessmentSchema,type June2026RegularAuthorityInput} from './contracts.ts';

const issued=new WeakSet<object>();
const equal=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
const primary=JUNE2026_MINIMUM_WAGE_SOURCES.filter(s=>s.role==='primary_binding');
/** Exact existing candidate bytes, not activation. The source review inputs
 * remain visibly unattested; only authenticated decisions can advance them. */
export function june2026RegularArtifactImports(importedAt:string):readonly ImportArtifactCommand[]{
 z.iso.datetime({offset:true}).parse(importedAt);
 const c=createJune2026MinimumWageCandidate(1),bindings=c.parameters[0].bindings;
 const item=(artifact_id:string,artifact_version:string,artifact_kind:ImportArtifactCommand['artifact_kind'],content:unknown,b:ImportArtifactCommand['bindings']):ImportArtifactCommand=>({
  artifact_id,artifact_version,artifact_kind,content,content_sha256:legalOperationsSha256(content),bindings:b,
  imported_at:importedAt,idempotency_key:`june-regular-import:${artifact_id}@${artifact_version}`,
 });
 return deepFreeze([
  ...primary.map(s=>item(s.source_version_id,'1.0.0','source',s,{...bindings,source_bytes_sha256:s.artifact_sha256,
   citations_sha256:legalOperationsSha256({source_version_id:s.source_version_id,locators:s.locators}),interval_sha256:legalOperationsSha256(s.interval)})),
  ...c.parameters.map(p=>item(p.parameter_id,p.parameter_version,'parameter',p,p.bindings)),
  item(c.rule.rule_spec_id,c.rule.rule_spec_version,'rule_package',c.rule,bindings),
 ]);
}

function admit(input:June2026RegularAuthorityInput){
 const evaluatedAt=z.iso.datetime({offset:true}).parse(input.evaluatedAt),now=Date.parse(evaluatedAt);
 const r=z.object({namespace:z.enum(['real','isolated_test']),organization_id:z.string().min(3),organization_version:z.string().min(1),
  policy_version:z.string().min(1),registry_sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict().parse(input.registry);
 if((input.mode==='real')!==(r.namespace==='real'))throw Error('JUNE_REGULAR_NAMESPACE_MISMATCH');
 const candidate=createJune2026MinimumWageCandidate(1);
 if(!equal(input.legal.goldenCases,candidate.goldenCases))throw Error('JUNE_REGULAR_GOLDEN_PIN');
 const store=new AppendOnlyLegalOperationsStore();store.importGoldenCaseSet(input.legal.goldenCases);
 const receipts:VerifiedHumanDecision[]=[],seen=new Map<string,string>();
 const verify=(payload:unknown,envelope:June2026RegularAuthorityInput['assessment']['envelope']|null,purpose:HumanTrustPurpose,role:string,
  actor:string,at:string,signature:string,schema:string)=>{
  if(!envelope)throw Error('JUNE_REGULAR_SIGNED_ENVELOPE_REQUIRED');
  const v=input.trust.verifyForAdmission({envelope,payload:payloadWithoutEmbeddedSignature(payload),purpose,required_reviewer_role:role});
  if(!v.currently_trusted||!v.valid_at_signing_time||v.organization_id!==r.organization_id||v.organization_version!==r.organization_version
   ||v.policy_version!==r.policy_version||v.envelope.payload_schema_version!==schema
   ||Date.parse(v.envelope.issued_at)>now||Date.parse(v.envelope.expires_at)<=now)throw Error('JUNE_REGULAR_TRUST_CONTEXT');
  assertVerifiedHumanBinding(v,{reviewer_id:actor,reviewer_role:role,purpose,occurred_at:at,embedded_signature_sha256:signature});
  const prior=seen.get(v.envelope.envelope_id);
  if(prior&&prior!==v.envelope_sha256)throw Error('JUNE_REGULAR_ENVELOPE_REUSED');
  seen.set(v.envelope.envelope_id,v.envelope_sha256);receipts.push(v);return v;
 };
 const expected=june2026RegularArtifactImports(evaluatedAt);
 if(input.legal.artifacts.length!==expected.length)throw Error('JUNE_REGULAR_DEPENDENCY_SET');
 const keys=new Set<string>(),sourceDecisions:ReturnType<typeof sourceReviewAttestationSchema.parse>[]=[];
 for(const artifact of input.legal.artifacts){
  const imp=artifact.import,key=`${imp.artifact_id}@${imp.artifact_version}`;
  if(keys.has(key))throw Error('JUNE_REGULAR_DUPLICATE_ARTIFACT');keys.add(key);
  const pinned=expected.find(e=>e.artifact_id===imp.artifact_id&&e.artifact_version===imp.artifact_version);
  if(!pinned||imp.artifact_kind!==pinned.artifact_kind||!equal(imp.content,pinned.content)||!equal(imp.bindings,pinned.bindings)
   ||imp.content_sha256!==pinned.content_sha256||Date.parse(imp.imported_at)>now)throw Error('JUNE_REGULAR_ARTIFACT_PIN');
  store.importArtifact(imp);
  let previousTime=Date.parse(imp.imported_at);
  for(const event of artifact.events){
   if(event.kind==='source_review'){
    const p=sourceReviewAttestationSchema.parse(event.payload);
    verify(p,event.envelope,'source_review',p.reviewer_role,p.reviewer_id,p.decided_at,p.signature_sha256,p.schema_version);
    if(p.decision!=='approved')throw Error('JUNE_REGULAR_SOURCE_NOT_APPROVED');
    store.importSourceAttestation(imp.artifact_id,imp.artifact_version,p);sourceDecisions.push(p);
   }else if(event.kind==='parameter_attestation'){
    const p=parameterAttestationSchema.parse(event.payload);
    verify(p,event.envelope,'parameter_attestation',p.reviewer_role,p.reviewer_id,p.attested_at,p.signature_sha256,p.schema_version);
    store.importParameterAttestation(imp.artifact_id,imp.artifact_version,p);
   }else if(event.kind==='semantic_approval'){
    const p=semanticApprovalSchema.parse(event.payload),purpose=p.approval_kind==='rule_semantics'?'rulespec_semantics':'golden_case_outputs';
    verify(p,event.envelope,purpose,p.reviewer_role,p.reviewer_id,p.decided_at,p.signature_sha256,p.schema_version);
    store.importSemanticApproval(imp.artifact_id,imp.artifact_version,p);
   }else{
    const action=signedLifecycleActionSchema.safeParse(event.payload);
    const raw=action.success?{schema_version:'tivdoc-legal-lifecycle-command-v0.6.0',command_id:action.data.action_id,
     idempotency_key:action.data.idempotency_key,artifact_id:action.data.artifact_id,artifact_version:action.data.artifact_version,
     artifact_kind:action.data.artifact_kind,expected_state:action.data.expected_state,target_state:action.data.target_state,
     actor_id:action.data.actor_id,actor_role:action.data.actor_role,occurred_at:action.data.occurred_at,reason:action.data.reason,
     bound_content_sha256:action.data.bound_content_sha256,bindings:action.data.bindings,action_signature_sha256:action.data.signature_sha256}:event.payload;
    const p=lifecycleCommandSchema.parse(raw);
    if(p.artifact_id!==imp.artifact_id||p.artifact_version!==imp.artifact_version||Date.parse(p.occurred_at)<previousTime||Date.parse(p.occurred_at)>now)
     throw Error('JUNE_REGULAR_LIFECYCLE_SCOPE');
    previousTime=Date.parse(p.occurred_at);
    if(['eligible','active','revoked','superseded'].includes(p.target_state)||event.envelope){
     if(!p.action_signature_sha256)throw Error('JUNE_REGULAR_LIFECYCLE_SIGNATURE_REQUIRED');
     verify(event.payload,event.envelope,'lifecycle_action',p.actor_role,p.actor_id,p.occurred_at,p.action_signature_sha256,
      action.success?action.data.schema_version:p.schema_version);
    }else if(!['content_verified','applicability_verified','structurally_valid','awaiting_attestations','approved'].includes(p.target_state)
      ||p.action_signature_sha256!==null)throw Error('JUNE_REGULAR_UNSIGNED_TRANSITION_FORBIDDEN');
    store.transition(p);
   }
  }
  if(store.status(imp.artifact_id,imp.artifact_version).state!=='active')throw Error('JUNE_REGULAR_DEPENDENCY_NOT_ACTIVE');
 }
 // State-machine approval validates separation and hashes. Explicitly validate
 // the actual declared legal scope/interval/authority, rather than translating
 // the existence of five signatures into arbitrary eligible source metadata.
 for(const s of primary){
  const decisions=sourceDecisions.filter(d=>d.source_version_ids.includes(s.source_version_id));
  const scope=decisions.find(d=>d.decision_payload.kind==='sector_population_applicability')?.decision_payload;
  const interval=decisions.find(d=>d.decision_payload.kind==='effective_interval')?.decision_payload;
  const roles=decisions.find(d=>d.decision_payload.kind==='authority_precedence')?.decision_payload;
  const content=decisions.find(d=>d.decision_payload.kind==='content_transcription_accuracy')?.decision_payload;
  if(scope?.kind!=='sector_population_applicability'||!scope.sectors.includes('general_private')||!scope.populations.includes('adult_general')
   ||interval?.kind!=='effective_interval'||!interval.intervals.some(i=>i.from<='2026-06-01'&&(i.to===null||i.to>='2026-06-30'))
   ||roles?.kind!=='authority_precedence'||!roles.source_roles.some(role=>role.source_version_id===s.source_version_id&&role.authority_role==='primary_binding')
   ||content?.kind!=='content_transcription_accuracy'||!s.parsed_sha256||!content.chunk_sha256s.includes(s.parsed_sha256))throw Error('JUNE_REGULAR_SOURCE_SCOPE_NOT_APPROVED');
 }
 const assessment=june2026CaseAssessmentSchema.parse(input.assessment.payload);
 if(assessment.namespace!==r.namespace||assessment.policy_sha256!==JUNE2026_MINIMUM_WAGE_POLICY_SHA256
  ||assessment.rule_sha256!==candidate.rule.content_sha256||assessment.golden_cases_sha256!==candidate.goldenCases.content_sha256
  ||Date.parse(assessment.issued_at)>now||Date.parse(assessment.expires_at)<=now)throw Error('JUNE_REGULAR_ASSESSMENT_PIN_OR_EXPIRY');
 const caseTrust=verify(assessment,input.assessment.envelope,'case_assessment',JUNE_CASE_ASSESSOR_ROLE,
  assessment.reviewer_id,assessment.issued_at,assessment.signature_sha256,assessment.schema_version);
 const legalAvailableFrom=new Date(Math.max(...receipts.filter(v=>v.purpose!=='case_assessment').map(v=>Date.parse(v.envelope.issued_at)))).toISOString().slice(0,10);
 const seed={schema_version:JUNE_REGULAR_AUTHORITY_VERSION,mode:input.mode,registry:r,legal_available_from:legalAvailableFrom,
  source_set_sha256:JUNE2026_SOURCE_SET_SHA256,rule_sha256:candidate.rule.content_sha256,assessment,
  assessment_envelope_sha256:caseTrust.envelope_sha256,artifacts:expected.map(a=>store.status(a.artifact_id,a.artifact_version)),
  verified_envelopes:receipts.map(v=>({envelope_sha256:v.envelope_sha256,purpose:v.purpose,reviewer_id:v.reviewer_id,
   expires_at:v.envelope.expires_at})),real_legal_authority:r.namespace==='real',human_report_approval:false as const};
 // Current-time admission is rechecked on every load, but is not a new legal
 // dependency version. A later retry of the same valid journal keeps its key.
 const result=deepFreeze({...seed,evaluated_at:evaluatedAt,assessment_envelope:caseTrust.envelope,authority_sha256:canonicalSha256(seed)});issued.add(result);return result;
}
export type June2026RegularAuthority=ReturnType<typeof admit>;
export function createJune2026RegularAuthority(input:June2026RegularAuthorityInput){
 try{return {state:'ready' as const,authority:admit(input)};}
 catch(error){return {state:'blocked' as const,blockers:[error instanceof Error&&/^[A-Z0-9_:,.-]+$/u.test(error.message)?error.message:'JUNE_REGULAR_AUTHORITY_INVALID']};}
}
export function assertJune2026RegularAuthority(authority:June2026RegularAuthority){
 if(!issued.has(authority))throw Error('JUNE_REGULAR_AUTHENTICATED_AUTHORITY_REQUIRED');
}
