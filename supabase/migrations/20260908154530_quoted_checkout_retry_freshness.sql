-- A reusable provider URL is still an unpaid checkout: revalidate its quote
-- before returning it. Existing externally issued URLs require provider
-- reconciliation; this guard does not claim to revoke them or free credit.
create function private.order_quote_checkout_assert(target_order uuid) returns void language plpgsql set search_path='' as $$
declare o private.product_orders;q private.order_price_quotes;r private.order_quote_reservations;input_hash text;
begin
 select * into o from private.product_orders where id=target_order;
 if o.offer->>'version' is distinct from 'tivdoc-order-offer-v2' then return;end if;
 select * into r from private.order_quote_reservations where order_id=o.id;
 select * into q from private.order_price_quotes where id=r.quote_id;
 if o.state<>'awaiting_payment' or r.order_id is null or r.released_at is not null or q.id is null
  or o.offer->>'price_quote_id' is distinct from q.id::text or o.offer->>'price_quote_sha256' is distinct from q.quote_sha256 then raise exception 'ORDER_QUOTE_INVALID';end if;
 select input_sha256 into input_hash from private.case_input_heads where case_id=o.case_id;
 if input_hash is distinct from q.snapshot->>'input_sha256' then raise exception 'ORDER_QUOTE_SOURCE_CHANGED';end if;
 if clock_timestamp()<(q.snapshot->>'created_at')::timestamptz or clock_timestamp()>=(q.snapshot->>'expires_at')::timestamptz then raise exception 'ORDER_QUOTE_EXPIRED';end if;
 return;
end;$$;

revoke all on function private.order_quote_checkout_assert(uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create or replace function private.order_quoted_checkout_guard() returns trigger language plpgsql set search_path='' as $$
begin perform private.order_quote_checkout_assert(new.order_id);return new;end;$$;
create or replace function public.case_order_checkout_begin(target_case uuid,target_identity uuid,target_order uuid,target_attempt uuid,target_return_hash text,target_terms text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o private.product_orders;c public.cases;attempt private.order_checkouts;
begin
 select * into c from public.cases where id=target_case for update;
 if not found or c.contact_verified_at is null then raise exception 'ORDER_FORBIDDEN';end if;
 select * into o from private.product_orders where id=target_order and case_id=target_case for update;
 if not found or (target_identity is null and o.kind<>'initial') or (target_identity is not null and not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity)) then raise exception 'ORDER_FORBIDDEN';end if;
 if o.state<>'awaiting_payment' then return jsonb_build_object('order',to_jsonb(o),'claimed',false);end if;
 if target_terms is distinct from o.terms_version then raise exception 'ORDER_TERMS_CHANGED';end if;
 perform private.order_quote_checkout_assert(o.id);
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
