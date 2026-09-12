import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import {composeEntitlementReview} from '../entitlement-review/compose.ts';
import {runDocumentReview} from '../document-review/service.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewCalculationInput} from '../document-review/calculations.ts';
import {AI_RELEASE_RUNTIME_FAMILIES,aiReleaseRuntimePreparationInputSchema,assertTrustedRuntimeGeneratorPins,
 type AiReleaseRuntimePreparationInput} from './contracts.ts';

const ordered=<T extends {check_id:string}>(items:T[])=>items.sort((a,b)=>a.check_id.localeCompare(b.check_id,'en'));

function bindings(calculation:DocumentReviewCalculationInput,kind:'facts'|'parameters'){
 const op=calculation.operation;if(op.kind!=='candidate_rule')throw Error('AI_RUNTIME_CANDIDATE_REQUIRED');
 return [...(kind==='facts'?op.fact_bindings:op.parameter_bindings)].sort((a,b)=>a.ref_id.localeCompare(b.ref_id,'en')).map(b=>{
  const operand=calculation.operands.find(o=>o.id===b.operand_id);if(!operand)throw Error('AI_RUNTIME_BINDING_OPERAND_MISSING');
  return {ref_id:b.ref_id,operand_id:b.operand_id,operand};
 });
}

/** Built-in composer and executor only. The resulting manifests can be used by
 * the server to issue an assessment, but runAiReleaseRuntime derives them again
 * before admission. IDs, actual fact values/sources/states and decisions are
 * hashed, not only the RuleSpec graph. */
export function prepareAiReleaseRuntime(candidate:AiReleaseRuntimePreparationInput){
 const input=aiReleaseRuntimePreparationInputSchema.parse(candidate);assertTrustedRuntimeGeneratorPins(input.trusted_generator_pins);
 const composed=composeEntitlementReview(input.source),review=runDocumentReview(composed,input.analysis_run_id);
 const selections=composed.entitlement_composition?.selections??[];
 const families=AI_RELEASE_RUNTIME_FAMILIES.filter(f=>composed.purchased_scope.topics.includes(f.topic)).map(family=>{
  const selection=selections.find(s=>s.topic===family.topic),pin=input.trusted_generator_pins.find(p=>p.family_id===family.family_id);
  const ids=new Set(selection?.generated_check_ids??[]);
  const checks=review.checks.filter(c=>ids.has(c.check_id));
  if(checks.length!==ids.size||checks.some(c=>c.topic!==family.topic))throw Error('AI_RUNTIME_GENERATED_CHECK_OWNERSHIP');
  const candidates=checks.filter(c=>c.calculation.input.operation.kind==='candidate_rule');
  const operations=ordered(candidates.map(c=>({check_id:c.check_id,calculation:documentReviewCalculationInputSchema.parse(c.calculation.input)})));
  const factManifest=operations.map(({check_id,calculation})=>({check_id,bindings:bindings(calculation,'facts')}));
  const decisionManifest=operations.map(({check_id,calculation})=>{
   const op=calculation.operation;if(op.kind!=='candidate_rule')throw Error('AI_RUNTIME_CANDIDATE_REQUIRED');
   return {check_id,required_decision_ids:[...op.required_decision_ids].sort(),decisions:[...op.decisions].sort((a,b)=>a.decision_id.localeCompare(b.decision_id,'en')),
    conditional_assumptions:op.conditional_assumptions??[],execution_preconditions:op.execution_preconditions??[]};
  });
  const outcomes=(composed.entitlement_composition?.nonmonetary_outcomes??[]).filter(o=>o.topic===family.topic)
   .sort((a,b)=>a.obligation_id.localeCompare(b.obligation_id,'en'));
  const exactRules=operations.map(({check_id,calculation},index)=>{
   const op=calculation.operation;if(op.kind!=='candidate_rule')throw Error('AI_RUNTIME_CANDIDATE_REQUIRED');
   return {check_id,topic:family.topic,period:calculation.period,rule_id:op.rule.rule_spec_id,rule_version:op.rule.rule_spec_version,
    rule_sha256:op.rule.content_sha256,operation_sha256:canonicalSha256(op),fact_bindings_sha256:canonicalSha256(op.fact_bindings),
    case_facts_sha256:canonicalSha256(factManifest[index]),applicability_decisions_sha256:canonicalSha256(decisionManifest[index])};
  });
  const rule_manifest={schema_version:'ai-release-generated-rules-v1' as const,family_id:family.family_id,checks:exactRules,nonmonetary_outcomes:outcomes};
  const parameter_manifest={schema_version:'ai-release-generated-parameters-v1' as const,family_id:family.family_id,
   checks:operations.map(({check_id,calculation})=>({check_id,bindings:bindings(calculation,'parameters')}))};
  const source_manifest={schema_version:'ai-release-generated-case-evidence-v1' as const,family_id:family.family_id,
   selection_evidence_sha256:selection?.evidence_sha256??null,case_facts:factManifest,applicability_decisions:decisionManifest,nonmonetary_outcomes:outcomes};
  const expected=pin?{branch_id:family.branch_id,generator:pin.generator,rule_sha256:canonicalSha256(rule_manifest),
   parameter_set_sha256:canonicalSha256(parameter_manifest),source_evidence_sha256:canonicalSha256(source_manifest)}:null;
  return {...family,selected:selection!==undefined,generator:pin?.generator??null,
   source_policy_sha256:selection?.source_policy_sha256??null,selection_status:selection?.status??null,
   candidate_check_ids:candidates.map(c=>c.check_id),supplemental_check_ids:checks.filter(c=>c.calculation.input.operation.kind!=='candidate_rule').map(c=>c.check_id),
   coverage_gaps:composed.coverage_gaps.filter(g=>g.topic===family.topic),nonmonetary_outcomes:outcomes,
   rule_manifest,parameter_manifest,source_manifest,expected};
 });
 const seed={schema_version:'ai-release-runtime-preparation-v1' as const,analysis_run_id:input.analysis_run_id,
  source_input_sha256:canonicalSha256(input.source),composed_input_sha256:canonicalSha256(composed),composed,review,families,
  expected_generated_rules:families.flatMap(f=>f.expected?[f.expected]:[])};
 return deepFreeze({...seed,sha256:canonicalSha256(seed)});
}
export type AiReleaseRuntimePreparation=ReturnType<typeof prepareAiReleaseRuntime>;
