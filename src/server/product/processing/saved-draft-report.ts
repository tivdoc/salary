import {renderReviewBundle} from '../reports/document-review-projection';
import {renderAiReleaseBundle} from '../reports/ai-release-report';
import {DOCUMENT_REVIEW_RENDER_POLICY} from '../reports/document-review-render-policy';
import {createHash} from 'node:crypto';
import {canonicalSha256,canonicalStringify} from '@/engine/rule-runtime/canonical';
import type {AnalysisResultBundle,ReportBuilderPort,DeterministicReportArtifacts} from '@/engine/wave3/contracts';
import {buildCanonicalReport} from '@/server/reports/deterministic-report-builder';
import {renderDeterministicRtlDocument,hebrewTopicLabel,type RtlBlock} from '@/server/reports/deterministic-hebrew-pdf';

export const SAVED_DRAFT_TEMPLATE='saved-source-analysis-draft-v1';
export function savedAnalysisId(namespace:string,hash:string){
 const h=canonicalSha256({namespace,hash});
 return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
}
const hashBytes=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Existing canonical analysis schema and Hebrew PDF renderer, with an explicit
 * saved-source draft label. Synthetic report templates cannot label real input.
 * This artifact grants no publication, legal activation or delivery authority. */
export class SavedAnalysisDraftBuilder implements ReportBuilderPort {
 async build(bundle:AnalysisResultBundle):Promise<DeterministicReportArtifacts>{
  const reportId=savedAnalysisId('saved-report',bundle.result_sha256);
  if(bundle.ai_release)return renderAiReleaseBundle(bundle,reportId);
  if(bundle.document_review)return renderReviewBundle(bundle,reportId,{gapPresentation:DOCUMENT_REVIEW_RENDER_POLICY});
  const report=buildCanonicalReport(bundle,reportId);
  const json=Buffer.from(canonicalStringify({schema_version:SAVED_DRAFT_TEMPLATE,publication:'draft',canonical_report:report}));
  const title='טיוטת ניתוח מסמכים — טרם אושרה לפרסום';
  const rows=bundle.topic_results.map(t=>({name:hebrewTopicLabel(t.topic),status:t.status,blockers:t.blockers.join(', ')}));
  const html=Buffer.from(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>הטיוטה מבוססת על קלט שמור. היא אינה אישור אנושי ואינה דוח שפורסם.</p><ul>${rows.map(r=>`<li>${escape(r.name)}: <bdi>${escape(r.status)}</bdi><p>${escape(r.blockers)}</p></li>`).join('')}</ul></body></html>`);
  const blocks:RtlBlock[]=[{kind:'heading',level:1,text:title},{kind:'paragraph',text:'הטיוטה מבוססת על קלט שמור. היא אינה אישור אנושי ואינה דוח שפורסם.'},
   {kind:'hash',label:'מזהה תוצאת הניתוח',value:bundle.result_sha256},
   ...rows.flatMap(r=>[{kind:'heading' as const,level:2 as const,text:r.name},{kind:'paragraph' as const,text:r.status},...(r.blockers?[{kind:'paragraph' as const,text:r.blockers}]:[])])];
  const pdf=renderDeterministicRtlDocument({title,subject:`Saved analysis ${bundle.analysis_run_id}`,fixed_date:bundle.as_of.slice(0,10).replaceAll('-',''),blocks});
  const jsonSha=hashBytes(json),htmlSha=hashBytes(html),pdfSha=hashBytes(pdf);
  const manifest=Buffer.from(canonicalStringify({schema_version:SAVED_DRAFT_TEMPLATE,report_id:reportId,analysis_result_sha256:bundle.result_sha256,
   source_document_snapshot_sha256:bundle.document_snapshot_sha256,source_extraction_snapshot_sha256:bundle.extraction_snapshot_sha256,
   publication:'draft',components:[{path:'report.json',sha256:jsonSha},{path:'report.html',sha256:htmlSha},{path:'report.pdf',sha256:pdfSha}]}));
  const binding={report_id:reportId,report_revision:bundle.case_revision,analysis_result_sha256:bundle.result_sha256,
   json_sha256:jsonSha,html_sha256:htmlSha,pdf_sha256:pdfSha,manifest_sha256:hashBytes(manifest)};
  return {...binding,json,html,pdf,manifest,report_sha256:canonicalSha256(binding)};
 }
}
