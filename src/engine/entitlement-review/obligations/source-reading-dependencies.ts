import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../../document-review/contracts.ts';
import {savedNonPayslipEvidenceSchema} from '../../extraction/document-evidence/snapshot.ts';
import type {NonPayslipReadingDependency} from '../automatic-nonpay.ts';
import {obligationsEntitlementInputSchema,type ObligationsEntitlementInput} from './contracts.ts';
import {obligationCheckIds} from './index.ts';
import {produceObligationSourceEvidence} from './product-source-evidence.ts';
import {OBLIGATIONS_CASE_POLICY} from './source-policy.ts';

/** Only original context observations which can unlock an existing selected
 * clause. Unknown/unreadable/currently answered cells are history, not new work.
 * This never creates a missing candidate or asks for a legal interpretation. */
export function obligationSourceReadingDependencies(candidate:ObligationsEntitlementInput,review:DocumentReviewInput):NonPayslipReadingDependency[]{
 const input=obligationsEntitlementInputSchema.parse(candidate);if(input.case_policy!==OBLIGATIONS_CASE_POLICY)return [];
 const selected=input.obligations.filter(o=>input.purchased_topics.includes(o.topic)&&review.purchased_scope.topics.includes(o.topic));
 const pending=selected.flatMap(o=>produceObligationSourceEvidence(input,o.obligation_id,review).reading_dependencies.map(d=>({...d,check_ids:obligationCheckIds(input.check_prefix,o.obligation_id)})));
 return (review.non_payslip_evidence??[]).flatMap(raw=>{
  const record=savedNonPayslipEvidenceSchema.parse(raw),items=pending.filter(p=>p.version_id===record.document.document_id);
  const observation_ids=[...new Set(items.map(p=>p.observation_id))].sort();if(!observation_ids.length)return [];
  if(record.document.case_id!==review.case_id||!record.extraction||!record.checkpoint_result_sha256
   ||!observation_ids.every(id=>record.extraction!.observations.some(o=>o.observation_id===id)&&!record.readings.some(r=>r.target.month===input.period.from.slice(0,7)&&r.target.observation.observation_id===id)))throw Error('OBLIGATION_READING_DEPENDENCY_SOURCE');
  return [{version_id:record.document.document_id,product_document_id:record.product_document_id,checkpoint_sha256:record.checkpoint_result_sha256,
   normalized_sha256:canonicalSha256(record.extraction),observation_ids,dependent_check_ids:[...new Set(items.flatMap(p=>p.check_ids))].sort()}];
 });
}
