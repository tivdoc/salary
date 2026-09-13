-- A hold cannot promise retention once an orphan removal is already in flight.
create function private.retention_hold_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='UPDATE' and new.case_id is distinct from old.case_id then raise exception 'RETENTION_HOLD_CASE_IMMUTABLE';end if;
 perform 1 from public.cases where id=new.case_id for update;
 if new.released_at is null and exists(select 1 from private.storage_gc_candidates where case_id=new.case_id and state='deleting') then raise exception 'RETENTION_GC_IN_PROGRESS';end if;
 return new;
end;$$;
create trigger retention_hold_serialized before insert or update on private.case_retention_holds for each row execute function private.retention_hold_guard();
create table private.privacy_cleanup_events(id bigint generated always as identity primary key,request_sha256 text not null,policy_version text not null,action text not null,at timestamptz not null default now());
revoke all on private.privacy_cleanup_events from public,anon,authenticated,service_role,tivdoc_web_runtime;
grant select on private.privacy_cleanup_events to tivdoc_operations_runtime,tivdoc_worker_runtime;
create or replace function public.case_privacy_draft_sweep(target_limit integer default 100) returns integer language plpgsql security definer set search_path='' as $$
declare target record; removed uuid; total integer:=0;
begin
 -- Always acquire the case lock before the draft lock, matching answer/hold writers.
 for target in select c.id from public.cases c where exists(select 1 from public.case_requests r join private.case_request_drafts d on d.request_id=r.id where r.case_id=c.id and d.updated_at<now()-interval '30 days' and (r.answered_at is not null or r.expired_at is not null)) order by c.id limit greatest(1,least(target_limit,1000)) for update of c skip locked loop
  if exists(select 1 from private.case_retention_holds where case_id=target.id and released_at is null) then continue;end if;
  for removed in delete from private.case_request_drafts d using public.case_requests r where r.id=d.request_id and r.case_id=target.id and d.updated_at<now()-interval '30 days' and (r.answered_at is not null or r.expired_at is not null) returning d.request_id loop
   insert into private.privacy_cleanup_events(request_sha256,policy_version,action) values(encode(sha256(convert_to(removed::text,'UTF8')),'hex'),'tivdoc-retention-v1','terminal_draft_deleted');
   total:=total+1;
  end loop;
 end loop;
 return total;
end;$$;
