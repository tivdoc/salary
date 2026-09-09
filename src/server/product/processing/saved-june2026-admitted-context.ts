import 'server-only';
import {z} from 'zod';
import {employmentSnapshotSchema} from '@/engine/facts/snapshot';
import {ruleInputSnapshotSchema} from '@/engine/wave1/contracts';
import {canonicalSha256, deepFreeze} from '@/engine/rule-runtime/canonical';
import {prepareJune2026AdmittedContext} from '@/engine/minimum-wage-june2026/admitted-context';
import {decodeCommand, decodeStage} from '@/server/platform/persistence/postgres/analysis/validation';
import {statement, type PostgresTransactionContext} from '@/server/platform/persistence/postgres/contracts';
import {lockCurrentSource, sourceJobSchema, type SourceJob} from './source-dispatch';
import {savedCaseTenant} from './saved-admission';
import {readSavedOrders, savedMonthIdempotencyKey} from './saved-order-scope';
import {SavedCaseSnapshot, SAVED_EXTRACTION_POLICY} from './saved-snapshot';
import {readSavedJune2026Collection} from './saved-june2026-collection';
import {readSavedExtractionProvenance} from './live-extraction-provenance';

const sha = z.string().regex(/^[a-f0-9]{64}$/u);
const runSchema = z.object({analysis_run_id: z.uuid(), case_id: z.uuid(), command: z.unknown(), command_sha256: sha,
  idempotency_key: z.string(), source_revision: z.coerce.number().int().safe().positive(), source_input_sha256: sha, actual_input_sha256: sha});
const checkpointRowSchema = z.object({product_document_id: z.uuid(), version_id: z.uuid(), content_sha256: sha, mime_type: z.string(),
  size: z.coerce.number().int().safe().positive(), checkpoint_input_sha256: sha, checkpoint_result_sha256: sha, result: z.unknown()});
const factsStageSchema = z.object({facts: employmentSnapshotSchema, facts_snapshot_sha256: sha}).strict();
const unsupported = ['multiple_documents', 'legacy_source_provenance', 'legacy_source_page_count', 'extraction_incomplete'] as const;
type Unsupported = typeof unsupported[number];

function blocked(code: Unsupported, caseId: string, analysisRunId: string) {
  return deepFreeze({schema_version: 'saved-june2026-factual-context-v1', state: 'context_blocked' as const, code,
    case_id: caseId, analysis_run_id: analysisRunId, legal_activation: false, publication_allowed: false});
}

/** Run only inside the current source's provisioned worker transaction. No
 * command/facts/confirmation supplied by the callback is an authority: all are
 * loaded again through persisted run/stage rows and the actual input journal.
 * Unsupported historical receipts are a review diagnostic, not a queue error;
 * malformed hashes, foreign authority and changed sources still fail closed. */
export async function loadSavedJune2026AdmittedContext(input: {
  context: PostgresTransactionContext; job: SourceJob; orderId: string; analysisRunId: string;
}) {
  const {context} = input, job = sourceJobSchema.parse(input.job), orderId = z.uuid().parse(input.orderId), analysisRunId = z.uuid().parse(input.analysisRunId);
  if (job.mode !== 'draft') throw Error('SAVED_LIVE_COMPOSITION_NOT_ENABLED');
  const tenantId = savedCaseTenant(job.case_id);
  const authority = await context.client.query(statement('saved_june_context_authority',
    'select private.runtime_verified_tenant() tenant_id, session_user::text principal', []));
  if (authority.rows.length !== 1 || authority.rows[0].tenant_id !== tenantId || authority.rows[0].principal !== 'tivdoc_worker_runtime') throw Error('SAVED_WORKER_SCOPE_FORBIDDEN');
  await lockCurrentSource(context, job);
  const [order] = await readSavedOrders(context, job, orderId);
  if (!order.topics.includes('minimum_wage') || order.from > '2026-06-01' || order.to < '2026-06-01') throw Error('SAVED_JUNE_CONTEXT_ORDER_SCOPE');
  const runRows = await context.client.query(statement('saved_june_context_run',
    `select ar.canonical_analysis_run_id analysis_run_id, ar.canonical_case_id case_id, ar.command_payload command,
      ar.command_sha256, ar.idempotency_key, v.revision source_revision, v.input_sha256 source_input_sha256,
      encode(sha256(convert_to(v.input::text,'UTF8')),'hex') actual_input_sha256
     from public.analysis_runs ar join private.case_input_versions v
       on v.case_id::text=ar.canonical_case_id
       and ar.command_payload->>'document_snapshot_id'='saved-documents:2026-06:'||v.input_sha256
       and ar.command_payload->>'extraction_snapshot_id'='saved-extractions:2026-06:'||v.input_sha256
       and ar.command_payload->>'declared_fact_snapshot_id'='saved-declarations:2026-06:'||v.input_sha256
     where ar.tenant_id=$1 and ar.canonical_case_id=$2 and ar.canonical_analysis_run_id=$3
       and ar.status in ('running','completed')`, [tenantId, job.case_id, analysisRunId]));
  if (runRows.rows.length !== 1) throw Error('SAVED_JUNE_CONTEXT_RUN_REQUIRED');
  const run = runSchema.parse(runRows.rows[0]), command = decodeCommand(run.command);
  if (run.case_id !== job.case_id || run.analysis_run_id !== analysisRunId || command.case_id !== job.case_id
    || run.source_revision !== job.revision || run.source_input_sha256 !== job.input_sha256 || run.actual_input_sha256 !== job.input_sha256
    || command.mode !== 'real' || command.period.start_date !== '2026-06-01' || command.period.end_date !== '2026-06-30'
    || canonicalSha256(command) !== run.command_sha256 || run.idempotency_key !== savedMonthIdempotencyKey(job, orderId, '2026-06')
    || command.idempotency_key !== run.idempotency_key || canonicalSha256(command.requested_topics) !== canonicalSha256(order.topics)) throw Error('SAVED_JUNE_CONTEXT_RUN_BINDING');
  const stageRows = await context.client.query(statement('saved_june_context_stages',
    `select s.stage,s.payload,s.payload_sha256 from public.engine_analysis_stage_versions s
     join public.analysis_runs ar on ar.id=s.analysis_run_id
     where ar.tenant_id=$1 and ar.canonical_case_id=$2 and ar.canonical_analysis_run_id=$3
       and s.tenant_id=ar.tenant_id and s.case_id=ar.case_id
       and s.stage in ('input_snapshot','canonical_facts','rule_inputs')`, [tenantId, job.case_id, analysisRunId]));
  const stages = stageRows.rows.map(decodeStage);
  if (stages.length !== 3 || new Set(stages.map(stage => stage.stage)).size !== 3) throw Error('SAVED_JUNE_CONTEXT_STAGES_REQUIRED');
  const canonicalStage = factsStageSchema.parse(stages.find(stage => stage.stage === 'canonical_facts')?.payload);
  const ruleInputs = z.object({rule_inputs: z.array(ruleInputSnapshotSchema).min(1).max(7)}).strict().parse(stages.find(stage => stage.stage === 'rule_inputs')?.payload).rule_inputs;
  const topicIndex = command.requested_topics.indexOf('minimum_wage');
  if (topicIndex < 0 || ruleInputs.length !== command.requested_topics.length) throw Error('SAVED_JUNE_CONTEXT_RULE_INPUTS');
  const inputStage = z.object({command_sha256: sha, document_snapshot_sha256: sha, extraction_snapshot_sha256: sha, declared_fact_snapshot_sha256: sha})
    .parse(stages.find(stage => stage.stage === 'input_snapshot')?.payload);
  if (inputStage.command_sha256 !== run.command_sha256 || inputStage.document_snapshot_sha256 !== command.document_snapshot_sha256
    || inputStage.extraction_snapshot_sha256 !== command.extraction_snapshot_sha256 || inputStage.declared_fact_snapshot_sha256 !== command.declared_fact_snapshot_sha256) throw Error('SAVED_JUNE_CONTEXT_INPUT_STAGE');
  // This reuses the existing journal/source/currentness checks and reconstructs
  // document readings from their authenticated request+answer revision, rather
  // than trusting a confirmation-shaped object in a canonical fact.
  const snapshot = await new SavedCaseSnapshot(context, job, '2026-06').loadPinned(command);
  if (snapshot.documents.length !== 1 || snapshot.extractions.length !== 1) return blocked('multiple_documents', job.case_id, analysisRunId);
  const document = snapshot.documents[0], extraction = snapshot.extractions[0], actualReadings = extraction.customer_readings ?? [];
  for (const fact of canonicalStage.facts.facts) for (const source of fact.provenance) {
    if (source.source_type !== 'documented') continue;
    if (source.customer_confirmation && !actualReadings.some(reading => canonicalSha256(reading) === canonicalSha256(source.customer_confirmation))) throw Error('SAVED_JUNE_CONTEXT_READING_NOT_IN_JOURNAL');
    if (source.read_by === 'machine' && source.verified === true && !source.customer_confirmation) throw Error('SAVED_JUNE_CONTEXT_UNATTRIBUTED_READING');
  }
  const checkpointRows = await context.client.query(statement('saved_june_context_checkpoint',
    `select d.id product_document_id,d.version_id,d.content_sha256,d.mime_type,d.size,
       c.input_sha256 checkpoint_input_sha256,c.result_sha256 checkpoint_result_sha256,c.result
     from public.documents d join private.case_extraction_checkpoints c on c.case_id=d.case_id and c.version_id=d.version_id
     where d.case_id=$1::uuid and d.version_id=$2::uuid and c.revision=$3 and c.policy_version=$4`,
    [job.case_id, document.document_id, job.revision, SAVED_EXTRACTION_POLICY]));
  if (checkpointRows.rows.length !== 1) throw Error('SAVED_JUNE_CONTEXT_CHECKPOINT_REQUIRED');
  const row = checkpointRowSchema.parse(checkpointRows.rows[0]);
  const header = z.object({case_id: z.uuid(), product_document_id: z.uuid(), version_id: z.uuid(), input_sha256: sha, result_sha256: sha,
    run: z.object({result: z.unknown(), provider_receipts: z.array(z.unknown()).optional()})}).parse(row.result);
  const {customer_readings, ...machineExtraction} = extraction; void customer_readings;
  const originalExtraction = z.object({final_extraction: z.unknown()}).parse(header.run.result).final_extraction;
  if (row.content_sha256 !== document.content_sha256 || row.checkpoint_input_sha256 !== document.content_sha256 || header.input_sha256 !== document.content_sha256
    || header.product_document_id !== row.product_document_id || header.version_id !== document.document_id || row.version_id !== document.document_id || header.case_id !== job.case_id
    || row.checkpoint_result_sha256 !== header.result_sha256 || canonicalSha256(header.run.result) !== header.result_sha256
    || canonicalSha256(machineExtraction) !== canonicalSha256(originalExtraction)) throw Error('SAVED_JUNE_CONTEXT_CHECKPOINT_BINDING');
  if (header.run.provider_receipts === undefined) return blocked('legacy_source_provenance', job.case_id, analysisRunId);
  const provenance = readSavedExtractionProvenance(row.result);
  if (provenance.kind === 'unproven_legacy') return blocked('legacy_source_provenance', job.case_id, analysisRunId);
  if (!provenance.allPassesSucceeded) return blocked('extraction_incomplete', job.case_id, analysisRunId);
  if (!provenance.receipts.length || provenance.receipts.some(receipt => receipt.source_page_count === undefined)) return blocked('legacy_source_page_count', job.case_id, analysisRunId);
  const pageCount = provenance.receipts[0].source_page_count!;
  if (provenance.receipts.some(receipt => receipt.source_page_count !== pageCount || receipt.source_size_bytes !== row.size || receipt.source_mime_type !== row.mime_type)) throw Error('SAVED_JUNE_CONTEXT_SOURCE_BYTES_BINDING');
  const collection = await readSavedJune2026Collection(context, job);
  const admitted = prepareJune2026AdmittedContext({current: {case_id: job.case_id, analysis_run_id: analysisRunId, input_revision: job.revision, input_sha256: job.input_sha256,
    order_id: orderId, month: '2026-06', topics: order.topics, document: {product_document_id: row.product_document_id, version_id: document.document_id, sha256: document.content_sha256, page_count: pageCount}},
    saved: {case_id: run.case_id, analysis_run_id: run.analysis_run_id, input_revision: run.source_revision, input_sha256: run.source_input_sha256,
      order_id: order.id, month: '2026-06'}, canonicalStage, ruleInput: ruleInputs[topicIndex], checkpoint: row.result, extractionPolicyVersion: SAVED_EXTRACTION_POLICY, collection});
  return deepFreeze({schema_version: 'saved-june2026-factual-context-v1', state: 'context_loaded' as const, context: admitted, provenance,
    persisted_stage_sha256s: Object.fromEntries(stages.map(stage => [stage.stage, stage.payload_sha256])), command_sha256: run.command_sha256,
    legal_activation: false, publication_allowed: false});
}
export type SavedJune2026AdmittedContext = Awaited<ReturnType<typeof loadSavedJune2026AdmittedContext>>;
