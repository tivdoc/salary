import {z} from 'zod';
import {CASE_ANALYSIS_CODE_VERSION} from '@/engine/case-analysis/contracts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {WAVE3_TOPICS} from '@/engine/wave3/contracts';
import {JUNE2026_REVIEW_CATALOG_SHA256} from '@/engine/legal-operations/june2026-catalog';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {SAVED_DRAFT_TEMPLATE} from './saved-draft-report';
import type {SourceJob} from './source-dispatch';
import {parseLegacyPaidScope,legacyPaidMonthlyScope,type LegacyPaidScope} from '../orders/legacy-paid-receipt';

const monthDate=z.iso.date().refine(value=>value.endsWith('-01'));
export const savedOrderSchema=z.object({id:z.uuid(),kind:z.enum(['initial','full']),from:monthDate,to:monthDate,
 topics:z.array(z.enum(WAVE3_TOPICS)).min(1).max(7).refine(value=>new Set(value).size===value.length),
 offer_sha256:z.string().regex(/^[a-f0-9]{64}$/)}).refine(value=>value.from<=value.to&&(value.kind!=='initial'||value.from===value.to&&value.topics.length<=3));
export type SavedOrderScope=z.infer<typeof savedOrderSchema>;
export type SavedLegacyOrderScope={id:string;kind:'legacy_initial';origin:'legacy_paid_receipt';from:string;to:string;
 topics:LegacyPaidScope['topics'];receipt_sha256:string;months:string[];legacy_scope:LegacyPaidScope};
export type SavedExecutionOrder=SavedOrderScope|SavedLegacyOrderScope;
export const savedOrderReceiptSha256=(order:SavedExecutionOrder)=>order.kind==='legacy_initial'?order.receipt_sha256:order.offer_sha256;
export const savedOrderOrigin=(order:SavedExecutionOrder)=>order.kind==='legacy_initial'?'legacy_paid_receipt' as const:'saved_order' as const;
/** Executor capabilities are distinct from the purchased scope, which remains intact in document review. */
export const savedOrderLegalTopics=(order:SavedExecutionOrder)=>order.topics.filter((topic):topic is typeof WAVE3_TOPICS[number]=>WAVE3_TOPICS.includes(topic as typeof WAVE3_TOPICS[number]));
export function savedLegacyExecutionScope(candidate:unknown):SavedLegacyOrderScope|null{
 const scope=parseLegacyPaidScope(candidate),months=new Set<string>();
 for(const evidence of scope.periods){
  let year=Number(evidence.period.from.slice(0,4)),month=Number(evidence.period.from.slice(5,7));
  for(let count=0;count<600;count++){
   const value=`${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}`;
   if(value+'-01'>evidence.period.to)break;
   if(legacyPaidMonthlyScope(scope,value).state==='ready')months.add(value);
   if(month===12){year++;month=1;}else month++;
   if(count===599&&`${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}-01`<=evidence.period.to)throw Error('ORDER_PERIOD_REQUIRES_OPERATIONS');
  }
 }
 const covered=[...months].sort();
 // Missing historical periods remain metadata, never an invented executable month.
 if(!covered.length)return null;
 return {id:scope.id,kind:scope.kind,origin:scope.origin,from:covered[0]+'-01',to:covered.at(-1)+'-01',topics:scope.topics,
  receipt_sha256:scope.receipt_sha256,months:covered,legacy_scope:scope};
}

export function savedMonthIdempotencyKey(job:SourceJob,orderId:string,month:string){
 return `saved-month:${canonicalSha256({job,order_id:orderId,month,template:SAVED_DRAFT_TEMPLATE,engine:CASE_ANALYSIS_CODE_VERSION,
  ...(month==='2026-06'?{review_catalog_sha256:JUNE2026_REVIEW_CATALOG_SHA256}:{})})}`;
}

export function purchasedMonths(candidate:SavedExecutionOrder){
 if(candidate.kind==='legacy_initial'){
  const verified=savedLegacyExecutionScope(candidate.legacy_scope);
  if(!verified||canonicalSha256(verified)!==canonicalSha256(candidate))throw Error('SAVED_ORDER_SCOPE');
  return [...verified.months];
 }
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
  `select v.input->'orders' orders,v.input->'legacy_orders' legacy_orders,
   private.legacy_paid_scopes(v.case_id) current_legacy_orders,coalesce((select jsonb_agg(jsonb_build_object(
   'id',o.id,'kind',o.kind,'from',o.period_from,'to',o.period_to,'topics',o.topics,'offer_sha256',o.offer_sha256))
   from private.product_orders o join private.order_entitlements e on e.order_id=o.id
   where o.case_id=v.case_id and o.state='paid' and o.refund_state<>'refunded' and e.state='active'),'[]'::jsonb) current_orders
   from private.case_input_versions v where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$3`,
  [job.case_id,job.revision,job.input_sha256]));
 const row=result.rows[0];if(!row)throw new Error('SAVED_ORDER_SCOPE');
 const legacy=(value:unknown)=>z.array(z.unknown()).parse(value??[]).map(savedLegacyExecutionScope).filter((o):o is SavedLegacyOrderScope=>o!==null);
 const pinned:SavedExecutionOrder[]=[...z.array(savedOrderSchema).parse(row.orders??[]),...legacy(row.legacy_orders)];
 const current:SavedExecutionOrder[]=[...z.array(savedOrderSchema).parse(row.current_orders??[]),...legacy(row.current_legacy_orders)];
 if(new Set(pinned.map(o=>o.id)).size!==pinned.length)throw new Error('SAVED_ORDER_SCOPE');
 const selected=orderId?pinned.filter(o=>o.id===orderId):pinned;
 if(selected.length===0)throw new Error('SAVED_ORDER_SCOPE');
 for(const order of selected){
  const actual=current.filter(o=>o.id===order.id);
  if(actual.length!==1||canonicalSha256(actual[0])!==canonicalSha256(order))throw new Error('SAVED_ORDER_ENTITLEMENT_REQUIRED');
 }
 return selected.sort((a,b)=>a.id.localeCompare(b.id));
}
