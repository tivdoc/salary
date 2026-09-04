-- Addendum 7 A7-1. Three guards for the reference tenant `legal.reference.il`
-- this session's Pool P work introduced, so that a tenant reserved for legal
-- reference data cannot silently behave like a customer tenant.
--
-- 1. The tenant id is a named constant in exactly one place on the SQL side
--    (this function). The TypeScript side has its own single constant
--    (pool-p-parameter-import.mts's `TENANT`) — two canonical definitions,
--    one per runtime, is the ceiling: SQL and TS share no module system.
create function private.legal_reference_tenant_id()
returns text
language sql immutable security definer set search_path = '' as $$
  select 'legal.reference.il'::text
$$;

alter function private.legal_reference_tenant_id() owner to tivdoc_governance_owner;
revoke all on function private.legal_reference_tenant_id()
  from public, anon, authenticated, service_role;
grant execute on function private.legal_reference_tenant_id()
  to tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime, tivdoc_identity_runtime;

-- 2. No identity session can ever be issued for the reference tenant. The
-- resolved tenant comes from the runtime-installed context
-- (product_identity_session_resolved_tenant, 202609020004), never a caller
-- argument, so this closes the same class of hole that migration already
-- fixed — just for one specific tenant value now, not "any tenant a caller
-- can produce a session for." Verbatim body from 202609020004 plus the one
-- refusal branch.
create or replace function private.product_identity_session_register(
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
  resolved_tenant text := private.product_identity_session_resolved_tenant();
  target_sha256 text;
begin
  if resolved_tenant is null then
    raise exception using errcode = 'P0001', message = 'PRODUCT_TENANT_CONTEXT_MISSING';
  end if;
  if resolved_tenant = private.legal_reference_tenant_id() then
    raise exception using errcode = '42501', message = 'IDENTITY_SESSION_REFUSED_FOR_REFERENCE_TENANT';
  end if;
  target_sha256 := pg_catalog.encode(public.digest(pg_catalog.convert_to(
    resolved_tenant || ':' || target_sid || ':' || target_subject || ':' || target_jti || ':' ||
    target_rotation::text || ':' || target_valid_after::text || ':' || target_expires_at::text || ':' ||
    coalesce(target_reviewer_org, ''), 'UTF8'
  ), 'sha256'), 'hex');
  insert into public.product_identity_sessions(
    tenant_id, sid, subject, current_jti, rotation_counter, valid_after,
    expires_at, revoked_at, reviewer_org_id, session_sha256, created_at
  ) values (
    resolved_tenant, target_sid, target_subject, target_jti, target_rotation,
    target_valid_after, target_expires_at, null, target_reviewer_org,
    target_sha256, target_created_at
  )
  on conflict (tenant_id, sid) do nothing;
  select * into existing
  from public.product_identity_sessions session
  where session.tenant_id = resolved_tenant and session.sid = target_sid;
  if existing.sid is null or existing.session_sha256 is distinct from target_sha256 then
    raise exception using errcode = 'P0001', message = 'PRODUCT_SESSION_REGISTRATION_MISMATCH';
  end if;
  return next existing;
end;
$$;

alter function private.product_identity_session_register(
  text,text,text,bigint,timestamptz,timestamptz,text,timestamptz
) owner to tivdoc_governance_owner;
revoke all on function private.product_identity_session_register(
  text,text,text,bigint,timestamptz,timestamptz,text,timestamptz
) from public, anon, authenticated, service_role;
grant execute on function private.product_identity_session_register(
  text,text,text,bigint,timestamptz,timestamptz,text,timestamptz
) to tivdoc_identity_runtime;

-- 3. The product runtime role (tivdoc_web_runtime) can read the reference
-- tenant's parameters only through the operative path, which refuses any
-- row that is not activation_allowed — every row this session created is
-- draft with activation_allowed false, so this returns nothing for all of
-- them today, correctly. It cannot write: no governance mutation function
-- is granted to tivdoc_web_runtime, here or anywhere else, and this
-- migration grants it nothing new beyond this one read.
create function private.governance_parameter_operative_read(
  target_tenant text,
  target_parameter_id text,
  target_parameter_version text
) returns table (
  tenant_id text,
  parameter_id text,
  parameter_version text,
  revision bigint,
  state text,
  content_sha256 text,
  content_json jsonb
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  return query
  select snapshot.tenant_id, snapshot.aggregate_id, snapshot.aggregate_version,
    snapshot.revision, snapshot.state, snapshot.content_sha256, snapshot.content_json
  from private.governance_aggregate_snapshots snapshot
  where snapshot.tenant_id = target_tenant
    and snapshot.workflow_kind = 'parameter_approval'
    and snapshot.aggregate_id = target_parameter_id
    and snapshot.aggregate_version = target_parameter_version
    and snapshot.activation_allowed = true
  order by snapshot.recorded_at desc, snapshot.revision desc, snapshot.mutation_scope desc
  limit 1;
end;
$$;

alter function private.governance_parameter_operative_read(text, text, text)
  owner to tivdoc_governance_owner;
revoke all on function private.governance_parameter_operative_read(text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.governance_parameter_operative_read(text, text, text)
  to tivdoc_web_runtime;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'legal_reference_tenant_guards',
  'tivdoc-legal-reference-tenant-guards-v0',
  '202609020021_legal_reference_tenant_guards'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on function private.legal_reference_tenant_id() is
  'The one named constant for the legal-reference tenant id. Addendum 7 A7-1 guard 1: never a string literal anywhere else in SQL.';
comment on function private.governance_parameter_operative_read(text, text, text) is
  'Addendum 7 A7-1 guard 3: the only path tivdoc_web_runtime has to read a parameter, and it refuses any row that is not activation_allowed.';
