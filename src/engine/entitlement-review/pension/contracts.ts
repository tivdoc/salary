import {z} from 'zod';
import {documentReviewCalculationInputSchema,type DocumentReviewCalculationInput} from '../../document-review/calculations.ts';
import {pensionProductFactsSchema,pensionCaseRecipeBindingSchema,pensionDerivedFactSchema} from './product-facts.ts';
import {pensionSourceFactsSchema,PENSION_STATUTORY_FLOOR_POLICY} from './source-fact-contracts.ts';

const source=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const operand=documentReviewCalculationInputSchema.shape.operands.element;
const state=z.enum(['known','derived','missing','unknown','conflict','stale','expired','unreadable']);
const fact=<T extends z.ZodType>(value:T)=>z.object({state,value:value.nullable(),source:source.nullable(),
 basis:z.enum(['identified_document_reading','customer_declaration','ai_source_assessment']),derivation:pensionDerivedFactSchema.optional()}).strict()
 .refine(f=>!['known','derived'].includes(f.state)||'value' in f&&f.value!==null&&f.source!==null,'PENSION_KNOWN_FACT_SOURCE')
 .refine(f=>f.state==='derived'?f.basis==='ai_source_assessment'&&f.source?.reading==='source_research'&&f.derivation!==undefined:f.derivation===undefined,'PENSION_DERIVED_FACT_CONTRACT');
export const pensionFactSchemas={date:fact(z.iso.date()),boolean:fact(z.boolean()),
 employmentEnd:fact(z.union([z.iso.date(),z.literal('ongoing')]))};
const decision=z.object({decision_id:z.string().min(1),state:z.enum(['accepted','missing','unknown','conflict','stale','expired']),
 basis:z.enum(['ai_source_assessment','customer_declaration','verified_rule_source']),explanation:z.string().min(1).max(1000),
 sources:z.array(source).max(16),valid_until:z.iso.datetime().nullable()}).strict();
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict();
export const pensionEntitlementInputSchema=z.object({schema_version:z.literal('pension-entitlement-input-v1'),
 catalog_id:z.literal('il.review.pension.general.2026'),catalog_version:z.literal('1.0.0'),
 case_id:z.string().min(1),run_id:z.string().min(1),check_prefix:z.string().regex(/^[a-z][a-z0-9._:-]{2,110}$/u),
 period,evaluated_at:z.iso.datetime(),source_manifest:documentReviewCalculationInputSchema.shape.source_manifest,
 facts:z.object({employment_start:pensionFactSchemas.date,employment_end:pensionFactSchemas.employmentEnd,
  prior_coverage_at_start:pensionFactSchemas.boolean,continuous_employment:pensionFactSchemas.boolean,
  aged_21_or_more:pensionFactSchemas.boolean,under_60:pensionFactSchemas.boolean}).strict(),
 pensionable_wage:operand.nullable(),
 eligible_interval_wage:z.object({period,operand}).strict().nullable(),
 applicability:z.array(decision).max(12),
 product_facts:pensionProductFactsSchema.optional(),
 source_facts:pensionSourceFactsSchema.optional(),
 calculation_policy:z.literal(PENSION_STATUTORY_FLOOR_POLICY).optional(),
 case_recipe_bindings:z.array(pensionCaseRecipeBindingSchema).max(6).optional(),
 conditional_assumptions:z.array(z.object({decision_id:z.literal('pension.pensionable_wage'),explanation:z.string().min(1).max(1000)}).strict()).max(1).optional(),
 recorded:z.array(z.object({share:z.enum(['employee','employer','severance','combined_employer']),
  relationship_check:documentReviewCalculationInputSchema}).strict()).max(4),
 remittance_status:z.enum(['not_assessed','missing','unverified','confirmed']).default('not_assessed'),
}).strict().refine(v=>!v.source_facts?.table_policy||!!v.product_facts?.contract_terms_changed,'PENSION_TABLE_TEMPORAL_FACT_REQUIRED');
export type PensionEntitlementInput=z.infer<typeof pensionEntitlementInputSchema>;
export type PensionFact=PensionEntitlementInput['facts'][keyof PensionEntitlementInput['facts']];
export type PensionShare='employee'|'employer'|'severance';
export type PensionDecision=Extract<DocumentReviewCalculationInput['operation'],{kind:'candidate_rule'}>['decisions'][number];
export type PensionGap=Readonly<{dependency_id:string;state:string;kind:'missing_fact'|'missing_applicability'|'missing_source'|'missing_rule';
 question:string;answer_kind:'date'|'choice'|'number'|'text';options?:readonly string[];input_path:string;
 value_validation?:Readonly<{schema_version:'document-review-value-validation-v1';format:'iso_date'|'iso_date_or_ongoing'}>;
 dependent_check_ids:readonly string[];source_required:boolean}>;
export type PensionEligibility=Readonly<{state:'eligible'|'waiting_period'|'unknown'|'outside_employment';
 accrual_from:string|null;eligible_interval:{from:string;to:string}|null;first_execution_due:string|null;
 retroactive_to_start:boolean|null;partial_waiting_month:boolean;date_policy:'calendar_month_anniversary_clamped_v1';
 termination_before_initial_execution:boolean}>;
