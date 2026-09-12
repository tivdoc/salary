import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewCalculationInputSchema} from '../../document-review/calculations.ts';
import type {ExplicitObligation,ObligationsEntitlementInput} from './contracts.ts';

const source=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const state=z.enum(['known','missing','unknown','conflict','stale','expired','unreadable']);
const fact=<T extends z.ZodType>(value:T)=>z.object({state,value:value.nullable(),source:source.nullable(),
 basis:z.enum(['identified_document_reading','customer_declaration','ai_source_assessment'])}).strict()
 .refine(v=>v.state!=='known'||'value'in v&&v.value!==null&&v.source!==null,'OBLIGATION_PRODUCT_FACT_SOURCE');
export const obligationProductFactsSchema=z.object({schema_version:z.literal('obligation-product-facts-v1'),
 agreement_used_for_employment:fact(z.boolean()),agreement_made_or_renewed_on:fact(z.iso.date()),
 changes_or_side_terms:fact(z.boolean()),employer_disputes_term:fact(z.boolean()),
}).strict();
export type ObligationProductFacts=z.infer<typeof obligationProductFactsSchema>;
export type ObligationProductFactKey=Exclude<keyof ObligationProductFacts,'schema_version'>;
export function obligationProductFactKey(input:ObligationsEntitlementInput,o:ExplicitObligation,key:ObligationProductFactKey):string{
 return `entitlement.obligation-fact.${canonicalSha256({case_id:input.case_id,period:input.period,obligation_id:o.obligation_id,clause:o.clause,key}).slice(0,28)}`;
}
export function obligationProductFacts():ObligationProductFacts{
 const missing={state:'missing',value:null,source:null,basis:'ai_source_assessment'};
 return obligationProductFactsSchema.parse({schema_version:'obligation-product-facts-v1',agreement_used_for_employment:missing,
  agreement_made_or_renewed_on:missing,changes_or_side_terms:missing,employer_disputes_term:missing});
}
export function enableObligationProductFacts(input:ObligationsEntitlementInput):ObligationsEntitlementInput{
 return {...input,obligations:input.obligations.map(o=>({...o,product_facts:o.product_facts??obligationProductFacts()}))};
}
/** Case facts only. Neither agreement usage nor absence of a known dispute is
 * an agreement-validity decision. A disputed/changed term opens source review,
 * rather than asking the customer to certify enforceability. */
export function obligationProductQuestions(input:ObligationsEntitlementInput,o:ExplicitObligation,index:number){
 if(!o.product_facts)return [];
 const keys=['agreement_used_for_employment','agreement_made_or_renewed_on','changes_or_side_terms','employer_disputes_term'] as const;
 const text={
  agreement_used_for_employment:'האם מסמך זה שימש לקביעת תנאי העבודה שלך בתקופה הנבדקת? התשובה מתארת את השימוש במסמך, ולא את תוקפו המשפטי.',
  agreement_made_or_renewed_on:'באיזה תאריך סוכם או חודש ההסכם הזה? חודש התלוש אינו בהכרח מועד ההסכמה.',
  changes_or_side_terms:'האם סוכמו תיקון, נספח או תנאים נוספים המשנים את הסעיף המסומן? אם כן, נדרשת בדיקת המקור המשלים לפני חישוב לפי הסעיף בלבד.',
  employer_disputes_term:'האם המעסיק מסר שהסעיף המסומן לא חל, בוטל או הוסכם אחרת? אין צורך להכריע מי צודק; חשוב לשמור גם את העמדה האחרת.',
 };
 return keys.flatMap(key=>{
  const value=o.product_facts![key];if(value.state==='known')return [];
  // Once a draft/unrelated source is identified, its date and further term
  // questions cannot unlock this month's obligation calculation.
  if(key!=='agreement_used_for_employment'&&o.product_facts!.agreement_used_for_employment.state==='known'&&o.product_facts!.agreement_used_for_employment.value===false)return [];
  return [{key,path:`obligations.${index}.product_facts.${key}`,fact:value,question:text[key],
   value_kind:key==='agreement_made_or_renewed_on'?'date' as const:'boolean' as const,
   fact_key:obligationProductFactKey(input,o,key)}];
 });
}
