import {z} from 'zod';
const entry=z.object({case_id:z.uuid(),employment_id:z.string().min(1),topic:z.enum(['vacation','sick_leave']),month:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),unit:z.enum(['calendar_days_hundredths','workdays_hundredths','hours_hundredths']),opening:z.number().int().safe().nullable(),accrued:z.number().int().safe().nullable(),used:z.number().int().safe().nullable(),closing:z.number().int().safe().nullable(),evidence_ids:z.array(z.string().min(1)).min(1)}).strict();
export type LeaveLedgerEntry=z.infer<typeof entry>;
/** Reconciliation of source facts only: no invented accrual, expiry, payout, or
 * conversion between calendar days, workdays and hours. Missing stays missing. */
export function reconcileLeaveLedger(input:readonly LeaveLedgerEntry[]){
 const entries=z.array(entry).parse(input).sort((a,b)=>a.month.localeCompare(b.month));
 const issues:{month:string;code:string;evidence_ids:string[]}[]=[];
 const issue=(row:LeaveLedgerEntry,code:string)=>issues.push({month:row.month,code,evidence_ids:row.evidence_ids});
 const first=entries[0];let prior:LeaveLedgerEntry|undefined;
 for(const row of entries){
  if(row.case_id!==first.case_id||row.employment_id!==first.employment_id||row.topic!==first.topic)throw new Error('LEDGER_SCOPE');
  if(row.unit!==first.unit)issue(row,'ledger_unit_conflict');
  if([row.opening,row.accrued,row.used,row.closing].some(v=>v===null))issue(row,'ledger_missing_fact');
  else if(BigInt(row.opening!)+BigInt(row.accrued!)-BigInt(row.used!)!==BigInt(row.closing!))issue(row,'ledger_arithmetic_conflict');
  if(prior){
   const serial=(m:string)=>Number(m.slice(0,4))*12+Number(m.slice(5));
   const gap=serial(row.month)-serial(prior.month);
   if(gap===0)issue(row,'ledger_duplicate_month');
   else if(gap!==1)issue(row,'ledger_missing_month');
   else if(prior.closing!==null&&row.opening!==null&&prior.closing!==row.opening)issue(row,'ledger_opening_conflict');
  }
  prior=row;
 }
 return {entries,issues,complete:entries.length>0&&issues.length===0};
}
