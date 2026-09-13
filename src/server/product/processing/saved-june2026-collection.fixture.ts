import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {normalizedAdditionalComponentSchema,normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
/** Metadata/checkpoint fixture solely for new collection authorization tests.
 * It is not provider output, an uploaded-file proof or a financial oracle. */
export function savedJuneCollectionFixture(){
 const fixture=buildSyntheticCaseFixture({fixture_id:'june-collection-'+randomUUID(),mode:'real'}),doc=fixture.stored.documents[0];
 const extraction=normalizedPayslipExtractionSchema.parse(structuredClone(fixture.stored.extractions[0]));
 for(const candidate of extraction.fields)if(candidate.field==='salary_period')candidate.normalized_value={year:2026,month:6,start_date:'2026-06-01',end_date:'2026-06-30'};
 extraction.additional_components=[normalizedAdditionalComponentSchema.parse({component_id:randomUUID(),source_label:'שכר רגיל',normalized_label:null,semantic_kind:'base_salary',
  quantity_raw:'100',rate_raw:'33',percentage_raw:null,amount_raw:'3300',confidence:1e-7,
  source:{document_id:doc.document_id,page:1,text_fragment:'Synthetic database collection fixture'},extraction_method:'fixture',warning_flags:[],
  quantity:'100',rate:{currency:'ILS',minor_units:3300},percentage:null,amount:{currency:'ILS',minor_units:330000},normalization_warnings:[]})];
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:doc.case_id,product_document_id:randomUUID(),version_id:doc.document_id,input_sha256:doc.content_sha256,
  expected_month:'2026-06',period_mismatch:false,requires_confirmation:false,result_sha256:'',run:{result:{final_extraction:extraction}}};
 const rehash=()=>checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);rehash();
 return {doc,extraction,checkpoint,rehash};
}
