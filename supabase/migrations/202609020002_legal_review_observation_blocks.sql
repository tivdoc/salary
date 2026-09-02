-- Wave 1 forward-only durable store for blocked legal review observations.
--
-- An observation that was acquired but never parsed has no normalized text, no
-- manifest, no parser and no normalizer version. `packet_enqueue` is right to
-- reject it: there is nothing for a reviewer to read, so it is not a review
-- packet and must never become one. Supplying those fields to get past the
-- validation would be fabricated evidence.
--
-- So the blocked side of the projection gets its own home, a sibling of the
-- packet tables under the same schema, the same ownership, the same forced RLS
-- and the same append-only guarantee. The observation id is the key and is the
-- idempotency key: projecting the same observation twice inserts nothing.
--
-- Anti-graduation, enforced by construction: this table holds no hash, version
-- or binding column that could later be backfilled, and the append-only trigger
-- forbids UPDATE entirely. If an observation is genuinely parsed one day, that
-- produces a new artifact with real hashes and a new packet; this row stays as
-- it is, and the two are related by sharing the observation id. There is no
-- column to mutate and therefore no path by which a block becomes a packet.
--
-- Every field here is provenance that genuinely exists at acquisition time.
-- Anything absent is NULL: no placeholder, no empty string, no synthesized
-- version number.

create table private.governance_legal_review_observation_blocks (
  tenant_id text not null,
  observation_id text not null,
  reason_code text not null check (reason_code in (
    'BYTES_PRESENT_NOT_PARSED',
    'BYTES_REJECTED_MEDIA',
    'BYTES_REJECTED_ENCODING',
    'BYTES_REJECTED_DUPLICATE',
    'BYTES_REJECTED_EMPTY_NORMALIZED_TEXT',
    'RETRIEVAL_FAILED_NO_BYTES'
  )),
  source_url text check (source_url is null or source_url <> ''),
  final_url text check (final_url is null or final_url <> ''),
  retrieved_at timestamptz,
  http_status integer check (http_status is null or http_status between 100 and 599),
  redirect_chain jsonb check (redirect_chain is null or jsonb_typeof(redirect_chain) = 'array'),
  media_type text check (media_type is null or media_type <> ''),
  raw_artifact_sha256 text check (raw_artifact_sha256 is null or raw_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  byte_count bigint check (byte_count is null or byte_count >= 0),
  command_sha256 text not null check (command_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz not null,
  primary key (tenant_id, observation_id),
  -- A reason that claims bytes were present must carry the bytes it saw, and a
  -- retrieval that produced nothing must not claim a digest.
  check (reason_code <> 'RETRIEVAL_FAILED_NO_BYTES' or (raw_artifact_sha256 is null and coalesce(byte_count, 0) = 0)),
  check (reason_code = 'RETRIEVAL_FAILED_NO_BYTES' or raw_artifact_sha256 is not null)
);

create index governance_legal_review_observation_blocks_reason_idx
  on private.governance_legal_review_observation_blocks (tenant_id, reason_code, observation_id);

alter table private.governance_legal_review_observation_blocks
  owner to tivdoc_governance_owner;

create trigger governance_legal_review_observation_blocks_immutable
before update or delete on private.governance_legal_review_observation_blocks
for each row execute function private.governance_forbid_mutation();

alter table private.governance_legal_review_observation_blocks enable row level security;
alter table private.governance_legal_review_observation_blocks force row level security;

create policy governance_legal_review_observation_blocks_verified_tenant
  on private.governance_legal_review_observation_blocks
  to tivdoc_governance_owner
  using (tenant_id = private.runtime_verified_tenant())
  with check (tenant_id = private.runtime_verified_tenant());

revoke all on table private.governance_legal_review_observation_blocks
  from public, anon, authenticated, service_role;

-- Records one blocked observation. The observation id is the idempotency key:
-- a replay returns the existing row and inserts nothing.
create function private.governance_legal_review_observation_block_append(
  target_tenant text,
  target_observation_id text,
  target_reason_code text,
  target_provenance jsonb,
  target_command_sha256 text,
  target_recorded_at timestamptz
) returns setof private.governance_legal_review_observation_blocks
language plpgsql security definer set search_path = '' as $$
declare
  existing private.governance_legal_review_observation_blocks;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  if target_observation_id !~ '^[A-Za-z0-9:._-]{3,200}$'
     or target_command_sha256 !~ '^[a-f0-9]{64}$'
     or pg_catalog.jsonb_typeof(target_provenance) is distinct from 'object' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_OBSERVATION_BLOCK_INVALID';
  end if;

  select * into existing
  from private.governance_legal_review_observation_blocks
  where tenant_id = target_tenant and observation_id = target_observation_id;
  if found then
    -- Replay. The row is immutable, so a second call adds nothing and changes
    -- nothing, including when the caller supplies a different reason.
    return next existing;
    return;
  end if;

  insert into private.governance_legal_review_observation_blocks(
    tenant_id, observation_id, reason_code, source_url, final_url, retrieved_at,
    http_status, redirect_chain, media_type, raw_artifact_sha256, byte_count,
    command_sha256, recorded_at
  ) values (
    target_tenant,
    target_observation_id,
    target_reason_code,
    nullif(target_provenance ->> 'source_url', ''),
    nullif(target_provenance ->> 'final_url', ''),
    (target_provenance ->> 'retrieved_at')::timestamptz,
    (target_provenance ->> 'http_status')::integer,
    case when pg_catalog.jsonb_typeof(target_provenance -> 'redirect_chain') = 'array'
      then target_provenance -> 'redirect_chain' else null end,
    nullif(target_provenance ->> 'media_type', ''),
    nullif(target_provenance ->> 'raw_artifact_sha256', ''),
    (target_provenance ->> 'byte_count')::bigint,
    target_command_sha256,
    target_recorded_at
  )
  returning * into existing;
  return next existing;
end;
$$;

-- Reconciles the projection: accounted = projected + blocked, as a relation the
-- dashboard reads rather than a number a report repeats.
create function private.governance_legal_review_projection_accounting(
  target_tenant text
) returns table (projected bigint, blocked bigint, accounted bigint)
language plpgsql security definer set search_path = '' as $$
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  return query
  select
    (select pg_catalog.count(*) from private.governance_legal_review_packets p
      where p.tenant_id = target_tenant)::bigint,
    (select pg_catalog.count(*) from private.governance_legal_review_observation_blocks b
      where b.tenant_id = target_tenant)::bigint,
    (select pg_catalog.count(*) from private.governance_legal_review_packets p
      where p.tenant_id = target_tenant)::bigint
    + (select pg_catalog.count(*) from private.governance_legal_review_observation_blocks b
      where b.tenant_id = target_tenant)::bigint;
end;
$$;

revoke all on function private.governance_legal_review_observation_block_append(
  text,text,text,jsonb,text,timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.governance_legal_review_projection_accounting(
  text
) from public, anon, authenticated, service_role;

alter function private.governance_legal_review_observation_block_append(
  text,text,text,jsonb,text,timestamptz
) owner to tivdoc_governance_owner;
alter function private.governance_legal_review_projection_accounting(
  text
) owner to tivdoc_governance_owner;

-- The grants ship in the same migration as the objects they cover, because a
-- family reachable only by its owning role is exactly the defect this chain
-- already paid for once.
grant execute on function private.governance_legal_review_observation_block_append(
  text,text,text,jsonb,text,timestamptz
) to tivdoc_operations_runtime, tivdoc_worker_runtime;
grant execute on function private.governance_legal_review_projection_accounting(
  text
) to tivdoc_operations_runtime, tivdoc_worker_runtime;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'legal_review_observation_blocks',
  'tivdoc-legal-review-observation-blocks-wave1',
  '202609020002_legal_review_observation_blocks'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on table private.governance_legal_review_observation_blocks is
  'Append-only record of observations that cannot become review packets. Holds no hash, version or binding column, so a block can never be graduated into a packet by backfill.';
