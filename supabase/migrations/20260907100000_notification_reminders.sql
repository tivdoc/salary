-- Link scheduler intentions to exactly one provider outbox entry.
alter table private.case_request_events add column delivery_id text references private.case_notification_outbox(delivery_id) on delete set null,add column queued_at timestamptz;
create function public.case_notification_request_reminders(target_limit integer default 100) returns table(request_id uuid,kind text,case_id uuid,public_id text,identity_id uuid,contact text,question text,expires_at timestamptz)
language plpgsql security definer set search_path='' as $$
begin
 if target_limit not between 1 and 100 then raise exception 'REMINDER_LIMIT'; end if;
 return query select e.request_id,e.kind,e.case_id,c.public_id,i.id,i.contact_normalized,r.question,r.expires_at
 from private.case_request_events e join public.case_requests r on r.id=e.request_id and r.case_id=e.case_id
 join public.cases c on c.id=e.case_id
 join lateral(select ident.* from public.case_identity_cases link join public.case_identities ident on ident.id=link.identity_id where link.case_id=c.id and ident.channel='email' order by ident.created_at,ident.id limit 1) i on true
 where e.kind in ('reminder_48h','reminder_5d') and e.delivery_id is null and r.answered_at is null and r.expired_at is null and r.expires_at>now() and c.contact_verified_at is not null
 order by e.occurred_at,e.request_id limit target_limit;
end;
$$;
create function public.case_notification_request_queued(target_request uuid,target_kind text,target_delivery text) returns void
language plpgsql security definer set search_path='' as $$
begin
 update private.case_request_events e set delivery_id=target_delivery,queued_at=coalesce(queued_at,now())
 where request_id=target_request and kind=target_kind and (delivery_id is null or delivery_id=target_delivery)
 and exists(select 1 from private.case_notification_outbox o where o.delivery_id=target_delivery and o.case_id=e.case_id and o.template='document_request');
 if not found then raise exception 'REMINDER_SCOPE'; end if;
end;
$$;
create function private.notification_terminal_payload() returns trigger language plpgsql security invoker set search_path='' as $$
begin if new.state in ('dead_letter','suppressed') then new.encrypted_payload:=null; end if;return new;end;
$$;
create trigger notification_terminal_payload before insert or update on private.case_notification_outbox for each row execute function private.notification_terminal_payload();
create function private.notification_reminder_receipt() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state='delivered' then update private.case_request_events set delivered_at=new.delivered_at where delivery_id=new.delivery_id;end if;
 return null;
end;
$$;
create trigger notification_reminder_receipt after update of state on private.case_notification_outbox for each row execute function private.notification_reminder_receipt();
revoke all on function public.case_notification_request_reminders(integer),public.case_notification_request_queued(uuid,text,text),private.notification_terminal_payload(),private.notification_reminder_receipt() from public,anon,authenticated,service_role,tivdoc_web_runtime;
grant execute on function public.case_notification_request_reminders(integer),public.case_notification_request_queued(uuid,text,text) to tivdoc_worker_runtime;
-- An accepted email can subsequently fail without bouncing. Preserve confirmed
-- delivery against out-of-order events, but never call a failed delivery sent.
create or replace function private.apply_notification_events(target_provider uuid) returns void language plpgsql security definer set search_path='' as $$
declare row private.case_notification_outbox;
begin
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
end;
$$;
