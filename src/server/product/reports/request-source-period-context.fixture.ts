import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {IDENTIFIED_PERIOD_STRUCTURE_POLICY} from '@/engine/extraction/source-structure-period';
import {savedSourcePeriodReadings} from '../processing/saved-field-readings';
import {documentSourceStructureTarget} from './document-source-structure';

/** Public synthetic source and actual typed journal receipts; no provider or DB. */
export function requestSourcePeriodFixture(){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-route-period-context',mode:'real'}),document=f.stored.documents[0],base=randomUUID(),amount=randomUUID();
 const template=f.stored.extractions[0].fields[0],source={document_id:document.document_id,page:1,text_fragment:'Synthetic January pension table'};
 const e=normalizedPayslipExtractionSchema.parse({...f.stored.extractions[0],additional_components:[],source_scope_observations:[],fields:[
  ...f.stored.extractions[0].fields.filter(x=>x.field==='salary_period'),
  {...template,candidate_id:base,field:'pension_base',source,raw_value:'2000',normalized_value:{currency:'ILS',minor_units:200000}},
  {...template,candidate_id:amount,field:'pension_employee_contribution',source,raw_value:'100',normalized_value:{currency:'ILS',minor_units:10000}}]});
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:randomUUID(),version_id:document.document_id,input_sha256:document.content_sha256,
  expected_month:'2025-01',period_mismatch:false,result_sha256:'',run:{result:{final_extraction:e,first_pass:{normalized_extraction:e}}}};
 checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);
 const policyVersion='synthetic-period-route',identityId=randomUUID(),requestId=randomUUID(),basis={page:1,locator:'Synthetic January heading',text:'Synthetic current column covers this amount and base'};
 const periodTarget=documentSourceStructureTarget({checkpoint,policyVersion,selector:{kind:'period_association',refs:[{kind:'field',id:base},{kind:'field',id:amount}]}});
 const periodAnswer={schema_version:'document-field-answer-v3',action:'correct',structured_value:{kind:'period_association',period_kind:'current',period:{from:'2025-01-01',to:'2025-01-31'},basis}};
 const periodEntry={id:randomUUID(),case_id:document.case_id,scope_month:'2025-01',code:`document_field:${periodTarget.target_sha256}`,answer_kind:'choice',answer:JSON.stringify(periodAnswer),
  answer_revision:1,answer_identity_id:identityId,answer_created_at:'2025-02-02T00:00:00Z',field_target:periodTarget};
 const source_journal={answers:[periodEntry]},periodReadings=savedSourcePeriodReadings({caseId:document.case_id,month:'2025-01',policyVersion,journal:source_journal,checkpoint});
 const target=documentSourceStructureTarget({checkpoint,policyVersion,selector:{kind:'source_relationship',componentKind:'pension_employee',contribution:{kind:'field',id:amount},base:{kind:'field',id:base}},
  periodPolicy:IDENTIFIED_PERIOD_STRUCTURE_POLICY,periodReadings});
 const answer=JSON.stringify({schema_version:'document-field-answer-v3',action:'confirm',structured_value:{kind:'source_relationship',relationship:'same_base',component_kind:'pension_employee',fund_kind:'pension',
  fund_label:'Synthetic fund',source_kind:'labelled_section',basis}});
 const context={case_id:document.case_id,request_id:requestId,source_revision:33,source_input_sha256:'d'.repeat(64),source_journal_sha256:canonicalSha256(source_journal),source_journal,checkpoint};
 return {caseId:document.case_id,identityId,requestId,target,answer,context,periodTarget,periodAnswer,periodEntry};
}
