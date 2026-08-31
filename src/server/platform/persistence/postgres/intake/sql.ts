import { statement, type PostgresParameter, type PostgresStatement } from "../contracts";

type SqlDefinition = Readonly<{ name: string; text: string }>;
const sql = (name: string, text: string): SqlDefinition => Object.freeze({ name, text });

export const INTAKE_SQL = Object.freeze({
  caseSelect: sql("intake_case_select", `select canonical_case_id as case_id, tenant_id, revision::text, lifecycle_state, state_sha256, updated_at::text
from public.engine_case_state where tenant_id = $1 and canonical_case_id = $2`),
  caseInsert: sql("intake_case_insert", `insert into public.engine_case_state
(case_id, tenant_id, canonical_case_id, revision, lifecycle_state, state_sha256, updated_at)
select private.resolve_engine_case_id($2, $1), $2, $1, 1, $3, $4, $5::timestamptz
where $6::bigint = 0 and not exists (select 1 from public.engine_case_state where tenant_id = $2 and canonical_case_id = $1)
returning canonical_case_id as case_id, tenant_id, revision::text, lifecycle_state, state_sha256, updated_at::text`),
  caseUpdate: sql("intake_case_update", `update public.engine_case_state set revision = revision + 1, lifecycle_state = $3,
state_sha256 = $4, updated_at = $5::timestamptz
where tenant_id = $1 and canonical_case_id = $2 and revision = $6::bigint
returning canonical_case_id as case_id, tenant_id, revision::text, lifecycle_state, state_sha256, updated_at::text`),
  lifecycleInsert: sql("intake_lifecycle_insert", `insert into public.engine_case_lifecycle_revisions
(case_id, tenant_id, revision, state_before, state_after, event_kind, command_sha256, event_sha256, previous_sha256, occurred_at)
values (private.resolve_engine_case_id($2, $1), $2, $3::bigint, $4, $5, $6, $7, $8, $9, $10::timestamptz)
on conflict (case_id, revision) do nothing returning revision::text`),
  paymentInsert: sql("intake_payment_insert", `insert into public.engine_payment_evidence_refs
(case_id, tenant_id, evidence_id, evidence_revision, evidence_sha256, status, bound_at)
select private.resolve_engine_case_id($1, $2), $1, $3, $4, $5, $6, $7::timestamptz
where exists (select 1 from public.engine_case_state where tenant_id = $1 and canonical_case_id = $2)
on conflict (case_id, evidence_id, evidence_revision) do update
set evidence_id = public.engine_payment_evidence_refs.evidence_id
where public.engine_payment_evidence_refs.tenant_id = excluded.tenant_id
and public.engine_payment_evidence_refs.evidence_sha256 = excluded.evidence_sha256
and public.engine_payment_evidence_refs.status = excluded.status
and public.engine_payment_evidence_refs.bound_at = excluded.bound_at
returning $2 as case_id, tenant_id, evidence_id, evidence_revision, evidence_sha256, status, bound_at::text`),
  paymentSelect: sql("intake_payment_select", `select $2 as case_id, p.tenant_id, p.evidence_id, p.evidence_revision, p.evidence_sha256, p.status, p.bound_at::text
from public.engine_payment_evidence_refs p join public.engine_case_state c on c.case_id = p.case_id and c.tenant_id = p.tenant_id
where p.tenant_id = $1 and c.canonical_case_id = $2 order by p.bound_at, p.evidence_id, p.evidence_revision`),
  conversationInsert: sql("intake_conversation_insert", `insert into public.case_conversations
(id, case_id, analysis_run_id, status, idempotency_key, created_at, closed_at, tenant_id, canonical_case_id,
 canonical_conversation_id, canonical_analysis_run_id)
select private.canonical_text_uuid('conversation', $3), private.resolve_engine_case_id($1, $2),
case when $4 is null then null else private.canonical_text_uuid('analysis_run', $4) end,
$5, $6, $7::timestamptz, $8::timestamptz, $1, $2, $3, $4
where exists (select 1 from public.engine_case_state where tenant_id = $1 and canonical_case_id = $2)
on conflict (case_id, idempotency_key) do update set id = public.case_conversations.id
where public.case_conversations.canonical_conversation_id = excluded.canonical_conversation_id
and public.case_conversations.analysis_run_id is not distinct from excluded.analysis_run_id
and public.case_conversations.status = excluded.status
and public.case_conversations.closed_at is not distinct from excluded.closed_at
returning canonical_conversation_id as conversation_id, canonical_case_id as case_id, canonical_analysis_run_id as analysis_run_id,
status, idempotency_key, created_at::text, closed_at::text`),
  messageInsert: sql("intake_message_insert", `insert into public.case_messages
(id, case_id, conversation_id, analysis_run_id, role, agent, question_id, question_version, selected_option_ids,
 free_text_answer, content, model_provider, model_identifier, prompt_version, idempotency_key, created_at,
 tenant_id, canonical_case_id, canonical_message_id, canonical_conversation_id, canonical_analysis_run_id)
select private.canonical_text_uuid('message', $3), private.resolve_engine_case_id($1, $2),
private.canonical_text_uuid('conversation', $4),
case when $5 is null then null else private.canonical_text_uuid('analysis_run', $5) end, $6, $7, $8, $9::integer,
array(select jsonb_array_elements_text($10::jsonb)), $11, $12, $13, $14, $15, $16, $17::timestamptz
, $1, $2, $3, $4, $5
where exists (select 1 from public.engine_case_state where tenant_id = $1 and canonical_case_id = $2)
on conflict (conversation_id, idempotency_key) do update set id = public.case_messages.id
where public.case_messages.canonical_message_id = excluded.canonical_message_id
and public.case_messages.analysis_run_id is not distinct from excluded.analysis_run_id
and public.case_messages.role = excluded.role
and public.case_messages.agent is not distinct from excluded.agent
and public.case_messages.question_id is not distinct from excluded.question_id
and public.case_messages.question_version is not distinct from excluded.question_version
and public.case_messages.selected_option_ids = excluded.selected_option_ids
and public.case_messages.free_text_answer is not distinct from excluded.free_text_answer
and public.case_messages.content is not distinct from excluded.content
and public.case_messages.model_provider is not distinct from excluded.model_provider
and public.case_messages.model_identifier is not distinct from excluded.model_identifier
and public.case_messages.prompt_version is not distinct from excluded.prompt_version
returning canonical_message_id as message_id, canonical_case_id as case_id,
canonical_conversation_id as conversation_id, idempotency_key`),
  documentInsert: sql("intake_document_insert", `insert into public.documents
(id, case_id, document_type, storage_path, original_filename, mime_type, size, created_at, declared_type,
 detected_type, classification_confidence, content_sha256, period_start, period_end, supersedes_document_id,
 processing_status, storage_layout, tenant_id, canonical_case_id, canonical_document_id)
select private.canonical_text_uuid('document', $3), private.resolve_engine_case_id($1, $2), $4, $5, $6, $7,
$8::bigint, $9::timestamptz, $4, $10, $11::numeric, $12, $13::date, $14::date,
case when $15 is null then null else private.canonical_text_uuid('document', $15) end, $16, 'immutable_v1', $1, $2, $3
where exists (select 1 from public.engine_case_state where tenant_id = $1 and canonical_case_id = $2)
on conflict (id) do nothing returning canonical_document_id as document_id, canonical_case_id as case_id, content_sha256`),
  artifactInsert: sql("intake_artifact_insert", `insert into public.engine_object_write_sagas
(reservation_id, tenant_id, case_id, opaque_key, expected_sha256, expected_length, detected_mime, retention_class,
 state, revision, staged_sha256, staged_length, object_version_id, visible, created_at, updated_at)
select $3, $1, private.resolve_engine_case_id($1, $2), $4, $5, $6::bigint, $7, $8, $9,
$10::bigint, $11, $12::bigint, $13, $14, $15::timestamptz, $16::timestamptz
where exists (select 1 from public.engine_case_state where tenant_id = $1 and canonical_case_id = $2)
on conflict (reservation_id) do nothing returning reservation_id, revision::text, expected_sha256, state, visible`),
  extractionInsert: sql("intake_extraction_insert", `insert into public.document_extractions
(id, document_id, analysis_run_id, extractor_id, extractor_version, model_version, source_content_sha256, status,
 payload, quality_metrics, raw_artifact_path, idempotency_key, created_at, completed_at, error_code,
 tenant_id, canonical_case_id, canonical_extraction_id, canonical_document_id, canonical_analysis_run_id)
select private.canonical_text_uuid('extraction', $3), private.canonical_text_uuid('document', $4),
case when $5 is null then null else private.canonical_text_uuid('analysis_run', $5) end,
$6, $7, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15::timestamptz, $16::timestamptz, $17,
$1, $2, $3, $4, $5
from public.documents d
where d.tenant_id = $1 and d.canonical_case_id = $2 and d.canonical_document_id = $4
on conflict (document_id, idempotency_key) do update set id = public.document_extractions.id
where public.document_extractions.canonical_extraction_id = excluded.canonical_extraction_id
and public.document_extractions.analysis_run_id is not distinct from excluded.analysis_run_id
and public.document_extractions.extractor_id = excluded.extractor_id
and public.document_extractions.extractor_version = excluded.extractor_version
and public.document_extractions.model_version is not distinct from excluded.model_version
and public.document_extractions.source_content_sha256 = excluded.source_content_sha256
and public.document_extractions.status = excluded.status
and public.document_extractions.payload is not distinct from excluded.payload
and public.document_extractions.quality_metrics = excluded.quality_metrics
and public.document_extractions.raw_artifact_path is not distinct from excluded.raw_artifact_path
and public.document_extractions.completed_at is not distinct from excluded.completed_at
and public.document_extractions.error_code is not distinct from excluded.error_code
returning canonical_extraction_id as extraction_id, canonical_document_id as document_id,
source_content_sha256, status, payload, quality_metrics`),
  factPrior: sql("intake_fact_prior", `select revision::text, payload_sha256 from public.engine_canonical_fact_versions
where tenant_id = $1 and canonical_case_id = $2 and fact_id = $3 order by revision desc limit 1 for update`),
  factInsert: sql("intake_fact_insert", `insert into public.engine_canonical_fact_versions
(fact_id, revision, tenant_id, case_id, analysis_run_id, payload, payload_sha256, created_at,
 canonical_case_id, canonical_analysis_run_id)
select $3, $4::bigint, $1, private.resolve_engine_case_id($1, $2),
case when $5 is null then null else private.canonical_text_uuid('analysis_run', $5) end,
$6::jsonb, $7, $8::timestamptz, $2, $5
where exists (select 1 from public.engine_case_state where tenant_id = $1 and canonical_case_id = $2)
on conflict (fact_id, revision) do nothing returning fact_id, revision::text, payload, payload_sha256`),
  hypothesisInsert: sql("intake_hypothesis_insert", `insert into public.analysis_hypotheses
(id, analysis_run_id, hypothesis_key, category, status, priority, payload, idempotency_key, created_at,
 tenant_id, canonical_case_id, canonical_analysis_run_id, canonical_hypothesis_id)
select private.canonical_text_uuid('hypothesis', $4), private.canonical_text_uuid('analysis_run', $3),
$5, $6, $7, $8, $9::jsonb, $10, $11::timestamptz, $1, $2, $3, $4
from public.analysis_runs r join public.engine_case_state c on c.case_id = r.case_id
where c.tenant_id = $1 and c.canonical_case_id = $2 and r.id = private.canonical_text_uuid('analysis_run', $3)
on conflict (analysis_run_id, idempotency_key) do update set id = public.analysis_hypotheses.id
where public.analysis_hypotheses.canonical_hypothesis_id = excluded.canonical_hypothesis_id
and public.analysis_hypotheses.hypothesis_key = excluded.hypothesis_key
and public.analysis_hypotheses.category = excluded.category
and public.analysis_hypotheses.status = excluded.status
and public.analysis_hypotheses.priority = excluded.priority
and public.analysis_hypotheses.payload = excluded.payload
returning canonical_hypothesis_id as hypothesis_id, canonical_analysis_run_id as analysis_run_id,
hypothesis_key, status, priority, payload, idempotency_key`),
  ruleInputPrior: sql("intake_rule_input_prior", `select revision::text, payload_sha256 from public.engine_rule_input_versions
where tenant_id = $1 and canonical_case_id = $2 and rule_input_id = $3 order by revision desc limit 1 for update`),
  ruleInputInsert: sql("intake_rule_input_insert", `insert into public.engine_rule_input_versions
(rule_input_id, revision, tenant_id, case_id, analysis_run_id, topic, payload, payload_sha256, created_at,
 canonical_case_id, canonical_analysis_run_id)
select $3, $4::bigint, $1, private.resolve_engine_case_id($1, $2), private.canonical_text_uuid('analysis_run', $5),
$6, $7::jsonb, $8, $9::timestamptz, $2, $5
where exists (select 1 from public.engine_case_state where tenant_id = $1 and canonical_case_id = $2)
on conflict (rule_input_id, revision) do nothing returning rule_input_id, revision::text, topic, payload, payload_sha256`),
} satisfies Record<string, SqlDefinition>);

export function intakeStatement(definition: SqlDefinition, values: readonly PostgresParameter[]): PostgresStatement {
  return statement(definition.name, definition.text, values);
}

export const INTAKE_SQL_INVENTORY = Object.freeze(Object.values(INTAKE_SQL).map(({ name, text }) => Object.freeze({
  name, tables: Object.freeze([...text.matchAll(/public\.([a-z_]+)/gu)].map((match) => match[1])),
  parameter_count: Math.max(0, ...[...text.matchAll(/\$(\d+)/gu)].map((match) => Number(match[1]))),
  interpolated: text.includes("${"),
  proof_class: "STATIC_OR_RECORDING_DRIVER_PROOF" as const,
  transaction_context_required: true as const,
})));
