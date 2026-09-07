-- P06: customer drafts and append-only corrections, preserving the first answer.
create table private.case_request_answer_versions (
 request_id uuid not null references public.case_requests(id) on delete cascade,
 revision integer not null check(revision>0), answer_text text not null check(char_length(answer_text) between 1 and 2000),
 identity_id uuid references public.case_identities(id), origin text not null check(origin in ('original','correction')),
 created_at timestamptz not null default now(), primary key(request_id,revision)
);
create table private.case_request_drafts (
 request_id uuid primary key references public.case_requests(id) on delete cascade,
 identity_id uuid not null references public.case_identities(id), revision integer not null check(revision>0),
 answer_text text not null check(char_length(answer_text)<=2000), updated_at timestamptz not null default now()
);
revoke all on private.case_request_answer_versions,private.case_request_drafts from public,anon,authenticated,service_role;
revoke all on private.case_request_answer_versions,private.case_request_drafts from tivdoc_web_runtime;
-- Restricted definer wrappers also support the hosted service-role adapter.
create function public.case_request_edit(target_case uuid,target_request uuid,target_identity uuid,target_answer text,expected_revision integer,edit_kind text) returns integer
language plpgsql security definer set search_path='' as $$
declare r public.case_requests; current_revision integer; answer text:=btrim(target_answer);
begin
 if not exists(select 1 from public.case_identity_cases where identity_id=target_identity and case_id=target_case) then raise exception 'REQUEST_FORBIDDEN'; end if;
 perform 1 from public.cases where id=target_case for update;
 select * into r from public.case_requests where id=target_request and case_id=target_case for update;
 if not found or r.answer_kind='document' or edit_kind not in ('draft','correction') or expected_revision<0 or target_answer is null or char_length(target_answer)>2000 then raise exception 'REQUEST_EDIT_INVALID'; end if;
 if edit_kind='draft' then
  if r.expired_at is not null or (r.answered_at is null and r.expires_at<=now()) then raise exception 'REQUEST_EDIT_CLOSED'; end if;
  select coalesce(max(revision),0) into current_revision from private.case_request_drafts where request_id=r.id;
  if current_revision<>expected_revision then raise exception 'REQUEST_EDIT_CONFLICT'; end if;
  insert into private.case_request_drafts(request_id,identity_id,revision,answer_text) values(r.id,target_identity,current_revision+1,target_answer)
   on conflict(request_id) do update set identity_id=excluded.identity_id,revision=excluded.revision,answer_text=excluded.answer_text,updated_at=now();
 else
  if r.answered_at is null or r.expired_at is not null or char_length(answer)<1
   or (r.answer_kind='choice' and not coalesce(answer=any(r.options),false))
   or (r.answer_kind='number' and answer!~'^-?[0-9]{1,9}([.][0-9]{1,4})?$') then raise exception 'REQUEST_ANSWER_INVALID'; end if;
  if r.code='regular_day_hours_unknown' and (answer::numeric<=0 or answer::numeric>24) then raise exception 'REQUEST_ANSWER_INVALID'; end if;
  if r.answer_kind='number' and r.code like 'low_confidence:%' and answer::numeric<0 then raise exception 'REQUEST_ANSWER_INVALID'; end if;
  select coalesce(max(revision),0) into current_revision from private.case_request_answer_versions where request_id=r.id;
  if current_revision<>expected_revision then raise exception 'REQUEST_EDIT_CONFLICT'; end if;
  insert into private.case_request_answer_versions(request_id,revision,answer_text,identity_id,origin) values(r.id,current_revision+1,answer,target_identity,'correction');
  delete from private.case_request_drafts where request_id=r.id;
 end if;
 return current_revision+1;
end;
$$;
-- FORCE RLS: only the schema owner inside the exact scoped definer may edit.
do $$ begin execute format('create policy request_edit_owner on public.case_requests for update to %I using(true) with check(true)',current_user); end $$;
create function private.case_request_record_original() returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.answered_at is null and new.answered_at is not null then
  insert into private.case_request_answer_versions(request_id,revision,answer_text,origin) values(new.id,1,new.answer_text,'original');
  delete from private.case_request_drafts where request_id=new.id;
 end if;
 return null;
end;
$$;
create trigger case_request_record_original after update of answer_text on public.case_requests for each row execute function private.case_request_record_original();
insert into private.case_request_answer_versions(request_id,revision,answer_text,origin) select id,1,answer_text,'original' from public.case_requests where answered_at is not null;
create function public.case_request_revision_list(target_case uuid) returns table(request_id uuid,answer_revision integer,latest_answer text,draft_revision integer,draft_text text)
language plpgsql security definer set search_path='' as $$
begin
 return query select r.id,coalesce(v.revision,0),v.answer_text,coalesce(d.revision,0),d.answer_text
 from public.case_requests r left join lateral(select a.revision,a.answer_text from private.case_request_answer_versions a where a.request_id=r.id order by a.revision desc limit 1) v on true
 left join private.case_request_drafts d on d.request_id=r.id where r.case_id=target_case;
end;
$$;
revoke all on function public.case_request_edit(uuid,uuid,uuid,text,integer,text),public.case_request_revision_list(uuid),private.case_request_record_original() from public,anon,authenticated;
grant execute on function public.case_request_edit(uuid,uuid,uuid,text,integer,text),public.case_request_revision_list(uuid) to tivdoc_web_runtime,service_role;
-- A corrected answer invalidates analysis through the SAME source journal.
do $upgrade$ declare definition text; begin
 definition:=pg_get_functiondef('private.capture_case_input(uuid,text)'::regprocedure);
 if position($old$'answer',r.answer_text$old$ in definition)=0 then raise exception 'SOURCE_CAPTURE_UPGRADE_BASE_MISMATCH'; end if;
 definition:=replace(definition,$old$'answer',r.answer_text$old$,$new$'answer',coalesce((select v.answer_text from private.case_request_answer_versions v where v.request_id=r.id order by v.revision desc limit 1),r.answer_text)$new$);
 execute definition;
end $upgrade$;
create function private.case_request_capture_correction() returns trigger language plpgsql security definer set search_path='' as $$
declare target_case uuid;
begin
 select case_id into target_case from public.case_requests where id=new.request_id;
 perform private.capture_case_input(target_case,'answer_revision');
 return null;
end;
$$;
revoke all on function private.case_request_capture_correction() from public,anon,authenticated,service_role;
create trigger case_request_capture_correction after insert on private.case_request_answer_versions for each row execute function private.case_request_capture_correction();

-- Preserve the case-before-request lock order used by document completion.
do $upgrade$ declare definition text; begin
 definition:=pg_get_functiondef('public.case_request_answer(uuid,uuid,text)'::regprocedure);
 definition:=replace(definition,' select * into r from public.case_requests',E' perform 1 from public.cases where id=target_case for update;\n select * into r from public.case_requests');
 execute definition;
end $upgrade$;
