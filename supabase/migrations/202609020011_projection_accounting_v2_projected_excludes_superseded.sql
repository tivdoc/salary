-- F4. The three-state accounting with the denominator where it belongs.
--
-- 202609020008 defined `projected` as the packet count. That is the wrong
-- population. With sixty-nine supersessions written, the function reported
--
--   projected 69 + blocked_active 2 + blocked_superseded 69 = 140
--
-- which double-counts every superseded observation: once as the blocked record
-- it still is, and once as the packet that supersedes it. The invariant is
-- stated over observations, and 71 is the number of observations. A packet that
-- exists because an observation was superseded is not a second observation; it
-- is the other population, linked to `blocked_superseded` and never summed in.
--
-- So `projected` counts only packets that did NOT arise by supersession —
-- observations that went straight to a packet with no blocked record. Today
-- that is zero, and the accounting reads
--
--   projected 0 + blocked_active 2 + blocked_superseded 69 = 71
--   packets_from_supersession = 69
--
-- both from the database. `packets_from_supersession` is counted from the
-- packet side — packets whose id a supersession row names — rather than from
-- the supersession side, so that a supersession pointing at a packet that does
-- not exist, or a packet that lost its supersession, shows up as the two
-- figures disagreeing instead of as one figure quietly reused for both.

create or replace function private.governance_legal_review_projection_accounting_v2(
  target_tenant text
) returns table (
  projected bigint,
  blocked_active bigint,
  blocked_superseded bigint,
  accounted bigint,
  packets_from_supersession bigint
)
language plpgsql security definer set search_path = '' as $$
declare
  packet_total bigint;
  packets_linked bigint;
  blocked_total bigint;
  superseded_count bigint;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  select pg_catalog.count(*) into packet_total
    from private.governance_legal_review_packets p where p.tenant_id = target_tenant;
  select pg_catalog.count(*) into packets_linked
    from private.governance_legal_review_packets p
   where p.tenant_id = target_tenant
     and exists (
       select 1 from private.governance_legal_review_observation_supersessions s
        where s.tenant_id = p.tenant_id and s.packet_id = p.packet_id
     );
  select pg_catalog.count(*) into blocked_total
    from private.governance_legal_review_observation_blocks b where b.tenant_id = target_tenant;
  select pg_catalog.count(*) into superseded_count
    from private.governance_legal_review_observation_supersessions s where s.tenant_id = target_tenant;
  return query select
    packet_total - packets_linked,
    blocked_total - superseded_count,
    superseded_count,
    (packet_total - packets_linked) + blocked_total,
    packets_linked;
end;
$$;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'legal_review_observation_supersessions',
  'tivdoc-legal-review-projection-accounting-v2-projected-excludes-superseded',
  '202609020011_projection_accounting_v2_projected_excludes_superseded'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;
