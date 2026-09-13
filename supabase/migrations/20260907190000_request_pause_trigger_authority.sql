-- Request completion is an authorized web write. Closing a linked service-clock
-- pause needs a narrow trigger authority, not direct web access to order tables.
create or replace function private.order_request_pause_close() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_schema <> 'public' or tg_table_name <> 'case_requests' or tg_op <> 'UPDATE' then
  raise exception 'ORDER_REQUEST_TRIGGER_SCOPE';
 end if;
 if new.answered_at is not null or new.expired_at is not null then
  update private.order_sla_pauses p
   set ended_at=coalesce(new.answered_at,new.expired_at)
   from private.product_orders o
   where p.order_id=o.id and o.case_id=new.case_id
    and p.request_id=new.id and p.ended_at is null;
 end if;
 return new;
end;
$$;
-- Trigger functions cannot be used as a general-purpose order mutation API.
revoke all on function private.order_request_pause_close()
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
