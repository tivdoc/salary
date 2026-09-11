import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentFieldTarget,DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from './document-field-confirmation';
import {validateDocumentReadingAnswerForTarget,parseDocumentFieldAnswer,resolveDocumentFieldVerification,documentFieldVerificationDisplay} from './reading-verification';

function fixture(){
 const f=buildSyntheticCaseFixture({fixture_id:'cell-reading-v2',mode:'real'}),d=f.stored.documents[0],extraction=structuredClone(f.stored.extractions[0]);
 const candidate=extraction.fields.find(f=>f.field==='gross_salary')!;candidate.confidence=.94;
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:d.case_id,product_document_id:randomUUID(),version_id:d.document_id,
  input_sha256:d.content_sha256,expected_month:'2025-01',period_mismatch:false,result_sha256:'',run:{result:{final_extraction:extraction}}};
 checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);
 const target=documentFieldTarget({checkpoint,policyVersion:'cell-test-v1',candidateId:candidate.candidate_id});
 const input={target,currentCheckpoint:checkpoint,caseId:d.case_id,month:'2025-01',policyVersion:'cell-test-v1',requestId:randomUUID(),
  answerRevision:1,identityId:randomUUID(),answeredAt:'2025-02-02T00:00:00Z',answer:{schema_version:'document-field-answer-v2',action:'confirm'}};
 return {input,checkpoint,candidate,target};
}
it('confirms exactly one unchanged source cell without manufacturing human/legal authority',()=>{
 const f=fixture(),before=structuredClone(f.checkpoint),receipt=resolveDocumentFieldVerification(f.input);
 expect(receipt).toMatchObject({state:'confirmed_reading',effective_value:f.candidate.normalized_value,authority:{actor_kind:'identified_account',identity_id:f.input.identityId},scope:'source_cell_reading_only'});
 expect(receipt).not.toHaveProperty('human_attestation');expect(f.checkpoint).toEqual(before);expect(f.candidate.confidence).toBe(.94);
});
it('normalizes corrected input using the provider field parser and preserves the original candidate and conflicts',()=>{
 const f=fixture(),before=structuredClone(f.checkpoint);
 const receipt=resolveDocumentFieldVerification({...f.input,answer:{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'1,234.56'}});
 expect(receipt).toMatchObject({state:'corrected_reading',effective_value:{currency:'ILS',minor_units:123456},original_candidate:f.candidate,value_origin:'identified_source_transcription'});
 expect(f.checkpoint).toEqual(before);expect('receipt_sha256' in receipt&&receipt.receipt_sha256).toMatch(/^[a-f0-9]{64}$/u);
});
it.each(['unknown','unreadable'])('does not reuse a prior corrected value after %s',action=>{
 const f=fixture();const provided=resolveDocumentFieldVerification({...f.input,answer:{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'100'}});
 const unanswered=resolveDocumentFieldVerification({...f.input,answerRevision:2,answer:{schema_version:'document-field-answer-v2',action}});
 const replaced=resolveDocumentFieldVerification({...f.input,answerRevision:3,answer:{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'200'}});
 expect(unanswered).toMatchObject({state:action,effective_value:null});expect(replaced).toMatchObject({effective_value:{minor_units:20000}});
 expect(provided).toMatchObject({effective_value:{minor_units:10000}});expect(f.candidate.confidence).toBe(.94);
});
it.each(['','not a value','USD 100','NaN'])('rejects an invalid or foreign currency correction %s',corrected_raw_value=>{
 const f=fixture();expect(()=>resolveDocumentFieldVerification({...f.input,answer:{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value}})).toThrow();
});
it('rejects foreign identity bindings and makes a replaced source stale',()=>{
 const f=fixture();expect(()=>resolveDocumentFieldVerification({...f.input,caseId:randomUUID()})).toThrow('REQUEST_FIELD_CASE_MISMATCH');
 f.checkpoint.input_sha256='d'.repeat(64);expect(resolveDocumentFieldVerification(f.input)).toEqual({state:'stale'});
});
it('uses a different receipt per authenticated revision and exposes the exact source target for UI',()=>{
 const f=fixture(),a=resolveDocumentFieldVerification(f.input),b=resolveDocumentFieldVerification({...f.input,answerRevision:2});expect(a).not.toEqual(b);
 expect(documentFieldVerificationDisplay(f.target)).toMatchObject({target_sha256:f.target.target_sha256,raw_value:f.candidate.raw_value,source:{version_id:f.target.version_id,page:f.candidate.source.page},actions:['confirm','correct','unreadable','unknown']});
});
it('keeps legacy answers compatible and rejects extra proposed source/value fields',()=>{
 expect(parseDocumentFieldAnswer(DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0]).action).toBe('confirm');
 expect(parseDocumentFieldAnswer(DOCUMENT_FIELD_CONFIRMATION_ANSWERS[1]).action).toBe('unknown');
 expect(()=>parseDocumentFieldAnswer({schema_version:'document-field-answer-v2',action:'confirm',corrected_raw_value:'500'})).toThrow('REQUEST_ANSWER_INVALID');
});

it('validates scalar answer semantics before saving while preserving legacy answer parsing',()=>{
 const f=fixture();
 expect(validateDocumentReadingAnswerForTarget(f.target,DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0])).toMatchObject({action:'confirm'});
 expect(()=>validateDocumentReadingAnswerForTarget(f.target,{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'garbage'})).toThrow('ANSWER_INVALID');
 const corrected={schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'123.45'};
 expect(validateDocumentReadingAnswerForTarget(f.target,corrected)).toEqual(corrected);
 expect(resolveDocumentFieldVerification({...f.input,answer:corrected})).toMatchObject({effective_value:{minor_units:12345}});
});
