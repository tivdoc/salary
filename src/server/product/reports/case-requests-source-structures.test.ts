import {beforeEach,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import type {SourceStructureSelector} from '@/engine/extraction/source-structure-resolution';
import {documentSourceStructureTarget} from './document-source-structure';
import {listCaseRequests} from './case-requests';
import type {CaseAccessDb} from '../case-access/db';
vi.mock('server-only',()=>({}));
const artifacts=vi.hoisted(()=>({list:vi.fn(),read:vi.fn()}));
vi.mock('./private-document-review',()=>({privateDocumentReviewReports:artifacts.list,privateDocumentReviewArtifact:artifacts.read}));
beforeEach(()=>{vi.resetAllMocks();artifacts.list.mockResolvedValue([]);});
const identity='22222222-2222-4222-8222-222222222222';
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
 const targets=[target(),target({kind:'deduction_group'}),target({kind:'balance_movement',balanceKind:'vacation',cell:'opening',candidateId:ids.balance}),
  target({kind:'balance_movement',balanceKind:'vacation',cell:'closing',candidateId:ids.balance})];
 const rows=targets.map(t=>({id:randomUUID(),case_id:document.case_id,code:`document_field:${t.target_sha256}`,question:'stored source question',answer_kind:'choice',options:null,field_crop:null,
  blocking:false,opened_at:'2025-01-01T00:00:00Z',expires_at:'2030-01-01T00:00:00Z',answered_at:null,answer_text:null}));
 const responses:Record<string,unknown[]>={case_request_list:rows,case_request_revision_list:[],case_request_field_states:rows.map(r=>({request_id:r.id,source_current:true})),
  case_request_field_reading_targets:targets.map((target,i)=>({request_id:rows[i].id,target}))};
 const calls:{name:string;args:unknown}[]=[];
 const db:CaseAccessDb={provider:'fake',async rpc<T>(name:string,args:unknown){calls.push({name,args});if(!(name in responses))throw Error('UNEXPECTED_RPC:'+name);return responses[name] as T[];}};
 return {caseId:document.case_id,targets,rows,responses,calls,db};
}
it('projects all three safe structure controls through listCaseRequests, preserving explicit affirmation and exact balance grouping',async()=>{
 const f=fixture(),r=await listCaseRequests(f.caseId,f.db,identity),contexts=r.map(x=>x.reading_display?.structure_context);
 expect(contexts[0]).toMatchObject({kind:'source_relationship',component_kind:'pension_employee',allows_explicit_confirmation:true,proposed_value:null,
  contribution:{raw_value:'300.00',page:1},base:{raw_value:'5000.00',page:1}});
 expect(contexts[1]).toMatchObject({kind:'deduction_group',allows_voluntary:true,proposed_value:null});
 expect(contexts[1]?.kind==='deduction_group'&&contexts[1].rows).toHaveLength(2);
 expect(contexts[2]).toMatchObject({kind:'balance_movement',cell:'opening',proposed_value:null});
 expect(contexts[3]).toMatchObject({kind:'balance_movement',cell:'closing',proposed_value:null});
 if(contexts[2]?.kind!=='balance_movement'||contexts[3]?.kind!=='balance_movement')throw Error('EXPECTED_BALANCE_DISPLAY');
 expect(contexts[2].group_id).toMatch(/^[a-f0-9]{64}$/u);expect(contexts[2].group_id).toBe(contexts[3].group_id);
 expect(r[2].reading_display?.raw_value).toBeNull();expect(r[3].reading_display?.raw_value).toBe('8.00');
 expect(r.every(x=>x.source_current===true)).toBe(true);
 const safe=JSON.stringify(r.map(x=>x.reading_display));
 for(const forbidden of ['confidence','target_sha256','normalized_extraction_sha256','first_pass_extraction_sha256','extraction_result_sha256','subject','original_component','candidate_id',f.targets[0].source_sha256])expect(safe).not.toContain(forbidden);
 expect(artifacts.list).toHaveBeenCalledExactlyOnceWith(f.caseId,identity,f.db);expect(artifacts.read).not.toHaveBeenCalled();
 for(const call of f.calls.filter(x=>x.name.startsWith('case_request_field_')))expect(call.args).toEqual({target_case:f.caseId,target_identity:identity});
});
it('does not disclose source structures without identified target access',async()=>{
 const f=fixture(),r=await listCaseRequests(f.caseId,f.db);
 expect(r.every(x=>x.reading_display===undefined)).toBe(true);expect(f.calls.map(x=>x.name)).toEqual(['case_request_list','case_request_revision_list']);
 expect(artifacts.list).not.toHaveBeenCalled();
});
it('keeps stale source flags and does not use a current report projection to rehabilitate them',async()=>{
 const f=fixture();f.responses.case_request_field_states=f.rows.map(r=>({request_id:r.id,source_current:false}));
 const r=await listCaseRequests(f.caseId,f.db,identity);expect(r.every(x=>x.source_current===false)).toBe(true);
 expect(r.every(x=>x.not_required_for_current_review===undefined)).toBe(true);expect(artifacts.list).not.toHaveBeenCalled();
});
it.each(['foreign_case','wrong_code','duplicate_target','missing_current_state'] as const)('fails closed for %s projection evidence',async defect=>{
 const f=fixture();
 if(defect==='wrong_code')f.rows[0].code='document_field:'+'e'.repeat(64);
 if(defect==='duplicate_target')f.responses.case_request_field_reading_targets.push(f.responses.case_request_field_reading_targets[0]);
 if(defect==='missing_current_state')f.responses.case_request_field_states.pop();
 await expect(listCaseRequests(defect==='foreign_case'?randomUUID():f.caseId,f.db,identity)).rejects.toThrow('REQUEST_FIELD_STATE_UNAVAILABLE');
});
