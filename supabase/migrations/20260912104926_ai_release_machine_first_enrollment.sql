-- First preparation records the absence of a predecessor honestly. Renewal
-- still references the stopped historical capability; it never revives it.
alter table private.managed_dev_lifecycle_epochs alter column predecessor_capability_sha256 drop not null;
create unique index managed_dev_first_epoch_once on private.managed_dev_lifecycle_epochs(case_id)
 where predecessor_capability_sha256 is null;

create function private.managed_dev_epoch_scope_guard() returns trigger
language plpgsql security invoker set search_path='' as $$
declare prior private.managed_dev_worker_cases;old_cap private.managed_dev_worker_capabilities;old_session public.product_identity_sessions;
begin
 if current_database()<>'tivdoc_release_replay_20260907' or session_user<>'tivdoc_dev_migrator' then raise exception 'DEV_EPOCH_OWNER_ONLY';end if;
 perform 1 from public.cases where id=new.case_id and is_qa and contact_verified_at is not null for update;
 if not found then raise exception 'DEV_EPOCH_CASE_SCOPE';end if;
 if not exists(select 1 from public.case_identity_cases ic join public.case_identities i on i.id=ic.identity_id
  join private.managed_dev_worker_capabilities cap on cap.capability_sha256=new.capability_sha256
  join public.product_identity_sessions s on s.sid=new.session_sid and s.tenant_id='saved-case:'||new.case_id::text
  where ic.case_id=new.case_id and i.id=new.owner_identity_id and i.channel='email'
   and i.contact_normalized in ('tivdoc.com@gmail.com','info@tivdoc.com') and i.contact_hash=any(cap.notification_recipients)
   and not cap.enabled and cap.expires_at=new.expires_at and s.expires_at=new.expires_at
   and s.revoked_at is null and s.valid_after<=statement_timestamp() and s.reviewer_org_id is null) then raise exception 'DEV_EPOCH_MACHINE_SCOPE';end if;
 select * into prior from private.managed_dev_worker_cases where case_id=new.case_id;
 if new.predecessor_capability_sha256 is null then
  if found or not private.ai_release_managed_case_ready(new.case_id) then raise exception 'DEV_FIRST_EPOCH_SCOPE';end if;
 else
  if not found or prior.capability_sha256<>new.predecessor_capability_sha256 or prior.identity_id<>new.owner_identity_id then raise exception 'DEV_EPOCH_PREDECESSOR_CHANGED';end if;
  select * into old_cap from private.managed_dev_worker_capabilities where capability_sha256=prior.capability_sha256;
  select * into old_session from public.product_identity_sessions where sid=prior.session_sid;
  if old_cap.enabled and old_session.revoked_at is null and old_session.expires_at>statement_timestamp() then raise exception 'DEV_PREDECESSOR_MUST_BE_STOPPED';end if;
 end if;
 return new;
end;$$;
revoke all on function private.managed_dev_epoch_scope_guard() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger managed_dev_epoch_scope_guard before insert on private.managed_dev_lifecycle_epochs
 for each row execute function private.managed_dev_epoch_scope_guard();
