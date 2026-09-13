import type {DocumentEvidenceSourceAnswer,EvidenceSourceTranscriptionContext} from '@/engine/extraction/document-evidence/source-transcription';
export type EvidenceSourceAction=DocumentEvidenceSourceAnswer['action'];
export type EvidenceSourceDraft={raw_value:string;locator:string;page?:string};
/** Client form validation only. Server target/currentness checks are required. */
export function buildEvidenceSourceAnswer(action:EvidenceSourceAction|null,draft:EvidenceSourceDraft,context?:EvidenceSourceTranscriptionContext):DocumentEvidenceSourceAnswer|null{
 const schema_version=context?.page===null?'document-evidence-source-answer-v2' as const:'document-evidence-source-answer-v1' as const;
 if(action==='unknown'||action==='unreadable')return {schema_version,action};
 const raw_value=draft.raw_value.trim(),locator=draft.locator.trim();
 if(action!=='correct'||!raw_value.length||raw_value.length>1600||!locator.length||locator.length>120)return null;
 const page=Number(draft.page);
 if(context?.page===null&&(!/^[1-9][0-9]*$/u.test(draft.page??'')||!Number.isSafeInteger(page)||page>context.page_count))return null;
 const answer:DocumentEvidenceSourceAnswer=context?.page===null?{schema_version:'document-evidence-source-answer-v2',action,value:{page,raw_value,locator}}
  :{schema_version:'document-evidence-source-answer-v1',action,value:{raw_value,locator}};
 return answer&&JSON.stringify(answer).length<=2000?answer:null;
}
export function initialEvidenceSourceDraft(value?:string|null):{action:EvidenceSourceAction|null;draft:EvidenceSourceDraft}{
 try{
  const a=JSON.parse(value??'');
  if(a.schema_version==='document-evidence-source-answer-v1'||a.schema_version==='document-evidence-source-answer-v2'){
   if(a.action==='unknown'||a.action==='unreadable')return {action:a.action,draft:{raw_value:'',locator:''}};
   if(a.action==='correct'&&typeof a.value?.raw_value==='string'&&typeof a.value?.locator==='string'
    &&(a.schema_version==='document-evidence-source-answer-v1'||Number.isInteger(a.value.page)&&a.value.page>0&&a.value.page<=100))
    return {action:a.action,draft:{raw_value:a.value.raw_value,locator:a.value.locator,...(a.schema_version==='document-evidence-source-answer-v2'?{page:String(a.value.page)}:{})}};
  }
 }catch{/* Historical values are never interpreted as a proposed clause. */}
 return {action:null,draft:{raw_value:'',locator:''}};
}
export function displayEvidenceSourceAnswer(value:string|null):string|null{
 const a=initialEvidenceSourceDraft(value);
 if(a.action==='unknown')return 'לא יודע — לא נשמרה קריאה של סעיף כספי במקור.';
 if(a.action==='unreadable')return 'הסעיף אינו קריא — המקור נשמר ללא השלמת נוסח או סכום.';
 if(a.action==='correct')return `נשמרה העתקת סעיף מהמקור${a.draft.page?` בעמוד ${a.draft.page}`:''} במיקום ${a.draft.locator}: ${a.draft.raw_value}`;
 return null;
}
