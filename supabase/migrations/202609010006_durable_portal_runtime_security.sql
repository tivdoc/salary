-- Tivdoc V0.10.2 durable customer-portal runtime authorization.
-- The web principal remains a non-owner NOBYPASSRLS login. This migration
-- grants only the statements used by the durable portal adapter and adds a
-- restrictive active-owner policy on every case-scoped row it can reach.

create function private.runtime_web_owns_case(
  target_tenant text,
  target_case text
) returns boolean
language sql stable security definer set search_path = '' as $$
  select pg_catalog.coalesce(session_user = 'tivdoc_web_runtime'
    and target_tenant = private.runtime_verified_tenant()
    and exists (
      select 1
      from public.product_case_owners owner
      where owner.tenant_id = target_tenant
        and owner.canonical_case_id = target_case
        and owner.subject = private.runtime_verified_actor()
        and owner.status = 'active'
        and owner.revoked_at is null
    ), false)
$$;

create function private.runtime_web_owns_internal_case(
  target_tenant text,
  target_case uuid
) returns boolean
language sql stable security invoker set search_path = '' as $$
  select exists (
    select 1
    from public.engine_case_identity identity
    where identity.tenant_id = target_tenant
      and identity.internal_case_id = target_case
      and private.runtime_web_owns_case(identity.tenant_id, identity.canonical_case_id)
  )
$$;

create function private.runtime_web_verified_actor()
returns text
language sql stable security definer set search_path = '' as $$
  select case
    when session_user = 'tivdoc_web_runtime' then private.runtime_verified_actor()
    else null
  end
$$;

alter function private.runtime_web_owns_case(text,text) owner to tivdoc_governance_owner;
alter function private.runtime_web_owns_internal_case(text,uuid) owner to tivdoc_governance_owner;
alter function private.runtime_web_verified_actor() owner to tivdoc_governance_owner;
revoke all on function private.runtime_web_owns_case(text,text)
  from public, anon, authenticated, service_role, tivdoc_operations_runtime, tivdoc_worker_runtime;
revoke all on function private.runtime_web_owns_internal_case(text,uuid)
  from public, anon, authenticated, service_role, tivdoc_operations_runtime, tivdoc_worker_runtime;
revoke all on function private.runtime_web_verified_actor()
  from public, anon, authenticated, service_role, tivdoc_operations_runtime, tivdoc_worker_runtime;
grant execute on function private.runtime_web_owns_case(text,text) to tivdoc_web_runtime;
grant execute on function private.runtime_web_owns_internal_case(text,uuid) to tivdoc_web_runtime;
grant execute on function private.runtime_web_verified_actor() to tivdoc_web_runtime;

-- The lookup may be used by operations for an owner in its verified tenant.
-- Web requests may resolve only their own authoritative active binding.
create or replace function private.product_owner_lookup(
  target_tenant text,
  target_case text,
  target_subject text
) returns setof public.product_case_owners
language sql stable security definer set search_path = '' as $$
  select owner.*
  from public.product_case_owners owner
  where owner.tenant_id = target_tenant
    and owner.canonical_case_id = target_case
    and owner.subject = target_subject
    and owner.status = 'active'
    and owner.revoked_at is null
    and target_tenant = private.runtime_verified_tenant()
    and (session_user <> 'tivdoc_web_runtime'
      or target_subject = private.runtime_verified_actor())
$$;

-- Web execution of the canonical UUID resolver is read-only: an authenticated
-- owner can resolve only an already-existing case identity. Non-web callers
-- retain the original behavior under their independently authorized ACL/RLS.
create or replace function private.resolve_engine_case_id(
  target_tenant text,
  target_canonical_case_id text
) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare
  resolved uuid;
begin
  if target_tenant is null or target_tenant = ''
    or target_canonical_case_id is null or target_canonical_case_id = '' then
    raise exception using errcode = '22023', message = 'CANONICAL_CASE_OWNERSHIP_REQUIRED';
  end if;
  if session_user = 'tivdoc_web_runtime' then
    if private.runtime_verified_tenant() is null
      or target_tenant is distinct from private.runtime_verified_tenant()
      or private.runtime_web_owns_case(target_tenant, target_canonical_case_id) is not true then
      raise exception using errcode = '42501', message = 'PORTAL_CASE_OWNERSHIP_REQUIRED';
    end if;
    select identity.internal_case_id into strict resolved
    from public.engine_case_identity identity
    where identity.tenant_id = target_tenant
      and identity.canonical_case_id = target_canonical_case_id;
    return resolved;
  end if;
  insert into public.engine_case_identity (tenant_id, canonical_case_id)
  values (target_tenant, target_canonical_case_id)
  on conflict (tenant_id, canonical_case_id) do nothing;
  select identity.internal_case_id into strict resolved
  from public.engine_case_identity identity
  where identity.tenant_id = target_tenant
    and identity.canonical_case_id = target_canonical_case_id;
  return resolved;
end;
$$;

-- Web may create only the initial owner-scoped request. A web session cannot
-- acknowledge, complete, legal-hold, or revoke grants; those remain operations
-- responsibilities. Existing atomic/idempotent semantics are preserved.
create or replace function private.product_privacy_append(
  target_request_id text,
  target_tenant text,
  target_case text,
  target_revision bigint,
  target_request_kind text,
  target_state text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_legal_hold_conflict boolean,
  target_grant_revocation_sha256 text,
  target_created_at timestamptz
) returns setof public.product_privacy_request_versions
language plpgsql security definer set search_path = '' as $$
declare
  existing public.product_privacy_request_versions%rowtype;
  prior public.product_privacy_request_versions%rowtype;
begin
  if private.runtime_verified_tenant() is null
    or target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'PRODUCT_TENANT_CONTEXT_MISMATCH';
  end if;
  if session_user = 'tivdoc_web_runtime' and (
    private.runtime_web_owns_case(target_tenant, target_case) is not true
    or target_revision is distinct from 1
    or target_request_kind is null
    or target_request_kind not in ('export', 'correction', 'deletion')
    or target_state is distinct from 'requested'
    or target_legal_hold_conflict is distinct from false
    or target_grant_revocation_sha256 is not null
  ) then
    raise exception using errcode = '42501', message = 'PORTAL_PRIVACY_REQUEST_FORBIDDEN';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_tenant || ':' || target_request_id, 0)
  );
  select * into existing
  from public.product_privacy_request_versions item
  where item.tenant_id = target_tenant
    and item.idempotency_key = target_idempotency_key;
  if existing.request_id is not null then
    if existing.tenant_id <> target_tenant
      or existing.request_id <> target_request_id
      or existing.revision <> target_revision
      or existing.canonical_case_id <> target_case
      or existing.request_kind <> target_request_kind
      or existing.state <> target_state
      or existing.command_sha256 <> target_command_sha256
      or existing.legal_hold_conflict <> target_legal_hold_conflict
      or existing.grant_revocation_receipt_sha256 is distinct from target_grant_revocation_sha256
      or existing.created_at <> target_created_at then
      raise exception using errcode = 'P0001', message = 'PRODUCT_PRIVACY_IDEMPOTENCY_MISMATCH';
    end if;
    return next existing;
    return;
  end if;
  select * into prior
  from public.product_privacy_request_versions item
  where item.tenant_id = target_tenant
    and item.request_id = target_request_id
  order by item.revision desc
  limit 1
  for update;
  if prior.request_id is null then
    if target_revision <> 1 or target_state not in ('requested', 'restricted_by_legal_hold') then
      raise exception using errcode = 'P0001', message = 'PRODUCT_PRIVACY_REVISION_CONFLICT';
    end if;
  elsif target_revision <> prior.revision + 1
    or target_case <> prior.canonical_case_id
    or target_request_kind <> prior.request_kind
    or not (
      (prior.state = 'requested'
        and target_state in ('acknowledged', 'restricted_by_legal_hold', 'completed_by_authorized_operations'))
      or (prior.state = 'acknowledged'
        and target_state in ('restricted_by_legal_hold', 'completed_by_authorized_operations'))
      or (prior.state = 'restricted_by_legal_hold'
        and target_state in ('acknowledged', 'completed_by_authorized_operations'))
    ) then
    raise exception using errcode = 'P0001', message = 'PRODUCT_PRIVACY_REVISION_CONFLICT';
  end if;
  insert into public.product_privacy_request_versions (
    request_id, revision, tenant_id, canonical_case_id, request_kind, state,
    idempotency_key, command_sha256, legal_hold_conflict,
    grant_revocation_receipt_sha256, created_at
  ) values (
    target_request_id, target_revision, target_tenant, target_case, target_request_kind, target_state,
    target_idempotency_key, target_command_sha256, target_legal_hold_conflict,
    target_grant_revocation_sha256, target_created_at
  ) returning * into existing;
  return next existing;
end;
$$;

-- Exact report storage operations retain their V0.10.1 canonical hash and
-- approval checks, but replace caller-controlled tenant GUC checks with the
-- authoritative durable-session verifier. Web reads add active ownership.
create or replace function private.product_private_report_object_bind(
  target_tenant text,
  target_case text,
  target_report_id text,
  target_report_revision bigint,
  target_report_sha256 text,
  target_object_version_id text,
  target_provider_locator text,
  target_byte_length bigint,
  target_artifact_sha256 text,
  target_created_at timestamptz
) returns setof public.product_private_report_objects
language plpgsql security definer set search_path = '' as $$
declare
  existing public.product_private_report_objects%rowtype;
begin
  if private.runtime_verified_tenant() is null
    or target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'PRODUCT_TENANT_CONTEXT_MISMATCH';
  end if;
  if not exists (
    select 1 from public.engine_report_versions report
    where report.tenant_id = target_tenant
      and report.canonical_case_id = target_case
      and report.report_id = target_report_id
      and report.revision = target_report_revision
      and report.report_sha256 = target_report_sha256
      and report.pdf_sha256 = target_artifact_sha256
  ) then
    raise exception using errcode = 'P0001', message = 'PRODUCT_REPORT_CANONICAL_BINDING_MISMATCH';
  end if;
  insert into public.product_private_report_objects (
    tenant_id, canonical_case_id, report_id, report_revision, report_sha256,
    object_version_id, provider_locator, byte_length, artifact_sha256,
    state, grant_epoch, created_at
  ) values (
    target_tenant, target_case, target_report_id, target_report_revision, target_report_sha256,
    target_object_version_id, target_provider_locator, target_byte_length, target_artifact_sha256,
    'staged', 0, target_created_at
  ) on conflict (tenant_id, canonical_case_id, report_id, report_revision) do nothing;
  select * into strict existing from public.product_private_report_objects object
  where object.tenant_id = target_tenant and object.canonical_case_id = target_case
    and object.report_id = target_report_id and object.report_revision = target_report_revision;
  if existing.report_sha256 <> target_report_sha256
    or existing.object_version_id <> target_object_version_id
    or existing.provider_locator <> target_provider_locator
    or existing.byte_length <> target_byte_length
    or existing.artifact_sha256 <> target_artifact_sha256
    or existing.state <> 'staged' or existing.grant_epoch <> 0
    or existing.created_at <> target_created_at then
    raise exception using errcode = 'P0001', message = 'PRODUCT_REPORT_OBJECT_BINDING_MISMATCH';
  end if;
  return next existing;
end;
$$;

create or replace function private.product_report_object_approve(
  target_tenant text,
  target_case text,
  target_object_version_id text,
  expected_grant_epoch bigint
) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if private.runtime_verified_tenant() is null
    or target_tenant is distinct from private.runtime_verified_tenant() then return false; end if;
  update public.product_private_report_objects object
  set state = 'approved', grant_epoch = object.grant_epoch + 1
  where object.tenant_id = target_tenant and object.canonical_case_id = target_case
    and object.object_version_id = target_object_version_id and object.state = 'staged'
    and object.grant_epoch = expected_grant_epoch
    and exists (
      select 1
      from public.engine_report_versions report
      join public.engine_review_task_versions approval
        on approval.tenant_id = report.tenant_id
       and approval.case_id = report.case_id
       and approval.report_id = report.report_id
       and approval.report_revision = report.revision
       and approval.report_sha256 = report.report_sha256
      where report.tenant_id = object.tenant_id
        and report.canonical_case_id = object.canonical_case_id
        and report.report_id = object.report_id
        and report.revision = object.report_revision
        and report.report_sha256 = object.report_sha256
        and report.pdf_sha256 = object.artifact_sha256
        and report.review_eligible = true
        and approval.canonical_case_id = object.canonical_case_id
        and approval.task_kind = 'report_approval'
        and approval.input_sha256 = report.report_sha256
        and approval.output_sha256 = report.report_sha256
        and approval.release_state = 'approved'
        and approval.invalidated_at is null
        and approval.decision_payload ->> 'decision' = 'approved'
        and not exists (
          select 1 from public.engine_review_task_versions newer
          where newer.tenant_id = approval.tenant_id
            and newer.task_id = approval.task_id
            and newer.revision > approval.revision
        )
    );
  if found then return true; end if;
  return exists (
    select 1
    from public.product_private_report_objects object
    join public.engine_report_versions report
      on report.tenant_id = object.tenant_id
     and report.canonical_case_id = object.canonical_case_id
     and report.report_id = object.report_id
     and report.revision = object.report_revision
     and report.report_sha256 = object.report_sha256
     and report.pdf_sha256 = object.artifact_sha256
    join public.engine_review_task_versions approval
      on approval.tenant_id = report.tenant_id
     and approval.case_id = report.case_id
     and approval.report_id = report.report_id
     and approval.report_revision = report.revision
     and approval.report_sha256 = report.report_sha256
    where object.tenant_id = target_tenant and object.canonical_case_id = target_case
      and object.object_version_id = target_object_version_id and object.state = 'approved'
      and object.grant_epoch = expected_grant_epoch + 1
      and report.review_eligible = true
      and approval.canonical_case_id = object.canonical_case_id
      and approval.task_kind = 'report_approval'
      and approval.input_sha256 = report.report_sha256
      and approval.output_sha256 = report.report_sha256
      and approval.release_state = 'approved'
      and approval.invalidated_at is null
      and approval.decision_payload ->> 'decision' = 'approved'
      and not exists (
        select 1 from public.engine_review_task_versions newer
        where newer.tenant_id = approval.tenant_id
          and newer.task_id = approval.task_id
          and newer.revision > approval.revision
      )
  );
end;
$$;

create or replace function private.product_report_object_approved_read(
  target_tenant text,
  target_case text,
  target_report_id text,
  target_report_revision bigint,
  target_report_sha256 text,
  target_artifact_sha256 text
) returns table (
  object_version_id text,
  provider_locator text,
  byte_length bigint,
  artifact_sha256 text,
  grant_epoch bigint
)
language sql stable security definer set search_path = '' as $$
  select object.object_version_id, object.provider_locator, object.byte_length,
         object.artifact_sha256, object.grant_epoch
  from public.product_private_report_objects object
  join public.engine_report_versions report
    on report.tenant_id = object.tenant_id
   and report.canonical_case_id = object.canonical_case_id
   and report.report_id = object.report_id
   and report.revision = object.report_revision
   and report.report_sha256 = object.report_sha256
   and report.pdf_sha256 = object.artifact_sha256
  join public.engine_review_task_versions approval
    on approval.tenant_id = report.tenant_id
   and approval.case_id = report.case_id
   and approval.report_id = report.report_id
   and approval.report_revision = report.revision
   and approval.report_sha256 = report.report_sha256
  where object.tenant_id = target_tenant and object.canonical_case_id = target_case
    and object.report_id = target_report_id and object.report_revision = target_report_revision
    and object.report_sha256 = target_report_sha256 and object.artifact_sha256 = target_artifact_sha256
    and object.state = 'approved' and object.revoked_at is null
    and report.review_eligible = true
    and approval.canonical_case_id = object.canonical_case_id
    and approval.task_kind = 'report_approval'
    and approval.input_sha256 = report.report_sha256
    and approval.output_sha256 = report.report_sha256
    and approval.release_state = 'approved'
    and approval.invalidated_at is null
    and approval.decision_payload ->> 'decision' = 'approved'
    and not exists (
      select 1 from public.engine_review_task_versions newer
      where newer.tenant_id = approval.tenant_id
        and newer.task_id = approval.task_id
        and newer.revision > approval.revision
    )
    and target_tenant = private.runtime_verified_tenant()
    and (session_user <> 'tivdoc_web_runtime'
      or private.runtime_web_owns_case(target_tenant, target_case))
$$;

alter function private.product_owner_lookup(text,text,text) owner to tivdoc_governance_owner;
alter function private.product_privacy_append(text,text,text,bigint,text,text,text,text,boolean,text,timestamptz)
  owner to tivdoc_governance_owner;
alter function private.product_private_report_object_bind(text,text,text,bigint,text,text,text,bigint,text,timestamptz)
  owner to tivdoc_governance_owner;
alter function private.product_report_object_approve(text,text,text,bigint) owner to tivdoc_governance_owner;
alter function private.product_report_object_approved_read(text,text,text,bigint,text,text)
  owner to tivdoc_governance_owner;
revoke all on function private.resolve_engine_case_id(text,text)
  from public, anon, authenticated, tivdoc_operations_runtime, tivdoc_worker_runtime;
grant execute on function private.resolve_engine_case_id(text,text) to tivdoc_web_runtime;
grant execute on function private.canonical_text_uuid(text,text) to tivdoc_web_runtime;
-- Approval finalization binds the immutable object from its verified
-- operations-role transaction; workers may stage bytes but cannot approve.
grant execute on function private.product_private_report_object_bind(
  text,text,text,bigint,text,text,text,bigint,text,timestamptz
) to tivdoc_operations_runtime;

-- Restrictive policies compose with the verified-tenant permissive policy
-- installed by 202609010005. They constrain same-tenant access further to the
-- active owner actor; the database never trusts a caller-supplied actor GUC.
drop policy if exists tivdoc_portal_web_owned_case on public.engine_case_identity;
create policy tivdoc_portal_web_owned_case on public.engine_case_identity
  as restrictive for select to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id));

drop policy if exists tivdoc_portal_web_owned_case on public.engine_case_state;
create policy tivdoc_portal_web_owned_case on public.engine_case_state
  as restrictive for all to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id))
  with check (private.runtime_web_owns_case(tenant_id, canonical_case_id));

drop policy if exists tivdoc_portal_web_owned_case on public.engine_case_lifecycle_revisions;
create policy tivdoc_portal_web_owned_case on public.engine_case_lifecycle_revisions
  as restrictive for all to tivdoc_web_runtime
  using (private.runtime_web_owns_internal_case(tenant_id, case_id))
  with check (
    private.runtime_web_owns_internal_case(tenant_id, case_id)
    and event_kind in ('portal.clarification.answered', 'portal.privacy.requested')
    and state_before is not distinct from state_after
  );

drop policy if exists tivdoc_portal_web_owned_case on public.documents;
create policy tivdoc_portal_web_owned_case on public.documents
  as restrictive for select to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id));

drop policy if exists tivdoc_portal_web_owned_case on public.case_conversations;
create policy tivdoc_portal_web_owned_case on public.case_conversations
  as restrictive for select to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id));

drop policy if exists tivdoc_portal_web_owned_case on public.case_messages;
create policy tivdoc_portal_web_owned_case on public.case_messages
  as restrictive for all to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id))
  with check (
    private.runtime_web_owns_case(tenant_id, canonical_case_id)
    and role = 'customer'
    and agent is null
    and model_provider is null
    and model_identifier is null
    and prompt_version is null
  );

drop policy if exists tivdoc_portal_web_owned_case on public.case_confirmations;
create policy tivdoc_portal_web_owned_case on public.case_confirmations
  as restrictive for all to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id))
  with check (
    private.runtime_web_owns_case(tenant_id, canonical_case_id)
    and status = 'confirmed'
    and answered_at is not null
    and canonical_source_message_id is not null
  );

drop policy if exists tivdoc_portal_web_owned_case on public.analysis_runs;
create policy tivdoc_portal_web_owned_case on public.analysis_runs
  as restrictive for select to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id));

drop policy if exists tivdoc_portal_web_owned_case on public.engine_idempotency_records;
create policy tivdoc_portal_web_owned_case on public.engine_idempotency_records
  as restrictive for all to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id))
  with check (
    private.runtime_web_owns_case(tenant_id, canonical_case_id)
    and scope in ('portal_clarification_answer', 'portal_privacy_request')
  );

drop policy if exists tivdoc_portal_web_owned_case on public.engine_platform_audit_events;
create policy tivdoc_portal_web_owned_case on public.engine_platform_audit_events
  as restrictive for all to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id))
  with check (
    private.runtime_web_owns_case(tenant_id, canonical_case_id)
    and actor_id = private.runtime_web_verified_actor()
    and action in ('PORTAL_CLARIFICATION_ANSWERED', 'PORTAL_PRIVACY_REQUESTED',
      'RUNTIME_PRODUCT_DOWNLOAD_GRANT_ISSUED', 'RUNTIME_PRODUCT_AUTHENTICATED_DOWNLOAD')
  );

drop policy if exists tivdoc_portal_web_owned_case on public.product_privacy_request_versions;
create policy tivdoc_portal_web_owned_case on public.product_privacy_request_versions
  as restrictive for select to tivdoc_web_runtime
  using (private.runtime_web_owns_case(tenant_id, canonical_case_id));

drop policy if exists tivdoc_portal_web_owned_case on public.product_private_report_objects;
create policy tivdoc_portal_web_owned_case on public.product_private_report_objects
  as restrictive for select to tivdoc_web_runtime
  using (
    private.runtime_web_owns_case(tenant_id, canonical_case_id)
    and state = 'approved'
    and revoked_at is null
  );

-- Revoke any inherited table ACL on the exact portal surface, then grant only
-- read access plus the columns used by the canonical repositories.
revoke all on table
  public.engine_case_identity, public.engine_case_state,
  public.engine_case_lifecycle_revisions, public.documents,
  public.case_conversations, public.case_messages, public.case_confirmations,
  public.analysis_runs, public.engine_idempotency_records,
  public.engine_platform_audit_events, public.engine_report_versions,
  public.engine_review_task_versions, public.product_case_owners,
  public.product_privacy_request_versions, public.product_private_report_objects
from tivdoc_web_runtime;

grant select (internal_case_id, tenant_id, canonical_case_id)
  on public.engine_case_identity to tivdoc_web_runtime;
grant select (case_id, tenant_id, canonical_case_id, revision, lifecycle_state, state_sha256, updated_at)
  on public.engine_case_state to tivdoc_web_runtime;
grant select (
  case_id, tenant_id, revision, state_before, state_after, event_kind,
  command_sha256, event_sha256, previous_sha256, occurred_at
) on public.engine_case_lifecycle_revisions to tivdoc_web_runtime;
grant select (tenant_id, canonical_case_id, canonical_document_id, document_type)
  on public.documents to tivdoc_web_runtime;
grant select (
  tenant_id, canonical_case_id, canonical_analysis_run_id,
  canonical_conversation_id, created_at
) on public.case_conversations to tivdoc_web_runtime;
grant select (
  id, case_id, conversation_id, analysis_run_id, role, agent, question_id,
  question_version, selected_option_ids, free_text_answer, content,
  model_provider, model_identifier, prompt_version, idempotency_key, created_at,
  tenant_id, canonical_case_id, canonical_message_id,
  canonical_conversation_id, canonical_analysis_run_id
) on public.case_messages to tivdoc_web_runtime;
grant select (
  id, case_id, source_analysis_run_id, target_fact_path, question_id,
  question_version, proposed_value, answer, status, source_message_id,
  idempotency_key, created_at, answered_at, tenant_id,
  canonical_confirmation_id, canonical_case_id, canonical_analysis_run_id,
  canonical_source_message_id
) on public.case_confirmations to tivdoc_web_runtime;
grant select (id, case_id, tenant_id, canonical_case_id, canonical_analysis_run_id)
  on public.analysis_runs to tivdoc_web_runtime;
grant select (
  tenant_id, case_id, canonical_case_id, scope, idempotency_key,
  command_sha256, result_sha256, result_payload, state, created_at, committed_at
) on public.engine_idempotency_records to tivdoc_web_runtime;
grant select (
  sequence, tenant_id, canonical_case_id, case_sequence, actor_id, action,
  resource_id, resource_revision, resource_sha256, reason_code,
  previous_sha256, event_sha256, occurred_at
) on public.engine_platform_audit_events to tivdoc_web_runtime;
grant select (
  request_id, revision, tenant_id, canonical_case_id, request_kind, state,
  idempotency_key, command_sha256, created_at
) on public.product_privacy_request_versions to tivdoc_web_runtime;
grant select (
  tenant_id, canonical_case_id, report_id, report_revision, report_sha256,
  object_version_id, state, grant_epoch, revoked_at
) on public.product_private_report_objects to tivdoc_web_runtime;

grant insert (
  id, case_id, conversation_id, analysis_run_id, role, agent, question_id,
  question_version, selected_option_ids, free_text_answer, content,
  model_provider, model_identifier, prompt_version, idempotency_key, created_at,
  tenant_id, canonical_case_id, canonical_message_id,
  canonical_conversation_id, canonical_analysis_run_id
) on public.case_messages to tivdoc_web_runtime;
grant update (id) on public.case_messages to tivdoc_web_runtime;

grant insert (
  id, case_id, source_analysis_run_id, target_fact_path, question_id,
  question_version, proposed_value, answer, status, source_message_id,
  idempotency_key, created_at, answered_at, tenant_id,
  canonical_confirmation_id, canonical_case_id, canonical_analysis_run_id,
  canonical_source_message_id
) on public.case_confirmations to tivdoc_web_runtime;

grant insert (
  case_id, tenant_id, revision, state_before, state_after, event_kind,
  command_sha256, event_sha256, previous_sha256, occurred_at
) on public.engine_case_lifecycle_revisions to tivdoc_web_runtime;

grant update (revision, lifecycle_state, state_sha256, updated_at)
  on public.engine_case_state to tivdoc_web_runtime;

grant insert (
  tenant_id, canonical_case_id, scope, idempotency_key, command_sha256,
  state, created_at
) on public.engine_idempotency_records to tivdoc_web_runtime;
grant update (state, result_sha256, result_payload, committed_at)
  on public.engine_idempotency_records to tivdoc_web_runtime;

grant insert (
  tenant_id, canonical_case_id, case_sequence, actor_id, action, resource_id,
  resource_revision, resource_sha256, reason_code, previous_sha256,
  event_sha256, occurred_at
) on public.engine_platform_audit_events to tivdoc_web_runtime;
-- Required only for SELECT ... FOR UPDATE when locking the audit-chain tail.
grant update (sequence) on public.engine_platform_audit_events to tivdoc_web_runtime;
revoke all on sequence public.engine_platform_audit_events_sequence_seq from tivdoc_web_runtime;
grant usage on sequence public.engine_platform_audit_events_sequence_seq to tivdoc_web_runtime;

-- Repository idempotency uses a no-op conflict update on message UUID. Permit
-- that exact no-op while rejecting every material web update.
create function private.runtime_web_noop_update_guard()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if session_user = 'tivdoc_web_runtime' and new is distinct from old then
    raise exception using errcode = '42501', message = 'PORTAL_ROW_UPDATE_FORBIDDEN';
  end if;
  return new;
end;
$$;

create function private.runtime_web_case_state_guard()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if session_user = 'tivdoc_web_runtime' and (
    new.tenant_id is distinct from old.tenant_id
    or new.case_id is distinct from old.case_id
    or new.canonical_case_id is distinct from old.canonical_case_id
    or new.revision <> old.revision + 1
    or new.lifecycle_state is distinct from old.lifecycle_state
    or new.state_sha256 is not distinct from old.state_sha256
    or new.updated_at < old.updated_at
  ) then
    raise exception using errcode = '42501', message = 'PORTAL_CASE_STATE_UPDATE_FORBIDDEN';
  end if;
  return new;
end;
$$;

create function private.runtime_web_case_state_commit_guard()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  if session_user = 'tivdoc_web_runtime' and not exists (
    select 1
    from public.engine_case_lifecycle_revisions history
    where history.tenant_id = new.tenant_id
      and history.case_id = new.case_id
      and history.revision = new.revision
      and history.state_before = old.lifecycle_state
      and history.state_after = new.lifecycle_state
      and history.event_kind in ('portal.clarification.answered', 'portal.privacy.requested')
      and history.occurred_at = new.updated_at
  ) then
    raise exception using errcode = '42501', message = 'PORTAL_CASE_STATE_LIFECYCLE_REQUIRED';
  end if;
  return new;
end;
$$;

alter function private.runtime_web_noop_update_guard() owner to tivdoc_governance_owner;
alter function private.runtime_web_case_state_guard() owner to tivdoc_governance_owner;
alter function private.runtime_web_case_state_commit_guard() owner to tivdoc_governance_owner;
revoke all on function private.runtime_web_noop_update_guard()
  from public, anon, authenticated, service_role, tivdoc_operations_runtime,
       tivdoc_worker_runtime, tivdoc_web_runtime;
revoke all on function private.runtime_web_case_state_guard()
  from public, anon, authenticated, service_role, tivdoc_operations_runtime,
       tivdoc_worker_runtime, tivdoc_web_runtime;
revoke all on function private.runtime_web_case_state_commit_guard()
  from public, anon, authenticated, service_role, tivdoc_operations_runtime,
       tivdoc_worker_runtime, tivdoc_web_runtime;

drop trigger if exists portal_web_message_noop_update on public.case_messages;
create trigger portal_web_message_noop_update
before update on public.case_messages
for each row execute function private.runtime_web_noop_update_guard();

drop trigger if exists portal_web_case_state_update on public.engine_case_state;
create trigger portal_web_case_state_update
before update on public.engine_case_state
for each row execute function private.runtime_web_case_state_guard();

drop trigger if exists portal_web_case_state_commit on public.engine_case_state;
create constraint trigger portal_web_case_state_commit
after update on public.engine_case_state
deferrable initially deferred
for each row execute function private.runtime_web_case_state_commit_guard();

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'durable_portal_runtime_security',
  'tivdoc-durable-portal-runtime-security-v0.10.2',
  '202609010006_durable_portal_runtime_security'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on function private.runtime_web_owns_case(text,text) is
  'Fail-closed active-owner proof derived from the transaction-local durable session; never from caller-supplied tenant or actor text.';
