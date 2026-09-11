import {z} from 'zod';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {normalizedPayslipExtractionSchema,type NormalizedPayslipExtraction} from '../extraction/payslip.ts';
import type {DocumentReviewCalculationInput} from './calculations.ts';
import {mappedRowCellCandidate} from '../extraction/reading-resolution.ts';
import {PAYSLIP_ROW_REVIEW_TOPICS,type DocumentReviewResult} from './contracts.ts';

const sha=z.string().regex(/^[a-f0-9]{64}$/u),ids=z.array(z.string().min(1)).min(1).max(48),hashes=z.array(sha).min(1).max(48),raw=z.array(z.string().nullable()).min(1).max(48);
const base={schema_version:z.literal('document-review-source-locator-v2')};
export const documentReviewSourceLocatorSchema=z.union([
 z.object({...base,component_ids:ids,cell:z.enum(['quantity','rate','amount','percentage']),original_component_sha256:hashes,raw_values:raw,
  mapped_candidate:z.object({candidate_id:z.string().min(1),candidate_sha256:sha}).strict().optional()}).strict(),
 z.object({...base,scope:z.string().min(1),candidate_ids:ids,scope_observation_sha256:hashes,raw_values:raw}).strict(),
 z.object({...base,field:z.string().min(1),candidate_ids:ids,candidate_sha256:hashes,raw_values:raw}).strict(),
 z.object({...base,transcription_kind:z.literal('reported_work_hours'),page:z.number().int().min(1).max(100),meaning:z.literal('document_reported_total_hours'),target_sha256:sha.optional()}).strict(),
]).superRefine((value,ctx)=>{
 if('transcription_kind' in value)return;
 const keys='component_ids' in value?value.component_ids:value.candidate_ids;
 const pins='original_component_sha256' in value?value.original_component_sha256:'scope_observation_sha256' in value?value.scope_observation_sha256:value.candidate_sha256;
 if(new Set(keys).size!==keys.length||keys.length!==pins.length||keys.length!==value.raw_values.length)ctx.addIssue({code:'custom',message:'REVIEW_LOCATOR_ARRAY_BINDING'});
 if('mapped_candidate' in value&&value.mapped_candidate&&keys.length!==1)ctx.addIssue({code:'custom',message:'REVIEW_LOCATOR_MAPPING_ARITY'});
});
export type DocumentReviewSourceLocator=z.infer<typeof documentReviewSourceLocatorSchema>;
export function parseDocumentReviewSourceLocator(value:string):DocumentReviewSourceLocator|null{
 try{const result=documentReviewSourceLocatorSchema.safeParse(JSON.parse(value));return result.success?result.data:null;}catch{return null;}
}

/** Defer a price reading only for an exact v2 row whose source quantity and
 * amount are both blank. Valid, separately admitted declarations can satisfy
 * these operands without becoming document readings; unknown answers cannot. */
export function deferredDocumentReviewRowPriceOperands(calculation:DocumentReviewCalculationInput,
 extraction:{document_id:string;additional_components:readonly NormalizedPayslipExtraction['additional_components'][number][]}):ReadonlySet<string>{
 const deferred=new Set<string>(),op=calculation.operation;if(op.kind!=='product')return deferred;
 const price=calculation.operands.find(o=>o.id===op.money_ref),amount=calculation.operands.find(o=>o.id===op.recorded_ref);
 const locator=price?parseDocumentReviewSourceLocator(price.source.locator):null;
 if(!price||!amount||!locator||!('component_ids' in locator)||locator.cell!=='rate'||price.source.document_id!==extraction.document_id)return deferred;
 const rows=locator.component_ids.map(id=>extraction.additional_components.find(r=>r.component_id===id));
 if(rows.some((r,i)=>!r||canonicalSha256(r)!==locator.original_component_sha256[i]||r.quantity_raw!==null||r.amount_raw!==null))return deferred;
 const sameCell=(operand:DocumentReviewCalculationInput['operands'][number],cell:string)=>{
  const target=parseDocumentReviewSourceLocator(operand.source.locator);
  return target&&'component_ids' in target&&target.cell===cell&&operand.source.document_id===extraction.document_id
   &&canonicalSha256(target.component_ids)===canonicalSha256(locator.component_ids)
   &&canonicalSha256(target.original_component_sha256)===canonicalSha256(locator.original_component_sha256);
 };
 const usable=(operand:DocumentReviewCalculationInput['operands'][number])=>['observed','declared'].includes(operand.state)&&operand.printed_value!==null;
 const quantities=calculation.operands.filter(o=>op.factor_refs.includes(o.id)&&(sameCell(o,'quantity')
  ||o.state==='declared'&&['decimal_quantity','hours_minutes','integer'].includes(o.representation)&&o.quantity_unit!=='ratio'));
 if(quantities.length!==1||!sameCell(amount,'amount')&&amount.state!=='declared'||usable(quantities[0])&&usable(amount))return deferred;
 deferred.add(price.id);
 for(const operand of calculation.operands)if(op.factor_refs.includes(operand.id)&&sameCell(operand,'percentage'))deferred.add(operand.id);
 return deferred;
}

/** Selection only, never an answer or an admission. The opener still verifies
 * the authenticated current checkpoint and creates its own exact target. */
export function documentReviewReadingDependencies(input:{review:DocumentReviewResult;document_id:string;extraction:unknown}){
 const extraction=normalizedPayslipExtractionSchema.parse(input.extraction),document=input.review.documents.find(d=>d.document_id===input.document_id);
 if(!document||extraction.document_id!==document.document_id||document.reading_sha256!==canonicalSha256(extraction))throw Error('REVIEW_DEPENDENCY_EXTRACTION_BINDING');
 const rows=new Map<string,{component_id:string;cell:'quantity'|'rate'|'amount'|'percentage';check_ids:string[]}>();
 const scopes=new Map<string,{candidate_id:string;scope:string;check_ids:string[]}>(),fields=new Map<string,{candidate_id:string;check_ids:string[]}>();
 const transcriptions=new Map<string,{subject:{kind:'reported_work_hours';page:number}|{kind:'balance_unit';candidateId:string};check_ids:string[]}>();
 const unmapped:{check_id:string;operand_id:string;reason:'locator_unavailable'|'source_changed'|'blank_source'}[]=[];
 for(const check of input.review.checks){
  if(check.calculation.state!=='blocked')continue;
  const operation=check.calculation.input.operation;
  if(operation.kind==='observed_ratio'&&!operation.same_period_and_base)continue;
  if(check.printed_inventory?.document_id===document.document_id&&check.printed_inventory.populated_component_ids.some(id=>{
   const row=extraction.additional_components.find(r=>r.component_id===id),topic=row?PAYSLIP_ROW_REVIEW_TOPICS[row.semantic_kind]:undefined;
   return !topic||!input.review.purchased_scope.topics.includes(topic);
  }))continue;
  const deferredPrices=deferredDocumentReviewRowPriceOperands(check.calculation.input,extraction);
  for(const operand of check.calculation.input.operands){
   if(deferredPrices.has(operand.id))continue;
   if(operand.state==='observed'||operand.source.document_id!==document.document_id)continue;
   if(operand.source.version_id!==document.version_id||operand.source.file_sha256!==document.file_sha256||operand.source.reading_receipt_sha256!==document.reading_sha256){
    unmapped.push({check_id:check.check_id,operand_id:operand.id,reason:'source_changed'});continue;
   }
   const locator=parseDocumentReviewSourceLocator(operand.source.locator);
   if(!locator){unmapped.push({check_id:check.check_id,operand_id:operand.id,reason:'locator_unavailable'});continue;}
   if('transcription_kind' in locator){
    if(locator.page!==operand.source.page||locator.page>(document.page_count??0)){unmapped.push({check_id:check.check_id,operand_id:operand.id,reason:'source_changed'});continue;}
    const key=`reported_work_hours:${locator.page}`,entry=transcriptions.get(key)??{subject:{kind:'reported_work_hours' as const,page:locator.page},check_ids:[]};
    if(!entry.check_ids.includes(check.check_id))entry.check_ids.push(check.check_id);transcriptions.set(key,entry);continue;
   }
   const ids='component_ids' in locator?locator.component_ids:locator.candidate_ids;
   for(const [i,id] of ids.entries()){
    const candidate='component_ids' in locator?extraction.additional_components.find(c=>c.component_id===id):'scope' in locator
     ?extraction.source_scope_observations?.find(c=>c.candidate.candidate_id===id&&c.scope===locator.scope):extraction.fields.find(c=>c.candidate_id===id&&c.field===locator.field);
    const hash='original_component_sha256' in locator?locator.original_component_sha256[i]:'scope_observation_sha256' in locator?locator.scope_observation_sha256[i]:locator.candidate_sha256[i];
    if(!candidate||canonicalSha256(candidate)!==hash){unmapped.push({check_id:check.check_id,operand_id:operand.id,reason:'source_changed'});continue;}
    const value='component_ids' in locator?extraction.additional_components.find(c=>c.component_id===id)![`${locator.cell}_raw`]
     :'scope' in locator?extraction.source_scope_observations!.find(c=>c.candidate.candidate_id===id)!.candidate.raw_value:extraction.fields.find(c=>c.candidate_id===id)!.raw_value;
    if(value===null||!value.trim()){unmapped.push({check_id:check.check_id,operand_id:operand.id,reason:'blank_source'});continue;}
    if('component_ids' in locator){
     const sourceRow=extraction.additional_components.find(c=>c.component_id===id)!,topic=PAYSLIP_ROW_REVIEW_TOPICS[sourceRow.semantic_kind];
     if(!topic||!input.review.purchased_scope.topics.includes(topic))continue;
     if(locator.mapped_candidate){
      const row=extraction.additional_components.find(c=>c.component_id===id)!,mapped=mappedRowCellCandidate({fields:extraction.fields,row,cell:locator.cell});
      if(!mapped||mapped.candidate_id!==locator.mapped_candidate.candidate_id||canonicalSha256(mapped)!==locator.mapped_candidate.candidate_sha256){unmapped.push({check_id:check.check_id,operand_id:operand.id,reason:'source_changed'});continue;}
      const entry=fields.get(mapped.candidate_id)??{candidate_id:mapped.candidate_id,check_ids:[]};if(!entry.check_ids.includes(check.check_id))entry.check_ids.push(check.check_id);fields.set(mapped.candidate_id,entry);continue;
     }
     const key=`${id}:${locator.cell}`,entry=rows.get(key)??{component_id:id,cell:locator.cell,check_ids:[]};if(!entry.check_ids.includes(check.check_id))entry.check_ids.push(check.check_id);rows.set(key,entry);}
    else if('scope' in locator){const entry=scopes.get(id)??{candidate_id:id,scope:locator.scope,check_ids:[]};if(!entry.check_ids.includes(check.check_id))entry.check_ids.push(check.check_id);scopes.set(id,entry);}
    else {const entry=fields.get(id)??{candidate_id:id,check_ids:[]};if(!entry.check_ids.includes(check.check_id))entry.check_ids.push(check.check_id);fields.set(id,entry);}
   }
  }
 }
 for(const row of input.review.coverage_inventory?.unresolved_source_observations??[]){
  if(row.document_id!==document.document_id||row.version_id!==document.version_id)continue;
  const checks=input.review.coverage_gaps.filter(g=>g.check_id.endsWith(`balance.${row.field}.unit`)
   &&g.source_pins?.some(p=>p.document_id===document.document_id&&p.version_id===document.version_id&&p.source_sha256===document.file_sha256)).map(g=>g.check_id);
  if(checks.length)transcriptions.set(`balance_unit:${row.candidate_id}`,{subject:{kind:'balance_unit',candidateId:row.candidate_id},check_ids:checks});
 }
 return {row_cells:[...rows.values()],scope_fields:[...scopes.values()],scalar_fields:[...fields.values()],source_transcriptions:[...transcriptions.values()],unmapped};
}
