import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {StoredCaseInputSnapshot} from '../case-analysis/contracts.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewSource,type DocumentReviewOperand} from '../document-review/calculations.ts';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY} from '../document-review/payslip-adapter.ts';
import {materializeValidatedPayslipReadings} from '../extraction/reading-resolution.ts';
import {payslipSourcePeriod} from '../extraction/source-period-association.ts';
import {validatePayslipGate0,SOURCE_ROW_DUPLICATE_POLICY} from '../extraction/validation.ts';
import {resolvePayslipSnapshot,resolvedPayslipFactPaths,IDENTIFIED_AGREEING_CANDIDATES_POLICY} from '../extraction/resolver.ts';
import type {NormalizedCandidateField} from '../extraction/payslip.ts';
import {entitlementDeclarationsSchema,questionnaireFactSource,type DeclarationTransform} from './declarations.ts';
import {vacationEntitlementInputSchema,type VacationEntitlementInput} from './vacation/index.ts';
import {convalescenceEntitlementInputSchema,type ConvalescenceEntitlementInput} from './convalescence/index.ts';

export const AUTOMATIC_BENEFITS_EVIDENCE_POLICY='automatic-benefits-source-evidence-v1' as const;
const uuid=(v:unknown)=>{const h=canonicalSha256(v);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const missing={state:'missing' as const,value:null,source:null};
const vacationMissing={...missing,basis:'ai_source_assessment' as const};
type Matched={document:StoredCaseInputSnapshot['documents'][number];extraction:StoredCaseInputSnapshot['extractions'][number];review:DocumentReviewInput['documents'][number]};
type Readings={start:{value:string;source:DocumentReviewSource}|null;convalescence:DocumentReviewOperand|null};
function readSource(pair:Matched,input:DocumentReviewInput,snapshot:StoredCaseInputSnapshot):Readings{
 const original=pair.extraction,materialized=materializeValidatedPayslipReadings({document:pair.document,extraction:original,case_id:input.case_id,requireDistinctTargets:true}),e=materialized.extraction,receipt=canonicalSha256(original);
 const validation=validatePayslipGate0(e,{reference_year:Number(input.period.from.slice(0,4)),component_duplicate_policy:SOURCE_ROW_DUPLICATE_POLICY});
 const resolved=resolvePayslipSnapshot({document:pair.document,extraction:original,validation,reading_policy:IDENTIFIED_AGREEING_CANDIDATES_POLICY,
  context:{snapshot_id:uuid([receipt,'snapshot']),analysis_run_id:uuid([receipt,'reading-run']),case_id:input.case_id,schema_version:'1.0.0',created_at:e.extracted_at,fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(p=>[p,uuid([receipt,p])]))}});
 const empty={start:null,convalescence:null},periods=e.fields.filter(f=>f.field==='salary_period');
 if(e.detected_document_type!=='payslip'||e.status==='failed'||e.document_quality_confidence<.65||resolved.facts.find(f=>f.path==='documents.period')?.status!=='confirmed'||!periods.length
  ||periods.some(f=>f.normalized_value?.start_date!==input.period.from||f.normalized_value?.end_date!==input.period.to))return empty;
 const source=(fields:NormalizedCandidateField[],label:string):DocumentReviewSource=>{
  const originals=fields.map(f=>original.fields.find(o=>o.candidate_id===f.candidate_id)!);
  const locator=JSON.stringify({schema_version:'document-review-source-locator-v2',field:fields[0].field,candidate_ids:fields.map(f=>f.candidate_id),candidate_sha256:originals.map(f=>canonicalSha256(f))});
  return {document_id:pair.review.document_id,version_id:pair.review.version_id,file_sha256:pair.review.file_sha256,page:fields[0].source.page,label,
   locator:locator.length<=500?locator:JSON.stringify({schema_version:AUTOMATIC_BENEFITS_EVIDENCE_POLICY,field:fields[0].field,observations_sha256:canonicalSha256(originals)}),
   reading:fields.every(f=>materialized.readings.has(f.candidate_id))?'identified_document_reading':'provider_extraction',reading_receipt_sha256:pair.review.reading_sha256};
 };
 const starts=e.fields.filter(f=>f.field==='employment_start_date'),date=resolved.facts.find(f=>f.path==='employment.start_date');
 const start=date?.status==='confirmed'&&typeof date.value==='string'&&starts.length&&starts.every(f=>f.normalized_value===date.value)
  ?{value:date.value,source:source(starts,'תאריך תחילת עבודה שנקרא בתלוש')}:null;
 const fields=e.fields.filter(f=>f.field==='convalescence_amount'),amount=resolved.facts.find(f=>f.path==='convalescence.payment'),v=fields[0]?.normalized_value;
 let convalescence:DocumentReviewOperand|null=amount?.status==='confirmed'&&fields.length>0&&fields.every(f=>payslipSourcePeriod({original:materialized.original,structureReadings:materialized.structureReadings,
  ref:{kind:'field',id:f.candidate_id},period:input.period}).state==='current'&&canonicalSha256(f.normalized_value)===canonicalSha256(v))
  &&v!==null&&typeof v==='object'&&'currency'in v&&v.currency==='ILS'&&'minor_units'in v
  ?{id:'convalescence.recorded',observation_id:fields[0].candidate_id,state:'observed',printed_value:(v.minor_units/100).toFixed(2),representation:'money_ils',quantity_unit:null,precision:'source_exact',source:source(fields,'סכום הבראה שנקרא בתלוש — תקופת הצבירה טרם שויכה')}:null;
 if(!fields.length&&input.purchased_scope.topics.includes('convalescence')){
  const arithmetic=reviewInputFromPayslips({case_id:input.case_id,period:input.period,purchased_scope:input.purchased_scope,review_policy:PAYSLIP_REVIEW_POLICY,
   snapshot:{...snapshot,documents:[pair.document],extractions:[original]}});
  const amounts=arithmetic.checks.flatMap(c=>{const calc=documentReviewCalculationInputSchema.parse(c.calculation);if(c.topic!=='convalescence'||calc.operation.kind!=='product')return [];
   const ref=calc.operation.recorded_ref,o=calc.operands.find(p=>p.id===ref);
   return o?.state==='observed'&&o.printed_value!==null&&original.additional_components.some(r=>r.semantic_kind==='convalescence'&&o.observation_id===r.component_id+':amount')?[o]:[];});
  if(amounts.length===1)convalescence=amounts[0];
 }
 return {start,convalescence};
}

/** Source facts only. Monthly balances are not annual entitlement, and a
 * convalescence row does not establish its accrual year, due date or FTE. */
export function attachAutomaticBenefitsEvidence(candidate:DocumentReviewInput,snapshot:StoredCaseInputSnapshot):DocumentReviewInput{
 const vacation=candidate.purchased_scope.topics.includes('vacation')&&candidate.entitlement_evidence?.vacation===undefined;
 const convalescence=candidate.purchased_scope.topics.includes('convalescence')&&candidate.entitlement_evidence?.convalescence===undefined;
 if(!vacation&&!convalescence||candidate.entitlement_composition||candidate.period.from<'2026-05-01'||candidate.period.to>'2026-07-31')return candidate;
 const input=documentReviewInputSchema.parse(candidate),pairs:Matched[]=[];
 if(new Set(snapshot.documents.map(d=>d.document_id)).size!==snapshot.documents.length||new Set(snapshot.extractions.map(e=>e.document_id)).size!==snapshot.extractions.length)throw Error('AUTOMATIC_BENEFITS_DUPLICATE_SOURCE');
 for(const document of snapshot.documents){
  const review=input.documents.find(d=>d.document_id===document.document_id),extraction=snapshot.extractions.find(e=>e.document_id===document.document_id);
  if(!review||!extraction)continue;
  if(document.case_id!==input.case_id||review.case_id!==input.case_id)throw Error('AUTOMATIC_BENEFITS_SOURCE_CASE');
  if(review.page_count===null||review.version_id!==document.document_id||review.file_sha256!==document.content_sha256||review.reading_sha256!==canonicalSha256(extraction))continue;
  pairs.push({document,review,extraction});
 }
 if(!pairs.length)return candidate;
 const declarations=entitlementDeclarationsSchema.parse({schema_version:'entitlement-questionnaire-evidence-v1',...snapshot.declared_fact_snapshot,period:input.period});
 if(input.entitlement_declarations&&canonicalSha256(input.entitlement_declarations)!==canonicalSha256(declarations))throw Error('AUTOMATIC_BENEFITS_DECLARATIONS_CHANGED');
 const prepared=documentReviewInputSchema.parse({...input,entitlement_declarations:declarations});
 const readings=pairs.map(p=>readSource(p,input,snapshot)),starts=readings.flatMap(r=>r.start?[r.start]:[]);
 const start:ConvalescenceEntitlementInput['employment_start']=starts.length===0?missing:new Set(starts.map(s=>s.value)).size===1?{state:'observed',...starts[0]}:{state:'conflict',value:null,source:starts[0].source};
 const manifest:VacationEntitlementInput['source_manifest']=pairs.map(p=>({document_id:p.review.document_id,version_id:p.review.version_id,file_sha256:p.review.file_sha256,page_count:p.review.page_count!,kind:'case_document',case_id:input.case_id}));
 const declared=(path:string,transform:DeclarationTransform)=>{
  const result=questionnaireFactSource(prepared,path,transform);if(!result)return vacationMissing;
  if(!manifest.some(p=>p.document_id===result.manifest.document_id))manifest.push(result.manifest);
  return {state:'known' as const,value:result.value,source:result.source,basis:'customer_declaration' as const};
 };
 const packet={...(input.entitlement_evidence??{schema_version:'entitlement-source-evidence-v1' as const,case_id:input.case_id,order_id:input.purchased_scope.order_id,receipt_sha256:input.purchased_scope.receipt_sha256,period:input.period})};
 const evaluatedAt=pairs.map(p=>p.extraction.extracted_at).sort().at(-1)!;
 if(vacation){
  const aged=declared('person.birth_year','aged_21_for_period'),under=declared('person.birth_year','under_60_for_period'),end=declared('employment.still_employed','ongoing_employment');
  const employmentStart=start.state==='observed'?{state:'known' as const,value:start.value,source:start.source,basis:'ai_source_assessment' as const}:start.state==='conflict'?{...start,basis:'ai_source_assessment' as const}:vacationMissing;
  packet.vacation=vacationEntitlementInputSchema.parse({schema_version:'vacation-entitlement-input-v1',catalog_id:'il.review.vacation.general.2026',catalog_version:'1.0.0',case_id:input.case_id,run_id:'automatic.source.selection',check_prefix:'entitlement.vacation',period:input.period,calendar_year:2026,evaluated_at:evaluatedAt,source_manifest:manifest,
   facts:{aged_21_or_more:aged,under_60:under},seniority_year:null,
   annual_basis:{employment_start:employmentStart,employment_end:end,complete_year_evidence:vacationMissing,covered_through:vacationMissing,actual_workdays:null},
   leave_pay:null,applicability:[],remittance_status:'not_assessed'});
 }
 if(convalescence){
  // More than one payslip is not silently added, even if amounts agree.
  // Coverage and payment inventory are independent facts, never the month.
  const recorded=pairs.length===1?readings[0].convalescence:null;
  packet.convalescence=convalescenceEntitlementInputSchema.parse({schema_version:'convalescence-entitlement-input-v1',catalog_version:'1.0.0',case_id:input.case_id,run_id:'automatic.source.selection',check_prefix:'entitlement.convalescence',period:input.period,evaluated_at:evaluatedAt,
   source_manifest:manifest.filter(m=>m.kind==='case_document'),population:missing,employment_start:start,qualifying_service:missing,payment_coverage:missing,benefit_year:missing,due_date:missing,segments:[],
   recorded,recorded_coverage:missing,recorded_inventory:missing,applicability:[]});
 }
 return documentReviewInputSchema.parse({...prepared,entitlement_evidence:packet});
}
