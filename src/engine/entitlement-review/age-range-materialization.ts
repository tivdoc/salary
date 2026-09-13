import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import type {DocumentReviewSource} from '../document-review/calculations.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import type {z} from 'zod';
import type {EntitlementEvidence} from './contracts.ts';
import {minimumWageEntitlementInputSchema} from './minimum-wage/contracts.ts';
import {convalescenceEntitlementInputSchema} from './convalescence/contracts.ts';
import {vacationEntitlementInputSchema} from './vacation/contracts.ts';
import {workingTimeEntitlementInputSchema} from './working-time/contracts.ts';
import {currentProductAgeRange,QUESTIONNAIRE_AGE_RANGE_REUSE_POLICY,type ProductAgeRangeFact} from './product-age-range.ts';
import type {QuestionnaireAgeRangeProof} from './questionnaire-age-range.ts';
type Manifest=z.infer<typeof documentReviewCalculationInputSchema.shape.source_manifest>;
type Branch={case_id:string;period:{from:string;to:string};product_facts?:{schema_version:string;birth_date?:ProductAgeRangeFact};source_manifest:Manifest;product_age_range?:QuestionnaireAgeRangeProof};
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
export function enableQuestionnaireAgeRangeReuse(input:EntitlementEvidence):EntitlementEvidence{return {...input,age_range_policy:QUESTIONNAIRE_AGE_RANGE_REUSE_POLICY};}

/** Only the effective annotation/its exact questionnaire manifest are changed.
 * This never replaces a DOB, population, original age boolean or decision. */
export function materializeQuestionnaireAgeRanges(candidate:EntitlementEvidence,original:EntitlementEvidence,review:DocumentReviewInput):EntitlementEvidence{
 if(candidate.age_range_policy!==original.age_range_policy)throw Error('AGE_RANGE_POLICY_CHANGED');
 const enabled=original.age_range_policy===QUESTIONNAIRE_AGE_RANGE_REUSE_POLICY;
 if(!enabled){
  for(const packet of [candidate,original])for(const key of ['minimum_wage','convalescence','vacation','working_time'] as const){
   const branch=packet[key],values=Array.isArray(branch)?branch:[branch];
   for(const value of values)if(value&&typeof value==='object'&&Reflect.get(value,'product_age_range')!==undefined)throw Error('AGE_RANGE_OPT_IN_REQUIRED');
  }
  return candidate;
 }
 for(const key of ['minimum_wage','convalescence','vacation','working_time'] as const){
  if(candidate[key]&&!original[key]){
   const values=key==='working_time'?workingTimeEntitlementInputSchema.array().parse(candidate[key]):[key==='minimum_wage'?minimumWageEntitlementInputSchema.parse(candidate[key]):key==='convalescence'?convalescenceEntitlementInputSchema.parse(candidate[key]):vacationEntitlementInputSchema.parse(candidate[key])];
   if(values.some(v=>v.product_age_range))throw Error('AGE_RANGE_ORIGINAL_BRANCH_REQUIRED');
  }
 }
 const project=<T extends Branch>(current:T,raw:T):T=>{
  if(raw.product_age_range)throw Error('AGE_RANGE_RAW_ANNOTATION');
  if(!enabled){if(current.product_age_range)throw Error('AGE_RANGE_OPT_IN_REQUIRED');return current;}
  if(current.case_id!==review.case_id||!same(current.period,review.period))throw Error('AGE_RANGE_BRANCH_SCOPE');
  const result={...current,source_manifest:[...current.source_manifest]},previous=current.product_age_range;
  delete result.product_age_range;
  if(previous)result.source_manifest=result.source_manifest.filter(m=>!(m.kind==='questionnaire'&&m.document_id===previous.origin.document_id&&m.version_id===previous.origin.version_id&&!raw.source_manifest.some(r=>same(r,m))));
  const proof=current.product_facts?.birth_date?currentProductAgeRange(review,current.product_facts.birth_date):undefined;
  if(proof){
   result.product_age_range=proof;const s:DocumentReviewSource=proof.origin;
   const manifest={document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,page_count:1,kind:'questionnaire' as const,case_id:review.case_id};
   const existing=result.source_manifest.find(m=>m.document_id===s.document_id&&m.version_id===s.version_id);
   if(existing&&!same(existing,manifest))throw Error('AGE_RANGE_MANIFEST_CONFLICT');
   if(!existing)result.source_manifest.push(manifest);
  }
  return result;
 };
 let result={...candidate};
 if(candidate.minimum_wage&&original.minimum_wage)result={...result,minimum_wage:project(minimumWageEntitlementInputSchema.parse(candidate.minimum_wage),minimumWageEntitlementInputSchema.parse(original.minimum_wage))};
 if(candidate.convalescence&&original.convalescence)result={...result,convalescence:project(convalescenceEntitlementInputSchema.parse(candidate.convalescence),convalescenceEntitlementInputSchema.parse(original.convalescence))};
 if(candidate.vacation&&original.vacation)result={...result,vacation:project(vacationEntitlementInputSchema.parse(candidate.vacation),vacationEntitlementInputSchema.parse(original.vacation))};
 if(candidate.working_time&&original.working_time){const current=workingTimeEntitlementInputSchema.array().min(1).max(6).parse(candidate.working_time),raw=workingTimeEntitlementInputSchema.array().min(1).max(6).parse(original.working_time);
  if(current.length!==raw.length)throw Error('AGE_RANGE_WEEK_SCOPE');result={...result,working_time:current.map((v,i)=>project(v,raw[i]))};}
 return enabled?result:candidate;
}
export function assertProductAgeRangeMaterialization(review:DocumentReviewInput,candidate:EntitlementEvidence):void{
 const original=review.entitlement_evidence;if(!original)return;
 const expected=materializeQuestionnaireAgeRanges(candidate,original,review);
 if(original.age_range_policy!==QUESTIONNAIRE_AGE_RANGE_REUSE_POLICY)return;
 const proofs=(e:EntitlementEvidence)=>[minimumWageEntitlementInputSchema.optional().parse(e.minimum_wage)?.product_age_range??null,
  convalescenceEntitlementInputSchema.optional().parse(e.convalescence)?.product_age_range??null,vacationEntitlementInputSchema.optional().parse(e.vacation)?.product_age_range??null,
  ...(e.working_time?workingTimeEntitlementInputSchema.array().parse(e.working_time).map(w=>w.product_age_range??null):[])];
 // Raw is admitted before projection; its absent annotation is intentional.
 if(!same(candidate,original)&&!same(proofs(candidate),proofs(expected)))throw Error('AGE_RANGE_MATERIALIZATION_REPLAY');
}
