-- Atomic acceptance of a saved quote, internal verified-worker path only.
-- The real monetary reader and customer sale route remain separately gated.
alter table private.order_sla drop constraint order_sla_track_check;
alter table private.order_sla add constraint order_sla_track_check check(track in ('automatic','human','business'));
create or replace function private.order_quote_guard() returns trigger language plpgsql set search_path='' as $$
begin
 if (new.case_id,new.kind,new.period_from,new.period_to,new.amount_minor,new.currency,new.offer,new.offer_sha256,new.topics,new.terms_version) is distinct from (old.case_id,old.kind,old.period_from,old.period_to,old.amount_minor,old.currency,old.offer,old.offer_sha256,old.topics,old.terms_version) then raise exception 'ORDER_QUOTE_IMMUTABLE';end if;
 if new.state='paid' and old.state<>'paid' then
  if new.offer->>'version'='tivdoc-order-offer-v2' then
   if new.offer->>'service_kind' is distinct from 'ai_assisted' or new.offer->>'human_review_required' is distinct from 'false'
    or coalesce(new.offer#>>'{sla,track}','') not in ('automatic','business') then raise exception 'ORDER_OFFER_INVALID';end if;
   insert into private.order_sla(order_id,started_at,track,calendar,budget_ms)
   values(new.id,new.verified_at,new.offer#>>'{sla,track}',new.offer#>'{sla,calendar}',(new.offer#>>'{sla,budget_ms}')::bigint) on conflict do nothing;
  else
   insert into private.order_sla(order_id,started_at,track,calendar,budget_ms)
   values(new.id,new.verified_at,'human',new.offer#>'{sla,calendar}',(new.offer#>>'{sla,human_ms}')::bigint) on conflict do nothing;
  end if;
 end if;return new;
end;$$;

create function private.order_quote_accept(target_quote uuid,target_offer jsonb) returns jsonb
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
  and period_from=(q.snapshot#>>'{purchased_period,from}'||'-01')::date and period_to=(q.snapshot#>>'{purchased_period,to}'||'-01')::date) then raise exception 'PRICE_QUOTE_EXISTING_ORDER_REQUIRES_RECONCILIATION';end if;
 insert into private.product_orders(case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version)
 values(q.case_id,'full',(q.snapshot#>>'{purchased_period,from}'||'-01')::date,(q.snapshot#>>'{purchased_period,to}'||'-01')::date,
  (q.snapshot->>'balance_minor')::integer,'ILS',target_offer,target_offer->>'sha256',selected_topics,q.terms_version) returning * into o;
 perform private.order_quote_reserve(q.id,o.id);
 insert into private.order_events(order_id,kind,actor,detail) values(o.id,'created','worker:quoted_order',jsonb_build_object('quote_id',q.id,'offer_sha256',o.offer_sha256));
 return jsonb_build_object('order',to_jsonb(o),'replayed',false);
end;$$;
revoke all on function private.order_quote_accept(uuid,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.order_quote_accept(uuid,jsonb) to tivdoc_worker_runtime;
