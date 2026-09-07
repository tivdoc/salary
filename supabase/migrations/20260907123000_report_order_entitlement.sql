-- New publication must deliver the actual paid scope; old published rows remain readable.
create or replace function private.case_report_order_scope() returns trigger language plpgsql security definer set search_path='' as $$
declare p public.case_report_projections;o private.product_orders;
begin
 if new.state not in ('approved','published') or (tg_op='UPDATE' and old.state=new.state and new.projection_id=old.projection_id) then return new;end if;
 select * into p from public.case_report_projections where id=new.projection_id and case_id=new.case_id;
 select * into o from private.product_orders where id::text=p.report_document->>'order_id' and case_id=new.case_id;
 if o.id is null or o.state<>'paid' or o.kind<>p.report_kind or not exists(select 1 from private.order_entitlements e where e.order_id=o.id and e.state='active') then raise exception 'REPORT_PAID_ORDER_REQUIRED';end if;
 if p.report_document#>>'{purchased_period,from}' is distinct from to_char(o.period_from,'YYYY-MM') or p.report_document#>>'{purchased_period,to}' is distinct from to_char(o.period_to,'YYYY-MM') then raise exception 'REPORT_ORDER_PERIOD_MISMATCH';end if;
 if exists(select 1 from jsonb_array_elements(p.projection->'topics') t where t->>'gate'='checked' and not((t->>'topic')=any(o.topics))) or exists(select 1 from jsonb_array_elements_text(p.projection->'months_covered') m where m<to_char(o.period_from,'YYYY-MM') or m>to_char(o.period_to,'YYYY-MM')) then raise exception 'REPORT_ORDER_COVERAGE_MISMATCH';end if;
 return new;
end;$$;
drop trigger if exists case_report_order_scope on public.case_report_qa;
create trigger case_report_order_scope before insert or update on public.case_report_qa for each row execute function private.case_report_order_scope();
create or replace function private.case_report_order_delivered() returns trigger language plpgsql security definer set search_path='' as $$
declare target uuid;
begin
 if new.state='published' and (tg_op='INSERT' or old.published_at is null) then
  select o.id into target from private.product_orders o join public.case_report_projections p on p.report_document->>'order_id'=o.id::text where p.id=new.projection_id and o.case_id=new.case_id;
  update private.product_orders set published_at=coalesce(published_at,new.published_at,now()) where id=target;
  update private.order_sla set completed_at=coalesce(completed_at,new.published_at,now()) where order_id=target;
 end if;return new;
end;$$;
drop trigger if exists case_report_order_delivered on public.case_report_qa;
create trigger case_report_order_delivered after insert or update on public.case_report_qa for each row execute function private.case_report_order_delivered();
