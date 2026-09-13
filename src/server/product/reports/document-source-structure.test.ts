import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {materializeValidatedPayslipReadings,payslipMachineExtractionSha256,identifiedSourceStructure} from '@/engine/extraction/reading-resolution';
import {sourceStructureSelector,parseSourceStructureReadingValue,type SourceStructureSelector} from '@/engine/extraction/source-structure-resolution';
import {documentReadingTargetSchema,documentReadingTargetForCheckpoint} from './document-field-confirmation';
import {documentSourceStructureTarget,serializeDocumentFieldAnswerV3} from './document-source-structure';
import {resolveDocumentReadingVerification,materializeDocumentVerification,validateDocumentReadingAnswerForTarget,documentFieldVerificationDisplay} from './reading-verification';

const basis={page:1,locator:'synthetic table section A',text:'Explicit source table section and row relationship'};
function fixture(){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-source-structures',mode:'real'}),document=f.stored.documents[0];
 const e=normalizedPayslipExtractionSchema.parse(structuredClone(f.stored.extractions[0]));
 const template=e.fields.find(f=>f.field==='gross_salary')!;
 const source={...template.source,page:1,text_fragment:'synthetic current table',source_scope:{period_kind:'current',fund_kind:'unknown',column_label:'synthetic'}};
 const ids={base:randomUUID(),employee:randomUUID(),total:randomUUID(),balance:randomUUID(),voluntary:randomUUID(),combined:randomUUID(),row1:randomUUID(),row2:randomUUID()};
 const field=(name:string,id:string,raw:string,normalized:unknown)=>({...template,candidate_id:id,field:name,raw_value:raw,normalized_value:normalized,source});
 const row=(id:string,amount:string)=>({component_id:id,source_label:'synthetic deduction '+amount,normalized_label:'deduction',semantic_kind:'deduction',quantity_raw:null,rate_raw:null,percentage_raw:null,
  amount_raw:amount,confidence:.94,source,extraction_method:'ai_vision',warning_flags:[],quantity:null,rate:null,percentage:null,amount:{currency:'ILS',minor_units:Number(amount)*100},normalization_warnings:[]});
 const scope=(id:string,kind:string,fieldName:string,raw:string)=>({scope:kind,source_label:'synthetic '+kind,policy_version:'payslip-explicit-source-scope-v1',
  candidate:{candidate_id:id,field:fieldName,raw_value:raw,confidence:.94,source,extraction_method:'ai_vision',warning_flags:[]}});
 const extraction=normalizedPayslipExtractionSchema.parse({...e,fields:[...e.fields.filter(f=>f.field==='salary_period'),field('pension_base',ids.base,'5000.00',{currency:'ILS',minor_units:500000}),
  field('pension_employee_contribution',ids.employee,'300.00',{currency:'ILS',minor_units:30000}),field('total_deductions',ids.total,'300.00',{currency:'ILS',minor_units:30000})],
  additional_components:[row(ids.row1,'300.00'),row(ids.row2,'100.00')],source_scope_observations:[scope(ids.voluntary,'voluntary_deduction','total_deductions','100.00'),scope(ids.combined,'combined_employer_funds','pension_employer_contribution','625.00')]});
 const first=normalizedPayslipExtractionSchema.parse({...extraction,fields:[...extraction.fields,field('vacation_balance',ids.balance,'8.00',null)]});
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:randomUUID(),version_id:document.document_id,input_sha256:document.content_sha256,
  expected_month:'2025-01',period_mismatch:false,result_sha256:'',run:{result:{final_extraction:extraction,first_pass:{normalized_extraction:first}}}};
 const rehash=()=>checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);rehash();
 const selector:SourceStructureSelector={kind:'source_relationship',componentKind:'pension_employee',contribution:{kind:'field',id:ids.employee},base:{kind:'field',id:ids.base}};
 const target=(s:SourceStructureSelector=selector)=>documentSourceStructureTarget({checkpoint,policyVersion:'structure-test-v1',selector:s});
 const answer=(value:unknown)=>({schema_version:'document-field-answer-v3',action:'correct',structured_value:value});
 const relation={kind:'source_relationship',relationship:'same_base',component_kind:'pension_employee',fund_kind:'pension',fund_label:'synthetic pension',source_kind:'labelled_section',basis} as const;
 const resolve=(t:ReturnType<typeof target>,a:unknown)=>resolveDocumentReadingVerification({target:t,currentCheckpoint:checkpoint,policyVersion:'structure-test-v1',caseId:document.case_id,month:'2025-01',requestId:randomUUID(),answerRevision:1,identityId:randomUUID(),answeredAt:'2025-02-02T00:00:00Z',answer:a});
 const receipt=(t:ReturnType<typeof target>,a:unknown)=>{const r=materializeDocumentVerification(resolve(t,a),canonicalSha256(extraction));if(r?.kind!=='source_structure')throw Error('STRUCTURE_READING_EXPECTED');return r.reading;};
 const materialize=(readings:ReturnType<typeof receipt>[])=>materializeValidatedPayslipReadings({document,case_id:document.case_id,extraction:normalizedPayslipExtractionSchema.parse({...extraction,customer_source_structures:readings,
  source_reading_context:{checkpoint_result_sha256:checkpoint.result_sha256,first_pass:first}})});
 return {document,ids,extraction,first,checkpoint,rehash,selector,target,answer,relation,resolve,receipt,materialize};
}
it('admits an explicit relation separately from both numeric readings, preserving machine/provider data',()=>{
 const f=fixture(),target=f.target(),before=canonicalSha256(f.extraction),reading=f.receipt(target,f.answer(f.relation));
 expect(documentReadingTargetSchema.parse(target)).toEqual(target);
 expect(documentReadingTargetForCheckpoint({target,currentCheckpoint:f.checkpoint})).toEqual(target);
 const result=f.materialize([reading]);expect(result.readings.size).toBe(0);expect(result.structureReadings.size).toBe(1);
 expect(result.extraction.fields).toEqual(f.extraction.fields);expect(result.extraction.additional_components).toEqual(f.extraction.additional_components);
 expect(payslipMachineExtractionSha256(result.extraction)).toBe(before);expect(canonicalSha256(f.extraction)).toBe(before);
 expect(identifiedSourceStructure({original:result.original,structureReadings:result.structureReadings,subject:target.subject})?.normalized_value).toEqual(f.relation);
 expect(parseSourceStructureReadingValue(reading).reading).toEqual(reading);
 expect(documentFieldVerificationDisplay(target)).toMatchObject({scope:'source_structure_reading_only',structure_context:{kind:'source_relationship',component_kind:'pension_employee',proposed_value:null}});
});
it('retains different-base evidence, without inventing a zero ratio or replacing a source label',()=>{
 const f=fixture(),r=f.receipt(f.target(),f.answer({...f.relation,relationship:'different_base'}));
 expect(f.materialize([r]).structureReadings.values().next().value?.value).toMatchObject({relationship:'different_base'});
 expect(r).not.toHaveProperty('ratio');expect(r).not.toHaveProperty('legal_approval');
});
it.each(['unknown','unreadable'])('%s removes affirmative structure materialization but retains the decision and originals',action=>{
 const f=fixture(),before=canonicalSha256(f.checkpoint),v=f.resolve(f.target(),{schema_version:'document-field-answer-v3',action});
 expect(v.state).toBe(action);expect(materializeDocumentVerification(v,canonicalSha256(f.extraction))).toBeNull();expect(canonicalSha256(f.checkpoint)).toBe(before);
});
it('does not turn numeric/legacy confirms into relationship approval',()=>{
 const f=fixture(),target=f.target();
 for(const a of [{schema_version:'document-field-answer-v3',action:'confirm'},{schema_version:'document-field-answer-v2',action:'confirm'},{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'300'},'כן, בדקתי במסמך והערך נכון'])
  expect(()=>validateDocumentReadingAnswerForTarget(target,a)).toThrow('REQUEST_ANSWER_INVALID');
});
it('supports explicit identified relationship affirmation without a fabricated provider proposal',()=>{
 const f=fixture(),target=f.target(),answer={schema_version:'document-field-answer-v3',action:'confirm',structured_value:f.relation};
 expect(target.proposed_value).toBeNull();
 const decision=f.resolve(target,answer);expect(decision.state).toBe('confirmed_reading');
 const reading=f.receipt(target,answer),result=f.materialize([reading]);
 expect(result.structureReadings.size).toBe(1);expect(result.readings.size).toBe(0);
 expect(reading.value).toMatchObject({relationship:'same_base',fund_kind:'pension',fund_label:'synthetic pension',source_kind:'labelled_section'});
 expect(result.extraction.fields).toEqual(f.extraction.fields);
 expect(documentFieldVerificationDisplay(target)).toMatchObject({actions:['confirm','correct','unreadable','unknown'],structure_context:{allows_explicit_confirmation:true}});
});
it('rejects confirmation without fund/source evidence or confirmation of a different base',()=>{
 const f=fixture(),target=f.target(),{fund_kind,...withoutFund}=f.relation;void fund_kind;
 for(const value of [withoutFund,{...f.relation,source_kind:undefined},{...f.relation,fund_label:''},{...f.relation,relationship:'different_base'}])
  expect(()=>validateDocumentReadingAnswerForTarget(target,{schema_version:'document-field-answer-v3',action:'confirm',structured_value:value})).toThrow();
 const group=f.target({kind:'deduction_group'});
 expect(()=>validateDocumentReadingAnswerForTarget(group,{schema_version:'document-field-answer-v3',action:'confirm',structured_value:f.relation})).toThrow('REQUEST_ANSWER_INVALID');
});
it('preserves explicitly unknown or conflicting fund evidence for downstream compatibility gates',()=>{
 const f=fixture();
 for(const fund_kind of ['unknown','study']){
  const reading=f.receipt(f.target(),f.answer({...f.relation,fund_kind}));
  expect(f.materialize([reading]).structureReadings.values().next().value?.value).toMatchObject({fund_kind});
  expect(f.extraction.fields.find(x=>x.candidate_id===f.ids.employee)?.source.source_scope?.fund_kind).toBe('unknown');
 }
});
it('binds combined scope to a base without asserting a split or changing its scope',()=>{
 const f=fixture(),target=f.target({kind:'source_relationship',componentKind:'combined_employer_funds',contribution:{kind:'scope',id:f.ids.combined},base:{kind:'field',id:f.ids.base}});
 const r=f.receipt(target,f.answer({...f.relation,component_kind:'combined_employer_funds',fund_kind:'combined'}));
 expect(f.materialize([r]).extraction.source_scope_observations).toEqual(f.extraction.source_scope_observations);
 expect(r.subject.kind).toBe('source_relationship');
});
it('rejects a salary component or unrelated candidate used as the pension base',()=>{
 const f=fixture();expect(()=>f.target({...f.selector,kind:'source_relationship',componentKind:'pension_employee',contribution:{kind:'field',id:f.ids.employee},base:{kind:'field',id:f.ids.total}})).toThrow('BASE_UNSUPPORTED');
});
it('requires explicit exact membership and completeness; unknown/partial is not complete',()=>{
 const f=fixture(),target=f.target({kind:'deduction_group'}),value={kind:'deduction_group',members:[{component_id:f.ids.row1,group:'mandatory'},{component_id:f.ids.row2,group:'voluntary'}],inventory:'complete',basis};
 const reading=f.receipt(target,f.answer(value));expect(f.materialize([reading]).structureReadings.size).toBe(1);
 expect(reading.value).toMatchObject({inventory:'complete'});
 for(const bad of [{...value,members:[value.members[0]]},{...value,members:[value.members[0],value.members[0]]},{...value,members:[value.members[0],{component_id:randomUUID(),group:'voluntary'}]},
  {...value,members:[value.members[0],{component_id:f.ids.row2,group:'unknown'}]}])expect(()=>validateDocumentReadingAnswerForTarget(target,f.answer(bad))).toThrow();
 expect(f.receipt(target,f.answer({...value,inventory:'partial',members:[value.members[0],{component_id:f.ids.row2,group:'unknown'}]})).value).toMatchObject({inventory:'partial'});
});
it.each(['opening','accrued','used','closing','adjustments'] as const)('binds balance %s value with its own period, unit and source section',cell=>{
 const f=fixture(),target=f.target({kind:'balance_movement',balanceKind:'vacation',candidateId:f.ids.balance,cell});
 const value={kind:'balance_movement',state:'value',amount:'8.00',unit:'source_native_unknown',period:'2025-01',basis};
 const reading=f.receipt(target,f.answer(value)),result=f.materialize([reading]);
 expect(reading.value).toMatchObject({unit:'source_native_unknown',amount:'8',period:'2025-01'});
 expect(result.extraction.fields).toEqual(f.extraction.fields);expect(result.structureReadings.size).toBe(1);
 expect(documentFieldVerificationDisplay(target)).toMatchObject({structure_context:{kind:'balance_movement',cell,proposed_value:null}});
});
it('requires explicit adjustments-not-present evidence and never manufactures a zero',()=>{
 const f=fixture(),target=f.target({kind:'balance_movement',balanceKind:'vacation',candidateId:f.ids.balance,cell:'adjustments'}),a=f.answer({kind:'balance_movement',state:'not_present',period:'2025-01',basis});
 const r=f.receipt(target,a);expect(r.value).not.toHaveProperty('amount');expect(f.materialize([r]).structureReadings.size).toBe(1);
 const other=f.target({...sourceStructureSelector(target.subject),kind:'balance_movement',balanceKind:'vacation',candidateId:f.ids.balance,cell:'used'});
 expect(()=>validateDocumentReadingAnswerForTarget(other,a)).toThrow('REQUEST_ANSWER_INVALID');
});
it.each([{amount:'8 days',unit:'days',period:'2025-01'},{amount:'8',unit:'days',period:'2025-02'},{amount:'8',unit:'ILS',period:'2025-01'},{amount:'8',period:'2025-01'}])('rejects malformed or unbound balance inputs %j',bad=>{
 const f=fixture(),target=f.target({kind:'balance_movement',balanceKind:'vacation',candidateId:f.ids.balance,cell:'closing'});
 expect(()=>validateDocumentReadingAnswerForTarget(target,f.answer({kind:'balance_movement',state:'value',...bad,basis}))).toThrow();
});
it('rejects same-checkpoint duplicate subjects and receipt value/hash changes',()=>{
 const f=fixture(),r=f.receipt(f.target(),f.answer(f.relation));expect(()=>f.materialize([r,r])).toThrow('BINDING_MISMATCH');
 expect(()=>f.materialize([{...r,value:{...f.relation,relationship:'different_base'}}])).toThrow('RECEIPT_HASH');
 expect(()=>f.materialize([{...r,first_pass_extraction_sha256:'f'.repeat(64)}])).toThrow();
});
it('rejects absent context, foreign case and changed source rows; stale decision is not admitted',()=>{
 const f=fixture(),target=f.target(),r=f.receipt(target,f.answer(f.relation));
 expect(()=>materializeValidatedPayslipReadings({case_id:f.document.case_id,document:f.document,extraction:normalizedPayslipExtractionSchema.parse({...f.extraction,customer_source_structures:[r]})})).toThrow('CONTEXT_REQUIRED');
 expect(()=>f.materialize([{...r,case_id:randomUUID()}])).toThrow('BINDING_MISMATCH');
 f.extraction.fields[1]={...f.extraction.fields[1],raw_value:'6000.00'};f.rehash();
 expect(f.resolve(target,f.answer(f.relation)).state).toBe('stale');
});
it('retains serialized journal size limits and rejects cross-kind values',()=>{
 const f=fixture();expect(serializeDocumentFieldAnswerV3(f.answer(f.relation)).length).toBeLessThan(2000);
 expect(()=>serializeDocumentFieldAnswerV3(f.answer({...f.relation,basis:{...basis,text:'x'.repeat(2001)}}))).toThrow('REQUEST_ANSWER_INVALID');
 expect(()=>validateDocumentReadingAnswerForTarget(f.target(),f.answer({kind:'balance_movement',state:'value',amount:'1',unit:'days',period:'2025-01',basis}))).toThrow('REQUEST_ANSWER_INVALID');
});
