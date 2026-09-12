/** Client-safe form values only. Authentication, source purpose and receipt
 * construction stay in the protected server/journal path. */
import type {TravelTariffAnswer} from '@/engine/entitlement-review/travel/tariff-contracts';
export type TravelTariffContext=Readonly<{subject:'context'|'daily_fare'|'ticket_inventory'|'monthly_pass_cost';page:number;locator:string}>;
export type TravelTariffAction='correct'|'unknown'|'unreadable';
export type TravelTariffDraft={route_reference:string;discount_profile:string;from:string;to:string;directions:string;
 ticket_inventory:string;monthly_pass_availability:string;amount:string;locator:string;text:string};
export const travelTariffLabels={context:'פרטי המסלול ותקופת התעריף',daily_fare:'תעריף יומי מוזל',ticket_inventory:'אפשרויות הכרטיסים',monthly_pass_cost:'מחיר מנוי חודשי'} as const;
const record=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const string=(value:unknown)=>typeof value==='string'?value:'';
function isoDate(value:string){const time=Date.parse(value+'T00:00:00Z');return /^\d{4}-\d{2}-\d{2}$/u.test(value)&&Number.isFinite(time)&&new Date(time).toISOString().slice(0,10)===value;}
export function initialTravelTariffDraft(context:TravelTariffContext,saved?:string|null):{action:TravelTariffAction|null;draft:TravelTariffDraft}{
 const draft:TravelTariffDraft={route_reference:'',discount_profile:'',from:'',to:'',directions:'',ticket_inventory:'',monthly_pass_availability:'',amount:'',locator:context.locator,text:''};
 const empty={action:null,draft};
 let answer:Record<string,unknown>|null;try{answer=record(JSON.parse(saved??''));}catch{return empty;}
 if(answer?.schema_version!=='document-field-answer-v3')return empty;
 if(answer.action==='unknown'||answer.action==='unreadable')return {action:answer.action,draft};
 const structured=record(answer.structured_value),basis=record(structured?.basis);
 if(answer.action!=='correct'||structured?.kind!=='travel_tariff'||structured.subject!==context.subject||basis?.page!==context.page)return empty;
 draft.locator=string(basis.locator);draft.text=string(basis.text);
 const value=record(structured.value);
 if(context.subject==='context'){
  const period=record(value?.effective_period);draft.route_reference=string(value?.route_reference);draft.discount_profile=string(value?.discount_profile);
  draft.from=string(period?.from);draft.to=string(period?.to);draft.directions=string(value?.directions);
 }else if(context.subject==='ticket_inventory'){
  draft.ticket_inventory=string(value?.ticket_inventory);draft.monthly_pass_availability=string(value?.monthly_pass_availability);
 }else draft.amount=string(structured.value);
 return {action:'correct',draft};
}
export function buildTravelTariffAnswer(context:TravelTariffContext,action:TravelTariffAction|null,draft:TravelTariffDraft):TravelTariffAnswer|null{
 if(!action)return null;
 if(action==='unknown'||action==='unreadable')return {schema_version:'document-field-answer-v3',action};
 if(action!=='correct'||!Number.isInteger(context.page)||context.page<1||context.page>100)return null;
 const basis={page:context.page,locator:draft.locator.trim(),text:draft.text.trim()};
 if(!basis.locator||basis.locator.length>120||!basis.text||basis.text.length>160)return null;
 let structured:Extract<TravelTariffAnswer,{action:'correct'}>['structured_value'];
 if(context.subject==='context'){
  const route=draft.route_reference.trim(),profile=draft.discount_profile,directions=draft.directions;
  if(!route||route.length>200||(profile!=='standard_adult'&&profile!=='special_discount')
   ||!['both','outbound','return'].includes(directions)||!isoDate(draft.from)||!isoDate(draft.to)||draft.from>draft.to)return null;
  if(directions!=='both'&&directions!=='outbound'&&directions!=='return')return null;
  structured={kind:'travel_tariff',subject:'context',value:{route_reference:route,discount_profile:profile,effective_period:{from:draft.from,to:draft.to},directions},basis};
 }else if(context.subject==='ticket_inventory'){
  const inventory=draft.ticket_inventory,availability=draft.monthly_pass_availability;
  if((inventory!=='complete'&&inventory!=='partial')||(availability!=='available'&&availability!=='unavailable'))return null;
  structured={kind:'travel_tariff',subject:'ticket_inventory',value:{ticket_inventory:inventory,monthly_pass_availability:availability},basis};
 }else{
  const value=draft.amount.trim();if(!/^(0|[1-9]\d{0,8})(?:\.\d{1,2})?$/u.test(value))return null;
  structured={kind:'travel_tariff',subject:context.subject,value,basis};
 }
 const answer:TravelTariffAnswer={schema_version:'document-field-answer-v3',action:'correct',structured_value:structured};
 return JSON.stringify(answer).length<=2000?answer:null;
}
export function displayTravelTariffAnswer(value:string,context?:TravelTariffContext):string|null{
 if(!context)return null;
 const restored=initialTravelTariffDraft(context,value),answer=buildTravelTariffAnswer(context,restored.action,restored.draft);
 if(!answer)return null;
 if(answer.action==='unknown')return 'לא יודע — פרט התעריף נשאר חסר.';
 if(answer.action==='unreadable')return 'לא קריא — לא התקבל ערך תעריף מזוהה.';
 const v=answer.structured_value;
 if(v.subject==='daily_fare'||v.subject==='monthly_pass_cost')return `${travelTariffLabels[v.subject]} הועתק מהמקור: ${v.value} ₪. אין בכך אישור זכאות.`;
 if(v.subject==='context')return `פרטי המקור הועתקו למסלול ${v.value.route_reference}, לתקופה ${v.value.effective_period.from}–${v.value.effective_period.to}. הכיוונים ופרופיל ההנחה נשמרו; תחולתם נבדקת בנפרד.`;
 return `אפשרויות הכרטיסים הועתקו: ${v.value.ticket_inventory==='complete'?'המלאי הוגדר שלם לפי המקור':'מלאי חלקי'}; ${v.value.monthly_pass_availability==='available'?'מנוי חודשי זמין':'מנוי חודשי אינו זמין לפי המקור'}. מחיר חסר אינו ראיה לאי־זמינות.`;
}
