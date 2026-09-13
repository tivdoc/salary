create function public.case_privacy_queue() returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(r)||jsonb_build_object('public_id',c.public_id) order by r.due_at),'[]'::jsonb) from (select * from private.privacy_requests where state in ('pending','in_review') order by due_at limit 100) r join public.cases c on c.id=r.case_id;
$$;
create function public.case_documents_gc_pending(target_limit integer default 100) returns jsonb language sql security definer set search_path='' as $$
 select coalesce(jsonb_agg(v),'[]'::jsonb) from (select jsonb_build_object('path',f->>'path','createdAt',b.created_at) v from public.document_upload_batches b cross join lateral jsonb_array_elements(b.files) f where b.completed_at is null and b.expires_at<now() and not exists(select 1 from private.storage_gc_candidates g where g.path=f->>'path' and g.state='deleted') order by b.created_at limit greatest(1,least(target_limit,1000))) pending;
$$;
create function public.case_privacy_draft_sweep(target_limit integer default 100) returns integer language plpgsql security definer set search_path='' as $$
declare total integer;
begin
 with eligible as (select d.request_id from private.case_request_drafts d join public.case_requests r on r.id=d.request_id where d.updated_at<now()-interval '30 days' and (r.answered_at is not null or r.expired_at is not null) and not exists(select 1 from private.case_retention_holds h where h.case_id=r.case_id and h.released_at is null) order by d.updated_at limit greatest(1,least(target_limit,1000)) for update of d skip locked),removed as (delete from private.case_request_drafts d using eligible e where d.request_id=e.request_id returning d.request_id) select count(*) into total from removed;
 return total;
end;$$;
revoke all on function public.case_privacy_queue(),public.case_documents_gc_pending(integer),public.case_privacy_draft_sweep(integer) from public,anon,authenticated,service_role,tivdoc_web_runtime;
grant execute on function public.case_privacy_queue() to tivdoc_operations_runtime;
grant execute on function public.case_documents_gc_pending(integer),public.case_privacy_draft_sweep(integer) to tivdoc_worker_runtime;
