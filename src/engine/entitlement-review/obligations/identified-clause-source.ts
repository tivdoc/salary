import {createHash} from 'node:crypto';
import {z} from 'zod';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import type {DocumentReviewSource} from '../../document-review/calculations.ts';
import {parseDocumentEvidenceSourceReading} from '../../extraction/document-evidence/source-transcription.ts';
import {parseObligationLiteralPromise} from './literal-promise.ts';

// This module is used while review schemas initialize. Keep review and
// obligation contracts type-only; attachment/product-fact modules depend on them.
export const IDENTIFIED_CLAUSE_PROMISE_POLICY='identified-clause-literal-period-v1' as const;
/** Full clause only: the established literal promise followed by an explicit
 * closed date range. Unsupported prose, conditions and references are retained
 * as a gap; neither dates nor amounts are searched out of arbitrary wording. */
export function parseIdentifiedClausePromise(text:string){
 const match=/^(.*?)\s*,?\s+מיום ([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[./][0-9]{1,2}[./][0-9]{4}) ועד יום ([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}[./][0-9]{1,2}[./][0-9]{4})[.]?$/u.exec(text.trim());
 if(!match)return null;
 const literal=parseObligationLiteralPromise(match[1]);if(!literal)return null;
 const date=(value:string)=>{const parts=/^(\d{1,2})([./])(\d{1,2})\2(\d{4})$/u.exec(value);
  const result=z.iso.date().safeParse(parts?`${parts[4]}-${parts[3].padStart(2,'0')}-${parts[1].padStart(2,'0')}`:value);return result.success?result.data:null;};
 const from=date(match[2]),to=date(match[3]);if(!from||!to||from>to)return null;
 return {policy_version:IDENTIFIED_CLAUSE_PROMISE_POLICY,literal,effective_period:{from,to}};
}

/** Additional receipt acceptance is exact to the current authenticated reading,
 * never an arbitrary document accepted-hash allowlist. */
export function identifiedClauseTranscriptionSourceCurrent(input:DocumentReviewInput,source:DocumentReviewSource,textSha256?:string){
 return (input.document_source_transcriptions??[]).some(raw=>{
  const r=parseDocumentEvidenceSourceReading(raw),t=r.target;
  return r.state==='identified_reading'&&r.value!==null&&source.reading==='identified_document_reading'
   &&source.reading_receipt_sha256===r.verification_sha256&&source.page===r.value.page
   &&(textSha256===undefined||createHash('sha256').update(r.value.text,'utf8').digest('hex')===textSha256)
   &&source.document_id===t.version_id&&source.version_id===t.version_id&&source.file_sha256===t.source_sha256
   &&t.case_id===input.case_id&&t.order_id===input.purchased_scope.order_id&&t.order_origin===input.purchased_scope.origin
   &&t.order_receipt_sha256===input.purchased_scope.receipt_sha256&&canonicalSha256(t.purchased_topics)===canonicalSha256(input.purchased_scope.topics)
   &&canonicalSha256(t.period)===canonicalSha256(input.period)
   &&input.documents.some(d=>d.case_id===t.case_id&&d.document_id===source.document_id&&d.version_id===t.version_id&&d.kind==='contract'
    &&d.file_sha256===t.source_sha256&&d.page_count===t.page_count&&source.page<=d.page_count);
 });
}

