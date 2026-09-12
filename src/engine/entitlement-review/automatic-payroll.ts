import {payslipSourcePeriod} from '../extraction/source-period-association.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {StoredCaseInputSnapshot} from '../case-analysis/contracts.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewOperand,type DocumentReviewSource} from '../document-review/calculations.ts';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY} from '../document-review/payslip-adapter.ts';
import {validatePayslipGate0,SOURCE_ROW_DUPLICATE_POLICY} from '../extraction/validation.ts';
import {resolvePayslipSnapshot,resolvedPayslipFactPaths,IDENTIFIED_AGREEING_CANDIDATES_POLICY} from '../extraction/resolver.ts';
import {materializeValidatedPayslipReadings} from '../extraction/reading-resolution.ts';
import type {NormalizedCandidateField} from '../extraction/payslip.ts';
import {entitlementDeclarationsSchema,questionnaireFactSource} from './declarations.ts';
import {minimumWageEntitlementInputSchema,type MinimumWageEntitlementInput} from './minimum-wage/index.ts';
import {travelEntitlementInputSchema,type TravelEntitlementInput} from './travel/index.ts';

export const AUTOMATIC_PAYROLL_EVIDENCE_POLICY='automatic-payroll-source-evidence-v1' as const;
const uuid=(v:unknown)=>{const h=canonicalSha256(v);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};
const missing={state:'missing' as const,value:null,source:null};
const travelMissing={...missing,basis:'ai_source_assessment' as const};
const money=(minor:number)=>(minor/100).toFixed(2);
type ReviewDocument=DocumentReviewInput['documents'][number];
type Matched={document:StoredCaseInputSnapshot['documents'][number];extraction:StoredCaseInputSnapshot['extractions'][number];review:ReviewDocument};
type SourceValues={hours:DocumentReviewOperand|null;hoursPeriod:MinimumWageEntitlementInput['ordinary_hours_period'];base:DocumentReviewOperand|null;travel:DocumentReviewOperand|null};
function candidateSource(d:ReviewDocument,fields:readonly NormalizedCandidateField[],reading:DocumentReviewSource['reading']):DocumentReviewSource{
 const locator={schema_version:'document-review-source-locator-v2',field:fields[0].field,candidate_ids:fields.map(f=>f.candidate_id),candidate_sha256:fields.map(f=>canonicalSha256(f))};
 const text=JSON.stringify(locator);
 return {document_id:d.document_id,version_id:d.version_id,file_sha256:d.file_sha256,page:fields[0].source.page,
  locator:text.length<=500?text:JSON.stringify({schema_version:AUTOMATIC_PAYROLL_EVIDENCE_POLICY,field:fields[0].field,observations_sha256:canonicalSha256(fields)}),
  label:fields[0].field==='regular_hours'?'שעות רגילות שנקראו לחודש התלוש':fields[0].field==='travel_amount'?'סכום נסיעות שנקרא בתלוש':'שכר בסיס שנקרא בתלוש',reading,reading_receipt_sha256:d.reading_sha256};
}
function sourceValues(pair:Matched,input:DocumentReviewInput):SourceValues{
 const original=pair.extraction,materialized=materializeValidatedPayslipReadings({document:pair.document,extraction:original,case_id:input.case_id,requireDistinctTargets:true}),extraction=materialized.extraction;
 const validation=validatePayslipGate0(extraction,{reference_year:Number(input.period.from.slice(0,4)),component_duplicate_policy:SOURCE_ROW_DUPLICATE_POLICY});
 const receipt=canonicalSha256(original),context={snapshot_id:uuid([receipt,'snapshot']),analysis_run_id:uuid([receipt,'reading-run']),case_id:input.case_id,schema_version:'1.0.0',created_at:extraction.extracted_at,
  fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(p=>[p,uuid([receipt,p])]))};
 const resolved=resolvePayslipSnapshot({document:pair.document,extraction:original,validation,context,reading_policy:IDENTIFIED_AGREEING_CANDIDATES_POLICY});
 const empty={hours:null,hoursPeriod:missing,base:null,travel:null};
 const period=resolved.facts.find(f=>f.path==='documents.period'),periods=extraction.fields.filter(f=>f.field==='salary_period');
 if(extraction.detected_document_type!=='payslip'||extraction.status==='failed'||extraction.document_quality_confidence<.65||period?.status!=='confirmed'||!periods.length
  ||periods.some(f=>f.normalized_value?.start_date!==input.period.from||f.normalized_value?.end_date!==input.period.to))return empty;
 const read=(field:'regular_hours'|'base_monthly_salary'|'travel_amount',path:'work.regular_hours'|'compensation.base_monthly_salary'|'travel.reimbursement'):DocumentReviewOperand|null=>{
  const fields=extraction.fields.filter(f=>f.field===field),fact=resolved.facts.find(f=>f.path===path);
  if(!fields.length||fields.some(f=>payslipSourcePeriod({original:materialized.original,structureReadings:materialized.structureReadings,ref:{kind:'field',id:f.candidate_id},period:input.period}).state!=='current'))return null;
  // Keep uncertain scalar values in the original extraction and its existing
  // reading requests. They do not become a known entitlement operand.
  if(fact?.status!=='confirmed'||fields.some(f=>canonicalSha256(f.normalized_value)!==canonicalSha256(fields[0].normalized_value)))return null;
  const originals=fields.map(f=>original.fields.find(o=>o.candidate_id===f.candidate_id)!);
  const source=candidateSource(pair.review,originals,fields.every(f=>materialized.readings.has(f.candidate_id))?'identified_document_reading':'provider_extraction');
  const value=fields[0].normalized_value;
  if(!value||typeof value!=='object')return null;
  if(field==='regular_hours'){
   if(!('amount'in value)||!('unit'in value)||value.unit!=='hours_per_month')return null;
   // Same period-bound quantity; the calculation's denominator is selected
   // separately. This is not a declared/footnote total relabelled as regular.
   return {id:'ordinary.hours',observation_id:fields[0].candidate_id,state:'observed',printed_value:value.amount,representation:'decimal_quantity',quantity_unit:'hours',precision:'source_exact',source};
  }
  if(!('minor_units'in value)||value.currency!=='ILS')return null;
  return {id:field==='travel_amount'?'travel.recorded':'base.salary',observation_id:fields[0].candidate_id,state:'observed',printed_value:money(value.minor_units),representation:'money_ils',quantity_unit:null,precision:'source_exact',source};
 };
 const hours=read('regular_hours','work.regular_hours');
 return {hours,hoursPeriod:hours?{state:'observed',value:input.period,source:candidateSource(pair.review,original.fields.filter(f=>f.field==='salary_period'),periods.every(f=>materialized.readings.has(f.candidate_id))?'identified_document_reading':'provider_extraction')}:missing,
  base:read('base_monthly_salary','compensation.base_monthly_salary'),travel:read('travel_amount','travel.reimbursement')};
}

/** Append only absent source-evidence branches before composition. Existing
 * immutable packets/replays and source observations are never rewritten.
 * No legal method, transport fare or applicability decision is inferred. */
export function attachAutomaticPayrollEvidence(candidate:DocumentReviewInput,snapshot:StoredCaseInputSnapshot):DocumentReviewInput{
 const minimum=candidate.purchased_scope.topics.includes('minimum_wage')&&candidate.entitlement_evidence?.minimum_wage===undefined;
 const travel=candidate.purchased_scope.topics.includes('travel')&&candidate.entitlement_evidence?.travel===undefined;
 if(!minimum&&!travel||candidate.entitlement_composition||candidate.period.from<'2026-05-01'||candidate.period.to>'2026-07-31')return candidate;
 const input=documentReviewInputSchema.parse(candidate),matched:Matched[]=[];
 if(new Set(snapshot.documents.map(d=>d.document_id)).size!==snapshot.documents.length||new Set(snapshot.extractions.map(e=>e.document_id)).size!==snapshot.extractions.length)throw Error('AUTOMATIC_PAYROLL_DUPLICATE_SOURCE');
 for(const d of snapshot.documents){
  const review=input.documents.find(r=>r.document_id===d.document_id),extraction=snapshot.extractions.find(e=>e.document_id===d.document_id);
  if(!review||!extraction)continue;
  if(d.case_id!==input.case_id||review.case_id!==input.case_id)throw Error('AUTOMATIC_PAYROLL_SOURCE_CASE');
  if(review.version_id!==d.document_id||review.file_sha256!==d.content_sha256||review.reading_sha256!==canonicalSha256(extraction))continue;
  matched.push({document:d,extraction,review});
 }
 if(!matched.length)return candidate;
 const declarations=entitlementDeclarationsSchema.parse({schema_version:'entitlement-questionnaire-evidence-v1',...snapshot.declared_fact_snapshot,period:input.period});
 if(input.entitlement_declarations&&canonicalSha256(input.entitlement_declarations)!==canonicalSha256(declarations))throw Error('AUTOMATIC_PAYROLL_DECLARATIONS_CHANGED');
 const prepared=documentReviewInputSchema.parse({...input,entitlement_declarations:declarations});
 const selectedSnapshot={...snapshot,documents:matched.map(p=>p.document),extractions:matched.map(p=>p.extraction)};
 // Recompute from the saved readings. Never promote a numeric answer placed
 // into candidate.checks, even if that answer happens to equal a source cell.
 const ordinary=reviewInputFromPayslips({case_id:input.case_id,period:input.period,purchased_scope:input.purchased_scope,snapshot:selectedSnapshot,review_policy:PAYSLIP_REVIEW_POLICY});
 const current=matched.filter(p=>ordinary.documents.some(d=>d.document_id===p.document.document_id&&d.period?.from===input.period.from&&d.period.to===input.period.to));
 const values=current.map(p=>sourceValues(p,input));
 const manifest:MinimumWageEntitlementInput['source_manifest']=matched.filter(p=>p.review.page_count!==null).map(p=>({document_id:p.review.document_id,version_id:p.review.version_id,file_sha256:p.review.file_sha256,page_count:p.review.page_count!,kind:'case_document',case_id:input.case_id}));
 if(!manifest.length)return candidate;
 const evaluatedAt=matched.map(p=>p.extraction.extracted_at).sort().at(-1)!;
 const packet={...(input.entitlement_evidence??{schema_version:'entitlement-source-evidence-v1' as const,case_id:input.case_id,order_id:input.purchased_scope.order_id,receipt_sha256:input.purchased_scope.receipt_sha256,period:input.period})};
 const rows=ordinary.checks.flatMap(check=>{
  const c=documentReviewCalculationInputSchema.parse(check.calculation);if(c.operation.kind!=='product')return [];
  const recordedRef=c.operation.recorded_ref,amount=c.operands.find(o=>o.id===recordedRef);if(!amount)return [];
  const pair=current.find(p=>p.review.document_id===amount.source.document_id);if(!pair)return [];
  const component=pair.extraction.additional_components.find(r=>amount.observation_id===r.component_id+':amount');if(!component)return [];
  return [{check,c,amount,pair,component}];
 });
 if(minimum){
  const components:MinimumWageEntitlementInput['components']=rows.map(({amount,component})=>{
   const kind=component.semantic_kind==='hourly_base'||component.semantic_kind==='base_salary'?'base_salary':component.semantic_kind==='travel'?'expense_reimbursement':component.semantic_kind.startsWith('overtime_')?'overtime':'unknown';
   return {id:'component.'+canonicalSha256({document:amount.source.document_id,observation:amount.observation_id}).slice(0,24),amount,
    period:{state:'observed',value:input.period,source:amount.source},classification:{state:kind==='unknown'?'unknown':'observed',value:kind,source:amount.source}};
  });
  // Scalar monthly base is a fallback reading, never an extra term beside
  // the same row amount. A pension base or a gross total is not substituted.
  for(const [i,value]of values.entries())if(value.base&&!rows.some(r=>r.pair.review.document_id===current[i].review.document_id&&['hourly_base','base_salary'].includes(r.component.semantic_kind)))components.push({id:'scalar.base.'+i,amount:value.base,period:{state:'observed',value:input.period,source:value.base.source},classification:{state:'observed',value:'base_salary',source:value.base.source}});
  const single=current.length===1?values[0]:null;
  const printed=ordinary.checks.filter(c=>c.printed_inventory);
  const inventorySource=printed.length===1?documentReviewCalculationInputSchema.parse(printed[0].calculation).operands[0]?.source:components[0]?.amount.source;
  // Printed reconciliation expressly does not establish payable completeness.
  // Its provenance is retained, but legal eligible-pay inventory needs its own
  // source assessment; blank rows and unpurchased components are not zero.
  const inventory:MinimumWageEntitlementInput['eligible_pay_inventory']=inventorySource?{state:'unknown',value:'unknown',source:inventorySource}:missing;
  packet.minimum_wage=minimumWageEntitlementInputSchema.parse({schema_version:'minimum-wage-entitlement-input-v1',catalog_version:'1.0.0',case_id:input.case_id,run_id:'automatic.source.selection',check_id:'entitlement.minimum-wage',period:input.period,evaluated_at:evaluatedAt,source_manifest:manifest,
   method:missing,population:missing,employment:missing,ordinary_hours:single?.hours??null,ordinary_hours_period:single?.hoursPeriod??missing,
   monthly_coverage:missing,eligible_pay_inventory:inventory,components,applicability:[]});
 }
 if(travel){
  const sourceAmounts=values.flatMap(v=>v.travel?[v.travel]:[]);
  const rowAmounts=rows.filter(r=>r.component.semantic_kind==='travel').map(r=>r.amount);
  // A unique canonical scalar may duplicate its source row; prefer it. More
  // than one current payslip/row is not summed or chosen by value equality.
  const hasScalar=current.some(p=>p.extraction.fields.some(f=>f.field==='travel_amount'));
  const recorded=current.length===1?(hasScalar?sourceAmounts.length===1?sourceAmounts[0]:null:rowAmounts.length===1?rowAmounts[0]:null):null;
  const transport=questionnaireFactSource(prepared,'travel.employer_provides_transport','no_employer_transport');
  const travelManifest=[...manifest];
  if(transport)travelManifest.push(transport.manifest);
  const employerTransport:TravelEntitlementInput['facts']['employer_transport']=transport?.value==='none'
   ?{state:'known',value:'none',source:transport.source,basis:'customer_declaration'}:travelMissing;
  packet.travel=travelEntitlementInputSchema.parse({schema_version:'travel-entitlement-input-v1',catalog_id:'il.review.travel.general.2026',catalog_version:'1.0.0',case_id:input.case_id,run_id:'automatic.source.selection',check_prefix:'entitlement.travel',period:input.period,evaluated_at:evaluatedAt,source_manifest:travelManifest,
   facts:{needs_transport:travelMissing,employer_transport:employerTransport,free_travel:travelMissing},commute_days:null,discounted_daily_fare:null,monthly_pass:travelMissing,monthly_pass_cost:null,recorded,applicability:[],remittance_status:'not_assessed'});
 }
 return documentReviewInputSchema.parse({...prepared,entitlement_evidence:packet});
}
