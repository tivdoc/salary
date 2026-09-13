import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../../document-review/contracts.ts';
import type {StoredCaseInputSnapshot} from '../../case-analysis/contracts.ts';
import {parseDocumentEvidenceSourceReading} from '../../extraction/document-evidence/source-transcription.ts';
import {parseObligationLiteralPromise} from './literal-promise.ts';
import {IDENTIFIED_CLAUSE_PROMISE_POLICY,parseIdentifiedClausePromise} from './identified-clause-source.ts';
import type {DocumentReviewSource,DocumentReviewOperand} from '../../document-review/calculations.ts';
import {obligationsEntitlementInputSchema,obligationTextSha256,type ExplicitObligation} from './contracts.ts';
import {enableObligationProductFacts} from './product-facts.ts';

export {IDENTIFIED_CLAUSE_PROMISE_POLICY,parseIdentifiedClausePromise,identifiedClauseTranscriptionSourceCurrent} from './identified-clause-source.ts';

/** Typed text evidence is consumed independently from machine extraction.
 * Reading a clause cannot supply its absent effective dates, source amount
 * association, agreement acceptance, or payment relationship. */
export function attachIdentifiedClauseTranscriptions(candidate:DocumentReviewInput,snapshot:StoredCaseInputSnapshot):DocumentReviewInput{
 if(!candidate.document_source_transcriptions?.length)return candidate;
 const input=documentReviewInputSchema.parse(candidate),gaps=[...input.coverage_gaps],documents=[...input.documents];
 if(input.entitlement_composition)return input;
 const prior=input.entitlement_evidence?.obligations?obligationsEntitlementInputSchema.parse(input.entitlement_evidence.obligations):null;
 const obligations:ExplicitObligation[]=[...(prior?.obligations??[])],manifest=[...(prior?.source_manifest??[])],timestamps=[...(prior?[prior.evaluated_at]:[])];
 const seen=new Set<string>();
 for(const raw of input.document_source_transcriptions!){
  const r=parseDocumentEvidenceSourceReading(raw),t=r.target;
  const saved=snapshot.document_source_transcriptions?.filter(s=>s.request_id===r.request_id);
  if(saved?.length!==1||canonicalSha256(saved[0])!==canonicalSha256(r)||seen.has(r.request_id))throw Error('CLAUSE_TRANSCRIPTION_SNAPSHOT_BINDING');seen.add(r.request_id);
  if(t.case_id!==input.case_id||t.order_id!==input.purchased_scope.order_id||t.order_origin!==input.purchased_scope.origin
   ||t.order_receipt_sha256!==input.purchased_scope.receipt_sha256||canonicalSha256(t.purchased_topics)!==canonicalSha256(input.purchased_scope.topics)
   ||canonicalSha256(t.period)!==canonicalSha256(input.period)||!input.documents.some(d=>d.version_id===t.version_id&&d.file_sha256===t.source_sha256))throw Error('CLAUSE_TRANSCRIPTION_SOURCE_BINDING');
  const check_id='entitlement.transcribed.clause.'+canonicalSha256({request:r.request_id,target:t.target_sha256}).slice(0,24);
  const parsed=r.value?parseIdentifiedClausePromise(r.value.text):null;
  const literal=parsed?.literal??(r.value?parseObligationLiteralPromise(r.value.text):null);
  const topic=literal?.bonus&&input.purchased_scope.topics.includes('bonuses')?'bonuses':input.purchased_scope.topics.includes('contract')?'contract':'bonuses';
  const pin={case_id:t.case_id,document_id:t.version_id,version_id:t.version_id,source_sha256:t.source_sha256};
  const add=(kind:DocumentReviewInput['coverage_gaps'][number]['kind'],detail:string,next_step:string)=>{
   if(!gaps.some(g=>g.check_id===check_id))gaps.push({check_id,topic,kind,detail,next_step,source_pins:[pin]});};
  if(parsed&&r.value&&r.state==='identified_reading'){
   const selectedTopic=parsed.literal.bonus?'bonuses':'contract';if(!input.purchased_scope.topics.includes(selectedTopic))continue;
   const end=new Date(input.period.to+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+1);
   if(input.period.from<'2026-05-01'||input.period.to>'2026-07-31'||!input.period.from.endsWith('-01')||!end.toISOString().slice(0,10).endsWith('-01')
    ||input.period.from.slice(0,7)!==input.period.to.slice(0,7)||parsed.effective_period.from>input.period.from||parsed.effective_period.to<input.period.to){
    add('missing_applicability','תקופת התוקף המפורשת בסעיף אינה מכסה חודש שלם בטווח הבדיקה הנתמך.','יש לזהות מקור המכסה את החודש הנבדק; לא בוצעה פרורציה ולא הושלמו תאריכים.');continue;
   }
   const at=documents.findIndex(d=>d.case_id===t.case_id&&d.document_id===t.version_id&&d.version_id===t.version_id&&d.kind==='contract'&&d.file_sha256===t.source_sha256);
   if(at<0||documents[at].page_count!==null&&documents[at].page_count!==t.page_count)throw Error('CLAUSE_TRANSCRIPTION_PAGE_BINDING');
   const receiptHashes=[...new Set([...(documents[at].accepted_reading_sha256??[]),r.verification_sha256])];
   if(receiptHashes.length>32||obligations.length>=32){add('missing_rule','מספר הקריאות או ההתחייבויות חורג מהגבול הנתמך.','יש לסקור את מלאי הסעיפים לפני צירוף התחייבות נוספת; המקורות נשמרו.');continue;}
   documents[at]={...documents[at],page_count:t.page_count,accepted_reading_sha256:receiptHashes};
   const short=canonicalSha256({request_id:r.request_id,target_sha256:t.target_sha256}).slice(0,32);
   const source:DocumentReviewSource={document_id:t.version_id,version_id:t.version_id,file_sha256:t.source_sha256,page:r.value.page,
    locator:JSON.stringify({schema_version:IDENTIFIED_CLAUSE_PROMISE_POLICY,request_id:r.request_id,answer_revision:r.answer_revision,locator:r.value.locator}),
    label:'סעיף שהועתק במלואו בקריאה מזוהה; ללא אישור תוקף משפטי',reading:'identified_document_reading',reading_receipt_sha256:r.verification_sha256};
   const overlaps=obligations.filter(o=>o.clause.source.version_id===t.version_id&&o.clause.source.page===r.value!.page);
   const equivalent=(o:ExplicitObligation)=>{
    const old=parseIdentifiedClausePromise(o.clause.text)?.literal??parseObligationLiteralPromise(o.clause.text),a=o.promise.kind==='fixed'?o.promise.amount:o.promise.rate;
    return old!==null&&canonicalSha256(old)===canonicalSha256(parsed.literal)&&a?.printed_value===(parsed.literal.minor/100).toFixed(2)
     &&o.topic===selectedTopic&&canonicalSha256(o.clause.effective_period)===canonicalSha256(parsed.effective_period);
   };
   if(overlaps.length===1&&equivalent(overlaps[0]))continue;
   if(overlaps.length){
    add('missing_source','קיימות קריאות חופפות של סעיף כספי באותו עמוד שאינן מתיישבות למקור יחיד.','יש ליישב את נוסח הסעיף, הסכום ותקופת התוקף בין הקריאות; לא נזקף סכום נוסף.');
    for(const old of overlaps){const i=obligations.indexOf(old);obligations[i]={...old,assessments:[...old.assessments.filter(a=>a.decision_id!=='obligation.clause_interpretation'),
     {decision_id:'obligation.clause_interpretation',state:'conflict',basis:'ai_source_assessment',explanation:'קריאות מקור חופפות לא יושבו; אין אישור לפרשנות הסעיף.',sources:[old.clause.source,source],valid_until:null}]};}
    continue;
   }
   const amount:DocumentReviewOperand={id:'transcribed.amount.'+short,observation_id:'transcribed.'+short,state:'observed',printed_value:(parsed.literal.minor/100).toFixed(2),
    representation:'money_ils',quantity_unit:null,precision:'source_exact',source};
   obligations.push({obligation_id:'transcribed.'+short,topic:selectedTopic,title:parsed.literal.kind==='fixed'?'התחייבות לסכום חודשי מפורש':'התחייבות לתעריף מפורש',
    clause:{source,text:r.value.text,text_sha256:obligationTextSha256(r.value.text),effective_period:parsed.effective_period},payment_period:input.period,
    promise:parsed.literal.kind==='fixed'?{kind:'fixed',amount}:{kind:'linear',rate:amount,quantity:null,quantity_unit:parsed.literal.unit},
    conditions_mode:'all',conditions:[],assessments:[],scenario:'established_only',recorded:null});
   if(!manifest.some(m=>m.document_id===t.version_id&&m.version_id===t.version_id))manifest.push({document_id:t.version_id,version_id:t.version_id,file_sha256:t.source_sha256,page_count:t.page_count,kind:'case_document',case_id:t.case_id});
   timestamps.push(r.answered_at);continue;
  }
  const gap:DocumentReviewInput['coverage_gaps'][number]=r.state!=='identified_reading'
   ?{check_id,topic,kind:'missing_source',detail:r.state==='unreadable'?'סעיף המקור סומן כלא קריא; נוסח וסכום לא הושלמו.':'לא זוהה סעיף כספי בעמוד שנבדק; המקור והיסטוריית הקריאה נשמרו.',next_step:'יש לקרוא סעיף מתאים מהמקור הקיים, או להשאיר את הקריאה פתוחה. אין להניח סכום אפס.'}
   :literal
    ?{check_id,topic,kind:'missing_source',detail:'נוסח כספי נתמך נקרא במקור, אך אין עדיין קשר מזוהה בין הסעיף, הסכום או התעריף וגבולות תוקפו.',next_step:'יש לזהות את תקופת תוקף הסעיף ואת קשר הסכום במקור. חודש הבדיקה אינו תחליף לתקופת תוקף ההתחייבות.'}
    :{check_id,topic,kind:'missing_rule',detail:'נוסח הסעיף נשמר בקריאה מזוהה, אך אינו תואם לתבנית המילולית הנתמכת לחישוב התחייבות כספית.',next_step:'נדרשת סקירה של הנוסח המלא, התנאים וההפניות לפני קישורו לנוסחה. לא נבחר סכום מתוך הטקסט ולא אושרה זכאות.'};
  if(!gaps.some(g=>g.check_id===check_id))gaps.push({...gap,source_pins:[pin]});
 }
 const packet=obligations.length?enableObligationProductFacts(obligationsEntitlementInputSchema.parse({...prior,schema_version:'obligations-entitlement-input-v1',catalog_id:'il.review.explicit_obligations.2026',catalog_version:'1.0.0',
  case_id:input.case_id,run_id:prior?.run_id??'automatic.source.selection',check_prefix:prior?.check_prefix??'entitlement.literal',period:input.period,
  evaluated_at:new Date(timestamps.sort().at(-1)!).toISOString(),purchased_topics:input.purchased_scope.topics.filter(t=>t==='contract'||t==='bonuses'),source_manifest:manifest,obligations})):null;
 return documentReviewInputSchema.parse({...input,documents,coverage_gaps:gaps,...(packet?{entitlement_evidence:{schema_version:'entitlement-source-evidence-v1',case_id:input.case_id,order_id:input.purchased_scope.order_id,
  receipt_sha256:input.purchased_scope.receipt_sha256,period:input.period,...input.entitlement_evidence,obligations:packet}}:{})});
}
