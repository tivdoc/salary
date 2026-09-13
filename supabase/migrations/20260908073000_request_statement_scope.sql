-- Forward-only: older questions have no provable statement month. Do not
-- backfill it from a case whose selected month may have changed since asking.
alter table public.case_requests add column statement_month text
 check(statement_month is null or statement_month ~ '^\d{4}-(0[1-9]|1[0-2])$');
create function private.pin_request_statement_month() returns trigger
 language plpgsql security invoker set search_path='' as $$
begin
 if tg_op='INSERT' then
  select to_char(c.check_period_month,'YYYY-MM') into new.statement_month from public.cases c where c.id=new.case_id;
  if not found then raise exception 'REQUEST_SCOPE_UNKNOWN'; end if;
 elsif new.case_id is distinct from old.case_id or new.statement_month is distinct from old.statement_month then
  raise exception 'REQUEST_STATEMENT_SCOPE_IMMUTABLE';
 end if;
 return new;
end;
$$;
revoke all on function private.pin_request_statement_month() from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger pin_request_statement_month before insert or update on public.case_requests
 for each row execute function private.pin_request_statement_month();

-- Existing capture owner/ACL and original journal bytes remain unchanged.
do $$
declare definition text; needle text:=$old$'id',r.id,'code',r.code,$old$;
begin
 definition:=pg_get_functiondef('private.capture_case_input(uuid,text)'::regprocedure);
 if position(needle in definition)=0 then raise exception 'REQUEST_SOURCE_CAPTURE_BASE_MISMATCH'; end if;
 definition:=replace(definition,needle,$new$'id',r.id,'case_id',r.case_id,'scope_month',r.statement_month,
  'answer_kind',r.answer_kind,'answer_revision',coalesce((select max(a.revision) from private.case_request_answer_versions a where a.request_id=r.id),1),
  'answer_created_at',coalesce((select a.created_at from private.case_request_answer_versions a where a.request_id=r.id order by a.revision desc limit 1),r.answered_at),
  'code',r.code,$new$);
 execute definition;
end;
$$;
