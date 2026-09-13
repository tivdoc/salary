-- Preserve existing execution ACLs and case -> order -> checkout -> payment lock order.
-- A known provider payment is immutable evidence; a missing payment row cannot grant delivery.
create or replace function public.case_order_payment_verify(target_order uuid,target_log text,target_payment text,target_confirmation text,target_minor integer,target_currency text) returns boolean
language plpgsql security definer set search_path='' as $$
declare o private.product_orders;c private.order_checkouts;p public.payments;
begin
 perform 1 from public.cases where id=(select case_id from private.product_orders where id=target_order) for update;
 select * into o from private.product_orders where id=target_order for update;
 select * into c from private.order_checkouts where order_id=target_order for update;
 if o.id is null or c.order_id is null or c.state<>'ready' or coalesce(length(target_log),0)=0 or c.provider_log_id is distinct from target_log or o.amount_minor is distinct from target_minor or o.currency is distinct from target_currency or coalesce(length(target_payment),0)=0 or target_payment='0' or coalesce(length(target_confirmation),0)=0 then raise exception 'ORDER_PAYMENT_MISMATCH';end if;
 if c.provider_payment_id is not null and c.provider_payment_id is distinct from target_payment then raise exception 'ORDER_PAYMENT_MISMATCH';end if;
 select * into p from public.payments where order_id=o.id and case_id=o.case_id for update;
 if not found then raise exception 'ORDER_PAYMENT_RECORD_MISSING';end if;
 if p.provider<>'invoice4u' or p.amount*100 is distinct from target_minor::numeric or p.currency is distinct from target_currency
  or (p.provider_payment_id is not null and p.provider_payment_id is distinct from target_payment) then raise exception 'ORDER_PAYMENT_MISMATCH';end if;
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

create or replace function public.case_order_payment_pending(target_limit integer default 50) returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(v),'[]'::jsonb) from (select to_jsonb(o)||jsonb_build_object('provider_log_id',c.provider_log_id,'provider_order_id',c.provider_order_id,'provider_payment_id',c.provider_payment_id) v from private.product_orders o join private.order_checkouts c on c.order_id=o.id where o.state='awaiting_payment' and c.provider_log_id is not null order by o.created_at limit greatest(1,least(target_limit,100))) pending;
$$;
