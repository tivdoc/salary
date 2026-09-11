import {expect,it,vi} from 'vitest';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {runDocumentReview,applyDocumentReviewAnswer} from '@/engine/document-review/service';
import {reviewRequestsCoveredByFieldReadings,reviewFieldReadingCheckLabels,reviewFieldRequestsNotRequired,reviewHistoricalRequestProjection} from './review-field-coverage';
import {documentFieldTarget} from './document-field-confirmation';
import {reviewFieldCoverageFixture,reviewRowCellCoverageFixture,reviewSourceScopeCoverageFixture,reviewSourceTranscriptionFixture,reviewUnusedFieldFixture,reviewStructurallyBlockedPensionFixture} from './review-field-coverage.fixture';
import {documentRowCellTarget} from './document-row-cell-confirmation';
import {documentReviewCalculationInputSchema} from '@/engine/document-review/calculations';
import {parseReviewCompletionInput} from '@/engine/document-review/completions';
vi.mock('server-only',()=>({}));
const nowMs=Date.parse('2026-09-11T00:00:00Z');
it.each(['unknown','unreadable']as const)('links the duplicate numeric request to a saved %s reading without claiming confirmation',action=>{
 const f=reviewRowCellCoverageFixture(),field={...f.fieldRequest,answered_at:'2026-09-10T00:00:00Z',answer_text:JSON.stringify({schema_version:'document-field-answer-v2',action})};
 const before=canonicalSha256(f.review),result=reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[field],nowMs});
 expect(result).toHaveLength(1);expect(result[0]).toMatchObject({field_request_id:field.request_id,reading_state:'unresolved_answer'});
 expect(f.review.checks[0].calculation.state).toBe('blocked');expect(canonicalSha256(f.review)).toBe(before);
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[{...field,source_current:false}],nowMs})).toEqual([]);
});
function blankRowFixture(){
 const f=reviewRowCellCoverageFixture(),component={...f.component,quantity_raw:null,quantity:null,amount_raw:null,amount:null};
 const result={final_extraction:{...f.checkpoint.run.result.final_extraction,additional_components:[component]}},checkpoint={...f.checkpoint,result_sha256:canonicalSha256(result),run:{result}};
 const target=documentRowCellTarget({checkpoint,policyVersion:f.fieldRequest.target.policy_version,componentId:component.component_id,cell:'rate'});
 const old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation),checkId='document.0.row.'+'a'.repeat(20),completion=parseReviewCompletionInput(f.input.completion_input),pin=completion.documents[0].pin;
 const operands=(['quantity','rate','amount']as const).map(cell=>({...old.operands[0],id:cell,observation_id:`${component.component_id}:${cell}`,
  state:cell==='rate'?'unknown':'missing',printed_value:component[`${cell}_raw`],representation:cell==='quantity'?'decimal_quantity':'money_ils',quantity_unit:cell==='quantity'?'count':null,
  source:{...old.operands[0].source,locator:JSON.stringify({schema_version:'document-review-source-locator-v2',component_ids:[component.component_id],cell,
   original_component_sha256:[canonicalSha256(component)],raw_values:[component[`${cell}_raw`]]})}}));
 const input={...f.input,coverage_policy:'document-review-coverage-v1',answer_bindings:[],
  checks:[{...f.input.checks[0],check_id:checkId,calculation:{...old,check_id:checkId,operands,operation:{kind:'product',money_ref:'rate',factor_refs:['quantity'],recorded_ref:'amount',rounding:'half_up',rounding_basis:'Synthetic calculation only'}}}],
  coverage_gaps:[{check_id:checkId+'.blank_basis',topic:'working_time',kind:'missing_fact',detail:'תאי הכמות והסכום ריקים',next_step:'נדרש מקור נוסף לשורה',source_pins:[pin]}],
  completion_input:{...completion,needs:[{fact_key:checkId+'.missing_basis',kind:'factual',reason:'missing',required_evidence_kind:'observed_reading',question:'האם קיים מקור נוסף לשורה?',answer_kind:'text',source_pins:[pin],dependent_check_ids:[checkId,checkId+'.blank_basis'],general_question:false}]}};
 return {...f,input,component,checkId,checkpoint,review:runDocumentReview(input,'blank-source-row'),fieldRequest:{...f.fieldRequest,target,code:`document_field:${target.target_sha256}`}};
}
it.each(['blank','missing_gap','changed_hash','effective_values','active_price_need']as const)('defers a historical row price only with a proven blank basis: %s',state=>{
 const f=blankRowFixture(),input=structuredClone(f.input),calculation=documentReviewCalculationInputSchema.parse(input.checks[0].calculation);
 if(state==='missing_gap'){input.coverage_gaps=[];input.completion_input.needs[0].dependent_check_ids=[f.checkId];}
 if(state==='changed_hash')input.checks[0].calculation.operands.forEach(o=>{const locator=JSON.parse(o.source.locator);o.source.locator=JSON.stringify({...locator,original_component_sha256:['f'.repeat(64)]});});
 if(state==='effective_values')input.checks[0].calculation.operands.forEach(o=>{if(o.id!=='rate'){o.state='observed';o.printed_value=o.id==='quantity'?'2':'200.00';}});
 if(state==='active_price_need'){
  const completion=parseReviewCompletionInput(input.completion_input);
  input.completion_input={...input.completion_input,needs:[...input.completion_input.needs,{...input.completion_input.needs[0],fact_key:f.checkId+'.rate',answer_kind:'number',dependent_check_ids:[f.checkId]}]};
  expect(completion.needs).toHaveLength(1);
 }
 expect(calculation.operation.kind).toBe('product');
 const review=runDocumentReview(input,'blank-source-change');
 expect(reviewFieldRequestsNotRequired({review,fieldRequests:[f.fieldRequest],nowMs})).toHaveLength(state==='blank'?1:0);
 expect(review.checks[0].calculation.state).toBe('blocked');
});
it.each(['current','no_replacement','stale_replacement','other_target','other_row']as const)('maps old blank quantity/amount questions to one current source question: %s',state=>{
 const f=blankRowFixture(),completion=parseReviewCompletionInput(f.input.completion_input),newRequest=f.review.completions.customer_requests[0];
 const prior=runDocumentReview({...f.input,answer_bindings:[{fact_key:f.checkId+'.quantity',check_id:f.checkId,operand_id:'quantity'},{fact_key:f.checkId+'.amount',check_id:f.checkId,operand_id:'amount'}],
  completion_input:{...completion,needs:['quantity','amount'].map(cell=>({...completion.needs[0],fact_key:f.checkId+'.'+cell,answer_kind:'number',dependent_check_ids:[f.checkId]}))}},'old-blank-cell-questions');
 const row=(target:typeof newRequest.target,id:string)=>({request_id:id,code:`document_review:${target.target_sha256}`,target,source_current:true,answered_at:null,expires_at:'2099-01-01T00:00:00Z'});
 const oldRows=prior.completions.customer_requests.map((r,i)=>row(r.target,`old-${i}`)),replacement=row(newRequest.target,'new-basis');
 if(state==='stale_replacement')replacement.source_current=false;
 const field=state==='other_row'?{...f.fieldRequest,source_current:false}:f.fieldRequest;
 const result=reviewHistoricalRequestProjection({review:f.review,fieldRequests:[field],reviewRequests:[...oldRows,...(state==='no_replacement'?[]:[state==='other_target'?{...replacement,target:oldRows[0].target,code:oldRows[0].code}:replacement])],nowMs});
 expect(result).toHaveLength(state==='current'?2:0);
 for(const match of result)expect(match).toMatchObject({state:'not_required',replacement_request_id:'new-basis'});
 expect(f.review.checks[0].calculation.state).toBe('blocked');expect(f.review.completions.customer_requests).toHaveLength(1);
});
it.each(['verified','no_flag','no_evidence','unknown_evidence','conflicting_period']as const)('uses the separately verified financial-source period only with exact evidence: %s',state=>{
 const f=reviewStructurallyBlockedPensionFixture(),input=structuredClone(f.input),completion=parseReviewCompletionInput(input.completion_input),pin=completion.documents[0].pin;
 input.documents[0].period=state==='conflicting_period'?{from:'2025-02-01',to:'2025-02-28'}:null;
 input.completion_input={...completion,documents:completion.documents.map(d=>({...d,...(state==='no_flag'?{}:{review_completed_fact_keys:['payslip.financial_source']})})),
  evidence:state==='no_evidence'?[]:[{evidence_id:'synthetic-financial-source',case_id:input.case_id,fact_key:'payslip.financial_source',period:input.period,
   state:state==='unknown_evidence'?'unknown':'observed',origin:'document',value:state==='unknown_evidence'?null:'Synthetic separately verified four-cell source receipt',source_pins:[pin],source_reviewed:true}]};
 expect(reviewFieldRequestsNotRequired({review:runDocumentReview(input,'nullable-upload-period'),fieldRequests:[f.fieldRequest],nowMs})).toHaveLength(state==='verified'?1:0);
});
it.each(['same','changed_observation']as const)('links amount.2 to the same row amount independently of the calculation-local name: %s',kind=>{
 const f=reviewRowCellCoverageFixture(),old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation);
 const target=documentRowCellTarget({checkpoint:f.checkpoint,policyVersion:f.fieldRequest.target.policy_version,componentId:f.component.component_id,cell:'amount'});
 const locator={schema_version:'document-review-source-locator-v2',component_ids:[f.component.component_id],cell:'amount',original_component_sha256:[canonicalSha256(f.component)],raw_values:[f.component.amount_raw]};
 const operand={...old.operands[0],id:'amount.2',observation_id:`${f.component.component_id}:${kind==='same'?'amount':'quantity'}`,source:{...old.operands[0].source,locator:JSON.stringify(locator)}};
 const review=runDocumentReview({...f.input,answer_bindings:[{fact_key:'source.cell',check_id:'source.check',operand_id:'amount.2'}],
  checks:[{...f.input.checks[0],calculation:{...old,operands:[operand,old.operands[1]],operation:{kind:'quantity_comparison',left_ref:'amount.2',right_ref:'comparison',interpretation:'same_measure'}}}]},'amount-alias');
 expect(reviewRequestsCoveredByFieldReadings({review,fieldRequests:[{...f.fieldRequest,target,code:`document_field:${target.target_sha256}`}],nowMs})).toHaveLength(kind==='same'?1:0);
});
it.each(['same','wrong_pass','changed_observation']as const)('links a generic balance-unit need to its exact retained first-pass transcription: %s',kind=>{
 const f=reviewSourceTranscriptionFixture('balance_unit'),input=structuredClone(f.input),target=f.fieldRequest.target;
 if(target.subject.kind!=='balance_unit')throw Error('BALANCE_REQUIRED');
 const pin={case_id:input.case_id,document_id:target.version_id,version_id:target.version_id,source_sha256:target.source_sha256},key='document.0.balance.vacation_balance.unit';
 input.coverage_policy='document-review-coverage-v1';input.purchased_scope.topics=['vacation'];input.checks=[];input.answer_bindings=[];
 input.source_observation_inventory=[{schema_version:'payslip-unresolved-fields-v1',document_id:target.version_id,version_id:target.version_id,source_sha256:target.source_sha256,
  reading_sha256:input.documents[0].reading_sha256,checkpoint_result_sha256:target.extraction_result_sha256,original_pass_sha256:kind==='wrong_pass'?'f'.repeat(64):target.subject.first_pass_extraction_sha256,
  observations:[{...target.subject.original_candidate,...(kind==='changed_observation'?{raw_value:'8.25'}:{})}]}];
 input.coverage_gaps=[{check_id:key,topic:'vacation',kind:'missing_fact',detail:'חסרה יחידה',next_step:'יש להעתיק את היחידה',source_pins:[pin]}];
 input.completion_input={case_id:input.case_id,period:input.period,documents:[{pin,kind:'payslip',period:input.period,review:'partial'}],evidence:[],
  needs:[{fact_key:key,kind:'factual',reason:'unknown',required_evidence_kind:'observed_reading',question:'מהי יחידת היתרה?',answer_kind:'text',source_pins:[pin],dependent_check_ids:[key],general_question:false}]};
 const covered=reviewRequestsCoveredByFieldReadings({review:runDocumentReview(input,'retained-balance-unit'),fieldRequests:[f.fieldRequest],nowMs});
 expect(covered).toHaveLength(kind==='same'?1:0);if(kind==='same')expect(covered[0]).toMatchObject({transcription_kind:'balance_unit',candidate_id:target.subject.original_candidate.candidate_id});
});
it.each(['confirmed','unknown','not_identified','stale_field','changed_locator']as const)('resolves an old generic action only against an actually identified current reading: %s',state=>{
 const f=reviewFieldCoverageFixture(true),old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation),oldRow=JSON.parse(old.operands[0].source.locator);
 const fact='source.check.quantity',completion=parseReviewCompletionInput(f.input.completion_input);
 const prior=runDocumentReview({...f.input,coverage_policy:'document-review-coverage-v1',answer_bindings:[{fact_key:fact,check_id:'source.check',operand_id:'quantity'}],completion_input:{...completion,needs:completion.needs.map(n=>({...n,fact_key:fact}))}},'prior-need');
 const target=prior.completions.customer_requests[0].target;
 const locator={schema_version:'document-review-source-locator-v2',component_ids:oldRow.component_ids,cell:'quantity',original_component_sha256:['a'.repeat(64)],raw_values:[f.candidate.raw_value],
  mapped_candidate:{candidate_id:f.candidate.candidate_id,candidate_sha256:state==='changed_locator'?'f'.repeat(64):canonicalSha256(f.candidate)}};
 const current=runDocumentReview({...prior.input,answer_bindings:[],completion_input:{...completion,needs:[]},checks:[{...f.input.checks[0],calculation:{...old,operands:[
  {...old.operands[0],state:'observed',source:{...old.operands[0].source,reading:state==='not_identified'?'provider_extraction':'identified_document_reading',locator:JSON.stringify(locator)}},old.operands[1]]}}]},'already-read-source');
 const field={...f.fieldRequest,source_current:state!=='stale_field',answered_at:'2026-09-10T00:00:00Z',answer_text:JSON.stringify({schema_version:'document-field-answer-v2',action:state==='unknown'?'unknown':'confirm'})};
 const result=reviewHistoricalRequestProjection({review:current,fieldRequests:[field],reviewRequests:[{request_id:'11111111-1111-4111-8111-111111111111',code:`document_review:${target.target_sha256}`,target,source_current:true,answered_at:null,expires_at:'2099-01-01T00:00:00Z'}],nowMs});
 expect(result).toHaveLength(state==='confirmed'?1:0);if(state==='confirmed')expect(result[0]).toMatchObject({state:'already_read',field_request_id:field.request_id});
});
it.each(['correct','unmatched_value','old_raw','invalid_correction','unknown','unreadable']as const)('links a corrected row amount only to its materialized current operand: %s',state=>{
 const f=reviewRowCellCoverageFixture(),old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation),completion=parseReviewCompletionInput(f.input.completion_input),fact='source.check.amount.2';
 const target=documentRowCellTarget({checkpoint:f.checkpoint,policyVersion:f.fieldRequest.target.policy_version,componentId:f.component.component_id,cell:'amount'});
 const locator={schema_version:'document-review-source-locator-v2',component_ids:[f.component.component_id],cell:'amount',original_component_sha256:[canonicalSha256(f.component)],raw_values:[f.component.amount_raw]};
 const original={...old.operands[0],id:'amount.2',observation_id:`${f.component.component_id}:amount`,printed_value:f.component.amount_raw,representation:'money_ils',quantity_unit:null,source:{...old.operands[0].source,locator:JSON.stringify(locator)}};
 const operation={kind:'reconciliation',add_refs:['amount.2'],subtract_refs:[],recorded_ref:'comparison',inventory_complete:true,inventory_basis:'Synthetic one row',disjoint_components:true,overlap_basis:'Single row once'};
 const comparison={...old.operands[1],representation:'money_ils',quantity_unit:null,printed_value:f.component.amount_raw};
 const prior=runDocumentReview({...f.input,coverage_policy:'document-review-coverage-v1',checks:[{...f.input.checks[0],calculation:{...old,operands:[original,comparison],operation}}],
  answer_bindings:[{fact_key:fact,check_id:'source.check',operand_id:'amount.2'}],completion_input:{...completion,needs:completion.needs.map(n=>({...n,fact_key:fact}))}},'prior-row-amount');
 const generic=prior.completions.customer_requests[0].target,correctedRaw='201.00';
 const current=runDocumentReview({...prior.input,answer_bindings:[],completion_input:{...completion,needs:[]},checks:[{...f.input.checks[0],calculation:{...old,operation,operands:[
  {...original,state:'observed',printed_value:state==='unmatched_value'?'202.00':correctedRaw,source:{...original.source,reading:'identified_document_reading',locator:JSON.stringify({...locator,raw_values:[state==='old_raw'?f.component.amount_raw:correctedRaw]})}},comparison]}}]},'current-row-amount');
 const answer=state==='unknown'||state==='unreadable'?{schema_version:'document-field-answer-v2',action:state}
  :{schema_version:'document-field-answer-v2',action:'correct',corrected_raw_value:state==='invalid_correction'?'garbage':correctedRaw};
 const result=reviewHistoricalRequestProjection({review:current,fieldRequests:[{...f.fieldRequest,target,code:`document_field:${target.target_sha256}`,answered_at:'2026-09-10T00:00:00Z',answer_text:JSON.stringify(answer)}],
  reviewRequests:[{request_id:'old-numeric',code:`document_review:${generic.target_sha256}`,target:generic,source_current:true,answered_at:null,expires_at:'2099-01-01T00:00:00Z'}],nowMs});
 expect(result).toHaveLength(state==='correct'?1:0);if(state==='correct')expect(result[0].state).toBe('already_read');
});
it.each(['pension_base','pension_employee_contribution']as const)('defers %s only when a source-bound structural refusal makes every ratio use non-actionable',field=>{
 const f=reviewStructurallyBlockedPensionFixture(field),before=canonicalSha256(f.review),targetBefore=canonicalSha256(f.fieldRequest);
 expect(reviewFieldRequestsNotRequired({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{field_request_id:f.fieldRequest.request_id,reason:'no_current_check_dependency'}]);
 expect(reviewFieldReadingCheckLabels({review:f.review,fieldRequests:[f.fieldRequest],nowMs})[0].check_titles).toEqual([]);
 expect(f.review.coverage_gaps.map(g=>g.check_id)).toEqual(['document.0.ratio.pension_employee_contribution.relationship','document.0.deductions.grouping']);
 expect(f.review.checks[0].calculation).toMatchObject({state:'blocked',observed_ratio:null,expected:null});
 expect(canonicalSha256(f.review)).toBe(before);expect(canonicalSha256(f.fieldRequest)).toBe(targetBefore);
});
it.each(['another_viable_use','missing_relationship_gap','unrelated_gap','active_numeric_need','changed_candidate_hash','unknown_grouping_basis','no_ratio_use']as const)('keeps pension numbers active when structural non-consumption is unproved: %s',change=>{
 const f=reviewStructurallyBlockedPensionFixture(),input=structuredClone(f.input),ratio=documentReviewCalculationInputSchema.parse(input.checks[0].calculation);
 if(change==='another_viable_use')input.checks.push({...input.checks[0],check_id:'document.0.other.ratio',calculation:{...ratio,check_id:'document.0.other.ratio',operation:{...ratio.operation,same_period_and_base:true}}});
 if(change==='missing_relationship_gap')input.coverage_gaps=input.coverage_gaps.filter(g=>!g.check_id.endsWith('.relationship'));
 if(change==='unrelated_gap')input.coverage_gaps[0].check_id='document.0.unresolved.pension.source';
 if(change==='active_numeric_need'){
  const completion=parseReviewCompletionInput(input.completion_input),pin=completion.documents[0].pin;
  input.completion_input={...completion,needs:[{fact_key:'pension.read.base',kind:'factual',reason:'unknown',required_evidence_kind:'observed_reading',question:'מהו הבסיס במקור?',answer_kind:'number',source_pins:[pin],dependent_check_ids:[input.checks[0].check_id],general_question:false}]};
  input.answer_bindings=[{fact_key:'pension.read.base',check_id:input.checks[0].check_id,operand_id:'base'}];
 }
 if(change==='changed_candidate_hash'){
  input.checks[0].calculation={...ratio,operands:ratio.operands.map(o=>{const locator=JSON.parse(o.source.locator);return {...o,source:{...o.source,locator:JSON.stringify({...locator,candidate_sha256:['f'.repeat(64)]})}};})};
 }
 if(change==='unknown_grouping_basis'){
  const totals=documentReviewCalculationInputSchema.parse(input.checks[1].calculation);
  input.checks[1].calculation={...totals,operands:totals.operands.map(o=>({...o,source:{...o.source,locator:'unmapped grouped totals'}}))};
 }
 if(change==='no_ratio_use'){input.checks=input.checks.slice(1);input.coverage_gaps=input.coverage_gaps.filter(g=>!g.check_id.endsWith('.relationship'));}
 expect(reviewFieldRequestsNotRequired({review:runDocumentReview(input,'pension-refusal-check'),fieldRequests:[f.fieldRequest],nowMs})).toEqual([]);
});
it('projects an unused salary-type action only for the explicitly versioned current arithmetic review',()=>{
 const f=reviewUnusedFieldFixture(),before=canonicalSha256(f.review),requestBefore=canonicalSha256(f.fieldRequest);
 expect(reviewFieldRequestsNotRequired({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{field_request_id:f.fieldRequest.request_id,reason:'no_current_check_dependency'}]);
 expect(canonicalSha256(f.review)).toBe(before);expect(canonicalSha256(f.fieldRequest)).toBe(requestBefore);
});
it.each(['legacy_policy','missing_period','no_checks','unknown_need','unexplained_gap','bad_locator','used_field','stale_request','expired_request','foreign_source']as const)('keeps the action visible when non-dependency cannot be proved: %s',change=>{
 const f=reviewUnusedFieldFixture();let review=f.review,request=f.fieldRequest;
 if(change==='stale_request')request={...request,source_current:false};
 else if(change==='expired_request')request={...request,expires_at:'2025-02-01T00:00:00Z'};
 else if(change==='foreign_source'){
  const target=documentFieldTarget({checkpoint:{...f.checkpoint,input_sha256:'f'.repeat(64)},policyVersion:request.target.policy_version,candidateId:request.target.candidate.candidate_id});
  request={...request,target,code:`document_field:${target.target_sha256}`};
 }else{
  const input=structuredClone(f.input);
  if(change==='legacy_policy')delete input.coverage_policy;
  if(change==='missing_period')input.documents[0].period=null;
  if(change==='no_checks'){input.checks=[];input.answer_bindings=[];input.completion_input={...input.completion_input as object,needs:[]};}
  if(change==='unknown_need'){
   const completion=input.completion_input as {needs:{fact_key:string}[]};completion.needs.push({...completion.needs[0],fact_key:'unmapped.need'});
  }
  if(change==='unexplained_gap')input.coverage_gaps.push({check_id:'unexplained',topic:'working_time',kind:'missing_fact',detail:'מידע חסר',next_step:'יש לברר את המקור'});
  if(change==='bad_locator'||change==='used_field'){
   const old=documentReviewCalculationInputSchema.parse(input.checks[0].calculation);
   input.checks[0].calculation={...old,operands:old.operands.map(o=>({...o,source:{...o.source,locator:change==='bad_locator'?'{truncated':JSON.stringify({schema_version:'document-review-source-locator-v2',field:request.target.candidate.field,candidate_ids:[request.target.candidate.candidate_id],candidate_sha256:[canonicalSha256(request.target.candidate)],raw_values:[request.target.candidate.raw_value]})}}))};
  }
  review=runDocumentReview(input,'conservative-projection');
 }
 expect(reviewFieldRequestsNotRequired({review,fieldRequests:[request],nowMs})).toEqual([]);
});
it.each(['reported_work_hours','balance_unit']as const)('does not hide an existing observation request behind a missing %s transcription',kind=>{
 const f=reviewSourceTranscriptionFixture(kind),before=canonicalSha256(f.review);
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([]);
 expect(reviewFieldReadingCheckLabels({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{field_request_id:f.fieldRequest.request_id,check_titles:[]}]);
 expect(canonicalSha256(f.review)).toBe(before);
});
it.each([false,true])('covers only the same existing field action; row=%s',row=>{
 const f=reviewFieldCoverageFixture(row),before=canonicalSha256(f.review);
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{target_sha256:f.review.completions.customer_requests[0].target.target_sha256,fact_key:'source.cell',field_request_id:f.fieldRequest.request_id,candidate_id:f.candidate.candidate_id}]);
 expect(canonicalSha256(f.review)).toBe(before);expect(f.review.checks[0].calculation.state).toBe('blocked');
});

it('covers an unmapped row cell by exact component and cell without inventing a scalar candidate',()=>{
 const f=reviewRowCellCoverageFixture(),before=canonicalSha256(f.review);
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{
  target_sha256:f.review.completions.customer_requests[0].target.target_sha256,fact_key:'source.cell',field_request_id:f.fieldRequest.request_id,component_id:f.component.component_id,cell:'quantity'}]);
 expect(reviewFieldReadingCheckLabels({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{field_request_id:f.fieldRequest.request_id,check_titles:['כמות בשורת המקור']}]);
 expect(canonicalSha256(f.review)).toBe(before);expect(f.review.checks[0].calculation.state).toBe('blocked');
});
it.each(['cell','same_label_other_id','foreign_source','merged_components','changed_raw']as const)('does not consolidate an unmapped row from %s',change=>{
 const f=reviewRowCellCoverageFixture();let review=f.review,request=f.fieldRequest;
 if(change==='cell'){const target=documentRowCellTarget({checkpoint:f.checkpoint,policyVersion:request.target.policy_version,componentId:f.component.component_id,cell:'rate'});request={...request,target,code:`document_field:${target.target_sha256}`};}
 else{
  const old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation),operand=old.operands[0],locator=JSON.parse(operand.source.locator);
  if(change==='same_label_other_id')locator.component_ids=['99999999-9999-4999-8999-999999999999'];
  if(change==='merged_components')locator.component_ids.push('99999999-9999-4999-8999-999999999999');
  if(change==='changed_raw')locator.original_raw='3';
  const changed={...operand,source:{...operand.source,locator:JSON.stringify(locator),...(change==='foreign_source'?{file_sha256:'f'.repeat(64)}:{})}};
  // Foreign source cannot enter a valid review; changing the target instead
  // exercises coverage's source fence without weakening review validation.
  if(change==='foreign_source'){
   const checkpoint={...f.checkpoint,input_sha256:'f'.repeat(64)},target=documentRowCellTarget({checkpoint,policyVersion:request.target.policy_version,componentId:f.component.component_id,cell:'quantity'});
   request={...request,target,code:`document_field:${target.target_sha256}`};
  }else review=runDocumentReview({...f.input,checks:[{...f.input.checks[0],calculation:{...old,operands:[changed,old.operands[1]]}}]},'different-row-review');
 }
 expect(reviewRequestsCoveredByFieldReadings({review,fieldRequests:[request],nowMs})).toEqual([]);
 expect(reviewFieldReadingCheckLabels({review,fieldRequests:[request],nowMs})[0].check_titles).toEqual([]);
});

it('matches the new versioned row locator and rejects a mismatched original-row hash',()=>{
 const f=reviewRowCellCoverageFixture(),old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation);
 for(const matching of [true,false]){
  const locator={schema_version:'document-review-source-locator-v2',component_ids:[f.component.component_id],cell:'quantity',
   original_component_sha256:[matching?canonicalSha256(f.component):'f'.repeat(64)],raw_values:[f.component.quantity_raw]};
  const operand={...old.operands[0],source:{...old.operands[0].source,locator:JSON.stringify(locator)}};
  const review=runDocumentReview({...f.input,checks:[{...f.input.checks[0],calculation:{...old,operands:[operand,old.operands[1]]}}]},'versioned-row-review');
  expect(reviewRequestsCoveredByFieldReadings({review,fieldRequests:[f.fieldRequest],nowMs})).toHaveLength(matching?1:0);
 }
});
it('reuses an exact mapped scalar reading from a versioned row without matching only the numeric value',()=>{
 const f=reviewFieldCoverageFixture(true),old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation),row=JSON.parse(old.operands[0].source.locator);
 for(const exact of [true,false]){
  const locator={schema_version:'document-review-source-locator-v2',component_ids:row.component_ids,cell:'quantity',original_component_sha256:['a'.repeat(64)],raw_values:[f.candidate.raw_value],
   mapped_candidate:{candidate_id:f.candidate.candidate_id,candidate_sha256:exact?canonicalSha256(f.candidate):'f'.repeat(64)}};
  const operand={...old.operands[0],source:{...old.operands[0].source,locator:JSON.stringify(locator)}};
  const review=runDocumentReview({...f.input,checks:[{...f.input.checks[0],calculation:{...old,operands:[operand,old.operands[1]]}}]},'mapped-scalar-review');
  expect(reviewRequestsCoveredByFieldReadings({review,fieldRequests:[f.fieldRequest],nowMs})).toHaveLength(exact?1:0);
 }
});
it('covers only the exact missing reported-hours consumer while preserving its meaning and target pins',()=>{
 const f=reviewSourceTranscriptionFixture(),old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation);
 for(const same of [true,false]){
  const locator={schema_version:'document-review-source-locator-v2',transcription_kind:'reported_work_hours',page:1,meaning:'document_reported_total_hours',
   ...(same?{}:{target_sha256:'f'.repeat(64)})};
  const operand={...old.operands[0],id:'reported.hours',state:'missing',printed_value:null,source:{...old.operands[0].source,locator:JSON.stringify(locator)}};
  const operation={...old.operation,kind:'quantity_comparison',left_ref:'reported.hours',right_ref:'comparison',interpretation:'same_measure'};
  const input={...f.input,answer_bindings:[{fact_key:'source.cell',check_id:'source.check',operand_id:'reported.hours'}],
   checks:[{...f.input.checks[0],title:'השוואה לסך השעות המדווחות',calculation:{...old,operands:[operand,old.operands[1]],operation}}]};
  const review=runDocumentReview(input,'missing-source-hours');
  const covered=reviewRequestsCoveredByFieldReadings({review,fieldRequests:[f.fieldRequest],nowMs});
  expect(covered).toHaveLength(same?1:0);if(same)expect(covered[0]).toMatchObject({transcription_kind:'reported_work_hours'});
  expect(reviewFieldReadingCheckLabels({review,fieldRequests:[f.fieldRequest],nowMs})[0].check_titles).toEqual(same?['השוואה לסך השעות המדווחות']:[]);
 }
});
it('links a source-scope action only to the exact original observation and current check',()=>{
 const f=reviewSourceScopeCoverageFixture();
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([{
  target_sha256:f.review.completions.customer_requests[0].target.target_sha256,fact_key:'source.cell',field_request_id:f.fieldRequest.request_id,
  candidate_id:f.observation.candidate.candidate_id,source_scope:'final_payable'}]);
 expect(reviewFieldReadingCheckLabels({review:f.review,fieldRequests:[f.fieldRequest],nowMs})[0].check_titles).toEqual(['התאמת הסכום הסופי לתשלום']);
 for(const change of ['scope','hash','raw','candidate']as const){
  const old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation),locator=JSON.parse(old.operands[0].source.locator);
  if(change==='scope')locator.scope='voluntary_deduction';if(change==='hash')locator.scope_observation_sha256=['f'.repeat(64)];
  if(change==='raw')locator.raw_values=['96.1'];if(change==='candidate')locator.candidate_ids=['99999999-9999-4999-8999-999999999999'];
  const operand={...old.operands[0],source:{...old.operands[0].source,locator:JSON.stringify(locator)}};
  const review=runDocumentReview({...f.input,checks:[{...f.input.checks[0],calculation:{...old,operands:[operand,old.operands[1]]}}]},'changed-scope');
  expect(reviewRequestsCoveredByFieldReadings({review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([]);
 }
});
it.each(['expired','answered','unknown_answer','stale','different_candidate','different_source'] as const)('does not cover %s',change=>{
 const f=reviewFieldCoverageFixture();
 if(change==='expired')f.fieldRequest.expires_at='2026-01-01T00:00:00Z';
 if(change==='answered'||change==='unknown_answer')f.fieldRequest.answered_at='2026-09-10T00:00:00Z';
 if(change==='stale')f.fieldRequest.source_current=false;
 if(change==='different_candidate'||change==='different_source'){
  const checkpoint=structuredClone(f.checkpoint);
  if(change==='different_source')checkpoint.input_sha256='f'.repeat(64);
  else checkpoint.run.result.final_extraction.fields.find(c=>c.candidate_id===f.candidate.candidate_id)!.candidate_id='99999999-9999-4999-8999-999999999999';
  checkpoint.result_sha256=canonicalSha256(checkpoint.run.result);
  const target=documentFieldTarget({checkpoint,policyVersion:f.fieldRequest.target.policy_version,candidateId:change==='different_candidate'?'99999999-9999-4999-8999-999999999999':f.candidate.candidate_id});
  f.fieldRequest.target=target;f.fieldRequest.code=`document_field:${target.target_sha256}`;
 }
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[f.fieldRequest],nowMs})).toEqual([]);
});
it('does not cover an unmapped row cell or a malformed/truncated locator',()=>{
 for(const change of ['unmapped_semantic','locator']){
  const f=reviewFieldCoverageFixture(true),input=structuredClone(f.input),calculation=input.checks[0].calculation as {operands:{id:string;source:{locator:string}}[]};
  if(change==='unmapped_semantic'){const locator=JSON.parse(calculation.operands[0].source.locator);locator.semantic_kind='bonus';calculation.operands[0].source.locator=JSON.stringify(locator);}else calculation.operands[0].source.locator='{truncated';
  expect(reviewRequestsCoveredByFieldReadings({review:runDocumentReview(input,'changed-source-review'),fieldRequests:[f.fieldRequest],nowMs})).toEqual([]);
 }
});
it('does not consolidate an arbitrary declaration or multiple competing current field targets',()=>{
 const f=reviewFieldCoverageFixture();
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[f.fieldRequest,{...f.fieldRequest,request_id:'11111111-1111-4111-8111-111111111111'}],nowMs})).toEqual([]);
 const input=structuredClone(f.input),completion=input.completion_input as {needs:{required_evidence_kind:string}[]};completion.needs[0].required_evidence_kind='customer_declaration';
 expect(reviewRequestsCoveredByFieldReadings({review:runDocumentReview(input,'declaration'),fieldRequests:[f.fieldRequest],nowMs})).toEqual([]);
});

it('links an answered numeric declaration using its preserved original source, without promoting it to a reading',()=>{
 const f=reviewFieldCoverageFixture(),request=f.review.completions.customer_requests[0];
 const applied=applyDocumentReviewAnswer(f.input,{request,actor:{case_id:f.review.case_id,identity_id:'11111111-1111-4111-8111-111111111111'},
  answer:{request_id:'22222222-2222-4222-8222-222222222222',revision:1,answered_at:'2026-09-11T00:00:00Z',state:'provided',value:100}});
 const review=runDocumentReview(applied.input,'answered-declaration');
 expect(reviewRequestsCoveredByFieldReadings({review,fieldRequests:[f.fieldRequest],nowMs})).toHaveLength(1);
 expect(review.checks[0].calculation.state).toBe('blocked');
});
