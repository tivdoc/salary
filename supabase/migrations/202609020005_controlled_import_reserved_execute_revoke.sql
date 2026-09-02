-- Wave 3 (C2). Take the reserved-role EXECUTE off the controlled-import ledger.
--
-- Six SECURITY DEFINER functions in `private` still carry EXECUTE for
-- `service_role`, granted by 202609010001 before the ledger had a runtime
-- principal of its own. Nothing reaches them that way: every caller goes
-- through `src/server/engine/legal-knowledge/controlled-import-ledger/sql.ts`,
-- which issues direct SQL over a connection authenticated as a runtime role.
-- No `supabase.rpc` call names any of them, and `private` is not an exposed
-- schema, so PostgREST cannot reach them either. The grant is reachable only by
-- something that has already authenticated as `service_role` — which is exactly
-- the reason to remove it rather than leave it as a spare key.
--
-- The eight `public.*_salary_*` definer functions keep their `service_role`
-- grant deliberately. They ARE called that way today, from
-- `src/app/api/cases/status/route.ts`, `src/lib/ga4-server.ts` and
-- `src/lib/verify-payment.ts`, all through `supabase.rpc`. Revoking those would
-- break the running product, and narrowing that path is its own piece of work
-- with its own callers to move; it is recorded, not half-done here.

revoke execute on function private.controlled_import_reserve(
  text, text, text, text, jsonb, text, text, timestamptz
) from service_role;
revoke execute on function private.claim_controlled_import_recovery(
  text, timestamptz, interval, integer
) from service_role;
revoke execute on function private.controlled_import_stage_exact_bytes(
  text, text, integer, bytea, text, text, timestamptz
) from service_role;
revoke execute on function private.controlled_import_reject(
  text, text, integer, text, timestamptz
) from service_role;
revoke execute on function private.controlled_import_publish(
  text, text, integer, text, text, timestamptz
) from service_role;
revoke execute on function private.open_controlled_import_published_bytes(text)
  from service_role;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'controlled_import_reserved_execute',
  'tivdoc-controlled-import-reserved-execute-revoke-wave3',
  '202609020005_controlled_import_reserved_execute_revoke'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;
