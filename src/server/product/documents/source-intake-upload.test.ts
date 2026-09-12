import {it,expect} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {sourceIntakeUploadFixture} from './source-intake-upload.fixture';
import {assessSourceIntakeUpload,projectSourceIntakeUploadContext,sourceIntakeUploadReceiptSchema} from './source-intake-upload';
const seal=<T extends {receipt_sha256:string}>(value:T)=>{const {receipt_sha256,...body}=value;void receipt_sha256;return {...body,receipt_sha256:canonicalSha256(body)};};
it('records actual received files without a purchase month, answer or financial success',()=>{
 const f=sourceIntakeUploadFixture();expect(f.receipt).toMatchObject({month:null,state:'received_pending_reading',information_satisfied:false,purchased_topics:f.scope.target.purchased_topics});
 expect(f.receipt.purchased_topics).toHaveLength(9);expect(f.receipt).not.toHaveProperty('analysis_run_id');expect(f.receipt).not.toHaveProperty('answer');
 const current={...f.context,journal:{...f.context.journal,answers:[]}};current.journalSha256=canonicalSha256(current.journal);
 expect(assessSourceIntakeUpload({...f,journalContext:current})).toMatchObject({state:'received_pending_reading',information_satisfied:false,reason:'source_reading_required'});
});
it('satisfies only source intake after exact uploaded-source reading replay and keeps all nine financial topics separate',()=>{
 const f=sourceIntakeUploadFixture(),before=canonicalSha256(f.context),result=assessSourceIntakeUpload({...f,journalContext:f.context});
 expect(result).toMatchObject({state:'satisfied',information_satisfied:true,reason:'source_period_identified',financial_analysis_completed:false});expect(result.reading_sha256s).toHaveLength(1);
 expect(result.verified_source_pins).toEqual([{case_id:f.caseId,document_id:f.document.id,version_id:f.document.version_id,source_sha256:f.document.sha256}]);
 expect(canonicalSha256(f.context)).toBe(before);expect(result).not.toHaveProperty('analysis_run_id');
});
it.each(['unknown','unreadable','partial','absent_period'] as const)('keeps %s source evidence insufficient without replacing historical answers',kind=>{
 const f=sourceIntakeUploadFixture();f.answerRow.answer=JSON.stringify(kind==='unknown'||kind==='unreadable'?{v:1,action:kind}:{...f.answer,value:{...f.answer.value,period:kind==='partial'?{from:'2026-06-15',to:'2026-06-30'}:null}});
 f.answerRow.answer_revision=2;f.context.journalSha256=canonicalSha256(f.context.journal);const before=canonicalSha256(f.context);
 expect(assessSourceIntakeUpload({...f,journalContext:f.context})).toMatchObject({state:'insufficient',information_satisfied:false});expect(canonicalSha256(f.context)).toBe(before);
});
it('rejects replaced receipt source and duplicate content independently of a positive reading',()=>{
 const f=sourceIntakeUploadFixture(),other=sourceIntakeUploadReceiptSchema.parse(seal({...f.receipt,files:f.receipt.files.map(v=>({...v,source_sha256:'f'.repeat(64)}))}));
 expect(assessSourceIntakeUpload({...f,receipt:other,journalContext:f.context})).toMatchObject({state:'stale',information_satisfied:false});
 const duplicate=sourceIntakeUploadReceiptSchema.parse(seal({...f.receipt,files:f.receipt.files.map(v=>({...v,duplicate_content:true}))}));
 expect(assessSourceIntakeUpload({...f,receipt:duplicate,journalContext:f.context})).toMatchObject({state:'insufficient',reason:'duplicate_content'});
});
it('refuses altered receipts, nine-topic scope and foreign context instead of manufacturing an assessment',()=>{
 const f=sourceIntakeUploadFixture();expect(()=>sourceIntakeUploadReceiptSchema.parse({...f.receipt,month:'2026-06'})).toThrow();
 expect(()=>sourceIntakeUploadReceiptSchema.parse(seal({...f.receipt,purchased_topics:f.receipt.purchased_topics.slice(0,3)}))).toThrow();
 expect(()=>assessSourceIntakeUpload({...f,receipt:{...f.receipt,receipt_sha256:'a'.repeat(64)},journalContext:f.context})).toThrow();
 expect(()=>projectSourceIntakeUploadContext({scope:f.scope,receipt:f.receipt,journalContext:f.context,reading_request_ids:[]},f.answerRow.id)).toThrow('SCOPE');
});
it('projects an unanswered original need as requested and later source evidence without inventing a monthly run',()=>{
 const f=sourceIntakeUploadFixture(),requested=projectSourceIntakeUploadContext({scope:f.scope,receipt:null,journalContext:f.context,reading_request_ids:[]},f.caseId);
 expect(requested).toMatchObject({state:{state:'requested',information_satisfied:false},assessment:null});
 const ready=projectSourceIntakeUploadContext({scope:f.scope,receipt:f.receipt,journalContext:f.context,reading_request_ids:[f.answerRow.id]},f.caseId);
 expect(ready.state).toMatchObject({state:'satisfied',information_satisfied:true,reading_request_ids:[f.answerRow.id]});
 expect(()=>projectSourceIntakeUploadContext({scope:f.scope,receipt:null,journalContext:{...f.context,sourceAnchors:[]},reading_request_ids:[]},f.caseId)).toThrow('ANCHOR');
});
it('binds a known request month to receipt and positive payslip reading without assigning a file month',()=>{
 const f=sourceIntakeUploadFixture('2026-06');expect(f.receipt).toMatchObject({month:'2026-06',files:[{period_month:null}]});
 expect(projectSourceIntakeUploadContext({scope:f.scope,receipt:f.receipt,journalContext:f.context,reading_request_ids:[]},f.caseId).state.state).toBe('satisfied');
 const mismatched=sourceIntakeUploadReceiptSchema.parse(seal({...f.receipt,month:'2026-07'}));
 expect(()=>assessSourceIntakeUpload({...f,receipt:mismatched,journalContext:f.context})).toThrow('SCOPE');
 for(const value of [{...f.answer.value,period:{from:'2026-07-01',to:'2026-07-31'}},{...f.answer.value,document_kind:'attendance'}]){
  const changed=sourceIntakeUploadFixture('2026-06');changed.answerRow.answer=JSON.stringify({...changed.answer,value});changed.answerRow.answer_revision=2;changed.context.journalSha256=canonicalSha256(changed.context.journal);
  expect(assessSourceIntakeUpload({...changed,journalContext:changed.context})).toMatchObject({state:'insufficient',information_satisfied:false});
 }
});
