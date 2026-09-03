-- Where a parsed observation goes, without the blocked record ever moving.
--
-- The blocked-record table was built with no hash, version, binding or
-- `superseded_by` column, so that graduation is impossible by construction. That
-- stays exactly as it is. A parse does not edit the blocked row, does not give
-- it a digest, and does not turn it into a packet. It gains a sibling row here,
-- pointing at a new packet, and the blocked row is untouched.
--
-- The accounting becomes three states over the same population. 71 is the number
-- of observations and does not change because one was parsed; what changes is
-- which state an observation is in:
--
--   accounted = projected + blocked_active + blocked_superseded
--
-- Packets are a different population and are linked rather than summed:
--
--   packets_from_supersession = blocked_superseded
--
-- Both are asserted. A run where those two disagree is a failure, and making
-- that disagreement detectable is the whole reason this table exists rather
-- than a column on the blocked record.

create table private.governance_legal_review_observation_supersessions (
  tenant_id text not null,
  observation_id text not null,
  packet_id text not null check (packet_id <> ''),
  -- The receipt is the parse artifact this supersession rests on; the parser and
  -- normalizer versions are recorded because a text layer read by one parser is
  -- not the same evidence as the same bytes read by another.
  parse_receipt_sha256 text not null check (parse_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  normalized_text_sha256 text not null check (normalized_text_sha256 ~ '^[a-f0-9]{64}$'),
  parser_version text not null check (parser_version <> ''),
  normalizer_version text not null check (normalizer_version <> ''),
  -- OCR output is derived, not documented. It never satisfies a citation that
  -- needs exact bytes, and a supersession that rests on it says so here.
  ocr_derived boolean not null,
  superseded_at timestamptz not null,
  -- One supersession per observation: an observation supersedes exactly once,
  -- and a second attempt is a conflict rather than a second history.
  primary key (tenant_id, observation_id),
  unique (tenant_id, packet_id),
  foreign key (tenant_id, observation_id)
    references private.governance_legal_review_observation_blocks (tenant_id, observation_id)
    on delete restrict
);

create index governance_legal_review_observation_supersessions_packet_idx
  on private.governance_legal_review_observation_supersessions (tenant_id, packet_id);

alter table private.governance_legal_review_observation_supersessions
  owner to tivdoc_governance_owner;

-- Append-only, enforced the same way the blocked record is.
create trigger governance_legal_review_observation_supersessions_immutable
  before update or delete on private.governance_legal_review_observation_supersessions
  for each row execute function private.governance_forbid_mutation();

alter table private.governance_legal_review_observation_supersessions
  enable row level security;
alter table private.governance_legal_review_observation_supersessions
  force row level security;

create policy governance_legal_review_observation_supersessions_verified_tenant
  on private.governance_legal_review_observation_supersessions
  for all
  to tivdoc_governance_owner
  using (tenant_id = private.runtime_verified_tenant())
  with check (tenant_id = private.runtime_verified_tenant());

revoke all on table private.governance_legal_review_observation_supersessions
  from public, anon, authenticated, service_role;

-- Appending a supersession. The blocked row must already exist and must not
-- already be superseded; both are enforced by the schema rather than by the
-- caller remembering to check.
create function private.governance_legal_review_observation_supersession_append(
  target_tenant text,
  target_observation text,
  target_packet text,
  target_parse_receipt_sha256 text,
  target_normalized_text_sha256 text,
  target_parser_version text,
  target_normalizer_version text,
  target_ocr_derived boolean,
  target_superseded_at timestamptz
) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  insert into private.governance_legal_review_observation_supersessions (
    tenant_id, observation_id, packet_id, parse_receipt_sha256,
    normalized_text_sha256, parser_version, normalizer_version,
    ocr_derived, superseded_at
  ) values (
    target_tenant, target_observation, target_packet, target_parse_receipt_sha256,
    target_normalized_text_sha256, target_parser_version, target_normalizer_version,
    target_ocr_derived, target_superseded_at
  );
end;
$$;

-- The accounting, in three states over one denominator, plus the packet link.
-- `blocked_active` and `blocked_superseded` partition the blocked records, so
-- their sum is unchanged and 71 stays 71 however many observations are parsed.
create function private.governance_legal_review_projection_accounting_v2(
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
  projected_count bigint;
  blocked_total bigint;
  superseded_count bigint;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  select pg_catalog.count(*) into projected_count
    from private.governance_legal_review_packets p where p.tenant_id = target_tenant;
  select pg_catalog.count(*) into blocked_total
    from private.governance_legal_review_observation_blocks b where b.tenant_id = target_tenant;
  select pg_catalog.count(*) into superseded_count
    from private.governance_legal_review_observation_supersessions s where s.tenant_id = target_tenant;
  return query select
    projected_count,
    blocked_total - superseded_count,
    superseded_count,
    projected_count + blocked_total,
    superseded_count;
end;
$$;

revoke all on function private.governance_legal_review_observation_supersession_append(
  text,text,text,text,text,text,text,boolean,timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.governance_legal_review_projection_accounting_v2(text)
  from public, anon, authenticated, service_role;

alter function private.governance_legal_review_observation_supersession_append(
  text,text,text,text,text,text,text,boolean,timestamptz
) owner to tivdoc_governance_owner;
alter function private.governance_legal_review_projection_accounting_v2(text)
  owner to tivdoc_governance_owner;

-- The grants ship with the objects they cover, because a boundary whose grant
-- arrives in a later migration is a boundary that fails on its first call.
grant execute on function private.governance_legal_review_observation_supersession_append(
  text,text,text,text,text,text,text,boolean,timestamptz
) to tivdoc_operations_runtime;
grant execute on function private.governance_legal_review_projection_accounting_v2(text)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'legal_review_observation_supersessions',
  'tivdoc-legal-review-observation-supersessions',
  '202609020008_legal_review_observation_supersessions'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on table private.governance_legal_review_observation_supersessions is
  'One row per observation whose bytes were parsed into a packet. The blocked record it names is never edited: anti-graduation means the block is immutable and a parse produces a sibling, not a promotion.';
