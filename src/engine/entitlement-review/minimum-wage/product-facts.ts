import {z} from 'zod';
import {documentReviewCalculationInputSchema} from '../../document-review/calculations.ts';

const source=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const fact=<T extends z.ZodType>(value:T)=>z.object({state:z.enum(['observed','declared','missing','unknown','conflict','stale','expired','unreadable']),value:value.nullable(),source:source.nullable()}).strict();
export const MINIMUM_WAGE_PERSONAL_FACTS_POLICY='minimum-wage-personal-facts-v1' as const;
export const minimumWagePersonalFactsSchema=z.object({schema_version:z.literal(MINIMUM_WAGE_PERSONAL_FACTS_POLICY),
 birth_date:fact(z.iso.date()),salary_basis:fact(z.enum(['hourly','monthly','other'])),
}).strict();
export function minimumWagePersonalFacts(){return minimumWagePersonalFactsSchema.parse({schema_version:MINIMUM_WAGE_PERSONAL_FACTS_POLICY,
 birth_date:{state:'missing',value:null,source:null},salary_basis:{state:'missing',value:null,source:null}});}
