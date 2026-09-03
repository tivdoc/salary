-- The two-state accounting must not disagree with the three-state one.
--
-- After sixty-nine supersessions the original function reported
-- projected 69, blocked 71, accounted 140 — it counted every packet as a
-- projected observation and every blocked record as blocked, and a superseded
-- observation is both. The three-state function (202609020011) counts the
-- denominator correctly. Two functions on one database that give two different
-- `accounted` figures for one tenant is a ledger that contradicts itself, so
-- the older one now derives its figures from the newer one: `projected` is the
-- packets that did not arise by supersession, `blocked` is every blocked record
-- regardless of state, and `accounted` is their sum — 0 + 71 = 71 today, the
-- same 71 the three-state form arrives at by a different partition.

create or replace function private.governance_legal_review_projection_accounting(
  target_tenant text
) returns table (projected bigint, blocked bigint, accounted bigint)
language plpgsql security definer set search_path = '' as $$
declare
  three record;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  select * into three
    from private.governance_legal_review_projection_accounting_v2(target_tenant);
  return query select
    three.projected,
    three.blocked_active + three.blocked_superseded,
    three.accounted;
end;
$$;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'legal_review_observation_supersessions',
  'tivdoc-legal-review-projection-accounting-v1-delegates-to-v2',
  '202609020012_projection_accounting_v1_delegates_to_v2'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;
