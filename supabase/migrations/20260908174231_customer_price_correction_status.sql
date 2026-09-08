-- Expose only the cumulative pending commercial request for the customer's
-- own order. Canonical basis, input hashes and internal revision rows stay private.
create or replace function public.case_order_snapshot(target_case uuid,target_identity uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'ORDER_FORBIDDEN';end if;
 return coalesce((select jsonb_agg(to_jsonb(o)||jsonb_build_object(
  'checkout_state',coalesce(c.state,'none'),'checkout_url',c.checkout_url,'payment_id',p.id,'entitlement',e.state,
  'price_correction',case when pc.order_id is null then null else jsonb_build_object('state','requested','cumulative_refund_minor',pc.cumulative_refund_minor,'requested_at',pc.first_requested_at) end)
  order by o.created_at desc)
 from private.product_orders o left join private.order_checkouts c on c.order_id=o.id
 left join public.payments p on p.order_id=o.id left join private.order_entitlements e on e.order_id=o.id
 left join private.order_price_correction_queue pc on pc.order_id=o.id and pc.case_id=o.case_id
 where o.case_id=target_case),'[]'::jsonb);
end;$$;
revoke all on function public.case_order_snapshot(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_order_snapshot(uuid,uuid) to service_role,tivdoc_web_runtime;
