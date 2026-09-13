import {z} from 'zod';

const timestamp=z.coerce.date().transform(value=>value.toISOString());
const count=z.coerce.number().int().safe().nonnegative();
/** Operational metadata is deliberately smaller than an authority packet.
 * record_present says nothing about signature or legal admission readiness. */
export const managedWorkerHealthSchema=z.object({
 checked_at:timestamp,last_activity_at:timestamp.nullable(),capability_expires_at:timestamp,
 daily_claims:count,total_claims:count,daily_limit:count.refine(value=>value>0),total_limit:count.refine(value=>value>0),
 cases:z.array(z.object({case_id:z.uuid(),pending_requests:count,
  authority_state:z.enum(['missing','record_present','expired','revoked','invalidated']),
  authority_expires_at:timestamp.nullable(),
 }).strict()).max(20),
}).strict().refine(value=>new Set(value.cases.map(row=>row.case_id)).size===value.cases.length);
export type ManagedWorkerHealth=z.infer<typeof managedWorkerHealthSchema>;

export function summarizeManagedWorkerHealth(health:ManagedWorkerHealth){
 const snapshot=managedWorkerHealthSchema.parse(health);
 const age=snapshot.last_activity_at===null?null:Math.max(0,Date.parse(snapshot.checked_at)-Date.parse(snapshot.last_activity_at));
 return {
  daily_remaining:Math.max(0,snapshot.daily_limit-snapshot.daily_claims),
  total_remaining:Math.max(0,snapshot.total_limit-snapshot.total_claims),
  budget_exhausted:snapshot.daily_claims>=snapshot.daily_limit||snapshot.total_claims>=snapshot.total_limit,
  pending_requests:snapshot.cases.reduce((sum,row)=>sum+row.pending_requests,0),
  authority_expired:snapshot.cases.filter(row=>row.authority_state==='expired').length,
  // No recent work is normal for an idle queue. A supervisor tick receipt is
  // the separate evidence that the scheduled process is alive.
  work_activity:age===null?'never_observed' as const:age>5*60000?'no_recent_work' as const:'recent_work' as const,
 };
}
