import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import {aiReleaseAssessmentSchema,aiReleaseAssessmentInputSchema,aiReleaseCurrentContextSchema,
 aiReleasePolicySchema,aiReleaseRegistrySchema,aiReleaseSourceReceiptSchema,aiReleaseInterpretationReceiptSchema,aiReleaseTestReceiptSchema,
 type AiReleaseAssessmentInput,type AiReleaseCurrentContext,type AiReleaseSourcePin,
 ownerEngineeringPolicySchema,ownerEngineeringCurrentContextSchema,ownerEngineeringAssessmentInputSchema,
 type OwnerEngineeringAssessmentInput,type OwnerEngineeringCurrentContext} from '../ai-release/contracts.ts';
import {isPinnedEntitlementLegalDocument} from '../entitlement-review/legal-documents.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import {prepareAiReleaseRuntime,type AiReleaseRuntimePreparation} from './generator-manifest.ts';
import type {AiReleaseTrustedGeneratorPin} from './contracts.ts';

export type AutomaticAiReleaseConfiguration=Pick<AiReleaseAssessmentInput,'policy'|'registry'|'source_receipts'|'interpretation_receipts'|'test_receipts'>;
export type AutomaticAiReleaseAssessmentInput={
 configuration:AutomaticAiReleaseConfiguration;source:DocumentReviewInput;prepared:AiReleaseRuntimePreparation;
 trusted_generator_pins:readonly AiReleaseTrustedGeneratorPin[];
 current:Omit<AiReleaseCurrentContext,'assessment_sha256'|'expected_generated_rules'>;
 issuance:{issued_at:string;expires_at:string;reviewer_id:string;reviewer_version:string};
};
export type AutomaticOwnerEngineeringAssessmentInput=Omit<AutomaticAiReleaseAssessmentInput,'configuration'|'current'>&{
 configuration:Pick<OwnerEngineeringAssessmentInput,'policy'|'registry'|'source_receipts'|'interpretation_receipts'|'test_receipts'>;
 current:Omit<OwnerEngineeringCurrentContext,'assessment_sha256'|'expected_generated_rules'>;
};
const configurationSchema=z.object({policy:aiReleasePolicySchema,registry:aiReleaseRegistrySchema,
 source_receipts:z.array(aiReleaseSourceReceiptSchema),interpretation_receipts:z.array(aiReleaseInterpretationReceiptSchema),test_receipts:z.array(aiReleaseTestReceiptSchema)}).strict();
// The complete current-context refinements run again in the final input parse;
// source-pin uniqueness is additionally checked before constructing any proof.
const currentSchema=z.object(aiReleaseCurrentContextSchema.shape).omit({assessment_sha256:true,expected_generated_rules:true}).strict();
const engineeringConfigurationSchema=configurationSchema.extend({policy:ownerEngineeringPolicySchema});
const engineeringCurrentSchema=z.object(ownerEngineeringCurrentContextSchema.shape).omit({assessment_sha256:true,expected_generated_rules:true}).strict();
const issuanceSchema=z.object({issued_at:z.iso.datetime({offset:true}),expires_at:z.iso.datetime({offset:true}),
 reviewer_id:z.string().min(1).max(200),reviewer_version:z.string().min(1).max(200)}).strict();
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
function invariant(condition:unknown,code:string):asserts condition{if(!condition)throw Error(code);}
function matches(pin:AiReleaseSourcePin,document:DocumentReviewInput['documents'][number]){
 return pin.case_id===document.case_id&&pin.version_id===document.version_id&&pin.source_sha256===document.file_sha256
  &&(pin.document_id===document.document_id||document.document_id===pin.version_id);
}

/** The caller authenticates configuration/current source-journal and facts
 * snapshot pins. This pure composer derives a manifest witness only; it is
 * neither a new document reading nor an assessment of missing legal facts.
 * The ordinary runtime recomputes the same manifests and independently blocks
 * unavailable operands, decisions and counterfactual-only checks. */
export function composeAutomaticAiReleaseAssessment(input:AutomaticAiReleaseAssessmentInput){
 const result=composeAssessment(input,false);
 return deepFreeze({...result,assessment_input:aiReleaseAssessmentInputSchema.parse(result.assessment_input)});
}
export function composeAutomaticOwnerEngineeringAssessment(input:AutomaticOwnerEngineeringAssessmentInput){
 const result=composeAssessment(input,true);
 return deepFreeze({...result,assessment_input:ownerEngineeringAssessmentInputSchema.parse(result.assessment_input)});
}
function composeAssessment(input:AutomaticAiReleaseAssessmentInput|AutomaticOwnerEngineeringAssessmentInput,engineering:boolean){
 const configuration=engineering?engineeringConfigurationSchema.parse(input.configuration):configurationSchema.parse(input.configuration),
  current=engineering?engineeringCurrentSchema.parse(input.current):currentSchema.parse(input.current),issuance=issuanceSchema.parse(input.issuance);
 const prepared=prepareAiReleaseRuntime({source:input.source,analysis_run_id:input.prepared.analysis_run_id,
  trusted_generator_pins:[...input.trusted_generator_pins]});
 invariant(same(prepared,input.prepared),'AI_AUTOMATIC_PREPARATION_MISMATCH');
 const source=prepared.composed,scope=current.scope,purchase=source.purchased_scope;
 invariant(scope.case_id===source.case_id&&scope.order_id===purchase.order_id&&scope.order_origin===purchase.origin
  &&scope.order_receipt_sha256===purchase.receipt_sha256&&same(scope.period,source.period),'AI_AUTOMATIC_SCOPE_MISMATCH');
 invariant(current.source_pins.every(p=>p.case_id===scope.case_id),'AI_AUTOMATIC_FOREIGN_SOURCE');
 invariant(new Set(current.source_pins.map(p=>canonicalSha256(p))).size===current.source_pins.length,'AI_AUTOMATIC_DUPLICATE_SOURCE');
 for(const document of source.documents){
  if(isPinnedEntitlementLegalDocument(document,source.case_id))continue;
  invariant(current.source_pins.some(pin=>matches(pin,document)),'AI_AUTOMATIC_SOURCE_MISMATCH');
 }
 const {policy,registry}=configuration;
 if(engineering)invariant('owner_scope' in policy&&'owner_scope' in current&&same(policy.owner_scope,current.owner_scope),'OWNER_ENGINEERING_OWNER_SCOPE_MISMATCH');
 invariant(policy.sha256===current.policy_sha256&&registry.policy_sha256===policy.sha256
  &&registry.sha256===current.registry_sha256&&registry.revision===current.registry_revision,'AI_AUTOMATIC_CONFIGURATION_PIN_MISMATCH');
 invariant(policy.namespace===current.namespace&&registry.namespace===current.namespace,'AI_AUTOMATIC_NAMESPACE_MISMATCH');
 invariant(policy.allowed_environments.some(value=>value===current.environment)
  &&(current.namespace!=='isolated_test'||current.is_qa&&['development','test'].includes(current.environment)),'AI_AUTOMATIC_ENVIRONMENT_FORBIDDEN');
 const reviewer=registry.reviewers.find(r=>r.actor_id===issuance.reviewer_id&&r.actor_version===issuance.reviewer_version);
 invariant(reviewer&&reviewer.review_method_version===policy.review_method_version,'AI_AUTOMATIC_REVIEWER_MISMATCH');
 const evaluated=Date.parse(current.evaluated_at),issued=Date.parse(issuance.issued_at),expires=Date.parse(issuance.expires_at);
 invariant(issued<=evaluated&&expires>evaluated&&expires>issued,'AI_AUTOMATIC_ISSUANCE_STALE');
 for(const value of [policy,registry,reviewer]){
  invariant(issued>=Date.parse(value.issued_at)&&evaluated<Date.parse(value.expires_at)
   &&expires<=Date.parse(value.expires_at),'AI_AUTOMATIC_CONFIGURATION_NOT_CURRENT');
 }
 const sourcePins=current.source_pins.filter(pin=>source.documents.some(document=>matches(pin,document)));
 invariant(sourcePins.length<=32,'AI_AUTOMATIC_MANIFEST_SOURCE_LIMIT');
 const missing_requirements:{branch_id:string;kind:'fact'|'decision';dependency_id:string;reason:string}[]=[];
 const manifests=prepared.families.flatMap(family=>{
  const branch=policy.branches.find(b=>b.branch_id===family.branch_id);
  if(!branch||!family.expected)return [];
  invariant('generator' in branch&&same(branch.generator,family.generator),'AI_AUTOMATIC_GENERATOR_POLICY_MISMATCH');
  invariant(!branch.document_reading_fact_keys.includes('generated.case_evidence'),'AI_AUTOMATIC_MANIFEST_NOT_DOCUMENT_READING');
  const body={schema_version:'ai-automatic-case-manifest-proof-v1' as const,branch_id:family.branch_id,
   preparation_sha256:prepared.sha256,source_input_sha256:prepared.source_input_sha256,composed_input_sha256:prepared.composed_input_sha256,
   source_manifest:family.source_manifest,source_manifest_sha256:family.expected.source_evidence_sha256,
   rule_manifest_sha256:family.expected.rule_sha256,parameter_manifest_sha256:family.expected.parameter_set_sha256,
   policy_sha256:policy.sha256,registry_sha256:registry.sha256,scope,source_pins:sourcePins,
   evidence_kind:'derived_manifest_only' as const,document_reading_performed:false as const,legal_case_decision_performed:false as const};
  for(const key of branch.required_fact_keys)if(key!=='generated.case_evidence')missing_requirements.push({branch_id:branch.branch_id,kind:'fact',dependency_id:key,reason:'explicit_case_fact_required'});
  for(const id of branch.required_decision_ids)missing_requirements.push({branch_id:branch.branch_id,kind:'decision',dependency_id:id,reason:'explicit_case_decision_required'});
  if(branch.required_fact_keys.includes('generated.case_evidence')&&(!family.selected||!sourcePins.length))missing_requirements.push({branch_id:branch.branch_id,kind:'fact',dependency_id:'generated.case_evidence',reason:'source_selection_required'});
  return [{family,branch,proof:{...body,sha256:canonicalSha256(body)}}];
 });
 invariant(manifests.length>0,'AI_AUTOMATIC_NO_CONFIGURED_GENERATED_BRANCH');
 const branches=manifests.map(({family,branch,proof})=>({branch_id:branch.branch_id,rule_sha256:family.expected!.rule_sha256,
  parameter_set_sha256:family.expected!.parameter_set_sha256,generated_from:{generator:family.expected!.generator,source_evidence_sha256:family.expected!.source_evidence_sha256},
  facts:branch.required_fact_keys.includes('generated.case_evidence')&&family.selected&&sourcePins.length?[{
   fact_key:'generated.case_evidence',state:'known' as const,origin:'derived' as const,value_sha256:proof.source_manifest_sha256,
   source_pins:sourcePins,reading_receipt_sha256:null,derivation_sha256:proof.sha256}]:[],decisions:[]}));
 const assessmentBody={schema_version:'tivdoc-ai-case-assessment-v1' as const,
  assessment_id:`automatic:${canonicalSha256({preparation:prepared.sha256,configuration:{policy:policy.sha256,registry:registry.sha256},current,issuance})}`,
  policy_sha256:policy.sha256,registry_sha256:registry.sha256,actor_kind:'ai_reviewer' as const,
  reviewer_id:issuance.reviewer_id,reviewer_version:issuance.reviewer_version,scope,issued_at:issuance.issued_at,expires_at:issuance.expires_at,branches};
 const assessment=aiReleaseAssessmentSchema.parse({...assessmentBody,sha256:canonicalSha256(assessmentBody)});
 const assessment_input=(engineering?ownerEngineeringAssessmentInputSchema:aiReleaseAssessmentInputSchema).parse({...configuration,assessment,current:{...current,
  assessment_sha256:assessment.sha256,expected_generated_rules:prepared.expected_generated_rules}});
 const provenanceBody={schema_version:'ai-automatic-assessment-provenance-v1' as const,assessment_sha256:assessment.sha256,
  actor:{kind:'deterministic_application_of_ai_reviewed_rules' as const,reviewer_id:issuance.reviewer_id,reviewer_version:issuance.reviewer_version,
   review_method_version:policy.review_method_version,human_attestation:null},manifests:manifests.map(m=>m.proof),missing_requirements};
 return deepFreeze({assessment_input,provenance:{...provenanceBody,sha256:canonicalSha256(provenanceBody)},missing_requirements});
}
