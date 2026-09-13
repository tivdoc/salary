import {z} from 'zod';
import type {ImmutableDocument} from '@/engine/domain/documents';
import {DOCUMENT_EVIDENCE_POLICY} from '@/engine/extraction/document-evidence/contracts';
import {documentEvidenceReadingTargetSchema} from '@/engine/extraction/document-evidence/reading';
import type {SavedNonPayslipEvidence} from '@/engine/extraction/document-evidence/snapshot';
import {resolveDocumentEvidenceAnswer} from '../reports/document-evidence-reading';

const answerSchema=z.object({id:z.uuid(),case_id:z.uuid(),scope_month:z.string(),code:z.string(),answer_kind:z.literal('choice'),answer:z.string(),
 answer_revision:z.number().int().positive(),answer_identity_id:z.uuid(),answer_created_at:z.iso.datetime({offset:true}),field_target:documentEvidenceReadingTargetSchema});

/** Input is the authenticated immutable journal, never a request-body actor.
 * A reading in a different purchased month is not silently borrowed. */
export function savedNonPayslipReadings(input:{caseId:string;month:string;journal:unknown;checkpoint:unknown;document:ImmutableDocument;productDocumentId:string}):SavedNonPayslipEvidence['readings']{
 const {answers=[]}=z.object({answers:z.array(z.record(z.string(),z.unknown())).optional()}).parse(input.journal);
 const readings:SavedNonPayslipEvidence['readings']=[],seen=new Set<string>();
 for(const raw of answers){
  if(typeof raw.code!=='string'||!raw.code.startsWith('document_field:')||!raw.field_target||typeof raw.field_target!=='object'
    ||!('schema_version' in raw.field_target)||raw.field_target.schema_version!=='document-evidence-reading-v1')continue;
  const a=answerSchema.parse(raw),t=a.field_target;
  if(a.case_id!==input.caseId||t.case_id!==input.caseId)throw Error('REQUEST_FIELD_CASE_MISMATCH');
  if(a.code!==`document_field:${t.target_sha256}`||t.policy_version!==DOCUMENT_EVIDENCE_POLICY)throw Error('REQUEST_FIELD_TARGET_INVALID');
  if(seen.has(a.id))throw Error('SAVED_REQUEST_ID_AMBIGUOUS');seen.add(a.id);
  if(t.version_id!==input.document.document_id||a.scope_month!==input.month)continue;
  if(t.month!==a.scope_month)throw Error('REQUEST_FIELD_MONTH_MISMATCH');
  const result=resolveDocumentEvidenceAnswer({checkpoint:input.checkpoint,document:input.document,productDocumentId:input.productDocumentId,month:input.month,
   target:t,answer:a.answer,caseId:input.caseId,requestId:a.id,answerRevision:a.answer_revision,identityId:a.answer_identity_id,answeredAt:a.answer_created_at});
  if(result.state==='current')readings.push(result.reading);
 }
 if(new Set(readings.map(r=>r.target.observation.observation_id)).size!==readings.length)throw Error('REQUEST_FIELD_READING_AMBIGUOUS');
 return readings.sort((a,b)=>a.target.observation.observation_id.localeCompare(b.target.observation.observation_id));
}
