import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {normalizeMoney} from '../extraction/normalization.ts';
import {payslipMachineExtractionSha256,identifiedSourceStructure,identifiedDirectRowCell,identifiedMappedRowCell,type materializeValidatedPayslipReadings} from '../extraction/reading-resolution.ts';
import {sourceStructureSubject,type SourceStructureSelector} from '../extraction/source-structure-resolution.ts';
import type {NormalizedPayslipExtraction} from '../extraction/payslip.ts';
import type {DocumentReviewInput,ReviewDocument} from './contracts.ts';
import {documentReviewCalculationInputSchema,type DocumentReviewCalculationInput,type DocumentReviewOperand} from './calculations.ts';
import {documentReviewSourceStructureSchema,sourceRelationshipUsable,sourceStructureGroupDisjoint,type DocumentReviewSourceStructure} from './source-structure-evidence.ts';
import type {ReviewCompletionNeed} from './completions.ts';

type Materialized=ReturnType<typeof materializeValidatedPayslipReadings>;
type Topic=DocumentReviewInput['purchased_scope']['topics'][number];
type Add=(id:string,topic:Topic,title:string,explanation:string,operands:DocumentReviewOperand[],operation:DocumentReviewCalculationInput['operation'],requestReadings?:boolean,structure?:DocumentReviewSourceStructure)=>unknown;
/** A v3 adapter over the ordinary source arithmetic path. This consumes source
 * structure readings and never writes a scalar candidate or legal decision. */
export function appendPayslipSourceStructures(input:{index:number;case_id:string;period:DocumentReviewInput['period'];topics:Topic[];
 document:ReviewDocument;original:NormalizedPayslipExtraction;materialized:Materialized;firstPass:NormalizedPayslipExtraction;checkpointSha256:string;
 checks:DocumentReviewInput['checks'];gaps:DocumentReviewInput['coverage_gaps'];needs:ReviewCompletionNeed[];bindings:DocumentReviewInput['answer_bindings'];
 add:Add;moneyOperand:(field:string,id:string,label:string)=>DocumentReviewOperand;scopedOperand:(scope:'voluntary_deduction',id:string,label:string)=>DocumentReviewOperand}){
 const {document:d,original,materialized:m,index}=input;
 const pins={schema_version:'document-review-source-structure-v1' as const,document_id:d.document_id,version_id:d.version_id,file_sha256:d.file_sha256,
  reading_sha256:d.reading_sha256,machine_extraction_sha256:payslipMachineExtractionSha256(original),first_pass_sha256:canonicalSha256(input.firstPass),checkpoint_result_sha256:input.checkpointSha256};
 const entry=(selector:SourceStructureSelector)=>{
  const subject=sourceStructureSubject({extraction:original,firstPass:input.firstPass,selector});
  const reading=identifiedSourceStructure({original,structureReadings:m.structureReadings,subject})?.reading??null;
  return {subject,reading};
 };
 const remove=(ids:string[])=>{
  for(let i=input.gaps.length-1;i>=0;i--)if(ids.includes(input.gaps[i].check_id))input.gaps.splice(i,1);
  for(let i=input.needs.length-1;i>=0;i--)if(input.needs[i].dependent_check_ids.some(id=>ids.includes(id)))input.needs.splice(i,1);
  for(let i=input.bindings.length-1;i>=0;i--)if(ids.includes(input.bindings[i].check_id))input.bindings.splice(i,1);
 };
 for(const check of [...input.checks]){
  const calc=documentReviewCalculationInputSchema.parse(check.calculation),op=calc.operation;
  if(!check.check_id.startsWith(`document.${index}.ratio.`)||op.kind!=='observed_ratio')continue;
  // Existing positive source-layout evidence remains admissible under its
  // historical policy; no extra question is manufactured for it.
  if(op.same_period_and_base)continue;
  const numerator=calc.operands.find(o=>o.id===op.numerator_ref)!,denominator=calc.operands.find(o=>o.id===op.denominator_ref)!;
  const field=original.fields.find(f=>f.candidate_id===numerator.observation_id),scope=original.source_scope_observations?.find(o=>o.candidate.candidate_id===numerator.observation_id);
  const kind=scope?.scope==='combined_employer_funds'?'combined_employer_funds':field?.field==='pension_employee_contribution'?'pension_employee':field?.field==='pension_employer_contribution'?'pension_employer':field?.field==='severance_contribution'?'severance':null;
  if(!kind||!original.fields.some(f=>f.candidate_id===denominator.observation_id&&f.field==='pension_base'))continue;
  const exact=(o:DocumentReviewOperand)=>{try{const loc=JSON.parse(o.source.locator);return Array.isArray(loc.candidate_ids)&&loc.candidate_ids.length===1;}catch{return false;}};
  if(!exact(numerator)||!exact(denominator))continue;
  let e;try{e=entry({kind:'source_relationship',componentKind:kind,contribution:{kind:scope?'scope':'field',id:numerator.observation_id},base:{kind:'field',id:denominator.observation_id}});}catch{continue;}
  const witness=documentReviewSourceStructureSchema.parse({...pins,kind:'source_relationship',entry:e,numerator_ref:op.numerator_ref,denominator_ref:op.denominator_ref});
  const ready=sourceRelationshipUsable(witness);
  input.checks.splice(input.checks.indexOf(check),1);remove([check.check_id,`${check.check_id}.relationship`]);
  input.add(check.check_id.slice(`document.${index}.`.length),check.topic,check.title,
   'יחס חשבוני בין סכום לבסיס שבקשר המקור המסומן. זיהוי הקרן והקשר נשמר בנפרד מקריאת המספרים; אין כאן שיעור חובה, פיצול רכיבים או אישור הפקדה.',calc.operands,
   {...op,same_period_and_base:ready,basis:'Identified source relationship and fund classification; numeric readings remain independently required.'},ready,witness);
 }
 if(input.topics.includes('minimum_wage')&&original.additional_components.some(r=>r.semantic_kind==='deduction')){
  let e;try{e=entry({kind:'deduction_group'});}catch{e=null;}
  if(e&&e.subject.kind==='deduction_group'&&e.subject.rows.length<=24){
   remove([`document.${index}.deductions.grouping`]);
   const value=e.reading?.value;
   for(const group of ['mandatory','voluntary'] as const){
    if(group==='voluntary'&&!e.subject.voluntary_total)continue;
    const members=value?.kind==='deduction_group'?value.members.filter(v=>v.group===group).map(v=>v.component_id):e.subject.rows.map(r=>r.id);
    // An empty/partial assignment is not a zero total. Keep a missing inventory
    // term, with the whole source group, until membership is established.
    const selected=members.length?members:e.subject.rows.map(r=>r.id);
    const operands=selected.map((id,i)=>deductionAmount(original,m,id,`deduction.${i}`,d));
    const complete=value?.kind==='deduction_group'&&value.inventory==='complete'&&members.length>0;
    const witness=documentReviewSourceStructureSchema.parse({...pins,kind:'deduction_group',entry:e,group,row_bindings:selected.map((component_id,i)=>({component_id,operand_id:`deduction.${i}`})),recorded_ref:'total'});
    input.add(`deductions.${group}`,'minimum_wage',group==='mandatory'?'התאמת שורות ניכויי חובה לסיכום':'התאמת שורות ניכויי רשות לסיכום',
     'סכום השורות ששויכו במפורש לקבוצה במקור מול הסיכום שלה. השיוך והשלמות אינם מוסקים מהתאמת סכומים; אין כאן קביעה שהניכוי מותר או אישור תשלום.',
     [...operands,group==='mandatory'?input.moneyOperand('total_deductions','total','סך ניכויי חובה'):input.scopedOperand('voluntary_deduction','total','סך ניכויי רשות')],
     {kind:'reconciliation',add_refs:operands.map(o=>o.id),subtract_refs:[],recorded_ref:'total',inventory_complete:complete,inventory_basis:'Explicit source group membership and complete/partial inventory.',disjoint_components:sourceStructureGroupDisjoint(witness),overlap_basis:'Each exact source row ID once in one explicitly assigned group; repeated source locations are not assumed distinct.'},complete&&sourceStructureGroupDisjoint(witness),witness);
   }
  }
 }
 for(const balanceKind of ['vacation','sick'] as const){
  const topic=balanceKind==='vacation'?'vacation':'sick_leave';if(!input.topics.includes(topic))continue;
  const anchors=input.firstPass.fields.filter(f=>f.field===`${balanceKind}_balance`);
  const unavailable=()=>input.gaps.push({check_id:`document.${index}.balance.${balanceKind}.source_block`,topic,kind:'missing_source',
   detail:'לא זוהה מקטע יתרה יחיד השייך לתקופה הנבדקת. תצפיות המקור נשמרו, אך לא עורבבו יתרות מצטברות או מקטעים שונים.',
   next_step:'יש לזהות את טבלת היתרה המתאימה לחודש ואת גבולותיה לפני קריאת תנועות. אין להסיק יחידה או יתרת פתיחה מהסכום הסופי.',
   source_pins:[{case_id:input.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256}]});
  if(anchors.length!==1){if(anchors.length)unavailable();continue;}
  const cells=['opening','accrued','used','adjustments','closing'] as const;
  let entries;try{entries=cells.map(cell=>entry({kind:'balance_movement',balanceKind,cell,candidateId:anchors[0].candidate_id}));}catch{unavailable();continue;}
  remove([`document.${index}.balance.${balanceKind}_balance.unit`,`document.${index}.balance.${balanceKind}_balance.movement`]);
  const adjustment=entries.find(e=>e.subject.kind==='balance_movement'&&e.subject.cell==='adjustments')?.reading?.value;
  const absentAdjustment=adjustment?.kind==='balance_movement'&&adjustment.state==='not_present';
  const included=entries.filter(e=>e.subject.kind==='balance_movement'&&(!absentAdjustment||e.subject.cell!=='adjustments'));
  const operands:DocumentReviewOperand[]=included.map(e=>{
   if(e.subject.kind!=='balance_movement')throw Error('REVIEW_BALANCE_STRUCTURE');
   const v=e.reading?.value,has=v?.kind==='balance_movement'&&v.state==='value';
   return {id:`balance.${e.subject.cell}`,observation_id:`structure:${canonicalSha256(e.subject)}`,state:has?(m.extraction.status==='failed'||m.extraction.document_quality_confidence<.95?'unknown':'observed'):'missing',printed_value:has?v.amount:null,
    representation:'decimal_quantity',quantity_unit:has?v.unit:null,precision:'printed_precision',source:{document_id:d.document_id,version_id:d.version_id,file_sha256:d.file_sha256,
     page:e.subject.page,label:`${balanceKind==='vacation'?'חופשה':'מחלה'} — ${{opening:'פתיחה',accrued:'צבירה',used:'ניצול',adjustments:'התאמות',closing:'סגירה'}[e.subject.cell]}`,
     locator:JSON.stringify({schema_version:'document-review-source-structure-locator-v1',subject_sha256:canonicalSha256(e.subject)}),reading:has?'identified_document_reading':'provider_extraction',reading_receipt_sha256:d.reading_sha256}};
  });
  const witness=documentReviewSourceStructureSchema.parse({...pins,kind:'balance_movement',entries,cell_bindings:included.map(e=>{
   if(e.subject.kind!=='balance_movement')throw Error('REVIEW_BALANCE_STRUCTURE');return {cell:e.subject.cell,operand_id:`balance.${e.subject.cell}`};})});
  input.add(`balance.${balanceKind}` ,topic,`התאמת תנועות יתרת ${balanceKind==='vacation'?'חופשה':'מחלה'}`,
   'פתיחה ועוד צבירה והתאמות, פחות ניצול, מול סגירה באותו מקטע מקור ובאותו חודש. כשיחידה אינה מודפסת נבדקת זהות מספרית בלבד, ללא הנחת ימים או שעות וללא בדיקת זכאות.',operands,
   {kind:'reconciliation',add_refs:['balance.opening','balance.accrued',...(absentAdjustment?[]:['balance.adjustments'])],subtract_refs:['balance.used'],recorded_ref:'balance.closing',
    inventory_complete:entries.every(e=>e.reading!==null),inventory_basis:'All five source roles identified; absent adjustment requires explicit source reading.',disjoint_components:true,overlap_basis:'One opening/accrued/used/adjustment/closing cell in the same pinned balance block and month.'},false,witness);
 }
}
function deductionAmount(original:NormalizedPayslipExtraction,m:Materialized,id:string,operandId:string,d:ReviewDocument):DocumentReviewOperand{
 const rawRow=original.additional_components.find(r=>r.component_id===id)!,row=m.extraction.additional_components.find(r=>r.component_id===id)!;
 const direct=identifiedDirectRowCell({original,effective:m.extraction,rowReadings:m.rowReadings,row:rawRow,cell:'amount'});
 const mapped=identifiedMappedRowCell({original,effective:m.extraction,readings:m.readings,row:rawRow,cell:'amount'});
 const raw=direct?.raw_value??mapped?.raw_value??row.amount_raw,value=raw===null?null:normalizeMoney(raw);
 const valid=value?.currency==='ILS'&&canonicalSha256(row.amount)===canonicalSha256(value);
 const unsafe=m.extraction.status==='failed'||m.extraction.document_quality_confidence<.95||row.warning_flags.length>0
  ||row.source.source_scope?.period_kind!=='current'||row.normalization_warnings.some(w=>w!=='quantity_normalization_failed'&&w!=='rate_normalization_failed'&&w!=='percentage_normalization_failed');
 return {id:operandId,observation_id:`${id}:amount`,state:raw===null?'missing':!valid?'unreadable':unsafe?'unknown':direct||mapped||row.confidence>=.95?'observed':'unknown',
  printed_value:value?.currency==='ILS'?(value.minor_units/100).toFixed(2):null,representation:'money_ils',quantity_unit:null,precision:'printed_precision',
  source:{document_id:d.document_id,version_id:d.version_id,file_sha256:d.file_sha256,page:row.source.page,label:row.source_label,
   locator:JSON.stringify({schema_version:'document-review-source-locator-v2',component_ids:[id],cell:'amount',original_component_sha256:[canonicalSha256(rawRow)],raw_values:[rawRow.amount_raw]}),
   reading:direct||mapped?'identified_document_reading':'provider_extraction',reading_receipt_sha256:d.reading_sha256}};
}
