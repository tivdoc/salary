-- P07 encrypted notification outbox + authenticated webhook inbox.
create table private.case_notification_outbox (
 delivery_id text primary key check(delivery_id~'^[a-f0-9]{64}$'),
 case_id uuid references public.cases(id) on delete cascade,identity_id uuid references public.case_identities(id) on delete cascade,
 recipient_sha256 text not null check(recipient_sha256~'^[a-f0-9]{64}$'),template text not null,
 encrypted_payload jsonb,state text not null default 'queued' check(state in ('queued','leased','sent','delivered','suppressed','dead_letter')),
 attempts integer not null default 0,fencing_token integer not null default 0,lease_owner uuid,lease_expires_at timestamptz,
 available_at timestamptz not null default now(),expires_at timestamptz not null,created_at timestamptz not null default now(),
 provider_message_id uuid unique,last_error text,delivered_at timestamptz,
 check(state not in ('sent','delivered') or provider_message_id is not null)
);
create table private.case_notification_suppression(recipient_sha256 text primary key,reason text not null,created_at timestamptz not null default now());
create table private.case_notification_webhooks(event_id text primary key,provider_message_id uuid not null,kind text not null,occurred_at timestamptz not null,received_at timestamptz not null default now());
revoke all on private.case_notification_outbox,private.case_notification_suppression,private.case_notification_webhooks from public,anon,authenticated,service_role;
grant select on private.case_notification_outbox,private.case_notification_suppression,private.case_notification_webhooks to tivdoc_operations_runtime;
create function public.case_notification_outbox_enqueue(target_id text,target_case uuid,target_identity uuid,target_recipient text,target_template text,target_payload jsonb,target_expires timestamptz) returns text
language plpgsql security definer set search_path='' as $$
begin
 if target_expires<=now() or target_expires>now()+interval '20 hours' or jsonb_typeof(target_payload) is distinct from 'object' then raise exception 'NOTIFICATION_INVALID'; end if;
 insert into private.case_notification_outbox(delivery_id,case_id,identity_id,recipient_sha256,template,encrypted_payload,expires_at,state)
 values(target_id,target_case,target_identity,target_recipient,target_template,target_payload,target_expires,
  case when exists(select 1 from private.case_notification_suppression where recipient_sha256=target_recipient) then 'suppressed' else 'queued' end)
 on conflict(delivery_id) do nothing;
 if not exists(select 1 from private.case_notification_outbox where delivery_id=target_id and case_id is not distinct from target_case and identity_id is not distinct from target_identity and recipient_sha256=target_recipient) then raise exception 'NOTIFICATION_SCOPE_CONFLICT'; end if;
 return target_id;
end;
$$;
create function public.case_notification_outbox_claim(target_worker uuid) returns setof private.case_notification_outbox
language plpgsql security definer set search_path='' as $$
declare target text;
begin
 if target_worker is null then raise exception 'NOTIFICATION_WORKER_INVALID'; end if;
 update private.case_notification_outbox set state='dead_letter',encrypted_payload=null,last_error='delivery_expired',lease_owner=null,lease_expires_at=null where state in ('queued','leased') and (expires_at<=now() or (attempts>=6 and coalesce(lease_expires_at,now())<=now()));
 select delivery_id into target from private.case_notification_outbox o where (state='queued' or(state='leased' and lease_expires_at<=now())) and available_at<=now() and expires_at>now() and attempts<6
 and not exists(select 1 from private.case_notification_suppression s where s.recipient_sha256=o.recipient_sha256)
 order by created_at,delivery_id limit 1 for update skip locked;
 if target is null then return; end if;
 return query update private.case_notification_outbox set state='leased',attempts=attempts+1,fencing_token=fencing_token+1,lease_owner=target_worker,lease_expires_at=now()+interval '1 minute' where delivery_id=target returning *;
end;
$$;
create function private.apply_notification_events(target_provider uuid) returns void language plpgsql security definer set search_path='' as $$
declare row private.case_notification_outbox;
begin
 select * into row from private.case_notification_outbox where provider_message_id=target_provider for update;
 if not found then return; end if;
 if exists(select 1 from private.case_notification_webhooks where provider_message_id=target_provider and kind in ('email.bounced','email.complained','email.suppressed')) then
  insert into private.case_notification_suppression(recipient_sha256,reason) values(row.recipient_sha256,'provider_suppression') on conflict do nothing;
  update private.case_notification_outbox set state='suppressed',encrypted_payload=null where delivery_id=row.delivery_id;
 elsif exists(select 1 from private.case_notification_webhooks where provider_message_id=target_provider and kind='email.delivered') then
  update private.case_notification_outbox set state='delivered',delivered_at=(select min(occurred_at) from private.case_notification_webhooks where provider_message_id=target_provider and kind='email.delivered') where delivery_id=row.delivery_id;
 end if;
end;
$$;
create function public.case_notification_outbox_finish(target_id text,target_worker uuid,target_fence integer,target_provider_id uuid,target_error text) returns void
language plpgsql security definer set search_path='' as $$
declare row private.case_notification_outbox;
begin
 select * into row from private.case_notification_outbox where delivery_id=target_id for update;
 if not found or row.state<>'leased' or row.lease_owner is distinct from target_worker or row.fencing_token<>target_fence or row.lease_expires_at<=now() then raise exception 'NOTIFICATION_LEASE_LOST'; end if;
 if target_provider_id is not null then
  update private.case_notification_outbox set state='sent',provider_message_id=target_provider_id,encrypted_payload=null,lease_owner=null,lease_expires_at=null,last_error=null where delivery_id=target_id;
  perform private.apply_notification_events(target_provider_id);
 else
  update private.case_notification_outbox set state=case when attempts>=6 or target_error in ('resend_rejected','recipient_not_allowlisted','resend_email_only') then 'dead_letter' else 'queued' end,
   available_at=now()+make_interval(secs=>least(3600,30*power(2,attempts)::integer)),lease_owner=null,lease_expires_at=null,last_error=left(target_error,100) where delivery_id=target_id;
 end if;
end;
$$;
create function public.case_notification_webhook_record(target_event text,target_provider uuid,target_kind text,target_at timestamptz) returns void
language plpgsql security definer set search_path='' as $$
begin
 if char_length(target_event) not between 1 and 200 or target_kind not in ('email.sent','email.delivered','email.bounced','email.complained','email.suppressed','email.failed','email.delivery_delayed') then raise exception 'WEBHOOK_INVALID'; end if;
 insert into private.case_notification_webhooks(event_id,provider_message_id,kind,occurred_at) values(target_event,target_provider,target_kind,target_at) on conflict do nothing;
 if not exists(select 1 from private.case_notification_webhooks where event_id=target_event and provider_message_id=target_provider and kind=target_kind and occurred_at=target_at) then raise exception 'WEBHOOK_REPLAY_MISMATCH'; end if;
 perform private.apply_notification_events(target_provider);
end;
$$;
revoke all on function public.case_notification_outbox_enqueue(text,uuid,uuid,text,text,jsonb,timestamptz),public.case_notification_outbox_claim(uuid),public.case_notification_outbox_finish(text,uuid,integer,uuid,text),public.case_notification_webhook_record(text,uuid,text,timestamptz),private.apply_notification_events(uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime;
grant execute on function public.case_notification_outbox_enqueue(text,uuid,uuid,text,text,jsonb,timestamptz) to tivdoc_web_runtime,service_role,tivdoc_worker_runtime;
grant execute on function public.case_notification_outbox_claim(uuid),public.case_notification_outbox_finish(text,uuid,integer,uuid,text) to tivdoc_worker_runtime;
grant execute on function public.case_notification_webhook_record(text,uuid,text,timestamptz) to service_role;
