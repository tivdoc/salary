import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {runDocumentReview} from '@/engine/document-review/service';
import {documentFieldTarget} from './document-field-confirmation';
export function reviewFieldCoverageFixture(row=false){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-reading-action-coverage',mode:'real'}),d=f.stored.documents[0],e=structuredClone(f.stored.extractions[0]);
 const candidate=e.fields.find(c=>c.field===(row?'regular_hours':'gross_salary'))!;
 candidate.confidence=.94;candidate.source={...candidate.source,page:1,text_fragment:row?`שכר בסיס: ${candidate.raw_value}`:`${candidate.field}: ${candidate.raw_value}`};
 const componentId=randomUUID(),rowSource={...candidate.source,text_fragment:'שכר בסיס'};
 const result={final_extraction:e};const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:d.case_id,product_document_id:randomUUID(),version_id:d.document_id,input_sha256:d.content_sha256,expected_month:'2025-01',period_mismatch:false,result_sha256:canonicalSha256(result),run:{result}};
 const target=documentFieldTarget({checkpoint,policyVersion:'synthetic-field-coverage',candidateId:candidate.candidate_id});
 const pin={case_id:d.case_id,document_id:d.document_id,version_id:d.document_id,source_sha256:d.content_sha256},reading=canonicalSha256(e),period={from:'2025-01-01',to:'2025-01-31'};
 const value=candidate.normalized_value;
 const printed=value&&typeof value==='object'&&'amount' in value?value.amount:value&&typeof value==='object'&&'minor_units' in value?(value.minor_units/100).toFixed(2):'1';
 const operand={id:row?'quantity':'gross',observation_id:row?`${componentId}:quantity`:candidate.candidate_id,state:'unknown',printed_value:printed,
  representation:row?'decimal_quantity':'money_ils',quantity_unit:row?'hours':null,precision:'printed_precision',
  source:{document_id:d.document_id,version_id:d.document_id,file_sha256:d.content_sha256,page:1,label:'תא המקור',
   locator:row?JSON.stringify({component_ids:[componentId],candidate_id:null,raw:candidate.raw_value,original_raw:candidate.raw_value,source:rowSource,semantic_kind:'hourly_base'}):JSON.stringify({field:candidate.field,candidate_ids:[candidate.candidate_id],observations:[{candidate_id:candidate.candidate_id,raw:candidate.raw_value,original:candidate.raw_value,source:candidate.source,reading_sha256:null}]}),reading:'provider_extraction',reading_receipt_sha256:reading}};
 const input=documentReviewInputSchema.parse({schema_version:'document-review-product-v1',case_id:d.case_id,period,
  purchased_scope:{order_id:randomUUID(),receipt_sha256:'a'.repeat(64),topics:['working_time'],origin:'saved_order'},
  documents:[{case_id:d.case_id,document_id:d.document_id,version_id:d.document_id,file_sha256:d.content_sha256,page_count:1,kind:'payslip',label:'מסמך סינתטי',period,reading_origin:'provider_extraction',reading_sha256:reading}],
  checks:[{check_id:'source.check',topic:'working_time',title:'בדיקת מקור',explanation:'בדיקה סינתטית בלבד',calculation:{schema_version:'document-review-calculation-input-v1',case_id:d.case_id,run_id:'pending',check_id:'source.check',period,evaluated_at:'2025-02-01T00:00:00Z',
   source_manifest:[{document_id:d.document_id,version_id:d.document_id,file_sha256:d.content_sha256,page_count:1,kind:'case_document',case_id:d.case_id}],
   operands:[operand,{...operand,id:'comparison',state:'observed'}],operation:{kind:'quantity_comparison',left_ref:operand.id,right_ref:'comparison',interpretation:'same_measure'},remittance_status:'not_assessed'}}],
  answer_bindings:[{fact_key:'source.cell',check_id:'source.check',operand_id:operand.id}],
  completion_input:{case_id:d.case_id,period,documents:[{pin,kind:'payslip',period,review:'partial'}],evidence:[],needs:[{fact_key:'source.cell',kind:'factual',reason:'unknown',required_evidence_kind:'observed_reading',question:'מהו הנתון בתא המקור?',answer_kind:'number',source_pins:[pin],dependent_check_ids:['source.check'],general_question:false}]}});
 const review=runDocumentReview(input,randomUUID()),fieldRequest={request_id:randomUUID(),code:`document_field:${target.target_sha256}`,target,source_current:true,answered_at:null as string|null,expires_at:'2026-10-01T00:00:00Z',expired_at:null as string|null};
 return {review,fieldRequest,checkpoint,candidate,input};
}
