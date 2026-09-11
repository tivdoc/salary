import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedAdditionalComponentSchema} from '@/engine/extraction/payslip';
import {documentRowCellTarget} from '../reports/document-row-cell-confirmation';
import {savedDocumentReadings,savedDocumentFieldReadings} from './saved-field-readings';

function setup(){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-saved-row-journal',mode:'real'}),document=f.stored.documents[0],extraction=structuredClone(f.stored.extractions[0]);
 const scalar=extraction.fields.find(c=>c.field==='gross_salary')!;
 const row=normalizedAdditionalComponentSchema.parse({component_id:randomUUID(),source_label:'בונוס סינתטי',normalized_label:'bonus',semantic_kind:'bonus',
  quantity_raw:'2',rate_raw:'100',amount_raw:'200',percentage_raw:null,quantity:'2',rate:{currency:'ILS',minor_units:10000},amount:{currency:'ILS',minor_units:20000},percentage:null,
  confidence:.94,source:scalar.source,extraction_method:scalar.extraction_method,warning_flags:[],normalization_warnings:[]});
 Object.assign(extraction,{additional_components:[row,{...row,component_id:randomUUID()}]});
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:randomUUID(),version_id:document.document_id,input_sha256:document.content_sha256,
  expected_month:'2025-01',period_mismatch:false,result_sha256:'',run:{result:{final_extraction:extraction}}};checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);
 const target=documentRowCellTarget({checkpoint,policyVersion:'test-row',componentId:row.component_id,cell:'amount'});
 const answer={id:randomUUID(),case_id:document.case_id,scope_month:'2025-01',code:`document_field:${target.target_sha256}`,answer_kind:'choice',
  answer:JSON.stringify({schema_version:'document-field-answer-v2',action:'confirm'}),answer_revision:1,answer_identity_id:randomUUID(),answer_created_at:'2025-02-01T00:00:00Z',field_target:target};
 const input={caseId:document.case_id,month:'2025-01',policyVersion:'test-row',journal:{answers:[answer]},checkpoint};
 return {input,answer,extraction,row};
}
it('loads the exact same-labelled row from the identified journal without scalar promotion',()=>{
 const s=setup(),before=canonicalSha256(s.input.checkpoint),read=savedDocumentReadings(s.input);
 expect(read.scalar).toEqual([]);expect(read.source_scope).toEqual([]);expect(read.row_cell).toHaveLength(1);
 expect(read.row_cell[0]).toMatchObject({component_id:s.row.component_id,cell:'amount',request_id:s.answer.id,identity_id:s.answer.answer_identity_id});
 expect(savedDocumentFieldReadings(s.input)).toEqual([]);expect(canonicalSha256(s.input.checkpoint)).toBe(before);
});
it('changes one reading revision, revokes it on unknown/unreadable, and retains original observations',()=>{
 const s=setup(),original=canonicalSha256(s.extraction);
 s.answer.answer=JSON.stringify({schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:'210'});s.answer.answer_revision=2;
 const second=savedDocumentReadings(s.input).row_cell[0];expect(second.correction?.normalized_value).toEqual({currency:'ILS',minor_units:21000});
 for(const action of ['unknown','unreadable']){s.answer.answer_revision++;s.answer.answer=JSON.stringify({schema_version:'document-field-answer-v2',action});expect(savedDocumentReadings(s.input).row_cell).toEqual([]);}
 expect(second.answer_revision).toBe(2);expect(canonicalSha256(s.extraction)).toBe(original);
});
it('rejects foreign answers and duplicate row-cell decisions, and ignores stale source versions',()=>{
 const foreign=setup();foreign.answer.case_id=randomUUID();expect(()=>savedDocumentReadings(foreign.input)).toThrow('REQUEST_FIELD_CASE_MISMATCH');
 const duplicate=setup();duplicate.input.journal.answers.push({...duplicate.answer,id:randomUUID()});expect(()=>savedDocumentReadings(duplicate.input)).toThrow('REQUEST_FIELD_READING_AMBIGUOUS');
 const stale=setup();stale.input.checkpoint.version_id=randomUUID();expect(savedDocumentReadings(stale.input).row_cell).toEqual([]);
});
it.each(['customer_row_readings','customer_scope_readings'])('refuses even an empty %s injected in provider bytes',key=>{
 const s=setup();Object.assign(s.extraction,{[key]:[]});expect(()=>savedDocumentReadings(s.input)).toThrow('SAVED_PROVIDER_CONFIRMATION_FORBIDDEN');
});
