import {z} from 'zod';
import {canonicalSha256} from '../../../engine/rule-runtime/canonical';
import {caseReportProjectionSchema,PROJECTION_TOPICS} from './case-report-projection';
const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
/** Delivery envelope v2. Existing safe v1 projections stay readable without invented provenance. */
export const reportDocumentSchema=z.object({
 schema_version:z.literal('tivdoc-report-document-v2'),
 id:z.uuid(),case_id:z.uuid(),order_id:z.uuid(),revision:z.number().int().positive(),
 input_sha256:hash,projection_sha256:hash,
 purchased_period:z.object({from:month,to:month}).strict(),
 projection:caseReportProjectionSchema,
 evidence:z.array(z.object({id:z.uuid(),document_id:z.uuid(),version_id:z.uuid(),sha256:hash,page:z.number().int().positive(),field:z.string().min(1),fact_version:z.string().min(1)}).strict()),
 findings:z.array(z.object({id:z.uuid(),topic:z.enum(PROJECTION_TOPICS),evidence_ids:z.array(z.uuid()).min(1),rule_versions:z.array(z.string().min(1)).min(1),parameter_versions:z.array(z.string().min(1)).min(1)}).strict()),
 publication:z.object({state:z.enum(['draft','approved','published','superseded']),approved_input_sha256:hash.nullable(),approval_actor_kind:z.enum(['human','automation']).nullable(),published_at:z.iso.datetime().nullable()}).strict(),
 correction_policy:z.literal('append_new_revision_preserve_published'),
}).strict().superRefine((doc,ctx)=>{
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
  if(doc.projection.report_kind==='full'&&doc.publication.approval_actor_kind!=='human')fail('full_report_requires_human_review');
 }
});
export type ReportDocument=z.infer<typeof reportDocumentSchema>;
