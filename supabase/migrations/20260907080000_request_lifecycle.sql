-- P06: expiry is a business transition; reminders are durable intentions.
alter table public.case_requests add column expired_at timestamptz;
alter table public.case_requests add constraint request_single_terminal check(not(answered_at is not null and expired_at is not null));
create table private.case_request_events (
 request_id uuid not null references public.case_requests(id) on delete cascade,
 case_id uuid not null references public.cases(id) on delete cascade,
 kind text not null check(kind in ('reminder_48h','reminder_5d','expired')),
 occurred_at timestamptz not null, delivered_at timestamptz,
 primary key(request_id,kind)
);
revoke all on private.case_request_events from public,anon,authenticated,service_role;
grant select,insert,update on private.case_request_events to tivdoc_worker_runtime;
grant select on private.case_request_events to tivdoc_operations_runtime;
create or replace function public.case_request_answer(target_request uuid,target_case uuid,target_answer text)
returns setof public.case_requests language plpgsql security invoker set search_path='' as $$
declare r public.case_requests; answer text:=btrim(target_answer);
begin
 select * into r from public.case_requests where id=target_request and case_id=target_case for update;
 if not found or r.answered_at is not null or r.expired_at is not null or r.expires_at<=clock_timestamp() then return; end if;
 if answer is null or char_length(answer) not between 1 and 2000 or r.answer_kind='document'
  or (r.answer_kind='choice' and not coalesce(answer=any(r.options),false))
  or (r.answer_kind='number' and answer!~'^-?[0-9]{1,9}([.][0-9]{1,4})?$') then raise exception 'REQUEST_ANSWER_INVALID'; end if;
 if r.code='regular_day_hours_unknown' and (answer::numeric<=0 or answer::numeric>24) then raise exception 'REQUEST_ANSWER_INVALID'; end if;
 if r.answer_kind='number' and r.code like 'low_confidence:%' and answer::numeric<0 then raise exception 'REQUEST_ANSWER_INVALID'; end if;
 return query update public.case_requests set answered_at=clock_timestamp(),answer_text=answer where id=r.id returning *;
end;
$$;
-- Bounded sweep. Repeated workers/restarts cannot produce a second reminder.
-- This queues intent only; P07's delivery adapter records provider outcomes.
create function public.case_request_sweep(observed_now timestamptz, batch_limit integer default 100) returns integer
language plpgsql security invoker set search_path='' as $$
declare r public.case_requests; n integer:=0;
begin
 if batch_limit not between 1 and 1000 or observed_now is null then raise exception 'REQUEST_SWEEP_INVALID'; end if;
 for r in select * from public.case_requests where answered_at is null and expired_at is null
  and (expires_at<=observed_now or (blocking and opened_at+interval '48 hours'<=observed_now
   and not exists(select 1 from private.case_request_events e where e.request_id=case_requests.id
    and e.kind=case when opened_at+interval '5 days'<=observed_now then 'reminder_5d' else 'reminder_48h' end)))
  order by expires_at,id limit batch_limit for update skip locked loop
  if r.expires_at<=observed_now then
   update public.case_requests set expired_at=observed_now where id=r.id;
   insert into private.case_request_events(request_id,case_id,kind,occurred_at) values(r.id,r.case_id,'expired',observed_now) on conflict do nothing;
  elsif r.blocking then
   insert into private.case_request_events(request_id,case_id,kind,occurred_at) values(r.id,r.case_id,case when r.opened_at+interval '5 days'<=observed_now then 'reminder_5d' else 'reminder_48h' end,observed_now) on conflict do nothing;
  end if;
  n:=n+1;
 end loop;
 return n;
end;
$$;
revoke all on function public.case_request_sweep(timestamptz,integer) from public,anon,authenticated,service_role,tivdoc_web_runtime;
grant execute on function public.case_request_sweep(timestamptz,integer) to tivdoc_worker_runtime;
revoke all on function public.case_request_answer(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.case_request_answer(uuid,uuid,text) to tivdoc_web_runtime,service_role;
-- Uploaded documents may still be saved after a linked request expires; the
-- expired request stays terminal, and a newer request is never auto-answered.
do $upgrade$ declare definition text; begin
 definition:=pg_get_functiondef('public.case_documents_commit(uuid,uuid,jsonb)'::regprocedure);
 if position('and case_id = target_case and answered_at is null;' in definition)=0 then raise exception 'UPLOAD_COMMIT_UPGRADE_BASE_MISMATCH'; end if;
 definition:=replace(definition,'and case_id = target_case and answered_at is null;',
  'and case_id = target_case and answered_at is null and expired_at is null and expires_at > now();');
 definition:=replace(definition,$old$if not found then raise exception 'UPLOAD_REQUEST_CONFLICT'; end if;$old$,
  $new$if not found and not exists(select 1 from public.case_requests where id=(b.manifest->>'requestId')::uuid and case_id=target_case and (expired_at is not null or expires_at<=now())) then raise exception 'UPLOAD_REQUEST_CONFLICT'; end if;$new$);
 execute definition;
end $upgrade$;
