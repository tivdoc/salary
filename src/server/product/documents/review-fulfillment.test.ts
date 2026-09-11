import {expect,it} from 'vitest';
import {generateReviewCompletions,type ReviewEvidence} from '@/engine/document-review/completions';
import {documentReviewInputSchema,type DocumentReviewInput} from '@/engine/document-review/contracts';
import {runDocumentReview} from '@/engine/document-review/service';
import {assessReviewUpload,buildReviewUploadReceipt,reviewUploadReceiptSchema,type ReviewUploadScope} from './review-fulfillment';
import {LEGACY_PAID_TOPICS} from '@/server/product/orders/legacy-paid-receipt';
import type {DocumentReviewCalculationInput} from '@/engine/document-review/calculations';
const caseId='11111111-1111-4111-8111-111111111111',orderId='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333';
const documentId='44444444-4444-4444-8444-444444444444',versionId='55555555-5555-4555-8555-555555555555',batchId='66666666-6666-4666-8666-666666666666';
const period={from:'2026-06-01',to:'2026-06-30'},pin={case_id:caseId,document_id:documentId,version_id:versionId,source_sha256:'a'.repeat(64)};
function fixture(factKey='payslip.complete'){
 const request=generateReviewCompletions({case_id:caseId,period,documents:[],evidence:[],needs:[{fact_key:factKey,kind:'document',document_kind:'payslip',
  reason:'unreadable',required_evidence_kind:'document',question:'נא לצרף תלוש מלא וקריא ליוני.',answer_kind:'document',source_pins:[],dependent_check_ids:['source.payslip'],general_question:false}]}).customer_requests[0];
 const scope:ReviewUploadScope={request_id:requestId,request,order_id:orderId,order_origin:'saved_order',order_receipt_sha256:'b'.repeat(64)};
 const file={document_id:documentId,version_id:versionId,source_sha256:pin.source_sha256,document_kind:'payslip' as const,period_month:'2026-06',duplicate_content:false};
 const receive={scope,case_id:caseId,batch_id:batchId,received_at:'2026-09-11T18:00:00Z',files:[file],existing_source_hashes:[] as string[]};
 const evidence:ReviewEvidence={evidence_id:'observed.full-payslip',case_id:caseId,fact_key:factKey,period,origin:'document',state:'observed',value:'The requested complete payroll content was read.',source_pins:[pin],source_reviewed:true};
 const input=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:caseId,period,
  purchased_scope:{order_id:orderId,receipt_sha256:scope.order_receipt_sha256,topics:['minimum_wage'],origin:'saved_order'},
  documents:[{case_id:caseId,document_id:documentId,version_id:versionId,file_sha256:pin.source_sha256,page_count:1,kind:'payslip',label:'Synthetic uploaded payroll',period,reading_origin:'ai_document_review',reading_sha256:'c'.repeat(64)}],
  checks:[],coverage_gaps:[{check_id:'source.payslip',topic:'minimum_wage',kind:'missing_rule',detail:'Independent legal execution not implemented in this fixture.',next_step:'No legal amount is asserted.'}],
  completion_input:{case_id:caseId,period,documents:[{pin,kind:'payslip',period,review:'complete'}],needs:[],evidence:[evidence]}});
 const review=()=>runDocumentReview(input,'synthetic-verified-analysis');
 const assess=()=>assessReviewUpload({scope,receipt:buildReviewUploadReceipt(receive),review:review(),current_source_pins:[pin]});
 return {scope,file,receive,input,review,assess};
}
it('records receipt separately from satisfaction and binds exact case, order, target, batch and immutable version',()=>{
 const f=fixture(),r=buildReviewUploadReceipt(f.receive);expect(r.state).toBe('received_pending_review');expect(r).not.toHaveProperty('information_satisfied');
 expect(r).toMatchObject({request_id:requestId,batch_id:batchId,order_id:orderId,files:[f.file]});expect(buildReviewUploadReceipt(f.receive)).toEqual(r);
 expect(()=>reviewUploadReceiptSchema.parse({...r,batch_id:requestId})).toThrow();
 expect(()=>buildReviewUploadReceipt({...f.receive,case_id:orderId})).toThrow('FORBIDDEN');
 expect(()=>buildReviewUploadReceipt({...f.receive,files:[{...f.file,period_month:'2026-07'}]})).toThrow('REQUEST_CONFLICT');
 expect(()=>buildReviewUploadReceipt({...f.receive,files:[{...f.file,document_kind:'contract'}]})).toThrow('REQUEST_CONFLICT');
});
it('satisfies only target-specific positive observed content from the current submitted version and same analysis',()=>{
 const f=fixture(),a=f.assess();expect(a).toMatchObject({state:'satisfied',information_satisfied:true,verified_source_pins:[pin],
  analysis_run_id:'synthetic-verified-analysis',analysis_result_sha256:f.review().result_sha256,invalidated_check_ids:['source.payslip']});
 expect(a.customer_declaration_is_source).toBe(false);expect(f.assess()).toEqual(a);
});
it('accepts ordinary immutable-version document identities while retaining the submitted product-document pin',()=>{
 const f=fixture(),versionPin={...pin,document_id:versionId};
 f.input.documents[0].document_id=versionId;
 const planner=f.input.completion_input as {documents:{pin:typeof pin}[];evidence:ReviewEvidence[]};
 planner.documents[0].pin=versionPin;planner.evidence[0]={...planner.evidence[0],source_pins:[versionPin]};
 expect(f.assess()).toMatchObject({state:'satisfied',verified_source_pins:[pin]});
 const foreign=fixture(),foreignPlanner=foreign.input.completion_input as {evidence:ReviewEvidence[]};
 foreignPlanner.evidence[0]={...foreignPlanner.evidence[0],source_pins:[{...versionPin,document_id:requestId}]};
 expect(()=>foreign.assess()).toThrow();
});
it.each(['absent','declared','unknown','conflicted','wrong_fact','wrong_source','wrong_period'] as const)('keeps %s target evidence unsatisfied even when the document is globally complete',kind=>{
 const f=fixture(),planner=f.input.completion_input as {evidence:ReviewEvidence[]};
 if(kind==='absent')planner.evidence=[];
 if(kind==='declared')planner.evidence=[{...planner.evidence[0],origin:'answer',state:'declared'}];
 if(kind==='unknown'||kind==='conflicted')planner.evidence=[{...planner.evidence[0],state:kind,value:null}];
 if(kind==='wrong_fact')planner.evidence=[{...planner.evidence[0],fact_key:'different.fact'}];
 if(kind==='wrong_source')planner.evidence=[{...planner.evidence[0],source_pins:[],state:'declared',origin:'questionnaire'}];
 if(kind==='wrong_period')planner.evidence=[{...planner.evidence[0],period:{from:'2026-05-01',to:'2026-05-31'}}];
 expect(f.assess()).toMatchObject({state:'insufficient',information_satisfied:false,verified_source_pins:[]});
});
it.each(['partial','unreadable','not_reviewed'] as const)('does not accept a %s document from a positive overall assertion',state=>{
 const f=fixture(),planner=f.input.completion_input as {documents:{review:string}[]};planner.documents[0].review=state;
 expect(f.assess()).toMatchObject({state:'insufficient',reason:'submitted_document_not_fully_verified'});
});
it('refuses duplicate content even when it has a new version UUID and rejects replaced sources',()=>{
 const f=fixture();f.receive.existing_source_hashes=[pin.source_sha256];expect(f.assess()).toMatchObject({state:'insufficient',reason:'duplicate_content'});
 const r=buildReviewUploadReceipt({...f.receive,existing_source_hashes:[],files:[f.file,{...f.file,version_id:requestId}]});expect(r.files.every(v=>v.duplicate_content)).toBe(true);
 expect(assessReviewUpload({scope:f.scope,receipt:r,review:f.review(),current_source_pins:[pin]})).toMatchObject({state:'stale',reason:'submitted_source_replaced'});
});
it('does not let a filtered-away dependent check, different order, or altered same-run payload certify completion',()=>{
 const f=fixture();f.input.coverage_gaps=[];expect(f.assess()).toMatchObject({state:'insufficient',reason:'dependent_check_not_evaluated'});
 const g=fixture();expect(()=>assessReviewUpload({scope:{...g.scope,order_id:requestId},receipt:buildReviewUploadReceipt(g.receive),review:g.review(),current_source_pins:[pin]})).toThrow('SCOPE');
 expect(()=>assessReviewUpload({scope:g.scope,receipt:buildReviewUploadReceipt(g.receive),review:{...g.review(),analysis_run_id:'another-run'},current_source_pins:[pin]})).toThrow();
});

it('satisfies the exact narrow source fact while preserving partial document review and older full-source requests',()=>{
 const f=fixture('payslip.financial_source'),planner=f.input.completion_input as {documents:{review:string;review_completed_fact_keys?:string[]}[];evidence:ReviewEvidence[]};
 planner.documents[0].review='partial';planner.documents[0].review_completed_fact_keys=['payslip.financial_source'];
 expect(f.assess()).toMatchObject({state:'satisfied',information_satisfied:true});
 const missing=fixture('payslip.financial_source'),missingPlanner=missing.input.completion_input as {documents:{review:string;review_completed_fact_keys?:string[]}[];evidence:ReviewEvidence[]};
 missingPlanner.documents[0].review='partial';missingPlanner.documents[0].review_completed_fact_keys=['payslip.financial_source'];missingPlanner.evidence=[];
 expect(missing.assess()).toMatchObject({state:'insufficient',reason:'target_specific_observation_required'});
 const historical=fixture('payslip.full'),oldPlanner=historical.input.completion_input as {documents:{review:string;review_completed_fact_keys?:string[]}[]};
 oldPlanner.documents[0].review='partial';oldPlanner.documents[0].review_completed_fact_keys=['payslip.financial_source'];
 expect(historical.assess()).toMatchObject({state:'insufficient',reason:'submitted_document_not_fully_verified'});
});

function financialInventory(topics:DocumentReviewInput['purchased_scope']['topics']=[...LEGACY_PAID_TOPICS]){
 const f=fixture('payslip.financial_source');
 f.scope.request={...f.scope.request,dependent_check_ids:topics.map(topic=>`missing.payslip.${topic}`)};
 f.input.purchased_scope.topics=topics;
 f.input.coverage_gaps=topics.map(topic=>({check_id:`current.${topic}`,topic,kind:'missing_rule' as const,
  detail:'The financial source was read; this legal check remains unavailable.',next_step:'Keep the legal coverage gap visible.',source_pins:[pin]}));
 const planner=f.input.completion_input as {documents:{review:string;review_completed_fact_keys?:string[]}[]};
 planner.documents[0].review='partial';planner.documents[0].review_completed_fact_keys=['payslip.financial_source'];
 return f;
}
it.each([false,true])('maps all purchased source sentinels to current source-bound coverage; legacy=%s',legacy=>{
 const f=financialInventory(legacy?[...LEGACY_PAID_TOPICS]:['minimum_wage','pension','working_time']);
 if(legacy){f.scope.order_origin='legacy_paid_receipt';f.input.purchased_scope.origin='legacy_paid_receipt';}
 expect(f.assess()).toMatchObject({state:'satisfied',information_satisfied:true,verified_source_pins:[pin]});
 const reviewed=f.review();expect(reviewed.coverage_gaps.every(g=>g.kind==='missing_rule')).toBe(true);
 expect(reviewed).toMatchObject({checks:[],legal_debt_total:null,publication_authority:false});
});
it.each(['missing_topic','unpinned_gap','arbitrary_dependency','extra_dependency','missing_dependency','old_full_target'] as const)('refuses financial inventory fallback with %s',kind=>{
 const f=financialInventory();
 if(kind==='missing_topic')f.input.coverage_gaps.pop();
 if(kind==='unpinned_gap')delete f.input.coverage_gaps[0].source_pins;
 if(kind==='arbitrary_dependency')f.scope.request={...f.scope.request,dependent_check_ids:['arbitrary.check',...f.scope.request.dependent_check_ids.slice(1)]};
 if(kind==='extra_dependency')f.scope.request={...f.scope.request,dependent_check_ids:[...f.scope.request.dependent_check_ids,'extra.check']};
 if(kind==='missing_dependency')f.scope.request={...f.scope.request,dependent_check_ids:f.scope.request.dependent_check_ids.slice(1)};
 if(kind==='old_full_target'){
  const historical=fixture('payslip.full');f.scope.request={...historical.scope.request,dependent_check_ids:f.scope.request.dependent_check_ids};
 }
 expect(f.assess()).toMatchObject({state:'insufficient',reason:'dependent_check_not_evaluated',information_satisfied:false});
});
it.each(['foreign_case','changed_hash','changed_version','unrelated_document'] as const)('rejects %s gap provenance instead of accepting topic names as coverage',kind=>{
 const f=financialInventory(),original=pin;
 f.input.coverage_gaps[0].source_pins=[{...original,
  ...(kind==='foreign_case'?{case_id:orderId}:kind==='changed_hash'?{source_sha256:'d'.repeat(64)}:
   kind==='changed_version'?{version_id:requestId}:{document_id:requestId})}];
 expect(()=>f.assess()).toThrow('REVIEW_GAP_SOURCE_MISMATCH');
});
it('leaves optional gap provenance absent in historical inputs and accepts immutable-version aliases',()=>{
 const historical=fixture();expect(documentReviewInputSchema.parse(historical.input).coverage_gaps[0]).not.toHaveProperty('source_pins');
 const f=financialInventory();f.input.documents[0].document_id=versionId;
 const planner=f.input.completion_input as {documents:{pin:typeof pin}[];evidence:ReviewEvidence[]};
 planner.documents[0].pin={...pin,document_id:versionId};planner.evidence[0]={...planner.evidence[0],source_pins:[{...pin,document_id:versionId}]};
 expect(f.assess()).toMatchObject({state:'satisfied',verified_source_pins:[pin]});
});
it('accepts a genuinely evaluated check citing submitted operands for one topic and preserves the other topic gaps',()=>{
 const f=financialInventory(['pension','working_time']),source={document_id:documentId,version_id:versionId,file_sha256:pin.source_sha256,
  page:1,locator:'synthetic printed pension/base rows',label:'printed values',reading:'ai_document_review' as const,reading_receipt_sha256:'c'.repeat(64)};
 const calculation:DocumentReviewCalculationInput={schema_version:'document-review-calculation-input-v1',case_id:caseId,run_id:'original-run',check_id:'current.pension.ratio',period,evaluated_at:'2026-09-11T18:00:00Z',
  source_manifest:[{document_id:documentId,version_id:versionId,file_sha256:pin.source_sha256,page_count:1,kind:'case_document',case_id:caseId}],
  operands:[{id:'contribution',observation_id:'printed.contribution',printed_value:'198.00'},{id:'base',observation_id:'printed.base',printed_value:'3300.00'}].map(operand=>({...operand,state:'observed',representation:'money_ils',quantity_unit:null,precision:'printed_precision',source})),
  operation:{kind:'observed_ratio',numerator_ref:'contribution',denominator_ref:'base',component_identity:'employee printed contribution',same_period_and_base:true,basis:'same submitted source and month'},remittance_status:'not_assessed'};
 f.input.checks=[{check_id:calculation.check_id,topic:'pension',title:'Observed pension ratio',explanation:'Source arithmetic only.',calculation}];
 f.input.coverage_gaps=f.input.coverage_gaps.filter(g=>g.topic!=='pension');
 expect(f.assess()).toMatchObject({state:'satisfied'});expect(f.review().checks[0].calculation.state).toBe('calculated');
});
