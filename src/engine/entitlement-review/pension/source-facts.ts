import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import type {DocumentReviewOperand,DocumentReviewSource} from '../../document-review/calculations.ts';
import {nonPayslipEffectiveReadingSha} from '../../document-review/non-payslip.ts';
import {savedNonPayslipEvidenceSchema} from '../../extraction/document-evidence/snapshot.ts';
import {normalizeMoney} from '../../extraction/normalization.ts';
import type {NonPayslipReadingDependency} from '../automatic-nonpay.ts';
import {pensionEntitlementInputSchema,type PensionEntitlementInput} from './contracts.ts';
import {emptyPensionSourceFacts,PENSION_SOURCE_FACTS_POLICY} from './source-fact-contracts.ts';
import {pensionCheckIds,resolvePensionEligibility,pensionOrdinaryWaitingElapsed} from './eligibility.ts';

type Period={from:string;to:string};
type Literal={kind:'wage';period:Period;minor:number}|{kind:'prior';period:Period}|{kind:'arrangement';period:Period;employee:string;employer:string;severance:string};
const validPeriod=(from:string,to:string)=>z.iso.date().safeParse(from).success&&z.iso.date().safeParse(to).success&&from<=to;
/** Literal source associations only. Qualifiers, omitted composition, nearby
 * figures and conditional promises intentionally do not match these forms. */
export function pensionLiteralClause(raw:string):Literal|null{
 const text=raw.trim().replace(/^\d+(?:\.\d+)*[.)]?\s+/u,'').replace(/[.]$/u,'');
 const wage=/^השכר הקובע להפרשות פנסיוניות לתקופה (\d{4}-\d{2}-\d{2}) עד (\d{4}-\d{2}-\d{2}) הוא (\d+(?:\.\d{1,2})?) (?:ש״ח|ש"ח|ILS),? והוא כולל את כל רכיבי השכר הקובעים לפנסיה$/u.exec(text);
 if(wage){const amount=normalizeMoney(wage[3],'ILS');return validPeriod(wage[1],wage[2])&&amount&&amount.minor_units>=0?{kind:'wage',period:{from:wage[1],to:wage[2]},minor:amount.minor_units}:null;}
 const prior=/^הביטוח בקרן הפנסיה היה פעיל ברציפות מתאריך (\d{4}-\d{2}-\d{2}) עד (\d{4}-\d{2}-\d{2})$/u.exec(text);
 if(prior)return validPeriod(prior[1],prior[2])?{kind:'prior',period:{from:prior[1],to:prior[2]}}:null;
 const arrangement=/^לתקופה (\d{4}-\d{2}-\d{2}) עד (\d{4}-\d{2}-\d{2}) שיעורי ההפרשה לקרן הפנסיה הם: עובד (\d+(?:\.\d{1,4})?)%, מעסיק (\d+(?:\.\d{1,4})?)%, פיצויים (\d+(?:\.\d{1,4})?)%$/u.exec(text);
 if(arrangement)return validPeriod(arrangement[1],arrangement[2])&&arrangement.slice(3).every(v=>Number(v)>=0&&Number(v)<=100)?{kind:'arrangement',period:{from:arrangement[1],to:arrangement[2]},employee:arrangement[3],employer:arrangement[4],severance:arrangement[5]}:null;
 return null;
}
export function isPensionProducedSource(source:DocumentReviewSource|null|undefined){if(!source)return false;try{return JSON.parse(source.locator).schema_version===PENSION_SOURCE_FACTS_POLICY;}catch{return false;}}
const samePeriod=(a:Period,b:Period)=>a.from===b.from&&a.to===b.to;
const money=(minor:number)=>`${Math.floor(minor/100)}.${String(minor%100).padStart(2,'0')}`;
type Found={literal:Literal;source:DocumentReviewSource;observation_id:string};
/** Recompute from immutable saved records plus their identified reading
 * receipts. This function grants neither a legal decision nor a transfer. */
export function attachPensionSourceFacts(candidate:PensionEntitlementInput,review:DocumentReviewInput){
 const input=pensionEntitlementInputSchema.parse(candidate),result=structuredClone(input),reading_dependencies:NonPayslipReadingDependency[]=[];
 if(!input.source_facts)return {input:result,reading_dependencies};
 if(review.case_id!==input.case_id||!samePeriod(review.period,input.period))throw Error('PENSION_SOURCE_FACT_SCOPE');
 const priorWage=result.pensionable_wage;
 if(isPensionProducedSource(priorWage?.source))result.pensionable_wage=null;
 if(isPensionProducedSource(result.eligible_interval_wage?.operand.source))result.eligible_interval_wage=null;
 result.source_facts=emptyPensionSourceFacts();
 const found:Found[]=[],negative:{kind:Literal['kind'];period:Period;state:'unknown'|'unreadable';source:DocumentReviewSource}[]=[];
 const relevant=(literal:Literal)=>literal.kind==='wage'?literal.period.from>=input.period.from&&literal.period.to<=input.period.to
  :literal.kind==='arrangement'?literal.period.from<=input.period.from&&literal.period.to>=input.period.to
  :!pensionOrdinaryWaitingElapsed(input)&&input.facts.employment_start.state==='known'&&input.facts.employment_start.value!==null&&literal.period.from<=input.facts.employment_start.value&&literal.period.to>=input.facts.employment_start.value;
 for(const raw of review.non_payslip_evidence??[]){
  const record=savedNonPayslipEvidenceSchema.parse(raw),e=record.extraction;
  if(!e||record.document.document_type!=='contract'||e.detected_document_type!=='contract')continue;
  const document=review.documents.find(d=>d.document_id===record.document.document_id&&d.version_id===record.document.document_id);
  if(record.document.case_id!==input.case_id||!document||document.file_sha256!==record.document.content_sha256||document.reading_sha256!==nonPayslipEffectiveReadingSha(record)||document.page_count!==e.physical_page_count)throw Error('PENSION_SOURCE_FACT_RECORD_BINDING');
  const reads=new Map(record.readings.filter(r=>r.target.month===input.period.from.slice(0,7)).map(r=>[r.target.observation.observation_id,r])),pending:string[]=[];
  for(const observation of e.observations){
   if(!['clause_text','source_label','condition_text'].includes(observation.original.semantic)||observation.issues.includes('duplicate_source_cell'))continue;
   const read=reads.get(observation.observation_id),value=read?.state==='identified_reading'?read.value:null;
   const literal=value?.kind==='text'?pensionLiteralClause(value.value):null,rawLiteral=pensionLiteralClause(observation.original.raw_value??'');
   if((!literal||!relevant(literal))&&(!rawLiteral||!relevant(rawLiteral)))continue;
   if(!result.source_manifest.some(s=>s.document_id===document.document_id))result.source_manifest.push({document_id:document.document_id,version_id:document.version_id,file_sha256:document.file_sha256,page_count:e.physical_page_count,case_id:input.case_id,kind:'case_document'});
   if(!read&&rawLiteral&&relevant(rawLiteral)){pending.push(observation.observation_id);negative.push({kind:rawLiteral.kind,period:rawLiteral.period,state:'unknown',source:{document_id:document.document_id,version_id:document.version_id,file_sha256:document.file_sha256,page:observation.original.page,
    locator:JSON.stringify({schema_version:PENSION_SOURCE_FACTS_POLICY,observation_id:observation.observation_id,original_sha256:observation.original_sha256,unresolved:'pending'}),label:'סעיף פנסיה שממתין לקריאה מזוהה',reading:'provider_extraction',reading_receipt_sha256:document.reading_sha256}});}
   if(read&&read.state!=='identified_reading'&&rawLiteral&&relevant(rawLiteral))negative.push({kind:rawLiteral.kind,period:rawLiteral.period,state:read.state,source:{document_id:document.document_id,version_id:document.version_id,file_sha256:document.file_sha256,page:observation.original.page,
    locator:JSON.stringify({schema_version:PENSION_SOURCE_FACTS_POLICY,observation_id:observation.observation_id,reading_sha256:read.verification_sha256,unresolved:read.state}),label:'סעיף פנסיה שנותר ללא קריאה שמישה',reading:'provider_extraction',reading_receipt_sha256:document.reading_sha256}});
   if(!literal||!relevant(literal))continue;
   const locator={schema_version:PENSION_SOURCE_FACTS_POLICY,observation_id:observation.observation_id,original_sha256:observation.original_sha256,
    reading_sha256:read!.verification_sha256,period:literal.period,association:literal.kind};
   found.push({literal,observation_id:observation.observation_id,source:{document_id:document.document_id,version_id:document.version_id,file_sha256:document.file_sha256,page:observation.original.page,
    locator:JSON.stringify(locator),label:'קביעה מפורשת בסעיף פנסיה שנקרא במקור',reading:'identified_document_reading',reading_receipt_sha256:document.reading_sha256}});
  }
  if(pending.length)reading_dependencies.push({version_id:document.version_id,product_document_id:record.product_document_id,checkpoint_sha256:record.checkpoint_result_sha256!,normalized_sha256:canonicalSha256(e),observation_ids:[...new Set(pending)],dependent_check_ids:pensionCheckIds(input.check_prefix)});
 }
 const sourceFacts=result.source_facts;
 const wageFor=(period:Period,key:'wage_basis'|'eligible_interval_basis')=>{
  const matches=found.filter(f=>f.literal.kind==='wage'&&samePeriod(f.literal.period,period));if(!matches.length)return null;
  const first=matches[0];if(first.literal.kind!=='wage')throw Error('PENSION_SOURCE_WAGE_KIND');
  const candidate:DocumentReviewOperand={id:key==='wage_basis'?'pension.source.wage':'pension.source.interval_wage',observation_id:first.observation_id,state:'observed',printed_value:money(first.literal.minor),representation:'money_ils',quantity_unit:null,precision:'source_exact',source:first.source};
  // Two physical clauses are not collapsed by matching amounts. A different
  // accepted printed base is a conflict, never silently replaced for a pass.
  const existing=key==='wage_basis'?result.pensionable_wage:result.eligible_interval_wage?.operand;
  const printed=existing?.state==='observed'&&existing.representation==='money_ils'&&existing.printed_value!==null?normalizeMoney(existing.printed_value,'ILS'):null;
  const conflict=matches.length!==1||!!existing&&(existing.state!=='observed'||!printed||printed.minor_units!==first.literal.minor);
  const operand=existing??candidate;
  sourceFacts[key]={state:conflict?'conflict':'observed',value:conflict?null:{period,operand_sha256:canonicalSha256(operand),composition:'explicit_all_pensionable_components',basis_kind:'identified_contract_amount'},source:first.source};
  return conflict?null:operand;
 };
 const wage=wageFor(input.period,'wage_basis');if(wage&&!result.pensionable_wage)result.pensionable_wage=wage;
 const eligible=resolvePensionEligibility(result).eligibility;
 if(eligible.partial_waiting_month&&eligible.eligible_interval){const interval=wageFor(eligible.eligible_interval,'eligible_interval_basis');if(interval&&!result.eligible_interval_wage)result.eligible_interval_wage={period:eligible.eligible_interval,operand:interval};}
 const start=input.facts.employment_start;
 if(['known','derived'].includes(start.state)&&start.value){
  const prior=found.filter(f=>f.literal.kind==='prior'&&f.literal.period.from<=start.value!&&f.literal.period.to>=start.value!);
  if(prior.length){const first=prior[0];sourceFacts.prior_insurance={state:prior.length===1?'observed':'conflict',value:prior.length===1?{period:first.literal.period,product:'pension_fund',coverage:'active'}:null,source:first.source};}
 }
 const arrangements=found.filter(f=>f.literal.kind==='arrangement'&&f.literal.period.from<=input.period.from&&f.literal.period.to>=input.period.to);
 if(arrangements.length){const first=arrangements[0];if(first.literal.kind==='arrangement')sourceFacts.arrangement={state:arrangements.length===1?'observed':'conflict',value:arrangements.length===1?{period:first.literal.period,employee_percent:first.literal.employee,employer_percent:first.literal.employer,severance_percent:first.literal.severance,product:'pension_fund'}:null,source:first.source};}
 for(const unresolved of negative){const key=unresolved.kind==='prior'?'prior_insurance':unresolved.kind==='arrangement'?'arrangement':samePeriod(unresolved.period,input.period)?'wage_basis':'eligible_interval_basis';
  if(sourceFacts[key].state==='observed')sourceFacts[key]={state:'conflict',value:null,source:unresolved.source};
  else if(sourceFacts[key].state==='missing'||sourceFacts[key].state==='unknown')sourceFacts[key]={state:unresolved.state,value:null,source:unresolved.source};}
 return {input:pensionEntitlementInputSchema.parse(result),reading_dependencies};
}
export function assertPensionSourceFacts(input:PensionEntitlementInput,review:DocumentReviewInput){
 if(!input.source_facts)return;
 const replay=attachPensionSourceFacts(input,review).input;
 if(canonicalSha256(input.source_facts)!==canonicalSha256(replay.source_facts))throw Error('PENSION_SOURCE_FACT_REPLAY');
 for(const key of ['pensionable_wage','eligible_interval_wage'] as const){const current=input[key],source=key==='pensionable_wage'?input.pensionable_wage?.source:input.eligible_interval_wage?.operand.source;
  if(isPensionProducedSource(source)&&canonicalSha256(current)!==canonicalSha256(replay[key]))throw Error('PENSION_SOURCE_OPERAND_REPLAY');}
}
