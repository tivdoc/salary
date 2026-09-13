import {z} from 'zod';

const id=z.string().regex(/^[a-z][a-z0-9._:-]{2,159}$/u);
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const privateCalculationSourceSchema=z.object({
 document_id:z.string().min(1).max(160),version_id:z.string().min(1).max(160),file_sha256:sha,
 page:z.number().int().positive(),locator:z.string().min(1).max(500),
 label:z.string().min(1).max(300),reading:z.enum(['ai_document_review','provider_extraction']),
 reading_receipt_sha256:sha,human_verified:z.literal(false),
}).strict();
export const privateCalculationOperandSchema=z.object({
 id,source:privateCalculationSourceSchema,
 state:z.enum(['observed','missing','conflicted','unreadable']),
 printed_value:z.string().max(100).nullable(),
 representation:z.enum(['money_ils','decimal_quantity','hours_minutes','percent']),
 quantity_unit:z.enum(['hours','days','calendar_days','count','ratio']).nullable(),
 precision:z.enum(['printed_precision','source_exact']),
}).strict();
export type PrivateCalculationOperand=z.infer<typeof privateCalculationOperandSchema>;
export const privateCalculationInputSchema=z.object({
 schema_version:z.literal('private-document-arithmetic-input-v1'),work_id:id,check_id:id,
 period:z.object({from:z.iso.date(),to:z.iso.date()}).strict(),
 source_manifest:z.array(z.object({document_id:z.string().min(1),version_id:z.string().min(1),file_sha256:sha,page_count:z.number().int().positive()}).strict()).min(1).max(32),
 operands:z.array(privateCalculationOperandSchema).min(2).max(32),
 operation:z.discriminatedUnion('kind',[
  z.object({kind:z.literal('product'),money_ref:id,factor_refs:z.array(id).min(1).max(2),recorded_ref:id,
   rounding:z.enum(['exact','toward_zero','half_up','half_even']),rounding_basis:z.string().min(1).max(500)}).strict(),
  z.object({kind:z.literal('reconciliation'),add_refs:z.array(id).min(1).max(24),subtract_refs:z.array(id).max(24),recorded_ref:id,
   inventory_basis:z.string().min(1).max(500),inventory_complete:z.boolean()}).strict(),
 ]),
}).strict();
export type PrivateCalculationInput=z.infer<typeof privateCalculationInputSchema>;
