-- Queueing and provider acceptance are separately observable in product state.
alter table public.case_notifications drop constraint case_notifications_state_check;
alter table public.case_notifications add constraint case_notifications_state_check check(state in ('queued','sent','delivered','failed','refused'));
alter table public.case_notifications add column provider_message_id uuid,add column delivered_at timestamptz;
alter table public.case_access_tokens drop constraint case_access_tokens_send_state_check;
alter table public.case_access_tokens add constraint case_access_tokens_send_state_check check(send_state in ('pending','queued','sent','failed','refused'));
alter table public.cases drop constraint cases_abandonment_reminder_state_check;
alter table public.cases add constraint cases_abandonment_reminder_state_check check(abandonment_reminder_state is null or abandonment_reminder_state in ('queued','sent','failed','refused'));
alter table private.case_notification_outbox add column token_id uuid references public.case_access_tokens(id) on delete set null;
create unique index notification_outbox_product_receipt on public.case_notifications(payload_sha256) where provider='resend_outbox';
create or replace function public.case_notification_record(target_case uuid,target_identity uuid,target_channel text,target_template text,target_state text,target_provider text,target_payload_sha256 text,target_error_code text) returns uuid
language plpgsql security definer set search_path='' as $$
declare result uuid; delivery private.case_notification_outbox; normalized_state text:=target_state;
begin
 if target_provider='resend_outbox' then
  select * into delivery from private.case_notification_outbox where delivery_id=target_payload_sha256 and case_id is not distinct from target_case and identity_id is not distinct from target_identity;
  if not found then raise exception 'NOTIFICATION_RECEIPT_SCOPE'; end if;
  normalized_state:=case delivery.state when 'delivered' then 'delivered' when 'sent' then 'sent' when 'suppressed' then 'refused' when 'dead_letter' then 'failed' else 'queued' end;
 end if;
 insert into public.case_notifications(case_id,identity_id,channel,template,state,provider,payload_sha256,error_code,provider_message_id,delivered_at)
 values(target_case,target_identity,target_channel,target_template,normalized_state,target_provider,target_payload_sha256,target_error_code,delivery.provider_message_id,delivery.delivered_at)
 on conflict(payload_sha256) where provider='resend_outbox' do nothing returning id into result;
 if result is null then select id into result from public.case_notifications where payload_sha256=target_payload_sha256 and provider='resend_outbox' and case_id is not distinct from target_case and identity_id is not distinct from target_identity; end if;
 if result is null then raise exception 'NOTIFICATION_RECEIPT_SCOPE'; end if;
 return result;
end;
$$;
create function public.case_notification_outbox_enqueue(target_id text,target_case uuid,target_identity uuid,target_recipient text,target_template text,target_payload jsonb,target_expires timestamptz,target_token_hash text) returns text
language plpgsql security definer set search_path='' as $$
declare token uuid;
begin
 if target_token_hash is not null then
  select id into token from public.case_access_tokens where token_hash=target_token_hash and case_id=target_case and identity_id=target_identity;
  if token is null then raise exception 'NOTIFICATION_TOKEN_SCOPE'; end if;
 end if;
 perform public.case_notification_outbox_enqueue(target_id,target_case,target_identity,target_recipient,target_template,target_payload,target_expires);
 update private.case_notification_outbox set token_id=token where delivery_id=target_id and token_id is null;
 return target_id;
end;
$$;
revoke all on function public.case_notification_outbox_enqueue(text,uuid,uuid,text,text,jsonb,timestamptz,text) from public,anon,authenticated;
grant execute on function public.case_notification_outbox_enqueue(text,uuid,uuid,text,text,jsonb,timestamptz,text) to service_role,tivdoc_web_runtime,tivdoc_worker_runtime;
-- Propagate exact delivery receipts to their token and digest-matched product
-- row in the same transaction. No other request/case is completed by a send.
create function private.notification_product_receipt() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state in ('sent','delivered') then
  update public.case_notifications set state=new.state,provider_message_id=new.provider_message_id,delivered_at=new.delivered_at,error_code=null where payload_sha256=new.delivery_id and provider='resend_outbox';
  update public.case_access_tokens set send_state='sent',sent_at=coalesce(sent_at,now()),send_error_code=null where id=new.token_id;
 elsif new.state in ('dead_letter','suppressed') then
  update public.case_notifications set state=case when new.state='suppressed' then 'refused' else 'failed' end,error_code=coalesce(new.last_error,new.state) where payload_sha256=new.delivery_id and provider='resend_outbox';
  update public.case_access_tokens set send_state=case when new.state='suppressed' then 'refused' else 'failed' end,send_error_code=coalesce(new.last_error,new.state) where id=new.token_id and send_state<>'sent';
 end if;
 return null;
end;
$$;
revoke all on function private.notification_product_receipt() from public,anon,authenticated,service_role;
create trigger notification_product_receipt after update of state on private.case_notification_outbox for each row execute function private.notification_product_receipt();
do $upgrade$ declare definition text; begin
 definition:=pg_get_functiondef('public.case_access_pending_links(integer)'::regprocedure);
 definition:=replace(definition,$old$'sent', 'refused'$old$,$new$'sent', 'refused', 'queued'$new$);execute definition;
 definition:=pg_get_functiondef('public.case_notification_count(uuid,text)'::regprocedure);
 definition:=replace(definition,$old$state = 'sent'$old$,$new$state in ('sent','delivered')$new$);execute definition;
end $upgrade$;

revoke all on function public.case_notification_record(uuid,uuid,text,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.case_notification_record(uuid,uuid,text,text,text,text,text,text) to tivdoc_web_runtime,service_role;
