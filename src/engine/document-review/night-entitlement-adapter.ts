import {canonicalSha256} from '../rule-runtime/canonical.ts';
import {documentReviewInputSchema,reviewDocumentSchema,type DocumentReviewInput,type ReviewDocument} from './contracts.ts';
import {parseReviewCompletionInput,type ReviewCompletionNeed,type ReviewSourcePin} from './completions.ts';
import type {DocumentReviewSource} from './calculations.ts';
import {resolveDocumentReviewNightEntitlement,type NightEntitlementInput} from '../legal-operations/document-review-entitlement-night-work.ts';
import {NIGHT_ENTITLEMENT_LEGAL_MANIFEST,NIGHT_ENTITLEMENT_SOURCE_REVIEW_SHA256} from '../legal-operations/document-review-entitlement-source-policy.ts';

export type NightEntitlementSelection=Readonly<{entitlement:NightEntitlementInput;completion_fact_keys?:Readonly<Record<string,string>>}>;
export function nightEntitlementReviewDocument(caseId:string):ReviewDocument{
 const pin=NIGHT_ENTITLEMENT_LEGAL_MANIFEST;
 return {case_id:caseId,document_id:pin.document_id,version_id:pin.version_id,file_sha256:pin.file_sha256,page_count:pin.page_count,
  kind:'other',label:'חוק שעות עבודה ומנוחה — מקור רשמי לחישוב המותנה',period:null,
  reading_origin:'ai_document_review',reading_sha256:NIGHT_ENTITLEMENT_SOURCE_REVIEW_SHA256};
}
export function isNightEntitlementReviewDocument(document:ReviewDocument):boolean{
 return canonicalSha256(document)===canonicalSha256(nightEntitlementReviewDocument(document.case_id));
}
export function isPinnedNightEntitlementLegalDocument(candidate:unknown,caseId:string):boolean{
 const parsed=reviewDocumentSchema.safeParse(candidate);
 if(!parsed.success||parsed.data.case_id!==caseId||!isNightEntitlementReviewDocument(parsed.data))return false;
 try{return canonicalSha256(candidate)===canonicalSha256(parsed.data);}catch{return false;}
}
function citations(selection:NightEntitlementInput):DocumentReviewSource[]{
 return [selection.hourly_wage.source,...selection.intervals.flatMap(i=>[i.clock_source,i.printed_presence.source]),
  ...selection.payroll_allocations.flatMap(a=>[a.hours.source,a.hourly_rate.source,...(a.percentage?[a.percentage.source]:[])]),
  ...selection.applicability.flatMap(d=>d.sources)];
}
/** Normal product input composition, including a version-pinned law document
 * and the existing completion planner. It does not create source readings,
 * answers, findings, reports, signatures, or an active legal catalog. */
export function enhanceDocumentReviewNightEntitlements(candidate:DocumentReviewInput,selections:readonly NightEntitlementSelection[]):DocumentReviewInput{
 const input=documentReviewInputSchema.parse(candidate);
 if(!selections.length)return input;
 if(!input.purchased_scope.topics.includes('working_time'))throw Error('NIGHT_REVIEW_UNPURCHASED');
 if(selections.length>32||new Set(selections.map(s=>s.entitlement.check_id)).size!==selections.length)throw Error('NIGHT_REVIEW_SELECTION_SET');
 const completion=parseReviewCompletionInput(input.completion_input),documents=[...input.documents],checks=[...input.checks],gaps=[...input.coverage_gaps],needs=[...completion.needs];
 const legal=nightEntitlementReviewDocument(input.case_id),prior=documents.find(d=>d.document_id===legal.document_id);
 if(prior&&!isNightEntitlementReviewDocument(prior))throw Error('NIGHT_REVIEW_LAW_PIN');
 if(!prior)documents.push(legal);
 for(const selection of selections){
  const e=selection.entitlement;
  if(e.case_id!==input.case_id||e.period.from<input.period.from||e.period.to>input.period.to)throw Error('NIGHT_REVIEW_CONTEXT');
  for(const source of citations(e)){
   const d=documents.find(d=>d.document_id===source.document_id&&d.version_id===source.version_id);
   if(!d||d.file_sha256!==source.file_sha256||d.page_count===null||source.page>d.page_count||![d.reading_sha256,...(d.accepted_reading_sha256??[])].includes(source.reading_receipt_sha256))throw Error('NIGHT_REVIEW_READING_SOURCE');
  }
  for(const pin of e.source_manifest){
   const d=documents.find(d=>d.document_id===pin.document_id&&d.version_id===pin.version_id);
   if(!d||d.file_sha256!==pin.file_sha256||d.page_count!==pin.page_count||(pin.kind==='legal_source'?pin.case_id!==null:pin.case_id!==input.case_id))throw Error('NIGHT_REVIEW_MANIFEST_SOURCE');
  }
  const resolved=resolveDocumentReviewNightEntitlement(e);
  if(resolved.check){
   const prior=checks.find(c=>c.check_id===resolved.check!.check_id);
   if(prior&&canonicalSha256(prior)!==canonicalSha256(resolved.check))throw Error('NIGHT_REVIEW_CHECK_COLLISION');
   if(!prior)checks.push(resolved.check);
  }else if(!gaps.some(g=>g.check_id===e.check_id))gaps.push({check_id:e.check_id,topic:'working_time',kind:resolved.missing.some(m=>m.dependency_id==='night.dated_attendance')?'missing_source':'missing_fact',
   detail:'לא ניתן לקבוע גמול ליום עבודה לילי מהנתונים הזמינים. לא הוצג סכום אפס במקום מידע חסר.',next_step:resolved.missing.map(m=>m.question).join(' ')});
  const uniqueMissing=[...new Map(resolved.missing.map(m=>[m.dependency_id,m])).values()];
  for(const missing of uniqueMissing){
   const attendancePins:ReviewSourcePin[]=documents.filter(d=>d.kind==='attendance'&&e.intervals.some(i=>i.clock_source.document_id===d.document_id)).map(d=>({case_id:d.case_id,document_id:d.document_id,version_id:d.version_id,source_sha256:d.file_sha256}));
   if(['night.breaks','night.workday','night.non_rest_day'].includes(missing.dependency_id)){
    // A free-text identified declaration is useful evidence, but cannot be
    // parsed as automatic legal classification. Keep this work visible even
    // when the planner suppresses a customer question after its answer.
    const fact_key=`night.reassess.${canonicalSha256({check:e.check_id,dependency:missing.dependency_id}).slice(0,24)}`;
    if(!needs.some(n=>n.fact_key===fact_key))needs.push({fact_key,kind:'legal',reason:'unknown',required_evidence_kind:'observed_reading',
     question:`יש לסווג מחדש את נתוני הרשומות ${[...new Set(e.intervals.map(i=>i.date))].join(', ')} לפי התשובה המזוהה ולבדוק את השפעתה על החישוב. תשובה חופשית אינה הופכת לאישור תחולה משפטית.`,
     answer_kind:'text',source_pins:attendancePins,dependent_check_ids:[e.check_id],general_question:false});
   }
   const alias=selection.completion_fact_keys?.[missing.dependency_id];
   if(alias){
    const indexes=needs.map((n,index)=>({n,index})).filter(({n})=>n.fact_key===alias);
    if(indexes.length!==1)throw Error('NIGHT_REVIEW_COMPLETION_ALIAS');
    const {n,index}=indexes[0];needs[index]={...n,dependent_check_ids:[...new Set([...n.dependent_check_ids,e.check_id])]};continue;
   }
   const legalDependency=['night.coverage','night.regular_wage','night.weekly_overlap','night.payroll_allocation','night.rounding'].includes(missing.dependency_id);
   const documentMissing=missing.dependency_id==='night.dated_attendance';
   const reason:ReviewCompletionNeed['reason']=missing.state==='conflict'?'conflicted':missing.state==='unreadable'?'unreadable':missing.state==='missing'?'missing':'unknown';
   // Different workdays can share a question only when its exact source target
   // and period agree. The explicit alias above reuses known existing targets.
   const fact_key=`night.${canonicalSha256({period:e.period,pins:attendancePins}).slice(0,16)}.${missing.dependency_id.slice(6)}`;
   const need:ReviewCompletionNeed={fact_key,kind:documentMissing?'document':legalDependency?'legal':'factual',reason,
    required_evidence_kind:documentMissing?'document':legalDependency?'observed_reading':'customer_declaration',question:missing.question,
    answer_kind:documentMissing?'document':'text',source_pins:attendancePins,dependent_check_ids:[e.check_id],general_question:false,
    ...(documentMissing?{document_kind:'attendance'}:{})};
   const existing=needs.findIndex(n=>n.fact_key===fact_key);
   if(existing<0)needs.push(need);
   else {const {dependent_check_ids:_a,...a}=needs[existing],{dependent_check_ids:_b,...b}=need;void _a;void _b;
    if(canonicalSha256(a)!==canonicalSha256(b))throw Error('NIGHT_REVIEW_COMPLETION_AMBIGUOUS');
    needs[existing]={...needs[existing],dependent_check_ids:[...new Set([...needs[existing].dependent_check_ids,e.check_id])]};}
  }
 }
 return documentReviewInputSchema.parse({...input,documents,checks,coverage_gaps:gaps,completion_input:{...completion,needs}});
}
