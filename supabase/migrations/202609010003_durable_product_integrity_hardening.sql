-- Tivdoc V0.10.1 forward-only durable product integrity hardening.
-- Server-mediated only: no browser, anon, or authenticated-client grants.

create unique index engine_reports_product_exact_binding_uq
  on public.engine_report_versions(
    tenant_id, canonical_case_id, report_id, revision, report_sha256, pdf_sha256
  );

alter table public.product_private_report_objects
  add constraint product_private_report_object_exact_report_fkey
  foreign key (
    tenant_id, canonical_case_id, report_id, report_revision, report_sha256, artifact_sha256
  ) references public.engine_report_versions(
    tenant_id, canonical_case_id, report_id, revision, report_sha256, pdf_sha256
  ) on delete restrict not valid;

drop function private.product_identity_session_read(text);

create function private.product_identity_session_read(
  target_sid text
) returns table (
  tenant_id text,
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
  select session.tenant_id, session.sid, session.subject,
         case when session.revoked_at is null then 'active'::text else 'revoked'::text end,
         session.current_jti, session.rotation_counter,
         floor(extract(epoch from session.valid_after))::bigint,
         floor(extract(epoch from session.expires_at))::bigint,
         session.reviewer_org_id
  from public.product_identity_sessions session
  where session.sid = target_sid
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
      valid_after = rotated_at,
      session_sha256 = encode(public.digest(convert_to(
        session.tenant_id || ':' || session.sid || ':' || session.subject || ':' || next_jti || ':' ||
        (session.rotation_counter + 1)::text || ':' || rotated_at::text || ':' ||
        session.expires_at::text || ':' || coalesce(session.reviewer_org_id, ''), 'UTF8'
      ), 'sha256'), 'hex')
  where session.tenant_id = target_tenant and session.sid = target_sid
    and session.revoked_at is null and session.expires_at > rotated_at
    and rotated_at >= session.valid_after
    and session.rotation_counter = expected_rotation;
  if found then return true; end if;
  return exists (
    select 1 from public.product_identity_sessions session
    where session.tenant_id = target_tenant and session.sid = target_sid
      and session.current_jti = next_jti
      and session.rotation_counter = expected_rotation + 1
      and session.valid_after = rotated_at
      and session.expires_at > rotated_at
      and session.revoked_at is null
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
    if existing.tenant_id <> target_tenant
      or existing.request_id <> target_request_id or existing.revision <> target_revision
      or existing.canonical_case_id <> target_case or existing.request_kind <> target_request_kind
      or existing.state <> target_state or existing.command_sha256 <> target_command_sha256
      or existing.legal_hold_conflict <> target_legal_hold_conflict
      or existing.grant_revocation_receipt_sha256 is distinct from target_grant_revocation_sha256
      or existing.created_at <> target_created_at then
      raise exception using errcode = 'P0001', message = 'PRODUCT_PRIVACY_IDEMPOTENCY_MISMATCH';
    end if;
    return next existing;
    return;
  end if;
  select * into prior from public.product_privacy_request_versions item
  where item.tenant_id = target_tenant and item.request_id = target_request_id
  order by item.revision desc limit 1 for update;
  if prior.request_id is null then
    if target_revision <> 1 or target_state not in ('requested', 'restricted_by_legal_hold') then
      raise exception using errcode = 'P0001', message = 'PRODUCT_PRIVACY_REVISION_CONFLICT';
    end if;
  elsif target_revision <> prior.revision + 1
    or target_case <> prior.canonical_case_id
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
  if not exists (
    select 1 from public.engine_report_versions report
    where report.tenant_id = target_tenant
      and report.canonical_case_id = target_case
      and report.report_id = target_report_id
      and report.revision = target_report_revision
      and report.report_sha256 = target_report_sha256
      and report.pdf_sha256 = target_artifact_sha256
  ) then
    raise exception using errcode = 'P0001', message = 'PRODUCT_REPORT_CANONICAL_BINDING_MISMATCH';
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
    and object.grant_epoch = expected_grant_epoch
    and exists (
      select 1
      from public.engine_report_versions report
      join public.engine_review_task_versions approval
        on approval.tenant_id = report.tenant_id
       and approval.case_id = report.case_id
       and approval.report_id = report.report_id
       and approval.report_revision = report.revision
       and approval.report_sha256 = report.report_sha256
      where report.tenant_id = object.tenant_id
        and report.canonical_case_id = object.canonical_case_id
        and report.report_id = object.report_id
        and report.revision = object.report_revision
        and report.report_sha256 = object.report_sha256
        and report.pdf_sha256 = object.artifact_sha256
        and report.review_eligible = true
        and approval.canonical_case_id = object.canonical_case_id
        and approval.task_kind = 'report_approval'
        and approval.input_sha256 = report.report_sha256
        and approval.output_sha256 = report.report_sha256
        and approval.release_state = 'approved'
        and approval.invalidated_at is null
        and approval.decision_payload ->> 'decision' = 'approved'
        and not exists (
          select 1 from public.engine_review_task_versions newer
          where newer.tenant_id = approval.tenant_id
            and newer.task_id = approval.task_id
            and newer.revision > approval.revision
        )
    );
  if found then return true; end if;
  return exists (
    select 1
    from public.product_private_report_objects object
    join public.engine_report_versions report
      on report.tenant_id = object.tenant_id
     and report.canonical_case_id = object.canonical_case_id
     and report.report_id = object.report_id
     and report.revision = object.report_revision
     and report.report_sha256 = object.report_sha256
     and report.pdf_sha256 = object.artifact_sha256
    join public.engine_review_task_versions approval
      on approval.tenant_id = report.tenant_id
     and approval.case_id = report.case_id
     and approval.report_id = report.report_id
     and approval.report_revision = report.revision
     and approval.report_sha256 = report.report_sha256
    where object.tenant_id = target_tenant and object.canonical_case_id = target_case
      and object.object_version_id = target_object_version_id and object.state = 'approved'
      and object.grant_epoch = expected_grant_epoch + 1
      and report.review_eligible = true
      and approval.canonical_case_id = object.canonical_case_id
      and approval.task_kind = 'report_approval'
      and approval.input_sha256 = report.report_sha256
      and approval.output_sha256 = report.report_sha256
      and approval.release_state = 'approved'
      and approval.invalidated_at is null
      and approval.decision_payload ->> 'decision' = 'approved'
      and not exists (
        select 1 from public.engine_review_task_versions newer
        where newer.tenant_id = approval.tenant_id
          and newer.task_id = approval.task_id
          and newer.revision > approval.revision
      )
  );
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
  join public.engine_report_versions report
    on report.tenant_id = object.tenant_id
   and report.canonical_case_id = object.canonical_case_id
   and report.report_id = object.report_id
   and report.revision = object.report_revision
   and report.report_sha256 = object.report_sha256
   and report.pdf_sha256 = object.artifact_sha256
  join public.engine_review_task_versions approval
    on approval.tenant_id = report.tenant_id
   and approval.case_id = report.case_id
   and approval.report_id = report.report_id
   and approval.report_revision = report.revision
   and approval.report_sha256 = report.report_sha256
  where object.tenant_id = target_tenant and object.canonical_case_id = target_case
    and object.report_id = target_report_id and object.report_revision = target_report_revision
    and object.report_sha256 = target_report_sha256 and object.artifact_sha256 = target_artifact_sha256
    and object.state = 'approved' and object.revoked_at is null
    and report.review_eligible = true
    and approval.canonical_case_id = object.canonical_case_id
    and approval.task_kind = 'report_approval'
    and approval.input_sha256 = report.report_sha256
    and approval.output_sha256 = report.report_sha256
    and approval.release_state = 'approved'
    and approval.invalidated_at is null
    and approval.decision_payload ->> 'decision' = 'approved'
    and not exists (
      select 1 from public.engine_review_task_versions newer
      where newer.tenant_id = approval.tenant_id
        and newer.task_id = approval.task_id
        and newer.revision > approval.revision
    )
    and target_tenant = nullif(current_setting('tivdoc.tenant_id', true), '')
$$;

revoke all on function private.product_identity_session_read(text) from public, anon, authenticated, service_role;
revoke all on function private.product_session_rotate(text,text,text,bigint,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.product_privacy_append(text,text,text,bigint,text,text,text,text,boolean,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.product_private_report_object_bind(text,text,text,bigint,text,text,text,bigint,text,timestamptz) from public, anon, authenticated, service_role;
revoke all on function private.product_report_object_approve(text,text,text,bigint) from public, anon, authenticated, service_role;
revoke all on function private.product_report_object_approved_read(text,text,text,bigint,text,text) from public, anon, authenticated, service_role;

grant execute on function private.product_identity_session_read(text) to service_role;
grant execute on function private.product_session_rotate(text,text,text,bigint,timestamptz) to service_role;
grant execute on function private.product_privacy_append(text,text,text,bigint,text,text,text,text,boolean,text,timestamptz) to service_role;
grant execute on function private.product_private_report_object_bind(text,text,text,bigint,text,text,text,bigint,text,timestamptz) to service_role;
grant execute on function private.product_report_object_approve(text,text,text,bigint) to service_role;
grant execute on function private.product_report_object_approved_read(text,text,text,bigint,text,text) to service_role;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'durable_product_boundaries',
  'tivdoc-durable-product-postgresql-v0.10.1',
  '202609010003_durable_product_integrity_hardening'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on constraint product_private_report_object_exact_report_fkey
  on public.product_private_report_objects is
  'Every new private object binding is byte-exact to canonical report and PDF hashes.';
