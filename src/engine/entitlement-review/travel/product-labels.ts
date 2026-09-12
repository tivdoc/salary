/** Product labels only. Answers remain sourced declarations; these mappings do
 * not accept applicability, a fare, a paid trip, or an authoritative source. */
export const TRAVEL_PRODUCT_FACT_LABELS={
 'facts.needs_transport':{'כן':true,'לא':false,'לא ידוע':null},
 'facts.employer_transport':{'אין הסעה':'none','לעבודה בלבד':'outbound','מהעבודה בלבד':'return','בשני הכיוונים':'both','משתנה לפי תאריך':'mixed','לא ידוע':null},
 'facts.free_travel':{'אין זכאות לנסיעה חינם':'none','לעבודה בלבד':'outbound','מהעבודה בלבד':'return','בשני הכיוונים':'both','משתנה לפי תאריך':'mixed','לא ידוע':null},
 'monthly_pass':{'קיים מנוי מתאים':'available','לא קיים מנוי מתאים':'unavailable','לא ידוע':null},
} as const;
export type TravelProductFactPath=keyof typeof TRAVEL_PRODUCT_FACT_LABELS;
export type TravelProductFactValue=boolean|'none'|'outbound'|'return'|'both'|'mixed'|'available'|'unavailable'|null;
export function travelProductAnswerField(path:string):Readonly<{answer_kind:'choice';options:readonly string[];decode:(raw:string)=>TravelProductFactValue}>|null{
 if(!Object.hasOwn(TRAVEL_PRODUCT_FACT_LABELS,path))return null;
 const labels:Readonly<Record<string,TravelProductFactValue>>=TRAVEL_PRODUCT_FACT_LABELS[path as TravelProductFactPath];
 return {answer_kind:'choice',options:Object.keys(labels),decode(raw){const label=raw.trim();if(!Object.hasOwn(labels,label))throw Error('TRAVEL_PRODUCT_ANSWER_VALUE');return labels[label];}};
}
