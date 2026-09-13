-- The ciphertext must belong to the identity/recipient snapshot rendered by
-- the caller. Refreshing metadata alone could label old ciphertext as a new
-- recipient if enrollment/contact changes between pending and enqueue.
drop function public.case_notification_managed_enqueue(text,text,text,jsonb,timestamptz);
create function public.case_notification_managed_enqueue(target_capability text,target_event text,target_delivery text,target_payload jsonb,target_expires timestamptz,expected_case uuid,expected_identity uuid,expected_recipient text) returns text
 language plpgsql security definer set search_path='' as $$
declare row record;prior text;digest text:=private.managed_dev_worker_capability(target_capability);
begin
 if expected_case is null or expected_identity is null or expected_recipient is null or expected_recipient!~'^[a-f0-9]{64}$' then raise exception 'MANAGED_NOTIFICATION_SNAPSHOT_INVALID';end if;
 select n.delivery_id into prior from private.managed_dev_notification_events n
  join private.managed_dev_worker_cases m on m.case_id=n.case_id
  join private.case_notification_outbox o on o.delivery_id=n.delivery_id
 where n.event_key=target_event and m.enabled and m.capability_sha256=digest
  and n.case_id=expected_case and o.identity_id=expected_identity and o.recipient_sha256=expected_recipient;
 if found then return prior;end if;
 select * into row from public.case_notification_managed_pending(target_capability) where event_key=target_event;
 if not found or row.case_id is distinct from expected_case then return null;end if;
 perform 1 from public.cases where id=expected_case for update;
 perform 1 from public.case_identities where id=expected_identity for share;
 select * into row from public.case_notification_managed_pending(target_capability) where event_key=target_event;
 if not found or row.case_id is distinct from expected_case or row.identity_id is distinct from expected_identity
  or (select contact_hash from public.case_identities where id=row.identity_id) is distinct from expected_recipient
  or encode(sha256(convert_to('email|'||lower(btrim(row.contact)),'UTF8')),'hex') is distinct from expected_recipient then return null;end if;
 perform public.case_notification_outbox_enqueue(target_delivery,row.case_id,row.identity_id,expected_recipient,
  case when row.event_kind='request_required' then 'document_request' else 'report_ready' end,target_payload,target_expires);
 insert into private.managed_dev_notification_events(event_key,case_id,delivery_id) values(target_event,row.case_id,target_delivery) on conflict(event_key) do nothing;
 if row.event_kind='report_ready' then update private.case_report_delivery set delivery_id=target_delivery where report_id=row.report_id and delivery_id is null;end if;
 return target_delivery;
end;$$;
revoke all on function public.case_notification_managed_enqueue(text,text,text,jsonb,timestamptz,uuid,uuid,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function public.case_notification_managed_enqueue(text,text,text,jsonb,timestamptz,uuid,uuid,text) to tivdoc_worker_runtime;
