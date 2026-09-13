import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {runtimeFixture} from '@/engine/ai-release-runtime/runtime.fixture';
import {prepareAiReleaseRuntime} from '@/engine/ai-release-runtime/generator-manifest';
import {fixture as pensionFixture} from '@/engine/entitlement-review/compose.fixture';
import {createCaseAnalysisAiRelease} from '@/engine/case-analysis/contracts';
import {WAVE3_TOPICS,type AnalysisResultBundle,type Wave3Topic} from '@/engine/wave3/contracts';
import {bytesSha256,encodeReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {getCompiledAiReleaseBuild} from '../processing/ai-release-build';
import {aiReleaseConfigurationSchema} from '../processing/ai-release-configuration';
import {renderAiReleaseBundle,AI_RELEASE_REPORT_TEMPLATE} from './ai-release-report';
import {QUALIFIED_AI_RENDERER_ACTIONS,realAiServiceDecisionSchema,REAL_AI_SERVICE_DECISION_VERSION} from './real-ai-service-admission';
import {realAiServiceDeliveryContextSchema} from './real-ai-service-delivery';

export const syntheticServiceId=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const h=(s:string)=>canonicalSha256({synthetic_delivery_fixture:s});
const seal=<T extends object>(body:T)=>({...body,sha256:canonicalSha256(body)});
/** Synthetic in-memory protocol data only, never service evidence to enroll.
 * REAL/acquisition labels deliberately simulate DB records for guard tests.
 * Uses actual compiled config verification, ordinary engine and HTML/PDF. */
export function realAiServiceFixture(){
 const build=getCompiledAiReleaseBuild(),runtime=structuredClone(runtimeFixture(pensionFixture().input));
 const a=runtime.assessment_input,replacements=new Map<string,string>();
 const replace=<T>(v:T):T=>JSON.parse(JSON.stringify(v,(_key,x)=>typeof x==='string'?(replacements.get(x)??x):x));
 const update=<T extends {sha256:string}>(v:T):T=>{
  const old=v.sha256,{sha256,...body}=replace(v);void sha256;const next=seal(body) as T;replacements.set(old,next.sha256);return next;
 };
 const evidence=[['product decision','synthetic operator product decision; never activated'],['action matrix','synthetic A01–A11 action analysis'],
  ['basis','synthetic bounded service explanation; no real law review'],['operator','synthetic operator identity evidence'],
  ['purchase','synthetic purchase presentation'],['support','synthetic support presentation']].map(([id,text])=>{
   const bytes=Buffer.from(text);return {id,sha256:bytesSha256(bytes),content_base64:bytes.toString('base64')};
  });
 const evidenceHash=(id:string)=>evidence.find(e=>e.id===id)!.sha256;
 runtime.analysis_run_id=syntheticServiceId(3);runtime.trusted_generator_pins=structuredClone([...build.trusted_generator_pins]);
 const prepared=prepareAiReleaseRuntime({source:runtime.source,analysis_run_id:runtime.analysis_run_id,trusted_generator_pins:runtime.trusted_generator_pins});
 const generator=(branch:string)=>runtime.trusted_generator_pins.find(p=>p.family_id===branch)!.generator;
 a.source_receipts=a.source_receipts.map(r=>update({...r,acquisition:'primary_copy' as const}));
 a.interpretation_receipts=a.interpretation_receipts.map(r=>update({...r,generator:generator(r.branch_id),human_by_law:{...r.human_by_law,basis_sha256:evidenceHash('basis')}}));
 a.test_receipts=a.test_receipts.map(r=>update({...r,generator:generator(r.branch_id),code_sha256:build.manifest.source_graph_sha256}));
 a.policy=update({...a.policy,namespace:'real' as const,product_decision_sha256:evidenceHash('product decision'),
  branches:a.policy.branches.map(b=>({...b,generator:generator(b.branch_id)}))});
 a.registry=update({...a.registry,namespace:'real' as const});
 a.assessment=update({...a.assessment,branches:a.assessment.branches.map(b=>{
  const expected=prepared.expected_generated_rules.find(e=>e.branch_id===b.branch_id)!;
  return {...b,rule_sha256:expected.rule_sha256,parameter_set_sha256:expected.parameter_set_sha256,
   generated_from:{generator:expected.generator,source_evidence_sha256:expected.source_evidence_sha256}};
 })});
 a.current=replace({...a.current,namespace:'real' as const,is_qa:false,evaluated_at:'2026-09-12T10:00:00.000Z',expected_generated_rules:prepared.expected_generated_rules});
 const scope=a.current.scope,envelope=createCaseAnalysisAiRelease(runtime,{engine_case_revision:7,
  source_journal:{case_id:scope.case_id,input_revision:scope.input_revision,input_sha256:scope.input_sha256}});
 const bundleBody:Omit<AnalysisResultBundle,'result_sha256'>={schema_version:'tivdoc-analysis-result-bundle-v0.6.0',analysis_run_id:runtime.analysis_run_id,
  case_id:scope.case_id,case_revision:7,period:{start_date:scope.period.from,end_date:scope.period.to},as_of:'2026-09-12',
  document_snapshot_sha256:h('documents'),extraction_snapshot_sha256:h('extractions'),declared_fact_snapshot_sha256:h('declarations'),
  facts_snapshot_sha256:scope.facts_sha256,facts:[],rule_inputs:[],catalog_sha256:h('catalog'),known_subtotal:null,coverage_complete:false,
  topic_results:runtime.source.purchased_scope.topics.filter((topic):topic is Exclude<Wave3Topic,'sick_leave'>=>WAVE3_TOPICS.includes(topic as Wave3Topic))
   .map(topic=>({topic,status:'blocked_missing_facts',blockers:['synthetic outer catalog'],rule_input_sha256:null,amount:null,trace:null,legal_readiness:null})),
  document_review:envelope.result.review,ai_release:envelope};
 const bundle={...bundleBody,result_sha256:canonicalSha256(bundleBody)},selector={case_id:scope.case_id,identity_id:syntheticServiceId(1),report_id:syntheticServiceId(2)};
 const report=renderAiReleaseBundle(bundle,selector.report_id);
 const configuration=aiReleaseConfigurationSchema.parse(seal({schema_version:'tivdoc-ai-release-configuration-v1',configuration_id:syntheticServiceId(4),revision:1,
  population:scope.population,build_manifest_sha256:build.manifest.sha256,policy:a.policy,registry:a.registry,source_receipts:a.source_receipts,
  interpretation_receipts:a.interpretation_receipts,test_receipts:a.test_receipts}));
 const decision=realAiServiceDecisionSchema.parse(seal({schema_version:REAL_AI_SERVICE_DECISION_VERSION,decision_id:'synthetic-adapter-decision',version:'1',
  namespace:'real',purpose:'real_customer_service',status:'active',policy_sha256:a.policy.sha256,product_decision_sha256:a.policy.product_decision_sha256,
  human_attestation:null,action_matrix_sha256:evidenceHash('action matrix'),
  action_reviews:QUALIFIED_AI_RENDERER_ACTIONS.map(action=>({action,interpretation_receipt_sha256:a.interpretation_receipts[0].sha256,basis_sha256:evidenceHash('basis')})),
  renderer:{template:AI_RELEASE_REPORT_TEMPLATE,code_sha256:build.manifest.source_graph_sha256},
  evidence:{operator_identity_sha256:evidenceHash('operator'),purchase_presentation_sha256:evidenceHash('purchase'),support_presentation_sha256:evidenceHash('support'),
   sample_html_sha256:report.html_sha256,sample_pdf_sha256:report.pdf_sha256},issued_at:'2026-09-12T01:00:00Z',expires_at:'2026-09-12T20:00:00Z'}));
 const artifacts={case_id:scope.case_id,report_id:report.report_id,analysis_run_id:bundle.analysis_run_id,envelope_sha256:envelope.sha256,
  renderer_template:AI_RELEASE_REPORT_TEMPLATE,renderer_code_sha256:build.manifest.source_graph_sha256,html_sha256:report.html_sha256,pdf_sha256:report.pdf_sha256,
  purchased_topics:[...runtime.source.purchased_scope.topics],represented_topics:[...runtime.source.purchased_scope.topics]};
 const binding={case_id:selector.case_id,identity_id:selector.identity_id,report_id:selector.report_id,analysis_run_id:bundle.analysis_run_id,
  report_sha256:report.report_sha256,envelope_sha256:envelope.sha256,service_decision_sha256:decision.sha256};
 const publication={...binding,delivery_binding_sha256:canonicalSha256({schema_version:'tivdoc-real-ai-service-delivery-binding-v1',...binding}),published_at:'2026-09-12T10:15:00Z'};
 const row=realAiServiceDeliveryContextSchema.parse({state:'configured',configuration,configuration_sha256:configuration.sha256,service_decision:decision,
  current:{assessment:{...a.current,evaluated_at:'2026-09-12T10:30:00Z'},identity_id:selector.identity_id,service_decision_sha256:decision.sha256,artifacts,revocations:[]},
  context_sha256:h('DB compare and set token'),source_created_at:a.current.evaluated_at,enrollment_expires_at:'2026-09-12T21:00:00Z',
  evidence:[...evidence.map(({id,...e})=>{void id;return e;}),{sha256:report.html_sha256,content_base64:Buffer.from(report.html).toString('base64')},
   {sha256:report.pdf_sha256,content_base64:Buffer.from(report.pdf).toString('base64')}],completion:{bundle,report:encodeReport(report)},publication});
 if(row.state!=='configured')throw Error('SYNTHETIC_CONTEXT_REQUIRED');
 return {row,selector,report,bundle,configuration};
}
