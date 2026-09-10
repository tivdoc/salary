import {createHash} from 'node:crypto';
import {canonicalSha256,canonicalStringify} from '@/engine/rule-runtime/canonical';
import {findingV2Schema} from '@/engine/findings/contracts';
import type {AnalysisResultBundle,DeterministicReportArtifacts,ReportBuilderPort} from '@/engine/wave3/contracts';
import {assertJune2026RegularAuthority,type June2026RegularAuthority} from '@/engine/minimum-wage-june2026/regular-service/authority';
import {June2026RegularExecutor,june2026RegularId} from '@/engine/minimum-wage-june2026/regular-service/executor';
import {JUNE2026_REGULAR_REQUIRED_FACT_PATHS} from '@/engine/minimum-wage-june2026/regular-service/contracts';
import type {June2026RegularAdmission} from '@/engine/minimum-wage-june2026/regular-service/evidence';
import {renderDeterministicRtlDocument,type RtlBlock} from '@/server/reports/deterministic-hebrew-pdf';
import {AI_PUBLICATION_POLICY,AI_REPORT_DISCLOSURE,reportDocumentV3Schema} from './report-document';
import {CERTAINTY_SENTENCE,PROJECTION_LEGAL_BASIS,PROJECTION_SCHEMA_VERSION,PROJECTION_TOPICS,parseProjection} from './case-report-projection';

export const JUNE_REGULAR_REPORT_TEMPLATE='june2026-regular-service-report-v1';
const hashBytes=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
/** Only dependencies of this calculation become report evidence. Unrelated
 * missing/conflicted facts stay in the full immutable bundle and its JSON. */
export function june2026RegularReportSources(input:{admission:June2026RegularAdmission;analysisRunId:string;document:June2026RegularAdmission['evidence']['documents'][number]}){
 const {admission,analysisRunId,document}=input;
 const required=admission.effective_facts.facts.filter(f=>JUNE2026_REGULAR_REQUIRED_FACT_PATHS.some(path=>path===f.path));
 if(required.length!==JUNE2026_REGULAR_REQUIRED_FACT_PATHS.length||admission.effective_facts.analysis_run_id!==analysisRunId)
  throw Error('JUNE_REGULAR_REPORT_REQUIRED_FACTS');
 return required.flatMap(f=>{
  if(f.status!=='confirmed'||f.value===null||!f.provenance.length)throw Error('JUNE_REGULAR_REPORT_LOCATOR');
  // Declared hours retain their separately signed answer lineage; they are
  // never presented as a document cell. Every documentary operand needs page.
  if(f.path==='work.regular_hours'&&admission.hours_origin==='identified_declared'&&f.provenance.length===1
    &&f.provenance[0].source_type==='declared'&&f.provenance[0].source_reference.kind==='case_request_answer'
    &&admission.fact_admissions.some(a=>a.fact_id===f.fact_id))return [];
  return f.provenance.map(p=>{
   if(p.source_type!=='documented'||p.source_reference.document_id!==document.version_id||!p.source_reference.locator?.page
     ||p.source_reference.locator.page>document.page_count)throw Error('JUNE_REGULAR_REPORT_LOCATOR');
   return {id:june2026RegularId({run:analysisRunId,fact:f.fact_id,source:p}),document_id:document.product_document_id,version_id:document.version_id,
    sha256:document.sha256,page:p.source_reference.locator.page,field:f.path,fact_version:f.fact_id};
  });
 });
}
/** Produces the existing v3 envelope from an actual same-run Finding. It does
 * not publish: root persists this envelope and its authority binding in the
 * same transaction, then calls the existing current-source AI publisher.
 * An isolated registry requires a separately enforced DEV/QA publication fence. */
export class June2026RegularReportBuilder implements ReportBuilderPort{
 document:ReturnType<typeof reportDocumentV3Schema.parse>|null=null;
 constructor(private readonly input:{authority:June2026RegularAuthority;executor:June2026RegularExecutor;publicId:string;offerSha256:string;reportKind?:'initial'|'full'}){}
 async build(bundle:AnalysisResultBundle):Promise<DeterministicReportArtifacts>{
  const {authority,executor}=this.input;assertJune2026RegularAuthority(authority);
  const result=executor.result;
  if(!result||result.case_id!==bundle.case_id||result.analysis_run_id!==bundle.analysis_run_id||result.authority_sha256!==authority.authority_sha256
   ||bundle.facts_snapshot_sha256!==result.admission.facts_snapshot_sha256
   ||bundle.topic_results.length!==1||canonicalSha256(bundle.topic_results[0].trace)!==canonicalSha256(result.trace))throw Error('JUNE_REGULAR_REPORT_RUN_BINDING');
  const comparison=result.comparison,finding=result.finding?findingV2Schema.parse(result.finding):null;
  const conditional=result.certainty==='medium',gap=comparison.signed_difference;
  const projection=parseProjection({schema_version:PROJECTION_SCHEMA_VERSION,case_public_id:this.input.publicId,check_period_month:'2026-06',months_covered:['2026-06'],
   report_kind:this.input.reportKind??'initial',legal_basis:PROJECTION_LEGAL_BASIS,generated_at:result.trace.calculated_at,
   topics:PROJECTION_TOPICS.map(topic=>topic==='minimum_wage'?{
    topic,branches_examined:['monthly_times_hours_over_182'],parameter_grades:Object.fromEntries(result.trace.parameters.map(p=>[`${p.parameter_id}@${p.parameter_version}`,'active'])),
    gate:'checked',activation:'active',applicability:'applicable',status:finding?'finding':'no_gap',certainty:result.certainty,
    display:conditional?'range':'amount',certainty_sentence:CERTAINTY_SENTENCE[result.certainty],severity_class:finding?'statutory_violation':null,
    basis_complete:true,missing_facts:[],assumptions:conditional?[{slot:'identified_case_evidence',statement:'תחולת החישוב נשענת גם על המידע שמסרת ועל קבלת ההערכה המוצמדת לדוח.'}]:[],
    retroactive_update:null,amount:finding&&!conditional?gap:null,range:finding&&conditional?{low:gap,high:gap}:null,direction:finding?'employer_owes':'none',
   }:{topic,branches_examined:[],parameter_grades:{},gate:'awaiting_verification',activation:'awaiting_verification',status:'not_checked',
    customer_text:'ממתין לאימות בסיום הפיתוח',blocked_by_grades:['draft']})});
  const source=authority.assessment,document=result.admission.evidence.documents.find(d=>d.version_id===source.document_version_id);
  if(!document||document.sha256!==source.document_sha256)throw Error('JUNE_REGULAR_REPORT_SOURCE');
  const evidence=june2026RegularReportSources({admission:result.admission,analysisRunId:result.analysis_run_id,document});
  const doc=reportDocumentV3Schema.parse({schema_version:'tivdoc-report-document-v3',id:june2026RegularId({run:bundle.analysis_run_id,result:result.result_sha256,template:JUNE_REGULAR_REPORT_TEMPLATE}),
   case_id:bundle.case_id,order_id:source.order_id,revision:source.input_revision,input_sha256:source.input_sha256,projection_sha256:canonicalSha256(projection),
   purchased_period:{from:'2026-06',to:'2026-06'},projection,evidence,
   findings:finding?[{id:finding.finding_id,topic:'minimum_wage',evidence_ids:evidence.map(e=>e.id),rule_versions:[`${finding.rule.rule_id}@${finding.rule.rule_version}`],
    parameter_versions:result.trace.parameters.map(p=>`${p.parameter_id}@${p.parameter_version}`)}]:[],
   publication:{state:'draft',approved_input_sha256:null,approval_actor_kind:'automation',published_at:null},correction_policy:'append_new_revision_preserve_published',
   service_kind:'ai_assisted',publication_policy:AI_PUBLICATION_POLICY,order_offer_sha256:this.input.offerSha256,
   execution_authority:{namespace:authority.registry.namespace,analysis_run_id:result.analysis_run_id,authority_sha256:authority.authority_sha256,
    real_legal_authority:authority.real_legal_authority,human_report_approval:false,
    parent_facts_sha256:result.admission.facts_snapshot_sha256,effective_facts_sha256:result.admission.effective_facts_snapshot_sha256}});
  this.document=doc;
  const money=(n:number)=>`${(n/100).toFixed(2)} ILS`,isolated=authority.registry.namespace==='isolated_test';
  const title=isolated?'דוח סינתטי מבודד — שכר מינימום יוני 2026':'בדיקת שכר מינימום — יוני 2026';
  const disclosure=isolated?'בדיקת DEV בלבד. המפתחות והחתימות שייכים למרשם בדיקה סינתטי. אין אישור אדם אמיתי, הפעלת דין אמיתי או קביעת חוב לקוח. אישורי קריאת השדות נשלחו בפעולות בדיקה מזוהות; הם אינם חתימת בודק אנושי.':AI_REPORT_DISCLOSURE;
  const readingLabels:Record<string,string>={'work.regular_hours':'שעות רגילות','compensation.base_monthly_salary':'שכר יסוד',
   'compensation.gross_salary':'שכר ברוטו','compensation.salary_type':'סוג שכר','documents.period':'תקופת התלוש'};
  const identifiedReadingPaths=[...new Set(result.admission.effective_facts.facts.filter(f=>JUNE2026_REGULAR_REQUIRED_FACT_PATHS.some(path=>path===f.path)
    &&f.provenance.some(p=>p.source_type==='documented'&&p.customer_confirmation))
   .map(f=>f.path))].sort();
  const rows=[['ריצת ניתוח',result.analysis_run_id],['מקור',document.version_id],['מקור SHA-256',document.sha256],
   ['סכום צפוי',money(comparison.expected.minor_units)],['סכום מתועד בתלוש',money(comparison.recorded.minor_units)],['הפרש חתום',money(gap.minor_units)],
   ['שיטה','6443.85 × שעות רגילות ÷ 182; half_up באגורה הסופית'],['רמת ודאות',CERTAINTY_SENTENCE[result.certainty]],
   ['מקור השעות',result.admission.hours_origin==='identified_declared'?'הצהרה מזוהה של הלקוח שהתקבלה בהערכה חתומה':'נתון מתועד בתלוש'],
   ['שדות שחולצו ואושרו בקריאה מזוהה',identifiedReadingPaths.length?identifiedReadingPaths.map(path=>readingLabels[path]??path).join(', '):'אין אישורי קריאה מזוהים בקלט זה'],
   ['עובדות מקור SHA-256',result.admission.facts_snapshot_sha256],['עובדות לאחר קבלת הערכה SHA-256',result.admission.effective_facts_snapshot_sha256],
   ['סמכות SHA-256',authority.authority_sha256],['קבלת הערכה SHA-256',result.admission.resolution_sha256],['עקבת חישוב SHA-256',result.trace.trace_sha256]];
  const json=Buffer.from(canonicalStringify({schema_version:JUNE_REGULAR_REPORT_TEMPLATE,namespace:authority.registry.namespace,
   real_legal_authority:authority.real_legal_authority,human_report_approval:false,bundle,execution:result,document:doc,rows}));
  const html=Buffer.from(`<!doctype html><html lang="he" dir="rtl"><meta charset="utf-8"><title>${escape(title)}</title><body><h1>${escape(title)}</h1><p>${escape(disclosure)}</p><p>הסכום המתועד אינו אישור שהתשלום הועבר בפועל; פער שלילי אינו חוב עובד.</p><table>${rows.map(([key,value])=>`<tr><th>${escape(key)}</th><td><bdi>${escape(value)}</bdi></td></tr>`).join('')}</table></body></html>`);
  const blocks:RtlBlock[]=[{kind:'heading',level:1,text:title},{kind:'paragraph',text:disclosure},
   {kind:'paragraph',text:'הסכום המתועד אינו אישור שהתשלום הועבר בפועל; פער שלילי אינו חוב עובד.'},
   ...rows.map(([key,value])=>({kind:'paragraph' as const,text:`${key}: ${value}`}))];
  const pdf=renderDeterministicRtlDocument({title,subject:`Analysis ${result.analysis_run_id}`,fixed_date:result.trace.calculated_at.slice(0,10).replaceAll('-',''),blocks});
  const manifest=Buffer.from(canonicalStringify({schema_version:JUNE_REGULAR_REPORT_TEMPLATE,analysis_run_id:result.analysis_run_id,document_id:doc.id,
   json_sha256:hashBytes(json),html_sha256:hashBytes(html),pdf_sha256:hashBytes(pdf)}));
  const binding={report_id:doc.id,report_revision:bundle.case_revision,analysis_result_sha256:bundle.result_sha256,json_sha256:hashBytes(json),
   html_sha256:hashBytes(html),pdf_sha256:hashBytes(pdf),manifest_sha256:hashBytes(manifest)};
  return {...binding,json,html,pdf,manifest,report_sha256:canonicalSha256(binding)};
 }
}
