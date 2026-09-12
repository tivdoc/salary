import {assertQuestionnaireSource} from './declarations.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {DocumentReviewInput,ReviewDocument} from '../document-review/contracts.ts';
import type {DocumentReviewSource} from '../document-review/calculations.ts';
import {parseReviewCompletionInput,resolveReviewCompletion,reviewDeclaredAnswerValue} from '../document-review/completions.ts';
import {entitlementEvidenceSchema,type EntitlementEvidence} from './contracts.ts';
import {assertTypedPeriodDerivation} from './typed-product-facts.ts';
import {isDeclaredPeriodSource} from './convalescence/product-facts.ts';
import {minimumWageEntitlementInputSchema} from './minimum-wage/contracts.ts';
import {materializeMinimumWageCaseFacts} from '../ai-release-decisions/minimum-wage-case.ts';
import {pensionEntitlementInputSchema} from './pension/contracts.ts';
import {replayPensionProductFacts} from './pension/product-facts.ts';
import {sharedPersonalAliasFact,sharedPersonalAnswerIsCurrent,assertSharedPersonalMaterialization} from './shared-product-facts.ts';

/** Inspect source citations rather than treating a caller's 'known' or
 * 'accepted' label as evidence. Legal sources are supplied by the selected
 * compiled catalog; client documents come from the immutable saved input. */
export function assertEntitlementSourcePacket(input:DocumentReviewInput,candidate:unknown,legalDocuments:readonly ReviewDocument[]):EntitlementEvidence{
 const packet=entitlementEvidenceSchema.parse(candidate);
 if(packet.case_id!==input.case_id||packet.order_id!==input.purchased_scope.order_id
  ||packet.receipt_sha256!==input.purchased_scope.receipt_sha256
  ||canonicalSha256(packet.period)!==canonicalSha256(input.period))throw Error('ENTITLEMENT_PACKET_SCOPE');
 const documents=[...input.documents];
 for(const law of legalDocuments){
  const existing=documents.find(d=>d.document_id===law.document_id);
  if(existing&&(existing.version_id!==law.version_id||existing.file_sha256!==law.file_sha256||existing.page_count!==law.page_count))throw Error('ENTITLEMENT_LEGAL_SOURCE_CHANGED');
  if(existing)documents[documents.indexOf(existing)]=law;else documents.push(law);
 }
 const completion=parseReviewCompletionInput(input.completion_input);
 assertSharedPersonalMaterialization(input,packet);
 function citation(value:DocumentReviewSource){
  if(value.reading==='questionnaire_declaration'){assertQuestionnaireSource(input,value);return;}
  if(value.reading==='customer_declaration'){
   const history=input.answer_history.find(h=>h.receipt.request_id===value.document_id
    &&`${h.receipt.request_id}:${h.receipt.answer_revision}`===value.version_id
    &&h.receipt.answer_sha256===value.file_sha256&&h.receipt.answer_sha256===value.reading_receipt_sha256);
   if(!history||history.receipt.case_id!==input.case_id||history.request.target.required_evidence_kind!=='customer_declaration')throw Error('ENTITLEMENT_ANSWER_SOURCE_REQUIRED');
   const r=history.receipt;
   if(!sharedPersonalAnswerIsCurrent(input,r.answer_sha256)){
    const admitted=resolveReviewCompletion({request:history.request,current:completion,actor:{case_id:input.case_id,identity_id:r.identity_id},
     answer:{request_id:r.request_id,revision:r.answer_revision,answered_at:r.answered_at,state:r.state,value:r.value}});
    if(admitted.state==='stale'||admitted.requires_source_verification||admitted.receipt.answer_sha256!==r.answer_sha256)throw Error('ENTITLEMENT_ANSWER_SOURCE_STALE');
   }
   const newer=input.answer_history.some(h=>h.receipt.request_id===r.request_id&&h.receipt.answer_revision>r.answer_revision);
   if(newer)throw Error('ENTITLEMENT_ANSWER_SOURCE_REPLACED');
   return;
  }
  const document=documents.find(d=>d.document_id===value.document_id&&d.version_id===value.version_id);
  if(!document||document.case_id!==input.case_id||document.file_sha256!==value.file_sha256
   ||document.page_count===null||value.page<1||value.page>document.page_count
   ||![document.reading_sha256,...(document.accepted_reading_sha256??[])].includes(value.reading_receipt_sha256))throw Error('ENTITLEMENT_READING_SOURCE_BINDING');
  if(value.reading==='source_research'&&!legalDocuments.some(d=>canonicalSha256(d)===canonicalSha256(document)))throw Error('ENTITLEMENT_LEGAL_SOURCE_REQUIRED');
 }
 let nodes=0;
 function visit(value:unknown,depth=0,path=''):void{
  if(++nodes>25000||depth>35)throw Error('ENTITLEMENT_PACKET_BOUNDS');
  if(!value||typeof value!=='object')return;
  if(Array.isArray(value)){for(const [i,item]of value.entries())visit(item,depth+1,path+'.'+i);return;}
  const object=value as Record<string,unknown>;
  if(object.state==='derived'&&path.startsWith('pension.')){
   const key=path.slice('pension.facts.'.length);
   if(!['pension.facts.aged_21_or_more','pension.facts.under_60'].includes(path)||!input.entitlement_evidence?.pension||!packet.pension)throw Error('PENSION_DERIVED_FACT_KEY');
   const raw=pensionEntitlementInputSchema.parse(input.entitlement_evidence.pension),effective=pensionEntitlementInputSchema.parse(packet.pension);
   const replay=replayPensionProductFacts(effective,raw,input);
   if(!raw.case_recipe_bindings?.length||canonicalSha256(Reflect.get(replay.facts,key))!==canonicalSha256(object))throw Error('PENSION_DERIVED_FACT_REPLAY');
  }
  if(object.state==='derived'&&path.startsWith('minimum_wage.')){
   const key=path.slice('minimum_wage.'.length);
   if(!['population','employment','method','eligible_pay_inventory'].includes(key)||!input.entitlement_evidence?.minimum_wage||!packet.minimum_wage)throw Error('MW_CASE_DERIVED_FACT_KEY');
   const raw=minimumWageEntitlementInputSchema.parse(input.entitlement_evidence.minimum_wage),effective=minimumWageEntitlementInputSchema.parse(packet.minimum_wage);
   const replay=materializeMinimumWageCaseFacts(effective,raw,input);
   if(!raw.case_recipe_bindings?.length||canonicalSha256(Reflect.get(replay,key))!==canonicalSha256(object))throw Error('MW_CASE_DERIVED_FACT_REPLAY');
  }
  // A source pointer is not permission to replace the receipt's answer value.
  const boundSource=object.source as DocumentReviewSource|undefined;
  if(boundSource?.reading==='questionnaire_declaration')assertQuestionnaireSource(input,boundSource,object.value);
  if(boundSource?.reading==='customer_declaration'&&('value' in object||'printed_value' in object)){
   const h=input.answer_history.find(h=>h.receipt.answer_sha256===boundSource.reading_receipt_sha256);
   const supplied='printed_value' in object?object.printed_value:object.value;
   const shared=sharedPersonalAliasFact(input,packet,path,object);
   const personal=/^(minimum_wage|pension)\.(product_facts\.[a-z_]+)$/u.exec(path);
   if(personal&&!shared){
    const branch=personal[1]==='pension'?pensionEntitlementInputSchema.parse(packet.pension):minimumWageEntitlementInputSchema.parse(packet.minimum_wage);
    const pins=input.documents.filter(d=>branch.source_manifest.some(m=>m.kind==='case_document'&&m.document_id===d.document_id)).map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256}));
    const key=personal[1]==='pension'?`entitlement.pension.${canonicalSha256({period:input.period,pins,path:personal[2]}).slice(0,32)}`
     :`entitlement.minimum_wage.${canonicalSha256({period:input.period,pins,path:personal[2],key:'personal.'+personal[2]}).slice(0,28)}`;
    if(!h||h.request.target.fact_key!==key)throw Error('ENTITLEMENT_PERSONAL_ANSWER_TARGET');
   }
   if(isDeclaredPeriodSource(boundSource)){
    if(!h||!assertTypedPeriodDerivation(packet,path,object))throw Error('ENTITLEMENT_DECLARED_PERIOD_CHANGED');
   }else if(!shared&&(!h||(h.receipt.state==='provided'?String(supplied)!==String(reviewDeclaredAnswerValue(h.request.target,h.receipt.value))&&!(supplied==='ongoing'&&h.receipt.value==='העבודה נמשכת'):supplied!==null)))throw Error('ENTITLEMENT_ANSWER_VALUE_CHANGED');
  }
  if('reading_receipt_sha256'in object&&'document_id'in object&&'file_sha256'in object) citation(object as DocumentReviewSource);
  if('source_manifest'in object){
   if(!Array.isArray(object.source_manifest))throw Error('ENTITLEMENT_MANIFEST_REQUIRED');
   for(const item of object.source_manifest){
    const pin=item as Record<string,unknown>,document=documents.find(d=>d.document_id===pin.document_id&&d.version_id===pin.version_id);
    if(pin.kind==='customer_answer'||pin.kind==='questionnaire')continue; // Each answer citation is admitted above and rechecked by the calculation executor.
    if(!document||document.file_sha256!==pin.file_sha256||document.page_count!==pin.page_count
     ||(pin.kind==='legal_source'?pin.case_id!==null:pin.case_id!==input.case_id))throw Error('ENTITLEMENT_MANIFEST_BINDING');
   }
  }
  for(const [key,item]of Object.entries(object))visit(item,depth+1,path?path+'.'+key:key);
 }
 visit(packet);
 return packet;
}
