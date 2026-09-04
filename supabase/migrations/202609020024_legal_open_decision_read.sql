-- Q-1..Q-7 / Q-8 / E2-1 prerequisite, found by trying to use the table rather
-- than by reading the schema: `private.legal_open_decisions` has a register
-- function, a withdraw function and a guard, and **no read path at all**.
--
-- Nothing that can connect could see whether a decision was open, resolved or
-- withdrawn. `governance_aggregate_read` does not cover it — the register
-- function writes an aggregate snapshot under the decision id, but the id shape
-- does not match what a caller can address — and the table has no SELECT grant
-- for any login role. So a draft RuleSpec carrying both branches of a decision
-- could not check the decision was still open, and the decision-sensitivity
-- report could not list withdrawn decisions separately from resolved ones,
-- which A7-3 requires of it.
--
-- This adds the read, and only the read. Registering, resolving and withdrawing
-- keep their existing entrypoints and their existing grants.
create function private.legal_open_decision_read(target_tenant text)
returns table (
  decision_id text, topic text, question text, dossier_anchor text,
  resolution_state text, resolved_branch text,
  withdrawn_reason text, dissolution_citation_locator text,
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
           d.created_at, d.updated_at
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

comment on function private.legal_open_decision_read(text) is
  'Reads this tenant''s legal open decisions, including the withdrawn ones with their reason and dissolving citation. Read-only; state changes keep their own entrypoints.';
