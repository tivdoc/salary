-- Wave 5 (G-12 operations queue panel). The durable work queue could be fed,
-- claimed, released and completed by the runtime roles, but never listed: the
-- table is owned by tivdoc_governance_owner with RLS forced and one owner-bound
-- policy, so no runtime role sees a row, which is the intended shape for the
-- table itself. The nested /operations panel needs the queue as a projection,
-- so it gets the same definer treatment as governance_legal_review_queue_list:
-- owned by the governance owner, gated on the verified tenant, executable only
-- by the operations principal. It returns identity, state, claimant and lease —
-- never payload_json, so a panel cannot become a content path by accident.
create function private.governance_work_queue_list(
  target_tenant text, target_workflow_kind text, target_limit integer
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  entries jsonb;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  if target_workflow_kind not in (
    'reviewer_trust', 'ground_truth', 'legal_reconciliation', 'parameter_approval', 'rulespec_approval'
  ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_WORK_QUEUE_KIND_INVALID';
  end if;
  if target_limit is null or target_limit < 1 or target_limit > 500 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_WORK_QUEUE_LIMIT_INVALID';
  end if;
  select coalesce(pg_catalog.jsonb_agg(ordered.entry order by ordered.entry ->> 'ordinal'), '[]'::jsonb)
    into entries
    from (
      select pg_catalog.jsonb_build_object(
        'ordinal', item.created_at::text || '|' || item.work_item_id,
        'work_item_id', item.work_item_id,
        'workflow_kind', item.workflow_kind,
        'aggregate_id', item.aggregate_id,
        'aggregate_version', item.aggregate_version,
        'work_kind', item.work_kind,
        'required_role', item.required_role,
        'document_sha256', item.document_sha256,
        'object_version_id', item.object_version_id,
        'input_sha256', item.input_sha256,
        'state', item.state,
        'claimant_id', item.claimant_id,
        'fencing_token', item.fencing_token,
        'lease_expires_at', item.lease_expires_at,
        'created_at', item.created_at,
        'updated_at', item.updated_at
      ) as entry
      from private.governance_work_items item
      where item.tenant_id = target_tenant
        and item.workflow_kind = target_workflow_kind
      order by item.created_at, item.work_item_id
      limit target_limit
    ) ordered;
  return entries;
end;
$$;

alter function private.governance_work_queue_list(text, text, integer) owner to tivdoc_governance_owner;
revoke all on function private.governance_work_queue_list(text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function private.governance_work_queue_list(text, text, integer) to tivdoc_operations_runtime;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'governance_work_queue_list',
  'tivdoc-governance-work-queue-list-v0.10.14',
  '202609020017_governance_work_queue_list'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on function private.governance_work_queue_list(text, text, integer) is
  'Durable work queue projection without payload; executable only by the explicitly granted least-privilege operations principal.';
