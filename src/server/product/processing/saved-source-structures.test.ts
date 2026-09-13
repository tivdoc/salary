import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import type {SourceStructureSelector} from '@/engine/extraction/source-structure-resolution';
import {documentSourceStructureTarget} from '../reports/document-source-structure';
import {validateRequestAnswer} from '../reports/request-answer';
import {validateDocumentReadingAnswerForTarget} from '../reports/reading-verification';
import {savedDocumentReadings} from './saved-field-readings';
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
 const entry=(t:ReturnType<typeof target>,value:unknown)=>({id:randomUUID(),case_id:document.case_id,scope_month:'2025-01',code:`document_field:${t.target_sha256}`,answer_kind:'choice',
  answer:JSON.stringify(value),answer_revision:1,answer_identity_id:randomUUID(),answer_created_at:'2025-02-02T00:00:00Z',field_target:t});
 const relationEntry=entry(target(),{schema_version:'document-field-answer-v3',action:'confirm',structured_value:relation});
 const group=target({kind:'deduction_group'}),balance=target({kind:'balance_movement',balanceKind:'vacation',cell:'closing',candidateId:ids.balance});
 const groupEntry=entry(group,answer({kind:'deduction_group',members:[{component_id:ids.row1,group:'mandatory'},{component_id:ids.row2,group:'voluntary'}],inventory:'complete',basis}));
 const balanceEntry=entry(balance,answer({kind:'balance_movement',state:'value',amount:'8.00',unit:'source_native_unknown',period:'2025-01',basis}));
 const input={caseId:document.case_id,month:'2025-01',policyVersion:'structure-test-v1',journal:{answers:[relationEntry,groupEntry,balanceEntry]},checkpoint};
 return {input,relationEntry,groupEntry,balanceEntry,entry,relation,answer,target};
}
it('materializes three distinct source decisions from the saved journal without rewriting provider data',()=>{
 const f=fixture(),before=canonicalSha256(f.input.checkpoint),journalBefore=canonicalSha256(f.input.journal),r=savedDocumentReadings(f.input);
 expect(r.source_structure).toHaveLength(3);expect(r.scalar).toEqual([]);expect(r.row_cell).toEqual([]);
 expect(r.source_structure.map(x=>x.subject.kind)).toEqual(['source_relationship','deduction_group','balance_movement']);
 expect(r.source_structure[0]).toMatchObject({identity_id:f.relationEntry.answer_identity_id,request_id:f.relationEntry.id,answer_revision:1,value:{relationship:'same_base'}});
 expect(r.source_structure[2].value).toMatchObject({unit:'source_native_unknown',amount:'8'});expect(JSON.parse(f.balanceEntry.answer).structured_value.amount).toBe('8.00');
 expect(canonicalSha256(f.input.checkpoint)).toBe(before);expect(canonicalSha256(f.input.journal)).toBe(journalBefore);
});
it.each(['unknown','unreadable'])('latest %s withdraws only its own subject and preserves earlier receipt/history',action=>{
 const f=fixture(),before=savedDocumentReadings(f.input),oldJournal=structuredClone(f.input.journal),machine=canonicalSha256(f.input.checkpoint);
 f.relationEntry.answer_revision=2;f.relationEntry.answer=JSON.stringify({schema_version:'document-field-answer-v3',action});
 const after=savedDocumentReadings(f.input);
 expect(after.source_structure).toEqual(before.source_structure.slice(1));
 expect(oldJournal.answers[0].answer_revision).toBe(1);expect(before.source_structure[0].value).toMatchObject({relationship:'same_base'});
 f.relationEntry.answer_revision=3;f.relationEntry.answer=JSON.stringify(f.answer({...f.relation,relationship:'different_base'}));
 expect(savedDocumentReadings(f.input).source_structure[0]).toMatchObject({answer_revision:3,value:{relationship:'different_base'}});
 expect(canonicalSha256(f.input.checkpoint)).toBe(machine);
});
it('rejects foreign, unattributed and duplicate journal entries',()=>{
 const foreign=fixture();foreign.relationEntry.case_id=randomUUID();expect(()=>savedDocumentReadings(foreign.input)).toThrow('REQUEST_FIELD_CASE_MISMATCH');
 const duplicate=fixture();duplicate.input.journal.answers.push(duplicate.relationEntry);expect(()=>savedDocumentReadings(duplicate.input)).toThrow('SAVED_REQUEST_ID_AMBIGUOUS');
 const subject=fixture();subject.input.journal.answers.push({...subject.relationEntry,id:randomUUID()});expect(()=>savedDocumentReadings(subject.input)).toThrow('REQUEST_FIELD_READING_AMBIGUOUS');
 const anonymous=fixture();Reflect.deleteProperty(anonymous.relationEntry,'answer_identity_id');expect(()=>savedDocumentReadings(anonymous.input)).toThrow();
});
it.each(['month','version','policy','checkpoint'] as const)('does not admit stale %s source structures',kind=>{
 const f=fixture();if(kind==='month')f.input.month='2025-02';if(kind==='version')f.input.checkpoint.version_id=randomUUID();if(kind==='policy')f.input.policyVersion='new-policy';
 if(kind==='checkpoint'){f.input.checkpoint.run.result.final_extraction.fields[0].confidence=.5;f.input.checkpoint.result_sha256=canonicalSha256(f.input.checkpoint.run.result);}
 expect(savedDocumentReadings(f.input).source_structure).toEqual([]);
});
it('accepts the v3 request envelope but validates source-specific semantics before admission',()=>{
 const f=fixture(),request={answer_kind:'choice' as const,options:[],code:f.relationEntry.code};
 const accepted=validateRequestAnswer(request,f.relationEntry.answer);expect(JSON.parse(accepted).action).toBe('confirm');
 expect(()=>validateDocumentReadingAnswerForTarget(f.relationEntry.field_target,accepted)).not.toThrow();
 for(const entry of [f.groupEntry,f.balanceEntry]){
  const result=validateRequestAnswer({...request,code:entry.code},entry.answer);
  expect(()=>validateDocumentReadingAnswerForTarget(entry.field_target,result)).not.toThrow();
 }
 for(const bad of [{schema_version:'document-field-answer-v3',action:'confirm'},
  {schema_version:'document-field-answer-v3',action:'confirm',structured_value:{...f.relation,fund_kind:null}}])expect(()=>validateRequestAnswer(request,JSON.stringify(bad))).toThrow('REQUEST_ANSWER_INVALID');
 const mismatched=validateRequestAnswer(request,f.groupEntry.answer);
 expect(()=>validateDocumentReadingAnswerForTarget(f.relationEntry.field_target,mismatched)).toThrow();
});
