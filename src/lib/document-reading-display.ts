/** Client-safe presentation contract. Targets, hashes and verification remain server-side. */
import {displaySourceStructureAnswer,type SourceStructureContext} from './source-structure-display';
export type {SourceStructureContext,SourceStructureValue,SourceRelationshipValue,SourceDeductionGroupValue,SourceBalanceMovementValue} from './source-structure-display';
export type DocumentReadingDisplay=Readonly<{
 question:string;field:string;raw_value:string|null;page:number;text_fragment:string|null;
 bounding_box:{x:number;y:number;width:number;height:number;coordinate_space:'normalized'|'pixels'}|null;
 /** Only the new row-cell target supplies this server-derived opaque key.
  * Its source/version/component identity is never inferred from the label. */
 row_context?:Readonly<{group_id:string;label:string;cell:'quantity'|'rate'|'amount'|'percentage'}>;
 /** Missing source information has no existing value that can be confirmed. */
 transcription_context?:Readonly<{kind:'reported_work_hours'|'balance_unit'}>;
 structure_context?:SourceStructureContext;
 dependent_checks?:readonly string[];
}>;
export const documentRowCellLabels={quantity:'כמות',rate:'תעריף ליחידה',amount:'סכום',percentage:'שיעור'} as const;

type ReadingRequest=Readonly<{id:string;source_current?:boolean;reading_display?:DocumentReadingDisplay}>;
export type DocumentReadingRequestGroup<T>=Readonly<{kind:'single';requests:readonly[T]}|{kind:'row';requests:readonly T[];group_id:string;label:string;page:number}|{kind:'balance';requests:readonly T[];group_id:string;label:string;page:number}>;
/** Presentation only. Ambiguous or repeated cells remain separate actions. */
export function groupDocumentReadingRequests<T extends ReadingRequest>(requests:readonly T[]):readonly DocumentReadingRequestGroup<T>[] {
 const context=(r:T)=>r.reading_display?.structure_context?.kind==='balance_movement'?{...r.reading_display.structure_context,kind:'balance' as const}
  :r.reading_display?.row_context?{kind:'row' as const,...r.reading_display.row_context}:null;
 const eligible=(r:T)=>{const c=context(r);return r.source_current===true&&c&&/^[a-f0-9]{64}$/u.test(c.group_id)?`${c.kind}:${c.group_id}`:null;};
 const buckets=new Map<string,T[]>();
 for(const request of requests){const key=eligible(request);if(key)buckets.set(key,[...(buckets.get(key)??[]),request]);}
 const valid=new Set([...buckets].filter(([,rows])=>rows.length>1
  &&new Set(rows.map(r=>context(r)!.cell)).size===rows.length
  &&new Set(rows.map(r=>context(r)!.label)).size===1
  &&new Set(rows.map(r=>r.reading_display!.page)).size===1).map(([key])=>key));
 const used=new Set<string>(),result:DocumentReadingRequestGroup<T>[]=[];
 for(const request of requests){const key=eligible(request);
  if(!key||!valid.has(key)){result.push({kind:'single',requests:[request]});continue;}
  if(used.has(key))continue;used.add(key);
  const c=context(request)!;result.push({kind:c.kind,requests:buckets.get(key)!,group_id:c.group_id,label:c.label,page:request.reading_display!.page});
 }
 return result;
}
export function displayDocumentReadingAnswer(value:string|null,display?:DocumentReadingDisplay):string|null{
 if(!value)return value;
 const structured=displaySourceStructureAnswer(value,display?.structure_context);if(structured!==null)return structured;
 try{
  const answer=JSON.parse(value) as {schema_version?:unknown;action?:unknown;corrected_raw_value?:unknown};
  if(answer.schema_version!=='document-field-answer-v2')return value;
  if(answer.action==='confirm')return 'הערך שמופיע בשאלה אושר כקריאה של התא במסמך.';
  if(answer.action==='correct'&&typeof answer.corrected_raw_value==='string'){
   if(display?.transcription_context?.kind==='balance_unit'){
    const unit=({'days':'ימים','hours':'שעות','ימים':'ימים','שעות':'שעות'} as Record<string,string>)[answer.corrected_raw_value];
    if(unit)return `יחידת היתרה הועתקה מהמסמך: ${unit}. המספר המקורי נשמר ללא שינוי.`;
   }
   if(display?.transcription_context?.kind==='reported_work_hours')return `סך השעות המדווחות הועתק מהמסמך: ${answer.corrected_raw_value}. אין בכך סיווג כשעות רגילות או בתשלום.`;
   return `הקריאה תוקנה לערך: ${answer.corrected_raw_value}`;
  }
  if(answer.action==='unknown')return 'לא יודע — הקריאה נשארה לא מאומתת.';
  if(answer.action==='unreadable')return 'התא אינו קריא — נדרש מקור ברור יותר.';
 }catch{/* Historical plain answers remain plain. */}
 return value;
}
