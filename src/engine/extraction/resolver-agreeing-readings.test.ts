import {randomUUID} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {buildSyntheticCaseFixture} from '../case-analysis/synthetic-fixtures.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {resolvePayslipSnapshot,resolvedPayslipFactPaths,IDENTIFIED_AGREEING_CANDIDATES_POLICY} from './resolver.ts';
import {validatePayslipGate0} from './validation.ts';
import {documentFieldTarget,DOCUMENT_FIELD_CONFIRMATION_ANSWERS} from '../../server/product/reports/document-field-confirmation.ts';
import {savedDocumentFieldReadings} from '../../server/product/processing/saved-field-readings.ts';

function fixture(field:'regular_hours'|'salary_period'='regular_hours'){
 const f=buildSyntheticCaseFixture({fixture_id:'synthetic-agreeing-identified-observations',mode:'real'}),document=f.stored.documents[0];
 const extraction=structuredClone(f.stored.extractions[0]),candidate=extraction.fields.find(c=>c.field===field)!;
 candidate.confidence=0.94;
 const repeated={...structuredClone(candidate),candidate_id:randomUUID(),source:{...candidate.source,text_fragment:'Synthetic second located observation of the same field'}};
 extraction.fields.push(repeated);
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:document.case_id,product_document_id:randomUUID(),version_id:document.document_id,
  input_sha256:document.content_sha256,expected_month:'2025-01',period_mismatch:false,result_sha256:canonicalSha256({final_extraction:extraction}),run:{result:{final_extraction:extraction}}};
 const readings=()=>{
  const answers=[candidate,repeated].map(c=>{const target=documentFieldTarget({checkpoint,policyVersion:'synthetic-agreeing-v1',candidateId:c.candidate_id});return {
   id:randomUUID(),case_id:document.case_id,scope_month:'2025-01',code:`document_field:${target.target_sha256}`,answer_kind:'choice',
   answer:DOCUMENT_FIELD_CONFIRMATION_ANSWERS[0],answer_revision:1,answer_identity_id:randomUUID(),answer_created_at:'2025-02-02T00:00:00Z',field_target:target};});
  return savedDocumentFieldReadings({caseId:document.case_id,month:'2025-01',policyVersion:'synthetic-agreeing-v1',journal:{answers},checkpoint});
 };
 const context={snapshot_id:randomUUID(),case_id:document.case_id,analysis_run_id:randomUUID(),schema_version:'1.0.0',created_at:'2025-02-02T00:00:00Z',
  fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(p=>[p,randomUUID()]))};
 const resolve=(r=readings(),policy:typeof IDENTIFIED_AGREEING_CANDIDATES_POLICY|undefined=IDENTIFIED_AGREEING_CANDIDATES_POLICY,validation=validatePayslipGate0(extraction,{reference_year:2025}))=>
  resolvePayslipSnapshot({document,extraction:{...extraction,customer_readings:[...r]},validation,context,...(policy?{reading_policy:policy}:{})});
 const path=field==='regular_hours'?'work.regular_hours':'documents.period';
 const repin=()=>{checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);};
 return {candidate,repeated,document,extraction,checkpoint,readings,context,resolve,path,repin};
}
describe('identified-agreeing-candidates-v1 opt-in resolution',()=>{
 it.each(['regular_hours','salary_period'] as const)('retains the duplicate gate in legacy %s and confirms only the separately identified agreeing observations',field=>{
  const f=fixture(field),r=f.readings(),before=canonicalSha256(f.checkpoint),validation=validatePayslipGate0(f.extraction,{reference_year:2025});
  expect(validation.field_assessments.filter(a=>[f.candidate.candidate_id,f.repeated.candidate_id].includes(a.candidate_id)).every(a=>a.issue_codes.includes('duplicate_candidate'))).toBe(true);
  const old=resolvePayslipSnapshot({document:f.document,extraction:{...f.extraction,customer_readings:[...r]},validation,context:f.context});
  expect(old.facts.find(fact=>fact.path===f.path)?.status).not.toBe('confirmed');
  const resolved=f.resolve(r),fact=resolved.facts.find(fact=>fact.path===f.path)!;
  expect(fact.status).toBe('confirmed');expect(fact.provenance).toHaveLength(2);
  expect(fact.provenance.map(p=>p.source_type==='documented'?p.customer_confirmation?.candidate_id:null).sort()).toEqual([f.candidate.candidate_id,f.repeated.candidate_id].sort());
  expect(fact.provenance.every(p=>p.source_type==='documented'&&p.verified===true)).toBe(true);
  expect(canonicalSha256(f.checkpoint)).toBe(before);expect(f.candidate.confidence).toBe(0.94);expect(f.repeated.confidence).toBe(0.94);
  expect(f.resolve(r.slice(0,1)).facts.find(fact=>fact.path===f.path)?.status).not.toBe('confirmed');
  expect(f.resolve([]).facts.find(fact=>fact.path===f.path)?.status).not.toBe('confirmed');
 });
 it.each(['request','target','candidate','source'] as const)('refuses non-bijective or edited %s evidence',defect=>{
  const f=fixture(),r=f.readings().map(x=>({...x}));
  if(defect==='request')r[1].request_id=r[0].request_id;if(defect==='target')r[1].target_sha256=r[0].target_sha256;
  if(defect==='candidate')r[1].candidate_sha256='e'.repeat(64);if(defect==='source')r[1].source_sha256='e'.repeat(64);
  expect(()=>f.resolve(r)).toThrow('DOCUMENT_READING_BINDING_MISMATCH');
 });
 it('retains a genuine conflicting-hours block despite both identified readings',()=>{
  const f=fixture();if(f.repeated.field!=='regular_hours'||!f.repeated.normalized_value)throw Error('TEST_HOURS');
  f.repeated.normalized_value={...f.repeated.normalized_value,amount:'101'};f.repin();
  const fact=f.resolve().facts.find(fact=>fact.path===f.path)!;
  expect(fact.status).toBe('conflicted');expect(fact.value).toBeNull();expect(fact.provenance).toHaveLength(2);
 });
 it('does not lose an unnormalizable third observation through selectFields filtering',()=>{
  const f=fixture();f.extraction.fields.push({...f.repeated,candidate_id:randomUUID(),normalized_value:null});f.repin();
  expect(f.resolve().facts.find(fact=>fact.path===f.path)?.status).not.toBe('confirmed');
 });
 it.each(['hourly_salary_mismatch','ocr_scale_mismatch','gross_component_mismatch','conflicting_candidates'] as const)('does not discharge %s with agreeing readings',code=>{
  const f=fixture(),v=validatePayslipGate0(f.extraction,{reference_year:2025});
  for(const a of v.field_assessments.filter(a=>[f.candidate.candidate_id,f.repeated.candidate_id].includes(a.candidate_id)))a.issue_codes.push(code);
  expect(f.resolve(f.readings(),IDENTIFIED_AGREEING_CANDIDATES_POLICY,v).facts.find(fact=>fact.path===f.path)?.status).not.toBe('confirmed');
 });
});
