-- Tivdoc V0.9.1 test-only compatibility bootstrap for isolated plain PostgreSQL.
-- This is deliberately not a Supabase emulator and is never Production-ready.

do $tivdoc_roles$
declare
  role_name text;
  expected_bypass boolean;
  existing record;
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    expected_bypass := role_name = 'service_role';
    select rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin, rolreplication, rolbypassrls
      into existing
      from pg_catalog.pg_roles
      where rolname = role_name;

    if not found then
      execute format(
        'create role %I nologin nosuperuser noinherit nocreaterole nocreatedb noreplication %s',
        role_name,
        case when expected_bypass then 'bypassrls' else 'nobypassrls' end
      );
    elsif existing.rolsuper
      or existing.rolinherit
      or existing.rolcreaterole
      or existing.rolcreatedb
      -- The owned dynamic runner may enable SCRAM LOGIN after first bootstrap
      -- so subsequent isolated databases can use genuine role sessions.
      or existing.rolreplication
      or existing.rolbypassrls <> expected_bypass then
      raise exception 'TIVDOC_PLAIN_PG_COMPAT_ROLE_MISMATCH:%', role_name;
    end if;
  end loop;
end
$tivdoc_roles$;

create schema if not exists storage authorization current_user;

create table if not exists storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

comment on schema storage is
  'Tivdoc V0.9.1 isolated plain-PostgreSQL compatibility surface; not Supabase platform proof.';
comment on table storage.buckets is
  'Minimal test-only shape required by Tivdoc migrations; no Storage API behavior is provided.';

do $tivdoc_storage_shape$
declare
  missing_columns text[];
begin
  select array_agg(required.column_name order by required.column_name)
    into missing_columns
    from (values
      ('allowed_mime_types'),
      ('file_size_limit'),
      ('id'),
      ('name'),
      ('public')
    ) as required(column_name)
    where not exists (
      select 1
      from information_schema.columns actual
      where actual.table_schema = 'storage'
        and actual.table_name = 'buckets'
        and actual.column_name = required.column_name
    );

  if missing_columns is not null then
    raise exception 'TIVDOC_PLAIN_PG_STORAGE_BUCKETS_SHAPE_MISMATCH:%', missing_columns;
  end if;
end
$tivdoc_storage_shape$;
