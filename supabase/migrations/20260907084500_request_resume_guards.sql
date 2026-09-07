-- A closed request must not prevent a later, independently identified request.
drop index public.case_requests_one_open_per_code;
create unique index case_requests_one_open_per_code on public.case_requests(case_id,code) where answered_at is null and expired_at is null;
do $upgrade$ declare definition text; begin
 definition:=pg_get_functiondef('public.case_documents_snapshot(uuid)'::regprocedure);
 definition:=replace(definition,'r.case_id = target_case and r.answered_at is null',
 'r.case_id = target_case and r.answered_at is null and r.expired_at is null and r.expires_at > now()');
 execute definition;
 definition:=pg_get_functiondef('public.case_documents_reserve(uuid,uuid,jsonb)'::regprocedure);
 definition:=replace(definition,'and case_id = target_case and answered_at is null and answer_kind',
 'and case_id = target_case and answered_at is null and expired_at is null and expires_at > now() and answer_kind');
 execute definition;
end $upgrade$;
