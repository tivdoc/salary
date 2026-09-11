import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {runDocumentReview} from '@/engine/document-review/service';
import {documentFieldTarget} from './document-field-confirmation';
import {documentRowCellTarget} from './document-row-cell-confirmation';
import {normalizedAdditionalComponentSchema,normalizedCandidateFieldSchema} from '@/engine/extraction/payslip';
import {documentReviewCalculationInputSchema} from '@/engine/document-review/calculations';
import {documentSourceScopeTarget} from './document-source-scope-confirmation';
import {sourceScopeObservationSchema} from '@/engine/extraction/contracts';
import {documentSourceTranscriptionTarget} from './document-source-transcription';
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

export function reviewRowCellCoverageFixture(){
 const f=reviewFieldCoverageFixture(true),source={...f.candidate.source,text_fragment:'רכיב סינתטי'},component=normalizedAdditionalComponentSchema.parse({
  component_id:randomUUID(),source_label:'רכיב סינתטי',normalized_label:'synthetic_bonus',semantic_kind:'bonus',
  quantity_raw:'2',rate_raw:'100.00',amount_raw:'200.00',percentage_raw:null,quantity:'2',rate:{currency:'ILS',minor_units:10000},amount:{currency:'ILS',minor_units:20000},percentage:null,
  confidence:.94,source,extraction_method:f.candidate.extraction_method,warning_flags:[],normalization_warnings:[]});
 const result={...f.checkpoint.run.result,final_extraction:{...f.checkpoint.run.result.final_extraction,additional_components:[component]}},
  checkpoint={...f.checkpoint,result_sha256:canonicalSha256(result),run:{result}};
 const target=documentRowCellTarget({checkpoint,policyVersion:'synthetic-row-coverage-v1',componentId:component.component_id,cell:'quantity'});
 const old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation),operand={...old.operands[0],observation_id:`${component.component_id}:quantity`,printed_value:'2',
  source:{...old.operands[0].source,locator:JSON.stringify({component_ids:[component.component_id],candidate_id:null,raw:'2',original_raw:'2',source,semantic_kind:component.semantic_kind})}};
 const input=documentReviewInputSchema.parse({...f.input,checks:[{...f.input.checks[0],title:'כמות בשורת המקור',calculation:{...old,operands:[operand,old.operands[1]]}}]});
 return {...f,input,review:runDocumentReview(input,randomUUID()),checkpoint,component,
  fieldRequest:{...f.fieldRequest,target,code:`document_field:${target.target_sha256}`}};
}

export function reviewSourceScopeCoverageFixture(){
 const f=reviewFieldCoverageFixture(),{normalized_value:ignored,...candidate}=f.candidate;void ignored;
 const observation=sourceScopeObservationSchema.parse({policy_version:'payslip-explicit-source-scope-v1',scope:'final_payable',source_label:'לתשלום סינתטי',
  candidate:{...candidate,candidate_id:randomUUID()}});
 const result={...f.checkpoint.run.result,final_extraction:{...f.checkpoint.run.result.final_extraction,source_scope_observations:[observation]}},
  checkpoint={...f.checkpoint,result_sha256:canonicalSha256(result),run:{result}};
 const target=documentSourceScopeTarget({checkpoint,policyVersion:'synthetic-scope-coverage-v1',candidateId:observation.candidate.candidate_id});
 const old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation),operand={...old.operands[0],observation_id:observation.candidate.candidate_id,
  source:{...old.operands[0].source,locator:JSON.stringify({schema_version:'document-review-source-locator-v2',scope:observation.scope,
   candidate_ids:[observation.candidate.candidate_id],scope_observation_sha256:[canonicalSha256(observation)],raw_values:[observation.candidate.raw_value]})}};
 const input=documentReviewInputSchema.parse({...f.input,checks:[{...f.input.checks[0],title:'התאמת הסכום הסופי לתשלום',calculation:{...old,operands:[operand,old.operands[1]]}}]});
 return {...f,input,review:runDocumentReview(input,randomUUID()),checkpoint,observation,
  fieldRequest:{...f.fieldRequest,target,code:`document_field:${target.target_sha256}`}};
}

export function reviewSourceTranscriptionFixture(kind:'reported_work_hours'|'balance_unit'='reported_work_hours'){
 const f=reviewFieldCoverageFixture(),original=f.checkpoint.run.result.final_extraction;
 const candidate=normalizedCandidateFieldSchema.parse({...f.candidate,candidate_id:randomUUID(),field:'vacation_balance',raw_value:'7.25',normalized_value:null});
 const extraction={...original,fields:original.fields.filter(c=>c.field!=='vacation_balance')};
 const first={...extraction,fields:[...extraction.fields,candidate]};
 const result={final_extraction:extraction,first_pass:{normalized_extraction:first}};
 const checkpoint={...f.checkpoint,result_sha256:canonicalSha256(result),run:{result}};
 const target=documentSourceTranscriptionTarget({checkpoint,policyVersion:'synthetic-transcription-ui-v1',
  subject:kind==='reported_work_hours'?{kind,page:1}:{kind,candidateId:candidate.candidate_id}});
 return {...f,checkpoint,retainedCandidate:candidate,fieldRequest:{...f.fieldRequest,target,code:`document_field:${target.target_sha256}`}};
}

export function reviewUnusedFieldFixture(){
 const f=reviewFieldCoverageFixture(),candidate=f.checkpoint.run.result.final_extraction.fields.find(c=>c.field==='salary_type')!;
 const target=documentFieldTarget({checkpoint:f.checkpoint,policyVersion:'synthetic-unused-ui-v1',candidateId:candidate.candidate_id});
 const old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation);
 const locator=JSON.stringify({schema_version:'document-review-source-locator-v2',field:f.candidate.field,
  candidate_ids:[f.candidate.candidate_id],candidate_sha256:[canonicalSha256(f.candidate)],raw_values:[f.candidate.raw_value]});
 const input=documentReviewInputSchema.parse({...f.input,coverage_policy:'document-review-coverage-v1',
  checks:[{...f.input.checks[0],calculation:{...old,operands:old.operands.map(o=>({...o,source:{...o.source,locator}}))}}]});
 return {...f,input,review:runDocumentReview(input,randomUUID()),fieldRequest:{...f.fieldRequest,target,code:`document_field:${target.target_sha256}`}};
}
