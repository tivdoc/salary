-- Separate purchased scope, payment and entitlement per order. No live offer
-- is enabled by this migration and no historical customer payment is changed.
create table private.product_orders(
 id uuid primary key default gen_random_uuid(),case_id uuid not null references public.cases(id) on delete cascade,
 kind text not null check(kind in ('initial','full')),period_from date not null,period_to date not null check(period_to>=period_from),
 amount_minor integer not null check(amount_minor>0),currency text not null check(currency='ILS'),offer jsonb not null,offer_sha256 text not null check(offer_sha256~'^[a-f0-9]{64}$'),
 topics text[] not null check(cardinality(topics)>0 and cardinality(topics)<=7),terms_version text not null,terms_accepted_at timestamptz,
 state text not null default 'awaiting_payment' check(state in ('awaiting_payment','paid','cancelled')),refund_state text not null default 'none' check(refund_state in ('none','requested','processing','refunded','rejected')),
 created_at timestamptz not null default now(),verified_at timestamptz,published_at timestamptz,receipt_url text,
 check(kind<>'initial' or period_from=period_to),check(date_trunc('month',period_from)=period_from and date_trunc('month',period_to)=period_to),
 unique(case_id,kind,period_from,period_to)
);
create unique index product_initial_order_once on private.product_orders(case_id) where kind='initial';
create table private.order_checkouts(
 order_id uuid primary key references private.product_orders(id) on delete cascade,attempt_id uuid not null unique,
 state text not null check(state in ('creating','ready','uncertain')),return_hash text not null unique,return_expires_at timestamptz not null,
 provider_order_id text not null unique,provider_log_id text unique,provider_payment_id text unique,checkout_url text,created_at timestamptz not null default now(),last_error text
);
create table private.order_entitlements(order_id uuid primary key references private.product_orders(id) on delete cascade,state text not null check(state in ('active','suspended','revoked')),granted_at timestamptz not null default now());
create table private.order_events(id bigint generated always as identity primary key,order_id uuid not null references private.product_orders(id) on delete cascade,kind text not null,actor text not null,detail jsonb not null default '{}',at timestamptz not null default now());
create table private.order_availability(kind text not null,topic text not null,period_from date not null,period_to date not null,ready boolean not null default false,evidence_reference text not null,primary key(kind,topic,period_from,period_to),check(kind in ('initial','full')),check(period_to>=period_from));
alter table public.payments add column order_id uuid unique references private.product_orders(id);
revoke all on private.product_orders,private.order_checkouts,private.order_entitlements,private.order_events,private.order_availability from public,anon,authenticated,service_role,tivdoc_web_runtime;
grant select on private.product_orders,private.order_checkouts,private.order_entitlements,private.order_events,private.order_availability to tivdoc_operations_runtime,tivdoc_worker_runtime;
-- Activation is an operations action with evidence, separate from a sale flag.
grant insert,update on private.order_availability to tivdoc_operations_runtime;
create function public.case_order_create(target_case uuid,target_identity uuid,target_kind text,target_from date,target_to date,target_offer jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.cases;o private.product_orders;covered text[];month_count integer;
begin
 select * into c from public.cases where id=target_case for update;
 if not found or c.contact_verified_at is null then raise exception 'ORDER_FORBIDDEN';end if;
 if target_identity is null then
  if target_kind<>'initial' then raise exception 'ORDER_FORBIDDEN';end if;
 elsif not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'ORDER_FORBIDDEN';end if;
 if target_kind not in ('initial','full') or target_from is null or target_to is null or target_from>target_to or date_trunc('month',target_from)<>target_from or date_trunc('month',target_to)<>target_to or (target_kind='initial' and (target_from<>target_to or target_from<>c.check_period_month)) then raise exception 'ORDER_PERIOD_INVALID';end if;
 select * into o from private.product_orders where case_id=target_case and kind=target_kind and (target_kind='initial' or(period_from=target_from and period_to=target_to));
 if found then return to_jsonb(o);end if;
 if target_offer->>'version' is distinct from 'tivdoc-order-offer-v1' or target_offer->>'kind' is distinct from target_kind or target_offer->>'currency' is distinct from 'ILS' or coalesce((target_offer->>'amount_minor')::integer,0)<=0 or target_offer->>'sha256' is null then raise exception 'ORDER_OFFER_INVALID';end if;
 -- A topic must be deliverable across the entire period being sold.
 select array_agg(topic order by array_position(array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave'],topic)) into covered from
 (select distinct a.topic from private.order_availability a where a.kind=target_kind and a.ready and a.period_from<=target_from and a.period_to>=target_to and a.topic=any(array['minimum_wage','working_time','pension','travel','convalescence','vacation','sick_leave'])) eligible;
 if coalesce(cardinality(covered),0)=0 then raise exception 'ORDER_COVERAGE_UNAVAILABLE';end if;
 if target_kind='initial' then covered:=covered[1:3];end if;
 month_count:=(extract(year from age(target_to,target_from))*12+extract(month from age(target_to,target_from))+1)::integer;
 if month_count>600 then raise exception 'ORDER_PERIOD_REQUIRES_OPERATIONS';end if;
 insert into private.product_orders(case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version)
 values(target_case,target_kind,target_from,target_to,(target_offer->>'amount_minor')::integer,'ILS',target_offer,target_offer->>'sha256',covered,target_offer->>'terms_version') returning * into o;
 insert into private.order_events(order_id,kind,actor,detail) values(o.id,'created','server:order',jsonb_build_object('offer_sha256',o.offer_sha256,'months',month_count));
 return to_jsonb(o);
end;
$$;
create function public.case_order_snapshot(target_case uuid,target_identity uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'ORDER_FORBIDDEN';end if;
 return coalesce((select jsonb_agg(to_jsonb(o)||jsonb_build_object('checkout_state',coalesce(c.state,'none'),'checkout_url',c.checkout_url,'payment_id',p.id,'entitlement',e.state) order by o.created_at desc) from private.product_orders o left join private.order_checkouts c on c.order_id=o.id left join public.payments p on p.order_id=o.id left join private.order_entitlements e on e.order_id=o.id where o.case_id=target_case),'[]'::jsonb);
end;
$$;
create function public.case_order_checkout_begin(target_case uuid,target_identity uuid,target_order uuid,target_attempt uuid,target_return_hash text,target_terms text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o private.product_orders;c public.cases;attempt private.order_checkouts;
begin
 select * into c from public.cases where id=target_case for update;
 if not found or c.contact_verified_at is null then raise exception 'ORDER_FORBIDDEN';end if;
 select * into o from private.product_orders where id=target_order and case_id=target_case for update;
 if not found or (target_identity is null and o.kind<>'initial') or (target_identity is not null and not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity)) then raise exception 'ORDER_FORBIDDEN';end if;
 if o.state<>'awaiting_payment' then return jsonb_build_object('order',to_jsonb(o),'claimed',false);end if;
 if target_terms is distinct from o.terms_version then raise exception 'ORDER_TERMS_CHANGED';end if;
 select * into attempt from private.order_checkouts where order_id=o.id;
 if found then return jsonb_build_object('order',to_jsonb(o),'checkout',to_jsonb(attempt),'claimed',false);end if;
 if target_return_hash!~'^[a-f0-9]{64}$' or target_attempt is null then raise exception 'ORDER_CHECKOUT_INVALID';end if;
 update private.product_orders set terms_accepted_at=coalesce(terms_accepted_at,now()) where id=o.id;
 insert into private.order_checkouts(order_id,attempt_id,state,return_hash,return_expires_at,provider_order_id) values(o.id,target_attempt,'creating',target_return_hash,now()+interval '1 day','tivdoc-order:'||o.id::text) returning * into attempt;
 insert into public.payments(case_id,order_id,provider,amount,currency,status,provider_order_id,idempotency_key,payment_return_token_hash,payment_return_token_expires_at)
 values(o.case_id,o.id,'invoice4u',o.amount_minor::numeric/100,'ILS','pending',attempt.provider_order_id,'order:'||o.id::text,target_return_hash,attempt.return_expires_at);
 if o.kind='initial' then update public.cases set payment_status='pending',status='payment_pending' where id=o.case_id and payment_status not in ('paid','verified');end if;
 insert into private.order_events(order_id,kind,actor) values(o.id,'checkout_reserved','server:checkout');
 return jsonb_build_object('order',to_jsonb(o),'checkout',to_jsonb(attempt),'claimed',true,'contact',jsonb_build_object('first_name',c.first_name,'email',c.email,'phone',c.phone,'public_id',c.public_id));
end;
$$;
create function public.case_order_checkout_finish(target_order uuid,target_attempt uuid,target_log text,target_payment text,target_url text,target_error text) returns void
language plpgsql security definer set search_path='' as $$
declare c private.order_checkouts;
begin
 select * into c from private.order_checkouts where order_id=target_order for update;
 if not found or c.attempt_id<>target_attempt then raise exception 'ORDER_ATTEMPT_CONFLICT';end if;
 if c.state='ready' then if c.provider_log_id is distinct from target_log then raise exception 'ORDER_ATTEMPT_CONFLICT';end if;return;end if;
 if target_error is not null then update private.order_checkouts set state='uncertain',last_error=left(target_error,100) where order_id=target_order;return;end if;
 if coalesce(length(target_log),0)=0 or coalesce(target_url,'')!~'^https://' then raise exception 'ORDER_CHECKOUT_INVALID';end if;
 update private.order_checkouts set state='ready',provider_log_id=target_log,provider_payment_id=target_payment,checkout_url=target_url where order_id=target_order;
 update public.payments set provider_clearing_log_id=target_log,provider_payment_id=target_payment,provider_redirect_url=target_url,provider_checkout_created_at=now() where order_id=target_order;
 insert into private.order_events(order_id,kind,actor) values(target_order,'checkout_ready','server:checkout');
end;
$$;
create function public.case_order_payment_verify(target_order uuid,target_log text,target_payment text,target_confirmation text,target_minor integer,target_currency text) returns boolean
language plpgsql security definer set search_path='' as $$
declare o private.product_orders;c private.order_checkouts;
begin
 select * into o from private.product_orders where id=target_order for update;
 select * into c from private.order_checkouts where order_id=target_order for update;
 if o.id is null or c.provider_log_id is distinct from target_log or o.amount_minor is distinct from target_minor or o.currency is distinct from target_currency or coalesce(length(target_payment),0)=0 or target_payment='0' or coalesce(length(target_confirmation),0)=0 then raise exception 'ORDER_PAYMENT_MISMATCH';end if;
 if o.state='paid' then if exists(select 1 from public.payments where order_id=o.id and provider_payment_id=target_payment and provider_reference=target_log and status='verified') then return false;end if;raise exception 'ORDER_PAYMENT_CONFLICT';end if;
 if o.state='cancelled' then raise exception 'ORDER_LATE_PAYMENT_REQUIRES_RECONCILIATION';end if;
 update public.payments set status='verified',provider_payment_id=target_payment,provider_reference=target_log,provider_confirmation_number=target_confirmation,verified_at=now() where order_id=o.id;
 update private.product_orders set state='paid',verified_at=now() where id=o.id;
 insert into private.order_entitlements(order_id,state) values(o.id,'active') on conflict do nothing;
 if o.kind='initial' then update public.cases set payment_status='verified',status=case when status in ('started','questionnaire_completed','awaiting_document','documents_uploaded','payment_pending') then 'under_review' else status end where id=o.case_id;end if;
 insert into private.order_events(order_id,kind,actor,detail) values(o.id,'payment_verified','provider:invoice4u',jsonb_build_object('amount_minor',target_minor,'currency',target_currency));
 return true;
end;
$$;
create function public.case_order_payment_pending(target_limit integer default 50) returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(o)||jsonb_build_object('provider_log_id',c.provider_log_id,'provider_order_id',c.provider_order_id)),'[]'::jsonb) from (select * from private.product_orders where state='awaiting_payment' order by created_at limit greatest(1,least(target_limit,100))) o join private.order_checkouts c on c.order_id=o.id where c.provider_log_id is not null;
$$;
create function public.case_order_return_resolve(target_hash text) returns jsonb language sql security definer set search_path='' as $$
 select jsonb_build_object('order_id',o.id,'case_id',o.case_id,'public_id',c.public_id,'kind',o.kind) from private.order_checkouts a join private.product_orders o on o.id=a.order_id join public.cases c on c.id=o.case_id where a.return_hash=target_hash and a.return_expires_at>now();
$$;
revoke all on function public.case_order_create(uuid,uuid,text,date,date,jsonb),public.case_order_snapshot(uuid,uuid),public.case_order_checkout_begin(uuid,uuid,uuid,uuid,text,text),public.case_order_checkout_finish(uuid,uuid,text,text,text,text),public.case_order_payment_verify(uuid,text,text,text,integer,text),public.case_order_payment_pending(integer),public.case_order_return_resolve(text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime;
grant execute on function public.case_order_create(uuid,uuid,text,date,date,jsonb),public.case_order_snapshot(uuid,uuid),public.case_order_checkout_begin(uuid,uuid,uuid,uuid,text,text),public.case_order_checkout_finish(uuid,uuid,text,text,text,text),public.case_order_return_resolve(text) to service_role,tivdoc_web_runtime;
grant execute on function public.case_order_payment_verify(uuid,text,text,text,integer,text),public.case_order_payment_pending(integer) to tivdoc_worker_runtime;

create function public.case_order_get(target_case uuid,target_identity uuid,target_order uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare o private.product_orders;
begin
 select * into o from private.product_orders where id=target_order and case_id=target_case;
 if not found or (target_identity is null and o.kind<>'initial') or (target_identity is not null and not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity)) then raise exception 'ORDER_FORBIDDEN';end if;
 return to_jsonb(o)||jsonb_build_object('public_id',(select public_id from public.cases where id=o.case_id),'checkout_state',coalesce((select state from private.order_checkouts where order_id=o.id),'none'),'checkout_url',(select checkout_url from private.order_checkouts where order_id=o.id));
end;
$$;
revoke all on function public.case_order_get(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.case_order_get(uuid,uuid,uuid) to service_role,tivdoc_web_runtime;
