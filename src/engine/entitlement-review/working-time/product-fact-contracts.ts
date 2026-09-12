import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewCalculationInputSchema} from '../../document-review/calculations.ts';
import {aiReleaseDecisionMethodSchema} from '../../ai-release-decisions/contracts.ts';
const sha=z.string().regex(/^[a-f0-9]{64}$/u),id=z.string().regex(/^[a-z][a-z0-9._:-]{2,100}$/u);
const source=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const fact=<T extends z.ZodType>(value:T)=>z.object({state:z.enum(['observed','declared','missing','unknown','conflict','stale','expired','unreadable']),value:value.nullable(),source:source.nullable()}).strict();
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict().refine(p=>p.from<=p.to,'WT_PRODUCT_PERIOD');
export const workingTimeRegularWageBasisSchema=fact(z.object({period,hourly_wage_operand_sha256:sha,
 composition:z.enum(['single_rate_no_regular_supplements','total_rate_including_all_regular_supplements','base_rate_only','incomplete','unknown']),
}).strict());
export const workingTimeAssignmentWitnessSchema=z.object({day_id:id,fact:fact(z.object({assigned_date:z.iso.date(),assignment:z.enum(['same_workday','separate_workdays','unknown']),intervals:z.array(z.object({interval_id:id,source_interval_sha256:sha}).strict()).min(1).max(8)}).strict())}).strict();
const associations={regular_wage_basis:workingTimeRegularWageBasisSchema.optional(),assignment_witnesses:z.array(workingTimeAssignmentWitnessSchema).max(7).optional()};
export const workingTimeProductFactsV1Schema=z.object({schema_version:z.literal('working-time-product-facts-v1'),...associations}).strict();
export const WORKING_TIME_PRODUCT_FACTS_POLICY='working-time-product-facts-v2' as const;
export const workingTimeProductFactsV2Schema=z.object({schema_version:z.literal(WORKING_TIME_PRODUCT_FACTS_POLICY),...associations,
 birth_date:fact(z.iso.date()),employment_relationship:fact(z.enum(['employee','self_employed','other'])),workplace_sector:fact(z.enum(['private','public','protected_workshop','other'])),
 salary_basis:fact(z.enum(['hourly','monthly','other'])),job_duties:fact(z.string().trim().min(1).max(2000)),
 occupation_group:fact(z.enum(['ordinary','police_prison','sea_fishing','aircrew','live_in_care','other'])),
 company_policy_authority:fact(z.boolean()),employer_personal_proxy:fact(z.boolean()),hours_trackable:fact(z.boolean()),other_hours_terms_known:fact(z.boolean()),contract_terms_current:fact(z.boolean()),
 rest_start_date:fact(z.iso.date()),rest_start_time:fact(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)),
 rest_end_date:fact(z.iso.date()),rest_end_time:fact(z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u)),
}).strict();
export const workingTimeProductFactsSchema=z.discriminatedUnion('schema_version',[workingTimeProductFactsV1Schema,workingTimeProductFactsV2Schema]);
export type WorkingTimeProductFacts=z.infer<typeof workingTimeProductFactsSchema>;
export const workingTimeCaseRecipeBindingSchema=z.object({schema_version:z.literal('working-time-case-recipe-binding-v1'),method:z.lazy(()=>aiReleaseDecisionMethodSchema),
 evaluated_at:z.iso.datetime(),decision_id:id,day_id:id.nullable(),binding_sha256:sha,
}).strict().refine(v=>{const {binding_sha256,...body}=v;return binding_sha256===canonicalSha256(body);},'WT_CASE_BINDING_HASH');
export type WorkingTimeCaseRecipeBinding=z.infer<typeof workingTimeCaseRecipeBindingSchema>;
