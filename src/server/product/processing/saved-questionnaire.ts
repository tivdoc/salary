import {z} from 'zod';
import {canonicalFactSchema,type CanonicalFact} from '@/engine/facts/contracts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {savedAnalysisId} from './saved-draft-report';

const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
const fields={
 salaryType:z.enum(['monthly','hourly']),employmentStartMonth:month,
 stillEmployed:z.boolean(),managerialOrTrustRole:z.boolean(),birthYear:z.number().int().min(1900).max(2200),
 sex:z.enum(['female','male','unspecified']),workDaysPerWeek:z.number().int().min(1).max(7),typicalHoursPerDay:z.number().min(1).max(18),
 worksFriday:z.boolean(),worksSaturday:z.boolean(),hadPensionFundAtHire:z.boolean(),employerProvidesTransport:z.boolean(),commuteOver500m:z.boolean(),
};
const mapping:Record<keyof typeof fields,CanonicalFact['path']>={
 salaryType:'compensation.salary_type',employmentStartMonth:'employment.start_month',stillEmployed:'employment.still_employed',
 managerialOrTrustRole:'employment.managerial_or_trust_role_declared',birthYear:'person.birth_year',sex:'person.sex',
 workDaysPerWeek:'work.days_per_week',typicalHoursPerDay:'work.typical_hours_per_day',worksFriday:'work.works_friday',worksSaturday:'work.works_saturday',
 hadPensionFundAtHire:'pension.fund_at_hire',employerProvidesTransport:'travel.employer_provides_transport',commuteOver500m:'travel.commute_over_500m',
};
const sourceSchema=z.object({id:z.uuid(),case_id:z.uuid(),scope_month:month.nullable(),created_at:z.string().datetime({offset:true})}).strict();
/** Explicit values only. Month/year precision stays month/year precision; a
 * managerial-role answer is an assertion, never an automatic legal exclusion.
 * No free text, identity contact details, derived age, workday list or unseen
 * period can become a fact here. Canonical fact IDs pin the journal revision. */
export function savedQuestionnaireFacts(input:{caseId:string;revision:number;inputSha256:string;month:string;journal:unknown;createdAt:string}):readonly CanonicalFact[]{
 const journal=z.object({questionnaire:z.unknown().optional(),questionnaire_source:z.unknown().optional()}).passthrough().parse(input.journal);
 if(journal.questionnaire===undefined||journal.questionnaire===null)return [];
 // Old journals retain their bytes. Missing historical provenance is not filled in.
 if(journal.questionnaire_source===undefined||journal.questionnaire_source===null)return [];
 const source=sourceSchema.parse(journal.questionnaire_source);
 if(source.case_id!==input.caseId)throw new Error('SAVED_DECLARATION_CASE_MISMATCH');
 if(source.scope_month!==input.month)return [];
 const payload=z.record(z.string(),z.unknown()).parse(journal.questionnaire);
 const facts:CanonicalFact[]=[];
 for(const key of Object.keys(fields) as (keyof typeof fields)[]){
  if(!(key in payload))continue;
  const parsed=fields[key].safeParse(payload[key]);if(!parsed.success)throw new Error('SAVED_DECLARATION_VALUE_INVALID');
  const path=mapping[key];
  facts.push(canonicalFactSchema.parse({fact_id:savedAnalysisId('saved-questionnaire-fact',canonicalSha256({case_id:input.caseId,revision:input.revision,input_sha256:input.inputSha256,response_id:source.id,path})),case_id:input.caseId,path,value:parsed.data,
   status:'needs_confirmation',confidence:1,provenance:[{source_type:'declared',source_reference:{kind:'questionnaire_response',response_id:source.id}}],conflicting_fact_ids:[],resolution:null,created_at:input.createdAt}));
 }
 return facts;
}
