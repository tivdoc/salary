import {canonicalSha256,deepFreeze} from '../rule-runtime/canonical.ts';
import {calculateDocumentReview,documentReviewCalculationInputSchema} from './calculations.ts';
import {generateReviewCompletions,parseReviewCompletionInput,resolveReviewCompletion,type ReviewCompletion} from './completions.ts';
import {DOCUMENT_REVIEW_POLICY,documentReviewInputSchema,type DocumentReviewResult} from './contracts.ts';
import {documentReviewCoverageInventory} from './coverage.ts';

/** A supplemental stage of ordinary case analysis. Results are source arithmetic
 * or conditional candidates, never a substitute for catalog admission. */
export function runDocumentReview(candidate:unknown,analysisRunId:string):DocumentReviewResult{
 const input=documentReviewInputSchema.parse(candidate);
 if(input.period.to<input.period.from)throw Error('REVIEW_PERIOD');
 if(new Set(input.documents.map(d=>d.document_id)).size!==input.documents.length
  ||input.documents.some(d=>d.case_id!==input.case_id))throw Error('REVIEW_DOCUMENT_SCOPE');
 if(new Set(input.checks.map(c=>c.check_id)).size!==input.checks.length)throw Error('REVIEW_DUPLICATE_CHECK');
 const completionInput=parseReviewCompletionInput(input.completion_input);
 if(completionInput.case_id!==input.case_id||canonicalSha256(completionInput.period)!==canonicalSha256(input.period))throw Error('REVIEW_COMPLETION_SCOPE');
 const checks=input.checks.map(check=>{
  if(!input.purchased_scope.topics.includes(check.topic))throw Error('REVIEW_UNPURCHASED_CHECK');
  const calculation=documentReviewCalculationInputSchema.parse(check.calculation);
  if(check.printed_inventory){
   const inventory=check.printed_inventory,operation=calculation.operation;
   if(operation.kind!=='reconciliation'||operation.inventory_basis!==`printed-earnings-inventory-v1:${canonicalSha256(inventory)}`
    ||operation.inventory_complete!==inventory.inventory_complete||operation.disjoint_components!==inventory.disjoint_components
    ||!input.documents.some(d=>d.document_id===inventory.document_id&&d.version_id===inventory.version_id&&d.reading_sha256===inventory.reading_sha256))throw Error('REVIEW_PRINTED_INVENTORY_BINDING');
   const ids=[...inventory.populated_component_ids,...inventory.unresolved_blank_component_ids,...inventory.excluded_deduction_component_ids];
   if(new Set(ids).size!==ids.length)throw Error('REVIEW_PRINTED_INVENTORY_DUPLICATE');
  }
  if(calculation.case_id!==input.case_id||calculation.check_id!==check.check_id
   ||calculation.period.from<input.period.from||calculation.period.to>input.period.to)throw Error('REVIEW_CHECK_SCOPE');
  if(calculation.source_structure){
   const s=calculation.source_structure,document=input.documents.find(d=>d.document_id===s.document_id&&d.version_id===s.version_id);
   if(!document||document.file_sha256!==s.file_sha256||document.reading_sha256!==s.reading_sha256)throw Error('REVIEW_SOURCE_STRUCTURE_READING_CHANGED');
  }
  const citedSources=[...calculation.operands.map(o=>o.source),...(calculation.operation.kind==='candidate_rule'?calculation.operation.decisions.flatMap(d=>d.sources):[])];
  for(const pin of calculation.source_manifest){
   // Identified answers are admitted through the planner, not arbitrary source
   // objects embedded in a caller's calculation. The answer adapter installs
   // their immutable evidence separately before re-evaluation.
   if(pin.kind==='customer_answer'){
    const answer=input.answer_history.find(a=>a.receipt.request_id===pin.document_id&&`${a.receipt.request_id}:${a.receipt.answer_revision}`===pin.version_id&&a.receipt.answer_sha256===pin.file_sha256);
    if(!answer||answer.receipt.case_id!==input.case_id||answer.request.target.required_evidence_kind!=='customer_declaration'
     ||answer.request.target.target_sha256!==answer.receipt.target_sha256
     ||!completionInput.previous_answers?.some(r=>r.answer_sha256===answer.receipt.answer_sha256)
     ||!answer.request.dependent_check_ids.includes(check.check_id))throw Error('REVIEW_ANSWER_ADMISSION_REQUIRED');
    // Re-admit the exact current receipt through the same scoped planner.
    // Retaining history must not make an earlier numeric answer usable again
    // after the customer has replaced it with "unknown" or a correction.
    const receipt=answer.receipt;
    const admitted=resolveReviewCompletion({request:answer.request,current:completionInput,actor:{case_id:input.case_id,identity_id:receipt.identity_id},
     answer:{request_id:receipt.request_id,revision:receipt.answer_revision,answered_at:receipt.answered_at,state:receipt.state,value:receipt.value}});
    if(admitted.state==='stale'||admitted.requires_source_verification||admitted.receipt.answer_sha256!==receipt.answer_sha256)throw Error('REVIEW_ANSWER_ADMISSION_REQUIRED');
    const expectedState=receipt.state==='provided'?(admitted.blocked?'conflict':'declared'):receipt.state==='conflicted'?'conflict':'unknown';
    for(const source of citedSources.filter(s=>s.document_id===pin.document_id))
     if(source.reading_receipt_sha256!==receipt.answer_sha256||source.reading!=='customer_declaration')throw Error('REVIEW_ANSWER_VALUE_MISMATCH');
    for(const operand of calculation.operands.filter(o=>o.source.document_id===pin.document_id)){
     if(operand.printed_value!==(answer.receipt.state==='provided'?String(answer.receipt.value):null)||operand.source.reading_receipt_sha256!==answer.receipt.answer_sha256
      ||operand.source.reading!=='customer_declaration'||operand.state!==expectedState
      ||!input.answer_bindings.some(b=>b.check_id===check.check_id&&b.operand_id===operand.id&&b.fact_key===answer.request.target.fact_key))throw Error('REVIEW_ANSWER_VALUE_MISMATCH');
    }
    continue;
   }
   const source=input.documents.find(d=>d.document_id===pin.document_id&&d.version_id===pin.version_id);
   if(!source||source.file_sha256!==pin.file_sha256||source.page_count!==pin.page_count)throw Error('REVIEW_CHECK_SOURCE_CHANGED');
   // Assessment evidence has the same receipt fence as numeric operands.
   // A manifest hash alone does not authorize an arbitrary new interpretation
   // of a case document or a legal source admitted to this review packet.
   for(const citation of citedSources.filter(s=>s.document_id===pin.document_id)){
    if(!([source.reading_sha256,...(source.accepted_reading_sha256??[])].includes(citation.reading_receipt_sha256)))throw Error('REVIEW_READING_CHANGED');
   }
  }
  const result=calculateDocumentReview({...calculation,run_id:analysisRunId});
  return {check_id:check.check_id,topic:check.topic,title:check.title,explanation:check.explanation,
   ...(check.printed_inventory?{printed_inventory:check.printed_inventory}:{}),
   dependency_sha256:result.dependency_fingerprint,calculation:result};
 });
 for(const d of completionInput.documents){
  if(!input.documents.some(source=>source.document_id===d.pin.document_id&&source.version_id===d.pin.version_id&&source.file_sha256===d.pin.source_sha256))throw Error('REVIEW_COMPLETION_SOURCE_MISMATCH');
 }
 const checkIds=new Set([...checks.map(c=>c.check_id),...input.coverage_gaps.map(g=>g.check_id)]);
 if(input.coverage_gaps.some(g=>!input.purchased_scope.topics.includes(g.topic)))throw Error('REVIEW_UNPURCHASED_GAP');
 for(const need of completionInput.needs)if(need.dependent_check_ids.some(id=>!checkIds.has(id)))throw Error('REVIEW_UNKNOWN_COMPLETION_DEPENDENCY');
 const completions=generateReviewCompletions(completionInput);
 const coverage=documentReviewCoverageInventory(input,checks);
 const seed={input,schema_version:DOCUMENT_REVIEW_POLICY,case_id:input.case_id,analysis_run_id:analysisRunId,input_sha256:canonicalSha256(input),
  period:input.period,purchased_scope:input.purchased_scope,documents:input.documents,coverage_gaps:input.coverage_gaps,checks,completions,
  ...(coverage?{coverage_inventory:coverage}:{}),
  legal_debt_total:null,actual_transfer_proven:false as const,publication_authority:false as const};
 return deepFreeze({...seed,result_sha256:canonicalSha256(seed)});
}

/** Stable check fingerprints make independent work visible across revisions.
 * The enclosing analysis still receives a NEW run/hash; no stale result can
 * become current merely because one of its checks remains identical. */
export function compareDocumentReviewDependencies(previous:DocumentReviewResult,current:DocumentReviewResult){
 if(previous.case_id!==current.case_id)throw Error('REVIEW_HISTORY_FOREIGN_CASE');
 const old=new Map(previous.checks.map(c=>[c.check_id,c.dependency_sha256]));
 return {unchanged:current.checks.filter(c=>old.get(c.check_id)===c.dependency_sha256).map(c=>c.check_id),
  changed:current.checks.filter(c=>old.has(c.check_id)&&old.get(c.check_id)!==c.dependency_sha256).map(c=>c.check_id),
  added:current.checks.filter(c=>!old.has(c.check_id)).map(c=>c.check_id),
  removed:previous.checks.filter(c=>!current.checks.some(n=>n.check_id===c.check_id)).map(c=>c.check_id)};
}

export function replayDocumentReview(value:unknown){
 if(!value||typeof value!=='object'||!('input' in value)||!('analysis_run_id' in value)||typeof value.analysis_run_id!=='string')throw Error('REVIEW_RESULT_INVALID');
 const replay=runDocumentReview(value.input,value.analysis_run_id);
 if(canonicalSha256(replay)!==canonicalSha256(value))throw Error('REVIEW_RESULT_REPLAY_MISMATCH');
 return replay;
}

/** Used after the ordinary authenticated answer write. Only explicit numeric
 * dependency bindings can change an operand; original readings remain in the
 * immutable prior run and in this revision's answer history. */
export function applyDocumentReviewAnswer(candidate:unknown,input:{request:ReviewCompletion;actor:{case_id:string;identity_id:string};
 answer:{request_id:string;revision:number;answered_at:string;state:'provided'|'unknown'|'conflicted';value:string|number|boolean|null}}){
 const current=documentReviewInputSchema.parse(candidate),completion=parseReviewCompletionInput(current.completion_input);
 const resolved=resolveReviewCompletion({...input,current:completion});
 if(resolved.state==='stale')return {input:current,resolution:resolved};
 if(current.answer_history.some(h=>h.receipt.answer_sha256===resolved.receipt.answer_sha256))return {input:current,resolution:resolved};
 const originals:ReturnType<typeof documentReviewCalculationInputSchema.parse>[]=[];
 const checks=current.checks.map(check=>{
  if(resolved.requires_source_verification||!resolved.invalidated_check_ids.includes(check.check_id))return check;
  const bindings=current.answer_bindings.filter(b=>b.fact_key===input.request.target.fact_key&&b.check_id===check.check_id);
  if(!bindings.length)return check;
  const calculation=documentReviewCalculationInputSchema.parse(check.calculation);originals.push(calculation);
  const receipt=resolved.receipt,document_id=receipt.request_id,version_id=`${document_id}:${receipt.answer_revision}`;
  const operands=calculation.operands.map(operand=>!bindings.some(b=>b.operand_id===operand.id)?operand:{...operand,
   observation_id:`answer:${receipt.answer_sha256}`,state:receipt.state==='provided'?(resolved.blocked?'conflict' as const:'declared' as const):receipt.state==='conflicted'?'conflict' as const:'unknown' as const,printed_value:receipt.state==='provided'?String(receipt.value):null,
   source:{document_id,version_id,file_sha256:receipt.answer_sha256,page:1,locator:input.request.target.fact_key,label:input.request.target.question,
    reading:'customer_declaration' as const,reading_receipt_sha256:receipt.answer_sha256}});
  const source_manifest=[...calculation.source_manifest.filter(s=>s.document_id!==document_id),{document_id,version_id,file_sha256:receipt.answer_sha256,page_count:1,kind:'customer_answer' as const,case_id:current.case_id}];
  return {...check,calculation:{...calculation,operands,source_manifest}};
 });
 const replacedEvidence=new Set((completion.previous_answers??[]).filter(a=>a.request_id===resolved.receipt.request_id&&a.target_sha256===resolved.receipt.target_sha256).map(a=>`review-answer:${a.answer_sha256}`));
 const next=documentReviewInputSchema.parse({...current,checks,completion_input:{...completion,
  previous_answers:[...(completion.previous_answers??[]),resolved.receipt],
  evidence:[...completion.evidence.filter(e=>!replacedEvidence.has(e.evidence_id)),resolved.evidence]},
  answer_history:[...current.answer_history,{request:input.request,receipt:resolved.receipt,original_checks:originals}]});
 return {input:next,resolution:resolved};
}
