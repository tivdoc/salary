import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from '../../document-review/contracts.ts';
import type {StoredCaseInputSnapshot} from '../../case-analysis/contracts.ts';
import {parseDocumentEvidenceSourceReading} from '../../extraction/document-evidence/source-transcription.ts';
import {parseObligationLiteralPromise} from './literal-promise.ts';

/** Typed text evidence is consumed independently from machine extraction.
 * Reading a clause cannot supply its absent effective dates, source amount
 * association, agreement acceptance, or payment relationship. */
export function attachIdentifiedClauseTranscriptions(candidate:DocumentReviewInput,snapshot:StoredCaseInputSnapshot):DocumentReviewInput{
 if(!candidate.document_source_transcriptions?.length)return candidate;
 const input=documentReviewInputSchema.parse(candidate),gaps=[...input.coverage_gaps];
 const seen=new Set<string>();
 for(const raw of input.document_source_transcriptions!){
  const r=parseDocumentEvidenceSourceReading(raw),t=r.target;
  const saved=snapshot.document_source_transcriptions?.filter(s=>s.request_id===r.request_id);
  if(saved?.length!==1||canonicalSha256(saved[0])!==canonicalSha256(r)||seen.has(r.request_id))throw Error('CLAUSE_TRANSCRIPTION_SNAPSHOT_BINDING');seen.add(r.request_id);
  if(t.case_id!==input.case_id||t.order_id!==input.purchased_scope.order_id||t.order_origin!==input.purchased_scope.origin
   ||t.order_receipt_sha256!==input.purchased_scope.receipt_sha256||canonicalSha256(t.purchased_topics)!==canonicalSha256(input.purchased_scope.topics)
   ||canonicalSha256(t.period)!==canonicalSha256(input.period)||!input.documents.some(d=>d.version_id===t.version_id&&d.file_sha256===t.source_sha256))throw Error('CLAUSE_TRANSCRIPTION_SOURCE_BINDING');
  const check_id='entitlement.transcribed.clause.'+canonicalSha256({request:r.request_id,target:t.target_sha256}).slice(0,24);
  const literal=r.value?parseObligationLiteralPromise(r.value.text):null;
  const topic=literal?.bonus&&input.purchased_scope.topics.includes('bonuses')?'bonuses':input.purchased_scope.topics.includes('contract')?'contract':'bonuses';
  const gap:DocumentReviewInput['coverage_gaps'][number]=r.state!=='identified_reading'
   ?{check_id,topic,kind:'missing_source',detail:r.state==='unreadable'?'סעיף המקור סומן כלא קריא; נוסח וסכום לא הושלמו.':'לא זוהה סעיף כספי בעמוד שנבדק; המקור והיסטוריית הקריאה נשמרו.',next_step:'יש לקרוא סעיף מתאים מהמקור הקיים, או להשאיר את הקריאה פתוחה. אין להניח סכום אפס.'}
   :literal
    ?{check_id,topic,kind:'missing_source',detail:'נוסח כספי נתמך נקרא במקור, אך אין עדיין קשר מזוהה בין הסעיף, הסכום או התעריף וגבולות תוקפו.',next_step:'יש לזהות את תקופת תוקף הסעיף ואת קשר הסכום במקור. חודש הבדיקה אינו תחליף לתקופת תוקף ההתחייבות.'}
    :{check_id,topic,kind:'missing_rule',detail:'נוסח הסעיף נשמר בקריאה מזוהה, אך אינו תואם לתבנית המילולית הנתמכת לחישוב התחייבות כספית.',next_step:'נדרשת סקירה של הנוסח המלא, התנאים וההפניות לפני קישורו לנוסחה. לא נבחר סכום מתוך הטקסט ולא אושרה זכאות.'};
  if(!gaps.some(g=>g.check_id===check_id))gaps.push(gap);
 }
 return documentReviewInputSchema.parse({...input,coverage_gaps:gaps});
}
