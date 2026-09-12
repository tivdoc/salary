import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import type {DocumentReviewSource} from '../document-review/calculations.ts';
import {questionnaireAgeRangeEvidence,assertQuestionnaireAgeRangeProof,ageRangeBirthDateConsistency,type QuestionnaireAgeRangeProof} from './questionnaire-age-range.ts';

export const QUESTIONNAIRE_AGE_RANGE_REUSE_POLICY='questionnaire-age-range-reuse-v1' as const;
export type ProductAgeRangeFact={state:string;value:unknown;source:DocumentReviewSource|null};
export type ProductAgeRangeInput={case_id:string;period:{from:string;to:string};product_age_range?:QuestionnaireAgeRangeProof};

/** No fact replacement. A separately supplied DOB takes precedence as an
 * input, but a contradiction with the retained year remains explicit. */
export function productAgeRangeSelection(input:ProductAgeRangeInput,birth:ProductAgeRangeFact,review?:DocumentReviewInput):{
 kind:'range'|'birth_date'|'blocked';reason:string|null;consumed_path:'product_age_range'|'product_facts.birth_date';
}{
 const proof=input.product_age_range;
 if(proof){
  const {sha256,...body}=proof;
  if(canonicalSha256(body)!==sha256||proof.case_id!==input.case_id||canonicalSha256(proof.period)!==canonicalSha256(input.period))throw Error('PRODUCT_AGE_RANGE_SCOPE');
  if(review)assertQuestionnaireAgeRangeProof(review,proof);
 }
 if(['observed','declared'].includes(birth.state)&&typeof birth.value==='string'&&birth.source){
  if(proof&&ageRangeBirthDateConsistency(proof,birth.value)==='conflict')return {kind:'blocked',reason:'birth_date_conflicts_with_retained_birth_year',consumed_path:'product_facts.birth_date'};
  return {kind:'birth_date',reason:null,consumed_path:'product_facts.birth_date'};
 }
 if(birth.state!=='missing'||birth.value!==null)return {kind:'blocked',reason:'birth_date:'+birth.state,consumed_path:'product_facts.birth_date'};
 if(proof&&proof.transforms.length===2&&proof.transforms.every(t=>t.value===true))return {kind:'range',reason:null,consumed_path:'product_age_range'};
 return {kind:'blocked',reason:proof?'birth_date_required_at_age_boundary':'birth_date:missing',consumed_path:'product_facts.birth_date'};
}

/** Pure current source projection. The caller stores it only on the effective
 * branch; raw packet, canonical questionnaire and answer history are retained. */
export function currentProductAgeRange(review:DocumentReviewInput,birth:ProductAgeRangeFact):QuestionnaireAgeRangeProof|undefined{
 if(!['missing','observed','declared'].includes(birth.state))return undefined;
 const result=questionnaireAgeRangeEvidence(review);
 return result.proof??undefined;
}

export function productAgeRangeSources(input:ProductAgeRangeInput):DocumentReviewSource[]{
 return input.product_age_range?[input.product_age_range.origin,...input.product_age_range.transforms.map(t=>t.source)]:[];
}
