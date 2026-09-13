import {z} from 'zod';
import {questionnaireAgeRangeProofSchema} from '../questionnaire-age-range.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewCalculationInput} from '../../document-review/calculations.ts';
import {workingTimeProductFactsSchema,workingTimeCaseRecipeBindingSchema} from './product-fact-contracts.ts';
import {WORKING_TIME_PROTECTED_BREAK_POLICY,WORKING_TIME_BREAK_TYPE_OPTIONS} from './protected-breaks.ts';

const operand=documentReviewCalculationInputSchema.shape.operands.element;
const source=operand.shape.source;
const id=z.string().regex(/^[a-z][a-z0-9._:-]{2,100}$/u);
const date=z.iso.date();
const evidenceState=z.enum(['observed','declared','missing','unknown','conflict','stale','expired','unreadable']);
export const workingTimeSourceFactSchema=<T extends z.ZodType>(value:T)=>z.object({state:evidenceState,value:value.nullable(),source:source.nullable()}).strict();
const classification=z.enum(['worked','free_break','required_presence','unknown']);
const interval=z.object({id,start_at:z.string().max(40),end_at:z.string().max(40),
 printed_duration:operand,clock_source:source,classification:workingTimeSourceFactSchema(classification),
 break_type:workingTimeSourceFactSchema(z.enum(WORKING_TIME_BREAK_TYPE_OPTIONS)).optional()}).strict();
const workday=z.object({id,date,kind:workingTimeSourceFactSchema(z.enum(['ordinary','pre_rest','holiday','unsupported'])),
 inventory:workingTimeSourceFactSchema(z.enum(['complete_work','no_work','incomplete'])),intervals:z.array(interval).max(8),
 no_work_credit:workingTimeSourceFactSchema(z.enum(['no_credit','paid_absence','unknown'])).optional(),
 // The employer/workplace arrangement is a sourced value, never derived from 42/5.
 ordinary_limit:operand,recorded_pay:operand.nullable(),
 payroll_allocations:z.array(z.object({id,hours:operand,hourly_rate:operand,percentage:operand.nullable()}).strict()).max(4).optional(),
 payment_allocation:workingTimeSourceFactSchema(z.enum(['full_pay_for_workday','partial','unknown']))}).strict();
const decision=z.object({decision_id:id,state:z.enum(['accepted','missing','unknown','conflict','stale','expired']),
 basis:z.enum(['ai_source_assessment','customer_declaration','verified_rule_source']),explanation:z.string().min(1).max(1000),sources:z.array(source).max(16),valid_until:z.iso.datetime({offset:true}).nullable()}).strict();
export const workingTimeEntitlementInputSchema=z.object({
 schema_version:z.literal('working-time-entitlement-input-v1'),catalog_version:z.literal('1.0.0'),
 calculation_policy:z.literal('working-time-separated-expected-v2').optional(),
 protected_break_policy:z.literal(WORKING_TIME_PROTECTED_BREAK_POLICY).optional(),
 case_id:z.string().min(1).max(160),run_id:z.string().min(1).max(160),check_id_prefix:id,
 period:z.object({from:date,to:date}).strict(),evaluated_at:z.iso.datetime(),
 source_manifest:documentReviewCalculationInputSchema.shape.source_manifest,
 product_age_range:questionnaireAgeRangeProofSchema.optional(),
 arrangement:workingTimeSourceFactSchema(z.enum(['adult_hourly_five_day_42','adult_hourly_six_day_42','unsupported'])),
 scheduled_weekdays:workingTimeSourceFactSchema(z.array(z.number().int().min(0).max(6)).min(5).max(6)),
 week_start:date,week_inventory:workingTimeSourceFactSchema(z.enum(['complete','partial','unknown'])),
 // All seven dated entries are required, including explicit source-backed no-work days.
 workdays:z.array(workday).max(7),
 rest_window:workingTimeSourceFactSchema(z.object({start_at:z.string().max(40),end_at:z.string().max(40)}).strict()),
 regular_hourly_wage:operand,
 product_facts:workingTimeProductFactsSchema.optional(),case_recipe_bindings:z.array(workingTimeCaseRecipeBindingSchema).max(32).optional(),
 applicability:z.array(decision).max(64),
 mode:z.enum(['source_classified','explicit_presence_scenario']),
 conditional_assumptions:z.array(z.object({decision_id:id,explanation:z.string().min(1).max(1000)}).strict()).min(1).max(32).optional(),
}).strict().superRefine((v,ctx)=>{if(v.product_facts?.schema_version!=='working-time-product-facts-v2'&&v.applicability.length>32)ctx.addIssue({code:'custom',message:'WORKING_TIME_LEGACY_DECISION_LIMIT'});
 if(!v.protected_break_policy&&v.workdays.some(d=>d.intervals.some(i=>i.break_type!==undefined)))ctx.addIssue({code:'custom',message:'WORKING_TIME_BREAK_POLICY_REQUIRED'});});
export type WorkingTimeEntitlementInput=z.infer<typeof workingTimeEntitlementInputSchema>;
export type WorkingTimeWorkday=WorkingTimeEntitlementInput['workdays'][number];
export type WorkingTimeSourceFact<T>={state:z.infer<typeof evidenceState>;value:T|null;source:z.infer<typeof source>|null};
export type WorkingTimeDecision=Extract<DocumentReviewCalculationInput['operation'],{kind:'candidate_rule'}>['decisions'][number];
export type WorkingTimeMissing=Readonly<{
 fact_key:string;input_path:string;state:'missing'|'unknown'|'conflict'|'stale'|'expired'|'unreadable'|'unsupported';
 kind:'source'|'fact'|'applicability';question:string;answer_kind:'boolean'|'number'|'choice'|'text'|'document';
 options?:readonly string[];customer_declaration_allowed:boolean;source_pins:readonly {case_id:string;document_id:string;version_id:string;source_sha256:string}[];
 dependent_check_ids:readonly string[];
}>;
