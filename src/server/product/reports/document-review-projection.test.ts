import {expect,it} from 'vitest';
import type {AnalysisResultBundle} from '@/engine/wave3/contracts';
import {runDocumentReview} from '@/engine/document-review/service';
import {calculateDocumentReview} from '@/engine/document-review/calculations';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {renderReviewBundle} from './document-review-projection';

function bundle():AnalysisResultBundle{
 const caseId='11111111-1111-4111-8111-111111111111',sha='a'.repeat(64),period={from:'2026-06-01',to:'2026-06-30'};
 const documents=['doc-a','doc-b'].map((document_id,i)=>({case_id:caseId,document_id,version_id:`v${i}`,file_sha256:sha,page_count:1,kind:'payslip',label:'מסמך סינתטי באותו שם',period,reading_origin:'ai_document_review',reading_sha256:sha}));
 const source={document_id:'doc-a',version_id:'v0',file_sha256:sha,page:1,locator:'synthetic table',label:'נתון סינתטי',reading:'ai_document_review',reading_receipt_sha256:sha};
 const review=runDocumentReview({schema_version:'document-review-product-v1',case_id:caseId,period,
  purchased_scope:{order_id:'synthetic-order',receipt_sha256:sha,topics:['pension'],origin:'saved_order'},documents,
  checks:[{check_id:'synthetic-check',topic:'pension',title:'בדיקת3רכיבים',explanation:'בדיקת חיסור סינתטית.',calculation:{schema_version:'document-review-calculation-input-v1',case_id:caseId,run_id:'pending',check_id:'synthetic-check',period,evaluated_at:'2026-09-11T12:00:00Z',
   source_manifest:[{document_id:'doc-a',version_id:'v0',file_sha256:sha,page_count:1,kind:'case_document',case_id:caseId}],
   operands:[['gross','100.00'],['deduction','10.00'],['net','90.00']].map(([id,printed_value])=>({id,observation_id:id,state:'observed',printed_value,representation:'money_ils',quantity_unit:null,precision:'printed_precision',source})),
   operation:{kind:'reconciliation',add_refs:['gross'],subtract_refs:['deduction'],recorded_ref:'net',inventory_complete:true,inventory_basis:'synthetic entire table',disjoint_components:true,overlap_basis:'different cells'},remittance_status:'not_assessed'}}],
  coverage_gaps:[{check_id:'internal.owner',topic:'pension',kind:'ownership',detail:'private ownership matching marker',next_step:'private account matching task'}],
  completion_input:{case_id:caseId,period,documents:documents.map(d=>({pin:{case_id:caseId,document_id:d.document_id,version_id:d.version_id,source_sha256:sha},kind:'payslip',period,review:'complete'})),needs:[],evidence:[]}},'synthetic-run');
 return {schema_version:'tivdoc-analysis-result-bundle-v0.6.0',analysis_run_id:'synthetic-run',case_id:caseId,case_revision:1,period:{start_date:period.from,end_date:period.to},as_of:'2026-09-11',
  document_snapshot_sha256:sha,extraction_snapshot_sha256:sha,declared_fact_snapshot_sha256:sha,facts_snapshot_sha256:sha,facts:[],rule_inputs:[],catalog_sha256:sha,topic_results:[],known_subtotal:null,coverage_complete:false,document_review:review,result_sha256:canonicalSha256(review)};
}

it('binds identically named documents by identity, summarizes topics and retains ownership only in the private appendix',()=>{
 const report=renderReviewBundle(bundle(),'synthetic-report'),body=JSON.parse(Buffer.from(report.json).toString('utf8'));
 expect(body.documents_checked.map((d:{source_ids:string[]})=>d.source_ids)).toEqual([['doc-a:v0:1'],['doc-b:v1:1']]);
 expect(body.what_checked).toEqual(['רישומי פנסיה: 1 בדיקה']);
 expect(body.findings[0].title).toBe('בדיקת 3 רכיבים');
 expect(Buffer.from(report.html).toString('utf8')).not.toContain('private ownership matching marker');
 expect(Buffer.from(report.private_evidence_appendix).toString('utf8')).toContain('private ownership matching marker');
});

it('labels an identified recorded answer as an answer rather than a printed document amount',()=>{
 const original=bundle(),review=original.document_review!,check=review.checks[0],source=check.calculation.input.operands[2].source,answerSha='b'.repeat(64);
 // Projection-only synthetic fixture: arithmetic uses an explicit answer
 // manifest. This test does not claim authenticated production admission.
 const calculation=calculateDocumentReview({...check.calculation.input,
  source_manifest:[...check.calculation.input.source_manifest,{document_id:'answer',version_id:'answer:1',file_sha256:answerSha,page_count:1,kind:'customer_answer',case_id:original.case_id}],
  operands:check.calculation.input.operands.map(o=>o.id!=='net'?o:{...o,state:'declared',source:{...source,document_id:'answer',version_id:'answer:1',file_sha256:answerSha,reading:'customer_declaration',reading_receipt_sha256:answerSha}})});
 const report=renderReviewBundle({...original,document_review:{...review,checks:[{...check,calculation}]}},'synthetic-answer-report');
 const body=JSON.parse(Buffer.from(report.json).toString('utf8'));
 expect(body.findings[0].amounts.map((a:{label:string})=>a.label)).toContain('סכום שנמסר בתשובה מזוהה');
 expect(body.findings[0].amounts.map((a:{label:string})=>a.label)).not.toContain('סכום במסמך');
 expect(body.findings[0].summary).toContain('תשובה מזוהה שנמסרה');
});
