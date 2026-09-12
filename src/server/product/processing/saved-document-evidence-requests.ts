import 'server-only';
import {z} from 'zod';
import {canonicalSha256} from '@/engine/rule-runtime/canonical';
import {DOCUMENT_EVIDENCE_POLICY,type RawDocumentObservation} from '@/engine/extraction/document-evidence/contracts';
import {savedDocumentEvidenceSchema,validateSavedDocumentEvidence} from '@/server/engine/extraction/saved-document-evidence';
import {loadVerifiedUpload} from '@/server/engine/extraction/verified-upload-source';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {documentEvidenceTarget,documentEvidenceQuestion} from '../reports/document-evidence-reading';
import {admitSavedSource} from './saved-admission';
import {readSavedOrders,purchasedMonths} from './saved-order-scope';
import type {SourceJob} from './source-dispatch';

const attendanceTopics=new Set(['working_time','rest_day','overtime','minimum_wage','travel','sick_leave','vacation','holidays','convalescence']);
const contractTopics=new Set(['contract','bonuses','pension','travel','working_time','rest_day','minimum_wage','sick_leave','vacation','holidays','convalescence']);
const initialSemantics=new Set<RawDocumentObservation['semantic']>(['period_start','period_end']);
/** Exact source admission and the existing SQL opener remain authoritative.
 * Explicit selectors narrow review dependencies; they never authorize a source
 * or a purchased month. Deferred cells remain visible as deferred work. */
export async function openSavedDocumentEvidenceRequests(context:PostgresTransactionContext,job:SourceJob,candidate:unknown,options:{observationIds?:readonly string[];month?:string}={}){
 const requestedMonth=options.month===undefined?null:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u).parse(options.month);
 await admitSavedSource(context,job);
 const checkpoint=savedDocumentEvidenceSchema.parse(candidate);
 if(checkpoint.case_id!==job.case_id)throw Error('REQUEST_FIELD_CASE_MISMATCH');
 const rows=await context.client.query(statement('document_evidence_reading_source',
  `select d.*,c.result from private.case_input_versions v cross join lateral jsonb_array_elements(v.input->'documents') p
   join public.documents d on d.case_id=v.case_id and d.id=(p->>'id')::uuid and d.version_id=(p->>'version_id')::uuid
   join private.case_extraction_checkpoints c on c.case_id=v.case_id and c.revision=v.revision and c.version_id=d.version_id
   where v.case_id=$1::uuid and v.revision=$2 and v.input_sha256=$3 and d.id=$4::uuid and d.version_id=$5::uuid
    and d.content_sha256=p->>'sha256' and c.input_sha256=d.content_sha256 and c.policy_version=$6 and c.result_sha256=$7
    and d.document_type::text=p->>'type' and p->>'type' in ('attendance','contract')`,
  [job.case_id,job.revision,job.input_sha256,checkpoint.product_document_id,checkpoint.version_id,DOCUMENT_EVIDENCE_POLICY,checkpoint.result_sha256]));
 if(rows.row_count!==1||canonicalSha256(rows.rows[0].result)!==canonicalSha256(checkpoint))throw Error('DOCUMENT_EVIDENCE_READING_SOURCE_CHANGED');
 const source=await loadVerifiedUpload(job.case_id,checkpoint.version_id,{async query(){return {rows:[rows.rows[0]]};}},
  {async download(){throw Error('DOCUMENT_EVIDENCE_READING_DOWNLOAD_FORBIDDEN');}});
 const saved=validateSavedDocumentEvidence({checkpoint,document:source.document,productDocumentId:source.productDocumentId,requiredMonths:[]});
 if(saved.run.result.status!=='completed'||!saved.run.result.normalized)return {opened:[],deferred:[],state:'extraction_failed' as const};
 const extraction=saved.run.result.normalized;
 if(extraction.detected_document_type!==extraction.declared_document_type)return {opened:[],deferred:extraction.observations.map(o=>o.observation_id),state:'document_type_unresolved' as const};
 const ids=options.observationIds?z.array(z.string().regex(/^[a-f0-9]{64}$/u)).max(600).parse(options.observationIds):null;
 if(ids&&(new Set(ids).size!==ids.length||ids.some(id=>!extraction.observations.some(o=>o.observation_id===id))))throw Error('DOCUMENT_EVIDENCE_READING_SELECTOR');
 const selected=extraction.observations.filter(o=>ids?ids.includes(o.observation_id):initialSemantics.has(o.original.semantic));
 const deferred=extraction.observations.filter(o=>!selected.includes(o)).map(o=>o.observation_id);
 const orders=await readSavedOrders(context,job),scopes=new Map<string,Set<string>>();
 for(const order of orders)for(const month of purchasedMonths(order))scopes.set(month,new Set([...(scopes.get(month)??[]),...order.topics]));
 const allowedTopics=extraction.declared_document_type==='attendance'?attendanceTopics:contractTopics;
 const eligible=[...scopes].filter(([month,topics])=>(requestedMonth===null||requestedMonth===month)&&[...topics].some(topic=>allowedTopics.has(topic)));
 const opened:{requestId:string;month:string;observationId:string}[]=[];
 for(const [month] of eligible)for(const observation of selected){
  const target=documentEvidenceTarget({checkpoint:saved,document:source.document,productDocumentId:source.productDocumentId,month,observationId:observation.observation_id});
  const result=await context.client.query(statement('document_evidence_reading_open',
   'select private.document_field_request_open($1::uuid,$2,$3,$4::jsonb,$5) id',
   [job.case_id,job.revision,job.input_sha256,JSON.stringify(target),documentEvidenceQuestion(target).question]));
  opened.push({requestId:z.uuid().parse(result.rows[0]?.id),month,observationId:observation.observation_id});
 }
 return {opened,deferred,state:eligible.length?'opened' as const:'outside_purchased_scope' as const};
}
