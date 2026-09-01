-- V0.10.2 forward-only least-privilege repair.
-- SECURITY DEFINER functions owned by tivdoc_governance_owner use fully
-- qualified helpers in the private schema. PostgreSQL still requires the
-- function owner to hold schema USAGE when resolving those helpers.

grant usage on schema private to tivdoc_governance_owner;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'governance_owner_schema_usage_repair',
  'tivdoc-governance-owner-schema-usage-repair-v0.10.2',
  '202609010009_governance_owner_schema_usage_repair'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on schema private is
  'Private Tivdoc runtime and governance surface; schema usage is limited to explicitly granted least-privilege runtime and function-owner roles.';
