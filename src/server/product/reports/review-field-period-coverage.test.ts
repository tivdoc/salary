import {randomUUID} from 'node:crypto';
import {beforeEach,expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {documentReviewInputSchema} from '@/engine/document-review/contracts';
import {documentReviewCalculationInputSchema} from '@/engine/document-review/calculations';
import {parseReviewCompletionInput} from '@/engine/document-review/completions';
import {runDocumentReview} from '@/engine/document-review/service';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {reviewRowCellCoverageFixture} from './review-field-coverage.fixture.ts';
import {reviewRequestsCoveredByFieldReadings,reviewHistoricalRequestProjection,type ExistingFieldReadingRequest} from './review-field-coverage.ts';
import {documentRowCellTarget,documentRowCellQuestion} from './document-row-cell-confirmation.ts';
import {documentFieldTarget,documentFieldQuestion} from './document-field-confirmation.ts';
import {documentSourceStructureTarget,documentSourceStructureTargetSchema,documentSourceStructureQuestion} from './document-source-structure.ts';
import {savedReviewRequestQuestion} from '../processing/saved-review-requests.ts';
import {listCaseRequests} from './case-requests.ts';
import type {CaseAccessDb} from '../case-access/db.ts';

const artifactPort=vi.hoisted(()=>({list:vi.fn(),artifact:vi.fn()}));
vi.mock('server-only',()=>({}));
// Protected artifact decoding/currentness belongs to the existing adapter;
// this test uses the real replay and presentation consumers after that fence.
vi.mock('./private-document-review',()=>({privateDocumentReviewReports:artifactPort.list,privateDocumentReviewArtifact:artifactPort.artifact}));
beforeEach(()=>vi.resetAllMocks());
const nowMs=Date.parse('2026-09-12T00:00:00Z'),expires_at='2099-01-01T00:00:00Z';

function fixture(kind:'row'|'scalar'|'mapped'='row',corrected?:string){
 const f=reviewRowCellCoverageFixture(),{source_scope:unused,...source}=f.candidate.source;void unused;
 const candidate={...f.candidate,source},component={...f.component,source,
  ...(kind==='mapped'?{semantic_kind:'hourly_base' as const,source_label:source.text_fragment!,quantity_raw:candidate.raw_value,quantity:candidate.raw_value}:{})};
 const extraction=normalizedPayslipExtractionSchema.parse({...f.checkpoint.run.result.final_extraction,
  fields:f.checkpoint.run.result.final_extraction.fields.map(c=>c.candidate_id===candidate.candidate_id?candidate:c),additional_components:[component]});
 const result={final_extraction:extraction,first_pass:{normalized_extraction:extraction}},checkpoint={...f.checkpoint,result_sha256:canonicalSha256(result),run:{result}};
 const policyVersion='synthetic-period-presentation-v1';
 const numericTarget=kind==='row'?documentRowCellTarget({checkpoint,policyVersion,componentId:component.component_id,cell:'quantity'})
  :documentFieldTarget({checkpoint,policyVersion,candidateId:candidate.candidate_id});
 const periodTarget=documentSourceStructureTarget({checkpoint,policyVersion,selector:{kind:'period_association',refs:kind==='scalar'?[{kind:'field',id:candidate.candidate_id}]
  :[{kind:'component',id:component.component_id},...(kind==='mapped'?[{kind:'field' as const,id:candidate.candidate_id}]:[])]}});
 const originalRaw=kind==='row'?component.quantity_raw:candidate.raw_value,effectiveRaw=corrected??originalRaw;
 const locator=kind==='scalar'?{schema_version:'document-review-source-locator-v2',field:candidate.field,candidate_ids:[candidate.candidate_id],candidate_sha256:[canonicalSha256(candidate)],raw_values:[effectiveRaw]}
  :{schema_version:'document-review-source-locator-v2',component_ids:[component.component_id],cell:'quantity',original_component_sha256:[canonicalSha256(component)],raw_values:[effectiveRaw],
   ...(kind==='mapped'?{mapped_candidate:{candidate_id:candidate.candidate_id,candidate_sha256:canonicalSha256(candidate)}}:{})};
 const old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation),reading=canonicalSha256(extraction);
 const operand={...old.operands[0],printed_value:effectiveRaw,observation_id:kind==='scalar'?candidate.candidate_id:`${component.component_id}:quantity`,
  source:{...old.operands[0].source,reading_receipt_sha256:reading,locator:JSON.stringify(locator)}};
 const completion=parseReviewCompletionInput(f.input.completion_input),fact='source.check.quantity';
 const input=documentReviewInputSchema.parse({...f.input,coverage_policy:'document-review-coverage-v1',documents:f.input.documents.map(d=>({...d,reading_sha256:reading})),
  checks:[{...f.input.checks[0],calculation:{...old,operands:[operand,{...old.operands[1],source:{...old.operands[1].source,reading_receipt_sha256:reading}}]}}],
  answer_bindings:[{fact_key:fact,check_id:'source.check',operand_id:'quantity'}],completion_input:{...completion,needs:completion.needs.map(n=>({...n,fact_key:fact}))}});
 const review=runDocumentReview(input,'synthetic-pending-period'),target=review.completions.customer_requests[0].target;
 const numeric:ExistingFieldReadingRequest={request_id:randomUUID(),target:numericTarget,code:`document_field:${numericTarget.target_sha256}`,source_current:true,
  answered_at:'2026-09-11T00:00:00Z',expires_at,answer_text:JSON.stringify({schema_version:'document-field-answer-v2',action:corrected===undefined?'confirm':'correct',...(corrected===undefined?{}:{corrected_raw_value:corrected})})};
 const period:ExistingFieldReadingRequest={request_id:randomUUID(),target:periodTarget,code:`document_field:${periodTarget.target_sha256}`,source_current:true,answered_at:null,expires_at};
 const generic={request_id:randomUUID(),target,code:`document_review:${target.target_sha256}`,source_current:true,answered_at:null,expires_at};
 return {input,review,numeric,period,generic,candidate,component,checkpoint,locator};
}
function project(f:ReturnType<typeof fixture>,fields:readonly ExistingFieldReadingRequest[]=[f.numeric,f.period]){
 return {current:reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:fields,nowMs}),
  historical:reviewHistoricalRequestProjection({review:f.review,reviewRequests:[f.generic],fieldRequests:fields,nowMs})};
}
function changedReview(f:ReturnType<typeof fixture>,change:(operand:ReturnType<typeof documentReviewCalculationInputSchema.parse>['operands'][number])=>unknown){
 const calculation=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation);
 return {...f,review:runDocumentReview({...f.input,checks:[{...f.input.checks[0],calculation:{...calculation,operands:[change(calculation.operands[0]),calculation.operands[1]]}}]},'synthetic-period-change')};
}

it.each(['row','scalar','mapped']as const)('redirects an already identified %s number to the exact pending period action without satisfying the check',kind=>{
 const f=fixture(kind),before=canonicalSha256(f.review),out=project(f);
 expect(out.current).toEqual([{target_sha256:f.generic.target.target_sha256,fact_key:f.generic.target.fact_key,field_request_id:f.period.request_id,
  structure_kind:'period_association',ref_kind:kind==='scalar'?'field':'component',ref_id:kind==='scalar'?f.candidate.candidate_id:f.component.component_id}]);
 expect(out.historical).toEqual([{request_id:f.generic.request_id,field_request_id:f.period.request_id,state:'period_required',
  structure_kind:'period_association',ref_kind:kind==='scalar'?'field':'component',ref_id:kind==='scalar'?f.candidate.candidate_id:f.component.component_id}]);
 expect(f.review.checks[0].calculation.state).toBe('blocked');expect(f.review.completions.customer_requests).toHaveLength(1);
 expect(canonicalSha256(f.review)).toBe(before);
});
it.each(['unknown','unreadable']as const)('preserves a %s period answer as an unresolved source action',action=>{
 const f=fixture(),period={...f.period,answered_at:'2026-09-11T01:00:00Z',answer_text:JSON.stringify({schema_version:'document-field-answer-v3',action})},out=project(f,[f.numeric,period]);
 expect(out.current[0]).toMatchObject({field_request_id:period.request_id,reading_state:'unresolved_answer'});
 expect(out.historical[0]).toMatchObject({state:'period_required',reading_state:'unresolved_answer'});
});
it.each(['row','scalar','mapped']as const)('binds a corrected %s number to its current raw value and original source hash',kind=>{
 const f=fixture(kind,'3.50');expect(project(f).historical).toHaveLength(1);
 expect(project(changedReview(f,o=>({...o,printed_value:'3.51'}))).historical).toEqual([]);
 expect(project(changedReview(f,o=>({...o,source:{...o.source,locator:JSON.stringify({...f.locator,raw_values:['3.51']})}}))).historical).toEqual([]);
});
it.each(['numeric_missing','numeric_unknown','numeric_unreadable','numeric_stale','numeric_retired','period_stale','period_expired','period_retired','period_positive','duplicate_period','duplicate_numeric']as const)(
 'keeps the numeric question independent when the prerequisite proof is insufficient: %s',state=>{
 const f=fixture();let numeric=f.numeric,period=f.period;
 if(state==='numeric_missing')numeric={...numeric,answered_at:null,answer_text:null};
 if(state==='numeric_unknown'||state==='numeric_unreadable')numeric={...numeric,answer_text:JSON.stringify({schema_version:'document-field-answer-v2',action:state==='numeric_unknown'?'unknown':'unreadable'})};
 if(state==='numeric_stale')numeric={...numeric,source_current:false};
 if(state==='numeric_retired')numeric={...numeric,expired_at:'2026-09-11T00:00:00Z'};
 if(state==='period_stale')period={...period,source_current:false};
 if(state==='period_expired')period={...period,expires_at:'2026-09-01T00:00:00Z'};
 if(state==='period_retired')period={...period,expired_at:'2026-09-11T00:00:00Z'};
 if(state==='period_positive')period={...period,answered_at:'2026-09-11T00:00:00Z',answer_text:JSON.stringify({schema_version:'document-field-answer-v3',action:'correct',structured_value:{kind:'period_association',period_kind:'current',period:f.input.period,basis:{page:1,locator:'Synthetic header',text:'Synthetic January 2025'}}})};
 const fields=[numeric,period,...(state==='duplicate_period'?[{...period,request_id:randomUUID()}]:[]),...(state==='duplicate_numeric'?[{...numeric,request_id:randomUUID()}]:[])],out=project(f,fields);
 expect(out.historical).toEqual([]);expect(out.current.some(r=>'structure_kind'in r)).toBe(false);
});
it.each(['result','policy','product_document','ref_sha','ref_page','known_period']as const)('rejects a validly hashed period target with a different %s binding',state=>{
 const f=fixture(),{target_sha256:unused,...body}=documentSourceStructureTargetSchema.parse(f.period.target);void unused;
 if(body.subject.kind!=='period_association')throw Error('SYNTHETIC_TARGET_KIND');
 const changed={...body,...(state==='result'?{extraction_result_sha256:'f'.repeat(64)}:{}),...(state==='policy'?{policy_version:'another-policy'}:{}),...(state==='product_document'?{product_document_id:randomUUID()}:{}),
  subject:{...body.subject,refs:body.subject.refs.map(r=>({...r,...(state==='ref_sha'?{sha256:'b'.repeat(64)}:{}),source:{...r.source,...(state==='ref_page'?{page:2}:{}),
   ...(state==='known_period'?{source_scope:{period_kind:'current' as const,fund_kind:'unknown' as const,column_label:'Synthetic current header'}}:{})}}))}};
 // Invalid enum details are not part of the binding test: use a known scope
 // shape from the source contract rather than bypassing target validation.
 const target=documentSourceStructureTargetSchema.parse({...changed,target_sha256:canonicalSha256(changed)});
 expect(project(f,[f.numeric,{...f.period,target,code:`document_field:${target.target_sha256}`}])).toEqual({current:[],historical:[]});
});
it.each(['conflict','unreadable','blank','observation','original_hash','multiple_refs','legacy_policy','foreign_period']as const)(
 'does not infer a missing-period prerequisite from %s',state=>{
 let f=fixture();
 f=changedReview(f,o=>({...o,...(state==='conflict'?{state:'conflict'}:{}),...(state==='unreadable'?{state:'unreadable'}:{}),...(state==='blank'?{printed_value:null}:{}),
  ...(state==='observation'?{observation_id:randomUUID()}:{}),source:{...o.source,
   ...(state==='original_hash'?{locator:JSON.stringify({...f.locator,original_component_sha256:['f'.repeat(64)]})}:{}),
   ...(state==='multiple_refs'?{locator:JSON.stringify({...f.locator,component_ids:[f.component.component_id,randomUUID()],original_component_sha256:[canonicalSha256(f.component),'f'.repeat(64)],raw_values:['2','2']})}:{})}}));
 if(state==='legacy_policy'){const {coverage_policy:unused,...legacy}=f.review.input;void unused;f={...f,review:runDocumentReview(legacy,'synthetic-legacy')};}
 if(state==='foreign_period')f={...f,review:runDocumentReview({...f.review.input,documents:f.review.input.documents.map(d=>({...d,period:{from:'2025-02-01',to:'2025-02-28'}}))},'synthetic-other-period')};
 expect(project(f).historical).toEqual([]);
});
it.each(['reading_hash','source_page']as const)('keeps the earlier review source guard for a foreign %s',state=>{
 const f=fixture();expect(()=>changedReview(f,o=>({...o,source:{...o.source,...(state==='reading_hash'?{reading_receipt_sha256:'a'.repeat(64)}:{page:2})}}))).toThrow();
});

it.each(['pending','unknown','stale_report']as const)('projects the existing case request as period-required, never already-read: %s',state=>{
 const f=fixture(),reportId=randomUUID(),identityId=randomUUID(),period=state==='unknown'?{...f.period,answered_at:'2026-09-11T00:00:00Z',answer_text:JSON.stringify({schema_version:'document-field-answer-v3',action:'unknown'})}:f.period;
 const common={case_id:f.review.case_id,options:null,field_crop:null,blocking:false,opened_at:'2026-09-01T00:00:00Z',expires_at,answered_at:null,answer_text:null};
 const generic={...common,id:f.generic.request_id,code:f.generic.code,question:savedReviewRequestQuestion(f.generic.target),answer_kind:'text'};
 const fields=[f.numeric,period],rows=fields.map(field=>({...common,
  ...(field.target.schema_version==='document-row-cell-confirmation-v1'?documentRowCellQuestion(field.target):field.target.schema_version==='document-field-confirmation-v1'?documentFieldQuestion(field.target):documentSourceStructureQuestion(field.target)),
  id:field.request_id,answered_at:field.answered_at,answer_text:field.answer_text??null}));
 const responses:Record<string,unknown[]>={case_request_list:[generic,...rows],case_request_revision_list:[],case_request_field_states:fields.map(field=>({request_id:field.request_id,source_current:true})),
  case_request_field_reading_targets:fields.map(field=>({request_id:field.request_id,target:field.target})),case_request_review_states:[{request_id:f.generic.request_id,source_current:true,target:f.generic.target}]};
 artifactPort.list.mockResolvedValue([{report_id:reportId,analysis_run_id:f.review.analysis_run_id,current:true,created_at:'2026-09-12T00:00:00Z'}]);
 artifactPort.artifact.mockResolvedValue({current:state!=='stale_report',bundle:{analysis_run_id:f.review.analysis_run_id,document_review:f.review}});
 const db:CaseAccessDb={provider:'fake',async rpc<T>(fn:string){if(!(fn in responses))throw Error('UNEXPECTED_RPC '+fn);return responses[fn] as T[];}};
 return listCaseRequests(f.review.case_id,db,identityId).then(result=>{
  const numeric=result.find(r=>r.id===generic.id)!;
  expect(numeric.covered_by_field_request_id).toBe(state==='stale_report'?undefined:period.request_id);
  expect(numeric.covered_by_unresolved_reading).toBe(state==='unknown'?true:undefined);
  expect(numeric).not.toHaveProperty('covered_by_confirmed_reading');expect(numeric).not.toHaveProperty('not_required_for_current_review');
  expect(numeric.answered_at).toBeNull();expect(numeric.answer_text).toBeNull();expect(numeric.question).toBe(generic.question);
  expect(numeric).not.toHaveProperty('target');expect(f.review.checks[0].calculation.state).toBe('blocked');
 });
});
