-- E3-2 / E3-3. Two schema changes the last run's findings made necessary, and
-- both follow the rule this schema already lives by: nothing is ever edited,
-- everything is appended.
--
-- D2, supersession. `il.vacation.calendar_days_years_1_to_4` carries the right
-- figure against the wrong seniority band, and the table is append-only, so
-- there is no way today to say so in the database — only in a comment in a
-- TypeScript file, which no export, panel or package reads. A wrong row that
-- looks exactly like a right one is worse than a missing row, because every
-- check that looks at the citation passes. Superseding appends a new revision
-- in state `superseded` carrying the reason and the id of the revision that
-- replaces it, the same way an attestation appends `awaiting_second_attestation`.
-- The original revision stays exactly as it was written.
--
-- D3, synthetic segregation. Eight throwaway decisions from A7-3's proof live
-- permanently in `legal_open_decisions` beside three real ones, and the only
-- thing keeping them out of a lawyer's document is a string prefix test in one
-- report generator. A flag on the row is what every consumer can filter on.
-- Proof rows written from now on go to their own tenant; the flag is for the
-- ones already here, which cannot be moved.

-- ---------------------------------------------------------------------------
-- Candidate supersession
-- ---------------------------------------------------------------------------

alter table private.governance_parameter_versions
  drop constraint governance_parameter_versions_state_check;

alter table private.governance_parameter_versions
  add constraint governance_parameter_versions_state_check
  check (state = any (array[
    'draft', 'awaiting_second_attestation', 'dual_attested_inactive',
    'rejected_by_decision', 'superseded'
  ]));

alter table private.governance_parameter_versions
  add column superseded_by text null
    check (superseded_by is null or superseded_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}@[0-9]+(\.[0-9]+){0,2}$'),
  add column supersede_reason text null
    check (supersede_reason is null or char_length(supersede_reason) between 20 and 2000),
  -- Synthetic rows are proof fixtures. The default is false and the column is
  -- not null, so a row that does not say it is synthetic is real — the safe
  -- direction for a flag whose job is to keep fixtures out of legal exports.
  add column synthetic boolean not null default false;

-- Both companion fields belong to the superseded state and to no other. A
-- `draft` row carrying a supersede reason would be a half-finished correction
-- that reads as a finished one.
alter table private.governance_parameter_versions
  add constraint governance_parameter_versions_supersede_pairing_check
  check (
    case when state = 'superseded'
      then superseded_by is not null and supersede_reason is not null
      else superseded_by is null and supersede_reason is null
    end
  );

-- Appends the superseding revision. Refuses when the named replacement does not
-- exist, because "superseded by" pointing at nothing is worse than staying
-- wrong: it looks resolved.
create function private.governance_parameter_supersede(
  target_tenant text, target_parameter_id text, target_parameter_version text,
  target_expected_revision bigint, target_superseded_by text, target_reason text,
  target_idempotency_key text, target_command_sha256 text, target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  current_version private.governance_parameter_versions;
  next_revision bigint := target_expected_revision + 1;
  replacement_id text := pg_catalog.split_part(target_superseded_by, '@', 1);
  replacement_version text := pg_catalog.split_part(target_superseded_by, '@', 2);
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'parameter_supersede', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if target_reason is null or char_length(target_reason) not between 20 and 2000 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_SUPERSEDE_REASON_REQUIRED';
  end if;

  select * into current_version
  from private.governance_parameter_versions item
  where item.tenant_id = target_tenant and item.parameter_id = target_parameter_id
    and item.parameter_version = target_parameter_version
  order by item.revision desc limit 1;
  if current_version.parameter_id is null then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_UNKNOWN';
  end if;
  if current_version.revision is distinct from target_expected_revision then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_REVISION_CONFLICT';
  end if;
  if current_version.state = 'superseded' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_ALREADY_SUPERSEDED';
  end if;
  -- A superseded candidate must not be one two people already attested: that
  -- would be overwriting a human decision with an engineering one.
  if current_version.state = 'dual_attested_inactive' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_ATTESTED_CANNOT_BE_SUPERSEDED';
  end if;
  if not exists (
    select 1 from private.governance_parameter_versions item
    where item.tenant_id = target_tenant and item.parameter_id = replacement_id
      and item.parameter_version = replacement_version
  ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_SUPERSEDER_UNKNOWN';
  end if;
  if replacement_id = target_parameter_id and replacement_version = target_parameter_version then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_PARAMETER_CANNOT_SUPERSEDE_ITSELF';
  end if;

  insert into private.governance_parameter_versions(
    tenant_id, parameter_id, parameter_version, revision, state, candidate_json,
    candidate_sha256, bindings_sha256, activation_allowed, recorded_at,
    decision_id, branch, superseded_by, supersede_reason, synthetic
  ) values (
    target_tenant, target_parameter_id, target_parameter_version, next_revision, 'superseded',
    current_version.candidate_json, current_version.candidate_sha256,
    current_version.bindings_sha256, false, target_recorded_at,
    current_version.decision_id, current_version.branch,
    target_superseded_by, target_reason, current_version.synthetic
  );
  result := private.governance_finish_mutation(
    target_tenant, 'parameter_supersede', target_idempotency_key, target_command_sha256,
    'parameter_approval', target_parameter_id, target_parameter_version, next_revision, 'superseded',
    current_version.candidate_json, current_version.candidate_sha256,
    'parameter_candidate_superseded', 'system_import', target_recorded_at, true
  );
  return next result;
end;
$$;

alter function private.governance_parameter_supersede(text, text, text, bigint, text, text, text, text, timestamptz)
  owner to tivdoc_governance_owner;
revoke all on function private.governance_parameter_supersede(text, text, text, bigint, text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.governance_parameter_supersede(text, text, text, bigint, text, text, text, text, timestamptz)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

-- ---------------------------------------------------------------------------
-- Synthetic segregation
-- ---------------------------------------------------------------------------

alter table private.legal_open_decisions
  add column synthetic boolean not null default false;

-- Marks an existing decision row as a proof fixture, and records why. This is
-- the only permitted way to set the flag on a row that already exists, and it
-- is an append to the audit trail rather than a silent update — the row itself
-- is updated because `synthetic` is metadata about the row's provenance rather
-- than part of its content, and the guard below permits exactly this one
-- column to move, exactly once, in one direction.
create or replace function private.governance_legal_open_decision_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_catalog.tg_op = 'DELETE' then
    raise exception using errcode = '42501', message = 'GOVERNANCE_APPEND_ONLY';
  end if;
  -- The one pre-existing permitted transition: open -> resolved, or
  -- open -> withdrawn, exactly once, with its companion fields set together.
  if old.resolution_state is distinct from new.resolution_state then
    if old.resolution_state is distinct from 'open'
       or new.resolution_state not in ('resolved', 'withdrawn') then
      raise exception using errcode = '42501', message = 'GOVERNANCE_LEGAL_OPEN_DECISION_TRANSITION_FORBIDDEN';
    end if;
  end if;
  -- E3-3: `synthetic` may be raised once, never lowered. Lowering it would let
  -- a fixture be laundered into a legal decision.
  if old.synthetic is distinct from new.synthetic and old.synthetic then
    raise exception using errcode = '42501', message = 'GOVERNANCE_LEGAL_OPEN_DECISION_SYNTHETIC_IRREVERSIBLE';
  end if;
  if old.tenant_id is distinct from new.tenant_id
     or old.decision_id is distinct from new.decision_id
     or old.topic is distinct from new.topic
     or old.question is distinct from new.question
     or old.dossier_anchor is distinct from new.dossier_anchor
     or old.created_at is distinct from new.created_at then
    raise exception using errcode = '42501', message = 'GOVERNANCE_LEGAL_OPEN_DECISION_IMMUTABLE_FIELD';
  end if;
  return new;
end;
$$;

alter function private.governance_legal_open_decision_guard() owner to tivdoc_governance_owner;
revoke all on function private.governance_legal_open_decision_guard()
  from public, anon, authenticated, service_role;

create function private.governance_legal_open_decision_mark_synthetic(
  target_tenant text, target_decision_id text, target_reason text,
  target_idempotency_key text, target_command_sha256 text, target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  current_decision private.legal_open_decisions;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'legal_open_decision_mark_synthetic', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if target_reason is null or char_length(target_reason) not between 20 and 2000 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_OPEN_DECISION_SYNTHETIC_REASON_REQUIRED';
  end if;
  select * into current_decision from private.legal_open_decisions decision
  where decision.tenant_id = target_tenant and decision.decision_id = target_decision_id;
  if current_decision.decision_id is null then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_OPEN_DECISION_UNKNOWN';
  end if;
  if current_decision.synthetic then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_OPEN_DECISION_ALREADY_SYNTHETIC';
  end if;
  update private.legal_open_decisions
     set synthetic = true, updated_at = target_recorded_at
   where tenant_id = target_tenant and decision_id = target_decision_id;
  result := private.governance_finish_mutation(
    target_tenant, 'legal_open_decision_mark_synthetic', target_idempotency_key, target_command_sha256,
    'parameter_approval', target_decision_id, '1', 1, current_decision.resolution_state,
    pg_catalog.jsonb_build_object(
      'decision_id', target_decision_id, 'synthetic', true, 'reason', target_reason
    ),
    private.governance_jsonb_sha256(pg_catalog.jsonb_build_object(
      'decision_id', target_decision_id, 'synthetic', true, 'reason', target_reason
    )),
    'legal_open_decision_marked_synthetic', 'system_import', target_recorded_at, false
  );
  return next result;
end;
$$;

alter function private.governance_legal_open_decision_mark_synthetic(text, text, text, text, text, timestamptz)
  owner to tivdoc_governance_owner;
revoke all on function private.governance_legal_open_decision_mark_synthetic(text, text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.governance_legal_open_decision_mark_synthetic(text, text, text, text, text, timestamptz)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

-- The read gains both new facts, so every consumer can filter without needing
-- to know the id-prefix convention that stood in for this until now. Adding a
-- column to a set-returning function changes its return type, which Postgres
-- will not do through `create or replace` — so it is dropped and recreated,
-- inside this migration's transaction, and its grants are restated below.
drop function if exists private.legal_open_decision_read(text);

create function private.legal_open_decision_read(target_tenant text)
returns table (
  decision_id text, topic text, question text, dossier_anchor text,
  resolution_state text, resolved_branch text,
  withdrawn_reason text, dissolution_citation_locator text,
  synthetic boolean,
  created_at timestamptz, updated_at timestamptz
)
language plpgsql security definer set search_path = '' as $$
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  return query
    select d.decision_id, d.topic, d.question, d.dossier_anchor,
           d.resolution_state, d.resolved_branch,
           d.withdrawn_reason, d.dissolution_citation_locator,
           d.synthetic, d.created_at, d.updated_at
      from private.legal_open_decisions d
     where d.tenant_id = target_tenant
     order by d.decision_id;
end;
$$;

alter function private.legal_open_decision_read(text) owner to tivdoc_governance_owner;
revoke all on function private.legal_open_decision_read(text)
  from public, anon, authenticated, service_role;
grant execute on function private.legal_open_decision_read(text)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

comment on function private.governance_parameter_supersede(text, text, text, bigint, text, text, text, text, timestamptz) is
  'Appends a superseded revision naming the candidate that replaces it and why. Refuses a replacement that does not exist, a candidate already superseded, and one two reviewers already attested.';
comment on function private.governance_legal_open_decision_mark_synthetic(text, text, text, text, text, timestamptz) is
  'Marks an existing decision row as a proof fixture. One direction only; a fixture can never be laundered back into a legal decision.';
