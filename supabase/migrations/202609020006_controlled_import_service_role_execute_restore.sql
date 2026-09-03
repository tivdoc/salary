-- Restores the EXECUTE grant that 202609020005 removed on a false premise.
--
-- That migration's own header said "every caller goes through
-- `src/server/engine/legal-knowledge/controlled-import-ledger/sql.ts`, which
-- issues direct SQL over a connection authenticated as a runtime role". Half of
-- that is right and the half that matters is wrong. There is no *product*
-- caller — nothing under `src/` imports the repository except its own test —
-- but there is a real caller, and it does not authenticate as a runtime role.
--
-- `scripts/canonical-persistence-v091/marathon-v010.mts` constructs
-- `PostgresControlledImportLedgerRepository` at :981 and :1102 and routes every
-- call through `withMaintenanceTransaction` (:1383). That manager is built from
-- `maintenance_connection_url`, supplied at `run.mts:375` and `:390` as
-- `urls.service_role`, which `orchestration/roles.mts` assembles as a URL whose
-- username is literally `service_role`. No runtime role was ever granted
-- EXECUTE on these six, and the four `tivdoc_*_runtime` roles have
-- `rolinherit = false`, so nothing routes there either. The revoke removed the
-- one grant the isolated dynamic verification run depends on.
--
-- Nothing on DEV broke, because the marathon builds its own throwaway cluster.
-- The defect is that the cluster replays this chain, so the next dynamic run
-- would have failed — and failed misleadingly, since `mapDatabaseError` had no
-- case for SQLSTATE 42501 and reported a permission denial as
-- `IMPORT_ROW_MALFORMED`. That is corrected alongside this.
--
-- The narrowing itself was not wrong to want. It is wrong to do it before the
-- caller has somewhere else to go, and moving a verification harness onto a
-- dedicated principal is its own piece of work with its own proof.

grant execute on function private.controlled_import_reserve(
  text, text, text, text, jsonb, text, text, timestamptz
) to service_role;
grant execute on function private.claim_controlled_import_recovery(
  text, timestamptz, interval, integer
) to service_role;
grant execute on function private.controlled_import_stage_exact_bytes(
  text, text, integer, bytea, text, text, timestamptz
) to service_role;
grant execute on function private.controlled_import_reject(
  text, text, integer, text, timestamptz
) to service_role;
grant execute on function private.controlled_import_publish(
  text, text, integer, text, text, timestamptz
) to service_role;
grant execute on function private.open_controlled_import_published_bytes(text)
  to service_role;

comment on function private.controlled_import_reserve(
  text, text, text, text, jsonb, text, text, timestamptz
) is 'Executed by the dynamic verification harness as service_role (scripts/canonical-persistence-v091/run.mts:375). No product caller: sql.ts records product_wiring_enabled false.';

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'controlled_import_reserved_execute',
  'tivdoc-controlled-import-service-role-execute-restore',
  '202609020006_controlled_import_service_role_execute_restore'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;
