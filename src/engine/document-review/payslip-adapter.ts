import type {StoredCaseInputSnapshot} from '../case-analysis/contracts.ts';
import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {resolvePayslipSnapshot,resolvedPayslipFactPaths,IDENTIFIED_AGREEING_CANDIDATES_POLICY} from '../extraction/resolver.ts';
import {validatePayslipGate0,SOURCE_ROW_DUPLICATE_POLICY} from '../extraction/validation.ts';
import {normalizeMoney,normalizeDecimal,normalizePercentage} from '../extraction/normalization.ts';
import type {NormalizedCandidateField,NormalizedPayslipExtraction} from '../extraction/payslip.ts';
import {DOCUMENT_REVIEW_POLICY,type DocumentReviewInput} from './contracts.ts';
import type {DocumentReviewCalculationInput,DocumentReviewOperand} from './calculations.ts';
import type {ReviewCompletionNeed} from './completions.ts';

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
const rowTopic:Partial<Record<Component['semantic_kind'],Topic>>={base_salary:'minimum_wage',hourly_base:'minimum_wage',overtime_125:'working_time',overtime_150:'working_time',travel:'travel',convalescence:'convalescence',bonus:'bonuses'};

/** Source arithmetic from the SAME saved extraction and canonical reading
 * policy. Neither a model confidence nor a customer's cell reading is legal
 * authority. Every original observation remains in the immutable receipt. */
export function reviewInputFromPayslips(input:{case_id:string;period:DocumentReviewInput['period'];purchased_scope:DocumentReviewInput['purchased_scope'];snapshot:StoredCaseInputSnapshot}):DocumentReviewInput{
 const {snapshot}=input;
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
 const checks:DocumentReviewInput['checks']=[],needs:ReviewCompletionNeed[]=[],coverage_gaps:DocumentReviewInput['coverage_gaps']=[],answer_bindings:DocumentReviewInput['answer_bindings']=[];
 for(const [index,{d:original,e:extraction}] of pairs.entries()){
  const d=documents[index],receipt=d.reading_sha256,pin={case_id:input.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256};
  const gap=(id:string,topic:Topic,detail:string,next_step:string,kind:'missing_source'|'missing_fact'='missing_fact')=>{
   if(input.purchased_scope.topics.includes(topic))coverage_gaps.push({check_id:`document.${index}.${id}`,topic,kind,detail,next_step});
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
  const resolved=resolvePayslipSnapshot({document:original,extraction,validation,context,reading_policy:IDENTIFIED_AGREEING_CANDIDATES_POLICY});
  const globallyUnreadable=extraction.status==='failed'||extraction.document_quality_confidence<0.65;
  const periodFact=resolved.facts.find(f=>f.path==='documents.period');
  const periods=extraction.fields.filter(f=>f.field==='salary_period');
  const periodValid=periodFact?.status==='confirmed'&&periods.length>0&&periods.every(f=>f.normalized_value
   &&f.normalized_value.start_date>=input.period.from&&f.normalized_value.end_date<=input.period.to
   &&(!original.document_period||f.normalized_value.start_date===original.document_period.start_date&&f.normalized_value.end_date===original.document_period.end_date));
  if(!periodValid){gap('period',input.purchased_scope.topics[0],'לא אומתה התאמה בין חודש התלוש לתקופה הנבדקת.','יש לברר את חודש המקור לפני שיוך חישובים אליו.');continue;}
  const manifest=[{document_id:d.document_id,version_id:d.version_id,file_sha256:d.file_sha256,page_count:d.page_count,kind:'case_document' as const,case_id:input.case_id}];
  const source=(page:number,label:string,locator:unknown):DocumentReviewOperand['source']=>({document_id:d.document_id,version_id:d.version_id,file_sha256:d.file_sha256,page,
   label:label.slice(0,300),locator:JSON.stringify(locator).slice(0,500),reading:'provider_extraction',reading_receipt_sha256:receipt});
  const fieldState=(field:string):DocumentReviewOperand['state']=>{
   const candidates=extraction.fields.filter(f=>f.field===field);
   if(!candidates.length)return 'missing';
   if(globallyUnreadable)return 'unreadable';
   if(candidates.some(f=>!monetary(f)||monetary(f)?.currency!=='ILS'||canonicalSha256(normalizeMoney(f.raw_value))!==canonicalSha256(monetary(f))))return 'unreadable';
   const assessments=candidates.map(f=>validation.field_assessments.find(a=>a.candidate_id===f.candidate_id));
   if(new Set(candidates.map(f=>canonicalSha256(f.normalized_value))).size>1||assessments.some(a=>a?.issue_codes.includes('conflicting_candidates')))return 'conflict';
   if(assessments.some(a=>!a||a.status==='invalid'))return 'unreadable';
   const path=scalarPaths[field];
   if(path)return resolved.facts.find(f=>f.path===path)?.status==='confirmed'?'observed':'unknown';
   if(candidates.length!==1)return 'unknown';
   const f=candidates[0],a=assessments[0]!;
   const identified=extraction.customer_readings?.some(r=>r.candidate_id===f.candidate_id)&&a.issue_codes.every(c=>readingIssues.has(c));
   return identified||extraction.document_quality_confidence>=0.95&&f.confidence>=0.95&&a.status==='valid'&&f.warning_flags.length===0?'observed':'unknown';
  };
  const moneyOperand=(field:string,id:string,label:string):DocumentReviewOperand=>{
   const candidates=extraction.fields.filter(f=>f.field===field),f=candidates[0],m=monetary(f);
   return {id,observation_id:f?.candidate_id??`${d.version_id}:${field}`,state:fieldState(field),printed_value:m?.currency==='ILS'?decimalMoney(m.minor_units):null,
    representation:'money_ils',quantity_unit:null,precision:'printed_precision',source:source(f?.source.page??1,label,{field,observations:candidates.map(f=>({candidate_id:f.candidate_id,raw:f.raw_value,source:f.source}))})};
  };
  const add=(checkId:string,topic:Topic,title:string,explanation:string,operands:DocumentReviewOperand[],operation:DocumentReviewCalculationInput['operation'])=>{
   if(!input.purchased_scope.topics.includes(topic))return;
   const check_id=`document.${index}.${checkId}`;
   checks.push({check_id,topic,title,explanation,calculation:{schema_version:'document-review-calculation-input-v1',case_id:input.case_id,run_id:'pending',check_id,
    period:input.period,evaluated_at:new Date(extraction.extracted_at).toISOString(),source_manifest:manifest,operands,operation,remittance_status:'not_assessed'}});
   for(const operand of operands.filter(o=>o.state!=='observed')){
    const fact_key=`document.${index}.${checkId}.${operand.id}`;
    needs.push({fact_key,kind:'factual',reason:operand.state==='conflict'?'conflicted':operand.state==='missing'?'missing':operand.state==='unreadable'?'unreadable':'unknown',
     required_evidence_kind:'observed_reading',question:`לצורך ${title}: מהו ${operand.source.label} במקור המסומן? אם לא ניתן לקבוע, יש לציין זאת.`,answer_kind:'number',source_pins:[pin],dependent_check_ids:[check_id],general_question:false});
    answer_bindings.push({fact_key,check_id,operand_id:operand.id});
   }
  };
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
   const related=contributions.length===1&&bases.length===1&&c.source.page===b.source.page&&labelledBase&&labelledContribution&&!/השתלמות|study\s*fund/iu.test(both)&&Boolean(sharedRow||sharedExcerpt);
   add(`ratio.${field}`,'pension',`יחס נצפה — ${label}`,'יחס בין סכום לבסיס שזוהו באותו רכיב. זה אינו שיעור חובה ואינו אישור הפקדה.',
    [moneyOperand(field,'contribution',label),moneyOperand('pension_base','base','בסיס הפנסיה')],{kind:'observed_ratio',numerator_ref:'contribution',denominator_ref:'base',component_identity:label,same_period_and_base:related,
     basis:related?'Explicit source-labelled same pension row/excerpt and confirmed source period; immutable observations retain labels and locations.':'The saved source does not establish that this contribution and this base belong to the same pension component.'});
   if(!related)gap(`ratio.${field}.relationship`,'pension','לא הוכח שהסכום ובסיס הפנסיה שייכים לאותו רכיב.','יש לזהות במקור את בסיס הרכיב ואת הסכום המקביל; אישור הפקדה אינו נדרש לבדיקת היחס.');
  }
  if(['gross_salary','total_deductions','net_salary'].some(field=>extraction.fields.some(f=>f.field===field)))
   add('gross.net','minimum_wage','התאמת ברוטו, ניכויים ונטו','בדיקת חיסור הסכומים הכוללים שנקראו. פער חשבוני דורש בירור ואינו חוב; התאמה אינה הוכחת העברה לחשבון.',
    [moneyOperand('gross_salary','gross','ברוטו'),moneyOperand('total_deductions','deductions','סך הניכויים'),moneyOperand('net_salary','net','נטו')],
    {kind:'reconciliation',add_refs:['gross'],subtract_refs:['deductions'],recorded_ref:'net',inventory_complete:true,inventory_basis:'Explicit total fields; individual deduction rows are not added again.',disjoint_components:true,overlap_basis:'Gross less one deduction total; no component aggregation.'});
  const groups=new Map<string,Component[]>();
  for(const row of extraction.additional_components){
   if(!rowTopic[row.semantic_kind])continue;
   // No source location means no proof that identical-looking rows duplicate.
   const location=row.source.bounding_box??row.source.text_fragment??row.component_id;
   const key=canonicalSha256({document:d.document_id,page:row.source.page,location,label:row.source_label});
   groups.set(key,[...(groups.get(key)??[]),row]);
  }
  for(const [key,rows] of groups){
   const row=rows[0],topic=rowTopic[row.semantic_kind]!,rowId=`row.${key.slice(0,20)}`;
   if(!input.purchased_scope.topics.includes(topic))continue;
   const cells=(r:Component)=>[r.semantic_kind,r.quantity_raw,r.rate_raw,r.percentage_raw,r.amount_raw,r.quantity,r.rate,r.percentage,r.amount];
   const conflict=new Set(rows.map(r=>canonicalSha256(cells(r)))).size>1;
   const uncertain=globallyUnreadable||extraction.document_quality_confidence<0.95||rows.some(r=>r.confidence<0.95||r.warning_flags.length>0||r.normalization_warnings.length>0);
   const rowOperand=(id:'quantity'|'rate'|'amount'|'percentage'):DocumentReviewOperand=>{
    const raw=row[`${id}_raw`],normalized=row[id];
    const money=id==='rate'||id==='amount';
    const value=money?row[id as 'rate'|'amount']:null;
    const rawNormalized=raw===null?null:money?normalizeMoney(raw):id==='quantity'?normalizeDecimal(raw):normalizePercentage(raw);
    const invalid=normalized===null||money&&value?.currency!=='ILS'||canonicalSha256(normalized)!==canonicalSha256(rawNormalized);
    const state:DocumentReviewOperand['state']=conflict?'conflict':raw===null?'missing':invalid?'unreadable':uncertain?'unknown':'observed';
    const printed=money?value?.currency==='ILS'?decimalMoney(value.minor_units):null:id==='quantity'?row.quantity:row.percentage?decimalMoney(row.percentage.basis_points):null;
    return {id,observation_id:`${row.component_id}:${id}`,state,printed_value:printed,representation:money?'money_ils':id==='percentage'?'percent':'decimal_quantity',
     quantity_unit:money?null:id==='percentage'?'ratio':row.semantic_kind==='hourly_base'||row.semantic_kind.startsWith('overtime_')?'hours':'count',precision:'printed_precision',
     source:source(row.source.page,`${row.source_label} — ${{quantity:'כמות',rate:'תעריף',amount:'סכום',percentage:'אחוז'}[id]}`,{component_ids:rows.map(r=>r.component_id),raw,source:row.source,semantic_kind:row.semantic_kind})};
   };
   const operands=[rowOperand('rate'),rowOperand('quantity'),rowOperand('amount')],factors=['quantity'];
   // Apply a displayed premium only when the displayed rate is positively
   // identified as the same usable base rate. A distinct explicit unit price
   // is used as printed, never multiplied again merely because its row is OT.
   const base=moneyOperand('hourly_rate','hourly.base','תעריף בסיס לשעה');
   const usePercentage=row.semantic_kind.startsWith('overtime_')&&row.percentage_raw!==null&&base.state==='observed'&&row.rate?.currency==='ILS'&&base.printed_value===decimalMoney(row.rate.minor_units);
   if(usePercentage){operands.push(rowOperand('percentage'));factors.push('percentage');}
   add(rowId,topic,`בדיקת שורה — ${row.source_label}`,'השוואת הכמות והתעריף המפורשים לסכום השורה. זהו בירור חשבוני בלבד, לפי עיגול מועמד לאגורה; אין כאן קביעת זכאות או חוב.',operands,
    {kind:'product',money_ref:'rate',factor_refs:factors,recorded_ref:'amount',rounding:'half_up',rounding_basis:usePercentage?'Candidate half-up to agorot; explicit percentage applied to the source-identified base rate.':'Candidate half-up to agorot; quantity times the explicitly printed unit price. No extra OT multiplier inferred; any percentage remains in the source receipt.'});
  }
 }
 return {schema_version:DOCUMENT_REVIEW_POLICY,coverage_gaps,answer_bindings,answer_history:[],case_id:input.case_id,period:input.period,purchased_scope:input.purchased_scope,documents,checks,
  completion_input:{case_id:input.case_id,period:input.period,documents:documents.map(d=>({pin:{case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256},kind:d.kind,review:'partial',period:d.period})),needs,evidence:[]}};
}
