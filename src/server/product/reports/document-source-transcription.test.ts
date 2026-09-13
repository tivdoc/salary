import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedCandidateFieldSchema,normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {materializeValidatedPayslipReadings,identifiedSourceTranscription,payslipMachineExtractionSha256} from '@/engine/extraction/reading-resolution';
import {documentSourceTranscriptionTarget} from './document-source-transcription';
import {documentReadingTargetForCheckpoint} from './document-field-confirmation';
import {validateDocumentReadingAnswerForTarget,resolveDocumentReadingVerification,materializeDocumentVerification,documentFieldVerificationDisplay} from './reading-verification';
function fixture(kind:'reported_work_hours'|'balance_unit'|'grand_total'='reported_work_hours'){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-source-transcription',mode:'real'}),document=f.stored.documents[0],extraction=normalizedPayslipExtractionSchema.parse(structuredClone(f.stored.extractions[0]));
 const base=extraction.fields.find(c=>c.field==='gross_salary')!;
 const balance=normalizedCandidateFieldSchema.parse({...base,candidate_id:randomUUID(),field:'vacation_balance',raw_value:'7.25',normalized_value:null});
 const firstPass=normalizedPayslipExtractionSchema.parse({...extraction,fields:[...extraction.fields.filter(f=>f.field!=='vacation_balance'),balance]});
 extraction.fields=extraction.fields.filter(f=>f.field!=='vacation_balance');
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:randomUUID(),version_id:document.document_id,input_sha256:document.content_sha256,
  expected_month:'2025-01',period_mismatch:false,result_sha256:'',run:{result:{final_extraction:extraction,first_pass:{normalized_extraction:firstPass}}}};
 const rehash=()=>{checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);};rehash();
 const target=()=>documentSourceTranscriptionTarget({checkpoint,policyVersion:'source-transcription-test',subject:kind==='balance_unit'?{kind,candidateId:balance.candidate_id}:{kind,page:1}});
 const input=()=>({target:target(),currentCheckpoint:checkpoint,caseId:document.case_id,month:'2025-01',policyVersion:'source-transcription-test',requestId:randomUUID(),answerRevision:1,identityId:randomUUID(),answeredAt:'2025-02-02T00:00:00Z',
  answer:{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:kind==='grand_total'?JSON.stringify({schema_version:'grand-total-source-value-v1',amount:'20.00',label:'סך הניכויים',locator:'טבלת סיכום סינתטית, שורת סך'}):kind==='reported_work_hours'?'97.5':'days'}});
 const annotated=()=>{
  const receipt=materializeDocumentVerification(resolveDocumentReadingVerification(input()),canonicalSha256(extraction));if(receipt?.kind!=='source_transcription')throw Error('SOURCE_TRANSCRIPTION_REQUIRED');
  return {...extraction,customer_source_transcriptions:[receipt.reading],source_reading_context:{checkpoint_result_sha256:checkpoint.result_sha256,first_pass:{...firstPass}}};
 };
 return {document,extraction,firstPass,balance,checkpoint,rehash,target,input,annotated};
}
it.each(['reported_work_hours','balance_unit'] as const)('materializes identified %s separately from provider fields with a retained source context',kind=>{
 const f=fixture(kind),before=canonicalSha256(f.extraction),annotated=f.annotated();
 const result=materializeValidatedPayslipReadings({document:f.document,case_id:f.document.case_id,extraction:annotated});
 expect(result.extraction.fields).toEqual(f.extraction.fields);expect(result.extraction.additional_components).toEqual(f.extraction.additional_components);
 const receipt=identifiedSourceTranscription({original:result.original,sourceTranscriptions:result.sourceTranscriptions,subjectKind:kind,candidateId:f.balance.candidate_id});
 expect(receipt?.normalized_value).toMatchObject(kind==='reported_work_hours'?{kind,meaning:'document_reported_total_hours',amount:'97.5',unit:'hours'}:{kind,field:'vacation_balance',amount:'7.25',unit:'days',amount_verified:false,unit_verified:true});
 expect(payslipMachineExtractionSha256(annotated)).toBe(before);expect(canonicalSha256(f.extraction)).toBe(before);
 expect(documentReadingTargetForCheckpoint({target:f.target(),currentCheckpoint:f.checkpoint})).toEqual(f.target());
 expect(documentFieldVerificationDisplay(f.target())).toMatchObject({field:'source_transcription.'+kind,actions:['correct','unreadable','unknown'],raw_value:kind==='balance_unit'?'7.25':null});
});
it.each(['reported_work_hours','balance_unit'] as const)('cannot confirm an absent %s value/unit or use unknown as zero',kind=>{
 const f=fixture(kind),input=f.input();
 expect(()=>resolveDocumentReadingVerification({...input,answer:{schema_version:'document-field-answer-v2',action:'confirm'}})).toThrow('ANSWER_INVALID');
 for(const action of ['unknown','unreadable']){
  const decision=resolveDocumentReadingVerification({...input,answerRevision:2,answer:{schema_version:'document-field-answer-v2',action}});
  expect(decision).toMatchObject({state:action,effective_value:null});expect(materializeDocumentVerification(decision,canonicalSha256(f.extraction))).toBeNull();
 }
});
it('resolves only the balance unit while preserving the original amount and no invented scalar candidate',()=>{
 const f=fixture('balance_unit'),input=f.input();
 for(const corrected_raw_value of ['hours','שעות'])expect(resolveDocumentReadingVerification({...input,answer:{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value}})).toMatchObject({effective_value:{amount:'7.25',unit:'hours'}});
 for(const corrected_raw_value of ['9','7.25 days','other'])expect(()=>resolveDocumentReadingVerification({...input,answer:{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value}})).toThrow('ANSWER_INVALID');
});
it.each(['missing_context','wrong_checkpoint','foreign_first_pass','changed_retained_amount','changed_first_pass_hash','provider_context','duplicate_subject','wrong_final_hash'] as const)('engine refuses missing or changed independent source evidence: %s',kind=>{
 const f=fixture('balance_unit'),input=structuredClone(f.annotated());
 if(kind==='missing_context')Reflect.deleteProperty(input,'source_reading_context');
 if(kind==='wrong_checkpoint')input.source_reading_context.checkpoint_result_sha256='f'.repeat(64);
 if(kind==='foreign_first_pass')input.source_reading_context.first_pass.document_id=randomUUID();
 if(kind==='changed_retained_amount')input.source_reading_context.first_pass.fields.find(c=>c.candidate_id===f.balance.candidate_id)!.raw_value='99';
 if(kind==='changed_first_pass_hash'){
  const subject=input.customer_source_transcriptions[0].subject;if(subject.kind!=='balance_unit')throw Error('BALANCE_REQUIRED');subject.first_pass_extraction_sha256='f'.repeat(64);
 }
 if(kind==='provider_context')input.source_reading_context.first_pass.customer_scope_readings=[];
 if(kind==='duplicate_subject')input.customer_source_transcriptions.push({...input.customer_source_transcriptions[0],request_id:randomUUID(),target_sha256:'e'.repeat(64)});
 if(kind==='wrong_final_hash')input.customer_source_transcriptions[0].normalized_extraction_sha256='f'.repeat(64);
 expect(()=>materializeValidatedPayslipReadings({document:f.document,case_id:f.document.case_id,extraction:input})).toThrow();
});
it('requires a genuinely missing retained balance and exact current first-pass bytes',()=>{
 const f=fixture('balance_unit'),input=f.input();f.firstPass.fields.find(c=>c.candidate_id===f.balance.candidate_id)!.raw_value='8.25';f.rehash();
 expect(resolveDocumentReadingVerification(input)).toEqual({state:'stale'});
 f.extraction.fields.push(f.balance);f.rehash();expect(()=>f.target()).toThrow('RETAINED_FIELD');
});
it('does not ask for a missing hours transcription when an attendance-total observation already exists',()=>{
 const f=fixture(),candidate=f.extraction.fields.find(c=>c.field==='regular_hours')!;const {normalized_value:ignored,...raw}=candidate;void ignored;
 f.extraction.source_scope_observations=[{policy_version:'payslip-explicit-source-scope-v1',scope:'attendance_total',source_label:'סך שעות סינתטי',candidate:raw}];f.rehash();
 expect(()=>f.target()).toThrow('PRESENT_FIELD');
});
it('refuses negative, unparsed or foreign-source reported totals and does not guess HH:MM as decimals',()=>{
 const f=fixture(),input=f.input();
 for(const corrected_raw_value of ['-1','NaN','12:30','97 days','97 ימים'])expect(()=>resolveDocumentReadingVerification({...input,answer:{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value}})).toThrow('ANSWER_INVALID');
 expect(()=>resolveDocumentReadingVerification({...input,caseId:randomUUID()})).toThrow('CASE_MISMATCH');
 expect(resolveDocumentReadingVerification({...input,month:'2025-02'})).toEqual({state:'stale'});
});

it.each(['reported_work_hours','balance_unit'] as const)('rejects invalid %s answers before persistence using the same resolver semantics',kind=>{
 const f=fixture(kind),target=f.target(),before=canonicalSha256(target);
 const invalid=kind==='reported_work_hours'?['97 days','97 ימים','garbage','12:30']:['7.25 days','garbage','97'];
 for(const corrected_raw_value of invalid){
  const answer={schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value};
  expect(()=>validateDocumentReadingAnswerForTarget(target,answer)).toThrow('ANSWER_INVALID');
  expect(()=>resolveDocumentReadingVerification({...f.input(),answer})).toThrow('ANSWER_INVALID');
 }
 expect(()=>validateDocumentReadingAnswerForTarget(target,{schema_version:'document-field-answer-v2',action:'confirm'})).toThrow('ANSWER_INVALID');
 for(const action of ['unknown','unreadable'])expect(validateDocumentReadingAnswerForTarget(target,{schema_version:'document-field-answer-v2',action})).toMatchObject({action});
 expect(validateDocumentReadingAnswerForTarget(target,f.input().answer)).toEqual(f.input().answer);
 expect(canonicalSha256(target)).toBe(before);
});

it('copies a missing grand total with its printed label and locator while retaining the checkpoint bytes',()=>{
 const f=fixture('grand_total'),before=canonicalSha256(f.checkpoint),annotated=f.annotated();
 const materialized=materializeValidatedPayslipReadings({document:f.document,case_id:f.document.case_id,extraction:annotated});
 const value=identifiedSourceTranscription({original:materialized.original,sourceTranscriptions:materialized.sourceTranscriptions,subjectKind:'grand_total'});
 expect(value?.normalized_value).toMatchObject({kind:'grand_total',amount:{minor_units:2000},label:'סך הניכויים',locator:'טבלת סיכום סינתטית, שורת סך'});
 expect(materialized.extraction.fields.some(c=>c.field==='total_deductions')).toBe(false);
 expect(documentReadingTargetForCheckpoint({target:f.target(),currentCheckpoint:f.checkpoint})).toEqual(f.target());
 expect(canonicalSha256(f.checkpoint)).toBe(before);
 for(const action of ['unknown','unreadable'])expect(resolveDocumentReadingVerification({...f.input(),answer:{schema_version:'document-field-answer-v2',action}})).toMatchObject({state:action,effective_value:null});
 expect(()=>resolveDocumentReadingVerification({...f.input(),answer:{schema_version:'document-field-answer-v2',action:'confirm'}})).toThrow('ANSWER_INVALID');
});
it.each(['ניכויי חובה','ניכויי חובה-מסים','קופות גמל','total tax deductions','סך ניכויים משוער'])('refuses a non-grand-total heading: %s',label=>{
 const f=fixture('grand_total'),input=f.input(),value=JSON.parse(input.answer.corrected_raw_value);
 expect(()=>validateDocumentReadingAnswerForTarget(f.target(),{...input.answer,corrected_raw_value:JSON.stringify({...value,label})})).toThrow('ANSWER_INVALID');
});
it('requires an amount and exact cell location, never accepts a scalar correction or a computed value',()=>{
 const f=fixture('grand_total'),input=f.input(),value=JSON.parse(input.answer.corrected_raw_value);
 for(const raw of ['20.00',JSON.stringify({...value,amount:'-1'}),JSON.stringify({...value,amount:'10+10'}),JSON.stringify({...value,locator:''}),JSON.stringify({...value,extra:true})])
  expect(()=>validateDocumentReadingAnswerForTarget(f.target(),{...input.answer,corrected_raw_value:raw})).toThrow('ANSWER_INVALID');
 expect(()=>validateDocumentReadingAnswerForTarget(fixture().target(),input.answer)).toThrow('ANSWER_INVALID');
});
it('permits only exact mandatory-subtotal candidates and refuses any competing grand total in either pass',()=>{
 const f=fixture('grand_total'),base=f.extraction.fields.find(c=>c.field==='gross_salary')!;
 const subtotal=normalizedCandidateFieldSchema.parse({...base,candidate_id:randomUUID(),field:'total_deductions',raw_value:'8.00',normalized_value:{currency:'ILS',minor_units:800},source:{...base.source,text_fragment:'ניכויי חובה-מסים: 8.00'}});
 f.extraction.fields.push(subtotal);f.firstPass.fields.push(structuredClone(subtotal));f.rehash();expect(f.target().subject.kind).toBe('grand_total');
 const firstBefore=canonicalSha256(f.firstPass),input=f.input();
 f.firstPass.fields.push({...subtotal,candidate_id:randomUUID(),source:{...subtotal.source,text_fragment:'סך הניכויים: 8.00'}});f.rehash();
 expect(()=>f.target()).toThrow('PRESENT_FIELD');expect(resolveDocumentReadingVerification(input)).toEqual({state:'stale'});
 expect(canonicalSha256(f.firstPass)).not.toBe(firstBefore);
});
it('requires a single physical page and exact current source, period and first-pass identity',()=>{
 const f=fixture('grand_total'),input=f.input();
 expect(()=>resolveDocumentReadingVerification({...input,caseId:randomUUID()})).toThrow('CASE_MISMATCH');
 expect(resolveDocumentReadingVerification({...input,month:'2025-02'})).toEqual({state:'stale'});
 f.extraction.quality_metrics.page_count=2;f.firstPass.quality_metrics.page_count=2;f.rehash();
 expect(()=>f.target()).toThrow('SINGLE_PAGE_REQUIRED');expect(resolveDocumentReadingVerification(input)).toEqual({state:'stale'});
});
