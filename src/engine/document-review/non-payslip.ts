import {canonicalSha256} from '../rule-runtime/canonical.ts';
import type {StoredCaseInputSnapshot} from '../case-analysis/contracts.ts';
import {savedNonPayslipEvidenceSchema,type SavedNonPayslipEvidence} from '../extraction/document-evidence/snapshot.ts';
import {documentReviewInputSchema,type DocumentReviewInput} from './contracts.ts';
import {parseReviewCompletionInput} from './completions.ts';

export const nonPayslipEffectiveReadingSha=(e:SavedNonPayslipEvidence)=>canonicalSha256({schema_version:'document-evidence-effective-reading-v1',extraction:e.extraction,readings:e.readings});

/** Keep the original machine observations alongside identified cell decisions.
 * A prior private reading packet is not relabeled as a live extraction. */
export function attachNonPayslipInventory(candidate:DocumentReviewInput,snapshot:StoredCaseInputSnapshot):DocumentReviewInput{
 if(!snapshot.non_payslip_evidence?.length)return candidate;
 const base=documentReviewInputSchema.parse(candidate),documents=[...base.documents],completion=parseReviewCompletionInput(base.completion_input),records=[];
 const completionDocuments=[...completion.documents];
 for(const raw of snapshot.non_payslip_evidence){
  const e=savedNonPayslipEvidenceSchema.parse(raw),d=e.document;
  if(d.case_id!==base.case_id)throw Error('NON_PAYSLIP_FOREIGN_CASE');
  const prior=documents.find(old=>old.version_id===d.document_id);
  // Historical source reviews keep their exact interpretation/identity. A
  // future explicitly automatic run may choose a fresh source input instead.
  if(prior&&prior.reading_origin!=='source_inventory'&&prior.reading_origin!=='provider_extraction'&&prior.reading_sha256!==nonPayslipEffectiveReadingSha(e))continue;
  const dates=(semantic:string)=>e.readings.filter(r=>r.state==='identified_reading'&&r.target.observation.original.semantic===semantic&&r.value?.kind==='iso_date').map(r=>r.value!.kind==='iso_date'?r.value!.value:'');
  const starts=dates('period_start'),ends=dates('period_end');
  const sourcePeriod=starts.length===1&&ends.length===1&&starts[0]<=ends[0]?{from:starts[0],to:ends[0]}:null;
  const reading=e.extraction?nonPayslipEffectiveReadingSha(e):canonicalSha256({document:d,pending:e.failure_code});
  const doc={case_id:d.case_id,document_id:d.document_id,version_id:d.document_id,file_sha256:d.content_sha256,page_count:e.extraction?.physical_page_count??null,
   kind:d.document_type as 'attendance'|'contract',label:d.document_type==='attendance'?'דוח נוכחות שהועלה':'מסמך תנאי העסקה שהועלה',period:sourcePeriod,
   reading_origin:e.extraction?'provider_extraction' as const:'source_inventory' as const,reading_sha256:reading};
  if(prior){documents.splice(documents.indexOf(prior),1);const at=completionDocuments.findIndex(x=>x.pin.version_id===d.document_id);if(at>=0)completionDocuments.splice(at,1);}
  documents.push(doc);records.push(e);
  completionDocuments.push({pin:{case_id:d.case_id,document_id:d.document_id,version_id:d.document_id,source_sha256:d.content_sha256},kind:doc.kind,
   review:e.extraction?'partial':'not_reviewed',period:sourcePeriod});
 }
 if(!records.length)return base;
 return documentReviewInputSchema.parse({...base,documents,non_payslip_evidence:records,completion_input:{...completion,documents:completionDocuments}});
}
