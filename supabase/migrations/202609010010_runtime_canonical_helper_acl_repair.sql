-- V0.10.2 forward-only least-privilege runtime helper repair.
--
-- Migration 006 intentionally removed broad access to the canonical mapping
-- helpers.  The canonical application repositories used by the operations
-- and fresh-worker principals call these two deterministic helpers directly,
-- so grant only their exact signatures to those principals.

revoke all on function private.resolve_engine_case_id(text,text)
  from public, anon, authenticated, service_role;
revoke all on function private.canonical_text_uuid(text,text)
  from public, anon, authenticated, service_role;

alter function private.resolve_engine_case_id(text,text)
  owner to tivdoc_governance_owner;
alter function private.resolve_engine_case_id(text,text)
  set search_path = '';
alter function private.canonical_text_uuid(text,text)
  owner to tivdoc_governance_owner;
alter function private.canonical_text_uuid(text,text)
  set search_path = '';

grant execute on function private.resolve_engine_case_id(text,text)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;
grant execute on function private.canonical_text_uuid(text,text)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'runtime_canonical_helper_acl_repair',
  'tivdoc-runtime-canonical-helper-acl-repair-v0.10.2',
  '202609010010_runtime_canonical_helper_acl_repair'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on function private.canonical_text_uuid(text,text) is
  'Deterministic canonical identifier helper; executable only by explicitly granted least-privilege runtime principals.';
