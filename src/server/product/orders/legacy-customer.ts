import 'server-only';
import {z} from 'zod';
import {resolveCaseAccessDb,type CaseAccessDb} from '../case-access/db';
import {LEGACY_PAID_TOPICS} from './legacy-paid-receipt';
export const legacyCustomerReceiptSchema=z.object({id:z.uuid(),kind:z.literal('legacy_initial'),origin:z.literal('legacy_paid_receipt'),
 topics:z.array(z.enum(LEGACY_PAID_TOPICS)).length(9).refine(v=>new Set(v).size===9),
 periods:z.array(z.object({from:z.iso.date(),to:z.iso.date()}).strict()),amount_minor:z.number().int().positive(),currency:z.literal('ILS'),
 period_state:z.enum(['missing','source_observed']),receipt_sha256:z.string().regex(/^[a-f0-9]{64}$/u),scope_basis:z.literal('legacy_initial_scope_not_versioned'),new_payment_required:z.literal(false)}).strict();
export async function legacyCustomerReceipts(caseId:string,identityId:string,db?:CaseAccessDb){
 z.uuid().parse(caseId);z.uuid().parse(identityId);
 const store=db??await resolveCaseAccessDb();if(!store)throw Error('LEGACY_RECEIPT_STORE');
 const rows=await store.rpc<{value:unknown}>('case_order_legacy_receipts',{target_case:caseId,target_identity:identityId});
 if(rows.length!==1)throw Error('LEGACY_RECEIPT_ACK');
 return z.array(legacyCustomerReceiptSchema).max(100).parse(rows[0].value);
}
