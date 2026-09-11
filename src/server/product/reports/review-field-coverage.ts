import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {candidateSourceSchema,rawCandidateFieldSchema} from '@/engine/extraction/contracts';
import {normalizedAdditionalComponentSchema} from '@/engine/extraction/payslip';
import {mappedRowCellCandidate,normalizeDocumentRowCellValue,normalizeDocumentScopeObservationValue,normalizeSourceTranscriptionValue,type MappedRowCell} from '@/engine/extraction/reading-resolution';
import {normalizePayslipFieldValue,normalizeMoney,normalizeDecimal,normalizePercentage} from '@/engine/extraction/normalization';
import {replayDocumentReview} from '@/engine/document-review/service';
import {documentReviewCalculationInputSchema,type DocumentReviewOperand} from '@/engine/document-review/calculations';
import {parseDocumentReviewSourceLocator,deferredDocumentReviewRowPriceOperands} from '@/engine/document-review/source-dependencies';
import {parseReviewCompletionInput,reviewCompletionTargetSchema,type ReviewCompletionTarget} from '@/engine/document-review/completions';
import {documentReadingTargetSchema,type DocumentReadingTarget} from './document-field-confirmation';
import {parseDocumentFieldAnswer,validateDocumentReadingAnswerForTarget} from './reading-verification';

export type ExistingFieldReadingRequest=Readonly<{request_id:string;code:string;target:DocumentReadingTarget;source_current:boolean;answered_at:string|null;answer_text?:string|null;expires_at:string;expired_at?:string|null}>;
export type ReviewFieldCoverage=Readonly<{target_sha256:string;fact_key:string;field_request_id:string;reading_state?:'unresolved_answer'}&({candidate_id:string;source_scope?:string}|{component_id:string;cell:'quantity'|'rate'|'amount'|'percentage'}|{transcription_kind:'reported_work_hours'}|{transcription_kind:'balance_unit';candidate_id:string})>;
function unresolvedAnswer(text:string|null|undefined){try{const answer=parseDocumentFieldAnswer(text);return answer.action==='unknown'||answer.action==='unreadable';}catch{return false;}}
const rowLocator=z.object({component_ids:z.array(z.uuid()).min(1),candidate_id:z.uuid().nullable(),raw:z.string().nullable(),original_raw:z.string().nullable(),
 source:candidateSourceSchema,semantic_kind:normalizedAdditionalComponentSchema.shape.semantic_kind}).passthrough();
function coversOperand(operand:DocumentReviewOperand,target:DocumentReadingTarget,phase:'pending'|'identified'='pending',effectiveRaw?:string):boolean{
 const rawFor=(raw:string|null)=>effectiveRaw??raw;
 if(target.schema_version==='document-source-transcription-v1'){
  const subject=target.subject,locator=parseDocumentReviewSourceLocator(operand.source.locator);
  return subject.kind==='reported_work_hours'&&operand.id==='reported.hours'
   &&(phase==='identified'?operand.source.reading==='identified_document_reading'&&operand.state==='observed'
    :operand.source.reading==='provider_extraction'&&['missing','unknown','unreadable','conflict'].includes(operand.state))&&operand.source.document_id===target.version_id
   &&operand.source.version_id===target.version_id&&operand.source.file_sha256===target.source_sha256&&operand.source.page===subject.page
   &&!!locator&&'transcription_kind'in locator&&locator.transcription_kind===subject.kind&&locator.page===subject.page&&locator.meaning===subject.meaning
   &&(phase==='identified'?locator.target_sha256===target.target_sha256:!locator.target_sha256||locator.target_sha256===target.target_sha256);
 }
 const targetSource=target.schema_version==='document-field-confirmation-v1'?target.candidate.source
  :target.schema_version==='document-row-cell-confirmation-v1'?target.original_component.source:target.original_observation.candidate.source;
 if((phase==='identified'?operand.source.reading!=='identified_document_reading'||operand.state!=='observed'
   :operand.source.reading!=='provider_extraction'||!['unknown','unreadable','conflict'].includes(operand.state))
  ||operand.source.document_id!==target.version_id||operand.source.version_id!==target.version_id||operand.source.file_sha256!==target.source_sha256
  ||operand.source.page!==targetSource.page)return false;
 const versioned=parseDocumentReviewSourceLocator(operand.source.locator);
 if(versioned){
  if(target.schema_version==='document-row-cell-confirmation-v1'){
   const row=target.original_component;
   return 'component_ids'in versioned&&versioned.component_ids.length===1&&versioned.component_ids[0]===row.component_id
    &&versioned.cell===target.cell&&operand.observation_id===`${row.component_id}:${target.cell}`
    &&versioned.original_component_sha256[0]===canonicalSha256(row)&&versioned.raw_values[0]===rawFor(row[`${target.cell}_raw`]);
  }
  if(target.schema_version==='document-source-scope-confirmation-v1'){
   const observation=target.original_observation,candidate=observation.candidate;
   return 'scope'in versioned&&versioned.scope===observation.scope&&versioned.candidate_ids.length===1&&versioned.candidate_ids[0]===candidate.candidate_id
    &&operand.observation_id===candidate.candidate_id&&versioned.scope_observation_sha256[0]===canonicalSha256(observation)&&versioned.raw_values[0]===rawFor(candidate.raw_value);
  }
  const candidate=target.candidate;
  if('component_ids'in versioned)return versioned.component_ids.length===1
   &&operand.observation_id===`${versioned.component_ids[0]}:${versioned.cell}`
   &&versioned.mapped_candidate?.candidate_id===candidate.candidate_id&&versioned.mapped_candidate.candidate_sha256===canonicalSha256(candidate)
   &&(phase==='pending'||versioned.raw_values[0]===rawFor(candidate.raw_value));
  return 'field'in versioned&&versioned.field===candidate.field&&versioned.candidate_ids.length===1&&versioned.candidate_ids[0]===candidate.candidate_id
   &&operand.observation_id===candidate.candidate_id&&versioned.candidate_sha256[0]===canonicalSha256(candidate)&&versioned.raw_values[0]===rawFor(candidate.raw_value);
 }
 if(target.schema_version==='document-source-scope-confirmation-v1')return false;
 if(target.schema_version==='document-row-cell-confirmation-v1'){
  let parsed:unknown;try{parsed=JSON.parse(operand.source.locator);}catch{return false;}
  const locator=rowLocator.safeParse(parsed);if(!locator.success)return false;
  const row=target.original_component,value=locator.data;
  return operand.id===target.cell&&operand.observation_id===`${row.component_id}:${target.cell}`
   &&value.component_ids.length===1&&value.component_ids[0]===row.component_id
   &&value.candidate_id===null&&value.raw===rawFor(row[`${target.cell}_raw`])&&value.original_raw===row[`${target.cell}_raw`]
   &&value.semantic_kind===row.semantic_kind&&canonicalSha256(value.source)===canonicalSha256(row.source);
 }
 if(operand.observation_id===target.candidate.candidate_id){
  let value:unknown;try{value=JSON.parse(operand.source.locator);}catch{return false;}
  const scalar=z.object({field:z.string(),candidate_ids:z.array(z.uuid()).length(1),observations:z.array(z.object({candidate_id:z.uuid(),raw:z.string().nullable(),original:z.string().nullable(),source:candidateSourceSchema}).passthrough()).length(1)}).safeParse(value);
  if(!scalar.success)return false;
  const observation=scalar.data.observations[0];
  return scalar.data.field===target.candidate.field&&scalar.data.candidate_ids[0]===target.candidate.candidate_id
   &&observation.candidate_id===target.candidate.candidate_id&&observation.original===target.candidate.raw_value
   &&observation.raw===rawFor(target.candidate.raw_value)&&canonicalSha256(observation.source)===canonicalSha256(target.candidate.source);
 }
 // Row operands retain a JSON source locator. Truncated/legacy/unmapped
 // locators cannot establish coverage and remain explicit requests.
 let parsed:unknown;try{parsed=JSON.parse(operand.source.locator);}catch{return false;}
 const locator=rowLocator.safeParse(parsed);if(!locator.success)return false;
 const cell=operand.id;if(!['quantity','rate','amount','percentage'].includes(cell))return false;
 const value=locator.data;
 if(value.original_raw===null||!value.source.text_fragment||!value.component_ids.some(id=>operand.observation_id===`${id}:${cell}`))return false;
 const row={semantic_kind:value.semantic_kind,source_label:value.source.text_fragment,source:value.source,
  quantity_raw:null,rate_raw:null,amount_raw:null,percentage_raw:null,[`${cell}_raw`]:value.original_raw};
 const match=mappedRowCellCandidate({fields:[target.candidate],row,cell:cell as MappedRowCell});
 return match?.candidate_id===target.candidate.candidate_id;
}

/** Consolidates ACTIONS, never confirms a value or modifies a hashed request.
 * Each supplied field target must already have passed the current-source DB
 * boundary. The complete replayed review remains unchanged and fully blocked. */
export function reviewRequestsCoveredByFieldReadings(input:{review:unknown;fieldRequests:readonly ExistingFieldReadingRequest[];nowMs:number}):readonly ReviewFieldCoverage[]{
 const review=replayDocumentReview(input.review);if(!Number.isFinite(input.nowMs))throw Error('REVIEW_FIELD_COVERAGE_TIME');
 const available=input.fieldRequests.filter(row=>row.source_current&&(row.answered_at===null||unresolvedAnswer(row.answer_text))&&!row.expired_at&&Date.parse(row.expires_at)>input.nowMs)
  .map(row=>{const target=documentReadingTargetSchema.parse(row.target);
   if(row.code!==`document_field:${target.target_sha256}`||target.case_id!==review.case_id)throw Error('REVIEW_FIELD_COVERAGE_TARGET');
   return {...row,target};});
 const result:ReviewFieldCoverage[]=[];
 const requests=[...new Map([...review.completions.customer_requests,...review.input.answer_history.map(h=>h.request)].map(r=>[r.target.target_sha256,r])).values()];
 for(const request of requests){
  const target=request.target;
  if(target.kind==='factual'&&target.answer_kind==='text'&&target.required_evidence_kind==='observed_reading'){
   const matches=available.filter(row=>{
    const reading=row.target;if(reading.schema_version!=='document-source-transcription-v1'||reading.subject.kind!=='balance_unit')return false;
    const subject=reading.subject,index=review.documents.findIndex(d=>d.version_id===reading.version_id&&d.file_sha256===reading.source_sha256);
    const key=`document.${index}.balance.${subject.original_candidate.field}.unit`;
    if(index<0||target.fact_key!==key||request.dependent_check_ids.length!==1||request.dependent_check_ids[0]!==key
     ||target.period.from.slice(0,7)!==reading.month||target.period.to.slice(0,7)!==reading.month||target.source_pins.length!==1
     ||target.source_pins[0].case_id!==reading.case_id||target.source_pins[0].version_id!==reading.version_id||target.source_pins[0].source_sha256!==reading.source_sha256)return false;
    const inventory=review.input.source_observation_inventory?.find(i=>i.document_id===review.documents[index].document_id&&i.version_id===reading.version_id
     &&i.source_sha256===reading.source_sha256&&i.reading_sha256===review.documents[index].reading_sha256
     &&i.checkpoint_result_sha256===reading.extraction_result_sha256&&i.original_pass_sha256===subject.first_pass_extraction_sha256);
    return !!inventory&&inventory.observations.filter(o=>o.candidate_id===subject.original_candidate.candidate_id).length===1
     &&inventory.observations.some(o=>canonicalSha256(o)===canonicalSha256(subject.original_candidate))
     &&review.coverage_gaps.some(g=>g.check_id===key&&g.kind==='missing_fact'&&g.source_pins?.length===1
      &&g.source_pins[0].case_id===reading.case_id&&g.source_pins[0].version_id===reading.version_id&&g.source_pins[0].source_sha256===reading.source_sha256);
   });
   if(matches.length===1){const match=matches[0];if(match.target.schema_version==='document-source-transcription-v1'&&match.target.subject.kind==='balance_unit')
    result.push({target_sha256:target.target_sha256,fact_key:target.fact_key,field_request_id:match.request_id,...(match.answered_at!==null?{reading_state:'unresolved_answer' as const}:{}),transcription_kind:'balance_unit',candidate_id:match.target.subject.original_candidate.candidate_id});}
   continue;
  }
  if(target.kind!=='factual'||target.answer_kind!=='number'||target.required_evidence_kind!=='observed_reading')continue;
  const bindings=review.input.answer_bindings.filter(b=>b.fact_key===target.fact_key);
  if(bindings.length!==1)continue;
  const binding=bindings[0],check=review.input.checks.find(c=>c.check_id===binding.check_id);
  if(!check||request.dependent_check_ids.length!==1||request.dependent_check_ids[0]!==binding.check_id)continue;
  const history=[...review.input.answer_history].reverse().find(h=>h.request.target.target_sha256===target.target_sha256);
  const original=history?.original_checks.find(c=>c.check_id===binding.check_id);
  const calculation=documentReviewCalculationInputSchema.parse(original??check.calculation),operand=calculation.operands.find(o=>o.id===binding.operand_id);
  if(!operand)continue;
  const matches=available.filter(row=>target.period.from.slice(0,7)===row.target.month&&target.period.to.slice(0,7)===row.target.month
   &&target.source_pins.length===1&&target.source_pins[0].case_id===row.target.case_id&&target.source_pins[0].version_id===row.target.version_id
   &&target.source_pins[0].source_sha256===row.target.source_sha256&&coversOperand(operand,row.target));
  if(matches.length!==1)continue;
  const match=matches[0];if(match.target.schema_version==='document-source-transcription-v1'&&match.target.subject.kind!=='reported_work_hours')continue;
  const subject=match.target.schema_version==='document-source-transcription-v1'?{transcription_kind:'reported_work_hours' as const}
   :match.target.schema_version==='document-field-confirmation-v1'?{candidate_id:match.target.candidate.candidate_id}
   :match.target.schema_version==='document-row-cell-confirmation-v1'?{component_id:match.target.original_component.component_id,cell:match.target.cell}
    :{candidate_id:match.target.original_observation.candidate.candidate_id,source_scope:match.target.original_observation.scope};
  result.push({target_sha256:target.target_sha256,fact_key:target.fact_key,field_request_id:match.request_id,...(match.answered_at!==null?{reading_state:'unresolved_answer' as const}:{}),...subject});
 }
 if(new Set(result.map(r=>r.target_sha256)).size!==result.length)throw Error('REVIEW_FIELD_COVERAGE_AMBIGUOUS');
 // Do not deduplicate the immutable engine need inventory or its calculation.
 return deepFreeze(result);
}

/** Optional presentation projection. This is deliberately narrower than a
 * general dependency analyser: unfamiliar needs, locators or legal operations
 * preserve the action. It never closes the request or changes its authority. */
const pensionRatioFields=new Set(['pension_base','pension_employee_contribution','pension_employer_contribution','severance_contribution']);
export const REVIEW_DEFERRABLE_SCALAR_FIELDS=['salary_type','pension_employee_rate','pension_employer_rate','severance_rate','vacation_balance','sick_balance',
 'pension_base','pension_employee_contribution','pension_employer_contribution','severance_contribution'] as const;
export function reviewFieldRequestsNotRequired(input:{review:unknown;fieldRequests:readonly ExistingFieldReadingRequest[];nowMs:number}){
 const review=replayDocumentReview(input.review),planner=parseReviewCompletionInput(review.input.completion_input);
 if(!Number.isFinite(input.nowMs))throw Error('REVIEW_FIELD_COVERAGE_TIME');
 if(review.input.coverage_policy!=='document-review-coverage-v1'||!review.checks.length)return [];
 // Period, financial-source totals, hours and mapped payment fields stay
 // active. Pension amounts additionally require a proven inactive ratio use.
 const eligible=new Set<string>(REVIEW_DEFERRABLE_SCALAR_FIELDS);
 return deepFreeze(input.fieldRequests.flatMap(request=>{
  if(!request.source_current||request.answered_at!==null||request.expired_at||Date.parse(request.expires_at)<=input.nowMs)return [];
  const target=documentReadingTargetSchema.parse(request.target);
  if(target.case_id!==review.case_id||request.code!==`document_field:${target.target_sha256}`)throw Error('REVIEW_FIELD_COVERAGE_TARGET');
  const rowPrice=target.schema_version==='document-row-cell-confirmation-v1'&&(target.cell==='rate'||target.cell==='percentage');
  if(!(target.schema_version==='document-field-confirmation-v1'&&eligible.has(target.candidate.field)||rowPrice)
   ||review.period.from.slice(0,7)!==target.month||review.period.to.slice(0,7)!==target.month)return [];
  const document=review.documents.find(d=>d.version_id===target.version_id&&d.file_sha256===target.source_sha256
   &&(d.document_id===target.version_id||d.document_id===target.product_document_id));
  if(!document||document.kind!=='payslip')return [];
  const matchesPin=(pin:{version_id:string;source_sha256:string})=>pin.version_id===target.version_id&&pin.source_sha256===target.source_sha256;
  const explicitPeriod=document.period?.from===review.period.from&&document.period.to===review.period.to;
  // Imported source metadata can have no period even after the separate,
  // source-bound four-cell financial review has established it. Never replace
  // a conflicting recorded period or infer a month from calculation existence.
  const financialPeriod=document.period===null&&planner.documents.some(d=>d.kind==='payslip'&&d.review==='partial'
   &&d.pin.case_id===target.case_id&&matchesPin(d.pin)&&d.period?.from===review.period.from&&d.period.to===review.period.to
   &&d.review_completed_fact_keys?.includes('payslip.financial_source'))
   &&planner.evidence.some(e=>e.fact_key==='payslip.financial_source'&&e.origin==='document'&&e.state==='observed'&&e.source_reviewed
    &&e.case_id===target.case_id&&e.period!==null&&e.period.from===review.period.from&&e.period.to===review.period.to&&e.source_pins.length===1&&matchesPin(e.source_pins[0]));
  if(!explicitPeriod&&!financialPeriod)return [];
  const sameDocumentSource=(source:DocumentReviewOperand['source'])=>source.document_id===document.document_id&&source.version_id===document.version_id
   &&source.file_sha256===document.file_sha256&&source.reading_receipt_sha256===document.reading_sha256;
  const needs=planner.needs.filter(n=>!n.source_pins.length||n.source_pins.some(matchesPin));
  const sourceIndex=review.documents.indexOf(document);
  const currentRows=input.fieldRequests.filter(r=>r.source_current&&r.target.case_id===target.case_id&&r.target.version_id===target.version_id&&r.target.source_sha256===target.source_sha256)
   .flatMap(r=>r.target.schema_version==='document-row-cell-confirmation-v1'?[r.target.original_component]:[]);
  const uniqueRows=[...new Map(currentRows.map(r=>[r.component_id,r])).values()];
  if(currentRows.some(row=>uniqueRows.some(other=>other.component_id===row.component_id&&canonicalSha256(row)!==canonicalSha256(other))))return [];
  const deferredPrices=new Map(review.checks.map(check=>[check.check_id,deferredDocumentReviewRowPriceOperands(check.calculation.input,{document_id:document.document_id,additional_components:uniqueRows})]));
  const blankGap=(checkId:string)=>review.coverage_gaps.some(g=>g.check_id===`${checkId}.blank_basis`&&g.kind==='missing_fact'
   &&g.source_pins?.length===1&&g.source_pins.every(matchesPin));
  const isBlankBasisNeed=(need:typeof needs[number],checkId:string)=>need.kind==='factual'&&need.answer_kind==='text'
   &&need.required_evidence_kind==='observed_reading'&&need.fact_key===`${checkId}.missing_basis`
   &&need.dependent_check_ids.length===2&&need.dependent_check_ids.includes(checkId)&&need.dependent_check_ids.includes(`${checkId}.blank_basis`)
   &&need.source_pins.length===1&&need.source_pins.every(matchesPin)
   &&blankGap(checkId)&&(deferredPrices.get(checkId)?.size??0)>0&&!review.input.answer_bindings.some(b=>b.fact_key===need.fact_key);
  if(target.schema_version==='document-row-cell-confirmation-v1'){
   let uses=0;
   for(const check of review.checks)for(const operand of check.calculation.input.operands){
    if(!coversOperand(operand,target))continue;
    uses++;
    if(!blankGap(check.check_id)||!deferredPrices.get(check.check_id)?.has(operand.id)
     ||needs.some(n=>n.dependent_check_ids.includes(check.check_id)&&!isBlankBasisNeed(n,check.check_id)&&(!review.input.answer_bindings.some(b=>b.fact_key===n.fact_key&&b.check_id===check.check_id)
      ||review.input.answer_bindings.some(b=>b.fact_key===n.fact_key&&b.check_id===check.check_id&&b.operand_id===operand.id))))return [];
   }
   return uses?[{field_request_id:request.request_id,reason:'no_current_check_dependency' as const}]:[];
  }
  if(target.schema_version!=='document-field-confirmation-v1')return [];
  const inactiveRatios=new Set(review.checks.filter(check=>{
   const operation=check.calculation.input.operation;
   return check.topic==='pension'&&operation.kind==='observed_ratio'&&!operation.same_period_and_base
    &&check.calculation.state==='blocked'&&check.calculation.blockers.some(b=>b.reason==='ratio_period_or_base_unresolved')
    &&check.calculation.input.operands.every(o=>sameDocumentSource(o.source))
    &&!needs.some(n=>n.dependent_check_ids.includes(check.check_id))
    &&review.coverage_gaps.some(g=>g.check_id===`${check.check_id}.relationship`&&g.kind==='missing_fact'&&g.topic==='pension'
     &&g.source_pins?.length===1&&g.source_pins.every(matchesPin));
  }).map(check=>check.check_id));
  const summaryCheck=review.checks.find(check=>check.check_id===`document.${sourceIndex}.gross.net`&&check.topic==='minimum_wage');
  const summaryOperation=summaryCheck?.calculation.input.operation;
  const standaloneTotals=summaryOperation?.kind==='reconciliation'&&summaryOperation.inventory_complete&&summaryOperation.disjoint_components
   &&summaryOperation.add_refs.length===1&&summaryOperation.add_refs[0]==='gross'&&summaryOperation.subtract_refs.length===1&&summaryOperation.subtract_refs[0]==='deductions'
   &&summaryOperation.recorded_ref==='net'&&summaryCheck!.calculation.input.operands.length===3
   &&summaryCheck!.calculation.input.operands.every(operand=>{
    const locator=parseDocumentReviewSourceLocator(operand.source.locator);
    return sameDocumentSource(operand.source)&&!!locator&&'field'in locator
     &&({gross:'gross_salary',deductions:'total_deductions',net:'net_salary'} as Record<string,string>)[operand.id]===locator.field;
   });
  const knownStructuralGap=(gap:typeof review.coverage_gaps[number])=>gap.source_pins?.length===1&&gap.source_pins.every(matchesPin)&&gap.kind==='missing_fact'
   &&(gap.topic==='pension'&&inactiveRatios.has(gap.check_id.replace(/\.relationship$/u,''))&&gap.check_id.endsWith('.relationship')
    ||gap.check_id.endsWith('.blank_basis')&&(deferredPrices.get(gap.check_id.slice(0,-'.blank_basis'.length))?.size??0)>0
    ||gap.topic==='minimum_wage'&&standaloneTotals&&gap.check_id===`document.${sourceIndex}.deductions.grouping`
     &&!review.checks.some(check=>check.check_id===gap.check_id)&&!needs.some(n=>n.dependent_check_ids.includes(gap.check_id)));
  for(const need of needs){
   if(need.kind==='legal'||need.kind==='ownership')continue;
   if(need.kind!=='factual')return [];
   if(review.checks.some(check=>isBlankBasisNeed(need,check.check_id)))continue;
   const binding=review.input.answer_bindings.find(b=>b.fact_key===need.fact_key);
   if(binding&&need.dependent_check_ids.length===1&&need.dependent_check_ids[0]===binding.check_id
    &&review.checks.some(c=>c.check_id===binding.check_id&&c.calculation.input.operands.some(o=>o.id===binding.operand_id)))continue;
   const balance=review.coverage_inventory?.unresolved_source_observations.find(o=>o.document_id===document.document_id&&o.version_id===document.version_id
    &&need.fact_key.endsWith(`.balance.${o.field}.unit`)&&need.dependent_check_ids.length===1&&need.dependent_check_ids[0]===need.fact_key);
   if(!balance||balance.field===target.candidate.field)return [];
  }
  if(review.coverage_gaps.some(g=>g.kind!=='missing_rule'&&(!g.source_pins?.length||g.source_pins.some(matchesPin))
   &&!needs.some(n=>n.dependent_check_ids.includes(g.check_id))&&!knownStructuralGap(g)))return [];
  let documentOperands=0,inactivePensionUse=false;
  for(const check of review.checks){
   if(check.calculation.input.operation.kind==='candidate_rule')return [];
   for(const operand of check.calculation.input.operands){
    if(operand.source.version_id!==document.version_id)continue;
    if(operand.source.file_sha256!==document.file_sha256)return [];
    documentOperands++;
    const locator=parseDocumentReviewSourceLocator(operand.source.locator);if(!locator)return [];
    if('field'in locator&&(locator.field===target.candidate.field||locator.candidate_ids.includes(target.candidate.candidate_id))){
     if(!inactiveRatios.has(check.check_id)||!pensionRatioFields.has(target.candidate.field)||locator.candidate_ids.length!==1
      ||locator.field!==target.candidate.field||locator.candidate_ids[0]!==target.candidate.candidate_id||locator.candidate_sha256[0]!==canonicalSha256(target.candidate)
      ||locator.raw_values[0]!==target.candidate.raw_value)return [];
     inactivePensionUse=true;
    }
    if('scope'in locator&&locator.candidate_ids.includes(target.candidate.candidate_id))return [];
    if('component_ids'in locator&&locator.mapped_candidate?.candidate_id===target.candidate.candidate_id)return [];
   }
  }
  return documentOperands&&(!pensionRatioFields.has(target.candidate.field)||inactivePensionUse)?[{field_request_id:request.request_id,reason:'no_current_check_dependency' as const}]:[];
 }));
}

/** Customer-facing check names are derived from the exact current review
 * operands, never inferred from a row label or scalar-like field name. */
export function reviewFieldReadingCheckLabels(input:{review:unknown;fieldRequests:readonly ExistingFieldReadingRequest[];nowMs:number}){
 const review=replayDocumentReview(input.review);
 if(!Number.isFinite(input.nowMs))throw Error('REVIEW_FIELD_COVERAGE_TIME');
 return deepFreeze(input.fieldRequests.filter(request=>request.source_current&&request.answered_at===null&&!request.expired_at&&Date.parse(request.expires_at)>input.nowMs).map(request=>{
  const target=documentReadingTargetSchema.parse(request.target);
  if(target.case_id!==review.case_id||request.code!==`document_field:${target.target_sha256}`)throw Error('REVIEW_FIELD_COVERAGE_TARGET');
  const titles=review.input.checks.filter(check=>{
   if(review.checks.find(result=>result.check_id===check.check_id)?.calculation.state!=='blocked')return false;
   const calculation=documentReviewCalculationInputSchema.parse(check.calculation);
   if(calculation.operation.kind==='observed_ratio'&&!calculation.operation.same_period_and_base)return false;
   return calculation.period.from.slice(0,7)===target.month&&calculation.period.to.slice(0,7)===target.month
    &&calculation.operands.some(operand=>coversOperand(operand,target));
  }).map(check=>check.title);
  return {field_request_id:request.request_id,check_titles:[...new Set(titles)]};
 }));
}

export type ExistingGenericReviewRequest=Readonly<{request_id:string;code:string;target:ReviewCompletionTarget;source_current:boolean;answered_at:string|null;expires_at:string}>;
function acceptedIdentifiedAnswer(operand:DocumentReviewOperand,field:ExistingFieldReadingRequest){
 try{
  const target=field.target,answer=validateDocumentReadingAnswerForTarget(target,field.answer_text);
  if(answer.action!=='confirm'&&answer.action!=='correct')return false;
  const raw=answer.action==='correct'?answer.corrected_raw_value:target.schema_version==='document-field-confirmation-v1'?target.candidate.raw_value
   :target.schema_version==='document-row-cell-confirmation-v1'?target.original_component[`${target.cell}_raw`]
    :target.schema_version==='document-source-scope-confirmation-v1'?target.original_observation.candidate.raw_value:null;
  if(raw===null||!coversOperand(operand,target,'identified',raw)||operand.printed_value===null)return false;
  const scalarRaw=target.schema_version==='document-field-confirmation-v1'?Object.fromEntries(Object.entries(target.candidate).filter(([key])=>key!=='normalized_value')):null;
  const value=target.schema_version==='document-row-cell-confirmation-v1'?normalizeDocumentRowCellValue(target.cell,raw)
   :target.schema_version==='document-source-scope-confirmation-v1'?normalizeDocumentScopeObservationValue(target.original_observation,raw)
    :target.schema_version==='document-source-transcription-v1'?normalizeSourceTranscriptionValue(target.subject,raw)
     :normalizePayslipFieldValue(rawCandidateFieldSchema.parse({...scalarRaw,raw_value:raw}));
  if(value===null)return false;
  const expected=typeof value==='object'&&'amount'in value?value.amount:value;
  const actual=operand.representation==='money_ils'?normalizeMoney(operand.printed_value)
   :operand.representation==='decimal_quantity'?normalizeDecimal(operand.printed_value)
    :operand.representation==='percent'?normalizePercentage(operand.printed_value):null;
  return actual!==null&&canonicalSha256(expected)===canonicalSha256(actual);
 }catch{return false;}
}
/** A previous generic question can outlive the need that created it. Link it
 * only through its exact generated fact key and current source operand, never
 * through question wording or an equal amount. No answer is manufactured. */
export function reviewHistoricalRequestProjection(input:{review:unknown;reviewRequests:readonly ExistingGenericReviewRequest[];fieldRequests:readonly ExistingFieldReadingRequest[];nowMs:number}){
 const review=replayDocumentReview(input.review);
 if(review.input.coverage_policy!=='document-review-coverage-v1'||!Number.isFinite(input.nowMs))return [];
 const deferred=new Set(reviewFieldRequestsNotRequired(input).map(r=>r.field_request_id));
 return deepFreeze(input.reviewRequests.flatMap(request=>{
  if(!request.source_current||request.answered_at!==null||Date.parse(request.expires_at)<=input.nowMs)return [];
  const target=reviewCompletionTargetSchema.parse(request.target);
  if(request.code!==`document_review:${target.target_sha256}`||target.case_id!==review.case_id)throw Error('REVIEW_FIELD_COVERAGE_TARGET');
  if(target.kind!=='factual'||target.answer_kind!=='number'||target.required_evidence_kind!=='observed_reading'||target.source_pins.length!==1
   ||target.period.from!==review.period.from||target.period.to!==review.period.to)return [];
  const operands=review.checks.flatMap(check=>check.calculation.input.operands.filter(o=>target.fact_key===`${check.check_id}.${o.id}`));
  if(operands.length!==1)return [];
  const operand=operands[0],pin=target.source_pins[0];
  const locator=parseDocumentReviewSourceLocator(operand.source.locator);
  if(locator&&'component_ids'in locator&&['quantity','amount','rate','percentage'].includes(locator.cell)){
   const check=review.checks.find(c=>target.fact_key===`${c.check_id}.${operand.id}`)!;
   const samePin=(other:typeof pin)=>canonicalSha256(other)===canonicalSha256(pin);
   const rows=input.fieldRequests.filter(f=>f.source_current&&f.target.case_id===target.case_id&&f.target.version_id===pin.version_id
    &&f.target.source_sha256===pin.source_sha256&&f.code===`document_field:${f.target.target_sha256}`)
    .flatMap(f=>f.target.schema_version==='document-row-cell-confirmation-v1'?[documentReadingTargetSchema.parse(f.target)]:[])
    .flatMap(t=>t.schema_version==='document-row-cell-confirmation-v1'?[t.original_component]:[]);
   const unique=[...new Map(rows.map(row=>[row.component_id,row])).values()];
   const consistent=rows.every(row=>unique.every(other=>other.component_id!==row.component_id||canonicalSha256(row)===canonicalSha256(other)));
   const replacementKey=`${check.check_id}.missing_basis`;
   const operation=check.calculation.input.operation,price=operation.kind==='product'?check.calculation.input.operands.find(o=>o.id===operation.money_ref):null;
   const priceLocator=price?parseDocumentReviewSourceLocator(price.source.locator):null;
   const currentRequests=[...review.completions.customer_requests,...review.input.answer_history.map(h=>h.request)];
   const replacements=input.reviewRequests.filter(r=>r.source_current&&Date.parse(r.expires_at)>input.nowMs&&r.code===`document_review:${r.target.target_sha256}`
    &&r.target.case_id===target.case_id&&r.target.kind==='factual'&&r.target.answer_kind==='text'&&r.target.required_evidence_kind==='observed_reading'
    &&r.target.fact_key===replacementKey&&canonicalSha256(r.target.period)===canonicalSha256(target.period)
    &&r.target.source_pins.length===1&&samePin(r.target.source_pins[0])
    &&currentRequests.some(c=>c.target.target_sha256===r.target.target_sha256&&c.dependent_check_ids.length===2
     &&c.dependent_check_ids.includes(check.check_id)&&c.dependent_check_ids.includes(`${check.check_id}.blank_basis`)));
   if(consistent&&replacements.length===1&&operand.source.version_id===pin.version_id&&operand.source.file_sha256===pin.source_sha256
    &&priceLocator&&'component_ids'in priceLocator&&canonicalSha256(priceLocator.component_ids)===canonicalSha256(locator.component_ids)
    &&canonicalSha256(priceLocator.original_component_sha256)===canonicalSha256(locator.original_component_sha256)
    &&deferredDocumentReviewRowPriceOperands(check.calculation.input,{document_id:operand.source.document_id,additional_components:unique}).size>0
    &&review.coverage_gaps.some(g=>g.check_id===`${check.check_id}.blank_basis`&&g.kind==='missing_fact'&&g.source_pins?.length===1&&samePin(g.source_pins[0])))
    return [{request_id:request.request_id,field_request_id:replacements[0].request_id,replacement_request_id:replacements[0].request_id,state:'not_required' as const}];
  }
  const matches=input.fieldRequests.filter(field=>{
   if(!field.source_current||field.target.case_id!==target.case_id||field.target.version_id!==pin.version_id||field.target.source_sha256!==pin.source_sha256
    ||field.target.month!==target.period.from.slice(0,7)||field.code!==`document_field:${field.target.target_sha256}`)return false;
   documentReadingTargetSchema.parse(field.target);
   return deferred.has(field.request_id)&&coversOperand(operand,field.target)
    ||field.answered_at!==null&&acceptedIdentifiedAnswer(operand,field);
  });
  if(matches.length!==1)return [];
  const field=matches[0];
  return [{request_id:request.request_id,field_request_id:field.request_id,state:deferred.has(field.request_id)?'not_required' as const:'already_read' as const}];
 }));
}
