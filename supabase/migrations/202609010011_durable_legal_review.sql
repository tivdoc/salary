-- V0.10.3B durable legal review operations.
--
-- Additive, forward-only. It persists the internal reviewer workflow only:
-- a packet is evidence bound for human review, never an activation. No row
-- here can make a source, parameter or RuleSpec operative, and no customer
-- path reads these relations.
--
-- Ownership uses the existing internal-governance access model rather than the
-- customer tenant/case owner model: review packets belong to the operating
-- tenant's internal governance surface, not to a case owner, so they follow
-- the same SECURITY DEFINER plus forced-RLS shape as every other
-- private.governance_* relation and are never granted to a runtime principal.

create table private.governance_legal_review_packets (
  tenant_id text not null,
  packet_id text not null,
  packet_sha256 text not null check (packet_sha256 ~ '^[a-f0-9]{64}$'),
  revision bigint not null check (revision >= 1),
  state text not null check (state in (
    'pending_review', 'in_review', 'changes_requested', 'approved', 'rejected', 'superseded'
  )),
  topic text,
  source_version_id text not null,
  raw_artifact_sha256 text not null check (raw_artifact_sha256 ~ '^[a-f0-9]{64}$'),
  normalized_text_sha256 text not null check (normalized_text_sha256 ~ '^[a-f0-9]{64}$'),
  manifest_sha256 text not null check (manifest_sha256 ~ '^[a-f0-9]{64}$'),
  parser_version text not null,
  normalizer_version text not null,
  binding_json jsonb not null check (jsonb_typeof(binding_json) = 'object'),
  scope_json jsonb not null check (jsonb_typeof(scope_json) = 'object'),
  citations_json jsonb not null check (jsonb_typeof(citations_json) = 'array'),
  queue_priority integer not null check (queue_priority between 0 and 999),
  blocked_reason_codes text[] not null default '{}',
  superseded_by_packet_id text,
  activation_allowed boolean not null default false check (activation_allowed = false),
  enqueued_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, packet_id),
  check (state is distinct from 'superseded' or superseded_by_packet_id is not null),
  check (superseded_by_packet_id is null or superseded_by_packet_id is distinct from packet_id)
);

create index governance_legal_review_packets_queue_idx
  on private.governance_legal_review_packets (tenant_id, queue_priority, enqueued_at, packet_id);
create index governance_legal_review_packets_state_idx
  on private.governance_legal_review_packets (tenant_id, state, packet_id);
create index governance_legal_review_packets_source_idx
  on private.governance_legal_review_packets (tenant_id, source_version_id, packet_sha256);

create table private.governance_legal_review_actions (
  tenant_id text not null,
  action_id text not null,
  packet_id text not null,
  packet_sha256 text not null check (packet_sha256 ~ '^[a-f0-9]{64}$'),
  expected_revision bigint not null check (expected_revision >= 1),
  resulting_revision bigint not null check (resulting_revision >= 2),
  decision text not null check (decision in ('claim', 'request_changes', 'approve', 'reject', 'supersede')),
  actor_id text not null,
  actor_role text not null check (actor_role in (
    'legal_reviewer', 'senior_legal_reviewer', 'legal_reviewer_observer'
  )),
  signature_sha256 text not null check (signature_sha256 ~ '^[a-f0-9]{64}$'),
  reason_code text not null check (reason_code ~ '^[A-Z][A-Z0-9_]{2,99}$'),
  reason text not null,
  cited_chunk_ids text[] not null default '{}',
  action_json jsonb not null check (jsonb_typeof(action_json) = 'object'),
  action_sha256 text not null check (action_sha256 ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz not null,
  primary key (tenant_id, action_id),
  unique (tenant_id, packet_id, resulting_revision),
  check (resulting_revision = expected_revision + 1),
  -- An observer may never carry a decision; the API rejects it first and the
  -- constraint keeps that true even if a future caller bypasses the service.
  check (actor_role is distinct from 'legal_reviewer_observer'),
  check (decision is distinct from 'approve' or actor_role = 'senior_legal_reviewer'),
  check (decision is distinct from 'supersede' or actor_role = 'senior_legal_reviewer'),
  foreign key (tenant_id, packet_id)
    references private.governance_legal_review_packets (tenant_id, packet_id)
);

create index governance_legal_review_actions_packet_idx
  on private.governance_legal_review_actions (tenant_id, packet_id, resulting_revision);

create function private.governance_legal_review_packet_enqueue(
  target_tenant text,
  target_packet jsonb,
  target_priority integer,
  target_blocked_reason_codes jsonb,
  target_idempotency_key text,
  target_command_sha256 text,
  target_enqueued_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  target_id text := target_packet ->> 'packet_id';
  target_sha256 text := target_packet ->> 'packet_sha256';
  target_binding jsonb := target_packet -> 'binding';
  target_scope jsonb := target_packet -> 'scope';
  target_state text := target_packet ->> 'state';
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'legal_review_packet_enqueue', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if pg_catalog.jsonb_typeof(target_packet) is distinct from 'object'
     or target_packet ->> 'schema_version' is distinct from 'tivdoc-legal-review-v0.10.3'
     or target_id is null
     or target_sha256 !~ '^[a-f0-9]{64}$'
     or target_state is distinct from 'pending_review'
     or coalesce((target_packet ->> 'revision')::bigint, 0) is distinct from 1
     or pg_catalog.jsonb_typeof(target_binding) is distinct from 'object'
     or pg_catalog.jsonb_typeof(target_scope) is distinct from 'object'
     or pg_catalog.jsonb_typeof(target_packet -> 'citations') is distinct from 'array'
     or target_priority is null or target_priority < 0 or target_priority > 999
     or target_binding ->> 'raw_artifact_sha256' !~ '^[a-f0-9]{64}$'
     or target_binding ->> 'normalized_text_sha256' !~ '^[a-f0-9]{64}$'
     or target_binding ->> 'manifest_sha256' !~ '^[a-f0-9]{64}$'
     or coalesce(target_binding ->> 'parser_version', '') = ''
     or coalesce(target_binding ->> 'normalizer_version', '') = ''
     or coalesce(target_binding ->> 'source_version_id', '') = '' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_REVIEW_PACKET_INVALID';
  end if;
  insert into private.governance_legal_review_packets(
    tenant_id, packet_id, packet_sha256, revision, state, topic, source_version_id,
    raw_artifact_sha256, normalized_text_sha256, manifest_sha256, parser_version, normalizer_version,
    binding_json, scope_json, citations_json, queue_priority, blocked_reason_codes,
    superseded_by_packet_id, activation_allowed, enqueued_at, updated_at
  ) values (
    target_tenant, target_id, target_sha256, 1, 'pending_review',
    target_scope ->> 'topic', target_binding ->> 'source_version_id',
    target_binding ->> 'raw_artifact_sha256', target_binding ->> 'normalized_text_sha256',
    target_binding ->> 'manifest_sha256', target_binding ->> 'parser_version',
    target_binding ->> 'normalizer_version', target_binding, target_scope,
    target_packet -> 'citations', target_priority,
    coalesce(
      (select pg_catalog.array_agg(value #>> '{}')
       from pg_catalog.jsonb_array_elements(coalesce(target_blocked_reason_codes, '[]'::jsonb))),
      '{}'
    ), null, false,
    target_enqueued_at, target_enqueued_at
  );
  result := private.governance_finish_mutation(
    target_tenant, 'legal_review_packet_enqueue', target_idempotency_key, target_command_sha256,
    'legal_review', target_id, target_sha256, 1,
    'pending_review', target_packet, target_sha256,
    'legal_review_packet_enqueued', 'system_projection', target_enqueued_at, true
  );
  return next result;
end;
$$;

create function private.governance_legal_review_action_append(
  target_tenant text,
  target_action jsonb,
  target_next_state text,
  target_superseded_by text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_occurred_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  current_packet private.governance_legal_review_packets%rowtype;
  target_action_id text := target_action ->> 'action_id';
  target_packet_id text := target_action ->> 'packet_id';
  target_packet_sha256 text := target_action ->> 'packet_sha256';
  target_expected bigint := (target_action ->> 'expected_revision')::bigint;
  target_action_sha256 text := private.governance_jsonb_sha256(target_action);
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'legal_review_action_append', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if pg_catalog.jsonb_typeof(target_action) is distinct from 'object'
     or target_action ->> 'schema_version' is distinct from 'tivdoc-legal-review-v0.10.3'
     or target_action_id is null or target_packet_id is null
     or target_packet_sha256 !~ '^[a-f0-9]{64}$'
     or target_expected is null or target_expected < 1
     or coalesce(target_action -> 'attestation' ->> 'actor_id', '') = ''
     or coalesce(target_action -> 'attestation' ->> 'signature_sha256', '') !~ '^[a-f0-9]{64}$'
     or target_next_state not in (
       'in_review', 'changes_requested', 'approved', 'rejected', 'superseded'
     ) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_REVIEW_ACTION_INVALID';
  end if;
  select * into current_packet from private.governance_legal_review_packets packet
    where packet.tenant_id = target_tenant and packet.packet_id = target_packet_id
    for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_REVIEW_PACKET_NOT_FOUND';
  end if;
  -- Compare and swap on both the revision and the evidence identity, so a
  -- decision can never land on a packet that moved or was re-derived.
  if current_packet.revision is distinct from target_expected then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_REVIEW_STALE_REVISION';
  end if;
  if current_packet.packet_sha256 is distinct from target_packet_sha256 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_REVIEW_IDENTITY_CHANGED';
  end if;
  if current_packet.state in ('approved', 'rejected', 'superseded') then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_REVIEW_TERMINAL_STATE';
  end if;
  insert into private.governance_legal_review_actions(
    tenant_id, action_id, packet_id, packet_sha256, expected_revision, resulting_revision,
    decision, actor_id, actor_role, signature_sha256, reason_code, reason,
    cited_chunk_ids, action_json, action_sha256, occurred_at
  ) values (
    target_tenant, target_action_id, target_packet_id, target_packet_sha256,
    target_expected, target_expected + 1,
    target_action ->> 'decision', target_action -> 'attestation' ->> 'actor_id',
    target_action ->> 'actor_role', target_action -> 'attestation' ->> 'signature_sha256',
    target_action ->> 'reason_code', target_action ->> 'reason',
    coalesce(
      (select pg_catalog.array_agg(value #>> '{}')
       from pg_catalog.jsonb_array_elements(coalesce(target_action -> 'cited_chunk_ids', '[]'::jsonb))),
      '{}'
    ),
    target_action, target_action_sha256, target_occurred_at
  );
  update private.governance_legal_review_packets
    set revision = target_expected + 1,
        state = target_next_state,
        superseded_by_packet_id = case when target_next_state = 'superseded'
          then target_superseded_by else superseded_by_packet_id end,
        updated_at = target_occurred_at
    where tenant_id = target_tenant and packet_id = target_packet_id;
  result := private.governance_finish_mutation(
    target_tenant, 'legal_review_action_append', target_idempotency_key, target_command_sha256,
    'legal_review', target_packet_id, target_packet_sha256, target_expected + 1,
    target_next_state, target_action, target_action_sha256,
    'legal_review_action_appended', target_action -> 'attestation' ->> 'actor_id',
    target_occurred_at, true
  );
  return next result;
end;
$$;

create function private.governance_legal_review_queue_list(
  target_tenant text,
  target_limit integer
) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  entries jsonb;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_TENANT_CONTEXT_MISMATCH';
  end if;
  if target_limit is null or target_limit < 1 or target_limit > 500 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_LEGAL_REVIEW_LIMIT_INVALID';
  end if;
  select coalesce(pg_catalog.jsonb_agg(entry order by entry ->> 'ordinal'), '[]'::jsonb)
    into entries
    from (
      select pg_catalog.jsonb_build_object(
        'ordinal', pg_catalog.lpad(packet.queue_priority::text, 4, '0')
          || '|' || packet.enqueued_at::text || '|' || packet.packet_id,
        'packet_id', packet.packet_id,
        'packet_sha256', packet.packet_sha256,
        'revision', packet.revision,
        'state', packet.state,
        'topic', packet.topic,
        'source_version_id', packet.source_version_id,
        'parser_version', packet.parser_version,
        'normalizer_version', packet.normalizer_version,
        'queue_priority', packet.queue_priority,
        'blocked_reason_codes', pg_catalog.to_jsonb(packet.blocked_reason_codes),
        'superseded_by_packet_id', packet.superseded_by_packet_id,
        'activation_allowed', packet.activation_allowed,
        'enqueued_at', packet.enqueued_at,
        'updated_at', packet.updated_at
      ) as entry
      from private.governance_legal_review_packets packet
      where packet.tenant_id = target_tenant
      order by packet.queue_priority, packet.enqueued_at, packet.packet_id
      limit target_limit
    ) ordered;
  return entries;
end;
$$;

create trigger governance_legal_review_actions_immutable
before update or delete on private.governance_legal_review_actions
for each row execute function private.governance_forbid_mutation();

alter table private.governance_legal_review_packets enable row level security;
alter table private.governance_legal_review_packets force row level security;
alter table private.governance_legal_review_actions enable row level security;
alter table private.governance_legal_review_actions force row level security;

create policy governance_legal_review_packets_verified_tenant on private.governance_legal_review_packets to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_legal_review_actions_verified_tenant on private.governance_legal_review_actions to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());

alter table private.governance_legal_review_packets owner to tivdoc_governance_owner;
alter table private.governance_legal_review_actions owner to tivdoc_governance_owner;

revoke all on table
  private.governance_legal_review_packets,
  private.governance_legal_review_actions
from public, anon, authenticated, service_role;

revoke all on function private.governance_legal_review_packet_enqueue(
  text,jsonb,integer,jsonb,text,text,timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.governance_legal_review_action_append(
  text,jsonb,text,text,text,text,timestamptz
) from public, anon, authenticated, service_role;
revoke all on function private.governance_legal_review_queue_list(
  text,integer
) from public, anon, authenticated, service_role;

alter function private.governance_legal_review_packet_enqueue(
  text,jsonb,integer,jsonb,text,text,timestamptz
) owner to tivdoc_governance_owner;
alter function private.governance_legal_review_action_append(
  text,jsonb,text,text,text,text,timestamptz
) owner to tivdoc_governance_owner;
alter function private.governance_legal_review_queue_list(
  text,integer
) owner to tivdoc_governance_owner;

grant execute on function private.governance_legal_review_packet_enqueue(
  text,jsonb,integer,jsonb,text,text,timestamptz
) to tivdoc_governance_owner;
grant execute on function private.governance_legal_review_action_append(
  text,jsonb,text,text,text,text,timestamptz
) to tivdoc_governance_owner;
grant execute on function private.governance_legal_review_queue_list(
  text,integer
) to tivdoc_governance_owner;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'durable_legal_review',
  'tivdoc-legal-review-v0.10.3',
  '202609010011_durable_legal_review'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on table private.governance_legal_review_packets is
  'Internal legal review packets bound to immutable source evidence; never operative and never customer-readable.';
comment on table private.governance_legal_review_actions is
  'Append-only reviewer actions with actor, role and signature metadata; no action activates a source, parameter or rule.';
