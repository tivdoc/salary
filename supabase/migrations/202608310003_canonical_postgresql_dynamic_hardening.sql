-- Tivdoc V0.9.1 plain-PostgreSQL runtime hardening.
-- Forward-only runtime hardening; the sole predecessor identifier amendment
-- is pinned in migration-portability-amendment.json and changes no SQL semantics.

-- Supabase supplies these privileges as part of its platform role setup. Plain
-- PostgreSQL requires them explicitly for the canonical direct driver.
grant usage on schema public, private to service_role;
grant usage, select on sequence
  public.engine_job_history_sequence_seq,
  public.engine_platform_audit_events_sequence_seq
to service_role;

-- Canonical idempotent inserts use ON CONFLICT DO UPDATE with a no-op identity
-- assignment. PostgreSQL checks UPDATE privilege even on the non-conflict path.
grant update on table public.case_messages, public.analysis_hypotheses to service_role;

-- Backfill only ownership that is authoritative in engine_case_state. Rows
-- without a canonical engine case retain their legacy UUID path contract.
do $$
begin
  if exists (
    select 1
    from public.documents document
    join public.engine_case_state state on state.case_id = document.case_id
    where (document.tenant_id is not null and document.tenant_id <> state.tenant_id)
       or (document.canonical_case_id is not null and document.canonical_case_id <> state.canonical_case_id)
  ) then
    raise exception 'Document canonical ownership conflicts with engine case state';
  end if;
end;
$$;

update public.documents document
set tenant_id = coalesce(document.tenant_id, state.tenant_id),
    canonical_case_id = coalesce(document.canonical_case_id, state.canonical_case_id),
    canonical_document_id = coalesce(document.canonical_document_id, document.id::text)
from public.engine_case_state state
where state.case_id = document.case_id
  and (document.tenant_id is null
    or document.canonical_case_id is null
    or document.canonical_document_id is null);

alter table public.documents drop constraint if exists documents_immutable_metadata_check;
alter table public.documents
  add constraint documents_immutable_metadata_check check (
    storage_layout = 'legacy_slot'
    or (
      declared_type is not null
      and content_sha256 is not null
      and storage_path not like '%..%'
      and storage_path not like '%://%'
      and (
        (
          canonical_case_id is not null
          and canonical_document_id is not null
          and left(
            storage_path,
            length('cases/' || canonical_case_id || '/documents/' || canonical_document_id || '/original.')
          ) = 'cases/' || canonical_case_id || '/documents/' || canonical_document_id || '/original.'
        )
        or (
          canonical_case_id is null
          and canonical_document_id is null
          and left(
            storage_path,
            length('cases/' || case_id::text || '/documents/' || id::text || '/original.')
          ) = 'cases/' || case_id::text || '/documents/' || id::text || '/original.'
        )
      )
    )
  ) not valid;
alter table public.documents validate constraint documents_immutable_metadata_check;

-- A successfully installed V0.9 schema already requires these run fields to be
-- non-null. Make the ownership relationship explicit and fail closed if a
-- partially imported legacy state does not reconcile.
do $$
begin
  if exists (
    select 1
    from public.analysis_runs run
    left join public.engine_case_state state on state.case_id = run.case_id
    where state.case_id is null
       or run.tenant_id <> state.tenant_id
       or run.canonical_case_id <> state.canonical_case_id
  ) then
    raise exception 'Analysis run canonical ownership does not reconcile with engine case state';
  end if;
end;
$$;

alter table public.analysis_runs validate constraint analysis_runs_engine_identity_fkey;

-- Canonical adapters also use these legacy foundation tables. Give a
-- NOBYPASSRLS policy probe the same fail-closed tenant contract as the V0.9
-- engine tables. The real Supabase service role remains a trusted BYPASSRLS
-- server role and is tested separately.
do $$
declare table_name text;
begin
  foreach table_name in array array[
    'documents', 'analysis_runs', 'analysis_hypotheses',
    'case_conversations', 'case_messages', 'analysis_findings',
    'document_extractions', 'case_confirmations', 'engine_object_write_sagas'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('drop policy if exists tivdoc_service_tenant_scope on public.%I', table_name);
    execute format(
      'create policy tivdoc_service_tenant_scope on public.%I to service_role using (tenant_id = nullif(current_setting(''tivdoc.tenant_id'', true), '''')) with check (tenant_id = nullif(current_setting(''tivdoc.tenant_id'', true), ''''))',
      table_name
    );
  end loop;
end;
$$;

-- SECURITY DEFINER bypasses table RLS. Every callable queue function therefore
-- derives its tenant exclusively from the transaction-local runtime setting.
create or replace function private.claim_engine_platform_jobs(
  target_worker text,
  observed_now timestamptz,
  lease_duration interval,
  claim_limit integer
)
returns setof public.engine_durable_jobs
language sql security definer set search_path = '' as $$
  with candidates as (
    select job.job_id
    from public.engine_durable_jobs job
    where job.tenant_id = nullif(current_setting('tivdoc.tenant_id', true), '')
      and job.attempt_count < job.max_attempts
      and (
        (job.state in ('queued', 'retry_wait') and job.available_at <= observed_now)
        or (job.state in ('leased', 'running') and job.lease_expires_at <= observed_now)
      )
    order by job.available_at, job.job_id
    for update of job skip locked
    limit greatest(least(coalesce(claim_limit, 0), 100), 0)
  )
  update public.engine_durable_jobs job
  set state = 'leased', revision = job.revision + 1,
      attempt_count = job.attempt_count + 1, lease_owner = target_worker,
      lease_expires_at = observed_now + lease_duration,
      fencing_token = job.fencing_token + 1,
      cancellation_requested = false, updated_at = observed_now
  from candidates
  where job.job_id = candidates.job_id
    and job.tenant_id = nullif(current_setting('tivdoc.tenant_id', true), '')
  returning job.*
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
    and tenant_id = nullif(current_setting('tivdoc.tenant_id', true), '')
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
    and tenant_id = nullif(current_setting('tivdoc.tenant_id', true), '')
  for update;

  if locked_job.job_id is null
    or locked_job.state <> 'running'
    or locked_job.lease_owner <> target_worker
    or locked_job.fencing_token <> expected_fencing_token
    or locked_job.lease_expires_at <= observed_now
    or not exists (
      select 1 from public.engine_outbox_events event
      where event.outbox_id = target_outbox_id
        and event.tenant_id = locked_job.tenant_id
    ) then
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
  where job_id = target_job_id and tenant_id = locked_job.tenant_id;
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
    select event.outbox_id
    from public.engine_outbox_events event
    where event.tenant_id = nullif(current_setting('tivdoc.tenant_id', true), '')
      and (event.state = 'pending' or (event.state = 'leased' and event.lease_expires_at <= observed_now))
    order by event.created_at, event.outbox_id
    for update of event skip locked
    limit 1
  )
  update public.engine_outbox_events event
  set state = 'leased',
      fencing_token = event.fencing_token + 1,
      lease_owner = target_worker,
      lease_expires_at = observed_now + lease_duration
  from candidate
  where event.outbox_id = candidate.outbox_id
    and event.tenant_id = nullif(current_setting('tivdoc.tenant_id', true), '')
  returning event.*
$$;

revoke all on function private.claim_engine_platform_jobs(text, timestamptz, interval, integer)
  from public, anon, authenticated;
revoke all on function private.heartbeat_engine_platform_job(text, text, bigint, timestamptz, interval)
  from public, anon, authenticated;
revoke all on function private.finish_engine_platform_job(text, text, bigint, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function private.claim_engine_platform_outbox(text, timestamptz, interval)
  from public, anon, authenticated;

grant execute on function private.claim_engine_platform_jobs(text, timestamptz, interval, integer)
  to service_role;
grant execute on function private.heartbeat_engine_platform_job(text, text, bigint, timestamptz, interval)
  to service_role;
grant execute on function private.finish_engine_platform_job(text, text, bigint, text, text, text, timestamptz)
  to service_role;
grant execute on function private.claim_engine_platform_outbox(text, timestamptz, interval)
  to service_role;

-- The compatibility bridge used by the immediately preceding composition
-- migration is deliberately temporary. Once canonical metadata has been
-- reconciled, restore a strict history guard that treats the new ownership,
-- command, and completion fields as immutable history.
create or replace function private.enforce_engine_analysis_run_history()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  parent_case_id uuid;
begin
  if new.parent_run_id is not null then
    select run.case_id into parent_case_id
    from public.analysis_runs run
    where run.id = new.parent_run_id;

    if parent_case_id is null or parent_case_id <> new.case_id then
      raise exception 'Parent analysis run must belong to the same case';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if old.id is distinct from new.id
      or old.case_id is distinct from new.case_id
      or old.parent_run_id is distinct from new.parent_run_id
      or old.run_type is distinct from new.run_type
      or old.trigger_reason is distinct from new.trigger_reason
      or old.engine_version is distinct from new.engine_version
      or old.engine_git_sha is distinct from new.engine_git_sha
      or old.contract_version is distinct from new.contract_version
      or old.ontology_version is distinct from new.ontology_version
      or old.rule_set_hash is distinct from new.rule_set_hash
      or old.input_snapshot is distinct from new.input_snapshot
      or old.input_snapshot_hash is distinct from new.input_snapshot_hash
      or old.idempotency_key is distinct from new.idempotency_key
      or old.created_at is distinct from new.created_at
      or old.tenant_id is distinct from new.tenant_id
      or old.canonical_case_id is distinct from new.canonical_case_id
      or old.canonical_analysis_run_id is distinct from new.canonical_analysis_run_id
      or old.command_sha256 is distinct from new.command_sha256
      or old.command_payload is distinct from new.command_payload
      or old.case_revision is distinct from new.case_revision then
      raise exception 'Analysis run identity and inputs are immutable';
    end if;

    if old.status in ('blocked', 'completed', 'failed') then
      raise exception 'Terminal analysis runs are immutable';
    end if;

    if old.completion_payload is distinct from new.completion_payload
      and not (
        old.completion_payload is null
        and new.completion_payload is not null
        and new.status = 'completed'
      ) then
      raise exception 'Analysis run completion payload is immutable';
    end if;

    if new.status = 'completed' and new.completion_payload is null then
      raise exception 'Completed analysis runs require a completion payload';
    end if;

    if not (
      (old.status = 'queued' and new.status in ('running', 'failed'))
      or (old.status = 'running' and new.status in ('waiting_for_customer', 'partial', 'blocked', 'completed', 'failed'))
      or (old.status = 'waiting_for_customer' and new.status in ('running', 'blocked', 'failed'))
      or (old.status = 'partial' and new.status in ('running', 'waiting_for_customer', 'blocked', 'completed', 'failed'))
    ) then
      raise exception 'Invalid analysis run state transition';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function private.enforce_engine_analysis_run_history()
  from public, anon, authenticated, service_role;
