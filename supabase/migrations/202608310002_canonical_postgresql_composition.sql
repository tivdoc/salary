-- Tivdoc V0.9 canonical PostgreSQL composition closure.
-- Forward-only: preserves legacy UUID bytes while adding lossless canonical text identities.

create table if not exists public.engine_schema_metadata (
  component text primary key,
  schema_version text not null,
  migration_id text not null unique,
  installed_at timestamptz not null default transaction_timestamp()
);

create table if not exists public.engine_case_identity (
  internal_case_id uuid primary key default gen_random_uuid(),
  tenant_id text not null,
  canonical_case_id text not null,
  created_at timestamptz not null default transaction_timestamp(),
  unique (tenant_id, canonical_case_id),
  unique (tenant_id, internal_case_id),
  check (length(canonical_case_id) between 1 and 512)
);

insert into public.engine_case_identity (internal_case_id, tenant_id, canonical_case_id)
select case_id, tenant_id, case_id::text
from public.engine_case_state
on conflict do nothing;

create or replace function private.canonical_text_uuid(target_namespace text, target_value text)
returns uuid language sql immutable strict parallel safe set search_path = '' as $$
  select (
    substr(md5(target_namespace || E'\x1f' || target_value), 1, 8) || '-' ||
    substr(md5(target_namespace || E'\x1f' || target_value), 9, 4) || '-' ||
    '4' || substr(md5(target_namespace || E'\x1f' || target_value), 14, 3) || '-' ||
    '8' || substr(md5(target_namespace || E'\x1f' || target_value), 18, 3) || '-' ||
    substr(md5(target_namespace || E'\x1f' || target_value), 21, 12)
  )::uuid
$$;

create or replace function private.resolve_engine_case_id(target_tenant text, target_canonical_case_id text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare resolved uuid;
begin
  if target_tenant is null or target_tenant = '' or target_canonical_case_id is null or target_canonical_case_id = '' then
    raise exception 'Canonical case ownership is required';
  end if;
  insert into public.engine_case_identity (tenant_id, canonical_case_id)
  values (target_tenant, target_canonical_case_id)
  on conflict (tenant_id, canonical_case_id) do nothing;
  select internal_case_id into strict resolved
  from public.engine_case_identity
  where tenant_id = target_tenant and canonical_case_id = target_canonical_case_id;
  return resolved;
end;
$$;

alter table public.engine_case_state add column if not exists canonical_case_id text;
update public.engine_case_state set canonical_case_id = case_id::text where canonical_case_id is null;
alter table public.engine_case_state alter column canonical_case_id set not null;
alter table public.engine_case_state drop constraint if exists engine_case_state_case_id_fkey;
alter table public.engine_case_state
  add constraint engine_case_state_identity_fkey foreign key (case_id)
  references public.engine_case_identity(internal_case_id) on delete restrict not valid;
alter table public.engine_case_state validate constraint engine_case_state_identity_fkey;
create unique index if not exists engine_case_state_canonical_owner_uq
  on public.engine_case_state(tenant_id, canonical_case_id);

-- Canonical identifiers are retained next to historical UUID storage keys.
alter table public.documents add column if not exists tenant_id text;
alter table public.documents add column if not exists canonical_case_id text;
alter table public.documents add column if not exists canonical_document_id text;
alter table public.documents drop constraint if exists documents_case_id_fkey;
alter table public.documents
  add constraint documents_engine_identity_fkey foreign key (case_id)
  references public.engine_case_identity(internal_case_id) on delete restrict not valid;
create unique index if not exists documents_canonical_id_uq
  on public.documents(tenant_id, canonical_document_id) where canonical_document_id is not null;
create index if not exists documents_canonical_case_idx
  on public.documents(tenant_id, canonical_case_id, created_at);

alter table public.case_conversations add column if not exists tenant_id text;
alter table public.case_conversations add column if not exists canonical_case_id text;
alter table public.case_conversations add column if not exists canonical_conversation_id text;
alter table public.case_conversations add column if not exists canonical_analysis_run_id text;
alter table public.case_conversations drop constraint if exists case_conversations_case_id_fkey;
alter table public.case_conversations
  add constraint conversations_engine_identity_fkey foreign key (case_id)
  references public.engine_case_identity(internal_case_id) on delete restrict not valid;
create unique index if not exists conversations_canonical_id_uq
  on public.case_conversations(tenant_id, canonical_conversation_id) where canonical_conversation_id is not null;

alter table public.case_messages add column if not exists tenant_id text;
alter table public.case_messages add column if not exists canonical_case_id text;
alter table public.case_messages add column if not exists canonical_message_id text;
alter table public.case_messages add column if not exists canonical_conversation_id text;
alter table public.case_messages add column if not exists canonical_analysis_run_id text;
alter table public.case_messages drop constraint if exists case_messages_case_id_fkey;
create unique index if not exists messages_canonical_id_uq
  on public.case_messages(tenant_id, canonical_message_id) where canonical_message_id is not null;

alter table public.document_extractions add column if not exists tenant_id text;
alter table public.document_extractions add column if not exists canonical_case_id text;
alter table public.document_extractions add column if not exists canonical_extraction_id text;
alter table public.document_extractions add column if not exists canonical_document_id text;
alter table public.document_extractions add column if not exists canonical_analysis_run_id text;
create unique index if not exists extractions_canonical_id_uq
  on public.document_extractions(tenant_id, canonical_extraction_id) where canonical_extraction_id is not null;

alter table public.analysis_hypotheses add column if not exists tenant_id text;
alter table public.analysis_hypotheses add column if not exists canonical_case_id text;
alter table public.analysis_hypotheses add column if not exists canonical_analysis_run_id text;
alter table public.analysis_hypotheses add column if not exists canonical_hypothesis_id text;
create unique index if not exists hypotheses_canonical_id_uq
  on public.analysis_hypotheses(tenant_id, canonical_hypothesis_id) where canonical_hypothesis_id is not null;

-- Analysis runs retain arbitrary canonical identifiers without coercing them to UUID.
alter table public.analysis_runs add column if not exists tenant_id text;
alter table public.analysis_runs add column if not exists canonical_case_id text;
alter table public.analysis_runs add column if not exists canonical_analysis_run_id text;
alter table public.analysis_runs add column if not exists command_sha256 text;
alter table public.analysis_runs add column if not exists command_payload jsonb;
alter table public.analysis_runs add column if not exists case_revision bigint;
alter table public.analysis_runs add column if not exists completion_payload jsonb;
update public.analysis_runs run
set tenant_id = state.tenant_id,
    canonical_case_id = state.canonical_case_id,
    canonical_analysis_run_id = run.id::text,
    command_sha256 = run.input_snapshot_hash,
    command_payload = run.input_snapshot,
    case_revision = state.revision
from public.engine_case_state state
where state.case_id = run.case_id
  and (run.tenant_id is null or run.canonical_case_id is null or run.canonical_analysis_run_id is null
       or run.command_sha256 is null or run.command_payload is null or run.case_revision is null);
alter table public.analysis_runs alter column tenant_id set not null;
alter table public.analysis_runs alter column canonical_case_id set not null;
alter table public.analysis_runs alter column canonical_analysis_run_id set not null;
alter table public.analysis_runs alter column command_sha256 set not null;
alter table public.analysis_runs alter column command_payload set not null;
alter table public.analysis_runs alter column case_revision set not null;
alter table public.analysis_runs drop constraint if exists analysis_runs_case_id_fkey;
alter table public.analysis_runs
  add constraint analysis_runs_engine_identity_fkey foreign key (case_id)
  references public.engine_case_identity(internal_case_id) on delete restrict not valid;
alter table public.analysis_runs
  add constraint analysis_runs_command_sha_check check (command_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint analysis_runs_command_payload_check check (jsonb_typeof(command_payload) = 'object'),
  add constraint analysis_runs_case_revision_check check (case_revision >= 0),
  add constraint analysis_runs_completion_payload_check check (completion_payload is null or jsonb_typeof(completion_payload) = 'object');
create unique index if not exists analysis_runs_canonical_id_uq
  on public.analysis_runs(canonical_analysis_run_id);
create index if not exists analysis_runs_canonical_owner_case_idx
  on public.analysis_runs(tenant_id, canonical_case_id, created_at desc);

alter table public.engine_canonical_fact_versions add column if not exists canonical_case_id text;
alter table public.engine_canonical_fact_versions add column if not exists canonical_analysis_run_id text;
alter table public.engine_rule_input_versions add column if not exists canonical_case_id text;
alter table public.engine_rule_input_versions add column if not exists canonical_analysis_run_id text;
alter table public.engine_legal_version_pins add column if not exists canonical_case_id text;
alter table public.engine_legal_version_pins add column if not exists canonical_analysis_run_id text;
alter table public.engine_analysis_stage_versions add column if not exists canonical_case_id text;
alter table public.engine_analysis_stage_versions add column if not exists canonical_analysis_run_id text;
alter table public.engine_topic_result_versions add column if not exists canonical_case_id text;
alter table public.engine_topic_result_versions add column if not exists canonical_analysis_run_id text;
alter table public.engine_calculation_trace_versions add column if not exists canonical_case_id text;
alter table public.engine_calculation_trace_versions add column if not exists canonical_analysis_run_id text;

alter table public.analysis_findings add column if not exists tenant_id text;
alter table public.analysis_findings add column if not exists canonical_case_id text;
alter table public.analysis_findings add column if not exists canonical_analysis_run_id text;
alter table public.analysis_findings add column if not exists canonical_finding_id text;
alter table public.case_confirmations add column if not exists tenant_id text;
alter table public.case_confirmations add column if not exists canonical_case_id text;
alter table public.case_confirmations add column if not exists canonical_analysis_run_id text;
alter table public.case_confirmations add column if not exists canonical_confirmation_id text;
alter table public.case_confirmations add column if not exists canonical_source_message_id text;
alter table public.case_confirmations drop constraint if exists case_confirmations_case_id_fkey;
alter table public.case_confirmations
  add constraint confirmations_engine_identity_fkey foreign key (case_id)
  references public.engine_case_identity(internal_case_id) on delete restrict not valid;
create unique index if not exists confirmations_canonical_id_uq
  on public.case_confirmations(tenant_id, canonical_confirmation_id)
  where canonical_confirmation_id is not null;

-- Exact report bytes and approval are bound independently and immutably.
alter table public.engine_report_versions add column if not exists json_sha256 text;
alter table public.engine_report_versions add column if not exists html_sha256 text;
alter table public.engine_report_versions add column if not exists pdf_sha256 text;
alter table public.engine_report_versions add column if not exists artifacts_payload jsonb;
alter table public.engine_report_versions add column if not exists review_eligible boolean not null default false;
alter table public.engine_report_versions add column if not exists canonical_case_id text;
alter table public.engine_report_versions add column if not exists canonical_analysis_run_id text;
alter table public.engine_report_versions
  add constraint engine_report_artifact_hashes_check check (
    (json_sha256 is null and html_sha256 is null and pdf_sha256 is null and artifacts_payload is null and not review_eligible)
    or (json_sha256 ~ '^[0-9a-f]{64}$' and html_sha256 ~ '^[0-9a-f]{64}$'
        and pdf_sha256 ~ '^[0-9a-f]{64}$' and jsonb_typeof(artifacts_payload) = 'object')
  );

alter table public.engine_review_task_versions add column if not exists report_id text;
alter table public.engine_review_task_versions add column if not exists report_revision bigint;
alter table public.engine_review_task_versions add column if not exists report_sha256 text;
alter table public.engine_review_task_versions add column if not exists release_state text;
alter table public.engine_review_task_versions add column if not exists canonical_case_id text;
alter table public.engine_review_task_versions
  add constraint engine_review_report_binding_check check (
    (report_id is null and report_revision is null and report_sha256 is null and release_state is null)
    or (task_kind = 'report_approval' and report_id is not null and report_revision > 0
        and report_sha256 ~ '^[0-9a-f]{64}$'
        and release_state in ('review_pending', 'approved', 'release_hold', 'released', 'invalidated'))
  ),
  add constraint engine_review_report_fk foreign key (report_id, report_revision)
    references public.engine_report_versions(report_id, revision) on delete restrict not valid;
create unique index if not exists engine_one_active_report_approval_uq
  on public.engine_review_task_versions(case_id, report_id, report_revision, report_sha256)
  where task_kind = 'report_approval' and invalidated_at is null and release_state = 'approved';

-- Idempotency receipts commit with domain/audit/outbox effects in the same transaction.
alter table public.engine_idempotency_records add column if not exists canonical_case_id text;
alter table public.engine_idempotency_records add column if not exists result_payload jsonb;
alter table public.engine_idempotency_records drop constraint if exists engine_idempotency_records_check;
alter table public.engine_idempotency_records
  add constraint engine_idempotency_commit_binding_check check (
    (state = 'reserved' and result_sha256 is null and result_payload is null and committed_at is null)
    or (state = 'committed' and result_sha256 ~ '^[0-9a-f]{64}$'
        and jsonb_typeof(result_payload) = 'object' and committed_at is not null)
  ),
  add constraint engine_idempotency_canonical_case_required
    check (canonical_case_id is not null) not valid;
create index if not exists engine_idempotency_case_scope_idx
  on public.engine_idempotency_records(tenant_id, canonical_case_id, scope);

alter table public.engine_durable_jobs add column if not exists canonical_case_id text;
alter table public.engine_job_history add column if not exists tenant_id text;
alter table public.engine_job_history add column if not exists canonical_case_id text;
update public.engine_job_history history
set tenant_id = job.tenant_id, canonical_case_id = job.canonical_case_id
from public.engine_durable_jobs job
where job.job_id = history.job_id and history.tenant_id is null;
alter table public.engine_outbox_events add column if not exists canonical_case_id text;
alter table public.engine_platform_audit_events add column if not exists canonical_case_id text;
alter table public.engine_platform_audit_events add column if not exists case_sequence bigint;
update public.engine_platform_audit_events event
set canonical_case_id = event.case_id::text,
    case_sequence = ordered.case_sequence
from (
  select sequence, row_number() over (partition by tenant_id, case_id order by sequence) as case_sequence
  from public.engine_platform_audit_events
) ordered
where ordered.sequence = event.sequence and event.case_sequence is null;
alter table public.engine_platform_audit_events
  add constraint engine_audit_case_sequence_positive check (case_sequence is null or case_sequence > 0),
  add constraint engine_audit_canonical_case_required
    check (canonical_case_id is not null and case_sequence is not null) not valid;
create unique index if not exists engine_audit_canonical_chain_uq
  on public.engine_platform_audit_events(tenant_id, canonical_case_id, case_sequence)
  where canonical_case_id is not null and case_sequence is not null;
create index if not exists engine_jobs_canonical_claim_idx
  on public.engine_durable_jobs(tenant_id, state, available_at, fencing_token, job_id);
create index if not exists engine_outbox_canonical_claim_idx
  on public.engine_outbox_events(tenant_id, state, created_at, fencing_token, outbox_id);

-- Claim functions reject exhausted jobs and advance fencing monotonically.
create or replace function private.claim_engine_platform_jobs(
  target_worker text,
  observed_now timestamptz,
  lease_duration interval,
  claim_limit integer
)
returns setof public.engine_durable_jobs
language sql security definer set search_path = '' as $$
  with candidates as (
    select job_id from public.engine_durable_jobs
    where attempt_count < max_attempts and (
      (state in ('queued', 'retry_wait') and available_at <= observed_now)
      or (state in ('leased', 'running') and lease_expires_at <= observed_now)
    )
    order by available_at, job_id
    for update skip locked
    limit greatest(least(claim_limit, 100), 0)
  )
  update public.engine_durable_jobs job
  set state = 'leased', revision = job.revision + 1,
      attempt_count = job.attempt_count + 1, lease_owner = target_worker,
      lease_expires_at = observed_now + lease_duration,
      fencing_token = job.fencing_token + 1,
      cancellation_requested = false, updated_at = observed_now
  from candidates
  where job.job_id = candidates.job_id
  returning job.*
$$;

-- RLS remains service-mediated; tenant context is mandatory for canonical rows.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'engine_case_identity', 'engine_case_state', 'engine_case_lifecycle_revisions',
    'engine_payment_evidence_refs', 'engine_canonical_fact_versions',
    'engine_rule_input_versions', 'engine_legal_version_pins',
    'engine_analysis_stage_versions', 'engine_topic_result_versions',
    'engine_calculation_trace_versions', 'engine_report_versions',
    'engine_review_task_versions', 'engine_idempotency_records',
    'engine_durable_jobs', 'engine_job_history', 'engine_outbox_events',
    'engine_logical_effect_receipts', 'engine_platform_audit_events'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists tivdoc_service_tenant_scope on public.%I', table_name);
    execute format(
      'create policy tivdoc_service_tenant_scope on public.%I to service_role using (tenant_id = current_setting(''tivdoc.tenant_id'', true)) with check (tenant_id = current_setting(''tivdoc.tenant_id'', true))',
      table_name
    );
  end loop;
end;
$$;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'canonical_postgresql_composition',
  'tivdoc-canonical-postgresql-v0.9.0',
  '202608310002_canonical_postgresql_composition'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

revoke all on table public.engine_schema_metadata, public.engine_case_identity from public, anon, authenticated;
grant select on table public.engine_schema_metadata to service_role;
grant select, insert on table public.engine_case_identity to service_role;
revoke all on function private.canonical_text_uuid(text, text) from public, anon, authenticated;
revoke all on function private.resolve_engine_case_id(text, text) from public, anon, authenticated;
grant execute on function private.canonical_text_uuid(text, text) to service_role;
grant execute on function private.resolve_engine_case_id(text, text) to service_role;

comment on table public.engine_case_identity is
  'Lossless tenant-scoped canonical text identity mapped to an internal PostgreSQL UUID storage key.';
comment on table public.engine_schema_metadata is
  'Fail-closed startup compatibility marker for the single canonical PostgreSQL composition root.';
