-- Never let a delayed queue receipt downgrade a terminal token receipt.
create or replace function public.case_access_token_mark_send(target_token uuid,target_state text,target_error_code text) returns void
language sql security invoker set search_path='' as $$
 update public.case_access_tokens set send_state=target_state,send_attempts=send_attempts+1,
 sent_at=case when target_state='sent' then coalesce(sent_at,now()) else sent_at end,send_error_code=target_error_code
 where id=target_token and not(send_state in ('sent','refused') and target_state in ('pending','queued','failed'));
$$;
-- Creating the encrypted reminder and linking its request is one transaction.
create function public.case_notification_reminder_enqueue(target_request uuid,target_kind text,target_id text,target_case uuid,target_identity uuid,target_recipient text,target_payload jsonb,target_expires timestamptz) returns text
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.case_requests r join private.case_request_events e on e.request_id=r.id and e.kind=target_kind
 where r.id=target_request and r.case_id=target_case and e.case_id=target_case and r.answered_at is null and r.expired_at is null and r.expires_at>now() for update of r,e;
 if not found then return null; end if;
 perform public.case_notification_outbox_enqueue(target_id,target_case,target_identity,target_recipient,'document_request',target_payload,target_expires);
 perform public.case_notification_request_queued(target_request,target_kind,target_id);
 return target_id;
end;
$$;
revoke all on function public.case_notification_reminder_enqueue(uuid,text,text,uuid,uuid,text,jsonb,timestamptz) from public,anon,authenticated,service_role,tivdoc_web_runtime;
grant execute on function public.case_notification_reminder_enqueue(uuid,text,text,uuid,uuid,text,jsonb,timestamptz) to tivdoc_worker_runtime;
-- Cancel obsolete reminders before claiming them. A request answered after a
-- provider call has started cannot recall the email; its link shows live state.
do $upgrade$ declare definition text; begin
 definition:=pg_get_functiondef('public.case_notification_outbox_claim(uuid)'::regprocedure);
 definition:=replace(definition,' select delivery_id into target', $insert$
 update private.case_notification_outbox o set state='dead_letter',last_error='request_resolved',encrypted_payload=null
 where o.state='queued' and exists(select 1 from private.case_request_events e join public.case_requests r on r.id=e.request_id where e.delivery_id=o.delivery_id and (r.answered_at is not null or r.expired_at is not null or r.expires_at<=now()));
 select delivery_id into target$insert$);
 execute definition;
end $upgrade$;
