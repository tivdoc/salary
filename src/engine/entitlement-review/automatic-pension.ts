import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {StoredCaseInputSnapshot} from '../case-analysis/contracts.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewOperand,type DocumentReviewSource} from '../document-review/calculations.ts';
import {validatePayslipGate0,SOURCE_ROW_DUPLICATE_POLICY} from '../extraction/validation.ts';
import {resolvePayslipSnapshot,resolvedPayslipFactPaths,IDENTIFIED_AGREEING_CANDIDATES_POLICY} from '../extraction/resolver.ts';
import {materializeValidatedPayslipReadings} from '../extraction/reading-resolution.ts';
import {payslipSourcePeriod} from '../extraction/source-period-association.ts';
import {payslipMachineExtractionSha256} from '../extraction/reading-resolution.ts';
import {reviewInputFromPayslips,PAYSLIP_REVIEW_POLICY} from '../document-review/payslip-adapter.ts';
import {validateReviewSourceStructure} from '../document-review/source-structure-evidence.ts';
import {entitlementDeclarationsSchema,questionnaireFactSource} from './declarations.ts';
import {pensionEntitlementInputSchema,type PensionEntitlementInput} from './pension/index.ts';
import {isPinnedEntitlementLegalDocument} from './legal-documents.ts';
import {emptyPensionSourceFacts,PENSION_STATUTORY_FLOOR_POLICY} from './pension/source-fact-contracts.ts';
import {pensionProductFacts} from './pension/product-facts.ts';
import {attachPensionSourceFacts} from './pension/source-facts.ts';
const uuid=(v:unknown)=>{const h=canonicalSha256(v);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};

function employmentStart(input:DocumentReviewInput,snapshot:StoredCaseInputSnapshot,identifiedOrigin=false){
 const observations:{value:string;source:DocumentReviewSource}[]=[];
 for(const original of snapshot.documents){
  const extraction=snapshot.extractions.find(e=>e.document_id===original.document_id),document=input.documents.find(d=>d.document_id===original.document_id&&d.file_sha256===original.content_sha256);
  if(!extraction||!document||document.reading_sha256!==canonicalSha256(extraction))continue;
  const reading=materializeValidatedPayslipReadings({document:original,extraction,case_id:input.case_id,requireDistinctTargets:true}),materialized=reading.extraction;
  const validation=validatePayslipGate0(materialized,{reference_year:Number(input.period.from.slice(0,4)),component_duplicate_policy:SOURCE_ROW_DUPLICATE_POLICY});
  const receipt=canonicalSha256(extraction),context={snapshot_id:uuid([receipt,'snapshot']),analysis_run_id:uuid([receipt,'reading-run']),case_id:input.case_id,schema_version:'1.0.0',created_at:materialized.extracted_at,
   fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(p=>[p,uuid([receipt,p])]))};
  const resolved=resolvePayslipSnapshot({document:original,extraction,validation,context,reading_policy:IDENTIFIED_AGREEING_CANDIDATES_POLICY});
  const period=resolved.facts.find(f=>f.path==='documents.period'),fact=resolved.facts.find(f=>f.path==='employment.start_date');
  if(period?.status!=='confirmed'||fact?.status!=='confirmed'||typeof fact.value!=='string')continue;
  const fields=materialized.fields.filter(f=>f.field==='employment_start_date');
  if(!fields.length||fields.some(f=>f.normalized_value!==fact.value))continue;
  const first=fields[0];observations.push({value:fact.value,source:{document_id:document.document_id,version_id:document.version_id,file_sha256:document.file_sha256,page:first.source.page,
   locator:JSON.stringify({field:'employment_start_date',candidate_ids:fields.map(f=>f.candidate_id),candidate_sha256:fields.map(f=>canonicalSha256(f))}),
   label:'תאריך תחילת עבודה שנקרא במסמך',reading:identifiedOrigin&&fields.every(f=>reading.readings.has(f.candidate_id))?'identified_document_reading':'provider_extraction',reading_receipt_sha256:document.reading_sha256}});
 }
 if(!observations.length)return null;
 if(new Set(observations.map(o=>o.value)).size!==1)return {state:'conflict' as const,value:null,source:observations[0].source,basis:'ai_source_assessment' as const};
 return {state:'known' as const,...observations[0],basis:'ai_source_assessment' as const};
}

function currentPensionSources(input:DocumentReviewInput,snapshot:StoredCaseInputSnapshot){
 if(new Set(snapshot.documents.map(d=>d.document_id)).size!==snapshot.documents.length||new Set(snapshot.extractions.map(e=>e.document_id)).size!==snapshot.extractions.length)throw Error('AUTOMATIC_PENSION_DUPLICATE_SOURCE');
 const pairs=snapshot.documents.flatMap(document=>{
  const extraction=snapshot.extractions.find(e=>e.document_id===document.document_id),review=input.documents.find(d=>d.document_id===document.document_id);
  if(document.case_id!==input.case_id||review&&review.case_id!==input.case_id)throw Error('AUTOMATIC_PENSION_SOURCE_CASE');
  return extraction&&review&&review.version_id===document.document_id&&review.file_sha256===document.content_sha256&&review.reading_sha256===canonicalSha256(extraction)?[{document,extraction,review}]:[];
 });
 const selected={...snapshot,documents:pairs.map(p=>p.document),extractions:pairs.map(p=>p.extraction)};
 const ordinary=reviewInputFromPayslips({case_id:input.case_id,period:input.period,purchased_scope:input.purchased_scope,snapshot:selected,review_policy:PAYSLIP_REVIEW_POLICY});
 const bases:DocumentReviewOperand[]=[];
 for(const p of pairs){
  const m=materializeValidatedPayslipReadings({document:p.document,extraction:p.extraction,case_id:input.case_id,requireDistinctTargets:true}),e=m.extraction;
  const validation=validatePayslipGate0(e,{reference_year:Number(input.period.from.slice(0,4)),component_duplicate_policy:SOURCE_ROW_DUPLICATE_POLICY});
  const receipt=canonicalSha256(p.extraction),context={snapshot_id:uuid([receipt,'snapshot']),analysis_run_id:uuid([receipt,'reading-run']),case_id:input.case_id,schema_version:'1.0.0',created_at:e.extracted_at,fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(path=>[path,uuid([receipt,path])]))};
  const resolved=resolvePayslipSnapshot({document:p.document,extraction:p.extraction,validation,context,reading_policy:IDENTIFIED_AGREEING_CANDIDATES_POLICY});
  const fact=resolved.facts.find(f=>f.path==='pension.base_salary'),period=resolved.facts.find(f=>f.path==='documents.period');
  const fields=e.fields.filter(f=>f.field==='pension_base'),periods=e.fields.filter(f=>f.field==='salary_period');
  if(e.status==='failed'||e.document_quality_confidence<.65||period?.status!=='confirmed'||!periods.length||periods.some(f=>f.normalized_value?.start_date!==input.period.from||f.normalized_value?.end_date!==input.period.to)
   ||fact?.status!=='confirmed'||!fields.length||fields.some(f=>payslipSourcePeriod({original:m.original,structureReadings:m.structureReadings,
    ref:{kind:'field',id:f.candidate_id},period:input.period}).state!=='current'||canonicalSha256(f.normalized_value)!==canonicalSha256(fields[0].normalized_value)))continue;
  const v=fields[0].normalized_value;if(!v||typeof v!=='object'||!('currency'in v)||!('minor_units'in v)||v.currency!=='ILS'||v.minor_units<0)continue;
  const originals=p.extraction.fields.filter(f=>fields.some(x=>x.candidate_id===f.candidate_id));
  const locator={schema_version:'document-review-source-locator-v2',field:'pension_base',candidate_ids:originals.map(f=>f.candidate_id),candidate_sha256:originals.map(f=>canonicalSha256(f))};
  const encoded=JSON.stringify(locator);
  bases.push({id:'pension.source.base',observation_id:fields[0].candidate_id,state:'observed',printed_value:(v.minor_units/100).toFixed(2),representation:'money_ils',quantity_unit:null,precision:'source_exact',source:{document_id:p.review.document_id,version_id:p.review.version_id,file_sha256:p.review.file_sha256,page:fields[0].source.page,
   locator:encoded.length<=500?encoded:JSON.stringify({schema_version:'pension-automatic-base-v2',observations_sha256:canonicalSha256(originals)}),label:'בסיס מבוטח מודפס; סיווג השכר נבדק בנפרד',reading:fields.every(f=>m.readings.has(f.candidate_id))?'identified_document_reading':'provider_extraction',reading_receipt_sha256:p.review.reading_sha256}});
 }
 const checks=input.checks.filter(check=>{
  const c=documentReviewCalculationInputSchema.parse(check.calculation);if(c.operation.kind!=='observed_ratio'||c.source_structure?.kind!=='source_relationship')return false;
  const pair=pairs.find(p=>p.document.document_id===c.source_structure?.document_id);
  if(!pair||c.case_id!==input.case_id||canonicalSha256(c.period)!==canonicalSha256(input.period)||c.source_structure.reading_sha256!==canonicalSha256(pair.extraction)||c.source_structure.machine_extraction_sha256!==payslipMachineExtractionSha256(pair.extraction))return false;
  validateReviewSourceStructure(c);
  if(c.source_structure.entry.reading&&!pair.extraction.customer_source_structures?.some(r=>canonicalSha256(r)===canonicalSha256(c.source_structure?.kind==='source_relationship'?c.source_structure.entry.reading:null)))return false;
  return ordinary.checks.some(check=>{const fresh=documentReviewCalculationInputSchema.parse(check.calculation);return fresh.operation.kind==='observed_ratio'&&canonicalSha256(fresh.operands)===canonicalSha256(c.operands);});
 });
 return {bases,checks};
}

/** Ordinary saved input only: reuse accepted readings and source links. No
 * guessed pension product, split combined contribution or legal approval. */
export function attachAutomaticPensionEvidence(candidate:DocumentReviewInput,snapshot:StoredCaseInputSnapshot,options:{source_facts?:boolean}={}):DocumentReviewInput{
 if((options.source_facts?candidate.entitlement_evidence?.pension!==undefined||candidate.entitlement_composition!==undefined:!!candidate.entitlement_evidence)||!candidate.purchased_scope.topics.includes('pension')||candidate.period.from<'2026-05-01'||candidate.period.to>'2026-07-31')return candidate;
 const ordinary=candidate.documents.filter(d=>d.page_count!==null&&!isPinnedEntitlementLegalDocument(d,candidate.case_id));if(!ordinary.length)return candidate;
 const declarations=entitlementDeclarationsSchema.parse({schema_version:'entitlement-questionnaire-evidence-v1',...snapshot.declared_fact_snapshot,period:candidate.period});
 if(options.source_facts&&candidate.entitlement_declarations&&canonicalSha256(candidate.entitlement_declarations)!==canonicalSha256(declarations))throw Error('AUTOMATIC_PENSION_DECLARATIONS_CHANGED');
 const input=documentReviewInputSchema.parse({...candidate,entitlement_declarations:declarations});
 const missing={state:'missing' as const,value:null,source:null,basis:'ai_source_assessment' as const};
 const manifest: PensionEntitlementInput['source_manifest']=ordinary.map(d=>({document_id:d.document_id,version_id:d.version_id,file_sha256:d.file_sha256,page_count:d.page_count!,kind:'case_document',case_id:input.case_id}));
 const declared=(path:string,transform:Parameters<typeof questionnaireFactSource>[2]='identity')=>{
  const evidence=questionnaireFactSource(input,path,transform);if(!evidence)return missing;
  if(!manifest.some(m=>m.document_id===evidence.manifest.document_id))manifest.push(evidence.manifest);
  return {state:'known' as const,value:evidence.value,source:evidence.source,basis:'customer_declaration' as const};
 };
 const current=options.source_facts?currentPensionSources(input,snapshot):null;
 const candidates:DocumentReviewOperand[]=current?[...current.bases]:[],recorded:PensionEntitlementInput['recorded']=[];
 for(const check of (current?.checks??input.checks).filter(c=>c.topic==='pension')){
  const c=documentReviewCalculationInputSchema.parse(check.calculation);if(c.operation.kind!=='observed_ratio')continue;
  const denominator=c.operation.denominator_ref,base=c.operands.find(o=>o.id===denominator);
  if(!current&&base&&base.state==='observed'&&base.representation==='money_ils'&&base.printed_value!==null)candidates.push(base);
  const structure=c.source_structure;
  if(structure?.kind!=='source_relationship'||structure.entry.reading?.value.kind!=='source_relationship')continue;
  const component=structure.entry.reading.value.component_kind;
  const share={pension_employee:'employee',pension_employer:'employer',severance:'severance',combined_employer_funds:'combined_employer'}[component] as PensionEntitlementInput['recorded'][number]['share'];
  // Unresolved links stay in the arithmetic report and reading requests. The
  // entitlement resolver independently verifies each usable relationship.
  if(!recorded.some(r=>r.share===share))recorded.push({share,relationship_check:c});
 }
 const unique=[...new Map(candidates.map(c=>[canonicalSha256({...c,id:'wage'}),c])).values()];
 const wage=unique.length===1?unique[0]:options.source_facts&&unique.length>1?{...unique[0],state:'conflict' as const,printed_value:null}:null;
 const evaluatedAt=[...snapshot.extractions.map(e=>e.extracted_at),...input.checks.map(c=>documentReviewCalculationInputSchema.parse(c.calculation).evaluated_at),...(options.source_facts?(input.non_payslip_evidence??[]).map(r=>r.document.created_at):[])].sort().at(-1);
 if(!evaluatedAt)return candidate;
 const pension=pensionEntitlementInputSchema.parse({schema_version:'pension-entitlement-input-v1',catalog_id:'il.review.pension.general.2026',catalog_version:'1.0.0',
  case_id:input.case_id,run_id:'automatic.source.selection',check_prefix:'entitlement.pension',period:input.period,
  evaluated_at:evaluatedAt,source_manifest:manifest,
  facts:{employment_start:employmentStart(input,snapshot,options.source_facts)??missing,employment_end:declared('employment.still_employed','ongoing_employment'),
   prior_coverage_at_start:declared('pension.fund_at_hire'),continuous_employment:missing,
   aged_21_or_more:declared('person.birth_year','aged_21_for_period'),under_60:declared('person.birth_year','under_60_for_period')},
  pensionable_wage:wage,eligible_interval_wage:null,applicability:[],recorded,remittance_status:'missing',
  ...(options.source_facts?{source_facts:emptyPensionSourceFacts({tables:true}),product_facts:pensionProductFacts({tables:true}),calculation_policy:PENSION_STATUTORY_FLOOR_POLICY}:{})});
 const prepared=options.source_facts?attachPensionSourceFacts(pension,input).input:pension;
 return documentReviewInputSchema.parse({...input,entitlement_evidence:{schema_version:'entitlement-source-evidence-v1',case_id:input.case_id,
  order_id:input.purchased_scope.order_id,receipt_sha256:input.purchased_scope.receipt_sha256,period:input.period,...(options.source_facts?input.entitlement_evidence:{}),pension:prepared}});
}
