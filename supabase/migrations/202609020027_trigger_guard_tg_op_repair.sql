-- Fix-forward for a defect I introduced in 202609020023 and then repeated in
-- 202609020026: both trigger guards wrote `pg_catalog.tg_op`. `TG_OP` is a
-- PL/pgSQL variable, not a catalog function, and under `set search_path = ''`
-- qualifying it produces `42P01 missing FROM-clause entry for table
-- "pg_catalog"` the moment the trigger fires.
--
-- It went unnoticed in 023 because that table grants no UPDATE or DELETE to any
-- runtime role, so the ACL check refuses first with 42501 and the trigger never
-- runs — the R-14 proof's immutability cases were passing on the grant, not on
-- the guard they were written to exercise. It surfaced in 026 immediately,
-- because that guard is on the one table with a permitted update path.
--
-- Worse than either: 026 replaced 202609020022's working decision guard with
-- the broken one, so `open -> withdrawn` and `open -> resolved` would both have
-- failed until this landed. 022's body is restored here verbatim, with the
-- synthetic rule added on top of it rather than in place of it.

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
       or OLD.created_at is distinct from NEW.created_at then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
    end if;
    -- E3-3. `synthetic` may be raised, never lowered: a fixture must never be
    -- laundered into a legal decision. It is the one column that may move
    -- without a resolution-state transition, and only in that direction.
    if OLD.synthetic and not NEW.synthetic then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
    end if;
    if OLD.resolution_state is not distinct from NEW.resolution_state then
      -- No state change: the only permitted edit is raising `synthetic`.
      if OLD.synthetic is not distinct from NEW.synthetic then
        raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
      end if;
      if OLD.resolved_branch is distinct from NEW.resolved_branch
         or OLD.withdrawn_reason is distinct from NEW.withdrawn_reason
         or OLD.dissolution_citation_locator is distinct from NEW.dissolution_citation_locator then
        raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
      end if;
      return NEW;
    end if;
    if OLD.resolution_state is distinct from 'open' then
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

-- The same repair on 023's guard. It has never actually run, but a guard that
-- would fail with a nonsense error the first time the grants ever changed is
-- not a guard.
create or replace function private.legal_operations_execution_trace_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception using errcode = '42501', message = 'LEGAL_OPERATIONS_EXECUTION_TRACE_IMMUTABLE';
end;
$$;

alter function private.legal_operations_execution_trace_guard() owner to tivdoc_governance_owner;
revoke all on function private.legal_operations_execution_trace_guard()
  from public, anon, authenticated, service_role;
