-- Preserve direct Resend acceptance IDs and reconcile genuine webhook events.
-- Legacy receipt RPC/outbox signatures and historical rows remain unchanged.
create function private.apply_direct_notification_events(target_provider uuid) returns void
language plpgsql security definer set search_path='' as $$
declare receipt public.case_notifications; delivered timestamptz;
begin
 select * into receipt from public.case_notifications where provider='resend' and provider_message_id=target_provider for update;
 if not found then return;end if;
 select min(occurred_at) into delivered from private.case_notification_webhooks where provider_message_id=target_provider and kind='email.delivered';
 if exists(select 1 from private.case_notification_webhooks where provider_message_id=target_provider and kind in ('email.bounced','email.complained','email.suppressed')) then
  insert into private.case_notification_suppression(recipient_sha256,reason)
   select contact_hash,'provider_suppression' from public.case_identities where id=receipt.identity_id on conflict do nothing;
  update public.case_notifications set state='refused',error_code='provider_suppression',delivered_at=coalesce(delivered_at,delivered) where id=receipt.id;
 elsif delivered is not null then
  update public.case_notifications set state='delivered',error_code=null,delivered_at=delivered where id=receipt.id;
 elsif exists(select 1 from private.case_notification_webhooks where provider_message_id=target_provider and kind='email.failed') then
  update public.case_notifications set state='failed',error_code='provider_delivery_failed' where id=receipt.id;
 end if;
end;$$;

create or replace function private.apply_notification_events(target_provider uuid) returns void language plpgsql security definer set search_path='' as $$
declare row private.case_notification_outbox;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_provider::text,0));
 perform private.apply_direct_notification_events(target_provider);
 select * into row from private.case_notification_outbox where provider_message_id=target_provider for update;
 if not found then return; end if;
 if exists(select 1 from private.case_notification_webhooks where provider_message_id=target_provider and kind in ('email.bounced','email.complained','email.suppressed')) then
  insert into private.case_notification_suppression(recipient_sha256,reason) values(row.recipient_sha256,'provider_suppression') on conflict do nothing;
  update private.case_notification_outbox set state='suppressed',encrypted_payload=null where delivery_id=row.delivery_id;
 elsif exists(select 1 from private.case_notification_webhooks where provider_message_id=target_provider and kind='email.delivered') then
  update private.case_notification_outbox set state='delivered',delivered_at=(select min(occurred_at) from private.case_notification_webhooks where provider_message_id=target_provider and kind='email.delivered') where delivery_id=row.delivery_id;
 elsif exists(select 1 from private.case_notification_webhooks where provider_message_id=target_provider and kind='email.failed') then
  update private.case_notification_outbox set state='dead_letter',last_error='provider_delivery_failed' where delivery_id=row.delivery_id;
 end if;
end;$$;

create function public.case_notification_record_provider(target_case uuid,target_identity uuid,target_channel text,target_template text,target_state text,target_provider text,target_payload_sha256 text,target_error_code text,target_provider_message_id uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid; prior public.case_notifications;
begin
 if target_provider is distinct from 'resend' or target_state is distinct from 'sent' or target_channel is distinct from 'email' or target_error_code is not null or target_provider_message_id is null
  or target_payload_sha256 is null or target_payload_sha256!~'^[a-f0-9]{64}$'
  or target_template is null or target_template not in ('case_link','access_code','report_ready','document_request','abandonment_reminder')
  or not exists(select 1 from public.case_identities i where i.id=target_identity and i.channel=target_channel)
  or (target_case is not null and not exists(select 1 from public.cases c join public.case_identities i on i.id=target_identity
   where c.id=target_case and (lower(trim(c.email))=i.contact_normalized or exists(select 1 from public.case_identity_cases ic where ic.case_id=c.id and ic.identity_id=i.id)))) then raise exception 'NOTIFICATION_PROVIDER_RECEIPT_SCOPE';end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_provider_message_id::text,0));
 select * into prior from public.case_notifications where provider_message_id=target_provider_message_id;
 if found then
  if prior.provider is distinct from 'resend' or prior.case_id is distinct from target_case or prior.identity_id is distinct from target_identity
   or prior.payload_sha256 is distinct from target_payload_sha256 or prior.template is distinct from target_template then raise exception 'NOTIFICATION_PROVIDER_RECEIPT_MISMATCH';end if;
  perform private.apply_notification_events(target_provider_message_id);return prior.id;
 end if;
 if exists(select 1 from private.case_notification_outbox where provider_message_id=target_provider_message_id) then raise exception 'NOTIFICATION_PROVIDER_RECEIPT_MISMATCH';end if;
 result:=public.case_notification_record(target_case,target_identity,target_channel,target_template,target_state,target_provider,target_payload_sha256,target_error_code);
 update public.case_notifications set provider_message_id=target_provider_message_id where id=result;
 perform private.apply_notification_events(target_provider_message_id);
 return result;
end;$$;
revoke all on function private.apply_direct_notification_events(uuid),private.apply_notification_events(uuid),public.case_notification_record_provider(uuid,uuid,text,text,text,text,text,text,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_notification_record_provider(uuid,uuid,text,text,text,text,text,text,uuid) to tivdoc_web_runtime,service_role;

-- Same provider lock order as direct recording and webhook reconciliation.
-- Prevent cross-path reuse; a worker lease still authorizes exactly one fence.
create or replace function public.case_notification_outbox_finish(target_id text,target_worker uuid,target_fence integer,target_provider_id uuid,target_error text) returns void
language plpgsql security definer set search_path='' as $$
declare row private.case_notification_outbox;
begin
 if target_provider_id is not null then
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(target_provider_id::text,0));
  if exists(select 1 from public.case_notifications where provider='resend' and provider_message_id=target_provider_id) then raise exception 'NOTIFICATION_PROVIDER_RECEIPT_MISMATCH';end if;
 end if;
 select * into row from private.case_notification_outbox where delivery_id=target_id for update;
 if not found or row.state<>'leased' or row.lease_owner is distinct from target_worker or row.fencing_token is distinct from target_fence or row.lease_expires_at<=now() then raise exception 'NOTIFICATION_LEASE_LOST'; end if;
 if target_provider_id is not null then
  update private.case_notification_outbox set state='sent',provider_message_id=target_provider_id,encrypted_payload=null,lease_owner=null,lease_expires_at=null,last_error=null where delivery_id=target_id;
  perform private.apply_notification_events(target_provider_id);
 else
  update private.case_notification_outbox set state=case when attempts>=6 or target_error in ('resend_rejected','recipient_not_allowlisted','resend_email_only') then 'dead_letter' else 'queued' end,
   available_at=now()+make_interval(secs=>least(3600,30*power(2,attempts)::integer)),lease_owner=null,lease_expires_at=null,last_error=left(target_error,100) where delivery_id=target_id;
 end if;
end;$$;
