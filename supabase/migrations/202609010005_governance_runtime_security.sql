-- Tivdoc V0.10.2 forward-only governance runtime security closure.
--
-- The historical V0.10.1 migration is immutable. This migration removes the
-- broad service_role execution path, installs transaction-local context derived
-- from the authoritative durable identity session, and re-owns the governance
-- surface with a dedicated NOLOGIN/NOBYPASSRLS principal.

do $roles$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tivdoc_governance_owner') then
    execute 'create role tivdoc_governance_owner nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tivdoc_operations_runtime') then
    execute 'create role tivdoc_operations_runtime nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tivdoc_worker_runtime') then
    execute 'create role tivdoc_worker_runtime nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls';
  end if;
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'tivdoc_web_runtime') then
    execute 'create role tivdoc_web_runtime nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls';
  end if;
end;
$roles$;

alter role tivdoc_governance_owner nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
alter role tivdoc_operations_runtime nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
alter role tivdoc_worker_runtime nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;
alter role tivdoc_web_runtime nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls;

revoke tivdoc_governance_owner from anon, authenticated, service_role, tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime;
revoke service_role from tivdoc_governance_owner, tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime;

create function private.runtime_context_install(
  target_sid text,
  target_jti text,
  target_correlation_id text
) returns table (
  tenant_id text,
  actor_id text,
  runtime_role text,
  reviewer_organization_id text,
  session_rotation_counter bigint
)
language plpgsql volatile security definer set search_path = '' as $$
declare
  authoritative public.product_identity_sessions%rowtype;
  effective_role text;
begin
  if session_user = 'tivdoc_operations_runtime' then
    effective_role := 'operations';
  elsif session_user = 'tivdoc_worker_runtime' then
    effective_role := 'worker';
  elsif session_user = 'tivdoc_web_runtime' then
    effective_role := 'web';
  else
    raise exception using errcode = '42501', message = 'RUNTIME_CONTEXT_ROLE_FORBIDDEN';
  end if;
  if target_correlation_id !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{2,159}$' then
    raise exception using errcode = '22023', message = 'RUNTIME_CONTEXT_CORRELATION_INVALID';
  end if;
  select session.* into authoritative
  from public.product_identity_sessions session
  where session.sid = target_sid
    and session.current_jti = target_jti
    and session.revoked_at is null
    and session.valid_after <= pg_catalog.statement_timestamp()
    and session.expires_at > pg_catalog.statement_timestamp()
  for share;
  if authoritative.sid is null then
    raise exception using errcode = '42501', message = 'RUNTIME_CONTEXT_SESSION_NOT_CURRENT';
  end if;
  if effective_role = 'operations' and authoritative.reviewer_org_id is null then
    raise exception using errcode = '42501', message = 'RUNTIME_CONTEXT_REVIEWER_ORGANIZATION_REQUIRED';
  end if;
  perform pg_catalog.set_config('tivdoc.tenant_id', authoritative.tenant_id, true);
  perform pg_catalog.set_config('tivdoc.actor_id', authoritative.subject, true);
  perform pg_catalog.set_config('tivdoc.identity_sid', authoritative.sid, true);
  perform pg_catalog.set_config('tivdoc.identity_jti', authoritative.current_jti, true);
  perform pg_catalog.set_config('tivdoc.runtime_role', effective_role, true);
  perform pg_catalog.set_config('tivdoc.correlation_id', target_correlation_id, true);
  perform pg_catalog.set_config('tivdoc.reviewer_organization_id', coalesce(authoritative.reviewer_org_id, ''), true);
  return query select authoritative.tenant_id, authoritative.subject, effective_role,
    authoritative.reviewer_org_id, authoritative.rotation_counter;
end;
$$;

create function private.runtime_verified_tenant()
returns text
language sql stable security definer set search_path = '' as $$
  select session.tenant_id
  from public.product_identity_sessions session
  where session_user in ('tivdoc_operations_runtime', 'tivdoc_worker_runtime', 'tivdoc_web_runtime')
    and session.sid = nullif(pg_catalog.current_setting('tivdoc.identity_sid', true), '')
    and session.current_jti = nullif(pg_catalog.current_setting('tivdoc.identity_jti', true), '')
    and session.subject = nullif(pg_catalog.current_setting('tivdoc.actor_id', true), '')
    and session.tenant_id = nullif(pg_catalog.current_setting('tivdoc.tenant_id', true), '')
    and session.revoked_at is null
    and session.valid_after <= pg_catalog.statement_timestamp()
    and session.expires_at > pg_catalog.statement_timestamp()
    and nullif(pg_catalog.current_setting('tivdoc.correlation_id', true), '') is not null
    and pg_catalog.current_setting('tivdoc.runtime_role', true) = case
      when session_user = 'tivdoc_operations_runtime' then 'operations'
      when session_user = 'tivdoc_worker_runtime' then 'worker'
      else 'web'
    end
    and (session_user <> 'tivdoc_operations_runtime'
      or session.reviewer_org_id = nullif(pg_catalog.current_setting('tivdoc.reviewer_organization_id', true), ''))
$$;

create function private.runtime_verified_actor()
returns text
language sql stable security definer set search_path = '' as $$
  select session.subject
  from public.product_identity_sessions session
  where session.tenant_id = private.runtime_verified_tenant()
    and session.sid = nullif(pg_catalog.current_setting('tivdoc.identity_sid', true), '')
    and session.current_jti = nullif(pg_catalog.current_setting('tivdoc.identity_jti', true), '')
$$;

create function private.runtime_assert_actor(target_actor_id text)
returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  verified_actor text := private.runtime_verified_actor();
begin
  if verified_actor is null then
    raise exception using errcode = '42501', message = 'RUNTIME_CONTEXT_NOT_VERIFIED';
  end if;
  if target_actor_id = verified_actor then return; end if;
  if session_user = 'tivdoc_worker_runtime'
     and target_actor_id in ('system_import', 'governance.queue', 'ground.truth.system') then
    return;
  end if;
  raise exception using errcode = '42501', message = 'RUNTIME_ACTOR_IMPERSONATION_FORBIDDEN';
end;
$$;

create function private.runtime_assert_reviewer_role(target_reviewer_role text)
returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  verified_actor text := private.runtime_verified_actor();
  verified_tenant text := private.runtime_verified_tenant();
begin
  if session_user <> 'tivdoc_operations_runtime'
     or verified_actor is null or verified_tenant is null
     or not exists (
       select 1
       from private.governance_reviewers reviewer
       where reviewer.tenant_id = verified_tenant
         and reviewer.reviewer_id = verified_actor
         and reviewer.organization_id = nullif(pg_catalog.current_setting('tivdoc.reviewer_organization_id', true), '')
         and reviewer.valid_from <= pg_catalog.statement_timestamp()
         and reviewer.expires_at > pg_catalog.statement_timestamp()
         and exists (
           select 1 from pg_catalog.jsonb_array_elements_text(reviewer.record_json -> 'reviewer_roles') role(value)
           where role.value = target_reviewer_role
         )
     ) then
    raise exception using errcode = '42501', message = 'RUNTIME_REVIEWER_ROLE_FORBIDDEN';
  end if;
end;
$$;

create or replace function private.governance_finish_mutation(
  target_tenant text,
  target_scope text,
  target_idempotency_key text,
  target_command_sha256 text,
  target_workflow_kind text,
  target_aggregate_id text,
  target_aggregate_version text,
  target_revision bigint,
  target_state text,
  target_content_json jsonb,
  target_content_sha256 text,
  target_event_kind text,
  target_actor_id text,
  target_occurred_at timestamptz,
  target_store_snapshot boolean
) returns private.governance_mutation_receipt
language plpgsql security definer set search_path = '' as $$
declare
  audit_sha256 text;
  result private.governance_mutation_receipt;
  result_json jsonb;
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  perform private.runtime_assert_actor(target_actor_id);
  audit_sha256 := private.governance_append_audit(
    target_tenant, target_workflow_kind, target_aggregate_id, target_event_kind,
    target_content_sha256, target_actor_id, target_occurred_at
  );
  result := row(
    target_tenant, target_workflow_kind, target_aggregate_id, target_aggregate_version,
    target_revision, target_state, target_content_sha256, audit_sha256, false, false
  )::private.governance_mutation_receipt;
  result_json := pg_catalog.to_jsonb(result);
  perform private.governance_store_idempotency(
    target_tenant, target_scope, target_idempotency_key, target_command_sha256,
    result_json, target_occurred_at
  );
  if target_store_snapshot then
    insert into private.governance_aggregate_snapshots(
      tenant_id, mutation_scope, workflow_kind, aggregate_id, aggregate_version, revision, state,
      content_json, content_sha256, audit_event_sha256, activation_allowed, recorded_at
    ) values (
      target_tenant, target_scope, target_workflow_kind, target_aggregate_id, target_aggregate_version,
      target_revision, target_state, target_content_json, target_content_sha256,
      audit_sha256, false, target_occurred_at
    );
  end if;
  return result;
end;
$$;

create or replace function private.governance_work_claim(
  target_tenant text,
  target_workflow_kind text,
  target_work_kind text,
  target_claimant_id text,
  target_reviewer_role text,
  target_now timestamptz,
  target_lease_seconds integer
) returns setof private.governance_work_claim_receipt
language plpgsql security definer set search_path = '' as $$
declare
  candidate private.governance_work_items%rowtype;
  claimed private.governance_work_items%rowtype;
  database_now timestamptz := pg_catalog.statement_timestamp();
begin
  if target_tenant is distinct from private.runtime_verified_tenant() then
    raise exception using errcode = '42501', message = 'GOVERNANCE_VERIFIED_TENANT_MISMATCH';
  end if;
  perform private.runtime_assert_actor(target_claimant_id);
  perform private.runtime_assert_reviewer_role(target_reviewer_role);
  if target_lease_seconds < 30 or target_lease_seconds > 86400 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_WORK_LEASE_INVALID';
  end if;
  if target_now is null
     or pg_catalog.abs(extract(epoch from (target_now - database_now))) > 300 then
    raise exception using errcode = 'P0001', message = 'GOVERNANCE_WORK_CLOCK_INVALID';
  end if;
  select * into candidate from private.governance_work_items item
  where item.tenant_id = target_tenant and item.workflow_kind = target_workflow_kind
    and item.work_kind = target_work_kind and item.required_role = target_reviewer_role
    and (item.state in ('pending', 'released')
      or (item.state = 'claimed' and item.lease_expires_at <= database_now))
  order by item.created_at, item.work_item_id
  for update skip locked limit 1;
  if candidate.work_item_id is null then return; end if;
  update private.governance_work_items item
  set state = 'claimed', claimant_id = target_claimant_id,
      fencing_token = item.fencing_token + 1,
      lease_expires_at = database_now + pg_catalog.make_interval(secs => target_lease_seconds),
      updated_at = database_now
  where item.tenant_id = target_tenant and item.work_item_id = candidate.work_item_id
  returning * into strict claimed;
  perform private.governance_append_audit(
    target_tenant, claimed.workflow_kind, claimed.aggregate_id, 'work_claimed',
    claimed.input_sha256, target_claimant_id, database_now
  );
  return next row(
    claimed.tenant_id, claimed.work_item_id, claimed.workflow_kind, claimed.aggregate_id,
    claimed.aggregate_version, claimed.work_kind, claimed.required_role,
    claimed.document_sha256, claimed.object_version_id, claimed.input_sha256,
    claimed.state, claimed.claimant_id, claimed.fencing_token, claimed.lease_expires_at
  )::private.governance_work_claim_receipt;
end;
$$;

-- The owner executes SECURITY DEFINER bodies while FORCE RLS still evaluates a
-- verified-session policy. Runtime principals never own a table or function.
alter table private.governance_reviewer_organizations owner to tivdoc_governance_owner;
alter table private.governance_reviewer_policies owner to tivdoc_governance_owner;
alter table private.governance_reviewers owner to tivdoc_governance_owner;
alter table private.governance_key_challenges owner to tivdoc_governance_owner;
alter table private.governance_key_challenge_consumptions owner to tivdoc_governance_owner;
alter table private.governance_reviewer_keys owner to tivdoc_governance_owner;
alter table private.governance_key_rotations owner to tivdoc_governance_owner;
alter table private.governance_key_revocations owner to tivdoc_governance_owner;
alter table private.governance_human_decisions owner to tivdoc_governance_owner;
alter table private.governance_work_items owner to tivdoc_governance_owner;
alter table private.governance_gt_eligibility_versions owner to tivdoc_governance_owner;
alter table private.governance_gt_manifest_versions owner to tivdoc_governance_owner;
alter table private.governance_gt_locks owner to tivdoc_governance_owner;
alter table private.governance_gt_active_locks owner to tivdoc_governance_owner;
alter table private.governance_gt_lock_supersessions owner to tivdoc_governance_owner;
alter table private.governance_legal_observation_versions owner to tivdoc_governance_owner;
alter table private.governance_legal_observation_decisions owner to tivdoc_governance_owner;
alter table private.governance_parameter_versions owner to tivdoc_governance_owner;
alter table private.governance_parameter_attestations owner to tivdoc_governance_owner;
alter table private.governance_golden_case_sets owner to tivdoc_governance_owner;
alter table private.governance_rulespec_versions owner to tivdoc_governance_owner;
alter table private.governance_rulespec_approvals owner to tivdoc_governance_owner;
alter table private.governance_idempotency owner to tivdoc_governance_owner;
alter table private.governance_audit_events owner to tivdoc_governance_owner;
alter table private.governance_aggregate_snapshots owner to tivdoc_governance_owner;

alter type private.governance_mutation_receipt owner to tivdoc_governance_owner;
alter type private.governance_human_decision_receipt owner to tivdoc_governance_owner;
alter type private.governance_verification_material owner to tivdoc_governance_owner;
alter type private.governance_work_claim_receipt owner to tivdoc_governance_owner;

-- Replacing the policy, rather than adding a permissive peer, prevents the
-- historical caller-controlled GUC policy from remaining an alternate path.
drop policy governance_reviewer_organizations_service_tenant on private.governance_reviewer_organizations;
drop policy governance_reviewer_policies_service_tenant on private.governance_reviewer_policies;
drop policy governance_reviewers_service_tenant on private.governance_reviewers;
drop policy governance_key_challenges_service_tenant on private.governance_key_challenges;
drop policy governance_key_challenge_consumptions_service_tenant on private.governance_key_challenge_consumptions;
drop policy governance_reviewer_keys_service_tenant on private.governance_reviewer_keys;
drop policy governance_key_rotations_service_tenant on private.governance_key_rotations;
drop policy governance_key_revocations_service_tenant on private.governance_key_revocations;
drop policy governance_human_decisions_service_tenant on private.governance_human_decisions;
drop policy governance_work_items_service_tenant on private.governance_work_items;
drop policy governance_gt_eligibility_versions_service_tenant on private.governance_gt_eligibility_versions;
drop policy governance_gt_manifest_versions_service_tenant on private.governance_gt_manifest_versions;
drop policy governance_gt_locks_service_tenant on private.governance_gt_locks;
drop policy governance_gt_active_locks_service_tenant on private.governance_gt_active_locks;
drop policy governance_gt_lock_supersessions_service_tenant on private.governance_gt_lock_supersessions;
drop policy governance_legal_observation_versions_service_tenant on private.governance_legal_observation_versions;
drop policy governance_legal_observation_decisions_service_tenant on private.governance_legal_observation_decisions;
drop policy governance_parameter_versions_service_tenant on private.governance_parameter_versions;
drop policy governance_parameter_attestations_service_tenant on private.governance_parameter_attestations;
drop policy governance_golden_case_sets_service_tenant on private.governance_golden_case_sets;
drop policy governance_rulespec_versions_service_tenant on private.governance_rulespec_versions;
drop policy governance_rulespec_approvals_service_tenant on private.governance_rulespec_approvals;
drop policy governance_idempotency_service_tenant on private.governance_idempotency;
drop policy governance_audit_events_service_tenant on private.governance_audit_events;
drop policy governance_aggregate_snapshots_service_tenant on private.governance_aggregate_snapshots;

create policy governance_reviewer_organizations_verified_tenant on private.governance_reviewer_organizations to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_reviewer_policies_verified_tenant on private.governance_reviewer_policies to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_reviewers_verified_tenant on private.governance_reviewers to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_key_challenges_verified_tenant on private.governance_key_challenges to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_key_challenge_consumptions_verified_tenant on private.governance_key_challenge_consumptions to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_reviewer_keys_verified_tenant on private.governance_reviewer_keys to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_key_rotations_verified_tenant on private.governance_key_rotations to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_key_revocations_verified_tenant on private.governance_key_revocations to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_human_decisions_verified_tenant on private.governance_human_decisions to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_work_items_verified_tenant on private.governance_work_items to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_gt_eligibility_versions_verified_tenant on private.governance_gt_eligibility_versions to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_gt_manifest_versions_verified_tenant on private.governance_gt_manifest_versions to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_gt_locks_verified_tenant on private.governance_gt_locks to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_gt_active_locks_verified_tenant on private.governance_gt_active_locks to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_gt_lock_supersessions_verified_tenant on private.governance_gt_lock_supersessions to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_legal_observation_versions_verified_tenant on private.governance_legal_observation_versions to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_legal_observation_decisions_verified_tenant on private.governance_legal_observation_decisions to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_parameter_versions_verified_tenant on private.governance_parameter_versions to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_parameter_attestations_verified_tenant on private.governance_parameter_attestations to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_golden_case_sets_verified_tenant on private.governance_golden_case_sets to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_rulespec_versions_verified_tenant on private.governance_rulespec_versions to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_rulespec_approvals_verified_tenant on private.governance_rulespec_approvals to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_idempotency_verified_tenant on private.governance_idempotency to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_audit_events_verified_tenant on private.governance_audit_events to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());
create policy governance_aggregate_snapshots_verified_tenant on private.governance_aggregate_snapshots to tivdoc_governance_owner using (tenant_id = private.runtime_verified_tenant()) with check (tenant_id = private.runtime_verified_tenant());

revoke all on function private.runtime_context_install(text,text,text) from public, anon, authenticated, service_role;
revoke all on function private.runtime_verified_tenant() from public, anon, authenticated, service_role, tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime;
revoke all on function private.runtime_verified_actor() from public, anon, authenticated, service_role, tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime;
revoke all on function private.runtime_assert_actor(text) from public, anon, authenticated, service_role, tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime;
revoke all on function private.runtime_assert_reviewer_role(text) from public, anon, authenticated, service_role, tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime;

grant usage on schema private to tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime;
grant execute on function private.runtime_context_install(text,text,text) to tivdoc_operations_runtime, tivdoc_worker_runtime, tivdoc_web_runtime;

-- Remove every V0.10.1 governance grant before applying the per-purpose
-- runtime ACL. Unrelated private-schema capabilities are left untouched.
revoke all on function private.governance_trust_organization_append(text,jsonb,text,text,text,timestamptz) from service_role;
revoke all on function private.governance_trust_policy_append(text,jsonb,text,text,text,timestamptz) from service_role;
revoke all on function private.governance_reviewer_append(text,jsonb,text,text,text,timestamptz) from service_role;
revoke all on function private.governance_key_challenge_append(text,jsonb,text,text,text,timestamptz) from service_role;
revoke all on function private.governance_reviewer_key_register(text,text,timestamptz,text,text,text,text) from service_role;
revoke all on function private.governance_reviewer_key_revoke(text,text,timestamptz,text,text,timestamptz,text,text) from service_role;
revoke all on function private.governance_reviewer_verification_material_read(text,text,text,text,text,text,text,text,text,timestamptz,timestamptz) from service_role;
revoke all on function private.governance_human_decision_admit(text,text,text,text,bigint,jsonb,text,jsonb,text,text,timestamptz) from service_role;
revoke all on function private.governance_work_enqueue(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,timestamptz) from service_role;
revoke all on function private.governance_work_claim(text,text,text,text,text,timestamptz,integer) from service_role;
revoke all on function private.governance_work_release(text,text,text,bigint,text,text,timestamptz,text,text) from service_role;
revoke all on function private.governance_gt_eligibility_append(text,jsonb,text,text,bigint,text,text,text,timestamptz) from service_role;
revoke all on function private.governance_gt_manifest_append(text,text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) from service_role;
revoke all on function private.governance_legal_observation_import(text,jsonb,text,text,timestamptz) from service_role;
revoke all on function private.governance_legal_observation_decide(text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) from service_role;
revoke all on function private.governance_parameter_import(text,jsonb,text,text,timestamptz) from service_role;
revoke all on function private.governance_parameter_attestation_append(text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) from service_role;
revoke all on function private.governance_golden_case_set_import(text,jsonb,text,text,timestamptz) from service_role;
revoke all on function private.governance_rulespec_import(text,jsonb,text,text,timestamptz) from service_role;
revoke all on function private.governance_rulespec_approval_append(text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) from service_role;
revoke all on function private.governance_aggregate_read(text,text,text,text) from service_role;
revoke usage on type private.governance_mutation_receipt from service_role;
revoke usage on type private.governance_human_decision_receipt from service_role;
revoke usage on type private.governance_verification_material from service_role;
revoke usage on type private.governance_work_claim_receipt from service_role;

grant usage on type private.governance_mutation_receipt to tivdoc_operations_runtime, tivdoc_worker_runtime;
grant usage on type private.governance_human_decision_receipt to tivdoc_operations_runtime;
grant usage on type private.governance_verification_material to tivdoc_operations_runtime;
grant usage on type private.governance_work_claim_receipt to tivdoc_operations_runtime;

grant execute on function private.governance_trust_organization_append(text,jsonb,text,text,text,timestamptz) to tivdoc_operations_runtime;
grant execute on function private.governance_trust_policy_append(text,jsonb,text,text,text,timestamptz) to tivdoc_operations_runtime;
grant execute on function private.governance_reviewer_append(text,jsonb,text,text,text,timestamptz) to tivdoc_operations_runtime;
grant execute on function private.governance_key_challenge_append(text,jsonb,text,text,text,timestamptz) to tivdoc_operations_runtime;
grant execute on function private.governance_reviewer_key_register(text,text,timestamptz,text,text,text,text) to tivdoc_operations_runtime;
grant execute on function private.governance_reviewer_key_revoke(text,text,timestamptz,text,text,timestamptz,text,text) to tivdoc_operations_runtime;
grant execute on function private.governance_reviewer_verification_material_read(text,text,text,text,text,text,text,text,text,timestamptz,timestamptz) to tivdoc_operations_runtime;
grant execute on function private.governance_human_decision_admit(text,text,text,text,bigint,jsonb,text,jsonb,text,text,timestamptz) to tivdoc_operations_runtime;
grant execute on function private.governance_work_enqueue(text,text,text,text,text,text,text,text,text,text,jsonb,text,text,timestamptz) to tivdoc_operations_runtime, tivdoc_worker_runtime;
grant execute on function private.governance_work_claim(text,text,text,text,text,timestamptz,integer) to tivdoc_operations_runtime;
grant execute on function private.governance_work_release(text,text,text,bigint,text,text,timestamptz,text,text) to tivdoc_operations_runtime;
grant execute on function private.governance_gt_eligibility_append(text,jsonb,text,text,bigint,text,text,text,timestamptz) to tivdoc_operations_runtime;
grant execute on function private.governance_gt_manifest_append(text,text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) to tivdoc_operations_runtime;
grant execute on function private.governance_legal_observation_import(text,jsonb,text,text,timestamptz) to tivdoc_worker_runtime;
grant execute on function private.governance_legal_observation_decide(text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) to tivdoc_operations_runtime;
grant execute on function private.governance_parameter_import(text,jsonb,text,text,timestamptz) to tivdoc_worker_runtime;
grant execute on function private.governance_parameter_attestation_append(text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) to tivdoc_operations_runtime;
grant execute on function private.governance_golden_case_set_import(text,jsonb,text,text,timestamptz) to tivdoc_worker_runtime;
grant execute on function private.governance_rulespec_import(text,jsonb,text,text,timestamptz) to tivdoc_worker_runtime;
grant execute on function private.governance_rulespec_approval_append(text,jsonb,bigint,text,text,bigint,text,text,text,timestamptz) to tivdoc_operations_runtime;
grant execute on function private.governance_aggregate_read(text,text,text,text) to tivdoc_operations_runtime, tivdoc_worker_runtime;

alter function private.runtime_context_install(text,text,text) owner to tivdoc_governance_owner;
alter function private.runtime_verified_tenant() owner to tivdoc_governance_owner;
alter function private.runtime_verified_actor() owner to tivdoc_governance_owner;
alter function private.runtime_assert_actor(text) owner to tivdoc_governance_owner;
alter function private.runtime_assert_reviewer_role(text) owner to tivdoc_governance_owner;

-- All 32 governance functions retain SECURITY DEFINER by explicit necessity:
-- 21 exposed functions are the only table mutation/read API; 11 helpers are
-- non-callable implementation units required to preserve one FORCE-RLS owner
-- and transaction. Every function has an empty search_path and fixed SQL.
do $governance_functions$
declare
  signature regprocedure;
begin
  for signature in
    select procedure.oid::regprocedure
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace on namespace.oid = procedure.pronamespace
    where namespace.nspname = 'private' and procedure.proname like 'governance\_%' escape '\'
  loop
    execute pg_catalog.format('alter function %s owner to tivdoc_governance_owner', signature);
  end loop;
end;
$governance_functions$;

grant select on public.product_identity_sessions to tivdoc_governance_owner;
grant usage on schema public to tivdoc_governance_owner;

insert into public.engine_schema_metadata (component, schema_version, migration_id)
values (
  'governance_runtime_security',
  'tivdoc-governance-runtime-security-v0.10.2',
  '202609010005_governance_runtime_security'
)
on conflict (component) do update
set schema_version = excluded.schema_version,
    migration_id = excluded.migration_id;

comment on function private.runtime_context_install(text,text,text) is
  'Installs transaction-local tenant/actor context only from a current durable identity session; caller-supplied tenant, actor and role are not accepted.';
comment on table private.governance_work_items is
  'Mutable lease projection protected by fencing tokens; immutable audit events preserve every claim/release/complete transition.';
comment on table private.governance_gt_active_locks is
  'Mutable single-active-lock projection; immutable governance_gt_locks and governance_gt_lock_supersessions are authoritative history.';
