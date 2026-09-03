-- Wave 5 (G-2 durable trust stack). First real call of
-- private.governance_trust_policy_append, from the ground-truth matrix running
-- as tivdoc_operations_runtime, failed with SQLSTATE 42702 (ambiguous column
-- reference) at
--
--   where item.tenant_id = target_tenant and item.organization_id = target_id
--     and item.organization_version = organization_version;
--
-- The PL/pgSQL variable `organization_version` shadows the column of the same
-- name, so the planner cannot tell which side of the comparison is which. The
-- function had been implemented_uncalled since 202609010004: every path that
-- publishes a reviewer-trust policy went through the in-process store, never
-- through this definer, so the defect was invisible until the matrix exercised
-- it. Nothing else changes — same checks, same raises, same grants; the body is
-- the DEV body with the variable renamed to `target_organization_version`.
create or replace function private.governance_trust_policy_append(
  target_tenant text, target_record jsonb, target_actor_id text,
  target_idempotency_key text, target_command_sha256 text, target_occurred_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  organization private.governance_reviewer_organizations%rowtype;
  target_id text := target_record ->> 'organization_id';
  target_organization_version text := target_record ->> 'organization_version';
  target_version text := target_record ->> 'policy_version';
  target_sha256 text := target_record ->> 'policy_sha256';
  effective_at timestamptz;
  target_expires_at timestamptz;
  max_envelope_ttl_seconds integer;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'trust_policy_append', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  select * into strict organization from private.governance_reviewer_organizations item
  where item.tenant_id = target_tenant and item.organization_id = target_id
    and item.organization_version = target_organization_version;
  effective_at := (target_record ->> 'effective_from')::timestamptz;
  target_expires_at := nullif(target_record ->> 'expires_at', '')::timestamptz;
  if target_record ->> 'max_envelope_ttl_seconds' !~ '^[0-9]{2,6}$' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TRUST_POLICY_TTL_INVALID';
  end if;
  max_envelope_ttl_seconds := (target_record ->> 'max_envelope_ttl_seconds')::integer;
  if target_record ->> 'schema_version' is distinct from 'tivdoc-reviewer-trust-v0.10.0'
     or target_sha256 !~ '^[a-f0-9]{64}$'
     or private.governance_jsonb_sha256(target_record - 'policy_sha256') is distinct from target_sha256
     or not exists (
       select 1 from pg_catalog.jsonb_array_elements_text(organization.record_json -> 'policy_admin_ids') admin(value)
       where admin.value = target_actor_id
     )
     or max_envelope_ttl_seconds < 60 or max_envelope_ttl_seconds > 604800
     or effective_at < organization.valid_from
     or (organization.expires_at is not null and (effective_at >= organization.expires_at
       or target_expires_at > organization.expires_at)) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TRUST_POLICY_INVALID';
  end if;
  insert into private.governance_reviewer_policies(
    tenant_id, organization_id, organization_version, policy_version, record_json,
    policy_sha256, effective_from, expires_at, actor_id, created_at
  ) values (
    target_tenant, target_id, target_organization_version, target_version, target_record,
    target_sha256, effective_at, target_expires_at, target_actor_id, target_occurred_at
  );
  result := private.governance_finish_mutation(
    target_tenant, 'trust_policy_append', target_idempotency_key, target_command_sha256,
    'reviewer_trust', target_id, target_version, 1, 'policy_published',
    target_record, target_sha256, 'policy_published', target_actor_id,
    target_occurred_at, true
  );
  return next result;
end;
$$;
