import {z} from 'zod';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema} from '../document-review/calculations.ts';
import {entitlementDeclarationsSchema,questionnaireFactSource,assertQuestionnaireSource} from './declarations.ts';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const source=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const range=z.object({minimum:z.number().int(),maximum:z.number().int()}).strict();
export const questionnaireAgeRangeProofSchema=z.object({
 schema_version:z.literal('questionnaire-age-range-proof-v1'),case_id:z.string().min(1),
 period:z.object({from:z.iso.date(),to:z.iso.date()}).strict(),birth_year:z.number().int(),
 age_at_period_start:range,age_at_period_end:range,
 origin:source,transforms:z.array(z.object({
  transform:z.enum(['aged_21_for_period','under_60_for_period']),value:z.boolean(),source,
  source_sha256:sha,
 }).strict()).max(2),sha256:sha,
}).strict();
export type QuestionnaireAgeRangeProof=z.infer<typeof questionnaireAgeRangeProofSchema>;
export type QuestionnaireAgeRangeResult={state:'proven'|'boundary'|'outside_scope'|'missing'|'conflict'|'unsupported';
 reason:string;proof:QuestionnaireAgeRangeProof|null};

/** Reuses a declared year as an interval, never as a fabricated birth date or
 * a legal population decision. The caller still admits the case recipe. */
export function questionnaireAgeRangeEvidence(input:DocumentReviewInput):QuestionnaireAgeRangeResult{
 const stop=(state:QuestionnaireAgeRangeResult['state'],reason:string):QuestionnaireAgeRangeResult=>({state,reason,proof:null});
 if(input.period.from<'2026-05-01'||input.period.to>'2026-07-31'||input.period.from>input.period.to)return stop('unsupported','outside_release_period');
 if(!input.entitlement_declarations)return stop('missing','birth_year_missing');
 const declarations=entitlementDeclarationsSchema.parse(input.entitlement_declarations);
 if(canonicalSha256(declarations.period)!==canonicalSha256(input.period)||declarations.facts.some(f=>f.case_id!==input.case_id))throw Error('AGE_RANGE_DECLARATION_SCOPE');
 const candidates=declarations.facts.filter(f=>f.path==='person.birth_year');
 if(candidates.length>1||candidates.some(f=>f.conflicting_fact_ids.length>0))return stop('conflict','birth_year_conflict');
 const year=questionnaireFactSource(input,'person.birth_year');
 if(!year||typeof year.value!=='number'||!Number.isInteger(year.value))return stop('missing','usable_birth_year_missing');
 const birthYear=year.value;
 assertQuestionnaireSource(input,year.source,year.value);
 // Jan 1 / Dec 31 are mathematical interval bounds, not stored source dates.
 const at=(date:string)=>({minimum:Number(date.slice(0,4))-birthYear-1,maximum:Number(date.slice(0,4))-birthYear});
 const transforms:QuestionnaireAgeRangeProof['transforms']=[];
 for(const transform of ['aged_21_for_period','under_60_for_period'] as const){
  const result=questionnaireFactSource(input,'person.birth_year',transform);
  if(result&&typeof result.value==='boolean'){
   assertQuestionnaireSource(input,result.source,result.value);
   transforms.push({transform,value:result.value,source:result.source,source_sha256:canonicalSha256(result.source)});
  }
 }
 const body={schema_version:'questionnaire-age-range-proof-v1' as const,case_id:input.case_id,period:input.period,birth_year:year.value,
  age_at_period_start:at(input.period.from),age_at_period_end:at(input.period.to),origin:year.source,transforms};
 const proof=questionnaireAgeRangeProofSchema.parse({...body,sha256:canonicalSha256(body)});
 if(transforms.some(t=>!t.value))return {state:'outside_scope',reason:'outside_adult_21_59_range',proof};
 if(transforms.length!==2)return {state:'boundary',reason:'actual_birth_date_required_at_age_boundary',proof};
 return {state:'proven',reason:'every_possible_birthday_is_within_21_59',proof};
}

/** Replays against the current authenticated declaration snapshot, including
 * source period and transform bytes; a fresh hash alone cannot repair tampering. */
export function assertQuestionnaireAgeRangeProof(input:DocumentReviewInput,raw:unknown):QuestionnaireAgeRangeProof{
 const proof=questionnaireAgeRangeProofSchema.parse(raw),{sha256,...body}=proof;
 if(canonicalSha256(body)!==sha256)throw Error('AGE_RANGE_PROOF_HASH');
 const replay=questionnaireAgeRangeEvidence(input);
 if(!replay.proof||canonicalSha256(replay.proof)!==canonicalSha256(proof))throw Error('AGE_RANGE_PROOF_REPLAY');
 return proof;
}

/** This checks consistency only. It does not authenticate a supplied date or
 * upgrade a boundary proof; the date retains its own answer/source admission. */
export function ageRangeBirthDateConsistency(raw:QuestionnaireAgeRangeProof,birthDate:string):'consistent'|'conflict'{
 const proof=questionnaireAgeRangeProofSchema.parse(raw),{sha256,...body}=proof;
 if(canonicalSha256(body)!==sha256)throw Error('AGE_RANGE_PROOF_HASH');
 const date=z.iso.date().parse(birthDate);
 return Number(date.slice(0,4))===proof.birth_year&&date<=proof.period.from?'consistent':'conflict';
}
