import {z} from 'zod';
import {createHash} from 'node:crypto';
import {obligationProductFactsSchema} from './product-facts.ts';
import {documentReviewCalculationInputSchema} from '../../document-review/calculations.ts';
const source=documentReviewCalculationInputSchema.shape.operands.element.shape.source,operand=documentReviewCalculationInputSchema.shape.operands.element;
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict().refine(p=>p.from<=p.to,'OBLIGATION_PERIOD');
const identifier=z.string().regex(/^[a-z][a-z0-9._:-]{2,63}$/u);
export const obligationTextSha256=(text:string)=>createHash('sha256').update(text,'utf8').digest('hex');
const decision=z.object({decision_id:z.string().min(1),state:z.enum(['accepted','missing','unknown','conflict','stale','expired']),basis:z.enum(['ai_source_assessment','customer_declaration','verified_rule_source']),explanation:z.string().min(1).max(1000),sources:z.array(source).max(16),valid_until:z.iso.datetime().nullable()}).strict();
const fact=z.object({state:z.enum(['known','missing','unknown','conflict','stale','expired','unreadable']),value:z.boolean().nullable(),source:source.nullable(),basis:z.enum(['identified_document_reading','customer_declaration','ai_source_assessment'])}).strict().refine(f=>f.state!=='known'||f.value!==null&&f.source!==null,'OBLIGATION_KNOWN_FACT_SOURCE');
const clause=z.object({source,text:z.string().min(1).max(6000),text_sha256:z.string().regex(/^[a-f0-9]{64}$/u),effective_period:period}).strict().refine(c=>obligationTextSha256(c.text)===c.text_sha256,'OBLIGATION_CLAUSE_TEXT_HASH');
export const obligationSchema=z.object({obligation_id:identifier,topic:z.enum(['contract','bonuses']),title:z.string().min(1).max(150),clause,payment_period:period,
 promise:z.discriminatedUnion('kind',[z.object({kind:z.literal('fixed'),amount:operand.nullable()}).strict(),z.object({kind:z.literal('linear'),rate:operand.nullable(),quantity:operand.nullable(),quantity_unit:z.enum(['count','hours','days'])}).strict()]),
 product_facts:obligationProductFactsSchema.optional(),
 conditions_mode:z.literal('all'),conditions:z.array(z.object({condition_id:identifier,description:z.string().min(1).max(300),fact}).strict()).max(8),
 assessments:z.array(decision).max(8),scenario:z.enum(['established_only','if_conditions_fulfilled']).default('established_only'),
 recorded:z.object({payment_id:identifier,amount:operand,payment_period:period,scope_assessment:decision}).strict().nullable(),
}).strict();
export const obligationsEntitlementInputSchema=z.object({schema_version:z.literal('obligations-entitlement-input-v1'),catalog_id:z.literal('il.review.explicit_obligations.2026'),catalog_version:z.literal('1.0.0'),case_id:z.string().min(1),run_id:z.string().min(1),check_prefix:z.string().regex(/^[a-z][a-z0-9._:-]{2,70}$/u),period,evaluated_at:z.iso.datetime(),
 purchased_topics:z.array(z.enum(['contract','bonuses'])).min(1).max(2),source_manifest:documentReviewCalculationInputSchema.shape.source_manifest,obligations:z.array(obligationSchema).max(32),
}).strict();
export type ObligationsEntitlementInput=z.infer<typeof obligationsEntitlementInputSchema>;
export type ExplicitObligation=z.infer<typeof obligationSchema>;
export type ObligationGap=Readonly<{obligation_id:string;topic:'contract'|'bonuses';dependency_id:string;state:string;kind:'missing_fact'|'missing_source'|'missing_applicability'|'missing_rule';question:string;answer_kind:'number'|'choice'|'text';options?:readonly string[];input_path:string;dependent_check_ids:readonly string[];source_required:boolean}>;
