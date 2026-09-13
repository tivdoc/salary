import {employmentSnapshotSchema,type EmploymentSnapshot} from '../../facts/snapshot.ts';
import {canonicalSha256} from '../../rule-runtime/canonical.ts';
import {hoursConflictDeclarationSchema,type HoursConflictDeclaration} from '../../extraction/hours-conflict.ts';
import type {June2026CaseAssessment} from './contracts.ts';

/** No trust is established here. This deterministic transform is reachable
 * only after the caller verifies current signed assessment authority. Its
 * inverse binding is also checked by persisted trace readers and SQL. */
export function deriveJune2026HoursConflictFacts(parent:EmploymentSnapshot,candidate:HoursConflictDeclaration){
 const facts=employmentSnapshotSchema.parse(parent),declaration=hoursConflictDeclarationSchema.parse(candidate),target=declaration.target;
 const hours=facts.facts.filter(fact=>fact.path==='work.regular_hours'),old=hours[0];
 if(facts.case_id!==target.case_id||hours.length!==1||!old||old.status==='confirmed'
  ||!['missing','conflicted','needs_confirmation','candidate'].includes(old.status)
  ||old.provenance.length===0||old.provenance.some(source=>source.source_type!=='documented'||source.source_reference.document_id!==target.version_id))
  throw Error('JUNE_REGULAR_HOURS_CONFLICT_PARENT');
 if(target.observations.length===0&&old.value!==null)throw Error('JUNE_REGULAR_HOURS_CONFLICT_PARENT');
 const located=old.provenance.filter(source=>source.source_type==='documented'&&source.source_reference.locator);
 for(const source of located){
  if(source.source_type!=='documented')throw Error('JUNE_REGULAR_HOURS_CONFLICT_PARENT');
  const locator=source.source_reference.locator!;
  if(!target.observations.some(row=>row.source.page===locator.page&&row.source.text_fragment===locator.text_span
   &&canonicalSha256(row.source.bounding_box??null)===canonicalSha256(locator.bounding_box??null)))
   throw Error('JUNE_REGULAR_HOURS_CONFLICT_OBSERVATION');
 }
 // Only effective hours changes; the original canonical stage and every
 // conflicting/unreadable observation stay immutable and independently hashed.
 return employmentSnapshotSchema.parse({...facts,facts:facts.facts.map(fact=>fact.fact_id===old.fact_id?{...fact,
  value:{amount:declaration.answer.hours,unit:'hours_per_month'},status:'confirmed',provenance:declaration.provenance,
  conflicting_fact_ids:[],resolution:null}:fact)});
}

export function assertJune2026HoursConflictAcceptance(candidate:HoursConflictDeclaration,assessment:June2026CaseAssessment){
 const declaration=hoursConflictDeclarationSchema.parse(candidate),target=declaration.target,acceptance=assessment.hours_acceptance;
 if(target.case_id!==assessment.case_id||target.order_id!==assessment.order_id||target.month!==assessment.month
  ||target.version_id!==assessment.document_version_id||target.source_sha256!==assessment.document_sha256
  ||Date.parse(declaration.answered_at)>Date.parse(assessment.issued_at)||!acceptance
  ||acceptance.request_id!==declaration.request_id||acceptance.answer_revision!==declaration.answer_revision
  ||acceptance.provenance_sha256!==canonicalSha256(declaration.provenance)||acceptance.value!==declaration.answer.hours)
  throw Error('JUNE_REGULAR_HOURS_CONFLICT_ASSESSMENT');
 return declaration;
}
