import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {assertCaseAnalysisAiReleaseScope} from '@/engine/case-analysis/contracts';
import {WAVE3_TOPICS,type Wave3Topic} from '@/engine/wave3/contracts';
import {bytesSha256,decodeBundle,decodeReport} from '@/server/platform/persistence/postgres/analysis/validation';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {CaseAccessDb} from '../case-access/db';
import {getCompiledAiReleaseBuild} from '../processing/ai-release-build';
import {verifyAiReleaseConfiguration} from '../processing/ai-release-configuration';
import {savedAiEvaluationAnchor} from '../processing/ai-release-evaluation-anchor';
import {renderAiReleaseBundle,AI_RELEASE_REPORT_TEMPLATE} from './ai-release-report';
import {admitRealAiServiceDelivery,realAiServiceCurrentContextSchema,realAiServiceDecisionSchema} from './real-ai-service-admission';

const hash=z.string().regex(/^[a-f0-9]{64}$/u),time=z.iso.datetime({offset:true});
export const realAiServiceSelectorSchema=z.object({case_id:z.uuid(),identity_id:z.uuid(),report_id:z.uuid()}).strict();
export type RealAiServiceSelector=z.infer<typeof realAiServiceSelectorSchema>;
const publicationSchema=z.object({case_id:z.uuid(),identity_id:z.uuid(),report_id:z.uuid(),analysis_run_id:z.string().min(1),
 report_sha256:hash,envelope_sha256:hash,service_decision_sha256:hash,delivery_binding_sha256:hash,published_at:time}).strict();
const currentSchema=realAiServiceCurrentContextSchema.omit({trusted_generator_pins:true,available_evidence_sha256s:true});
export const realAiServiceDeliveryContextSchema=z.discriminatedUnion('state',[
 z.object({state:z.literal('unavailable'),reason:z.enum(['disabled','forbidden','unpublished','superseded','revoked','expired','not_enrolled'])}).strict(),
 z.object({state:z.literal('configured'),configuration:z.unknown(),configuration_sha256:hash,
  service_decision:realAiServiceDecisionSchema,current:currentSchema,context_sha256:hash,
  source_created_at:time,enrollment_expires_at:time,
  evidence:z.array(z.object({sha256:hash,content_base64:z.string().min(1).max(4_000_000)}).strict()).min(1).max(32),
  completion:z.object({bundle:z.unknown(),report:z.unknown()}).strict(),publication:publicationSchema.nullable(),
 }).strict(),
]);
const same=(a:unknown,b:unknown)=>canonicalSha256(a)===canonicalSha256(b);
function assert(condition:unknown,code:string):asserts condition{if(!condition)throw Error(code);}
function enabled(){assert(process.env.TIVDOC_REAL_AI_SERVICE_ENABLED==='1','REAL_SERVICE_DISABLED');}
const loaded=new WeakSet<object>();

/** SQL must authenticate identity/tenant and load every current pin under its
 * own RLS scope. No authority, content or recipient is accepted from the HTTP
 * request. See the companion DB contract proposal; these RPCs are deliberately
 * separate from owner/DEV functions and are unavailable until migrated. */
function resolveDelivery(value:unknown,selector:RealAiServiceSelector){
 const row=realAiServiceDeliveryContextSchema.parse(value);
 assert(row.state==='configured',row.state==='unavailable'?`REAL_SERVICE_UNAVAILABLE_${row.reason.toUpperCase()}`:'REAL_SERVICE_CONTEXT_REQUIRED');
 const current=row.current,at=Date.parse(current.assessment.evaluated_at);
 assert(current.identity_id===selector.identity_id&&current.assessment.scope.case_id===selector.case_id
  &&current.artifacts.report_id===selector.report_id,'REAL_SERVICE_LOADER_SCOPE');
 assert(current.assessment.namespace==='real'&&!current.assessment.is_qa,'REAL_SERVICE_REAL_CONTEXT_REQUIRED');
 assert(at<Date.parse(row.enrollment_expires_at),'REAL_SERVICE_ENROLLMENT_EXPIRED');
 const build=getCompiledAiReleaseBuild(),verified=verifyAiReleaseConfiguration(row.configuration,build),config=verified.configuration;
 assert(config.sha256===row.configuration_sha256&&config.policy.namespace==='real','REAL_SERVICE_CONFIGURATION_MISMATCH');
 assert(build.manifest.files.some(f=>f.path==='src/server/product/reports/ai-release-report.ts'),'REAL_SERVICE_RENDERER_BUILD_MISSING');
 assert(current.artifacts.renderer_template===AI_RELEASE_REPORT_TEMPLATE
  &&current.artifacts.renderer_code_sha256===build.manifest.source_graph_sha256,'REAL_SERVICE_RENDERER_BUILD_CHANGED');
 // Same outer-catalog selection as savedOrderLegalTopics. The full purchased
 // inventory remains in document_review and the service artifact binding.
 const legalTopics=current.artifacts.purchased_topics.filter((topic):topic is Exclude<Wave3Topic,'sick_leave'>=>WAVE3_TOPICS.includes(topic as Wave3Topic));
 const bundle=decodeBundle(row.completion.bundle,legalTopics),report=decodeReport(row.completion.report);
 assert(bundle.ai_release&&!bundle.owner_engineering,'REAL_SERVICE_REAL_ENVELOPE_REQUIRED');
 const envelope=bundle.ai_release,input=envelope.input.assessment_input;
 assertCaseAnalysisAiReleaseScope(envelope,bundle);
 for(const key of ['policy','registry','source_receipts','interpretation_receipts','test_receipts'] as const)
  assert(same(input[key],config[key]),'REAL_SERVICE_CONFIGURATION_EVIDENCE_CHANGED');
 assert(config.population===current.assessment.scope.population,'REAL_SERVICE_POPULATION_CHANGED');
 const anchor=savedAiEvaluationAnchor(config,row.source_created_at,current.assessment.evaluated_at);
 assert(anchor.evaluated_at===input.current.evaluated_at&&Date.parse(anchor.evaluated_at)<=at,'REAL_SERVICE_EVALUATION_ANCHOR_CHANGED');
 assert(report.report_id===selector.report_id&&report.analysis_result_sha256===bundle.result_sha256,'REAL_SERVICE_SAVED_REPORT_BINDING');
 const rendered=renderAiReleaseBundle(bundle,report.report_id);
 assert(rendered.report_sha256===report.report_sha256&&rendered.html_sha256===report.html_sha256
  &&rendered.pdf_sha256===report.pdf_sha256&&rendered.json_sha256===report.json_sha256
  &&rendered.manifest_sha256===report.manifest_sha256,'REAL_SERVICE_RENDERED_BYTES_CHANGED');
 assert(current.artifacts.html_sha256===report.html_sha256&&current.artifacts.pdf_sha256===report.pdf_sha256,'REAL_SERVICE_STORED_ARTIFACTS_CHANGED');
 const evidenceHashes=row.evidence.map(e=>{
  const bytes=Buffer.from(e.content_base64,'base64');
  assert(bytes.toString('base64')===e.content_base64&&bytesSha256(bytes)===e.sha256,'REAL_SERVICE_EVIDENCE_BYTES_CHANGED');
  return e.sha256;
 });
 assert(new Set(evidenceHashes).size===evidenceHashes.length,'REAL_SERVICE_DUPLICATE_EVIDENCE');
 assert(evidenceHashes.includes(config.policy.product_decision_sha256),'REAL_SERVICE_PRODUCT_EVIDENCE_UNAVAILABLE');
 const admission=admitRealAiServiceDelivery({decision:row.service_decision,envelope,
  request:{identity_id:selector.identity_id,artifacts:current.artifacts}},
  {...current,trusted_generator_pins:verified.trusted_generator_pins,available_evidence_sha256s:evidenceHashes});
 const binding={case_id:selector.case_id,identity_id:selector.identity_id,report_id:selector.report_id,analysis_run_id:bundle.analysis_run_id,
  report_sha256:report.report_sha256,envelope_sha256:envelope.sha256,service_decision_sha256:row.service_decision.sha256};
 const delivery_binding_sha256=canonicalSha256({schema_version:'tivdoc-real-ai-service-delivery-binding-v1',...binding});
 if(row.publication){
  const {published_at,...published}=row.publication;
  assert(same(published,{...binding,delivery_binding_sha256})&&Date.parse(published_at)<=at,'REAL_SERVICE_PUBLICATION_CHANGED');
 }
 const result=Object.freeze({selector:Object.freeze(selector),admission,report,binding:Object.freeze({...binding,delivery_binding_sha256}),
  context_sha256:row.context_sha256,publication:row.publication,evaluated_at:current.assessment.evaluated_at,
  expires_at:new Date(Math.min(Date.parse(admission.expires_at),Date.parse(row.enrollment_expires_at))).toISOString()});
 loaded.add(result);return result;
}
export type LoadedRealAiServiceDelivery=ReturnType<typeof resolveDelivery>;
export function assertLoadedRealAiServiceDelivery(value:LoadedRealAiServiceDelivery){
 assert(loaded.has(value),'REAL_SERVICE_AUTHENTICATED_LOADER_REQUIRED');
}

export async function loadRealAiServiceDelivery(context:PostgresTransactionContext,candidate:RealAiServiceSelector){
 enabled();const selector=realAiServiceSelectorSchema.parse(candidate);
 const result=await context.client.query(statement('real_ai_service_delivery_context',
  'select private.real_ai_service_delivery_context($1::uuid,$2::uuid,$3::uuid) value',
  [selector.case_id,selector.identity_id,selector.report_id]));
 assert(result.row_count===1,'REAL_SERVICE_CONTEXT_ACK');
 return resolveDelivery(result.rows[0]?.value,selector);
}

/** A delivery stage after a genuine REAL saved run. Reuses its report and
 * envelope; does not enqueue a new analysis or upgrade isolated_test output.
 * The caller owns the transaction. The publish RPC must repeat the source,
 * entitlement, service/config/revocation, exact artifact and DB-time fences
 * while holding the case lock; a TypeScript preflight is not the SQL guard. */
export async function publishRealAiServiceReport(context:PostgresTransactionContext,selector:RealAiServiceSelector){
 const delivery=await loadRealAiServiceDelivery(context,selector),bound=delivery.selector;
 const result=await context.client.query(statement('real_ai_service_report_publish',
  'select private.real_ai_service_report_publish($1::uuid,$2::uuid,$3::uuid,$4,$5::jsonb,$6::jsonb) value',
  [bound.case_id,bound.identity_id,bound.report_id,delivery.context_sha256,JSON.stringify(delivery.binding),JSON.stringify(delivery.admission)]));
 assert(result.row_count===1,'REAL_SERVICE_PUBLICATION_ACK');
 const published=publicationSchema.extend({replayed:z.boolean()}).strict().parse(result.rows[0]?.value);
 const {published_at,replayed,...binding}=published;
 assert(same(binding,delivery.binding),'REAL_SERVICE_PUBLICATION_ACK_BINDING');
 assert(Date.parse(published_at)<Date.parse(delivery.expires_at)
  &&(replayed||Date.parse(published_at)>=Date.parse(delivery.evaluated_at)),'REAL_SERVICE_PUBLICATION_ACK_TIME');
 return published;
}

/** Call from an authenticated REAL route. Only HTML/PDF bytes leave this
 * boundary; configuration, assessment, operator evidence and recipient context
 * stay private. The web RPC refuses unpublished or foreign reports itself. */
export async function readRealAiServiceReport(db:CaseAccessDb,candidate:RealAiServiceSelector,format:'html'|'pdf'){
 enabled();const selector=realAiServiceSelectorSchema.parse(candidate);z.enum(['html','pdf']).parse(format);
 const rows=await db.rpc<{value:unknown}>('case_report_real_ai_context',{
  target_case:selector.case_id,target_identity:selector.identity_id,target_report:selector.report_id});
 assert(rows.length===1,'REAL_SERVICE_CONTEXT_ACK');
 const delivery=resolveDelivery(rows[0].value,selector);
 assert(delivery.publication,'REAL_SERVICE_REPORT_UNPUBLISHED');
 return {report_id:selector.report_id,analysis_run_id:delivery.binding.analysis_run_id,
  content_type:format==='pdf'?'application/pdf' as const:'text/html; charset=utf-8' as const,
  bytes:new Uint8Array(delivery.report[format]),sha256:format==='pdf'?delivery.report.pdf_sha256:delivery.report.html_sha256,
  cache_control:'private, no-store' as const};
}
