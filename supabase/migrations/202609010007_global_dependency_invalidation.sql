-- Tivdoc V0.10.2 forward-only durable global dependency invalidation.
-- Historical analysis/report/review rows remain immutable. Only currentness,
-- revocable report objects, cancellable jobs and unpublished outbox state move.

create table public.engine_global_dependency_state (
  tenant_id text not null,
  canonical_case_id text not null,
  case_revision bigint not null check (case_revision >= 0),
  dependency_epoch bigint not null default 0 check (dependency_epoch >= 0),
  cache_epoch bigint not null default 0 check (cache_epoch >= 0),
  download_grant_epoch bigint not null default 0 check (download_grant_epoch >= 0),
  current_dependency_sha256 text not null check (current_dependency_sha256 ~ '^[a-f0-9]{64}$'),
  stale_stages text[] not null default '{}',
  release_hold boolean not null default false,
  dependencies_approved boolean not null default false,
  execution_binding_sha256 text check (execution_binding_sha256 is null or execution_binding_sha256 ~ '^[a-f0-9]{64}$'),
  approval_binding_sha256 text check (approval_binding_sha256 is null or approval_binding_sha256 ~ '^[a-f0-9]{64}$'),
  download_binding_sha256 text check (download_binding_sha256 is null or download_binding_sha256 ~ '^[a-f0-9]{64}$'),
  latest_invalidation_sha256 text check (latest_invalidation_sha256 is null or latest_invalidation_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, canonical_case_id),
  foreign key (tenant_id, canonical_case_id)
    references public.engine_case_state(tenant_id, canonical_case_id) on delete restrict,
  check (updated_at >= created_at),
  check (stale_stages <@ array[
    'documents','facts','confirmations','legal_source','parameters','rulespec',
    'rule_input','analysis','trace','report','pdf','approval','download_grant',
    'job','outbox','cache'
  ]::text[]),
  check (
    (dependencies_approved and cardinality(stale_stages) = 0 and not release_hold
      and execution_binding_sha256 is not null
      and approval_binding_sha256 is not null
      and download_binding_sha256 is not null)
    or
    (not dependencies_approved
      and execution_binding_sha256 is null
      and approval_binding_sha256 is null
      and download_binding_sha256 is null)
  )
);

create table public.engine_global_dependency_invalidations (
  invalidation_id text primary key check (invalidation_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$'),
  tenant_id text not null,
  canonical_case_id text not null,
  command_sha256 text not null check (command_sha256 ~ '^[a-f0-9]{64}$'),
  invalidation_sha256 text not null unique check (invalidation_sha256 ~ '^[a-f0-9]{64}$'),
  prior_invalidation_sha256 text check (prior_invalidation_sha256 is null or prior_invalidation_sha256 ~ '^[a-f0-9]{64}$'),
  mutation_kind text not null check (mutation_kind in (
    'document_changed','fact_correction','clarification_answered',
    'source_version_changed','source_period_changed','source_scope_changed',
    'parameter_changed','rulespec_changed','reviewer_key_revoked','report_changed',
    'chargeback','privacy_request'
  )),
  dependency_id text not null,
  previous_dependency_sha256 text not null check (previous_dependency_sha256 ~ '^[a-f0-9]{64}$'),
  next_dependency_sha256 text not null check (next_dependency_sha256 ~ '^[a-f0-9]{64}$'),
  case_revision bigint not null check (case_revision > 0),
  dependency_epoch bigint not null check (dependency_epoch > 0),
  cache_epoch bigint not null check (cache_epoch > 0),
  download_grant_epoch bigint not null check (download_grant_epoch > 0),
  stale_stages text[] not null,
  release_hold boolean not null,
  actor_id text not null,
  reason_code text not null,
  worker_job_id text not null,
  worker_id text not null,
  worker_fencing_token bigint not null check (worker_fencing_token > 0),
  audit_event_sha256 text not null check (audit_event_sha256 ~ '^[a-f0-9]{64}$'),
  outbox_id text not null,
  outbox_payload_sha256 text not null check (outbox_payload_sha256 ~ '^[a-f0-9]{64}$'),
  grants_revoked bigint not null check (grants_revoked >= 0),
  jobs_cancelled bigint not null check (jobs_cancelled >= 0),
  outbox_events_superseded bigint not null check (outbox_events_superseded >= 0),
  plan_payload jsonb not null check (jsonb_typeof(plan_payload) = 'object'),
  applied_payload jsonb not null check (jsonb_typeof(applied_payload) = 'object'),
  occurred_at timestamptz not null,
  foreign key (tenant_id, canonical_case_id)
    references public.engine_case_state(tenant_id, canonical_case_id) on delete restrict,
  unique (tenant_id, canonical_case_id, case_revision),
  check (stale_stages <@ array[
    'documents','facts','confirmations','legal_source','parameters','rulespec',
    'rule_input','analysis','trace','report','pdf','approval','download_grant',
    'job','outbox','cache'
  ]::text[])
);

-- Existing cases start fail-closed. Their durable case-state hash is the only
-- initial dependency binding; no dependency is implicitly approved.
insert into public.engine_global_dependency_state (
  tenant_id, canonical_case_id, case_revision, dependency_epoch, cache_epoch,
  download_grant_epoch, current_dependency_sha256, stale_stages, release_hold,
  dependencies_approved, execution_binding_sha256, approval_binding_sha256,
  download_binding_sha256, latest_invalidation_sha256, created_at, updated_at
)
select state.tenant_id, state.canonical_case_id, state.revision, 0, 0, 0,
       state.state_sha256, '{}'::text[],
       state.lifecycle_state in ('release_hold','cancelled'), false,
       null, null, null, null, state.updated_at, state.updated_at
from public.engine_case_state state
on conflict (tenant_id, canonical_case_id) do nothing;

create function private.global_dependency_state_initialize()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.engine_global_dependency_state (
    tenant_id, canonical_case_id, case_revision, current_dependency_sha256,
    stale_stages, release_hold, dependencies_approved, created_at, updated_at
  ) values (
    new.tenant_id, new.canonical_case_id, new.revision, new.state_sha256,
    '{}'::text[], new.lifecycle_state in ('release_hold','cancelled'), false,
    new.updated_at, new.updated_at
  ) on conflict (tenant_id, canonical_case_id) do nothing;
  return new;
end;
$$;

create trigger engine_global_dependency_state_initialize
after insert on public.engine_case_state
for each row execute function private.global_dependency_state_initialize();

create function private.global_dependency_actor_assert(target_actor_id text)
returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.runtime_assert_actor(target_actor_id);
end;
$$;

-- Unpublished events need an honest terminal supersession state; reporting
-- them as published would manufacture an external effect.
alter table public.engine_outbox_events
  drop constraint if exists engine_outbox_events_state_check;
alter table public.engine_outbox_events
  add column superseded_at timestamptz,
  add column superseded_by_invalidation_id text,
  add constraint engine_outbox_events_state_check
    check (state in ('pending','leased','published','superseded')),
  add constraint engine_outbox_events_supersession_check check (
    (state = 'superseded') =
      (superseded_at is not null and superseded_by_invalidation_id is not null)
  );

create index engine_global_dependency_history_case_idx
  on public.engine_global_dependency_invalidations(
    tenant_id, canonical_case_id, case_revision desc
  );
create index engine_outbox_superseded_case_idx
  on public.engine_outbox_events(tenant_id, canonical_case_id, superseded_at)
  where state = 'superseded';

create trigger engine_global_dependency_history_append_only
before update or delete on public.engine_global_dependency_invalidations
for each row execute function private.reject_engine_append_only_mutation();
create trigger engine_global_dependency_state_no_delete
before delete on public.engine_global_dependency_state
for each row execute function private.reject_engine_append_only_mutation();

alter table public.engine_global_dependency_state enable row level security;
alter table public.engine_global_dependency_state force row level security;
alter table public.engine_global_dependency_invalidations enable row level security;
alter table public.engine_global_dependency_invalidations force row level security;

create policy tivdoc_service_tenant_scope
  on public.engine_global_dependency_state
  for all to service_role
  using (tenant_id = nullif(pg_catalog.current_setting('tivdoc.tenant_id', true), ''))
  with check (tenant_id = nullif(pg_catalog.current_setting('tivdoc.tenant_id', true), ''));
create policy tivdoc_service_tenant_scope
  on public.engine_global_dependency_invalidations
  for all to service_role
  using (tenant_id = nullif(pg_catalog.current_setting('tivdoc.tenant_id', true), ''))
  with check (tenant_id = nullif(pg_catalog.current_setting('tivdoc.tenant_id', true), ''));
create policy tivdoc_runtime_verified_tenant
  on public.engine_global_dependency_state
  for all to tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime
  using (tenant_id = private.runtime_verified_tenant())
  with check (tenant_id = private.runtime_verified_tenant());
create policy tivdoc_runtime_verified_tenant
  on public.engine_global_dependency_invalidations
  for all to tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime
  using (tenant_id = private.runtime_verified_tenant())
  with check (tenant_id = private.runtime_verified_tenant());
create policy tivdoc_owner_verified_tenant
  on public.engine_global_dependency_state
  for all to tivdoc_governance_owner
  using (true)
  with check (true);
create policy tivdoc_owner_verified_tenant
  on public.engine_global_dependency_invalidations
  for all to tivdoc_governance_owner
  using (tenant_id = private.runtime_verified_tenant())
  with check (tenant_id = private.runtime_verified_tenant());

alter table public.engine_global_dependency_state owner to tivdoc_governance_owner;
alter table public.engine_global_dependency_invalidations owner to tivdoc_governance_owner;
alter function private.global_dependency_state_initialize() owner to tivdoc_governance_owner;
alter function private.global_dependency_actor_assert(text) owner to tivdoc_governance_owner;

revoke all on table
  public.engine_global_dependency_state,
  public.engine_global_dependency_invalidations
from public, anon, authenticated, service_role, tivdoc_identity_runtime,
     tivdoc_worker_runtime, tivdoc_web_runtime;
grant select, insert, update on public.engine_global_dependency_state
  to tivdoc_operations_runtime, tivdoc_governance_owner;
grant select, insert on public.engine_global_dependency_invalidations
  to tivdoc_operations_runtime, tivdoc_governance_owner;
grant usage on sequence public.engine_job_history_sequence_seq
  to tivdoc_operations_runtime;
revoke all on function private.global_dependency_state_initialize()
  from public, anon, authenticated, service_role, tivdoc_identity_runtime,
       tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime;
revoke all on function private.global_dependency_actor_assert(text)
  from public, anon, authenticated, service_role, tivdoc_identity_runtime,
       tivdoc_worker_runtime, tivdoc_web_runtime;
grant execute on function private.global_dependency_actor_assert(text)
  to tivdoc_operations_runtime;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'global_dependency_invalidation',
  'tivdoc-global-dependency-invalidation-v0.10.2',
  '202609010007_global_dependency_invalidation'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on table public.engine_global_dependency_invalidations is
  'Append-only plans and applied receipts for globally fenced dependency invalidation.';
comment on column public.engine_outbox_events.superseded_by_invalidation_id is
  'Terminal local supersession only; it is never evidence of publication.';
