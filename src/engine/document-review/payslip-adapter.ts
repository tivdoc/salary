import {payslipSourcePeriod} from '../extraction/source-period-association.ts';
import {IDENTIFIED_PERIOD_STRUCTURE_POLICY} from '../extraction/source-structure-period.ts';
import {z} from 'zod';
import {createDeductionScopeDerivation,isExplicitMandatorySubtotalCandidate} from '../extraction/deduction-source-scope.ts';
import {appendPayslipSourceStructures} from './payslip-source-structures.ts';
import type {DocumentReviewSourceStructure} from './source-structure-evidence.ts';
import type {StoredCaseInputSnapshot} from '../case-analysis/contracts.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {resolvePayslipSnapshot,resolvedPayslipFactPaths,IDENTIFIED_AGREEING_CANDIDATES_POLICY} from '../extraction/resolver.ts';
import {validatePayslipGate0,SOURCE_ROW_DUPLICATE_POLICY} from '../extraction/validation.ts';
import {normalizeMoney,normalizeDecimal,normalizePercentage} from '../extraction/normalization.ts';
import {materializeValidatedPayslipReadings,mappedRowCellCandidate,identifiedMappedRowCell,identifiedDirectRowCell,identifiedScopeObservation,identifiedSourceTranscription,payslipMachineExtractionSha256,payslipMachineExtraction} from '../extraction/reading-resolution.ts';
import {normalizedPayslipExtractionSchema,type NormalizedCandidateField,type NormalizedPayslipExtraction} from '../extraction/payslip.ts';
import {DOCUMENT_REVIEW_POLICY,DOCUMENT_REVIEW_COVERAGE_POLICY,PAYSLIP_ROW_REVIEW_TOPICS as rowTopic,type DocumentReviewInput} from './contracts.ts';
import type {DocumentReviewCalculationInput,DocumentReviewOperand} from './calculations.ts';
import type {ReviewCompletionNeed,ReviewCompletionInput} from './completions.ts';
import {deferredDocumentReviewRowPriceOperands} from './source-dependencies.ts';

export const PAYSLIP_FINANCIAL_SOURCE_FACT='payslip.financial_source';
export const PAYSLIP_FINANCIAL_SOURCE_POLICY='payslip-financial-source-v1';
export const PAYSLIP_REVIEW_POLICY='payslip-review-coverage-v2' as const;
export const PAYSLIP_SOURCE_STRUCTURE_POLICY='payslip-review-source-structures-v3' as const;
const financialSourceProofSchema=z.object({policy_version:z.literal(PAYSLIP_FINANCIAL_SOURCE_POLICY),case_id:z.uuid(),document_id:z.uuid(),
 source_sha256:z.string().regex(/^[a-f0-9]{64}$/u),normalized_extraction_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
 provider_receipt_sha256:z.string().regex(/^[a-f0-9]{64}$/u),source_page_count:z.number().int().min(1).max(12),complete_original_source:z.literal(true)}).strict();
/** Server supplies only after validating the checkpoint, raw-pass receipts and
 * original-file page coverage. A provider-reported page count is insufficient. */
export type PayslipFinancialSourceProof=Readonly<z.infer<typeof financialSourceProofSchema>>;
const retainedUnresolvedFieldsSchema=z.object({case_id:z.uuid(),document_id:z.string().min(1),source_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
 checkpoint_result_sha256:z.string().regex(/^[a-f0-9]{64}$/u),checkpoint_result:z.record(z.string(),z.unknown()),
 final_extraction_sha256:z.string().regex(/^[a-f0-9]{64}$/u),first_pass:normalizedPayslipExtractionSchema}).strict();
const retainedCheckpointPassesSchema=z.object({first_pass:z.object({normalized_extraction:normalizedPayslipExtractionSchema}).passthrough(),
 final_extraction:normalizedPayslipExtractionSchema}).passthrough();
/** Loaded from the already authenticated saved checkpoint, not a new source read. */
export type RetainedUnresolvedPayslipFields=Readonly<z.infer<typeof retainedUnresolvedFieldsSchema>>;
const financialSourceFields=['salary_period','gross_salary','total_deductions','net_salary'] as const;
const incompleteSourceFlags=new Set(['cropped_content','partial_visibility','incomplete_document','missing_page','truncated_document']);

type Topic=DocumentReviewInput['purchased_scope']['topics'][number];
type Component=NormalizedPayslipExtraction['additional_components'][number];
const scalarPaths:Readonly<Record<string,string>>={pension_base:'pension.base_salary',hourly_rate:'compensation.hourly_rate',gross_salary:'compensation.gross_salary',net_salary:'compensation.net_salary'};
// Only reading uncertainties already accepted by the canonical resolver. This
// bridge handles scalar fields (deduction totals/contributions) absent from its
// single-field map, after the resolver has validated every reading's binding.
const readingIssues=new Set(['low_field_confidence','moderate_field_confidence','ocr_value_ambiguous','recovery_reading_confirmation_required']);
function uuid(value:unknown){const h=canonicalSha256(value);return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;}
const decimalMoney=(minor:number)=>(minor/100).toFixed(2);
const monetary=(f:NormalizedCandidateField|undefined)=>f?.normalized_value&&typeof f.normalized_value==='object'&&'minor_units' in f.normalized_value?f.normalized_value:null;

/** Source arithmetic from the SAME saved extraction and canonical reading
 * policy. Neither a model confidence nor a customer's cell reading is legal
 * authority. Every original observation remains in the immutable receipt. */
export function reviewInputFromPayslips(input:{case_id:string;period:DocumentReviewInput['period'];purchased_scope:DocumentReviewInput['purchased_scope'];snapshot:StoredCaseInputSnapshot;financial_source_proofs?:readonly PayslipFinancialSourceProof[];review_policy?:typeof PAYSLIP_REVIEW_POLICY|typeof PAYSLIP_SOURCE_STRUCTURE_POLICY;retained_unresolved_fields?:readonly RetainedUnresolvedPayslipFields[];identified_period_structure_policy?:typeof IDENTIFIED_PERIOD_STRUCTURE_POLICY}):DocumentReviewInput{
 const {snapshot}=input;
 if(input.identified_period_structure_policy&&input.review_policy!==PAYSLIP_SOURCE_STRUCTURE_POLICY)throw Error('DOCUMENT_REVIEW_SOURCE_PERIOD_POLICY');
 const withCoverage=input.review_policy===PAYSLIP_REVIEW_POLICY||input.review_policy===PAYSLIP_SOURCE_STRUCTURE_POLICY;
 const proofs=(input.financial_source_proofs??[]).map(proof=>financialSourceProofSchema.parse(proof));
 const retained=(input.retained_unresolved_fields??[]).map(r=>retainedUnresolvedFieldsSchema.parse(r));
 if(retained.length&&!withCoverage
  ||new Set(retained.map(r=>r.document_id)).size!==retained.length
  ||retained.some(r=>r.case_id!==input.case_id||!snapshot.documents.some(d=>d.document_id===r.document_id&&d.content_sha256===r.source_sha256)))throw Error('DOCUMENT_REVIEW_RETAINED_SOURCE_BINDING');
 if(new Set(proofs.map(p=>p.document_id)).size!==proofs.length||proofs.some(p=>p.case_id!==input.case_id||!snapshot.documents.some(d=>d.document_id===p.document_id&&d.content_sha256===p.source_sha256)))throw Error('DOCUMENT_REVIEW_FINANCIAL_SOURCE_PROOF_BINDING');
 if(snapshot.documents.length!==snapshot.extractions.length||new Set(snapshot.documents.map(d=>d.document_id)).size!==snapshot.documents.length
  ||new Set(snapshot.extractions.map(e=>e.document_id)).size!==snapshot.extractions.length)throw Error('DOCUMENT_REVIEW_EXTRACTION_IDENTITY');
 const pairs=snapshot.documents.map(d=>{
  const e=snapshot.extractions.find(e=>e.document_id===d.document_id);
  if(!e||d.case_id!==input.case_id||[...e.fields,...e.additional_components].some(o=>o.source.document_id!==d.document_id))throw Error('DOCUMENT_REVIEW_EXTRACTION_IDENTITY');
  return {d,e};
 });
 const documents=pairs.map(({d,e},i)=>({case_id:d.case_id,document_id:d.document_id,version_id:d.document_id,file_sha256:d.content_sha256,
  page_count:Math.max(1,e.quality_metrics?.page_count??1,...e.fields.map(f=>f.source.page),...e.additional_components.map(c=>c.source.page)),
  kind:e.detected_document_type==='payslip'?'payslip' as const:'other' as const,
  label:e.detected_document_type==='payslip'?`תלוש ${input.period.from.slice(0,7)} — מסמך ${i+1}`:`מסמך ${i+1} — לא זוהה כתלוש`,
  period:d.document_period?.start_date&&d.document_period.end_date?{from:d.document_period.start_date,to:d.document_period.end_date}:null,
  reading_origin:'provider_extraction' as const,reading_sha256:canonicalSha256(e)}));
 const evidence:ReviewCompletionInput['evidence'][number][]=[],completedFinancialSources=new Set<string>();
 const checks:DocumentReviewInput['checks']=[],needs:ReviewCompletionNeed[]=[],coverage_gaps:DocumentReviewInput['coverage_gaps']=[],answer_bindings:DocumentReviewInput['answer_bindings']=[];
 const source_observation_inventory:NonNullable<DocumentReviewInput['source_observation_inventory']>=[];
 const source_semantic_derivations:NonNullable<DocumentReviewInput['source_semantic_derivations']>=[];
 for(const [index,{d:original,e:originalExtraction}] of pairs.entries()){
  const materialized=materializeValidatedPayslipReadings({document:original,extraction:originalExtraction,case_id:input.case_id,requireDistinctTargets:true});
  const originalMachine=payslipMachineExtraction(originalExtraction),prior=retained.find(r=>r.document_id===original.document_id);
  const derivation=withCoverage&&prior&&originalMachine.fields.some(isExplicitMandatorySubtotalCandidate)?createDeductionScopeDerivation({document:original,reading_sha256:documents[index].reading_sha256,
   checkpoint_result_sha256:prior.checkpoint_result_sha256,checkpoint_result:prior.checkpoint_result,original:originalMachine}):null;
  if(derivation)source_semantic_derivations.push(derivation);
  const excluded=new Set(derivation?.excluded_candidates.map(c=>c.candidate_id)??[]);
  const extraction=derivation?{...materialized.extraction,fields:materialized.extraction.fields.filter(c=>!excluded.has(c.candidate_id))}:materialized.extraction;
  const d=documents[index],receipt=d.reading_sha256,pin={case_id:input.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256};
  const gap=(id:string,topic:Topic,detail:string,next_step:string,kind:'missing_source'|'missing_fact'='missing_fact')=>{
   if(input.purchased_scope.topics.includes(topic))coverage_gaps.push({check_id:`document.${index}.${id}`,topic,kind,detail,next_step,source_pins:[pin]});
  };
  if(extraction.detected_document_type!=='payslip'){
   const topic=input.purchased_scope.topics[0];
   gap('financial.source',topic,'המסמך השמור לא זוהה כתלוש שכר. לא הופקו ממנו סכומי שכר.','יש לזהות תלוש שכר קריא לתקופה הנבדקת.','missing_source');
   needs.push({fact_key:`document.${index}.financial.source`,kind:'document',reason:'missing',required_evidence_kind:'document',question:'המסמך הקיים לא זוהה כתלוש. יש לצרף תלוש שכר קריא לתקופה הנבדקת.',answer_kind:'document',document_kind:'payslip',source_pins:[pin],dependent_check_ids:[`document.${index}.financial.source`],general_question:false});
   continue;
  }
  const validation=validatePayslipGate0(extraction,{reference_year:Number(input.period.from.slice(0,4)),component_duplicate_policy:SOURCE_ROW_DUPLICATE_POLICY});
  const context={snapshot_id:uuid([receipt,'snapshot']),analysis_run_id:uuid([receipt,'reading-run']),case_id:input.case_id,schema_version:'1.0.0',created_at:extraction.extracted_at,
   fact_ids:Object.fromEntries(resolvedPayslipFactPaths.map(p=>[p,uuid([receipt,p])]))};
  const resolved=resolvePayslipSnapshot({document:original,extraction:originalExtraction,validation,context,reading_policy:IDENTIFIED_AGREEING_CANDIDATES_POLICY});
  const globallyUnreadable=extraction.status==='failed'||extraction.document_quality_confidence<0.65;
  const periodFact=resolved.facts.find(f=>f.path==='documents.period');
  const periods=extraction.fields.filter(f=>f.field==='salary_period');
  const periodValid=periodFact?.status==='confirmed'&&periods.length>0&&periods.every(f=>f.normalized_value
   &&f.normalized_value.start_date>=input.period.from&&f.normalized_value.end_date<=input.period.to
   &&(!original.document_period||f.normalized_value.start_date===original.document_period.start_date&&f.normalized_value.end_date===original.document_period.end_date));
  if(!periodValid){gap('period',input.purchased_scope.topics[0],'לא אומתה התאמה בין חודש התלוש לתקופה הנבדקת.','יש לברר את חודש המקור לפני שיוך חישובים אליו.');continue;}
  if(withCoverage&&d.period===null){
   const observedPeriod=periods[0]?.normalized_value;
   // The immutable reading receipt already pins these candidates and the
   // canonical resolver has confirmed their agreement. This is source scope,
   // not evidence of the period originally purchased or a file metadata edit.
   if(observedPeriod&&periods.every(p=>p.normalized_value?.start_date===observedPeriod.start_date&&p.normalized_value.end_date===observedPeriod.end_date))
    d.period={from:observedPeriod.start_date,to:observedPeriod.end_date};
  }
  if(prior){
   const passes=retainedCheckpointPassesSchema.safeParse(prior.checkpoint_result);
   // The resolver assigns a separate final extraction ID. Bind both immutable
   // passes to the authenticated saved result, never by equality of pass IDs.
   if(!passes.success||canonicalSha256(prior.checkpoint_result)!==prior.checkpoint_result_sha256
    ||canonicalSha256(passes.data.first_pass.normalized_extraction)!==canonicalSha256(prior.first_pass)
    ||canonicalSha256(passes.data.final_extraction)!==prior.final_extraction_sha256
    ||prior.final_extraction_sha256!==payslipMachineExtractionSha256(originalExtraction)||prior.first_pass.document_id!==d.document_id
    ||[...prior.first_pass.fields,...prior.first_pass.additional_components,...(prior.first_pass.source_scope_observations??[]).map(o=>o.candidate)]
     .some(o=>o.source.document_id!==d.document_id||o.source.page>d.page_count))throw Error('DOCUMENT_REVIEW_RETAINED_SOURCE_BINDING');
   const observations=prior.first_pass.fields.filter(o=>(o.field==='vacation_balance'||o.field==='sick_balance')&&o.normalized_value===null
    &&!originalExtraction.fields.some(c=>c.candidate_id===o.candidate_id));
   if(observations.length){
    const unitReadings=observations.flatMap(o=>{
     const identified=identifiedSourceTranscription({original:originalExtraction,sourceTranscriptions:materialized.sourceTranscriptions,subjectKind:'balance_unit',candidateId:o.candidate_id});
     return identified?[identified.reading]:[];
    });
    source_observation_inventory.push({schema_version:'payslip-unresolved-fields-v1',document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256,
     reading_sha256:receipt,checkpoint_result_sha256:prior.checkpoint_result_sha256,original_pass_sha256:canonicalSha256(prior.first_pass),observations,
     ...(input.review_policy===PAYSLIP_SOURCE_STRUCTURE_POLICY?{outside_purchased_topics:observations.flatMap(o=>o.field==='sick_balance'&&!input.purchased_scope.topics.includes('sick_leave')?['sick_leave' as const]:o.field==='vacation_balance'&&!input.purchased_scope.topics.includes('vacation')?['vacation' as const]:[])}:{}),
     ...(unitReadings.length?{machine_extraction_sha256:prior.final_extraction_sha256,unit_readings:unitReadings}:{})});
    for(const field of (input.review_policy===PAYSLIP_SOURCE_STRUCTURE_POLICY?[]:['vacation_balance','sick_balance']) as ('vacation_balance'|'sick_balance')[]){
     const rows=observations.filter(o=>o.field===field);if(!rows.length)continue;
     const topic=field==='vacation_balance'?'vacation' as const:'sick_leave' as const,id=`balance.${field}.unit`,label=field==='vacation_balance'?'חופשה':'מחלה';
     if(rows.every(o=>unitReadings.some(r=>r.subject.kind==='balance_unit'&&r.subject.original_candidate.candidate_id===o.candidate_id))){
      gap(`balance.${field}.movement`,topic,`יחידת יתרת ${label} נקראה במענה מזוהה. עדיין לא נבנתה התאמה בין יתרת פתיחה, צבירה, ניצול ויתרה סופית.`,`לבדיקת התאמת יתרת ${label} נדרשות כל עמודות התנועה מאותה תקופה ובאותה יחידה.`);continue;
     }
     gap(id,topic,`נקראה יתרת ${label}, אך יחידות המקור לא זוהו. הנתון הגולמי נשמר; לא הונחו ימים או שעות ולא חושבה התאמת יתרה.`,`יש לזהות במקור את יחידת יתרת ${label} ואת נתוני הפתיחה, הצבירה והניצול לפני חישוב.`);
     if(input.purchased_scope.topics.includes(topic))needs.push({fact_key:`document.${index}.${id}`,kind:'factual',reason:'unknown',required_evidence_kind:'observed_reading',
      question:`באילו יחידות מוצגת יתרת ${label} במסמך — ימים, שעות או יחידה אחרת? אם לא מופיע או לא ניתן לקרוא, יש לציין זאת.`,answer_kind:'text',source_pins:[pin],dependent_check_ids:[`document.${index}.${id}`],general_question:false});
    }
   }
  }
  const manifest=[{document_id:d.document_id,version_id:d.version_id,file_sha256:d.file_sha256,page_count:d.page_count,kind:'case_document' as const,case_id:input.case_id}];
  const source=(page:number,label:string,locator:unknown):DocumentReviewOperand['source']=>{
   const encoded=JSON.stringify(withCoverage&&locator!==null&&typeof locator==='object'?{schema_version:'document-review-source-locator-v2',...locator}:locator),bounded=withCoverage&&encoded.length>500
    ?JSON.stringify({schema_version:'document-review-source-locator-v2',unavailable:'source_locator_too_large',observation_sha256:canonicalSha256(locator)}):encoded.slice(0,500);
   return {document_id:d.document_id,version_id:d.version_id,file_sha256:d.file_sha256,page,label:label.slice(0,300),locator:bounded,reading:'provider_extraction',reading_receipt_sha256:receipt};
  };
  const fieldState=(field:string):DocumentReviewOperand['state']=>{
   const candidates=extraction.fields.filter(f=>f.field===field);
   if(!candidates.length)return 'missing';
   if(globallyUnreadable)return 'unreadable';
   if(candidates.some(f=>!monetary(f)||monetary(f)?.currency!=='ILS'||canonicalSha256(normalizeMoney(f.raw_value))!==canonicalSha256(monetary(f))))return 'unreadable';
   const assessments=candidates.map(f=>validation.field_assessments.find(a=>a.candidate_id===f.candidate_id));
   if(new Set(candidates.map(f=>canonicalSha256(f.normalized_value))).size>1||assessments.some(a=>a?.issue_codes.includes('conflicting_candidates')))return 'conflict';
   if(assessments.some(a=>!a||a.status==='invalid'))return 'unreadable';
   const path=scalarPaths[field];
   if(path){
    if(resolved.facts.find(f=>f.path===path)?.status==='confirmed')return 'observed';
    // The canonical facts retain the original subtotal conflict. This local
    // arithmetic view may use separately identified gross/net cells only when
    // the pinned semantic derivation removes that cause and no other issue.
    if(derivation&&(field==='gross_salary'||field==='net_salary')&&validation.status!=='invalid'
     &&validation.issues.every(issue=>issue.field_candidate_ids.length>0||readingIssues.has(issue.code))
     &&candidates.every((c,i)=>materialized.readings.has(c.candidate_id)&&assessments[i]!.issue_codes.every(code=>readingIssues.has(code)||candidates.length>1&&code==='duplicate_candidate')))return 'observed';
    return 'unknown';
   }
   if(candidates.length!==1)return 'unknown';
   const f=candidates[0],a=assessments[0]!;
   const identified=extraction.customer_readings?.some(r=>r.candidate_id===f.candidate_id)&&a.issue_codes.every(c=>readingIssues.has(c));
   return identified||extraction.document_quality_confidence>=0.95&&f.confidence>=0.95&&a.status==='valid'&&f.warning_flags.length===0?'observed':'unknown';
  };
  const proof=proofs.find(p=>p.document_id===d.document_id);
  if(proof){
   if(proof.normalized_extraction_sha256!==payslipMachineExtractionSha256(originalExtraction)
    ||proof.source_page_count!==originalExtraction.quality_metrics?.page_count
    ||[...originalExtraction.fields,...originalExtraction.additional_components,...(originalExtraction.source_scope_observations??[]).map(o=>o.candidate)]
     .some(o=>o.source.document_id!==d.document_id||o.source.page>proof.source_page_count))throw Error('DOCUMENT_REVIEW_FINANCIAL_SOURCE_PROOF_BINDING');
   const cells=financialSourceFields.map(field=>extraction.fields.filter(f=>f.field===field));
   // This policy verifies only the four requested current-period source cells.
   // Unrelated pension rows stay partial and retain their own requests. No
   // model confidence, source receipt or whole-file flag confirms these cells.
   const ready=!globallyUnreadable&&extraction.status==='completed'
    &&![...extraction.warnings,...extraction.fields.flatMap(c=>c.warning_flags),...extraction.additional_components.flatMap(c=>c.warning_flags),...(extraction.source_scope_observations??[]).flatMap(o=>o.candidate.warning_flags)].some(flag=>incompleteSourceFlags.has(flag))
    &&cells.every(group=>group.length===1&&group.every(c=>materialized.readings.has(c.candidate_id)
     &&c.source.source_scope?.period_kind==='current'&&c.source.text_fragment?.trim()
     &&!c.warning_flags.some(flag=>incompleteSourceFlags.has(flag))))
    &&financialSourceFields.slice(1).every(field=>fieldState(field)==='observed');
   if(ready){
    completedFinancialSources.add(d.document_id);
    evidence.push({evidence_id:`financial-source:${canonicalSha256([proof,cells.map(group=>group[0].candidate_id)])}`,case_id:input.case_id,
     fact_key:PAYSLIP_FINANCIAL_SOURCE_FACT,period:input.period,origin:'document',state:'observed',source_reviewed:true,source_pins:[pin],
     value:JSON.stringify({policy_version:PAYSLIP_FINANCIAL_SOURCE_POLICY,proof,cells:cells.map(group=>({candidate_id:group[0].candidate_id,
      field:group[0].field,reading_sha256:canonicalSha256(materialized.readings.get(group[0].candidate_id))}))})});
   }
  }
  const moneyOperand=(field:string,id:string,label:string):DocumentReviewOperand=>{
   const candidates=extraction.fields.filter(f=>f.field===field),f=candidates[0],m=monetary(f);
   if(withCoverage&&field==='total_deductions'&&!candidates.length&&(prior||originalExtraction.source_reading_context)
    &&originalExtraction.quality_metrics.page_count===1){
    const transcribed=identifiedSourceTranscription({original:originalExtraction,sourceTranscriptions:materialized.sourceTranscriptions,subjectKind:'grand_total'});
    const value=transcribed?.normalized_value;
    return {id,observation_id:transcribed?`transcription:${transcribed.reading.target_sha256}`:`${d.version_id}:grand_total`,state:value?.kind==='grand_total'?'observed':'missing',
     printed_value:value?.kind==='grand_total'?decimalMoney(value.amount.minor_units):null,representation:'money_ils',quantity_unit:null,precision:'printed_precision',
     source:{...source(1,label,{transcription_kind:'grand_total',page:1,meaning:'document_total_deductions',
      ...(value?.kind==='grand_total'?{target_sha256:transcribed!.reading.target_sha256,label:value.label,locator:value.locator}:{})}),
      reading:transcribed?'identified_document_reading':'provider_extraction'}};
   }
   return {id,observation_id:f?.candidate_id??`${d.version_id}:${field}`,state:fieldState(field),printed_value:m?.currency==='ILS'?decimalMoney(m.minor_units):null,
    representation:'money_ils',quantity_unit:null,precision:'printed_precision',source:{...source(f?.source.page??1,label,withCoverage
     ?{field,candidate_ids:candidates.map(c=>c.candidate_id),candidate_sha256:candidates.map(c=>canonicalSha256(originalExtraction.fields.find(o=>o.candidate_id===c.candidate_id))),raw_values:candidates.map(c=>c.raw_value)}
     :{field,candidate_ids:candidates.map(f=>f.candidate_id),observations:candidates.map(f=>({candidate_id:f.candidate_id,raw:f.raw_value,source:f.source,original:originalExtraction.fields.find(o=>o.candidate_id===f.candidate_id)?.raw_value,reading_sha256:materialized.readings.has(f.candidate_id)?canonicalSha256(materialized.readings.get(f.candidate_id)):null}))}),reading:candidates.length>0&&candidates.every(f=>materialized.readings.has(f.candidate_id))?'identified_document_reading':'provider_extraction'}};
  };
  const add=(checkId:string,topic:Topic,title:string,explanation:string,operands:DocumentReviewOperand[],operation:DocumentReviewCalculationInput['operation'],requestReadings=true,structure?:DocumentReviewSourceStructure)=>{
   if(!input.purchased_scope.topics.includes(topic))return;
   const check_id=`document.${index}.${checkId}`;
   const calculation:DocumentReviewCalculationInput={schema_version:'document-review-calculation-input-v1',case_id:input.case_id,run_id:'pending',check_id,
    period:input.period,evaluated_at:new Date(extraction.extracted_at).toISOString(),source_manifest:manifest,operands,operation,remittance_status:'not_assessed',...(structure?{source_structure:structure}:{})};
   checks.push({check_id,topic,title,explanation,calculation});
   // A number cannot establish that a contribution belongs to this base.
   // Retain the blocked arithmetic and relationship gap until source linkage
   // exists; do not request cell confirmations that cannot change the result.
   if(!requestReadings||withCoverage&&operation.kind==='observed_ratio'&&!operation.same_period_and_base)return;
   const deferredPrices=withCoverage?deferredDocumentReviewRowPriceOperands(calculation,originalExtraction):new Set<string>();
   if(deferredPrices.size){
    needs.push({fact_key:`${check_id}.missing_basis`,kind:'factual',reason:'missing',required_evidence_kind:'observed_reading',
     question:`לגבי ${title.slice(0,100)}: תאי הכמות והסכום ריקים. האם קיים רישום או מסמך נוסף שמפרט את הכמות או השעות ואת התשלום בשורה זו? ציין מה קיים ומה מקורו; אם אין או לא ידוע, ציין זאת. אין צורך להעתיק מספר שאינו מופיע בתלוש.`,
     answer_kind:'text',source_pins:[pin],dependent_check_ids:[check_id,`${check_id}.blank_basis`],general_question:false});
    // Text describes potential evidence. It is never bound to a numeric
    // operand, and the existing planner requires source review after receipt.
    return deferredPrices;
   }
   for(const operand of operands.filter(o=>o.state!=='observed'&&!deferredPrices.has(o.id))){
    const fact_key=`document.${index}.${checkId}.${operand.id}`;
    needs.push({fact_key,kind:'factual',reason:operand.state==='conflict'?'conflicted':operand.state==='missing'?'missing':operand.state==='unreadable'?'unreadable':'unknown',
     required_evidence_kind:'observed_reading',question:`לצורך ${title}: מהו ${operand.source.label} במקור המסומן? אם לא ניתן לקבוע, יש לציין זאת.`,answer_kind:'number',source_pins:[pin],dependent_check_ids:[check_id],general_question:false});
    answer_bindings.push({fact_key,check_id,operand_id:operand.id});
   }
   return deferredPrices;
  };
  const scopedOperand=(scope:NonNullable<NormalizedPayslipExtraction['source_scope_observations']>[number]['scope'],id:string,label:string):DocumentReviewOperand=>{
   const candidates=extraction.source_scope_observations?.filter(o=>o.scope===scope)??[],candidate=candidates[0]?.candidate;
   const values=candidates.map(o=>normalizeMoney(o.candidate.raw_value)),value=values[0]??null;
   const conflict=new Set(values.map(v=>canonicalSha256(v))).size>1;
   const invalid=!candidates.length||values.some(v=>!v||v.currency!=='ILS');
   const confirmed=candidates.length>0&&candidates.every(o=>{
    const original=originalExtraction.source_scope_observations?.find(c=>c.candidate.candidate_id===o.candidate.candidate_id);
    return original&&identifiedScopeObservation({original:originalExtraction,effective:extraction,scopeReadings:materialized.scopeReadings,observation:original});
   });
   const uncertain=extraction.document_quality_confidence<.95||candidates.some(o=>!confirmed&&o.candidate.confidence<.95||o.candidate.warning_flags.length>0||o.candidate.source.source_scope?.period_kind!=='current');
   return {id,observation_id:candidate?.candidate_id??`${d.version_id}:${scope}`,state:!candidates.length?'missing':conflict?'conflict':globallyUnreadable||invalid?'unreadable':uncertain?'unknown':'observed',
    printed_value:value?.currency==='ILS'?decimalMoney(value.minor_units):null,representation:'money_ils',quantity_unit:null,precision:'printed_precision',
    source:{...source(candidate?.source.page??1,label,{scope,candidate_ids:candidates.map(o=>o.candidate.candidate_id),
     scope_observation_sha256:candidates.map(o=>canonicalSha256(originalExtraction.source_scope_observations?.find(c=>c.candidate.candidate_id===o.candidate.candidate_id))),raw_values:candidates.map(o=>o.candidate.raw_value)}),reading:confirmed?'identified_document_reading':'provider_extraction'}};
  };
  if(withCoverage){
   const scopes=extraction.source_scope_observations??[];
   if(scopes.some(o=>o.scope==='voluntary_deduction'||o.scope==='final_payable'))
    add('net.final','minimum_wage','התאמת נטו וסכום לתשלום לאחר ניכויי רשות','בדיקת הנטו המודפס פחות ניכויי הרשות, מול שדה לתשלום הנפרד. אין בכך אימות של העברה לחשבון.',
     [moneyOperand('net_salary','net','נטו'),scopedOperand('voluntary_deduction','voluntary','ניכויי רשות'),scopedOperand('final_payable','final','לתשלום')],
     {kind:'reconciliation',add_refs:['net'],subtract_refs:['voluntary'],recorded_ref:'final',inventory_complete:scopes.filter(o=>o.scope==='voluntary_deduction').length===1&&scopes.filter(o=>o.scope==='final_payable').length===1,
      inventory_basis:'One explicitly classified current voluntary deduction total and one separately classified final payable; no substitution of net and final payable.',disjoint_components:true,overlap_basis:'Voluntary deductions are subtracted once after the printed net amount.'});
   if(scopes.some(o=>o.scope==='combined_employer_funds')){
    // The source labels separate a combined employer amount from an employer
    // pension-only amount. Classification does not prove a matching fund base.
    add('ratio.combined_employer_funds','pension','יחס נצפה — רכיבי מעסיק משולבים','הסכום המשולב נשמר בנפרד מפנסיית מעסיק ומפיצויים. ללא בסיס תואם מאומת לא מוצג יחס או שיעור חובה.',
     [scopedOperand('combined_employer_funds','contribution','סכום מעסיק משולב'),moneyOperand('pension_base','base','בסיס מבוטח')],
     {kind:'observed_ratio',numerator_ref:'contribution',denominator_ref:'base',component_identity:'combined_employer_funds',same_period_and_base:false,
      basis:'A combined source amount is present, but its exact fund/base relationship has not been independently established.'});
    gap('ratio.combined_employer_funds.relationship','pension','הסכום המשולב לא פוצל לפנסיה ולפיצויים ולא הוצמד לבסיס מסוים.','יש לזהות במסמך את רכיבי הסכום ואת הבסיס התואם; אין צורך באישור הפקדה לשם בדיקת היחס.');
   }
  }
  for(const [field,label] of [['pension_employee_contribution','ניכוי עובד לפנסיה'],['pension_employer_contribution','רכיב מעסיק לפנסיה'],['severance_contribution','רכיב פיצויים']] as const){
   if(!extraction.fields.some(f=>f.field===field))continue;
   const contributions=extraction.fields.filter(f=>f.field===field),bases=extraction.fields.filter(f=>f.field==='pension_base'),c=contributions[0],b=bases[0];
   const ct=c?.source.text_fragment??'',bt=b?.source.text_fragment??'',both=`${bt} ${ct}`;
   // Same normalized names alone do not prove the same fund/base. Require a
   // source-labelled pension row shared by the two cells, or an identical
   // source excerpt containing both values and the relationship's labels.
   const cb=c?.source.bounding_box,bb=b?.source.bounding_box;
   const sharedRow=cb&&bb&&cb.coordinate_space===bb.coordinate_space&&Math.max(cb.y,bb.y)<Math.min(cb.y+cb.height,bb.y+bb.height);
   const sharedExcerpt=ct===bt&&ct.includes(c?.raw_value??'\u0000')&&ct.includes(b?.raw_value??'\u0000');
   const labelledBase=/pension\s+base|insured\s+(salary|base)|שכר\s*(מבוטח|לפנסיה|לגמל)|בסיס\s*(לפנסיה|פנסיה|לגמל|גמל)/iu.test(bt);
   const labelledContribution=field==='severance_contribution'?/פיצויים|severance/iu.test(ct):/פנסיה|pension/iu.test(ct);
   const related=contributions.length===1&&bases.length===1&&c.source.page===b.source.page&&labelledBase&&labelledContribution&&!/השתלמות|study\s*fund/iu.test(both)&&Boolean(sharedRow||sharedExcerpt)
    &&(!input.identified_period_structure_policy||[c,b].every(f=>f.source.source_scope?.period_kind==='current'
     &&payslipSourcePeriod({original:materialized.original,structureReadings:materialized.structureReadings,ref:{kind:'field',id:f.candidate_id},period:input.period}).state==='current'));
   add(`ratio.${field}`,'pension',`יחס נצפה — ${label}`,'יחס בין סכום לבסיס שזוהו באותו רכיב. זה אינו שיעור חובה ואינו אישור הפקדה.',
    [moneyOperand(field,'contribution',label),moneyOperand('pension_base','base','בסיס הפנסיה')],{kind:'observed_ratio',numerator_ref:'contribution',denominator_ref:'base',component_identity:label,same_period_and_base:related,
     basis:related?'Explicit source-labelled same pension row/excerpt and confirmed source period; immutable observations retain labels and locations.':'The saved source does not establish that this contribution and this base belong to the same pension component.'});
   if(!related)gap(`ratio.${field}.relationship`,'pension','לא הוכח שהסכום ובסיס הפנסיה שייכים לאותו רכיב.','יש לזהות במקור את בסיס הרכיב ואת הסכום המקביל; אישור הפקדה אינו נדרש לבדיקת היחס.');
  }
  if(['gross_salary','total_deductions','net_salary'].some(field=>extraction.fields.some(f=>f.field===field)))
   add('gross.net','minimum_wage','התאמת ברוטו, ניכויים ונטו','בדיקת חיסור הסכומים הכוללים שנקראו. פער חשבוני דורש בירור ואינו חוב; התאמה אינה הוכחת העברה לחשבון.',
    [moneyOperand('gross_salary','gross','ברוטו'),moneyOperand('total_deductions','deductions','סך הניכויים'),moneyOperand('net_salary','net','נטו')],
    {kind:'reconciliation',add_refs:['gross'],subtract_refs:['deductions'],recorded_ref:'net',inventory_complete:true,inventory_basis:'Explicit total fields; individual deduction rows are not added again.',disjoint_components:true,overlap_basis:'Gross less one deduction total; no component aggregation.'});
  if(withCoverage&&extraction.additional_components.some(r=>r.semantic_kind==='deduction')
   &&extraction.fields.some(f=>f.field==='total_deductions'))
   gap('deductions.grouping','minimum_wage','שורות הניכוי שנקראו נשמרו, אך לא זוהה באופן מלא אילו שורות נכללות בכל סיכום ניכויים. לכן לא בוצעה התאמת סכומי השורות לסיכומים; התאמת הברוטו והנטו נבדקת בנפרד.',
    'יש לזהות במקור את שיוך השורות לקבוצות הניכויים ואת גבולות כל קבוצה. אישור המספרים בלבד אינו קובע את השיוך, ואין להסיק אותו מהתאמה בין סכומים.');
  const groups=new Map<string,Component[]>();
  for(const row of extraction.additional_components){
   if(!rowTopic[row.semantic_kind])continue;
   // No source location means no proof that identical-looking rows duplicate.
   const location=row.source.bounding_box??row.source.text_fragment??row.component_id;
   const key=canonicalSha256({document:d.document_id,page:row.source.page,location,label:row.source_label});
   groups.set(key,[...(groups.get(key)??[]),row]);
  }
  const printedAmounts:{rows:Component[];operand:DocumentReviewOperand;conflict:boolean}[]=[];
  for(const [key,rows] of groups){
   const row=rows[0],topic=rowTopic[row.semantic_kind]!,rowId=`row.${key.slice(0,20)}`;
   const cells=(r:Component)=>[r.semantic_kind,r.quantity_raw,r.rate_raw,r.percentage_raw,r.amount_raw,r.quantity,r.rate,r.percentage,r.amount];
   const rowPeriod=(r:Component)=>payslipSourcePeriod({original:materialized.original,structureReadings:materialized.structureReadings,ref:{kind:'component',id:r.component_id},period:input.period});
   const conflict=new Set(rows.map(r=>canonicalSha256(cells(r)))).size>1||withCoverage&&rows.some(r=>rowPeriod(r).state==='conflict');
   const cellNormalizationWarnings=new Set(['quantity_normalization_failed','rate_normalization_failed','amount_normalization_failed','percentage_normalization_failed']);
   const uncertain=(cell:string)=>globallyUnreadable||extraction.document_quality_confidence<0.95||rows.some(r=>r.confidence<0.95||r.warning_flags.length>0
    ||withCoverage&&rowPeriod(r).state!=='current'
    ||r.normalization_warnings.some(w=>!withCoverage||!cellNormalizationWarnings.has(w)||w===`${cell}_normalization_failed`));
   const confirmedCell=(id:'quantity'|'rate'|'amount'|'percentage')=>{
    const originalRow=originalExtraction.additional_components.find(r=>r.component_id===row.component_id);
    if(!originalRow||conflict||globallyUnreadable||extraction.document_quality_confidence<.95
     ||rows.some(r=>r.warning_flags.length>0||withCoverage&&rowPeriod(r).state!=='current'
      ||r.normalization_warnings.some(w=>!withCoverage||!cellNormalizationWarnings.has(w))))return null;
    const direct=rows.map(r=>{
     const original=originalExtraction.additional_components.find(o=>o.component_id===r.component_id);
     return original?identifiedDirectRowCell({original:originalExtraction,effective:extraction,rowReadings:materialized.rowReadings,row:original,cell:id}):null;
    });
    if(direct.every(c=>c!==null)&&new Set(direct.map(c=>canonicalSha256(c!.normalized_value))).size===1){
     const first=direct[0]!;
     return {normalized:first.normalized_value,raw_value:first.raw_value,candidate_id:null,row_reading_sha256:direct.map(c=>canonicalSha256(c!.reading))};
    }
    const candidate=identifiedMappedRowCell({original:originalExtraction,effective:extraction,readings:materialized.readings,row:originalRow,cell:id});
    if(!candidate)return null;
    const field=candidate.field;
    const assessment=validation.field_assessments.find(a=>a.candidate_id===candidate.candidate_id);
    const paths:Readonly<Record<string,string>>={base_monthly_salary:'compensation.base_monthly_salary',hourly_rate:'compensation.hourly_rate',regular_hours:'work.regular_hours',
     overtime_125_hours:'work.overtime_125_hours',overtime_150_hours:'work.overtime_150_hours',travel_amount:'travel.reimbursement',convalescence_amount:'convalescence.payment'};
    const agreeingGroup=resolved.facts.find(f=>f.path===paths[field])?.status==='confirmed';
    if(!assessment||assessment.status==='invalid'||assessment.issue_codes.some(code=>!readingIssues.has(code)&&!(code==='duplicate_candidate'&&agreeingGroup)))return null;
    const value=candidate.normalized_value;
    const normalized=value&&typeof value==='object'&&'amount' in value?value.amount:value;
    return normalized===null?null:{normalized,raw_value:candidate.raw_value,candidate_id:candidate.candidate_id,row_reading_sha256:[]};
   };
   const rowOperand=(id:'quantity'|'rate'|'amount'|'percentage'):DocumentReviewOperand=>{
    const originalRow=originalExtraction.additional_components.find(r=>r.component_id===row.component_id);
    const mapped=rows.length===1&&originalRow?mappedRowCellCandidate({fields:originalExtraction.fields,row:originalRow,cell:id}):null;
    const confirmed=confirmedCell(id),raw=confirmed?.raw_value??row[`${id}_raw`],normalized=confirmed?.normalized??row[id];
    const money=id==='rate'||id==='amount';
    const value=money&&normalized&&typeof normalized==='object'&&'minor_units' in normalized?normalized:null;
    const rawNormalized=raw===null?null:money?normalizeMoney(raw):id==='quantity'?normalizeDecimal(raw):normalizePercentage(raw);
    const invalid=normalized===null||money&&value?.currency!=='ILS'||canonicalSha256(normalized)!==canonicalSha256(rawNormalized);
    const state:DocumentReviewOperand['state']=conflict?'conflict':raw===null?'missing':invalid?'unreadable':confirmed?'observed':uncertain(id)?'unknown':'observed';
    const printed=money?value?.currency==='ILS'?decimalMoney(value.minor_units):null:id==='quantity'?typeof normalized==='string'?normalized:null:row.percentage?decimalMoney(row.percentage.basis_points):null;
    return {id,observation_id:`${row.component_id}:${id}`,state,printed_value:printed,representation:money?'money_ils':id==='percentage'?'percent':'decimal_quantity',
     quantity_unit:money?null:id==='percentage'?'ratio':row.semantic_kind==='hourly_base'||row.semantic_kind.startsWith('overtime_')?'hours':'count',precision:'printed_precision',
     source:{...source(row.source.page,`${row.source_label} — ${{quantity:'כמות',rate:'תעריף',amount:'סכום',percentage:'אחוז'}[id]}`,withCoverage
      ?{component_ids:rows.map(r=>r.component_id),cell:id,original_component_sha256:rows.map(r=>canonicalSha256(originalExtraction.additional_components.find(o=>o.component_id===r.component_id))),raw_values:rows.map(r=>r[`${id}_raw`]),
       ...(mapped?{mapped_candidate:{candidate_id:mapped.candidate_id,candidate_sha256:canonicalSha256(mapped)}}:{})}
      :{component_ids:rows.map(r=>r.component_id),candidate_id:confirmed?.candidate_id??null,...(confirmed?.row_reading_sha256.length?{row_reading_sha256:confirmed.row_reading_sha256}:{}),raw,original_raw:originalExtraction.additional_components.find(r=>r.component_id===row.component_id)?.[`${id}_raw`]??null,source:row.source,semantic_kind:row.semantic_kind}),reading:confirmed?'identified_document_reading':'provider_extraction'}};
   };
   printedAmounts.push({rows,operand:rowOperand('amount'),conflict});
   if(withCoverage&&row.semantic_kind==='hourly_base'
    &&[...groups.values()].filter(group=>group[0].semantic_kind==='hourly_base').length===1&&d.page_count===1){
    const transcribed=identifiedSourceTranscription({original:originalExtraction,sourceTranscriptions:materialized.sourceTranscriptions,subjectKind:'reported_work_hours'});
    const value=transcribed?.normalized_value,raw=value?.kind==='reported_work_hours'?value.amount:null;
    const footer:DocumentReviewOperand={id:'reported.hours',observation_id:transcribed?`source-transcription:${transcribed.reading.target_sha256}`:`${d.version_id}:reported-hours`,
     state:raw===null?'missing':globallyUnreadable||extraction.document_quality_confidence<.95?'unknown':'observed',printed_value:raw,representation:'decimal_quantity',quantity_unit:'hours',precision:'printed_precision',
     source:{...source(1,'סך שעות מדווחות במסמך',{transcription_kind:'reported_work_hours',page:1,meaning:'document_reported_total_hours',...(transcribed?{target_sha256:transcribed.reading.target_sha256}:{})}),reading:transcribed?'identified_document_reading':'provider_extraction'}};
    add('hours.row.reported_total','working_time','השוואת כמות שורת השכר לסך השעות המדווחות','השוואה בין שני שדות בעלי היקף שונה: כמות שורת השכר וסך השעות המדווחות במסמך. ההפרש אינו שעות שלא שולמו; שעות נוספות ושורות ריקות נשארות לא פתורות.',
     [rowOperand('quantity'),footer],{kind:'quantity_comparison',left_ref:'quantity',right_ref:'reported.hours',interpretation:'different_source_representations'});
   }
   const operands=[rowOperand('rate'),rowOperand('quantity'),rowOperand('amount')],factors=['quantity'];
   // Apply a displayed premium only when the displayed rate is positively
   // identified as the same usable base rate. A distinct explicit unit price
   // is used as printed, never multiplied again merely because its row is OT.
   const base=moneyOperand('hourly_rate','hourly.base','תעריף בסיס לשעה');
   const usePercentage=row.semantic_kind.startsWith('overtime_')&&row.percentage_raw!==null&&base.state==='observed'&&row.rate?.currency==='ILS'&&base.printed_value===decimalMoney(row.rate.minor_units);
   if(usePercentage){operands.push(rowOperand('percentage'));factors.push('percentage');}
   const deferredPrices=add(rowId,topic,`בדיקת שורה — ${row.source_label}`,'השוואת הכמות והתעריף המפורשים לסכום השורה. זהו בירור חשבוני בלבד, לפי עיגול מועמד לאגורה; אין כאן קביעת זכאות או חוב.',operands,
    {kind:'product',money_ref:'rate',factor_refs:factors,recorded_ref:'amount',rounding:'half_up',rounding_basis:usePercentage?'Candidate half-up to agorot; explicit percentage applied to the source-identified base rate.':'Candidate half-up to agorot; quantity times the explicitly printed unit price. No extra OT multiplier inferred; any percentage remains in the source receipt.'});
   if(deferredPrices?.size)gap(`${rowId}.blank_basis`,topic,`בשורה ${row.source_label} תאי הכמות והסכום ריקים במקור שנקרא. הם נשארו חסרים ולא הוזנו כאפס. אישור התעריף לבדו לא יאפשר לבדוק את השורה, ולכן אינו מתבקש כעת.`,
    'אם קיימים נתוני כמות וסכום מפורשים ממקור מתאים, ניתן להשלים אותם ולבחון שוב את השורה. תשובה לא ידועה משאירה את החסר; הצהרה אינה אישור לקריאת מסמך.');
  }
  if(withCoverage&&extraction.fields.some(f=>f.field==='gross_salary')){
   const populated=printedAmounts.filter(p=>p.rows.some(r=>r.amount_raw!==null));
   const blanks=printedAmounts.filter(p=>p.rows.every(r=>r.amount_raw===null&&r.quantity_raw===null));
   const unboundBlank=printedAmounts.some(p=>p.rows.some(r=>r.amount_raw===null&&r.quantity_raw!==null));
   const unknown=extraction.additional_components.some(r=>!rowTopic[r.semantic_kind]&&r.semantic_kind!=='deduction');
   const current=extraction.additional_components.filter(r=>r.semantic_kind!=='deduction').every(r=>payslipSourcePeriod({original:materialized.original,structureReadings:materialized.structureReadings,ref:{kind:'component',id:r.component_id},period:input.period}).state==='current');
   const disjoint=printedAmounts.every(p=>!p.conflict);
   if(populated.length&&populated.length<=24){
    const scopeCovered=populated.every(p=>p.rows.every(r=>rowTopic[r.semantic_kind]!==undefined&&input.purchased_scope.topics.includes(rowTopic[r.semantic_kind]!)));
    const printed_inventory={schema_version:'printed-earnings-inventory-v1' as const,document_id:d.document_id,version_id:d.version_id,reading_sha256:receipt,
     populated_component_ids:populated.flatMap(p=>p.rows.map(r=>r.component_id)),unresolved_blank_component_ids:blanks.flatMap(p=>p.rows.map(r=>r.component_id)),
     excluded_deduction_component_ids:extraction.additional_components.filter(r=>r.semantic_kind==='deduction').map(r=>r.component_id),
     inventory_complete:extraction.earnings_components_complete&&!unknown&&!unboundBlank&&current&&scopeCovered,
     disjoint_components:disjoint,payable_completeness_assessed:false as const};
    const operands=populated.map((p,i)=>({...p.operand,id:`amount.${i}`}));
    add('earnings.printed','minimum_wage','התאמת סכומי התשלום המודפסים לברוטו',
     `סכום תאי התשלום שאינם ריקים מול הברוטו המודפס. ניכויים אינם מצורפים לתשלומים. ${blanks.length?`${blanks.length} שורות עם כמות וסכום ריקים נשארו לא פתורות ולא נחשבו כאפס. `:''}ההתאמה אינה קובעת שכל השכר המגיע שולם; בדיקות השורות והזכאות נפרדות.`,
     [...operands,moneyOperand('gross_salary','gross','ברוטו')],{kind:'reconciliation',add_refs:operands.map(o=>o.id),subtract_refs:[],recorded_ref:'gross',
      inventory_complete:printed_inventory.inventory_complete,inventory_basis:`printed-earnings-inventory-v1:${canonicalSha256(printed_inventory)}`,
      disjoint_components:disjoint,overlap_basis:'Each distinct source-located populated earnings amount once; exact agreeing observations share one term. Deduction rows excluded; unresolved blank rows are not assigned zero.'},scopeCovered);
    const check=checks.find(c=>c.check_id===`document.${index}.earnings.printed`);if(check)check.printed_inventory=printed_inventory;
    if(check&&!scopeCovered)coverage_gaps.push({check_id:`document.${index}.earnings.printed.scope`,topic:'minimum_wage',kind:'missing_rule',source_pins:[pin],
     detail:'התאמת סכומי התשלום הכוללים תלויה גם בשורות מנושאים שאינם כלולים בהיקף השירות של דוח זה. המסלול הנוכחי אינו מאשר את תאי השורות האלה במסגרת הבדיקה שנרכשה, ולכן ההשוואה נשארה חסומה.',
     next_step:'נדרשת החלטת היקף מפורשת לפני בדיקת השורות הנוספות. לא שונו הנושאים שנרכשו ולא נפתחו עבורן שאלות; בדיקות עצמאיות בתחום השירות ממשיכות.'});
   }
  }
  if(input.review_policy===PAYSLIP_SOURCE_STRUCTURE_POLICY&&prior)appendPayslipSourceStructures({index,case_id:input.case_id,period:input.period,topics:input.purchased_scope.topics,
   ...(input.identified_period_structure_policy?{identified_period_structure_policy:input.identified_period_structure_policy}:{}),
   document:d,original:originalExtraction,materialized,firstPass:prior.first_pass,checkpointSha256:prior.checkpoint_result_sha256,checks,gaps:coverage_gaps,needs,bindings:answer_bindings,add,moneyOperand,scopedOperand});
 }
 return {schema_version:DOCUMENT_REVIEW_POLICY,...(input.identified_period_structure_policy?{source_structure_period_policy:input.identified_period_structure_policy}:{}),...(withCoverage?{coverage_policy:DOCUMENT_REVIEW_COVERAGE_POLICY,...(source_observation_inventory.length?{source_observation_inventory}:{}),...(source_semantic_derivations.length?{source_semantic_derivations}:{})}:{}),coverage_gaps,answer_bindings,answer_history:[],case_id:input.case_id,period:input.period,purchased_scope:input.purchased_scope,documents,checks,
  completion_input:{case_id:input.case_id,period:input.period,documents:documents.map(d=>({pin:{case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256},kind:d.kind,review:'partial',period:completedFinancialSources.has(d.document_id)?input.period:d.period,
   ...(completedFinancialSources.has(d.document_id)?{review_completed_fact_keys:[PAYSLIP_FINANCIAL_SOURCE_FACT]}:{})})),needs,evidence}};
}
