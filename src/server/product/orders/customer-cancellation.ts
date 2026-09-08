import 'server-only';
import {z} from 'zod';
import {resolveCaseAccessDb,type CaseAccessDb} from '../case-access/db';

const requestSchema=z.object({caseId:z.uuid(),identityId:z.uuid(),orderId:z.uuid()}).strict();
/** The HTTP route supplies session-derived identity/case. The scoped RPC locks
 * case then order and refuses any checkout, payment, entitlement or refund. */
export async function cancelCustomerUnstartedOrder(candidate:z.infer<typeof requestSchema>,db?:CaseAccessDb){
 const input=requestSchema.parse(candidate),store=db??await resolveCaseAccessDb();
 if(!store)throw Error('ORDER_STORE_UNAVAILABLE');
 const rows=await store.rpc<{value:unknown}>('case_order_cancel_unstarted',{target_case:input.caseId,target_identity:input.identityId,target_order:input.orderId});
 if(rows.length!==1)throw Error('ORDER_CANCEL_ACKNOWLEDGEMENT_INVALID');
 return z.object({order_id:z.literal(input.orderId),state:z.literal('cancelled'),replayed:z.boolean()}).strict().parse(rows[0]?.value);
}
