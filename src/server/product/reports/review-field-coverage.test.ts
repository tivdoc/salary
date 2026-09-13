import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildSyntheticCaseFixture} from '@/engine/case-analysis/synthetic-fixtures';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {runDocumentReview,applyDocumentReviewAnswer} from '@/engine/document-review/service';
import {reviewRequestsCoveredByFieldReadings,reviewRequestsCoveredByFieldReadingGroups,reviewFieldReadingCheckLabels,reviewFieldRequestsNotRequired,reviewHistoricalRequestProjection,type ExistingFieldReadingRequest} from './review-field-coverage';
import {documentFieldTarget} from './document-field-confirmation';
import {reviewFieldCoverageFixture,reviewMultipleFieldCoverageFixture,reviewRowCellCoverageFixture,reviewSourceScopeCoverageFixture,reviewSourceTranscriptionFixture,reviewUnusedFieldFixture,reviewStructurallyBlockedPensionFixture} from './review-field-coverage.fixture';
import {documentRowCellTarget} from './document-row-cell-confirmation';
import {documentReviewCalculationInputSchema} from '@/engine/document-review/calculations';
import {parseReviewCompletionInput,generateReviewCompletions} from '@/engine/document-review/completions';
import {normalizedPayslipExtractionSchema} from '@/engine/extraction/payslip';
import {reviewInputFromPayslips,PAYSLIP_SOURCE_STRUCTURE_POLICY} from '@/engine/document-review/payslip-adapter';
import {sourceStructureEntries} from '@/engine/document-review/source-structure-evidence';
import {sourceStructureSelector} from '@/engine/extraction/source-structure-resolution';
import {documentSourceStructureTarget,documentSourceStructureTargetSchema,resolveDocumentSourceStructureVerification,materializeDocumentSourceStructureVerification} from './document-source-structure';
import {documentSourceTranscriptionTarget,documentSourceTranscriptionTargetSchema} from './document-source-transcription';
import {documentEvidenceSourceTranscriptionTarget} from './document-evidence-source-transcription';
vi.mock('server-only',()=>({}));
const nowMs=Date.parse('2026-09-11T00:00:00Z');
it('replaces a multi-observation generic scalar with every exact field action without confirming either',()=>{
 const f=reviewMultipleFieldCoverageFixture(),before=canonicalSha256(f.review);
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:f.fields,nowMs})).toEqual([]);
 expect(reviewRequestsCoveredByFieldReadingGroups({review:f.review,fieldRequests:f.fields,nowMs})).toEqual([{
  target_sha256:f.review.completions.customer_requests[0].target.target_sha256,fact_key:'source.cell',
  field_requests:f.fields.map((r,i)=>({request_id:r.request_id,candidate_id:f.candidates[i].candidate_id,state:'pending'}))}]);
 expect(f.review.checks[0].calculation.state).toBe('blocked');expect(canonicalSha256(f.review)).toBe(before);
});
it.each(['missing','stale','foreign','expired','duplicate','changed_hash','changed_period','other_checkpoint','conflict']as const)(
 'does not hide the generic multi-observation need when one contributor is %s',kind=>{
  const f=reviewMultipleFieldCoverageFixture();let fields:ExistingFieldReadingRequest[]=structuredClone(f.fields),review=f.review;
  if(kind==='missing')fields=fields.slice(0,1);
  if(kind==='stale')fields[1]={...fields[1],source_current:false};
  if(kind==='expired')fields[1]={...fields[1],expires_at:new Date(nowMs-1).toISOString()};
  if(kind==='duplicate')fields.push({...fields[1],request_id:randomUUID()});
  if(['foreign','changed_hash','changed_period','other_checkpoint'].includes(kind)){
   const old=fields[1].target;if(old.schema_version!=='document-field-confirmation-v1')throw Error('SYNTHETIC_SCALAR');
   const {target_sha256:_,...body}=old;void _;
   const changed={...body,...(kind==='foreign'?{case_id:randomUUID()}:kind==='changed_hash'?{candidate:{...body.candidate,confidence:.91}}
    :kind==='changed_period'?{month:'2025-02'}:{extraction_result_sha256:'b'.repeat(64)})};
   const target={...changed,target_sha256:canonicalSha256(changed)};fields[1]={...fields[1],target,code:`document_field:${target.target_sha256}`};
  }
  if(kind==='conflict'){
   const calculation=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation);
   review=runDocumentReview({...f.input,checks:[{...f.input.checks[0],calculation:{...calculation,
    operands:calculation.operands.map((o,i)=>i===0?{...o,state:'conflict'}:o)}}]},randomUUID());
  }
  expect(reviewRequestsCoveredByFieldReadingGroups({review,fieldRequests:fields,nowMs})).toEqual([]);
 });
it.each(['unknown','unreadable']as const)('retains individual %s states for the complete field group',action=>{
 const f=reviewMultipleFieldCoverageFixture(),fields=f.fields.map((r,i)=>i===0?{...r,answered_at:'2026-09-10T00:00:00Z',
  answer_text:JSON.stringify({schema_version:'document-field-answer-v2',action})}:r);
 const [group]=reviewRequestsCoveredByFieldReadingGroups({review:f.review,fieldRequests:fields,nowMs});
 expect(group.field_requests.map(r=>r.state)).toEqual(['unresolved','pending']);
 expect(group.field_requests.map(r=>r.request_id)).toEqual(fields.map(r=>r.request_id));
});
it('keeps the generic need when exact authenticated candidates disagree, even before conflict classification',()=>{
 const f=reviewMultipleFieldCoverageFixture(12345);
 expect(reviewRequestsCoveredByFieldReadingGroups({review:f.review,fieldRequests:f.fields,nowMs})).toEqual([]);
});
it.each(['pending','correct','unknown']as const)('keeps a clause transcription outside numeric operand coverage: %s',action=>{
 const f=reviewRowCellCoverageFixture(),old=f.fieldRequest.target;
 const target=documentEvidenceSourceTranscriptionTarget({source:{case_id:old.case_id,product_document_id:old.product_document_id,version_id:old.version_id,
  source_sha256:old.source_sha256,document_kind:'contract',document_month:null,page_count:1,reading_dependencies:[]},
  purchase:{order_id:randomUUID(),origin:'saved_order',receipt_sha256:'a'.repeat(64),topics:['contract']},month:old.month,page:1});
 const field:ExistingFieldReadingRequest={...f.fieldRequest,target,code:`document_field:${target.target_sha256}`,
  answered_at:action==='pending'?null:'2026-09-10T00:00:00Z',answer_text:action==='pending'?null:JSON.stringify({schema_version:'document-evidence-source-answer-v1',action,
   ...(action==='correct'?{value:{raw_value:'SYNTHETIC ONLY - 100.00',locator:'Complete synthetic clause'}}:{})})};
 const before=canonicalSha256(f.review);
 expect(reviewRequestsCoveredByFieldReadings({review:f.review,fieldRequests:[field],nowMs})).toEqual([]);
 expect(reviewFieldReadingCheckLabels({review:f.review,fieldRequests:[field],nowMs})).toEqual(action==='pending'?[{field_request_id:field.request_id,check_titles:[]}]:[]);
 expect(canonicalSha256(f.review)).toBe(before);
});
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
it('covers only the exact grand-total request without reusing a subtotal or a foreign page/source',()=>{
 const f=reviewSourceTranscriptionFixture('grand_total'),old=documentReviewCalculationInputSchema.parse(f.input.checks[0].calculation);
 for(const changed of ['none','hash','page','source','meaning'] as const){
  const locator={schema_version:'document-review-source-locator-v2',transcription_kind:'grand_total',page:1,
   meaning:changed==='meaning'?'document_reported_total_hours':'document_total_deductions',...(changed==='hash'?{target_sha256:'f'.repeat(64)}:{})};
  const operand={...old.operands[0],id:'deductions',state:'missing',printed_value:null,source:{...old.operands[0].source,locator:JSON.stringify(locator),
   ...(changed==='page'?{page:2}:{})}};
  const operation={...old.operation,kind:'quantity_comparison',left_ref:'deductions',right_ref:'comparison',interpretation:'same_measure'};
  const input={...f.input,documents:f.input.documents.map(d=>({...d,page_count:2})),answer_bindings:[{fact_key:'source.cell',check_id:'source.check',operand_id:'deductions'}],
   checks:[{...f.input.checks[0],title:'השוואת סך הניכויים',calculation:{...old,source_manifest:old.source_manifest.map(p=>({...p,page_count:2})),operands:[operand,old.operands[1]],operation}}]};
  const review=runDocumentReview(input,'missing-grand-total');
  const {target_sha256:ignored,...body}=f.fieldRequest.target;void ignored;
  const changedBody={...body,source_sha256:changed==='source'?'f'.repeat(64):body.source_sha256};
  const target={...changedBody,target_sha256:canonicalSha256(changedBody)},request={...f.fieldRequest,target,code:`document_field:${target.target_sha256}`};
  const covered=reviewRequestsCoveredByFieldReadings({review,fieldRequests:[request],nowMs});
  expect(covered).toHaveLength(changed==='none'?1:0);if(changed==='none')expect(covered[0]).toMatchObject({transcription_kind:'grand_total'});
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

/** Synthetic counterpart of the v3 report: role witnesses replace old gaps,
 * while numeric/source decisions remain separate and the report stays blocked. */
function structureProjectionFixture(){
 const fixture=buildSyntheticCaseFixture({fixture_id:'synthetic-current-structure-projection',mode:'real'}),d=fixture.stored.documents[0],template=fixture.stored.extractions[0];
 if(!d.document_period?.end_date)throw new Error('Synthetic structure fixture requires a complete period');
 const period={from:d.document_period.start_date,to:d.document_period.end_date},ids={base:randomUUID(),employee:randomUUID(),vacation:randomUUID(),row:randomUUID()};
 const source={document_id:d.document_id,page:1,text_fragment:'Synthetic current source block',source_scope:{period_kind:'current',fund_kind:'unknown',column_label:'current'}};
 const field=(field:string,candidate_id:string,raw_value:string,normalized_value:unknown)=>({candidate_id,field,raw_value,normalized_value,confidence:.94,source,extraction_method:'fixture',warning_flags:[]});
 const machine=normalizedPayslipExtractionSchema.parse({...template,document_quality_confidence:1,
  fields:[...template.fields.filter(f=>['salary_period','salary_type'].includes(f.field)),
   field('pension_base',ids.base,'2000.00',{currency:'ILS',minor_units:200000}),field('pension_employee_contribution',ids.employee,'100.00',{currency:'ILS',minor_units:10000}),
   ...([['gross_salary','2000.00',200000],['net_salary','1900.00',190000],['total_deductions','100.00',10000]]as const).map(([name,raw,minor_units])=>({...field(name,randomUUID(),raw,{currency:'ILS',minor_units}),confidence:1}))]
   .map(f=>({...f,source})),
  additional_components:[{component_id:ids.row,source_label:'Synthetic deduction A',normalized_label:'deduction',semantic_kind:'deduction',
   quantity_raw:null,rate_raw:null,percentage_raw:null,amount_raw:'100.00',quantity:null,rate:null,percentage:null,amount:{currency:'ILS',minor_units:10000},confidence:.94,source,extraction_method:'fixture',warning_flags:[],normalization_warnings:[]}]});
 const first=normalizedPayslipExtractionSchema.parse({...machine,fields:[...machine.fields,field('vacation_balance',ids.vacation,'9.00',null)]});
 const result={final_extraction:machine,first_pass:{normalized_extraction:first}},checkpoint={schema_version:'tivdoc-saved-extraction-v1',case_id:d.case_id,product_document_id:randomUUID(),version_id:d.document_id,
  input_sha256:d.content_sha256,expected_month:'2025-01',period_mismatch:false,result_sha256:canonicalSha256(result),run:{result}};
 const readings:NonNullable<typeof machine.customer_source_structures>=[];
 const build=()=>reviewInputFromPayslips({case_id:d.case_id,period,review_policy:PAYSLIP_SOURCE_STRUCTURE_POLICY,
  purchased_scope:{order_id:randomUUID(),receipt_sha256:'a'.repeat(64),origin:'saved_order',topics:['minimum_wage','pension','vacation']},
  snapshot:{...fixture.stored,documents:[d],extractions:[{...machine,...(readings.length?{customer_source_structures:readings,source_reading_context:{checkpoint_result_sha256:checkpoint.result_sha256,first_pass:first}}:{})}]},
  retained_unresolved_fields:[{case_id:d.case_id,document_id:d.document_id,source_sha256:d.content_sha256,checkpoint_result_sha256:checkpoint.result_sha256,checkpoint_result:result,final_extraction_sha256:canonicalSha256(machine),first_pass:first}]});
 const input=build(),review=runDocumentReview(input,'synthetic-v3-projection');
 const request=(target:ExistingFieldReadingRequest['target']):ExistingFieldReadingRequest=>({request_id:randomUUID(),code:`document_field:${target.target_sha256}`,target,source_current:true,answered_at:null,expires_at:'2099-01-01T00:00:00Z'});
 const scalar=(name:string)=>request(documentFieldTarget({checkpoint,policyVersion:'synthetic-projection',candidateId:machine.fields.find(f=>f.field===name)!.candidate_id}));
 const structures=review.checks.flatMap(c=>c.calculation.input.source_structure?sourceStructureEntries(c.calculation.input.source_structure):[])
  .map(e=>request(documentSourceStructureTarget({checkpoint,policyVersion:'synthetic-projection',selector:sourceStructureSelector(e.subject)})));
 const unit=request(documentSourceTranscriptionTarget({checkpoint,policyVersion:'synthetic-projection',subject:{kind:'balance_unit',candidateId:ids.vacation}}));
 const generic=(fact_key:string,answer_kind:'text'|'number'='text')=>{
  const planner=parseReviewCompletionInput(input.completion_input),target=generateReviewCompletions({...planner,needs:[{fact_key,kind:'factual',reason:'unknown',required_evidence_kind:'observed_reading',
   question:'Synthetic prior source question',answer_kind,source_pins:[planner.documents[0].pin],dependent_check_ids:[fact_key],general_question:false}]}).customer_requests[0].target;
  return {request_id:randomUUID(),code:`document_review:${target.target_sha256}`,target,source_current:true,answered_at:null,expires_at:'2099-01-01T00:00:00Z'};
 };
 const relation=(relationship:'same_base'|'different_base'='same_base')=>{
  const target=documentSourceStructureTarget({checkpoint,policyVersion:'synthetic-projection',selector:{kind:'source_relationship',componentKind:'pension_employee',contribution:{kind:'field',id:ids.employee},base:{kind:'field',id:ids.base}}});
  const decision=resolveDocumentSourceStructureVerification({target,currentCheckpoint:checkpoint,policyVersion:'synthetic-projection',caseId:d.case_id,month:'2025-01',requestId:randomUUID(),answerRevision:1,identityId:randomUUID(),answeredAt:'2025-02-02T00:00:00Z',
   answer:{schema_version:'document-field-answer-v3',action:relationship==='same_base'?'confirm':'correct',structured_value:{kind:'source_relationship',relationship,component_kind:'pension_employee',fund_kind:'pension',fund_label:'Synthetic fund',source_kind:'labelled_section',basis:{page:1,locator:'section A',text:'Explicit source relation'}}}});
  const materialized=materializeDocumentSourceStructureVerification(decision,canonicalSha256(machine));if(!materialized)throw Error('SYNTHETIC_RELATION_REQUIRED');readings.push(materialized.reading);
 };
 return {input,review,build,structures,unit,scalar,generic,relation,checkpoint,ids};
}
it.each(['salary_type','pension_base','pension_employee_contribution'])('keeps the v3 source relationship gap visible while deferring non-consumable %s',field=>{
 const f=structureProjectionFixture(),request=f.scalar(field),before=canonicalSha256(f.review);
 expect(f.review.checks.some(c=>c.calculation.input.source_structure?.kind==='balance_movement')).toBe(true);
 const ratio=f.review.checks.find(c=>c.calculation.input.source_structure?.kind==='source_relationship')!;
 expect(f.review.coverage_gaps.filter(g=>g.check_id===`${ratio.check_id}.relationship`)).toEqual([expect.objectContaining({kind:'missing_source',topic:'pension',source_pins:[{
  case_id:f.review.case_id,document_id:f.review.documents[0].document_id,version_id:f.review.documents[0].version_id,source_sha256:f.review.documents[0].file_sha256}]})]);
 expect(ratio.calculation.state).toBe('blocked');expect(ratio.calculation.input.operation).toMatchObject({same_period_and_base:false});
 expect(reviewFieldRequestsNotRequired({review:f.review,fieldRequests:[request,...f.structures],nowMs})).toContainEqual({field_request_id:request.request_id,reason:'no_current_check_dependency'});
 expect(canonicalSha256(f.review)).toBe(before);
});
it.each(['unrelated_gap','missing_witness']as const)('does not bypass a missing-source gap without the exact v3 relationship proof: %s',change=>{
 const f=structureProjectionFixture(),input=structuredClone(f.input),request=f.scalar('pension_base');
 const ratio=input.checks.find(c=>documentReviewCalculationInputSchema.parse(c.calculation).source_structure?.kind==='source_relationship')!;
 if(change==='unrelated_gap')input.coverage_gaps=input.coverage_gaps.map(g=>g.check_id===`${ratio.check_id}.relationship`?{...g,check_id:`${ratio.check_id}.other_source`}:g);
 if(change==='missing_witness'){
  const {source_structure:_source,...calculation}=documentReviewCalculationInputSchema.parse(ratio.calculation);void _source;
  ratio.calculation=calculation;
 }
 const review=runDocumentReview(input,'synthetic-unproved-relationship-gap');
 expect(review.coverage_gaps.some(g=>g.kind==='missing_source')).toBe(true);
 expect(reviewFieldRequestsNotRequired({review,fieldRequests:[request,...f.structures],nowMs})).toEqual([]);
});
it('keeps pension numeric readings active after a compatible identified relationship; no number is approved by the relation',()=>{
 const f=structureProjectionFixture(),request=f.scalar('pension_base');f.relation();const review=runDocumentReview(f.build(),'synthetic-compatible-relation');
 const ratio=review.checks.find(c=>c.calculation.input.source_structure?.kind==='source_relationship')!;
 expect(ratio.calculation.input.operation).toMatchObject({same_period_and_base:true});expect(ratio.calculation.state).toBe('blocked');
 expect(reviewFieldRequestsNotRequired({review,fieldRequests:[request],nowMs})).toEqual([]);
});
it('keeps the different-base conflict visible while deferring numbers that cannot resolve it',()=>{
 const f=structureProjectionFixture(),request=f.scalar('pension_base');f.relation('different_base');const review=runDocumentReview(f.build(),'synthetic-different-source-base');
 const ratio=review.checks.find(c=>c.calculation.input.source_structure?.kind==='source_relationship')!;
 expect(ratio.calculation.input.operation).toMatchObject({same_period_and_base:false});expect(ratio.calculation.state).toBe('blocked');
 expect(reviewFieldRequestsNotRequired({review,fieldRequests:[request],nowMs})).toContainEqual({field_request_id:request.request_id,reason:'no_current_check_dependency'});
});
it('retains a separate viable pension operand even when another source relationship is missing',()=>{
 const f=structureProjectionFixture(),input=structuredClone(f.input),request=f.scalar('pension_base');
 const ratio=input.checks.find(c=>c.topic==='pension')!,calculation=documentReviewCalculationInputSchema.parse(ratio.calculation),{source_structure:_source,...ordinary}=calculation;void _source;
 input.checks.push({...ratio,check_id:'independent.pension.ratio',calculation:{...ordinary,check_id:'independent.pension.ratio',operation:{...ordinary.operation,same_period_and_base:true}}});
 expect(reviewFieldRequestsNotRequired({review:runDocumentReview(input,'independent-numeric-use'),fieldRequests:[request,...f.structures],nowMs})).toEqual([]);
});
it.each(['balance','group','relationship']as const)('replaces only the historical generic %s source role with its current structured action',kind=>{
 const f=structureProjectionFixture(),key=kind==='balance'?'document.0.balance.vacation_balance.unit':kind==='group'?'document.0.deductions.grouping':'document.0.ratio.pension_employee_contribution.relationship';
 const old=f.generic(key),before=canonicalSha256(old);
 const result=reviewHistoricalRequestProjection({review:f.review,fieldRequests:f.structures,reviewRequests:[old],nowMs});
 expect(result).toHaveLength(1);expect(result[0]).toMatchObject({request_id:old.request_id,state:'not_required'});
 const projected=result[0];if(projected.state==='resolved_source_fact')throw Error('EXPECTED_SOURCE_FIELD_PROJECTION');expect(f.structures.some(r=>r.request_id===projected.field_request_id)).toBe(true);expect(canonicalSha256(old)).toBe(before);
});
it.each(['complete','unknown_cell','missing_cell','stale_cell','expired_cell','wrong_checkpoint','wrong_anchor','foreign_source','wrong_period','independent_unit_need']as const)('replaces the old balance-unit question only with the same complete five-role action set: %s',change=>{
 const f=structureProjectionFixture(),old=f.generic('document.0.balance.vacation_balance.unit'),input=structuredClone(f.input);
 let fields=f.structures;const index=fields.findIndex(r=>'proposed_value'in r.target&&r.target.subject.kind==='balance_movement'&&r.target.subject.cell==='opening'),r=fields[index];
 if(change==='missing_cell')fields=fields.filter((_,i)=>i!==index);
 if(change==='stale_cell'||change==='expired_cell'||change==='unknown_cell')fields=fields.map((row,i)=>i!==index?row:{...row,...(change==='stale_cell'?{source_current:false}:change==='expired_cell'?{expires_at:'2020-01-01T00:00:00Z'}:{answered_at:'2025-02-01T00:00:00Z',answer_text:JSON.stringify({schema_version:'document-field-answer-v3',action:'unknown'})})});
 if(['wrong_checkpoint','wrong_anchor','foreign_source','wrong_period'].includes(change)){
  if(!('proposed_value'in r.target)||r.target.subject.kind!=='balance_movement')throw Error('SYNTHETIC_BALANCE_TARGET');
  const {target_sha256:_hash,...body}=r.target;void _hash;
  const changed={...body,...(change==='wrong_checkpoint'?{extraction_result_sha256:'e'.repeat(64)}:change==='foreign_source'?{source_sha256:'e'.repeat(64)}:change==='wrong_period'?{month:'2025-02'}:
   {subject:{...body.subject,anchor:{...r.target.subject.anchor,sha256:'e'.repeat(64)}}})};
  const target=documentSourceStructureTargetSchema.parse({...changed,target_sha256:canonicalSha256(changed)});fields=fields.map((row,i)=>i!==index?row:{...row,target,code:`document_field:${target.target_sha256}`});
 }
 if(change==='independent_unit_need'){
  const planner=parseReviewCompletionInput(input.completion_input),check=input.checks.find(c=>c.topic==='vacation')!;
  input.completion_input={...planner,needs:[...planner.needs,{fact_key:old.target.fact_key,kind:'factual',reason:'unknown',required_evidence_kind:'observed_reading',question:'Independent source unit',answer_kind:'text',source_pins:old.target.source_pins,dependent_check_ids:[check.check_id],general_question:false}]};
 }
 const review=runDocumentReview(input,'synthetic-balance-replacement'),expected=change==='complete'||change==='unknown_cell';
 expect(reviewHistoricalRequestProjection({review,fieldRequests:fields,reviewRequests:[old],nowMs})).toHaveLength(expected?1:0);
 expect(reviewFieldRequestsNotRequired({review,fieldRequests:[f.unit,...fields],nowMs}).some(r=>r.field_request_id===f.unit.request_id)).toBe(expected);
 expect(review.checks.find(c=>c.topic==='vacation')!.calculation.state).toBe('blocked');
});
it.each(['month','checkpoint']as const)('does not defer an old unit target with mismatched %s even if marked source-current',kind=>{
 const f=structureProjectionFixture();if(f.unit.target.schema_version!=='document-source-transcription-v1')throw Error('SYNTHETIC_UNIT_TARGET');
 const {target_sha256:_hash,...body}=f.unit.target;void _hash;
 const changed={...body,...(kind==='month'?{month:'2025-02'}:{extraction_result_sha256:'e'.repeat(64)})};
 const target=documentSourceTranscriptionTargetSchema.parse({...changed,target_sha256:canonicalSha256(changed)});
 const request={...f.unit,target,code:`document_field:${target.target_sha256}`};
 expect(reviewFieldRequestsNotRequired({review:f.review,fieldRequests:[request,...f.structures],nowMs}).some(row=>row.field_request_id===request.request_id)).toBe(false);
});
