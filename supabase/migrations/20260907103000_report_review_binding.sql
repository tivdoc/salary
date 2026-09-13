-- P08 approvals bind the entire saved report, wording and source revision.
alter table public.case_report_qa add column approval_fingerprint text,add column assigned_to text;
alter table public.case_report_qa drop constraint case_report_qa_published_pairing_check;
alter table public.case_report_qa add constraint case_report_qa_published_pairing_check check(state<>'published' or published_at is not null);
-- A narrow definer reads/locks source state; it never accepts a client identity.
create policy report_release_owner_read on public.case_report_projections for select to CURRENT_USER using(true);
create policy report_release_qa_owner_read on public.case_report_qa for select to CURRENT_USER using(true);
create function private.report_review_fingerprint(target_qa uuid) returns text language sql security definer set search_path='' as $$
 select encode(sha256(convert_to(jsonb_build_object('case',q.case_id,'projection',p.projection,'document',p.report_document,'input_revision',p.input_revision,'wording',q.wording)::text,'UTF8')),'hex')
 from public.case_report_qa q join public.case_report_projections p on p.id=q.projection_id and p.case_id=q.case_id where q.id=target_qa;
$$;
revoke all on function private.report_review_fingerprint(uuid) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime;
grant execute on function private.report_review_fingerprint(uuid) to tivdoc_operations_runtime;
create or replace function private.case_report_current_input() returns trigger language plpgsql security definer set search_path='' as $$
declare expected integer; actual integer; p public.case_report_projections;
begin
 if new.state in ('approved','published') then
  perform 1 from public.cases where id=new.case_id for update;
  select revision into expected from private.case_input_heads where case_id=new.case_id;
  select * into p from public.case_report_projections where id=new.projection_id and case_id=new.case_id;
  if not found or p.report_kind<>new.report_kind then raise exception 'REPORT_SCOPE_MISMATCH'; end if;
  if new.state='approved' and not pg_has_role(session_user,'tivdoc_operations_runtime','member') then raise exception 'REPORT_HUMAN_ROLE_REQUIRED'; end if;
  actual:=p.input_revision;
  if expected is not null and actual is distinct from expected then raise exception 'REPORT_INPUT_STALE'; end if;
  if new.state='published' and TG_OP='INSERT' then
   if new.report_kind<>'initial' or new.document_track<>'automatic' or cardinality(new.queue_reasons)>0 or new.operator_identity<>'system:publication_gate'
    or exists(select 1 from jsonb_array_elements(p.projection->'topics') t where t->>'certainty'='low' or t::text like '%fact.conflicted%' or abs(coalesce((t->'amount'->>'minor_units')::numeric,0))>500000 or abs(coalesce((t->'range'->'high'->>'minor_units')::numeric,0))>500000)
   then raise exception 'REPORT_HUMAN_APPROVAL_REQUIRED'; end if;
  elsif new.state='published' then
   if old.state<>'approved' or old.approval_fingerprint is null or old.approval_fingerprint is distinct from private.report_review_fingerprint(new.id) then raise exception 'REPORT_APPROVAL_REQUIRED'; end if;
  end if;
 end if;
 return new;
end;
$$;
create function private.report_published_immutable() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if (new.projection,new.report_document,new.input_revision,new.projection_sha256,new.case_id) is distinct from (old.projection,old.report_document,old.input_revision,old.projection_sha256,old.case_id)
 and exists(select 1 from public.case_report_qa where projection_id=old.id and (state='approved' or published_at is not null)) then raise exception 'REPORT_APPEND_REVISION_REQUIRED'; end if;
 return new;
end;
$$;
revoke all on function private.report_published_immutable() from public,anon,authenticated,service_role;
create trigger report_published_immutable before update on public.case_report_projections for each row execute function private.report_published_immutable();
create function public.case_report_qa_detail(target_qa uuid) returns jsonb language sql security invoker set search_path='' as $$
 select jsonb_build_object('row',to_jsonb(q),'projection',p.projection,'document',p.report_document,'fingerprint',private.report_review_fingerprint(q.id))
 from public.case_report_qa q join public.case_report_projections p on p.id=q.projection_id and p.case_id=q.case_id where q.id=target_qa;
$$;
create function public.case_report_qa_decide_bound(target_qa uuid,target_state text,target_actor text,target_review_seconds integer,target_fingerprint text) returns setof public.case_report_qa
language plpgsql security invoker set search_path='' as $$
declare q public.case_report_qa;
begin
 if target_state not in ('approved','published','rejected') or target_actor is null or length(trim(target_actor))<2 or target_actor like 'system:%' then raise exception 'REPORT_HUMAN_ACTOR_REQUIRED'; end if;
 select * into q from public.case_report_qa where id=target_qa for update;
 if not found then return; end if;
 if target_fingerprint is null or target_fingerprint is distinct from private.report_review_fingerprint(target_qa) then raise exception 'REPORT_REVIEW_STALE'; end if;
 if q.state=target_state then return next q;return;end if;
 if q.published_at is not null then raise exception 'REPORT_APPEND_REVISION_REQUIRED'; end if;
 if target_state='published' and q.state<>'approved' then raise exception 'REPORT_APPROVAL_REQUIRED'; end if;
 update public.case_report_qa set state=target_state,operator_identity=target_actor,review_seconds=coalesce(target_review_seconds,review_seconds),decided_at=now(),
 approval_fingerprint=case when target_state='approved' then target_fingerprint else approval_fingerprint end,
 published_at=case when target_state='published' then now() else published_at end where id=target_qa;
 insert into public.case_report_qa_log(qa_id,case_id,action,operator_identity,detail) values(q.id,q.case_id,target_state,target_actor,jsonb_build_object('fingerprint',target_fingerprint));
 return query select * from public.case_report_qa where id=target_qa;
end;
$$;
create function public.case_report_qa_assign(target_qa uuid,target_actor text) returns void language plpgsql security invoker set search_path='' as $$
begin
 update public.case_report_qa set assigned_to=target_actor where id=target_qa and state in ('queued','approved','recheck_required');
 if not found then raise exception 'REPORT_NOT_OPEN'; end if;
 insert into public.case_report_qa_log(qa_id,case_id,action,operator_identity,detail) select id,case_id,'queued',target_actor,jsonb_build_object('assignment',target_actor) from public.case_report_qa where id=target_qa;
end;
$$;
revoke all on function public.case_report_qa_decide(uuid,text,text,integer) from public,anon,authenticated,service_role,tivdoc_operations_runtime,tivdoc_worker_runtime,tivdoc_web_runtime;
revoke all on function public.case_report_qa_detail(uuid),public.case_report_qa_decide_bound(uuid,text,text,integer,text),public.case_report_qa_assign(uuid,text) from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime;
grant execute on function public.case_report_qa_detail(uuid),public.case_report_qa_decide_bound(uuid,text,text,integer,text),public.case_report_qa_assign(uuid,text) to tivdoc_operations_runtime;
-- Historical published versions remain readable while a new input is reviewed.
create or replace function public.case_report_customer_snapshot(target_case uuid,target_identity uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare c public.cases;
begin
 if not exists(select 1 from public.case_identity_cases where case_id=target_case and identity_id=target_identity) then raise exception 'REPORT_FORBIDDEN'; end if;
 select * into strict c from public.cases where id=target_case;
 return jsonb_build_object('caseId',c.id,'publicId',c.public_id,'checkPeriodMonth',to_char(c.check_period_month,'YYYY-MM'),
 'reports',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'projection',p.projection,'document',case when p.report_document is null then null else jsonb_set(p.report_document,'{publication}',jsonb_build_object('state',case when p.superseded_at is not null then 'superseded' else 'published' end,'approved_input_sha256',p.report_document->>'input_sha256','approval_actor_kind',case when q.operator_identity='system:publication_gate' then 'automation' else 'human' end,'published_at',to_char(q.published_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) end,
 'sha256',p.projection_sha256,'publishedAt',q.published_at,'state',case when p.superseded_at is not null then 'superseded' else q.state end,'wording',q.wording) order by q.published_at desc)
 from public.case_report_projections p join public.case_report_qa q on q.projection_id=p.id and q.case_id=p.case_id where p.case_id=target_case and q.published_at is not null
 and exists(select 1 from jsonb_array_elements(p.projection->'topics') t where t->>'gate'='checked')),'[]'::jsonb));
end;
$$;
