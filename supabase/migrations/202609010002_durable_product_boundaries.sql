-- Tivdoc V0.10 forward-only durable product boundaries.
-- Server-mediated only: no browser, anon, or authenticated-client grants.

create table public.product_identity_sessions (
  tenant_id text not null,
  sid text primary key check (sid ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$'),
  subject text not null check (subject ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$'),
  current_jti text not null check (current_jti ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$'),
  rotation_counter bigint not null default 0 check (rotation_counter >= 0),
  valid_after timestamptz not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  reviewer_org_id text check (reviewer_org_id is null or reviewer_org_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$'),
  session_sha256 text not null check (session_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  check (expires_at > valid_after),
  check (revoked_at is null or revoked_at >= created_at),
  unique (tenant_id, sid)
);

create table public.product_case_owners (
  tenant_id text not null,
  canonical_case_id text not null,
  subject text not null check (subject ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$'),
  revision bigint not null default 1 check (revision > 0),
  status text not null check (status in ('active', 'revoked')),
  binding_sha256 text not null check (binding_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  revoked_at timestamptz,
  primary key (tenant_id, canonical_case_id),
  foreign key (tenant_id, canonical_case_id)
    references public.engine_case_state(tenant_id, canonical_case_id) on delete restrict,
  check ((status = 'revoked') = (revoked_at is not null)),
  check (revoked_at is null or revoked_at >= created_at)
);

create table public.product_privacy_request_versions (
  request_id text not null check (request_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$'),
  revision bigint not null check (revision > 0),
  tenant_id text not null,
  canonical_case_id text not null,
  request_kind text not null check (request_kind in ('access', 'correction', 'deletion', 'export', 'consent')),
  state text not null check (state in ('requested', 'acknowledged', 'restricted_by_legal_hold', 'completed_by_authorized_operations')),
  idempotency_key text not null check (length(idempotency_key) between 3 and 256),
  command_sha256 text not null check (command_sha256 ~ '^[a-f0-9]{64}$'),
  legal_hold_conflict boolean not null,
  grant_revocation_receipt_sha256 text check (
    grant_revocation_receipt_sha256 is null or grant_revocation_receipt_sha256 ~ '^[a-f0-9]{64}$'
  ),
  created_at timestamptz not null,
  primary key (request_id, revision),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, canonical_case_id)
    references public.engine_case_state(tenant_id, canonical_case_id) on delete restrict,
  check (legal_hold_conflict = (state = 'restricted_by_legal_hold'))
);

create unique index engine_reports_canonical_identity_uq
  on public.engine_report_versions(tenant_id, canonical_case_id, report_id, revision);

create table public.product_private_report_objects (
  tenant_id text not null,
  canonical_case_id text not null,
  report_id text not null,
  report_revision bigint not null check (report_revision > 0),
  report_sha256 text not null check (report_sha256 ~ '^[a-f0-9]{64}$'),
  object_version_id text not null unique check (object_version_id ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,255}$'),
  provider_locator text not null check (
    length(provider_locator) between 3 and 1024
    and provider_locator not like '%://%'
    and provider_locator not like '%..%'
    and provider_locator !~ '[[:cntrl:]]'
  ),
  byte_length bigint not null check (byte_length > 0 and byte_length <= 52428800),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('staged', 'approved', 'revoked')),
  grant_epoch bigint not null default 0 check (grant_epoch >= 0),
  revocation_receipt_sha256 text check (
    revocation_receipt_sha256 is null or revocation_receipt_sha256 ~ '^[a-f0-9]{64}$'
  ),
  revoked_at timestamptz,
  created_at timestamptz not null,
  primary key (tenant_id, canonical_case_id, report_id, report_revision),
  foreign key (tenant_id, canonical_case_id, report_id, report_revision)
    references public.engine_report_versions(tenant_id, canonical_case_id, report_id, revision) on delete restrict,
  unique (tenant_id, canonical_case_id, report_sha256, artifact_sha256),
  check ((state = 'revoked') = (revoked_at is not null)),
  check ((state = 'revoked') = (revocation_receipt_sha256 is not null)),
  check (revoked_at is null or revoked_at >= created_at)
);

create index product_identity_sessions_active_idx
  on public.product_identity_sessions(tenant_id, expires_at, sid)
  where revoked_at is null;
create index product_case_owners_subject_idx
  on public.product_case_owners(tenant_id, subject, canonical_case_id)
  where status = 'active';
create index product_privacy_request_case_idx
  on public.product_privacy_request_versions(tenant_id, canonical_case_id, request_id, revision desc);
create index product_private_report_object_read_idx
  on public.product_private_report_objects(tenant_id, canonical_case_id, report_id, report_revision, state);

create or replace function private.product_forbid_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'PRODUCT_DURABLE_HISTORY_DELETE_FORBIDDEN';
end;
$$;

create or replace function private.product_forbid_privacy_mutation()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = 'PRODUCT_PRIVACY_HISTORY_APPEND_ONLY';
end;
$$;

create trigger product_identity_session_no_delete
before delete on public.product_identity_sessions
for each row execute function private.product_forbid_delete();
create trigger product_case_owner_no_delete
before delete on public.product_case_owners
for each row execute function private.product_forbid_delete();
create trigger product_privacy_append_only
before update or delete on public.product_privacy_request_versions
for each row execute function private.product_forbid_privacy_mutation();
create trigger product_private_report_no_delete
before delete on public.product_private_report_objects
for each row execute function private.product_forbid_delete();

create or replace function private.product_identity_session_read(
  target_sid text
) returns table (
  session_id text,
  subject text,
  status text,
  current_token_id text,
  rotation_counter bigint,
  valid_after_epoch bigint,
  expires_at_epoch bigint,
  reviewer_organization_id text
)
language sql stable security definer set search_path = '' as $$
  select session.sid, session.subject,
         case when session.revoked_at is null then 'active'::text else 'revoked'::text end,
         session.current_jti, session.rotation_counter,
         floor(extract(epoch from session.valid_after))::bigint,
         floor(extract(epoch from session.expires_at))::bigint,
         session.reviewer_org_id
  from public.product_identity_sessions session
  where session.sid = target_sid
$$;

create or replace function private.product_identity_session_register(
  target_tenant text,
  target_sid text,
  target_subject text,
  target_jti text,
  target_rotation bigint,
  target_valid_after timestamptz,
  target_expires_at timestamptz,
  target_reviewer_org text,
  target_created_at timestamptz
) returns setof public.product_identity_sessions
language plpgsql security definer set search_path = '' as $$
declare
  existing public.product_identity_sessions%rowtype;
  target_sha256 text;
begin
  if target_tenant <> nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'PRODUCT_TENANT_CONTEXT_MISMATCH';
  end if;
  target_sha256 := encode(public.digest(convert_to(
    target_tenant || ':' || target_sid || ':' || target_subject || ':' || target_jti || ':' ||
    target_rotation::text || ':' || target_valid_after::text || ':' || target_expires_at::text || ':' ||
    coalesce(target_reviewer_org, ''), 'UTF8'
  ), 'sha256'), 'hex');
  insert into public.product_identity_sessions (
    tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
    expires_at, reviewer_org_id, session_sha256, created_at
  ) values (
    target_tenant, target_sid, target_subject, target_jti, target_rotation, target_valid_after,
    target_expires_at, target_reviewer_org, target_sha256, target_created_at
  ) on conflict (sid) do nothing;
  select * into strict existing from public.product_identity_sessions session where session.sid = target_sid;
  if existing.tenant_id <> target_tenant or existing.subject <> target_subject
    or existing.current_jti <> target_jti or existing.rotation_counter <> target_rotation
    or existing.valid_after <> target_valid_after or existing.expires_at <> target_expires_at
    or existing.reviewer_org_id is distinct from target_reviewer_org
    or existing.session_sha256 <> target_sha256 or existing.revoked_at is not null then
    raise exception using errcode = 'P0001', message = 'PRODUCT_SESSION_REGISTRATION_MISMATCH';
  end if;
  return next existing;
end;
$$;

create or replace function private.product_session_rotate(
  target_tenant text,
  target_sid text,
  next_jti text,
  expected_rotation bigint,
  rotated_at timestamptz
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if target_tenant <> nullif(current_setting('tivdoc.tenant_id', true), '')
     or next_jti !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$' then
    return false;
  end if;
  update public.product_identity_sessions session
  set current_jti = next_jti,
      rotation_counter = session.rotation_counter + 1,
      valid_after = greatest(session.valid_after, rotated_at),
      session_sha256 = encode(public.digest(convert_to(
        session.tenant_id || ':' || session.sid || ':' || session.subject || ':' || next_jti || ':' ||
        (session.rotation_counter + 1)::text || ':' || greatest(session.valid_after, rotated_at)::text || ':' ||
        session.expires_at::text || ':' || coalesce(session.reviewer_org_id, ''), 'UTF8'
      ), 'sha256'), 'hex')
  where session.tenant_id = target_tenant and session.sid = target_sid
    and session.revoked_at is null and session.expires_at > rotated_at
    and session.rotation_counter = expected_rotation;
  if found then return true; end if;
  return exists (
    select 1 from public.product_identity_sessions session
    where session.tenant_id = target_tenant and session.sid = target_sid
      and session.current_jti = next_jti
      and session.rotation_counter = expected_rotation + 1
      and session.valid_after = rotated_at and session.revoked_at is null
  );
end;
$$;

create or replace function private.product_session_revoke(
  target_tenant text,
  target_sid text,
  revoked_at_value timestamptz
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if target_tenant <> nullif(current_setting('tivdoc.tenant_id', true), '') then return false; end if;
  update public.product_identity_sessions session
  set revoked_at = revoked_at_value,
      session_sha256 = encode(public.digest(convert_to(
        session.tenant_id || ':' || session.sid || ':' || session.subject || ':' || session.current_jti || ':' ||
        session.rotation_counter::text || ':' || session.valid_after::text || ':' || session.expires_at::text || ':' ||
        revoked_at_value::text || ':' || coalesce(session.reviewer_org_id, ''), 'UTF8'
      ), 'sha256'), 'hex')
  where session.tenant_id = target_tenant and session.sid = target_sid
    and session.revoked_at is null and revoked_at_value >= session.created_at;
  if found then return true; end if;
  return exists (
    select 1 from public.product_identity_sessions session
    where session.tenant_id = target_tenant and session.sid = target_sid
      and session.revoked_at = revoked_at_value
  );
end;
$$;

create or replace function private.product_owner_lookup(
  target_tenant text,
  target_case text,
  target_subject text
) returns setof public.product_case_owners
language sql stable security definer set search_path = '' as $$
  select owner.* from public.product_case_owners owner
  where owner.tenant_id = target_tenant
    and owner.canonical_case_id = target_case
    and owner.subject = target_subject
    and owner.status = 'active'
    and target_tenant = nullif(current_setting('tivdoc.tenant_id', true), '')
$$;

create or replace function private.product_case_owner_bind(
  target_tenant text,
  target_case text,
  target_subject text,
  target_binding_sha256 text,
  target_created_at timestamptz
) returns setof public.product_case_owners
language plpgsql security definer set search_path = '' as $$
declare
  existing public.product_case_owners%rowtype;
begin
  if target_tenant <> nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'PRODUCT_TENANT_CONTEXT_MISMATCH';
  end if;
  insert into public.product_case_owners (
    tenant_id, canonical_case_id, subject, revision, status,
    binding_sha256, created_at, revoked_at
  ) values (
    target_tenant, target_case, target_subject, 1, 'active',
    target_binding_sha256, target_created_at, null
  ) on conflict (tenant_id, canonical_case_id) do nothing;
  select * into strict existing from public.product_case_owners owner
  where owner.tenant_id = target_tenant and owner.canonical_case_id = target_case;
  if existing.subject <> target_subject or existing.revision <> 1 or existing.status <> 'active'
    or existing.binding_sha256 <> target_binding_sha256 or existing.created_at <> target_created_at
    or existing.revoked_at is not null then
    raise exception using errcode = 'P0001', message = 'PRODUCT_OWNER_BINDING_MISMATCH';
  end if;
  return next existing;
end;
$$;

create or replace function private.product_owner_revoke(
  target_tenant text,
  target_case text,
  target_subject text,
  revoked_at_value timestamptz
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if target_tenant <> nullif(current_setting('tivdoc.tenant_id', true), '') then return false; end if;
  update public.product_case_owners owner
  set status = 'revoked', revision = owner.revision + 1, revoked_at = revoked_at_value,
      binding_sha256 = encode(public.digest(convert_to(
        owner.tenant_id || ':' || owner.canonical_case_id || ':' || owner.subject || ':' ||
        (owner.revision + 1)::text || ':revoked:' || revoked_at_value::text, 'UTF8'
      ), 'sha256'), 'hex')
  where owner.tenant_id = target_tenant and owner.canonical_case_id = target_case
    and owner.subject = target_subject and owner.status = 'active'
    and revoked_at_value >= owner.created_at;
  if found then return true; end if;
  return exists (
    select 1 from public.product_case_owners owner
    where owner.tenant_id = target_tenant and owner.canonical_case_id = target_case
      and owner.subject = target_subject and owner.status = 'revoked'
      and owner.revoked_at = revoked_at_value
  );
end;
$$;

create or replace function private.product_privacy_append(
  target_request_id text,
  target_tenant text,
  target_case text,
  target_revision bigint,
  target_request_kind text,
  target_state text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_legal_hold_conflict boolean,
  target_grant_revocation_sha256 text,
  target_created_at timestamptz
) returns setof public.product_privacy_request_versions
language plpgsql security definer set search_path = '' as $$
declare
  existing public.product_privacy_request_versions%rowtype;
  prior public.product_privacy_request_versions%rowtype;
begin
  if target_tenant <> nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'PRODUCT_TENANT_CONTEXT_MISMATCH';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_tenant || ':' || target_request_id, 0));
  select * into existing from public.product_privacy_request_versions item
  where item.tenant_id = target_tenant and item.idempotency_key = target_idempotency_key;
  if existing.request_id is not null then
    if existing.request_id <> target_request_id or existing.revision <> target_revision
      or existing.canonical_case_id <> target_case or existing.request_kind <> target_request_kind
      or existing.state <> target_state or existing.command_sha256 <> target_command_sha256
      or existing.legal_hold_conflict <> target_legal_hold_conflict
      or existing.grant_revocation_receipt_sha256 is distinct from target_grant_revocation_sha256 then
      raise exception using errcode = 'P0001', message = 'PRODUCT_PRIVACY_IDEMPOTENCY_MISMATCH';
    end if;
    return next existing;
    return;
  end if;
  select * into prior from public.product_privacy_request_versions item
  where item.request_id = target_request_id order by item.revision desc limit 1 for update;
  if prior.request_id is null then
    if target_revision <> 1 or target_state not in ('requested', 'restricted_by_legal_hold') then
      raise exception using errcode = 'P0001', message = 'PRODUCT_PRIVACY_REVISION_CONFLICT';
    end if;
  elsif target_revision <> prior.revision + 1
    or target_tenant <> prior.tenant_id or target_case <> prior.canonical_case_id
    or target_request_kind <> prior.request_kind
    or not (
      (prior.state = 'requested' and target_state in ('acknowledged', 'restricted_by_legal_hold', 'completed_by_authorized_operations'))
      or (prior.state = 'acknowledged' and target_state in ('restricted_by_legal_hold', 'completed_by_authorized_operations'))
      or (prior.state = 'restricted_by_legal_hold' and target_state in ('acknowledged', 'completed_by_authorized_operations'))
    ) then
    raise exception using errcode = 'P0001', message = 'PRODUCT_PRIVACY_REVISION_CONFLICT';
  end if;
  insert into public.product_privacy_request_versions (
    request_id, revision, tenant_id, canonical_case_id, request_kind, state,
    idempotency_key, command_sha256, legal_hold_conflict,
    grant_revocation_receipt_sha256, created_at
  ) values (
    target_request_id, target_revision, target_tenant, target_case, target_request_kind, target_state,
    target_idempotency_key, target_command_sha256, target_legal_hold_conflict,
    target_grant_revocation_sha256, target_created_at
  ) returning * into existing;
  return next existing;
end;
$$;

create or replace function private.product_report_object_approve(
  target_tenant text,
  target_case text,
  target_object_version_id text,
  expected_grant_epoch bigint
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if target_tenant <> nullif(current_setting('tivdoc.tenant_id', true), '') then return false; end if;
  update public.product_private_report_objects object
  set state = 'approved', grant_epoch = object.grant_epoch + 1
  where object.tenant_id = target_tenant and object.canonical_case_id = target_case
    and object.object_version_id = target_object_version_id and object.state = 'staged'
    and object.grant_epoch = expected_grant_epoch;
  if found then return true; end if;
  return exists (
    select 1 from public.product_private_report_objects object
    where object.tenant_id = target_tenant and object.canonical_case_id = target_case
      and object.object_version_id = target_object_version_id and object.state = 'approved'
      and object.grant_epoch = expected_grant_epoch + 1
  );
end;
$$;

create or replace function private.product_private_report_object_bind(
  target_tenant text,
  target_case text,
  target_report_id text,
  target_report_revision bigint,
  target_report_sha256 text,
  target_object_version_id text,
  target_provider_locator text,
  target_byte_length bigint,
  target_artifact_sha256 text,
  target_created_at timestamptz
) returns setof public.product_private_report_objects
language plpgsql security definer set search_path = '' as $$
declare
  existing public.product_private_report_objects%rowtype;
begin
  if target_tenant <> nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'PRODUCT_TENANT_CONTEXT_MISMATCH';
  end if;
  insert into public.product_private_report_objects (
    tenant_id, canonical_case_id, report_id, report_revision, report_sha256,
    object_version_id, provider_locator, byte_length, artifact_sha256,
    state, grant_epoch, created_at
  ) values (
    target_tenant, target_case, target_report_id, target_report_revision, target_report_sha256,
    target_object_version_id, target_provider_locator, target_byte_length, target_artifact_sha256,
    'staged', 0, target_created_at
  ) on conflict (tenant_id, canonical_case_id, report_id, report_revision) do nothing;
  select * into strict existing from public.product_private_report_objects object
  where object.tenant_id = target_tenant and object.canonical_case_id = target_case
    and object.report_id = target_report_id and object.report_revision = target_report_revision;
  if existing.report_sha256 <> target_report_sha256
    or existing.object_version_id <> target_object_version_id
    or existing.provider_locator <> target_provider_locator
    or existing.byte_length <> target_byte_length
    or existing.artifact_sha256 <> target_artifact_sha256
    or existing.state <> 'staged' or existing.grant_epoch <> 0
    or existing.created_at <> target_created_at then
    raise exception using errcode = 'P0001', message = 'PRODUCT_REPORT_OBJECT_BINDING_MISMATCH';
  end if;
  return next existing;
end;
$$;

create or replace function private.product_report_object_approved_read(
  target_tenant text,
  target_case text,
  target_report_id text,
  target_report_revision bigint,
  target_report_sha256 text,
  target_artifact_sha256 text
) returns table (
  object_version_id text,
  provider_locator text,
  byte_length bigint,
  artifact_sha256 text,
  grant_epoch bigint
)
language sql stable security definer set search_path = '' as $$
  select object.object_version_id, object.provider_locator, object.byte_length,
         object.artifact_sha256, object.grant_epoch
  from public.product_private_report_objects object
  where object.tenant_id = target_tenant and object.canonical_case_id = target_case
    and object.report_id = target_report_id and object.report_revision = target_report_revision
    and object.report_sha256 = target_report_sha256 and object.artifact_sha256 = target_artifact_sha256
    and object.state = 'approved' and object.revoked_at is null
    and target_tenant = nullif(current_setting('tivdoc.tenant_id', true), '')
$$;

create or replace function private.product_report_object_revoke(
  target_tenant text,
  target_case text,
  target_object_version_id text,
  expected_grant_epoch bigint,
  target_revocation_receipt_sha256 text,
  revoked_at_value timestamptz
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if target_tenant <> nullif(current_setting('tivdoc.tenant_id', true), '')
    or target_revocation_receipt_sha256 !~ '^[a-f0-9]{64}$' then return false; end if;
  update public.product_private_report_objects object
  set state = 'revoked', grant_epoch = object.grant_epoch + 1,
      revocation_receipt_sha256 = target_revocation_receipt_sha256,
      revoked_at = revoked_at_value
  where object.tenant_id = target_tenant and object.canonical_case_id = target_case
    and object.object_version_id = target_object_version_id and object.state = 'approved'
    and object.grant_epoch = expected_grant_epoch and revoked_at_value >= object.created_at;
  if found then return true; end if;
  return exists (
    select 1 from public.product_private_report_objects object
    where object.tenant_id = target_tenant and object.canonical_case_id = target_case
      and object.object_version_id = target_object_version_id and object.state = 'revoked'
      and object.grant_epoch = expected_grant_epoch + 1
      and object.revocation_receipt_sha256 = target_revocation_receipt_sha256
      and object.revoked_at = revoked_at_value
  );
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'product_identity_sessions', 'product_case_owners',
    'product_privacy_request_versions', 'product_private_report_objects'
  ] loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy tivdoc_service_tenant_scope on public.%I to service_role using (tenant_id = nullif(current_setting(''tivdoc.tenant_id'', true), '''')) with check (tenant_id = nullif(current_setting(''tivdoc.tenant_id'', true), ''''))',
      table_name
    );
  end loop;
end;
$$;

revoke all on table
  public.product_identity_sessions,
  public.product_case_owners,
  public.product_privacy_request_versions,
  public.product_private_report_objects
from public, anon, authenticated, service_role;
grant select, insert on table
  public.product_identity_sessions,
  public.product_case_owners,
  public.product_private_report_objects
to service_role;
grant select on table public.product_privacy_request_versions to service_role;

revoke all on function private.product_forbid_delete() from public, anon, authenticated, service_role;
revoke all on function private.product_forbid_privacy_mutation() from public, anon, authenticated, service_role;
revoke all on function private.product_identity_session_read(text) from public, anon, authenticated, service_role;
revoke all on function private.product_identity_session_register(text,text,text,text,bigint,timestamptz,timestamptz,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.product_session_rotate(text,text,text,bigint,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.product_session_revoke(text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.product_case_owner_bind(text,text,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.product_owner_lookup(text,text,text) from public, anon, authenticated, service_role;
revoke all on function private.product_owner_revoke(text,text,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.product_privacy_append(text,text,text,bigint,text,text,text,text,boolean,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.product_report_object_approve(text,text,text,bigint) from public, anon, authenticated, service_role;
revoke all on function private.product_private_report_object_bind(text,text,text,bigint,text,text,text,bigint,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.product_report_object_approved_read(text,text,text,bigint,text,text) from public, anon, authenticated, service_role;
revoke all on function private.product_report_object_revoke(text,text,text,bigint,text,timestamptz) from public, anon, authenticated, service_role;

grant execute on function private.product_identity_session_read(text) to service_role;
grant execute on function private.product_identity_session_register(text,text,text,text,bigint,timestamptz,timestamptz,text,timestamptz) to service_role;
grant execute on function private.product_session_rotate(text,text,text,bigint,timestamptz) to service_role;
grant execute on function private.product_session_revoke(text,text,timestamptz) to service_role;
grant execute on function private.product_case_owner_bind(text,text,text,text,timestamptz) to service_role;
grant execute on function private.product_owner_lookup(text,text,text) to service_role;
grant execute on function private.product_owner_revoke(text,text,text,timestamptz) to service_role;
grant execute on function private.product_privacy_append(text,text,text,bigint,text,text,text,text,boolean,text,timestamptz) to service_role;
grant execute on function private.product_report_object_approve(text,text,text,bigint) to service_role;
grant execute on function private.product_private_report_object_bind(text,text,text,bigint,text,text,text,bigint,text,timestamptz) to service_role;
grant execute on function private.product_report_object_approved_read(text,text,text,bigint,text,text) to service_role;
grant execute on function private.product_report_object_revoke(text,text,text,bigint,text,timestamptz) to service_role;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'durable_product_boundaries',
  'tivdoc-durable-product-postgresql-v0.10.0',
  '202609010002_durable_product_boundaries'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on table public.product_identity_sessions is
  'Server-only durable session state; JWT verification fails closed when no exact row exists.';
comment on table public.product_private_report_objects is
  'Server-only exact report artifact metadata; provider locators are never client-visible.';
