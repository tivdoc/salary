import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedAdditionalComponentSchema,normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {materializeValidatedPayslipReadings,identifiedDirectRowCell,rowCellReadingKey,payslipMachineExtractionSha256} from '@/engine/extraction/reading-resolution';
import {rowReadingCellSchema,type RowReadingCell} from '@/engine/extraction/customer-reading';
import {documentFieldTarget,documentReadingTargetSchema} from './document-field-confirmation';
import {documentRowCellTarget,documentRowCellQuestion,documentRowCellTargetSchema} from './document-row-cell-confirmation';
import {validateDocumentReadingAnswerForTarget,resolveDocumentReadingVerification,materializeDocumentVerification,documentFieldVerificationDisplay} from './reading-verification';

function fixture(cell:RowReadingCell='amount'){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-row-cell-reading',mode:'real'}),document=f.stored.documents[0],extraction=normalizedPayslipExtractionSchema.parse(structuredClone(f.stored.extractions[0]));
 const field=extraction.fields.find(f=>f.field==='gross_salary')!;
 const row=normalizedAdditionalComponentSchema.parse({component_id:randomUUID(),source_label:'רכיב סינתטי',normalized_label:'synthetic_bonus',semantic_kind:'bonus',
  quantity_raw:'2',rate_raw:'100.00',amount_raw:'200.00',percentage_raw:'12.50%',quantity:'2',rate:{currency:'ILS',minor_units:10000},amount:{currency:'ILS',minor_units:20000},percentage:{basis_points:1250},
  confidence:.94,source:{...field.source,text_fragment:'רכיב סינתטי',page:1},extraction_method:field.extraction_method,warning_flags:[],normalization_warnings:[]});
 extraction.additional_components=[row];
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:randomUUID(),version_id:document.document_id,
  input_sha256:document.content_sha256,expected_month:'2025-01',period_mismatch:false,result_sha256:'',run:{result:{final_extraction:extraction}}};
 const rehash=()=>{checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);};rehash();
 const target=()=>documentRowCellTarget({checkpoint,policyVersion:'row-test-v1',componentId:row.component_id,cell});
 const input=()=>({target:target(),currentCheckpoint:checkpoint,caseId:document.case_id,month:'2025-01',policyVersion:'row-test-v1',requestId:randomUUID(),answerRevision:1,identityId:randomUUID(),answeredAt:'2025-02-02T00:00:00Z',answer:{schema_version:'document-field-answer-v2',action:'confirm'}});
 const materialize=(answer:unknown={schema_version:'document-field-answer-v2',action:'confirm'})=>materializeDocumentVerification(resolveDocumentReadingVerification({...input(),answer}),canonicalSha256(extraction));
 return {document,extraction,row,checkpoint,rehash,target,input,materialize};
}
it.each(rowReadingCellSchema.options)('binds only one %s cell without changing provider bytes or adding a scalar fact',cell=>{
 const f=fixture(cell),before=canonicalSha256(f.extraction),target=f.target(),receipt=f.materialize();
 expect(receipt?.kind).toBe('row_cell');if(receipt?.kind!=='row_cell')throw Error('ROW_RECEIPT_REQUIRED');
 expect(documentReadingTargetSchema.parse(target)).toEqual(target);expect(target).not.toHaveProperty('candidate');
 const annotated=normalizedPayslipExtractionSchema.parse({...f.extraction,customer_row_readings:[receipt.reading]});
 const result=materializeValidatedPayslipReadings({document:f.document,extraction:annotated,case_id:f.document.case_id});
 expect(result.extraction.fields).toEqual(f.extraction.fields);expect(result.extraction.additional_components).toEqual(f.extraction.additional_components);
 for(const other of rowReadingCellSchema.options){
  const read=identifiedDirectRowCell({original:result.original,effective:result.extraction,rowReadings:result.rowReadings,row:f.row,cell:other});
  expect(read===null).toBe(other!==cell);
 }
 expect(payslipMachineExtractionSha256(annotated)).toBe(before);expect(canonicalSha256(f.extraction)).toBe(before);expect(f.row.confidence).toBe(.94);
 expect(documentFieldVerificationDisplay(target)).toMatchObject({field:'row_cell.'+cell,source:{page:1},raw_value:f.row[`${cell}_raw`]});
 expect(documentRowCellQuestion(target).question).toContain('רכיב סינתטי');
});
it('corrects exactly one cell and preserves source observations and warning text',()=>{
 const f=fixture('amount');f.row.warning_flags=[];f.row.normalization_warnings=['source_note'];f.rehash();
 const receipt=f.materialize({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'250.00'});if(receipt?.kind!=='row_cell')throw Error('ROW_RECEIPT_REQUIRED');
 const result=materializeValidatedPayslipReadings({document:f.document,case_id:f.document.case_id,extraction:{...f.extraction,customer_row_readings:[receipt.reading]}});
 expect(result.extraction.additional_components[0]).toMatchObject({amount_raw:'250.00',amount:{minor_units:25000},quantity_raw:'2',rate_raw:'100.00',normalization_warnings:['source_note']});
 expect(result.original.additional_components[0].amount_raw).toBe('200.00');expect(result.hasCorrections).toBe(true);
 const effective=structuredClone(result.extraction);effective.additional_components[0].amount={currency:'ILS',minor_units:999};
 expect(()=>identifiedDirectRowCell({original:result.original,effective,rowReadings:result.rowReadings,row:f.row,cell:'amount'})).toThrow('EFFECTIVE_MISMATCH');
});
it.each(['unknown','unreadable'])('does not retain a prior value after latest %s and needs a new receipt to resume',action=>{
 const f=fixture(),input=f.input(),sha=canonicalSha256(f.extraction);
 const first=materializeDocumentVerification(resolveDocumentReadingVerification(input),sha);
 const latest=resolveDocumentReadingVerification({...input,answerRevision:2,answer:{schema_version:'document-field-answer-v2',action}});
 expect(first?.kind).toBe('row_cell');expect(latest).toMatchObject({state:action,effective_value:null});expect(materializeDocumentVerification(latest,sha)).toBeNull();
 const next=materializeDocumentVerification(resolveDocumentReadingVerification({...input,answerRevision:3,answer:{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'300'}}),sha);
 expect(next).not.toEqual(first);expect(next?.reading.answer_revision).toBe(3);
});
it('retains legacy scalar target and materialization through the new union',()=>{
 const f=fixture(),field=f.extraction.fields.find(c=>c.field==='gross_salary')!;
 const target=documentFieldTarget({checkpoint:f.checkpoint,policyVersion:'row-test-v1',candidateId:field.candidate_id});
 const receipt=materializeDocumentVerification(resolveDocumentReadingVerification({...f.input(),target}),canonicalSha256(f.extraction));
 expect(target.schema_version).toBe('document-field-confirmation-v1');expect(receipt?.kind).toBe('scalar');expect(receipt?.reading).not.toHaveProperty('schema_version');
});
it.each(['source','version','month','policy','checkpoint','row','cell'] as const)('rejects or marks stale a mismatched %s',change=>{
 const f=fixture(),input=f.input();
 if(change==='source')f.checkpoint.input_sha256='a'.repeat(64);
 if(change==='version')f.checkpoint.version_id=randomUUID();
 if(change==='month')input.month='2025-02';
 if(change==='policy')input.policyVersion='other';
 if(change==='checkpoint')f.checkpoint.result_sha256='b'.repeat(64);
 if(change==='row'){f.row.source_label='changed source';f.rehash();}
 if(change==='cell'){const target={...input.target,cell:'quantity' as const};expect(()=>documentRowCellTargetSchema.parse(target)).toThrow();return;}
 expect(resolveDocumentReadingVerification(input)).toEqual({state:'stale'});
});
it('requires actual identity fields and same case before making any receipt',()=>{
 const f=fixture();expect(()=>resolveDocumentReadingVerification({...f.input(),caseId:randomUUID()})).toThrow('CASE_MISMATCH');
 expect(()=>resolveDocumentReadingVerification({...f.input(),identityId:'not-an-identity'})).toThrow();
});
it.each(['blank','unparsed','foreign_currency'] as const)('does not affirm an unsafe %s source cell',kind=>{
 const f=fixture();
 if(kind==='blank'){f.row.amount_raw=null;f.row.amount=null;f.rehash();expect(()=>f.target()).toThrow();return;}
 if(kind==='unparsed'){f.row.amount_raw='??';f.row.amount=null;f.rehash();expect(()=>f.materialize()).toThrow('ANSWER_INVALID');expect(f.materialize({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'200'})?.kind).toBe('row_cell');return;}
 f.row.amount={currency:'XTS',minor_units:20000};f.rehash();expect(()=>f.materialize()).toThrow('ANSWER_INVALID');
 expect(()=>f.materialize({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'200'})).toThrow('ANSWER_INVALID');
});
it.each(['case','source','machine','row','cell','duplicate','identity_reuse'] as const)('engine revalidates the admitted receipt fence: %s',change=>{
 const f=fixture(),receipt=f.materialize();if(receipt?.kind!=='row_cell')throw Error('ROW_RECEIPT_REQUIRED');const reading=structuredClone(receipt.reading),others:typeof reading[]=[];
 if(change==='case')reading.case_id=randomUUID();if(change==='source')reading.source_sha256='f'.repeat(64);if(change==='machine')reading.normalized_extraction_sha256='f'.repeat(64);
 if(change==='row')reading.original_component_sha256='f'.repeat(64);if(change==='cell')reading.component_id=randomUUID();
 if(change==='duplicate')others.push(reading);if(change==='identity_reuse')others.push({...reading,cell:'quantity' as const});
 expect(()=>materializeValidatedPayslipReadings({document:f.document,case_id:f.document.case_id,extraction:{...f.extraction,customer_row_readings:[reading,...others]}})).toThrow('ROW_READING_BINDING');
});
it('rejects provider-supplied annotation envelopes even if they are empty',()=>{
 const f=fixture();f.checkpoint.run.result.final_extraction={...f.extraction,customer_row_readings:[]};f.rehash();expect(()=>f.target()).toThrow('SAVED_PROVIDER_CONFIRMATION_FORBIDDEN');
});
it('keys two equal-looking rows by exact component and cell, never label alone',()=>{
 const f=fixture(),receipt=f.materialize();if(receipt?.kind!=='row_cell')throw Error('ROW_RECEIPT_REQUIRED');
 expect(rowCellReadingKey(f.row.component_id,'amount')).not.toBe(rowCellReadingKey(f.row.component_id,'quantity'));
 const copy={...f.row,component_id:randomUUID()};f.extraction.additional_components.push(copy);f.rehash();
 expect(()=>materializeValidatedPayslipReadings({document:f.document,case_id:f.document.case_id,extraction:{...f.extraction,customer_row_readings:[receipt.reading]}})).toThrow('ROW_READING_BINDING');
});

it('rejects an unclear row confirmation or invalid correction before journal persistence',()=>{
 const f=fixture(),answer={schema_version:'document-field-answer-v2',action:'confirm'};
 expect(validateDocumentReadingAnswerForTarget(f.target(),answer)).toEqual(answer);
 f.row.amount=null;f.row.amount_raw='unreadable';f.rehash();
 expect(()=>validateDocumentReadingAnswerForTarget(f.target(),answer)).toThrow('ANSWER_INVALID');
 expect(()=>validateDocumentReadingAnswerForTarget(f.target(),{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'garbage'})).toThrow('ANSWER_INVALID');
 const corrected={schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'250.00'};
 expect(validateDocumentReadingAnswerForTarget(f.target(),corrected)).toEqual(corrected);
 expect(resolveDocumentReadingVerification({...f.input(),answer:corrected})).toMatchObject({effective_value:{minor_units:25000}});
});
