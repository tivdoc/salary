-- A credit is released only when no provider attempt or payment ever started.
-- Historical quote/reservation bytes remain; cancellation appends release data.
alter table private.order_quote_reservations add column released_at timestamptz,
 add column release_reason text check(release_reason in ('customer_changed_scope','source_changed','quote_expired')),
 add constraint order_quote_release_complete check((released_at is null)=(release_reason is null));
alter table private.order_quote_reservations drop constraint order_quote_reservations_credit_order_id_key;
create unique index order_quote_active_credit_once on private.order_quote_reservations(credit_order_id) where released_at is null;
alter table private.product_orders drop constraint product_orders_case_id_kind_period_from_period_to_key;
create unique index product_order_active_scope_once on private.product_orders(case_id,kind,period_from,period_to) where state<>'cancelled';
create or replace function private.order_quote_context(target_case uuid,target_identity uuid) returns jsonb
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
   'verified',true,'paid_minor',paid_minor,'already_consumed',exists(select 1 from private.order_quote_reservations where credit_order_id=initial.id and released_at is null)) end);
end;$$;
create or replace function private.order_quote_reserve(target_quote uuid,target_order uuid) returns jsonb
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
 if r.released_at is not null then raise exception 'PRICE_QUOTE_CANCELLED';end if;
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
create or replace function private.order_quote_accept(target_quote uuid,target_offer jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare q private.order_price_quotes; o private.product_orders; r private.order_quote_reservations; context jsonb; selected_topics text[];
begin
 select * into q from private.order_price_quotes where id=target_quote;
 if q.id is null then raise exception 'PRICE_QUOTE_FORBIDDEN';end if;
 context:=private.order_quote_context(q.case_id,q.identity_id);
 select * into r from private.order_quote_reservations where quote_id=q.id;
 if r.quote_id is not null then
  perform private.order_quote_reserve(q.id,r.order_id);
  select * into o from private.product_orders where id=r.order_id and case_id=q.case_id;
  return jsonb_build_object('order',to_jsonb(o),'replayed',true);
 end if;
 if q.snapshot->>'input_sha256' is distinct from context->>'input_sha256' then raise exception 'PRICE_QUOTE_SOURCE_CHANGED';end if;
 if clock_timestamp()<(q.snapshot->>'created_at')::timestamptz or clock_timestamp()>=(q.snapshot->>'expires_at')::timestamptz then raise exception 'PRICE_QUOTE_EXPIRED';end if;
 if target_offer->>'version' is distinct from 'tivdoc-order-offer-v2' or target_offer->>'kind' is distinct from 'full'
  or target_offer->>'currency' is distinct from 'ILS' or target_offer->>'service_kind' is distinct from 'ai_assisted'
  or target_offer->>'human_review_required' is distinct from 'false' or target_offer->>'maximum_checked_topics' is distinct from '7'
  or target_offer->>'price_quote_id' is distinct from q.id::text or target_offer->>'price_quote_sha256' is distinct from q.quote_sha256
  or target_offer->'price_quote' is distinct from q.snapshot or target_offer->>'terms_version' is distinct from q.terms_version
  or target_offer->>'amount_minor' is distinct from q.snapshot->>'balance_minor' or coalesce(target_offer->>'sha256','')!~'^[a-f0-9]{64}$'
  or coalesce(target_offer#>>'{sla,track}','') not in ('automatic','business') or coalesce((target_offer#>>'{sla,budget_ms}')::bigint,0)<=0 then raise exception 'ORDER_OFFER_INVALID';end if;
 selected_topics:=array(select jsonb_array_elements_text(q.snapshot->'purchased_topics'));
 if cardinality(selected_topics)<1 or cardinality(selected_topics)>7 or exists(select 1 from unnest(selected_topics) required(topic)
  where not exists(select 1 from private.order_availability a where a.kind='full' and a.topic=required.topic and a.ready
   and a.period_from<=(q.snapshot#>>'{purchased_period,from}'||'-01')::date and a.period_to>=(q.snapshot#>>'{purchased_period,to}'||'-01')::date)) then raise exception 'ORDER_COVERAGE_UNAVAILABLE';end if;
 -- An earlier different order is never silently repriced or cancelled. A
 -- definite no-charge cancellation/reissue path must precede another purchase.
 if exists(select 1 from private.product_orders where case_id=q.case_id and kind='full'
  and not(state='cancelled' and exists(select 1 from private.order_quote_reservations retired where retired.order_id=private.product_orders.id and retired.released_at is not null))
  and period_from=(q.snapshot#>>'{purchased_period,from}'||'-01')::date and period_to=(q.snapshot#>>'{purchased_period,to}'||'-01')::date) then raise exception 'PRICE_QUOTE_EXISTING_ORDER_REQUIRES_RECONCILIATION';end if;
 insert into private.product_orders(case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version)
 values(q.case_id,'full',(q.snapshot#>>'{purchased_period,from}'||'-01')::date,(q.snapshot#>>'{purchased_period,to}'||'-01')::date,
  (q.snapshot->>'balance_minor')::integer,'ILS',target_offer,target_offer->>'sha256',selected_topics,q.terms_version) returning * into o;
 perform private.order_quote_reserve(q.id,o.id);
 insert into private.order_events(order_id,kind,actor,detail) values(o.id,'created','worker:quoted_order',jsonb_build_object('quote_id',q.id,'offer_sha256',o.offer_sha256));
 return jsonb_build_object('order',to_jsonb(o),'replayed',false);
end;$$;

create function private.order_quote_cancel_unstarted(target_case uuid,target_identity uuid,target_order uuid,target_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o private.product_orders;r private.order_quote_reservations;
begin
 perform private.order_quote_context(target_case,target_identity);
 if coalesce(target_reason,'') not in ('customer_changed_scope','source_changed','quote_expired') then raise exception 'ORDER_CANCEL_REASON_INVALID';end if;
 select * into o from private.product_orders where id=target_order and case_id=target_case for update;
 select * into r from private.order_quote_reservations where order_id=o.id and case_id=target_case;
 if o.id is null or o.kind<>'full' or o.offer->>'version' is distinct from 'tivdoc-order-offer-v2' or r.order_id is null
  or not exists(select 1 from private.order_price_quotes where id=r.quote_id and case_id=target_case and identity_id=target_identity) then raise exception 'PRICE_QUOTE_FORBIDDEN';end if;
 -- Even a creating/uncertain attempt may have charged externally. No timeout,
 -- error status or cancellation request is proof of no provider settlement.
 if exists(select 1 from private.order_checkouts where order_id=o.id) or exists(select 1 from public.payments where order_id=o.id)
  or exists(select 1 from private.order_entitlements where order_id=o.id) or o.verified_at is not null or o.refund_state<>'none'
  then raise exception 'ORDER_CANCEL_REQUIRES_RECONCILIATION';end if;
 if o.state='cancelled' and r.released_at is not null then return jsonb_build_object('order_id',o.id,'state','cancelled','replayed',true);end if;
 if o.state<>'awaiting_payment' or r.released_at is not null then raise exception 'ORDER_CANCEL_REQUIRES_RECONCILIATION';end if;
 update private.product_orders set state='cancelled' where id=o.id;
 update private.order_quote_reservations set released_at=clock_timestamp(),release_reason=target_reason where order_id=o.id;
 insert into private.order_events(order_id,kind,actor,detail) values(o.id,'cancelled_before_checkout','worker:quote_ledger',jsonb_build_object('reason',target_reason,'quote_id',r.quote_id,'released_credit_minor',r.credit_minor));
 return jsonb_build_object('order_id',o.id,'state','cancelled','replayed',false);
end;$$;
revoke all on function private.order_quote_cancel_unstarted(uuid,uuid,uuid,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.order_quote_cancel_unstarted(uuid,uuid,uuid,text) to tivdoc_worker_runtime;

-- Revalidate v2 freshness when provider checkout is first claimed, under the
-- existing authorized case/order locks. v1 historical terms are unaffected.
create function private.order_quoted_checkout_guard() returns trigger language plpgsql set search_path='' as $$
declare o private.product_orders;q private.order_price_quotes;r private.order_quote_reservations;input_hash text;
begin
 select * into o from private.product_orders where id=new.order_id;
 if o.offer->>'version' is distinct from 'tivdoc-order-offer-v2' then return new;end if;
 select * into r from private.order_quote_reservations where order_id=o.id;
 select * into q from private.order_price_quotes where id=r.quote_id;
 if o.state<>'awaiting_payment' or r.order_id is null or r.released_at is not null or q.id is null
  or o.offer->>'price_quote_id' is distinct from q.id::text or o.offer->>'price_quote_sha256' is distinct from q.quote_sha256 then raise exception 'ORDER_QUOTE_INVALID';end if;
 select input_sha256 into input_hash from private.case_input_heads where case_id=o.case_id;
 if input_hash is distinct from q.snapshot->>'input_sha256' then raise exception 'ORDER_QUOTE_SOURCE_CHANGED';end if;
 if clock_timestamp()<(q.snapshot->>'created_at')::timestamptz or clock_timestamp()>=(q.snapshot->>'expires_at')::timestamptz then raise exception 'ORDER_QUOTE_EXPIRED';end if;
 return new;
end;$$;
create trigger order_quoted_checkout_guard before insert on private.order_checkouts for each row execute function private.order_quoted_checkout_guard();
