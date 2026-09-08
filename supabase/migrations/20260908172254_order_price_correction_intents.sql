-- Commercial correction intake, not a provider refund dispatcher. Every amount
-- is a cumulative target for ONE paid upgrade. Never sum these revision rows.
create table private.order_price_correction_requests (
 id uuid primary key, case_id uuid not null references public.cases(id) on delete cascade,
 identity_id uuid not null references public.case_identities(id),
 order_id uuid not null references private.product_orders(id) on delete cascade,
 quote_id uuid not null references private.order_price_quotes(id) on delete cascade,
 quote_sha256 text not null check(quote_sha256~'^[a-f0-9]{64}$'),
 input_sha256 text not null check(input_sha256~'^[a-f0-9]{64}$'),
 corrected_basis jsonb not null, corrected_basis_sha256 text not null check(corrected_basis_sha256~'^[a-f0-9]{64}$'),
 corrected_basis_minor bigint not null check(corrected_basis_minor>=0),
 cumulative_refund_minor integer not null check(cumulative_refund_minor>0),
 state text not null default 'requested' check(state='requested'),
 requested_at timestamptz not null default clock_timestamp(),
 unique(order_id,corrected_basis_sha256)
);
alter table private.order_price_correction_requests enable row level security;
revoke all on private.order_price_correction_requests from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant select on private.order_price_correction_requests to tivdoc_worker_runtime;
create policy price_correction_worker_read on private.order_price_correction_requests for select to tivdoc_worker_runtime
 using(private.runtime_verified_tenant()='saved-case:'||case_id::text);
create view private.order_price_correction_queue with(security_invoker=true) as
 select case_id,order_id,max(cumulative_refund_minor) cumulative_refund_minor,
 count(*) revision_count,min(requested_at) first_requested_at,max(requested_at) last_requested_at,'requested'::text state
 from private.order_price_correction_requests group by case_id,order_id;
revoke all on private.order_price_correction_queue from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant select on private.order_price_correction_queue to tivdoc_worker_runtime;

-- The same case/order lock serializes corrections with customer refund intake.
-- A customer refund request is retained; this ledger does not replace it or
-- independently dispatch money. A future provider adapter must reconcile BOTH.
create function private.order_price_correction_context(target_case uuid,target_identity uuid,target_order uuid,target_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c jsonb; o private.product_orders; q private.order_price_quotes; r private.order_price_correction_requests; previous jsonb;
begin
 c:=private.order_quote_context(target_case,target_identity);
 select * into o from private.product_orders where id=target_order and case_id=target_case for update;
 if o.id is null or o.kind<>'full' then raise exception 'PRICE_CORRECTION_FORBIDDEN';end if;
 select pq.* into q from private.order_price_quotes pq join private.order_quote_reservations qr on qr.quote_id=pq.id
 where qr.order_id=o.id and qr.case_id=target_case and qr.released_at is null and pq.identity_id=target_identity
 and pq.case_id=target_case and pq.id::text=o.offer->>'price_quote_id' and pq.quote_sha256=o.offer->>'price_quote_sha256';
 if q.id is null or o.offer->'price_quote' is distinct from q.snapshot or o.amount_minor is distinct from (q.snapshot->>'balance_minor')::integer then raise exception 'PRICE_CORRECTION_QUOTE_MISMATCH';end if;
 select * into r from private.order_price_correction_requests where id=target_id;
 if r.id is not null then
  if r.order_id<>o.id or r.case_id<>target_case or r.identity_id<>target_identity then raise exception 'PRICE_CORRECTION_REQUEST_CONFLICT';end if;
  previous:=jsonb_build_object('id',r.id,'order_id',r.order_id,'state',r.state,'cumulative_refund_minor',r.cumulative_refund_minor,'requested_at',r.requested_at);
 else
  if o.state<>'paid' or o.verified_at is null or o.currency<>'ILS' or o.refund_state in ('processing','refunded')
   or not exists(select 1 from private.order_entitlements where order_id=o.id and state='active')
   or not exists(select 1 from public.payments where order_id=o.id and case_id=o.case_id and status='verified' and verified_at is not null and currency='ILS' and amount*100=o.amount_minor)
   then raise exception 'PRICE_CORRECTION_PAID_ORDER_REQUIRED';end if;
 end if;
 return jsonb_build_object('input_sha256',c->>'input_sha256','quote_id',q.id,'quote_sha256',q.quote_sha256,'quote',q.snapshot,'previous',previous);
end;$$;
revoke all on function private.order_price_correction_context(uuid,uuid,uuid,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.order_price_correction_context(uuid,uuid,uuid,uuid) to tivdoc_worker_runtime;

create function private.order_price_correction_request(target_case uuid,target_identity uuid,target_order uuid,target_id uuid,
 expected_quote_sha256 text,target_basis jsonb,target_basis_sha256 text,target_basis_minor bigint,target_refund_minor integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c jsonb; q jsonb; corrected_total integer; expected_refund integer; r private.order_price_correction_requests;
begin
 c:=private.order_price_correction_context(target_case,target_identity,target_order,target_id);q:=c->'quote';
 if c->'previous' is not null and c->'previous'<>'null'::jsonb then
  select * into r from private.order_price_correction_requests where id=target_id;
  if r.quote_sha256 is distinct from expected_quote_sha256 or r.corrected_basis is distinct from target_basis
   or r.corrected_basis_sha256 is distinct from target_basis_sha256 or r.corrected_basis_minor is distinct from target_basis_minor
   or r.cumulative_refund_minor is distinct from target_refund_minor then raise exception 'PRICE_CORRECTION_REQUEST_CONFLICT';end if;
  return c->'previous'||jsonb_build_object('replayed',true);
 end if;
 if expected_quote_sha256 is distinct from c->>'quote_sha256'
  or target_basis->>'case_id' is distinct from target_case::text or target_basis->>'identity_id' is distinct from target_identity::text
  or target_basis->>'input_sha256' is distinct from c->>'input_sha256' then raise exception 'PRICE_CORRECTION_SOURCE_CHANGED';end if;
 if target_basis_sha256 is null or target_basis_sha256!~'^[a-f0-9]{64}$' or target_basis_minor is null or target_basis_minor<0
  or jsonb_typeof(target_basis->'checked_months') is distinct from 'array' or jsonb_typeof(target_basis->'checked_topics') is distinct from 'array'
  or array(select jsonb_array_elements_text(target_basis->'checked_months') order by 1) is distinct from array(select jsonb_array_elements_text(q->'checked_months') order by 1)
  or array(select jsonb_array_elements_text(target_basis->'checked_topics') order by 1) is distinct from array(select jsonb_array_elements_text(q->'checked_topics') order by 1)
  then raise exception 'PRICE_CORRECTION_BASIS_INVALID';end if;
 -- The server-owned canonical reader and pricing validator establish the basis.
 -- SQL independently recomputes the commercial refund using the ORIGINAL policy
 -- and caps it at the actual verified upgrade charge. No present-day repricing.
 select (tier->>'total_minor')::integer into corrected_total from jsonb_array_elements(q#>'{pricing_policy,tiers}') tier
 where (tier->>'minimum_basis_minor')::bigint<=target_basis_minor order by (tier->>'minimum_basis_minor')::bigint desc limit 1;
 expected_refund:=case when corrected_total is null then (q->>'balance_minor')::integer
 else greatest(0,least((q->>'balance_minor')::integer,(q->>'total_minor')::integer-corrected_total)) end;
 if expected_refund<=0 or target_refund_minor is distinct from expected_refund then raise exception 'PRICE_CORRECTION_AMOUNT_MISMATCH';end if;
 select * into r from private.order_price_correction_requests where order_id=target_order and cumulative_refund_minor>=expected_refund order by cumulative_refund_minor desc,requested_at,id limit 1;
 if r.id is not null then
  return jsonb_build_object('id',r.id,'order_id',r.order_id,'state',r.state,'cumulative_refund_minor',r.cumulative_refund_minor,'requested_at',r.requested_at,'replayed',true);
 end if;
 insert into private.order_price_correction_requests(id,case_id,identity_id,order_id,quote_id,quote_sha256,input_sha256,corrected_basis,corrected_basis_sha256,corrected_basis_minor,cumulative_refund_minor)
 values(target_id,target_case,target_identity,target_order,(c->>'quote_id')::uuid,expected_quote_sha256,c->>'input_sha256',target_basis,target_basis_sha256,target_basis_minor,expected_refund) returning * into r;
 insert into private.order_events(order_id,kind,actor,detail) values(target_order,'price_correction_refund_requested','worker:price_correction',jsonb_build_object('request_id',r.id,'quote_sha256',r.quote_sha256,'basis_sha256',r.corrected_basis_sha256,'cumulative_refund_minor',r.cumulative_refund_minor,'provider_settled',false));
 return jsonb_build_object('id',r.id,'order_id',r.order_id,'state',r.state,'cumulative_refund_minor',r.cumulative_refund_minor,'requested_at',r.requested_at,'replayed',false);
end;$$;
revoke all on function private.order_price_correction_request(uuid,uuid,uuid,uuid,text,jsonb,text,bigint,integer) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_operations_runtime;
grant execute on function private.order_price_correction_request(uuid,uuid,uuid,uuid,text,jsonb,text,bigint,integer) to tivdoc_worker_runtime;
