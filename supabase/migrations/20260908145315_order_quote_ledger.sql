-- Internal, case-bound quote ledger. No customer sale endpoint or legal rule is
-- enabled here. A trusted monetary-basis reader must precede quote issuance.
create table private.order_price_quotes (
 id uuid primary key, case_id uuid not null references public.cases(id) on delete cascade,
 identity_id uuid not null references public.case_identities(id),
 request_sha256 text not null check(request_sha256~'^[a-f0-9]{64}$'),
 snapshot jsonb not null, quote_sha256 text not null check(quote_sha256~'^[a-f0-9]{64}$'),
 terms_version text not null check(length(terms_version)>0), created_at timestamptz not null default clock_timestamp(),
 check(snapshot->>'schema_version' is not distinct from 'tivdoc-price-quote-v1'),
 check(snapshot->>'case_id' is not distinct from case_id::text),
 check(snapshot->>'identity_id' is not distinct from identity_id::text),
 check(snapshot->>'sha256' is not distinct from quote_sha256),
 unique(case_id,identity_id,request_sha256)
);
create table private.order_quote_reservations (
 quote_id uuid primary key references private.order_price_quotes(id) on delete cascade,
 case_id uuid not null references public.cases(id) on delete cascade,
 order_id uuid not null unique references private.product_orders(id) on delete cascade,
 credit_order_id uuid unique references private.product_orders(id),
 credit_minor integer not null check(credit_minor>=0), reserved_at timestamptz not null default clock_timestamp(),
 check((credit_minor=0)=(credit_order_id is null))
);
alter table private.order_price_quotes enable row level security;
alter table private.order_quote_reservations enable row level security;
revoke all on private.order_price_quotes,private.order_quote_reservations from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

-- Worker authority is installed in this same transaction by the canonical
-- runtime. A supplied case/identity UUID or tenant GUC is not authority.
create function private.order_quote_context(target_case uuid,target_identity uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare initial private.product_orders; input_hash text; paid_minor integer;
begin
 if session_user<>'tivdoc_worker_runtime' or private.runtime_verified_tenant() is distinct from 'saved-case:'||target_case::text then raise exception 'PRICE_QUOTE_FORBIDDEN';end if;
 perform 1 from public.cases where id=target_case and contact_verified_at is not null for update;
 if not found or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'PRICE_QUOTE_FORBIDDEN';end if;
 select input_sha256 into input_hash from private.case_input_heads where case_id=target_case;
 if input_hash is null then raise exception 'PRICE_QUOTE_SOURCE_MISSING';end if;
 select o.* into initial from private.product_orders o join private.order_entitlements e on e.order_id=o.id
 where o.case_id=target_case and o.kind='initial' and o.state='paid' and o.verified_at is not null
 and o.refund_state in ('none','rejected') and e.state='active';
 if initial.id is not null then
  select (p.amount*100)::integer into paid_minor from public.payments p where p.order_id=initial.id and p.case_id=target_case
   and p.status='verified' and p.verified_at is not null and p.currency='ILS' and p.amount*100=initial.amount_minor;
 end if;
 return jsonb_build_object('input_sha256',input_hash,'now',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'credit',case when paid_minor is null then null else jsonb_build_object('order_id',initial.id,'case_id',target_case,'identity_id',target_identity,
   'verified',true,'paid_minor',paid_minor,'already_consumed',exists(select 1 from private.order_quote_reservations where credit_order_id=initial.id)) end);
end;$$;
revoke all on function private.order_quote_context(uuid,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.order_quote_context(uuid,uuid) to tivdoc_worker_runtime;
grant select,insert on private.order_price_quotes to tivdoc_worker_runtime;
grant select on private.order_quote_reservations to tivdoc_worker_runtime;
create policy order_price_quotes_worker_read on private.order_price_quotes for select to tivdoc_worker_runtime
 using(private.runtime_verified_tenant()='saved-case:'||case_id::text);
create policy order_price_quotes_worker_insert on private.order_price_quotes for insert to tivdoc_worker_runtime
 with check(private.order_quote_context(case_id,identity_id)->>'input_sha256'=snapshot->>'input_sha256');
create policy order_quote_reservations_worker_read on private.order_quote_reservations for select to tivdoc_worker_runtime
 using(private.runtime_verified_tenant()='saved-case:'||case_id::text);

-- Bind an already constructed full order in its caller's SAME transaction.
-- The public order API cannot construct this offer yet. No checkout/provider
-- call occurs here, and uncertain provider outcomes never release a credit.
create function private.order_quote_reserve(target_quote uuid,target_order uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q private.order_price_quotes; o private.product_orders; r private.order_quote_reservations; current_context jsonb;
 credit_id uuid; credited integer;
begin
 select * into q from private.order_price_quotes where id=target_quote;
 if q.id is null then raise exception 'PRICE_QUOTE_FORBIDDEN';end if;
 current_context:=private.order_quote_context(q.case_id,q.identity_id);
 select * into o from private.product_orders where id=target_order and case_id=q.case_id for update;
 if o.id is null or o.kind<>'full' or o.state not in ('awaiting_payment','paid')
  or o.offer->>'price_quote_id' is distinct from q.id::text or o.offer->>'price_quote_sha256' is distinct from q.quote_sha256
  or o.amount_minor is distinct from (q.snapshot->>'balance_minor')::integer
  or to_char(o.period_from,'YYYY-MM') is distinct from q.snapshot#>>'{purchased_period,from}'
  or to_char(o.period_to,'YYYY-MM') is distinct from q.snapshot#>>'{purchased_period,to}'
  or to_jsonb(o.topics) is distinct from q.snapshot->'purchased_topics' or o.terms_version is distinct from q.terms_version then raise exception 'PRICE_QUOTE_ORDER_MISMATCH';end if;
 select * into r from private.order_quote_reservations where quote_id=q.id;
 if r.quote_id is not null and r.order_id<>o.id then raise exception 'PRICE_QUOTE_ALREADY_RESERVED';end if;
 -- An exact paid replay preserves history even after expiry or input changes.
 if r.quote_id is not null and o.state='paid' then return to_jsonb(r);end if;
 if o.state='paid' then raise exception 'PRICE_QUOTE_RESERVATION_REQUIRED';end if;
 if q.snapshot->>'input_sha256' is distinct from current_context->>'input_sha256' then raise exception 'PRICE_QUOTE_SOURCE_CHANGED';end if;
 if clock_timestamp()<(q.snapshot->>'created_at')::timestamptz or clock_timestamp()>=(q.snapshot->>'expires_at')::timestamptz then raise exception 'PRICE_QUOTE_EXPIRED';end if;
 if r.quote_id is not null then return to_jsonb(r);end if;
 credited:=(q.snapshot->>'credit_minor')::integer;credit_id:=(q.snapshot->>'credit_order_id')::uuid;
 if credited>0 and (current_context->'credit' is null or current_context->'credit'='null'::jsonb
  or current_context#>>'{credit,order_id}' is distinct from credit_id::text
  or (current_context#>>'{credit,paid_minor}')::integer<credited
  or (current_context#>>'{credit,already_consumed}')::boolean) then raise exception 'PRICE_QUOTE_CREDIT_UNAVAILABLE';end if;
 insert into private.order_quote_reservations(quote_id,case_id,order_id,credit_order_id,credit_minor)
 values(q.id,q.case_id,o.id,credit_id,credited) returning * into r;
 insert into private.order_events(order_id,kind,actor,detail) values(o.id,'quote_reserved','worker:quote_ledger',jsonb_build_object('quote_id',q.id,'quote_sha256',q.quote_sha256,'credit_minor',credited));
 return to_jsonb(r);
end;$$;
revoke all on function private.order_quote_reserve(uuid,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.order_quote_reserve(uuid,uuid) to tivdoc_worker_runtime;
