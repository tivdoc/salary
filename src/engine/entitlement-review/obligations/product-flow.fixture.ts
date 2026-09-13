import {buildSyntheticCaseFixture} from '../../case-analysis/synthetic-fixtures.ts';
import type {StoredCaseInputSnapshot} from '../../case-analysis/contracts.ts';
import {rawDocumentObservationSchema,type RawDocumentObservation} from '../../extraction/document-evidence/contracts.ts';
import {normalizeDocumentEvidence} from '../../extraction/document-evidence/normalization.ts';
import {createDocumentEvidenceReadingTarget,resolveDocumentEvidenceReading} from '../../extraction/document-evidence/reading.ts';
import {savedNonPayslipEvidenceSchema,type SavedNonPayslipEvidence} from '../../extraction/document-evidence/snapshot.ts';
import {documentReviewInputSchema} from '../../document-review/contracts.ts';
import {attachNonPayslipInventory} from '../../document-review/non-payslip.ts';
import {attachAutomaticNonPayslipEvidence} from '../automatic-nonpay.ts';
import {obligationsEntitlementInputSchema} from './contracts.ts';
import {produceObligationSourceEvidence,OBLIGATION_POSITIVE_SOURCE_GRAMMAR} from './product-source-evidence.ts';

export const uuid=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const period={from:'2026-06-01',to:'2026-06-30'};
export const observation=(semantic:RawDocumentObservation['semantic'],value_kind:RawDocumentObservation['value_kind'],raw_value:string,unit:RawDocumentObservation['unit']=null,row='clause',label:string=semantic)=>rawDocumentObservationSchema.parse({
 block_id:'synthetic.clause.block',row_id:row,cell_id:semantic,semantic,value_kind,raw_value,source_label:label,unit,page:1,locator:`synthetic.${row}.${semantic}`,text_fragment:raw_value,state:'present',confidence:1,warnings:[]});
export function fixture(options:{linear?:boolean;bonus?:boolean;agreement?:boolean;inventory?:boolean;extra?:RawDocumentObservation[];partial?:boolean}={}){
 const old=buildSyntheticCaseFixture({fixture_id:'obligation-source-oracle',mode:'real'}),linear=options.linear??false;
 const document={...old.stored.documents[0],document_type:'contract' as const,document_period:null,created_at:'2026-07-01T00:00:00Z'};
 const observations=[observation('clause_text','text',linear?'המעסיק ישלם לעובד 12.50 ש״ח לכל משמרת בחודש.':options.bonus?'המעסיק ישלם לעובד בונוס בסך 500 ש״ח בכל חודש.':'המעסיק ישלם לעובד 500 ש״ח בכל חודש.'),
  observation(linear?'rate':'amount','money',linear?'12.50':'500','ILS'),observation('effective_from','iso_date','2026-02-01'),observation('effective_to','iso_date','2026-12-31'),
  ...(linear?[observation('quantity','decimal','8','count','clause','משמרות שבוצעו'),observation('period_start','iso_date',period.from),observation('period_end','iso_date',period.to)]:[]),
  ...(options.agreement===false?[]:[observation('source_label','text','הצדדים הסכימו ביום 2026-02-01 להחיל את ההתחייבות שבסעיף זה.',null,'agreement',OBLIGATION_POSITIVE_SOURCE_GRAMMAR.agreement_label)]),
  ...(options.inventory===false?[]:[observation('source_label','text',OBLIGATION_POSITIVE_SOURCE_GRAMMAR.unconditional_statement,null,'conditions',OBLIGATION_POSITIVE_SOURCE_GRAMMAR.unconditional_label)]),...(options.extra??[])];
 const extraction=normalizeDocumentEvidence({document,physicalPageCount:1,raw:{schema_version:'document-evidence-provider-v1',detected_document_type:'contract',page_count:1,pages:[{page:1,coverage:options.partial?'partial':'complete',missing_regions:[]}],observations,warnings:[]}});
 let record:SavedNonPayslipEvidence=savedNonPayslipEvidenceSchema.parse({document,product_document_id:uuid(30),checkpoint_result_sha256:'c'.repeat(64),provider_receipt_sha256:'b'.repeat(64),extraction,failure_code:null,readings:[]});
 const snapshot=():StoredCaseInputSnapshot=>({...old.stored,documents:[document],extractions:[],non_payslip_evidence:[record]});
 const answer=(semantic:string,action:unknown={action:'confirm'},row?:string)=>{
  for(const o of extraction.observations.filter(o=>o.original.semantic===semantic&&(row===undefined||o.original.row_id===row))){
   const target=createDocumentEvidenceReadingTarget({normalized:extraction,productDocumentId:record.product_document_id,checkpointSha256:record.checkpoint_result_sha256!,policyVersion:'saved-document-evidence-v1',month:'2026-06',observationId:o.observation_id});
   const prior=record.readings.find(r=>r.target.observation.observation_id===o.observation_id);
   const r=resolveDocumentEvidenceReading({target,currentTarget:target,caseId:document.case_id,answer:action,requestId:uuid(100+extraction.observations.indexOf(o)),answerRevision:(prior?.answer_revision??0)+1,identityId:uuid(300),answeredAt:'2026-07-02T00:00:00Z'});
   if(r.state!=='current')throw Error('SYNTHETIC_TARGET');record={...record,readings:[...record.readings.filter(x=>x.target.observation.observation_id!==o.observation_id),r.reading]};
  }
 };
 const identify=()=>{for(const o of extraction.observations)answer(o.original.semantic,{action:'confirm'},o.original.row_id??undefined);};
 const run=()=>{
  const base=attachNonPayslipInventory(documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:document.case_id,period,purchased_scope:{order_id:'synthetic.order',receipt_sha256:'a'.repeat(64),topics:['contract','bonuses'],origin:'saved_order'},
   documents:[{case_id:document.case_id,document_id:document.document_id,version_id:document.document_id,file_sha256:document.content_sha256,page_count:null,kind:'contract',label:'Synthetic source document',period:null,reading_origin:'source_inventory',reading_sha256:'d'.repeat(64)}],
   checks:[],completion_input:{case_id:document.case_id,period,documents:[],needs:[],evidence:[]}}),snapshot());
  const review=attachAutomaticNonPayslipEvidence(base,snapshot()).input,input=obligationsEntitlementInputSchema.parse(review.entitlement_evidence!.obligations);
  return {review,input,result:produceObligationSourceEvidence(input,input.obligations[0].obligation_id,review)};
 };
 return {identify,answer,run,extraction};
}
