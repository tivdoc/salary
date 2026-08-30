-- Tivdoc V0.7 engine platform persistence. Forward-only and intentionally
-- unapplied: a proven disposable local PostgreSQL target was unavailable.

create table if not exists public.engine_case_state (
  case_id uuid primary key references public.cases(id) on delete restrict,
  tenant_id text not null,
  revision bigint not null default 0 check (revision >= 0),
  lifecycle_state text not null check (lifecycle_state in (
    'awaiting_payment', 'awaiting_documents', 'awaiting_extraction_review',
    'awaiting_fact_resolution', 'ready_for_legal_evaluation',
    'awaiting_legal_review', 'awaiting_report_approval', 'report_ready',
    'release_hold', 'delivered', 'cancelled'
  )),
  state_sha256 text not null check (state_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz not null,
  unique (tenant_id, case_id)
);

create table if not exists public.engine_case_lifecycle_revisions (
  case_id uuid not null references public.engine_case_state(case_id) on delete restrict,
  tenant_id text not null,
  revision bigint not null check (revision >= 0),
  state_before text,
  state_after text not null,
  event_kind text not null,
  command_sha256 text not null check (command_sha256 ~ '^[0-9a-f]{64}$'),
  event_sha256 text not null check (event_sha256 ~ '^[0-9a-f]{64}$'),
  previous_sha256 text check (previous_sha256 is null or previous_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null,
  primary key (case_id, revision),
  unique (event_sha256)
);

create table if not exists public.engine_payment_evidence_refs (
  case_id uuid not null references public.engine_case_state(case_id) on delete restrict,
  tenant_id text not null,
  evidence_id text not null,
  evidence_revision text not null,
  evidence_sha256 text not null check (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null check (status in ('settled', 'pending', 'failed', 'cancelled', 'refunded', 'chargeback')),
  bound_at timestamptz not null,
  primary key (case_id, evidence_id, evidence_revision),
  unique (case_id, evidence_sha256)
);

create table if not exists public.engine_canonical_fact_versions (
  fact_id text not null,
  revision bigint not null check (revision > 0),
  tenant_id text not null,
  case_id uuid not null references public.engine_case_state(case_id) on delete restrict,
  analysis_run_id uuid references public.analysis_runs(id) on delete restrict,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  primary key (fact_id, revision),
  unique (case_id, payload_sha256)
);

create table if not exists public.engine_rule_input_versions (
  rule_input_id text not null,
  revision bigint not null check (revision > 0),
  tenant_id text not null,
  case_id uuid not null references public.engine_case_state(case_id) on delete restrict,
  analysis_run_id uuid not null references public.analysis_runs(id) on delete restrict,
  topic text not null check (topic in ('minimum_wage', 'working_time', 'pension', 'travel', 'convalescence', 'vacation', 'sick_leave')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  primary key (rule_input_id, revision),
  unique (analysis_run_id, topic, payload_sha256)
);

create table if not exists public.engine_legal_version_pins (
  analysis_run_id uuid not null references public.analysis_runs(id) on delete restrict,
  tenant_id text not null,
  case_id uuid not null references public.engine_case_state(case_id) on delete restrict,
  pin_kind text not null check (pin_kind in ('catalog', 'source', 'parameter', 'rulespec', 'code', 'template')),
  version_id text not null,
  version_sha256 text not null check (version_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  primary key (analysis_run_id, pin_kind, version_id),
  unique (analysis_run_id, pin_kind, version_sha256)
);

create table if not exists public.engine_analysis_stage_versions (
  analysis_run_id uuid not null references public.analysis_runs(id) on delete restrict,
  tenant_id text not null,
  case_id uuid not null references public.engine_case_state(case_id) on delete restrict,
  stage text not null check (stage in ('input_snapshot', 'canonical_facts', 'rule_inputs', 'analysis_run', 'topic_results', 'report_artifacts', 'review_pending')),
  resume_cursor jsonb not null default '{}'::jsonb check (jsonb_typeof(resume_cursor) = 'object'),
  payload jsonb not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  primary key (analysis_run_id, stage)
);

create table if not exists public.engine_topic_result_versions (
  analysis_run_id uuid not null references public.analysis_runs(id) on delete restrict,
  tenant_id text not null,
  case_id uuid not null references public.engine_case_state(case_id) on delete restrict,
  topic text not null check (topic in ('minimum_wage', 'working_time', 'pension', 'travel', 'convalescence', 'vacation', 'sick_leave')),
  status text not null check (status in ('calculated', 'not_applicable', 'blocked_missing_facts', 'blocked_conflict', 'blocked_legal_readiness', 'error')),
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  result_sha256 text not null check (result_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  primary key (analysis_run_id, topic),
  unique (analysis_run_id, result_sha256)
);

create table if not exists public.engine_calculation_trace_versions (
  trace_id text primary key,
  tenant_id text not null,
  case_id uuid not null references public.engine_case_state(case_id) on delete restrict,
  analysis_run_id uuid not null references public.analysis_runs(id) on delete restrict,
  topic text not null,
  trace jsonb not null check (jsonb_typeof(trace) = 'object'),
  trace_sha256 text not null check (trace_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null,
  unique (analysis_run_id, topic, trace_sha256)
);

create table if not exists public.engine_report_versions (
  report_id text not null,
  revision bigint not null check (revision > 0),
  tenant_id text not null,
  case_id uuid not null references public.engine_case_state(case_id) on delete restrict,
  analysis_run_id uuid not null references public.analysis_runs(id) on delete restrict,
  analysis_result_sha256 text not null check (analysis_result_sha256 ~ '^[0-9a-f]{64}$'),
  report_sha256 text not null check (report_sha256 ~ '^[0-9a-f]{64}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  object_version_id text,
  visible boolean not null default false,
  created_at timestamptz not null,
  primary key (report_id, revision),
  unique (case_id, report_sha256)
);

create table if not exists public.engine_review_task_versions (
  task_id text not null,
  revision bigint not null check (revision > 0),
  tenant_id text not null,
  case_id uuid not null references public.engine_case_state(case_id) on delete restrict,
  task_kind text not null check (task_kind in ('extraction_review', 'fact_conflict', 'legal_evaluation', 'report_approval')),
  input_sha256 text not null check (input_sha256 ~ '^[0-9a-f]{64}$'),
  output_sha256 text not null check (output_sha256 ~ '^[0-9a-f]{64}$'),
  task_sha256 text not null check (task_sha256 ~ '^[0-9a-f]{64}$'),
  decision_payload jsonb,
  decision_sha256 text check (decision_sha256 is null or decision_sha256 ~ '^[0-9a-f]{64}$'),
  invalidated_at timestamptz,
  created_at timestamptz not null,
  primary key (task_id, revision),
  unique (case_id, task_sha256)
);

create table if not exists public.engine_idempotency_records (
  tenant_id text not null,
  case_id uuid references public.engine_case_state(case_id) on delete restrict,
  scope text not null,
  idempotency_key text not null,
  command_sha256 text not null check (command_sha256 ~ '^[0-9a-f]{64}$'),
  result_sha256 text check (result_sha256 is null or result_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('reserved', 'committed')),
  created_at timestamptz not null,
  committed_at timestamptz,
  primary key (tenant_id, scope, idempotency_key),
  check ((state = 'committed') = (result_sha256 is not null and committed_at is not null))
);

create table if not exists public.engine_durable_jobs (
  job_id text primary key,
  tenant_id text not null,
  case_id uuid references public.engine_case_state(case_id) on delete restrict,
  job_kind text not null,
  idempotency_key text not null,
  payload jsonb not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  pinned_version_sha256s text[] not null default '{}',
  state text not null check (state in ('queued', 'leased', 'running', 'succeeded', 'retry_wait', 'cancelled', 'dead_letter')),
  revision bigint not null default 1 check (revision > 0),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null check (max_attempts > 0),
  available_at timestamptz not null,
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  cancellation_requested boolean not null default false,
  terminal_effect_sha256 text check (terminal_effect_sha256 is null or terminal_effect_sha256 ~ '^[0-9a-f]{64}$'),
  replayed_from_job_id text references public.engine_durable_jobs(job_id) on delete restrict,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, job_kind, idempotency_key),
  check ((state in ('leased', 'running')) = (lease_owner is not null and lease_expires_at is not null))
);

create table if not exists public.engine_job_history (
  sequence bigserial primary key,
  job_id text not null references public.engine_durable_jobs(job_id) on delete restrict,
  from_state text,
  to_state text not null,
  revision bigint not null,
  fencing_token bigint not null,
  reason_code text not null,
  previous_sha256 text check (previous_sha256 is null or previous_sha256 ~ '^[0-9a-f]{64}$'),
  event_sha256 text not null unique check (event_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null
);

create table if not exists public.engine_outbox_events (
  outbox_id text primary key,
  tenant_id text not null,
  case_id uuid references public.engine_case_state(case_id) on delete restrict,
  logical_effect_id text not null,
  effect_kind text not null,
  payload jsonb not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  state text not null check (state in ('pending', 'leased', 'published')),
  fencing_token bigint not null default 0 check (fencing_token >= 0),
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz not null,
  published_at timestamptz,
  unique (tenant_id, logical_effect_id, outbox_id),
  check ((state = 'leased') = (lease_owner is not null and lease_expires_at is not null)),
  check ((state = 'published') = (published_at is not null))
);

create table if not exists public.engine_logical_effect_receipts (
  tenant_id text not null,
  logical_effect_id text not null,
  logical_effect_sha256 text not null check (logical_effect_sha256 ~ '^[0-9a-f]{64}$'),
  outbox_id text not null references public.engine_outbox_events(outbox_id) on delete restrict,
  committed_at timestamptz not null,
  primary key (tenant_id, logical_effect_id)
);

create table if not exists public.engine_platform_audit_events (
  sequence bigserial primary key,
  tenant_id text not null,
  case_id uuid references public.engine_case_state(case_id) on delete restrict,
  actor_id text not null,
  action text not null,
  resource_id text not null,
  resource_revision bigint not null,
  resource_sha256 text not null check (resource_sha256 ~ '^[0-9a-f]{64}$'),
  reason_code text not null,
  previous_sha256 text check (previous_sha256 is null or previous_sha256 ~ '^[0-9a-f]{64}$'),
  event_sha256 text not null unique check (event_sha256 ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null
);

create table if not exists public.engine_object_write_sagas (
  reservation_id text primary key,
  tenant_id text not null,
  case_id uuid not null references public.engine_case_state(case_id) on delete restrict,
  opaque_key text not null,
  expected_sha256 text not null check (expected_sha256 ~ '^[0-9a-f]{64}$'),
  expected_length bigint not null check (expected_length >= 0),
  detected_mime text not null,
  retention_class text not null,
  state text not null check (state in ('reserved', 'staged', 'verified', 'finalized', 'quarantined')),
  revision bigint not null default 1 check (revision > 0),
  staged_sha256 text check (staged_sha256 is null or staged_sha256 ~ '^[0-9a-f]{64}$'),
  staged_length bigint check (staged_length is null or staged_length >= 0),
  object_version_id text unique,
  visible boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (tenant_id, opaque_key, expected_sha256),
  check (state <> 'finalized' or (visible and object_version_id is not null and staged_sha256 = expected_sha256 and staged_length = expected_length)),
  check (state = 'finalized' or not visible)
);

create index if not exists engine_case_state_tenant_idx on public.engine_case_state(tenant_id, lifecycle_state);
create index if not exists engine_facts_case_revision_idx on public.engine_canonical_fact_versions(case_id, fact_id, revision desc);
create index if not exists engine_rule_inputs_run_topic_idx on public.engine_rule_input_versions(analysis_run_id, topic, revision desc);
create index if not exists engine_analysis_stage_case_idx on public.engine_analysis_stage_versions(case_id, analysis_run_id);
create index if not exists engine_reports_case_revision_idx on public.engine_report_versions(case_id, report_id, revision desc);
create index if not exists engine_reviews_case_kind_idx on public.engine_review_task_versions(case_id, task_kind, revision desc);
create index if not exists engine_jobs_claim_idx on public.engine_durable_jobs(state, available_at, job_id) where state in ('queued', 'retry_wait', 'leased', 'running');
create index if not exists engine_outbox_claim_idx on public.engine_outbox_events(state, created_at, outbox_id) where state in ('pending', 'leased');
create index if not exists engine_audit_case_sequence_idx on public.engine_platform_audit_events(case_id, sequence);
create index if not exists engine_object_saga_reconcile_idx on public.engine_object_write_sagas(state, updated_at) where state <> 'finalized';

create or replace function private.reject_engine_append_only_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'Engine version history is append-only';
end;
$$;

create trigger engine_lifecycle_append_only before update or delete on public.engine_case_lifecycle_revisions for each row execute function private.reject_engine_append_only_mutation();
create trigger engine_payment_refs_append_only before update or delete on public.engine_payment_evidence_refs for each row execute function private.reject_engine_append_only_mutation();
create trigger engine_facts_append_only before update or delete on public.engine_canonical_fact_versions for each row execute function private.reject_engine_append_only_mutation();
create trigger engine_rule_inputs_append_only before update or delete on public.engine_rule_input_versions for each row execute function private.reject_engine_append_only_mutation();
create trigger engine_legal_pins_append_only before update or delete on public.engine_legal_version_pins for each row execute function private.reject_engine_append_only_mutation();
create trigger engine_analysis_stages_append_only before update or delete on public.engine_analysis_stage_versions for each row execute function private.reject_engine_append_only_mutation();
create trigger engine_topic_results_append_only before update or delete on public.engine_topic_result_versions for each row execute function private.reject_engine_append_only_mutation();
create trigger engine_traces_append_only before update or delete on public.engine_calculation_trace_versions for each row execute function private.reject_engine_append_only_mutation();
create trigger engine_reports_append_only before update or delete on public.engine_report_versions for each row execute function private.reject_engine_append_only_mutation();
create trigger engine_reviews_append_only before update or delete on public.engine_review_task_versions for each row execute function private.reject_engine_append_only_mutation();
create trigger engine_job_history_append_only before update or delete on public.engine_job_history for each row execute function private.reject_engine_append_only_mutation();
create trigger engine_effects_append_only before update or delete on public.engine_logical_effect_receipts for each row execute function private.reject_engine_append_only_mutation();
create trigger engine_audit_append_only before update or delete on public.engine_platform_audit_events for each row execute function private.reject_engine_append_only_mutation();

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
    where (
      (state in ('queued', 'retry_wait') and available_at <= observed_now)
      or (state in ('leased', 'running') and lease_expires_at <= observed_now)
    )
    order by available_at, job_id
    for update skip locked
    limit claim_limit
  )
  update public.engine_durable_jobs job
  set state = 'leased',
      revision = job.revision + 1,
      attempt_count = job.attempt_count + 1,
      lease_owner = target_worker,
      lease_expires_at = observed_now + lease_duration,
      fencing_token = job.fencing_token + 1,
      updated_at = observed_now
  from candidates
  where job.job_id = candidates.job_id
  returning job.*;
$$;

create or replace function private.heartbeat_engine_platform_job(
  target_job_id text,
  target_worker text,
  expected_fencing_token bigint,
  observed_now timestamptz,
  lease_duration interval
)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  update public.engine_durable_jobs
  set revision = revision + 1,
      lease_expires_at = observed_now + lease_duration,
      updated_at = observed_now
  where job_id = target_job_id
    and state in ('leased', 'running')
    and lease_owner = target_worker
    and fencing_token = expected_fencing_token;
  return found;
end;
$$;

create or replace function private.finish_engine_platform_job(
  target_job_id text,
  target_worker text,
  expected_fencing_token bigint,
  target_outbox_id text,
  target_logical_effect_id text,
  target_logical_effect_sha256 text,
  observed_now timestamptz
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  locked_job public.engine_durable_jobs%rowtype;
  prior_effect_sha256 text;
begin
  select * into locked_job
  from public.engine_durable_jobs
  where job_id = target_job_id
  for update;

  if locked_job.job_id is null
    or locked_job.state <> 'running'
    or locked_job.lease_owner <> target_worker
    or locked_job.fencing_token <> expected_fencing_token
    or locked_job.lease_expires_at <= observed_now then
    return false;
  end if;

  select logical_effect_sha256 into prior_effect_sha256
  from public.engine_logical_effect_receipts
  where tenant_id = locked_job.tenant_id and logical_effect_id = target_logical_effect_id;

  if prior_effect_sha256 is not null and prior_effect_sha256 <> target_logical_effect_sha256 then
    raise exception 'Logical effect hash mismatch';
  end if;

  insert into public.engine_logical_effect_receipts (
    tenant_id, logical_effect_id, logical_effect_sha256, outbox_id, committed_at
  ) values (
    locked_job.tenant_id, target_logical_effect_id, target_logical_effect_sha256, target_outbox_id, observed_now
  ) on conflict (tenant_id, logical_effect_id) do nothing;

  update public.engine_durable_jobs
  set state = 'succeeded',
      revision = revision + 1,
      terminal_effect_sha256 = target_logical_effect_sha256,
      lease_owner = null,
      lease_expires_at = null,
      updated_at = observed_now
  where job_id = target_job_id;
  return true;
end;
$$;

create or replace function private.claim_engine_platform_outbox(
  target_worker text,
  observed_now timestamptz,
  lease_duration interval
)
returns setof public.engine_outbox_events
language sql security definer set search_path = '' as $$
  with candidate as (
    select outbox_id from public.engine_outbox_events
    where state = 'pending' or (state = 'leased' and lease_expires_at <= observed_now)
    order by created_at, outbox_id
    for update skip locked
    limit 1
  )
  update public.engine_outbox_events event
  set state = 'leased',
      fencing_token = event.fencing_token + 1,
      lease_owner = target_worker,
      lease_expires_at = observed_now + lease_duration
  from candidate
  where event.outbox_id = candidate.outbox_id
  returning event.*;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'engine_case_state', 'engine_case_lifecycle_revisions', 'engine_payment_evidence_refs',
    'engine_canonical_fact_versions', 'engine_rule_input_versions', 'engine_legal_version_pins',
    'engine_analysis_stage_versions', 'engine_topic_result_versions', 'engine_calculation_trace_versions',
    'engine_report_versions', 'engine_review_task_versions', 'engine_idempotency_records',
    'engine_durable_jobs', 'engine_job_history', 'engine_outbox_events',
    'engine_logical_effect_receipts', 'engine_platform_audit_events', 'engine_object_write_sagas'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('revoke all on table public.%I from anon, authenticated', table_name);
    execute format('grant select, insert, update on table public.%I to service_role', table_name);
  end loop;
end;
$$;

revoke all on function private.reject_engine_append_only_mutation() from public, anon, authenticated;
revoke all on function private.claim_engine_platform_jobs(text, timestamptz, interval, integer) from public, anon, authenticated;
revoke all on function private.heartbeat_engine_platform_job(text, text, bigint, timestamptz, interval) from public, anon, authenticated;
revoke all on function private.finish_engine_platform_job(text, text, bigint, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function private.claim_engine_platform_outbox(text, timestamptz, interval) from public, anon, authenticated;

grant execute on function private.claim_engine_platform_jobs(text, timestamptz, interval, integer) to service_role;
grant execute on function private.heartbeat_engine_platform_job(text, text, bigint, timestamptz, interval) to service_role;
grant execute on function private.finish_engine_platform_job(text, text, bigint, text, text, text, timestamptz) to service_role;
grant execute on function private.claim_engine_platform_outbox(text, timestamptz, interval) to service_role;

comment on table public.engine_idempotency_records is 'Reservation and result binding must commit in the same transaction as domain, audit and outbox mutations.';
comment on table public.engine_durable_jobs is 'At-least-once durable jobs with optimistic revisions, lease expiry and monotonically increasing fencing tokens.';
comment on table public.engine_outbox_events is 'At-least-once transport only. engine_logical_effect_receipts deduplicates logical effects.';
comment on table public.engine_object_write_sagas is 'Invisible staging metadata; content becomes visible only after exact checksum finalization.';
