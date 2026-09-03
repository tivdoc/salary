-- Addendum 6 (A6-2), unit P-0. Two changes, one migration, before any Pool P
-- draft parameter exists: the durable candidate's initial state is renamed to
-- match the engine's own state machine, and open legal decisions become a
-- first-class, durable, resolvable record instead of a pairwise link.
--
-- 1. `draft` replaces `candidate_inactive` as the initial state of
--    private.governance_parameter_versions, matching the engine's
--    `draft -> independently_verified_twice -> activation_eligible`. Zero
--    rows exist in this table on DEV (checked before writing this migration),
--    so the rename is not a data migration — there is nothing to move.
--    `rejected_by_decision` joins the state set: what a sibling branch moves
--    to when its decision resolves in favour of another branch.
--
-- 2. private.legal_open_decisions: one row per open legal question, keyed by
--    a stable decision_id. Append-only except resolution_state, which moves
--    open -> resolved exactly once, enforced by trigger rather than by
--    convention.
--
-- 3. On the candidate: nullable decision_id and branch. Every alternative of
--    one open question is its own candidate row, sharing decision_id, each
--    with its own distinct branch. governance_parameter_import requires the
--    two paired (both null or both set) and, when set, the named decision to
--    exist and still be open.
--
-- 4. Resolution rule, enforced in governance_parameter_attestation_append:
--    reaching the existing two-distinct-reviewer requirement on a
--    decision-linked candidate resolves the decision to that candidate's own
--    branch (both attestations necessarily name the same branch, because
--    both target the same candidate row) and moves every sibling branch's
--    latest revision to rejected_by_decision. A reviewer who has already
--    attested a sibling branch of the same decision is refused outright,
--    before any other check, so a single identity cannot appear on both
--    sides of one question. Two different reviewers each attesting a
--    different branch resolves nothing on its own — each branch still needs
--    its own second, distinct attestation — which is the "recorded as a
--    disagreement" case: neither branch leaves draft, and the negative test
--    below proves it.

alter table private.governance_parameter_versions
  drop constraint governance_parameter_versions_state_check;

update private.governance_parameter_versions set state = 'draft' where state = 'candidate_inactive';

alter table private.governance_parameter_versions
  add constraint governance_parameter_versions_state_check
  check (state = any (array['draft', 'awaiting_second_attestation', 'dual_attested_inactive', 'rejected_by_decision']));

alter table private.governance_parameter_versions
  add column decision_id text null,
  add column branch text null;

alter table private.governance_parameter_versions
  add constraint governance_parameter_versions_decision_branch_paired_check
  check ((decision_id is null) = (branch is null));

alter table private.governance_parameter_versions
  add constraint governance_parameter_versions_decision_id_check
  check (decision_id is null or decision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$');

alter table private.governance_parameter_versions
  add constraint governance_parameter_versions_branch_check
  check (branch is null or branch ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$');

create table private.legal_open_decisions (
  tenant_id text not null,
  decision_id text not null check (decision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'),
  topic text not null,
  question text not null check (char_length(question) between 1 and 2000),
  dossier_anchor text not null check (char_length(dossier_anchor) between 1 and 500),
  resolution_state text not null default 'open' check (resolution_state in ('open', 'resolved')),
  resolved_branch text null check (resolved_branch is null or resolved_branch ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$'),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, decision_id),
  constraint legal_open_decisions_resolution_pairing_check
    check ((resolution_state = 'resolved') = (resolved_branch is not null))
);

alter table private.legal_open_decisions owner to tivdoc_governance_owner;
alter table private.legal_open_decisions enable row level security;
alter table private.legal_open_decisions force row level security;

create policy legal_open_decisions_verified_tenant on private.legal_open_decisions
  for all to tivdoc_governance_owner
  using (tenant_id = private.runtime_verified_tenant())
  with check (tenant_id = private.runtime_verified_tenant());

-- Append-only except the one permitted transition: resolution_state moves
-- open -> resolved exactly once, resolved_branch is set in the same update
-- and nowhere else, and no other column may ever change.
create function private.governance_legal_open_decision_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
  end if;
  if TG_OP = 'UPDATE' then
    if OLD.tenant_id is distinct from NEW.tenant_id
       or OLD.decision_id is distinct from NEW.decision_id
       or OLD.topic is distinct from NEW.topic
       or OLD.question is distinct from NEW.question
       or OLD.dossier_anchor is distinct from NEW.dossier_anchor
       or OLD.created_at is distinct from NEW.created_at
       or OLD.resolution_state is distinct from 'open'
       or NEW.resolution_state is distinct from 'resolved'
       or OLD.resolved_branch is not null
       or NEW.resolved_branch is null then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
    end if;
    return NEW;
  end if;
  return NEW;
end;
$$;

alter function private.governance_legal_open_decision_guard() owner to tivdoc_governance_owner;

create trigger legal_open_decisions_guard
  before insert or update or delete on private.legal_open_decisions
  for each row execute function private.governance_legal_open_decision_guard();

-- Registers one open decision. Idempotent on (target_tenant, decision_id,
-- idempotency_key) via the same ledger every other append uses.
create function private.governance_legal_open_decision_register(
  target_tenant text, target_decision jsonb, target_idempotency_key text,
  target_command_sha256 text, target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  target_id text := target_decision ->> 'decision_id';
  target_topic text := target_decision ->> 'topic';
  target_question text := target_decision ->> 'question';
  target_anchor text := target_decision ->> 'dossier_anchor';
  content_sha256 text;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'legal_open_decision_register', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if pg_catalog.jsonb_typeof(target_decision) is distinct from 'object'
     or target_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'
     or target_topic is null or char_length(target_topic) < 1
     or target_question is null or char_length(target_question) not between 1 and 2000
     or target_anchor is null or char_length(target_anchor) not between 1 and 500 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_OPEN_DECISION_INVALID';
  end if;
  insert into private.legal_open_decisions(
    tenant_id, decision_id, topic, question, dossier_anchor,
    resolution_state, resolved_branch, created_at, updated_at
  ) values (
    target_tenant, target_id, target_topic, target_question, target_anchor,
    'open', null, target_recorded_at, target_recorded_at
  );
  content_sha256 := private.governance_jsonb_sha256(pg_catalog.jsonb_build_object(
    'decision_id', target_id, 'topic', target_topic, 'question', target_question,
    'dossier_anchor', target_anchor, 'resolution_state', 'open'
  ));
  result := private.governance_finish_mutation(
    target_tenant, 'legal_open_decision_register', target_idempotency_key, target_command_sha256,
    'parameter_approval', target_id, '1', 1, 'open',
    target_decision, content_sha256, 'legal_open_decision_registered',
    'system_import', target_recorded_at, false
  );
  return next result;
end;
$$;

alter function private.governance_legal_open_decision_register(text, jsonb, text, text, timestamptz)
  owner to tivdoc_governance_owner;
revoke all on function private.governance_legal_open_decision_register(text, jsonb, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.governance_legal_open_decision_register(text, jsonb, text, text, timestamptz)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

-- governance_parameter_import: verbatim DEV body, with the initial state
-- renamed to 'draft' and the decision binding added. Every other check is
-- unchanged.
create or replace function private.governance_parameter_import(
  target_tenant text, target_candidate jsonb, target_idempotency_key text,
  target_command_sha256 text, target_imported_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  target_id text := target_candidate ->> 'parameter_id';
  target_version text := target_candidate ->> 'parameter_version';
  target_sha256 text := target_candidate ->> 'candidate_sha256';
  bindings_sha256 text := private.governance_jsonb_sha256(target_candidate -> 'bindings');
  target_decision_id text := target_candidate ->> 'decision_id';
  target_branch text := target_candidate ->> 'branch';
begin
  if target_tenant is distinct from nullif(current_setting('tivdoc.tenant_id', true), '') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'parameter_import', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if pg_catalog.jsonb_typeof(target_candidate) is distinct from 'object'
     or target_candidate ->> 'schema_version' is distinct from 'tivdoc-parameter-candidate-v0.6.0'
     or target_id is null or target_version is null
     or target_candidate -> 'bindings' is null
     or target_sha256 !~ '^[a-f0-9]{64}$'
     or private.governance_jsonb_sha256(target_candidate - 'candidate_sha256') is distinct from target_sha256
     or nullif(target_candidate ->> 'effective_to', '')::date <
        nullif(target_candidate ->> 'effective_from', '')::date
     or (target_decision_id is null) is distinct from (target_branch is null) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_CANDIDATE_INVALID';
  end if;
  if target_decision_id is not null and not exists (
    select 1 from private.legal_open_decisions decision
    where decision.tenant_id = target_tenant and decision.decision_id = target_decision_id
      and decision.resolution_state = 'open'
  ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_DECISION_UNKNOWN_OR_RESOLVED';
  end if;
  insert into private.governance_parameter_versions(
    tenant_id, parameter_id, parameter_version, revision, state, candidate_json,
    candidate_sha256, bindings_sha256, activation_allowed, recorded_at,
    decision_id, branch
  ) values (
    target_tenant, target_id, target_version, 1, 'draft', target_candidate,
    target_sha256, bindings_sha256, false, target_imported_at,
    target_decision_id, target_branch
  );
  result := private.governance_finish_mutation(
    target_tenant, 'parameter_import', target_idempotency_key, target_command_sha256,
    'parameter_approval', target_id, target_version, 1, 'draft',
    target_candidate, target_sha256, 'parameter_candidate_imported',
    'system_import', target_imported_at, true
  );
  return next result;
end;
$$;

-- governance_parameter_attestation_append: verbatim DEV body, with the
-- cross-branch refusal added before the existing checks, and the decision
-- cascade added after the existing state transition is decided.
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
  -- A reviewer who has already attested a sibling branch of the same open
  -- decision may not attest this one too: one identity, one side of one
  -- question. Checked before any other binding so it can never be reached
  -- by coincidence of the other checks passing.
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
  -- sibling. Two different reviewers each attesting a different branch does
  -- not reach this point on either branch alone — each still needs its own
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

alter function private.governance_parameter_import(text, jsonb, text, text, timestamptz)
  owner to tivdoc_governance_owner;
revoke all on function private.governance_parameter_import(text, jsonb, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.governance_parameter_import(text, jsonb, text, text, timestamptz)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

alter function private.governance_parameter_attestation_append(
  text, jsonb, bigint, text, text, bigint, text, text, text, timestamptz
) owner to tivdoc_governance_owner;
revoke all on function private.governance_parameter_attestation_append(
  text, jsonb, bigint, text, text, bigint, text, text, text, timestamptz
) from public, anon, authenticated, service_role;
grant execute on function private.governance_parameter_attestation_append(
  text, jsonb, bigint, text, text, bigint, text, text, text, timestamptz
) to tivdoc_operations_runtime;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'legal_open_decisions',
  'tivdoc-legal-open-decisions-v0.10.0',
  '202609020018_parameter_draft_state_and_open_decisions'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on table private.legal_open_decisions is
  'One row per open legal decision the research dossier records; append-only except resolution_state, which moves open -> resolved exactly once.';
comment on function private.governance_legal_open_decision_register(text, jsonb, text, text, timestamptz) is
  'Registers one open legal decision; executable only by the explicitly granted least-privilege operations and worker principals.';
