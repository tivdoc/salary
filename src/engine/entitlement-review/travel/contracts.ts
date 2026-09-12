import {z} from 'zod';
import {documentReviewCalculationInputSchema} from '../../document-review/calculations.ts';
const source=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const operand=documentReviewCalculationInputSchema.shape.operands.element;
const fact=<T extends z.ZodType>(value:T)=>z.object({state:z.enum(['known','missing','unknown','conflict','stale','expired','unreadable']),value:value.nullable(),source:source.nullable(),basis:z.enum(['identified_document_reading','customer_declaration','ai_source_assessment'])}).strict().refine(f=>f.state!=='known'||'value' in f&&f.value!==null&&f.source!==null,'TRAVEL_KNOWN_FACT_SOURCE');
const direction=z.enum(['none','outbound','return','both','mixed']);
const decision=z.object({decision_id:z.string().min(1),state:z.enum(['accepted','missing','unknown','conflict','stale','expired']),basis:z.enum(['ai_source_assessment','customer_declaration','verified_rule_source']),explanation:z.string().min(1).max(1000),sources:z.array(source).max(16),valid_until:z.iso.datetime().nullable()}).strict();
export const travelEntitlementInputSchema=z.object({schema_version:z.literal('travel-entitlement-input-v1'),catalog_id:z.literal('il.review.travel.general.2026'),catalog_version:z.literal('1.0.0'),
 case_id:z.string().min(1),run_id:z.string().min(1),check_prefix:z.string().regex(/^[a-z][a-z0-9._:-]{2,110}$/u),period:z.object({from:z.iso.date(),to:z.iso.date()}).strict(),evaluated_at:z.iso.datetime(),source_manifest:documentReviewCalculationInputSchema.shape.source_manifest,
 facts:z.object({needs_transport:fact(z.boolean()),employer_transport:fact(direction),free_travel:fact(direction)}).strict(),
 commute_days:operand.nullable(),discounted_daily_fare:operand.nullable(),
 monthly_pass:fact(z.enum(['available','unavailable'])),monthly_pass_cost:operand.nullable(),recorded:operand.nullable(),
 applicability:z.array(decision).max(8),conditional_assumptions:z.array(z.object({decision_id:z.enum(['travel.general_coverage','travel.no_better_arrangement','travel.fare_basis','travel.one_direction_treatment','travel.ticket_options','travel.rounding']),explanation:z.string().min(1).max(1000)}).strict()).max(6).optional(),
 remittance_status:z.enum(['not_assessed','missing','unverified','confirmed']).default('not_assessed'),
}).strict();
export type TravelEntitlementInput=z.infer<typeof travelEntitlementInputSchema>;
export type TravelGap=Readonly<{dependency_id:string;state:string;kind:'missing_fact'|'missing_source'|'missing_applicability'|'missing_rule';question:string;answer_kind:'number'|'choice'|'text';options?:readonly string[];input_path:string;dependent_check_ids:readonly string[];source_required:boolean}>;
