-- External review #1 (5.9.2026), finding 5 (Q6). A resolution can be
-- re-recorded — never edited. The table becomes append-only by REVISION:
-- a decision's first resolution is revision 1; a later one names the
-- revision it supersedes and the basis of the supersession, and is
-- inserted as the next revision. The superseded row is not touched (the
-- guard still refuses every update and delete); the read returns every
-- revision, ordered, and the code treats the latest as the default.
--
-- What changes: the primary key gains `revision`; `supersedes_revision`
-- and `supersession_basis` are added (null on revision 1, required after);
-- `basis` may also be 'external_review_correction' on a revision above 1
-- (revision 1 stays a lawyer-approved opinion, as every existing row is);
-- the record function accepts `supersedes_revision` + `supersession_basis`
-- and refuses a supersession that does not name the latest revision; a
-- bare second resolution (no supersession) is still refused, exactly as
-- before. The read function gains the three columns.

-- 1. Columns and constraints.
alter table private.legal_decision_resolutions
  add column revision integer not null default 1 check (revision >= 1),
  add column supersedes_revision integer null,
  add column supersession_basis text null;

alter table private.legal_decision_resolutions
  drop constraint legal_decision_resolutions_pkey,
  add primary key (tenant_id, decision_id, revision);

alter table private.legal_decision_resolutions
  drop constraint legal_decision_resolutions_basis_check,
  add constraint legal_decision_resolutions_basis_check
    check (basis in ('lawyer_approved_opinion', 'external_review_correction')),
  add constraint legal_decision_resolutions_revision_pairing_check check (
    (revision = 1 and supersedes_revision is null and supersession_basis is null and basis = 'lawyer_approved_opinion')
    or (revision > 1 and supersedes_revision = revision - 1
        and supersession_basis ~ '^[a-z][a-z0-9_.-]{2,119}$')
  );

-- 2. The record function: a supersession names the latest revision.
create or replace function private.governance_legal_decision_resolution_record(
  target_tenant text, target_resolution jsonb, target_idempotency_key text,
  target_command_sha256 text, target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  decision private.legal_open_decisions%rowtype;
  existing private.legal_decision_resolutions%rowtype;
  v_decision_id text := target_resolution->>'decision_id';
  v_decision_key text := target_resolution->>'decision_key';
  v_selected_branch text := target_resolution->>'selected_branch';
  v_basis text := target_resolution->>'basis';
  v_evidence_sha256 text := target_resolution->>'evidence_sha256';
  v_approval_record_sha256 text := target_resolution->>'approval_record_sha256';
  v_approved_on text := target_resolution->>'approved_on';
  v_mapping_note text := target_resolution->>'mapping_note';
  v_resolution_sha256 text := target_resolution->>'resolution_sha256';
  v_synthetic boolean := coalesce((target_resolution->>'synthetic')::boolean, false);
  v_supersedes_revision integer := null;
  v_supersession_basis text := target_resolution->>'supersession_basis';
  v_revision integer := 1;
  payload jsonb;
  content_sha256 text;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'legal_decision_resolution_record', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  -- A payload that names a status is refused unless it names the only one
  -- this path can produce; a payload that names an approver is refused.
  if target_resolution ? 'status' and target_resolution->>'status' is distinct from 'owner_recorded' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_DECISION_RESOLUTION_ATTESTATION_NOT_A_CODE_PATH';
  end if;
  if target_resolution ? 'approver_identity' and target_resolution->'approver_identity' is distinct from 'null'::jsonb then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_DECISION_RESOLUTION_ATTESTATION_NOT_A_CODE_PATH';
  end if;
  if target_resolution ? 'supersedes_revision' and target_resolution->'supersedes_revision' is distinct from 'null'::jsonb then
    if pg_catalog.jsonb_typeof(target_resolution->'supersedes_revision') is distinct from 'number' then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_DECISION_RESOLUTION_INVALID';
    end if;
    v_supersedes_revision := (target_resolution->>'supersedes_revision')::integer;
  end if;
  if v_decision_id is null or v_decision_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'
     or v_decision_key is null or v_decision_key !~ '^[a-z][a-z0-9_]{2,79}$'
     or v_selected_branch is null or v_selected_branch !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$'
     or v_basis is null or v_basis not in ('lawyer_approved_opinion', 'external_review_correction')
     or v_evidence_sha256 is null or v_evidence_sha256 !~ '^[a-f0-9]{64}$'
     or v_approval_record_sha256 is null or v_approval_record_sha256 !~ '^[a-f0-9]{64}$'
     or v_approved_on is null
     or v_mapping_note is null or char_length(v_mapping_note) not between 1 and 2000
     or v_resolution_sha256 is null or v_resolution_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_DECISION_RESOLUTION_INVALID';
  end if;
  -- A supersession carries its basis; a first resolution carries none, and is a lawyer-approved opinion.
  if v_supersedes_revision is not null then
    if v_supersedes_revision < 1
       or v_supersession_basis is null or v_supersession_basis !~ '^[a-z][a-z0-9_.-]{2,119}$' then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_DECISION_RESOLUTION_INVALID';
    end if;
  elsif v_supersession_basis is not null or v_basis is distinct from 'lawyer_approved_opinion' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_DECISION_RESOLUTION_INVALID';
  end if;
  select * into decision from private.legal_open_decisions d
  where d.tenant_id = target_tenant and d.decision_id = v_decision_id
  for share;
  if decision.decision_id is null then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_OPEN_DECISION_UNKNOWN';
  end if;
  if decision.resolution_state is distinct from 'open' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_DECISION_RESOLUTION_DECISION_NOT_OPEN';
  end if;
  if decision.synthetic is distinct from v_synthetic then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_DECISION_RESOLUTION_SYNTHETIC_MISMATCH';
  end if;
  -- The latest revision on the decision, if any.
  select * into existing from private.legal_decision_resolutions r
  where r.tenant_id = target_tenant and r.decision_id = v_decision_id
  order by r.revision desc
  limit 1
  for share;
  if v_supersedes_revision is null then
    if existing.decision_id is not null then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_DECISION_RESOLUTION_EXISTS';
    end if;
    v_revision := 1;
  else
    if existing.decision_id is null or existing.revision is distinct from v_supersedes_revision then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_DECISION_RESOLUTION_SUPERSEDES_NOT_LATEST';
    end if;
    v_revision := existing.revision + 1;
  end if;
  insert into private.legal_decision_resolutions (
    tenant_id, decision_id, decision_key, selected_branch, basis,
    evidence_sha256, approval_record_sha256, approved_on, approver_identity,
    status, recorded_by, recorded_at, attested_at, mapping_note, resolution_sha256, synthetic,
    revision, supersedes_revision, supersession_basis
  ) values (
    target_tenant, v_decision_id, v_decision_key, v_selected_branch, v_basis,
    v_evidence_sha256, v_approval_record_sha256, v_approved_on::date, null,
    'owner_recorded', 'owner_action', target_recorded_at, null, v_mapping_note, v_resolution_sha256, v_synthetic,
    v_revision, v_supersedes_revision, v_supersession_basis
  );
  payload := pg_catalog.jsonb_build_object(
    'decision_id', v_decision_id,
    'decision_key', v_decision_key,
    'selected_branch', v_selected_branch,
    'basis', v_basis,
    'evidence_sha256', v_evidence_sha256,
    'approval_record_sha256', v_approval_record_sha256,
    'approved_on', v_approved_on,
    'status', 'owner_recorded',
    'recorded_by', 'owner_action',
    'approver_identity', null,
    'resolution_sha256', v_resolution_sha256,
    'revision', v_revision,
    'supersedes_revision', v_supersedes_revision,
    'supersession_basis', v_supersession_basis,
    'decision_row_resolution_state', decision.resolution_state,
    'decision_row_unchanged', true,
    'synthetic', v_synthetic
  );
  content_sha256 := private.governance_jsonb_sha256(payload);
  result := private.governance_finish_mutation(
    target_tenant, 'legal_decision_resolution_record', target_idempotency_key, target_command_sha256,
    'parameter_approval', v_decision_id, v_revision::text, v_revision, 'owner_recorded',
    payload, content_sha256, 'legal_decision_resolution_recorded',
    'owner_action', target_recorded_at, false
  );
  return next result;
end;
$$;

alter function private.governance_legal_decision_resolution_record(text, jsonb, text, text, timestamptz)
  owner to tivdoc_governance_owner;
revoke all on function private.governance_legal_decision_resolution_record(text, jsonb, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.governance_legal_decision_resolution_record(text, jsonb, text, text, timestamptz)
  to tivdoc_operations_runtime;

-- 3. The read: every revision, ordered; the return type changes, so the function is dropped first.
drop function private.legal_decision_resolution_read(text);
create function private.legal_decision_resolution_read(target_tenant text)
returns table (
  decision_id text, decision_key text, selected_branch text, basis text,
  evidence_sha256 text, approval_record_sha256 text, approved_on date,
  approver_identity text, status text, recorded_by text, recorded_at timestamptz,
  attested_at timestamptz, mapping_note text, resolution_sha256 text, synthetic boolean,
  revision integer, supersedes_revision integer, supersession_basis text
)
language plpgsql security definer set search_path = '' as $$
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  return query
    select r.decision_id, r.decision_key, r.selected_branch, r.basis,
           r.evidence_sha256, r.approval_record_sha256, r.approved_on,
           r.approver_identity, r.status, r.recorded_by, r.recorded_at,
           r.attested_at, r.mapping_note, r.resolution_sha256, r.synthetic,
           r.revision, r.supersedes_revision, r.supersession_basis
      from private.legal_decision_resolutions r
     where r.tenant_id = target_tenant
     order by r.decision_id, r.revision;
end;
$$;

alter function private.legal_decision_resolution_read(text) owner to tivdoc_governance_owner;
revoke all on function private.legal_decision_resolution_read(text)
  from public, anon, authenticated, service_role;
grant execute on function private.legal_decision_resolution_read(text)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

comment on column private.legal_decision_resolutions.revision is
  'Append-only re-recording (external review #1, finding 5): 1 for a decision''s first resolution; a supersession is inserted as the next revision and names the one it supersedes. No row is ever updated or deleted.';
comment on column private.legal_decision_resolutions.supersession_basis is
  'Why the previous revision was superseded, e.g. superseded_by_external_review_2026-09-05. Null on revision 1.';
