import {z} from 'zod';
import {documentReviewCalculationInputSchema} from '../../document-review/calculations.ts';
import {convalescencePersonalFactsSchema} from './product-facts.ts';
import {convalescenceCaseBindingSchema,convalescencePopulationDerivationSchema} from './case-bindings.ts';

const operand=documentReviewCalculationInputSchema.shape.operands.element;
const source=operand.shape.source;
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict();
export const convalescenceFactSchema=<T extends z.ZodType>(value:T)=>z.object({
 state:z.enum(['observed','declared','missing','unknown','conflict','stale','expired','unreadable']),
 value:value.nullable(),source:source.nullable(),
}).strict();
export const convalescenceEntitlementInputSchema=z.object({
 schema_version:z.literal('convalescence-entitlement-input-v1'),catalog_version:z.literal('1.0.0'),
 case_id:z.string().min(1),run_id:z.string().min(1),check_prefix:z.string().regex(/^[a-z][a-z0-9._:-]{2,100}$/u),
 period,evaluated_at:z.iso.datetime(),source_manifest:documentReviewCalculationInputSchema.shape.source_manifest,
 population:convalescenceFactSchema(z.enum(['adult_private_general_21_59','public_or_pegged','protected_workshop','other'])).extend({
  state:z.enum(['observed','declared','derived','missing','unknown','conflict','stale','expired','unreadable']),derivation:convalescencePopulationDerivationSchema.optional(),
 }).strict().refine(f=>f.state==='derived'?f.derivation!==undefined:f.derivation===undefined,'CV_POPULATION_DERIVATION_STATE'),
 employment_start:convalescenceFactSchema(z.iso.date()),
 qualifying_service:convalescenceFactSchema(z.enum(['continuous_no_excluded_absence','excluded_absence_or_break','unknown'])),
 payment_coverage:convalescenceFactSchema(period),benefit_year:convalescenceFactSchema(z.number().int().min(1900).max(2100)),
 due_date:convalescenceFactSchema(z.iso.date()),
 segments:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9._:-]{2,60}$/u),
  period:convalescenceFactSchema(period),fte:convalescenceFactSchema(z.string().regex(/^(?:0(?:\.\d{1,8})?|1(?:\.0{1,8})?)$/u)),
 }).strict()).max(8),
 recorded:operand.nullable(),recorded_coverage:convalescenceFactSchema(period),
 recorded_inventory:convalescenceFactSchema(z.enum(['complete_allocated','partial','unknown'])),
 product_facts:convalescencePersonalFactsSchema.optional(),
 case_recipe_bindings:z.array(convalescenceCaseBindingSchema).max(12).optional(),
 source_gates_policy:z.literal('cv-source-gates-v2').optional(),
 applicability:z.array(z.object({decision_id:z.string().regex(/^[a-z][a-z0-9._:-]{2,100}$/u),
  state:z.enum(['accepted','missing','unknown','conflict','stale','expired']),
  basis:z.enum(['ai_source_assessment','customer_declaration','verified_rule_source']),explanation:z.string().min(1).max(1000),
  sources:z.array(source).max(16),valid_until:z.iso.datetime({offset:true}).nullable(),
 }).strict()).max(16),
 conditional_assumptions:z.array(z.object({decision_id:z.string().min(1),explanation:z.string().min(1).max(1000)}).strict()).max(12).optional(),
}).strict();
export type ConvalescenceEntitlementInput=z.infer<typeof convalescenceEntitlementInputSchema>;
export type ConvalescenceMissing=Readonly<{fact_key:string;input_path:string;
 state:'missing'|'unknown'|'conflict'|'stale'|'expired'|'unreadable'|'unsupported';kind:'fact'|'source'|'applicability';
 question:string;answer_kind:'text'|'document'|'date'|'choice'|'number';customer_declaration_allowed:boolean;
 source_pins:readonly {case_id:string;document_id:string;version_id:string;source_sha256:string}[];
 dependent_check_ids:readonly string[]}>;
