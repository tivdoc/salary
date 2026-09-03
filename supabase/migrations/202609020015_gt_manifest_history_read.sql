-- Wave 5 (G-3 revision chain, G-12 operations panel). The ground-truth
-- workflow had append definers and a current-aggregate read, but no way for a
-- runtime role to read a manifest's revision chain: the versions table is
-- owned by tivdoc_governance_owner, RLS is forced, and its only policy binds
-- the owner to the verified tenant — so the runtime roles (no SELECT grant) and
-- the migrator (no policy) both see nothing, which is the intended shape for
-- the table itself. The chain is needed by the operations panel and by the
-- ground-truth matrix, so it gets the same definer treatment as
-- governance_aggregate_read: owned by the governance owner, gated on the
-- verified tenant, executable only by the two runtime roles. Read-only, and it
-- returns digests and states, never manifest_json.
create function private.governance_gt_manifest_history_read(
  target_tenant text, target_manifest_id text
) returns table(
  tenant_id text, manifest_id text, manifest_revision bigint, workflow_revision bigint,
  event_kind text, status text, document_sha256 text, manifest_sha256 text,
  envelope_id text, recorded_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  return query
  select version.tenant_id, version.manifest_id, version.manifest_revision, version.workflow_revision,
    version.event_kind, version.status, version.document_sha256, version.manifest_sha256,
    version.envelope_id, version.recorded_at
  from private.governance_gt_manifest_versions version
  where version.tenant_id = target_tenant
    and version.manifest_id = target_manifest_id
  order by version.workflow_revision asc;
end;
$$;

alter function private.governance_gt_manifest_history_read(text, text) owner to tivdoc_governance_owner;
revoke all on function private.governance_gt_manifest_history_read(text, text) from public, anon, authenticated, service_role;
grant execute on function private.governance_gt_manifest_history_read(text, text) to tivdoc_operations_runtime, tivdoc_worker_runtime;
