import {z} from 'zod';
import {documentReviewCalculationInputSchema} from '../../document-review/calculations.ts';
import {minimumWagePersonalFactsSchema} from './product-facts.ts';
const operand=documentReviewCalculationInputSchema.shape.operands.element;
const source=operand.shape.source;
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict();
export const minimumWageFactSchema=<T extends z.ZodType>(value:T)=>z.object({state:z.enum(['observed','declared','missing','unknown','conflict','stale','expired','unreadable']),value:value.nullable(),source:source.nullable()}).strict();
export const minimumWageMethodSchema=z.enum(['published_hourly_182','monthly_exact_div182','full_monthly']);
export const minimumWageComponentKindSchema=z.enum(['base_salary','cost_of_living','fixed_work_supplement','seniority','family','shift_premium','productivity_premium','thirteenth_salary','annual_bonus','expense_reimbursement','overtime','weekly_rest','paid_absence','unknown']);
export const minimumWageEntitlementInputSchema=z.object({schema_version:z.literal('minimum-wage-entitlement-input-v1'),catalog_version:z.literal('1.0.0'),
 case_id:z.string().min(1),run_id:z.string().min(1),check_id:z.string().regex(/^[a-z][a-z0-9._:-]{2,100}$/u),period:z.object({from:z.iso.date(),to:z.iso.date()}).strict(),evaluated_at:z.iso.datetime(),
 source_manifest:documentReviewCalculationInputSchema.shape.source_manifest,
 method:minimumWageFactSchema(minimumWageMethodSchema),
 population:minimumWageFactSchema(z.enum(['adult_general','minor','adapted_wage','unsupported'])),
 employment:minimumWageFactSchema(z.enum(['hourly_182','full_monthly_42','partial_monthly','unsupported'])),
 ordinary_hours:operand.nullable(),
 ordinary_hours_period:minimumWageFactSchema(period),
 monthly_coverage:minimumWageFactSchema(z.enum(['full_month_full_time','partial','unknown'])),
 eligible_pay_inventory:minimumWageFactSchema(z.enum(['complete','partial','unknown'])),
 product_facts:minimumWagePersonalFactsSchema.optional(),
 components:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9._:-]{2,100}$/u),amount:operand,period:minimumWageFactSchema(period),classification:minimumWageFactSchema(minimumWageComponentKindSchema)}).strict()).max(32),
 applicability:z.array(z.object({decision_id:z.string().regex(/^[a-z][a-z0-9._:-]{2,100}$/u),state:z.enum(['accepted','missing','unknown','conflict','stale','expired']),
  basis:z.enum(['ai_source_assessment','customer_declaration','verified_rule_source']),explanation:z.string().min(1).max(1000),sources:z.array(source).max(16),valid_until:z.iso.datetime({offset:true}).nullable()}).strict()).max(16),
}).strict();
export type MinimumWageEntitlementInput=z.infer<typeof minimumWageEntitlementInputSchema>;
export type MinimumWageMethod=z.infer<typeof minimumWageMethodSchema>;
export type MinimumWageMissing=Readonly<{fact_key:string;input_path:string;state:'missing'|'unknown'|'conflict'|'stale'|'expired'|'unreadable'|'unsupported';
 kind:'fact'|'source'|'applicability';question:string;answer_kind:'text'|'document'|'choice'|'number';options?:readonly string[];
 customer_declaration_allowed:boolean;source_pins:readonly {case_id:string;document_id:string;version_id:string;source_sha256:string}[];dependent_check_ids:readonly string[]}>;
