import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {DocumentReviewInput} from '../document-review/contracts.ts';
import type {NonPayslipReadingDependency} from './automatic-nonpay.ts';
import {vacationEntitlementInputSchema} from './vacation/contracts.ts';
import {vacationSourceReadingDependencies} from './vacation/product-source-evidence.ts';
import {workingTimeEntitlementInputSchema} from './working-time/contracts.ts';
import {attachWorkingTimeSourceFacts} from './working-time/source-facts.ts';
import {savedNonPayslipEvidenceSchema} from '../extraction/document-evidence/snapshot.ts';

/** Re-evaluate only real source dependencies after current identified answers.
 * A personal answer can reveal a source cell; it cannot authenticate that cell.
 * Multiple checks share one exact checkpoint request without merging versions. */
export function entitlementSourceReadingDependencies(input:DocumentReviewInput,initial:readonly NonPayslipReadingDependency[]=[]):NonPayslipReadingDependency[]{
 const evidence=input.entitlement_composition?.evidence??input.entitlement_evidence;
 const dependencies=[...initial];
 if(evidence?.vacation)dependencies.push(...vacationSourceReadingDependencies(vacationEntitlementInputSchema.parse(evidence.vacation),input));
 if(Array.isArray(evidence?.working_time))for(const week of evidence.working_time)
  dependencies.push(...attachWorkingTimeSourceFacts(workingTimeEntitlementInputSchema.parse(week),input).reading_dependencies);
 const groups=new Map<string,NonPayslipReadingDependency>();
 for(const d of dependencies){
  const matches=(input.non_payslip_evidence??[]).map(r=>savedNonPayslipEvidenceSchema.parse(r)).filter(r=>r.document.document_id===d.version_id&&r.product_document_id===d.product_document_id);
  const stored=matches[0];
  if(matches.length!==1||stored.document.case_id!==input.case_id||!input.documents.some(doc=>doc.case_id===input.case_id&&doc.version_id===d.version_id&&doc.file_sha256===stored.document.content_sha256)||stored.checkpoint_result_sha256!==d.checkpoint_sha256||!stored.extraction||canonicalSha256(stored.extraction)!==d.normalized_sha256||!d.observation_ids.every(id=>stored.extraction!.observations.some(o=>o.observation_id===id)))throw Error('ENTITLEMENT_SOURCE_DEPENDENCY_BINDING');
  const prior=groups.get(d.version_id);
  if(prior&&canonicalSha256([prior.product_document_id,prior.checkpoint_sha256,prior.normalized_sha256])!==canonicalSha256([d.product_document_id,d.checkpoint_sha256,d.normalized_sha256]))throw Error('ENTITLEMENT_SOURCE_DEPENDENCY_VERSION_CONFLICT');
  groups.set(d.version_id,{...d,observation_ids:[...new Set([...(prior?.observation_ids??[]),...d.observation_ids])],dependent_check_ids:[...new Set([...(prior?.dependent_check_ids??[]),...d.dependent_check_ids])]});
 }
 return [...groups.values()];
}
