import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/u);
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
const value=z.union([z.string().min(1).max(4000),z.number().finite().min(-1e12).max(1e12),z.boolean()]);
const valueValidation=z.object({schema_version:z.literal('document-review-value-validation-v1'),format:z.enum(['iso_date','iso_date_or_ongoing','year','fte_ratio','clock_time','calendar_days'])}).strict();
const valueMap=z.object({schema_version:z.literal('document-review-choice-values-v1'),entries:z.array(z.object({label:z.string().min(1).max(300),value:z.union([z.string().min(1).max(300),z.boolean(),z.number().finite()]).nullable()}).strict()).min(2).max(12)}).strict();
export const reviewPeriodSchema=z.object({from:z.iso.date(),to:z.iso.date()}).strict()
 .refine(period=>period.from<=period.to,'Period must be ordered');
export const reviewSourcePinSchema=z.object({case_id:z.uuid(),document_id:id,version_id:id,source_sha256:sha}).strict();
export type ReviewSourcePin=Readonly<z.infer<typeof reviewSourcePinSchema>>;
export const reviewDocumentSchema=z.object({pin:reviewSourcePinSchema,kind:id,period:reviewPeriodSchema.nullable().optional(),
 review:z.enum(['complete','partial','unreadable','not_reviewed']),
 review_completed_fact_keys:z.array(z.literal('payslip.financial_source')).max(1).optional()}).strict().refine(d=>!d.review_completed_fact_keys?.length
 ||d.kind==='payslip'&&d.review==='partial'&&d.period!==null&&d.period!==undefined,'Scoped financial-source review requires a partial payslip with a known period');
export const reviewEvidenceSchema=z.object({evidence_id:id,case_id:z.uuid(),fact_key:id,
 period:reviewPeriodSchema.nullable(),origin:z.enum(['document','questionnaire','answer','derived','transfer_receipt']),
 state:z.enum(['observed','declared','derived','unknown','conflicted','stale']),value:value.nullable(),
 source_pins:z.array(reviewSourcePinSchema).max(32),source_reviewed:z.boolean(),
}).strict().superRefine((entry,ctx)=>{
 if(['observed','declared','derived'].includes(entry.state)&&entry.value===null)
  ctx.addIssue({code:'custom',message:'Present evidence requires its actual value'});
 if(entry.origin==='derived'&&entry.state==='observed')
  ctx.addIssue({code:'custom',message:'A calculation is not an observed document cell'});
 if((entry.origin==='questionnaire'||entry.origin==='answer')&&entry.state==='observed')
  ctx.addIssue({code:'custom',message:'A declaration is not an observed document cell'});
 if(entry.state==='observed'&&entry.source_pins.length===0)
  ctx.addIssue({code:'custom',message:'An observation needs a source'});
});
export type ReviewEvidence=Readonly<z.infer<typeof reviewEvidenceSchema>>;
export const reviewCompletionNeedSchema=z.object({fact_key:id,
 kind:z.enum(['factual','document','legal','ownership']),
 reason:z.enum(['missing','unknown','unreadable','conflicted']),
 required_evidence_kind:z.enum(['observed_reading','customer_declaration','document','actual_transfer']),
 question:z.string().min(1).max(1000),answer_kind:z.enum(['text','number','boolean','choice','document']),
 value_validation:valueValidation.optional(),
 value_mapping:valueMap.optional(),
 options:z.array(z.string().min(1).max(300)).min(2).max(12).optional(),
 source_pins:z.array(reviewSourcePinSchema).max(32),dependent_check_ids:z.array(id).min(1).max(128),
 general_question:z.boolean(),document_kind:id.optional(),
}).strict().superRefine((need,ctx)=>{
 if(need.value_mapping&&(need.answer_kind!=='choice'||canonicalSha256(need.value_mapping.entries.map(e=>e.label))!==canonicalSha256(need.options)))ctx.addIssue({code:'custom',message:'Choice mapping must match options'});
 if(need.value_validation&&need.answer_kind!=='text')ctx.addIssue({code:'custom',message:'Formatted value requires text'});
 if((need.answer_kind==='choice')!==(need.options!==undefined))
  ctx.addIssue({code:'custom',message:'Only choice questions have options'});
 if(need.options&&new Set(need.options).size!==need.options.length)
  ctx.addIssue({code:'custom',message:'Options must be distinct'});
 if(need.kind==='document'&&!need.document_kind)
  ctx.addIssue({code:'custom',message:'A document request must identify its required kind'});
 if(need.document_kind&&need.kind!=='document')
  ctx.addIssue({code:'custom',message:'Document kind belongs to a document request'});
});
export type ReviewCompletionNeed=Readonly<z.infer<typeof reviewCompletionNeedSchema>>;

const targetBodySchema=z.object({schema_version:z.literal('document-review-completion-v1'),case_id:z.uuid(),period:reviewPeriodSchema,
 fact_key:id,kind:z.enum(['factual','document','legal','ownership']),
 reason:z.enum(['missing','unknown','unreadable','conflicted']),
 required_evidence_kind:z.enum(['observed_reading','customer_declaration','document','actual_transfer']),
 question:z.string().min(1).max(1000),answer_kind:z.enum(['text','number','boolean','choice','document']),
 value_validation:valueValidation.optional(),
 value_mapping:valueMap.optional(),
 options:z.array(z.string().min(1).max(300)).min(2).max(12).optional(),source_pins:z.array(reviewSourcePinSchema).max(32),
 document_kind:id.optional(),
}).strict();
export const reviewCompletionTargetSchema=targetBodySchema.extend({target_sha256:sha}).superRefine((target,ctx)=>{
 const {target_sha256,...body}=target;
 if(canonicalSha256(body)!==target_sha256)ctx.addIssue({code:'custom',message:'Completion target hash mismatch'});
 if(target.source_pins.some(pin=>pin.case_id!==target.case_id))ctx.addIssue({code:'custom',message:'Foreign source'});
 if(target.value_mapping&&(target.answer_kind!=='choice'||canonicalSha256(target.value_mapping.entries.map(e=>e.label))!==canonicalSha256(target.options)))ctx.addIssue({code:'custom',message:'Choice mapping must match options'});
 if(target.value_validation&&target.answer_kind!=='text')ctx.addIssue({code:'custom',message:'Formatted value requires text'});
 if((target.answer_kind==='choice')!==(target.options!==undefined))ctx.addIssue({code:'custom',message:'Invalid choice target'});
});
export type ReviewCompletionTarget=Readonly<z.infer<typeof reviewCompletionTargetSchema>>;
export const reviewCompletionSchema=z.object({code:z.string().regex(/^document_review:[a-f0-9]{64}$/u),target:reviewCompletionTargetSchema,
 dependent_check_ids:z.array(id).min(1).max(128)}).strict().refine(request=>request.code===`document_review:${request.target.target_sha256}`,'Code must match target');
export type ReviewCompletion=Readonly<z.infer<typeof reviewCompletionSchema>>;

const answerBodySchema=z.object({case_id:z.uuid(),target_sha256:sha,request_id:z.uuid(),answer_revision:z.number().int().positive(),
 identity_id:z.uuid(),answered_at:z.iso.datetime({offset:true}),state:z.enum(['provided','unknown','conflicted']),value:value.nullable(),
}).strict().superRefine((answer,ctx)=>{
 if((answer.state==='provided')!==(answer.value!==null))ctx.addIssue({code:'custom',message:'Only a provided answer has a value'});
});
export const reviewCompletionAnswerReceiptSchema=answerBodySchema.safeExtend({answer_sha256:sha}).superRefine((answer,ctx)=>{
 const {answer_sha256,...body}=answer;
 if(canonicalSha256(body)!==answer_sha256)ctx.addIssue({code:'custom',message:'Answer receipt hash mismatch'});
});
export type ReviewCompletionAnswerReceipt=Readonly<z.infer<typeof reviewCompletionAnswerReceiptSchema>>;
export const reviewCompletionInputSchema=z.object({case_id:z.uuid(),period:reviewPeriodSchema,
 documents:z.array(reviewDocumentSchema).max(128),needs:z.array(reviewCompletionNeedSchema).max(256),
 evidence:z.array(reviewEvidenceSchema).max(1024),previous_answers:z.array(reviewCompletionAnswerReceiptSchema).max(1024).optional(),
}).strict();
export type ReviewCompletionInput=Readonly<z.infer<typeof reviewCompletionInputSchema>>;
export const parseReviewCompletionInput=(input:unknown):ReviewCompletionInput=>reviewCompletionInputSchema.parse(input);
export type ReviewCompletionSuppression=Readonly<{target_sha256:string;fact_key:string;
 reason:'already_known'|'legacy_declaration_already_reviewed'|'existing_document'|'previous_answer';
 state:'satisfied'|'provided'|'unknown'|'conflicted';dependent_check_ids:readonly string[];evidence_ids:readonly string[]}>;
export type ReviewInternalTask=Readonly<{id:string;kind:'legal_research'|'ownership'|'review_existing_source';question:string;
 source_pins:readonly ReviewSourcePin[];dependent_check_ids:readonly string[]}>;
export type ReviewCompletionPlan=Readonly<{customer_requests:readonly ReviewCompletion[];internal_tasks:readonly ReviewInternalTask[];
 suppressed:readonly ReviewCompletionSuppression[];dependency_index:Readonly<Record<string,readonly string[]>>}>;

function sortedPins(pins:readonly ReviewSourcePin[]):ReviewSourcePin[]{
 const unique=new Map(pins.map(pin=>[canonicalSha256(pin),pin]));
 return [...unique.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([,pin])=>pin);
}
const sortedIds=(ids:readonly string[])=>[...new Set(ids)].sort();
const periodContains=(outer:z.infer<typeof reviewPeriodSchema>,inner:z.infer<typeof reviewPeriodSchema>)=>outer.from<=inner.from&&outer.to>=inner.to;
function targetFor(input:ReviewCompletionInput,need:ReviewCompletionNeed):ReviewCompletionTarget{
 const {dependent_check_ids:_,general_question:__,...question}=need;
 void _;void __;
 const body=targetBodySchema.parse({schema_version:'document-review-completion-v1',case_id:input.case_id,period:input.period,
  ...question,source_pins:sortedPins(need.source_pins)});
 return deepFreeze(reviewCompletionTargetSchema.parse({...body,target_sha256:canonicalSha256(body)}));
}
function validateScope(input:ReviewCompletionInput){
 if(input.documents.some(d=>d.pin.case_id!==input.case_id)||input.evidence.some(e=>e.case_id!==input.case_id)
  ||input.needs.some(n=>n.source_pins.some(p=>p.case_id!==input.case_id))
  ||input.evidence.some(e=>e.source_pins.some(p=>p.case_id!==input.case_id))
  ||input.previous_answers?.some(a=>a.case_id!==input.case_id))throw Error('REVIEW_COMPLETION_CASE_MISMATCH');
 const documents=new Map<string,string>();
 for(const document of input.documents){
  const key=document.pin.document_id,signature=canonicalSha256(document.pin);
  if(documents.has(key))throw Error('REVIEW_COMPLETION_DOCUMENT_AMBIGUOUS');
  documents.set(key,signature);
 }
 for(const need of input.needs)for(const pin of need.source_pins)
  if(documents.get(pin.document_id)!==canonicalSha256(pin))throw Error('REVIEW_COMPLETION_SOURCE_STALE');
 if(new Set(input.evidence.map(e=>e.evidence_id)).size!==input.evidence.length)throw Error('REVIEW_COMPLETION_EVIDENCE_AMBIGUOUS');
 for(const evidence of input.evidence)if(evidence.state!=='stale')for(const pin of evidence.source_pins)
  if(documents.get(pin.document_id)!==canonicalSha256(pin))throw Error('REVIEW_COMPLETION_SOURCE_STALE');
}
function appropriateEvidence(need:Pick<ReviewCompletionNeed,'required_evidence_kind'>,evidence:ReviewEvidence):boolean{
 if(!evidence.source_reviewed||evidence.value===null||['unknown','conflicted','stale','derived'].includes(evidence.state)||evidence.origin==='derived')return false;
 switch(need.required_evidence_kind){
  case 'observed_reading':return evidence.origin==='document'&&evidence.state==='observed';
  case 'customer_declaration':return ['questionnaire','answer'].includes(evidence.origin)&&evidence.state==='declared';
  case 'actual_transfer':return evidence.origin==='transfer_receipt'&&evidence.state==='observed'&&evidence.source_pins.length>0;
  case 'document':return evidence.origin==='document'&&evidence.state==='observed';
 }
}
function scopedConflict(need:Pick<ReviewCompletionNeed,'reason'|'required_evidence_kind'>,evidence:readonly ReviewEvidence[]):boolean{
 return need.reason==='conflicted'||evidence.some(e=>e.state==='conflicted')
  ||new Set(evidence.filter(e=>appropriateEvidence(need,e)).map(e=>canonicalSha256(e.value))).size>1;
}
function answerEvidence(target:ReviewCompletionTarget,receipt:ReviewCompletionAnswerReceipt):ReviewEvidence{
 return reviewEvidenceSchema.parse({evidence_id:`review-answer:${receipt.answer_sha256}`,case_id:receipt.case_id,
  fact_key:target.fact_key,period:target.period,origin:'answer',state:receipt.state==='provided'?'declared':receipt.state,
  value:receipt.value,source_pins:target.source_pins,source_reviewed:true});
}

/** Pure planning over authenticated saved evidence. This function never opens a
 * request, calls OCR, decides law, or manufactures a declaration. Callers must
 * preserve the global source fence and key each calculation by its dependencies. */
export function generateReviewCompletions(candidate:ReviewCompletionInput):ReviewCompletionPlan{
 const input=reviewCompletionInputSchema.parse(candidate);validateScope(input);
 const requests:ReviewCompletion[]=[],internal:ReviewInternalTask[]=[],suppressed:ReviewCompletionSuppression[]=[];
 const index:Record<string,readonly string[]>={},groups=new Map<string,{need:ReviewCompletionNeed;target:ReviewCompletionTarget}>();
 const semanticKeys=new Map<string,string>();
 for(const need of input.needs){
  const target=targetFor(input,need),semantic=canonicalSha256({fact_key:need.fact_key,kind:need.kind,
   required_evidence_kind:need.required_evidence_kind,source_pins:target.source_pins,document_kind:need.document_kind??null});
  const priorKey=semanticKeys.get(semantic);
  if(priorKey&&priorKey!==target.target_sha256)throw Error('REVIEW_COMPLETION_NEED_AMBIGUOUS');
  semanticKeys.set(semantic,target.target_sha256);
  const existing=groups.get(target.target_sha256);
  if(existing)existing.need={...existing.need,general_question:existing.need.general_question&&need.general_question,
   dependent_check_ids:sortedIds([...existing.need.dependent_check_ids,...need.dependent_check_ids])};
  else groups.set(target.target_sha256,{need,target});
 }
 for(const [hash,{need,target}] of [...groups.entries()].sort(([a],[b])=>a.localeCompare(b))){
  const dependent=sortedIds(need.dependent_check_ids);index[hash]=dependent;
  const internalTask=(kind:ReviewInternalTask['kind'])=>internal.push({id:`review_internal:${hash}`,kind,question:need.question,source_pins:target.source_pins,dependent_check_ids:dependent});
  if(need.kind==='legal'||need.kind==='ownership'){internalTask(need.kind==='legal'?'legal_research':'ownership');continue;}
  const suppress=(reason:ReviewCompletionSuppression['reason'],state:ReviewCompletionSuppression['state'],evidenceIds:string[]=[])=>
   suppressed.push({target_sha256:hash,fact_key:need.fact_key,reason,state,dependent_check_ids:dependent,evidence_ids:sortedIds(evidenceIds)});
  const previous=(input.previous_answers??[]).filter(a=>a.target_sha256===hash).sort((a,b)=>b.answer_revision-a.answer_revision);
  if(previous.length){
   const latest=previous[0];
   if(previous.some(a=>a.request_id!==latest.request_id)||previous.some(a=>a.answer_revision===latest.answer_revision&&a.answer_sha256!==latest.answer_sha256))throw Error('REVIEW_COMPLETION_ANSWER_AMBIGUOUS');
   suppress('previous_answer',latest.state,[latest.request_id]);
   // A declaration can end the customer's question without supplying the
   // document evidence the check requires. Retain that verification work.
   if(latest.state==='provided'&&need.required_evidence_kind!=='customer_declaration')internalTask('review_existing_source');
   continue;
  }
  if(need.kind==='document'){
   const known=input.documents.filter(d=>d.kind===need.document_kind);
   const matching=known.filter(d=>d.period&&periodContains(d.period,input.period));
   if(matching.some(d=>d.review==='complete')&&need.reason!=='conflicted'){
    suppress('existing_document','satisfied',matching.filter(d=>d.review==='complete').map(d=>d.pin.document_id));continue;
   }
   if(known.some(d=>d.review==='not_reviewed'||(d.review==='complete'&&!d.period))){internalTask('review_existing_source');continue;}
  }
  const relevant=input.evidence.filter(e=>e.fact_key===need.fact_key&&e.state!=='stale');
  const scoped=relevant.filter(e=>e.period&&periodContains(e.period,input.period));
  const conflict=scopedConflict(need,scoped);
  if(!conflict){
   const matched=scoped.filter(e=>appropriateEvidence(need,e));
   if(matched.length){suppress('already_known','satisfied',matched.map(e=>e.evidence_id));continue;}
   // Legacy scope is not invented. It prevents a repeated general question,
   // but cannot satisfy a dated check or a transfer/document requirement.
   const legacy=need.general_question&&need.required_evidence_kind==='customer_declaration'
    ?relevant.filter(e=>e.period===null&&e.origin==='questionnaire'&&e.state==='declared'&&e.source_reviewed&&e.value!==null):[];
   if(legacy.length&&new Set(legacy.map(e=>canonicalSha256(e.value))).size===1){
    suppress('legacy_declaration_already_reviewed','provided',legacy.map(e=>e.evidence_id));continue;
   }
  }
  requests.push(deepFreeze(reviewCompletionSchema.parse({code:`document_review:${hash}`,target,dependent_check_ids:dependent})));
 }
 return deepFreeze({customer_requests:requests,internal_tasks:internal,suppressed,dependency_index:index});
}

export type ReviewCompletionResolution=Readonly<
 |{state:'stale';blocked:true;invalidated_check_ids:readonly string[]}
 |{state:'provided'|'unknown'|'conflicted';blocked:boolean;invalidated_check_ids:readonly string[];
   receipt:ReviewCompletionAnswerReceipt;evidence:ReviewEvidence;requires_source_verification:boolean}>;

/** actor comes from the server's authenticated session, never from answer JSON.
 * A text answer supplies a declaration. Document/transfer evidence is accepted
 * only after the normal source path loads and verifies the supplied document. */
export function resolveReviewCompletion(input:{request:ReviewCompletion;current:ReviewCompletionInput;
 actor:{case_id:string;identity_id:string};answer:{request_id:string;revision:number;answered_at:string;
 state:'provided'|'unknown'|'conflicted';value:string|number|boolean|null}}):ReviewCompletionResolution{
 const request=reviewCompletionSchema.parse(input.request),current=reviewCompletionInputSchema.parse(input.current);
 const actor=z.object({case_id:z.uuid(),identity_id:z.uuid()}).strict().parse(input.actor);
 if(actor.case_id!==request.target.case_id||current.case_id!==request.target.case_id)throw Error('REVIEW_COMPLETION_CASE_MISMATCH');
 const body=answerBodySchema.parse({case_id:actor.case_id,target_sha256:request.target.target_sha256,
  request_id:input.answer.request_id,answer_revision:input.answer.revision,identity_id:actor.identity_id,
  answered_at:input.answer.answered_at,state:input.answer.state,value:input.answer.value});
 const targetAnswers=(current.previous_answers??[]).filter(a=>a.target_sha256===body.target_sha256);
 if(targetAnswers.some(a=>a.request_id!==body.request_id))throw Error('REVIEW_COMPLETION_ANSWER_AMBIGUOUS');
 // A correction replaces this request's prior declaration, not other evidence.
 // Match both its journal receipt hash and complete evidence shape; a similarly
 // named fact, a different target, or an altered source must remain visible.
 const priorEvidenceHashes=new Set(targetAnswers.map(a=>canonicalSha256(answerEvidence(request.target,a))));
 const remainingEvidence=current.evidence.filter(e=>!priorEvidenceHashes.has(canonicalSha256(e)));
 let plan:ReviewCompletionPlan;
 try{plan=generateReviewCompletions({...current,evidence:remainingEvidence,previous_answers:[]});}
 catch(error){if(error instanceof Error&&error.message==='REVIEW_COMPLETION_SOURCE_STALE')return {state:'stale',blocked:true,invalidated_check_ids:[]};throw error;}
 const latest=plan.customer_requests.find(r=>r.target.target_sha256===request.target.target_sha256);
 if(!latest)return deepFreeze({state:'stale',blocked:true,invalidated_check_ids:[]});
 if(body.state==='provided'){
  const kind=latest.target.answer_kind;
  if((kind==='number'&&typeof body.value!=='number')||(kind==='boolean'&&typeof body.value!=='boolean')
   ||(['text','document','choice'].includes(kind)&&typeof body.value!=='string')
   ||(kind==='choice'&&!latest.target.options?.includes(String(body.value))))throw Error('REVIEW_COMPLETION_ANSWER_INVALID');
  validateReviewAnswerFormat(latest.target,body.value);
 }
 const requiresSource=latest.target.required_evidence_kind!=='customer_declaration';
 const receipt=reviewCompletionAnswerReceiptSchema.parse({...body,answer_sha256:canonicalSha256(body)});
 const prior=targetAnswers
  .sort((a,b)=>b.answer_revision-a.answer_revision)[0];
 if(!prior&&body.answer_revision!==1)throw Error('REVIEW_COMPLETION_ANSWER_REVISION');
 if(prior&&(body.answer_revision<prior.answer_revision||(body.answer_revision===prior.answer_revision&&receipt.answer_sha256!==prior.answer_sha256)))throw Error('REVIEW_COMPLETION_ANSWER_REVISION');
 if(prior&&body.answer_revision>prior.answer_revision+1)throw Error('REVIEW_COMPLETION_ANSWER_REVISION');
 const evidence=answerEvidence(latest.target,receipt);
 const externalConflict=scopedConflict(latest.target,remainingEvidence.filter(e=>e.fact_key===latest.target.fact_key
  &&e.state!=='stale'&&e.period&&periodContains(e.period,latest.target.period)));
 return deepFreeze({state:body.state,blocked:body.state!=='provided'||requiresSource||externalConflict,
  invalidated_check_ids:prior?.answer_sha256===receipt.answer_sha256?[]:latest.dependent_check_ids,
  receipt,evidence,requires_source_verification:requiresSource});
}

/** Opt-in target contract; absent validation preserves historical receipts. */
export function validateReviewAnswerFormat(target:ReviewCompletionTarget,value:unknown):void{
 const format=target.value_validation?.format;if(!format)return;
 if(format==='calendar_days'){
  if(typeof value!=='string'||!/^(?:0|[1-9]|[12]\d|3[01])$/u.test(value)||Number(value)>Number(target.period.to.slice(8)))throw Error('REVIEW_COMPLETION_ANSWER_INVALID');return;
 }
 if(format==='clock_time'){
  if(typeof value!=='string'||!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value))throw Error('REVIEW_COMPLETION_ANSWER_INVALID');return;
 }
 if(format==='year'){
  if(typeof value!=='string'||! /^(?:19|20)\d{2}$|^2100$/u.test(value))throw Error('REVIEW_COMPLETION_ANSWER_INVALID');return;
 }
 if(format==='fte_ratio'){
  if(typeof value!=='string'||!/^(?:0\.\d{1,8}|1(?:\.0{1,8})?)$/u.test(value)||Number(value)<=0)throw Error('REVIEW_COMPLETION_ANSWER_INVALID');return;
 }
 if(format==='iso_date_or_ongoing'&&value==='העבודה נמשכת')return;
 if(typeof value!=='string'||!z.iso.date().safeParse(value).success)throw Error('REVIEW_COMPLETION_ANSWER_INVALID');
}

export function reviewDeclaredAnswerValue(target:ReviewCompletionTarget,value:unknown):unknown{
 if(target.value_validation?.format==='year'||target.value_validation?.format==='calendar_days'){validateReviewAnswerFormat(target,value);return Number(value);}
 if(!target.value_mapping)return value;
 const mapped=target.value_mapping.entries.filter(e=>e.label===value);
 if(mapped.length!==1)throw Error('REVIEW_COMPLETION_ANSWER_MAPPING');return mapped[0].value;
}
