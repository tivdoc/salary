import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../../document-review/contracts.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewSource} from '../../document-review/calculations.ts';
import {parseReviewCompletionInput,resolveReviewCompletion} from '../../document-review/completions.ts';
import {savedNonPayslipEvidenceSchema} from '../../extraction/document-evidence/snapshot.ts';
import {nonPayslipEffectiveReadingSha} from '../../document-review/non-payslip.ts';
import {vacationEntitlementInputSchema,type VacationEntitlementInput} from './contracts.ts';
import {vacationCaseSourceEvidenceSchema,type VacationCaseSourceEvidence} from './product-decisions.ts';
import {VACATION_SOURCE_REVIEW_SHA256} from './sources.ts';

const sourceSchema=documentReviewCalculationInputSchema.shape.operands.element.shape.source;
const factSchema=z.object({state:z.enum(['declared','missing','unknown','conflict','stale']),value:z.boolean().nullable(),source:sourceSchema.nullable()}).strict();
export const vacationSourceProductFactsSchema=z.object({schema_version:z.literal('vacation-source-product-facts-v1'),
 same_employer_or_workplace:factSchema,preceding_quarter_full_months:factSchema,
}).strict();
export type VacationSourceProductFacts=z.infer<typeof vacationSourceProductFactsSchema>;
const questions={
 same_employer_or_workplace:'האם כל תקופת הוותק שצוינה היא אצל אותו מעסיק או באותו מקום עבודה?',
 preceding_quarter_full_months:'האם עבדת בכל שלושת החודשים שלפני החופשה חודשים מלאים, בלי חודש עבודה חלקי?',
} as const;
type FactKey=keyof typeof questions;
export function vacationSourceFactKey(key:FactKey){return 'entitlement.vacation.source_facts.'+key;}
/** Existing immutable answer journal only. No raw caller boolean is accepted,
 * and a newer unknown answer supersedes only this factual question. */
export function readVacationSourceProductFacts(source:DocumentReviewInput):VacationSourceProductFacts{
 const facts=vacationSourceProductFactsSchema.parse({schema_version:'vacation-source-product-facts-v1',same_employer_or_workplace:{state:'missing',value:null,source:null},preceding_quarter_full_months:{state:'missing',value:null,source:null}});
 for(const key of Object.keys(questions) as FactKey[]){
  const versions=source.answer_history.filter(h=>h.request.target.fact_key===vacationSourceFactKey(key));if(!versions.length)continue;
  const current:VacationSourceProductFacts[FactKey][]=[];
  for(const requestId of new Set(versions.map(h=>h.receipt.request_id))){
  const requestVersions=versions.filter(v=>v.receipt.request_id===requestId);
  const latest=[...requestVersions].sort((a,b)=>b.receipt.answer_revision-a.receipt.answer_revision)[0],r=latest.receipt;
  if(requestVersions.filter(v=>v.receipt.answer_revision===r.answer_revision).length!==1)throw Error('VACATION_FACT_DUPLICATE_REVISION');
  if(latest.request.target.required_evidence_kind!=='customer_declaration'||r.case_id!==source.case_id)throw Error('VACATION_FACT_DECLARATION_SCOPE');
  const resolved=resolveReviewCompletion({request:latest.request,current:parseReviewCompletionInput(source.completion_input),actor:{case_id:source.case_id,identity_id:r.identity_id},answer:{request_id:r.request_id,revision:r.answer_revision,answered_at:r.answered_at,state:r.state,value:r.value}});
  if(resolved.state==='stale')continue;
  if(resolved.receipt.answer_sha256!==r.answer_sha256||resolved.requires_source_verification)throw Error('VACATION_FACT_RECEIPT');
  const citation:DocumentReviewSource={document_id:r.request_id,version_id:r.request_id+':'+r.answer_revision,file_sha256:r.answer_sha256,page:1,locator:'Identified factual answer: '+vacationSourceFactKey(key),label:questions[key],reading:'customer_declaration',reading_receipt_sha256:r.answer_sha256};
  if(r.state!=='provided'||resolved.blocked){current.push({state:r.state==='unknown'?'unknown':'conflict',value:null,source:citation});continue;}
  const value=r.value==='כן'||r.value===true?true:r.value==='לא'||r.value===false?false:null;if(value===null)throw Error('VACATION_FACT_VALUE');
  current.push({state:'declared',value,source:citation});
  }
  facts[key]=current.length===1?current[0]:{state:current.length?'conflict':'stale',value:null,source:null};
 }
 return facts;
}
type Cell={id:string;row:string;semantic:string;value:unknown;source:DocumentReviewSource};
function acceptedSource(s:DocumentReviewSource,source:DocumentReviewInput){return ['provider_extraction','identified_document_reading'].includes(s.reading)&&source.documents.some(d=>d.case_id===source.case_id&&d.document_id===s.document_id&&d.version_id===s.version_id&&d.file_sha256===s.file_sha256&&d.page_count!==null&&s.page<=d.page_count&&[d.reading_sha256,...(d.accepted_reading_sha256??[])].includes(s.reading_receipt_sha256));}
/** Reuses admitted source readings. A confidence score never makes a new
 * non-payslip cell readable; unresolved candidates remain reading dependencies. */
function sourceRows(source:DocumentReviewInput){
 const rows:Cell[][]=[],dependencies:{version_id:string;observation_id:string}[]=[];
 if(new Set((source.non_payslip_evidence??[]).map(r=>r.document.document_id)).size!==(source.non_payslip_evidence??[]).length)throw Error('VACATION_SOURCE_DUPLICATE_VERSION');
 for(const raw of source.non_payslip_evidence??[]){
  const record=savedNonPayslipEvidenceSchema.parse(raw),e=record.extraction;if(!e||record.document.document_type!=='attendance')continue;
  const doc=source.documents.find(d=>d.version_id===record.document.document_id),readingSha=nonPayslipEffectiveReadingSha(record);
  if(record.document.case_id!==source.case_id||!doc||doc.file_sha256!==record.document.content_sha256||doc.reading_sha256!==readingSha)throw Error('VACATION_SOURCE_CURRENT_RECORD');
  if(e.pages.length!==e.physical_page_count||new Set(e.pages.map(p=>p.page)).size!==e.physical_page_count||e.pages.some(p=>p.page>e.physical_page_count||p.coverage!=='complete'||p.missing_regions.length)||e.warnings.length)continue;
  const groups=new Map<string,Cell[]>();
  for(const o of e.observations){
   if(!['row_date','source_label'].includes(o.original.semantic)||!o.original.row_id||!e.observations.some(other=>other.original.semantic==='row_date'&&other.original.row_id===o.original.row_id&&other.original.block_id===o.original.block_id&&other.original.page===o.original.page))continue;
   const row=canonicalSha256({version:record.document.document_id,page:o.original.page,block:o.original.block_id,row:o.original.row_id});
   if(!groups.has(row))groups.set(row,[]);
   const reading=record.readings.find(r=>r.target.observation.observation_id===o.observation_id);
   if(!reading){dependencies.push({version_id:record.document.document_id,observation_id:o.observation_id});continue;}
   if(reading.state!=='identified_reading'||!reading.value||(o.original.semantic==='row_date'?reading.value.kind!=='iso_date':reading.value.kind!=='text')||!('value' in reading.value))continue;
   const cell:Cell={id:o.observation_id,row,semantic:o.original.semantic,value:reading.value.value,source:{document_id:doc.document_id,version_id:doc.version_id,file_sha256:doc.file_sha256,page:o.original.page,locator:JSON.stringify({schema_version:'vacation-source-cell-v1',observation_id:o.observation_id,original_sha256:o.original_sha256,reading_sha256:reading.verification_sha256}),label:o.original.source_label||'נתון בפנקס נוכחות',reading:'identified_document_reading',reading_receipt_sha256:readingSha}};
   groups.set(row,[...(groups.get(row)??[]),cell]);
  }
  rows.push(...groups.values());
 }
 return {rows,dependencies};
}
/** Pure normal-source producer. The hashes it returns are for an INTERNAL
 * deterministic producer call, never an API allowlist submitted by a customer.
 * Calendar status labels are factual source text. Only the narrow all-work /
 * weekly-rest inventory is classified here; sickness/holiday mixtures are not
 * guessed. No statutory classification is asked in a document-reading form. */
export function produceVacationSourceEvidence(candidate:VacationEntitlementInput,review:DocumentReviewInput){
 const input=vacationEntitlementInputSchema.parse(candidate),source=documentReviewInputSchema.parse(review);
 if(input.case_id!==source.case_id||canonicalSha256(input.period)!==canonicalSha256(source.period))throw Error('VACATION_PRODUCER_SCOPE');
 const facts=readVacationSourceProductFacts(source),entries:VacationCaseSourceEvidence['entries']=[],witnesses:unknown[]=[],softwareGaps:string[]=[];
 const push=(entry:VacationCaseSourceEvidence['entries'][number],consumed:unknown)=>{entries.push(entry);witnesses.push({entry_sha256:canonicalSha256(entry),consumed,consumed_sha256:canonicalSha256(consumed),source_policy_sha256:VACATION_SOURCE_REVIEW_SHA256,actor_kind:'deterministic_application_of_ai_reviewed_rule',human_attestation:null});};
 const a=input.annual_basis;
 const final=a?.employment_end.value==='ongoing'||a?.employment_end.value&&a.employment_end.value>'2026-12-31'?'2026-12-31':a?.employment_end.value;
 // Do not open daily source questions while the annual interval itself cannot
 // yet be evaluated. Existing monthly balances never trigger an annual scan.
 const annualCanConsume=!!a&&a.employment_start.state==='known'&&a.employment_end.state==='known'&&a.covered_through.state==='known'&&!!a.employment_start.value&&!!final&&a.employment_start.value<=final&&final<=input.evaluated_at.slice(0,10)&&!!a.covered_through.value&&a.covered_through.value>=final&&a.actual_workdays?.state==='observed'&&a.actual_workdays.printed_value!==null&&acceptedSource(a.actual_workdays.source,source);
 const cells=annualCanConsume?sourceRows(source):{rows:[] as Cell[][],dependencies:[] as {version_id:string;observation_id:string}[]};
 if(a&&a.employment_start.state==='known'&&a.employment_start.value&&input.seniority_year?.state==='observed'&&acceptedSource(input.seniority_year.source,source)&&facts.same_employer_or_workplace.state==='declared'&&facts.same_employer_or_workplace.value===true){
  // This checks an existing year value; it does not manufacture a source scalar.
  const expected=2026-Number(a.employment_start.value.slice(0,4))+1;
  if(expected>=1&&expected<=60&&input.seniority_year.printed_value===String(expected))push({kind:'seniority',state:'identified',source:input.seniority_year.source,reference_year:2026,continuity:'same_employer_or_workplace',operand_sha256:canonicalSha256(input.seniority_year)},{employment_start:a.employment_start,seniority_year:input.seniority_year,same_employer_or_workplace:facts.same_employer_or_workplace});
  else softwareGaps.push('seniority_source_year_conflicts_with_same_employment_calendar_year');
 }else if(!input.seniority_year)softwareGaps.push('derived_seniority_operand_contract_required_no_printed_year_fabricated');
 if(a?.actual_workdays?.state==='observed'&&acceptedSource(a.actual_workdays.source,source)&&a.employment_start.value&&a.employment_end.value){
  const from=a.employment_start.value<'2026-01-01'?'2026-01-01':a.employment_start.value,to=a.employment_end.value==='ongoing'||a.employment_end.value>'2026-12-31'?'2026-12-31':a.employment_end.value;
  const dated=cells.rows.flatMap(row=>{const dates=row.filter(c=>c.semantic==='row_date'),labels=row.filter(c=>c.semantic==='source_label');return dates.length===1&&labels.length===1&&typeof dates[0].value==='string'&&typeof labels[0].value==='string'?[{date:dates[0].value,label:labels[0].value.trim(),cells:row}]:[];}).filter(r=>r.date>=from&&r.date<=to).sort((x,y)=>x.date.localeCompare(y.date));
  let cursor=from;let complete=from<=to&&cells.rows.every(row=>row.filter(c=>c.semantic==='row_date').length===1&&row.filter(c=>c.semantic==='source_label').length===1);for(const row of dated){if(row.date!==cursor||!['עבודה','מנוחה שבועית'].includes(row.label))complete=false;cursor=new Date(Date.parse(row.date)+86400000).toISOString().slice(0,10);}
  complete=complete&&cursor===new Date(Date.parse(to)+86400000).toISOString().slice(0,10)&&to<=input.evaluated_at.slice(0,10)&&dated.length>0;
  if(complete&&a.actual_workdays.printed_value===String(dated.filter(r=>r.label==='עבודה').length))push({kind:'annual_workdays',state:'identified',source:a.actual_workdays.source,coverage:{from,to},inventory:'complete_classified_workdays',operand_sha256:canonicalSha256(a.actual_workdays)},{inventory:dated,actual_workdays:a.actual_workdays});
  else softwareGaps.push('complete_dated_annual_status_inventory_required_no_monthly_projection');
 }
 const p=input.leave_pay;
 if(p?.mode==='hourly_quarter'&&facts.preceding_quarter_full_months.state==='declared'&&facts.preceding_quarter_full_months.value===true&&p.wage?.state==='observed'&&acceptedSource(p.wage.source,source)){
  push({kind:'quarter_selection',state:'identified',source:p.wage.source,coverage:p.quarter_period,selection:'preceding_quarter_all_months_full',fullest_quarter_inventory:'not_needed'},{quarter_period:p.quarter_period,leave_period:p.leave_period,wage:p.wage,full_months:facts.preceding_quarter_full_months});
 }
 if(p?.mode==='hourly_quarter')softwareGaps.push('dated_leave_types_and_weekly_rest_source_required_before_section5_classification');
 if(p?.mode==='monthly_maintained_wage')softwareGaps.push('same_leave_period_wage_component_inventory_required_no_gross_salary_substitution');
 if(p?.recorded)softwareGaps.push('recorded_payment_exact_leave_dates_source_relation_required');
 if(!p)softwareGaps.push('ordinary_leave_period_and_wage_source_producer_missing');
 const needed:FactKey[]=[];
 if(input.seniority_year&&facts.same_employer_or_workplace.state==='missing')needed.push('same_employer_or_workplace');
 if(p?.mode==='hourly_quarter'&&facts.preceding_quarter_full_months.state==='missing')needed.push('preceding_quarter_full_months');
 const evidence=vacationCaseSourceEvidenceSchema.parse({schema_version:'vacation-case-source-evidence-v1',case_id:input.case_id,period:input.period,entries});
 const receipt={schema_version:'vacation-source-producer-receipt-v1' as const,source_policy_sha256:VACATION_SOURCE_REVIEW_SHA256,input_sha256:canonicalSha256(input),source_sha256:canonicalSha256(source),facts,witnesses,evidence_sha256:canonicalSha256(evidence)};
 return {evidence,authenticated_evidence_sha256s:entries.map(e=>canonicalSha256(e)),receipt:{...receipt,receipt_sha256:canonicalSha256(receipt)},
  factual_questions:needed.map(key=>({schema_version:'vacation-source-factual-question-v1' as const,path:'product_source_facts.'+key,fact_key:vacationSourceFactKey(key),question:questions[key],answer_kind:'choice' as const,options:['כן','לא'],required_evidence_kind:'customer_declaration' as const,existing_fact:facts[key]})),
  reading_dependencies:cells.dependencies,software_gaps:[...new Set(softwareGaps)],publication_authority:false as const};
}

/** Normal request opener port. Source identities are copied only from the
 * authenticated immutable inventory; it cannot synthesize an OCR candidate. */
export function vacationSourceReadingDependencies(input:VacationEntitlementInput,review:DocumentReviewInput){
 const produced=produceVacationSourceEvidence(input,review);
 return (review.non_payslip_evidence??[]).flatMap(raw=>{
  const r=savedNonPayslipEvidenceSchema.parse(raw),observation_ids=[...new Set(produced.reading_dependencies.filter(d=>d.version_id===r.document.document_id).map(d=>d.observation_id))];
  if(!observation_ids.length)return [];
  if(!r.extraction||!r.checkpoint_result_sha256||!observation_ids.every(id=>r.extraction!.observations.some(o=>o.observation_id===id)))throw Error('VACATION_DEPENDENCY_SOURCE_BINDING');
  return [{version_id:r.document.document_id,product_document_id:r.product_document_id,checkpoint_sha256:r.checkpoint_result_sha256,
   normalized_sha256:canonicalSha256(r.extraction),observation_ids,dependent_check_ids:[input.check_prefix+'.annual.prorated']}];
 });
}
