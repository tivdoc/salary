-- Run 11 / L11-2 (D2). A resolution is a new record.
--
-- On 5 September 2026 a labour lawyer approved an opinion on the six open
-- legal decisions. The owner records that opinion's selected branches here —
-- as resolutions, one per decision, each naming the branch the report and the
-- shadow treat as DEFAULT from now on. That is the only thing a resolution
-- changes. Every other branch is still computed and shown; no source is
-- reviewed, no parameter leaves draft, no RuleSpec activates, no counter moves.
--
-- Why a new table and not the decision row: `legal_open_decisions` has exactly
-- one permitted transition, open -> resolved, and it belongs to the parameter
-- attestation cascade — two registered reviewer identities attesting the
-- branch's parameter. An owner recording a lawyer's opinion is not that, and
-- must not be mistakable for it. The decision row stays `open`; this function
-- contains no statement that touches it.
--
-- `status` has two values. `owner_recorded` is the only one anything in this
-- migration can produce. `attested` exists in the vocabulary so that the record
-- can one day carry the registered reviewer identity that attests it at the
-- /operations screen — and that transition is NOT here: the guard below refuses
-- every UPDATE. The migration that adds the attestation path adds the
-- transition, with the registered-identity check, at the same time. Until
-- then there is no code path, sanctioned or otherwise, that sets `attested`.
create table private.legal_decision_resolutions (
  tenant_id text not null,
  decision_id text not null check (decision_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'),
  -- The name the opinion and the run brief use for the decision, kept beside
  -- the register's id so the mapping between them is on the row itself.
  decision_key text not null check (decision_key ~ '^[a-z][a-z0-9_]{2,79}$'),
  selected_branch text not null check (selected_branch ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$'),
  basis text not null check (basis = 'lawyer_approved_opinion'),
  evidence_sha256 text not null check (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  approval_record_sha256 text not null check (approval_record_sha256 ~ '^[a-f0-9]{64}$'),
  approved_on date not null,
  approver_identity text null check (approver_identity is null or approver_identity ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'),
  status text not null check (status in ('owner_recorded', 'attested')),
  recorded_by text not null check (recorded_by = 'owner_action'),
  recorded_at timestamptz not null,
  attested_at timestamptz null,
  mapping_note text not null check (char_length(mapping_note) between 1 and 2000),
  resolution_sha256 text not null check (resolution_sha256 ~ '^[a-f0-9]{64}$'),
  synthetic boolean not null default false,
  primary key (tenant_id, decision_id),
  constraint legal_decision_resolutions_status_pairing_check check (
    (status = 'owner_recorded' and approver_identity is null and attested_at is null)
    or (status = 'attested' and approver_identity is not null and attested_at is not null)
  )
);

alter table private.legal_decision_resolutions owner to tivdoc_governance_owner;
alter table private.legal_decision_resolutions enable row level security;
alter table private.legal_decision_resolutions force row level security;

create policy legal_decision_resolutions_verified_tenant on private.legal_decision_resolutions
  for all to tivdoc_governance_owner
  using (tenant_id = private.runtime_verified_tenant())
  with check (tenant_id = private.runtime_verified_tenant());

-- Append-only, and born owner_recorded: an insert that claims `attested` is
-- refused by name, an update of any column is refused, a delete is refused.
create function private.governance_legal_decision_resolution_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if TG_OP = 'DELETE' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
  end if;
  if TG_OP = 'UPDATE' then
    -- The one transition (owner_recorded -> attested by a registered reviewer
    -- identity at /operations) does not exist yet. Nothing may move.
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
  end if;
  if NEW.status is distinct from 'owner_recorded'
     or NEW.approver_identity is not null
     or NEW.attested_at is not null then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_DECISION_RESOLUTION_BORN_ATTESTED';
  end if;
  return NEW;
end;
$$;

alter function private.governance_legal_decision_resolution_guard() owner to tivdoc_governance_owner;
revoke all on function private.governance_legal_decision_resolution_guard()
  from public, anon, authenticated, service_role;

create trigger legal_decision_resolutions_guard
  before insert or update or delete on private.legal_decision_resolutions
  for each row execute function private.governance_legal_decision_resolution_guard();

-- Records one owner resolution. Idempotent on (tenant, scope, key, command
-- sha256) through the same ledger every governance append uses. Refuses a
-- decision that is not registered, one that is not open, a second resolution
-- for the same decision, a payload asking for any status but owner_recorded,
-- and a synthetic flag that disagrees with the decision row's.
create function private.governance_legal_decision_resolution_record(
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
  if v_decision_id is null or v_decision_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'
     or v_decision_key is null or v_decision_key !~ '^[a-z][a-z0-9_]{2,79}$'
     or v_selected_branch is null or v_selected_branch !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$'
     or v_basis is distinct from 'lawyer_approved_opinion'
     or v_evidence_sha256 is null or v_evidence_sha256 !~ '^[a-f0-9]{64}$'
     or v_approval_record_sha256 is null or v_approval_record_sha256 !~ '^[a-f0-9]{64}$'
     or v_approved_on is null
     or v_mapping_note is null or char_length(v_mapping_note) not between 1 and 2000
     or v_resolution_sha256 is null or v_resolution_sha256 !~ '^[a-f0-9]{64}$' then
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
  select * into existing from private.legal_decision_resolutions r
  where r.tenant_id = target_tenant and r.decision_id = v_decision_id;
  if existing.decision_id is not null then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_DECISION_RESOLUTION_EXISTS';
  end if;
  insert into private.legal_decision_resolutions (
    tenant_id, decision_id, decision_key, selected_branch, basis,
    evidence_sha256, approval_record_sha256, approved_on, approver_identity,
    status, recorded_by, recorded_at, attested_at, mapping_note, resolution_sha256, synthetic
  ) values (
    target_tenant, v_decision_id, v_decision_key, v_selected_branch, v_basis,
    v_evidence_sha256, v_approval_record_sha256, v_approved_on::date, null,
    'owner_recorded', 'owner_action', target_recorded_at, null, v_mapping_note, v_resolution_sha256, v_synthetic
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
    'decision_row_resolution_state', decision.resolution_state,
    'decision_row_unchanged', true,
    'synthetic', v_synthetic
  );
  content_sha256 := private.governance_jsonb_sha256(payload);
  result := private.governance_finish_mutation(
    target_tenant, 'legal_decision_resolution_record', target_idempotency_key, target_command_sha256,
    'parameter_approval', v_decision_id, '1', 1, 'owner_recorded',
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

-- The sanctioned read, shaped like legal_open_decision_read.
create function private.legal_decision_resolution_read(target_tenant text)
returns table (
  decision_id text, decision_key text, selected_branch text, basis text,
  evidence_sha256 text, approval_record_sha256 text, approved_on date,
  approver_identity text, status text, recorded_by text, recorded_at timestamptz,
  attested_at timestamptz, mapping_note text, resolution_sha256 text, synthetic boolean
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
           r.attested_at, r.mapping_note, r.resolution_sha256, r.synthetic
      from private.legal_decision_resolutions r
     where r.tenant_id = target_tenant
     order by r.decision_id;
end;
$$;

alter function private.legal_decision_resolution_read(text) owner to tivdoc_governance_owner;
revoke all on function private.legal_decision_resolution_read(text)
  from public, anon, authenticated, service_role;
grant execute on function private.legal_decision_resolution_read(text)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

comment on table private.legal_decision_resolutions is
  'Owner-recorded resolutions of open legal decisions: which branch is the default, on what evidence. Not an attestation; the decision row stays open. Append-only; status owner_recorded is the only value any path here produces.';
comment on function private.governance_legal_decision_resolution_record(text, jsonb, text, text, timestamptz) is
  'Records one owner resolution of an open decision, naming the default branch and the lawyer-approved opinion it rests on. Touches no column of the decision row and cannot produce status attested.';
comment on function private.legal_decision_resolution_read(text) is
  'Reads the verified tenant''s owner-recorded resolutions.';

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'legal_decision_resolutions',
  'tivdoc-legal-decision-resolution-v0',
  '202609020031_legal_decision_resolutions'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;
