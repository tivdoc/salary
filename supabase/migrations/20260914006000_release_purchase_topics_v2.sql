-- Explicit versioned runtime connection; no activation, charge or service grant seeded.
-- CLI-generated timestamp resequenced after existing applied migrations.


create function private.release_purchase_topics_v2() returns text[]
language sql immutable security invoker set search_path='' as $$
 select array['minimum_wage','working_time','pension','travel','convalescence','vacation','rest_day','bonuses','contract']::text[];
$$;
revoke all on function private.release_purchase_topics_v2() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

do $constraints$
declare c record;n integer:=0;
begin
 for c in select conname from pg_constraint where conrelid='private.product_orders'::regclass and contype='c'
  and pg_get_constraintdef(oid) like '%cardinality(topics)%' loop
  execute format('alter table private.product_orders drop constraint %I',c.conname);n:=n+1;
 end loop;
 if n<>1 then raise exception 'PURCHASE_V2_TOPIC_CONSTRAINT_BASE';end if;
 alter table private.product_orders add constraint product_orders_purchase_topics_version_check check (
  case when offer->>'version'='tivdoc-order-offer-v3' then
   offer->>'purchase_topics_version' is not distinct from 'tivdoc-purchase-topics-v2'
   and cardinality(topics) between 1 and 9 and topics <@ private.release_purchase_topics_v2()
   and (kind<>'initial' or cardinality(topics)<=3 and period_from=period_to and amount_minor=999)
  else cardinality(topics) between 1 and 7 end);
 n:=0;
 for c in select conname from pg_constraint where conrelid='private.order_price_quotes'::regclass and contype='c'
  and pg_get_constraintdef(oid) like '%schema_version%' loop
  execute format('alter table private.order_price_quotes drop constraint %I',c.conname);n:=n+1;
 end loop;
 if n<>1 then raise exception 'PURCHASE_V2_QUOTE_CONSTRAINT_BASE';end if;
 alter table private.order_price_quotes add constraint order_price_quotes_version_check check (coalesce(
  snapshot->>'schema_version'='tivdoc-price-quote-v1' or
  snapshot->>'schema_version'='tivdoc-price-quote-v2'
   and snapshot->>'purchase_topics_version'='tivdoc-purchase-topics-v2',false));
end;$constraints$;

-- Save the old constructor unchanged. New v3 initial requests use the same
-- case lock, verified-contact/identity boundary, one initial order, month and
-- delivery availability checks. Returning an old order never rewrites it.
do $preserve$
declare b text;
begin
 if to_regprocedure('public.case_order_create_before_purchase_v2(uuid,uuid,text,date,date,jsonb)') is not null then raise exception 'PURCHASE_V2_ALREADY_INSTALLED';end if;
 b:=pg_get_functiondef('public.case_order_create(uuid,uuid,text,date,date,jsonb)'::regprocedure);
 execute replace(b,'FUNCTION public.case_order_create(','FUNCTION public.case_order_create_before_purchase_v2(');
end;$preserve$;
revoke all on function public.case_order_create_before_purchase_v2(uuid,uuid,text,date,date,jsonb) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;

create or replace function public.case_order_create(target_case uuid,target_identity uuid,target_kind text,target_from date,target_to date,target_offer jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.cases;o private.product_orders;covered text[];universe text[]:=private.release_purchase_topics_v2();
begin
 if target_offer->>'version' is distinct from 'tivdoc-order-offer-v3' then
  return public.case_order_create_before_purchase_v2(target_case,target_identity,target_kind,target_from,target_to,target_offer);end if;
 select * into c from public.cases where id=target_case for update;
 if not found or c.contact_verified_at is null then raise exception 'ORDER_FORBIDDEN';end if;
 if target_identity is not null and not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'ORDER_FORBIDDEN';end if;
 if target_kind is distinct from 'initial' or target_from is null or target_to is null or target_from<>target_to
  or date_trunc('month',target_from)<>target_from or target_from is distinct from c.check_period_month then raise exception 'ORDER_PERIOD_INVALID';end if;
 select * into o from private.product_orders where case_id=target_case and kind='initial';
 if found then return to_jsonb(o);end if;
 if target_offer->>'kind' is distinct from 'initial' or target_offer->>'currency' is distinct from 'ILS'
  or target_offer->>'amount_minor' is distinct from '999' or target_offer->>'maximum_checked_topics' is distinct from '3'
  or target_offer->>'purchase_topics_version' is distinct from 'tivdoc-purchase-topics-v2'
  or target_offer->'topic_order' is distinct from to_jsonb(universe)
  or target_offer->>'human_review_required' is distinct from 'false'
  or target_offer->>'sha256' is distinct from private.source_intake_journal_sha(target_offer-'sha256')
  or coalesce(length(target_offer->>'terms_version'),0)=0 then raise exception 'ORDER_OFFER_INVALID';end if;
 select array_agg(topic order by array_position(universe,topic)) into covered from
  (select distinct a.topic from private.order_availability a where a.kind='initial' and a.ready
   and a.period_from<=target_from and a.period_to>=target_to and a.topic=any(universe)) available;
 if coalesce(cardinality(covered),0)=0 then raise exception 'ORDER_COVERAGE_UNAVAILABLE';end if;
 covered:=covered[1:3];
 insert into private.product_orders(case_id,kind,period_from,period_to,amount_minor,currency,offer,offer_sha256,topics,terms_version)
 values(target_case,'initial',target_from,target_to,999,'ILS',target_offer,target_offer->>'sha256',covered,target_offer->>'terms_version') returning * into o;
 insert into private.order_events(order_id,kind,actor,detail) values(o.id,'created','server:order',jsonb_build_object('offer_sha256',o.offer_sha256,'months',1));
 return to_jsonb(o);
end;$$;

-- Exact textual substitutions deliberately abort when the expected base is
-- absent. The review must list every changed function before application.
-- This finds current capture_case_input and ALL live source-reading comparators
-- (including saved copies behind currentness wrappers), not only one branch.
do $pins$
declare p record;b text;old_pin text:='jsonb_build_object(''id'',o.id,''kind'',o.kind,''from'',o.period_from,''to'',o.period_to,''topics'',o.topics,''offer_sha256'',o.offer_sha256)';n integer:=0;
begin
 for p in select x.oid from pg_proc x join pg_namespace s on s.oid=x.pronamespace
  where s.nspname in ('private','public') and x.prokind='f'
   and position(old_pin in pg_get_functiondef(x.oid))>0 loop
  b:=pg_get_functiondef(p.oid);execute replace(b,old_pin,'('||old_pin||' ||case when o.offer ? ''purchase_topics_version'' then jsonb_build_object(''purchase_topics_version'',o.offer->''purchase_topics_version'') else ''{}''::jsonb end)');n:=n+1;
 end loop;
 if n<1 then raise exception 'PURCHASE_V2_PIN_CONSUMERS_BASE';end if;
end;$pins$;

do $quote_accept$
declare b text;anchor text;
begin
 b:=pg_get_functiondef('private.order_quote_accept(uuid,jsonb)'::regprocedure);
 anchor:='target_offer->>''version'' is distinct from ''tivdoc-order-offer-v2''';
 if position(anchor in b)=0 then raise exception 'PURCHASE_V2_QUOTE_ACCEPT_VERSION_BASE';end if;
 b:=replace(b,anchor,$condition$not coalesce(
  (target_offer->>'version'='tivdoc-order-offer-v2' and q.snapshot->>'schema_version'='tivdoc-price-quote-v1') or
  (target_offer->>'version'='tivdoc-order-offer-v3' and q.snapshot->>'schema_version'='tivdoc-price-quote-v2'
   and target_offer->>'purchase_topics_version'='tivdoc-purchase-topics-v2'
   and q.snapshot->>'purchase_topics_version'='tivdoc-purchase-topics-v2'
   and target_offer->'topic_order'=to_jsonb(private.release_purchase_topics_v2())
   and target_offer->>'sha256'=private.source_intake_journal_sha(target_offer-'sha256')),false)$condition$);
 anchor:='target_offer->>''maximum_checked_topics'' is distinct from ''7''';
 if position(anchor in b)=0 then raise exception 'PURCHASE_V2_QUOTE_ACCEPT_MAX_BASE';end if;
 b:=replace(b,anchor,'target_offer->>''maximum_checked_topics'' is distinct from (case when q.snapshot->>''schema_version''=''tivdoc-price-quote-v2'' then ''9'' else ''7'' end)');
 anchor:='cardinality(selected_topics)>7';
 if position(anchor in b)=0 then raise exception 'PURCHASE_V2_QUOTE_ACCEPT_TOPICS_BASE';end if;
 b:=replace(b,anchor,'cardinality(selected_topics)>(case when q.snapshot->>''schema_version''=''tivdoc-price-quote-v2'' then 9 else 7 end) or (q.snapshot->>''schema_version''=''tivdoc-price-quote-v2'' and not selected_topics <@ private.release_purchase_topics_v2())');
 execute b;
end;$quote_accept$;

-- Full v3 must still use the quoted SLA, freshness, cancellation and existing
-- AI service guards. Initial v3 MUST NOT enter the full quoted-SLA branch.
-- Review generated diffs: preserve all authority/current-source predicates.
do $versioned_consumers$
declare p record;b text;changed text;
begin
 for p in select x.oid from pg_proc x join pg_namespace s on s.oid=x.pronamespace
  where s.nspname in ('private','public') and x.prokind='f' and x.proname<>'order_quote_accept'
   and position('tivdoc-order-offer-v2' in pg_get_functiondef(x.oid))>0 loop
  b:=pg_get_functiondef(p.oid);changed:=b;
  changed:=replace(changed,'new.offer->>''version''=''tivdoc-order-offer-v2''','(new.kind=''full'' and new.offer->>''version'' in (''tivdoc-order-offer-v2'',''tivdoc-order-offer-v3''))');
  changed:=replace(changed,'o.offer->>''version'' is distinct from ''tivdoc-order-offer-v2''','not coalesce(o.kind=''full'' and o.offer->>''version'' in (''tivdoc-order-offer-v2'',''tivdoc-order-offer-v3''),false)');
  changed:=replace(changed,'o.offer->>''version''=''tivdoc-order-offer-v2''','(o.kind=''full'' and o.offer->>''version'' in (''tivdoc-order-offer-v2'',''tivdoc-order-offer-v3''))');
  changed:=replace(changed,'item#>>''{offer,version}''=''tivdoc-order-offer-v2''','item#>>''{offer,version}'' in (''tivdoc-order-offer-v2'',''tivdoc-order-offer-v3'')');
  if changed<>b then execute changed;end if;
 end loop;
end;$versioned_consumers$;

-- An authenticated web session may read an existing current worker-issued v2
-- quote for its exact requested period. It cannot insert/accept/reserve a quote.
-- Returned source pins stay server-side; the route projects commercial fields.
create function public.case_order_release_quote(target_case uuid,target_identity uuid,target_from date,target_to date) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare q private.order_price_quotes;input_hash text;existing_order uuid;
begin
 if session_user<>'tivdoc_web_runtime' or not exists(select 1 from public.case_identity_cases l join public.cases c on c.id=l.case_id
  where l.case_id=target_case and l.identity_id=target_identity and c.contact_verified_at is not null) then raise exception 'ORDER_FORBIDDEN';end if;
 if target_from is null or target_to is null or target_from>target_to or date_trunc('month',target_from)<>target_from or date_trunc('month',target_to)<>target_to then raise exception 'ORDER_PERIOD_INVALID';end if;
 select input_sha256 into input_hash from private.case_input_heads where case_id=target_case;
 if input_hash is null then return null;end if;
 select p.* into q from private.order_price_quotes p
 where p.case_id=target_case and p.identity_id=target_identity
  and p.snapshot->>'schema_version'='tivdoc-price-quote-v2' and p.snapshot->>'purchase_topics_version'='tivdoc-purchase-topics-v2'
  and p.snapshot#>>'{purchased_period,from}'=to_char(target_from,'YYYY-MM') and p.snapshot#>>'{purchased_period,to}'=to_char(target_to,'YYYY-MM')
  and p.snapshot->>'input_sha256'=input_hash and p.quote_sha256=private.source_intake_journal_sha(p.snapshot-'sha256')
  and p.snapshot->>'sha256'=p.quote_sha256 and p.snapshot->>'case_id'=target_case::text and p.snapshot->>'identity_id'=target_identity::text
  and statement_timestamp()>=(p.snapshot->>'created_at')::timestamptz and statement_timestamp()<(p.snapshot->>'expires_at')::timestamptz
  and exists(select 1 from private.product_orders initial join private.order_entitlements e on e.order_id=initial.id and e.state='active'
   join public.payments paid on paid.order_id=initial.id and paid.case_id=target_case and paid.status='verified' and paid.verified_at is not null
    and paid.currency='ILS' and paid.amount*100=initial.amount_minor
   where initial.case_id=target_case and initial.kind='initial' and initial.state='paid' and initial.verified_at is not null
    and initial.refund_state in ('none','rejected')
    and ((p.snapshot->>'credit_minor')::integer=0 or initial.id::text=p.snapshot->>'credit_order_id'
     and (p.snapshot->>'credit_minor')::integer<=initial.amount_minor
     and not exists(select 1 from private.order_quote_reservations other where other.credit_order_id=initial.id and other.released_at is null and other.quote_id<>p.id)))
  and not exists(select 1 from private.order_quote_reservations r left join private.product_orders o on o.id=r.order_id
   where r.quote_id=p.id and (r.released_at is not null or o.state is distinct from 'awaiting_payment'))
 order by p.created_at desc,p.id limit 1;
 if q.id is null then return null;end if;
 select o.id into existing_order from private.order_quote_reservations r join private.product_orders o on o.id=r.order_id
 where r.quote_id=q.id and r.case_id=target_case and r.released_at is null and o.case_id=target_case and o.kind='full' and o.state='awaiting_payment'
  and o.offer->>'version'='tivdoc-order-offer-v3' and o.offer->>'price_quote_id'=q.id::text and o.offer->>'price_quote_sha256'=q.quote_sha256
  and o.offer->'price_quote'=q.snapshot and o.amount_minor=(q.snapshot->>'balance_minor')::integer
  and to_jsonb(o.topics)=q.snapshot->'purchased_topics' and o.period_from=target_from and o.period_to=target_to;
 return jsonb_build_object('id',q.id,'snapshot',q.snapshot,'quote_sha256',q.quote_sha256,'input_sha256',input_hash,
  'now',to_char(statement_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'order_id',existing_order);
end;$$;
revoke all on function public.case_order_release_quote(uuid,uuid,date,date) from public,anon,authenticated,service_role,tivdoc_worker_runtime,tivdoc_operations_runtime,tivdoc_identity_runtime;
grant execute on function public.case_order_release_quote(uuid,uuid,date,date) to tivdoc_web_runtime;

-- Required separate reviews before root promotes this proposal:
-- 1. The order-pin expression is inlined in current invoker/definer readers;
--    no new helper permission is required and no table/RLS grants are widened.
-- 2. Catalog diff must contain: capture_case_input; all live and chained
--    document_field/current row/metadata/source-period scope comparators;
--    order_quote_guard; order_quote_checkout_assert; quote cancellation and
--    customer snapshot; current full-order publication/managed predicates.
--    Do not alter their enrollment, authority or deployment requirements.
-- 3. SQL duplicate-topic and strict quote-schema validation should match the
--    TypeScript constructors. Current storage writers are worker-only, but
--    an independent real-role test must reject forged v3/version/hash/scope.
-- 4. No existing offers/orders/quote snapshots/case-input versions are updated.
--    A future paid source capture creates a new version with the new pin.
-- 5. Acceptance: old offer byte replay, new initial999/max3, fullv2->v3 worker
--    acceptance/credit-once, expiry/source changes, cancellation/freshness,
--    foreign web null/refusal, source-reading pin match, new9 report coverage.
-- 6. A quote with no prepared order is a read-only preview. The actual trusted
--    pricing reader and worker issuer/accept orchestration remain a distinct
--    task; this script does not call either on fabricated monetary data.

