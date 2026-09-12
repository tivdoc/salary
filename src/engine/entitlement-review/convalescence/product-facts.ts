import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewSource} from '../../document-review/calculations.ts';

const source=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const fact=<T extends z.ZodType>(value:T)=>z.object({state:z.enum(['observed','declared','missing','unknown','conflict','stale','expired','unreadable']),value:value.nullable(),source:source.nullable()}).strict();
export const CONVALESCENCE_PERSONAL_FACTS_POLICY='convalescence-personal-facts-v1' as const;
const date=fact(z.iso.date());
export const convalescencePersonalFactsSchema=z.object({schema_version:z.literal(CONVALESCENCE_PERSONAL_FACTS_POLICY),
 birth_date:date,employment_category:fact(z.enum(['private','public_or_pegged','protected_workshop','other'])),
 payment_from:date,payment_to:date,segment_count:fact(z.number().int().min(1).max(8)),
 segments:z.array(z.object({id:z.string().regex(/^declared\.segment\.[1-8]$/u),from:date,to:date,
  fte:fact(z.string().regex(/^(?:0(?:\.\d{1,8})?|1(?:\.0{1,8})?)$/u))}).strict()).max(8),
}).strict();
export type ConvalescencePersonalFacts=z.infer<typeof convalescencePersonalFactsSchema>;
const missing={state:'missing' as const,value:null,source:null};
export function convalescencePersonalFacts():ConvalescencePersonalFacts{return convalescencePersonalFactsSchema.parse({schema_version:CONVALESCENCE_PERSONAL_FACTS_POLICY,
 birth_date:missing,employment_category:missing,payment_from:missing,payment_to:missing,segment_count:missing,segments:[]});}
const usable=(f:{state:string;value:unknown;source:DocumentReviewSource|null})=>['observed','declared'].includes(f.state)&&f.value!==null&&f.source!==null;
type DateFact=ConvalescencePersonalFacts['payment_from'];
type PeriodFact={state:DateFact['state'];value:{from:string;to:string}|null;source:DocumentReviewSource|null};

/** A period derived from two authenticated declarations remains a declaration.
 * Both input receipts are kept in the packet and cited by the branch trace. */
export function periodFromDeclarations(from:DateFact,to:DateFact):PeriodFact|null{
 if(!usable(from)||!usable(to)||from.value!>to.value!||from.source!.reading!=='customer_declaration'||to.source!.reading!=='customer_declaration')return null;
 const inputs=[from,to].map(f=>({id:f.source!.document_id,version:f.source!.version_id,sha:f.source!.reading_receipt_sha256}));
 const locator=JSON.stringify({schema_version:'entitlement-declared-period-v1',inputs_sha256:canonicalSha256(inputs)});
 return {state:'declared',value:{from:from.value!,to:to.value!},source:{...from.source!,locator,label:'תקופה שהורכבה משתי הצהרות תאריך מזוהות; אינה קריאת מסמך'}};
}
export function unresolvedDeclaredPeriod(from:DateFact,to:DateFact):PeriodFact{
 if(usable(from)&&usable(to))return {state:'conflict',value:null,source:null};
 const state=(['conflict','stale','expired','unreadable','unknown','missing'] as const).find(s=>from.state===s||to.state===s)??'missing';
 return {state,value:null,source:null};
}
export function isDeclaredPeriodSource(source:DocumentReviewSource):boolean{
 try{return JSON.parse(source.locator)?.schema_version==='entitlement-declared-period-v1';}catch{return false;}
}

export function scaffoldConvalescenceSegments(facts:ConvalescencePersonalFacts):ConvalescencePersonalFacts{
 const next=structuredClone(facts),count=usable(next.segment_count)?next.segment_count.value:null;
 next.segments=count===null?[]:Array.from({length:count},(_,i)=>{
  const id=`declared.segment.${i+1}`;return next.segments.find(s=>s.id===id)??{id,from:{...missing},to:{...missing},fte:{...missing}};
 });
 return convalescencePersonalFactsSchema.parse(next);
}
