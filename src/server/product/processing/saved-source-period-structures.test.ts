import {expect,it,vi} from 'vitest';
vi.mock('server-only',()=>({}));
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import type {SourceStructureSelector} from '@/engine/extraction/source-structure-resolution';
import {IDENTIFIED_PERIOD_STRUCTURE_POLICY} from '@/engine/extraction/source-structure-period';
import {documentSourceStructureTarget,documentSourceStructureTargetSchema} from '../reports/document-source-structure';
import {documentReadingTargetForCheckpoint} from '../reports/document-field-confirmation';
import {resolveDocumentReadingVerification} from '../reports/reading-verification';
import {savedDocumentReadings,savedSourcePeriodReadings} from './saved-field-readings';
import {SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import {openSavedReadingDependencies} from './saved-reading-dependencies';
import {reviewInputFromPayslips,PAYSLIP_SOURCE_STRUCTURE_POLICY} from '@/engine/document-review/payslip-adapter';
import {runDocumentReview} from '@/engine/document-review/service';
import type {PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';

const basis={page:1,locator:'Synthetic January heading',text:'Synthetic January 2025 column covers these exact source cells'};
function fixture(originalCurrent=false){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-period-structures-v2',mode:'real'}),document=f.stored.documents[0];
 const template=f.stored.extractions[0].fields[0],source={document_id:document.document_id,page:1,text_fragment:'Synthetic January table',
  ...(originalCurrent?{source_scope:{period_kind:'current',fund_kind:'unknown',column_label:'January'}}:{})};
 const ids={base:randomUUID(),employee:randomUUID(),total:randomUUID(),row:randomUUID()};
 const field=(field:string,id:string,raw:string,minor_units:number)=>({...template,field,candidate_id:id,raw_value:raw,normalized_value:{currency:'ILS',minor_units},source});
 const e=normalizedPayslipExtractionSchema.parse({...f.stored.extractions[0],fields:[...f.stored.extractions[0].fields.filter(x=>x.field==='salary_period'),
  field('pension_base',ids.base,'5000',500000),field('pension_employee_contribution',ids.employee,'300',30000),field('total_deductions',ids.total,'300',30000)],
  source_scope_observations:[],additional_components:[{component_id:ids.row,source_label:'Synthetic pension deduction',normalized_label:'deduction',semantic_kind:'deduction',
   quantity_raw:null,rate_raw:null,percentage_raw:null,amount_raw:'300',quantity:null,rate:null,percentage:null,amount:{currency:'ILS',minor_units:30000},
   confidence:.94,source,extraction_method:'fixture',warning_flags:[],normalization_warnings:[]}]});
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:randomUUID(),version_id:document.document_id,input_sha256:document.content_sha256,
  expected_month:'2025-01',period_mismatch:false,result_sha256:'',run:{result:{final_extraction:e,first_pass:{normalized_extraction:e}}}};
 checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);
 const policyVersion=SAVED_EXTRACTION_POLICY,selector:SourceStructureSelector={kind:'source_relationship',componentKind:'pension_employee',contribution:{kind:'field',id:ids.employee},base:{kind:'field',id:ids.base}};
 const target=(selector:SourceStructureSelector)=>documentSourceStructureTarget({checkpoint,policyVersion,selector});
 const periodValue={kind:'period_association',period_kind:'current',period:{from:'2025-01-01',to:'2025-01-31'},basis};
 const correct=(structured_value:unknown)=>({schema_version:'document-field-answer-v3',action:'correct',structured_value});
 const entry=(field_target:ReturnType<typeof target>,answer:unknown)=>({id:randomUUID(),case_id:document.case_id,scope_month:'2025-01',code:`document_field:${field_target.target_sha256}`,
  answer_kind:'choice',answer:JSON.stringify(answer),answer_revision:1,answer_identity_id:randomUUID(),answer_created_at:'2025-02-02T00:00:00Z',field_target});
 const relationPeriod=entry(target({kind:'period_association',refs:[{kind:'field',id:ids.base},{kind:'field',id:ids.employee}]}),correct(periodValue));
 const groupPeriod=entry(target({kind:'period_association',refs:[{kind:'field',id:ids.total},{kind:'component',id:ids.row}]}),correct(periodValue));
 const input={caseId:document.case_id,month:'2025-01',policyVersion,checkpoint,journal:{answers:[relationPeriod,groupPeriod]}};
 const periods=()=>savedSourcePeriodReadings(input);
 const v2=(selected:SourceStructureSelector=selector)=>documentSourceStructureTarget({checkpoint,policyVersion,selector:selected,periodPolicy:IDENTIFIED_PERIOD_STRUCTURE_POLICY,periodReadings:periods()});
 const relation={kind:'source_relationship',relationship:'same_base',component_kind:'pension_employee',fund_kind:'pension',fund_label:'Synthetic pension',source_kind:'labelled_section',basis};
 const relationEntry=()=>entry(v2(),{schema_version:'document-field-answer-v3',action:'confirm',structured_value:relation});
 const groupEntry=()=>entry(v2({kind:'deduction_group'}),correct({kind:'deduction_group',members:[{component_id:ids.row,group:'mandatory'}],inventory:'complete',basis}));
 const verify=(t:ReturnType<typeof target>,withContext=true)=>resolveDocumentReadingVerification({target:t,currentCheckpoint:checkpoint,policyVersion,caseId:document.case_id,month:input.month,
  requestId:randomUUID(),answerRevision:1,identityId:randomUUID(),answeredAt:'2025-02-02T00:00:00Z',answer:correct(relation),...(withContext?{periodReadings:periods()}:{})});
 const prepare=()=>{
  const extraction=normalizedPayslipExtractionSchema.parse({...e,customer_source_structures:savedDocumentReadings(input).source_structure,
   source_reading_context:{checkpoint_result_sha256:checkpoint.result_sha256,first_pass:e}}),snapshot={...f.stored,documents:[document],extractions:[extraction]};
  const review=runDocumentReview(reviewInputFromPayslips({case_id:document.case_id,period:periodValue.period,review_policy:PAYSLIP_SOURCE_STRUCTURE_POLICY,identified_period_structure_policy:IDENTIFIED_PERIOD_STRUCTURE_POLICY,
   purchased_scope:{order_id:'synthetic.order',receipt_sha256:'a'.repeat(64),origin:'saved_order',topics:['pension']},snapshot,
   retained_unresolved_fields:[{case_id:document.case_id,document_id:document.document_id,source_sha256:document.content_sha256,checkpoint_result_sha256:checkpoint.result_sha256,
    checkpoint_result:checkpoint.run.result,final_extraction_sha256:canonicalSha256(e),first_pass:e}]}),'synthetic.period.opener');
  return {snapshot,review};
 };
 return {input,checkpoint,selector,target,v2,periods,relationPeriod,groupPeriod,relationEntry,groupEntry,periodValue,correct,verify,prepare};
}
it('replays period decisions before v2 relationship and group answers regardless of journal order, preserving originals',()=>{
 const f=fixture(),relation=f.relationEntry(),group=f.groupEntry();f.input.journal.answers.unshift(group,relation);
 const before=canonicalSha256(f.input),out=savedDocumentReadings(f.input);
 expect(out.source_structure.map(r=>r.schema_version)).toEqual(['document-source-structure-reading-v1','document-source-structure-reading-v1','document-source-structure-reading-v2','document-source-structure-reading-v2']);
 expect(out.source_structure.filter(r=>r.schema_version.endsWith('v2')).map(r=>r.subject.kind)).toEqual(['deduction_group','source_relationship']);
 expect(out.scalar).toEqual([]);expect(canonicalSha256(f.input)).toBe(before);
 expect(f.periods().size).toBe(2);
});
it('requires explicit opt-in and independent current journal context even for a structurally valid embedded witness',()=>{
 const f=fixture(),t=f.v2();expect(()=>f.target(f.selector)).toThrow('SOURCE_STRUCTURE_CURRENT_SOURCE_REQUIRED');
 expect(t.schema_version).toBe('document-source-relationship-v2');expect(documentSourceStructureTargetSchema.parse(t)).toEqual(t);
 expect(f.verify(t,false)).toEqual({state:'stale'});expect(f.verify(t).state).toBe('corrected_reading');
 expect(()=>documentReadingTargetForCheckpoint({target:t,currentCheckpoint:f.checkpoint})).toThrow('SOURCE_STRUCTURE_PERIOD_CONTEXT_REQUIRED');
 expect(documentReadingTargetForCheckpoint({target:t,currentCheckpoint:f.checkpoint,periodReadings:f.periods()})).toEqual(t);
});
it('keeps default v1 bytes unchanged when an unused period map is supplied',()=>{
 const f=fixture(true),plain=f.target(f.selector),withMap=documentSourceStructureTarget({checkpoint:f.checkpoint,policyVersion:f.input.policyVersion,selector:f.selector,periodReadings:f.periods()});
 expect(withMap).toEqual(plain);expect(plain.schema_version).toBe('document-source-relationship-v1');expect(plain).not.toHaveProperty('period_witness');
});
it.each(['unknown','unreadable'])('latest period %s withdraws only dependent v2 reading and keeps retained history reproducible',action=>{
 const f=fixture(),relation=f.relationEntry(),group=f.groupEntry();f.input.journal.answers.unshift(relation,group);
 const historical=structuredClone(f.input),old=savedDocumentReadings(historical);
 f.relationPeriod.answer_revision=2;f.relationPeriod.answer=JSON.stringify({schema_version:'document-field-answer-v3',action});
 const now=savedDocumentReadings(f.input);
 expect(now.source_structure.map(r=>r.subject.kind)).toEqual(['period_association','deduction_group']);
 expect(now.source_structure.find(r=>r.subject.kind==='deduction_group')).toEqual(old.source_structure.find(r=>r.subject.kind==='deduction_group'));
 expect(savedDocumentReadings(historical)).toEqual(old);expect(f.verify(relation.field_target)).toEqual({state:'stale'});
});
it.each(['same_value_new_revision','retroactive'])('a %s period correction invalidates the exact bound target until it is re-opened',kind=>{
 const f=fixture(),target=f.v2();f.relationPeriod.answer_revision=2;
 if(kind==='retroactive')f.relationPeriod.answer=JSON.stringify(f.correct({...f.periodValue,period_kind:'retroactive',period:{from:'2024-12-01',to:'2024-12-31'}}));
 expect(f.verify(target)).toEqual({state:'stale'});
 if(kind==='retroactive')expect(()=>f.v2()).toThrow('SOURCE_STRUCTURE_PERIOD_NOT_CURRENT');
 else expect(f.v2().target_sha256).not.toBe(target.target_sha256);
});
it('ignores unrelated period changes when reconstructing a relationship witness',()=>{
 const f=fixture(),target=f.v2();f.groupPeriod.answer_revision=2;f.groupPeriod.answer=JSON.stringify({schema_version:'document-field-answer-v3',action:'unknown'});
 expect(f.v2()).toEqual(target);expect(f.verify(target).state).toBe('corrected_reading');
});
it('rejects foreign or duplicate authenticated journal identities rather than trusting a self-contained target',()=>{
 const f=fixture();f.input.journal.answers.push({...f.relationPeriod});expect(()=>f.periods()).toThrow('SAVED_REQUEST_ID_AMBIGUOUS');
 f.input.journal.answers.pop();f.relationPeriod.case_id=randomUUID();expect(()=>f.periods()).toThrow('REQUEST_FIELD_CASE_MISMATCH');
});
it('rejects rehashed target witness source pin corruption',()=>{
 const f=fixture(),t=structuredClone(f.v2());if(!('period_witness' in t))throw Error('V2_REQUIRED');
 const item=t.period_witness.refs.find(x=>x.reading);if(!item?.reading)throw Error('PERIOD_RECEIPT_REQUIRED');
 item.reading.source_sha256='0'.repeat(64);const {verification_sha256,...readingBody}=item.reading;void verification_sha256;item.reading.verification_sha256=canonicalSha256(readingBody);
 const {target_sha256,...body}=t;void target_sha256;
 expect(()=>documentSourceStructureTargetSchema.parse({...body,target_sha256:canonicalSha256(body)})).toThrow();
});
it.each(['current','changed','absent'])('the ordinary opener rebuilds its %s period dependency from the pinned journal',async state=>{
 const f=fixture(),{snapshot,review}=f.prepare(),opened:unknown[]=[];
 if(state==='changed')f.relationPeriod.answer_revision=2;
 const context:PostgresTransactionContext={transaction_id:'synthetic.period.open',client:{async query(q){
  if(q.name==='review_dependency_checkpoint')return {rows:[{result:f.checkpoint,result_sha256:f.checkpoint.result_sha256,...(state!=='absent'?{source_journal:f.input.journal}:{})}],row_count:1};
  if(q.name==='review_dependency_existing_targets')return {rows:[],row_count:0};
  if(q.name==='review_dependency_request_open'){opened.push(JSON.parse(String(q.values[3])));return {rows:[{id:randomUUID()}],row_count:1};}
  throw Error('UNEXPECTED_SQL:'+q.name);
 }}};
 const run=()=>openSavedReadingDependencies(context,{schema_version:'saved-case-work-v1',case_id:f.input.caseId,revision:1,input_sha256:'a'.repeat(64),mode:'draft'},review,snapshot);
 if(state==='current'){
  await run();const relationship=opened.map(x=>documentSourceStructureTargetSchema.safeParse(x)).filter(x=>x.success).map(x=>x.data).find(x=>x.schema_version==='document-source-relationship-v2');
  expect(relationship).toEqual(f.v2());
 }else{await expect(run()).rejects.toThrow(state==='changed'?'REVIEW_DEPENDENCY_PERIOD_CHANGED':undefined);expect(opened).toEqual([]);}
});
