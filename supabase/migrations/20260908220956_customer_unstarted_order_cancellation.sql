-- Customer cancellation reuses the worker's locked ledger operation. This
-- application uses its own server-verified case identity (not Supabase JWT
-- auth.uid()); only the trusted web/service RPC roles can enter the customer
-- boundary. End-user identity is derived from the authenticated session by HTTP.
create function private.order_quote_cancel_locked(target_case uuid,target_identity uuid,target_order uuid,target_reason text,target_actor text) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare o private.product_orders;r private.order_quote_reservations;
begin
 if coalesce(target_reason,'') not in ('customer_changed_scope','source_changed','quote_expired') then raise exception 'ORDER_CANCEL_REASON_INVALID';end if;
 select * into o from private.product_orders where id=target_order and case_id=target_case for update;
 select * into r from private.order_quote_reservations where order_id=o.id and case_id=target_case;
 if o.id is null or o.kind<>'full' or o.offer->>'version' is distinct from 'tivdoc-order-offer-v2' or r.order_id is null
  or not exists(select 1 from private.order_price_quotes where id=r.quote_id and case_id=target_case and identity_id=target_identity) then raise exception 'PRICE_QUOTE_FORBIDDEN';end if;
 if exists(select 1 from private.order_checkouts where order_id=o.id) or exists(select 1 from public.payments where order_id=o.id)
  or exists(select 1 from private.order_entitlements where order_id=o.id) or o.verified_at is not null or o.refund_state<>'none'
  then raise exception 'ORDER_CANCEL_REQUIRES_RECONCILIATION';end if;
 if o.state='cancelled' and r.released_at is not null then return jsonb_build_object('order_id',o.id,'state','cancelled','replayed',true);end if;
 if o.state<>'awaiting_payment' or r.released_at is not null then raise exception 'ORDER_CANCEL_REQUIRES_RECONCILIATION';end if;
 update private.product_orders set state='cancelled' where id=o.id;
 update private.order_quote_reservations set released_at=clock_timestamp(),release_reason=target_reason where order_id=o.id;
 insert into private.order_events(order_id,kind,actor,detail) values(o.id,'cancelled_before_checkout',target_actor,jsonb_build_object('reason',target_reason,'quote_id',r.quote_id,'released_credit_minor',r.credit_minor));
 return jsonb_build_object('order_id',o.id,'state','cancelled','replayed',false);
end;$$;
revoke all on function private.order_quote_cancel_locked(uuid,uuid,uuid,text,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;

create or replace function private.order_quote_cancel_unstarted(target_case uuid,target_identity uuid,target_order uuid,target_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 perform private.order_quote_context(target_case,target_identity);
 return private.order_quote_cancel_locked(target_case,target_identity,target_order,target_reason,'worker:quote_ledger');
end;$$;
revoke all on function private.order_quote_cancel_unstarted(uuid,uuid,uuid,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.order_quote_cancel_unstarted(uuid,uuid,uuid,text) to tivdoc_worker_runtime;

create function private.customer_order_cancel_unstarted(target_case uuid,target_identity uuid,target_order uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 -- Same case -> order lock order as quote acceptance and provider checkout.
 perform 1 from public.cases where id=target_case and contact_verified_at is not null for update;
 if not found or not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'ORDER_FORBIDDEN';end if;
 if not exists(select 1 from private.product_orders o
  join private.order_quote_reservations r on r.order_id=o.id and r.case_id=o.case_id
  join private.order_price_quotes q on q.id=r.quote_id and q.case_id=o.case_id and q.identity_id=target_identity
  where o.id=target_order and o.case_id=target_case and o.kind='full' and o.offer->>'version'='tivdoc-order-offer-v2') then raise exception 'ORDER_FORBIDDEN';end if;
 return private.order_quote_cancel_locked(target_case,target_identity,target_order,'customer_changed_scope','customer:'||target_identity::text);
end;$$;
revoke all on function private.customer_order_cancel_unstarted(uuid,uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function private.customer_order_cancel_unstarted(uuid,uuid,uuid) to service_role,tivdoc_web_runtime;

create function public.case_order_cancel_unstarted(target_case uuid,target_identity uuid,target_order uuid) returns jsonb
language sql security invoker set search_path='' as $$
 select private.customer_order_cancel_unstarted(target_case,target_identity,target_order);
$$;
revoke all on function public.case_order_cancel_unstarted(uuid,uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_order_cancel_unstarted(uuid,uuid,uuid) to service_role,tivdoc_web_runtime;

-- The display hint conveys no authority. The mutation rechecks under locks.
create or replace function public.case_order_snapshot(target_case uuid,target_identity uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'ORDER_FORBIDDEN';end if;
 return coalesce((select jsonb_agg(to_jsonb(o)||jsonb_build_object(
  'checkout_state',coalesce(c.state,'none'),'checkout_url',c.checkout_url,'payment_id',p.id,'entitlement',e.state,
  'can_cancel_unstarted',coalesce(o.kind='full' and o.state='awaiting_payment' and o.offer->>'version'='tivdoc-order-offer-v2'
    and o.verified_at is null and o.refund_state='none' and c.order_id is null and p.id is null and e.order_id is null
    and exists(select 1 from public.cases sc where sc.id=o.case_id and sc.contact_verified_at is not null)
    and exists(select 1 from private.order_quote_reservations r join private.order_price_quotes q on q.id=r.quote_id
      where r.order_id=o.id and r.case_id=o.case_id and r.released_at is null and q.case_id=o.case_id and q.identity_id=target_identity),false),
  'price_correction',case when pc.order_id is null then null else jsonb_build_object('state','requested','cumulative_refund_minor',pc.cumulative_refund_minor,'requested_at',pc.first_requested_at) end)
  order by o.created_at desc)
 from private.product_orders o left join private.order_checkouts c on c.order_id=o.id
 left join public.payments p on p.order_id=o.id left join private.order_entitlements e on e.order_id=o.id
 left join private.order_price_correction_queue pc on pc.order_id=o.id and pc.case_id=o.case_id
 where o.case_id=target_case),'[]'::jsonb);
end;$$;
revoke all on function public.case_order_snapshot(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_order_snapshot(uuid,uuid) to service_role,tivdoc_web_runtime;
