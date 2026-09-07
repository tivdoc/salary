-- P02: read actual published projections, scoped to the verified identity's case.
-- No grant to write projections or to activate a legal topic is introduced.
alter table public.case_report_projections add column report_document jsonb;
alter table public.case_report_projections add constraint report_document_v2_shape
 check (report_document is null or coalesce((report_document->>'schema_version'='tivdoc-report-document-v2'
   and report_document->>'case_id'=case_id::text and report_document->>'id'=id::text),false));
grant select on public.case_report_projections,public.case_report_qa,public.case_identity_cases to service_role,tivdoc_web_runtime;
create policy case_report_projection_service_read on public.case_report_projections for select to service_role using(true);
create function public.case_report_customer_snapshot(target_case uuid,target_identity uuid) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare c public.cases;
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'REPORT_FORBIDDEN'; end if;
 select * into strict c from public.cases where id=target_case;
 return jsonb_build_object('caseId',c.id,'publicId',c.public_id,'checkPeriodMonth',to_char(c.check_period_month,'YYYY-MM'),
 'reports',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'projection',p.projection,'document',p.report_document,'sha256',p.projection_sha256,'publishedAt',q.published_at) order by q.published_at desc)
 from public.case_report_projections p join public.case_report_qa q on q.projection_id=p.id and q.case_id=p.case_id
 where p.case_id=target_case and p.superseded_at is null and q.state='published' and q.published_at is not null
 and exists(select 1 from jsonb_array_elements(p.projection->'topics') t where t->>'gate'='checked')), '[]'::jsonb));
end;
$$;
revoke all on function public.case_report_customer_snapshot(uuid,uuid) from public,anon,authenticated;
grant execute on function public.case_report_customer_snapshot(uuid,uuid) to service_role,tivdoc_web_runtime;
-- Reject unsafe new projections at the SQL boundary too; historical rows are
-- not rewritten and the reader revalidates them before displaying anything.
create function public.case_report_contract_valid(p jsonb) returns boolean
language plpgsql immutable security invoker set search_path='' as $$
declare t jsonb; checked_count int:=0;
begin
 if jsonb_typeof(p->'topics') is distinct from 'array' then return false; end if;
 for t in select value from jsonb_array_elements(p->'topics') loop
  if t->>'activation'='active' and exists(select 1 from jsonb_each_text(t->'parameter_grades') g where g.value<>'active') then return false; end if;
  if t->>'gate'='checked' then
   checked_count:=checked_count+1;
   if t->>'certainty'='low' and (coalesce(t->'amount','null')<>'null'::jsonb or coalesce(t->'range','null')<>'null'::jsonb) then return false; end if;
   if p->>'report_kind'='initial' and t->>'basis_complete' is distinct from 'true' and (coalesce(t->'amount','null')<>'null'::jsonb or coalesce(t->'range','null')<>'null'::jsonb) then return false; end if;
   if t->'range'<>'null'::jsonb and (t#>>'{range,low,minor_units}')::numeric>(t#>>'{range,high,minor_units}')::numeric then return false; end if;
  end if;
 end loop;
 return coalesce(p->>'report_kind'<>'initial' or (checked_count<=3 and jsonb_array_length(p->'months_covered')=1),false);
end;
$$;
revoke all on function public.case_report_contract_valid(jsonb) from public,anon,authenticated;
grant execute on function public.case_report_contract_valid(jsonb) to service_role,tivdoc_web_runtime,tivdoc_operations_runtime,tivdoc_worker_runtime;
alter table public.case_report_projections add constraint case_report_safe_display check(public.case_report_contract_valid(projection)) not valid;
create function private.case_report_require_checked_before_publish() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.state='published' and not exists(select 1 from public.case_report_projections p,jsonb_array_elements(p.projection->'topics') t where p.id=new.projection_id and p.case_id=new.case_id and t->>'gate'='checked') then raise exception 'REPORT_NO_CHECKED_TOPICS'; end if;
 return new;
end;
$$;
revoke all on function private.case_report_require_checked_before_publish() from public,anon,authenticated;
create trigger case_report_require_checked_before_publish before insert or update on public.case_report_qa for each row execute function private.case_report_require_checked_before_publish();
