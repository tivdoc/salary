-- Immutable order quotes; operational holds and customer refund requests.
create table private.order_sla(order_id uuid primary key references private.product_orders(id) on delete cascade,started_at timestamptz not null,completed_at timestamptz,track text not null check(track in ('automatic','human')),calendar jsonb not null,budget_ms bigint not null check(budget_ms>0));
create table private.order_sla_pauses(id uuid primary key default gen_random_uuid(),order_id uuid not null references private.product_orders(id) on delete cascade,request_id uuid not null references public.case_requests(id),started_at timestamptz not null default now(),ended_at timestamptz,unique(order_id,request_id),check(ended_at is null or ended_at>=started_at));
create table private.order_refund_requests(id uuid primary key,order_id uuid not null unique references private.product_orders(id) on delete cascade,identity_id uuid not null references public.case_identities(id),reason text not null check(length(reason) between 4 and 2000),requested_at timestamptz not null default now());
revoke all on private.order_sla,private.order_sla_pauses,private.order_refund_requests from public,anon,authenticated,service_role,tivdoc_web_runtime;
grant select on private.order_sla,private.order_sla_pauses,private.order_refund_requests to tivdoc_worker_runtime,tivdoc_operations_runtime;
create function private.order_quote_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if (new.case_id,new.kind,new.period_from,new.period_to,new.amount_minor,new.currency,new.offer,new.offer_sha256,new.topics,new.terms_version) is distinct from (old.case_id,old.kind,old.period_from,old.period_to,old.amount_minor,old.currency,old.offer,old.offer_sha256,old.topics,old.terms_version) then raise exception 'ORDER_QUOTE_IMMUTABLE';end if;
 if new.state='paid' and old.state<>'paid' then
  insert into private.order_sla(order_id,started_at,track,calendar,budget_ms) values(new.id,new.verified_at,'human',new.offer#>'{sla,calendar}',(new.offer#>>'{sla,human_ms}')::bigint) on conflict do nothing;
 end if;return new;
end;$$;
create trigger order_quote_guard before update on private.product_orders for each row execute function private.order_quote_guard();
create function private.order_checkout_guard() returns trigger language plpgsql set search_path='' as $$
declare o private.product_orders;
begin
 select * into o from private.product_orders where id=new.order_id;
 if o.kind='initial' and exists(select 1 from public.payments where case_id=o.case_id and order_id is null) then raise exception 'ORDER_LEGACY_PAYMENT_REQUIRES_RECONCILIATION';end if;
 if not exists(select 1 from public.documents where case_id=o.case_id and document_type='payslip') then raise exception 'ORDER_PAYSLIP_REQUIRED';end if;
 if exists(select 1 from unnest(o.topics) as required(topic) where not exists(select 1 from private.order_availability a where a.kind=o.kind and a.topic=required.topic and a.ready and a.period_from<=o.period_from and a.period_to>=o.period_to)) then raise exception 'ORDER_COVERAGE_UNAVAILABLE';end if;
 return new;
end;$$;
create trigger order_checkout_guard before insert on private.order_checkouts for each row execute function private.order_checkout_guard();
create or replace function public.case_order_payment_pending(target_limit integer default 50) returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(v),'[]'::jsonb) from (select to_jsonb(o)||jsonb_build_object('provider_log_id',c.provider_log_id,'provider_order_id',c.provider_order_id) v from private.product_orders o join private.order_checkouts c on c.order_id=o.id where o.state='awaiting_payment' and c.provider_log_id is not null order by o.created_at limit greatest(1,least(target_limit,100))) pending;
$$;
create function public.case_order_refund_request(target_case uuid,target_identity uuid,target_order uuid,target_id uuid,target_reason text) returns text language plpgsql security definer set search_path='' as $$
declare o private.product_orders;r private.order_refund_requests;
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'ORDER_FORBIDDEN';end if;
 select * into o from private.product_orders where id=target_order and case_id=target_case for update;
 if not found then raise exception 'ORDER_FORBIDDEN';end if;
 select * into r from private.order_refund_requests where order_id=o.id;
 if found then return o.refund_state;end if;
 if o.state<>'paid' then raise exception 'ORDER_NOT_PAID';end if;
 insert into private.order_refund_requests(id,order_id,identity_id,reason) values(target_id,o.id,target_identity,btrim(target_reason));
 update private.product_orders set refund_state='requested' where id=o.id;
 insert into private.order_events(order_id,kind,actor) values(o.id,'refund_requested','customer');
 return 'requested';
end;$$;
create function public.case_order_sla_snapshot(target_case uuid,target_identity uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'ORDER_FORBIDDEN';end if;
 return coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('pauses',coalesce((select jsonb_agg(to_jsonb(p)) from private.order_sla_pauses p where p.order_id=o.id),'[]'::jsonb))) from private.product_orders o join private.order_sla s on s.order_id=o.id where o.case_id=target_case),'[]'::jsonb);
end;$$;
create function public.case_order_sla_hold(target_order uuid,target_request uuid) returns void language plpgsql security definer set search_path='' as $$
declare o private.product_orders;r public.case_requests;
begin
 select * into o from private.product_orders where id=target_order for update;
 select * into r from public.case_requests where id=target_request;
 if o.id is null or r.case_id is distinct from o.case_id or r.answered_at is not null or r.expired_at is not null or r.expires_at<=now() or not r.blocking then raise exception 'ORDER_REQUEST_MISMATCH';end if;
 insert into private.order_sla_pauses(order_id,request_id) values(o.id,r.id) on conflict do nothing;
end;$$;
create function private.order_request_pause_close() returns trigger language plpgsql set search_path='' as $$
begin
 if new.answered_at is not null or new.expired_at is not null then update private.order_sla_pauses set ended_at=coalesce(new.answered_at,new.expired_at) where request_id=new.id and ended_at is null;end if;return new;
end;$$;
create trigger order_request_pause_close after update of answered_at,expired_at on public.case_requests for each row execute function private.order_request_pause_close();
revoke all on function public.case_order_refund_request(uuid,uuid,uuid,uuid,text),public.case_order_sla_snapshot(uuid,uuid),public.case_order_sla_hold(uuid,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime;
grant execute on function public.case_order_refund_request(uuid,uuid,uuid,uuid,text),public.case_order_sla_snapshot(uuid,uuid) to service_role,tivdoc_web_runtime;
grant execute on function public.case_order_sla_hold(uuid,uuid) to tivdoc_operations_runtime,tivdoc_worker_runtime;
