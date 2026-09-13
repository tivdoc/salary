import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {syntheticPayslipFixtures} from '@/engine/extraction/fixtures/source-fixtures';
import {buildPassEvaluation} from '@/engine/extraction/v2';
import {resolvePayslipExtractionPassesV21} from '@/engine/extraction/v21';
import {mapOpenAiV2Output} from '@/server/engine/extraction/providers/openai/v2-mapper';
import {openAiPayslipV2StructuredOutputSchema} from '@/server/engine/extraction/providers/openai/v2-schema';
import {createOpenAiProviderReceipt} from '@/server/engine/extraction/providers/openai/provider-receipt';
import {readSavedExtractionProvenance} from '../processing/live-extraction-provenance';
import {createDocumentHoursConflictTarget,resolveDocumentHoursConflictAnswer,documentHoursConflictQuestion} from './document-hours-conflict';
import {HOURS_CONFLICT_ANSWER_VERSION,formatHoursConflictAnswer} from './document-hours-conflict-answer';
import {validateRequestAnswer} from './request-answer';
import {resolvePayslipSnapshot,resolvedPayslipFactPaths} from '@/engine/extraction/resolver';
import {validatePayslipGate0} from '@/engine/extraction/validation';
import {deriveJune2026HoursConflictFacts} from '@/engine/minimum-wage-june2026/regular-service/hours-conflict-admission';
vi.mock('server-only',()=>({}));

const saved='docs/release-evidence/sol-canonical-20260910/conflicting-hours/provider/210b4896-structured.json';
const policy='saved-payslip-v21-p95-v1',at='2026-09-11T00:19:48Z';
/** Offline replay of real structured text into an explicitly injected test
 * receipt. No old checkpoint is changed or transferred into a live case. */
function fixture(withObservations=false){
 const retained=JSON.parse(readFileSync(saved,'utf8'));expect(canonicalSha256(retained.structured_output)).toBe(retained.structured_output_sha256);
 const output=openAiPayslipV2StructuredOutputSchema.parse(retained.structured_output);
 if(withObservations)output.generic_fields.push({field:'regular_hours',candidates:['100','120'].map((raw_value,index)=>({raw_value,confidence:'high',
  evidence:{page:1,region:'header',source_label:`Synthetic regular hours ${index}`},warnings:[]}))});
 const template=syntheticPayslipFixtures[0],version=randomUUID(),caseId=randomUUID(),orderId=randomUUID();
 const request={...template.request,case_id:caseId,document:{...template.request.document,case_id:caseId,document_id:version,storage_path:`cases/${caseId}/documents/${version}/original.pdf`}};
 const mapped=mapOpenAiV2Output({request,output,model:'offline-conflict-unit',extractorVersion:'2.1',durationMs:1,providerResponseId:'resp_synthetic_conflict',tokenUsage:null,extractedAt:at});
 const raw=mapped.extraction;
 const first=buildPassEvaluation({pass_id:raw.extraction_id,kind:'first_pass',requested_fields:[],selected_regions:[],model:'offline-conflict-unit',prompt_version:'offline-conflict-unit-v1',
  raw_extraction:raw,salary_type_assessment:mapped.salary_type_assessment,totals_section_visible:mapped.totals_section_visible,
  pension_section_visible:mapped.pension_section_visible,critical_context:mapped.critical_context,reference_year:2026});
 const result=structuredClone(resolvePayslipExtractionPassesV21({first_pass:first,recovery_passes:[],recovery_decision:{requested:false,skipped:true,fields_requested:[],regions:[],
  reason_codes:['unit_test_no_recovery'],expected_information_gain:'none'},final_extraction_id:randomUUID(),critical_context:mapped.critical_context,reference_year:2026}));
 const receipt=createOpenAiProviderReceipt({schema_version:'tivdoc-openai-provider-receipt-v1',origin:'injected_test_provider',case_id:caseId,analysis_run_id:randomUUID(),document_id:version,
  extraction_id:raw.extraction_id,source_sha256:request.document.content_sha256,source_size_bytes:1000,source_mime_type:'application/pdf',source_page_count:1,request_sha256:'a'.repeat(64),
  raw_extraction_sha256:canonicalSha256(raw),pass_kind:'first_pass',requested_model:'offline-conflict-unit',actual_model:'offline-conflict-unit',extractor_version:'2.1',prompt_version:first.prompt_version,
  provider_response_id:raw.operation.provider_response_id,provider_request_id:'req_synthetic_conflict',provider_attempted:true,status:'completed',error_code:null,http_status:200,duration_ms:1,
  token_usage:null,cost:{status:'not_returned_by_provider',amount_usd:null},created_at:at});
 const checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:caseId,product_document_id:randomUUID(),version_id:version,input_sha256:request.document.content_sha256,
  expected_month:'2026-06',period_mismatch:false,result_sha256:canonicalSha256(result),run:{result,provider_receipts:[receipt]}};
 const target=createDocumentHoursConflictTarget({checkpoint,orderId,policyVersion:policy});
 const input={target,currentCheckpoint:checkpoint,policyVersion:policy,caseId,orderId,month:'2026-06',requestId:randomUUID(),answerRevision:1,identityId:randomUUID(),answeredAt:at,
  answer:JSON.stringify({schema_version:HOURS_CONFLICT_ANSWER_VERSION,state:'declared',hours:'100',basis:'Synthetic attendance evidence distinguishes ordinary hours from other scope.'})};
 return {checkpoint,target,input,retained,document:request.document};
}
describe('source-bound conflict completion',()=>{
 it.each([false,true])('binds observed=%s source and answers without manufacturing a source reading',observed=>{
  const f=fixture(observed),before=canonicalSha256(f.checkpoint),resolved=resolveDocumentHoursConflictAnswer(f.input);
  expect(readSavedExtractionProvenance(f.checkpoint).kind).toBe('injected_test_provider');
  expect(f.target.observations).toHaveLength(observed?2:0);expect(f.target.reason).toBe(observed?'conflicting_observations':'provider_reported_conflict');
  expect(resolved).toMatchObject({state:'declared',declaration:{request_id:f.input.requestId,answer_revision:1,identity_id:f.input.identityId,
   answer:{hours:'100'},provenance:[{source_type:'declared'}]}});
  expect(resolved).not.toHaveProperty('candidate_id');expect(resolved).not.toHaveProperty('legal_approval');
  expect(canonicalSha256(f.checkpoint)).toBe(before);expect(documentHoursConflictQuestion(f.target).question).toContain('אינה מתקנת את המקור');
  const unknown=resolveDocumentHoursConflictAnswer({...f.input,answer:JSON.stringify({schema_version:HOURS_CONFLICT_ANSWER_VERSION,state:'unknown',basis:''})});
  expect(unknown.state).toBe('unknown');expect(unknown).not.toHaveProperty('declaration');
 });
 it.each([false,true])('derives from the actual canonical resolver output, observed=%s',observed=>{
  const f=fixture(observed),extraction=f.checkpoint.run.result.final_extraction;
  const parent=resolvePayslipSnapshot({document:f.document,extraction,validation:validatePayslipGate0(extraction,{reference_year:2026,critical_context:{hourly_analysis_implied:true}}),
   context:{snapshot_id:randomUUID(),case_id:f.input.caseId,analysis_run_id:randomUUID(),schema_version:'1.0.0',created_at:at,
    fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(path=>[path,randomUUID()]))}});
  const before=canonicalSha256(parent),old=parent.facts.find(f=>f.path==='work.regular_hours')!;
  expect(old.status).toBe(observed?'conflicted':'missing');expect(old.value).toBeNull();
  expect(old.provenance.length).toBe(observed?2:1);
  const resolved=resolveDocumentHoursConflictAnswer(f.input);if(resolved.state!=='declared')throw Error('TEST_DECLARATION_REQUIRED');
  const effective=deriveJune2026HoursConflictFacts(parent,resolved.declaration),hours=effective.facts.find(f=>f.path==='work.regular_hours')!;
  expect(hours).toMatchObject({value:{amount:'100',unit:'hours_per_month'},confidence:old.confidence,status:'confirmed',provenance:resolved.declaration.provenance});
  expect(effective.facts.filter(f=>f.path!=='work.regular_hours')).toEqual(parent.facts.filter(f=>f.path!=='work.regular_hours'));
  expect(canonicalSha256(parent)).toBe(before);
 });
 it.each(['case','order','version','source','checkpoint','policy','month','receipt','page'] as const)('rejects/stales %s mismatch',kind=>{
  const f=fixture(true),input={...f.input};
  if(kind==='case')input.caseId=randomUUID();if(kind==='order')input.orderId=randomUUID();
  if(kind==='version')f.checkpoint.version_id=randomUUID();if(kind==='source')f.checkpoint.input_sha256='b'.repeat(64);
  if(kind==='checkpoint')f.checkpoint.result_sha256='b'.repeat(64);if(kind==='policy')input.policyVersion='another-policy';
  if(kind==='month')input.month='2026-07';if(kind==='receipt')f.checkpoint.run.provider_receipts=[];
  if(kind==='page'){f.checkpoint.run.result.final_extraction.fields.find(r=>r.field==='regular_hours')!.source.page=2;
   f.checkpoint.result_sha256=canonicalSha256(f.checkpoint.run.result);}
  if(kind==='case'||kind==='order')expect(()=>resolveDocumentHoursConflictAnswer(input)).toThrow('CASE_ORDER_MISMATCH');
  else expect(resolveDocumentHoursConflictAnswer(input)).toEqual({state:'stale'});
 });
 it('keeps known unrelated warnings and refuses a global conflict when hours has one valid observation',()=>{
  const f=fixture(true),extraction=f.checkpoint.run.result.final_extraction;
  const hours=extraction.fields.filter(r=>r.field==='regular_hours');extraction.fields=extraction.fields.filter(r=>r.candidate_id!==hours[1].candidate_id);
  f.checkpoint.result_sha256=canonicalSha256(f.checkpoint.run.result);
  expect(()=>createDocumentHoursConflictTarget({checkpoint:f.checkpoint,orderId:f.input.orderId,policyVersion:policy})).toThrow('NOT_PRESENT');
 });
 it('validates the typed wire at the server and renders human text instead of JSON',()=>{
  const f=fixture(),question=documentHoursConflictQuestion(f.target);
  expect(validateRequestAnswer(question,f.input.answer)).toBe(f.input.answer);
  expect(formatHoursConflictAnswer(f.input.answer)).toContain('100 שעות רגילות');
  const known=JSON.parse(f.input.answer);
  for(const answer of ['100','{}',JSON.stringify({...known,basis:''}),JSON.stringify({...known,hours:'0100'}),JSON.stringify({...known,hours:'183'}),
   JSON.stringify({...known,state:'unknown'}),JSON.stringify({...known,human_approval:true})])expect(()=>validateRequestAnswer(question,answer)).toThrow('REQUEST_ANSWER_INVALID');
  expect(validateRequestAnswer(question,JSON.stringify({schema_version:HOURS_CONFLICT_ANSWER_VERSION,state:'unknown',basis:''}))).toContain('unknown');
 });
});
