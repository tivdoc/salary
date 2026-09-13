import {describe,it,expect,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {materializeValidatedPayslipReadings,payslipMachineExtractionSha256} from '@/engine/extraction/reading-resolution';
import {payslipSourcePeriod,missingSourcePeriodSelector} from '@/engine/extraction/source-period-association';
import {sourceStructureSubjectKey} from '@/engine/extraction/source-structure-resolution';
import {documentSourceStructureTarget,resolveDocumentSourceStructureVerification,materializeDocumentSourceStructureVerification,validateDocumentSourceStructureAnswer} from './document-source-structure';
import {reviewInputFromPayslips,PAYSLIP_SOURCE_STRUCTURE_POLICY} from '@/engine/document-review/payslip-adapter';
import {runDocumentReview} from '@/engine/document-review/service';
import {documentReviewReadingDependencies} from '@/engine/document-review/source-dependencies';
import {attachAutomaticPayrollEvidence} from '@/engine/entitlement-review/automatic-payroll';
import {minimumWageEntitlementInputSchema} from '@/engine/entitlement-review/minimum-wage/contracts';
import type {CustomerSourceStructureReading} from '@/engine/extraction/source-structure';

function fixture(){
 const base=buildSyntheticCaseFixture({fixture_id:'synthetic-period-association',mode:'real'}),document={...base.stored.documents[0],document_period:{start_date:'2026-06-01',end_date:'2026-06-30'}},rowId=randomUUID();
 const period={from:'2026-06-01',to:'2026-06-30'},label='Synthetic hourly base',source={document_id:document.document_id,page:1,text_fragment:label};
 const template=base.stored.extractions[0].fields[0];
 const field=(name:string,raw:string,value:unknown)=>({...template,candidate_id:randomUUID(),field:name,raw_value:raw,normalized_value:value,confidence:.94,warning_flags:[],source:{...source,text_fragment:label+': '+raw}});
 const e=normalizedPayslipExtractionSchema.parse({...base.stored.extractions[0],document_quality_confidence:.96,extracted_at:'2026-07-02T00:00:00Z',earnings_components_complete:true,
 fields:[{...field('salary_period','06/2026',{year:2026,month:6,start_date:period.from,end_date:period.to}),confidence:1},
 field('regular_hours','100',{amount:'100',unit:'hours_per_month'}),field('hourly_rate','33.00',{currency:'ILS',minor_units:3300}),
 field('base_monthly_salary','3300.00',{currency:'ILS',minor_units:330000}),field('gross_salary','3300.00',{currency:'ILS',minor_units:330000})],
 additional_components:[{component_id:rowId,source_label:label,normalized_label:'base',semantic_kind:'hourly_base',quantity_raw:'100',rate_raw:'33.00',amount_raw:'3300.00',percentage_raw:null,
 quantity:'100',rate:{currency:'ILS',minor_units:3300},amount:{currency:'ILS',minor_units:330000},percentage:null,source,confidence:.94,extraction_method:'fixture',warning_flags:[],normalization_warnings:[]}]});
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:randomUUID(),version_id:document.document_id,input_sha256:document.content_sha256,
 expected_month:'2026-06',period_mismatch:false,result_sha256:'',run:{result:{final_extraction:e,first_pass:{normalized_extraction:e}}}};
 checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);
 const selector=missingSourcePeriodSelector(e,{kind:'component',id:rowId});if(!selector)throw Error('PERIOD_SELECTOR_REQUIRED');
 const target=documentSourceStructureTarget({checkpoint,policyVersion:'synthetic-period-policy-v1',selector});
 const value={kind:'period_association',period_kind:'current',period,basis:{page:1,locator:'Synthetic current month column',text:'Explicit June 2026 heading covers the marked hourly row and its cells'}};
 const answer=(action='correct',v:unknown=value)=>({schema_version:'document-field-answer-v3',action,...(action==='correct'||action==='confirm'?{structured_value:v}:{})});
 const resolve=(a:unknown)=>resolveDocumentSourceStructureVerification({target,currentCheckpoint:checkpoint,policyVersion:target.policy_version,caseId:document.case_id,month:'2026-06',requestId:randomUUID(),answerRevision:1,identityId:randomUUID(),answeredAt:'2026-09-12T12:00:00Z',answer:a});
 const reading=(a:unknown=answer())=>materializeDocumentSourceStructureVerification(resolve(a),canonicalSha256(e))?.reading;
 const numeric=e.fields.map(f=>({actor_kind:'customer' as const,case_id:document.case_id,document_id:document.document_id,candidate_id:f.candidate_id,source_sha256:document.content_sha256,normalized_extraction_sha256:canonicalSha256(e),candidate_sha256:canonicalSha256(f),extraction_result_sha256:checkpoint.result_sha256,target_sha256:canonicalSha256({scalar:f.candidate_id}),month:'2026-06',request_id:randomUUID(),answer_revision:1,identity_id:randomUUID(),confirmed_at:'2026-07-03T00:00:00Z'}));
 const snapshot=(structures:CustomerSourceStructureReading[]=[],withNumbers=true)=>({...base.stored,documents:[document],extractions:[normalizedPayslipExtractionSchema.parse({...e,...(withNumbers?{customer_readings:numeric}:{}),customer_source_structures:structures,source_reading_context:{checkpoint_result_sha256:checkpoint.result_sha256,first_pass:e}})]});
 const review=(structures:CustomerSourceStructureReading[]=[],withNumbers=true)=>reviewInputFromPayslips({case_id:document.case_id,period,purchased_scope:{order_id:'synthetic.order',receipt_sha256:'f'.repeat(64),topics:['minimum_wage'],origin:'saved_order'},snapshot:snapshot(structures,withNumbers),review_policy:PAYSLIP_SOURCE_STRUCTURE_POLICY});
 return {document,e,period,rowId,checkpoint,target,value,answer,resolve,reading,numeric,snapshot,review};
}
describe('identified period association beside retained numeric readings',()=>{
 it('opens one exact row/scalar period target and consumes it without reapproving numbers or changing machine bytes',()=>{
  const f=fixture(),r=f.reading();if(!r)throw Error('READING_REQUIRED');
  expect(f.target.subject.kind).toBe('period_association');if(f.target.subject.kind!=='period_association')throw Error('SUBJECT_REQUIRED');
  expect(f.target.subject.refs).toHaveLength(4);
  const before=f.review(),snap=f.snapshot([r]),after=f.review([r]);
  const pending=documentReviewReadingDependencies({review:runDocumentReview(before,'synthetic.period.before'),document_id:f.document.document_id,extraction:f.snapshot().extractions[0]});
  expect(pending.source_structures?.filter(s=>s.subject.kind==='period_association')).toHaveLength(1);
  const mwBefore=minimumWageEntitlementInputSchema.parse(attachAutomaticPayrollEvidence(before,f.snapshot()).entitlement_evidence!.minimum_wage);
  const mwAfter=minimumWageEntitlementInputSchema.parse(attachAutomaticPayrollEvidence(after,snap).entitlement_evidence!.minimum_wage);
  expect(mwBefore.ordinary_hours).toBeNull();expect(mwAfter.ordinary_hours).toMatchObject({state:'observed',printed_value:'100'});
  expect(mwAfter.components[0].amount).toMatchObject({state:'observed',printed_value:'3300.00'});
  const materialized=materializeValidatedPayslipReadings({document:f.document,case_id:f.document.case_id,extraction:snap.extractions[0]});
  expect(materialized.extraction.fields).toEqual(f.e.fields);expect(materialized.extraction.additional_components).toEqual(f.e.additional_components);
  expect(materialized.extraction.customer_readings).toEqual(f.numeric);expect(payslipMachineExtractionSha256(materialized.extraction)).toBe(canonicalSha256(f.e));
 });
 it('period metadata alone cannot authorize unconfirmed numeric cells',()=>{
  const f=fixture(),r=f.reading();if(!r)throw Error('READING_REQUIRED');
  const mw=minimumWageEntitlementInputSchema.parse(attachAutomaticPayrollEvidence(f.review([r],false),f.snapshot([r],false)).entitlement_evidence!.minimum_wage);
  expect(mw.ordinary_hours).toBeNull();expect(mw.components[0].amount.state).toBe('unknown');
 });
 it.each(['unknown','unreadable'])('%s keeps the period unknown and preserves all existing numbers',action=>{
  const f=fixture();expect(f.reading(f.answer(action))).toBeUndefined();
  const out=attachAutomaticPayrollEvidence(f.review(),f.snapshot());expect(minimumWageEntitlementInputSchema.parse(out.entitlement_evidence!.minimum_wage).ordinary_hours).toBeNull();
  expect(f.snapshot().extractions[0].customer_readings).toEqual(f.numeric);
 });
 it('a correction to another period blocks only bound observations, never overwrites known conflicting source labels',()=>{
  const f=fixture(),r=f.reading(f.answer('correct',{...f.value,period_kind:'retroactive',period:{from:'2026-05-01',to:'2026-05-31'}}));if(!r)throw Error('READING_REQUIRED');
  const map=new Map([[sourceStructureSubjectKey(r.subject),r]]),get=(id:string)=>payslipSourcePeriod({original:f.e,structureReadings:map,ref:{kind:'field',id},period:f.period});
  expect(get(f.e.fields.find(x=>x.field==='regular_hours')!.candidate_id).state).toBe('other');expect(get(f.e.fields.find(x=>x.field==='gross_salary')!.candidate_id).state).toBe('missing');
  const known=structuredClone(f.e);known.additional_components[0].source.source_scope={period_kind:'cumulative',fund_kind:'unknown',column_label:'YTD'};
  expect(missingSourcePeriodSelector(known,{kind:'component',id:f.rowId})).toBeNull();
  expect(()=>payslipSourcePeriod({original:known,structureReadings:map,ref:{kind:'component',id:f.rowId},period:f.period})).toThrow('SOURCE_PERIOD_READING_REF_CHANGED');
 });
 it('preserves an explicit conflicting period label across the whole bound association',()=>{
  const f=fixture(),e=structuredClone(f.e);e.additional_components[0].source.source_scope={period_kind:'cumulative',fund_kind:'unknown',column_label:'YTD'};
  const checkpoint={...f.checkpoint,run:{result:{final_extraction:e,first_pass:{normalized_extraction:e}}}};checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);
  if(f.target.subject.kind!=='period_association')throw Error('SUBJECT_REQUIRED');
  const target=documentSourceStructureTarget({checkpoint,policyVersion:f.target.policy_version,selector:{kind:'period_association',refs:f.target.subject.refs.map(r=>{if(r.kind==='scope')throw Error('REF_KIND');return {kind:r.kind,id:r.id};})}});
  const verified=resolveDocumentSourceStructureVerification({target,currentCheckpoint:checkpoint,policyVersion:target.policy_version,caseId:f.document.case_id,month:'2026-06',requestId:randomUUID(),answerRevision:1,identityId:randomUUID(),answeredAt:'2026-09-12T12:00:00Z',answer:f.answer()});
  const reading=materializeDocumentSourceStructureVerification(verified,canonicalSha256(e))?.reading;if(!reading)throw Error('READING_REQUIRED');
  const materialized=materializeValidatedPayslipReadings({document:f.document,case_id:f.document.case_id,extraction:normalizedPayslipExtractionSchema.parse({...e,customer_source_structures:[reading],source_reading_context:{checkpoint_result_sha256:checkpoint.result_sha256,first_pass:e}})});
  for(const ref of target.subject.kind==='period_association'?target.subject.refs:[]){if(ref.kind==='scope')throw Error('REF_KIND');expect(payslipSourcePeriod({original:e,structureReadings:materialized.structureReadings,ref:{kind:ref.kind,id:ref.id},period:f.period}).state).toBe('conflict');}
  expect(e.additional_components[0].source.source_scope.period_kind).toBe('cumulative');
 });
 it.each([{period_kind:'current',period:{from:'2026-05-01',to:'2026-05-31'}},{period_kind:'current',period:{from:'2026-06-31',to:'2026-06-31'}},{basis:{page:2,locator:'x',text:'x'}}])('rejects invalid period/date/page %j',patch=>{
  const f=fixture();expect(()=>validateDocumentSourceStructureAnswer(f.target,f.answer('correct',{...f.value,...patch}))).toThrow();
 });
 it('rejects confirm, foreign refs, altered target and stale result hashes',()=>{
  const f=fixture();expect(()=>validateDocumentSourceStructureAnswer(f.target,f.answer('confirm'))).toThrow();
  expect(()=>documentSourceStructureTarget({checkpoint:{},policyVersion:'x',selector:{kind:'period_association',refs:[{kind:'field',id:randomUUID()}]}})).toThrow();
  expect(()=>validateDocumentSourceStructureAnswer({...f.target,target_sha256:'0'.repeat(64)},f.answer())).toThrow();
  expect(resolveDocumentSourceStructureVerification({target:f.target,currentCheckpoint:{...f.checkpoint,result_sha256:'0'.repeat(64)},policyVersion:f.target.policy_version,caseId:f.document.case_id,month:'2026-06',requestId:randomUUID(),answerRevision:1,identityId:randomUUID(),answeredAt:'2026-09-12T12:00:00Z',answer:f.answer()})).toEqual({state:'stale'});
 });
});
