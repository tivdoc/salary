import {z} from 'zod';
import {documentReviewCalculationInputSchema} from '../../document-review/calculations.ts';

export const PENSION_SOURCE_FACTS_POLICY='pension-identified-source-facts-v1' as const;
export const PENSION_STATUTORY_FLOOR_POLICY='pension-statutory-floor-v2' as const;
const source=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const period=z.object({from:z.iso.date(),to:z.iso.date()}).strict().refine(p=>p.from<=p.to,'PENSION_SOURCE_PERIOD_ORDER');
const fact=<T extends z.ZodType>(value:T)=>z.object({state:z.enum(['observed','missing','unknown','conflict','stale','expired','unreadable']),value:value.nullable(),source:source.nullable()}).strict()
 .refine(f=>f.state!=='observed'||'value' in f&&f.value!==null&&f.source?.reading==='identified_document_reading','PENSION_IDENTIFIED_SOURCE_FACT');
/** A source assertion identifies the selected base, not legal compliance of
 * every remuneration component. The floor policy keeps that limit explicit. */
export const pensionSourceFactsSchema=z.object({schema_version:z.literal(PENSION_SOURCE_FACTS_POLICY),
 wage_basis:fact(z.object({period,operand_sha256:hash,composition:z.literal('explicit_all_pensionable_components'),
  basis_kind:z.literal('identified_contract_amount')}).strict()),
 eligible_interval_basis:fact(z.object({period,operand_sha256:hash,composition:z.literal('explicit_all_pensionable_components'),
  basis_kind:z.literal('identified_contract_amount')}).strict()),
 prior_insurance:fact(z.object({period,product:z.literal('pension_fund'),coverage:z.literal('active')}).strict()),
 arrangement:fact(z.object({period,employee_percent:z.string().regex(/^\d+(?:\.\d{1,4})?$/u),employer_percent:z.string().regex(/^\d+(?:\.\d{1,4})?$/u),
  severance_percent:z.string().regex(/^\d+(?:\.\d{1,4})?$/u),product:z.literal('pension_fund')}).strict()),
}).strict();
export type PensionSourceFacts=z.infer<typeof pensionSourceFactsSchema>;
export function emptyPensionSourceFacts():PensionSourceFacts{const missing={state:'missing',value:null,source:null};return pensionSourceFactsSchema.parse({schema_version:PENSION_SOURCE_FACTS_POLICY,
 wage_basis:missing,eligible_interval_basis:missing,prior_insurance:missing,arrangement:missing});}
