import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {normalizedPayslipExtractionSchema,type NormalizedPayslipExtraction} from './payslip.ts';
import {normalizeDecimal} from './normalization.ts';
import {customerSourceStructureReadingSchema,sourceStructureRefSchema,sourceStructureSubjectSchema,sourceStructureValueSchema,type SourceStructureRef,type SourceStructureSubject,type SourceStructureValue} from './source-structure.ts';

export type SourceStructureSelector=
 |{kind:'source_relationship';componentKind:'pension_employee'|'pension_employer'|'severance'|'combined_employer_funds';contribution:{kind:SourceStructureRef['kind'];id:string};base:{kind:SourceStructureRef['kind'];id:string}}
 |{kind:'deduction_group'}
 |{kind:'balance_movement';balanceKind:'vacation'|'sick';cell:'opening'|'accrued'|'used'|'adjustments'|'closing';candidateId:string};
export function sourceStructureRef(extraction:NormalizedPayslipExtraction,selector:{kind:SourceStructureRef['kind'];id:string}):SourceStructureRef {
 const {kind,id}=selector;
 const allIds=[...extraction.fields.map(f=>f.candidate_id),...extraction.additional_components.map(r=>r.component_id),...(extraction.source_scope_observations??[]).map(o=>o.candidate.candidate_id)];
 if(allIds.filter(x=>x===id).length!==1)throw Error('SOURCE_STRUCTURE_REF_AMBIGUOUS');
 if(kind==='field'){
  const f=extraction.fields.find(f=>f.candidate_id===id);if(!f)throw Error('SOURCE_STRUCTURE_REF_MISSING');
  return sourceStructureRefSchema.parse({kind,id,sha256:canonicalSha256(f),source:f.source,label:f.source.text_fragment??f.field,raw_value:f.raw_value});
 }
 if(kind==='scope'){
  const o=extraction.source_scope_observations?.find(o=>o.candidate.candidate_id===id);if(!o)throw Error('SOURCE_STRUCTURE_REF_MISSING');
  return sourceStructureRefSchema.parse({kind,id,sha256:canonicalSha256(o),source:o.candidate.source,label:o.source_label,raw_value:o.candidate.raw_value});
 }
 const r=extraction.additional_components.find(r=>r.component_id===id);if(!r)throw Error('SOURCE_STRUCTURE_REF_MISSING');
 return sourceStructureRefSchema.parse({kind,id,sha256:canonicalSha256(r),source:r.source,label:r.source_label,raw_value:r.amount_raw});
}
export function sourceStructureSelector(subject:SourceStructureSubject):SourceStructureSelector {
 if(subject.kind==='source_relationship')return {kind:subject.kind,componentKind:subject.component_kind,contribution:{kind:subject.contribution.kind,id:subject.contribution.id},base:{kind:subject.base.kind,id:subject.base.id}};
 if(subject.kind==='deduction_group')return {kind:subject.kind};
 return {kind:subject.kind,balanceKind:subject.balance_kind,cell:subject.cell,candidateId:subject.anchor.id};
}
export function sourceStructureSubject(input:{extraction:NormalizedPayslipExtraction;firstPass:NormalizedPayslipExtraction;selector:SourceStructureSelector}):SourceStructureSubject {
 const {extraction:e,firstPass:first,selector:s}=input;let subject:SourceStructureSubject;
 if(e.document_id!==first.document_id)throw Error('SOURCE_STRUCTURE_DOCUMENT_MISMATCH');
 if(s.kind==='source_relationship'){
  const base=e.fields.find(f=>f.candidate_id===s.base.id);
  if(s.base.kind!=='field'||base?.field!=='pension_base')throw Error('SOURCE_STRUCTURE_BASE_UNSUPPORTED');
  const expected={pension_employee:'pension_employee_contribution',pension_employer:'pension_employer_contribution',severance:'severance_contribution'};
  const field=e.fields.find(f=>f.candidate_id===s.contribution.id),scope=e.source_scope_observations?.find(o=>o.candidate.candidate_id===s.contribution.id),row=e.additional_components.find(r=>r.component_id===s.contribution.id);
  if(s.componentKind==='combined_employer_funds'?(s.contribution.kind!=='scope'||scope?.scope!=='combined_employer_funds')
   :s.contribution.kind==='field'?field?.field!==expected[s.componentKind]:s.contribution.kind!=='component'||row?.semantic_kind!=='deduction')throw Error('SOURCE_STRUCTURE_CONTRIBUTION_UNSUPPORTED');
  subject={kind:s.kind,component_kind:s.componentKind,contribution:sourceStructureRef(e,s.contribution),base:sourceStructureRef(e,s.base)};
 }else if(s.kind==='deduction_group'){
  const totals=e.fields.filter(f=>f.field==='total_deductions'),voluntary=e.source_scope_observations?.filter(o=>o.scope==='voluntary_deduction')??[];
  if(totals.length!==1||voluntary.length>1)throw Error('SOURCE_STRUCTURE_TOTAL_AMBIGUOUS');
  const rows=e.additional_components.filter(r=>r.semantic_kind==='deduction').map(r=>sourceStructureRef(e,{kind:'component',id:r.component_id})).sort((a,b)=>a.id.localeCompare(b.id));
  subject={kind:s.kind,rows,mandatory_total:sourceStructureRef(e,{kind:'field',id:totals[0].candidate_id}),voluntary_total:voluntary.length?sourceStructureRef(e,{kind:'scope',id:voluntary[0].candidate.candidate_id}):null};
 }else{
  const candidates=first.fields.filter(f=>f.candidate_id===s.candidateId),candidate=candidates[0];
  if(candidates.length!==1||candidate.field!==`${s.balanceKind}_balance`)throw Error('SOURCE_STRUCTURE_BALANCE_ANCHOR');
  subject={kind:s.kind,balance_kind:s.balanceKind,cell:s.cell,anchor:sourceStructureRef(first,{kind:'field',id:s.candidateId}),page:candidate.source.page,
   original_raw_value:s.cell==='closing'?candidate.raw_value:null};
 }
 const parsed=sourceStructureSubjectSchema.parse(subject);
 const refs=parsed.kind==='source_relationship'?[parsed.contribution,parsed.base]:parsed.kind==='deduction_group'?[...parsed.rows,parsed.mandatory_total,...(parsed.voluntary_total?[parsed.voluntary_total]:[])]:[parsed.anchor];
 if(refs.some(r=>r.source.document_id!==e.document_id||r.source.page>e.quality_metrics.page_count||r.source.page>first.quality_metrics.page_count
  ||r.source.source_scope?.period_kind!=='current'))throw Error('SOURCE_STRUCTURE_CURRENT_SOURCE_REQUIRED');
 return parsed;
}
export function sourceStructureSubjectKey(subject:SourceStructureSubject):string {
 if(subject.kind==='source_relationship')return `${subject.kind}:${subject.component_kind}:${subject.contribution.id}:${subject.base.id}`;
 if(subject.kind==='deduction_group')return subject.kind;
 return `${subject.kind}:${subject.balance_kind}:${subject.anchor.id}:${subject.cell}`;
}
export function normalizeSourceStructureValue(subject:SourceStructureSubject,valueInput:unknown,month:string):SourceStructureValue {
 const value=sourceStructureValueSchema.parse(valueInput);
 if(value.kind!==subject.kind)throw Error('REQUEST_ANSWER_INVALID');
 const pages=subject.kind==='source_relationship'?[subject.contribution.source.page,subject.base.source.page]:subject.kind==='deduction_group'?[...subject.rows.map(r=>r.source.page),subject.mandatory_total.source.page,...(subject.voluntary_total?[subject.voluntary_total.source.page]:[])]:[subject.page];
 if(!pages.includes(value.basis.page))throw Error('REQUEST_ANSWER_INVALID');
 if(subject.kind==='source_relationship'&&value.kind==='source_relationship'){
  if(value.component_kind!==subject.component_kind)throw Error('REQUEST_ANSWER_INVALID');return value;
 }
 if(subject.kind==='deduction_group'&&value.kind==='deduction_group'){
  if(value.members.length!==subject.rows.length||value.members.some(m=>!subject.rows.some(r=>r.id===m.component_id))
   ||!subject.voluntary_total&&value.members.some(m=>m.group==='voluntary'))throw Error('REQUEST_ANSWER_INVALID');
  return {...value,members:[...value.members].sort((a,b)=>a.component_id.localeCompare(b.component_id))};
 }
 if(subject.kind==='balance_movement'&&value.kind==='balance_movement'){
  if(value.period!==month||value.state==='not_present'&&subject.cell!=='adjustments')throw Error('REQUEST_ANSWER_INVALID');
  if(value.state==='not_present')return value;
  if(!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(value.amount))throw Error('REQUEST_ANSWER_INVALID');
  const amount=normalizeDecimal(value.amount);if(amount===null||subject.cell!=='adjustments'&&amount.startsWith('-'))throw Error('REQUEST_ANSWER_INVALID');
  return {...value,amount};
 }
 throw Error('REQUEST_ANSWER_INVALID');
}
/** Context is supplied independently from the saved checkpoint, never from an
 * answer. Rebuilding detects source changes and unknown/foreign observations. */
export function assertSourceStructureSubject(input:{subject:SourceStructureSubject;extraction:NormalizedPayslipExtraction;firstPass:unknown}){
 const firstPass=normalizedPayslipExtractionSchema.parse(input.firstPass);
 const actual=sourceStructureSubject({...input,firstPass,selector:sourceStructureSelector(input.subject)});
 if(canonicalSha256(actual)!==canonicalSha256(input.subject))throw Error('SOURCE_STRUCTURE_SUBJECT_CHANGED');
 return firstPass;
}
/** This verifies the receipt's internal content, not account authentication or
 * checkpoint admission. Those remain mandatory in the saved-source loader. */
export function parseSourceStructureReadingValue(input:unknown){
 const reading=customerSourceStructureReadingSchema.parse(input),{verification_sha256,...body}=reading;
 if(canonicalSha256(body)!==verification_sha256)throw Error('DOCUMENT_SOURCE_STRUCTURE_RECEIPT_HASH');
 const value=normalizeSourceStructureValue(reading.subject,reading.value,reading.month);
 if(canonicalSha256(value)!==canonicalSha256(reading.value))throw Error('DOCUMENT_SOURCE_STRUCTURE_VALUE_INVALID');
 return {reading,subject:reading.subject,normalized_value:value};
}
