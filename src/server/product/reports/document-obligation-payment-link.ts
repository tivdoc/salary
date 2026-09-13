import {obligationPaymentLinkTargetSchema,obligationPaymentLinkAnswerSchema} from '@/engine/entitlement-review/obligations/payment-link';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {reviewTopicSchema} from '@/engine/document-review/contracts';

const sha=z.string().regex(/^[a-f0-9]{64}$/u);
export const obligationReadingDependencySchema=z.object({version_id:z.uuid(),request_id:z.uuid(),answer_revision:z.number().int().positive(),answer_sha256:sha}).strict();
export const obligationPaymentChoiceTargetSchema=z.object({
 schema_version:z.literal('obligation-payment-choice-v1'),case_id:z.uuid(),product_document_id:z.uuid(),version_id:z.uuid(),
 source_sha256:sha,month:z.string(),policy_version:z.string(),order_id:z.uuid(),order_origin:z.enum(['saved_order','legacy_paid_receipt']),
 order_receipt_sha256:sha,purchased_topics:z.array(reviewTopicSchema).min(1),reading_dependencies:z.array(obligationReadingDependencySchema).max(512),
 candidates:z.array(obligationPaymentLinkTargetSchema).min(1).max(16),target_sha256:sha,
}).strict().superRefine((t,c)=>{
 const {target_sha256,...body}=t,first=t.candidates[0];
 if(canonicalSha256(body)!==target_sha256)c.addIssue({code:'custom',message:'OBLIGATION_CHOICE_HASH'});
 if(new Set(t.reading_dependencies.map(d=>d.request_id)).size!==t.reading_dependencies.length||new Set(t.purchased_topics).size!==t.purchased_topics.length
  ||!t.purchased_topics.some(p=>p==='contract'||p==='bonuses')
  ||t.reading_dependencies.some(d=>!t.candidates.some(p=>p.version_id===d.version_id||p.clause.source.version_id===d.version_id)))c.addIssue({code:'custom',message:'OBLIGATION_CHOICE_DEPENDENCIES'});
 if(new Set(t.candidates.map(p=>p.target_sha256)).size!==t.candidates.length||t.candidates.some(p=>p.case_id!==t.case_id||p.month!==t.month||p.obligation_id!==first.obligation_id||canonicalSha256(p.clause)!==canonicalSha256(first.clause)||canonicalSha256(p.period)!==canonicalSha256(first.period))
  ||t.product_document_id!==first.product_document_id||t.version_id!==first.version_id||t.source_sha256!==first.source_sha256||t.policy_version!==first.policy_version)c.addIssue({code:'custom',message:'OBLIGATION_CHOICE_SCOPE'});
});
export const documentObligationPaymentTargetSchema=z.union([obligationPaymentLinkTargetSchema,obligationPaymentChoiceTargetSchema]);
export type DocumentObligationPaymentTarget=z.infer<typeof documentObligationPaymentTargetSchema>;
export function parseObligationPaymentWireAnswer(value:unknown){
 const wire=z.union([obligationPaymentLinkAnswerSchema.options[0].extend({candidate_target_sha256:sha.optional()}),
  obligationPaymentLinkAnswerSchema.options[1],obligationPaymentLinkAnswerSchema.options[2]]);
 return wire.parse(typeof value==='string'?JSON.parse(value):value);
}
export function createObligationPaymentChoiceTarget(candidates:readonly z.infer<typeof obligationPaymentLinkTargetSchema>[],purchase:{order_id:string;origin:'saved_order'|'legacy_paid_receipt';receipt_sha256:string;topics:z.infer<typeof reviewTopicSchema>[]},dependencies:readonly z.infer<typeof obligationReadingDependencySchema>[]){
 const ordered=[...candidates].sort((a,b)=>a.target_sha256.localeCompare(b.target_sha256)),first=ordered[0];
 if(!first)throw Error('OBLIGATION_CHOICE_SOURCE_REQUIRED');
 const body={schema_version:'obligation-payment-choice-v1' as const,case_id:first.case_id,product_document_id:first.product_document_id,version_id:first.version_id,
  source_sha256:first.source_sha256,month:first.month,policy_version:first.policy_version,order_id:purchase.order_id,order_origin:purchase.origin,
  order_receipt_sha256:purchase.receipt_sha256,purchased_topics:purchase.topics,reading_dependencies:[...dependencies].sort((a,b)=>a.request_id.localeCompare(b.request_id)),candidates:ordered};
 return deepFreeze(obligationPaymentChoiceTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}
export function selectedObligationPaymentTarget(target:DocumentObligationPaymentTarget,candidateHash?:string){
 if(target.schema_version==='obligation-payment-link-v1')return target;
 const selected=target.candidates.filter(t=>t.target_sha256===candidateHash);
 if(selected.length!==1)throw Error('REQUEST_ANSWER_INVALID');return selected[0];
}

export function validateDocumentObligationPaymentLinkAnswer(targetInput:unknown,answerInput:unknown){
 const target=documentObligationPaymentTargetSchema.parse(targetInput);
 let candidate=answerInput;
 if(typeof candidate==='string'){
  if(candidate.length>2000)throw Error('REQUEST_ANSWER_INVALID');
  try{candidate=JSON.parse(candidate);}catch{throw Error('REQUEST_ANSWER_INVALID');}
 }
 let selected=target.schema_version==='obligation-payment-link-v1'?target:null;
 let selectedHash:string|undefined;
 if(target.schema_version==='obligation-payment-choice-v1'&&candidate&&typeof candidate==='object'&&'action' in candidate&&candidate.action==='correct'){
  const wire=z.object({candidate_target_sha256:sha,action:z.literal('correct'),value:obligationPaymentLinkAnswerSchema.options[0].shape.value}).strict().safeParse(candidate);
  if(!wire.success)throw Error('REQUEST_ANSWER_INVALID');
  selectedHash=wire.data.candidate_target_sha256;selected=selectedObligationPaymentTarget(target,selectedHash);
  candidate={action:'correct',value:wire.data.value};
 }
 const answer=obligationPaymentLinkAnswerSchema.safeParse(candidate);
 if(!answer.success)throw Error('REQUEST_ANSWER_INVALID');
 if(answer.data.action==='correct'&&(!selected||answer.data.value.basis.page!==selected.amount.source.page))throw Error('REQUEST_ANSWER_INVALID');
 return {...answer.data,...(selectedHash?{candidate_target_sha256:selectedHash}:{})};
}

export function documentObligationPaymentLinkQuestion(input:unknown){
 const parsed=documentObligationPaymentTargetSchema.parse(input),target=parsed.schema_version==='obligation-payment-link-v1'?parsed:parsed.candidates[0];
 return {code:`document_field:${parsed.target_sha256}`,question:`איזו שורת תשלום בתלוש מתייחסת להתחייבות שבעמוד ${target.clause.source.page} בהסכם? יש לבדוק את המקורות ולציין הפניה מפורשת בשורת התלוש.`,
  answer_kind:'choice' as const,options:['קיימת הפניה לאותה התחייבות','השורה מתייחסת לתשלום אחר','לא קריא','לא יודע/ת'],
  field_crop:'obligation.payment_link',blocking:false};
}

export function documentObligationPaymentLinkDisplay(input:unknown){
 const parsed=documentObligationPaymentTargetSchema.parse(input),t=parsed.schema_version==='obligation-payment-link-v1'?parsed:parsed.candidates[0],source=t.amount.source;
 const visibleLocator=(s:{locator:string;label:string;page:number})=>/^[{[]/u.test(s.locator.trim())?s.label:s.locator;
 return {question:documentObligationPaymentLinkQuestion(parsed).question,field:'obligation.payment_link',raw_value:parsed.schema_version==='obligation-payment-link-v1'?t.amount.printed_value:null,
  source:{version_id:t.version_id,source_sha256:t.source_sha256,page:source.page,text_fragment:null,region:source.locator,source_scope:null,bounding_box:null},
  target_sha256:parsed.target_sha256,actions:['correct','unknown','unreadable'] as const,scope:'source_relationship_only' as const,
  obligation_context:{payroll_page:source.page,payroll_locator:visibleLocator(source),clause_page:t.clause.source.page,clause_locator:visibleLocator(t.clause.source),
   period:{...t.period},...(parsed.schema_version==='obligation-payment-choice-v1'?{candidates:parsed.candidates.map(p=>({target_sha256:p.target_sha256,payroll_page:p.amount.source.page,payroll_locator:visibleLocator(p.amount.source),amount:p.amount.printed_value??''}))}:{})}};
}
