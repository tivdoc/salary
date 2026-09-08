import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {WAVE3_TOPICS} from '@/engine/wave3/contracts';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {SAVED_DRAFT_TEMPLATE} from './saved-draft-report';
import type {SourceJob} from './source-dispatch';

const monthDate=z.iso.date().refine(value=>value.endsWith('-01'));
export const savedOrderSchema=z.object({id:z.uuid(),kind:z.enum(['initial','full']),from:monthDate,to:monthDate,
 topics:z.array(z.enum(WAVE3_TOPICS)).min(1).max(7).refine(value=>new Set(value).size===value.length),
 offer_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).refine(value=>value.from<=value.to&&(value.kind!=='initial'||value.from===value.to));
export type SavedOrderScope=z.infer<typeof savedOrderSchema>;

export function savedMonthIdempotencyKey(job:SourceJob,orderId:string,month:string){
 return `saved-month:${canonicalSha256({job,order_id:orderId,month,template:SAVED_DRAFT_TEMPLATE,engine:'case-analysis@0.6.3'})}`;
}

export function purchasedMonths(candidate:SavedOrderScope){
 const order=savedOrderSchema.parse(candidate);
 const start=Number(order.from.slice(0,4))*12+Number(order.from.slice(5,7))-1;
 const end=Number(order.to.slice(0,4))*12+Number(order.to.slice(5,7))-1;
 // Same bound as order creation. Never silently truncate purchased scope.
 if(end-start+1>600)throw new Error('ORDER_PERIOD_REQUIRES_OPERATIONS');
 return Array.from({length:end-start+1},(_,index)=>{
  const absolute=start+index;
  return `${String(Math.floor(absolute/12)).padStart(4,'0')}-${String(absolute%12+1).padStart(2,'0')}`;
 });
}

/** Called after the case/source lock. Each selected paid scope must still have
 * its own active entitlement and immutable offer; another paid order is not a substitute. */
export async function readSavedOrders(context:PostgresTransactionContext,job:SourceJob,orderId?:string){
 const result=await context.client.query(statement('saved_order_entitlements',
  `select v.input->'orders' orders,coalesce((select jsonb_agg(jsonb_build_object(
   'id',o.id,'kind',o.kind,'from',o.period_from,'to',o.period_to,'topics',o.topics,'offer_sha256',o.offer_sha256))
   from private.product_orders o join private.order_entitlements e on e.order_id=o.id
   where o.case_id=v.case_id and o.state='paid' and o.refund_state<>'refunded' and e.state='active'),'[]'::jsonb) current_orders
   from private.case_input_versions v where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$3`,
  [job.case_id,job.revision,job.input_sha256]));
 const row=result.rows[0];if(!row)throw new Error('SAVED_ORDER_SCOPE');
 const pinned=z.array(savedOrderSchema).min(1).parse(row.orders),current=z.array(savedOrderSchema).parse(row.current_orders);
 if(new Set(pinned.map(o=>o.id)).size!==pinned.length)throw new Error('SAVED_ORDER_SCOPE');
 const selected=orderId?pinned.filter(o=>o.id===orderId):pinned;
 if(selected.length===0)throw new Error('SAVED_ORDER_SCOPE');
 for(const order of selected){
  const actual=current.filter(o=>o.id===order.id);
  if(actual.length!==1||canonicalSha256(actual[0])!==canonicalSha256(order))throw new Error('SAVED_ORDER_ENTITLEMENT_REQUIRED');
 }
 return selected.sort((a,b)=>a.id.localeCompare(b.id));
}
