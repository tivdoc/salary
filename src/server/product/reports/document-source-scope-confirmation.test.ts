import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {sourceScopeObservationSchema} from '@/engine/extraction/contracts';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {materializeValidatedPayslipReadings,identifiedScopeObservation,payslipMachineExtractionSha256} from '@/engine/extraction/reading-resolution';
import {documentReadingTargetSchema,documentReadingTargetForCheckpoint} from './document-field-confirmation';
import {documentSourceScopeTarget,documentSourceScopeTargetSchema} from './document-source-scope-confirmation';
import {validateDocumentReadingAnswerForTarget,resolveDocumentReadingVerification,materializeDocumentVerification,documentFieldVerificationDisplay} from './reading-verification';
function fixture(scope:'final_payable'|'voluntary_deduction'|'combined_employer_funds'|'attendance_total'|'cumulative'='final_payable'){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-scoped-reading',mode:'real'}),document=f.stored.documents[0],extraction=normalizedPayslipExtractionSchema.parse(structuredClone(f.stored.extractions[0]));
 const original=extraction.fields.find(f=>f.field==='gross_salary')!;const {normalized_value:ignored,...raw}=original;void ignored;
 const observation=sourceScopeObservationSchema.parse({policy_version:'payslip-explicit-source-scope-v1',scope,source_label:'תצפית מקור סינתטית',
  candidate:{...raw,candidate_id:randomUUID(),field:scope==='attendance_total'?'regular_hours':scope==='combined_employer_funds'?'pension_employer_contribution':'net_salary',raw_value:scope==='attendance_total'?'96.10':'500.00',confidence:.94,
   source:{...original.source,text_fragment:'תצפית מקור סינתטית',source_scope:{period_kind:scope==='cumulative'?'cumulative':'current',fund_kind:'combined',column_label:'סינתטי'}}}});
 extraction.source_scope_observations=[observation];
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:randomUUID(),version_id:document.document_id,input_sha256:document.content_sha256,
  expected_month:'2025-01',period_mismatch:false,result_sha256:'',run:{result:{final_extraction:extraction}}};
 const rehash=()=>{checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);};rehash();
 const target=()=>documentSourceScopeTarget({checkpoint,policyVersion:'scope-test-v1',candidateId:observation.candidate.candidate_id});
 const input=()=>({target:target(),currentCheckpoint:checkpoint,caseId:document.case_id,month:'2025-01',policyVersion:'scope-test-v1',requestId:randomUUID(),answerRevision:1,identityId:randomUUID(),answeredAt:'2025-02-02T00:00:00Z',answer:{schema_version:'document-field-answer-v2',action:'confirm'}});
 return {document,extraction,observation,checkpoint,rehash,target,input};
}
it.each(['final_payable','voluntary_deduction','combined_employer_funds','attendance_total','cumulative'] as const)('confirms only a numeric %s source reading, never its scope or a scalar fact',scope=>{
 const f=fixture(scope),before=canonicalSha256(f.extraction),decision=resolveDocumentReadingVerification(f.input()),receipt=materializeDocumentVerification(decision,before);
 expect(decision).toMatchObject({state:'confirmed_reading',classification_verified:false});expect(receipt?.kind).toBe('source_scope');if(receipt?.kind!=='source_scope')throw Error('SCOPE_RECEIPT_REQUIRED');
 expect(documentReadingTargetSchema.parse(f.target())).toEqual(f.target());expect(documentReadingTargetForCheckpoint({target:f.target(),currentCheckpoint:f.checkpoint})).toEqual(f.target());
 const result=materializeValidatedPayslipReadings({document:f.document,case_id:f.document.case_id,extraction:{...f.extraction,customer_scope_readings:[receipt.reading]}});
 expect(result.extraction.fields).toEqual(f.extraction.fields);expect(result.extraction.source_scope_observations).toEqual(f.extraction.source_scope_observations);
 const reading=identifiedScopeObservation({original:result.original,effective:result.extraction,scopeReadings:result.scopeReadings,observation:f.observation});
 expect(reading?.raw_value).toBe(f.observation.candidate.raw_value);expect(reading?.observation.scope).toBe(scope);
 expect(payslipMachineExtractionSha256(result.original)).toBe(before);expect(canonicalSha256(f.extraction)).toBe(before);
 expect(documentFieldVerificationDisplay(f.target())).toMatchObject({field:'source_scope.'+scope,raw_value:f.observation.candidate.raw_value});
});
it('corrects the existing raw observation only, retaining original scope metadata and candidate',()=>{
 const f=fixture(),input=f.input(),receipt=materializeDocumentVerification(resolveDocumentReadingVerification({...input,answer:{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'600.00'}}),canonicalSha256(f.extraction));
 if(receipt?.kind!=='source_scope')throw Error('SCOPE_RECEIPT_REQUIRED');
 const result=materializeValidatedPayslipReadings({document:f.document,case_id:f.document.case_id,extraction:{...f.extraction,customer_scope_readings:[receipt.reading]}});
 expect(result.original.source_scope_observations?.[0]).toEqual(f.observation);expect(result.extraction.source_scope_observations?.[0].candidate.raw_value).toBe('600.00');
 expect(result.extraction.source_scope_observations?.[0].candidate.source).toEqual(f.observation.candidate.source);expect(result.extraction.fields).toEqual(f.extraction.fields);
 const changed=structuredClone(result.extraction);changed.source_scope_observations![0].scope='cumulative';
 expect(()=>identifiedScopeObservation({original:result.original,effective:changed,scopeReadings:result.scopeReadings,observation:f.observation})).toThrow('EFFECTIVE_MISMATCH');
});
it.each(['unknown','unreadable'])('latest %s removes a prior scoped correction without dropping original observations',action=>{
 const f=fixture(),input=f.input(),sha=canonicalSha256(f.extraction);
 const first=materializeDocumentVerification(resolveDocumentReadingVerification({...input,answer:{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'600'}}),sha);
 const last=materializeDocumentVerification(resolveDocumentReadingVerification({...input,answerRevision:2,answer:{schema_version:'document-field-answer-v2',action}}),sha);
 expect(first?.kind).toBe('source_scope');expect(last).toBeNull();expect(f.observation.candidate.raw_value).toBe('500.00');
});
it.each(['case','source','policy','month','observation','scope','candidate','raw','checkpoint'] as const)('refuses altered scoped target binding: %s',kind=>{
 const f=fixture(),input=f.input();
 if(kind==='case'){expect(()=>resolveDocumentReadingVerification({...input,caseId:randomUUID()})).toThrow('CASE_MISMATCH');return;}
 if(kind==='source')f.checkpoint.input_sha256='f'.repeat(64);if(kind==='policy')input.policyVersion='different';if(kind==='month')input.month='2025-02';
 if(kind==='observation')f.observation.source_label='other label';if(kind==='scope')f.observation.scope='cumulative';if(kind==='candidate')f.observation.candidate.candidate_id=randomUUID();if(kind==='raw')f.observation.candidate.raw_value='900';
 if(['observation','scope','candidate','raw'].includes(kind))f.rehash();if(kind==='checkpoint')f.checkpoint.result_sha256='f'.repeat(64);
 expect(resolveDocumentReadingVerification(input)).toEqual({state:'stale'});
});
it('cannot promote an observation to a scalar field or accept forged scope/hash changes',()=>{
 const f=fixture(),target=structuredClone(f.target());target.original_observation.scope='attendance_total';expect(()=>documentSourceScopeTargetSchema.parse(target)).toThrow();
 const value=resolveDocumentReadingVerification(f.input()),receipt=materializeDocumentVerification(value,canonicalSha256(f.extraction));if(receipt?.kind!=='source_scope')throw Error('SCOPE_RECEIPT_REQUIRED');
 expect(()=>materializeValidatedPayslipReadings({document:f.document,case_id:f.document.case_id,extraction:{...f.extraction,customer_scope_readings:[{...receipt.reading,original_observation_sha256:'f'.repeat(64)}]}})).toThrow('SCOPE_READING_BINDING');
 f.extraction.fields.push({...f.extraction.fields[0],candidate_id:f.observation.candidate.candidate_id});f.rehash();expect(()=>f.target()).toThrow('CANDIDATE_AMBIGUOUS');
});
it('does not hash annotation presence into the original machine source and rejects provider-injected annotations',()=>{
 const f=fixture();expect(payslipMachineExtractionSha256(normalizedPayslipExtractionSchema.parse({...f.extraction,customer_readings:[],customer_row_readings:[],customer_scope_readings:[]}))).toBe(canonicalSha256(f.extraction));
 f.checkpoint.run.result.final_extraction={...f.extraction,customer_scope_readings:[]};f.rehash();expect(()=>f.target()).toThrow('SAVED_PROVIDER_CONFIRMATION_FORBIDDEN');
});
it('requires a correction for unparsed source text and never invents a missing observation',()=>{
 const f=fixture();f.observation.candidate.raw_value='??';f.rehash();expect(()=>resolveDocumentReadingVerification(f.input())).toThrow('ANSWER_INVALID');
 expect(resolveDocumentReadingVerification({...f.input(),answer:{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'500'}})).toMatchObject({state:'corrected_reading'});
 f.extraction.source_scope_observations=[];f.rehash();expect(()=>f.target()).toThrow('CANDIDATE_AMBIGUOUS');
});

it('uses the identical scoped value parser before persistence and when resolving an answer',()=>{
 const f=fixture(),target=f.target();
 const good={schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'750.00'};
 expect(validateDocumentReadingAnswerForTarget(target,good)).toEqual(good);
 expect(resolveDocumentReadingVerification({...f.input(),answer:good})).toMatchObject({effective_value:{minor_units:75000}});
 for(const corrected_raw_value of ['garbage','USD 500'])expect(()=>validateDocumentReadingAnswerForTarget(target,{...good,corrected_raw_value})).toThrow('ANSWER_INVALID');
});
