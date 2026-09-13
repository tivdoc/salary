/** Presentation and form values only. The server validates the stored target,
 * actor, current source and answer before admitting any source relationship. */
export type SourceReadingBasis=Readonly<{page:number;locator:string;text:string}>;
export type SourceComponentKind='pension_employee'|'pension_employer'|'severance'|'combined_employer_funds';
export type SourceFundKind='pension'|'study'|'severance'|'combined'|'unknown';
export type SourceRelationshipKind='same_row'|'labelled_section'|'explicit_reference';
export type SourceDeductionGroup='mandatory'|'voluntary'|'unknown';
export type SourceRelationshipValue=Readonly<{kind:'source_relationship';relationship:'same_base'|'different_base';component_kind:SourceComponentKind;
 fund_kind:SourceFundKind;source_kind:SourceRelationshipKind;fund_label:string;basis:SourceReadingBasis}>;
export type SourceDeductionGroupValue=Readonly<{kind:'deduction_group';members:readonly Readonly<{component_id:string;group:SourceDeductionGroup}>[];inventory:'complete'|'partial';basis:SourceReadingBasis}>;
export type SourceBalanceMovementValue=Readonly<{kind:'balance_movement';state:'value';amount:string;unit:'days'|'hours'|'source_native_unknown';period:string;basis:SourceReadingBasis}
 |{kind:'balance_movement';state:'not_present';period:string;basis:SourceReadingBasis}>;
export type SourcePeriodAssociationValue=Readonly<{kind:'period_association';period_kind:'current'|'retroactive'|'cumulative';period:Readonly<{from:string;to:string}>;basis:SourceReadingBasis}>;
export type SourceStructureValue=SourceRelationshipValue|SourceDeductionGroupValue|SourceBalanceMovementValue|SourcePeriodAssociationValue;
export type SourceStructureContext=Readonly<
 {kind:'period_association';month:string;refs:readonly Readonly<{label:string;raw_value:string|null;page:number}>[];proposed_value:null}
 |{kind:'source_relationship';component_kind:SourceComponentKind;allows_explicit_confirmation?:boolean;contribution:Readonly<{label:string;raw_value:string|null;page?:number}>;base:Readonly<{label:string;raw_value:string|null;page?:number}>;proposed_value:SourceRelationshipValue|null}
 |{kind:'deduction_group';rows:readonly Readonly<{component_id:string;label:string;raw_value:string|null;page?:number}>[];allows_voluntary?:boolean;proposed_value:SourceDeductionGroupValue|null}
 |{kind:'balance_movement';group_id:string;label:string;cell:'opening'|'accrued'|'used'|'adjustments'|'closing';proposed_value:SourceBalanceMovementValue|null}>;
export type SourceStructureAction='confirm'|'correct'|'unknown'|'unreadable';
export type SourceStructureAnswer=Readonly<{schema_version:'document-field-answer-v3';action:'unknown'|'unreadable'}
 |{schema_version:'document-field-answer-v3';action:'confirm';structured_value:SourceRelationshipValue}
 |{schema_version:'document-field-answer-v3';action:'correct';structured_value:SourceStructureValue}>;
export const balanceMovementLabels={opening:'יתרה קודמת',accrued:'צבירה בתקופה',used:'ניצול בתקופה',adjustments:'התאמות',closing:'יתרה נוכחית'} as const;
export const deductionGroupLabels={mandatory:'ניכויי חובה',voluntary:'ניכויי רשות',unknown:'לא ניתן לקבוע'} as const;
export const sourcePeriodKindLabels={current:'החודש הנבדק',retroactive:'תקופה קודמת',cumulative:'נתון מצטבר'} as const;
export type SourceStructureDraft={page:string;locator:string;text:string;relationship:''|'same_base'|'different_base';members:Record<string,SourceDeductionGroup|''>;
 fund_kind:''|SourceFundKind;source_kind:''|SourceRelationshipKind;fund_label:string;inventory:''|'complete'|'partial';amount:string;unit:''|'days'|'hours'|'source_native_unknown';period:string;not_present:boolean;
 period_kind:''|SourcePeriodAssociationValue['period_kind'];period_from:string;period_to:string};
export function initialSourceStructureDraft(context:SourceStructureContext,saved?:string|null):{action:SourceStructureAction|null;draft:SourceStructureDraft}{
 let action:SourceStructureAction|null=null,value:SourceStructureValue|null=context.proposed_value;
 try{const parsed=JSON.parse(saved??'');if(parsed.schema_version==='document-field-answer-v3'&&['confirm','correct','unknown','unreadable'].includes(parsed.action)){
  action=parsed.action;if((parsed.action==='correct'||parsed.action==='confirm')&&parsed.structured_value?.kind===context.kind)value=parsed.structured_value;
 }}catch{/* An absent or historic draft supplies no source information. */}
 if(context.kind==='period_association'&&action==='confirm'){action=null;value=null;}
 const draft:SourceStructureDraft={page:'',locator:'',text:'',relationship:'',fund_kind:'',source_kind:'',fund_label:'',members:{},inventory:'',amount:'',unit:'',period:'',not_present:false,period_kind:'',period_from:'',period_to:''};
 if(value?.basis){draft.page=String(value.basis.page);draft.locator=value.basis.locator;draft.text=value.basis.text;}
 if(context.kind==='source_relationship'&&value?.kind==='source_relationship'&&value.component_kind===context.component_kind){draft.relationship=value.relationship;draft.fund_kind=value.fund_kind;draft.source_kind=value.source_kind;draft.fund_label=value.fund_label;}
 if(context.kind==='deduction_group'){
  for(const row of context.rows)draft.members[row.component_id]=value?.kind==='deduction_group'?value.members.find(m=>m.component_id===row.component_id)?.group??'':'';
  if(value?.kind==='deduction_group')draft.inventory=value.inventory;
 }
 if(context.kind==='balance_movement'&&value?.kind==='balance_movement'){
  draft.period=value.period;draft.not_present=value.state==='not_present'&&context.cell==='adjustments';
  if(value.state==='value'){draft.amount=value.amount;draft.unit=value.unit;}
 }
 if(context.kind==='period_association'){
  draft.page=context.refs.length&&new Set(context.refs.map(r=>r.page)).size===1?String(context.refs[0].page):'';
  if(value?.kind==='period_association'&&value.basis?.page===Number(draft.page)&&value.period
   &&['current','retroactive','cumulative'].includes(value.period_kind)&&typeof value.period.from==='string'&&typeof value.period.to==='string'){
   draft.period_kind=value.period_kind;draft.period_from=value.period.from;draft.period_to=value.period.to;
  }
 }
 return {action,draft};
}
/** Form completeness is convenience only; this does not establish truth. */
export function buildSourceStructureAnswer(context:SourceStructureContext,action:SourceStructureAction|null,draft:SourceStructureDraft):SourceStructureAnswer|null{
 if(action===null)return null;
 if(action==='unknown'||action==='unreadable')return {schema_version:'document-field-answer-v3',action};
 if(action==='confirm'&&(context.kind!=='source_relationship'||context.allows_explicit_confirmation!==true))return null;
 const page=Number(draft.page),locator=draft.locator.trim(),text=draft.text.trim();
 if(!/^\d+$/u.test(draft.page)||!Number.isSafeInteger(page)||page<1||page>100||!locator||locator.length>120||!text||text.length>160)return null;
 const basis={page,locator,text};let value:SourceStructureValue;
 if(context.kind==='source_relationship'){
  if(action==='correct'&&!['same_base','different_base'].includes(draft.relationship)
   ||!['pension','study','severance','combined','unknown'].includes(draft.fund_kind)||!['same_row','labelled_section','explicit_reference'].includes(draft.source_kind)
   ||!draft.fund_label.trim()||draft.fund_label.trim().length>160)return null;
  value={kind:context.kind,relationship:action==='confirm'?'same_base':draft.relationship as 'same_base'|'different_base',component_kind:context.component_kind,
   fund_kind:draft.fund_kind as SourceFundKind,source_kind:draft.source_kind as SourceRelationshipKind,fund_label:draft.fund_label.trim(),basis};
 }else if(context.kind==='deduction_group'){
  if(!context.rows.length||new Set(context.rows.map(r=>r.component_id)).size!==context.rows.length||!['complete','partial'].includes(draft.inventory))return null;
  const members=context.rows.map(row=>({component_id:row.component_id,group:draft.members[row.component_id]}));
  if(members.some(m=>!['mandatory','voluntary','unknown'].includes(m.group)))return null;
  if(draft.inventory==='complete'&&members.some(m=>m.group==='unknown'))return null;
  if(context.allows_voluntary!==true&&members.some(m=>m.group==='voluntary'))return null;
  value={kind:context.kind,members:members.map(m=>({...m,group:m.group as SourceDeductionGroup})),inventory:draft.inventory as 'complete'|'partial',basis};
 }else if(context.kind==='period_association'){
  const validDate=(v:string)=>/^\d{4}-\d{2}-\d{2}$/u.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
  if(!context.refs.length||context.refs.some(r=>r.page!==page)||!['current','retroactive','cumulative'].includes(draft.period_kind)
   ||!validDate(draft.period_from)||!validDate(draft.period_to)||draft.period_from>draft.period_to)return null;
  if(draft.period_kind==='current'){
   if(!/^\d{4}-(0[1-9]|1[0-2])$/u.test(context.month)||draft.period_from!==context.month+'-01'||draft.period_to.slice(0,7)!==context.month)return null;
   const following=new Date(draft.period_to+'T00:00:00Z');following.setUTCDate(following.getUTCDate()+1);
   if(following.getUTCDate()!==1)return null;
  }
  value={kind:context.kind,period_kind:draft.period_kind as SourcePeriodAssociationValue['period_kind'],period:{from:draft.period_from,to:draft.period_to},basis};
 }else{
  if(!/^\d{4}-(0[1-9]|1[0-2])$/u.test(draft.period))return null;
  if(draft.not_present){if(context.cell!=='adjustments')return null;value={kind:context.kind,state:'not_present',period:draft.period,basis};}
  else{
   if(!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(draft.amount.trim())||!['days','hours','source_native_unknown'].includes(draft.unit))return null;
   value={kind:context.kind,state:'value',amount:draft.amount.trim(),unit:draft.unit as 'days'|'hours'|'source_native_unknown',period:draft.period,basis};
  }
 }
 const answer:SourceStructureAnswer=action==='confirm'&&value.kind==='source_relationship'?{schema_version:'document-field-answer-v3',action:'confirm',structured_value:value}
  :{schema_version:'document-field-answer-v3',action:'correct',structured_value:value};
 return JSON.stringify(answer).length<=2000?answer:null;
}
export function displaySourceStructureAnswer(answerText:string,context?:SourceStructureContext):string|null{
 try{
  const answer=JSON.parse(answerText) as SourceStructureAnswer;if(answer.schema_version!=='document-field-answer-v3')return null;
  if(answer.action==='unknown')return context?.kind==='period_association'?'לא יודע — שיוך התקופה נשאר לא מאומת.':'לא יודע — שיוך המקור או תא היתרה נשארו לא מאומתים.';
  if(answer.action==='unreadable')return 'לא ניתן לקרוא את המקור הנדרש — הבדיקה התלויה בו נשארה חסרה.';
  if(answer.action!=='correct'&&answer.action!=='confirm')return null;
  const value=answer.structured_value;
  if(value.kind==='source_relationship')return `${value.relationship==='same_base'?'נשמר אישור מפורש לקשר לאותו בסיס':'נשמר שהרכיב אינו משויך לבסיס שהוצג'} — ${value.fund_label}. המספרים עצמם לא אושרו מחדש; אין בכך אישור להפקדה או לזכאות.`;
  if(value.kind==='deduction_group')return `שיוך השורות נשמר: ${value.members.map(m=>`${context?.kind==='deduction_group'?context.rows.find(r=>r.component_id===m.component_id)?.label??'שורה':'שורה'} — ${deductionGroupLabels[m.group]}`).join(' · ')}. מלאי המקור ${value.inventory==='complete'?'סומן כמלא':'נשאר חלקי'}.`;
  if(value.kind==='period_association')return `שיוך התקופה הועתק מהמקור: ${sourcePeriodKindLabels[value.period_kind]}, ${value.period.from} עד ${value.period.to}. המספרים נשמרו ללא אישור מחדש; אין בכך אישור לתשלום או לזכאות.`;
  return value.state==='not_present'?`נשמר שלא מופיעה שורת התאמות לתקופה ${value.period}. אין בכך הזנת אפס בתא חסר.`
   :`תא היתרה הועתק: ${value.amount} ${value.unit==='days'?'ימים':value.unit==='hours'?'שעות':'ביחידה שאינה מודפסת במקור'}, לתקופה ${value.period}. תאים אחרים לא אושרו.`;
 }catch{return null;}
}
