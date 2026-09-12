import {z} from 'zod';
import {documentReviewCalculationInputSchema} from '../../document-review/calculations.ts';

const source=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const fact=<T extends z.ZodType>(value:T)=>z.object({state:z.enum(['observed','declared','missing','unknown','conflict','stale','expired','unreadable']),value:value.nullable(),source:source.nullable()}).strict();
export const MINIMUM_WAGE_PERSONAL_FACTS_POLICY='minimum-wage-personal-facts-v1' as const;
const legacy=z.object({schema_version:z.literal(MINIMUM_WAGE_PERSONAL_FACTS_POLICY),
 birth_date:fact(z.iso.date()),salary_basis:fact(z.enum(['hourly','monthly','other'])),
}).strict();
export const MINIMUM_WAGE_CASE_FACTS_POLICY='minimum-wage-personal-facts-v2' as const;
export const minimumWageCaseFactsSchema=legacy.extend({schema_version:z.literal(MINIMUM_WAGE_CASE_FACTS_POLICY),
 employment_relationship:fact(z.enum(['employee','self_employed','other'])),workplace_sector:fact(z.enum(['private','public','protected_workshop','other'])),
 adapted_wage_approval:fact(z.boolean()),special_wage_arrangement:fact(z.boolean()),weekly_schedule_hours:fact(z.enum(['42','other'])),
}).strict();
export const minimumWagePersonalFactsSchema=z.union([legacy,minimumWageCaseFactsSchema]);
export function minimumWagePersonalFacts(){const missing={state:'missing',value:null,source:null};return minimumWageCaseFactsSchema.parse({schema_version:MINIMUM_WAGE_CASE_FACTS_POLICY,
 birth_date:missing,salary_basis:missing,employment_relationship:missing,workplace_sector:missing,
 adapted_wage_approval:missing,special_wage_arrangement:missing,weekly_schedule_hours:missing});}
