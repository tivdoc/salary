import {projectSourceIntakeUploadContext,sourceIntakeUploadContextSchema} from '../documents/source-intake-upload.ts';
import {legacySourceDocumentNeedTarget} from '../reports/document-source-period-intake.ts';
import {z} from 'zod';
import {canonicalSha256,deepFreeze} from '@/engine/rule-runtime/canonical';
import {statement,type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import type {SourceJob} from './source-dispatch.ts';
import {savedLegacySourceIntake,legacySourceIntakeRequests,sourceIntakeTechnicalDependencies,sourceIntakeUnresolvedDocuments,effectiveLegacySourcePeriods,sourceIntakeFullMonths,type SavedLegacySourceIntake} from './saved-legacy-source-intake.ts';
import type {SavedExecutionOrder} from './saved-order-scope.ts';
const month=z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u);
export type SavedSourceIntakeHold={orderId:string;month:string|null;code:string};
export class SavedSourceIntakeRequired extends Error{
 constructor(readonly detail:{job:SourceJob;held:readonly SavedSourceIntakeHold[];openedRequestIds:readonly string[];technicalDependencies:readonly unknown[];analyzedMonths:number}){super('SAVED_SOURCE_INTAKE_REQUIRED');}
}
/** Pure per-document routing. A source reading cannot rewrite stored metadata,
 * lend another document a month or select one month out of a multi-month file. */
export function savedSourceDocumentRoute(orders:readonly SavedExecutionOrder[],document:{id:string;version_id:string;sha256?:string;type:string;month:string|null},defaultMonth:string|null){
 if(orders.some(o=>o.kind==='legacy_initial'&&o.source_period_evidence?.conflicts.includes(document.version_id)))return {state:'held' as const,code:'source_period_conflict'};
 const evidence=orders.flatMap(o=>o.kind==='legacy_initial'?o.source_period_evidence?.periods??[]:[]).filter(p=>p.source_pins.some(pin=>pin.document_id===document.id&&pin.version_id===document.version_id&&pin.source_sha256===document.sha256));
 if(evidence.length){
  const kinds=[...new Set(evidence.map(p=>p.source_document_kind))],months=[...new Set(evidence.flatMap(p=>sourceIntakeFullMonths(p.period)))].sort();
  if(kinds.length!==1)return {state:'held' as const,code:'source_kind_conflict'};
  if(kinds[0]!==document.type)return {state:'held' as const,code:'source_kind_dispatch_required'};
  if(months.length!==1)return {state:'held' as const,code:'source_multi_month_dispatch_required'};
  if(document.month!==null&&document.month!==months[0])return {state:'held' as const,code:'source_stored_period_conflict'};
  return {state:'ready' as const,kind:kinds[0],month:months[0],reading_sha256s:evidence.map(p=>p.reading_sha256)};
 }
 const selected=document.month??(orders.some(o=>o.kind==='legacy_initial'&&o.legacy_scope.period_state==='missing')?null:defaultMonth);
 if(selected===null)return {state:'held' as const,code:'source_period_required'};
 return {state:'ready' as const,kind:document.type,month:month.parse(selected),reading_sha256s:[]};
}
export function needsSavedSourceIntake(job:SourceJob,journal:unknown){
 if(job.processing_profile!=='qualified_ai_v1')return false;
 const j=z.object({documents:z.array(z.unknown()),legacy_orders:z.array(z.object({period_state:z.string()})).optional()}).parse(journal);
 return !!j.legacy_orders?.length&&(j.documents.length===0||j.legacy_orders.some(s=>s.period_state==='missing'));
}
// A pg connection retains prepared statement names across worker transactions.
// Each RPC therefore has one stable name and byte-identical SQL at every caller.
function sourceIntakeRequestStatement(kind:'document_field'|'document',job:SourceJob,target:unknown,question:string){
 const values=[job.case_id,job.revision,job.input_sha256,JSON.stringify(target),question];
 return kind==='document_field'
  ?statement('saved_runner_source_intake_field_open','select private.document_field_request_open($1::uuid,$2,$3,$4::jsonb,$5) id',values)
  :statement('saved_runner_source_intake_document_open','select private.legacy_source_document_request_open($1::uuid,$2,$3,$4::jsonb,$5) id',values);
}
export async function prepareSavedSourceIntake(context:PostgresTransactionContext,job:SourceJob,journal:unknown){
 if(!needsSavedSourceIntake(job,journal))return null;
 const rows=await context.client.query(statement('saved_runner_source_intake_context','select private.legacy_source_intake_context($1::uuid,$2,$3) context',[job.case_id,job.revision,job.input_sha256]));
 const saved=savedLegacySourceIntake(rows.rows[0]?.context);
 if(rows.row_count!==1||saved.case_id!==job.case_id||saved.revision!==job.revision||saved.head.input_sha256!==job.input_sha256||canonicalSha256(saved.head.input)!==canonicalSha256(journal))throw Error('SOURCE_INTAKE_CURRENT_HASH');
 const openedRequestIds:string[]=[];
 for(const request of legacySourceIntakeRequests(saved)){
  const rows=await context.client.query(sourceIntakeRequestStatement(request.kind==='document_field'?'document_field':'document',job,request.target,request.question.question));
  if(rows.row_count!==1)throw Error('SOURCE_INTAKE_REQUEST_ACK');const id=z.uuid().nullable().parse(rows.rows[0]?.id);if(id)openedRequestIds.push(id);
 }
 const held:SavedSourceIntakeHold[]=saved.scopes.flatMap<SavedSourceIntakeHold>(scope=>{
  const months=[...new Set([...scope.periods,...effectiveLegacySourcePeriods(scope,saved).periods].flatMap(p=>sourceIntakeFullMonths(p.period)))];
  if(!months.length)return [{orderId:scope.id,month:null,code:'source_period_required'}];
  if(!saved.documents.length)return months.map(month=>({orderId:scope.id,month,code:'source_document_required'}));
  return scope.period_state==='missing'&&sourceIntakeUnresolvedDocuments(saved,scope).length?[{orderId:scope.id,month:null,code:'source_period_required'}]:[];
 });
 return deepFreeze({saved,held,openedRequestIds,technicalDependencies:[...sourceIntakeTechnicalDependencies(saved),...saved.readings.flatMap(r=>{const d=saved.documents.find(d=>d.version_id===r.target.version_id);return r.answer.action==='correct'&&d&&r.answer.value.document_kind!==d.type?[{code:'source_kind_dispatch_required',document_id:d.id,version_id:d.version_id,source_sha256:d.sha256,stored_kind:d.type,source_document_kind:r.answer.value.document_kind}]:[];})]});
}
export function intakeHasExecutableScope(saved:SavedLegacySourceIntake,journal:unknown){
 const modern=z.object({orders:z.array(z.unknown()).optional()}).parse(journal).orders??[];
 return modern.length>0||saved.scopes.some(s=>[...s.periods,...effectiveLegacySourcePeriods(s,saved).periods].some(p=>sourceIntakeFullMonths(p.period).length));
}

/** The immutable invocation keeps the already authenticated source evidence.
 * This validates its identity and arithmetic coverage again on late delivery;
 * issuing that evidence remains restricted to current admission / SQL. */
export function assertSavedSourcePeriodEvidence(raw:unknown,source:{caseId:string;documentId:string;versionId:string;sha256:string;month:string}){
 const sha=z.string().regex(/^[a-f0-9]{64}$/u);
 const evidence=z.object({schema_version:z.literal('legacy-customer-source-periods-v1'),order_id:z.uuid(),order_receipt_sha256:sha,
  origin:z.literal('customer_document_reading'),purchase_period_unchanged:z.literal(true),
  periods:z.array(z.object({period:z.object({from:z.iso.date(),to:z.iso.date()}).strict(),source_document_kind:z.enum(['payslip','attendance']),reading_sha256:sha,
   source_pins:z.array(z.object({case_id:z.uuid(),document_id:z.uuid(),version_id:z.uuid(),source_sha256:sha}).strict()).min(1)}).strict()),
  conflicts:z.array(z.string()),evidence_sha256:sha}).strict().parse(raw);
 const {evidence_sha256,...body}=evidence;
 if(canonicalSha256(body)!==evidence_sha256||evidence.conflicts.includes(source.versionId))throw Error('SAVED_EXTRACTION_PERIOD_EVIDENCE');
 const rows=evidence.periods.filter(p=>p.source_pins.some(pin=>pin.case_id===source.caseId&&pin.document_id===source.documentId&&pin.version_id===source.versionId&&pin.source_sha256===source.sha256));
 const months=[...new Set(rows.flatMap(p=>sourceIntakeFullMonths(p.period)))];
 if(!rows.length||rows.some(p=>p.source_document_kind!=='payslip')||months.length!==1||months[0]!==source.month)throw Error('SAVED_EXTRACTION_PERIOD_EVIDENCE');
 return evidence;
}
export function savedSourcePeriodEvidence(orders:readonly SavedExecutionOrder[],source:Parameters<typeof assertSavedSourcePeriodEvidence>[1]){
 const candidates=orders.flatMap(o=>o.kind==='legacy_initial'&&o.source_period_evidence?[o.source_period_evidence]:[])
  .filter(e=>e.periods.some(p=>p.source_pins.some(pin=>pin.document_id===source.documentId&&pin.version_id===source.versionId&&pin.source_sha256===source.sha256)))
  .sort((a,b)=>a.order_id.localeCompare(b.order_id));
 return candidates.length?assertSavedSourcePeriodEvidence(candidates[0],source):null;
}

/** Missing financial sources are scoped upload requests, not fabricated monthly
 * snapshots. A classification software gap is deliberately not a fact request. */
export async function openSavedSourceFinancialNeeds(context:PostgresTransactionContext,job:SourceJob,saved:SavedLegacySourceIntake,held:readonly SavedSourceIntakeHold[]){
 const opened:string[]=[];
 for(const h of held){
  if(h.code!=='source_financial_document_required'||!h.month)continue;
  const scope=saved.scopes.find(s=>s.id===h.orderId);if(!scope)continue;
  const target=legacySourceDocumentNeedTarget({scope,anchor:saved.head,month:h.month});
  const rows=await context.client.query(sourceIntakeRequestStatement('document',job,target,`נא לצרף תלוש שכר מלא לחודש ${h.month}. אין כרגע תלוש שכר המשויך לתקופה זו.`));
  if(rows.row_count!==1)throw Error('SOURCE_INTAKE_REQUEST_ACK');const id=z.uuid().nullable().parse(rows.rows[0]?.id);if(id)opened.push(id);
 }
 return opened;
}

/** Source upload satisfaction is replayed from the same authenticated head.
 * This receipt does not say the purchased financial analysis is complete. */
export async function recordSavedSourceIntakeUploadAssessments(context:PostgresTransactionContext,job:SourceJob,journal:unknown){
 const result=await context.client.query(statement('saved_runner_source_upload_context',
  'select private.legacy_source_upload_assessment_context($1::uuid,$2,$3) contexts',[job.case_id,job.revision,job.input_sha256]));
 if(result.row_count!==1)throw Error('SOURCE_INTAKE_UPLOAD_CONTEXT_REQUIRED');
 const rows=z.array(sourceIntakeUploadContextSchema).parse(result.rows[0]?.contexts);
 let recorded=0;
 for(const row of rows){
  if(!row.receipt)continue;
  const source=savedLegacySourceIntake(row.journalContext);
  if(source.case_id!==job.case_id||source.revision!==job.revision||source.head.input_sha256!==job.input_sha256||canonicalSha256(source.head.input)!==canonicalSha256(journal))throw Error('SOURCE_INTAKE_CURRENT_HASH');
  const projected=projectSourceIntakeUploadContext(row,job.case_id);
  if(!projected.assessment)continue;
  const saved=await context.client.query(statement('saved_runner_source_upload_assessment',
   'select private.legacy_source_upload_assessment_record($1::uuid,$2,$3,$4::jsonb) recorded',
   [job.case_id,job.revision,job.input_sha256,JSON.stringify(projected.assessment)]));
  if(saved.row_count!==1)throw Error('SOURCE_INTAKE_UPLOAD_ASSESSMENT_ACK');recorded++;
 }
 return recorded;
}
