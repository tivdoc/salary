import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewSource} from '../../document-review/calculations.ts';
import {parseReviewCompletionInput,resolveReviewCompletion,reviewDeclaredAnswerValue} from '../../document-review/completions.ts';
import {obligationsEntitlementInputSchema,type ObligationsEntitlementInput,type ExplicitObligation} from './contracts.ts';
import {obligationProductFactKey,type ObligationProductFactKey} from './product-facts.ts';
import {produceObligationSourceEvidence} from './product-source-evidence.ts';
import {OBLIGATIONS_CASE_POLICY,OBLIGATIONS_SOURCE_REVIEW} from './source-policy.ts';

type Readiness={allowed:boolean;reason:string;consumed_paths:string[]};
const ids=['obligation.clause_interpretation','obligation.agreement_binding','obligation.payment_scope','obligation.complete_conditions','obligation.rounding'] as const;
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const sourceSchema=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
function sourcesIn(value:unknown):DocumentReviewSource[]{
 const results:DocumentReviewSource[]=[];
 const visit=(v:unknown)=>{if(!object(v)&&!Array.isArray(v))return;const source=sourceSchema.safeParse(v);if(source.success){results.push(source.data);return;}for(const child of Object.values(v))visit(child);};
 visit(value);return [...new Map(results.map(s=>[canonicalSha256(s),s])).values()];
}
function pathValue(input:ObligationsEntitlementInput,o:ExplicitObligation,path:string,review:DocumentReviewInput):unknown{
 if(path==='period')return input.period;
 if(path==='condition_inventory')return o.conditions.map(c=>({condition_id:c.condition_id,description:c.description}));
 if(path.startsWith('source_witness.'))return produceObligationSourceEvidence(input,o.obligation_id,review).entries.filter(e=>e.kind===path.slice('source_witness.'.length));
 let value:unknown=o;for(const key of path.split('.')){if(!object(value)||!Object.hasOwn(value,key))return null;value=value[key];}return value;
}
export function obligationCaseConsumed(candidate:ObligationsEntitlementInput,obligationId:string,paths:readonly string[],review:DocumentReviewInput){
 const input=obligationsEntitlementInputSchema.parse(candidate),index=input.obligations.findIndex(o=>o.obligation_id===obligationId);
 if(index<0||input.obligations.filter(o=>o.obligation_id===obligationId).length!==1)throw Error('OBLIGATION_CONSUMED_ID');
 return paths.map(path=>{const value=pathValue(input,input.obligations[index],path,review);return {
  path:path==='period'?'entitlement_evidence.obligations.period':`entitlement_evidence.obligations.obligations.${index}.${path}`,state:object(value)&&'state'in value?String(value.state):value===null?'missing':'structural',
  value_sha256:canonicalSha256(value),source_sha256s:sourcesIn(value).map(s=>canonicalSha256(s)),
 };});
}
/** The existing ordinary factual form is replayed, not merely cited. A copied
 * boolean or source-labelled JSON cannot certify use, agreement date or absence
 * of a reported dispute. Identified legal-source readings are not case facts. */
function currentContext(input:ObligationsEntitlementInput,o:ExplicitObligation,key:ObligationProductFactKey,review:DocumentReviewInput){
 const f=o.product_facts?.[key];if(!f||f.state!=='known'||f.value===null||!f.source)return false;
 if(f.basis!=='customer_declaration'||f.source.reading!=='customer_declaration')return false;
 const h=review.answer_history.find(h=>h.receipt.answer_sha256===f.source!.reading_receipt_sha256);
 if(!h||h.receipt.case_id!==input.case_id||h.request.target.fact_key!==obligationProductFactKey(input,o,key)||h.request.target.required_evidence_kind!=='customer_declaration')return false;
 const r=h.receipt;
 if(r.state!=='provided'||review.answer_history.some(n=>n.receipt.request_id===r.request_id&&n.receipt.answer_revision>r.answer_revision))return false;
 const resolved=resolveReviewCompletion({request:h.request,current:parseReviewCompletionInput(review.completion_input),actor:{case_id:input.case_id,identity_id:r.identity_id},answer:{request_id:r.request_id,revision:r.answer_revision,answered_at:r.answered_at,state:r.state,value:r.value}});
 return resolved.state!=='stale'&&!resolved.blocked&&!resolved.requires_source_verification&&resolved.receipt.answer_sha256===r.answer_sha256
  &&canonicalSha256(f.value)===canonicalSha256(reviewDeclaredAnswerValue(h.request.target,r.value))
  &&f.source.document_id===r.request_id&&f.source.version_id===`${r.request_id}:${r.answer_revision}`&&f.source.file_sha256===r.answer_sha256;
}
function regime(date:string){
 const p=OBLIGATIONS_SOURCE_REVIEW.interpretation_transition;
 return date>=p.prior_formation_from&&date<=p.prior_formation_through?'prior_25_text_and_circumstances'
  :date>=p.new_formation_from?'amendment3_employment_text_and_circumstances':null;
}
function exactAgora(o:ExplicitObligation){
 const m=o.promise.kind==='fixed'?o.promise.amount:o.promise.rate;
 if(!m||m.state!=='observed'||m.printed_value===null||!/^\d+(?:\.\d{1,2})?$/u.test(m.printed_value))return false;
 if(o.promise.kind==='fixed')return true;
 const q=o.promise.quantity;if(!q||q.state!=='observed'||q.printed_value===null||!/^\d+(?:\.\d{1,6})?$/u.test(q.printed_value))return false;
 const [a,b='']=m.printed_value.split('.'),minor=BigInt(a)*BigInt(100)+BigInt(b.padEnd(2,'0'));
 const [whole,fraction='']=q.printed_value.split('.'),denominator=BigInt(10)**BigInt(fraction.length),numerator=BigInt(whole)*denominator+BigInt(fraction||'0');
 return minor*numerator%denominator===BigInt(0);
}

/** Every recipe is case/source evidence, not an approval switch. The policy
 * argument is supplied only by the opted-in packet and pinned method factory.
 * All other agreement regimes and non-exact rounding remain explicit gaps. */
export function evaluateObligationCaseRecipe(decisionId:string,candidate:ObligationsEntitlementInput,obligationId:string,review:DocumentReviewInput,policyVersion?:string):Readiness{
 const input=obligationsEntitlementInputSchema.parse(candidate),o=input.obligations.find(o=>o.obligation_id===obligationId);
 const paths=['period','clause','payment_period','promise'];
 const result=(allowed:boolean,reason:string):Readiness=>({allowed,reason,consumed_paths:[...new Set(paths)]});
 if(policyVersion!==OBLIGATIONS_CASE_POLICY)return result(false,'explicit_obligation_case_policy_required');
 if(!o||!ids.some(id=>id===decisionId))return result(false,'obligation_case_recipe_not_supported');
 if(!input.purchased_topics.includes(o.topic)||!review.purchased_scope.topics.includes(o.topic))return result(false,'obligation_topic_not_purchased');
 if(input.period.from<OBLIGATIONS_SOURCE_REVIEW.supported_work_period.from||input.period.to>OBLIGATIONS_SOURCE_REVIEW.supported_work_period.to)return result(false,'obligation_period_not_supported');
 const produced=produceObligationSourceEvidence(input,obligationId,review);
 const needs=(kind:(typeof produced.entries)[number]['kind'])=>{paths.push('source_witness.'+kind);return produced.entries.find(e=>e.kind===kind);};
 if(!needs('literal_promise'))return result(false,produced.unresolved[0]??'identified_literal_promise_required');
 if(decisionId==='obligation.payment_scope')return result(!!needs('payment_period'),'whole_month_source_payment_scope');
 if(decisionId==='obligation.rounding')return result(!!needs('payment_period')&&exactAgora(o),'exact_agora_product_required_no_assumed_rounding_rule');
 if(decisionId==='obligation.complete_conditions'){
  paths.push('conditions_mode','condition_inventory');return result(!!needs('complete_conditions'),'positive_source_condition_inventory_required');
 }
 paths.push('product_facts.agreement_made_or_renewed_on');
 if(!currentContext(input,o,'agreement_made_or_renewed_on',review))return result(false,'identified_formation_or_renewal_date_required');
 const date=o.product_facts!.agreement_made_or_renewed_on.value!;
 if(!regime(date)||date>input.period.from)return result(false,'agreement_date_regime_or_retroactivity_requires_separate_assessment');
 paths.push('product_facts.agreement_used_for_employment','product_facts.changes_or_side_terms','product_facts.employer_disputes_term');
 for(const key of ['agreement_used_for_employment','changes_or_side_terms','employer_disputes_term'] as const){
  if(!currentContext(input,o,key,review))return result(false,'identified_agreement_context_required.'+key);
  if(o.product_facts![key].value!==(key==='agreement_used_for_employment'))return result(false,'agreement_context_adverse.'+key);
 }
 // Even a literal expression is not interpreted in disregard of unreviewed
 // additional terms. Positive witnesses make the supported narrow context
 // inspectable, and the separate binding/conditions decisions remain required.
 if(produced.unresolved.includes('additional_or_unread_context_requires_interpretation'))return result(false,'additional_or_unread_context_requires_interpretation');
 if(decisionId==='obligation.clause_interpretation')return result(true,'literal_expression_in_identified_case_context.'+regime(date));
 const acceptance=needs('agreement_acceptance');
 return result(!!acceptance&&object(acceptance.value)&&acceptance.value.agreed_on===date,'positive_exact_agreement_statement_and_matching_case_context_required');
}

export function obligationCaseDecisionSources(input:ObligationsEntitlementInput,obligationId:string,paths:readonly string[],review:DocumentReviewInput){
 const o=input.obligations.find(o=>o.obligation_id===obligationId);if(!o)throw Error('OBLIGATION_CONSUMED_ID');
 return [...new Map(paths.flatMap(path=>sourcesIn(pathValue(input,o,path,review))).map(s=>[canonicalSha256(s),s])).values()];
}
