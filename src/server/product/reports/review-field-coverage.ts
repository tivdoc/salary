import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {candidateSourceSchema} from '@/engine/extraction/contracts';
import {normalizedAdditionalComponentSchema} from '@/engine/extraction/payslip';
import {mappedRowCellCandidate,type MappedRowCell} from '@/engine/extraction/reading-resolution';
import {replayDocumentReview} from '@/engine/document-review/service';
import {documentReviewCalculationInputSchema,type DocumentReviewOperand} from '@/engine/document-review/calculations';
import {parseDocumentReviewSourceLocator} from '@/engine/document-review/source-dependencies';
import {parseReviewCompletionInput} from '@/engine/document-review/completions';
import {documentReadingTargetSchema,type DocumentReadingTarget} from './document-field-confirmation';

export type ExistingFieldReadingRequest=Readonly<{request_id:string;code:string;target:DocumentReadingTarget;source_current:boolean;answered_at:string|null;expires_at:string;expired_at?:string|null}>;
export type ReviewFieldCoverage=Readonly<{target_sha256:string;fact_key:string;field_request_id:string}&({candidate_id:string;source_scope?:string}|{component_id:string;cell:'quantity'|'rate'|'amount'|'percentage'}|{transcription_kind:'reported_work_hours'})>;
const rowLocator=z.object({component_ids:z.array(z.uuid()).min(1),candidate_id:z.uuid().nullable(),raw:z.string().nullable(),original_raw:z.string().nullable(),
 source:candidateSourceSchema,semantic_kind:normalizedAdditionalComponentSchema.shape.semantic_kind}).passthrough();
function coversOperand(operand:DocumentReviewOperand,target:DocumentReadingTarget):boolean{
 if(target.schema_version==='document-source-transcription-v1'){
  const subject=target.subject,locator=parseDocumentReviewSourceLocator(operand.source.locator);
  return subject.kind==='reported_work_hours'&&operand.id==='reported.hours'&&operand.source.reading==='provider_extraction'
   &&['missing','unknown','unreadable','conflict'].includes(operand.state)&&operand.source.document_id===target.version_id
   &&operand.source.version_id===target.version_id&&operand.source.file_sha256===target.source_sha256&&operand.source.page===subject.page
   &&!!locator&&'transcription_kind'in locator&&locator.transcription_kind===subject.kind&&locator.page===subject.page&&locator.meaning===subject.meaning
   &&(!locator.target_sha256||locator.target_sha256===target.target_sha256);
 }
 const targetSource=target.schema_version==='document-field-confirmation-v1'?target.candidate.source
  :target.schema_version==='document-row-cell-confirmation-v1'?target.original_component.source:target.original_observation.candidate.source;
 if(operand.source.reading!=='provider_extraction'||!['unknown','unreadable','conflict'].includes(operand.state)
  ||operand.source.document_id!==target.version_id||operand.source.version_id!==target.version_id||operand.source.file_sha256!==target.source_sha256
  ||operand.source.page!==targetSource.page)return false;
 const versioned=parseDocumentReviewSourceLocator(operand.source.locator);
 if(versioned){
  if(target.schema_version==='document-row-cell-confirmation-v1'){
   const row=target.original_component;
   return 'component_ids'in versioned&&versioned.component_ids.length===1&&versioned.component_ids[0]===row.component_id
    &&versioned.cell===target.cell&&operand.id===target.cell&&operand.observation_id===`${row.component_id}:${target.cell}`
    &&versioned.original_component_sha256[0]===canonicalSha256(row)&&versioned.raw_values[0]===row[`${target.cell}_raw`];
  }
  if(target.schema_version==='document-source-scope-confirmation-v1'){
   const observation=target.original_observation,candidate=observation.candidate;
   return 'scope'in versioned&&versioned.scope===observation.scope&&versioned.candidate_ids.length===1&&versioned.candidate_ids[0]===candidate.candidate_id
    &&operand.observation_id===candidate.candidate_id&&versioned.scope_observation_sha256[0]===canonicalSha256(observation)&&versioned.raw_values[0]===candidate.raw_value;
  }
  const candidate=target.candidate;
  if('component_ids'in versioned)return versioned.component_ids.length===1&&versioned.cell===operand.id
   &&operand.observation_id===`${versioned.component_ids[0]}:${versioned.cell}`
   &&versioned.mapped_candidate?.candidate_id===candidate.candidate_id&&versioned.mapped_candidate.candidate_sha256===canonicalSha256(candidate);
  return 'field'in versioned&&versioned.field===candidate.field&&versioned.candidate_ids.length===1&&versioned.candidate_ids[0]===candidate.candidate_id
   &&operand.observation_id===candidate.candidate_id&&versioned.candidate_sha256[0]===canonicalSha256(candidate)&&versioned.raw_values[0]===candidate.raw_value;
 }
 if(target.schema_version==='document-source-scope-confirmation-v1')return false;
 if(target.schema_version==='document-row-cell-confirmation-v1'){
  let parsed:unknown;try{parsed=JSON.parse(operand.source.locator);}catch{return false;}
  const locator=rowLocator.safeParse(parsed);if(!locator.success)return false;
  const row=target.original_component,value=locator.data;
  return operand.id===target.cell&&operand.observation_id===`${row.component_id}:${target.cell}`
   &&value.component_ids.length===1&&value.component_ids[0]===row.component_id
   &&value.candidate_id===null&&value.raw===row[`${target.cell}_raw`]&&value.original_raw===row[`${target.cell}_raw`]
   &&value.semantic_kind===row.semantic_kind&&canonicalSha256(value.source)===canonicalSha256(row.source);
 }
 if(operand.observation_id===target.candidate.candidate_id){
  let value:unknown;try{value=JSON.parse(operand.source.locator);}catch{return false;}
  const scalar=z.object({field:z.string(),candidate_ids:z.array(z.uuid()).length(1),observations:z.array(z.object({candidate_id:z.uuid(),raw:z.string().nullable(),original:z.string().nullable(),source:candidateSourceSchema}).passthrough()).length(1)}).safeParse(value);
  if(!scalar.success)return false;
  const observation=scalar.data.observations[0];
  return scalar.data.field===target.candidate.field&&scalar.data.candidate_ids[0]===target.candidate.candidate_id
   &&observation.candidate_id===target.candidate.candidate_id&&observation.original===target.candidate.raw_value
   &&observation.raw===target.candidate.raw_value&&canonicalSha256(observation.source)===canonicalSha256(target.candidate.source);
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
 const available=input.fieldRequests.filter(row=>row.source_current&&row.answered_at===null&&!row.expired_at&&Date.parse(row.expires_at)>input.nowMs)
  .map(row=>{const target=documentReadingTargetSchema.parse(row.target);
   if(row.code!==`document_field:${target.target_sha256}`||target.case_id!==review.case_id)throw Error('REVIEW_FIELD_COVERAGE_TARGET');
   return {...row,target};});
 const result:ReviewFieldCoverage[]=[];
 const requests=[...new Map([...review.completions.customer_requests,...review.input.answer_history.map(h=>h.request)].map(r=>[r.target.target_sha256,r])).values()];
 for(const request of requests){
  const target=request.target;
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
  result.push({target_sha256:target.target_sha256,fact_key:target.fact_key,field_request_id:match.request_id,...subject});
 }
 if(new Set(result.map(r=>r.target_sha256)).size!==result.length)throw Error('REVIEW_FIELD_COVERAGE_AMBIGUOUS');
 // Do not deduplicate the immutable engine need inventory or its calculation.
 return deepFreeze(result);
}

/** Optional presentation projection. This is deliberately narrower than a
 * general dependency analyser: unfamiliar needs, locators or legal operations
 * preserve the action. It never closes the request or changes its authority. */
export const REVIEW_DEFERRABLE_SCALAR_FIELDS=['salary_type','pension_employee_rate','pension_employer_rate','severance_rate','vacation_balance','sick_balance'] as const;
export function reviewFieldRequestsNotRequired(input:{review:unknown;fieldRequests:readonly ExistingFieldReadingRequest[];nowMs:number}){
 const review=replayDocumentReview(input.review),planner=parseReviewCompletionInput(review.input.completion_input);
 if(!Number.isFinite(input.nowMs))throw Error('REVIEW_FIELD_COVERAGE_TIME');
 if(review.input.coverage_policy!=='document-review-coverage-v1'||!review.checks.length)return [];
 // These scalar fields have no implicit mapped-row/financial-source gate.
 // Salary period, money cells, hours and mapped payment fields stay active.
 const eligible=new Set<string>(REVIEW_DEFERRABLE_SCALAR_FIELDS);
 return deepFreeze(input.fieldRequests.flatMap(request=>{
  if(!request.source_current||request.answered_at!==null||request.expired_at||Date.parse(request.expires_at)<=input.nowMs)return [];
  const target=documentReadingTargetSchema.parse(request.target);
  if(target.case_id!==review.case_id||request.code!==`document_field:${target.target_sha256}`)throw Error('REVIEW_FIELD_COVERAGE_TARGET');
  if(target.schema_version!=='document-field-confirmation-v1'||!eligible.has(target.candidate.field)
   ||review.period.from.slice(0,7)!==target.month||review.period.to.slice(0,7)!==target.month)return [];
  const document=review.documents.find(d=>d.version_id===target.version_id&&d.file_sha256===target.source_sha256
   &&(d.document_id===target.version_id||d.document_id===target.product_document_id));
  if(!document||document.kind!=='payslip'||document.period?.from!==review.period.from||document.period.to!==review.period.to)return [];
  const matchesPin=(pin:{version_id:string;source_sha256:string})=>pin.version_id===target.version_id&&pin.source_sha256===target.source_sha256;
  const needs=planner.needs.filter(n=>!n.source_pins.length||n.source_pins.some(matchesPin));
  for(const need of needs){
   if(need.kind==='legal'||need.kind==='ownership')continue;
   if(need.kind!=='factual')return [];
   const binding=review.input.answer_bindings.find(b=>b.fact_key===need.fact_key);
   if(binding&&need.dependent_check_ids.length===1&&need.dependent_check_ids[0]===binding.check_id
    &&review.checks.some(c=>c.check_id===binding.check_id&&c.calculation.input.operands.some(o=>o.id===binding.operand_id)))continue;
   const balance=review.coverage_inventory?.unresolved_source_observations.find(o=>o.document_id===document.document_id&&o.version_id===document.version_id
    &&need.fact_key.endsWith(`.balance.${o.field}.unit`)&&need.dependent_check_ids.length===1&&need.dependent_check_ids[0]===need.fact_key);
   if(!balance||balance.field===target.candidate.field)return [];
  }
  if(review.coverage_gaps.some(g=>g.kind!=='missing_rule'&&(!g.source_pins?.length||g.source_pins.some(matchesPin))
   &&!needs.some(n=>n.dependent_check_ids.includes(g.check_id))))return [];
  let documentOperands=0;
  for(const check of review.checks){
   if(check.calculation.input.operation.kind==='candidate_rule')return [];
   for(const operand of check.calculation.input.operands){
    if(operand.source.version_id!==document.version_id)continue;
    if(operand.source.file_sha256!==document.file_sha256)return [];
    documentOperands++;
    const locator=parseDocumentReviewSourceLocator(operand.source.locator);if(!locator)return [];
    if('field'in locator&&(locator.field===target.candidate.field||locator.candidate_ids.includes(target.candidate.candidate_id)))return [];
    if('scope'in locator&&locator.candidate_ids.includes(target.candidate.candidate_id))return [];
    if('component_ids'in locator&&locator.mapped_candidate?.candidate_id===target.candidate.candidate_id)return [];
   }
  }
  return documentOperands?[{field_request_id:request.request_id,reason:'no_current_check_dependency' as const}]:[];
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
   return calculation.period.from.slice(0,7)===target.month&&calculation.period.to.slice(0,7)===target.month
    &&calculation.operands.some(operand=>coversOperand(operand,target));
  }).map(check=>check.title);
  return {field_request_id:request.request_id,check_titles:[...new Set(titles)]};
 }));
}
