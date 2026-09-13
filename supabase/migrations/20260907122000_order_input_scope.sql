create function public.case_order_funnel_state(target_case uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.cases;
begin
 select * into c from public.cases where id=target_case;
 if not found or c.contact_verified_at is null then raise exception 'ORDER_FORBIDDEN';end if;
 return jsonb_build_object('check_period_month',c.check_period_month,'payment_status',c.payment_status,'legacy_payment',exists(select 1 from public.payments where case_id=target_case and order_id is null));
end;$$;
revoke all on function public.case_order_funnel_state(uuid) from public,anon,authenticated;
grant execute on function public.case_order_funnel_state(uuid) to service_role,tivdoc_web_runtime;
-- Case first, then order, throughout checkout, capture and verification.
do $upgrade$ declare definition text;begin
 definition:=pg_get_functiondef('public.case_order_payment_verify(uuid,text,text,text,integer,text)'::regprocedure);
 definition:=replace(definition,' select * into o from private.product_orders where id=target_order for update;', ' perform 1 from public.cases where id=(select case_id from private.product_orders where id=target_order) for update; select * into o from private.product_orders where id=target_order for update;');execute definition;
 definition:=pg_get_functiondef('private.capture_case_input(uuid,text)'::regprocedure);
 definition:=replace(definition,'''payment_status'',c.payment_status,', '''payment_status'',c.payment_status, ''orders'', coalesce((select jsonb_agg(jsonb_build_object(''id'',o.id,''kind'',o.kind,''from'',o.period_from,''to'',o.period_to,''topics'',o.topics,''offer_sha256'',o.offer_sha256) order by o.id) from private.product_orders o where o.case_id=c.id and o.state=''paid''),''[]''::jsonb),');execute definition;
end $upgrade$;
create trigger case_order_input after update of state on private.product_orders for each row when(old.state is distinct from new.state) execute function private.capture_case_input_trigger();
