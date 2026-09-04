-- Addendum 7 A7-3. A decision that turns out to be ill-posed — dissolved by
-- reading the primary source directly, not settled by two independent human
-- attestations naming the same branch — is withdrawn, not resolved.
-- Resolution is a human act with identities (governance_parameter_attestation_append's
-- decision-resolution cascade); withdrawal is an engineering act with
-- evidence: a reason and the exact citation locator that dissolved it. The
-- two must never look alike to a later reader, so they are distinct states,
-- distinct required companion fields, and a distinct entrypoint function —
-- withdrawal has no reviewer identity to check and no cascade to run,
-- because an ill-posed decision has no sibling branches left to reject.
alter table private.legal_open_decisions
  drop constraint legal_open_decisions_resolution_pairing_check;

alter table private.legal_open_decisions
  drop constraint legal_open_decisions_resolution_state_check;

alter table private.legal_open_decisions
  add constraint legal_open_decisions_resolution_state_check
  check (resolution_state in ('open', 'resolved', 'withdrawn'));

alter table private.legal_open_decisions
  add column withdrawn_reason text null check (withdrawn_reason is null or char_length(withdrawn_reason) between 1 and 2000),
  add column dissolution_citation_locator text null check (dissolution_citation_locator is null or char_length(dissolution_citation_locator) between 1 and 500);

-- Exactly one state matches at a time (resolution_state is a single text
-- value), so this is a complete case split, not three independent checks
-- that might accidentally both pass: each state names every companion
-- field, including the other state's, so 'resolved' with a
-- withdrawn_reason set is rejected by the same constraint that requires
-- resolved_branch, not by a separate rule that could be dropped later
-- without anyone noticing the gap.
alter table private.legal_open_decisions
  add constraint legal_open_decisions_resolution_pairing_check
  check (
    case resolution_state
      when 'open' then resolved_branch is null and withdrawn_reason is null and dissolution_citation_locator is null
      when 'resolved' then resolved_branch is not null and withdrawn_reason is null and dissolution_citation_locator is null
      when 'withdrawn' then resolved_branch is null and withdrawn_reason is not null and dissolution_citation_locator is not null
      else false
    end
  );

create or replace function private.governance_legal_open_decision_guard() returns trigger
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
       or OLD.resolution_state is distinct from 'open' then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
    end if;
    if NEW.resolution_state = 'resolved' then
      if OLD.resolved_branch is not null or NEW.resolved_branch is null
         or NEW.withdrawn_reason is not null or NEW.dissolution_citation_locator is not null then
        raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
      end if;
      return NEW;
    end if;
    if NEW.resolution_state = 'withdrawn' then
      if OLD.withdrawn_reason is not null or OLD.dissolution_citation_locator is not null
         or NEW.withdrawn_reason is null or NEW.dissolution_citation_locator is null
         or NEW.resolved_branch is not null then
        raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
      end if;
      return NEW;
    end if;
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
  end if;
  return NEW;
end;
$$;

alter function private.governance_legal_open_decision_guard() owner to tivdoc_governance_owner;
revoke all on function private.governance_legal_open_decision_guard()
  from public, anon, authenticated, service_role;

-- Withdraws an open decision with evidence. Idempotent on
-- (target_tenant, decision_id, idempotency_key), the same ledger every
-- other append uses. No reviewer identity, no trust stack, no cascade: an
-- ill-posed decision was never validly split into branches to reject.
create function private.governance_legal_open_decision_withdraw(
  target_tenant text, target_decision_id text, target_withdrawn_reason text,
  target_dissolution_citation_locator text, target_idempotency_key text,
  target_command_sha256 text, target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  existing private.legal_open_decisions%rowtype;
  content_sha256 text;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'legal_open_decision_withdraw', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if target_decision_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'
     or target_withdrawn_reason is null or char_length(target_withdrawn_reason) not between 1 and 2000
     or target_dissolution_citation_locator is null or char_length(target_dissolution_citation_locator) not between 1 and 500 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_OPEN_DECISION_WITHDRAW_INVALID';
  end if;
  select * into existing from private.legal_open_decisions decision
  where decision.tenant_id = target_tenant and decision.decision_id = target_decision_id
  for update;
  if existing.decision_id is null then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_OPEN_DECISION_UNKNOWN';
  end if;
  if existing.resolution_state != 'open' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_OPEN_DECISION_NOT_OPEN';
  end if;
  update private.legal_open_decisions
  set resolution_state = 'withdrawn', withdrawn_reason = target_withdrawn_reason,
      dissolution_citation_locator = target_dissolution_citation_locator, updated_at = target_recorded_at
  where tenant_id = target_tenant and decision_id = target_decision_id;
  content_sha256 := private.governance_jsonb_sha256(pg_catalog.jsonb_build_object(
    'decision_id', target_decision_id, 'resolution_state', 'withdrawn',
    'withdrawn_reason', target_withdrawn_reason,
    'dissolution_citation_locator', target_dissolution_citation_locator
  ));
  result := private.governance_finish_mutation(
    target_tenant, 'legal_open_decision_withdraw', target_idempotency_key, target_command_sha256,
    'parameter_approval', target_decision_id, '1', 1, 'withdrawn',
    pg_catalog.jsonb_build_object(
      'decision_id', target_decision_id, 'withdrawn_reason', target_withdrawn_reason,
      'dissolution_citation_locator', target_dissolution_citation_locator
    ),
    content_sha256, 'legal_open_decision_withdrawn',
    'system_import', target_recorded_at, false
  );
  return next result;
end;
$$;

alter function private.governance_legal_open_decision_withdraw(text, text, text, text, text, text, timestamptz)
  owner to tivdoc_governance_owner;
revoke all on function private.governance_legal_open_decision_withdraw(text, text, text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.governance_legal_open_decision_withdraw(text, text, text, text, text, text, timestamptz)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'legal_open_decision_withdrawal',
  'tivdoc-legal-open-decision-withdrawal-v0',
  '202609020022_legal_open_decision_withdrawal'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on function private.governance_legal_open_decision_withdraw(text, text, text, text, text, text, timestamptz) is
  'Addendum 7 A7-3: withdraws an open decision found ill-posed, with a mandatory reason and the citation locator that dissolved it. Distinct from resolution (two independent human attestations naming a branch) — no reviewer identity, no cascade.';
