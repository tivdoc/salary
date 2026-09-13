-- P06: lost-response retries acknowledge the exact saved operation. Draft
-- generations never reset when a submitted answer clears the draft row.
create table private.case_request_draft_heads (
 request_id uuid primary key references public.case_requests(id) on delete cascade,
 revision integer not null check(revision>=0)
);
revoke all on private.case_request_draft_heads from public,anon,authenticated,service_role,tivdoc_web_runtime,tivdoc_worker_runtime,tivdoc_operations_runtime;
insert into private.case_request_draft_heads(request_id,revision)
 select r.id,greatest(coalesce(d.revision,0),case when r.answered_at is not null then 1 else 0 end)
 from public.case_requests r left join private.case_request_drafts d on d.request_id=r.id;

do $upgrade$
declare definition text; previous text;
begin
 definition:=pg_get_functiondef('public.case_request_answer(uuid,uuid,text)'::regprocedure);
 previous:=definition;
 definition:=replace(definition,
  ' if not found or r.answered_at is not null or r.expired_at is not null or r.expires_at<=clock_timestamp() then return; end if;',
  $new$ if not found then return; end if;
 if r.answered_at is not null then
  -- Replaying the original answer never replaces a later correction.
  if r.answer_kind not in ('document','none') and r.answer_text=answer then return next r; end if;
  return;
 end if;
 if r.expired_at is not null or r.expires_at<=clock_timestamp() then return; end if;$new$);
 if definition=previous then raise exception 'REQUEST_RETRY_ANSWER_BASE_MISMATCH'; end if;
 definition:=replace(definition,$old$r.answer_kind='document'$old$,$new$r.answer_kind in ('document','none')$new$);
 execute definition;

 definition:=pg_get_functiondef('public.case_request_edit(uuid,uuid,uuid,text,integer,text)'::regprocedure);
 previous:=definition;
 definition:=replace(definition,$old$r.answer_kind='document' or edit_kind not in ('draft','correction') or expected_revision<0$old$,
  $new$r.answer_kind in ('document','none') or edit_kind is null or edit_kind not in ('draft','correction') or expected_revision is null or expected_revision<0$new$);
 if definition=previous then raise exception 'REQUEST_RETRY_EDIT_BASE_MISMATCH'; end if;
 previous:=definition;
 definition:=replace(definition,
  '  select coalesce(max(revision),0) into current_revision from private.case_request_drafts where request_id=r.id;',
  $new$  select coalesce((select h.revision from private.case_request_draft_heads h where h.request_id=r.id),0) into current_revision;
  if current_revision=expected_revision+1 and exists(select 1 from private.case_request_drafts d
    where d.request_id=r.id and d.revision=current_revision and d.identity_id=target_identity and d.answer_text=target_answer) then
   return current_revision;
  end if;$new$);
 if definition=previous then raise exception 'REQUEST_RETRY_DRAFT_BASE_MISMATCH'; end if;
 previous:=definition;
 definition:=replace(definition,
  '  insert into private.case_request_drafts(request_id,identity_id,revision,answer_text)',
  $new$  insert into private.case_request_draft_heads(request_id,revision) values(r.id,current_revision+1)
   on conflict(request_id) do update set revision=excluded.revision;
  insert into private.case_request_drafts(request_id,identity_id,revision,answer_text)$new$);
 if definition=previous then raise exception 'REQUEST_RETRY_DRAFT_WRITE_BASE_MISMATCH'; end if;
 previous:=definition;
 definition:=replace(definition,
  '  select coalesce(max(revision),0) into current_revision from private.case_request_answer_versions where request_id=r.id;',
  $new$  select coalesce(max(revision),0) into current_revision from private.case_request_answer_versions where request_id=r.id;
  if current_revision=expected_revision+1 and exists(select 1 from private.case_request_answer_versions v
    where v.request_id=r.id and v.revision=current_revision and v.identity_id=target_identity and v.origin='correction' and v.answer_text=answer) then
   return current_revision;
  end if;$new$);
 if definition=previous then raise exception 'REQUEST_RETRY_CORRECTION_BASE_MISMATCH'; end if;
 previous:=definition;
 definition:=replace(definition,
  '  delete from private.case_request_drafts where request_id=r.id;',
  $new$  delete from private.case_request_drafts where request_id=r.id;
  insert into private.case_request_draft_heads(request_id,revision) values(r.id,1)
   on conflict(request_id) do update set revision=private.case_request_draft_heads.revision+1;$new$);
 if definition=previous then raise exception 'REQUEST_RETRY_CLEAR_BASE_MISMATCH'; end if;
 execute definition;

 definition:=pg_get_functiondef('private.case_request_record_original()'::regprocedure);
 previous:=definition;
 definition:=replace(definition,
  '  delete from private.case_request_drafts where request_id=new.id;',
  $new$  delete from private.case_request_drafts where request_id=new.id;
  insert into private.case_request_draft_heads(request_id,revision) values(new.id,1)
   on conflict(request_id) do update set revision=private.case_request_draft_heads.revision+1;$new$);
 if definition=previous then raise exception 'REQUEST_RETRY_ORIGINAL_BASE_MISMATCH'; end if;
 execute definition;

 definition:=pg_get_functiondef('public.case_request_revision_list(uuid)'::regprocedure);
 previous:=definition;
 definition:=replace(definition,'coalesce(d.revision,0),d.answer_text','coalesce((select h.revision from private.case_request_draft_heads h where h.request_id=r.id),0),d.answer_text');
 if definition=previous then raise exception 'REQUEST_RETRY_LIST_BASE_MISMATCH'; end if;
 execute definition;
end $upgrade$;
-- Existing functions retain their owners, invoker/definer mode, empty search
-- paths and scoped ACLs. No direct private-table grant or new RPC is introduced.
