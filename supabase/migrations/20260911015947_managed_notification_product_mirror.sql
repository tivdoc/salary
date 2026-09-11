-- Mirror authenticated managed DEV notification receipts without sending again.
-- Align the product receipt with the already-supported notification contract.
-- The original three-template constraint predates document requests/reminders.
alter table public.case_notifications drop constraint case_notifications_template_check;
alter table public.case_notifications add constraint case_notifications_template_check
 check(template in ('case_link','access_code','report_ready','document_request','abandonment_reminder'));

create function private.managed_notification_product_mirror(target_digest text,target_case uuid,target_delivery text) returns uuid
language plpgsql security invoker set search_path='' as $$
declare delivery private.case_notification_outbox; result uuid; normalized_state text; normalized_error text;
begin
 if current_database() is distinct from 'tivdoc_release_replay_20260907'
  or target_digest is null or target_digest!~'^[a-f0-9]{64}$' or target_case is null
  or target_delivery is null or target_delivery!~'^[a-f0-9]{64}$' then raise exception 'MANAGED_NOTIFICATION_MIRROR_SCOPE';end if;
 -- Keep the ordinary case -> outbox order, including owner backfill, rather
 -- than taking an outbox lock before a product-row FK checks the case.
 perform 1 from public.cases where id=target_case and is_qa for update;
 if not found then raise exception 'MANAGED_NOTIFICATION_MIRROR_SCOPE';end if;
 -- The provider finish/webhook path also locks this row before changing its
 -- state and then updates the product mirror. Holding the same row here
 -- prevents a stale INSERT from racing a delivered/suppressed transition.
 select * into delivery from private.case_notification_outbox where delivery_id=target_delivery and case_id=target_case for update;
 if not found or delivery.template not in ('document_request','report_ready') then raise exception 'MANAGED_NOTIFICATION_MIRROR_SCOPE';end if;
 if not exists(
  select 1 from private.managed_dev_notification_events n
  join private.managed_dev_worker_cases m on m.case_id=n.case_id
  join private.managed_dev_worker_capabilities cap on cap.capability_sha256=m.capability_sha256
  join public.cases c on c.id=m.case_id and c.is_qa
  join public.case_identity_cases ic on ic.case_id=c.id and ic.identity_id=m.identity_id
  join public.case_identities i on i.id=ic.identity_id
  where n.case_id=target_case and n.delivery_id=target_delivery
   and m.enabled and m.capability_sha256=target_digest and m.identity_id=delivery.identity_id
   and cap.enabled and cap.expires_at>statement_timestamp()
   and delivery.recipient_sha256=any(cap.notification_recipients)
   and i.channel='email' and i.contact_hash=delivery.recipient_sha256
   and (delivery.template='document_request' and n.event_key like 'request:%'
    or delivery.template='report_ready' and (n.event_key like 'report:%' or n.event_key like 'engineering:%'))
 ) then raise exception 'MANAGED_NOTIFICATION_MIRROR_SCOPE';end if;
 -- A historical sent event may already be answered/superseded. Mirroring its
 -- recorded state is not a new send, so event_current is deliberately not
 -- required here. Existing enqueue/claim/current-report gates stay unchanged.
 normalized_state:=case delivery.state when 'delivered' then 'delivered' when 'sent' then 'sent'
  when 'suppressed' then 'refused' when 'dead_letter' then 'failed' else 'queued' end;
 normalized_error:=case when delivery.state in ('sent','delivered') then null
  when delivery.state in ('suppressed','dead_letter') then coalesce(delivery.last_error,delivery.state) else delivery.last_error end;
 result:=public.case_notification_record(target_case,delivery.identity_id,'email',delivery.template,
  normalized_state,'resend_outbox',delivery.delivery_id,normalized_error);
 -- case_notification_record performs an idempotent INSERT with exact
 -- outbox/case/identity binding, but an existing receipt needs reconciliation.
 -- Copy ONLY persisted outbox state. A sent row stays sent without a webhook.
 update public.case_notifications set state=normalized_state,error_code=normalized_error,
  provider_message_id=delivery.provider_message_id,delivered_at=delivery.delivered_at
 where id=result and case_id=target_case and identity_id=delivery.identity_id and provider='resend_outbox'
  and payload_sha256=delivery.delivery_id and template=delivery.template and channel='email';
 if not found then raise exception 'MANAGED_NOTIFICATION_MIRROR_BINDING';end if;
 return result;
end;$$;
revoke all on function private.managed_notification_product_mirror(text,uuid,text)
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Preserve the exact existing capability, expected recipient snapshot,
-- current-event, paid-source, identity and encrypted outbox boundary.
-- There is no direct record permission added to the worker role.
do $proposal$ declare definition text;needle text;begin
 definition:=pg_get_functiondef('public.case_notification_managed_enqueue(text,text,text,jsonb,timestamptz,uuid,uuid,text)'::regprocedure);
 needle:=' if found then return prior;end if;';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'MANAGED_MIRROR_EXISTING_BASE';end if;
 definition:=replace(definition,needle,$new$ if found then
  perform private.managed_notification_product_mirror(digest,expected_case,prior);
  return prior;
 end if;$new$);
 needle:=' return target_delivery;';
 if length(definition)-length(replace(definition,needle,''))<>length(needle) then raise exception 'MANAGED_MIRROR_FRESH_BASE';end if;
 definition:=replace(definition,needle,$new$ perform private.managed_notification_product_mirror(digest,row.case_id,target_delivery);
 return target_delivery;$new$);
 execute definition;
end $proposal$;
