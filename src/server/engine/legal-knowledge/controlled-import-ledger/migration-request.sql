-- MIGRATION REQUEST ONLY. The W3 lane is not authorized to install migrations.
-- Requested canonical path: supabase/migrations/202609010001_controlled_import_ledger.sql
-- MC-11 stays unwired until the orchestrator reviews, installs, grants, and
-- dynamically verifies this contract on the isolated canonical PostgreSQL.

create schema if not exists private;

create table if not exists private.controlled_import_requests (
  operation_id text primary key check (operation_id ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null unique,
  source_id text not null,
  actor_id text not null,
  request_payload jsonb not null,
  request_sha256 text not null check (request_sha256 ~ '^[a-f0-9]{64}$'),
  expected_artifact_sha256 text check (expected_artifact_sha256 is null or expected_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('received', 'leased', 'validated', 'rejected', 'published')),
  rejection_reason text,
  lease_owner text,
  lease_expires_at timestamptz,
  fencing_token integer not null default 0 check (fencing_token >= 0),
  created_at timestamptz not null,
  transitioned_at timestamptz not null,
  check ((state = 'rejected') = (rejection_reason is not null))
);

create table if not exists private.controlled_import_artifacts (
  operation_id text primary key references private.controlled_import_requests(operation_id),
  artifact_bytes bytea not null,
  artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  identity_token_sha256 text not null check (identity_token_sha256 ~ '^[a-f0-9]{64}$'),
  byte_count integer not null check (byte_count > 0),
  staged_at timestamptz not null,
  check (octet_length(artifact_bytes) = byte_count),
  check (encode(public.digest(artifact_bytes, 'sha256'), 'hex') = artifact_sha256)
);

create table if not exists private.controlled_import_audit_events (
  operation_id text not null references private.controlled_import_requests(operation_id),
  sequence integer not null check (sequence > 0),
  event_kind text not null check (event_kind in ('received', 'lease_claimed', 'validated', 'rejected', 'published')),
  event_payload jsonb not null,
  previous_event_sha256 text check (previous_event_sha256 is null or previous_event_sha256 ~ '^[a-f0-9]{64}$'),
  event_sha256 text not null unique check (event_sha256 ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz not null,
  primary key (operation_id, sequence)
);

create table if not exists public.controlled_import_publication_markers (
  publication_id text primary key check (publication_id ~ '^[a-f0-9]{64}$'),
  operation_id text not null unique references private.controlled_import_requests(operation_id),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  publication_receipt_sha256 text not null unique check (publication_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  published_at timestamptz not null
);

create or replace view public.controlled_import_publication_status_v1
with (security_barrier = true)
as
select r.operation_id, r.source_id, r.actor_id, r.request_sha256,
       r.expected_artifact_sha256, a.artifact_sha256, a.byte_count, r.state,
       r.fencing_token, p.publication_id, p.publication_receipt_sha256,
       (r.state = 'published' and p.publication_id is not null) as visible,
       r.rejection_reason
from private.controlled_import_requests r
left join private.controlled_import_artifacts a on a.operation_id = r.operation_id
left join public.controlled_import_publication_markers p on p.operation_id = r.operation_id;

create or replace function private.controlled_import_forbid_mutation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  raise exception using errcode = 'CI003', message = 'CONTROLLED_IMPORT_APPEND_ONLY';
end;
$$;

drop trigger if exists controlled_import_audit_append_only on private.controlled_import_audit_events;
create trigger controlled_import_audit_append_only
before update or delete on private.controlled_import_audit_events
for each row execute function private.controlled_import_forbid_mutation();

drop trigger if exists controlled_import_publication_append_only on public.controlled_import_publication_markers;
create trigger controlled_import_publication_append_only
before update or delete on public.controlled_import_publication_markers
for each row execute function private.controlled_import_forbid_mutation();

create or replace function private.append_controlled_import_audit(
  p_operation_id text,
  p_event_kind text,
  p_payload jsonb,
  p_occurred_at timestamptz
) returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sequence integer;
  v_previous text;
  v_hash text;
begin
  select coalesce(max(sequence), 0) + 1,
         (array_agg(event_sha256 order by sequence desc))[1]
    into v_sequence, v_previous
  from private.controlled_import_audit_events
  where operation_id = p_operation_id;
  v_hash := encode(public.digest(convert_to(
    p_operation_id || ':' || v_sequence::text || ':' || p_event_kind || ':' ||
    coalesce(v_previous, '') || ':' || p_payload::text || ':' || p_occurred_at::text,
    'UTF8'), 'sha256'), 'hex');
  insert into private.controlled_import_audit_events (
    operation_id, sequence, event_kind, event_payload,
    previous_event_sha256, event_sha256, occurred_at
  ) values (
    p_operation_id, v_sequence, p_event_kind, p_payload,
    v_previous, v_hash, p_occurred_at
  );
  return v_hash;
end;
$$;

create or replace function private.controlled_import_reserve(
  p_operation_id text,
  p_idempotency_key text,
  p_source_id text,
  p_actor_id text,
  p_request_payload jsonb,
  p_request_sha256 text,
  p_expected_artifact_sha256 text,
  p_requested_at timestamptz
) returns setof public.controlled_import_publication_status_v1
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.controlled_import_requests%rowtype;
  v_inserted_count integer := 0;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_idempotency_key, 0));
  insert into private.controlled_import_requests (
    operation_id, idempotency_key, source_id, actor_id, request_payload,
    request_sha256, expected_artifact_sha256, state, created_at, transitioned_at
  ) values (
    p_operation_id, p_idempotency_key, p_source_id, p_actor_id, p_request_payload,
    p_request_sha256, p_expected_artifact_sha256, 'received', p_requested_at, p_requested_at
  ) on conflict (idempotency_key) do nothing;
  get diagnostics v_inserted_count = row_count;
  select * into strict v_row from private.controlled_import_requests
  where idempotency_key = p_idempotency_key for update;
  if v_row.operation_id <> p_operation_id
     or v_row.source_id <> p_source_id
     or v_row.actor_id <> p_actor_id
     or v_row.request_sha256 <> p_request_sha256
     or v_row.request_payload <> p_request_payload
     or v_row.expected_artifact_sha256 is distinct from p_expected_artifact_sha256 then
    raise exception using errcode = 'CI001', message = 'CONTROLLED_IMPORT_IDEMPOTENCY_BINDING_MISMATCH';
  end if;
  if v_inserted_count = 1 then
    perform private.append_controlled_import_audit(
      p_operation_id, 'received',
      jsonb_build_object('actor_id', p_actor_id, 'request_sha256', p_request_sha256),
      p_requested_at
    );
  end if;
  return query select * from public.controlled_import_publication_status_v1 where operation_id = p_operation_id;
end;
$$;

create or replace function private.claim_controlled_import_recovery(
  p_worker_id text,
  p_now timestamptz,
  p_lease interval,
  p_limit integer
) returns table (
  operation_id text,
  worker_id text,
  fencing_token integer,
  lease_expires_at timestamptz,
  state text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_candidate record;
  v_claimed record;
begin
  for v_candidate in
    select r.operation_id as candidate_operation_id
    from private.controlled_import_requests r
    where r.state in ('received', 'leased', 'validated')
      and (r.lease_expires_at is null or r.lease_expires_at <= p_now)
    order by r.created_at, r.operation_id
    for update skip locked
    limit p_limit
  loop
    update private.controlled_import_requests r
    set lease_owner = p_worker_id,
        lease_expires_at = p_now + p_lease,
        fencing_token = r.fencing_token + 1,
        state = case when r.state = 'validated' then 'validated' else 'leased' end,
        transitioned_at = p_now
    where r.operation_id = v_candidate.candidate_operation_id
    returning r.operation_id, r.fencing_token, r.lease_expires_at, r.state
      into strict v_claimed;
    perform private.append_controlled_import_audit(
      v_claimed.operation_id, 'lease_claimed',
      jsonb_build_object('worker_id', p_worker_id, 'fencing_token', v_claimed.fencing_token),
      p_now
    );
    operation_id := v_claimed.operation_id;
    worker_id := p_worker_id;
    fencing_token := v_claimed.fencing_token;
    lease_expires_at := v_claimed.lease_expires_at;
    state := v_claimed.state;
    return next;
  end loop;
end;
$$;

create or replace function private.controlled_import_stage_exact_bytes(
  p_operation_id text,
  p_worker_id text,
  p_fencing_token integer,
  p_artifact_bytes bytea,
  p_artifact_sha256 text,
  p_identity_token_sha256 text,
  p_occurred_at timestamptz
) returns setof public.controlled_import_publication_status_v1
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.controlled_import_requests%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operation_id, 0));
  select * into strict v_row from private.controlled_import_requests
  where operation_id = p_operation_id for update;
  if v_row.lease_owner <> p_worker_id or v_row.fencing_token <> p_fencing_token
     or v_row.lease_expires_at <= p_occurred_at then
    raise exception using errcode = 'CI002', message = 'CONTROLLED_IMPORT_LEASE_FENCED';
  end if;
  if v_row.state not in ('leased', 'validated') then
    raise exception using errcode = 'CI003', message = 'CONTROLLED_IMPORT_INVALID_STAGE_STATE';
  end if;
  if encode(public.digest(p_artifact_bytes, 'sha256'), 'hex') <> p_artifact_sha256
     or (v_row.expected_artifact_sha256 is not null and v_row.expected_artifact_sha256 <> p_artifact_sha256) then
    raise exception using errcode = 'CI001', message = 'CONTROLLED_IMPORT_EXACT_BYTES_MISMATCH';
  end if;
  insert into private.controlled_import_artifacts (
    operation_id, artifact_bytes, artifact_sha256, identity_token_sha256, byte_count, staged_at
  ) values (
    p_operation_id, p_artifact_bytes, p_artifact_sha256, p_identity_token_sha256,
    octet_length(p_artifact_bytes), p_occurred_at
  ) on conflict (operation_id) do nothing;
  if not exists (
    select 1 from private.controlled_import_artifacts
    where operation_id = p_operation_id and artifact_sha256 = p_artifact_sha256
      and artifact_bytes = p_artifact_bytes and identity_token_sha256 = p_identity_token_sha256
  ) then
    raise exception using errcode = 'CI001', message = 'CONTROLLED_IMPORT_STAGED_BYTES_MISMATCH';
  end if;
  if v_row.state <> 'validated' then
    update private.controlled_import_requests
    set state = 'validated', transitioned_at = p_occurred_at
    where operation_id = p_operation_id;
    perform private.append_controlled_import_audit(
      p_operation_id, 'validated',
      jsonb_build_object('artifact_sha256', p_artifact_sha256, 'byte_count', octet_length(p_artifact_bytes)),
      p_occurred_at
    );
  end if;
  return query select * from public.controlled_import_publication_status_v1 where operation_id = p_operation_id;
end;
$$;

create or replace function private.controlled_import_reject(
  p_operation_id text,
  p_worker_id text,
  p_fencing_token integer,
  p_reason text,
  p_occurred_at timestamptz
) returns setof public.controlled_import_publication_status_v1
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operation_id, 0));
  update private.controlled_import_requests
  set state = 'rejected', rejection_reason = p_reason,
      lease_owner = null, lease_expires_at = null, transitioned_at = p_occurred_at
  where operation_id = p_operation_id and lease_owner = p_worker_id
    and fencing_token = p_fencing_token and lease_expires_at > p_occurred_at
    and state in ('leased', 'validated');
  if not found then raise exception using errcode = 'CI002', message = 'CONTROLLED_IMPORT_LEASE_FENCED'; end if;
  perform private.append_controlled_import_audit(
    p_operation_id, 'rejected', jsonb_build_object('reason', p_reason), p_occurred_at
  );
  return query select * from public.controlled_import_publication_status_v1 where operation_id = p_operation_id;
end;
$$;

create or replace function private.controlled_import_publish(
  p_operation_id text,
  p_worker_id text,
  p_fencing_token integer,
  p_publication_id text,
  p_artifact_sha256 text,
  p_occurred_at timestamptz
) returns setof public.controlled_import_publication_status_v1
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt text;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_operation_id, 0));
  if not exists (
    select 1 from private.controlled_import_requests r
    join private.controlled_import_artifacts a using (operation_id)
    where r.operation_id = p_operation_id and r.state = 'validated'
      and r.lease_owner = p_worker_id and r.fencing_token = p_fencing_token
      and r.lease_expires_at > p_occurred_at and a.artifact_sha256 = p_artifact_sha256
  ) then
    raise exception using errcode = 'CI002', message = 'CONTROLLED_IMPORT_PUBLISH_FENCED_OR_INVALID';
  end if;
  v_receipt := encode(public.digest(convert_to(
    p_publication_id || ':' || p_operation_id || ':' || p_artifact_sha256 || ':' || p_occurred_at::text,
    'UTF8'), 'sha256'), 'hex');
  insert into public.controlled_import_publication_markers (
    publication_id, operation_id, artifact_sha256, publication_receipt_sha256, published_at
  ) values (p_publication_id, p_operation_id, p_artifact_sha256, v_receipt, p_occurred_at);
  update private.controlled_import_requests
  set state = 'published', lease_owner = null, lease_expires_at = null, transitioned_at = p_occurred_at
  where operation_id = p_operation_id;
  perform private.append_controlled_import_audit(
    p_operation_id, 'published',
    jsonb_build_object('publication_id', p_publication_id, 'artifact_sha256', p_artifact_sha256),
    p_occurred_at
  );
  return query select * from public.controlled_import_publication_status_v1 where operation_id = p_operation_id;
end;
$$;

create or replace function private.open_controlled_import_published_bytes(p_operation_id text)
returns table (artifact_bytes bytea, artifact_sha256 text, byte_count integer)
language sql
stable
security definer
set search_path = ''
as $$
  select a.artifact_bytes, a.artifact_sha256, a.byte_count
  from private.controlled_import_artifacts a
  join public.controlled_import_publication_markers p using (operation_id)
  join private.controlled_import_requests r using (operation_id)
  where a.operation_id = p_operation_id and r.state = 'published'
$$;

revoke all on private.controlled_import_requests from public, anon, authenticated, service_role;
revoke all on private.controlled_import_artifacts from public, anon, authenticated, service_role;
revoke all on private.controlled_import_audit_events from public, anon, authenticated, service_role;
revoke all on public.controlled_import_publication_markers from public, anon, authenticated, service_role;
revoke all on public.controlled_import_publication_status_v1 from public, anon, authenticated, service_role;
revoke all on function private.controlled_import_reserve(text,text,text,text,jsonb,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.claim_controlled_import_recovery(text,timestamptz,interval,integer) from public, anon, authenticated, service_role;
revoke all on function private.controlled_import_stage_exact_bytes(text,text,integer,bytea,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.controlled_import_reject(text,text,integer,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.controlled_import_publish(text,text,integer,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.open_controlled_import_published_bytes(text) from public, anon, authenticated, service_role;

-- The orchestrator must add grants only to the canonical server runtime role,
-- then run isolated PostgreSQL tests. No browser/client/service-role grant is
-- authorized by this request.
