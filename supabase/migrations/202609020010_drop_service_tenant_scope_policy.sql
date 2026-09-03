-- E3 outcome. `tivdoc_service_tenant_scope` is dropped from every table that
-- carried it, behind the owner-access path.
--
-- The Wave 3 ledger said this policy "widens nothing today, because it is
-- granted to service_role, a role holding no privilege on those 33 tables".
-- That statement is false and is corrected here rather than caveated. Row
-- level security matches roles with has_privs_of_role, not by name, and the
-- transitive membership closure of service_role is five roles:
--
--   authenticator            inherits=false  bypassrls=false  login=true
--   postgres                 inherits=true   bypassrls=true   login=true
--   supabase_realtime_admin  inherits=false  bypassrls=false  login=false
--   tivdoc_dev_migrator      inherits=true   bypassrls=false  login=true
--   supabase_storage_admin   inherits=false  bypassrls=false  login=true
--
-- Two of them inherit. postgres holds full DML on all 33 tables and bypasses
-- RLS, so no policy ever bound it. tivdoc_dev_migrator holds full DML on all
-- 33, can log in, does not bypass RLS, and so was bound by this policy — whose
-- entire test is tenant_id = current_setting('tivdoc.tenant_id'), a value any
-- session may set. That is 33 widening rows on a real principal. The reason it
-- did not amount to an escalation is ownership: that role owns all 31 of the
-- public tables and could turn FORCE off, and the two private ones admit it
-- through governance_owner membership. Nothing reached a table through this
-- policy that it could not reach otherwise — but that is a property of who
-- happens to own the tables today, not of the policy, and it is not the claim
-- the ledger made.
--
-- The policy is now redundant for every role it could bind. The migrator has
-- tivdoc_owner_access on all 31 tables it owns (202609020009) and, as of this
-- migration, on the two governance-owned dependency tables the invalidation
-- fixture reads as admin. service_role itself bypasses RLS. So the policy is
-- removed rather than gated: a caller-settable tenant test has no place in a
-- policy set whose other members all key on runtime_verified_tenant().

create policy tivdoc_owner_access
  on public.engine_global_dependency_state
  for all to tivdoc_dev_migrator using (true) with check (true);
create policy tivdoc_owner_access
  on public.engine_global_dependency_invalidations
  for all to tivdoc_dev_migrator using (true) with check (true);

do $$
declare
  target record;
begin
  for target in
    select n.nspname as schema_name, c.relname as table_name
      from pg_policy p
      join pg_class c on c.oid = p.polrelid
      join pg_namespace n on n.oid = c.relnamespace
     where p.polname = 'tivdoc_service_tenant_scope'
  loop
    execute format('drop policy tivdoc_service_tenant_scope on %I.%I',
      target.schema_name, target.table_name);
  end loop;
end;
$$;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'service_tenant_scope_policy',
  'tivdoc-service-tenant-scope-dropped',
  '202609020010_drop_service_tenant_scope_policy'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;
