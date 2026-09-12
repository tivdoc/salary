import {expect,it} from 'vitest';
import {createCaseAnalysisAiRelease} from '@/engine/case-analysis/contracts';
import {runtimeFixture,nineTopicRuntimeSource} from '@/engine/ai-release-runtime/runtime.fixture';
import {fixture as pensionSource} from '@/engine/entitlement-review/compose.fixture';
import {pensionEntitlementInputSchema} from '@/engine/entitlement-review/pension/contracts';
import {obligationsEntitlementInputSchema} from '@/engine/entitlement-review/obligations/contracts';
import type {DocumentReviewInput} from '@/engine/document-review/contracts';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import type {AnalysisResultBundle} from '@/engine/wave3/contracts';
import type {DocumentReviewPresentationInput} from './document-review-artifacts';
import {qualifiedAiPresentation,renderAiReleaseBundle,AI_RELEASE_REPORT_TEMPLATE} from './ai-release-report';
import {renderReviewBundle} from './document-review-projection';
import {DOCUMENT_REVIEW_RENDER_POLICY} from './document-review-render-policy';
import {SavedAnalysisDraftBuilder,savedAnalysisId} from '../processing/saved-draft-report';
function setup(kind:'expected'|'missing'|'conditional'='expected',source:DocumentReviewInput=pensionSource().input){
 if(kind!=='expected'){
  const pension=pensionEntitlementInputSchema.parse(source.entitlement_evidence!.pension);
  if(kind==='missing'){pension.pensionable_wage!.state='unknown';pension.pensionable_wage!.printed_value=null;}
  else {pension.applicability.find(d=>d.decision_id==='pension.pensionable_wage')!.state='unknown';
   pension.conditional_assumptions=[{decision_id:'pension.pensionable_wage',explanation:'אם השכר הרשום הוא הבסיס החל לחישוב'}];}
  source.entitlement_evidence!.pension=pension;
 }
 const runtime=runtimeFixture(source),journal=runtime.assessment_input.current.scope;
 const engineRevision=7,envelope=createCaseAnalysisAiRelease(runtime,{engine_case_revision:engineRevision,
  source_journal:{case_id:journal.case_id,input_revision:journal.input_revision,input_sha256:journal.input_sha256}}),r=envelope.result,scope=r.current_scope,h='a'.repeat(64);
 const bundle:AnalysisResultBundle={schema_version:'tivdoc-analysis-result-bundle-v0.6.0',analysis_run_id:r.analysis_run_id,case_id:r.case_id,case_revision:engineRevision,
  period:{start_date:scope.period.from,end_date:scope.period.to},as_of:'2026-09-12',document_snapshot_sha256:h,extraction_snapshot_sha256:h,
  declared_fact_snapshot_sha256:h,facts_snapshot_sha256:scope.facts_sha256,facts:[],rule_inputs:[],catalog_sha256:h,topic_results:[],known_subtotal:null,
  coverage_complete:false,document_review:r.review,ai_release:envelope,result_sha256:canonicalSha256(envelope)};
 const input:DocumentReviewPresentationInput={schema_version:'document-review-presentation-v1',report_id:'synthetic-report',report_revision:engineRevision,
  analysis_run_id:r.analysis_run_id,analysis_result_sha256:bundle.result_sha256,generated_at:'2026-09-12T00:00:00Z',case_public_id:'בדיקה סינתטית',period:scope.period,
  coverage:'partial',what_checked:['פנסיה'],documents_checked:[{label:'מסמך סינתטי',source_ids:['source']}],sources:[{id:'source',title:'מסמך סינתטי',page:1}],missing_inputs:[],
  findings:r.review.checks.map(c=>({id:c.check_id,title:c.title,summary:'פרטי חישוב סינתטי',source_ids:['source'],
   ...(kind==='conditional'?{status:'conditional' as const,conditions:['הבסיס חל על הרכיב'],amounts:[{label:'סכום תרחיש',currency:'ILS' as const,minor_units:30000}]}
    :{status:'unknown' as const,amounts:[] as const})}))};
 return {envelope,bundle,input};
}
it('projects expected contributions without zero remittance, totals or assessment leakage',()=>{
 const f=setup(),p=qualifiedAiPresentation(f.input,f.envelope);
 expect(p.findings.filter(x=>x.amounts.length).map(x=>x.amounts.map(a=>a.minor_units))).toEqual([[30000],[32500],[30000]]);
 expect(p.findings.filter(x=>x.amounts.length).every(x=>x.status==='supported'&&x.summary.includes('היעדר רישום אינו תשלום אפס'))).toBe(true);
 expect(p.findings[0].summary).toContain('2026-06-01');expect(p.findings[0].summary).toContain('גרסה');
 const text=JSON.stringify(p);for(const secret of ['assessment_input','confidence','source_manifest','private/','admission_dependency_sha256'])expect(text).not.toContain(secret);
 expect(p).not.toHaveProperty('combined_amount');expect(p).not.toHaveProperty('legal_debt_total');
});
it('retains missing data without publishing a numerical result under an admitted family',()=>{
 const f=setup('missing'),p=qualifiedAiPresentation(f.input,f.envelope);
 expect(f.envelope.result.admission.state).toBe('admitted');expect(p.findings.every(x=>x.status==='unknown'&&x.amounts.length===0)).toBe(true);
});
it.each([['450.00',5000],['500.00',0],['550.00',-5000]] as const)('shows signed comparison against %s without summing overlapping expected checks', (paid,difference)=>{
 const source=nineTopicRuntimeSource(),obligations=obligationsEntitlementInputSchema.parse(source.entitlement_evidence!.obligations);
 obligations.obligations[0].recorded!.amount.printed_value=paid;source.entitlement_evidence!.obligations=obligations;
 const f=setup('expected',source),p=qualifiedAiPresentation(f.input,f.envelope);
 const comparison=f.envelope.result.checks.find(c=>c.topic==='bonuses'&&c.difference!==null)!;
 const displayed=p.findings.find(c=>c.id===comparison.check_id)!;
 expect(displayed.amounts.map(a=>a.minor_units)).toEqual([50000,Number(paid)*100,difference]);
 expect(displayed.summary).toContain('אין לחבר תוצאה זו עם בדיקות חופפות');
 expect(p).not.toHaveProperty('combined_amount');
});
it('keeps a calculated conditional scenario distinct from an admitted result',()=>{
 const f=setup('conditional'),p=qualifiedAiPresentation(f.input,f.envelope);
 expect(f.envelope.result.findings).toEqual([]);expect(p.findings.every(x=>x.status==='conditional'&&x.summary.includes('תרחיש מותנה בלבד'))).toBe(true);
 expect(p.findings.every(x=>x.status==='conditional'&&x.conditions.includes('אין להציג את סכום התרחיש כחוב או כסכום שאושר לתשלום.'))).toBe(true);
});
it('rejects wrong analysis scope and tampered envelope before rendering',()=>{
 const f=setup();expect(()=>renderAiReleaseBundle({...f.bundle,analysis_run_id:'foreign'},'report')).toThrow('AI_RELEASE_BUNDLE_SCOPE_MISMATCH');
 expect(()=>renderAiReleaseBundle({...f.bundle,ai_release:{...f.envelope,sha256:'f'.repeat(64)}},'report')).toThrow('AI_RELEASE_ENVELOPE_HASH_MISMATCH');
});
it('uses the ordinary HTML/PDF builder and binds its private qualified receipt to the same run',async()=>{
 const f=setup(),result=await new SavedAnalysisDraftBuilder().build(f.bundle),html=Buffer.from(result.html).toString('utf8'),json=JSON.parse(Buffer.from(result.json).toString('utf8'));
 expect(html).toContain('300.00');expect(html).toContain('325.00');expect(html).toContain('בדיקת AI');expect(Buffer.from(result.pdf).subarray(0,5).toString()).toBe('%PDF-');
 expect(JSON.stringify(json)).not.toContain('assessment_input');expect(JSON.stringify(json)).not.toContain('registry_sha256');
 const direct=renderAiReleaseBundle(f.bundle,savedAnalysisId('saved-report',f.bundle.result_sha256));
 expect(result.report_sha256).toBe(direct.report_sha256);expect(Buffer.from(direct.private_evidence_appendix).toString()).toContain(AI_RELEASE_REPORT_TEMPLATE);
 expect(Buffer.from(result.manifest).toString()).toContain(f.bundle.analysis_run_id);
});
it('keeps absent-envelope ordinary report bytes identical',async()=>{
 const f=setup(),{ai_release:ignored,...legacy}=f.bundle;void ignored;
 const expected=renderReviewBundle(legacy,savedAnalysisId('saved-report',legacy.result_sha256),{gapPresentation:DOCUMENT_REVIEW_RENDER_POLICY});
 const actual=await new SavedAnalysisDraftBuilder().build(legacy);
 for(const key of ['html','pdf','json','manifest'] as const)expect(Buffer.from(actual[key]).equals(Buffer.from(expected[key]))).toBe(true);
});
