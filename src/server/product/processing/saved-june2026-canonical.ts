import 'server-only';
import {createHash} from 'node:crypto';
import {canonicalSha256,canonicalStringify} from '@/engine/rule-runtime/canonical';
import {createSourceCalculationTrace} from '@/engine/calculations/source-trace';
import {createSourceMonetaryComparison,type SourceMonetaryComparison} from '@/engine/findings/source-comparison';
import {createJune2026MinimumWageCandidate} from '@/engine/minimum-wage-june2026/candidate';
import {resolveJune2026Evidence,type June2026EvidenceAdmission} from '@/engine/minimum-wage-june2026/evidence-admission';
import type {AnalysisResultBundle,ReportBuilderPort,RuleSpecExecutorPort,DeterministicReportArtifacts} from '@/engine/wave3/contracts';
import {renderDeterministicRtlDocument,type RtlBlock} from '@/server/reports/deterministic-hebrew-pdf';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SavedJune2026AdmittedContext} from './saved-june2026-admitted-context';
import {assertJune2026TestAuthority,type June2026TestAuthority} from './saved-june2026-test-authority';
import type {SourceJob} from './source-dispatch';
import {savedAnalysisId} from './saved-draft-report';

export const JUNE2026_CANONICAL_TEST_TEMPLATE='june2026-canonical-engineering-report-v1';
const hashBytes=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export class SavedJune2026CanonicalRuntime implements RuleSpecExecutorPort,ReportBuilderPort{
 private preparedRunId:string|null=null;
 private loaded:Extract<SavedJune2026AdmittedContext,{state:'context_loaded'}>|null=null;
 admission:June2026EvidenceAdmission|Readonly<{schema_version:'june2026-context-blocked-v1';assessment_sha256:string;
  legal_activation:false;human_approval:false;execution_allowed:false;decisions:[];preflight:{state:'context_blocked';code:string};resolution_sha256:string}>|null=null;
 comparison:SourceMonetaryComparison|null=null;
 constructor(private readonly authority:June2026TestAuthority,private readonly job:SourceJob,private readonly orderId:string){
  assertJune2026TestAuthority(authority,job,orderId);
 }
 prepare(value:SavedJune2026AdmittedContext){
  this.preparedRunId=value.state==='context_loaded'?value.context.current.analysis_run_id:value.analysis_run_id;
  if(value.state!=='context_loaded'){
   const body={schema_version:'june2026-context-blocked-v1' as const,assessment_sha256:this.authority.assessment_sha256,
    legal_activation:false as const,human_approval:false as const,execution_allowed:false as const,decisions:[] as [],
    preflight:{state:'context_blocked' as const,code:value.code}};
   this.admission={...body,resolution_sha256:canonicalSha256(body)};return;
  }
  this.loaded=value;
  this.admission=resolveJune2026Evidence({packet:value.admission_assessment,facts:value.facts,
   assessment:this.authority.assessment,evaluatedAt:this.authority.evaluated_at,mode:'synthetic_test'});
 }
 blockers(){
  if(this.admission?.execution_allowed)return null;
  const conflict=this.admission?.decisions.some(d=>d.state==='conflicted');
  return {status:conflict?'blocked_conflict' as const:'blocked_missing_facts' as const,
   blockers:this.admission?[...this.admission.decisions.filter(d=>d.state!=='test_assessment_admitted').map(d=>`${d.field}:${d.state}`),
    ...(this.loaded?.context.factual_issues??[]).map(i=>`${i.field}:${i.reason}`),`preflight:${this.admission.preflight.state}`]:['SAVED_CANONICAL_CONTEXT_UNAVAILABLE']};
 }
 async execute(input:Parameters<RuleSpecExecutorPort['execute']>[0]){
  const loaded=this.loaded,admission=this.admission,c=createJune2026MinimumWageCandidate(1);
  assertJune2026TestAuthority(this.authority,this.job,this.orderId);
  if(!loaded||!admission?.execution_allowed||admission.preflight.state!=='candidate_calculated'
   ||input.selection.mode!=='synthetic_test'||input.selection.catalog_id!=='tivdoc.june2026.isolated-test'
   ||input.selection.rule_spec_id!==c.rule.rule_spec_id||input.selection.rule_spec_version!==c.rule.rule_spec_version
   ||canonicalSha256(input.rule_input)!==canonicalSha256(loaded.context.rule_input))throw Error('JUNE_CANONICAL_EXECUTOR_DENIED');
  const trace=createSourceCalculationTrace({calculationId:input.execution_id,caseId:this.job.case_id,
   analysisRunId:loaded.facts.analysis_run_id,calculatedAt:input.calculated_at,catalogSha256:input.selection.catalog_sha256,
   facts:loaded.facts,rule:c.rule,parameters:c.parameters,bindings:[...loaded.context.source_fact_bindings,
    ...c.rule.parameters.map((p,index)=>({input_id:p.ref_id,source:{kind:'parameter' as const,
     parameter_id:c.parameters[index].parameter_id,parameter_version:c.parameters[index].parameter_version}}))]});
  if(canonicalSha256(trace.execution_output)!==canonicalSha256(admission.preflight.execution.output))throw Error('JUNE_CANONICAL_ASSESSMENT_ARITHMETIC_BINDING');
  this.comparison=createSourceMonetaryComparison({trace,expectedRef:'expected.regular.pay',recordedRef:'recorded.eligible.pay'});
  const amount=this.comparison.signed_difference.minor_units<0?null:this.comparison.signed_difference;
  return {topic:'minimum_wage' as const,rule_spec_id:c.rule.rule_spec_id,rule_spec_version:c.rule.rule_spec_version,
   amount,trace,result_sha256:canonicalSha256({amount,trace})};
 }
 async build(bundle:AnalysisResultBundle):Promise<DeterministicReportArtifacts>{
  if(!this.admission||bundle.analysis_run_id!==this.preparedRunId||bundle.case_id!==this.job.case_id||(this.loaded&&(bundle.analysis_run_id!==this.loaded.facts.analysis_run_id
   ||bundle.facts_snapshot_sha256!==this.loaded.context.facts_snapshot_sha256)))throw Error('JUNE_CANONICAL_REPORT_RUN_BINDING');
  if(this.comparison&&canonicalSha256(bundle.topic_results[0]?.trace)!==canonicalSha256(this.comparison.trace))throw Error('JUNE_CANONICAL_REPORT_TRACE_BINDING');
  const reportId=savedAnalysisId('june-canonical-report',bundle.result_sha256),c=this.comparison;
  const money=(n:number)=>`${(n/100).toFixed(2)} ILS`;
  const rows=[['חודש','2026-06'],['ריצת ניתוח',bundle.analysis_run_id],['שיטה','6443.85 × שעות רגילות ÷ 182; עיגול half_up בסוף'],
   ['גרסת שיטה','monthly_times_hours_over_182_final_half_up@1.0.0'],
   ['סכום צפוי',c?money(c.expected.minor_units):'לא חושב'],['סכום מתועד',c?money(c.recorded.minor_units):'לא חושב'],
   ['הפרש חתום',c?money(c.signed_difference.minor_units):'לא חושב'],['מצב',bundle.topic_results[0].status],
   ['גרסת מסמך',this.authority.assessment.document_version_id],['מקור מסמך SHA-256',this.authority.assessment.document_sha256],
   ['עקבת חישוב SHA-256',c?.trace.trace_sha256??'אין'],['קבלת הערכות SHA-256',this.admission.resolution_sha256]];
  const title='שכר מינימום יוני 2026 — בדיקה קנונית ב־DEV';
  const disclosure='תיק סינתטי ואישורי בדיקה מבודדים. הכלל אינו פעיל לשירות לקוחות. אין אישור מקצועי אנושי ואין כאן קביעה של חוב לקוח. הסכום המתועד אינו הוכחת תשלום בפועל.';
  const json=Buffer.from(canonicalStringify({schema_version:JUNE2026_CANONICAL_TEST_TEMPLATE,authority:'isolated_dev_test_assumptions',
   human_approval:false,legal_activation:false,bundle,admission:this.admission,comparison:c,rows}));
  const html=Buffer.from(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>${title}</title><body><h1>${title}</h1><p>${disclosure}</p><table>${rows.map(([k,v])=>`<tr><th>${escape(k)}</th><td><bdi>${escape(v)}</bdi></td></tr>`).join('')}</table><p>${escape(bundle.topic_results[0].blockers.join('; '))}</p></body></html>`);
  const blocks:RtlBlock[]=[{kind:'heading',level:1,text:title},{kind:'paragraph',text:disclosure},
   ...rows.map(([k,v])=>({kind:'paragraph' as const,text:`${k}: ${v}`})),{kind:'paragraph',text:bundle.topic_results[0].blockers.join('; ')||'אין חסמי קלט בהוכחת הבדיקה.'}];
  const pdf=renderDeterministicRtlDocument({title,subject:`Canonical run ${bundle.analysis_run_id}`,fixed_date:bundle.as_of.replaceAll('-',''),blocks});
  const manifest=Buffer.from(canonicalStringify({schema_version:JUNE2026_CANONICAL_TEST_TEMPLATE,analysis_run_id:bundle.analysis_run_id,
   json_sha256:hashBytes(json),html_sha256:hashBytes(html),pdf_sha256:hashBytes(pdf)}));
  const binding={report_id:reportId,report_revision:bundle.case_revision,analysis_result_sha256:bundle.result_sha256,
   json_sha256:hashBytes(json),html_sha256:hashBytes(html),pdf_sha256:hashBytes(pdf),manifest_sha256:hashBytes(manifest)};
  return {...binding,json,html,pdf,manifest,report_sha256:canonicalSha256(binding)};
 }
 async persist(context:PostgresTransactionContext,runId:string){
  if(!this.admission)throw Error('JUNE_CANONICAL_ADMISSION_REQUIRED');
  await context.client.query(statement('june_canonical_test_save','select private.june2026_canonical_test_save($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,$7::jsonb)',
   [this.job.case_id,this.orderId,this.job.revision,this.job.input_sha256,runId,this.comparison?JSON.stringify(this.comparison):null,JSON.stringify(this.admission)]));
 }
}
