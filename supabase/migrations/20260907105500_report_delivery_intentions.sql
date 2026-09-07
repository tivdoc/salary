-- Publication commits one durable notification intention. HTTP retries never
-- mint another report notification or an access token.
create table private.case_report_delivery(report_id uuid primary key references public.case_report_projections(id) on delete cascade,case_id uuid not null references public.cases(id) on delete cascade,qa_id uuid not null references public.case_report_qa(id) on delete cascade,delivery_id text references private.case_notification_outbox(delivery_id),created_at timestamptz not null default now());
revoke all on private.case_report_delivery from public,anon,authenticated,service_role,tivdoc_web_runtime;
grant select on private.case_report_delivery to tivdoc_operations_runtime;
create function private.report_delivery_intention() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.state='published' then insert into private.case_report_delivery(report_id,case_id,qa_id) values(new.projection_id,new.case_id,new.id) on conflict(report_id) do nothing;end if;return null;
end;
$$;
revoke all on function private.report_delivery_intention() from public,anon,authenticated,service_role;
create trigger report_delivery_intention after insert or update on public.case_report_qa for each row execute function private.report_delivery_intention();
-- No backfill: old deliveries must first be reconciled with actual provider receipts.
create function public.case_report_notification_pending() returns table(report_id uuid,case_id uuid,public_id text,identity_id uuid,contact text)
language sql security definer set search_path='' as $$
 select d.report_id,d.case_id,c.public_id,i.id,i.contact_normalized from private.case_report_delivery d join public.cases c on c.id=d.case_id
 join lateral(select ident.* from public.case_identity_cases link join public.case_identities ident on ident.id=link.identity_id where link.case_id=c.id and ident.channel='email' order by ident.created_at,ident.id limit 1) i on true
 where d.delivery_id is null and c.contact_verified_at is not null order by d.created_at,d.report_id limit 100;
$$;
create function public.case_report_notification_queue(target_report uuid,target_delivery text,target_identity uuid,target_recipient text,target_payload jsonb,target_expires timestamptz) returns text
language plpgsql security definer set search_path='' as $$
declare d private.case_report_delivery;
begin
 select * into d from private.case_report_delivery where report_id=target_report for update;
 if not found then raise exception 'REPORT_NOT_PUBLISHED'; end if;
 if d.delivery_id is not null then return d.delivery_id;end if;
 if not exists(select 1 from public.case_identity_cases where case_id=d.case_id and identity_id=target_identity) then raise exception 'REPORT_FORBIDDEN';end if;
 perform public.case_notification_outbox_enqueue(target_delivery,d.case_id,target_identity,target_recipient,'report_ready',target_payload,target_expires);
 update private.case_report_delivery set delivery_id=target_delivery where report_id=target_report;
 return target_delivery;
end;
$$;
create function public.case_report_notification_status(target_qa uuid) returns jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('state',coalesce(o.state,'pending'),'error',o.last_error,'attempts',coalesce(o.attempts,0),'next_attempt_at',o.available_at,'provider_message_id',o.provider_message_id) from private.case_report_delivery d left join private.case_notification_outbox o on o.delivery_id=d.delivery_id where d.qa_id=target_qa;
$$;
revoke all on function public.case_report_notification_pending(),public.case_report_notification_queue(uuid,text,uuid,text,jsonb,timestamptz),public.case_report_notification_status(uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime;
grant execute on function public.case_report_notification_pending(),public.case_report_notification_queue(uuid,text,uuid,text,jsonb,timestamptz) to tivdoc_worker_runtime;
grant execute on function public.case_report_notification_status(uuid) to tivdoc_operations_runtime;
