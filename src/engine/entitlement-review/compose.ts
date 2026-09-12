import {obligationsProductReview} from './obligations-product.ts';
import {simpleEntitlementProduct} from './simple-product.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import {parseReviewCompletionInput,resolveReviewCompletion,reviewDeclaredAnswerValue} from '../document-review/completions.ts';
import {ENTITLEMENT_REVIEW_POLICY,entitlementCompositionSchema,type EntitlementEvidence} from './contracts.ts';
import {assertEntitlementSourcePacket} from './source-admission.ts';
import {entitlementLegalDocuments} from './legal-documents.ts';
import {obligationsEntitlementInputSchema} from './obligations/contracts.ts';
import {OBLIGATIONS_CASE_POLICY} from './obligations/source-policy.ts';
import {travelEntitlementInputSchema} from './travel/contracts.ts';
import {materializeQuestionnaireAgeRanges} from './age-range-materialization.ts';
import {pensionProductReview} from './pension-product.ts';
import {workingTimeProductReview} from './working-time-product.ts';
import type {EntitlementBranchReview,EntitlementAnswerTarget} from './branch-contract.ts';
import {materializeTypedEntitlementFacts} from './typed-product-facts.ts';
import {projectSharedPersonalFactNeeds,materializeSharedPersonalFacts,sharedPersonalFactManifest} from './shared-product-facts.ts';

function resolve(input:DocumentReviewInput,e:EntitlementEvidence,original=e):EntitlementBranchReview{
 const parts=[...(e.pension===undefined?[]:[pensionProductReview(input,e.pension)]),...(e.working_time===undefined?[]:[workingTimeProductReview(input,e.working_time)]),...(['travel','minimum_wage','vacation','convalescence'] as const).flatMap(topic=>e[topic]===undefined?[]:[simpleEntitlementProduct(input,topic,e[topic])]),...(e.obligations===undefined?[]:[obligationsProductReview(input,e.obligations)])];
 return projectSharedPersonalFactNeeds(input,original,{checks:parts.flatMap(p=>p.checks),gaps:parts.flatMap(p=>p.gaps),needs:parts.flatMap(p=>p.needs),answer_targets:parts.flatMap(p=>p.answer_targets),selections:parts.flatMap(p=>p.selections),nonmonetary_outcomes:parts.flatMap(p=>p.nonmonetary_outcomes??[])});
}
function factAt(e:EntitlementEvidence,target:EntitlementAnswerTarget):Record<string,unknown>{
 let current:unknown=target.branch==='working_time'?(e.working_time as unknown[])[target.index!]:e[target.branch];
 for(const key of target.input_path.split('.')){
  if(['__proto__','prototype','constructor'].includes(key)||!current||typeof current!=='object'||!Object.hasOwn(current,key))throw Error('ENTITLEMENT_FACT_TARGET');
  current=(current as Record<string,unknown>)[key];
 }
 if(!current||typeof current!=='object'||!('state'in current)||!('value'in current)||!('source'in current))throw Error('ENTITLEMENT_FACT_TARGET');
 return current as Record<string,unknown>;
}
function answeredEvidence(input:DocumentReviewInput,original:EntitlementEvidence,targets:EntitlementAnswerTarget[]):EntitlementEvidence{
 const packet=structuredClone(original),completion=parseReviewCompletionInput(input.completion_input);
 for(const target of targets){
  const histories=input.answer_history.filter(h=>h.request.target.fact_key===target.fact_key).sort((a,b)=>b.receipt.answer_revision-a.receipt.answer_revision);
  if(!histories.length)continue;
  const h=histories[0],r=h.receipt;
  const admitted=resolveReviewCompletion({request:h.request,current:completion,actor:{case_id:input.case_id,identity_id:r.identity_id},answer:{request_id:r.request_id,revision:r.answer_revision,answered_at:r.answered_at,state:r.state,value:r.value}});
  if(admitted.state==='stale'||admitted.requires_source_verification||admitted.receipt.answer_sha256!==r.answer_sha256)continue;
  const decoded=r.state==='provided'?reviewDeclaredAnswerValue(h.request.target,r.value):null;
  const fact=factAt(packet,target),known=r.state==='provided'&&!admitted.blocked&&decoded!==null;
  const personalPension=['pension','travel','vacation'].includes(target.branch)&&target.input_path.startsWith('product_facts.');
  fact.state=known?(['working_time','minimum_wage','convalescence'].includes(target.branch)||personalPension?'declared':'known'):r.state==='conflicted'||admitted.state==='provided'&&admitted.blocked?'conflict':'unknown';
  fact.value=known?(target.value_kind==='date_or_ongoing'&&decoded==='העבודה נמשכת'?'ongoing':decoded):null;
  fact.source={document_id:r.request_id,version_id:`${r.request_id}:${r.answer_revision}`,file_sha256:r.answer_sha256,page:1,locator:target.fact_key,label:h.request.target.question,reading:'customer_declaration',reading_receipt_sha256:r.answer_sha256};
  if(!['working_time','minimum_wage','convalescence'].includes(target.branch)&&!personalPension)fact.basis='customer_declaration';
  const branch=(target.branch==='working_time'?(packet.working_time as unknown[])[target.index!]:packet[target.branch]) as {source_manifest:{document_id:string;version_id:string;file_sha256:string;page_count:number;kind:string;case_id:string|null}[]};
  branch.source_manifest=branch.source_manifest.filter(s=>s.document_id!==r.request_id);
  branch.source_manifest.push({document_id:r.request_id,version_id:`${r.request_id}:${r.answer_revision}`,file_sha256:r.answer_sha256,page_count:1,kind:'customer_answer',case_id:input.case_id});
 }
 return packet;
}

/** Rebuild only catalog-owned checks from immutable source facts and the
 * authenticated answer journal. It never overwrites that source packet. */
export function composeEntitlementReview(candidate:DocumentReviewInput):DocumentReviewInput{
 const original=documentReviewInputSchema.parse(candidate);if(!original.entitlement_evidence)return original;
 const prior=original.entitlement_composition,priorChecks=new Set(prior?.selections.flatMap(s=>s.generated_check_ids)??[]),priorGaps=new Set(prior?.selections.flatMap(s=>s.generated_gap_ids)??[]),priorFacts=new Set(prior?.generated_fact_keys??[]);
 const completion=parseReviewCompletionInput(original.completion_input);
 const base=documentReviewInputSchema.parse({...original,entitlement_composition:undefined,
  checks:original.checks.filter(c=>!priorChecks.has(c.check_id)),coverage_gaps:original.coverage_gaps.filter(g=>!priorGaps.has(g.check_id)),
  answer_bindings:original.answer_bindings.filter(b=>!priorChecks.has(b.check_id)),
  completion_input:{...completion,needs:completion.needs.filter(n=>!priorFacts.has(n.fact_key))}});
 const obligationPolicy=base.entitlement_evidence?.obligations?obligationsEntitlementInputSchema.parse(base.entitlement_evidence.obligations).case_policy:undefined;
 const topics=['working_time','pension','travel','minimum_wage','vacation','convalescence'].filter(t=>base.entitlement_evidence?.[t as keyof EntitlementEvidence]!==undefined);
 if(obligationPolicy===OBLIGATIONS_CASE_POLICY)topics.push(...base.purchased_scope.topics.filter(t=>t==='contract'||t==='bonuses'));
 const travelPolicy=base.entitlement_evidence?.travel?travelEntitlementInputSchema.parse(base.entitlement_evidence.travel).calculation_policy:undefined;
 const laws=entitlementLegalDocuments(base.case_id,topics,{...(obligationPolicy===OBLIGATIONS_CASE_POLICY?{obligations_policy:obligationPolicy}:{}),...(travelPolicy?{travel_policy:travelPolicy}:{})}),packet=assertEntitlementSourcePacket(base,base.entitlement_evidence,laws);
 const baseline=resolve(base,materializeQuestionnaireAgeRanges(packet,packet,base));
 const documents=[...base.documents];for(const law of laws){const at=documents.findIndex(d=>d.document_id===law.document_id);if(at<0)documents.push(law);else documents[at]=law;}
 let withNeeds=documentReviewInputSchema.parse({...base,documents,completion_input:{...parseReviewCompletionInput(base.completion_input),needs:[...parseReviewCompletionInput(base.completion_input).needs,...baseline.needs]}});
 let effective=materializeSharedPersonalFacts(withNeeds,packet,answeredEvidence(withNeeds,packet,baseline.answer_targets));
 // Opt-in fact inventories have two stages: an identified count creates only
 // the named empty slots, then their own dated/FTE receipts fill those slots.
 // Rebuild from the original packet every run; old count/cell answers cannot
 // survive a count correction through a previously materialized result.
 const targetKey=(t:EntitlementAnswerTarget)=>canonicalSha256({fact_key:t.fact_key,branch:t.branch,index:t.index,input_path:t.input_path});
 const targets=new Map(baseline.answer_targets.map(t=>[targetKey(t),t]));
 for(let step=0;step<4;step++){
  const staged=materializeTypedEntitlementFacts(effective,packet,withNeeds);
  if(canonicalSha256(staged)===canonicalSha256(effective)&&step===0)break;
  const expanded=resolve(base,staged,packet),oldNeeds=parseReviewCompletionInput(withNeeds.completion_input).needs;
  const needs=[...oldNeeds];for(const n of expanded.needs)if(!needs.some(old=>old.fact_key===n.fact_key))needs.push(n);
  for(const target of expanded.answer_targets)targets.set(targetKey(target),target);
  withNeeds=documentReviewInputSchema.parse({...withNeeds,completion_input:{...parseReviewCompletionInput(withNeeds.completion_input),needs}});
  const next=materializeTypedEntitlementFacts(materializeSharedPersonalFacts(withNeeds,packet,answeredEvidence(withNeeds,staged,[...targets.values()])),packet,withNeeds);
  if(canonicalSha256(next)===canonicalSha256(effective)){effective=next;break;}effective=next;
  if(step===3)throw Error('ENTITLEMENT_FACT_MATERIALIZATION_DID_NOT_SETTLE');
 }
 assertEntitlementSourcePacket(withNeeds,effective,laws);
 const current=resolve(withNeeds,effective,packet);
 const bindings=[...base.answer_bindings];
 const checks=current.checks.map(check=>{
  const calc=documentReviewCalculationInputSchema.parse(check.calculation),op=calc.operation;
  const citations=[...calc.operands.map(o=>o.source),...(op.kind==='candidate_rule'?op.decisions.flatMap(d=>d.sources):[])];
  const source_manifest=calc.source_manifest.filter(s=>s.kind!=='customer_answer'||citations.some(c=>c.document_id===s.document_id&&c.version_id===s.version_id));
  for(const operand of calc.operands)if(operand.source.reading==='customer_declaration'){
   const h=withNeeds.answer_history.find(h=>h.receipt.answer_sha256===operand.source.reading_receipt_sha256);
   if(!h||!h.request.dependent_check_ids.includes(check.check_id))throw Error('ENTITLEMENT_ANSWER_CHECK_SCOPE');
   bindings.push({fact_key:h.request.target.fact_key,check_id:check.check_id,operand_id:operand.id});
  }
  return {...check,calculation:{...calc,source_manifest,input_basis_policy:'all-consumed-citations-v2'}};
 });
 if(checks.some(c=>base.checks.some(old=>old.check_id===c.check_id)))throw Error('ENTITLEMENT_CHECK_COLLISION');
 const externalFacts=new Set(parseReviewCompletionInput(base.completion_input).needs.map(n=>n.fact_key));
 const currentKeys=new Set(current.needs.map(n=>n.fact_key)),addressedKeys=new Set(original.answer_history.map(h=>h.request.target.fact_key));
 const needs=parseReviewCompletionInput(withNeeds.completion_input).needs.filter(n=>!externalFacts.has(n.fact_key)
  &&(!n.fact_key.startsWith('entitlement.obligation-fact.')||currentKeys.has(n.fact_key)||addressedKeys.has(n.fact_key)));
 // A newly revealed dependency creates new work; original targets remain
 // addressable for answer replay and correction after the fact is known.
 for(const need of current.needs)if(!needs.some(n=>n.fact_key===need.fact_key))needs.push(need);
 const gaps=[...current.gaps];
 for(const need of needs)for(const id of need.dependent_check_ids)if(!checks.some(c=>c.check_id===id)&&!gaps.some(g=>g.check_id===id)&&!current.nonmonetary_outcomes?.some(o=>o.check_ids.includes(id))){
  const priorGap=baseline.gaps.find(g=>g.check_id===id);if(priorGap)gaps.push(priorGap);else throw Error('ENTITLEMENT_UNRESOLVED_DEPENDENCY');
 }
 const selections=current.selections.map(s=>({...s,generated_check_ids:checks.filter(c=>c.topic===s.topic).map(c=>c.check_id),generated_gap_ids:gaps.filter(g=>g.topic===s.topic).map(g=>g.check_id)}));
 const shared=sharedPersonalFactManifest(withNeeds,packet);
 const body={policy_version:ENTITLEMENT_REVIEW_POLICY,source_evidence_sha256:canonicalSha256(packet),evidence:effective,selections,generated_fact_keys:needs.map(n=>n.fact_key),...(current.nonmonetary_outcomes?.length?{nonmonetary_outcomes:current.nonmonetary_outcomes}:{}),...(shared?{shared_personal_facts:shared}:{})};
 return documentReviewInputSchema.parse({...withNeeds,checks:[...base.checks,...checks],coverage_gaps:[...base.coverage_gaps,...gaps],answer_bindings:bindings,
  completion_input:{...parseReviewCompletionInput(base.completion_input),needs:[...parseReviewCompletionInput(base.completion_input).needs,...needs]},
  entitlement_composition:entitlementCompositionSchema.parse({...body,composition_sha256:canonicalSha256(body)})});
}

export function assertEntitlementComposition(input:DocumentReviewInput):void{
 if(!input.entitlement_evidence&&!input.entitlement_composition)return;
 if(!input.entitlement_composition||canonicalSha256(composeEntitlementReview(input))!==canonicalSha256(input))throw Error('ENTITLEMENT_COMPOSITION_REPLAY');
}
