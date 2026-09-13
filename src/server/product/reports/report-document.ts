import {z} from 'zod';
import {canonicalSha256} from '../../../engine/rule-runtime/canonical';
import {caseReportProjectionSchema,PROJECTION_TOPICS} from './case-report-projection';
import {publicationDecision} from './publication-gate';
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
/** Delivery envelope v2. Existing safe v1 projections stay readable without invented provenance. */
const reportDocumentShape=z.object({
 schema_version:z.literal('tivdoc-report-document-v2'),
 id:z.uuid(),case_id:z.uuid(),order_id:z.uuid(),revision:z.number().int().positive(),
 input_sha256:hash,projection_sha256:hash,
 purchased_period:z.object({from:month,to:month}).strict(),
 projection:caseReportProjectionSchema,
 evidence:z.array(z.object({id:z.uuid(),document_id:z.uuid(),version_id:z.uuid(),sha256:hash,page:z.number().int().positive(),field:z.string().min(1),fact_version:z.string().min(1)}).strict()),
 findings:z.array(z.object({id:z.uuid(),topic:z.enum(PROJECTION_TOPICS),evidence_ids:z.array(z.uuid()).min(1),rule_versions:z.array(z.string().min(1)).min(1),parameter_versions:z.array(z.string().min(1)).min(1)}).strict()),
 publication:z.object({state:z.enum(['draft','approved','published','superseded']),approved_input_sha256:hash.nullable(),approval_actor_kind:z.enum(['human','automation']).nullable(),published_at:z.iso.datetime().nullable()}).strict(),
 correction_policy:z.literal('append_new_revision_preserve_published'),
}).strict();
function validateProvenance(doc:z.infer<typeof reportDocumentShape>,ctx:z.RefinementCtx){
 const fail=(message:string)=>ctx.addIssue({code:'custom',message});
 if(canonicalSha256(doc.projection)!==doc.projection_sha256)fail('projection_hash_mismatch');
 if(doc.purchased_period.from>doc.purchased_period.to)fail('purchased_period_reversed');
 if(doc.projection.months_covered.some(m=>m<doc.purchased_period.from||m>doc.purchased_period.to))fail('coverage_outside_order');
 if(new Set(doc.evidence.map(e=>e.id)).size!==doc.evidence.length||new Set(doc.findings.map(f=>f.id)).size!==doc.findings.length)fail('duplicate_evidence_or_finding');
 if(doc.findings.some(f=>f.evidence_ids.some(id=>!doc.evidence.some(e=>e.id===id))))fail('finding_source_missing');
 const topics=doc.projection.topics.filter(t=>t.gate==='checked'&&t.status==='finding').map(t=>t.topic).sort();
 if(JSON.stringify(topics)!==JSON.stringify(doc.findings.map(f=>f.topic).sort()))fail('finding_provenance_mismatch');
 if(['approved','published'].includes(doc.publication.state)&&doc.publication.approved_input_sha256!==doc.input_sha256)fail('stale_approval');
 if(doc.publication.state==='published'){
  if(!doc.publication.published_at)fail('publication_time_missing');
  if(!doc.projection.topics.some(t=>t.gate==='checked'))fail('empty_report_not_deliverable');
 }
}
/** Historical v2 keeps its purchased human-review requirement unchanged. */
export const reportDocumentV2Schema=reportDocumentShape.superRefine((doc,ctx)=>{
 validateProvenance(doc,ctx);
 if(doc.publication.state==='published'&&doc.projection.report_kind==='full'&&doc.publication.approval_actor_kind!=='human')ctx.addIssue({code:'custom',message:'full_report_requires_human_review'});
});
/** v1.1 changes the service promise, not source activation or accuracy gates.
 * An envelope is provenance, never permission to publish or a human attestation.
 * The saved publisher must additionally load the exact paid v2 AI order. */
export const AI_REPORT_DISCLOSURE='דוח באמצעות AI עם מקורות והסברים. הממצאים מתייחסים לנתונים שנבדקו; קבלת כסף מהמעסיק אינה מובטחת. שאלות ותיקונים נשמרים בתיק.';
export const AI_PUBLICATION_POLICY='tivdoc-ai-publication-v1' as const;
export const reportDocumentV3Schema=reportDocumentShape.extend({
 schema_version:z.literal('tivdoc-report-document-v3'),
 service_kind:z.literal('ai_assisted'),
 publication_policy:z.literal(AI_PUBLICATION_POLICY),
 order_offer_sha256:hash,
 // Optional forward metadata: historic v3 bytes and hashes remain unchanged.
 // This binding is not a publication grant or a manufactured human approval.
 execution_authority:z.object({namespace:z.enum(['real','isolated_test']),analysis_run_id:z.uuid(),authority_sha256:hash,
  real_legal_authority:z.boolean(),human_report_approval:z.literal(false),parent_facts_sha256:hash,effective_facts_sha256:hash,
 }).strict().optional(),
 publication:z.object({state:z.enum(['draft','published','superseded']),approved_input_sha256:hash.nullable(),approval_actor_kind:z.literal('automation'),published_at:z.iso.datetime().nullable()}).strict(),
}).strict().superRefine((doc,ctx)=>{
 validateProvenance({...doc,schema_version:'tivdoc-report-document-v2'},ctx);
 if(doc.execution_authority&&doc.execution_authority.real_legal_authority!==(doc.execution_authority.namespace==='real'))
  ctx.addIssue({code:'custom',message:'execution_authority_namespace_mismatch'});
 if(doc.publication.state!=='draft'){
  if(doc.publication.approved_input_sha256!==doc.input_sha256||!doc.publication.published_at)ctx.addIssue({code:'custom',message:'ai_publication_receipt_required'});
  // Only the old full-report human requirement changes. The existing automatic
  // certainty, contradiction, source and per-finding ceiling rules still apply.
  const decision=publicationDecision(doc.projection,{documentTrack:'automatic'});
  for(const reason of decision.reasons.filter(r=>r!=='full_report'))ctx.addIssue({code:'custom',message:'ai_publication_blocked:'+reason});
  for(const topic of doc.projection.topics){
   if(topic.gate==='checked'&&!topic.basis_complete)ctx.addIssue({code:'custom',message:'ai_publication_incomplete_basis'});
  }
 }
});
export const reportDocumentSchema=z.union([reportDocumentV2Schema,reportDocumentV3Schema]);
export type ReportDocument=z.infer<typeof reportDocumentSchema>;
