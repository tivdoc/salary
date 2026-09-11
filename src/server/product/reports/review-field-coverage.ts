import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {candidateSourceSchema} from '@/engine/extraction/contracts';
import {normalizedAdditionalComponentSchema} from '@/engine/extraction/payslip';
import {mappedRowCellCandidate,type MappedRowCell} from '@/engine/extraction/reading-resolution';
import {replayDocumentReview} from '@/engine/document-review/service';
import {documentReviewCalculationInputSchema,type DocumentReviewOperand} from '@/engine/document-review/calculations';
import {documentFieldTargetSchema,type DocumentFieldTarget} from './document-field-confirmation';

export type ExistingFieldReadingRequest=Readonly<{request_id:string;code:string;target:DocumentFieldTarget;source_current:boolean;answered_at:string|null;expires_at:string;expired_at?:string|null}>;
export type ReviewFieldCoverage=Readonly<{target_sha256:string;fact_key:string;field_request_id:string;candidate_id:string}>;
const rowLocator=z.object({component_ids:z.array(z.uuid()).min(1),candidate_id:z.uuid().nullable(),raw:z.string().nullable(),original_raw:z.string().nullable(),
 source:candidateSourceSchema,semantic_kind:normalizedAdditionalComponentSchema.shape.semantic_kind}).passthrough();
function coversOperand(operand:DocumentReviewOperand,target:DocumentFieldTarget):boolean{
 if(operand.source.reading!=='provider_extraction'||!['unknown','unreadable','conflict'].includes(operand.state)
  ||operand.source.document_id!==target.version_id||operand.source.version_id!==target.version_id||operand.source.file_sha256!==target.source_sha256
  ||operand.source.page!==target.candidate.source.page)return false;
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
  .map(row=>{const target=documentFieldTargetSchema.parse(row.target);
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
  result.push({target_sha256:target.target_sha256,fact_key:target.fact_key,field_request_id:matches[0].request_id,candidate_id:matches[0].target.candidate.candidate_id});
 }
 if(new Set(result.map(r=>r.target_sha256)).size!==result.length)throw Error('REVIEW_FIELD_COVERAGE_AMBIGUOUS');
 // Do not deduplicate the immutable engine need inventory or its calculation.
 return deepFreeze(result);
}
