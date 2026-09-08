import 'server-only';
import {z} from 'zod';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';

const cancellation=z.object({caseId:z.uuid(),identityId:z.uuid(),orderId:z.uuid(),reason:z.enum(['customer_changed_scope','source_changed','quote_expired'])}).strict();
/** Only an order with no provider attempt/payment/entitlement may release its
 * credit. This is not a refund and never resolves an uncertain external charge.
 * Caller owns the verified worker transaction, including rollback on failure. */
export async function cancelUnstartedQuotedOrder(context:PostgresTransactionContext,candidate:z.infer<typeof cancellation>){
 const input=cancellation.parse(candidate);
 const result=await context.client.query(statement('quoted_order_cancel_unstarted',
  'select private.order_quote_cancel_unstarted($1::uuid,$2::uuid,$3::uuid,$4) value',
  [input.caseId,input.identityId,input.orderId,input.reason]));
 return z.object({order_id:z.literal(input.orderId),state:z.literal('cancelled'),replayed:z.boolean()}).strict().parse(result.rows[0]?.value);
}
