-- P09: whole-case capacity derives from active paid full-order periods.
-- Keep small immutable batches and the existing case-lock/reservation protocol.
create function private.case_document_capacity(target_case uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 with paid_months as (
  select distinct to_char(m,'YYYY-MM') as period_key
  from private.product_orders o join private.order_entitlements e on e.order_id=o.id and e.state='active'
  cross join lateral generate_series(o.period_from,o.period_to,interval '1 month') m
  where o.case_id=target_case and o.kind='full' and o.state='paid'
 ), scope as (
  select coalesce(jsonb_agg(period_key order by period_key),'[]'::jsonb) months,count(*)::integer n from paid_months
 ) select jsonb_build_object('maxPayslips',greatest(12,least(600,n)),
  'maxCaseBytes',case when n=0 then 26214400::bigint else greatest(26214400::bigint,(greatest(12,least(600,n))+2)::bigint*10485760) end,
  'paidMonths',months,'maxBatchFiles',14,'maxBatchBytes',26214400) from scope;
$$;
revoke all on function private.case_document_capacity(uuid) from public,anon,authenticated;
grant execute on function private.case_document_capacity(uuid) to service_role,tivdoc_web_runtime;

alter table public.documents drop constraint documents_slot_check;
alter table public.documents add constraint documents_slot_check
 check(slot ~ '^(payslip-(0[1-9]|[1-9][0-9]|[1-5][0-9]{2}|600)|contract|attendance)$');

-- Patch the installed definitions, preserving the later request/revision and
-- retention fences. Refuse a drifted base instead of silently omitting a check.
do $migration$
declare definition text; changed text;
begin
 definition:=pg_get_functiondef('public.case_documents_snapshot(uuid)'::regprocedure);
 changed:=replace(definition,'''checkPeriodMonth'',', '''capacity'', private.case_document_capacity(target_case), ''checkPeriodMonth'',');
 if changed=definition then raise exception 'CAPACITY_SNAPSHOT_BASE_DRIFT'; end if;
 execute changed;

 definition:=pg_get_functiondef('public.case_documents_reserve(uuid,uuid,jsonb)'::regprocedure);
 changed:=replace(definition,'generate_series(1,12)','generate_series(1,(private.case_document_capacity(target_case)->>''maxPayslips'')::integer)');
 if changed=definition then raise exception 'CAPACITY_RESERVE_BASE_DRIFT'; end if;
 -- lpad(text,2) truncates 100 to 10; preserve the full numeric slot above 99.
 changed:=replace(changed,'lpad(n::text, 2, ''0'')','lpad(n::text, greatest(2,length(n::text)), ''0'')');
 changed:=replace(changed,'if total_size > 26214400 then','if total_size > (private.case_document_capacity(target_case)->>''maxCaseBytes'')::bigint then');
 changed:=replace(changed,'  select coalesce(jsonb_agg(x), ''[]'') into pending',
  '  if (select sum((x->>''size'')::bigint) from jsonb_array_elements(target_manifest->''files'') x)>26214400 then raise exception ''UPLOAD_BATCH_LIMIT''; end if;
  select coalesce(jsonb_agg(x), ''[]'') into pending');
 if position('UPLOAD_BATCH_LIMIT' in changed)=0 or position('maxCaseBytes' in changed)=0 then raise exception 'CAPACITY_RESERVE_GUARD_DRIFT'; end if;
 execute changed;

 definition:=pg_get_functiondef('public.case_documents_commit(uuid,uuid,jsonb)'::regprocedure);
 changed:=replace(definition,'if total_size > 26214400 then','if total_size > (private.case_document_capacity(target_case)->>''maxCaseBytes'')::bigint then');
 if changed=definition then raise exception 'CAPACITY_COMMIT_BASE_DRIFT'; end if;
 changed:=replace(changed,'  -- Recheck the actual case, not the request or a stale sign-time snapshot.',
  '  if (select count(*) from public.documents where case_id=target_case and document_type=''payslip'')>(private.case_document_capacity(target_case)->>''maxPayslips'')::integer then raise exception ''UPLOAD_LIMIT''; end if;
  -- Recheck the actual case, not the request or a stale sign-time snapshot.');
 if position('count(*) from public.documents' in changed)=0 then raise exception 'CAPACITY_COMMIT_COUNT_DRIFT'; end if;
 execute changed;
end;
$migration$;
