import type {DocumentReviewOperand,DocumentReviewSource} from '../document-review/calculations.ts';
import {NIGHT_ENTITLEMENT_DEPENDENCIES,type NightEntitlementInput} from './document-review-entitlement-night-work.ts';
import {NIGHT_ENTITLEMENT_CATALOG} from './document-review-entitlement-source-policy.ts';

const source:DocumentReviewSource={document_id:'synthetic.attendance',version_id:'synthetic.source.1',file_sha256:'a'.repeat(64),page:1,locator:'synthetic row',label:'מסמך בדיקה סינתטי',reading:'ai_document_review',reading_receipt_sha256:'b'.repeat(64)};
export function operand(id:string,raw:string|null,kind:'hours'|'money'|'percent'='hours'):DocumentReviewOperand{
 return {id,observation_id:'synthetic.'+id,state:raw===null?'missing':'observed',printed_value:raw,representation:kind==='hours'?'hours_minutes':kind==='money'?'money_ils':'percent',quantity_unit:kind==='hours'?'hours':kind==='percent'?'ratio':null,precision:'source_exact',source:{...source,locator:'synthetic '+id}};
}
export function syntheticNightInput():NightEntitlementInput{
 const wage=operand('wage','40.00','money');
 return {catalog_id:NIGHT_ENTITLEMENT_CATALOG.catalog_id,catalog_version:'1.0.0',case_id:'synthetic.case',run_id:'synthetic.run',check_id:'synthetic.night',period:{from:'2026-06-01',to:'2026-06-30'},evaluated_at:'2026-09-11T12:00:00Z',source_manifest:[{document_id:source.document_id,version_id:source.version_id,file_sha256:source.file_sha256,page_count:1,kind:'case_document',case_id:'synthetic.case'}],
  intervals:[{id:'synthetic.interval',date:'2026-06-02',start_time:'22:00',end_time:'08:00',clock_source:source,printed_presence:operand('presence','10:00'),classification:'work'}],hourly_wage:wage,
  payroll_allocations:[{id:'ordinary',hours:operand('ordinary','10:00'),hourly_rate:wage,percentage:null}],
  applicability:Object.keys(NIGHT_ENTITLEMENT_DEPENDENCIES).map(decision_id=>({decision_id,state:'accepted',basis:'ai_source_assessment',explanation:'Synthetic applicability fixture only; no human or REAL approval.',sources:[source],valid_until:null})),mode:'source_classified'};
}
