-- Orphan GC is a two-stage protocol. Reference-bearing objects are retained.
create table private.storage_gc_policy(version text primary key,minimum_age interval not null,grace interval not null,created_at timestamptz not null default now());
insert into private.storage_gc_policy values('tivdoc-retention-v1',interval '7 days',interval '7 days',now());
create table private.storage_gc_candidates(path text primary key,case_id uuid not null,policy_version text not null references private.storage_gc_policy(version),observed_created_at timestamptz not null,marked_at timestamptz not null default now(),eligible_at timestamptz not null,state text not null default 'marked' check(state in ('marked','deleting','deleted','retained')),reason text,claimed_at timestamptz,deleted_at timestamptz);
create table private.storage_gc_events(id bigint generated always as identity primary key,path_sha256 text not null,state text not null,reason text,at timestamptz not null default now());
revoke all on private.storage_gc_policy,private.storage_gc_candidates,private.storage_gc_events from public,anon,authenticated,service_role,tivdoc_web_runtime;
grant select on private.storage_gc_policy,private.storage_gc_candidates,private.storage_gc_events to tivdoc_operations_runtime,tivdoc_worker_runtime;
-- The owner must see FORCE-RLS product references when called by the worker.
do $$ begin execute format('create policy gc_reference_owner on public.document_upload_batches for select to %I using(true)',current_user);end $$;
create function private.storage_gc_reference_reason(target_case uuid,target_path text) returns text language plpgsql security definer set search_path='' as $$
declare version text:=substring(target_path from '/versions/([a-f0-9-]+)\.');
begin
 if exists(select 1 from public.documents where storage_path=target_path) then return 'current_document';end if;
 if exists(select 1 from public.document_versions where storage_path=target_path) then return 'retained_version';end if;
 if exists(select 1 from public.document_upload_batches b cross join lateral jsonb_array_elements(b.files) f where b.case_id=target_case and f->>'path'=target_path and b.cancelled_at is null and (b.completed_at is not null or b.expires_at>now())) then return 'upload_batch';end if;
 if exists(select 1 from private.case_input_versions i cross join lateral jsonb_array_elements(i.input->'documents') d where i.case_id=target_case and d->>'version_id'=version) then return 'analysis_input';end if;
 if exists(select 1 from public.case_report_projections p cross join lateral jsonb_array_elements(p.report_document->'evidence') e where p.case_id=target_case and e->>'version_id'=version) then return 'report_evidence';end if;
 if exists(select 1 from private.case_retention_holds where case_id=target_case and released_at is null) then return 'retention_hold';end if;
 if exists(select 1 from public.case_access_tokens where case_id=target_case and expires_at>now() and used_at is null and revoked_at is null) then return 'live_case_token';end if;
 return null;
end;$$;
create function public.case_documents_gc_mark(target_path text,target_created timestamptz) returns text language plpgsql security definer set search_path='' as $$
declare target uuid;p private.storage_gc_policy;reason text;
begin
 if target_path!~'^cases/[a-f0-9-]{36}/versions/[a-f0-9-]{36}\.(pdf|png|jpg)$' or target_created is null or target_created>now() then raise exception 'GC_PATH_INVALID';end if;
 target:=split_part(target_path,'/',2)::uuid;
 perform 1 from public.cases where id=target for update;
 select * into p from private.storage_gc_policy where version='tivdoc-retention-v1';
 reason:=private.storage_gc_reference_reason(target,target_path);
 if reason is not null then return 'retained:'||reason;end if;
 insert into private.storage_gc_candidates(path,case_id,policy_version,observed_created_at,eligible_at) values(target_path,target,p.version,target_created,greatest(target_created+p.minimum_age,now())+p.grace) on conflict do nothing;
 return 'marked';
end;$$;
create function public.case_documents_gc_claim(target_path text) returns text language plpgsql security definer set search_path='' as $$
declare c private.storage_gc_candidates;reason text;
begin
 perform 1 from public.cases where id=(select case_id from private.storage_gc_candidates where path=target_path) for update;
 select * into c from private.storage_gc_candidates where path=target_path for update;
 if not found or c.eligible_at>now() then return 'not_due';end if;
 if c.state='deleted' then return 'deleted';end if;
 reason:=private.storage_gc_reference_reason(c.case_id,c.path);
 if reason is not null then update private.storage_gc_candidates set state='retained',reason=reason where path=c.path;return 'retained:'||reason;end if;
 -- Reclaims repeat the same immutable deletion. A timed-out remove is safe to repeat.
 update private.storage_gc_candidates set state='deleting',claimed_at=now() where path=c.path;
 insert into private.storage_gc_events(path_sha256,state) values(encode(sha256(convert_to(c.path,'UTF8')),'hex'),'deleting');
 return 'deleting';
end;$$;
create function public.case_documents_gc_finish(target_path text) returns void language plpgsql security definer set search_path='' as $$
begin
 update private.storage_gc_candidates set state='deleted',deleted_at=coalesce(deleted_at,now()) where path=target_path and state in ('deleting','deleted');
 if not found then raise exception 'GC_FENCE_REQUIRED';end if;
 insert into private.storage_gc_events(path_sha256,state) values(encode(sha256(convert_to(target_path,'UTF8')),'hex'),'deleted');
end;$$;
create function private.storage_gc_reference_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.cases where id=new.case_id for update;
 if exists(select 1 from private.storage_gc_candidates where path=new.storage_path and state in ('deleting','deleted')) then raise exception 'GC_OBJECT_RETIRED';end if;
 return new;
end;$$;
create trigger gc_document_reference before insert or update of storage_path on public.documents for each row execute function private.storage_gc_reference_guard();
create trigger gc_version_reference before insert on public.document_versions for each row execute function private.storage_gc_reference_guard();
revoke all on function private.storage_gc_reference_reason(uuid,text),public.case_documents_gc_mark(text,timestamptz),public.case_documents_gc_claim(text),public.case_documents_gc_finish(text) from public,anon,authenticated,service_role,tivdoc_web_runtime;
grant execute on function public.case_documents_gc_mark(text,timestamptz),public.case_documents_gc_claim(text),public.case_documents_gc_finish(text) to tivdoc_worker_runtime;

create function private.storage_gc_report_guard() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.cases where id=new.case_id for update;
 if exists(select 1 from jsonb_array_elements(new.report_document->'evidence') e join private.storage_gc_candidates g on substring(g.path from '/versions/([a-f0-9-]+)\.')=e->>'version_id' where g.state in ('deleting','deleted')) then raise exception 'GC_OBJECT_RETIRED';end if;return new;
end;$$;
create trigger gc_report_reference before insert or update of report_document on public.case_report_projections for each row execute function private.storage_gc_report_guard();
