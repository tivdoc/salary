-- Wave 1 forward-only repair: the same defect class as 202609010011, four more
-- times.
--
-- Migration 005 granted the four governance import functions to
-- tivdoc_worker_runtime only. The application dispatches all four through a
-- governance transaction that always opens with the operations audience
-- (internal-ops/durable-governance/application.ts:530), so the database
-- principal is tivdoc_operations_runtime, not the worker. The commands gate on
-- the *application* actor role `scoped_background_worker`, which is not a
-- database principal and does not change which role executes the statement.
--
-- Left alone these are four more 42501 refusals waiting for their first caller,
-- discovered at runtime rather than at commit time. The worker grants stay: the
-- worker is still the intended actor, and nothing here widens who may act.

revoke all on function private.governance_legal_observation_import(
  text,jsonb,text,text,timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.governance_parameter_import(
  text,jsonb,text,text,timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.governance_golden_case_set_import(
  text,jsonb,text,text,timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.governance_rulespec_import(
  text,jsonb,text,text,timestamptz
) from public, anon, authenticated, service_role;

grant execute on function private.governance_legal_observation_import(
  text,jsonb,text,text,timestamptz
) to tivdoc_operations_runtime;
grant execute on function private.governance_parameter_import(
  text,jsonb,text,text,timestamptz
) to tivdoc_operations_runtime;
grant execute on function private.governance_golden_case_set_import(
  text,jsonb,text,text,timestamptz
) to tivdoc_operations_runtime;
grant execute on function private.governance_rulespec_import(
  text,jsonb,text,text,timestamptz
) to tivdoc_operations_runtime;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'governance_import_operations_grants',
  'tivdoc-governance-import-operations-grants-wave1',
  '202609020003_governance_import_operations_grants'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;
