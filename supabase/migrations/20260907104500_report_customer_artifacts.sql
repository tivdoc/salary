-- A saved report authorizes its own pinned source, including retained versions.
create function public.case_report_source(target_case uuid,target_identity uuid,target_report uuid,target_version uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare evidence jsonb; source jsonb;
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'REPORT_FORBIDDEN'; end if;
 select e into evidence from public.case_report_projections p join public.case_report_qa q on q.projection_id=p.id and q.case_id=p.case_id cross join lateral jsonb_array_elements(p.report_document->'evidence') e
 where p.id=target_report and p.case_id=target_case and q.published_at is not null and e->>'version_id'=target_version::text limit 1;
 if evidence is null then raise exception 'REPORT_SOURCE_FORBIDDEN'; end if;
 select jsonb_build_object('path',v.storage_path,'mime',v.mime_type,'size',v.size,'sha256',evidence->>'sha256') into source from public.document_versions v
 where v.version_id=target_version and v.case_id=target_case and v.document_id::text=evidence->>'document_id';
 if source is null then select jsonb_build_object('path',d.storage_path,'mime',d.mime_type,'size',d.size,'sha256',evidence->>'sha256') into source from public.documents d where d.version_id=target_version and d.case_id=target_case and d.id::text=evidence->>'document_id'; end if;
 if source is null then raise exception 'REPORT_SOURCE_MISSING'; end if; return source;
end;
$$;
revoke all on function public.case_report_source(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.case_report_source(uuid,uuid,uuid,uuid) to service_role,tivdoc_web_runtime;
create table private.case_report_corrections(id uuid primary key,case_id uuid not null references public.cases(id) on delete cascade,report_id uuid not null references public.case_report_projections(id) on delete cascade,finding_id uuid not null,identity_id uuid not null references public.case_identities(id),message text not null check(length(message) between 4 and 2000),state text not null default 'pending' check(state in ('pending','in_review','resolved')),created_at timestamptz not null default now());
revoke all on private.case_report_corrections from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime;
grant select on private.case_report_corrections to tivdoc_operations_runtime;
create function public.case_report_correction_submit(target_id uuid,target_case uuid,target_identity uuid,target_report uuid,target_finding uuid,target_message text) returns uuid language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'REPORT_FORBIDDEN'; end if;
 if not exists(select 1 from public.case_report_projections p join public.case_report_qa q on q.projection_id=p.id and q.case_id=p.case_id cross join lateral jsonb_array_elements(p.report_document->'findings') f where p.id=target_report and p.case_id=target_case and q.published_at is not null and f->>'id'=target_finding::text) then raise exception 'REPORT_FINDING_FORBIDDEN'; end if;
 insert into private.case_report_corrections(id,case_id,report_id,finding_id,identity_id,message) values(target_id,target_case,target_report,target_finding,target_identity,trim(target_message)) on conflict(id) do nothing;
 if not exists(select 1 from private.case_report_corrections where id=target_id and case_id=target_case and report_id=target_report and finding_id=target_finding and identity_id=target_identity and message=trim(target_message)) then raise exception 'REPORT_CORRECTION_CONFLICT'; end if;
 return target_id;
end;
$$;
revoke all on function public.case_report_correction_submit(uuid,uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.case_report_correction_submit(uuid,uuid,uuid,uuid,uuid,text) to service_role,tivdoc_web_runtime;
-- No correction text changes a computed fact or an approval by itself.
do $upgrade$ declare definition text; begin
 definition:=pg_get_functiondef('public.case_report_qa_detail(uuid)'::regprocedure);
 definition:=replace(definition,$old$'fingerprint',private.report_review_fingerprint(q.id)$old$,$new$'fingerprint',private.report_review_fingerprint(q.id),'corrections',coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at) from private.case_report_corrections c where c.report_id=p.id),'[]'::jsonb)$new$);execute definition;
end $upgrade$;
