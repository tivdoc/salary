import {z} from 'zod';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {customerSourceStructureReadingV1Schema,customerSourceStructureReadingV2Schema,sourceStructurePeriodWitnessSchema,sourceStructureSubjectSchema,type SourceStructureRef} from '../extraction/source-structure.ts';
import {parseSourceStructureReadingValue} from '../extraction/source-structure-resolution.ts';
import {assertSourceStructurePeriodWitness,sourceStructureRefs} from '../extraction/source-structure-period.ts';
import type {DocumentReviewCalculationInput,DocumentReviewOperand} from './calculations.ts';

const sha=z.string().regex(/^[a-f0-9]{64}$/u),id=z.string().min(1).max(160);
const entry=z.object({subject:sourceStructureSubjectSchema,reading:customerSourceStructureReadingV1Schema.nullable()}).strict();
const entryV2=entry.extend({reading:customerSourceStructureReadingV2Schema.nullable()});
export const SOURCE_STRUCTURE_BLOCKER_POLICY='source-structure-blockers-v2' as const;
const pins={schema_version:z.literal('document-review-source-structure-v1'),blocker_policy:z.literal(SOURCE_STRUCTURE_BLOCKER_POLICY).optional(),document_id:id,version_id:id,file_sha256:sha,
 reading_sha256:sha,machine_extraction_sha256:sha,first_pass_sha256:sha,checkpoint_result_sha256:sha};
const v1=z.discriminatedUnion('kind',[
 z.object({...pins,kind:z.literal('source_relationship'),entry,numerator_ref:id,denominator_ref:id}).strict(),
 z.object({...pins,kind:z.literal('deduction_group'),entry,group:z.enum(['mandatory','voluntary']),
  row_bindings:z.array(z.object({component_id:z.uuid(),operand_id:id}).strict()).max(100),recorded_ref:id}).strict(),
 z.object({...pins,kind:z.literal('balance_movement'),entries:z.array(entry).length(5),
  cell_bindings:z.array(z.object({cell:z.enum(['opening','accrued','used','adjustments','closing']),operand_id:id}).strict()).min(4).max(5)}).strict(),
]);
const pinsV2={...pins,schema_version:z.literal('document-review-source-structure-v2'),period_witness:sourceStructurePeriodWitnessSchema};
const v2=z.discriminatedUnion('kind',[
 z.object({...pinsV2,kind:z.literal('source_relationship'),entry:entryV2,numerator_ref:id,denominator_ref:id}).strict(),
 z.object({...pinsV2,kind:z.literal('deduction_group'),entry:entryV2,group:z.enum(['mandatory','voluntary']),
  row_bindings:z.array(z.object({component_id:z.uuid(),operand_id:id}).strict()).max(100),recorded_ref:id}).strict(),
]);
export const documentReviewSourceStructureSchema=z.union([v1,v2]);
export type DocumentReviewSourceStructure=z.infer<typeof documentReviewSourceStructureSchema>;
export function sourceRelationshipUsable(s:DocumentReviewSourceStructure){
 if(s.kind!=='source_relationship')return false;
 const v=s.entry.reading?.value;
 if(v?.kind!=='source_relationship'||v.relationship!=='same_base')return false;
 const expected={pension_employee:'pension',pension_employer:'pension',severance:'severance',combined_employer_funds:'combined'};
 if(v.fund_kind!==expected[v.component_kind]||s.entry.subject.kind!=='source_relationship')return false;
 return [s.entry.subject.contribution,s.entry.subject.base].every(r=>!r.source.source_scope?.fund_kind||r.source.source_scope.fund_kind==='unknown'||r.source.source_scope.fund_kind===v.fund_kind);
}
function preciseRelationshipBlocker(s:DocumentReviewSourceStructure){
 if(s.kind!=='source_relationship'||s.entry.subject.kind!=='source_relationship'||!s.entry.reading)return null;
 const v=s.entry.reading.value;if(v.kind!=='source_relationship')return null;
 if(v.relationship==='different_base')return {state:'conflict',reason:'source_relationship_different_base'};
 if(v.fund_kind==='unknown')return {state:'unknown',reason:'source_fund_unknown'};
 if([s.entry.subject.contribution,s.entry.subject.base].some(r=>r.source.source_scope?.fund_kind&&r.source.source_scope.fund_kind!=='unknown'&&r.source.source_scope.fund_kind!==v.fund_kind))
  return {state:'conflict',reason:'source_fund_conflicts_with_original'};
 const expected={pension_employee:'pension',pension_employer:'pension',severance:'severance',combined_employer_funds:'combined'};
 return v.fund_kind===expected[v.component_kind]?null:{state:'conflict',reason:'source_fund_incompatible'};
}
export function sourceStructureGroupDisjoint(s:DocumentReviewSourceStructure){
 if(s.kind!=='deduction_group'||s.entry.subject.kind!=='deduction_group')return false;
 const rows=s.entry.subject.rows,locations=rows.map(r=>canonicalSha256({page:r.source.page,location:r.source.bounding_box??r.source.text_fragment??r.id,label:r.label}));
 return new Set(locations).size===locations.length;
}
export const sourceStructureEntries=(s:DocumentReviewSourceStructure)=>s.kind==='balance_movement'?s.entries:[s.entry];
export function balanceStructureGroupSha256(s:DocumentReviewSourceStructure){
 if(s.kind!=='balance_movement'||s.entries[0].subject.kind!=='balance_movement')throw Error('REVIEW_BALANCE_STRUCTURE');
 const first=s.entries[0].subject;
 if(first.kind!=='balance_movement')throw Error('REVIEW_BALANCE_STRUCTURE');
 return canonicalSha256({document_id:s.document_id,version_id:s.version_id,file_sha256:s.file_sha256,
  first_pass_sha256:s.first_pass_sha256,anchor:first.anchor,balance_kind:first.balance_kind});
}
const fail=()=>{throw Error('REVIEW_SOURCE_STRUCTURE_BINDING');};
function bindRef(operand:DocumentReviewOperand|undefined,ref:SourceStructureRef){
 if(!operand||operand.source.page!==ref.source.page)return fail();
 let locator:Record<string,unknown>;try{locator=JSON.parse(operand.source.locator);}catch{return fail();}
 const ids=ref.kind==='component'?locator.component_ids:locator.candidate_ids;
 const hashes=ref.kind==='component'?locator.original_component_sha256:ref.kind==='scope'?locator.scope_observation_sha256:locator.candidate_sha256;
 if(!Array.isArray(ids)||!Array.isArray(hashes)||ids.length!==1||hashes.length!==1||ids[0]!==ref.id||hashes[0]!==ref.sha256
  ||ref.kind==='component'&&locator.cell!=='amount')return fail();
}
/** Internal replay proof only. Authentication and current checkpoint admission
 * are independently enforced by the saved loader and reading materializer. */
export function validateReviewSourceStructure(input:DocumentReviewCalculationInput){
 const s=input.source_structure;
 if(!s){if(input.operands.some(o=>o.quantity_unit==='source_native_unknown'))fail();return;}
 const manifest=input.source_manifest.find(d=>d.document_id===s.document_id&&d.version_id===s.version_id);
 if(!manifest||manifest.kind!=='case_document'||manifest.file_sha256!==s.file_sha256||manifest.case_id!==input.case_id)fail();
 const entries=sourceStructureEntries(s),requests=new Set<string>(),targets=new Set<string>();
 if(new Set(entries.map(e=>canonicalSha256(e.subject))).size!==entries.length)fail();
 for(const e of entries){
  // Period associations are metadata witnesses, never one of these three
  // arithmetic relationship/group/balance witness variants.
  if(e.subject.kind==='period_association')throw Error('REVIEW_SOURCE_STRUCTURE_BINDING');
  const refs=e.subject.kind==='balance_movement'?[e.subject.anchor]:e.subject.kind==='source_relationship'?[e.subject.contribution,e.subject.base]:[...e.subject.rows,e.subject.mandatory_total,...(e.subject.voluntary_total?[e.subject.voluntary_total]:[])];
  if(refs.some(r=>r.source.document_id!==s.document_id||r.source.page>manifest!.page_count
   ||s.schema_version==='document-review-source-structure-v1'&&r.source.source_scope?.period_kind!=='current'))fail();
  if(s.schema_version==='document-review-source-structure-v2'){
   assertSourceStructurePeriodWitness({witness:s.period_witness,refs:sourceStructureRefs(e.subject),period:input.period,
    pins:{case_id:input.case_id,document_id:s.document_id,source_sha256:s.file_sha256,normalized_extraction_sha256:s.machine_extraction_sha256,
     first_pass_extraction_sha256:s.first_pass_sha256,extraction_result_sha256:s.checkpoint_result_sha256,month:input.period.from.slice(0,7)}});
   if(e.reading&&(e.reading.schema_version!=='document-source-structure-reading-v2'||canonicalSha256(e.reading.period_witness)!==canonicalSha256(s.period_witness)))fail();
  }
  if(!e.reading)continue;
  const r=parseSourceStructureReadingValue(e.reading).reading;
  if(canonicalSha256(r.subject)!==canonicalSha256(e.subject)||r.case_id!==input.case_id||r.document_id!==s.document_id||r.source_sha256!==s.file_sha256
   ||r.normalized_extraction_sha256!==s.machine_extraction_sha256||r.first_pass_extraction_sha256!==s.first_pass_sha256||r.extraction_result_sha256!==s.checkpoint_result_sha256
   ||r.month!==input.period.from.slice(0,7)||input.period.to.slice(0,7)!==r.month||requests.has(r.request_id)||targets.has(r.target_sha256))fail();
  requests.add(r.request_id);targets.add(r.target_sha256);
 }
 for(const o of input.operands)if(o.source.document_id!==s.document_id||o.source.version_id!==s.version_id||o.source.file_sha256!==s.file_sha256||o.source.reading_receipt_sha256!==s.reading_sha256)fail();
 const op=input.operation,operand=(id:string)=>input.operands.find(o=>o.id===id);
 if(s.kind==='source_relationship'){
  if(s.entry.subject.kind!=='source_relationship'||op.kind!=='observed_ratio'||op.numerator_ref!==s.numerator_ref||op.denominator_ref!==s.denominator_ref)return fail();
  if(op.same_period_and_base!==sourceRelationshipUsable(s))fail();
  bindRef(operand(s.numerator_ref),s.entry.subject.contribution);bindRef(operand(s.denominator_ref),s.entry.subject.base);
 }else if(s.kind==='deduction_group'){
  if(s.entry.subject.kind!=='deduction_group'||op.kind!=='reconciliation'||op.recorded_ref!==s.recorded_ref||op.subtract_refs.length)return fail();
  const subject=s.entry.subject,value=s.entry.reading?.value;
  if(value&&value.kind!=='deduction_group')return fail();
  const assigned=value?value.members.filter(m=>m.group===s.group).map(m=>m.component_id):[];
  const selected=assigned.length?assigned:subject.rows.map(r=>r.id);
  if(new Set(s.row_bindings.map(b=>b.component_id)).size!==s.row_bindings.length||canonicalSha256([...selected].sort())!==canonicalSha256(s.row_bindings.map(b=>b.component_id).sort())
   ||canonicalSha256(op.add_refs)!==canonicalSha256(s.row_bindings.map(b=>b.operand_id))||op.inventory_complete!==(value?.inventory==='complete'&&assigned.length>0)||op.disjoint_components!==sourceStructureGroupDisjoint(s))fail();
  for(const b of s.row_bindings){const ref=subject.rows.find(r=>r.id===b.component_id);if(!ref)fail();bindRef(operand(b.operand_id),ref!);}
  const total=s.group==='mandatory'?subject.mandatory_total:subject.voluntary_total;if(!total)return fail();bindRef(operand(s.recorded_ref),total);
 }else{
  if(op.kind!=='reconciliation'||!op.disjoint_components)return fail();
  const subjects=s.entries.map(e=>e.subject);if(subjects.some(e=>e.kind!=='balance_movement'))return fail();
  const first=subjects[0];if(first.kind!=='balance_movement')return fail();
  if(new Set(subjects.map(e=>e.kind==='balance_movement'?e.cell:'')).size!==5||subjects.some(e=>e.kind!=='balance_movement'||e.balance_kind!==first.balance_kind||canonicalSha256(e.anchor)!==canonicalSha256(first.anchor)))fail();
  const value=(cell:string)=>s.entries.find(e=>e.subject.kind==='balance_movement'&&e.subject.cell===cell)?.reading?.value;
  const adjustment=value('adjustments'),notPresent=adjustment?.kind==='balance_movement'&&adjustment.state==='not_present';
  const required=['opening','accrued','used','closing',...(notPresent?[]:['adjustments'])];
  if(new Set(s.cell_bindings.map(b=>b.cell)).size!==s.cell_bindings.length||canonicalSha256(required.sort())!==canonicalSha256(s.cell_bindings.map(b=>b.cell).sort()))fail();
  const ref=(cell:string)=>s.cell_bindings.find(b=>b.cell===cell)?.operand_id;
  if(canonicalSha256(op.add_refs)!==canonicalSha256([ref('opening'),ref('accrued'),...(notPresent?[]:[ref('adjustments')])])||canonicalSha256(op.subtract_refs)!==canonicalSha256([ref('used')])||op.recorded_ref!==ref('closing'))fail();
  if(op.inventory_complete!==s.entries.every(e=>e.reading!==null))fail();
  for(const b of s.cell_bindings){
   const e=s.entries.find(e=>e.subject.kind==='balance_movement'&&e.subject.cell===b.cell)!,v=e.reading?.value,o=operand(b.operand_id);if(!o)return fail();
   let locator;try{locator=JSON.parse(o.source.locator);}catch{return fail();}
   if(o.representation!=='decimal_quantity'||locator.schema_version!=='document-review-source-structure-locator-v1'||locator.subject_sha256!==canonicalSha256(e.subject)||o.observation_id!==`structure:${canonicalSha256(e.subject)}`)fail();
   if(v?.kind==='balance_movement'&&v.state==='value'){
    if(!['observed','unknown','unreadable'].includes(o.state)||o.printed_value!==v.amount||o.quantity_unit!==v.unit||o.source.reading!=='identified_document_reading')fail();
   }else if(o.state!=='missing'||o.printed_value!==null)fail();
  }
 }
}
export function reviewSourceStructureBlockers(input:DocumentReviewCalculationInput){
 const s=input.source_structure;if(!s)return [];
 // Null means no usable affirmative reading; the authenticated answer journal
 // separately distinguishes unanswered, unknown and unreadable decisions.
 const missing=sourceStructureEntries(s).filter(e=>!e.reading).map(e=>({dependency_id:`structure.${canonicalSha256(e.subject).slice(0,24)}`,state:'missing',reason:'source_structure_reading_required'}));
 if(s.kind==='source_relationship'&&s.entry.reading&&!sourceRelationshipUsable(s)){
  const precise=s.blocker_policy===SOURCE_STRUCTURE_BLOCKER_POLICY?preciseRelationshipBlocker(s):null;
  missing.push({dependency_id:'structure.relationship',...(precise??{state:'unknown',reason:'source_relationship_or_fund_not_compatible'})});
 }
 if(s.kind==='balance_movement'){
  const units=new Set(input.operands.filter(o=>o.state==='observed').map(o=>o.quantity_unit));
  if(units.size>1)missing.push({dependency_id:'balance.unit',state:'conflict',reason:'balance_movement_units_differ'});
 }
 return missing;
}
