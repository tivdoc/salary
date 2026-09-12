/** Client presentation only; the server validates the immutable target and journal. */
export type SourcePeriodIntakeContext=Readonly<{page_count:number;month:null}>;
export const sourcePeriodIntakeKinds={payslip:'תלוש שכר',attendance:'דוח נוכחות',contract:'חוזה עבודה',other:'מסמך אחר'} as const;
export type SourcePeriodIntakeAction='correct'|'unknown'|'unreadable';
export type SourcePeriodIntakeDraft={document_kind:string;period_shown:string;from:string;to:string;page:string;source_label:string};
const empty=():SourcePeriodIntakeDraft=>({document_kind:'',period_shown:'',from:'',to:'',page:'',source_label:''});
function date(value:string){return /^\d{4}-\d{2}-\d{2}$/u.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
export function buildSourcePeriodIntakeAnswer(context:SourcePeriodIntakeContext,action:SourcePeriodIntakeAction|null,draft:SourcePeriodIntakeDraft){
 if(!Number.isInteger(context.page_count)||context.page_count<1||context.page_count>100||context.month!==null)return null;
 if(action==='unknown'||action==='unreadable')return {v:1 as const,action};
 if(action!=='correct'||!Object.hasOwn(sourcePeriodIntakeKinds,draft.document_kind)||!['yes','no'].includes(draft.period_shown))return null;
 const page=Number(draft.page),label=draft.source_label.trim();
 if(!/^\d+$/u.test(draft.page)||!Number.isInteger(page)||page<1||page>context.page_count||!label||label.length>400)return null;
 if(draft.period_shown==='yes'&&(!date(draft.from)||!date(draft.to)||draft.from>draft.to))return null;
 return {v:1 as const,action,value:{document_kind:draft.document_kind as keyof typeof sourcePeriodIntakeKinds,
  period:draft.period_shown==='yes'?{from:draft.from,to:draft.to}:null,page,source_label:label}};
}
export function initialSourcePeriodIntakeDraft(context:SourcePeriodIntakeContext,raw:string|null|undefined):{action:SourcePeriodIntakeAction|null;draft:SourcePeriodIntakeDraft}{
 const initial={action:null,draft:empty()};
 try{
  const answer=JSON.parse(raw??'');if(answer.v!==1)return initial;
  if(answer.action==='unknown'||answer.action==='unreadable')return {action:answer.action,draft:empty()};
  if(answer.action!=='correct'||!answer.value)return initial;
  const v=answer.value,draft={document_kind:v.document_kind,period_shown:v.period===null?'no':'yes',from:v.period?.from??'',to:v.period?.to??'',page:String(v.page),source_label:v.source_label};
  return buildSourcePeriodIntakeAnswer(context,'correct',draft)?{action:'correct',draft}:initial;
 }catch{return initial;}
}
export function displaySourcePeriodIntakeAnswer(raw:string,context?:SourcePeriodIntakeContext):string|null{
 if(!context)return null;
 const result=initialSourcePeriodIntakeDraft(context,raw);
 if(result.action==='unknown')return 'לא ידוע — סוג המסמך והתקופה נשארו להשלמה.';
 if(result.action==='unreadable')return 'לא ניתן לקרוא את פרטי המקור — נדרש מקור ברור יותר.';
 if(result.action==='correct'){
  const answer=buildSourcePeriodIntakeAnswer(context,result.action,result.draft);if(!answer||!('value'in answer)||!answer.value)return null;
  const v=answer.value;return `${sourcePeriodIntakeKinds[v.document_kind]} · ${v.period?`${v.period.from} – ${v.period.to}`:'לא מופיעה תקופה במסמך'} · עמוד ${v.page}: ${v.source_label}. הפרט הועתק מהמקור; אין בכך אישור זכאות או דוח.`;
 }
 return 'קריאת סוג המסמך והתקופה אינה זמינה להצגה.';
}
