-- L5-5 / D4. `legal-instrument-selector-v1`: an instrument boundary is a draft
-- selection artifact, written through the governance path like a parameter.
--
-- A gazette issue is one artifact carrying several instruments. Until now the
-- boundary between them was recorded as `instrument_selector_pending_human_review`
-- and everything on the page was unusable — including a convalescence day rate
-- sitting in plain text for two runs. The boundary is a document segmentation,
-- not a legal interpretation: an instrument is selected by its own title line
-- and the next instrument's title line, over the page span they delimit, and
-- the selection is hashed. A parameter cited into a selected span carries the
-- selection's hash in its binding, so attesting the parameter attests the
-- boundary. Nothing here reviews anything; a selection is `draft` and stays
-- `draft` until a person attests the parameter that rests on it.
--
-- Two-column gazette layouts interleave columns line by line, which is why the
-- selection unit is a page span bounded by the title lines rather than a line
-- span: a line span would cut through the neighbouring column. The anchors
-- identify the instrument; the page span is what is chunked.
--
-- Same shape as parameter candidates: append-only, revisioned, supersedable
-- with a paired reason, `synthetic` one-way, force-RLS on the verified tenant.

create table private.legal_instrument_selections (
  tenant_id text not null,
  selection_id text not null check (selection_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'),
  revision bigint not null check (revision >= 1),
  source_id text not null check (source_id ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'),
  source_version text not null check (char_length(source_version) between 1 and 64),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  page_from integer not null check (page_from >= 1),
  page_to integer not null check (page_to >= page_from),
  start_anchor text not null check (char_length(start_anchor) between 8 and 500),
  end_anchor text not null check (char_length(end_anchor) between 3 and 500),
  selection_sha256 text not null check (selection_sha256 ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('draft', 'superseded')),
  superseded_by text null check (superseded_by is null or superseded_by ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'),
  supersede_reason text null check (supersede_reason is null or char_length(supersede_reason) between 20 and 2000),
  synthetic boolean not null default false,
  record_json jsonb not null,
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz not null,
  primary key (tenant_id, selection_id, revision),
  constraint legal_instrument_selections_supersession_pairing_check
    check ((state = 'superseded') = (superseded_by is not null and supersede_reason is not null))
);

alter table private.legal_instrument_selections owner to tivdoc_governance_owner;
alter table private.legal_instrument_selections enable row level security;
alter table private.legal_instrument_selections force row level security;

create policy legal_instrument_selections_verified_tenant on private.legal_instrument_selections
  for all to tivdoc_governance_owner
  using (tenant_id = private.runtime_verified_tenant())
  with check (tenant_id = private.runtime_verified_tenant());

-- Append-only. Revision 1 is draft; a later revision may only be the
-- supersession of a draft that exists; the synthetic flag never clears.
create function private.governance_legal_instrument_selection_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  previous private.legal_instrument_selections%rowtype;
begin
  if TG_OP = 'DELETE' or TG_OP = 'UPDATE' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_APPEND_ONLY';
  end if;
  if NEW.revision = 1 then
    if NEW.state is distinct from 'draft' then
      raise exception using errcode = 'P0001', message = 'GOVERNANCE_SELECTION_FIRST_REVISION_MUST_BE_DRAFT';
    end if;
    return NEW;
  end if;
  select * into previous from private.legal_instrument_selections item
  where item.tenant_id = NEW.tenant_id and item.selection_id = NEW.selection_id and item.revision = NEW.revision - 1;
  if previous.selection_id is null then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_SELECTION_REVISION_GAP';
  end if;
  if previous.state is distinct from 'draft' or NEW.state is distinct from 'superseded' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_SELECTION_ONLY_DRAFT_MAY_BE_SUPERSEDED';
  end if;
  if previous.synthetic and not NEW.synthetic then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_SYNTHETIC_FLAG_IS_ONE_WAY';
  end if;
  return NEW;
end;
$$;

alter function private.governance_legal_instrument_selection_guard() owner to tivdoc_governance_owner;
-- 018 and 023 both forgot this line and shipped a guard executable by PUBLIC.
revoke all on function private.governance_legal_instrument_selection_guard() from public, anon, authenticated, service_role;

create trigger legal_instrument_selections_guard
  before insert or update or delete on private.legal_instrument_selections
  for each row execute function private.governance_legal_instrument_selection_guard();

-- Registers one selection at revision 1, state draft. Idempotent on the
-- (tenant, key, command sha) triple like every other governance mutation.
create function private.governance_legal_instrument_selection_register(
  target_tenant text, target_selection jsonb, target_idempotency_key text,
  target_command_sha256 text, target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  target_id text := target_selection ->> 'selection_id';
  target_source_id text := target_selection ->> 'source_id';
  target_source_version text := target_selection ->> 'source_version';
  target_artifact text := target_selection ->> 'artifact_sha256';
  target_page_from integer := (target_selection ->> 'page_from')::integer;
  target_page_to integer := (target_selection ->> 'page_to')::integer;
  target_start text := target_selection ->> 'start_anchor';
  target_end text := target_selection ->> 'end_anchor';
  target_selection_sha256 text := target_selection ->> 'selection_sha256';
  target_synthetic boolean := coalesce((target_selection ->> 'synthetic')::boolean, false);
  content_sha256 text;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'legal_instrument_selection_register', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if pg_catalog.jsonb_typeof(target_selection) is distinct from 'object'
     or target_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'
     or target_source_id !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'
     or target_source_version is null
     or target_artifact !~ '^[a-f0-9]{64}$'
     or target_selection_sha256 !~ '^[a-f0-9]{64}$'
     or target_page_from is null or target_page_to is null or target_page_to < target_page_from or target_page_from < 1
     or target_start is null or char_length(target_start) not between 8 and 500
     or target_end is null or char_length(target_end) not between 3 and 500 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_SELECTION_INVALID';
  end if;
  if exists (select 1 from private.legal_instrument_selections item
             where item.tenant_id = target_tenant and item.selection_id = target_id) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_SELECTION_ALREADY_REGISTERED';
  end if;
  content_sha256 := private.governance_jsonb_sha256(target_selection);
  insert into private.legal_instrument_selections(
    tenant_id, selection_id, revision, source_id, source_version, artifact_sha256,
    page_from, page_to, start_anchor, end_anchor, selection_sha256,
    state, superseded_by, supersede_reason, synthetic, record_json, content_sha256, recorded_at
  ) values (
    target_tenant, target_id, 1, target_source_id, target_source_version, target_artifact,
    target_page_from, target_page_to, target_start, target_end, target_selection_sha256,
    'draft', null, null, target_synthetic, target_selection, content_sha256, target_recorded_at
  );
  result := private.governance_finish_mutation(
    target_tenant, 'legal_instrument_selection_register', target_idempotency_key, target_command_sha256,
    'instrument_selection', target_id, '1', 1, 'draft',
    target_selection, content_sha256, 'legal_instrument_selection_registered',
    'system_import', target_recorded_at, false
  );
  return next result;
end;
$$;

alter function private.governance_legal_instrument_selection_register(text, jsonb, text, text, timestamptz)
  owner to tivdoc_governance_owner;
revoke all on function private.governance_legal_instrument_selection_register(text, jsonb, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.governance_legal_instrument_selection_register(text, jsonb, text, text, timestamptz)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

-- Supersedes a draft selection by appending a revision that names its
-- replacement and the reason. The original row is never touched.
create function private.governance_legal_instrument_selection_supersede(
  target_tenant text, target_selection_id text, target_superseded_by text, target_reason text,
  target_idempotency_key text, target_command_sha256 text, target_recorded_at timestamptz
) returns setof private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  replay jsonb;
  result private.governance_mutation_receipt;
  current private.legal_instrument_selections%rowtype;
  next_revision bigint;
  content jsonb;
  content_sha256 text;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  replay := private.governance_idempotency_lookup(
    target_tenant, 'legal_instrument_selection_supersede', target_idempotency_key, target_command_sha256
  );
  if replay is not null then
    result := pg_catalog.jsonb_populate_record(null::private.governance_mutation_receipt, replay);
    result.idempotent_replay := true;
    return next result;
    return;
  end if;
  if target_superseded_by !~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{2,199}$'
     or target_superseded_by = target_selection_id
     or target_reason is null or char_length(target_reason) not between 20 and 2000 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_SELECTION_SUPERSESSION_INVALID';
  end if;
  select * into current from private.legal_instrument_selections item
  where item.tenant_id = target_tenant and item.selection_id = target_selection_id
  order by item.revision desc limit 1;
  if current.selection_id is null then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_SELECTION_UNKNOWN';
  end if;
  if current.state is distinct from 'draft' then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_SELECTION_ALREADY_SUPERSEDED';
  end if;
  if not exists (select 1 from private.legal_instrument_selections item
                 where item.tenant_id = target_tenant and item.selection_id = target_superseded_by) then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_SELECTION_REPLACEMENT_UNKNOWN';
  end if;
  next_revision := current.revision + 1;
  content := current.record_json || pg_catalog.jsonb_build_object(
    'state', 'superseded', 'superseded_by', target_superseded_by, 'supersede_reason', target_reason
  );
  content_sha256 := private.governance_jsonb_sha256(content);
  insert into private.legal_instrument_selections(
    tenant_id, selection_id, revision, source_id, source_version, artifact_sha256,
    page_from, page_to, start_anchor, end_anchor, selection_sha256,
    state, superseded_by, supersede_reason, synthetic, record_json, content_sha256, recorded_at
  ) values (
    target_tenant, current.selection_id, next_revision, current.source_id, current.source_version, current.artifact_sha256,
    current.page_from, current.page_to, current.start_anchor, current.end_anchor, current.selection_sha256,
    'superseded', target_superseded_by, target_reason, current.synthetic, content, content_sha256, target_recorded_at
  );
  result := private.governance_finish_mutation(
    target_tenant, 'legal_instrument_selection_supersede', target_idempotency_key, target_command_sha256,
    'instrument_selection', current.selection_id, '1', next_revision, 'superseded',
    content, content_sha256, 'legal_instrument_selection_superseded',
    'system_import', target_recorded_at, false
  );
  return next result;
end;
$$;

alter function private.governance_legal_instrument_selection_supersede(text, text, text, text, text, text, timestamptz)
  owner to tivdoc_governance_owner;
revoke all on function private.governance_legal_instrument_selection_supersede(text, text, text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function private.governance_legal_instrument_selection_supersede(text, text, text, text, text, text, timestamptz)
  to tivdoc_operations_runtime, tivdoc_worker_runtime;

-- The latest revision of every selection on the tenant.
create function private.legal_instrument_selection_read(target_tenant text)
returns table (
  selection_id text, revision bigint, source_id text, source_version text, artifact_sha256 text,
  page_from integer, page_to integer, start_anchor text, end_anchor text, selection_sha256 text,
  state text, superseded_by text, supersede_reason text, synthetic boolean,
  content_sha256 text, recorded_at timestamptz
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  return query
    select distinct on (s.selection_id)
      s.selection_id, s.revision, s.source_id, s.source_version, s.artifact_sha256,
      s.page_from, s.page_to, s.start_anchor, s.end_anchor, s.selection_sha256,
      s.state, s.superseded_by, s.supersede_reason, s.synthetic,
      s.content_sha256, s.recorded_at
    from private.legal_instrument_selections s
    where s.tenant_id = target_tenant
    order by s.selection_id, s.revision desc;
end;
$$;

alter function private.legal_instrument_selection_read(text) owner to tivdoc_governance_owner;
revoke all on function private.legal_instrument_selection_read(text) from public, anon, authenticated, service_role;
grant execute on function private.legal_instrument_selection_read(text) to tivdoc_operations_runtime, tivdoc_worker_runtime;

comment on table private.legal_instrument_selections is
  'L5-5 / D4. Draft, supersedable instrument boundaries over multi-instrument artifacts. A parameter cited into a selected span carries selection_sha256 in its binding, so attesting the parameter attests the boundary.';
