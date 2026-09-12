import {z} from 'zod';
import {documentReviewCalculationInputSchema,type DocumentReviewCalculationInput} from '../../document-review/calculations.ts';
import {vacationProductFactsSchema,vacationCaseRecipeBindingSchema,vacationDerivedFactSchema,vacationDerivedSenioritySchema} from './product-facts.ts';

const source=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const operand=documentReviewCalculationInputSchema.shape.operands.element;
const state=z.enum(['known','derived','missing','unknown','conflict','stale','expired','unreadable']);
const fact=<T extends z.ZodType>(value:T)=>z.object({state,value:value.nullable(),source:source.nullable(),
 basis:z.enum(['identified_document_reading','customer_declaration','ai_source_assessment']),derivation:vacationDerivedFactSchema.optional()}).strict()
 .refine(f=>!['known','derived'].includes(f.state)||'value' in f&&f.value!==null&&f.source!==null,'VACATION_KNOWN_FACT_SOURCE')
 .refine(f=>f.state==='derived'?f.derivation!==undefined&&f.basis==='ai_source_assessment'&&f.source?.reading==='source_research':f.derivation===undefined,'VACATION_DERIVED_FACT_CONTRACT');
export const vacationFactSchemas={boolean:fact(z.boolean()),date:fact(z.iso.date()),
 employmentEnd:fact(z.union([z.iso.date(),z.literal('ongoing')]))};
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict().refine(p=>p.from<=p.to,'VACATION_PERIOD');
const decision=z.object({decision_id:z.string().min(1),state:z.enum(['accepted','missing','unknown','conflict','stale','expired']),
 basis:z.enum(['ai_source_assessment','customer_declaration','verified_rule_source']),explanation:z.string().min(1).max(1000),
 sources:z.array(source).max(16),valid_until:z.iso.datetime().nullable()}).strict();
const leaveBase={leave_period:period,wage:operand.nullable(),recorded:operand.nullable()};
export const vacationEntitlementInputSchema=z.object({schema_version:z.literal('vacation-entitlement-input-v1'),
 catalog_id:z.literal('il.review.vacation.general.2026'),catalog_version:z.literal('1.0.0'),
 case_id:z.string().min(1),run_id:z.string().min(1),check_prefix:z.string().regex(/^[a-z][a-z0-9._:-]{2,110}$/u),
 period,calendar_year:z.literal(2026),evaluated_at:z.iso.datetime(),source_manifest:documentReviewCalculationInputSchema.shape.source_manifest,
 facts:z.object({aged_21_or_more:vacationFactSchemas.boolean,under_60:vacationFactSchemas.boolean}).strict(),
 seniority_year:operand.nullable(),
 derived_seniority:vacationDerivedSenioritySchema.optional(),
 product_facts:vacationProductFactsSchema.optional(),
 case_recipe_bindings:z.array(vacationCaseRecipeBindingSchema).max(14).optional(),
 product_scenario_policy:z.literal('vacation-qualified-statutory-scenario-v1').optional(),
 annual_basis:z.object({employment_start:vacationFactSchemas.date,employment_end:vacationFactSchemas.employmentEnd,
  complete_year_evidence:vacationFactSchemas.boolean,covered_through:vacationFactSchemas.date,actual_workdays:operand.nullable()}).strict().nullable(),
 leave_pay:z.discriminatedUnion('mode',[
  z.object({mode:z.literal('hourly_quarter'),...leaveBase,quarter_period:period,leave_calendar_days:operand.nullable()}).strict(),
  z.object({mode:z.literal('monthly_maintained_wage'),...leaveBase}).strict(),
 ]).nullable(),
 applicability:z.array(decision).max(16),
 conditional_assumptions:z.array(z.object({decision_id:z.string().min(1),explanation:z.string().min(1).max(1000)}).strict()).max(12).optional(),
 remittance_status:z.enum(['not_assessed','missing','unverified','confirmed']).default('not_assessed'),
}).strict();
export type VacationEntitlementInput=z.infer<typeof vacationEntitlementInputSchema>;
export type VacationFact=VacationEntitlementInput['facts'][keyof VacationEntitlementInput['facts']];
export type VacationDecision=Extract<DocumentReviewCalculationInput['operation'],{kind:'candidate_rule'}>['decisions'][number];
export type VacationGap=Readonly<{dependency_id:string;state:string;kind:'missing_fact'|'missing_applicability'|'missing_source'|'missing_rule';
 question:string;answer_kind:'date'|'choice'|'number'|'text';input_path:string;dependent_check_ids:readonly string[];source_required:boolean;
 value_validation?:Readonly<{schema_version:'document-review-value-validation-v1';format:'iso_date'|'iso_date_or_ongoing'}>}>;
