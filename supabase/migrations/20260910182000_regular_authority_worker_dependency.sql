-- Invalidation metadata only: no source edit, legal approval or new queue.
alter table private.case_analysis_dispatch add column authority_dependency_sha256 text
 check(authority_dependency_sha256 is null or authority_dependency_sha256 ~ '^[a-f0-9]{64}$');
revoke update on private.case_analysis_dispatch from tivdoc_worker_runtime;
grant update(job_id,dispatched_at) on private.case_analysis_dispatch to tivdoc_worker_runtime;

create function private.june2026_regular_dependency_refresh(target_case uuid) returns void
 language plpgsql security invoker set search_path='' as $$
declare token text;
begin
 -- Append already owns registry/assessment locks. Never wait in the reverse
 -- order of a worker's case->registry locks. Admin retries SQL55P03 atomically.
 perform 1 from public.cases where id=target_case for update nowait;
 if not found then return;end if;
 select encode(sha256(convert_to(coalesce(jsonb_agg(jsonb_build_object(
  'assessment',a.id,'sha',a.payload_sha256,'revoked',a.revoked_at,
  'registry',a.registry_key,'registry_revision',r.revision,'registry_sha',r.payload_sha256)
  order by a.order_id,a.id),'[]'::jsonb)::text,'UTF8')),'hex') into token
 from private.case_input_heads h join private.june2026_regular_assessments a
  on a.case_id=h.case_id and a.input_revision=h.revision and a.input_sha256=h.input_sha256
 left join lateral(select revision,payload_sha256 from private.june2026_authority_registries
  where registry_key=a.registry_key order by revision desc limit 1) r on true
 where h.case_id=target_case;
 update private.case_analysis_dispatch d set authority_dependency_sha256=token,job_id=null,dispatched_at=null
 from private.case_input_heads h where d.case_id=target_case and h.case_id=d.case_id
  and h.revision=d.revision and d.mode='draft' and d.authority_dependency_sha256 is distinct from token;
end;$$;
create function private.june2026_regular_dependency_changed() returns trigger
 language plpgsql security invoker set search_path='' as $$
declare target uuid;
begin
 if tg_table_name='june2026_regular_assessments' then
  if exists(select 1 from private.case_input_heads where case_id=new.case_id and revision=new.input_revision and input_sha256=new.input_sha256) then
   perform private.june2026_regular_dependency_refresh(new.case_id);
  end if;
 else
  for target in select distinct a.case_id from private.june2026_regular_assessments a
   join private.case_input_heads h on h.case_id=a.case_id and h.revision=a.input_revision and h.input_sha256=a.input_sha256
   where a.registry_key=new.registry_key order by a.case_id loop
   perform private.june2026_regular_dependency_refresh(target);
  end loop;
 end if;
 return new;
end;$$;
revoke all on function private.june2026_regular_dependency_refresh(uuid),private.june2026_regular_dependency_changed()
 from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
create trigger june_regular_dependency_assessment after insert or update of revoked_at on private.june2026_regular_assessments
 for each row execute function private.june2026_regular_dependency_changed();
create trigger june_regular_dependency_registry after insert on private.june2026_authority_registries
 for each row execute function private.june2026_regular_dependency_changed();

-- Preserve existing function ownership and all other scope/lease/cost guards.
do $migration$
declare original text;body text;signature text;
begin
 foreach signature in array array['private.managed_dev_worker_enrollment_guard()','private.managed_dev_worker_candidates(text,integer)'] loop
  select pg_get_functiondef(signature::regprocedure) into original;
  body:=replace(original,'o.kind=''initial''','(o.kind=''initial'' or (o.kind=''full'' and o.offer->>''service_kind''=''ai_assisted'' and o.offer->''human_review_required''=''false''::jsonb and o.offer->>''version''=''tivdoc-order-offer-v2''))');
  if body=original then raise exception 'REGULAR_FULL_MANAGED_ANCHOR';end if;execute body;
 end loop;
 foreach signature in array array['private.managed_dev_worker_admit_claim(uuid,text,bigint)','private.managed_dev_worker_note(uuid,text,bigint,text)'] loop
  select pg_get_functiondef(signature::regprocedure) into original;
  body:=replace(original,'j.payload->>''input_sha256''=h.input_sha256',
   'j.payload->>''input_sha256''=h.input_sha256 and exists(select 1 from private.case_analysis_dispatch dep where dep.case_id=target_case and dep.revision=h.revision and dep.mode=''draft'' and dep.job_id=j.job_id and dep.authority_dependency_sha256 is not distinct from j.payload->>''authority_dependency_sha256'')');
  if body=original then raise exception 'REGULAR_MANAGED_DEPENDENCY_ANCHOR';end if;execute body;
 end loop;
 select pg_get_functiondef('private.managed_dev_worker_status(text)'::regprocedure) into original;
 body:=replace(original,'when j.state=''succeeded'' and f.payload#>>''{calculation,state}''=''calculated'' then ''complete''',
  'when j.state=''succeeded'' and (f.payload#>>''{calculation,state}''=''calculated'' or regular.projection_id is not null) then ''complete''');
 body:=replace(body,'when j.state=''succeeded'' and f.id is null then ''canonical_activation_blocked''',
  'when j.state=''succeeded'' and f.id is null and regular.projection_id is null then ''canonical_activation_blocked''');
 body:=replace(body,'f.id,coalesce(r.last_checked_at,r.created_at)','coalesce(regular.analysis_run_id,f.id),coalesce(r.last_checked_at,r.created_at)');
 body:=replace(body,'where r.capability_sha256=digest order by r.created_at,r.case_id limit 20;',
  'left join lateral(select rr.analysis_run_id,rr.projection_id from private.june2026_regular_results rr where rr.case_id=r.case_id and rr.input_revision=h.revision and rr.input_sha256=h.input_sha256 and private.june2026_regular_publication_current(rr.projection_id) order by rr.created_at desc,rr.analysis_run_id limit 1) regular on true where r.capability_sha256=digest order by r.created_at,r.case_id limit 20;');
 if body=original or position('regular on true' in body)=0 then raise exception 'REGULAR_MANAGED_STATUS_ANCHOR';end if;execute body;
end $migration$;
