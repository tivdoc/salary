import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {AI_RELEASE_DECISION_RECIPES} from '../../ai-release-decisions/catalog.ts';
import {obligationsEntitlementInputSchema,type ObligationsEntitlementInput} from './contracts.ts';
import {obligationCaseBindingSchema} from './case-bindings.ts';
import {evaluateObligationCaseRecipe,obligationCaseConsumed,obligationCaseDecisionSources} from './product-decisions.ts';
import {OBLIGATIONS_CASE_POLICY} from './source-policy.ts';
export {obligationCaseBinding} from './case-bindings.ts';

const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function owned(explanation:string){let value:unknown;try{value=JSON.parse(explanation);}catch{return null;}
 return object(value)&&value.schema_version==='ai-release-method-basis-v1'?value:null;}
/** Raw source facts/history never change. Only the exact decisions produced
 * by our receipt are replayed and invalidated when one consumed input changes.
 * External/unknown decisions remain untouched; no stale accepted value leaks
 * into a new interpretation or a different clause. */
export function replayObligationProductFacts(candidate:ObligationsEntitlementInput,originalCandidate:ObligationsEntitlementInput,review:DocumentReviewInput):ObligationsEntitlementInput{
 const input=obligationsEntitlementInputSchema.parse(candidate),original=obligationsEntitlementInputSchema.parse(originalCandidate);
 if(original.case_policy!==OBLIGATIONS_CASE_POLICY)return input;
 if(input.case_policy!==original.case_policy||input.case_id!==original.case_id||canonicalSha256(input.period)!==canonicalSha256(original.period))throw Error('OBLIGATION_REPLAY_SCOPE');
 for(const o of input.obligations){
  const raw=original.obligations.filter(v=>v.obligation_id===o.obligation_id);if(raw.length!==1)throw Error('OBLIGATION_REPLAY_ID');
  if(canonicalSha256(o.case_recipe_bindings??[])!==canonicalSha256(raw[0].case_recipe_bindings??[]))throw Error('OBLIGATION_REPLAY_BINDINGS_CHANGED');
  const seen=new Set<string>();
  for(const value of raw[0].case_recipe_bindings??[]){
   const binding=obligationCaseBindingSchema.parse(value),m=binding.method,recipe=AI_RELEASE_DECISION_RECIPES.find(r=>r.recipe_id===m.recipe_id);
   if(binding.obligation_id!==o.obligation_id||seen.has(m.recipe_id))throw Error('OBLIGATION_REPLAY_BINDING_ID');seen.add(m.recipe_id);
   if(!recipe||recipe.branch!=='obligations'||recipe.recipe_sha256!==m.recipe_sha256||recipe.recipe_version!==m.recipe_version||recipe.source_policy_sha256!==m.source_policy_sha256
    ||recipe.legal_sources.some(s=>!m.source_receipts.some(r=>r.source_version_id===s.version_id&&r.artifact_sha256===s.file_sha256))
    ||Date.parse(m.issued_at)>Date.parse(binding.evaluated_at)||Date.parse(m.expires_at)<=Date.parse(binding.evaluated_at)||Date.parse(m.issued_at)>=Date.parse(m.expires_at))throw Error('OBLIGATION_REPLAY_METHOD');
   const rawDecision=raw[0].assessments.find(d=>d.decision_id===recipe.decision_id),rawBasis=rawDecision?owned(rawDecision.explanation):null;
   if(!rawDecision||rawDecision.state!=='accepted'||rawDecision.basis!=='ai_source_assessment'||!rawBasis
    ||rawBasis.recipe_id!==recipe.recipe_id||rawBasis.recipe_sha256!==recipe.recipe_sha256||rawBasis.interpretation_receipt_sha256!==m.interpretation_receipt_sha256)continue;
   const decision=o.assessments.find(d=>d.decision_id===recipe.decision_id),basis=decision?owned(decision.explanation):null;
   if(!decision||!basis||basis.recipe_id!==rawBasis.recipe_id||basis.recipe_sha256!==rawBasis.recipe_sha256||basis.interpretation_receipt_sha256!==rawBasis.interpretation_receipt_sha256)throw Error('OBLIGATION_REPLAY_DECISION_CHANGED');
   if(decision.state!=='accepted')continue;
   const ready=evaluateObligationCaseRecipe(recipe.decision_id,input,o.obligation_id,review,input.case_policy);
   const consumed=obligationCaseConsumed(input,o.obligation_id,ready.consumed_paths,review);
   if(!ready.allowed||rawBasis.consumed_sha256!==canonicalSha256(consumed)||basis.consumed_sha256!==rawBasis.consumed_sha256){
    decision.state='stale';decision.explanation=JSON.stringify({...basis,stale_reason:ready.allowed?'consumed_source_facts_changed':ready.reason});
    // Preserve immutable law/clause pins. Old factual answer citations do not
    // survive a correction into the effective source manifest.
    decision.sources=rawDecision.sources;continue;
   }
   const sources=[...rawDecision.sources,...obligationCaseDecisionSources(input,o.obligation_id,ready.consumed_paths,review)];
   decision.sources=[...new Map(sources.map(s=>[canonicalSha256(s),s])).values()];
   if(decision.sources.length>16)throw Error('OBLIGATION_REPLAY_SOURCE_LIMIT');
  }
 }
 return input;
}
export function enableObligationCasePolicy(input:ObligationsEntitlementInput):ObligationsEntitlementInput{
 return {...input,case_policy:OBLIGATIONS_CASE_POLICY};
}
