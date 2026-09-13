export const RETENTION_POLICY=Object.freeze({version:'tivdoc-retention-v1',document_days:90,case_inactive_months:24,orphan_minimum_days:7,deletion_grace_days:7,draft_days:30,review_days:365,accounting:'max_tax_year_end_plus_7_years_filing_plus_6_years'});
export type RetentionInput={kind:'document'|'case'|'orphan'|'draft'|'accounting';createdAt:string;lastActivityAt:string;now:string;references:readonly string[];holds:readonly string[];taxYear?:number;taxReturnFiledAt?:string};
/** Retention targets are company policy; holds and actual references always win. */
export function retentionDecision(input:RetentionInput){
 const start=Date.parse(input.createdAt),activity=Date.parse(input.lastActivityAt),now=Date.parse(input.now);if(![start,activity,now].every(Number.isFinite)||start>now||activity>now)throw new Error('RETENTION_DATE_INVALID');
 const reasons=[...input.holds.map(s=>'hold:'+s),...input.references.map(s=>'reference:'+s)];let eligibleAt:number|null=null;
 if(input.kind==='accounting'){
  if(!input.taxYear||!input.taxReturnFiledAt)reasons.push('accounting_filing_evidence_required');
  else{const filed=new Date(input.taxReturnFiledAt);if(!Number.isFinite(filed.valueOf()))throw new Error('RETENTION_DATE_INVALID');filed.setUTCFullYear(filed.getUTCFullYear()+6);eligibleAt=Math.max(Date.UTC(input.taxYear+8,0,1),filed.valueOf());}
 }else if(input.kind==='case'){const date=new Date(activity);date.setUTCMonth(date.getUTCMonth()+RETENTION_POLICY.case_inactive_months);eligibleAt=date.valueOf();}
 else eligibleAt=(input.kind==='draft'?activity:start)+86400000*(input.kind==='orphan'?RETENTION_POLICY.orphan_minimum_days:input.kind==='draft'?RETENTION_POLICY.draft_days:RETENTION_POLICY.document_days);
 if(eligibleAt!==null&&eligibleAt>now)reasons.push('retention_period');
 return {policy:RETENTION_POLICY.version,decision:reasons.length||eligibleAt===null?'retain' as const:'eligible_after_grace' as const,eligibleAt:eligibleAt===null?null:new Date(eligibleAt).toISOString(),reasons:[...new Set(reasons)].sort()};
}
