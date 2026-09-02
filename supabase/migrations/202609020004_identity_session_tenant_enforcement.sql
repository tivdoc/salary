-- Wave 3 forward-only identity-session tenant enforcement.
--
-- Three of the four identity-session functions took the tenant as their first
-- argument and then "checked" it against `current_setting('tivdoc.tenant_id')`.
-- That is not authorization: a custom GUC is settable by any session, so a
-- caller holding EXECUTE could name any tenant and then rotate or revoke that
-- tenant's sessions. The check looked like a gate and was one only against
-- callers that were not trying.
--
-- Nothing is exposed today — customer reads are zero and there is no production
-- database — and none of the three has a production caller: the only runtime use
-- of this boundary is `product_identity_session_read`. But every surface built
-- on this identity layer inherits the hole, so it is closed now rather than
-- after something real depends on it.
--
-- Four properties, together, because any one alone leaves it open:
--
--   1. the tenant parameter is *removed*, not ignored. An ignored parameter is
--      an invitation to reintroduce the bug, and removing it makes the compiler
--      and the tests enumerate every caller. The tenant now comes from the
--      session context the runtime installed, which the caller cannot choose.
--   2. every function gets an explicit owner and keeps its pinned empty
--      search_path, so the table's policies actually apply to it.
--   3. row level security is enabled and forced on the table, with mutation
--      restricted to the verified tenant.
--   4. EXECUTE is revoked from PUBLIC and the Supabase reserved roles and
--      granted only to the identity runtime principal.
--
-- `product_identity_session_read` keeps its signature: it never took a tenant.
-- It is the bootstrap that resolves a session *before* any verified tenant
-- exists, and its safety comes from the caller comparing the tenant the row
-- returns against the JWT claim (identity-verification.ts:323). Giving it a
-- tenant gate would deadlock the bootstrap against itself.

drop function if exists private.product_identity_session_register(
  text,text,text,text,bigint,timestamptz,timestamptz,text,timestamptz
);
drop function if exists private.product_session_rotate(text,text,text,bigint,timestamptz);
drop function if exists private.product_session_revoke(text,text,timestamptz);

-- The tenant is resolved, never supplied. An absent context refuses.
create function private.product_identity_session_resolved_tenant()
returns text
language sql stable security definer set search_path = '' as $$
  select nullif(pg_catalog.current_setting('tivdoc.tenant_id', true), '')
$$;

create function private.product_identity_session_register(
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

create function private.product_session_rotate(
  target_sid text,
  next_jti text,
  expected_rotation bigint,
  rotated_at timestamptz
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  resolved_tenant text := private.product_identity_session_resolved_tenant();
begin
  if resolved_tenant is null
     or next_jti !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$' then
    return false;
  end if;
  update public.product_identity_sessions session
  set current_jti = next_jti,
      rotation_counter = session.rotation_counter + 1,
      valid_after = rotated_at,
      session_sha256 = pg_catalog.encode(public.digest(pg_catalog.convert_to(
        session.tenant_id || ':' || session.sid || ':' || session.subject || ':' || next_jti || ':' ||
        (session.rotation_counter + 1)::text || ':' || rotated_at::text || ':' ||
        session.expires_at::text || ':' || coalesce(session.reviewer_org_id, ''), 'UTF8'
      ), 'sha256'), 'hex')
  where session.tenant_id = resolved_tenant and session.sid = target_sid
    and session.revoked_at is null and session.expires_at > rotated_at
    and rotated_at >= session.valid_after
    and session.rotation_counter = expected_rotation;
  if found then return true; end if;
  return exists (
    select 1 from public.product_identity_sessions session
    where session.tenant_id = resolved_tenant and session.sid = target_sid
      and session.current_jti = next_jti
      and session.rotation_counter = expected_rotation + 1
      and session.valid_after = rotated_at and session.revoked_at is null
  );
end;
$$;

create function private.product_session_revoke(
  target_sid text,
  revoked_at_value timestamptz
) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  resolved_tenant text := private.product_identity_session_resolved_tenant();
begin
  if resolved_tenant is null then return false; end if;
  update public.product_identity_sessions session
  set revoked_at = revoked_at_value,
      session_sha256 = pg_catalog.encode(public.digest(pg_catalog.convert_to(
        session.tenant_id || ':' || session.sid || ':' || session.subject || ':' || session.current_jti || ':' ||
        session.rotation_counter::text || ':' || session.valid_after::text || ':' || session.expires_at::text || ':' ||
        revoked_at_value::text || ':' || coalesce(session.reviewer_org_id, ''), 'UTF8'
      ), 'sha256'), 'hex')
  where session.tenant_id = resolved_tenant and session.sid = target_sid
    and session.revoked_at is null and revoked_at_value >= session.created_at;
  if found then return true; end if;
  return exists (
    select 1 from public.product_identity_sessions session
    where session.tenant_id = resolved_tenant and session.sid = target_sid
      and session.revoked_at = revoked_at_value
  );
end;
$$;

-- Ownership, so the table's policies apply to these functions at all.
alter function private.product_identity_session_resolved_tenant()
  owner to tivdoc_governance_owner;
alter function private.product_identity_session_read(text)
  owner to tivdoc_governance_owner;
alter function private.product_identity_session_register(
  text,text,text,bigint,timestamptz,timestamptz,text,timestamptz
) owner to tivdoc_governance_owner;
alter function private.product_session_rotate(text,text,bigint,timestamptz)
  owner to tivdoc_governance_owner;
alter function private.product_session_revoke(text,timestamptz)
  owner to tivdoc_governance_owner;

revoke all on function private.product_identity_session_resolved_tenant()
  from public, anon, authenticated, service_role;
revoke all on function private.product_identity_session_read(text)
  from public, anon, authenticated, service_role;
revoke all on function private.product_identity_session_register(
  text,text,text,bigint,timestamptz,timestamptz,text,timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.product_session_rotate(text,text,bigint,timestamptz)
  from public, anon, authenticated, service_role;
revoke all on function private.product_session_revoke(text,timestamptz)
  from public, anon, authenticated, service_role;

grant execute on function private.product_identity_session_read(text)
  to tivdoc_identity_runtime;
grant execute on function private.product_identity_session_register(
  text,text,text,bigint,timestamptz,timestamptz,text,timestamptz
) to tivdoc_identity_runtime;
grant execute on function private.product_session_rotate(text,text,bigint,timestamptz)
  to tivdoc_identity_runtime;
grant execute on function private.product_session_revoke(text,timestamptz)
  to tivdoc_identity_runtime;

-- Row level security, forced, so the table owner is subject to it too.
--
-- The permissive policy keeps the bootstrap working: `runtime_context_install`
-- and `product_identity_session_read` both have to reach a row *before* any
-- tenant is verified, so a select gate would deadlock the identity layer
-- against itself. The restrictive policies are where the enforcement lives —
-- they AND with the permissive one, so an update or delete must satisfy the
-- verified tenant no matter what any other policy allows.
--
-- INSERT is deliberately not restricted to the verified tenant: registration is
-- how the first session for a tenant comes into existence, and at that moment
-- there is no verified tenant to compare against. What closes that is the
-- function above refusing when the resolved tenant is null, plus EXECUTE being
-- held by one role. Restricting INSERT at the row level would require a
-- registration path that runs after verification, which does not exist and has
-- no caller to justify building.
alter table public.product_identity_sessions enable row level security;
alter table public.product_identity_sessions force row level security;

create policy product_identity_sessions_owner_access
  on public.product_identity_sessions
  for all
  to tivdoc_governance_owner
  using (true)
  with check (true);

-- The check is on the resulting row, not on which rows may be locked.
-- PostgreSQL applies an UPDATE policy's USING clause to `select ... for share`
-- as well, and `runtime_context_install` locks the session row *while* it is
-- establishing the very tenant context the policy would test — a gate there
-- deadlocks the bootstrap against itself. WITH CHECK is where the enforcement
-- belongs anyway: an update never changes `tenant_id`, so a row belonging to
-- another tenant fails the check no matter which row was locked to reach it.
create policy product_identity_sessions_update_verified_tenant
  on public.product_identity_sessions
  as restrictive
  for update
  to public
  using (true)
  with check (tenant_id = private.product_identity_session_resolved_tenant());

create policy product_identity_sessions_no_delete
  on public.product_identity_sessions
  as restrictive
  for delete
  to public
  using (false);

revoke all on table public.product_identity_sessions
  from anon, authenticated, service_role;

-- Giving the definer functions an explicit owner moved the authority for their
-- writes from the migrator to `tivdoc_governance_owner`, which held only SELECT
-- and UPDATE — so registration started failing with a bare `permission denied
-- for table`. Nothing caught it, because no test had ever executed register,
-- rotate or revoke; the grant execution proof found it on its first pass over
-- this boundary. INSERT is granted and DELETE deliberately is not: the
-- restrictive policy already refuses deletes, and withholding the privilege
-- means the refusal does not depend on the policy surviving.
grant insert on table public.product_identity_sessions to tivdoc_governance_owner;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'identity_session_tenant_enforcement',
  'tivdoc-identity-session-tenant-enforcement-wave3',
  '202609020004_identity_session_tenant_enforcement'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on function private.product_identity_session_resolved_tenant() is
  'The tenant the runtime installed for this session. Never a caller argument: an identity function that lets its caller name the tenant is not gated at all.';
