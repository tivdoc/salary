import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {StoredCaseInputSnapshot} from '../case-analysis/contracts.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../document-review/contracts.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewOperand,type DocumentReviewSource} from '../document-review/calculations.ts';
import {validatePayslipGate0,SOURCE_ROW_DUPLICATE_POLICY} from '../extraction/validation.ts';
import {resolvePayslipSnapshot,resolvedPayslipFactPaths,IDENTIFIED_AGREEING_CANDIDATES_POLICY} from '../extraction/resolver.ts';
import {materializeValidatedPayslipReadings} from '../extraction/reading-resolution.ts';
import {entitlementDeclarationsSchema,questionnaireFactSource} from './declarations.ts';
import {pensionEntitlementInputSchema,type PensionEntitlementInput} from './pension/index.ts';
import {isPinnedEntitlementLegalDocument} from './legal-documents.ts';
const uuid=(v:unknown)=>{const h=canonicalSha256(v);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;};

function employmentStart(input:DocumentReviewInput,snapshot:StoredCaseInputSnapshot){
 const observations:{value:string;source:DocumentReviewSource}[]=[];
 for(const original of snapshot.documents){
  const extraction=snapshot.extractions.find(e=>e.document_id===original.document_id),document=input.documents.find(d=>d.document_id===original.document_id&&d.file_sha256===original.content_sha256);
  if(!extraction||!document||document.reading_sha256!==canonicalSha256(extraction))continue;
  const materialized=materializeValidatedPayslipReadings({document:original,extraction,case_id:input.case_id,requireDistinctTargets:true}).extraction;
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
   label:'תאריך תחילת עבודה שנקרא במסמך',reading:'provider_extraction',reading_receipt_sha256:document.reading_sha256}});
 }
 if(!observations.length)return null;
 if(new Set(observations.map(o=>o.value)).size!==1)return {state:'conflict' as const,value:null,source:observations[0].source,basis:'ai_source_assessment' as const};
 return {state:'known' as const,...observations[0],basis:'ai_source_assessment' as const};
}

/** Ordinary saved input only: reuse accepted readings and source links. No
 * guessed pension product, split combined contribution or legal approval. */
export function attachAutomaticPensionEvidence(candidate:DocumentReviewInput,snapshot:StoredCaseInputSnapshot):DocumentReviewInput{
 if(candidate.entitlement_evidence||!candidate.purchased_scope.topics.includes('pension')||candidate.period.from<'2026-05-01'||candidate.period.to>'2026-07-31')return candidate;
 const ordinary=candidate.documents.filter(d=>d.page_count!==null&&!isPinnedEntitlementLegalDocument(d,candidate.case_id));if(!ordinary.length)return candidate;
 const declarations=entitlementDeclarationsSchema.parse({schema_version:'entitlement-questionnaire-evidence-v1',...snapshot.declared_fact_snapshot,period:candidate.period});
 const input=documentReviewInputSchema.parse({...candidate,entitlement_declarations:declarations});
 const missing={state:'missing' as const,value:null,source:null,basis:'ai_source_assessment' as const};
 const manifest: PensionEntitlementInput['source_manifest']=ordinary.map(d=>({document_id:d.document_id,version_id:d.version_id,file_sha256:d.file_sha256,page_count:d.page_count!,kind:'case_document',case_id:input.case_id}));
 const declared=(path:string,transform:Parameters<typeof questionnaireFactSource>[2]='identity')=>{
  const evidence=questionnaireFactSource(input,path,transform);if(!evidence)return missing;
  if(!manifest.some(m=>m.document_id===evidence.manifest.document_id))manifest.push(evidence.manifest);
  return {state:'known' as const,value:evidence.value,source:evidence.source,basis:'customer_declaration' as const};
 };
 const candidates:DocumentReviewOperand[]=[],recorded:PensionEntitlementInput['recorded']=[];
 for(const check of input.checks.filter(c=>c.topic==='pension')){
  const c=documentReviewCalculationInputSchema.parse(check.calculation);if(c.operation.kind!=='observed_ratio')continue;
  const denominator=c.operation.denominator_ref,base=c.operands.find(o=>o.id===denominator);
  if(base&&base.state==='observed'&&base.representation==='money_ils'&&base.printed_value!==null)candidates.push(base);
  const structure=c.source_structure;
  if(structure?.kind!=='source_relationship'||structure.entry.reading?.value.kind!=='source_relationship')continue;
  const component=structure.entry.reading.value.component_kind;
  const share={pension_employee:'employee',pension_employer:'employer',severance:'severance',combined_employer_funds:'combined_employer'}[component] as PensionEntitlementInput['recorded'][number]['share'];
  // Unresolved links stay in the arithmetic report and reading requests. The
  // entitlement resolver independently verifies each usable relationship.
  if(!recorded.some(r=>r.share===share))recorded.push({share,relationship_check:c});
 }
 const unique=[...new Map(candidates.map(c=>[canonicalSha256({...c,id:'wage'}),c])).values()];
 const wage=unique.length===1?unique[0]:null;
 const evaluatedAt=[...snapshot.extractions.map(e=>e.extracted_at),...input.checks.map(c=>documentReviewCalculationInputSchema.parse(c.calculation).evaluated_at)].sort().at(-1);
 if(!evaluatedAt)return candidate;
 const pension=pensionEntitlementInputSchema.parse({schema_version:'pension-entitlement-input-v1',catalog_id:'il.review.pension.general.2026',catalog_version:'1.0.0',
  case_id:input.case_id,run_id:'automatic.source.selection',check_prefix:'entitlement.pension',period:input.period,
  evaluated_at:evaluatedAt,source_manifest:manifest,
  facts:{employment_start:employmentStart(input,snapshot)??missing,employment_end:declared('employment.still_employed','ongoing_employment'),
   prior_coverage_at_start:declared('pension.fund_at_hire'),continuous_employment:missing,
   aged_21_or_more:declared('person.birth_year','aged_21_for_period'),under_60:declared('person.birth_year','under_60_for_period')},
  pensionable_wage:wage,eligible_interval_wage:null,applicability:[],recorded,remittance_status:'missing'});
 return documentReviewInputSchema.parse({...input,entitlement_evidence:{schema_version:'entitlement-source-evidence-v1',case_id:input.case_id,
  order_id:input.purchased_scope.order_id,receipt_sha256:input.purchased_scope.receipt_sha256,period:input.period,pension}});
}
