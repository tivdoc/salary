-- Derived current-source state, never rewrite the question or answer journal.
create function public.case_request_field_states(target_case uuid,target_identity uuid)
returns table(request_id uuid,source_current boolean)
language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.case_identity_cases l where l.case_id=target_case and l.identity_id=target_identity)
 then raise exception 'REQUEST_FIELD_FORBIDDEN';end if;
 return query select r.id,coalesce(private.document_field_current(target_case,t.target),false)
 from public.case_requests r left join private.document_field_targets t on t.request_id=r.id and t.case_id=r.case_id
 where r.case_id=target_case and r.code like 'document_field:%';
end;$$;
revoke all on function public.case_request_field_states(uuid,uuid) from public,anon,authenticated,tivdoc_worker_runtime,tivdoc_operations_runtime;
grant execute on function public.case_request_field_states(uuid,uuid) to tivdoc_web_runtime,service_role;
