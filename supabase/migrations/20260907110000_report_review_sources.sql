-- Authenticated operators may inspect only evidence pinned to the reviewed row.
create policy report_source_owner_read on public.document_versions for select to CURRENT_USER using(true);
create policy report_source_current_owner_read on public.documents for select to CURRENT_USER using(true);
create function public.case_report_qa_source(target_qa uuid,target_version uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare c uuid;evidence jsonb;source jsonb;
begin
 select p.case_id,e into c,evidence from public.case_report_qa q join public.case_report_projections p on p.id=q.projection_id and p.case_id=q.case_id cross join lateral jsonb_array_elements(p.report_document->'evidence') e where q.id=target_qa and e->>'version_id'=target_version::text limit 1;
 if evidence is null then raise exception 'REPORT_SOURCE_FORBIDDEN';end if;
 select jsonb_build_object('path',v.storage_path,'mime',v.mime_type,'size',v.size,'sha256',evidence->>'sha256') into source from public.document_versions v where v.case_id=c and v.version_id=target_version and v.document_id::text=evidence->>'document_id';
 if source is null then select jsonb_build_object('path',d.storage_path,'mime',d.mime_type,'size',d.size,'sha256',evidence->>'sha256') into source from public.documents d where d.case_id=c and d.version_id=target_version and d.id::text=evidence->>'document_id';end if;
 if source is null then raise exception 'REPORT_SOURCE_MISSING';end if;return source;
end;
$$;
revoke all on function public.case_report_qa_source(uuid,uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime;
grant execute on function public.case_report_qa_source(uuid,uuid) to tivdoc_operations_runtime;
