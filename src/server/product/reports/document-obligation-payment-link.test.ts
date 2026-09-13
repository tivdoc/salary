import {expect,it} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {normalizeMoney} from '@/engine/extraction/normalization';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {payslipMachineExtractionSha256} from '@/engine/extraction/reading-resolution';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY} from '@/engine/document-review/payslip-adapter';
import {fixture as contractFixture,uuid} from '@/engine/entitlement-review/obligations/product-flow.fixture';
import {obligationPaymentLinkTargets} from '@/engine/entitlement-review/obligations/payment-link';
import {createObligationPaymentChoiceTarget,documentObligationPaymentTargetSchema,obligationPaymentChoiceTargetSchema,selectedObligationPaymentTarget,
 validateDocumentObligationPaymentLinkAnswer,documentObligationPaymentLinkQuestion,documentObligationPaymentLinkDisplay} from './document-obligation-payment-link';
import {documentReadingTargetSchema,documentReadingTargetForCheckpoint} from './document-field-confirmation';
import {validateDocumentReadingAnswerForTarget,documentFieldVerificationDisplay} from './reading-verification';

/** Both payment candidates originate in ordinary adapter output from two
 * synthetic identified source rows. No hand-prepared review operand is used. */
function fixture(){
 const contract=contractFixture();contract.identify();const {review,input}=contract.run(),old=buildSyntheticCaseFixture({fixture_id:'synthetic-obligation-choice-payroll',mode:'real'});
 const caseId=review.case_id,id=uuid(710),period=review.period;
 const document={...old.stored.documents[0],case_id:caseId,document_id:id,storage_path:`cases/${caseId}/documents/${id}/original.pdf`,document_period:{start_date:period.from,end_date:period.to}};
 const source=(page:number)=>({document_id:id,page,text_fragment:`Synthetic identified payment row ${page}`,source_scope:{period_kind:'current' as const,fund_kind:'unknown' as const,column_label:'Current payment'}});
 const rows=['450.00','440.00'].map((raw,i)=>({component_id:uuid(711+i),source_label:`תשלום סינתטי ${i+1}`,normalized_label:`synthetic.payment.${i+1}`,semantic_kind:'bonus',
  quantity_raw:'1',rate_raw:raw,percentage_raw:null,amount_raw:raw,quantity:'1',rate:normalizeMoney(raw),percentage:null,amount:normalizeMoney(raw),confidence:1,
  source:source(i+1),extraction_method:'fixture',warning_flags:[],normalization_warnings:[]}));
 const p=old.stored.extractions[0].fields.find(p=>p.field==='salary_period')!;
 const machine=normalizedPayslipExtractionSchema.parse({...old.stored.extractions[0],document_id:id,extracted_at:'2026-07-02T00:00:00Z',quality_metrics:{...old.stored.extractions[0].quality_metrics,page_count:2},
  fields:[{...p,source:source(1),raw_value:'06/2026',normalized_value:{year:2026,month:6,start_date:period.from,end_date:period.to}}],additional_components:rows,earnings_components_complete:false});
 const extraction=normalizedPayslipExtractionSchema.parse({...machine,customer_row_readings:machine.additional_components.map((r,i)=>({schema_version:'document-row-cell-reading-v1',actor_kind:'customer',case_id:caseId,document_id:id,
  component_id:r.component_id,cell:'amount',source_sha256:document.content_sha256,normalized_extraction_sha256:payslipMachineExtractionSha256(machine),original_component_sha256:canonicalSha256(r),
  extraction_result_sha256:'d'.repeat(64),target_sha256:canonicalSha256({synthetic:r.component_id}),month:'2026-06',request_id:uuid(720+i),answer_revision:1,identity_id:uuid(725),confirmed_at:'2026-07-03T00:00:00Z'}))});
 const payroll=reviewInputFromPayslips({case_id:caseId,period,purchased_scope:review.purchased_scope,review_policy:PAYSLIP_REVIEW_POLICY,snapshot:{...old.stored,documents:[document],extractions:[extraction]}});
 const merged={...review,documents:[...review.documents,...payroll.documents],checks:payroll.checks};
 const candidates=obligationPaymentLinkTargets({review:merged,obligation:input.obligations[0],payrollSources:[{version_id:id,product_document_id:uuid(726),checkpoint_sha256:'d'.repeat(64),policy_version:'synthetic-payment-choice-v1'}]});
 const dependencies=[...(review.non_payslip_evidence??[]).flatMap(e=>e.readings.map(r=>({version_id:e.document.document_id,request_id:r.request_id,answer_revision:r.answer_revision,answer_sha256:canonicalSha256(r.answer)}))),
  ...(extraction.customer_row_readings??[]).map(r=>({version_id:r.document_id,request_id:r.request_id,answer_revision:r.answer_revision,answer_sha256:canonicalSha256({schema_version:'document-field-answer-v2',action:'confirm'})}))];
 const purchase={order_id:uuid(730),origin:'legacy_paid_receipt' as const,receipt_sha256:'e'.repeat(64),topics:review.purchased_scope.topics},target=createObligationPaymentChoiceTarget(candidates,purchase,dependencies);
 const selected=target.candidates.find(c=>c.amount.source.page===2)!;
 const answer={action:'correct' as const,candidate_target_sha256:selected.target_sha256,value:{relationship:'same_obligation' as const,basis:{page:2,locator:'Synthetic payroll row reference',text:'Explicit synthetic reference from the chosen payroll row to this clause'}}};
 return {candidates,purchase,target,selected,answer,dependencies};
}
const rehash=<T extends {target_sha256:string}>(value:T):T=>{const {target_sha256,...body}=value;void target_sha256;return {...value,target_sha256:canonicalSha256(body)};};
it('creates one deterministic purchase-bound choice for two ordinary payroll rows',()=>{
 const f=fixture(),before=canonicalSha256(f.candidates);expect(f.target.candidates).toHaveLength(2);
 expect(createObligationPaymentChoiceTarget([...f.candidates].reverse(),f.purchase,[...f.dependencies].reverse())).toEqual(f.target);expect(canonicalSha256(f.candidates)).toBe(before);
 expect(f.target).toMatchObject({order_id:f.purchase.order_id,order_origin:f.purchase.origin,order_receipt_sha256:f.purchase.receipt_sha256});
 expect(documentReadingTargetSchema.parse(f.target)).toEqual(f.target);expect(documentObligationPaymentTargetSchema.parse(f.target)).toEqual(f.target);
 expect(documentReadingTargetForCheckpoint({target:f.target,obligationPaymentTarget:f.target})).toEqual(f.target);
});
it.each(['order_id','origin','receipt_sha256'] as const)('invalidates an old target when purchase %s changes',key=>{
 const f=fixture(),purchase={...f.purchase,...(key==='order_id'?{order_id:uuid(731)}:key==='origin'?{origin:'saved_order' as const}:{receipt_sha256:'f'.repeat(64)})};
 const changed=createObligationPaymentChoiceTarget(f.candidates,purchase,f.dependencies);expect(changed.target_sha256).not.toBe(f.target.target_sha256);
 expect(()=>documentReadingTargetForCheckpoint({target:f.target,obligationPaymentTarget:changed})).toThrow('REQUEST_FIELD_SOURCE_CHANGED');
});
it('requires current server context and rejects an answer-side candidate removed from it',()=>{
 const f=fixture();expect(()=>documentReadingTargetForCheckpoint({target:f.target})).toThrow('OBLIGATION_PAYMENT_CONTEXT_REQUIRED');
 const current=createObligationPaymentChoiceTarget(f.target.candidates.filter(c=>c.target_sha256!==f.selected.target_sha256),f.purchase,f.dependencies);
 expect(()=>documentReadingTargetForCheckpoint({target:f.target,obligationPaymentTarget:current})).toThrow('REQUEST_FIELD_SOURCE_CHANGED');
 expect(()=>selectedObligationPaymentTarget(current,f.selected.target_sha256)).toThrow('REQUEST_ANSWER_INVALID');
});
it('requires an explicit selected hash even when the wrapper contains one candidate',()=>{
 const f=fixture(),{candidate_target_sha256,...bare}=f.answer;void candidate_target_sha256;
 for(const target of [f.target,createObligationPaymentChoiceTarget([f.selected],f.purchase,f.dependencies)]){
  expect(()=>selectedObligationPaymentTarget(target)).toThrow('REQUEST_ANSWER_INVALID');expect(()=>validateDocumentObligationPaymentLinkAnswer(target,bare)).toThrow('REQUEST_ANSWER_INVALID');
 }
 expect(selectedObligationPaymentTarget(f.target,f.selected.target_sha256)).toEqual(f.selected);
});
it.each(['same_obligation','different_obligation'] as const)('validates the %s wire value through the shared answer dispatcher without granting numeric approval',relationship=>{
 const f=fixture(),answer={...f.answer,value:{...f.answer.value,relationship}};
 expect(validateDocumentObligationPaymentLinkAnswer(f.target,answer)).toEqual(answer);expect(validateDocumentReadingAnswerForTarget(f.target,JSON.stringify(answer))).toEqual(answer);
 expect(answer).not.toHaveProperty('amount');expect(answer).not.toHaveProperty('scope_assessment');expect(answer).not.toHaveProperty('legal_applicability');
});
it.each(['unknown','unreadable'] as const)('keeps %s valid without choosing a payment and rejects hidden affirmative data',action=>{
 const f=fixture(),answer={action};expect(validateDocumentObligationPaymentLinkAnswer(f.target,JSON.stringify(answer))).toEqual(answer);
 expect(validateDocumentReadingAnswerForTarget(f.target,answer)).toEqual(answer);
 expect(()=>validateDocumentObligationPaymentLinkAnswer(f.target,{...answer,candidate_target_sha256:f.selected.target_sha256})).toThrow('REQUEST_ANSWER_INVALID');
 expect(()=>validateDocumentObligationPaymentLinkAnswer(f.target,{...answer,value:f.answer.value})).toThrow('REQUEST_ANSWER_INVALID');
});
it.each(['foreign_hash','wrong_page','empty_locator','empty_text','oversize_text','confirmation','extra_amount','scalar_answer','malformed_json','oversize_wire'] as const)('rejects %s before source-link saving',kind=>{
 const f=fixture(),answer=kind==='foreign_hash'?{...f.answer,candidate_target_sha256:'f'.repeat(64)}
  :kind==='wrong_page'?{...f.answer,value:{...f.answer.value,basis:{...f.answer.value.basis,page:1}}}
  :kind==='empty_locator'?{...f.answer,value:{...f.answer.value,basis:{...f.answer.value.basis,locator:''}}}
  :kind==='empty_text'?{...f.answer,value:{...f.answer.value,basis:{...f.answer.value.basis,text:''}}}
  :kind==='oversize_text'?{...f.answer,value:{...f.answer.value,basis:{...f.answer.value.basis,text:'x'.repeat(161)}}}
  :kind==='confirmation'?{...f.answer,action:'confirm'}:kind==='extra_amount'?{...f.answer,amount:'450.00'}
  :kind==='scalar_answer'?{schema_version:'document-field-answer-v2',action:'confirm'}:kind==='malformed_json'?'{':'x'.repeat(2001);
 expect(()=>validateDocumentObligationPaymentLinkAnswer(f.target,answer)).toThrow('REQUEST_ANSWER_INVALID');
});
it('rejects outer, inner and source hash tampering, including a recomputed outer digest',()=>{
 const f=fixture();expect(()=>obligationPaymentChoiceTargetSchema.parse({...f.target,order_receipt_sha256:'f'.repeat(64)})).toThrow('OBLIGATION_CHOICE_HASH');
 const inner={...f.selected,source_sha256:'f'.repeat(64)};
 expect(()=>obligationPaymentChoiceTargetSchema.parse(rehash({...f.target,candidates:[inner]}))).toThrow();
 expect(()=>obligationPaymentChoiceTargetSchema.parse(rehash({...f.target,source_sha256:'f'.repeat(64)}))).toThrow('OBLIGATION_CHOICE_SCOPE');
 const changed=createObligationPaymentChoiceTarget(f.candidates.map(c=>rehash({...c,checkpoint_sha256:'f'.repeat(64)})),f.purchase,f.dependencies);
 expect(()=>documentReadingTargetForCheckpoint({target:f.target,obligationPaymentTarget:changed})).toThrow('REQUEST_FIELD_SOURCE_CHANGED');
});
it('rejects duplicate, empty, oversized and mixed-clause choices',()=>{
 const f=fixture();expect(()=>createObligationPaymentChoiceTarget([],f.purchase,f.dependencies)).toThrow('OBLIGATION_CHOICE_SOURCE_REQUIRED');
 expect(()=>createObligationPaymentChoiceTarget([f.selected,f.selected],f.purchase,f.dependencies)).toThrow('OBLIGATION_CHOICE_SCOPE');
 const many=Array.from({length:17},(_,i)=>rehash({...f.selected,checkpoint_sha256:canonicalSha256({synthetic:i})}));expect(()=>createObligationPaymentChoiceTarget(many,f.purchase,f.dependencies)).toThrow();
 const other=rehash({...f.selected,obligation_id:'synthetic.other.clause'});expect(()=>createObligationPaymentChoiceTarget([f.selected,other],f.purchase,f.dependencies)).toThrow('OBLIGATION_CHOICE_SCOPE');
});
it('binds both source reading journals and rejects foreign dependency versions or duplicate requests',()=>{
 const f=fixture();expect(f.target.purchased_topics).toEqual(f.purchase.topics);
 expect(new Set(f.target.reading_dependencies.map(d=>d.version_id))).toEqual(new Set([f.selected.version_id,f.selected.clause.source.version_id]));
 const foreign=f.dependencies.map((d,i)=>i===0?{...d,version_id:uuid(999)}:d);
 expect(()=>createObligationPaymentChoiceTarget(f.candidates,f.purchase,foreign)).toThrow('OBLIGATION_CHOICE_DEPENDENCIES');
 expect(()=>createObligationPaymentChoiceTarget(f.candidates,f.purchase,[...f.dependencies,f.dependencies[0]])).toThrow('OBLIGATION_CHOICE_DEPENDENCIES');
});
it.each(['answer_revision','answer_sha256'] as const)('invalidates the current target when a source dependency %s changes',key=>{
 const f=fixture(),dependencies=f.dependencies.map((d,i)=>i===0?{...d,...(key==='answer_revision'?{answer_revision:d.answer_revision+1}:{answer_sha256:'f'.repeat(64)})}:d);
 const current=createObligationPaymentChoiceTarget(f.candidates,f.purchase,dependencies);
 expect(()=>documentReadingTargetForCheckpoint({target:f.target,obligationPaymentTarget:current})).toThrow('REQUEST_FIELD_SOURCE_CHANGED');
});
it('requires the source dependency inventory and purchased topics even after a recomputed hash',()=>{
 const f=fixture(),{reading_dependencies,...withoutDependencies}=f.target,{purchased_topics,...withoutTopics}=f.target;void reading_dependencies;void purchased_topics;
 expect(()=>obligationPaymentChoiceTargetSchema.parse(rehash(withoutDependencies))).toThrow();expect(()=>obligationPaymentChoiceTargetSchema.parse(rehash(withoutTopics))).toThrow();
 expect(()=>createObligationPaymentChoiceTarget(f.candidates,{...f.purchase,topics:['contract','contract']},f.dependencies)).toThrow('OBLIGATION_CHOICE_DEPENDENCIES');
 expect(()=>createObligationPaymentChoiceTarget(f.candidates,{...f.purchase,topics:['working_time']},f.dependencies)).toThrow('OBLIGATION_CHOICE_DEPENDENCIES');
});
it('rejects a missing purchase pin even if an attacker recomputes the outer hash',()=>{
 const f=fixture(),{order_receipt_sha256,...rest}=f.target;void order_receipt_sha256;
 expect(()=>obligationPaymentChoiceTargetSchema.parse(rehash(rest))).toThrow();
});
it('keeps the historical single-pair answer wire and source display compatible',()=>{
 const f=fixture(),{candidate_target_sha256,...answer}=f.answer;void candidate_target_sha256;
 expect(documentReadingTargetSchema.parse(f.selected)).toEqual(f.selected);expect(selectedObligationPaymentTarget(f.selected)).toEqual(f.selected);
 expect(validateDocumentObligationPaymentLinkAnswer(f.selected,answer)).toEqual(answer);expect(()=>validateDocumentObligationPaymentLinkAnswer(f.selected,f.answer)).toThrow('REQUEST_ANSWER_INVALID');
 expect(documentObligationPaymentLinkDisplay(f.selected)).toMatchObject({raw_value:'440.00',scope:'source_relationship_only',obligation_context:{payroll_page:2}});
});
it('returns one clause-level question and source-only choice display without selecting or approving a row',()=>{
 const f=fixture(),q=documentObligationPaymentLinkQuestion(f.target),display=documentFieldVerificationDisplay(f.target);
 expect(q.code).toBe('document_field:'+f.target.target_sha256);expect(q).toMatchObject({answer_kind:'choice',blocking:false,field_crop:'obligation.payment_link'});
 expect(display).toMatchObject({raw_value:null,scope:'source_relationship_only',actions:['correct','unknown','unreadable']});
 if(!display||!('obligation_context'in display))throw Error('SYNTHETIC_CHOICE_DISPLAY');
 expect(display.obligation_context.candidates).toHaveLength(2);expect(display.obligation_context.candidates?.map(c=>c.amount).sort()).toEqual(['440.00','450.00']);
 expect(display).not.toHaveProperty('selected_candidate');expect(display).not.toHaveProperty('scope_assessment');
});
