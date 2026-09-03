-- Fix-forward for 202609020018. The decision-resolution cascade in
-- governance_parameter_attestation_append inserted the sibling's
-- rejected_by_decision revision into governance_parameter_versions directly,
-- but never wrote the corresponding row in governance_aggregate_snapshots —
-- the table governance_aggregate_read (and therefore every port-level
-- readCurrent) actually reads. The version-history row existed; nothing
-- could see it. Caught by parameter-decision-matrix.mts's own read-back
-- assertion, not inferred.
--
-- Fixed by routing the cascade through governance_finish_mutation, the same
-- function every other mutation in this schema uses to write its snapshot,
-- audit event and idempotency record together — rather than hand-rolling a
-- second, narrower path that can drift from the first. Each rejected sibling
-- gets its own deterministic idempotency key derived from the resolving
-- command's, so a replay of the same attestation append rejects the same
-- siblings exactly once.
create or replace function private.governance_parameter_attestation_append(
  target_tenant text, target_attestation jsonb, target_expected_revision bigint,
  target_work_item_id text, target_claimant_id text, target_fencing_token bigint,
  target_envelope_id text, target_idempotency_key text, target_command_sha256 text,
  target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  claim private.governance_work_items%rowtype;
  admission private.governance_human_decisions%rowtype;
  current_version private.governance_parameter_versions%rowtype;
  sibling private.governance_parameter_versions%rowtype;
  target_id text := target_attestation ->> 'candidate_id';
  target_version text := target_attestation ->> 'candidate_version';
  next_revision bigint := target_expected_revision + 1;
  prior_count bigint;
  target_state text;
  attestation_sha256 text := private.governance_jsonb_sha256(target_attestation);
  snapshot jsonb;
  snapshot_sha256 text;
  sibling_ignored private.governance_mutation_receipt;
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'parameter_attestation_append', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  select * into strict current_version from private.governance_parameter_versions item
  where item.tenant_id = target_tenant and item.parameter_id = target_id
    and item.parameter_version = target_version
  order by item.revision desc limit 1 for update;
  if current_version.revision is distinct from target_expected_revision then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_REVISION_FENCED';
  end if;
  if current_version.decision_id is not null and exists (
    select 1 from private.governance_parameter_attestations sibling_att
    join private.governance_parameter_versions sibling_pv
      on sibling_pv.tenant_id = sibling_att.tenant_id
     and sibling_pv.parameter_id = sibling_att.parameter_id
     and sibling_pv.parameter_version = sibling_att.parameter_version
    where sibling_att.tenant_id = target_tenant
      and sibling_att.reviewer_id = target_claimant_id
      and sibling_pv.decision_id = current_version.decision_id
      and sibling_att.parameter_id is distinct from target_id
  ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_DECISION_CROSS_BRANCH_ATTESTATION_FORBIDDEN';
  end if;
  select * into strict claim from private.governance_claim_assert(
    target_tenant, target_work_item_id, target_claimant_id, target_fencing_token,
    'parameter_attestation', target_recorded_at
  );
  select * into strict admission from private.governance_decision_assert(
    target_tenant, target_envelope_id, 'parameter_approval', target_id,
    target_version, next_revision, 'parameter_attestation', 'human_parameter_reviewer',
    target_claimant_id, target_attestation ->> 'signature_sha256'
  );
  if pg_catalog.jsonb_typeof(target_attestation) is distinct from 'object'
     or admission.payload_json is distinct from
        (target_attestation - 'signature_sha256' - 'action_signature_sha256')
     or target_attestation ->> 'schema_version' is distinct from 'tivdoc-parameter-attestation-v0.6.0'
     or target_attestation ->> 'attestation_id' is null
     or target_attestation ->> 'candidate_sha256' is distinct from current_version.candidate_sha256
     or target_attestation ->> 'reviewer_id' is distinct from target_claimant_id
     or target_attestation ->> 'reviewer_role' is distinct from 'human_parameter_reviewer'
     or target_attestation ->> 'decision' is distinct from 'approved'
     or target_attestation ->> 'bindings_sha256' is distinct from current_version.bindings_sha256
     or target_attestation ->> 'unit' is distinct from current_version.candidate_json ->> 'unit'
     or target_attestation ->> 'rounding_policy' is distinct from
        current_version.candidate_json ->> 'rounding_policy'
     or target_attestation -> 'value' is distinct from current_version.candidate_json -> 'value'
     or target_attestation -> 'operative_source_version_ids' is distinct from
        current_version.candidate_json -> 'operative_source_version_ids'
     or claim.workflow_kind is distinct from 'parameter_approval'
     or claim.aggregate_id is distinct from target_id or claim.aggregate_version is distinct from target_version
     or claim.required_role is distinct from 'human_parameter_reviewer' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_ATTESTATION_BINDING_MISMATCH';
  end if;
  select pg_catalog.count(*) into prior_count
  from private.governance_parameter_attestations item
  where item.tenant_id = target_tenant and item.parameter_id = target_id
    and item.parameter_version = target_version;
  if prior_count >= 2 or exists (
    select 1 from private.governance_parameter_attestations item
    where item.tenant_id = target_tenant and item.parameter_id = target_id
      and item.parameter_version = target_version
      and item.reviewer_id = target_claimant_id
  ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_REVIEWER_SEPARATION_REQUIRED';
  end if;
  if prior_count = 1 and not exists (
    select 1 from pg_catalog.jsonb_array_elements_text(
      current_version.candidate_json -> 'support_roles'
    ) role(value) where role.value = 'primary_binding'
  ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_PRIMARY_BINDING_REQUIRED';
  end if;
  target_state := case when prior_count = 0
    then 'awaiting_second_attestation' else 'dual_attested_inactive' end;
  insert into private.governance_parameter_attestations(
    tenant_id, attestation_id, parameter_id, parameter_version, revision,
    reviewer_id, attestation_json, attestation_sha256, envelope_id, recorded_at
  ) values (
    target_tenant, target_attestation ->> 'attestation_id', target_id, target_version,
    next_revision, target_claimant_id, target_attestation, attestation_sha256,
    target_envelope_id, target_recorded_at
  );
  insert into private.governance_parameter_versions(
    tenant_id, parameter_id, parameter_version, revision, state, candidate_json,
    candidate_sha256, bindings_sha256, activation_allowed, recorded_at,
    decision_id, branch
  ) values (
    target_tenant, target_id, target_version, next_revision, target_state,
    current_version.candidate_json, current_version.candidate_sha256,
    current_version.bindings_sha256, false, target_recorded_at,
    current_version.decision_id, current_version.branch
  );
  -- The decision cascade: both attestations necessarily named this
  -- candidate's own branch (a candidate's branch never changes across its
  -- revisions), so reaching dual_attested_inactive on a decision-linked
  -- candidate resolves the decision to that branch and rejects every
  -- sibling — through governance_finish_mutation, the same path every other
  -- mutation uses, so the sibling's new state is visible to
  -- governance_aggregate_read (and therefore readCurrent), not only to a
  -- direct read of governance_parameter_versions that no runtime role has.
  -- Two different reviewers each attesting a different branch does not
  -- reach this point on either branch alone — each still needs its own
  -- second, distinct attestation — so it resolves nothing, which is exactly
  -- the "recorded as a disagreement" requirement: nothing here needs to
  -- detect that case specially, because there is nothing for it to do.
  if target_state = 'dual_attested_inactive' and current_version.decision_id is not null then
    update private.legal_open_decisions
    set resolution_state = 'resolved', resolved_branch = current_version.branch, updated_at = target_recorded_at
    where tenant_id = target_tenant and decision_id = current_version.decision_id
      and resolution_state = 'open';
    for sibling in
      select distinct on (item.parameter_id) item.*
      from private.governance_parameter_versions item
      where item.tenant_id = target_tenant and item.decision_id = current_version.decision_id
        and item.parameter_id is distinct from target_id
      order by item.parameter_id, item.revision desc
    loop
      if sibling.state in ('draft', 'awaiting_second_attestation') then
        insert into private.governance_parameter_versions(
          tenant_id, parameter_id, parameter_version, revision, state, candidate_json,
          candidate_sha256, bindings_sha256, activation_allowed, recorded_at,
          decision_id, branch
        ) values (
          target_tenant, sibling.parameter_id, sibling.parameter_version, sibling.revision + 1,
          'rejected_by_decision', sibling.candidate_json, sibling.candidate_sha256,
          sibling.bindings_sha256, false, target_recorded_at,
          sibling.decision_id, sibling.branch
        );
        sibling_ignored := private.governance_finish_mutation(
          target_tenant, 'parameter_decision_cascade_reject',
          target_idempotency_key || ':cascade:' || sibling.parameter_id, target_command_sha256,
          'parameter_approval', sibling.parameter_id, sibling.parameter_version, sibling.revision + 1,
          'rejected_by_decision', sibling.candidate_json, sibling.candidate_sha256,
          'parameter_rejected_by_decision', target_claimant_id, target_recorded_at, true
        );
      end if;
    end loop;
  end if;
  perform private.governance_complete_claim(
    target_tenant, target_work_item_id, target_claimant_id,
    target_fencing_token, target_recorded_at
  );
  snapshot := pg_catalog.jsonb_build_object(
    'candidate', current_version.candidate_json,
    'latest_attestation', target_attestation,
    'attestation_count', prior_count + 1,
    'activation_allowed', false
  );
  snapshot_sha256 := private.governance_jsonb_sha256(snapshot);
  result := private.governance_finish_mutation(
    target_tenant, 'parameter_attestation_append', target_idempotency_key,
    target_command_sha256, 'parameter_approval', target_id, target_version,
    next_revision, target_state, snapshot, snapshot_sha256,
    'parameter_attestation_appended', target_claimant_id, target_recorded_at, true
  );
  return next result;
end;
$$;

alter function private.governance_parameter_attestation_append(
  text, jsonb, bigint, text, text, bigint, text, text, text, timestamptz
) owner to tivdoc_governance_owner;
revoke all on function private.governance_parameter_attestation_append(
  text, jsonb, bigint, text, text, bigint, text, text, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function private.governance_parameter_attestation_append(
  text, jsonb, bigint, text, text, bigint, text, text, text, timestamptz
) to tivdoc_operations_runtime;
