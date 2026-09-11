import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {resolvePayslipSnapshot,resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {validatePayslipGate0} from '@/engine/extraction/validation';
import {documentFieldTarget,DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from '../reports/document-field-confirmation';
import {savedDocumentFieldReadings} from './saved-field-readings';

function setup(){
 const f=buildSyntheticCaseFixture({fixture_id:'customer-reading',mode:'real'}),doc=f.stored.documents[0],extraction=structuredClone(f.stored.extractions[0]);
 const candidate=extraction.fields.find(c=>c.field==='base_monthly_salary')!;candidate.confidence=0.6;
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:doc.case_id,product_document_id:randomUUID(),version_id:doc.document_id,input_sha256:doc.content_sha256,
  expected_month:'2025-01',period_mismatch:false,result_sha256:canonicalSha256({final_extraction:extraction}),run:{result:{final_extraction:extraction}}};
 const target=documentFieldTarget({checkpoint,policyVersion:'test-policy',candidateId:candidate.candidate_id});
 const answer={id:randomUUID(),case_id:doc.case_id,scope_month:'2025-01',code:`document_field:${target.target_sha256}`,answer_kind:'choice',answer:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0] as string,
  answer_revision:1,answer_identity_id:randomUUID(),answer_created_at:'2025-02-02T00:00:00Z',field_target:target};
 const input={caseId:doc.case_id,month:'2025-01',policyVersion:'test-policy',journal:{answers:[answer]},checkpoint};
 const context={snapshot_id:randomUUID(),case_id:doc.case_id,analysis_run_id:randomUUID(),schema_version:'1.0.0',created_at:'2025-02-02T00:00:00Z',fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(p=>[p,randomUUID()]))};
 const resolve=(readings=savedDocumentFieldReadings(input),validation=validatePayslipGate0(extraction,{reference_year:2025}))=>resolvePayslipSnapshot({document:doc,extraction:{...extraction,customer_readings:[...readings]},validation,context});
 return {doc,extraction,candidate,checkpoint,answer,input,resolve};
}
it('carries an actual answer revision into the canonical reading while preserving original OCR bytes and score',()=>{
 const s=setup(),before=canonicalSha256(s.checkpoint),base=s.resolve().facts.find(f=>f.path==='compensation.base_monthly_salary')!;
 expect(base).toMatchObject({status:'confirmed',confidence:1,value:s.candidate.normalized_value});
 expect(base.provenance[0]).toMatchObject({source_type:'documented',read_by:'machine',verified:true,customer_confirmation:{actor_kind:'customer',request_id:s.answer.id,identity_id:s.answer.answer_identity_id,answer_revision:1}});
 expect(canonicalSha256(s.checkpoint)).toBe(before);expect(s.candidate.confidence).toBe(0.6);
 expect(s.resolve().facts.find(f=>f.path==='compensation.gross_salary')?.provenance[0]).toMatchObject({verified:false});
});
it('a negative corrected answer removes the reading without changing the original target or creating zero',()=>{
 const s=setup();s.answer.answer_revision=2;s.answer.answer=DOCUMENT_FIELD_CONFIRMATION_ANSWERS[1];
 expect(savedDocumentFieldReadings(s.input)).toEqual([]);expect(s.resolve().facts.find(f=>f.path==='compensation.base_monthly_salary')).toMatchObject({status:'needs_confirmation',confidence:0.6,value:s.candidate.normalized_value});
});
it.each(['month','policy','version','extraction'] as const)('drops stale %s evidence from the next source snapshot',change=>{
 const s=setup();if(change==='month')s.input.month='2025-02';if(change==='policy')s.input.policyVersion='new';if(change==='version')s.checkpoint.version_id=randomUUID();
 if(change==='extraction'){s.candidate.confidence=0.7;s.checkpoint.result_sha256=canonicalSha256(s.checkpoint.run.result);}
 expect(savedDocumentFieldReadings(s.input)).toEqual([]);
});
it('does not accept generic, unattributed, duplicated or foreign answers as confirmed cells',()=>{
 const generic=setup();generic.answer.code='low_confidence:base_wage';expect(savedDocumentFieldReadings(generic.input)).toEqual([]);
 const noActor=setup();Reflect.deleteProperty(noActor.answer,'answer_identity_id');expect(()=>savedDocumentFieldReadings(noActor.input)).toThrow();
 const duplicate=setup();duplicate.input.journal.answers.push(duplicate.answer);expect(()=>savedDocumentFieldReadings(duplicate.input)).toThrow('SAVED_REQUEST_ID_AMBIGUOUS');
 const foreign=setup();foreign.answer.case_id=randomUUID();expect(()=>savedDocumentFieldReadings(foreign.input)).toThrow('REQUEST_FIELD_CASE_MISMATCH');
});
it('refuses confirmations injected into a provider checkpoint',()=>{
 const s=setup();Object.assign(s.extraction,{customer_readings:savedDocumentFieldReadings(s.input)});expect(()=>savedDocumentFieldReadings(s.input)).toThrow('SAVED_PROVIDER_CONFIRMATION_FORBIDDEN');
});
it.each(['case_id','document_id','source_sha256','normalized_extraction_sha256','candidate_sha256','month'] as const)('the engine independently refuses tampered %s sidecars',key=>{
 const s=setup(),reading=structuredClone(savedDocumentFieldReadings(s.input)[0]);
 Object.assign(reading,{[key]:key.endsWith('sha256')?'f'.repeat(64):key==='month'?'2025-02':randomUUID()});
 expect(()=>s.resolve([reading])).toThrow('DOCUMENT_READING_BINDING_MISMATCH');
});
it('confirming a reading cannot clear an arithmetic mismatch',()=>{
 const s=setup(),validation=validatePayslipGate0(s.extraction,{reference_year:2025}),assessment=validation.field_assessments.find(f=>f.candidate_id===s.candidate.candidate_id)!;
 assessment.issue_codes.push('hourly_salary_mismatch');
 const fact=s.resolve(undefined,validation).facts.find(f=>f.path==='compensation.base_monthly_salary');
 expect(fact).toMatchObject({status:'needs_confirmation',confidence:0.6});expect(fact?.provenance[0]).toMatchObject({verified:true});
});
it('consumes an authenticated v2 correction then unknown then a new correction without rewriting original OCR',()=>{
 const s=setup(),original=canonicalSha256(s.checkpoint);
 const set=(action:string,raw?:string)=>{s.answer.answer_revision++;s.answer.answer=JSON.stringify({schema_version:'document-field-answer-v2',action,...(raw?{corrected_raw_value:raw}:{})});};
 set('correct','4321.00');const first=savedDocumentFieldReadings(s.input);
 expect(first[0]).toMatchObject({correction:{raw_value:'4321.00',normalized_value:{currency:'ILS',minor_units:432100}}});
 expect(s.resolve().facts.find(f=>f.path==='compensation.base_monthly_salary')?.value).toEqual({currency:'ILS',minor_units:432100});
 set('unknown');expect(savedDocumentFieldReadings(s.input)).toEqual([]);
 expect(s.resolve().facts.find(f=>f.path==='compensation.base_monthly_salary')?.value).toEqual(s.candidate.normalized_value);
 set('correct','5432.00');expect(s.resolve().facts.find(f=>f.path==='compensation.base_monthly_salary')?.value).toEqual({currency:'ILS',minor_units:543200});
 expect(first[0].correction?.normalized_value).toEqual({currency:'ILS',minor_units:432100});expect(canonicalSha256(s.checkpoint)).toBe(original);
});
it('a corrected cell still cannot discard caller-supplied non-reading validation gates',()=>{
 const s=setup();s.answer.answer=JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'4321.00'});
 const validation=validatePayslipGate0(s.extraction,{reference_year:2025}),assessment=validation.field_assessments.find(a=>a.candidate_id===s.candidate.candidate_id)!;
 assessment.issue_codes.push('critical_source_applicability_missing');assessment.status='requires_confirmation';
 expect(s.resolve(undefined,validation).facts.find(f=>f.path==='compensation.base_monthly_salary')?.status).not.toBe('confirmed');
});
